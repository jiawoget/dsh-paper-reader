import { parseAcademicInput, type AcademicTarget } from '../shared/academic-intake.js';
import type { DocMetadata, OpenDocument } from '../shared/types.js';
import { articleUrl, type WebArticle } from '../shared/web-article.js';
import { fail, isRecord, type Library } from './library.js';
import { publicResource } from './public-resource.js';

export type ResourceReader = typeof publicResource;
export const isPdfBytes = (bytes: Buffer): boolean => bytes.subarray(0, 1024).includes('%PDF-');
export function pdfFilename(url: URL): string {
  let name = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
  try { name = decodeURIComponent(name); } catch {}
  return name.toLowerCase().endsWith('.pdf') ? name : name + '.pdf';
}
export function decodeHtml(bytes: Buffer, type: string, charset?: string): string {
  if (type === 'application/pdf' || bytes.length > 5 * 1024 * 1024) fail('This link did not return a readable HTML article or PDF.', 415);
  const sniff = bytes.subarray(0, 4096).toString('latin1');
  if (!type.includes('html') && !/<(?:!doctype\s+html|html|head|body|article|main)\b/i.test(sniff)) fail('This link did not return a readable HTML article or PDF.', 415);
  const encoding = charset || /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] || 'utf-8';
  try { return new TextDecoder(encoding).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

const pickMeta = ({ paperTitle, authors, venue, year, doi, publisher, abstract }: WebArticle): DocMetadata => ({ paperTitle, authors, venue, year, doi, publisher, abstract });
const mergeMeta = (p: DocMetadata, f: DocMetadata, doi?: string): DocMetadata => ({
  paperTitle: p.paperTitle ?? f.paperTitle, authors: p.authors ?? f.authors, venue: p.venue ?? f.venue,
  year: p.year ?? f.year, doi: p.doi ?? f.doi ?? doi, publisher: p.publisher ?? f.publisher, abstract: p.abstract ?? f.abstract
});

function parseCrossref(bytes: Buffer): { meta: DocMetadata; pdfUrl?: string } {
  try {
    const body: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(body) || !isRecord(body.message)) return { meta: {} };
    const m = body.message, first = (v: unknown) => Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;
    const authors = Array.isArray(m.author) ? m.author.map(a =>
      isRecord(a) ? (typeof a.family === 'string' && typeof a.given === 'string' ? `${a.family}, ${a.given}` : typeof a.family === 'string' ? a.family : typeof a.name === 'string' ? a.name : '') : ''
    ).filter(Boolean).join('; ') : undefined;
    let year: string | undefined;
    for (const k of ['published-print', 'published-online', 'published', 'issued', 'created']) {
      const part = isRecord(m[k]) && Array.isArray(m[k]['date-parts']) && Array.isArray(m[k]['date-parts'][0]) ? m[k]['date-parts'][0][0] : undefined;
      if ((typeof part === 'number' || typeof part === 'string') && /^(1[5-9]\d{2}|20\d{2}|21\d{2})$/.test(String(part))) { year = String(part); break; }
    }
    const abstract = typeof m.abstract === 'string' ? m.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : undefined;
    const pdfLink = Array.isArray(m.link) ? m.link.find(l => isRecord(l) && typeof l['content-type'] === 'string' && l['content-type'].toLowerCase().includes('application/pdf') && typeof l.URL === 'string') : undefined;
    return {
      meta: { paperTitle: first(m.title), authors: authors || undefined, venue: first(m['container-title']), year, publisher: typeof m.publisher === 'string' ? m.publisher : undefined, abstract: abstract || undefined },
      pdfUrl: isRecord(pdfLink) && typeof pdfLink.URL === 'string' ? articleUrl(pdfLink.URL)?.href : undefined
    };
  } catch { return { meta: {} }; }
}

function readHtmlMeta(parseArticle: (html: string, url: string) => WebArticle, html: string, url: string): { parsed?: WebArticle; meta: DocMetadata; pdfUrl?: string } {
  try { const parsed = parseArticle(html, url); return { parsed, meta: pickMeta(parsed), pdfUrl: parsed.pdfUrl }; }
  catch { try { const stub = parseArticle(html + '<p>.</p>', url); return { meta: pickMeta(stub), pdfUrl: stub.pdfUrl }; } catch { return { meta: {} }; } }
}

export async function resolveAcademicIntake(
  library: Library, target: Extract<AcademicTarget, { kind: 'arxiv' | 'doi' }>,
  readResource: ResourceReader, parseArticle: (html: string, url: string) => WebArticle
): Promise<OpenDocument> {
  if (target.kind === 'arxiv') {
    const [absRes, pdfRes] = await Promise.allSettled([readResource(target.absUrl, 'document'), readResource(target.pdfUrl, 'document')]);
    const absInfo = absRes.status === 'fulfilled' && !isPdfBytes(absRes.value.bytes)
      ? readHtmlMeta(parseArticle, decodeHtml(absRes.value.bytes, absRes.value.type, absRes.value.charset), absRes.value.url.href) : undefined;
    if (pdfRes.status === 'fulfilled' && isPdfBytes(pdfRes.value.bytes)) {
      const meta = absInfo?.meta ?? {};
      return { doc: await library.importPdf(meta.paperTitle || target.versionedId.replace(/\//g, '_') + '.pdf', pdfRes.value.bytes, target.absUrl, meta) };
    }
    if (absInfo?.parsed) return library.importWebDocument(absInfo.parsed);
    throw pdfRes.status === 'rejected' ? pdfRes.reason : absRes.status === 'rejected' ? absRes.reason : fail('This link did not return a readable HTML article or PDF.', 415);
  }
  const [landRes, crRes] = await Promise.allSettled([readResource(target.url, 'document'), readResource('https://api.crossref.org/works/' + encodeURIComponent(target.doi), 'json')]);
  const cr = crRes.status === 'fulfilled' ? parseCrossref(crRes.value.bytes) : { meta: {} };
  const tryPdf = async (candidate: string | undefined, sourceUrl: string, meta: DocMetadata): Promise<OpenDocument | null> => {
    const pdfRes = candidate ? await readResource(candidate, 'document').catch(() => null) : null;
    return pdfRes && isPdfBytes(pdfRes.bytes) ? { doc: await library.importPdf(meta.paperTitle || pdfFilename(pdfRes.url), pdfRes.bytes, sourceUrl, meta) } : null;
  };
  if (landRes.status === 'fulfilled') {
    const land = landRes.value;
    if (isPdfBytes(land.bytes)) { const meta = mergeMeta({}, cr.meta, target.doi); return { doc: await library.importPdf(meta.paperTitle || pdfFilename(land.url), land.bytes, land.url.href, meta) }; }
    const landInfo = readHtmlMeta(parseArticle, decodeHtml(land.bytes, land.type, land.charset), land.url.href);
    const merged = mergeMeta(landInfo.meta, cr.meta, target.doi), redirected = parseAcademicInput(land.url.href);
    const pdfDoc = await tryPdf(redirected?.kind === 'arxiv' ? redirected.pdfUrl : (landInfo.pdfUrl ?? cr.pdfUrl), redirected?.kind === 'arxiv' ? redirected.absUrl : land.url.href, merged);
    if (pdfDoc) return pdfDoc;
    if (landInfo.parsed) return library.importWebDocument({ ...landInfo.parsed, ...merged });
  }
  return (await tryPdf(cr.pdfUrl, target.url, mergeMeta({}, cr.meta, target.doi)))
    ?? (landRes.status === 'rejected' ? Promise.reject(landRes.reason) : fail('This link did not return a readable HTML article or PDF.', 415));
}
