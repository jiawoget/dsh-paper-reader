import { isValidExplicitDest } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, StructTreeNode, TextContent } from 'pdfjs-dist/types/src/display/api.js';
import { maxOutlineLineLength, maxOutlineLinesPerPage, type PdfOutlineEntry, type PdfOutlineLine,
  type PdfOutlinePage } from '../../shared/pdf-outline.js';
import { printedLines, sameTextFlow } from './extract.js';

type Viewport = ReturnType<PDFPageProxy['getViewport']>;
type Bookmark = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number];
const fraction = (value: number) => Math.max(0, Math.min(1, value));
const cleanText = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim();
const clipLine = (text: string, length = maxOutlineLineLength) => text.slice(0, length).replace(/[\uD800-\uDBFF]$/u, '');
const yieldToReader = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function destinationTop(view: Viewport, dest: unknown[]): number | undefined {
  const [, kind, first, second, third, fourth] = dest as [unknown, { name: string }, number | null, number | null, number, number];
  const [left, bottom, right, top] = view.viewBox;
  const y = (x: number, y: number) => view.convertToViewportPoint(x, y)[1] / view.height;
  switch (kind.name) {
    case 'XYZ':
      // Only the axis contributing to the displayed vertical position is relevant on rotated pages.
      if ((view.transform[1] && first == null) || (view.transform[3] && second == null)) return;
      return fraction(y(first ?? left, second ?? top));
    case 'FitH':
    case 'FitBH':
      if (first != null) return fraction(Math.min(y(left, first), y(right, first)));
      break;
    case 'FitV':
    case 'FitBV':
      if (first != null) return fraction(Math.min(y(first, bottom), y(first, top)));
      break;
    case 'FitR':
      return fraction(Math.min(y(first!, second!), y(third, fourth)));
  }
}

/** Only destinations with coordinates need a page's geometry. No page text or graphics are requested. */
export async function readPdfOutline(pdf: PDFDocumentProxy, signal?: AbortSignal): Promise<PdfOutlineEntry[]> {
  signal?.throwIfAborted();
  const roots = await pdf.getOutline();
  signal?.throwIfAborted();
  const result: PdfOutlineEntry[] = [];
  const pending = (roots ?? []).map(node => ({ node, level: 1 })).reverse();
  const pageIndexes = new Map<string, number>(), viewports = new Map<number, Viewport>();
  async function resolve(node: Bookmark, level: number): Promise<PdfOutlineEntry | undefined> {
    const title = cleanText(node.title ?? '');
    if (!title || node.url || node.unsafeUrl || !node.dest) return;
    const dest = typeof node.dest === 'string' ? await pdf.getDestination(node.dest) : node.dest;
    if (!dest || !isValidExplicitDest(dest) || dest.slice(2).some(n => n != null && !Number.isFinite(n))) return;
    const ref = dest[0];
    let index: number;
    if (typeof ref === 'number') index = ref;
    else {
      const key = ref.num + 'R' + ref.gen;
      index = pageIndexes.get(key) ?? await pdf.getPageIndex(ref);
      pageIndexes.set(key, index);
    }
    if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) return;
    const entry: PdfOutlineEntry = { title, page: index + 1, level };
    if (dest[2] != null || dest[3] != null) {
      const view = viewports.get(entry.page) ?? (await pdf.getPage(entry.page)).getViewport({ scale: 1 });
      viewports.set(entry.page, view);
      const top = destinationTop(view, dest);
      if (top !== undefined && Number.isFinite(top)) entry.top = top;
    }
    return entry;
  }
  let lastYield = performance.now();
  while (pending.length) {
    signal?.throwIfAborted();
    const { node, level } = pending.pop()!;
    let entry: PdfOutlineEntry | undefined;
    try { entry = await resolve(node, level); }
    catch { signal?.throwIfAborted(); } // A broken bookmark can still contain working local destinations.
    if (entry) result.push(entry);
    for (let i = (node.items?.length ?? 0) - 1; i >= 0; i--) {
      pending.push({ node: node.items[i], level: entry ? level + 1 : level });
    }
    if (performance.now() - lastYield > 24 && pending.length) {
      await yieldToReader();
      lastYield = performance.now();
    }
  }
  signal?.throwIfAborted();
  return result;
}

function headingRuns(tree: StructTreeNode | null, content: TextContent): Map<number, StructTreeNode> {
  const indices = new Map<number, StructTreeNode>();
  if (!tree) return indices;
  const ids = new Map<string, StructTreeNode>();
  function visit(node: StructTreeNode, inside?: StructTreeNode): void {
    const heading = /^H[1-6]?$/u.test(node.role) ? node : inside;
    for (const child of node.children) {
      if ('role' in child) visit(child, heading);
      else if (heading && child.type === 'content') ids.set(child.id, heading);
    }
  }
  visit(tree);
  if (!ids.size) return indices;
  const stack: (StructTreeNode | undefined)[] = [];
  let index = 0;
  for (const item of content.items) {
    if ('str' in item) {
      const heading = stack.at(-1);
      if (heading) indices.set(index, heading);
      index++;
    } else if (item.type === 'endMarkedContent') stack.pop();
    else stack.push(ids.get(item.id) ?? stack.at(-1));
  }
  return indices;
}

const numbered = /^(?:(?:\d{1,3}(?:\.\d{1,3})*[.)]?|[A-Z]\.\d+(?:\.\d+)*|[IVXLCDM]+[.)]|[A-Z][.)])\s+(?!\p{Ll})\p{L}|第\s*[\d一二三四五六七八九十百千万〇零两]+\s*[章节篇卷部講讲回]|[一二三四五六七八九十]+、)/u;
const chapter = /^(?:chapter|part|book|unit|section|lecture|appendix)\s+(?:\d|[a-z]\b|[ivxlcdm]+\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b)/iu;
const named = /^(?:abstract|introduction|background|contents|table of contents|preface|foreword|methods?|methodology|related work|results?|discussion|limitations|conclusions?|acknowledg(?:e)?ments?|references|bibliography|appendix|index|摘要|目录|目次|序言|前言|绪论|引言|结论|结语|参考文献|附录|索引)\s*[.:：]?$/iu;

const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
// Leave room for document metadata and the action envelope within the server's 5 MiB JSON limit.
const evidenceBytes = 4 * 1024 * 1024;

function pageEvidence(content: TextContent, view: Viewport, tree: StructTreeNode | null, page: number, byteBudget: number): PdfOutlinePage {
  const { lines, bodySize } = printedLines(content, view);
  const tagged = headingRuns(tree, content);
  const fontWeights = new Map<string, number>();
  for (const item of content.items) {
    if ('str' in item) fontWeights.set(item.fontName, (fontWeights.get(item.fontName) ?? 0) + item.str.trim().length);
  }
  const bodyFont = [...fontWeights].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ranked: { line: PdfOutlineLine; index: number; priority: number }[] = [];
  let previousHeading: StructTreeNode | undefined, wrapped: PdfOutlineLine | undefined;
  for (const [index, row] of lines.entries()) {
    const text = cleanText(row.text);
    const markedRun = tagged.size ? row.runs.find(run => tagged.has(run.index)) : undefined;
    const heading = markedRun && tagged.get(markedRun.index);
    if (!text || !(heading || /\p{L}/u.test(text)) || !Number.isFinite(row.box.y) || row.box.y > view.height ||
      row.box.y + row.box.height < 0 || row.box.x > view.width || row.box.x + row.box.width < 0) continue;
    if (heading && heading === previousHeading && wrapped) {
      const space = /[-‐]$/u.test(wrapped.text) || (/\p{Script=Han}$/u.test(wrapped.text) && /^\p{Script=Han}/u.test(text)) ? '' : ' ';
      wrapped.text = clipLine(wrapped.text + space + text);
      continue;
    }
    previousHeading = heading;
    const short = text.length <= maxOutlineLineLength && !/[.!?。！？,，;；‐-]$/u.test(text);
    const section = named.test(text) || (short && (numbered.test(text) || chapter.test(text)));
    const distinctFont = row.size >= bodySize * .94 && row.runs.every(run => run.text.fontName !== bodyFont);
    const previous = lines[index - 1];
    const words = text.match(/[\p{L}\p{M}]{2,}/gu) ?? [];
    const phrase = words.length >= 3 || /\p{Script=Han}{5}/u.test(text);
    const math = /[\p{Sm}\u{1D400}-\u{1D7FF}]/u.test(text) && !phrase;
    const continuous = sameTextFlow(previous, row) || sameTextFlow(row, lines[index + 1]);
    const display = short && !math && words.length > 0 && (row.size > bodySize * 1.13 || distinctFont) &&
      (row.size > bodySize * 1.5 || (!continuous && /^[\p{Lu}\p{Lt}\p{Lo}“‘「《]/u.test(text)));
    const prominent = heading || section || display;
    // Keep a little prose when the typography is uniform, including openings after a column break.
    const opening = !previous || row.box.y < previous.box.y - row.size || row.box.y - previous.box.y > row.size * 1.7;
    const priority = (heading ? 100 : section ? 80 : display ? 55 : 0)
      + (opening ? 8 : 0) + (phrase ? 6 : 0) + (row.size >= bodySize * .9 ? 3 : -4);
    const line: PdfOutlineLine = { text: clipLine(text), top: Math.round(fraction(row.box.y / view.height) * 10000) / 10000 };
    if (prominent) line.prominent = true;
    wrapped = heading ? line : undefined;
    ranked.push({ line, index, priority });
  }
  ranked.sort((a, b) => b.priority - a.priority || a.index - b.index);
  const result: PdfOutlinePage = { page, lines: [] };
  let remaining = byteBudget - jsonBytes(result);
  const chosen: typeof ranked = [];
  const seen = new Set<string>();
  for (const candidate of ranked) {
    const line = candidate.line;
    const key = line.prominent ? line.top + '\n' + line.text : line.text;
    if (seen.has(key)) continue;
    let bytes = jsonBytes(line) + 1;
    if (bytes > remaining && !chosen.length) {
      // Even very long books can keep one heading or opening line on each readable page.
      const chars = Math.floor((remaining - jsonBytes({ ...line, text: '' }) - 1) / 6);
      if (chars < 4) throw new Error('This PDF has too many pages for contents generation.');
      line.text = clipLine(line.text, chars);
      bytes = jsonBytes(line) + 1;
    }
    if (bytes > remaining) continue;
    seen.add(key);
    remaining -= bytes;
    chosen.push(candidate);
    if (chosen.length === maxOutlineLinesPerPage) break;
  }
  result.lines = chosen.sort((a, b) => a.index - b.index).map(item => item.line);
  return result;
}

/** Called on demand. Only the current page's PDF text and structure tree are kept during extraction. */
export async function readOutlinePages(pdf: Pick<PDFDocumentProxy, 'numPages' | 'getPage'>, onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal): Promise<PdfOutlinePage[]> {
  signal?.throwIfAborted();
  const pages: PdfOutlinePage[] = [], total = pdf.numPages;
  const byteBudget = Math.floor((evidenceBytes - 2) / total) - 1;
  if (byteBudget < 28) throw new Error('This PDF has too many pages for contents generation.');
  onProgress?.(0, total);
  let lastYield = performance.now();
  for (let number = 1; number <= total; number++) {
    signal?.throwIfAborted();
    const page = await pdf.getPage(number);
    signal?.throwIfAborted();
    const [content, tree] = await Promise.all([page.getTextContent({ includeMarkedContent: true }),
      page.getStructTree().catch(() => null)]);
    signal?.throwIfAborted();
    pages.push(pageEvidence(content, page.getViewport({ scale: 1 }), tree, number, byteBudget));
    onProgress?.(number, total);
    if (performance.now() - lastYield > 24 && number < total) {
      await yieldToReader();
      lastYield = performance.now();
    }
  }
  signal?.throwIfAborted();
  return pages;
}
