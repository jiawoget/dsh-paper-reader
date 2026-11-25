import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { extractArxivId } from '../shared/citation-export.js';
import { safeWeb } from './ui.js';

interface ReferencePaper { pages: number; textContent(page: number): Promise<TextContent> }
export interface BibliographyEntry {
  entry: string; page?: number; title?: string; authors?: string; year?: string;
  arxivId?: string; doi?: string; url?: string;
}
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

function extractAuthors(joined: string, title?: string): string | undefined {
  let prefix = '';
  if (title) {
    const idx = joined.indexOf(title);
    if (idx > 0) prefix = joined.slice(0, idx);
  }
  if (!prefix) {
    const stop = /\b(?:18|19|20)\d{2}[a-z]?\b|https?:\/\/|doi:|arXiv:/iu.exec(joined);
    if (stop && stop.index > 0) prefix = joined.slice(0, stop.index);
  }
  prefix = prefix
    .replace(/\s*\(?\b(?:18|19|20)\d{2}[a-z]?\)?\.?\s*$/u, '')
    .replace(/[\s.,;:("“]+$/u, '')
    .trim();
  if (prefix && /\p{L}/u.test(prefix) && !/^(?:https?:\/\/|doi:|arXiv:)/iu.test(prefix)) return prefix;
}

export function parseBibliography(pages: string[][], firstPage = 1): Map<number, BibliographyEntry> {
  const tagged = pages.flatMap((pageLines, i) => pageLines.map(text => ({ text, page: firstPage + i })));
  const lines = tagged.map(item => item.text);
  let first = lines.findIndex(line => heading.test(line)) + 1;
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
  let number = 0, entryPage = firstPage, parts: string[] = [], bracketed: boolean | undefined;
  const finish = () => {
    if (number && parts.length) {
      let printed = parts.join('\n');
      for (let prev = ''; prev !== printed;) {
        prev = printed;
        printed = printed.replace(/((?:https?:\/\/|doi:\s*10\.\d{4,9}\/)(?:\S*[-/.])?)\n(?=\S)/giu, '$1');
      }
      const entry = printed.replace(/\s+/gu, ' ').trim();
      const joined = printed.replace(/(\p{L})-\n(?=(?:aware|based|level|scale|free|efficient)\b)/giu, '$1-')
        .replace(/\b(self|cross|fine|multi|single|real|large|fixed|end)-\n(?=\p{Ll})/gu, '$1-')
        .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1').replace(/\s+/gu, ' ').trim();
      const rawUrl = /https?:\/\/[^\s<>()[\]"']+/u.exec(joined)?.[0]?.replace(/[.,;:)\]]+$/u, '');
      const url = safeWeb(rawUrl);
      const doi = /\b(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[^\s<>()[\]"']+)/iu.exec(joined)?.[1]?.replace(/[.,;:)\]]+$/u, '');
      const arxivId = extractArxivId(url, doi) ?? /\barXiv:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?\b/iu.exec(joined)?.[1]?.toLowerCase();
      const noUrl = joined.replace(/https?:\/\/\S+/gu, '');
      const year = /\b((?:18|19|20)\d{2})[a-z]?\b/u.exec(noUrl)?.[1] ?? /\b((?:18|19|20)\d{2})[a-z]?\b/u.exec(joined)?.[1];
      const title = printedTitle(joined);
      const authors = extractAuthors(joined, title);
      refs.set(number, {
        entry, page: entryPage,
        ...(title && { title }), ...(authors && { authors }), ...(year && { year }),
        ...(arxivId && { arxivId }), ...(doi && { doi }), ...(url && { url })
      });
    }
  };
  for (const { text: line, page } of tagged.slice(first)) {
    if (/^\s*(?:appendi(?:x|ces)|supplementary (?:material|information))\b/iu.test(line)) break;
    if (!line.trim() || /^\s*\d{1,3}\s*$/u.test(line) || heading.test(line)) continue;
    const start = entryStart.exec(line);
    if (start && (bracketed === undefined || bracketed === Boolean(start[1])) && (start[1] || start[3])) {
      finish();
      bracketed = Boolean(start[1]);
      number = Number(start[1] || start[2]);
      entryPage = page;
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
    return parseBibliography(pages.reverse(), paper.pages - pages.length + 1);
  };
  const request = read();
  indices.set(paper, request);
  void request.catch(() => indices.delete(paper));
  return request;
}
