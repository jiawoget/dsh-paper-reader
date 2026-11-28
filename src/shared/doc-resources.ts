export type DocResourceKind = 'code' | 'talk' | 'slides' | 'project' | 'dataset' | 'other';
export type DocResourceStatus = 'suggested' | 'linked' | 'dismissed';
export const DOC_RESOURCE_KINDS: readonly DocResourceKind[] = ['code', 'talk', 'slides', 'project', 'dataset', 'other'];

export interface DocResource {
  id: string; docId: string; kind: DocResourceKind; title: string;
  url?: string; targetDocId?: string; status: DocResourceStatus; source: string;
  createdAt: number; updatedAt: number;
}
export interface DocResourceBacklink { id: string; sourceDocId: string; kind: DocResourceKind; title: string }
export interface DocResourcesListResult {
  resources: DocResource[]; backlinks: DocResourceBacklink[]; pendingCounts?: Record<string, number>;
}
export interface DocResourcesDiscoverResult {
  resources: DocResource[]; backlinks: DocResourceBacklink[]; discovered: number; degraded: string[];
}

const CODE_HOST_RE = /(?:^|\.)(?:github\.com|gitlab\.com|codeberg\.org)$/;
const TALK_HOST_RE = /(?:^|\.)(?:youtube\.com|youtu\.be|bilibili\.com|slideslive\.com|vimeo\.com)$/;
const SLIDES_HOST_RE = /(?:^|\.)(?:speakerdeck\.com|slideshare\.net)$/;
const SLIDES_EXT_RE = /\.(?:pptx|ppt|key|odp)$/i;
const DATASET_HOST_RE = /(?:^|\.)(?:huggingface\.co|kaggle\.com|zenodo\.org|figshare\.com)$/;
const SKIP_HOST_RE = /(?:^|\.)(?:arxiv\.org|doi\.org|orcid\.org|creativecommons\.org|w3\.org|schema\.org)$/;
const CODE_NON_REPO = new Set(['about', 'explore', 'features', 'issues', 'login', 'marketplace', 'notifications', 'pricing', 'pulls', 'search', 'settings', 'signup', 'sponsors', 'topics']);

export function sanitizeResourceUrl(raw: string): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || trimmed.length > 4096 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { return null; }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || !parsed.hostname) return null;
  return parsed.href;
}

export function normalizeResourceUrl(raw: string): string {
  const parsed = URL.parse(raw);
  if (!parsed) return raw.trim().toLowerCase();
  const host = parsed.hostname.toLowerCase();
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (CODE_HOST_RE.test(host)) pathname = pathname.toLowerCase().replace(/\.git$/i, '');
  else if (/(?:^|\.)huggingface\.co$/.test(host)) pathname = pathname.toLowerCase();
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
}

export function classifyResourceKind(url: string, hint?: string): DocResourceKind {
  const parsed = URL.parse(url);
  const host = parsed?.hostname.toLowerCase() ?? '';
  const pathname = parsed?.pathname.toLowerCase() ?? url.toLowerCase();
  const hintLow = (hint ?? '').toLowerCase();
  if (CODE_HOST_RE.test(host)) return 'code';
  if (TALK_HOST_RE.test(host)) return 'talk';
  if (SLIDES_EXT_RE.test(pathname) || SLIDES_HOST_RE.test(host)) return 'slides';
  if (DATASET_HOST_RE.test(host) && !(/huggingface\.co$/.test(host) && pathname.startsWith('/papers/'))) return 'dataset';
  if (host.endsWith('.github.io') || /(?:^|\.)(?:projects?|blog)\./.test(host) || /(?:^|\/)(?:projects?|blog)(?:\/|$)/.test(pathname)) return 'project';
  if (hintLow) {
    if (/\b(?:slides?|deck|presentation)\b/.test(hintLow)) return 'slides';
    if (/\b(?:talk|video|lecture|keynote)\b/.test(hintLow)) return 'talk';
    if (/\b(?:dataset|weights?|checkpoint|benchmark|model)\b/.test(hintLow)) return 'dataset';
    if (/\b(?:code|repo|repository|source)\b/.test(hintLow)) return 'code';
    if (/\b(?:project|homepage|demo|blog)\b/.test(hintLow)) return 'project';
  }
  return 'other';
}

export function defaultResourceTitle(url: string, kind: DocResourceKind): string {
  const parsed = URL.parse(url);
  if (!parsed) return url.slice(0, 120);
  const host = parsed.hostname.replace(/^www\./i, ''), segs = parsed.pathname.split('/').filter(Boolean);
  if (kind === 'code' && segs.length >= 2) return `${segs[0]}/${segs[1]}`.slice(0, 120);
  if (kind === 'dataset' && /(?:^|\.)huggingface\.co$/i.test(host) && segs.length >= 2) return segs.slice(0, 3).join('/').slice(0, 120);
  if (kind === 'slides' && segs.length && SLIDES_EXT_RE.test(segs[segs.length - 1])) {
    try { return decodeURIComponent(segs[segs.length - 1]).slice(0, 120); } catch { return segs[segs.length - 1].slice(0, 120); }
  }
  return (host + (segs.length ? '/' + segs.slice(0, 2).join('/') : '')).slice(0, 120);
}

export function extractInPaperResources(text: string, ownUrl?: string): { url: string; kind: DocResourceKind; title: string }[] {
  if (!text) return [];
  const cleanOwn = ownUrl ? sanitizeResourceUrl(ownUrl) : null;
  const seen = new Set<string>(cleanOwn ? [normalizeResourceUrl(cleanOwn)] : []);
  const out: { url: string; kind: DocResourceKind; title: string }[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const clean = sanitizeResourceUrl(match[0].replace(/[.,;:!?'"\])}>]+$/g, ''));
    if (!clean) continue;
    const norm = normalizeResourceUrl(clean);
    if (seen.has(norm)) continue;
    const parsed = new URL(clean), host = parsed.hostname.toLowerCase();
    if (SKIP_HOST_RE.test(host)) continue;
    const kind = classifyResourceKind(clean);
    if (kind === 'other') continue;
    const segs = parsed.pathname.split('/').filter(Boolean);
    if (kind === 'code' && (segs.length < 2 || CODE_NON_REPO.has(segs[0].toLowerCase()))) continue;
    if (kind === 'dataset' && /(?:^|\.)huggingface\.co$/.test(host) && segs.length < 2) continue;
    if ((kind === 'dataset' || kind === 'slides' || kind === 'talk') && !segs.length) continue;
    if (kind === 'talk' && /(?:^|\.)youtube\.com$/.test(host) && segs[0] === 'watch' && !parsed.searchParams.get('v')) continue;
    if (kind === 'project' && !host.endsWith('.github.io') && !/(?:^|\.)(?:projects?|blog)\./.test(host) && !segs.length) continue;
    seen.add(norm);
    out.push({ url: clean, kind, title: defaultResourceTitle(clean, kind) });
    if (out.length >= 12) break;
  }
  return out;
}
