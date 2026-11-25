import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractArxivId, extractYear } from '../../shared/citation-export.js';

export interface PdfMetadata { paperTitle?: string; authors?: string; venue?: string; year?: string; doi?: string; url?: string }

const BOGUS_TITLE = /^(?:untitled|document|microsoft\s+word\b.*|slide\s*\d+|page\s*\d+|presentation\d*)$/i;
const PDF_DATE_RE = /^\s*D:\s*(1[5-9]\d{2}|20\d{2}|21\d{2})/i;
const DOI_LABELED_RE = /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)(10\.\d{4,9}\/[^\s<>()[\]"']+)/i;
const DOI_BARE_RE = /\b(10\.\d{4,9}\/[^\s<>()[\]"']+)/i;
const ARXIV_TEXT_RE = /\barXiv:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?\b/i;
const ARXIV_LINK_RE = /https?:\/\/(?:[\w-]+\.)?arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?/i;
const ARXIV_STAMP_YEAR_RE = /\[[\w-]+(?:\.[\w-]+)?\]\s*\d{1,2}\s+[A-Za-z]{3}\s+(1[5-9]\d{2}|20\d{2}|21\d{2})/;
const ARXIV_ID_TAG_RE = /^(?:arXiv:\s*\S+|doi:\s*\S+|10\.\d{4,9}\/\S+)$/i;

function cleanText(value: unknown, max: number): string | undefined {
  if (Array.isArray(value)) return value.map(v => cleanText(v, max)).filter(Boolean).join('; ').slice(0, max) || undefined;
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || undefined;
}
const parsePdfYear = (v: unknown) => { const raw = cleanText(v, 64); return raw ? (PDF_DATE_RE.exec(raw)?.[1] ?? extractYear(raw)) : undefined; };

export function parsePdfMetadata(info: unknown, xmp: { get(name: string): unknown } | null | undefined, page1Text: string): PdfMetadata {
  const rec = typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : undefined;
  const xmpGet = (key: string): unknown => { try { return xmp?.get(key); } catch { return undefined; } };
  const pickTitle = (v: unknown) => { const s = cleanText(v, 500); return s && !BOGUS_TITLE.test(s) ? s : undefined; };
  const paperTitle = pickTitle(rec?.Title) ?? pickTitle(xmpGet('dc:title'));
  const authors = cleanText(rec?.Author, 1000) ?? cleanText(xmpGet('dc:creator'), 1000);
  const subject = cleanText(rec?.Subject, 300);
  const text = page1Text.replace(/-\s*\n\s*/g, '-').replace(/(doi(?:\.org\/|:\s*)|arXiv:\s*(?:\d{4}\.)?|10\.\d{4,9}\/)\s*\n\s*/gi, '$1').replace(/\s+/g, ' ');
  const sources = [subject, cleanText(rec?.Keywords, 500), cleanText(xmpGet('prism:doi'), 256), cleanText(xmpGet('pdfx:doi'), 256), cleanText(xmpGet('dc:identifier'), 256), text].filter((s): s is string => Boolean(s));
  let doi: string | undefined;
  for (const s of sources) { const m = DOI_LABELED_RE.exec(s) ?? DOI_BARE_RE.exec(s); if (m) { doi = m[1].replace(/[.,;:)\]]+$/, ''); break; } }
  let arxivId = extractArxivId(undefined, doi);
  for (const s of sources) { if (arxivId) break; arxivId = extractArxivId(s) ?? ARXIV_TEXT_RE.exec(s)?.[1]?.toLowerCase() ?? ARXIV_LINK_RE.exec(s)?.[1]?.toLowerCase(); }
  const url = arxivId ? 'https://arxiv.org/abs/' + arxivId : undefined;
  const venue = cleanText(xmpGet('prism:publicationname'), 300) ?? (subject && !ARXIV_ID_TAG_RE.test(subject) ? subject : undefined);
  const arxivYear = arxivId?.match(/^(\d{2})(?:0[1-9]|1[0-2])\.\d{4,5}$/)?.[1];
  const year = parsePdfYear(rec?.CreationDate) ?? parsePdfYear(xmpGet('xmp:createdate')) ?? parsePdfYear(xmpGet('dc:date'))
    ?? parsePdfYear(rec?.ModDate) ?? ARXIV_STAMP_YEAR_RE.exec(text)?.[1] ?? (arxivYear ? '20' + arxivYear : undefined);
  return { ...(paperTitle ? { paperTitle } : {}), ...(authors ? { authors } : {}), ...(venue ? { venue } : {}), ...(year ? { year } : {}), ...(doi ? { doi } : {}), ...(url ? { url } : {}) };
}

export async function extractPdfMetadata(pdf: PDFDocumentProxy): Promise<PdfMetadata> {
  const [meta, content] = await Promise.all([pdf.getMetadata().catch(() => null), pdf.getPage(1).then(p => p.getTextContent()).catch(() => null)]);
  const page1Text = content ? content.items.map(it => 'str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '').join('') : '';
  return parsePdfMetadata(meta?.info, meta?.metadata, page1Text);
}
