import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  DOC_RESOURCE_KINDS, normalizeResourceUrl,
  type DocResource, type DocResourceBacklink, type DocResourceKind, type DocResourcesListResult, type DocResourceStatus
} from '../shared/doc-resources.js';

type Row = Record<string, SQLOutputValue>;
const VALID_KINDS = new Set<string>(DOC_RESOURCE_KINDS);
const VALID_STATUSES = new Set<string>(['suggested', 'linked', 'dismissed']);
const toKind = (v: SQLOutputValue | undefined): DocResourceKind => typeof v === 'string' && VALID_KINDS.has(v) ? (v as DocResourceKind) : 'other';
const toStatus = (v: SQLOutputValue | undefined): DocResourceStatus => typeof v === 'string' && VALID_STATUSES.has(v) ? (v as DocResourceStatus) : 'suggested';

function decodeResource(row: Row): DocResource {
  return {
    id: String(row.id ?? ''), docId: String(row.doc_id ?? ''), kind: toKind(row.kind), title: String(row.title ?? ''),
    ...(typeof row.url === 'string' && row.url ? { url: row.url } : {}),
    ...(typeof row.target_doc_id === 'string' && row.target_doc_id ? { targetDocId: row.target_doc_id } : {}),
    status: toStatus(row.status), source: String(row.source ?? 'manual'),
    createdAt: Number(row.created_at ?? 0), updatedAt: Number(row.updated_at ?? 0)
  };
}

export function ensureDocResourcesSchema(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS doc_resources(id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT, target_doc_id TEXT, status TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_resources_doc ON doc_resources(doc_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_resources_target ON doc_resources(target_doc_id)');
}

export function deleteDocResourcesForDoc(db: DatabaseSync, docId: string): void {
  db.prepare('DELETE FROM doc_resources WHERE doc_id=?').run(docId);
  db.prepare("DELETE FROM doc_resources WHERE target_doc_id=? AND (url IS NULL OR url='')").run(docId);
  db.prepare('UPDATE doc_resources SET target_doc_id=NULL WHERE target_doc_id=?').run(docId);
}

export function listDocResources(db: DatabaseSync, docId: string, includeDismissed = false): DocResourcesListResult {
  const filter = includeDismissed ? '' : " AND status!='dismissed'";
  const rows = db.prepare(`SELECT * FROM doc_resources WHERE doc_id=?${filter} ORDER BY CASE status WHEN 'linked' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END, updated_at DESC, created_at DESC`).all(docId);
  const backlinks: DocResourceBacklink[] = db.prepare("SELECT id, doc_id, kind, title FROM doc_resources WHERE target_doc_id=? AND status='linked' ORDER BY updated_at DESC").all(docId).map(r => ({
    id: String(r.id ?? ''), sourceDocId: String(r.doc_id ?? ''), kind: toKind(r.kind), title: String(r.title ?? '')
  }));
  return { resources: rows.map(decodeResource), backlinks };
}

export function pendingResourceCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of db.prepare("SELECT doc_id, COUNT(*) AS n FROM doc_resources WHERE status='suggested' GROUP BY doc_id").all()) {
    const id = String(row.doc_id ?? ''), count = Number(row.n ?? 0);
    if (id && count > 0) counts[id] = count;
  }
  return counts;
}

interface AddDocResourceInput {
  docId: string; kind: DocResourceKind; title: string; url?: string; targetDocId?: string; status: DocResourceStatus; source: string;
}

export function addDocResource(db: DatabaseSync, input: AddDocResourceInput): { resource: DocResource; created: boolean } {
  const normUrl = input.url ? normalizeResourceUrl(input.url) : '';
  const existing = db.prepare('SELECT * FROM doc_resources WHERE doc_id=?').all(input.docId).map(decodeResource).find(row =>
    (normUrl && row.url && normalizeResourceUrl(row.url) === normUrl) || (input.targetDocId && row.targetDocId === input.targetDocId)
  );
  const now = Date.now();
  if (existing) {
    if (input.status === 'suggested') return { resource: existing, created: false };
    db.prepare('UPDATE doc_resources SET kind=?, title=?, url=?, target_doc_id=?, status=?, source=?, updated_at=? WHERE id=?')
      .run(input.kind, input.title, input.url ?? existing.url ?? null, input.targetDocId ?? existing.targetDocId ?? null, input.status, input.source, now, existing.id);
    const updated = db.prepare('SELECT * FROM doc_resources WHERE id=?').get(existing.id);
    return { resource: updated ? decodeResource(updated) : { ...existing, status: input.status, updatedAt: now }, created: false };
  }
  const id = randomUUID();
  db.prepare('INSERT INTO doc_resources(id, doc_id, kind, title, url, target_doc_id, status, source, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, input.docId, input.kind, input.title, input.url ?? null, input.targetDocId ?? null, input.status, input.source, now, now);
  return {
    resource: {
      id, docId: input.docId, kind: input.kind, title: input.title,
      ...(input.url ? { url: input.url } : {}), ...(input.targetDocId ? { targetDocId: input.targetDocId } : {}),
      status: input.status, source: input.source, createdAt: now, updatedAt: now
    },
    created: true
  };
}

export function updateDocResourceStatus(db: DatabaseSync, id: string, status: 'linked' | 'dismissed'): DocResource | undefined {
  if (!db.prepare('UPDATE doc_resources SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), id).changes) return undefined;
  const row = db.prepare('SELECT * FROM doc_resources WHERE id=?').get(id);
  return row ? decodeResource(row) : undefined;
}

export const removeDocResource = (db: DatabaseSync, id: string): boolean => Boolean(db.prepare('DELETE FROM doc_resources WHERE id=?').run(id).changes);
