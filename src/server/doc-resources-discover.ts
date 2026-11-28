import { existsSync } from 'node:fs';
import { extractArxivId } from '../shared/citation-export.js';
import {
  classifyResourceKind, defaultResourceTitle, extractInPaperResources, normalizeResourceUrl, sanitizeResourceUrl,
  type DocResourceKind, type DocResourcesDiscoverResult
} from '../shared/doc-resources.js';
import type { DocumentInfo } from '../shared/types.js';
import { cleanDoi, oaUrl } from './academic-graph.js';
import type { ResourceReader } from './academic-intake.js';
import { addDocResource, listDocResources } from './doc-resources-store.js';
import type { Library } from './library.js';
import type { ReaderStore } from './reader-store.js';
import { getDocPages } from './research-store.js';
import { isObject } from './service-types.js';

interface ResourceDiscoveryDeps { root: string; library: Library; store: ReaderStore; readResource: ResourceReader }
interface Candidate { url: string; kind: DocResourceKind; title: string; source: string }

const ARXIV_TEXT_RE = /\barxiv\s*:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?\b/i;
const ARXIV_URL_TEXT_RE = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(?:v\d+)?/i;
const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'using', 'based', 'via', 'towards', 'toward',
  'paper', 'model', 'models', 'learning', 'neural', 'network', 'networks', 'large', 'language', 'deep', 'system', 'systems', 'method', 'study', 'analysis', 'approach'
]);
const inflight = new Set<string>();

function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const ac = new AbortController(), onAbort = () => ac.abort();
  if (parent?.aborted) ac.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), ms);
  timer.unref?.();
  return run(ac.signal).finally(() => { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); });
}

const titleTokens = (title: string): string[] =>
  [...new Set((title.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(t => !STOP_TOKENS.has(t)))].slice(0, 8);

function repoMatchesPaper(item: Record<string, unknown>, arxivId: string | undefined, tokens: string[]): boolean {
  const topics = Array.isArray(item.topics) ? item.topics.filter(t => typeof t === 'string').join(' ') : '';
  const hay = `${typeof item.full_name === 'string' ? item.full_name : ''} ${typeof item.name === 'string' ? item.name : ''} ${typeof item.description === 'string' ? item.description : ''} ${topics}`.toLowerCase();
  if (arxivId && hay.includes(arxivId.toLowerCase())) return true;
  if (!tokens.length) return false;
  const hits = tokens.filter(t => hay.includes(t));
  return tokens.length === 1 ? hits.length === 1 && tokens[0].length >= 5 : hits.length >= 2 && hits.length / Math.min(tokens.length, 5) >= 0.5;
}

function pushCandidate(out: Candidate[], seen: Set<string>, rawUrl: unknown, source: string, hintKind?: DocResourceKind, rawTitle?: unknown): void {
  if (typeof rawUrl !== 'string') return;
  const clean = sanitizeResourceUrl(rawUrl);
  if (!clean) return;
  const norm = normalizeResourceUrl(clean);
  if (seen.has(norm)) return;
  const kind = hintKind ?? classifyResourceKind(clean);
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 120) : defaultResourceTitle(clean, kind);
  seen.add(norm);
  out.push({ url: clean, kind, title, source });
}

async function fetchJson(readResource: ResourceReader, url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await withTimeout(8_000, sig => readResource(url, 'json', { signal: sig }), signal);
  return JSON.parse(res.bytes.toString('utf8')) as unknown;
}

export async function discoverDocResources(
  deps: ResourceDiscoveryDeps, doc: DocumentInfo, opts?: { includeRemote?: boolean; signal?: AbortSignal }
): Promise<DocResourcesDiscoverResult> {
  const includeRemote = opts?.includeRemote ?? true;
  const full = doc.paragraphs || doc.abstract || doc.book ? doc : await deps.library.get(doc.id).catch(() => doc);
  const parts: string[] = [];
  if (full.abstract) parts.push(full.abstract);
  if (full.paragraphs?.length) parts.push(full.paragraphs.slice(0, 80).join('\n'));
  if ((full.kind === 'pdf' || !parts.length) && existsSync(deps.root)) {
    try { for (const p of deps.store.withDb(false, db => getDocPages(db, full.id).slice(0, 2))) if (p.text) parts.push(p.text); } catch {}
  }
  const combined = parts.join('\n'), ownClean = full.url ? sanitizeResourceUrl(full.url) : null;
  const seen = new Set<string>(ownClean ? [normalizeResourceUrl(ownClean)] : []), candidates: Candidate[] = [], degraded: string[] = [];
  for (const item of extractInPaperResources(combined, full.url)) pushCandidate(candidates, seen, item.url, 'in-paper', item.kind, item.title);
  const arxivId = extractArxivId(full.url, full.doi) ?? ARXIV_TEXT_RE.exec(combined)?.[1]?.toLowerCase() ?? ARXIV_URL_TEXT_RE.exec(combined)?.[1]?.toLowerCase();
  const doi = cleanDoi(full.doi);
  const tokens = titleTokens((full.paperTitle || full.title || '').replace(/\.(?:pdf|md|markdown|html?|pptx|docx)$/i, '').trim());

  if (includeRemote) {
    if (arxivId) {
      try {
        const body = await fetchJson(deps.readResource, `https://huggingface.co/api/papers/${encodeURIComponent(arxivId)}`, opts?.signal);
        const rec = isObject(body) ? (isObject(body.paper) ? { ...body.paper, ...body } : body) : null;
        if (rec) {
          pushCandidate(candidates, seen, rec.githubRepo, 'huggingface', 'code');
          pushCandidate(candidates, seen, rec.projectPage, 'huggingface', 'project');
        }
      } catch { degraded.push('huggingface'); }
    }
    const ghQuery = arxivId || (tokens.length >= 2 ? tokens.slice(0, 6).join(' ') : '');
    if (ghQuery) {
      try {
        const body = await fetchJson(deps.readResource, `https://api.github.com/search/repositories?q=${encodeURIComponent(ghQuery)}&per_page=3`, opts?.signal);
        let added = 0;
        for (const raw of isObject(body) && Array.isArray(body.items) ? body.items : []) {
          if (!isObject(raw) || !repoMatchesPaper(raw, arxivId, tokens)) continue;
          pushCandidate(candidates, seen, raw.html_url, 'github', 'code', raw.full_name);
          if (++added >= 2) break;
        }
      } catch { degraded.push('github'); }
    }
    if ((doi || arxivId) && !candidates.some(c => c.kind === 'code' || c.kind === 'project')) {
      try {
        const oaDoi = doi ? doi.toLowerCase() : `10.48550/arxiv.${arxivId}`;
        const url = oaUrl('/works/https://doi.org/' + encodeURIComponent(oaDoi), { select: 'primary_location,best_oa_location,locations' }, deps.store.settings());
        const body = await fetchJson(deps.readResource, url, opts?.signal);
        if (isObject(body)) {
          for (const loc of [body.primary_location, body.best_oa_location, ...(Array.isArray(body.locations) ? body.locations : [])]) {
            if (!isObject(loc) || typeof loc.landing_page_url !== 'string') continue;
            const kind = classifyResourceKind(loc.landing_page_url);
            if (kind !== 'other') pushCandidate(candidates, seen, loc.landing_page_url, 'openalex', kind);
          }
        }
      } catch { degraded.push('openalex'); }
    }
  }

  if (!existsSync(deps.root) || !deps.library.hasSync(full.id)) return { resources: [], backlinks: [], discovered: 0, degraded };
  const discovered = candidates.length ? deps.store.withDb(true, db => {
    if (!deps.library.hasSync(full.id)) return 0;
    let count = 0;
    for (const c of candidates) {
      if (addDocResource(db, { docId: full.id, kind: c.kind, title: c.title, url: c.url, status: 'suggested', source: c.source }).created) count++;
    }
    return count;
  }) : 0;
  return { ...deps.store.withDb(false, db => listDocResources(db, full.id)), discovered, degraded };
}

export function scheduleResourceDiscovery(deps: ResourceDiscoveryDeps, doc: DocumentInfo, includeRemote = true): void {
  const key = `${deps.root}\0${doc.id}`;
  if (!doc.id || inflight.has(key)) return;
  inflight.add(key);
  void Promise.resolve()
    .then(async () => { if (existsSync(deps.root) && deps.library.hasSync(doc.id)) await discoverDocResources(deps, doc, { includeRemote }); })
    .catch(() => undefined)
    .finally(() => { inflight.delete(key); });
}
