import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, TextContent } from 'pdfjs-dist/types/src/display/api.js';
import type { PageView, ReaderBlock, ReadingSide, RegionAction, SelectionHit, SelectionSegment } from '../shared/types.js';
import type { SavedSelectionRange, TranslatedLocator } from '../shared/source-link.js';
import type { PdfOutlineEntry, PdfOutlinePage } from '../shared/pdf-outline.js';
import { clipToText, textRange } from './quote-range.js';
import { ambiguousQuote, restoreSelection } from './saved-selection.js';
import { annotationLayoutChanged, withAnnotationSurface } from './annotation-layer.js';
import { translationQualityError } from '../shared/translation-quality.js';
import { extractLayout } from './pdf/extract.js';
import { pageGraphics, taggedArtwork } from './pdf/graphics.js';
import { correspondingText, pairSelection } from './pdf/alignment.js';
import type { PageLayout, Passage } from './pdf/model.js';
import { cropFigure, element, fitText, makeSheet, newAnchor, place, translatedText, type Sheet } from './pdf/paper.js';
import { PageRaster, cropPdfPage } from './pdf/raster.js';
import { pdfRegionPicker } from './pdf/region-picker.js';
import { readRegion, regionBox, figureAtRegion } from './pdf/region-geometry.js';
import { PdfFocus, type TranslationFocus } from './pdf/focus.js';
import { pageText } from './pdf/reading-text.js';
import { readOutlinePages, readPdfOutline } from './pdf/outline.js';
import { sampleDigest } from './pdf/sample.js';
import { findQuote, listenForSelections, paintRange } from './pdf/selection.js';

export type { PageView, ReaderBlock, SelectionHit };

export interface PdfRenderOptions {
  page: number;
  sourceEl: HTMLElement;
  translationEl: HTMLElement;
  translations?: Record<string, string>;
  /** Text and interaction are ready. The render promise also waits for the first full-resolution artwork. */
  onMounted?: (view: PdfPageView) => void;
  onSelect?: (selection: SelectionHit) => void;
  onRegion?: RegionAction;
  canContinueRegion?: (anchor: string) => boolean;
  onAmbiguousQuote?: () => void;
  onTranslationState?: () => void;
  /** A scale of one fits the available pane width. */
  zoom?: number;
  translationVisible?: boolean;
  focusMode?: TranslationFocus;
  focusId?: string;
  onFocus?: (id: string, label: string) => void;
}

export type PdfTranslationState = 'pending' | 'loading' | 'unavailable' | 'error' | 'scanned';
interface TranslationStatus {
  state: PdfTranslationState;
  message: string;
  actions: { label: string; run: () => void }[];
}
export interface PdfPageView extends PageView {
  readonly canReadText: boolean;
  readonly translationStatus?: TranslationStatus;
  goToOutline(top: number, title?: string): void;
  outlineTop(): number;
  setTextView(enabled: boolean): void;
  beginRegion(attach?: boolean): void;
  cancelRegion(): void;
  reopenRegion(id: string, receive?: RegionAction): Promise<void>;
  setZoom(zoom: number): void;
  setFocusMode(mode: TranslationFocus): void;
  setTranslationState(state: PdfTranslationState, message: string, actions?: {label: string; run: () => void}[]): void;
}

export interface PdfDocument {
  readonly pages: number;
  outline(): Promise<PdfOutlineEntry[]>;
  outlinePages(onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<PdfOutlinePage[]>;
  cropRegion(page: number, anchor: string): Promise<string>;
  textContent(page: number): Promise<TextContent>;
  render(options: PdfRenderOptions): Promise<PdfPageView>;
  destroy(): Promise<void>;
}

export const bundledPdfUrl = '/api/paper-reader/app/assets/pagedattention.pdf';
const vendor = '/api/paper-reader/vendor/';
const hostOwners = new WeakMap<HTMLElement, AbortController>();

async function sampleTranslations(page: number): Promise<Readonly<Record<string, string>>> {
  // The bundle includes the dictionaries so an already running DSH host can serve newly translated pages.
  const { default: entries } = await import(`../../public/assets/pagedattention-page-${page}.zh-CN.json`, { with: { type: 'json' } });
  return entries as Readonly<Record<string, string>>;
}

interface PlacedPassage {
  passage: Passage;
  source: HTMLElement;
  target: HTMLElement;
  sourceFigure?: HTMLElement;
  targetFigure?: HTMLElement;
  translated: HTMLDivElement;
  runs: HTMLElement[];
  markers: HTMLElement[];
  active?: { quote?: string; translated?: TranslatedLocator; part?: SelectionSegment; side?: ReadingSide };
}

interface MountedPage {
  options: PdfRenderOptions;
  source: Sheet;
  target: Sheet;
  layout: PageLayout;
  raster: PageRaster;
  nativeLayer: TextLayer;
  nativeContainer: HTMLElement;
  pageWidth: number;
  pageHeight: number;
  controller: AbortController;
}

function mount(input: MountedPage): PdfPageView {
  const { source, target, layout, options, raster, nativeLayer, nativeContainer,
    controller, pageWidth, pageHeight } = input;
  const { signal } = controller;
  let focus: PdfFocus | undefined;
  const byId = new Map([...layout.passages, ...(layout.sourceOnly ?? [])].map(p => [p.id, p]));
  const placed = new Map<string, PlacedPassage>();
  source.plane.append(raster.original, nativeContainer);
  target.plane.append(raster.artwork);
  for (const p of byId.values()) {
    const sourceAnchor = newAnchor(p), targetAnchor = newAnchor(p);
    const translated = translatedText(p);
    translated.hidden = true;
    if (layout.registered && options.page !== 6 && p.role === 'paragraph') {
      // The final line of a passage may end well before the typeset column margin.
      const right = p.box.x < 300 ? 296.5 : 560.5;
      const next = layout.passages.filter(other => other !== p && other.box.x > p.box.x &&
        other.box.y < p.box.y + p.box.height && p.box.y < other.box.y + other.box.height);
      const width = Math.max(p.box.width, Math.min(right, ...next.map(other => other.box.x)) - p.box.x);
      place(translated, { ...p.box, width });
    }
    const nodes = p.indices.map(i => nativeLayer.textDivs[i]).filter((n): n is HTMLElement => Boolean(n));
    for (const run of nodes) run.dataset.blockId = p.id;
    source.plane.append(sourceAnchor);
    target.plane.append(translated, targetAnchor);
    const item: PlacedPassage = { passage: p, source: sourceAnchor, target: targetAnchor, translated, runs: nodes, markers: [] };
    if (p.illustration) {
      item.sourceFigure = newAnchor(p, true);
      item.targetFigure = newAnchor(p, true);
      source.plane.append(item.sourceFigure);
      target.plane.append(item.targetFigure);
    }
    placed.set(p.id, item);
  }
  const status = element('div', 'pdf-translation-state');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  target.outer.append(status);
  let translationStatus: TranslationStatus | undefined;
  function setTranslationState(state: PdfTranslationState, message: string, actions: {label: string; run: () => void}[] = []): void {
    if (signal.aborted) return;
    translationStatus = { state, message, actions };
    options.onTranslationState?.();
    if (state === 'scanned' && nativeLayer.textDivs.some(run => run.textContent?.trim())) {
      status.hidden = true;
      return;
    }
    status.dataset.state = state;
    status.hidden = false;
    const copy = element('span', 'pdf-status-message');
    copy.textContent = message;
    status.replaceChildren(copy);
    for (const action of actions) {
      const button = element('button', 'pdf-status-action');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.run, { signal });
      status.append(button);
    }
  }

  let zoom = Number.isFinite(options.zoom) && (options.zoom ?? 0) > 0 ? options.zoom! : 1;
  const grid = options.sourceEl.closest<HTMLElement>('.pages');
  const sharedGrid = grid && grid.contains(options.translationEl) ? grid : null;
  let previousWidth = '';
  if (sharedGrid) {
    previousWidth = sharedGrid.style.width;
    sharedGrid.style.width = zoom * 100 + '%';
  }
  source.attach(options.sourceEl, sharedGrid ? 1 : zoom);
  target.attach(options.translationEl, sharedGrid ? 1 : zoom);
  const reading = pageText(layout.passages, options.onSelect && ((passage, trigger) => {
    if (signal.aborted) return;
    document.getSelection()?.removeAllRanges();
    const { id, text, label } = passage;
    options.onSelect?.({ id, text, label, side: 'source', page: options.page,
      sourceQuote: text, sourceText: text, sourceOffset: 0, context: text, rect: trigger.getBoundingClientRect(),
      segments: [{ id, ...pairSelection(passage, text, 'original', 0), ranges: [], offset: 0 }], trigger });
  }));
  options.sourceEl.append(reading.root);
  const regions = pdfRegionPicker(source, raster, nativeLayer.textDivs, options.page,
    { x: 0, y: 0, width: pageWidth, height: pageHeight }, signal, options.onRegion,
    area => figureAtRegion(area, layout.passages), options.canContinueRegion);
  function sizeSheets(): void {
    if (sharedGrid) sharedGrid.style.width = (reading.root.hidden ? zoom * 100 : 100) + '%';
    else for (const sheet of [source, target]) sheet.outer.style.width = zoom * 100 + '%';
    source.resize(); target.resize();
    repaint(false);
  }
  const resize = new ResizeObserver(() => {
    source.resize(); target.resize();
    repaint(false);
  });
  resize.observe(source.outer);
  resize.observe(target.outer);
  raster.watchDensity(source.outer, target.outer);
  window.visualViewport?.addEventListener('resize', () => raster.schedule(), { signal });
  signal.addEventListener('abort', () => {
    resize.disconnect();
    if (sharedGrid) sharedGrid.style.width = previousWidth;
  }, { once: true });

  const blocks: ReaderBlock[] = layout.passages.map(({ id, text, label, translation }) => ({ id, text, label, translation }));
  let located: { entry: PlacedPassage; quote?: string; translated?: TranslatedLocator;
    range?: SavedSelectionRange; parts?: Map<PlacedPassage, SelectionSegment> } | undefined;
  let preview: PlacedPassage | undefined;
  const selectedEntries = new Set<PlacedPassage>();
  function setTranslations(map: Record<string, string>): void {
    if (signal.aborted) return;
    for (const record of blocks) {
      const entry = placed.get(record.id)!;
      const supplied = map[record.id]?.trim();
      const value = entry.passage.translation || (supplied && !translationQualityError(record.text, supplied) ? supplied : undefined);
      const changed = value && (entry.translated.hidden || entry.translated.textContent !== value);
      entry.passage.translation = record.translation = value;
      entry.translated.hidden = !value;
      if (changed) {
        entry.translated.textContent = value;
        fitText(entry.translated, entry.passage);
        if (entry.active) {
          const active = entry.active;
          entry.active = undefined;
          paint(entry, true, active.quote, active.translated, active.part, active.side);
          if (active.translated && located?.entry === entry && !preview) {
            revealLocated(entry, true);
          }
        }
      }
    }
    if (located?.range && !located.parts && restoreLocatedRange() && !preview) {
      revealLocated(located.entry, Boolean(located.translated));
    }
    if (!blocks.length) setTranslationState('scanned', 'This page has no selectable text. Run OCR on the PDF to translate it.');
    else if (blocks.some(b => !b.translation)) setTranslationState('pending', 'Waiting for the page translation…');
    else {
      translationStatus = undefined;
      status.hidden = true;
      options.onTranslationState?.();
    }
    annotationLayoutChanged(source.outer);
  }
  setTranslations(options.translations ?? {});
  function resolve(id: string, quote?: string): PlacedPassage | undefined {
    const direct = placed.get(id);
    const alternatives = layout.aliases?.get(id);
    if (!alternatives?.length) return direct;
    const candidates = alternatives.flatMap(key => placed.get(key) || []);
    if (quote) {
      const match = candidates.find(candidate => findQuote(candidate.runs, quote));
      if (match) return match;
    }
    return direct || candidates[0];
  }
  const previews = new WeakMap<HTMLCanvasElement, Map<string, string>>();
  function figureImage(id: string): string | null {
    const region = resolve(id)?.passage.illustration;
    const rendered = raster.original;
    if (!region || signal.aborted || rendered.width <= 1) return null;
    const cache = previews.get(rendered) ?? new Map<string, string>();
    const cached = cache.get(id);
    if (cached) return cached;
    const data = cropFigure(rendered, region, pageWidth, pageHeight);
    if (data) { cache.set(id, data); previews.set(rendered, cache); }
    return data;
  }
  function quoteRange(entry: PlacedPassage, quote?: string): Range | null {
    return findQuote(entry.runs, quote || (entry.passage.id === 'block-tables' ? 'block tables' : ''));
  }
  function sourceRect(id: string): DOMRect | null {
    if (readRegion(id) && !signal.aborted) return regions.rect(id);
    const entry = resolve(id);
    if (!entry || signal.aborted) return null;
    if (!reading.root.hidden) return reading.entries.get(entry.passage.id)?.row.getBoundingClientRect() ?? null;
    return quoteRange(entry)?.getBoundingClientRect() ?? (entry.sourceFigure ?? entry.source).getBoundingClientRect();
  }
  function paint(entry: PlacedPassage, on: boolean, quote?: string, translated?: TranslatedLocator,
    part?: SelectionSegment, side?: ReadingSide): void {
    const prior = entry.active;
    if (on === Boolean(prior) && (!on || (prior?.quote === quote &&
      prior?.translated?.text === translated?.text && prior?.translated?.offset === translated?.offset && prior?.part === part))) return;
    entry.active = on ? { quote, translated, part, side } : undefined;
    reading.entries.get(entry.passage.id)?.row.classList.toggle('is-selected', on);
    for (const marker of entry.markers) marker.remove();
    entry.markers = [];
    let sourceHasQuote = false, targetHasQuote = false;
    if (on && (part || !ambiguousQuote(entry.passage, quote, translated))) {
      const p = entry.passage;
      const original = part?.original ?? (translated ? correspondingText(p, translated.text, 'translated', translated.offset) || p.text : quote);
      const plane = side === 'source' ? source.plane : target.plane;
      const captured = part?.ranges.filter(range => plane.contains(range.commonAncestorContainer)) ?? [];
      const sourceRange = side === 'source' && captured.length ? null : side === 'source' && part?.offset !== undefined
        ? findQuote(entry.runs, original ?? '', p.text.slice(0, part.offset)) : quoteRange(entry, original);
      const sourceRanges = side === 'source' && captured.length ? captured : entry.runs.flatMap(run => {
        if (sourceRange) return clipToText(sourceRange, run.firstChild) ?? [];
        if (!original || original !== p.text || !(run.firstChild instanceof Text)) return [];
        const range = document.createRange();
        range.selectNodeContents(run.firstChild);
        return range;
      });
      entry.markers = sourceRanges.flatMap(range => paintRange(range, source, pageWidth));
      sourceHasQuote = entry.markers.length > 0;
      const counterpart = part?.translated || translated?.text ||
        (original && (correspondingText(p, original, 'original', side === 'source' ? part?.offset : undefined) || p.translation));
      const targetOffset = side === 'translation' ? part?.offset : translated?.offset;
      const targetRange = counterpart && textRange(entry.translated.firstChild, counterpart, targetOffset);
      const targetRanges = side === 'translation' && captured.length ? captured : targetRange ? [targetRange] : [];
      const markers = targetRanges.flatMap(range => paintRange(range, target, pageWidth));
      targetHasQuote = markers.length > 0;
      if (translated || side === 'translation') entry.markers.unshift(...markers);
      else entry.markers.push(...markers);
    }
    entry.source.classList.toggle('is-active', on && !sourceHasQuote && !entry.sourceFigure);
    entry.target.classList.toggle('is-active', on && !!entry.passage.translation && !targetHasQuote && !entry.targetFigure);
    entry.sourceFigure?.classList.toggle('is-active', on);
    entry.targetFigure?.classList.toggle('is-active', on);
  }
  function endPreview(): void {
    if (!preview) return;
    const part = located?.parts?.get(preview);
    if (part) paint(preview, true, part.original, undefined, part, located?.translated ? 'translation' : 'source');
    else if (preview === located?.entry) paint(preview, true, located.quote, located.translated);
    else paint(preview, false);
    preview = undefined;
  }
  function highlight(id: string, on = true, quote?: string, translated?: TranslatedLocator): void {
    if (signal.aborted || selectedEntries.size) return;
    const entry = resolve(id, quote);
    if (!entry) return;
    if (!on) {
      if (preview === entry || (preview && layout.aliases?.get(id)?.includes(preview.passage.id))) endPreview();
      return;
    }
    if (preview !== entry) endPreview();
    preview = entry;
    paint(entry, true, quote, translated);
  }
  function select(hit?: SelectionHit): void {
    for (const entry of selectedEntries) paint(entry, false);
    selectedEntries.clear();
    regions.mark();
    if (!hit || signal.aborted) return;
    endPreview();
    clearLocated();
    if (hit.regionText !== undefined) { regions.mark(hit.id); return; }
    const caret = document.getSelection()?.focusNode;
    const caretId = caret && source.outer.contains(caret) ? (caret instanceof Element ? caret : caret.parentElement)?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId : undefined;
    focus?.focus(caretId && hit.segments?.some(part => part.id === caretId) ? caretId : hit.id);
    const parts = hit.segments ?? [{ id: hit.id, original: hit.sourceQuote || hit.text,
      translated: hit.side === 'translation' ? hit.text : undefined, ranges: [], exactPair: false }];
    for (const part of parts) {
      const entry = resolve(part.id, part.original);
      if (entry) {
        paint(entry, true, part.original, undefined, part, hit.side);
        selectedEntries.add(entry);
      }
    }
  }
  function clearLocated(): void {
    if (located?.parts) for (const entry of located.parts.keys()) paint(entry, false);
    else if (located) paint(located.entry, false);
    located = undefined;
  }
  function orderedBlocks(range: SavedSelectionRange | undefined, side: ReadingSide): Passage[] {
    if (range?.order === 'reflow' && side === 'source') return layout.passages;
    const ordered = Array.from(placed.values(), item => item.passage);
    if (side === 'source') ordered.sort((a, b) => (a.indices[0] ?? Infinity) - (b.indices[0] ?? Infinity));
    return ordered;
  }
  function restoreLocatedRange(): boolean {
    if (!located?.range) return false;
    const { entry, quote, translated, range } = located;
    const ordered = orderedBlocks(range, translated ? 'translation' : 'source');
    const segments = restoreSelection(ordered, entry.passage.id, quote, translated, range);
    if (!segments) return false;
    located.parts = new Map();
    for (const part of segments) {
      const block = placed.get(part.id)!;
      located.parts.set(block, part);
      paint(block, true, part.original, undefined, part, translated ? 'translation' : 'source');
    }
    return true;
  }
  function revealLocated(entry: PlacedPassage, preferTranslation: boolean): void {
    const visible = (node: HTMLElement | undefined): node is HTMLElement => Boolean(node?.getClientRects().length);
    const preferred = preferTranslation ? target.plane : source.plane;
    const mark = entry.markers.find(node => preferred.contains(node) && visible(node)) ?? entry.markers.find(visible);
    const anchors = preferTranslation ? [entry.targetFigure, entry.target, entry.sourceFigure, entry.source]
      : [entry.sourceFigure, entry.source, entry.targetFigure, entry.target];
    (mark ?? anchors.find(visible))?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }

  function locate(id: string, quote?: string, translated?: TranslatedLocator, range?: SavedSelectionRange): boolean {
    if (!signal.aborted && readRegion(id)) {
      select(); endPreview(); clearLocated();
      regions.mark(id, true);
      return true;
    }
    const entry = resolve(id, quote);
    if (!entry || signal.aborted) return false;
    select();
    endPreview();
    clearLocated();
    focus?.focus(entry.passage.id);
    located = {entry, quote, translated, range};
    if (!restoreLocatedRange()) {
      paint(entry, true, quote, translated);
      if (ambiguousQuote(entry.passage, quote, translated)) options.onAmbiguousQuote?.();
    }
    revealLocated(entry, Boolean(translated));
    return true;
  }
  if (options.onSelect) {
    for (const [side, sheet] of [['source', source], ['translation', target]] as const) {
      const textNodes = (id: string) => {
        const entry = placed.get(id)!;
        return side === 'source' ? entry.runs : entry.translated.hidden ? [] : [entry.translated];
      };
      listenForSelections({ root: sheet.outer, side, page: options.page, passages: byId, textNodes, figureImage, signal, deliver: options.onSelect });
    }
    const textNodes = (id: string) => {
      const entry = reading.entries.get(id);
      return entry ? [entry.text] : [];
    };
    listenForSelections({ root: reading.root, side: 'source', page: options.page, passages: byId, textNodes,
      figureImage, signal, deliver: options.onSelect, reflow: true });
  }
  function repaint(refit: boolean): void {
    for (const entry of placed.values()) {
      if ((refit || !entry.translated.style.fontSize) && !entry.translated.hidden) fitText(entry.translated, entry.passage);
      if (!entry.active) continue;
      const active = entry.active;
      entry.active = undefined;
      paint(entry, true, active.quote, active.translated, active.part, active.side);
    }
    raster.schedule();
    annotationLayoutChanged(source.outer);
  }
  focus = new PdfFocus(layout, placed, source, target, options.focusMode ?? 'page', options.focusId,
    (id, label) => options.onFocus?.(id, label), repaint, signal);
  function setTextView(enabled: boolean): void {
    if (signal.aborted || enabled === !reading.root.hidden || (enabled && !reading.entries.size)) return;
    const scroller = options.sourceEl.closest<HTMLElement>('#paperScroll');
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const readingPosition = scroller && scroller.scrollTop > 12 && [...reading.entries].find(([, { row }]) =>
      row.getBoundingClientRect().bottom > top + 12);
    const active = selectedEntries.values().next().value ?? located?.entry;
    const id = active?.passage.id ?? (readingPosition ? readingPosition[0] : undefined);
    reading.root.hidden = !enabled;
    source.outer.hidden = enabled;
    sizeSheets();
    if (enabled && scroller) { scroller.scrollLeft = 0; scroller.scrollTop = 0; }
    if (enabled && id) reading.entries.get(id)?.row.scrollIntoView({ block: 'start', inline: 'nearest' });
    else if (!enabled) {
      const entry = id ? placed.get(id) : undefined;
      if (entry) revealLocated(entry, false);
    }
  }
  const paperScroll = options.sourceEl.closest<HTMLElement>('#paperScroll');
  const innerTranslation = () => options.translationEl.scrollHeight > options.translationEl.clientHeight + 1;
  let translationScrolled = false;
  const listen = { signal, passive: true };
  paperScroll?.addEventListener('scroll', () => { translationScrolled = false; }, listen);
  options.translationEl.addEventListener('scroll', () => { translationScrolled = true; }, listen);
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const readingEdge = (pane: HTMLElement) => pane.getBoundingClientRect().top + pane.clientTop + 16;
  const titleKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  function outlinePassage(y: number, title?: string): Passage | undefined {
    let best: Passage | undefined, nearest = Infinity;
    const key = title && titleKey(title);
    for (const passage of layout.passages) {
      if (!reading.entries.has(passage.id)) continue;
      const match = key && titleKey(passage.text) === key;
      // A PDF bookmark often points into the whitespace immediately above a printed heading.
      const distance = Math.abs(y - passage.box.y) - (passage.role === 'heading' ? 12 : 0) - (match ? pageHeight : 0);
      if (distance < nearest) { best = passage; nearest = distance; }
    }
    return best;
  }
  function goToOutline(top: number, title?: string): void {
    if (!paperScroll || signal.aborted || !Number.isFinite(top)) return;
    top = clamp(top);
    const y = top * pageHeight, passage = outlinePassage(y, title);
    if (passage) focus?.focus(passage.id);
    const position = (pane: HTMLElement, rect: DOMRect, offset: number) => {
      pane.scrollTop = top === 0 ? 0 : pane.scrollTop + rect.top + rect.height * offset - readingEdge(pane);
    };
    if (!reading.root.hidden && reading.root.offsetWidth && passage) {
      const row = reading.entries.get(passage.id)!.row;
      position(paperScroll, row.getBoundingClientRect(), clamp((y - passage.box.y) / Math.max(1, passage.box.height)));
      return;
    }
    const originalVisible = source.outer.offsetWidth > 0;
    if (originalVisible) position(paperScroll, source.plane.getBoundingClientRect(), top);
    if (target.outer.offsetWidth && (!originalVisible || innerTranslation())) {
      const pane = innerTranslation() ? options.translationEl : paperScroll;
      if (target.outer.dataset.focus === 'passage') pane.scrollTop = 0;
      else position(pane, target.plane.getBoundingClientRect(), top);
    }
  }
  function outlineTop(): number {
    if (!paperScroll || signal.aborted) return 0;
    const positionIn = (rect: DOMRect, edge: number) => rect.height ? clamp((edge - rect.top) / rect.height) : 0;
    if (!reading.root.hidden && reading.root.offsetWidth) {
      const edge = readingEdge(paperScroll);
      let top = 0;
      for (const [id, { row }] of reading.entries) {
        const rect = row.getBoundingClientRect(), box = byId.get(id)!.box;
        top = (box.y + box.height * positionIn(rect, edge)) / pageHeight;
        if (rect.bottom >= edge) break;
      }
      return clamp(top);
    }
    const translated = target.outer.offsetWidth > 0 && (!source.outer.offsetWidth || (translationScrolled && innerTranslation()));
    const edge = readingEdge(translated && innerTranslation() ? options.translationEl : paperScroll);
    if (translated && target.outer.dataset.focus === 'passage') {
      const entry = placed.get(target.outer.dataset.activeBlock ?? '');
      if (entry) {
        const part = positionIn(entry.translated.getBoundingClientRect(), edge), box = entry.passage.box;
        return clamp((box.y + box.height * part) / pageHeight);
      }
    }
    return positionIn((translated ? target : source).plane.getBoundingClientRect(), edge);
  }
  const view: PdfPageView = { blocks, setTranslations, setTranslationState, figureImage, highlight, select, locate, sourceRect, setTextView,
    goToOutline, outlineTop,
    beginRegion: attach => regions.begin(attach), cancelRegion: () => regions.end(), reopenRegion: (id, receive) => regions.reopen(id, receive),
    canReadText: reading.entries.size > 0,
    get translationStatus() { return translationStatus; },
    setZoom(value) {
      if (signal.aborted || !Number.isFinite(value) || value <= 0) return;
      zoom = value;
      sizeSheets();
    },
    setFocusMode: mode => { if (!signal.aborted) focus.setMode(mode); }, dispose: () => controller.abort() };
  return withAnnotationSurface(view, { original: source.outer, blocks: orderedBlocks, signal,
    revealPassage(id, quote, offset) {
      focus?.focus(id);
      const node = placed.get(id)?.translated;
      if (!quote || !node?.classList.contains('needs-scroll')) return;
      const line = textRange(node.firstChild, quote, offset)?.getClientRects()[0], box = node.getBoundingClientRect();
      if (line && box.height && (line.top < box.top || line.bottom > box.bottom)) {
        node.scrollTop += (line.top - box.top) * node.offsetHeight / box.height;
      }
    },
    panes: [
    { host: source.outer, side: 'source', ranges(id, quote, offset) {
      const entry = resolve(id, quote);
      if (!entry) return [];
      const prefix = offset === undefined ? undefined : entry.passage.text.slice(0, offset);
      const range = findQuote(entry.runs, quote, prefix);
      return range ? entry.runs.flatMap(run => clipToText(range, run.firstChild) ?? []) : [];
    } },
    { host: reading.root, side: 'source', ranges(id, quote, offset) {
      const range = textRange(reading.entries.get(id)?.text.firstChild, quote, offset);
      return range ? [range] : [];
    } },
    { host: target.outer, side: 'translation', ranges(id, quote, offset) {
      const range = textRange(placed.get(id)?.translated.firstChild, quote, offset);
      return range ? [range] : [];
    } }
  ] });
}

async function renderPdfPage(pdf: PDFDocumentProxy, options: PdfRenderOptions, digest: string,
  controller: AbortController): Promise<PdfPageView> {
  const { signal } = controller;
  const page = await pdf.getPage(options.page);
  signal.throwIfAborted();
  const viewport = page.getViewport({ scale: 1 });
  const [content, imported, operators, tagged] = await Promise.all([page.getTextContent(),
    digest === sampleDigest ? sampleTranslations(options.page) : Promise.resolve({}),
    digest === sampleDigest ? undefined : page.getOperatorList(),
    // Damaged optional structure tags can still accompany an otherwise readable page.
    digest === sampleDigest ? undefined : taggedArtwork(page).catch(() => undefined)]);
  signal.throwIfAborted();
  const layout = extractLayout(content, viewport, options.page, digest, imported, operators && pageGraphics(operators, viewport), tagged);
  const raster = new PageRaster(page, layout.passages.map(p => p.box), viewport.width, viewport.height, signal);
  const source = makeSheet('source', options.page, layout.window, viewport.width, viewport.height);
  const target = makeSheet('translation', options.page, layout.window, viewport.width, viewport.height);
  const nativeContainer = element('div', 'pdf-native-text pdf-text-preview');
  const nativeLayer = new TextLayer({ textContentSource: content, container: nativeContainer, viewport });
  nativeContainer.style.setProperty('--total-scale-factor', String(viewport.userUnit));
  const cancel = () => nativeLayer.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await nativeLayer.render();
    signal.throwIfAborted();
    const view = mount({ source, target, options, layout, raster, nativeLayer, nativeContainer, controller,
      pageWidth: viewport.width, pageHeight: viewport.height });
    options.onMounted?.(view);
    await raster.refresh();
    signal.throwIfAborted();
    nativeContainer.classList.remove('pdf-text-preview');
    return view;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  GlobalWorkerOptions.workerSrc = vendor + 'pdf.worker.mjs';
  GlobalWorkerOptions.rendererSrc = vendor + 'pdf.renderer.mjs';
  // PDF.js transfers its buffer to its worker. Keep the caller's imported bytes intact.
  const data = Uint8Array.from(bytes);
  const digest = data.byteLength === 1_459_631 && globalThis.crypto?.subtle
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('')
    : '';
  const task = getDocument({ data, cMapUrl: vendor + 'cmaps/', cMapPacked: true, wasmUrl: vendor + 'wasm/',
    standardFontDataUrl: vendor + 'standard_fonts/', iccUrl: vendor + 'iccs/' });
  let pdf: PDFDocumentProxy;
  try { pdf = await task.promise; }
  catch (error) { await task.destroy(); throw error; }
  let current: AbortController | undefined;
  let closed = false;
  const lifetime = new AbortController();
  let bookmarks: Promise<PdfOutlineEntry[]> | undefined;
  return { pages: pdf.numPages,
    outline() {
      if (closed) return Promise.reject(new Error('This document is closed.'));
      return bookmarks ??= readPdfOutline(pdf, lifetime.signal).catch(error => { bookmarks = undefined; throw error; });
    },
    outlinePages(onProgress, signal) {
      return readOutlinePages(pdf, onProgress, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
    },
    async cropRegion(pageNumber, anchor) {
      const region = readRegion(anchor);
      if (!region) throw new Error('Invalid screenshot area.');
      const page = await pdf.getPage(pageNumber), {width, height} = page.getViewport({scale: 1});
      return cropPdfPage(page, regionBox(region, {x: 0, y: 0, width, height}));
    },
    async textContent(page) { return (await pdf.getPage(page)).getTextContent(); },
    async render(options) {
      if (closed) throw new Error('This document is closed.');
      if (!Number.isInteger(options.page) || options.page < 1 || options.page > pdf.numPages) throw new RangeError('Page number is out of range.');
      current?.abort();
      for (const host of [options.sourceEl, options.translationEl]) hostOwners.get(host)?.abort();
      const controller = new AbortController();
      current = controller;
      for (const host of [options.sourceEl, options.translationEl]) hostOwners.set(host, controller);
      try { return await renderPdfPage(pdf, options, digest, controller); }
      catch (error) { controller.signal.throwIfAborted(); controller.abort(); throw error; }
    },
    async destroy() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      current?.abort();
      await task.destroy();
    }
  };
}
