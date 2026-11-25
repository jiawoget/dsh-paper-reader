import type { DocumentInfo, ReaderBlock } from '../shared/types.js';
import type { PaperPage } from './paper-evidence.js';
import { findTextMatches } from './pdf/selection.js';

type SearchSide = 'source' | 'translation';
export interface SearchBlock { id: string; text: string; }
interface SearchSource { page: number; side: SearchSide; text: string; blockId?: string; }
interface SearchMatch { page: number; side: SearchSide; blockId?: string; occurrence: number; snippet: string; matchStart: number; matchEnd: number; }
export interface SearchResult { query: string; matches: SearchMatch[]; groups: { page: number; matches: { index: number; match: SearchMatch }[] }[]; }

export function extractTranslatedBlocks(blocks: readonly ReaderBlock[]): SearchBlock[] {
  const out: SearchBlock[] = [];
  for (const block of blocks) {
    const text = block.translation?.trim();
    if (text && text !== block.text.trim()) out.push({ id: block.id, text });
  }
  return out;
}

export function buildSearchSources(doc: DocumentInfo, pdfPages: readonly PaperPage[] | undefined, translations: ReadonlyMap<number, readonly SearchBlock[]>): SearchSource[] {
  const sources: SearchSource[] = [];
  const addTranslated = (page: number) => {
    for (const b of translations.get(page) ?? []) sources.push({ page, side: 'translation', blockId: b.id, text: b.text });
  };
  if (pdfPages) {
    for (const entry of pdfPages) {
      if (entry.text.trim()) sources.push({ page: entry.page, side: 'source', text: entry.text });
      addTranslated(entry.page);
    }
    return sources;
  }
  const page = doc.sectionPage ?? 1;
  for (const [index, paragraph] of (doc.paragraphs ?? []).entries()) {
    const id = 'p-' + (index + 1);
    if (paragraph.trim() && doc.articleLayout?.[id]?.kind !== 'image') sources.push({ page, side: 'source', blockId: id, text: paragraph });
  }
  addTranslated(page);
  return sources;
}

export function searchDocument(sources: readonly SearchSource[], rawQuery: string): SearchResult {
  const query = rawQuery.trim();
  if (!query) return { query, matches: [], groups: [] };
  const matches: SearchMatch[] = [], byPage = new Map<number, { index: number; match: SearchMatch }[]>(), pageOcc = new Map<string, number>();
  for (const source of sources) {
    const display = source.text.replace(/\s+/gu, ' ').trim();
    if (!display) continue;
    const occKey = source.page + ':' + source.side + ':' + (source.blockId ?? '');
    let occ = pageOcc.get(occKey) ?? 0;
    for (const [{ start: rawStart, end: rawEnd }] of findTextMatches([{ data: display }], query)) {
      const winStart = Math.max(0, rawStart - 36), winEnd = Math.min(display.length, rawEnd + 56);
      const prefix = winStart > 0 ? '…' : '', suffix = winEnd < display.length ? '…' : '';
      const match: SearchMatch = {
        page: source.page, side: source.side, ...(source.blockId && { blockId: source.blockId }), occurrence: occ++,
        snippet: prefix + display.slice(winStart, winEnd) + suffix,
        matchStart: prefix.length + (rawStart - winStart), matchEnd: prefix.length + (rawEnd - winStart)
      };
      const index = matches.push(match) - 1;
      (byPage.get(source.page) ?? byPage.set(source.page, []).get(source.page)!).push({ index, match });
    }
    pageOcc.set(occKey, occ);
  }
  return { query, matches, groups: [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, list]) => ({ page, matches: list })) };
}
