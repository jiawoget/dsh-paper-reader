import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { PaperAnnotation } from '../shared/annotations.js';
import { collectLibraryTags, isInternalTag, mergeTags, normalizeTagList, suggestOfflineTags } from '../shared/tags.js';
import type { DocMeta, DocStatus, DocumentInfo, LibrarySearchHit } from '../shared/types.js';
import type { Library } from './library.js';
import type { ReaderModel, StreamOptions } from './reader-model.js';
import type { ReaderStore } from './reader-store.js';
import { getDocPages, listTopics } from './research-store.js';
import { pageNumber, ServiceError, single, type Input } from './service-types.js';

type Row = Record<string, SQLOutputValue>;
type AnnContent = Omit<PaperAnnotation, 'id' | 'docId' | 'createdAt' | 'updatedAt'>;

export const docMetaSchema = `CREATE TABLE IF NOT EXISTS doc_meta(
  docId TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unread', starred INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]', lastOpenedAt INTEGER, lastPage INTEGER, pageCount INTEGER, scrollFraction REAL
) STRICT`;

const isStatus = (value: unknown): value is DocStatus => value === 'unread' || value === 'reading' || value === 'done';

function decodeMeta(row: Row): DocMeta {
  let tags: string[] = [];
  if (typeof row.tags === 'string') {
    try { const parsed: unknown = JSON.parse(row.tags); if (Array.isArray(parsed)) tags = parsed.filter((v): v is string => typeof v === 'string'); } catch {}
  }
  return {
    status: isStatus(row.status) ? row.status : 'unread', starred: row.starred === 1, tags,
    ...(typeof row.lastOpenedAt === 'number' && { lastOpenedAt: row.lastOpenedAt }),
    ...(typeof row.lastPage === 'number' && { lastPage: row.lastPage }),
    ...(typeof row.pageCount === 'number' && { pageCount: row.pageCount }),
    ...(typeof row.scrollFraction === 'number' && { scrollFraction: row.scrollFraction })
  };
}

export function listDocMeta(db: DatabaseSync, docId?: string): Map<string, DocMeta> {
  const rows = docId !== undefined ? db.prepare('SELECT * FROM doc_meta WHERE docId=?').all(docId) : db.prepare('SELECT * FROM doc_meta').all();
  const out = new Map<string, DocMeta>();
  for (const row of rows) if (typeof row.docId === 'string') out.set(row.docId, decodeMeta(row));
  return out;
}

function upsertMeta(db: DatabaseSync, docId: string, meta: DocMeta): DocMeta {
  db.prepare(`INSERT INTO doc_meta(docId,status,starred,tags,lastOpenedAt,lastPage,pageCount,scrollFraction) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(docId) DO UPDATE SET status=excluded.status,starred=excluded.starred,tags=excluded.tags,
    lastOpenedAt=excluded.lastOpenedAt,lastPage=excluded.lastPage,pageCount=excluded.pageCount,scrollFraction=excluded.scrollFraction`)
    .run(docId, meta.status, meta.starred ? 1 : 0, JSON.stringify(meta.tags),
      meta.lastOpenedAt ?? null, meta.lastPage ?? null, meta.pageCount ?? null, meta.scrollFraction ?? null);
  return meta;
}

export function saveDocProgress(db: DatabaseSync, input: Input): DocMeta {
  const docId = single(input.docId, 'document ID', 512, true);
  const lastPage = input.lastPage === undefined ? undefined : pageNumber(input.lastPage);
  const pageCount = input.pageCount === undefined ? undefined : pageNumber(input.pageCount);
  let scrollFraction: number | undefined;
  if (input.scrollFraction !== undefined) {
    if (typeof input.scrollFraction !== 'number' || !Number.isFinite(input.scrollFraction)) throw new ServiceError(400, 'Scroll fraction must be a finite number.');
    scrollFraction = Math.max(0, Math.min(1, input.scrollFraction));
  }
  const prev = listDocMeta(db, docId).get(docId) ?? { status: 'unread', starred: false, tags: [] };
  const nextCount = pageCount ?? prev.pageCount;
  let nextPage = lastPage ?? prev.lastPage;
  if (nextPage !== undefined && nextCount !== undefined) nextPage = Math.min(nextPage, nextCount);
  const nextScroll = scrollFraction ?? prev.scrollFraction;
  const progressed = (nextPage !== undefined && nextPage > 1) || (nextScroll !== undefined && nextScroll > 0);
  return upsertMeta(db, docId, {
    status: prev.status === 'unread' && progressed ? 'reading' : prev.status,
    starred: prev.starred, tags: prev.tags, lastOpenedAt: Date.now(),
    ...(nextPage !== undefined && { lastPage: nextPage }),
    ...(nextCount !== undefined && { pageCount: nextCount }),
    ...(nextScroll !== undefined && { scrollFraction: nextScroll })
  });
}

function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 50 || !raw.every(item => typeof item === 'string')) throw new ServiceError(400, 'Tags must be an array of strings.');
  return normalizeTagList(raw);
}

export function updateDocTriage(db: DatabaseSync, input: Input): DocMeta {
  const docId = single(input.docId, 'document ID', 512, true);
  if (input.status !== undefined && !isStatus(input.status)) throw new ServiceError(400, 'Choose unread, reading, or done.');
  if (input.starred !== undefined && typeof input.starred !== 'boolean') throw new ServiceError(400, 'Starred must be a boolean.');
  const prev = listDocMeta(db, docId).get(docId) ?? { status: 'unread', starred: false, tags: [] };
  return upsertMeta(db, docId, {
    ...prev, status: input.status ?? prev.status, starred: input.starred ?? prev.starred,
    tags: input.tags === undefined ? prev.tags : sanitizeTags(input.tags)
  });
}

export function readBulkDocIds(raw: unknown, required = true): string[] {
  if (!Array.isArray(raw) || (required && !raw.length) || raw.length > 5000) {
    throw new ServiceError(400, required ? 'Select between 1 and 5000 documents.' : 'Invalid document filter.');
  }
  return [...new Set(raw.map(id => single(id, 'document ID', 512, true)))];
}

export function bulkUpdateDocTriage(db: DatabaseSync, input: Input, validIds: ReadonlySet<string>): { updated: number } {
  const docIds = readBulkDocIds(input.docIds, true);
  if (input.status !== undefined && !isStatus(input.status)) throw new ServiceError(400, 'Choose unread, reading, or done.');
  if (input.starred !== undefined && typeof input.starred !== 'boolean') throw new ServiceError(400, 'Starred must be a boolean.');
  const addTags = input.addTags === undefined ? undefined : sanitizeTags(input.addTags);
  const removeTags = input.removeTags === undefined ? undefined : sanitizeTags(input.removeTags);
  if (input.status === undefined && input.starred === undefined && addTags === undefined && removeTags === undefined) {
    throw new ServiceError(400, 'Provide tags, status, or starred to update.');
  }
  const targets = docIds.filter(id => validIds.has(id));
  if (!targets.length) return { updated: 0 };
  const existing = listDocMeta(db);
  for (const docId of targets) {
    const prev = existing.get(docId) ?? { status: 'unread', starred: false, tags: [] };
    const tags = removeTags?.length || addTags?.length ? mergeTags(prev.tags, { remove: removeTags, add: addTags }) : prev.tags;
    upsertMeta(db, docId, { ...prev, status: input.status ?? prev.status, starred: input.starred ?? prev.starred, tags });
  }
  return { updated: targets.length };
}

const TAG_SUGGEST_SYSTEM = 'Suggest 2 to 4 concise topical tags (1-3 words each) for this academic paper. Prefer matching tags from existingTags first before inventing new tags. Never repeat currentTags and never use "screen:" prefixes. Return ONLY valid JSON shaped as {"tags":["tag1","tag2"]}.';

function parseSuggestedTags(raw: string, currentKeys: ReadonlySet<string>): string[] {
  const match = raw.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim().match(/\{[\s\S]*\}/);
  if (!match) return [];
  const parsed: unknown = JSON.parse(match[0]);
  if (typeof parsed !== 'object' || parsed === null || !('tags' in parsed) || !Array.isArray(parsed.tags)) return [];
  return normalizeTagList(parsed.tags.filter((v): v is string => typeof v === 'string'))
    .filter(tag => !isInternalTag(tag) && !currentKeys.has(tag.toLocaleLowerCase())).slice(0, 4);
}

export async function suggestDocTags(
  input: Input, deps: { store: ReaderStore; library: Library; model: ReaderModel }, options?: StreamOptions
): Promise<{ tags: string[]; source: 'ai' | 'offline' }> {
  const docId = single(input.docId, 'document ID', 512, true);
  const [doc, docs] = await Promise.all([deps.library.get(docId), deps.library.list()]);
  const { metas, topics, firstPage } = deps.store.withDb(false, db => ({
    metas: listDocMeta(db), topics: listTopics(db), firstPage: doc.abstract ? '' : (getDocPages(db, doc.id)[0]?.text ?? '')
  }));
  const taxonomy = collectLibraryTags(docs.map(d => { const m = metas.get(d.id); return m ? { ...d, meta: m } : d; }), topics);
  const excerpt = (doc.abstract || doc.paragraphs?.slice(0, 4).join(' ') || firstPage || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
  const docMeta = metas.get(doc.id), docWithExcerpt: DocumentInfo = { ...doc, meta: docMeta, abstract: excerpt };
  const currentKeys = new Set((docMeta?.tags ?? []).map(t => t.toLocaleLowerCase()));
  try {
    const res = await deps.model.completeText(deps.store.settings(), TAG_SUGGEST_SYSTEM, {
      title: doc.paperTitle || doc.title, venue: doc.venue ?? '', excerpt, currentTags: docMeta?.tags ?? [], existingTags: taxonomy.slice(0, 40).map(t => t.tag)
    }, { signal: options?.signal });
    const aiTags = parseSuggestedTags(res.text, currentKeys);
    if (aiTags.length) return { tags: aiTags, source: 'ai' };
  } catch (error) {
    if (options?.signal?.aborted || (error instanceof ServiceError && error.status === 499)) throw error;
  }
  return { tags: suggestOfflineTags(docWithExcerpt, taxonomy, 4), source: 'offline' };
}

export async function bulkDeleteDocuments(
  library: { hasSync(id: unknown): boolean; delete(id: unknown): Promise<{ id: string; deleted: boolean }> },
  rawDocIds: unknown
): Promise<{ deletedIds: string[]; skippedIds: string[] }> {
  const docIds = readBulkDocIds(rawDocIds, true), deletedIds: string[] = [], skippedIds: string[] = [];
  for (const id of docIds) {
    if (id === 'pagedattention' || !library.hasSync(id)) { skippedIds.push(id); continue; }
    const res = await library.delete(id);
    if (res.deleted) deletedIds.push(id); else skippedIds.push(id);
  }
  return { deletedIds, skippedIds };
}

export function deleteDocMeta(db: DatabaseSync, docId: string): void {
  db.prepare('DELETE FROM doc_meta WHERE docId=?').run(docId);
}

function snippetFor(raw: string, needle: string): string {
  const clean = raw.replace(/\s+/g, ' ').trim(), idx = clean.toLocaleLowerCase().indexOf(needle);
  if (idx < 0) return clean.slice(0, 120);
  const start = Math.max(0, idx - 40), end = Math.min(clean.length, idx + needle.length + 72);
  return (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '');
}

function matchFields(fields: (string | undefined)[], needle: string): string | undefined {
  for (const field of fields) if (field && field.toLocaleLowerCase().includes(needle)) return snippetFor(field, needle);
}

export function searchLibrary(db: DatabaseSync, query: string, docs: DocumentInfo[]): LibrarySearchHit[] {
  const needle = query.toLocaleLowerCase(), docMap = new Map(docs.map(doc => [doc.id, doc])), metas = listDocMeta(db);
  const docKind = (doc: DocumentInfo): 'pdf' | 'web' | 'book' | 'abstract' => doc.book ? 'book' : doc.kind;
  const docHits: LibrarySearchHit[] = [], contentHits: LibrarySearchHit[] = [];
  for (const doc of docs) {
    const meta = metas.get(doc.id);
    const snippet = matchFields([doc.title, doc.paperTitle, doc.authors, doc.venue, doc.year, ...(meta?.tags ?? []), doc.doi, doc.url, doc.id], needle);
    if (snippet) docHits.push({ docId: doc.id, docTitle: doc.title, docKind: docKind(doc), kind: 'doc', snippet, page: meta?.lastPage ?? doc.defaultPage });
  }
  const unicodeCased = /[^\x00-\x7f]/.test(query) && query.toLocaleLowerCase() !== query.toLocaleUpperCase();
  const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
  const noteRows = unicodeCased
    ? db.prepare("SELECT id,docId,page,anchor,text,quote,label,updatedAt FROM entries WHERE kind='note' ORDER BY updatedAt DESC,rowid DESC").all()
    : db.prepare("SELECT id,docId,page,anchor,text,quote,label,updatedAt FROM entries WHERE kind='note' AND (text LIKE ? ESCAPE '\\' OR quote LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\') ORDER BY updatedAt DESC,rowid DESC").all(pattern, pattern, pattern);
  for (const row of noteRows) {
    const doc = typeof row.docId === 'string' ? docMap.get(row.docId) : undefined;
    if (!doc) continue;
    const text = String(row.text ?? ''), quote = String(row.quote ?? ''), anchor = String(row.anchor ?? '');
    const snippet = matchFields([text, quote, String(row.label ?? '')], needle);
    if (snippet) contentHits.push({ docId: doc.id, docTitle: doc.title, docKind: docKind(doc), kind: 'note', snippet, page: typeof row.page === 'number' ? row.page : undefined, anchor: anchor || undefined, quote: quote || undefined, id: String(row.id), updatedAt: String(row.updatedAt ?? '') });
  }
  for (const row of db.prepare('SELECT id,docId,content,updatedAt FROM annotations WHERE content IS NOT NULL ORDER BY updatedAt DESC,rowid DESC').all()) {
    const doc = typeof row.docId === 'string' ? docMap.get(row.docId) : undefined;
    if (!doc || typeof row.content !== 'string') continue;
    let parsed: AnnContent;
    try { parsed = JSON.parse(row.content) as AnnContent; } catch { continue; }
    const snippet = matchFields([parsed.text, parsed.quote, parsed.label], needle);
    if (snippet) contentHits.push({ docId: doc.id, docTitle: doc.title, docKind: docKind(doc), kind: 'mark', snippet, page: parsed.page, anchor: parsed.anchor || undefined, quote: parsed.quote || undefined, id: String(row.id), color: parsed.color, updatedAt: String(row.updatedAt ?? '') });
  }
  contentHits.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return [...docHits, ...contentHits].slice(0, 60);
}
