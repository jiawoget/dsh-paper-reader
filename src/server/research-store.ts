import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { VALID_CITATION_SECTIONS, VALID_CITATION_STANCES, type CitationDirection, type CitationSection, type CitationSource, type CitationStance, type CitationStatement } from '../shared/citation-stance-types.js';
import type { WatchlistEntry, WatchlistItem, WatchlistKind } from '../shared/deep-search-types.js';
import type { PaperCard } from '../shared/research-types.js';
import type { DocPageRecord, GraphSource, TopicRecord } from '../shared/types.js';
import { isObject, single, stringValue, type Input } from './service-types.js';
import { deleteDocResourcesForDoc, ensureDocResourcesSchema } from './doc-resources-store.js';

type Row = Record<string, SQLOutputValue>;
interface PageFtsHit { docId: string; page: number; snippet: string; score: number }

export function hasResearchSchema(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('doc_pages','doc_pages_fts','topics','graph_cache','paper_cards','extraction_tables','extraction_cells','watchlist','citation_stances','doc_resources')").get();
  return Number(row?.n ?? 0) === 10;
}

export function ensureResearchSchema(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS doc_pages(docId TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(docId, page)) STRICT');
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS doc_pages_fts USING fts5(docId UNINDEXED, page UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')");
  db.exec("CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL, zoteroCollection TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL) STRICT");
  db.exec('CREATE TABLE IF NOT EXISTS graph_cache(cacheKey TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL, fetchedAt INTEGER NOT NULL, ttlMs INTEGER NOT NULL) STRICT');
  db.exec('CREATE TABLE IF NOT EXISTS paper_cards(doc_id TEXT PRIMARY KEY, card_json TEXT NOT NULL, source_hash TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT');
  db.exec('CREATE TABLE IF NOT EXISTS extraction_tables(id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT NOT NULL, criteria_json TEXT NOT NULL, columns_json TEXT NOT NULL, strict_criterion INTEGER NOT NULL DEFAULT 0, threshold REAL NOT NULL DEFAULT 0.6, updated_at INTEGER NOT NULL) STRICT');
  db.exec("CREATE TABLE IF NOT EXISTS extraction_cells(table_id TEXT NOT NULL, doc_id TEXT NOT NULL, col_id TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', page INTEGER, reasoning TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0, manual_override INTEGER NOT NULL DEFAULT 0, source_kind TEXT NOT NULL DEFAULT 'pdf', status TEXT NOT NULL DEFAULT 'done', updated_at INTEGER NOT NULL, PRIMARY KEY(table_id, doc_id, col_id)) STRICT");
  db.exec(`CREATE TABLE IF NOT EXISTS watchlist(id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, query TEXT NOT NULL, doc_id TEXT, work_id TEXT, sources_json TEXT NOT NULL DEFAULT '["openalex","europepmc","arxiv"]', cursor_date TEXT NOT NULL, seen_keys_json TEXT NOT NULL DEFAULT '[]', unread_json TEXT NOT NULL DEFAULT '[]', last_checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT`);
  db.exec('CREATE TABLE IF NOT EXISTS citation_stances(target_key TEXT NOT NULL, direction TEXT NOT NULL, citing_key TEXT NOT NULL, doc_id TEXT, source TEXT NOT NULL, citing_doc_id TEXT, citing_page INTEGER, citing_title TEXT NOT NULL, citing_authors_json TEXT NOT NULL, citing_year INTEGER, citing_doi TEXT, citing_arxiv TEXT, citing_url TEXT, section TEXT NOT NULL, context TEXT NOT NULL, stance TEXT NOT NULL, rationale TEXT NOT NULL, is_influential INTEGER NOT NULL DEFAULT 0, is_self_citation INTEGER NOT NULL DEFAULT 0, manual_override INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(target_key, direction, citing_key)) STRICT');
  ensureDocResourcesSchema(db);
}

export function deleteResearchDocument(db: DatabaseSync, docId: string): void {
  db.prepare('DELETE FROM doc_pages WHERE docId=?').run(docId);
  db.prepare('DELETE FROM doc_pages_fts WHERE docId=?').run(docId);
  db.prepare('DELETE FROM paper_cards WHERE doc_id=?').run(docId);
  db.prepare('DELETE FROM extraction_cells WHERE doc_id=?').run(docId);
  db.prepare('DELETE FROM watchlist WHERE doc_id=?').run(docId);
  db.prepare('DELETE FROM citation_stances WHERE doc_id=? OR citing_doc_id=?').run(docId, docId);
  deleteDocResourcesForDoc(db, docId);
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

function decodePaperCard(row: Row): PaperCard | undefined {
  if (typeof row.card_json !== 'string') return undefined;
  try {
    const p: unknown = JSON.parse(row.card_json);
    if (!isObject(p)) return undefined;
    return {
      docId: String(row.doc_id ?? ''), sourceKind: p.sourceKind === 'abstract' ? 'abstract' : 'pdf',
      problem: String(p.problem ?? ''), method: String(p.method ?? ''), findings: String(p.findings ?? ''),
      limitations: String(p.limitations ?? ''), futureWork: String(p.futureWork ?? ''),
      sourceHash: String(row.source_hash ?? ''), updatedAt: Number(row.updated_at ?? 0)
    };
  } catch { return undefined; }
}

export function setPaperCard(db: DatabaseSync, card: PaperCard): PaperCard {
  const docId = single(card.docId, 'document ID', 512, true), updatedAt = card.updatedAt || Date.now();
  const payload = JSON.stringify({
    sourceKind: card.sourceKind, problem: card.problem, method: card.method,
    findings: card.findings, limitations: card.limitations, futureWork: card.futureWork
  });
  db.prepare(`INSERT INTO paper_cards(doc_id, card_json, source_hash, updated_at) VALUES(?,?,?,?)
    ON CONFLICT(doc_id) DO UPDATE SET card_json=excluded.card_json, source_hash=excluded.source_hash, updated_at=excluded.updated_at`)
    .run(docId, payload, card.sourceHash, updatedAt);
  return { ...card, docId, updatedAt };
}

export function listPaperCards(db: DatabaseSync, docIds?: readonly string[]): PaperCard[] {
  if (docIds && !docIds.length) return [];
  const rows = docIds?.length
    ? db.prepare(`SELECT doc_id, card_json, source_hash, updated_at FROM paper_cards WHERE doc_id IN (${docIds.map(() => '?').join(',')}) ORDER BY updated_at DESC`).all(...docIds)
    : db.prepare('SELECT doc_id, card_json, source_hash, updated_at FROM paper_cards ORDER BY updated_at DESC').all();
  return rows.map(decodePaperCard).filter((c): c is PaperCard => Boolean(c));
}

export const VALID_GRAPH_SOURCES = new Set<GraphSource>(['openalex', 's2', 'europepmc', 'arxiv']);
const parseArr = <T>(raw: SQLOutputValue | undefined): T[] => { try { const v: unknown = typeof raw === 'string' ? JSON.parse(raw) : []; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; } };
function decodeWatchlist(r: Row): WatchlistEntry {
  const kind: WatchlistKind = r.kind === 'paper' ? 'paper' : 'topic';
  const sources = parseArr<string>(r.sources_json).filter((s): s is GraphSource => VALID_GRAPH_SOURCES.has(s as GraphSource));
  return {
    id: String(r.id ?? ''), kind, label: String(r.label ?? ''), query: String(r.query ?? ''),
    ...(typeof r.doc_id === 'string' && r.doc_id ? { docId: r.doc_id } : {}), ...(typeof r.work_id === 'string' && r.work_id ? { workId: r.work_id } : {}),
    sources: sources.length ? sources : (kind === 'paper' ? ['openalex', 's2'] : ['openalex', 'europepmc', 'arxiv']),
    cursorDate: String(r.cursor_date ?? ''), seenKeys: parseArr<string>(r.seen_keys_json).filter(k => typeof k === 'string'),
    unread: parseArr<WatchlistItem>(r.unread_json).filter(i => isObject(i) && typeof i.key === 'string' && isObject(i.paper)),
    ...(typeof r.last_checked_at === 'string' && r.last_checked_at ? { lastCheckedAt: r.last_checked_at } : {}),
    createdAt: String(r.created_at ?? ''), updatedAt: String(r.updated_at ?? '')
  };
}
export const listWatchlistEntries = (db: DatabaseSync): WatchlistEntry[] => db.prepare('SELECT * FROM watchlist ORDER BY updated_at DESC, label ASC').all().map(decodeWatchlist);
export const getWatchlistEntry = (db: DatabaseSync, id: string): WatchlistEntry | undefined => { const r = db.prepare('SELECT * FROM watchlist WHERE id=?').get(id); return r ? decodeWatchlist(r) : undefined; };
export function upsertWatchlistEntry(db: DatabaseSync, e: WatchlistEntry): WatchlistEntry {
  db.prepare(`INSERT INTO watchlist(id,kind,label,query,doc_id,work_id,sources_json,cursor_date,seen_keys_json,unread_json,last_checked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,query=excluded.query,doc_id=excluded.doc_id,work_id=excluded.work_id,sources_json=excluded.sources_json,cursor_date=excluded.cursor_date,seen_keys_json=excluded.seen_keys_json,unread_json=excluded.unread_json,last_checked_at=excluded.last_checked_at,updated_at=excluded.updated_at`)
    .run(e.id, e.kind, e.label, e.query, e.docId ?? null, e.workId ?? null, JSON.stringify(e.sources), e.cursorDate, JSON.stringify(e.seenKeys), JSON.stringify(e.unread), e.lastCheckedAt ?? null, e.createdAt, e.updatedAt);
  return e;
}
export function deleteWatchlistEntry(db: DatabaseSync, id: string): { id: string; deleted: boolean } {
  const watchId = single(id, 'watchlist ID', 128, true);
  return { id: watchId, deleted: Boolean(db.prepare('DELETE FROM watchlist WHERE id=?').run(watchId).changes) };
}

const CITATION_SOURCES = new Set<CitationSource>(['local', 's2', 'europepmc', 'openalex']);
const CITATION_STANCES = new Set<CitationStance>(VALID_CITATION_STANCES);
const CITATION_SECTIONS = new Set<CitationSection>(VALID_CITATION_SECTIONS);
function decodeCitationStance(r: Row): CitationStatement {
  const source: CitationSource = CITATION_SOURCES.has(r.source as CitationSource) ? (r.source as CitationSource) : 's2';
  const stance: CitationStance = CITATION_STANCES.has(r.stance as CitationStance) ? (r.stance as CitationStance) : 'unclassified';
  const section: CitationSection = CITATION_SECTIONS.has(r.section as CitationSection) ? (r.section as CitationSection) : 'Unknown';
  return {
    targetKey: String(r.target_key ?? ''), direction: r.direction === 'references' ? 'references' : 'cited_by', citingKey: String(r.citing_key ?? ''),
    ...(typeof r.doc_id === 'string' && r.doc_id ? { docId: r.doc_id } : {}), source,
    ...(typeof r.citing_doc_id === 'string' && r.citing_doc_id ? { citingDocId: r.citing_doc_id } : {}),
    ...(typeof r.citing_page === 'number' && Number.isFinite(r.citing_page) ? { citingPage: r.citing_page } : {}),
    citingTitle: String(r.citing_title ?? ''), citingAuthors: parseArr<string>(r.citing_authors_json).filter(a => typeof a === 'string'),
    ...(typeof r.citing_year === 'number' && Number.isFinite(r.citing_year) ? { citingYear: r.citing_year } : {}),
    ...(typeof r.citing_doi === 'string' && r.citing_doi ? { citingDoi: r.citing_doi } : {}),
    ...(typeof r.citing_arxiv === 'string' && r.citing_arxiv ? { citingArxiv: r.citing_arxiv } : {}),
    ...(typeof r.citing_url === 'string' && r.citing_url ? { citingUrl: r.citing_url } : {}),
    section, context: String(r.context ?? ''), stance, rationale: String(r.rationale ?? ''),
    isInfluential: Number(r.is_influential ?? 0) !== 0, isSelfCitation: Number(r.is_self_citation ?? 0) !== 0,
    manualOverride: Number(r.manual_override ?? 0) !== 0, updatedAt: String(r.updated_at ?? '')
  };
}
export function listCitationStances(db: DatabaseSync, targetKey: string, direction: CitationDirection): CitationStatement[] {
  return db.prepare("SELECT * FROM citation_stances WHERE target_key=? AND direction=? ORDER BY CASE WHEN source='local' THEN 0 ELSE 1 END, is_influential DESC, citing_year DESC, updated_at DESC").all(targetKey, direction).map(decodeCitationStance);
}
export function upsertCitationStances(db: DatabaseSync, rows: readonly CitationStatement[]): void {
  const stmt = db.prepare(`INSERT INTO citation_stances(target_key,direction,citing_key,doc_id,source,citing_doc_id,citing_page,citing_title,citing_authors_json,citing_year,citing_doi,citing_arxiv,citing_url,section,context,stance,rationale,is_influential,is_self_citation,manual_override,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(target_key,direction,citing_key) DO UPDATE SET doc_id=COALESCE(excluded.doc_id,citation_stances.doc_id),source=excluded.source,citing_doc_id=excluded.citing_doc_id,citing_page=excluded.citing_page,citing_title=excluded.citing_title,citing_authors_json=excluded.citing_authors_json,citing_year=excluded.citing_year,citing_doi=excluded.citing_doi,citing_arxiv=excluded.citing_arxiv,citing_url=excluded.citing_url,section=excluded.section,context=excluded.context,stance=excluded.stance,rationale=excluded.rationale,is_influential=excluded.is_influential,is_self_citation=excluded.is_self_citation,updated_at=excluded.updated_at WHERE citation_stances.manual_override=0`);
  for (const s of rows) {
    stmt.run(s.targetKey, s.direction, s.citingKey, s.docId ?? null, s.source, s.citingDocId ?? null, s.citingPage ?? null, s.citingTitle, JSON.stringify(s.citingAuthors), s.citingYear ?? null, s.citingDoi ?? null, s.citingArxiv ?? null, s.citingUrl ?? null, s.section, s.context, s.stance, s.rationale, s.isInfluential ? 1 : 0, s.isSelfCitation ? 1 : 0, s.manualOverride ? 1 : 0, s.updatedAt);
  }
}
export function pruneCitationStances(db: DatabaseSync, targetKey: string, direction: CitationDirection, scope: 'local' | 'external', keepKeys: ReadonlySet<string>): void {
  const srcSql = scope === 'local' ? "source='local'" : "source!='local'", keys = [...keepKeys];
  if (!keys.length) db.prepare(`DELETE FROM citation_stances WHERE target_key=? AND direction=? AND ${srcSql} AND manual_override=0`).run(targetKey, direction);
  else db.prepare(`DELETE FROM citation_stances WHERE target_key=? AND direction=? AND ${srcSql} AND manual_override=0 AND citing_key NOT IN (${keys.map(() => '?').join(',')})`).run(targetKey, direction, ...keys);
}
export function reclassifyCitationStance(db: DatabaseSync, targetKey: string, direction: CitationDirection, citingKey: string, stance: CitationStance, rationale?: string): CitationStatement | undefined {
  const res = db.prepare('UPDATE citation_stances SET stance=?, rationale=COALESCE(?, rationale), manual_override=1, updated_at=? WHERE target_key=? AND direction=? AND citing_key=?').run(stance, rationale ?? null, new Date().toISOString(), targetKey, direction, citingKey);
  if (!res.changes) return undefined;
  const row = db.prepare('SELECT * FROM citation_stances WHERE target_key=? AND direction=? AND citing_key=?').get(targetKey, direction, citingKey);
  return row ? decodeCitationStance(row) : undefined;
}
