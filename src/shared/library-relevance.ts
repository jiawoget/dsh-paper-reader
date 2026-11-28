import type { DocumentInfo } from './types.js';

export const LIBRARY_PAGE_SIZE = 50;
interface RelevanceMatch { docId: string; score: number; matchedTerms: number }
interface PageSlice<T> { items: T[]; shown: number; total: number; hasMore: boolean }

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'have', 'has', 'had',
  'not', 'but', 'can', 'may', 'our', 'their', 'these', 'those', 'such', 'which', 'when', 'where', 'while',
  'about', 'between', 'across', 'using', 'based', 'via', 'of', 'in', 'on', 'to', 'a', 'an', 'is', 'by', 'as', 'at', 'be', 'or', 'it'
]);
const FIELD_WEIGHTS = { title: 3.0, tags: 2.5, abstract: 2.0, extra: 1.2 } as const;
const TOKEN_RE = /[a-z0-9]+|[\u3400-\u9fff\uf900-\ufaff]+/g;

function scanTerms(text: string, cjkUni: boolean, visit: (term: string, isCjk: boolean) => void): void {
  const lower = text.toLowerCase(); TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(lower); m; m = TOKEN_RE.exec(lower)) {
    const tok = m[0];
    if (tok.charCodeAt(0) >= 0x3400) {
      if (tok.length === 1 || cjkUni) for (let i = 0; i < tok.length; i++) visit(tok[i], true);
      for (let i = 0; i + 1 < tok.length; i++) visit(tok.slice(i, i + 2), true);
    } else visit(tok, false);
  }
}
function queryTermsFor(query: string): { terms: string[]; needCjkUni: boolean } {
  const raw = query.trim();
  if (!raw) return { terms: [], needCjkUni: false };
  let needCjkUni = false;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(raw.toLowerCase()); m; m = TOKEN_RE.exec(raw.toLowerCase())) if (m[0].charCodeAt(0) >= 0x3400 && m[0].length === 1) needCjkUni = true;
  const kept: string[] = [], all: string[] = [];
  scanTerms(raw, needCjkUni, (tok, isCjk) => { all.push(tok); if (isCjk || (tok.length > 1 && !STOP_WORDS.has(tok))) kept.push(tok); });
  return { terms: [...new Set(kept.length ? kept : all)], needCjkUni };
}
function accumulateField(text: string, weight: number, qSet: ReadonlySet<string>, cjkUni: boolean, counts: Map<string, number>): number {
  if (!text) return 0;
  let len = 0;
  scanTerms(text, cjkUni, tok => { len++; if (qSet.has(tok)) counts.set(tok, (counts.get(tok) ?? 0) + weight); });
  return len * weight;
}
export function slicePage<T>(items: readonly T[], limit = LIBRARY_PAGE_SIZE): PageSlice<T> {
  const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : LIBRARY_PAGE_SIZE;
  const sliced = items.slice(0, cap);
  return { items: sliced, shown: sliced.length, total: items.length, hasMore: sliced.length < items.length };
}
export function rankDocsByRelevance(query: string, docs: readonly DocumentInfo[], extraTextByDocId?: ReadonlyMap<string, string>): RelevanceMatch[] {
  const { terms, needCjkUni } = queryTermsFor(query);
  if (!terms.length || !docs.length) return docs.map(d => ({ docId: d.id, score: 0, matchedTerms: 0 }));
  const qSet = new Set(terms), n = docs.length, df = new Map<string, number>(), docTf: Map<string, number>[] = new Array(n), docLen: number[] = new Array(n);
  let totalLen = 0, maxRaw = 0;
  for (let i = 0; i < n; i++) {
    const doc = docs[i], tf = new Map<string, number>(), tags = (doc.meta?.tags ?? []).filter(t => !/^screen:/i.test(t)).join(' ');
    const dl = accumulateField(doc.paperTitle || doc.title, FIELD_WEIGHTS.title, qSet, needCjkUni, tf)
      + accumulateField(tags, FIELD_WEIGHTS.tags, qSet, needCjkUni, tf)
      + accumulateField([doc.abstract, doc.authors, doc.venue].filter(Boolean).join(' '), FIELD_WEIGHTS.abstract, qSet, needCjkUni, tf)
      + accumulateField(extraTextByDocId?.get(doc.id) ?? '', FIELD_WEIGHTS.extra, qSet, needCjkUni, tf);
    docTf[i] = tf; docLen[i] = dl; totalLen += dl;
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const avgdl = Math.max(1, totalLen / n), idf = new Map(terms.map(t => { const f = df.get(t) ?? 0; return [t, Math.log(1 + (n - f + 0.5) / (f + 0.5))] as const; }));
  const scored = docs.map((doc, i) => {
    const tf = docTf[i], dlNorm = 1 - 0.75 + 0.75 * (docLen[i] / avgdl);
    let raw = 0;
    for (const [term, f] of tf) raw += (idf.get(term) ?? 0) * ((f * 2.2) / (f + 1.2 * dlNorm));
    if (raw > maxRaw) maxRaw = raw;
    return { docId: doc.id, raw, matched: tf.size, idx: i };
  });
  return scored
    .map(item => ({ docId: item.docId, matchedTerms: item.matched, raw: item.raw, idx: item.idx, score: item.raw <= 0 || maxRaw <= 0 ? 0 : Math.max(1, Math.min(100, Math.round((0.5 * (item.raw / maxRaw) + 0.25 * (item.raw / (item.raw + 2.5)) + 0.25 * (item.matched / terms.length)) * 100))) }))
    .sort((a, b) => b.score - a.score || b.raw - a.raw || a.idx - b.idx)
    .map(({ docId, score, matchedTerms }) => ({ docId, score, matchedTerms }));
}
