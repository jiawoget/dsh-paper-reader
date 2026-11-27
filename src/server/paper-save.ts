import { parseAcademicInput } from '../shared/academic-intake.js';
import { extractArxivId } from '../shared/citation-export.js';
import type { ArxivFormat, DocMetadata, DocumentInfo, GraphPaper, SaveGraphPaperResult, SavePaperMode } from '../shared/types.js';
import { articleUrl, type WebArticle } from '../shared/web-article.js';
import { abstractDocId } from './abstract-library.js';
import { attachLibraryMatch, cleanDoi, oaUrl } from './academic-graph.js';
import { isArxivHtmlUnavailable, isPdfBytes, mergeMeta, parseCrossref, safeHtmlMeta, type ResourceReader } from './academic-intake.js';
import type { Library } from './library.js';
import type { ReaderStore } from './reader-store.js';
import { replaceDocPages } from './research-store.js';
import { isObject, ServiceError, single, type PrivateSettings } from './service-types.js';
import { parseWebArticle } from './web-article.js';

interface SaveGraphPaperInput { paper: GraphPaper; mode?: SavePaperMode; arxivFormat?: ArxivFormat; topicTag?: string }
interface SaveGraphPaperDeps {
  library: Library; store: ReaderStore; readResource: ResourceReader;
  indexDoc: (doc: DocumentInfo, force?: boolean) => Promise<number>; settings?: Partial<PrivateSettings>;
}

const PAYWALL_RE = /\b(?:purchase\s+pdf|buy\s+article|subscribe\s+to\s+read|institutional\s+login|access\s+through\s+your\s+institution|get\s+access|rent\s+this\s+article|sign\s+in\s+to\s+view\s+full\s+text|paywall)\b/i;
const isSubstantialOaHtml = (parsed: WebArticle): boolean => {
  const text = parsed.paragraphs.join(' ');
  return parsed.paragraphs.length >= 12 && text.length >= 4000 && !PAYWALL_RE.test(text.slice(0, 3000));
};
function parseOpenAlexOaPdf(bytes: Buffer): string | undefined {
  try {
    const body: unknown = JSON.parse(bytes.toString('utf8'));
    const best = isObject(body) && isObject(body.best_oa_location) ? body.best_oa_location : undefined;
    return best && typeof best.pdf_url === 'string' ? articleUrl(best.pdf_url)?.href : undefined;
  } catch { return undefined; }
}
function arxivVersionSuffix(paper: GraphPaper): string {
  for (const raw of [paper.arxivId, paper.url, paper.oaPdfUrl]) {
    if (!raw || !extractArxivId(raw)) continue;
    const m = /(v\d+)(?:\.pdf)?\/?$/i.exec(raw.trim());
    if (m) return m[1].toLowerCase();
  }
  return '';
}

export async function saveGraphPaper(input: SaveGraphPaperInput, deps: SaveGraphPaperDeps): Promise<SaveGraphPaperResult> {
  const { paper } = input, mode: SavePaperMode = input.mode ?? 'auto';
  const title = single(paper.title, 'paper title', 250, true), topicTag = input.topicTag ? single(input.topicTag, 'topic tag', 40) : '', doi = cleanDoi(paper.doi);
  const meta: DocMetadata = { paperTitle: title, authors: paper.authors.filter(Boolean).join('; ') || undefined, venue: paper.venue, year: paper.year ? String(paper.year) : undefined, doi, abstract: paper.abstract };
  const applyTag = (doc: DocumentInfo): DocumentInfo => {
    const prev = deps.store.listDocMeta(doc.id).get(doc.id);
    return !topicTag ? (prev ? { ...doc, meta: prev } : doc) : { ...doc, meta: deps.store.updateDocTriage({ docId: doc.id, tags: [...new Set([...(prev?.tags ?? []), topicTag])].slice(0, 50) }) };
  };
  const savePdfBytes = async (bytes: Buffer, sourceUrl: string): Promise<SaveGraphPaperResult> => {
    const docs = await deps.library.list(), absId = abstractDocId({ title, url: paper.url, ...meta }), matchedId = attachLibraryMatch(paper, docs).docId;
    const existing = docs.find(d => d.id === absId) ?? (matchedId ? docs.find(d => d.id === matchedId) : undefined);
    if (existing?.kind === 'abstract') {
      const { doc, pages } = await deps.library.attachPdf(existing.id, bytes);
      if (pages.length && deps.library.hasSync(doc.id)) deps.store.withDb(true, db => replaceDocPages(db, doc.id, pages));
      return { doc: applyTag(doc), upgraded: true, mode: 'oa-pdf' };
    }
    const doc = await deps.library.importPdf(title, bytes, sourceUrl, meta);
    await deps.indexDoc(doc, true).catch(() => 0);
    return { doc: applyTag(doc), upgraded: false, mode: 'oa-pdf' };
  };
  const saveWebArticle = async (parsed: WebArticle, extraMeta: DocMetadata): Promise<SaveGraphPaperResult> => {
    const merged = mergeMeta(meta, extraMeta, doi);
    const opened = await deps.library.importWebDocument({ ...parsed, ...merged, title: merged.paperTitle || parsed.title });
    await deps.indexDoc(opened.doc, true).catch(() => 0);
    return { doc: applyTag(opened.doc), upgraded: false, mode: 'oa-html' };
  };
  const saveAbstract = async (fallback: boolean): Promise<SaveGraphPaperResult> => {
    const doc = await deps.library.createAbstract({ title, url: paper.url, ...meta });
    await deps.indexDoc(doc, doc.kind === 'abstract').catch(() => 0);
    return { doc: applyTag(doc), mode: 'abstract', ...(fallback ? { fallback: 'abstract_only' as const, attachPdfSuggested: true } : {}) };
  };

  if (mode === 'abstract') return saveAbstract(false);
  if (mode === 'oa-pdf') {
    const pdfUrl = paper.oaPdfUrl ?? (paper.arxivId ? `https://arxiv.org/pdf/${paper.arxivId}.pdf` : undefined);
    if (!pdfUrl) throw new ServiceError(400, 'No open-access PDF URL is available for this paper.');
    const res = await deps.readResource(pdfUrl, 'document');
    if (!isPdfBytes(res.bytes)) throw new ServiceError(415, 'The open-access link did not return a valid PDF.');
    return savePdfBytes(res.bytes, paper.url ?? pdfUrl);
  }

  const readFast: ResourceReader = (url, kind, opts) => deps.readResource(url, kind, { ...opts, signal: opts?.signal ?? AbortSignal.timeout(15_000) });
  const triedUrls = new Set<string>();
  const tryPdfUrl = async (candidate: string | undefined, sourceUrl: string): Promise<SaveGraphPaperResult | null> => {
    const clean = candidate ? articleUrl(candidate)?.href : undefined;
    if (!clean || triedUrls.has(clean)) return null;
    triedUrls.add(clean);
    const res = await readFast(clean, 'document').catch(() => null);
    return res && isPdfBytes(res.bytes) ? savePdfBytes(res.bytes, sourceUrl) : null;
  };
  const tryArxiv = async (versionedId: string): Promise<SaveGraphPaperResult | null> => {
    const fmt: ArxivFormat = input.arxivFormat ?? deps.settings?.arxivFormat ?? 'html';
    const htmlUrl = 'https://arxiv.org/html/' + versionedId, pdfUrl = 'https://arxiv.org/pdf/' + versionedId + '.pdf', absUrl = 'https://arxiv.org/abs/' + versionedId;
    const sourceUrl = paper.url && extractArxivId(paper.url) ? paper.url : absUrl;
    if (fmt === 'html') {
      const htmlRes = await readFast(htmlUrl, 'document').catch(() => null);
      if (htmlRes) {
        if (isPdfBytes(htmlRes.bytes)) return savePdfBytes(htmlRes.bytes, sourceUrl);
        const info = safeHtmlMeta(parseWebArticle, htmlRes);
        if (info.parsed && !isArxivHtmlUnavailable(info.parsed)) return saveWebArticle(info.parsed, info.meta);
      }
      const pdfSaved = await tryPdfUrl(pdfUrl, sourceUrl);
      return pdfSaved ? { ...pdfSaved, arxivFallback: 'html-to-pdf' } : null;
    }
    return tryPdfUrl(pdfUrl, sourceUrl);
  };

  const arxivId = extractArxivId(paper.arxivId, doi) ?? extractArxivId(paper.url) ?? extractArxivId(paper.oaPdfUrl);
  if (arxivId) {
    const ver = arxivVersionSuffix(paper);
    const saved = await tryArxiv(ver && !arxivId.endsWith(ver) ? arxivId + ver : arxivId);
    if (saved) return saved;
  }
  if (paper.oaPdfUrl) {
    const saved = await tryPdfUrl(paper.oaPdfUrl, paper.url ?? paper.oaPdfUrl);
    if (saved) return saved;
  }
  if (doi) {
    const doiUrl = 'https://doi.org/' + encodeURI(doi);
    const [landRes, crRes, oaRes] = await Promise.allSettled([
      readFast(doiUrl, 'document'),
      readFast('https://api.crossref.org/works/' + encodeURIComponent(doi), 'json'),
      readFast(oaUrl('/works/https://doi.org/' + encodeURIComponent(doi.toLowerCase()), { select: 'best_oa_location' }, deps.settings), 'json')
    ]);
    const cr = crRes.status === 'fulfilled' ? parseCrossref(crRes.value.bytes) : { meta: {} };
    const oaPdf = oaRes.status === 'fulfilled' ? parseOpenAlexOaPdf(oaRes.value.bytes) : undefined;
    let landInfo: ReturnType<typeof safeHtmlMeta> | undefined;
    if (landRes.status === 'fulfilled') {
      const land = landRes.value;
      if (isPdfBytes(land.bytes)) return savePdfBytes(land.bytes, land.url.href);
      const redirected = parseAcademicInput(land.url.href);
      if (redirected?.kind === 'arxiv') { const saved = await tryArxiv(redirected.versionedId); if (saved) return saved; }
      landInfo = safeHtmlMeta(parseWebArticle, land);
    }
    const sourceUrl = paper.url ?? doiUrl;
    for (const candidate of [landInfo?.pdfUrl, oaPdf, cr.pdfUrl]) { const saved = await tryPdfUrl(candidate, sourceUrl); if (saved) return saved; }
    if (landInfo?.parsed && isSubstantialOaHtml(landInfo.parsed)) return saveWebArticle(landInfo.parsed, mergeMeta(landInfo.meta, cr.meta, doi));
  }
  return saveAbstract(true);
}
