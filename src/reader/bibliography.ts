import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api.js';

interface ReferencePaper { pages: number; textContent(page: number): Promise<TextContent> }
interface BibliographyEntry { entry: string; title?: string }
export interface CitationGroup { text: string; numbers: number[]; from: number; to: number }
const indices = new WeakMap<ReferencePaper, Promise<ReadonlyMap<number, BibliographyEntry>>>();
const heading = /^(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+)?(?:references|bibliography|works cited|literature cited|参考文献)\s*[:.]?$/iu;
const entryStart = /^\s*(?:\[\s*(\d{1,4})\s*\]|(\d{1,4})[.)])\s*(.*)$/u;

export function citationGroups(text: string): CitationGroup[] {
  const groups: CitationGroup[] = [];
  const pattern = /[\[［]\s*(\d{1,4}(?:\s*[-‐‑‒–—−~～]\s*\d{1,4})?(?:\s*[,，、;；]\s*\d{1,4}(?:\s*[-‐‑‒–—−~～]\s*\d{1,4})?)*)\s*[\]］]/gu;
  for (const match of text.matchAll(pattern)) {
    const numbers = new Set<number>();
    let valid = true;
    for (const part of match[1].split(/[,，、;；]/u)) {
      const [first, last = first] = part.trim().split(/\s*[-‐‑‒–—−~～]\s*/u).map(Number);
      if (first < 1 || last < first || last - first > 200) { valid = false; break; }
      for (let number = first; number <= last; number++) numbers.add(number);
    }
    if (valid) groups.push({ text: match[0], numbers: [...numbers], from: match.index, to: match.index + match[0].length });
  }
  return groups;
}

function textLines(content: TextContent): string[] {
  const lines: string[] = [];
  let line = '', previous: TextItem | undefined;
  const flush = () => { if (line.trim()) lines.push(line.trim().normalize('NFKC')); line = ''; previous = undefined; };
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const size = Math.max(item.height, previous?.height ?? 0, 1);
    if (previous && Math.abs(item.transform[5] - previous.transform[5]) > size * .8) flush();
    if (previous && item.transform[4] - previous.transform[4] - previous.width > size * .15 && !/\s$/u.test(line)) line += ' ';
    line += item.str;
    if (item.hasEOL) flush();
    else previous = item;
  }
  flush();
  return lines;
}

function printedTitle(entry: string): string | undefined {
  const quoted = /[“"]([^”"]{5,})[”"]/u.exec(entry)?.[1];
  if (quoted) return quoted.replace(/[.,]\s*$/u, '');
  // ACM places a year between the authors and the title. In CVPR-style references
  // the final surname (rather than an initial) ends the author list.
  const afterYear = /\b(?:18|19|20)\d{2}[a-z]?\)?\.\s+(.+)$/u.exec(entry)?.[1];
  const afterAuthors = /^.+?\p{Ll}[\p{L}\p{M}'’-]*\.\s+(.+)$/u.exec(entry)?.[1];
  const candidate = afterYear ?? afterAuthors;
  if (!candidate || /^(?:https?:\/\/|doi:|arXiv:|\d{4}\b)/iu.test(candidate)) return;
  const title = candidate.split(/[.!?](?:\s+|$)/u, 1)[0].trim();
  if (title && /\p{L}/u.test(title)) return title;
}

export function parseBibliography(pages: string[][]): Map<number, BibliographyEntry> {
  const lines = pages.flat();
  let first = lines.findIndex(line => heading.test(line)) + 1;
  // Some PDFs omit the heading. Require a numbered bibliography beginning with
  // two publication records before accepting numbers elsewhere on the page.
  if (!first) {
    first = lines.findIndex((line, index) => {
      const start = /^\[1\]\s/u.test(line);
      if (!start) return false;
      const next = lines.slice(index + 1, index + 22).findIndex(value => /^\[2\]\s/u.test(value));
      return next >= 0 && /\b(?:18|19|20)\d{2}\b/u.test(lines.slice(index, index + next + 1).join(' '));
    });
    if (first < 0) return new Map();
  }
  const refs = new Map<number, BibliographyEntry>();
  let number = 0, parts: string[] = [], bracketed: boolean | undefined;
  const finish = () => {
    if (number && parts.length) {
      const printed = parts.join('\n').replace(/(https?:\/\/\S+[-/])\n(?=\S)/gu, '$1');
      const entry = printed.replace(/\s+/gu, ' ').trim();
      const joined = printed.replace(/(\p{L})-\n(?=(?:aware|based|level|scale|free|efficient)\b)/giu, '$1-')
        .replace(/\b(self|cross|fine|multi|single|real|large|fixed|end)-\n(?=\p{Ll})/gu, '$1-')
        .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1').replace(/\s+/gu, ' ').trim();
      refs.set(number, { entry, title: printedTitle(joined) });
    }
  };
  for (const line of lines.slice(first)) {
    if (/^\s*(?:appendi(?:x|ces)|supplementary (?:material|information))\b/iu.test(line)) break;
    if (!line.trim() || /^\s*\d{1,3}\s*$/u.test(line) || heading.test(line)) continue;
    const start = entryStart.exec(line);
    if (start && (bracketed === undefined || bracketed === Boolean(start[1])) && (start[1] || start[3])) {
      finish();
      bracketed = Boolean(start[1]);
      number = Number(start[1] || start[2]);
      parts = start[3] ? [start[3]] : [];
    } else if (number) parts.push(line);
  }
  finish();
  return refs;
}

export function bibliography(paper: ReferencePaper): Promise<ReadonlyMap<number, BibliographyEntry>> {
  const cached = indices.get(paper);
  if (cached) return cached;
  const read = async () => {
    const pages: string[][] = [];
    for (let number = paper.pages; number > 0; number--) {
      const lines = textLines(await paper.textContent(number));
      pages.push(lines);
      if (lines.some(line => heading.test(line))) break;
    }
    return parseBibliography(pages.reverse());
  };
  const request = read();
  indices.set(paper, request);
  void request.catch(() => indices.delete(paper));
  return request;
}
