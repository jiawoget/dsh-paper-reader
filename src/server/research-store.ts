import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { DocPageRecord, TopicRecord } from '../shared/types.js';
import { single, stringValue, type Input } from './service-types.js';

type Row = Record<string, SQLOutputValue>;
interface PageFtsHit { docId: string; page: number; snippet: string; score: number }

export function hasResearchSchema(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('doc_pages','doc_pages_fts','topics','graph_cache')").get();
  return Number(row?.n ?? 0) === 4;
}

export function ensureResearchSchema(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS doc_pages(docId TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(docId, page)) STRICT');
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS doc_pages_fts USING fts5(docId UNINDEXED, page UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')");
  db.exec("CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL, zoteroCollection TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL) STRICT");
  db.exec('CREATE TABLE IF NOT EXISTS graph_cache(cacheKey TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL, fetchedAt INTEGER NOT NULL, ttlMs INTEGER NOT NULL) STRICT');
}

export function deleteResearchDocument(db: DatabaseSync, docId: string): void {
  db.prepare('DELETE FROM doc_pages WHERE docId=?').run(docId);
  db.prepare('DELETE FROM doc_pages_fts WHERE docId=?').run(docId);
}

export function segmentFtsText(text: string): string {
  return text.replace(/(\p{Script=Han})/gu, ' $1 ').replace(/\s+/g, ' ').trim();
}

export function buildFtsQuery(raw: string): string {
  const input = raw.trim().slice(0, 500);
  if (!input) return '';
  const clauses: string[] = [];
  const pushWords = (chunk: string, asPhrase: boolean) => {
    if (asPhrase) {
      const tokens = segmentFtsText(chunk).match(/[\p{L}\p{N}]+/gu);
      if (tokens?.length) clauses.push('"' + tokens.join(' ') + '"');
      return;
    }
    for (const part of chunk.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? []) {
      clauses.push('"' + (/\p{Script=Han}/u.test(part) ? [...part].join(' ') : part) + '"');
    }
  };
  let pos = 0;
  for (const match of input.matchAll(/"([^"]+)"/g)) {
    const start = match.index ?? 0;
    if (start > pos) pushWords(input.slice(pos, start), false);
    pushWords(match[1], true);
    pos = start + match[0].length;
  }
  if (pos < input.length) pushWords(input.slice(pos), false);
  return clauses.slice(0, 24).join(' ');
}

function makeSnippet(text: string, query: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const lower = clean.toLocaleLowerCase();
  const terms = (query.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}]){2,}/gu) ?? []).map(t => t.toLocaleLowerCase()).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 60), end = Math.min(clean.length, idx + term.length + 120);
    return (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '');
  }
  return clean.slice(0, 180) + (clean.length > 180 ? '…' : '');
}

export function replaceDocPages(db: DatabaseSync, docId: string, pages: ReadonlyArray<DocPageRecord>): number {
  const id = single(docId, 'document ID', 512, true), now = Date.now();
  db.prepare('DELETE FROM doc_pages WHERE docId=?').run(id);
  db.prepare('DELETE FROM doc_pages_fts WHERE docId=?').run(id);
  const insPage = db.prepare('INSERT OR REPLACE INTO doc_pages(docId, page, text, updatedAt) VALUES(?,?,?,?)');
  const insFts = db.prepare('INSERT INTO doc_pages_fts(docId, page, text) VALUES(?,?,?)');
  for (const entry of pages) {
    if (!Number.isSafeInteger(entry.page) || entry.page < 1) continue;
    const text = entry.text.replace(/\0/g, '').trim(), segmented = segmentFtsText(text);
    insPage.run(id, entry.page, text, now);
    if (segmented) insFts.run(id, entry.page, segmented);
  }
  return pages.length;
}

export function getDocPages(db: DatabaseSync, docId: string): DocPageRecord[] {
  return db.prepare('SELECT page, text FROM doc_pages WHERE docId=? ORDER BY page ASC').all(docId)
    .map(row => ({ page: Number(row.page), text: String(row.text ?? '') }));
}

export function hasDocPages(db: DatabaseSync, docId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM doc_pages WHERE docId=? LIMIT 1').get(docId));
}

export function searchDocPagesFts(db: DatabaseSync, query: string, opts?: { docIds?: string[]; limit?: number }): PageFtsHit[] {
  const fts = buildFtsQuery(query);
  if (!fts) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 40)));
  const docIds = opts?.docIds?.filter(Boolean);
  if (opts?.docIds && !docIds?.length) return [];
  const filterSql = docIds?.length ? ` AND doc_pages_fts.docId IN (${docIds.map(() => '?').join(',')})` : '';
  const sql = `SELECT doc_pages_fts.docId AS docId, doc_pages_fts.page AS page, p.text AS text, bm25(doc_pages_fts) AS score
    FROM doc_pages_fts JOIN doc_pages p ON p.docId = doc_pages_fts.docId AND p.page = doc_pages_fts.page
    WHERE doc_pages_fts MATCH ?${filterSql} ORDER BY score ASC, doc_pages_fts.docId ASC, doc_pages_fts.page ASC LIMIT ?`;
  const params: (string | number)[] = docIds?.length ? [fts, ...docIds, limit] : [fts, limit];
  return db.prepare(sql).all(...params).map(row => ({
    docId: String(row.docId ?? ''), page: Number(row.page), snippet: makeSnippet(String(row.text ?? ''), query), score: Number(row.score ?? 0)
  }));
}

function decodeTopic(row: Row): TopicRecord {
  return {
    id: String(row.id ?? ''), name: String(row.name ?? ''), tag: String(row.tag ?? ''),
    zoteroCollection: String(row.zoteroCollection ?? ''), description: String(row.description ?? ''),
    createdAt: String(row.createdAt ?? ''), updatedAt: String(row.updatedAt ?? '')
  };
}

export function listTopics(db: DatabaseSync): TopicRecord[] {
  return db.prepare('SELECT id, name, tag, zoteroCollection, description, createdAt, updatedAt FROM topics ORDER BY updatedAt DESC, name ASC').all().map(decodeTopic);
}

export function saveTopic(db: DatabaseSync, input: Input): TopicRecord {
  const name = single(input.name, 'topic name', 120, true);
  const id = input.id === undefined ? randomUUID() : single(input.id, 'topic ID', 128, true);
  const tag = single(input.tag, 'topic tag', 40) || name.slice(0, 40).trim();
  const zoteroCollection = single(input.zoteroCollection, 'Zotero collection', 120);
  const description = stringValue(input.description, 'topic description', 1000, false, true).trim();
  const prev = db.prepare('SELECT createdAt, updatedAt FROM topics WHERE id=?').get(id);
  const prevUpdated = typeof prev?.updatedAt === 'string' ? Date.parse(prev.updatedAt) : 0;
  const now = new Date(Math.max(Date.now(), prevUpdated + 1)).toISOString();
  const createdAt = typeof prev?.createdAt === 'string' ? prev.createdAt : now;
  db.prepare(`INSERT INTO topics(id, name, tag, zoteroCollection, description, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, tag=excluded.tag, zoteroCollection=excluded.zoteroCollection, description=excluded.description, updatedAt=excluded.updatedAt`)
    .run(id, name, tag, zoteroCollection, description, createdAt, now);
  return { id, name, tag, zoteroCollection, description, createdAt, updatedAt: now };
}

export function deleteTopic(db: DatabaseSync, id: unknown): { id: string; deleted: boolean } {
  const topicId = single(id, 'topic ID', 128, true);
  return { id: topicId, deleted: Boolean(db.prepare('DELETE FROM topics WHERE id=?').run(topicId).changes) };
}

export function getGraphCache<T>(db: DatabaseSync, key: string): { value: T; stale: boolean; fetchedAt: number } | undefined {
  const row = db.prepare('SELECT payload, fetchedAt, ttlMs FROM graph_cache WHERE cacheKey=?').get(key);
  if (!row || typeof row.payload !== 'string') return undefined;
  const fetchedAt = Number(row.fetchedAt ?? 0);
  try { return { value: JSON.parse(row.payload) as T, stale: Date.now() - fetchedAt > Number(row.ttlMs ?? 0), fetchedAt }; }
  catch { return undefined; }
}

export function setGraphCache(db: DatabaseSync, key: string, source: string, value: unknown, ttlMs: number): void {
  db.prepare(`INSERT INTO graph_cache(cacheKey, source, payload, fetchedAt, ttlMs) VALUES(?,?,?,?,?)
    ON CONFLICT(cacheKey) DO UPDATE SET source=excluded.source, payload=excluded.payload, fetchedAt=excluded.fetchedAt, ttlMs=excluded.ttlMs`)
    .run(key, source, JSON.stringify(value), Date.now(), Math.max(1000, Math.floor(ttlMs)));
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM graph_cache').get()?.n ?? 0) > 1200) {
    db.prepare('DELETE FROM graph_cache WHERE cacheKey NOT IN (SELECT cacheKey FROM graph_cache ORDER BY fetchedAt DESC LIMIT 1000)').run();
  }
}
