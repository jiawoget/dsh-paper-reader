import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { PaperAnnotation } from '../shared/annotations.js';
import type { DocMeta, DocStatus, DocumentInfo, LibrarySearchHit } from '../shared/types.js';
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
  const seen = new Set<string>(), tags: string[] = [];
  for (const item of raw) {
    const clean = item.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key); tags.push(clean);
    if (tags.length >= 20) break;
  }
  return tags;
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
