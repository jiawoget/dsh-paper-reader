import { randomUUID } from 'node:crypto';
import type { WatchlistCheckResult, WatchlistEntry, WatchlistItem, WatchlistKind } from '../shared/deep-search-types.js';
import type { DocumentInfo, GraphPaper, GraphSource } from '../shared/types.js';
import { arrOf, attachLibraryMatch, cleanDoi, fetchJson, paperCanonKey, paperIdentityKeys, parseS2Paper, resolveAcademicPaper, S2_FIELDS, s2Headers, shortOaId, type GraphContext } from './academic-graph.js';
import { searchSourcePapers } from './deep-search.js';
import type { Library } from './library.js';
import type { ReaderStore } from './reader-store.js';
import { deleteWatchlistEntry, getWatchlistEntry, listWatchlistEntries, upsertWatchlistEntry, VALID_GRAPH_SOURCES } from './research-store.js';
import { isObject, ServiceError, single, type Input } from './service-types.js';

interface WatchlistDeps { store: ReaderStore; library: Library; fetchFn?: typeof fetch; sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void> }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s: string): boolean => { if (!DATE_RE.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const todayIso = (): string => new Date().toISOString().slice(0, 10), defaultCursor = (): string => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

function parseSources(raw: unknown, kind: WatchlistKind): GraphSource[] {
  if (raw === undefined) return kind === 'paper' ? ['openalex', 's2'] : ['openalex', 'europepmc', 'arxiv'];
  if (!Array.isArray(raw) || !raw.length || raw.length > 4) throw new ServiceError(400, 'Choose 1 to 4 watchlist sources.');
  const out = [...new Set(raw.filter((s): s is GraphSource => typeof s === 'string' && VALID_GRAPH_SOURCES.has(s as GraphSource)))];
  if (!out.length || out.length !== new Set(raw).size) throw new ServiceError(400, 'Choose valid watchlist sources.');
  return out;
}

export const listWatchlist = (deps: WatchlistDeps): { entries: WatchlistEntry[] } => ({ entries: deps.store.withDb(false, listWatchlistEntries) });
export const deleteWatchlist = (input: Input, deps: WatchlistDeps): { id: string; deleted: boolean } => deps.store.withDb(true, db => deleteWatchlistEntry(db, single(input.id, 'watchlist ID', 128, true)));

export async function saveWatchlist(input: Input, deps: WatchlistDeps): Promise<{ entry: WatchlistEntry }> {
  if (input.kind !== 'topic' && input.kind !== 'paper') throw new ServiceError(400, 'Choose topic or paper watchlist kind.');
  const kind: WatchlistKind = input.kind, id = input.id === undefined ? randomUUID() : single(input.id, 'watchlist ID', 128, true), prev = deps.store.withDb(false, db => getWatchlistEntry(db, id));
  const docId = input.docId === undefined ? prev?.docId : (single(input.docId, 'document ID', 512) || undefined), doc = docId ? await deps.library.get(docId) : undefined;
  const rawQuery = input.query === undefined ? (prev?.query ?? (doc ? (doc.doi || doc.paperTitle || doc.title) : '')) : single(input.query, 'watchlist query', 500);
  const workId = input.workId === undefined ? (prev?.workId ?? (doc?.doi ? cleanDoi(doc.doi) : undefined)) : (single(input.workId, 'work ID', 200) || undefined);
  const query = rawQuery || workId || '';
  if (!query) throw new ServiceError(400, 'Provide a query, document, or work ID for this watchlist.');
  const label = input.label !== undefined ? single(input.label, 'watchlist label', 120, true) : (prev?.label || (doc?.paperTitle || doc?.title || query).slice(0, 120));
  const sources = input.sources === undefined && prev ? prev.sources : parseSources(input.sources, kind);
  const cursorDate = input.cursorDate === undefined ? (prev?.cursorDate || defaultCursor()) : single(input.cursorDate, 'cursor date', 16, true);
  if (!isIsoDate(cursorDate)) throw new ServiceError(400, 'Cursor date must be a valid YYYY-MM-DD date.');
  const now = new Date().toISOString();
  return { entry: deps.store.withDb(true, db => upsertWatchlistEntry(db, { id, kind, label, query, ...(docId ? { docId } : {}), ...(workId ? { workId } : {}), sources, cursorDate, seenKeys: prev?.seenKeys ?? [], unread: prev?.unread ?? [], ...(prev?.lastCheckedAt ? { lastCheckedAt: prev.lastCheckedAt } : {}), createdAt: prev?.createdAt ?? now, updatedAt: now })) };
}

export function markWatchlistRead(input: Input, deps: WatchlistDeps): { entry: WatchlistEntry } {
  const id = single(input.id, 'watchlist ID', 128, true);
  const keys = input.keys === undefined ? undefined : (() => { if (!Array.isArray(input.keys) || input.keys.length > 500) throw new ServiceError(400, 'Invalid watchlist keys.'); return new Set(input.keys.map(k => single(k, 'watchlist item key', 256, true))); })();
  return { entry: deps.store.withDb(true, db => { const cur = getWatchlistEntry(db, id); if (!cur) throw new ServiceError(404, 'Watchlist entry not found.'); return upsertWatchlistEntry(db, { ...cur, unread: keys ? cur.unread.filter(i => !keys.has(i.key)) : [], updatedAt: new Date().toISOString() }); }) };
}

async function fetchWatchPapers(entry: WatchlistEntry, docs: DocumentInfo[], ctx: GraphContext, degraded: Set<string>): Promise<{ items: { paper: GraphPaper; pubDate?: string }[]; workId?: string; attempted: number; selfKeys: Set<string> }> {
  const items: { paper: GraphPaper; pubDate?: string }[] = [], cursorYear = Number(entry.cursorDate.slice(0, 4)) || 1900, selfKeys = new Set<string>();
  let attempted = 0, workId = entry.workId;
  if (entry.kind === 'topic') {
    for (const src of entry.sources) { attempted++; items.push(...await searchSourcePapers(src, entry.query, ctx, degraded, { since: entry.cursorDate, limit: 20, noCache: true, cacheKey: `wl:${src}:${entry.id}` })); }
    return { items, workId, attempted, selfKeys };
  }
  const localDoc = entry.docId ? docs.find(d => d.id === entry.docId) : undefined, oaId0 = shortOaId(workId), docDoi = cleanDoi(localDoc?.doi), workDoi = workId && !oaId0 ? cleanDoi(workId) : undefined;
  let oaId = oaId0, s2Key = workDoi?.startsWith('10.') ? 'DOI:' + workDoi : (workId && !oaId ? workId : (docDoi ? 'DOI:' + docDoi : ''));
  for (const k of [oaId && 'oa:' + oaId, docDoi && 'doi:' + docDoi.toLowerCase(), workDoi && 'doi:' + workDoi.toLowerCase()]) if (k) selfKeys.add(k);
  if ((entry.sources.includes('openalex') && !oaId) || (entry.sources.includes('s2') && !s2Key)) {
    const resolved = await resolveAcademicPaper((!oaId && workId) || docDoi || localDoc?.url || localDoc?.paperTitle || localDoc?.title || entry.query, ctx);
    for (const d of resolved.degraded) degraded.add(d);
    if (resolved.paper) {
      oaId = oaId ?? resolved.paper.openAlexId; s2Key = s2Key || resolved.paper.s2Id || (resolved.paper.doi ? 'DOI:' + resolved.paper.doi : resolved.paper.arxivId ? 'ARXIV:' + resolved.paper.arxivId : '');
      workId = oaId ?? resolved.paper.doi ?? resolved.paper.arxivId ?? resolved.paper.s2Id ?? workId; for (const k of paperIdentityKeys(resolved.paper)) selfKeys.add(k);
    }
  }
  if (entry.sources.includes('openalex') && oaId) { attempted++; items.push(...await searchSourcePapers('openalex', '', ctx, degraded, { oaFilter: `cites:${oaId},from_publication_date:${entry.cursorDate}`, limit: 20, noCache: true, cacheKey: `wl:oacite:${entry.id}` })); }
  if (entry.sources.includes('s2') && s2Key) {
    attempted++;
    const res = await fetchJson('s2', `wl:s2cite:${entry.id}`, `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2Key)}/citations?fields=${S2_FIELDS}&limit=20`, ctx, degraded, 60_000, { method: 'GET', headers: s2Headers(ctx.settings) }, true);
    for (const row of arrOf(isObject(res?.data) ? res.data.data : undefined)) { const p = parseS2Paper(isObject(row) ? row.citingPaper : undefined); if (p && (!p.year || p.year >= cursorYear)) items.push({ paper: p }); }
  }
  return { items, workId, attempted, selfKeys };
}

export async function checkWatchlist(input: Input, deps: WatchlistDeps, signal?: AbortSignal): Promise<WatchlistCheckResult> {
  const targetId = input.id === undefined ? undefined : single(input.id, 'watchlist ID', 128, true);
  const all = deps.store.withDb(false, listWatchlistEntries), targets = targetId ? all.filter(e => e.id === targetId) : all;
  if (targetId && !targets.length) throw new ServiceError(404, 'Watchlist entry not found.');
  const docs = await deps.library.list(), allDegraded = new Set<string>();
  const ctx: GraphContext = { withDb: (w, run) => deps.store.withDb(w, run), settings: deps.store.settings(), fetchFn: deps.fetchFn, sleepFn: deps.sleepFn, docs, signal };
  let newItemsCount = 0, checkedCount = 0;
  for (const entry of targets) {
    if (signal?.aborted) break;
    const entryDeg = new Set<string>(), { items, workId, attempted, selfKeys } = await fetchWatchPapers(entry, docs, ctx, entryDeg);
    checkedCount++;
    for (const d of entryDeg) allDegraded.add(d);
    deps.store.withDb(true, db => {
      const cur = getWatchlistEntry(db, entry.id);
      if (!cur) return;
      const seen = new Set(cur.seenKeys), curUnread = new Set(cur.unread.map(i => i.key)), nowIso = new Date().toISOString(), today = todayIso(), fresh: WatchlistItem[] = [];
      let maxDate = '';
      for (const { paper, pubDate } of items) {
        if (pubDate && isIsoDate(pubDate) && pubDate <= today && pubDate > maxDate) maxDate = pubDate;
        const key = paperCanonKey(paper), pKeys = paperIdentityKeys(paper), allKeys = pKeys.length ? pKeys : [key];
        if (curUnread.has(key) || allKeys.some(k => selfKeys.has(k) || seen.has(k))) continue;
        for (const k of allKeys) seen.add(k);
        fresh.push({ key, paper: attachLibraryMatch(paper, docs), foundAt: nowIso });
      }
      const nextCursor = entryDeg.size || !attempted ? entry.cursorDate : (maxDate > entry.cursorDate ? maxDate : (!items.length && today > entry.cursorDate ? today : entry.cursorDate));
      newItemsCount += fresh.length;
      upsertWatchlistEntry(db, { ...cur, ...(workId && cur.workId === entry.workId ? { workId } : {}), cursorDate: cur.cursorDate === entry.cursorDate ? nextCursor : cur.cursorDate, seenKeys: [...seen].slice(-500), unread: [...fresh, ...cur.unread].slice(0, 100), lastCheckedAt: nowIso, updatedAt: nowIso });
    });
  }
  return { entries: deps.store.withDb(false, listWatchlistEntries), checkedCount, newItemsCount, degraded: [...allDegraded] };
}
