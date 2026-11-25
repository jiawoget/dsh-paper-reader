import type { DocumentInfo, PaperEvidence } from '../shared/types.js';
import type { PdfDocument } from './pdf-view.js';

export type PaperPage = PaperEvidence['excerpts'][number];
const paperCache = new WeakMap<PdfDocument, Promise<PaperPage[]>>();
const budget = 96_000;

export function needsEnglishSearch(pages: PaperPage[], question: string): boolean {
  if (!/\p{Script=Han}/u.test(question) || pages.reduce((sum, p) => sum + p.text.length, 0) <= budget) return false;
  const sample = pages.slice(0, 4).map(p => p.text.slice(0, 1200)).join(' ');
  return (sample.match(/[A-Za-z]{3,}/gu)?.length ?? 0) > (sample.match(/\p{Script=Han}/gu)?.length ?? 0);
}

/** Keep the source page number even when PDF.js supplies only a sparse or partly scanned document. */
export function readPaper(doc: DocumentInfo, pdf?: PdfDocument): Promise<PaperPage[]> {
  if (!pdf) return Promise.resolve([{ page: doc.sectionPage ?? 1, text: (doc.paragraphs ?? []).map((p, i) => '[Paragraph ' + (i + 1) + '] ' + p).join('\n\n') }]);
  const cached = paperCache.get(pdf);
  if (cached) return cached;
  const request = (async () => {
    const pages: PaperPage[] = [];
    for (let page = 1; page <= pdf.pages; page++) {
      const content = await pdf.textContent(page);
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('')
        .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1').replace(/[^\S\n]+/gu, ' ').trim();
      pages.push({ page, text });
    }
    return pages;
  })();
  paperCache.set(pdf, request);
  void request.catch(() => { if (paperCache.get(pdf) === request) paperCache.delete(pdf); });
  return request;
}

/** Short papers are sent in full. For long documents, search every page and retain distributed context. */
export function paperEvidence(title: string, pages: PaperPage[], query: string): PaperEvidence {
  const content = pages.filter(p => p.text.trim());
  if (!content.length) throw Error(typeof navigator !== 'undefined' && /^zh(?:-|$)/i.test(navigator.language || '') ? '这份文档没有可检索文字。请先导入 OCR 副本再进行全文问答。' : 'This document has no searchable text. Import an OCR copy to chat about its contents.');
  const pageCount = pages.at(-1)!.page;
  if (content.length <= 5000 && content.reduce((n, p) => n + p.text.length, 0) <= budget) {
    return { title, pageCount, partial: content.length < pageCount, excerpts: content };
  }
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(t => !/^(?:the|for|and|with|this|that|what|does|how|are|was|were|have|paper|from|about)$/.test(t));
  const mentioned = new Set([...query.matchAll(/(?:page|p[.]|第)\s*(\d+)/giu)].map(match => Number(match[1])));
  const chunks: { page: number; text: string; score: number }[] = [];
  for (const { page, text } of content) {
    for (let offset = 0; offset < text.length; offset += 1650) {
      const passage = text.slice(Math.max(0, offset - 100), offset + 1650).trim(), lower = passage.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0) + (mentioned.has(page) ? 4 : 0);
      if (passage) chunks.push({ page, text: passage, score });
    }
  }
  const selected = new Set<number>();
  // An overview question still receives the introduction, conclusion and samples across the entire work.
  for (let n = 0; n < 12; n++) selected.add(Math.round(n * (chunks.length - 1) / 11));
  let size = [...selected].reduce((sum, i) => sum + chunks[i].text.length, 0);
  const scores = new Map<number, number[]>();
  chunks.forEach((chunk, i) => {
    const group = scores.get(chunk.score);
    if (group) group.push(i); else scores.set(chunk.score, [i]);
  });
  for (const [, indices] of [...scores].sort((a, b) => b[0] - a[0])) {
    // Equal relevance gets a spread of positions, including when a translation or lexical match is unavailable.
    const ranges = [[0, indices.length - 1]];
    for (let i = 0; i < ranges.length && size < budget; i++) {
      const [left, right] = ranges[i], mid = (left + right) >>> 1, index = indices[mid];
      if (!selected.has(index) && size + chunks[index].text.length <= budget) {
        selected.add(index); size += chunks[index].text.length;
      }
      if (mid > left) ranges.push([left, mid - 1]);
      if (mid < right) ranges.push([mid + 1, right]);
    }
  }
  return { title, pageCount, partial: true, excerpts: [...selected].sort((a, b) => a - b).map(i => ({ page: chunks[i].page, text: chunks[i].text })) };
}
