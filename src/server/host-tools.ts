import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { CitationDirection } from '../shared/citation-stance-types.js';
import type { TrendMetric, TrendSource, TrendWindow } from '../shared/research-types.js';
import type { DocumentInfo, TopicRecord } from '../shared/types.js';
import { readCachedCitations } from './citation-stance.js';
import { listDocMeta, searchLibrary } from './doc-meta.js';
import { queryFieldTrends } from './field-trends.js';
import type { Library } from './library.js';
import type { ReaderStore } from './reader-store.js';
import { listPaperCards, listTopics, searchDocPagesFts } from './research-store.js';
import { isObject } from './service-types.js';

type JsonRecord = Record<string, unknown>;
type Row = Record<string, SQLOutputValue>;

export class ToolArgsError extends Error {
  readonly code = 'INVALID_ARGS';
  readonly status = 400;
  readonly violations: string[];
  constructor(violations: string | readonly string[]) {
    const list = typeof violations === 'string' ? [violations] : [...violations];
    super(`invalid arguments: ${list.join('; ')}`);
    this.name = 'ToolArgsError'; this.violations = list;
  }
}

export interface HostToolDefinition {
  name: string; description: string; parameters: JsonRecord;
  output: { schema: JsonRecord; render: (args: unknown, value: unknown) => { type: 'text'; text: string }[] };
  isConcurrencySafe: () => boolean;
  presentCall: (args: unknown) => { card: 'generic'; kind: 'read'; title: string };
  execute: (args: unknown, exec?: { signal?: AbortSignal }) => Promise<JsonRecord>;
}
export interface HostToolsRegistry { register(definition: HostToolDefinition): unknown }
interface HostToolsDeps { store: ReaderStore; library: Library; fetchFn?: typeof fetch }
interface ToolsHostLike { inject?: (services: ['tools'], setup: (child: { tools?: HostToolsRegistry }) => () => void) => unknown }

const OUTPUT_SPEC = {
  schema: { type: 'object', description: 'Read-only Paper Reader JSON response.' },
  render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
};
const toJsonObject = (value: unknown): JsonRecord => JSON.parse(JSON.stringify(value)) as JsonRecord;
const expectObject = (raw: unknown, allowedKeys: readonly string[]): JsonRecord => {
  if (!isObject(raw)) throw new ToolArgsError('arguments must be a JSON object');
  const allowed = new Set(allowedKeys), extra = Object.keys(raw).filter(k => !allowed.has(k));
  if (extra.length) throw new ToolArgsError(extra.map(k => `"${k}" is not a declared property (additionalProperties: false)`));
  return raw;
};
const readString = (obj: JsonRecord, key: string, maxLen: number, required: boolean): string | undefined => {
  const val = obj[key];
  if (val === undefined) { if (required) throw new ToolArgsError(`missing required property "${key}"`); return undefined; }
  if (typeof val !== 'string') throw new ToolArgsError(`"${key}" must be a string`);
  const trimmed = val.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new ToolArgsError(`"${key}" must be a non-empty string`);
  if (trimmed.length > maxLen) throw new ToolArgsError(`"${key}" exceeds maximum length ${maxLen}`);
  return trimmed;
};
const readIntRange = (obj: JsonRecord, key: string, min: number, max: number, fallback: number): number => {
  const val = obj[key];
  if (val === undefined) return fallback;
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < min || val > max) throw new ToolArgsError(`"${key}" must be an integer between ${min} and ${max}`);
  return val;
};
const readEnumValue = <T extends string | number>(obj: JsonRecord, key: string, allowed: readonly T[], fallback: T): T => {
  const val = obj[key];
  if (val === undefined) return fallback;
  const hit = allowed.find(item => item === val);
  if (hit === undefined) throw new ToolArgsError(`"${key}" must be one of ${JSON.stringify(allowed)}`);
  return hit;
};
const readTrendSources = (raw: unknown): TrendSource => {
  if (raw === undefined) return 'openalex';
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2) throw new ToolArgsError('"sources" must be a non-empty array of ["openalex" | "europepmc"]');
  const picked = new Set<'openalex' | 'europepmc'>();
  for (const item of raw) {
    if (item !== 'openalex' && item !== 'europepmc') throw new ToolArgsError('"sources" items must be "openalex" or "europepmc"');
    picked.add(item);
  }
  return picked.size === 2 ? 'all' : picked.has('europepmc') ? 'europepmc' : 'openalex';
};

function matchTopicScope(docs: readonly DocumentInfo[], topics: readonly TopicRecord[], topicQuery?: string): { docs: DocumentInfo[]; matchedTopic?: TopicRecord } {
  if (!topicQuery) return { docs: [...docs] };
  const needle = topicQuery.toLowerCase();
  const matchedTopic = topics.find(t => t.id.toLowerCase() === needle || t.name.toLowerCase() === needle || t.tag.toLowerCase() === needle || (t.zoteroCollection && t.zoteroCollection.toLowerCase() === needle));
  const tagTargets = new Set([needle, matchedTopic?.tag.toLowerCase(), matchedTopic?.name.toLowerCase()].filter((v): v is string => Boolean(v)));
  return { docs: docs.filter(doc => (doc.meta?.tags ?? []).some(tag => tagTargets.has(tag.trim().toLowerCase()))), matchedTopic };
}

function parseJsonArray<T>(raw: SQLOutputValue | undefined): T[] {
  if (typeof raw !== 'string') return [];
  try { const parsed: unknown = JSON.parse(raw); return Array.isArray(parsed) ? (parsed as T[]) : []; } catch { return []; }
}

async function listDocsWithMeta(store: ReaderStore, library: Library): Promise<DocumentInfo[]> {
  const docs = await library.list(), metas = store.withDb(false, db => listDocMeta(db));
  return docs.map(doc => { const meta = metas.get(doc.id); return meta ? { ...doc, meta } : doc; });
}

function readExtractionData(db: DatabaseSync, docIds: readonly string[]) {
  const tables = db.prepare('SELECT id, name, preset, columns_json FROM extraction_tables ORDER BY updated_at DESC, id ASC').all() as Row[];
  const docSet = new Set(docIds);
  return tables.map(tableRow => {
    const id = String(tableRow.id ?? '');
    const columns = parseJsonArray<{ id?: string; name?: string; type?: string }>(tableRow.columns_json)
      .filter(c => typeof c.id === 'string' && typeof c.name === 'string')
      .map(c => ({ id: c.id!, name: c.name!, type: typeof c.type === 'string' ? c.type : 'text' }));
    const cellRows = docIds.length
      ? db.prepare(`SELECT doc_id, col_id, value, quote, page, verified, manual_override FROM extraction_cells WHERE table_id=? AND doc_id IN (${docIds.map(() => '?').join(',')}) ORDER BY updated_at DESC`).all(id, ...docIds) as Row[]
      : [];
    const byDoc = new Map<string, Record<string, { value: string; quote: string; page: number | null; verified: boolean; manualOverride: boolean }>>();
    for (const r of cellRows) {
      const docId = String(r.doc_id ?? ''), colId = String(r.col_id ?? '');
      if (!docId || !colId || !docSet.has(docId)) continue;
      const bucket = byDoc.get(docId) ?? {};
      bucket[colId] = { value: String(r.value ?? ''), quote: String(r.quote ?? ''), page: typeof r.page === 'number' ? r.page : null, verified: r.verified === 1, manualOverride: r.manual_override === 1 };
      byDoc.set(docId, bucket);
    }
    return { id, name: String(tableRow.name ?? id), preset: String(tableRow.preset ?? 'cs_ai'), columns, rows: [...byDoc.entries()].map(([docId, cells]) => ({ docId, cells })) };
  });
}

function buildPaperReaderTools(deps: HostToolsDeps): HostToolDefinition[] {
  const { store, library, fetchFn } = deps;
  const readOnlyWithDb = <T>(writer: boolean, run: (db: DatabaseSync) => T): T => {
    if (writer) throw new Error('Read-only Paper Reader host tool attempted a SQLite write.');
    return store.withDb(false, run);
  };
  return [
    {
      name: 'paper_reader_search',
      description: 'Read-only search across local Paper Reader full-text PDF pages (FTS5), document metadata, notes, and highlights.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query text.' },
          topic: { type: 'string', description: 'Optional topic name, topic ID, tag, or Zotero collection filter.' },
          limit: { type: 'integer', description: 'Maximum hits per category (1 to 50, default 20).' }
        },
        required: ['query'],
        additionalProperties: false
      },
      output: OUTPUT_SPEC,
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'Search Paper Reader library' }),
      async execute(rawArgs) {
        const obj = expectObject(rawArgs, ['query', 'topic', 'limit']);
        const query = readString(obj, 'query', 500, true)!, topic = readString(obj, 'topic', 120, false), limit = readIntRange(obj, 'limit', 1, 50, 20);
        const allDocs = await listDocsWithMeta(store, library);
        return toJsonObject(readOnlyWithDb(false, db => {
          const { docs: scopedDocs, matchedTopic } = matchTopicScope(allDocs, listTopics(db), topic);
          const docMap = new Map(scopedDocs.map(d => [d.id, d])), docIds = scopedDocs.map(d => d.id);
          const ftsHits = docIds.length ? searchDocPagesFts(db, query, { docIds, limit }) : [];
          const libHits = scopedDocs.length ? searchLibrary(db, query, scopedDocs) : [];
          return {
            query, ...(topic ? { topic, matchedTopic: matchedTopic ?? null } : {}), limit, totalDocumentsSearched: scopedDocs.length,
            pageHits: ftsHits.map(h => { const d = docMap.get(h.docId); return { docId: h.docId, docTitle: d?.paperTitle || d?.title || h.docId, docKind: d?.kind ?? 'pdf', page: h.page, snippet: h.snippet, score: h.score }; }),
            metadataHits: libHits.filter(h => h.kind === 'doc').slice(0, limit),
            noteHits: libHits.filter(h => h.kind === 'note').slice(0, limit),
            highlightHits: libHits.filter(h => h.kind === 'mark').slice(0, limit)
          };
        }));
      }
    },
    {
      name: 'paper_reader_topic_summary',
      description: 'Read-only summary of a local research topic (or entire library when topic is omitted): documents, cached paper cards, saved review tables, and aggregated limitations/open problems.',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'Optional topic name, topic ID, tag, or Zotero collection.' } },
        additionalProperties: false
      },
      output: OUTPUT_SPEC,
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'Summarize Paper Reader topic' }),
      async execute(rawArgs) {
        const obj = expectObject(rawArgs === undefined ? {} : rawArgs, ['topic']);
        const topic = readString(obj, 'topic', 120, false), allDocs = await listDocsWithMeta(store, library);
        return toJsonObject(readOnlyWithDb(false, db => {
          const topics = listTopics(db), { docs: scopedDocs, matchedTopic } = matchTopicScope(allDocs, topics, topic);
          const docIds = scopedDocs.map(d => d.id), titleOf = new Map(scopedDocs.map(d => [d.id, d.paperTitle || d.title]));
          const paperCards = listPaperCards(db, docIds), extractionTables = readExtractionData(db, docIds);
          return {
            scope: topic ? 'topic' : 'library', ...(topic ? { topic, matchedTopic: matchedTopic ?? null } : {}),
            topics, documentCount: scopedDocs.length,
            documents: scopedDocs.map(d => ({ id: d.id, title: d.paperTitle || d.title, authors: d.authors ?? '', year: d.year ?? '', venue: d.venue ?? '', doi: d.doi ?? '', kind: d.kind, status: d.meta?.status ?? 'unread', starred: d.meta?.starred ?? false, tags: d.meta?.tags ?? [] })),
            paperCards, extractionTables,
            limitations: paperCards.filter(c => c.limitations.trim()).map(c => ({ docId: c.docId, title: titleOf.get(c.docId) ?? c.docId, limitations: c.limitations })),
            openProblems: paperCards.filter(c => c.futureWork.trim()).map(c => ({ docId: c.docId, title: titleOf.get(c.docId) ?? c.docId, futureWork: c.futureWork }))
          };
        }));
      }
    },
    {
      name: 'paper_reader_citation_stance',
      description: 'Read-only citation stance tallies, cached external citation stances, Scite report link, and live offline local-library back-citations for a paper.',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'Local Paper Reader document ID.' },
          doi: { type: 'string', description: 'Paper DOI.' },
          arxivId: { type: 'string', description: 'arXiv identifier.' },
          query: { type: 'string', description: 'Paper title, DOI, or arXiv query.' },
          direction: { type: 'string', enum: ['cited_by', 'references'], description: 'Citation direction (default cited_by).' }
        },
        additionalProperties: false
      },
      output: OUTPUT_SPEC,
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'Read Paper Reader citation stances' }),
      async execute(rawArgs) {
        const obj = expectObject(rawArgs, ['docId', 'doi', 'arxivId', 'query', 'direction']);
        const docId = readString(obj, 'docId', 512, false), doi = readString(obj, 'doi', 250, false), arxivId = readString(obj, 'arxivId', 64, false), query = readString(obj, 'query', 500, false);
        const direction = readEnumValue<CitationDirection>(obj, 'direction', ['cited_by', 'references'], 'cited_by');
        if (!docId && !doi && !arxivId && !query) throw new ToolArgsError('provide at least one of "docId", "doi", "arxivId", or "query"');
        return toJsonObject(await readCachedCitations({ store, library }, { docId, doi, arxivId, query, direction }));
      }
    },
    {
      name: 'paper_reader_field_trends',
      description: 'Read-only macro field trends query across OpenAlex and/or Europe PMC with local library coverage counts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Research field or topic query.' },
          windowYears: { type: 'integer', enum: [3, 5, 8], description: 'Trend window in years: 3, 5, or 8 (default 5).' },
          metric: { type: 'string', enum: ['volume', 'growth', 'citations'], description: 'Primary trend metric (default volume).' },
          sources: { type: 'array', items: { type: 'string', enum: ['openalex', 'europepmc'] }, description: 'Upstream trend sources (default ["openalex"]).' }
        },
        required: ['query'],
        additionalProperties: false
      },
      output: OUTPUT_SPEC,
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'Query research field trends' }),
      async execute(rawArgs, exec) {
        const obj = expectObject(rawArgs, ['query', 'windowYears', 'metric', 'sources']);
        const query = readString(obj, 'query', 250, true)!, windowYears = readEnumValue<TrendWindow>(obj, 'windowYears', [3, 5, 8], 5);
        const metric = readEnumValue<TrendMetric>(obj, 'metric', ['volume', 'growth', 'citations'], 'volume'), source = readTrendSources(obj.sources);
        const docs = await listDocsWithMeta(store, library);
        return toJsonObject(await queryFieldTrends({ query, source, windowYears, metric }, { withDb: readOnlyWithDb, settings: store.settings(), fetchFn, docs, signal: exec?.signal, readOnly: true }));
      }
    }
  ];
}

export function registerPaperReaderTools(ctx: ToolsHostLike | undefined, deps: HostToolsDeps): void {
  if (!ctx || typeof ctx.inject !== 'function') return;
  ctx.inject(['tools'], child => {
    const registry = child?.tools;
    if (!registry || typeof registry.register !== 'function') return () => {};
    const disposers = buildPaperReaderTools(deps).map(tool => registry.register(tool));
    return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose(); };
  });
}
