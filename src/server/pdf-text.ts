import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { DocPageRecord, DocumentInfo } from '../shared/types.js';

function normalizePdfText(items: ReadonlyArray<unknown>): string {
  return items
    .map(item => typeof item === 'object' && item !== null && 'str' in item && typeof item.str === 'string'
      ? item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ') : '')
    .join('')
    .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1')
    .replace(/[^\S\n]+/gu, ' ')
    .trim();
}

export async function extractPdfPages(bytes: Buffer | Uint8Array): Promise<DocPageRecord[]> {
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  let doc: Awaited<typeof task.promise> | undefined;
  try {
    doc = await task.promise;
    const pages: DocPageRecord[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const pdfPage = await doc.getPage(page);
      try { pages.push({ page, text: normalizePdfText((await pdfPage.getTextContent()).items) }); }
      finally { pdfPage.cleanup(); }
    }
    return pages;
  } finally {
    try { await doc?.cleanup(); } catch {}
    try { await task.destroy(); } catch {}
  }
}

export async function extractDocumentPages(doc: DocumentInfo, pdfBytes?: Buffer): Promise<DocPageRecord[]> {
  if (doc.kind === 'pdf') return pdfBytes ? extractPdfPages(pdfBytes) : [];
  if (doc.kind === 'abstract') {
    const text = [doc.paperTitle || doc.title, doc.authors, doc.venue, doc.year, doc.doi, doc.abstract]
      .filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).join('\n\n').trim();
    return text ? [{ page: 1, text }] : [];
  }
  if (doc.paragraphs?.length) {
    const text = doc.paragraphs.map(p => p.trim()).filter(Boolean).join('\n\n');
    return text ? [{ page: doc.sectionPage ?? 1, text }] : [];
  }
  if (doc.book?.sections.length) {
    const text = [doc.title, ...doc.book.sections.map(s => s.title)].filter(Boolean).join('\n');
    return text ? [{ page: 1, text }] : [];
  }
  return [];
}
