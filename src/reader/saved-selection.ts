import type { SavedSelectionRange, TranslatedLocator } from '../shared/source-link.js';
import type { ReaderBlock, SelectionHit, SelectionSegment } from '../shared/types.js';
import { pairSelection } from './pdf/alignment.js';

export function selectionRange(hit: SelectionHit): SavedSelectionRange | undefined {
  const first = hit.segments?.[0], last = hit.segments?.at(-1);
  if (!first || !last || first.offset === undefined || last.offset === undefined) return;
  const text = hit.side === 'source' ? last.original : last.translated;
  if (!text) return;
  return { start: first.offset, endAnchor: last.id, end: last.offset + text.length,
    tail: Array.from(text).slice(-32).join(''), ...(hit.rangeOrder && { order: hit.rangeOrder }) };
}

// PDF runs and their browser selection can differ in line breaks, ligatures and line-end hyphens.
const comparable = (text: string) => text.normalize('NFKC').replace(/[\s\u00ad\-‐‑]/gu, '');

export function ambiguousQuote(block: ReaderBlock, quote?: string, target?: TranslatedLocator): boolean {
  const raw = target ? block.translation ?? '' : block.text;
  const needle = comparable(target?.text ?? quote ?? '').toLowerCase();
  if (!needle || target?.offset !== undefined && comparable(raw.slice(target.offset)).toLowerCase().startsWith(needle)) return false;
  const text = comparable(raw).toLowerCase(), first = text.indexOf(needle);
  return first >= 0 && text.indexOf(needle, first + 1) >= 0;
}

export function restoreSelection(blocks: ReaderBlock[], anchor: string, quote: string | undefined,
  target: TranslatedLocator | undefined, range: SavedSelectionRange): SelectionSegment[] | undefined {
  const first = blocks.findIndex(block => block.id === anchor), last = blocks.findIndex(block => block.id === range.endAnchor);
  if (first < 0 || last < first || !(target?.text || quote)) return;
  const segments: SelectionSegment[] = [], selected: string[] = [];
  for (let index = first; index <= last; index++) {
    const block = blocks[index], text = target ? block.translation : block.text;
    if (!text) return;
    const start = index === first ? range.start : 0, end = index === last ? range.end : text.length;
    if (start < 0 || end > text.length || end <= start) return;
    const slice = text.slice(start, end);
    selected.push(slice);
    segments.push({ id: block.id, ...pairSelection(block, slice, target ? 'translated' : 'original', start), offset: start, ranges: [] });
  }
  // Reject obsolete coordinates if the current extractor or translation has changed the text.
  if (!comparable(selected.join('')).startsWith(comparable(target?.text || quote!)) ||
    !comparable(selected.at(-1)!).endsWith(comparable(range.tail))) return;
  return segments;
}
