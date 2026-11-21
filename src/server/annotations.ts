import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { PaperAnnotation } from '../shared/annotations.js';
import { address, isObject, pageNumber, ServiceError, single, stringValue, type Input } from './service-types.js';

type Content = Omit<PaperAnnotation, 'id' | 'docId' | 'createdAt' | 'updatedAt'>;
type Row = Record<string, SQLOutputValue>;

export const annotationSchema = `
  CREATE TABLE IF NOT EXISTS annotations(
    id TEXT PRIMARY KEY, docId TEXT NOT NULL, content TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS annotations_document ON annotations(docId) WHERE content IS NOT NULL;
`;

function annotationId(input: Input): string {
  const id = single(input.id, 'annotation ID', 36, true).toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id)) {
    throw new ServiceError(400, 'Use a UUID for the annotation ID.');
  }
  return id;
}

function fraction(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}
function readContent(input: Input): Content {
  const { kind, color, point } = input;
  if (kind !== 'pin' && kind !== 'highlight') throw new ServiceError(400, 'Choose a highlight or a margin pin.');
  if (color !== 'yellow' && color !== 'green' && color !== 'purple') throw new ServiceError(400, 'Choose a supported annotation color.');
  let position: Content['point'];
  if (kind === 'pin' || point !== undefined) {
    if (!isObject(point) || !fraction(point.x) || !fraction(point.y)) {
      throw new ServiceError(400, 'Choose a position on the original page.');
    }
    position = { x: point.x, y: point.y };
  }
  return {
    kind, color, page: pageNumber(input.page), anchor: single(input.anchor, 'passage anchor', 4096),
    label: single(input.label, 'label', 512), title: stringValue(input.title, 'document title', 2048),
    sourceUrl: address(input.sourceUrl), quote: stringValue(input.quote, 'quotation', 100_000, kind === 'highlight', true),
    text: stringValue(input.text, 'annotation text', 100_000, false, true), ...(position && { point: position })
  };
}

function decode(row: Row): PaperAnnotation {
  return { ...JSON.parse(String(row.content)) as Content, id: String(row.id), docId: String(row.docId),
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) };
}
function nextTimestamp(row?: Row): string {
  return new Date(Math.max(Date.now(), row ? Date.parse(String(row.updatedAt)) + 1 : 0)).toISOString();
}

export function listAnnotations(db: DatabaseSync, input: Input): PaperAnnotation[] {
  const docId = single(input.docId, 'document ID', 512, true);
  return db.prepare('SELECT * FROM annotations WHERE docId=? AND content IS NOT NULL ORDER BY createdAt,rowid').all(docId).map(decode);
}

export function saveAnnotation(db: DatabaseSync, input: Input): PaperAnnotation {
  const id = annotationId(input), docId = single(input.docId, 'document ID', 512, true);
  const content = readContent(input);
  const serialized = JSON.stringify(content);
  const row = db.prepare('SELECT * FROM annotations WHERE id=?').get(id);
  if (row && row.docId !== docId) throw new ServiceError(409, 'This annotation ID belongs to another paper.');
  // A committed save may be retried after the transport lost the response.
  if (row?.content === serialized) return decode(row);
  const expected = input.expectedUpdatedAt;
  if (row?.content ? row.updatedAt !== expected : expected !== undefined) {
    throw new ServiceError(409, 'This annotation changed. Reopen it to review the saved version.');
  }
  const updatedAt = nextTimestamp(row), createdAt = row ? String(row.createdAt) : updatedAt;
  db.prepare(`INSERT INTO annotations(id,docId,content,createdAt,updatedAt) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET content=excluded.content,updatedAt=excluded.updatedAt`)
    .run(id, docId, serialized, createdAt, updatedAt);
  return { ...content, id, docId, createdAt, updatedAt };
}

export function deleteAnnotation(db: DatabaseSync, input: Input): boolean {
  const id = annotationId(input), docId = single(input.docId, 'document ID', 512, true);
  const expected = single(input.expectedUpdatedAt, 'annotation revision', 64, true);
  const row = db.prepare('SELECT * FROM annotations WHERE id=? AND docId=? AND content IS NOT NULL').get(id, docId);
  if (!row) return false;
  if (row.updatedAt !== expected) throw new ServiceError(409, 'This annotation changed. Review it before deleting.');
  // Retain only identity and revision so undo can restore this ID without reusing a stale revision.
  db.prepare('UPDATE annotations SET content=NULL,updatedAt=? WHERE id=?').run(nextTimestamp(row), id);
  return true;
}
