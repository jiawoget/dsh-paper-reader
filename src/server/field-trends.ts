import type { DocumentInfo } from '../shared/types.js';
import {
  computeCellYoyGrowth, computeCitationHeat, computeTrendGrowth, filterTrendTopics, sortTrendTopics,
  type TrendCell, type TrendMetric, type TrendPaper, type TrendPapersInput, type TrendPapersResult,
  type TrendPaperSort, type TrendQueryInput, type TrendQueryResult, type TrendSort, type TrendSource, type TrendTopicRow, type TrendWindow
} from '../shared/research-types.js';
import { arrOf, attachLibraryMatch, fetchJson, normTitle, oaUrl, parseEpmcItem, parseOaWork, shortTopicId, type GraphContext } from './academic-graph.js';
import { isObject, ServiceError, single, type Input } from './service-types.js';

export interface TrendContext extends GraphContext { nowYear?: number }

const TTL_TRENDS = 21_600_000;
const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'via', 'of', 'in', 'on', 'to', 'by', 'at', 'an', 'or', 'using', 'based']);
const sigTokens = (text: string): string[] => [...new Set(normTitle(text).split(' ').filter(t => t.length >= 3 && !STOPWORDS.has(t)))];

export function matchLocalDocsForTopic(
  topicId: string, topicName: string, docs: ReadonlyArray<DocumentInfo>, pageSnippets?: ReadonlyMap<string, string>
): string[] {
  const cleanName = topicName.replace(/\s*\(Europe PMC \/ PubMed\)$/i, '').trim();
  const idLow = topicId.trim().toLowerCase(), normName = normTitle(cleanName), nameTokens = sigTokens(cleanName);
  const nameTokenSet = new Set(nameTokens), needed = nameTokens.length >= 2 ? 2 : 1, matched: string[] = [];
  for (const doc of docs) {
    const tagHit = (doc.meta?.tags ?? []).some(raw => {
      const low = raw.trim().toLowerCase(), normTag = normTitle(raw);
      if (!low || !normTag) return false;
      if (low === idLow || normTag === normName || (normTag.length >= 3 && !STOPWORDS.has(normTag) && (' ' + normName + ' ').includes(' ' + normTag + ' '))) return true;
      const tks = sigTokens(raw);
      return tks.length > 0 && tks.every(t => nameTokenSet.has(t));
    });
    if (tagHit) { matched.push(doc.id); continue; }
    const body = normTitle([doc.paperTitle, doc.title, doc.abstract, pageSnippets?.get(doc.id)].filter(Boolean).join(' '));
    if (!body) continue;
    if (normName.length >= 4 && (' ' + body + ' ').includes(' ' + normName + ' ')) { matched.push(doc.id); continue; }
    if (!nameTokens.length || (nameTokens.length === 1 && nameTokens[0].length < 4)) continue;
    const bodyWords = new Set(body.split(' '));
    let hits = 0;
    for (const tk of nameTokens) if (bodyWords.has(tk)) hits++;
    if (hits >= needed) matched.push(doc.id);
  }
  return matched;
}

async function mapConcurrent<T, R>(items: ReadonlyArray<T>, concurrency: number, signal: AbortSignal | undefined, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new ServiceError(499, 'Request canceled.');
      const idx = cursor++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function loadPageSnippets(ctx: TrendContext): Map<string, string> {
  const out = new Map<string, string>();
  try {
    ctx.withDb(false, db => { for (const r of db.prepare('SELECT docId, text FROM doc_pages WHERE page=1').all()) if (typeof r.docId === 'string' && typeof r.text === 'string') out.set(r.docId, r.text.slice(0, 1500)); });
  } catch {}
  return out;
}

interface CacheTracker { total: number; hits: number; minAt?: number }
const trackCache = (tracker: CacheTracker, res: { fromCache: boolean; fetchedAt: number } | undefined) => {
  tracker.total++;
  if (!res) return;
  if (res.fromCache) tracker.hits++;
  if (res.fetchedAt > 0 && (tracker.minAt === undefined || res.fetchedAt < tracker.minAt)) tracker.minAt = res.fetchedAt;
};

function aggregateCitations(items: unknown[], yearField: string, citeField: string): { byYear: Map<number, { sum: number; n: number }>; sum: number; n: number } {
  const byYear = new Map<number, { sum: number; n: number }>();
  let sum = 0, n = 0;
  for (const item of items) {
    if (!isObject(item)) continue;
    const y = Number(item[yearField]), c = Number(item[citeField]);
    if (!Number.isFinite(c) || c < 0) continue;
    sum += c; n++;
    if (Number.isInteger(y)) {
      const prev = byYear.get(y) ?? { sum: 0, n: 0 };
      byYear.set(y, { sum: prev.sum + c, n: prev.n + 1 });
    }
  }
  return { byYear, sum, n };
}

function buildTopicRow(
  topicId: string, topicName: string, years: number[], ytdYear: number, countsByYear: Map<number, number>,
  cites: { byYear: Map<number, { sum: number; n: number }>; sum: number; n: number }, docs: ReadonlyArray<DocumentInfo>, snippets: ReadonlyMap<string, string>
): TrendTopicRow {
  const cells: TrendCell[] = years.map(year => {
    const volume = countsByYear.get(year) ?? 0, isYtd = year === ytdYear;
    const prev = countsByYear.has(year - 1) ? countsByYear.get(year - 1) : undefined;
    const { yoyGrowth, lowBase } = computeCellYoyGrowth(volume, prev, isYtd), c = cites.byYear.get(year);
    return { year, volume, isYtd, yoyGrowth, lowBase, citations: c?.sum ?? 0, citationHeat: computeCitationHeat(c?.sum ?? 0, c?.n ?? 0) };
  });
  const totalVolume = cells.reduce((acc, c) => acc + c.volume, 0);
  const { recent2yr, prior2yr, growth, lowBase } = computeTrendGrowth(countsByYear, ytdYear);
  const localDocIds = matchLocalDocsForTopic(topicId, topicName, docs, snippets);
  return { topicId, topicName, totalVolume, recent2yr, prior2yr, growth, lowBase, citationHeat: computeCitationHeat(cites.sum, cites.n), localCount: localDocIds.length, localDocIds, cells };
}

function parseGroupByYear(data: unknown, fetchStart: number, endYear: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (let y = fetchStart; y <= endYear; y++) counts.set(y, 0);
  for (const row of arrOf(isObject(data) ? data.group_by : undefined)) {
    if (!isObject(row)) continue;
    const y = Number(row.key), n = Number(row.count);
    if (Number.isInteger(y) && Number.isFinite(n) && n >= 0) counts.set(y, n);
  }
  return counts;
}

const sanitizeEpmcQuery = (q: string): string => q.replace(/[()"[\]{}\\:]/g, ' ').replace(/&&|\|\|/g, ' ').replace(/\b(?:AND|OR|NOT)\b/g, m => m.toLowerCase()).replace(/\s+/g, ' ').trim();
const sanitizeEpmcMesh = (m: string): string => m.replace(/[\\"]/g, '').trim();
const epmcResults = (data: unknown): unknown[] => arrOf(isObject(data) && isObject(data.resultList) ? data.resultList.result : undefined);
const epmcUrl = (q: string, resultType: 'lite' | 'core', pageSize: number, sort?: string): string => {
  const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
  for (const [k, v] of Object.entries({ query: q, format: 'json', resultType, pageSize: String(pageSize), ...(sort ? { sort } : {}) })) url.searchParams.set(k, v);
  return url.href;
};

async function fetchEpmcTrendRow(
  topicId: string, topicName: string, baseQuery: string, years: number[], fetchStart: number, ytdYear: number,
  docs: ReadonlyArray<DocumentInfo>, snippets: ReadonlyMap<string, string>, ctx: TrendContext, degraded: Set<string>, cache: CacheTracker
): Promise<TrendTopicRow | undefined> {
  const spanYears = Array.from({ length: ytdYear - fetchStart + 1 }, (_, i) => fetchStart + i), counts = new Map<number, number>();
  let anyYearOk = false;
  await mapConcurrent(spanYears, 3, ctx.signal, async y => {
    const res = await fetchJson('europepmc', `epmc:trends:y:${normTitle(baseQuery)}:${y}`, epmcUrl(`(${baseQuery}) AND PUB_YEAR:${y}`, 'lite', 1), ctx, degraded, TTL_TRENDS);
    trackCache(cache, res);
    if (res && isObject(res.data)) {
      anyYearOk = true;
      const n = Number(res.data.hitCount);
      counts.set(y, Number.isFinite(n) && n >= 0 ? n : 0);
    } else counts.set(y, 0);
  });
  if (!anyYearOk) return undefined;
  const sampleQ = `(${baseQuery}) AND PUB_YEAR:[${years[0]} TO ${ytdYear}]`;
  const sampleRes = await fetchJson('europepmc', `epmc:trends:cites:${normTitle(baseQuery)}:${years[0]}-${ytdYear}`, epmcUrl(sampleQ, 'lite', 25, 'CITED desc'), ctx, degraded, TTL_TRENDS);
  trackCache(cache, sampleRes);
  return buildTopicRow(topicId, topicName, years, ytdYear, counts, aggregateCitations(epmcResults(sampleRes?.data), 'pubYear', 'citedByCount'), docs, snippets);
}

export async function queryFieldTrends(rawInput: TrendQueryInput, ctx: TrendContext): Promise<TrendQueryResult> {
  const query = single(rawInput.query, 'search query', 250, true), source: TrendSource = rawInput.source ?? 'openalex';
  const windowYears: TrendWindow = rawInput.windowYears ?? 5, metric: TrendMetric = rawInput.metric ?? 'volume', sort: TrendSort = rawInput.sort ?? 'fastest_growing';
  const blindSpotsOnly = rawInput.blindSpotsOnly === true, topicLimit = Math.min(10, Math.max(1, Math.floor(rawInput.topicLimit ?? 8)));
  const ytdYear = ctx.nowYear ?? new Date().getUTCFullYear(), years = Array.from({ length: windowYears }, (_, i) => ytdYear - windowYears + 1 + i);
  const startYear = years[0], fetchStart = Math.min(startYear - 1, ytdYear - 4), normQ = normTitle(query);
  const docs = ctx.docs ?? [], snippets = loadPageSnippets(ctx), degraded = new Set<string>(), cache: CacheTracker = { total: 0, hits: 0 }, rows: TrendTopicRow[] = [];

  if (source === 'openalex' || source === 'all') {
    const discUrl = oaUrl('/works', { search: query, filter: `publication_year:${startYear}-${ytdYear}`, group_by: 'primary_topic.id', 'per-page': '20' }, ctx.settings);
    const disc = await fetchJson('openalex', `oa:trends:topics:${normQ}:${startYear}-${ytdYear}`, discUrl, ctx, degraded, TTL_TRENDS);
    trackCache(cache, disc);
    const discovered: { id: string; name: string }[] = [];
    for (const entry of arrOf(isObject(disc?.data) ? disc.data.group_by : undefined)) {
      if (!isObject(entry)) continue;
      const tid = shortTopicId(entry.key), name = typeof entry.key_display_name === 'string' ? entry.key_display_name.trim() : '';
      if (tid && name && !discovered.some(d => d.id === tid)) discovered.push({ id: tid, name });
      if (discovered.length >= topicLimit) break;
    }
    const oaRows = await mapConcurrent(discovered, 3, ctx.signal, async topic => {
      const yrUrl = oaUrl('/works', { search: query, filter: `primary_topic.id:${topic.id},publication_year:${fetchStart}-${ytdYear}`, group_by: 'publication_year' }, ctx.settings);
      const ctUrl = oaUrl('/works', { search: query, filter: `primary_topic.id:${topic.id},publication_year:${startYear}-${ytdYear}`, sort: 'cited_by_count:desc', 'per-page': '25', select: 'publication_year,cited_by_count' }, ctx.settings);
      const [yrRes, ctRes] = await Promise.all([
        fetchJson('openalex', `oa:trends:years:${normQ}:${topic.id}:${fetchStart}-${ytdYear}`, yrUrl, ctx, degraded, TTL_TRENDS),
        fetchJson('openalex', `oa:trends:cites:${normQ}:${topic.id}:${startYear}-${ytdYear}`, ctUrl, ctx, degraded, TTL_TRENDS)
      ]);
      trackCache(cache, yrRes); trackCache(cache, ctRes);
      if (!yrRes) return undefined;
      const counts = parseGroupByYear(yrRes.data, fetchStart, ytdYear);
      const cites = aggregateCitations(arrOf(isObject(ctRes?.data) ? ctRes.data.results : undefined), 'publication_year', 'cited_by_count');
      return buildTopicRow(topic.id, topic.name, years, ytdYear, counts, cites, docs, snippets);
    });
    for (const row of oaRows) if (row) rows.push(row);
  }

  const safeQ = sanitizeEpmcQuery(query);
  let needEpmcAll = source === 'all';
  if (source === 'europepmc') {
    if (!safeQ) throw new ServiceError(400, 'Enter a valid search query.');
    const coreRes = await fetchJson('europepmc', `epmc:trends:mesh:${normQ}:${startYear}-${ytdYear}`, epmcUrl(`(${safeQ}) AND PUB_YEAR:[${startYear} TO ${ytdYear}]`, 'core', 25), ctx, degraded, TTL_TRENDS);
    trackCache(cache, coreRes);
    const meshCounts = new Map<string, number>();
    for (const item of epmcResults(coreRes?.data)) {
      for (const h of arrOf(isObject(item) && isObject(item.meshHeadingList) ? item.meshHeadingList.meshHeading : undefined)) {
        const desc = isObject(h) && typeof h.descriptorName === 'string' ? sanitizeEpmcMesh(h.descriptorName) : '';
        if (desc && !/^(humans|animals|male|female|adult|aged|middle aged)$/i.test(desc)) meshCounts.set(desc, (meshCounts.get(desc) ?? 0) + 1);
      }
    }
    const topMesh = [...meshCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.min(topicLimit, 5)).map(([m]) => m);
    if (topMesh.length) {
      const epmcRows = await mapConcurrent(topMesh, 2, ctx.signal, m =>
        fetchEpmcTrendRow(`epmc:mesh:${normTitle(m)}`, m, `(${safeQ}) AND MESH:"${m}"`, years, fetchStart, ytdYear, docs, snippets, ctx, degraded, cache)
      );
      for (const row of epmcRows) if (row) rows.push(row);
    } else needEpmcAll = true;
  }
  if (needEpmcAll && safeQ) {
    const epmcSummary = await fetchEpmcTrendRow('epmc:all', `${query} (Europe PMC / PubMed)`, safeQ, years, fetchStart, ytdYear, docs, snippets, ctx, degraded, cache);
    if (epmcSummary) rows.push(epmcSummary);
  }

  const topics = filterTrendTopics(sortTrendTopics(rows, sort, metric), blindSpotsOnly);
  const fromCache = cache.total > 0 && cache.hits === cache.total;
  return { query, source, windowYears, years, ytdYear, metric, sort, blindSpotsOnly, topics, degraded: [...degraded], fromCache, ...(cache.minAt !== undefined ? { cachedAt: cache.minAt } : {}) };
}

function docToTrendPaper(doc: DocumentInfo, topicId: string, topicName: string, source: 'openalex' | 'europepmc'): TrendPaper {
  const authors = (doc.authors ?? '').split(/\s*[;,]\s*/).filter(Boolean), yr = Number(doc.year);
  return {
    id: doc.id, title: doc.paperTitle || doc.title, authors, firstAuthor: authors[0] ?? '', lastAuthor: authors.at(-1) ?? '',
    year: Number.isInteger(yr) && yr > 1800 ? yr : undefined, venue: doc.venue, doi: doc.doi, abstract: doc.abstract,
    url: doc.url, source, inLibrary: true, docId: doc.id, localDocId: doc.id, primaryTopicId: topicId, primaryTopicName: topicName
  };
}

const withLibraryMatch = (paper: TrendPaper, docs: DocumentInfo[], primaryTopicId: string, primaryTopicName: string): TrendPaper => {
  const matched = attachLibraryMatch(paper, docs);
  return { ...matched, ...(matched.docId ? { localDocId: matched.docId } : {}), primaryTopicId, primaryTopicName };
};
const readEnum = <T extends string | number>(v: unknown, def: T, allowed: readonly T[], msg: string): T => { const hit = allowed.find(a => a === (v === undefined ? def : v)); if (hit === undefined) throw new ServiceError(400, msg); return hit; };
const readInt = (v: unknown, min: number, max: number, msg: string): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new ServiceError(400, msg); return v; };

export async function queryTrendPapers(rawInput: TrendPapersInput, ctx: TrendContext): Promise<TrendPapersResult> {
  const query = single(rawInput.query, 'search query', 250, true), topicId = single(rawInput.topicId, 'topic ID', 128, true);
  const topicName = rawInput.topicName ? single(rawInput.topicName, 'topic name', 200) : topicId, year = rawInput.year;
  if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new ServiceError(400, 'Enter a valid publication year.');
  const source: TrendSource = rawInput.source ?? 'openalex', sort: TrendPaperSort = rawInput.sort ?? 'representative';
  const limit = Math.min(25, Math.max(1, Math.floor(rawInput.limit ?? 15))), docs = ctx.docs ?? [], degraded = new Set<string>();
  const finish = (tid: string, papers: TrendPaper[], res?: { fromCache: boolean; fetchedAt: number }): TrendPapersResult =>
    ({ query, topicId: tid, topicName, year, source, sort, papers, degraded: [...degraded], fromCache: Boolean(res?.fromCache), ...(res?.fetchedAt ? { cachedAt: res.fetchedAt } : {}) });

  const isEpmc = source === 'europepmc' || topicId.startsWith('epmc:');
  if (sort === 'library') {
    const matched = new Set(matchLocalDocsForTopic(topicId, topicName, docs, loadPageSnippets(ctx)));
    const papers = docs.filter(d => matched.has(d.id)).map(d => docToTrendPaper(d, topicId, topicName, isEpmc ? 'europepmc' : 'openalex'))
      .sort((a, b) => Number(b.year === year) - Number(a.year === year) || (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title)).slice(0, limit);
    return finish(topicId, papers);
  }

  if (isEpmc) {
    const isAll = topicId === 'epmc:all', meshSlug = topicId.startsWith('epmc:mesh:') ? topicId.slice('epmc:mesh:'.length).trim() : '';
    const cleanMesh = meshSlug ? sanitizeEpmcMesh(rawInput.topicName ? topicName : meshSlug) : '';
    if (!isAll && !cleanMesh) throw new ServiceError(400, 'Invalid Europe PMC topic ID.');
    const safeQ = sanitizeEpmcQuery(query);
    if (!safeQ) throw new ServiceError(400, 'Enter a valid search query.');
    const epmcQ = isAll ? `(${safeQ}) AND PUB_YEAR:${year}` : `(${safeQ}) AND MESH:"${cleanMesh}" AND PUB_YEAR:${year}`;
    const res = await fetchJson('europepmc', `epmc:trends:papers:${normTitle(query)}:${topicId}:${year}:${sort}:${limit}`, epmcUrl(epmcQ, 'core', limit, sort === 'newest' ? 'P_PDATE_D desc' : 'CITED desc'), ctx, degraded, TTL_TRENDS);
    const papers = epmcResults(res?.data).map(parseEpmcItem).filter((p): p is NonNullable<typeof p> => Boolean(p && p.year === year))
      .map(p => withLibraryMatch(p, docs, topicId, topicName)).slice(0, limit);
    return finish(topicId, papers, res);
  }

  const oaTopicId = shortTopicId(topicId);
  if (!oaTopicId) throw new ServiceError(400, 'Invalid OpenAlex topic ID.');
  const url = oaUrl('/works', { search: query, filter: `primary_topic.id:${oaTopicId},publication_year:${year}`, sort: sort === 'newest' ? 'publication_date:desc' : 'cited_by_count:desc', 'per-page': String(limit) }, ctx.settings);
  const res = await fetchJson('openalex', `oa:trends:papers:${normTitle(query)}:${oaTopicId}:${year}:${sort}:${limit}`, url, ctx, degraded, TTL_TRENDS);
  const papers = arrOf(isObject(res?.data) ? res.data.results : undefined).map(parseOaWork)
    .filter((w): w is NonNullable<typeof w> => Boolean(w && w.paper.year === year && w.primaryTopicId === oaTopicId))
    .map(w => withLibraryMatch(w.paper, docs, oaTopicId, w.primaryTopicName ?? topicName)).slice(0, limit);
  return finish(oaTopicId, papers, res);
}

export function readTrendQueryInput(input: Input): TrendQueryInput {
  if (input.blindSpotsOnly !== undefined && typeof input.blindSpotsOnly !== 'boolean') throw new ServiceError(400, 'Invalid blindSpotsOnly option.');
  return {
    query: single(input.query, 'search query', 250, true), source: readEnum<TrendSource>(input.source, 'openalex', ['openalex', 'europepmc', 'all'], 'Choose openalex, europepmc, or all.'),
    windowYears: readEnum<TrendWindow>(input.windowYears, 5, [3, 5, 8], 'Choose a 3, 5, or 8 year window.'), metric: readEnum<TrendMetric>(input.metric, 'volume', ['volume', 'growth', 'citations'], 'Choose volume, growth, or citations.'),
    sort: readEnum<TrendSort>(input.sort, 'fastest_growing', ['fastest_growing', 'hottest', 'blind_spots_first'], 'Choose fastest_growing, hottest, or blind_spots_first.'),
    blindSpotsOnly: input.blindSpotsOnly === true, topicLimit: input.topicLimit === undefined ? undefined : readInt(input.topicLimit, 1, 10, 'Invalid topic limit.')
  };
}
export function readTrendPapersInput(input: Input): TrendPapersInput {
  return {
    query: single(input.query, 'search query', 250, true), topicId: single(input.topicId, 'topic ID', 128, true),
    topicName: input.topicName === undefined ? undefined : single(input.topicName, 'topic name', 200), year: readInt(input.year, 1900, 2100, 'Enter a valid publication year.'),
    source: readEnum<TrendSource>(input.source, 'openalex', ['openalex', 'europepmc', 'all'], 'Choose openalex, europepmc, or all.'),
    sort: readEnum<TrendPaperSort>(input.sort, 'representative', ['representative', 'newest', 'library'], 'Choose representative, newest, or library.'),
    limit: input.limit === undefined ? undefined : readInt(input.limit, 1, 25, 'Invalid paper limit.')
  };
}
