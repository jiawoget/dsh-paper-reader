import type { DatabaseSync } from 'node:sqlite';
import { parseAcademicInput } from '../shared/academic-intake.js';
import { extractArxivId } from '../shared/citation-export.js';
import { buildCitationGraphEdges, rankEarlierByCoCitation, reconstructInvertedAbstract } from '../shared/graph-layout.js';
import type { DocumentInfo, GraphDirection, GraphEdge, GraphExploreResult, GraphNode, GraphPaper, GraphSource } from '../shared/types.js';
import { articleUrl } from '../shared/web-article.js';
import { getGraphCache, setGraphCache } from './research-store.js';
import { isObject, ServiceError, single, type Input, type PrivateSettings } from './service-types.js';

export interface GraphContext {
  withDb: <T>(writer: boolean, run: (db: DatabaseSync) => T) => T;
  settings?: Partial<PrivateSettings>; fetchFn?: typeof fetch; sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>; docs?: DocumentInfo[]; signal?: AbortSignal; readOnly?: boolean;
}
interface ResolvedWork { paper: GraphPaper; referencedIds: string[]; relatedIds: string[]; fromCache: boolean; primaryTopicId?: string; primaryTopicName?: string; publishedDate?: string }

const OA_SELECT = 'id,doi,ids,title,display_name,publication_year,publication_date,authorships,primary_location,best_oa_location,cited_by_count,referenced_works,related_works,abstract_inverted_index,primary_topic';
export const S2_FIELDS = 'paperId,externalIds,title,abstract,year,venue,citationCount,authors,openAccessPdf,url';
const TTL_WORK = 86_400_000, TTL_EXPLORE = 21_600_000, sourceNextAt = new Map<GraphSource, number>();
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined, num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const safeUrl = (v: unknown) => str(v) ? articleUrl(str(v)!)?.href : undefined;
export const arrOf = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const cleanDoi = (v: unknown) => str(v)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim() || undefined;
const cleanPmid = (v: unknown) => { const s = str(v); return s && /^\d+$/.test(s) ? s : undefined; };
export const shortOaId = (v: unknown) => str(v) ? /(?:^|\/)(W\d+)\/?$/i.exec(str(v)!)?.[1]?.toUpperCase() : undefined;
export const shortTopicId = (v: unknown): string | undefined => str(v) ? /(?:^|\/)(T\d+)\/?$/i.exec(str(v)!)?.[1]?.toUpperCase() : undefined;
export const normTitle = (s?: string): string => (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function paperIdentityKeys(p: GraphPaper): string[] {
  const arxiv = (extractArxivId(p.arxivId, p.doi) ?? p.arxivId)?.toLowerCase(), doi = p.doi?.toLowerCase(), t = normTitle(p.title), axDoi = Boolean(doi && /^10\.48550\/arxiv\./i.test(doi));
  return [...new Set([doi && !axDoi && 'doi:' + doi, arxiv && 'arxiv:' + arxiv, doi && axDoi && 'doi:' + doi, p.pmid && 'pmid:' + p.pmid, p.openAlexId && 'oa:' + p.openAlexId.toUpperCase(), p.s2Id && 's2:' + p.s2Id, t.length >= 8 && 'title:' + t].filter((v): v is string => Boolean(v)))];
}
export const paperCanonKey = (p: GraphPaper): string => paperIdentityKeys(p)[0] ?? 'title:' + normTitle(p.title);
const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decodeXml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/[&<>]/g, ch => ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;')).replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (_, k: string) => XML_ENT[k]).replace(/\s+/g, ' ').trim();
export const s2Headers = (s?: Partial<PrivateSettings>, json = false): Record<string, string> => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), ...(s?.semanticScholarApiKey ? { 'x-api-key': s.semanticScholarApiKey } : {}) });

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ServiceError(499, 'Request canceled.'));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new ServiceError(499, 'Request canceled.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
function retryDelay(raw: string | null, attempt: number): number {
  const text = raw?.trim(), fallback = 250 * (2 ** attempt), sec = text ? Number(text) : Number.NaN;
  if (Number.isFinite(sec)) return sec > 30 ? -1 : sec >= 0 ? Math.min(5000, Math.round(sec * 1000)) : fallback;
  const at = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(at) ? (at - Date.now() > 30_000 ? -1 : Math.min(5000, Math.max(0, at - Date.now()))) : fallback;
}

function makePaper(p: Omit<GraphPaper, 'id' | 'firstAuthor' | 'lastAuthor'> & { id?: string }): GraphPaper {
  const arxivId = p.arxivId?.toLowerCase(), oaPdfUrl = safeUrl(p.oaPdfUrl) ?? (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined);
  const url = safeUrl(p.url) ?? (p.doi ? `https://doi.org/${p.doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : p.openAlexId ? `https://openalex.org/${p.openAlexId}` : p.pmid ? `https://europepmc.org/article/MED/${p.pmid}` : undefined);
  const id = p.id || p.openAlexId || p.s2Id || (p.pmid ? `pmid:${p.pmid}` : p.doi ? `doi:${p.doi.toLowerCase()}` : arxivId ? `arxiv:${arxivId}` : normTitle(p.title));
  return { ...p, id, arxivId, oaPdfUrl, url, firstAuthor: p.authors[0] ?? '', lastAuthor: p.authors.at(-1) ?? '' };
}
export async function cachedFetch<T>(
  source: GraphSource, key: string, url: string, init: RequestInit, ttlMs: number, parse: (res: Response) => Promise<T>, ctx: GraphContext, degraded: Set<string>, noCache = false
): Promise<{ data: T; fromCache: boolean; fetchedAt: number } | undefined> {
  if (ctx.signal?.aborted) throw new ServiceError(499, 'Request canceled.');
  const cached = noCache ? undefined : (() => { try { return ctx.withDb(false, db => getGraphCache<T>(db, key)); } catch (e) { if (ctx.readOnly) return undefined; throw e; } })();
  if (cached && !cached.stale) return { data: cached.value, fromCache: true, fetchedAt: cached.fetchedAt };
  const fetcher = ctx.fetchFn ?? globalThis.fetch, sleep = ctx.sleepFn ?? defaultSleep, headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) headers.set('User-Agent', 'DSH-Paper-Reader/0.1 (academic graph)');
  let failed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (ctx.signal?.aborted) throw new ServiceError(499, 'Request canceled.');
    if (!ctx.fetchFn || ctx.fetchFn === globalThis.fetch) {
      const gap = source === 's2' ? (ctx.settings?.semanticScholarApiKey ? 120 : 1050) : source === 'arxiv' ? 350 : source === 'europepmc' ? 200 : 100;
      const now = Date.now(), prev = sourceNextAt.get(source) ?? 0;
      sourceNextAt.set(source, Math.max(now, prev) + gap);
      if (prev > now) await sleep(prev - now, ctx.signal);
    }
    try {
      const timeout = AbortSignal.timeout(12_000), res = await fetcher(url, { ...init, headers, signal: ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout });
      if (res.ok) { const data = await parse(res), fetchedAt = Date.now(); if (!noCache && !ctx.readOnly) ctx.withDb(true, db => setGraphCache(db, key, source, data, ttlMs)); return { data, fromCache: false, fetchedAt }; }
      if (res.status === 404) return undefined;
      failed = true;
      if (![429, 502, 503, 504].includes(res.status) || attempt >= 2) break;
      const delay = retryDelay(res.headers.get('retry-after'), attempt);
      if (delay < 0) break;
      await sleep(delay, ctx.signal);
    } catch {
      if (ctx.signal?.aborted) throw new ServiceError(499, 'Request canceled.');
      failed = true;
      if (attempt < 2) await sleep(250 * (2 ** attempt), ctx.signal);
    }
  }
  if (failed) degraded.add(source);
  return cached ? { data: cached.value, fromCache: true, fetchedAt: cached.fetchedAt } : undefined;
}
export const fetchJson = (source: GraphSource, key: string, url: string, ctx: GraphContext, degraded: Set<string>, ttlMs = TTL_WORK, init: RequestInit = { method: 'GET' }, noCache = false) =>
  cachedFetch<unknown>(source, key, url, init, ttlMs, r => r.json(), ctx, degraded, noCache);
export const oaUrl = (pathname: string, params: Record<string, string>, s?: Partial<PrivateSettings>): string => {
  const url = new URL('https://api.openalex.org' + pathname);
  const base = 'group_by' in params || params.select === '' ? {} : { select: OA_SELECT };
  for (const [k, v] of Object.entries({ ...base, ...params, ...(s?.openAlexEmail ? { mailto: s.openAlexEmail } : {}), ...(s?.openAlexApiKey ? { api_key: s.openAlexApiKey } : {}) })) if (v !== '') url.searchParams.set(k, v);
  return url.href;
};
export function parseOaWork(raw: unknown): ResolvedWork | undefined {
  if (!isObject(raw)) return undefined;
  const oaId = shortOaId(raw.id), title = str(raw.title) ?? str(raw.display_name);
  if (!oaId || !title) return undefined;
  const ids = isObject(raw.ids) ? raw.ids : {}, prim = isObject(raw.primary_location) ? raw.primary_location : {}, oa = isObject(raw.best_oa_location) ? raw.best_oa_location : {}, doi = cleanDoi(raw.doi) ?? cleanDoi(ids.doi);
  const pt = isObject(raw.primary_topic) ? raw.primary_topic : undefined;
  const arxivId = extractArxivId(str(raw.doi), doi) ?? extractArxivId(str(prim.landing_page_url)) ?? extractArxivId(str(oa.landing_page_url)) ?? extractArxivId(str(oa.pdf_url));
  const authors = arrOf(raw.authorships).map(a => isObject(a) && isObject(a.author) ? str(a.author.display_name) ?? '' : '').filter(Boolean);
  const abstract = isObject(raw.abstract_inverted_index) ? reconstructInvertedAbstract(raw.abstract_inverted_index as Record<string, number[]>) || undefined : undefined;
  return {
    paper: makePaper({ id: oaId, openAlexId: oaId, title, authors, year: num(raw.publication_year), venue: isObject(prim.source) ? str(prim.source.display_name) : undefined, doi, arxivId, pmid: str(ids.pmid) ? /(\d+)\/?$/.exec(str(ids.pmid)!)?.[1] : undefined, abstract, citationCount: num(raw.cited_by_count), oaPdfUrl: str(oa.pdf_url), url: str(prim.landing_page_url), topic: pt ? str(pt.display_name) : undefined, source: 'openalex' }),
    referencedIds: arrOf(raw.referenced_works).map(shortOaId).filter((v): v is string => Boolean(v)),
    relatedIds: arrOf(raw.related_works).map(shortOaId).filter((v): v is string => Boolean(v)), fromCache: false,
    primaryTopicId: pt ? shortTopicId(pt.id) : undefined, primaryTopicName: pt ? str(pt.display_name) : undefined,
    publishedDate: str(raw.publication_date)?.slice(0, 10)
  };
}
export function parseS2Paper(raw: unknown): GraphPaper | undefined {
  if (!isObject(raw) || !str(raw.title)) return undefined;
  const ext = isObject(raw.externalIds) ? raw.externalIds : {}, doi = cleanDoi(ext.DOI);
  const authors = arrOf(raw.authors).map(a => isObject(a) ? str(a.name) ?? '' : '').filter(Boolean);
  return makePaper({ id: str(raw.paperId), s2Id: str(raw.paperId), title: str(raw.title)!, authors, year: num(raw.year), venue: str(raw.venue), doi, arxivId: extractArxivId(str(ext.ArXiv), doi), pmid: cleanPmid(ext.PubMed), abstract: str(raw.abstract), citationCount: num(raw.citationCount), oaPdfUrl: isObject(raw.openAccessPdf) ? str(raw.openAccessPdf.url) : undefined, url: str(raw.url), source: 's2' });
}
export function parseEpmcItem(raw: unknown): GraphPaper | undefined {
  if (!isObject(raw) || !str(raw.title)) return undefined;
  const authors = arrOf(isObject(raw.authorList) ? raw.authorList.author : undefined).map(a => isObject(a) ? str(a.fullName) ?? '' : '').filter(Boolean);
  if (!authors.length && str(raw.authorString)) authors.push(...str(raw.authorString)!.split(/\s*,\s*/).filter(Boolean));
  const pdf = arrOf(isObject(raw.fullTextUrlList) ? raw.fullTextUrlList.fullTextUrl : undefined).find(u => isObject(u) && u.documentStyle === 'pdf' && u.availabilityCode === 'OA' && str(u.url));
  const year = Number(raw.pubYear), cited = Number(raw.citedByCount);
  return makePaper({ title: decodeXml(str(raw.title)!), authors, year: Number.isFinite(year) && year > 1800 ? year : undefined, venue: str(raw.journalTitle), doi: cleanDoi(raw.doi), pmid: cleanPmid(raw.pmid) ?? cleanPmid(raw.id), abstract: str(raw.abstractText) ? decodeXml(str(raw.abstractText)!) : undefined, citationCount: Number.isFinite(cited) ? cited : undefined, oaPdfUrl: isObject(pdf) ? str(pdf.url) : undefined, source: 'europepmc' });
}
export function parseArxivEntries(xml: string): { paper: GraphPaper; publishedDate?: string }[] {
  const out: { paper: GraphPaper; publishedDate?: string }[] = [];
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const entry = m[1], tag = (n: string) => new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i').exec(entry)?.[1] ?? '';
    const idUrl = decodeXml(tag('id')), title = decodeXml(tag('title')), arxivId = extractArxivId(idUrl), pub = tag('published');
    const authors = [...entry.matchAll(/<author\b[^>]*>\s*<name\b[^>]*>([\s\S]*?)<\/name>/gi)].map(a => decodeXml(a[1])).filter(Boolean), year = Number(/(\d{4})/.exec(pub)?.[1]);
    if (!title || /arxiv\.org\/api\/errors/i.test(idUrl) || (!authors.length && !arxivId)) continue;
    out.push({ paper: makePaper({ title, authors, year: Number.isFinite(year) && year > 1900 ? year : undefined, venue: 'arXiv', doi: cleanDoi(decodeXml(tag('arxiv:doi'))), arxivId, abstract: decodeXml(tag('summary')) || undefined, url: idUrl, source: 'arxiv' }), publishedDate: /(\d{4}-\d{2}-\d{2})/.exec(pub)?.[1] });
  }
  return out;
}

async function fetchOpenAlexByIds(ids: string[], ctx: GraphContext, degraded: Set<string>): Promise<{ works: ResolvedWork[]; fromCache: boolean }> {
  const unique = [...new Set(ids.map(shortOaId).filter((v): v is string => Boolean(v)))], works: ResolvedWork[] = [];
  let allCached = unique.length > 0;
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const res = await fetchJson('openalex', 'oa:batch:' + [...chunk].sort().join('|'), oaUrl('/works', { filter: 'openalex:' + chunk.join('|'), 'per-page': String(chunk.length) }, ctx.settings), ctx, degraded);
    if (!res?.fromCache) allCached = false;
    for (const row of arrOf(isObject(res?.data) ? res.data.results : undefined)) { const w = parseOaWork(row); if (w) works.push({ ...w, fromCache: Boolean(res?.fromCache) }); }
  }
  return { works, fromCache: allCached };
}
const parsePaperWork = (paper: GraphPaper | undefined, fromCache: boolean): ResolvedWork | undefined => paper ? { paper, referencedIds: [], relatedIds: [], fromCache } : undefined;
async function resolveWorkInternal(rawInput: string, ctx: GraphContext, degraded: Set<string>): Promise<ResolvedWork | undefined> {
  const query = rawInput.trim();
  if (!query) return undefined;
  const oaDirect = shortOaId(query), pmidDirect = /^pmid:?\s*(\d+)$/i.exec(query)?.[1], parsed = parseAcademicInput(query);
  const fetchOa = async (p: string, q: Record<string, string>, k: string) => {
    const res = await fetchJson('openalex', k, oaUrl(p, q, ctx.settings), ctx, degraded);
    const w = res ? parseOaWork(isObject(res.data) && Array.isArray(res.data.results) ? res.data.results[0] : res.data) : undefined;
    return w && res ? { ...w, fromCache: res.fromCache } : undefined;
  };
  let work = oaDirect ? await fetchOa('/works/' + oaDirect, {}, 'oa:id:' + oaDirect)
    : pmidDirect ? await fetchOa('/works/pmid:' + pmidDirect, {}, 'oa:pmid:' + pmidDirect)
    : parsed?.kind === 'doi' ? await fetchOa('/works/https://doi.org/' + encodeURIComponent(parsed.doi.toLowerCase()), {}, 'oa:doi:' + parsed.doi.toLowerCase())
    : parsed?.kind === 'arxiv' ? (await fetchOa('/works/https://doi.org/10.48550/arxiv.' + encodeURIComponent(parsed.id.toLowerCase()), {}, 'oa:arxiv:' + parsed.id.toLowerCase()) ?? await fetchOa('/works', { filter: 'locations.landing_page_url:https://arxiv.org/abs/' + parsed.id.toLowerCase(), 'per-page': '1' }, 'oa:arxiv-loc:' + parsed.id.toLowerCase()))
    : await fetchOa('/works', { search: query, 'per-page': '3' }, 'oa:search:' + normTitle(query));
  if (work && parsed?.kind === 'arxiv') work = { ...work, paper: { ...work.paper, arxivId: work.paper.arxivId ?? parsed.id.toLowerCase(), oaPdfUrl: work.paper.oaPdfUrl ?? `https://arxiv.org/pdf/${parsed.id.toLowerCase()}.pdf` } };
  if (!work && parsed?.kind === 'arxiv') {
    const res = await cachedFetch<string>('arxiv', 'arxiv:id:' + parsed.id, 'https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(parsed.id), { method: 'GET' }, TTL_WORK, r => r.text(), ctx, degraded);
    if (res) work = parsePaperWork(parseArxivEntries(res.data)[0]?.paper, res.fromCache);
  }
  if (!work || (!work.paper.abstract && (work.paper.doi || pmidDirect || parsed?.kind === 'doi'))) {
    const doi = work?.paper.doi ?? (parsed?.kind === 'doi' ? parsed.doi : undefined), pmid = work?.paper.pmid ?? pmidDirect, epmcQ = doi ? `DOI:"${doi}"` : pmid ? `EXT_ID:${pmid} AND SRC:MED` : !work ? query : '';
    const res = epmcQ ? await fetchJson('europepmc', 'epmc:' + epmcQ.toLowerCase(), `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(epmcQ)}&format=json&resultType=core&pageSize=1`, ctx, degraded) : undefined;
    const epmc = parseEpmcItem(arrOf(isObject(res?.data) && isObject(res.data.resultList) ? res.data.resultList.result : undefined)[0]);
    if (epmc && res) work = work ? { ...work, paper: { ...work.paper, abstract: work.paper.abstract ?? epmc.abstract, pmid: work.paper.pmid ?? epmc.pmid, oaPdfUrl: work.paper.oaPdfUrl ?? epmc.oaPdfUrl, venue: work.paper.venue ?? epmc.venue } } : parsePaperWork(epmc, res.fromCache);
  }
  if (!work) {
    const s2Key = parsed?.kind === 'doi' ? 'DOI:' + parsed.doi : parsed?.kind === 'arxiv' ? 'ARXIV:' + parsed.id : pmidDirect ? 'PMID:' + pmidDirect : '';
    const url = s2Key ? `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2Key)}?fields=${S2_FIELDS}` : `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=1&fields=${S2_FIELDS}`;
    const res = await fetchJson('s2', 's2:paper:' + (s2Key || normTitle(query)), url, ctx, degraded, TTL_WORK, { method: 'GET', headers: s2Headers(ctx.settings) });
    if (res) work = parsePaperWork(parseS2Paper(isObject(res.data) && Array.isArray(res.data.data) ? res.data.data[0] : res.data), res.fromCache);
  }
  return work;
}

export const attachLibraryMatch = <T extends GraphPaper>(paper: T, docs?: DocumentInfo[]): T => {
  const pDoi = paper.doi?.toLowerCase(), pArxiv = paper.arxivId?.toLowerCase(), pTitle = normTitle(paper.title);
  const hit = docs?.find(d => (pDoi && cleanDoi(d.doi)?.toLowerCase() === pDoi) || (pArxiv && extractArxivId(d.url, d.doi)?.toLowerCase() === pArxiv) || (pTitle && pTitle === normTitle(d.paperTitle || d.title)));
  return hit ? { ...paper, inLibrary: true, docId: hit.id } : { ...paper, inLibrary: false };
};

export async function resolveAcademicPaper(input: string, ctx: GraphContext): Promise<{ paper: GraphPaper | null; degraded: string[]; fromCache: boolean }> {
  const degraded = new Set<string>(), work = await resolveWorkInternal(input, ctx, degraded);
  return { paper: work ? attachLibraryMatch(work.paper, ctx.docs) : null, degraded: [...degraded], fromCache: Boolean(work?.fromCache) };
}
export async function searchAcademicPapers(rawQuery: string, rawLimit: number | undefined, ctx: GraphContext): Promise<{ papers: GraphPaper[]; degraded: string[] }> {
  const query = rawQuery.trim();
  if (!query) return { papers: [], degraded: [] };
  const limit = Math.min(15, Math.max(1, Math.round(typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : 8)));
  const parsed = parseAcademicInput(query), pmid = /^pmid:?\s*(\d+)$/i.exec(query)?.[1];
  if (parsed?.kind === 'doi' || parsed?.kind === 'arxiv' || pmid || shortOaId(query)) {
    const res = await resolveAcademicPaper(query, ctx);
    return { papers: res.paper ? [res.paper] : [], degraded: res.degraded };
  }
  const degraded = new Set<string>(), key = `oa:typeahead:${limit}:${normTitle(query).slice(0, 80)}`;
  const res = await fetchJson('openalex', key, oaUrl('/works', { search: query, 'per-page': String(limit) }, ctx.settings), ctx, degraded, 3_600_000);
  const papers = arrOf(isObject(res?.data) ? res.data.results : undefined).flatMap(r => {
    const w = parseOaWork(r);
    return w ? [attachLibraryMatch(w.paper, ctx.docs)] : [];
  });
  return { papers, degraded: [...degraded] };
}
export async function exploreCitationGraph(params: { seeds: string[]; direction: GraphDirection; negativeSeeds?: string[]; limit?: number }, ctx: GraphContext): Promise<GraphExploreResult> {
  const limit = Math.min(45, Math.max(25, Math.floor(params.limit ?? 35))), degraded = new Set<string>(), resolvedSeeds: ResolvedWork[] = [], seedKeySet = new Set<string>();
  for (const raw of params.seeds.slice(0, 5)) { const w = await resolveWorkInternal(raw, ctx, degraded); if (w && !seedKeySet.has(w.paper.id)) { seedKeySet.add(w.paper.id); resolvedSeeds.push(w); } }
  if (!resolvedSeeds.length) return { seeds: [], nodes: [], edges: [], degraded: [...degraded], fromCache: false };
  const seedNodes: GraphNode[] = resolvedSeeds.map(s => ({ ...attachLibraryMatch(s.paper, ctx.docs), isSeed: true, direction: 'seed' }));
  const budget = Math.max(1, limit - seedNodes.length), discovered: GraphNode[] = [], edges: GraphEdge[] = [];
  const refsByNodeId = new Map<string, string[]>(), relatedByNodeId = new Map<string, string[]>();
  const recordMeta = (id: string, w: ResolvedWork) => {
    if (w.referencedIds.length) refsByNodeId.set(id, w.referencedIds);
    if (w.relatedIds.length) relatedByNodeId.set(id, w.relatedIds);
  };
  for (const s of resolvedSeeds) recordMeta(s.paper.id, s);
  let fromCache = resolvedSeeds.every(s => s.fromCache);
  const negSet = new Set((params.negativeSeeds ?? []).flatMap(r => { const p = parseAcademicInput(r); return [r.trim().toLowerCase(), shortOaId(r)?.toLowerCase(), p?.kind === 'doi' ? p.doi.toLowerCase() : undefined, p?.kind === 'arxiv' ? p.id.toLowerCase() : undefined].filter((v): v is string => Boolean(v)); }));
  const pushDisc = (paper: GraphPaper, dir: GraphDirection, coCitations?: number) => {
    if (discovered.length >= budget || seedKeySet.has(paper.id) || negSet.has(paper.id.toLowerCase()) || (paper.doi && negSet.has(paper.doi.toLowerCase())) || (paper.arxivId && negSet.has(paper.arxivId.toLowerCase())) || discovered.some(d => d.id === paper.id)) return false;
    discovered.push({ ...attachLibraryMatch(paper, ctx.docs), isSeed: false, direction: dir, ...(coCitations !== undefined ? { coCitations } : {}) });
    return true;
  };
  if (params.direction === 'earlier') {
    const counts = new Map<string, number>();
    for (const s of resolvedSeeds) for (const refId of new Set(s.referencedIds)) if (!seedKeySet.has(refId)) { counts.set(refId, (counts.get(refId) ?? 0) + 1); edges.push({ source: s.paper.id, target: refId, kind: 'cites' }); }
    const batch = await fetchOpenAlexByIds([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([id]) => id), ctx, degraded);
    const workById = new Map(batch.works.map(w => [w.paper.id, w]));
    fromCache = fromCache && batch.fromCache;
    for (const paper of rankEarlierByCoCitation(batch.works.map(w => w.paper), counts, budget)) {
      if (pushDisc(paper, 'earlier', counts.get(paper.id) ?? 1)) { const w = workById.get(paper.id); if (w) recordMeta(paper.id, w); }
    }
  } else if (params.direction === 'later') {
    const oaIds = resolvedSeeds.map(s => s.paper.openAlexId).filter((v): v is string => Boolean(v));
    const res = oaIds.length ? await fetchJson('openalex', 'oa:cites:' + [...oaIds].sort().join('|'), oaUrl('/works', { filter: 'cites:' + oaIds.join('|'), sort: 'cited_by_count:desc', 'per-page': '50' }, ctx.settings), ctx, degraded, TTL_EXPLORE) : undefined;
    fromCache = fromCache && Boolean(res?.fromCache);
    for (const row of arrOf(isObject(res?.data) ? res.data.results : undefined)) {
      const w = parseOaWork(row);
      if (!w || !pushDisc(w.paper, 'later')) continue;
      recordMeta(w.paper.id, w);
      const hits = resolvedSeeds.filter(s => s.paper.openAlexId && w.referencedIds.includes(s.paper.openAlexId));
      for (const t of hits.length ? hits : [resolvedSeeds[0]]) edges.push({ source: w.paper.id, target: t.paper.id, kind: 'cites' });
    }
  } else {
    const posIds = resolvedSeeds.map(s => s.paper.s2Id ?? (s.paper.doi ? 'DOI:' + s.paper.doi : s.paper.arxivId ? 'ARXIV:' + s.paper.arxivId : s.paper.pmid ? 'PMID:' + s.paper.pmid : '')).filter(Boolean);
    const negIds = (params.negativeSeeds ?? []).map(r => { const p = parseAcademicInput(r); return p?.kind === 'doi' ? 'DOI:' + p.doi : p?.kind === 'arxiv' ? 'ARXIV:' + p.id : shortOaId(r) ? '' : r.trim(); }).filter(Boolean);
    if (posIds.length) {
      const res = await fetchJson('s2', `s2:rec:${posIds.join('|')}:${negIds.join('|')}`, `https://api.semanticscholar.org/recommendations/v1/papers/?fields=${S2_FIELDS}&limit=45`, ctx, degraded, TTL_EXPLORE, { method: 'POST', headers: s2Headers(ctx.settings, true), body: JSON.stringify({ positivePaperIds: posIds, negativePaperIds: negIds }) });
      fromCache = fromCache && Boolean(res?.fromCache);
      for (const row of arrOf(isObject(res?.data) ? res.data.recommendedPapers : undefined)) { const paper = parseS2Paper(row); if (paper && pushDisc(paper, 'similar')) edges.push({ source: resolvedSeeds[0].paper.id, target: paper.id, kind: 'related' }); }
    }
    if (discovered.length < budget) {
      const batch = await fetchOpenAlexByIds([...new Set(resolvedSeeds.flatMap(s => s.relatedIds).filter(id => !seedKeySet.has(id)))].slice(0, 50), ctx, degraded);
      fromCache = fromCache && batch.fromCache;
      for (const w of batch.works) if (pushDisc(w.paper, 'similar')) { recordMeta(w.paper.id, w); edges.push({ source: (resolvedSeeds.find(s => s.relatedIds.includes(w.paper.id)) ?? resolvedSeeds[0]).paper.id, target: w.paper.id, kind: 'related' }); }
    }
    if (discovered.filter(d => refsByNodeId.has(d.id)).length < 3) {
      const byDoi = new Map<string, GraphNode>();
      for (const d of discovered) if (!refsByNodeId.has(d.id) && d.doi) byDoi.set(d.doi.toLowerCase(), d);
      const dois = [...byDoi.keys()].slice(0, 50);
      if (dois.length) {
        const res = await fetchJson('openalex', 'oa:doi-batch:' + [...dois].sort().join('|'), oaUrl('/works', { filter: 'doi:' + dois.join('|'), 'per-page': String(dois.length) }, ctx.settings), ctx, degraded);
        fromCache = fromCache && Boolean(res?.fromCache);
        for (const row of arrOf(isObject(res?.data) ? res.data.results : undefined)) {
          const w = parseOaWork(row), target = w?.paper.doi ? byDoi.get(w.paper.doi.toLowerCase()) : undefined;
          if (!w || !target) continue;
          if (!target.openAlexId && w.paper.openAlexId) target.openAlexId = w.paper.openAlexId;
          recordMeta(target.id, w);
        }
      }
    }
  }
  if (!discovered.length && params.direction !== 'similar' && resolvedSeeds.some(s => s.paper.pmid)) {
    const pmidSeed = resolvedSeeds.find(s => s.paper.pmid)!, ep = params.direction === 'earlier' ? 'references' : 'citations';
    const res = await fetchJson('europepmc', `epmc:${ep}:${pmidSeed.paper.pmid}`, `https://www.ebi.ac.uk/europepmc/webservices/rest/MED/${pmidSeed.paper.pmid}/${ep}?format=json&pageSize=45`, ctx, degraded, TTL_EXPLORE);
    const listObj = isObject(res?.data) ? res.data[ep === 'references' ? 'referenceList' : 'citationList'] : undefined;
    for (const item of arrOf(isObject(listObj) ? listObj[ep === 'references' ? 'reference' : 'citation'] : undefined)) { const paper = parseEpmcItem(item); if (paper && pushDisc(paper, params.direction)) edges.push(params.direction === 'earlier' ? { source: pmidSeed.paper.id, target: paper.id, kind: 'cites' } : { source: paper.id, target: pmidSeed.paper.id, kind: 'cites' }); }
  }
  const nodes = [...seedNodes, ...discovered].slice(0, limit);
  return { seeds: seedNodes, nodes, edges: buildCitationGraphEdges(nodes, refsByNodeId, relatedByNodeId, edges), degraded: [...degraded], fromCache };
}
export function readGraphPaperInput(raw: Input): GraphPaper {
  const title = single(raw.title, 'paper title', 250, true), authors = arrOf(raw.authors).map(a => str(a) ?? '').filter(Boolean).slice(0, 100);
  return makePaper({ id: str(raw.id), title, authors, year: num(raw.year), venue: str(raw.venue), doi: cleanDoi(raw.doi), arxivId: extractArxivId(str(raw.arxivId)), pmid: cleanPmid(raw.pmid), openAlexId: shortOaId(raw.openAlexId), s2Id: str(raw.s2Id), abstract: str(raw.abstract), citationCount: num(raw.citationCount), oaPdfUrl: str(raw.oaPdfUrl), url: str(raw.url), source: raw.source === 's2' || raw.source === 'europepmc' || raw.source === 'arxiv' ? raw.source : 'openalex' });
}
