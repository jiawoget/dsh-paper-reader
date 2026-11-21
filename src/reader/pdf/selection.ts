import type { ReadingSide, SelectionHit, SelectionSegment } from '../../shared/types.js';
import { clipToText } from '../quote-range.js';
import type { Passage } from './model.js';
import { element, place, type Sheet } from './paper.js';
import { pairSelection } from './alignment.js';

interface Glyph { node: Text; offset: number; end: number }

function searchable(character: string): string {
  return character.normalize('NFKC').toLowerCase().replace(/[\s\u00ad\-‐‑]/gu, '');
}

/** The layout supplies spaces between positioned runs that the DOM text nodes can omit. */
function sourceSlice(paragraph: string, prefix: string, selected: string): { text: string; offset?: number } {
  const offsets: number[] = [];
  let corpus = '', index = 0;
  for (const character of paragraph) {
    const key = searchable(character);
    for (let i = 0; i < key.length; i++) offsets.push(index);
    corpus += key;
    index += character.length;
  }
  const needle = searchable(selected);
  const hint = searchable(prefix).length;
  const at = corpus.startsWith(needle, hint) ? hint : corpus.indexOf(needle);
  if (!needle || at < 0) return { text: selected };
  const offset = offsets[at], last = offsets[at + needle.length - 1];
  const length = String.fromCodePoint(paragraph.codePointAt(last)!).length;
  return { text: paragraph.slice(offset, last + length), offset };
}

/** Native PDF runs can split any word across fonts, lines or hyphenation marks. */
export function findQuote(spans: HTMLElement[], quote: string, prefix?: string): Range | null {
  const needle = searchable(quote);
  if (!needle) return null;
  let corpus = '';
  const offsets: Glyph[] = [];
  for (const span of spans) {
    const node = span.firstChild;
    if (!(node instanceof Text)) continue;
    let offset = 0;
    for (const character of node.data) {
      const key = searchable(character);
      for (let i = 0; i < key.length; i++) offsets.push({ node, offset, end: offset + character.length });
      corpus += key;
      offset += character.length;
    }
  }
  const hint = prefix === undefined ? -1 : searchable(prefix).length;
  const at = hint >= 0 && corpus.startsWith(needle, hint) ? hint : corpus.indexOf(needle);
  if (at < 0) return null;
  const first = offsets[at], last = offsets[at + needle.length - 1];
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.end);
  return range;
}

export function paintRange(range: Range, sheet: Sheet, width: number): HTMLElement[] {
  const plane = sheet.plane.getBoundingClientRect();
  const scale = sheet.outer.dataset.pdfSide === 'translation' && sheet.outer.dataset.focus === 'passage' ? 1 : plane.width / width;
  if (!scale) return [];
  const markers: HTMLElement[] = [];
  for (const r of range.getClientRects()) {
    if (r.width <= 0.4 || r.height <= 0.4) continue;
    const marker = element('div', 'pdf-quote-mark');
    place(marker, { x: (r.left - plane.left) / scale, y: (r.top - plane.top) / scale,
      width: r.width / scale, height: r.height / scale });
    sheet.plane.append(marker);
    markers.push(marker);
  }
  return markers;
}

function belonging(node: Node | null): HTMLElement | null {
  return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-block-id]') ?? null;
}

function normalizeSelected(text: string): string {
  return text.replace(/(\p{L})-\r?\n(?=\p{Ll})/gu, '$1').replace(/\s+/gu, ' ').trim();
}

interface HitInput {
  root: HTMLElement;
  side: ReadingSide;
  page: number;
  passages: Map<string, Passage>;
  textNodes: (id: string) => HTMLElement[];
  figureImage: (id: string) => string | null;
  deliver: (hit: SelectionHit) => void;
  signal: AbortSignal;
  reflow?: boolean;
}

export function listenForSelections(input: HitInput): void {
  const { root, side, page, passages, signal, reflow } = input;
  const from = side === 'source' ? 'original' : 'translated';
  let lastRange: Range | undefined;
  const emit = (segments: SelectionSegment[], value: string, rect: DOMRect, isFigure = false, previewClick = false) => {
    const first = segments[0], p = first && passages.get(first.id);
    if (!p || !value.trim()) return;
    const context = segments.map(part => passages.get(part.id)!.text).join('\n\n');
    const sourceQuote = side === 'source' ? value : segments.map(part => part.original).join('\n\n');
    const index = p.text.indexOf(first.original);
    const sourceOffset = side === 'source' ? first.offset :
      index >= 0 && p.text.indexOf(first.original, index + 1) < 0 ? index : undefined;
    const image = isFigure ? input.figureImage(p.id) ?? undefined : undefined;
    input.deliver({ id: p.id, text: value, context, label: p.label, rect, page, side,
      sourceText: context, sourceQuote, sourceOffset, segments, previewClick, translatedOffset: side === 'translation' ? first.offset : undefined,
      ...(reflow && segments.length > 1 && { rangeOrder: 'reflow' as const }),
      ...(image && { image }) });
  };
  const selected = (deduplicate: boolean): boolean => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
    if (deduplicate && lastRange && range.startContainer === lastRange.startContainer && range.startOffset === lastRange.startOffset &&
      range.endContainer === lastRange.endContainer && range.endOffset === lastRange.endOffset) return false;
    const value = normalizeSelected(selection.toString());
    if (!value) return false;
    const segments: SelectionSegment[] = [];
    for (const [id, passage] of passages) {
      const ranges: Range[] = [];
      let prefix = '';
      for (const element of input.textNodes(id)) {
        const node = element.firstChild;
        if (!(node instanceof Text)) continue;
        const clipped = clipToText(range, node);
        if (clipped) {
          if (!ranges.length) prefix += node.data.slice(0, clipped.startOffset);
          ranges.push(clipped);
        } else if (!ranges.length) prefix += node.data;
      }
      const raw = ranges.map(part => part.toString()).join('');
      if (!raw.trim()) continue;
      const slice = side === 'source' ? sourceSlice(passage.text, prefix, raw) : { text: raw, offset: ranges[0].startOffset };
      segments.push({ id, ...pairSelection(passage, slice.text, from, slice.offset), offset: slice.offset, ranges });
    }
    if (!segments.length) return false;
    segments.sort((a, b) => a.ranges[0].compareBoundaryPoints(Range.START_TO_START, b.ranges[0]));
    const focus = selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset
      ? segments[0].ranges[0] : segments.at(-1)!.ranges.at(-1)!;
    const text = reflow ? segments.map(part => part.original).join('\n\n') : value;
    lastRange = range.cloneRange();
    emit(segments, text, Array.from(focus.getClientRects()).at(-1) ?? focus.getBoundingClientRect());
    return true;
  };
  let frame = 0, touchTimer = 0, touch = false;
  const afterGesture = (deduplicate = false) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (!signal.aborted) selected(deduplicate); });
  };
  const afterTouchSelection = () => {
    clearTimeout(touchTimer);
    // Browser-owned selection handles can change the range without a DOM pointerup.
    touchTimer = window.setTimeout(() => afterGesture(true), 220);
  };
  root.addEventListener('pointerdown', event => {
    touch = event.pointerType === 'touch';
    if (touch) lastRange = undefined;
    clearTimeout(touchTimer);
  }, { signal });
  root.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') afterTouchSelection();
    else afterGesture();
  }, { signal });
  root.addEventListener('pointercancel', event => {
    if (event.pointerType === 'touch') afterTouchSelection();
  }, { signal });
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) lastRange = undefined;
    else if (touch && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) afterTouchSelection();
  }, { signal });
  signal.addEventListener('abort', () => {
    clearTimeout(touchTimer);
    cancelAnimationFrame(frame);
  }, { once: true });
  document.addEventListener('keyup', event => {
    if ((event.shiftKey || event.key === 'Shift') && root.contains(window.getSelection()?.focusNode ?? null) &&
      !(event.target instanceof Element && event.target.closest('#card, #rail, dialog'))) afterGesture();
  }, { signal });
  if (reflow) return;
  root.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const target = belonging(event.target);
    const id = target?.dataset.blockId, passage = id ? passages.get(id) : undefined;
    if (!target || !id || !passage) return;
    const isFigure = target.classList.contains('pdf-figure');
    if (isFigure) {
      window.getSelection()?.removeAllRanges();
      const value = (side === 'translation' && passage.translation) || passage.text;
      emit([{ id, ...pairSelection(passage, value, from), ranges: [] }], value, target.getBoundingClientRect(), true, event.detail > 0);
    } else if (!window.getSelection()?.isCollapsed) return;
    else if (side === 'translation' && passage.translation) {
      emit([{ id, ...pairSelection(passage, passage.translation, from), ranges: [] }], passage.translation, target.getBoundingClientRect(), false, event.detail > 0);
    } else if (target.textContent?.trim().toLowerCase() === 'block tables') {
      const value = target.textContent.trim();
      emit([{ id, ...pairSelection(passage, value, from), ranges: [] }], value, target.getBoundingClientRect(), false, event.detail > 0);
    }
  }, { signal });
}
