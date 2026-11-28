import type { DocumentInfo, PageView, ReaderBlock, ReadingSide, RegionAction, SelectionHit, SelectionSegment } from '../shared/types.js';
import type { SavedSelectionRange, TranslatedLocator } from '../shared/source-link.js';
import { DEFAULT_TARGET_LANGUAGE, targetLanguageBcp47 } from '../shared/languages.js';
import { articleUrl, type ArticleBlock } from '../shared/web-article.js';
import { openStaxLocation } from '../shared/openstax.js';
import { articleContent, rangeInArticle, selectedArticleText, unchangedArticleBlock } from './article-content.js';
import { articleRegionPicker } from './article-region-picker.js';
import { message, readerLabel as label, sourceUrl, toast } from './ui.js';
import { sectionFooter } from './book-navigation.js';
import { pairSelection } from './pdf/alignment.js';
import { ambiguousQuote, restoreSelection } from './saved-selection.js';
import { annotationLayoutChanged, withAnnotationSurface } from './annotation-layer.js';
import { researchText } from './research/labels.js';

interface ArticleOptions {
  doc: DocumentInfo;
  sourceEl: HTMLElement;
  translationEl: HTMLElement;
  translations?: Record<string, string>;
  targetLanguage?: string;
  zoom?: number;
  onSelect: (hit: SelectionHit) => void;
  onRegion?: RegionAction;
  canContinueRegion?: (anchor: string) => boolean;
  onAmbiguousQuote?: () => void;
  onNavigateAnchor?: (anchor: string) => void;
  onBookSection?: (page: number, fragment?: string) => Promise<void>;
}
interface ParagraphPair {
  block: ReaderBlock;
  source: HTMLElement;
  translation: HTMLElement;
}

export function renderArticle({ doc, sourceEl, translationEl, translations = {}, targetLanguage = DEFAULT_TARGET_LANGUAGE, zoom = 1, onSelect, onRegion,
  canContinueRegion, onAmbiguousQuote, onNavigateAnchor, onBookSection }: ArticleOptions): PageView {
  const owner = sourceEl.ownerDocument;
  const paneWindow = owner.defaultView!;
  const events = new AbortController();
  const pairs = new Map<string, ParagraphPair>();
  const anchors = new Map<string, string>();
  for (const [id, block] of Object.entries(doc.articleLayout || {}))
    for (const fragment of block.ids || []) if (!anchors.has(fragment)) anchors.set(fragment, id);
  const originalUrl = articleUrl(doc.url);
  const page = doc.sectionPage ?? 1, section = doc.book?.sections[page - 1];
  const bookPages = new Map(doc.book?.sections.map((entry, index) => [entry.slug, index + 1] as const));
  let selectionFrame = 0;
  let sizingFrame = 0;
  let activeId = '';
  let selectionHit: SelectionHit | undefined;
  let location: { id: string; quote?: string; target?: TranslatedLocator; range?: SavedSelectionRange; parts?: SelectionSegment[] } | undefined;

  function makeSheet(container: HTMLElement, side: ReadingSide): HTMLElement {
    const sheet = owner.createElement('article');
    sheet.className = 'web-reading-sheet';
    sheet.dataset.side = side;
    sheet.style.setProperty('--article-zoom', String(Number.isFinite(zoom) && zoom > 0 ? zoom : 1));
    sheet.setAttribute('aria-label', side === 'source' ? label('Original article', '原文文章') : label('Article translation', '文章译文'));
    if (side === 'translation') {
      const bcp47 = targetLanguageBcp47(targetLanguage);
      if (bcp47) sheet.lang = bcp47;
      sheet.dir = 'auto';
    }
    if (originalUrl) {
      const link = owner.createElement('a');
      link.className = 'web-reading-source'; link.href = originalUrl.href;
      link.rel = 'noopener noreferrer'; link.target = '_blank';
      link.textContent = doc.book && openStaxLocation(doc.url) ? label('Access for free at OpenStax', '在 OpenStax 免费阅读原文') : label('Original webpage', '原网页');
      sheet.append(link);
    }
    container.replaceChildren(sheet);
    return sheet;
  }
  const original = makeSheet(sourceEl, 'source');
  const translated = makeSheet(translationEl, 'translation');

  function addRow(sheet: HTMLElement, id: string, text: string, format?: ArticleBlock): HTMLElement {
    const row = owner.createElement('div');
    row.className = 'web-reading-row';
    row.dataset.anchor = id;
    if (format) row.dataset.kind = format.kind;
    row.append(articleContent(owner, format, text, {
      docId: doc.id, anchor: id, sourceUrl: doc.url, bookPage: doc.sectionPage,
      onLink(link, address) {
        const fragment = address.hash.slice(1); address.hash = '';
        let key = fragment; try { key = decodeURIComponent(fragment); } catch { /* Use the literal anchor. */ }
        const baseHref = originalUrl ? originalUrl.origin + originalUrl.pathname + originalUrl.search : '';
        const bookLink = doc.book && format?.kind !== 'byline' ? openStaxLocation(address.href) : undefined;
        const destination = bookLink?.book === doc.book?.slug && bookLink?.section ? bookPages.get(bookLink.section)
          : address.href === baseHref && key && doc.book?.anchorPages && Object.hasOwn(doc.book.anchorPages, key) ? doc.book.anchorPages[key] : undefined;
        const target = (address.href === baseHref || destination === page) && anchors.get(key);
        if (target) {
          link.href = sourceUrl(doc.id, page, target);
          link.addEventListener('click', event => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            if (onNavigateAnchor) onNavigateAnchor(target); else view.locate(target);
          }, { signal: events.signal });
        } else if (destination && onBookSection) {
          link.href = sourceUrl(doc.id, destination, key ? 'publisher:' + key : '');
          link.addEventListener('click', event => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            void onBookSection(destination, key).catch(error => toast(message(error)));
          }, { signal: events.signal });
        } else {
          if (fragment) address.hash = fragment;
          link.href = address.href; link.rel = 'noopener noreferrer'; link.target = '_blank';
        }
      }
    }));
    sheet.append(row);
    return row;
  }

  function sizeRows(): void {
    sizingFrame = 0;
    const heights = Array.from(pairs.values(), pair => ({
      pair, height: Math.max(pair.source.firstElementChild!.getBoundingClientRect().height,
                            pair.translation.firstElementChild!.getBoundingClientRect().height)
    }));
    for (const { pair, height } of heights) {
      pair.source.style.minHeight = height + 'px';
      pair.translation.style.minHeight = height + 'px';
    }
    annotationLayoutChanged(original);
    regions?.refresh();
  }
  const sizes = new ResizeObserver(() => {
    if (!sizingFrame) sizingFrame = paneWindow.requestAnimationFrame(sizeRows);
  });

  let pictures: ParagraphPair[] = [];
  let captionIds: string[] = [];
  let sectionTitle = '';
  for (const [index, paragraph] of (doc.paragraphs || []).entries()) {
    if (!paragraph.trim()) continue;
    const id = 'p-' + (index + 1);
    const format = doc.articleLayout?.[id];
    if (format && /^h[1-6]$/.test(format.kind) && paragraph !== doc.title) sectionTitle = paragraph.slice(0, 160);
    const place = section && section.title !== sectionTitle ? [section.title, sectionTitle].filter(Boolean).join(' · ') : sectionTitle;
    const block: ReaderBlock = { id, text: paragraph, label: place || label('Paragraph ' + (index + 1), '第 ' + (index + 1) + ' 段') };
    const keep = unchangedArticleBlock(format?.kind);
    const pair = { block, source: addRow(original, id, paragraph, format),
      translation: addRow(translated, id, keep ? paragraph : '', keep ? format : format && {kind:format.kind}) };
    if (format?.kind === 'caption' && pictures.length) {
      captionIds.push(id);
      for (const side of ['source', 'translation'] as const) {
        const caption = pair[side].firstElementChild!;
        caption.id = 'article-' + side + '-' + id;
        for (const picture of pictures) picture[side].querySelector('img')?.setAttribute('aria-describedby',
          captionIds.map(key => 'article-' + side + '-' + key).join(' '));
      }
    } else if (format?.kind === 'image') {
      if (captionIds.length) { pictures=[]; captionIds=[]; }
      pictures.push(pair);
    } else { pictures=[]; captionIds=[]; }
    pairs.set(id, pair);
    sizes.observe(pair.source.firstElementChild!);
    sizes.observe(pair.translation.firstElementChild!);
  }
  if (!pairs.size) {
    for (const sheet of [original, translated]) {
      const message = owner.createElement('p');
      message.className = 'web-reading-empty';
      message.textContent = label('No article text was captured.', '未能提取文章正文。');
      sheet.append(message);
    }
  }
  if (doc.book && onBookSection) {
    for (const sheet of [original, translated]) sectionFooter(sheet, doc, page, onBookSection);
  }

  let pending = new Set<string>();
  function setTranslations(values: Record<string, string>, overwrite = false): void {
    for (const [id, { block, translation }] of pairs) {
      if (unchangedArticleBlock(doc.articleLayout?.[id]?.kind)) { block.translation = block.text; continue; }
      const supplied = values[id]?.trim() || undefined;
      if (supplied) pending.delete(id);
      block.translation = overwrite ? (supplied ?? block.translation) : (block.translation || supplied);
      const busy = !block.translation && pending.has(id);
      translation.classList.toggle('is-untranslated', !block.translation);
      translation.classList.toggle('is-translating', busy);
      const rendered = block.translation || (busy ? researchText.translatingRow() : label('Awaiting translation', '待翻译'));
      if (translation.firstElementChild!.textContent !== rendered) translation.firstElementChild!.textContent = rendered;
    }
    sizeRows();
    if (selectionHit) select(selectionHit);
    else if (location?.range) paintLocation();
  }

  function near(node: Node | null, sheet: HTMLElement): HTMLElement | undefined {
    const el = node instanceof Element ? node : node?.parentElement;
    const row = el?.closest<HTMLElement>('.web-reading-row');
    return row && sheet.contains(row) ? row : undefined;
  }

  function toggle(id: string, flag: string, value: boolean): void {
    const pair = pairs.get(id);
    pair?.source.classList.toggle(flag, value);
    pair?.translation.classList.toggle(flag, value);
  }

  function connect(sheet: HTMLElement, side: ReadingSide): void {
    let last = '';
    const options = { signal: events.signal };
    function hover(id: string): void {
      if (id === last) return;
      toggle(last, 'is-linked', false);
      last = id;
      toggle(last, 'is-linked', true);
    }
    function read(): void {
      const selection = paneWindow.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!sheet.contains(range.startContainer) || !sheet.contains(range.endContainer)) return;
      if (!selection.toString().trim()) return;
      const segments: SelectionSegment[] = [];
      const excerpts: string[] = [];
      for (const [id, pair] of pairs) {
        if (side === 'translation' && !pair.block.translation) continue;
        if (doc.articleLayout?.[id]?.kind === 'image') continue;
        const clipped = selectedArticleText(range, pair[side].firstElementChild as HTMLElement, side === 'source' ? pair.block.text : pair.block.translation || '');
        if (!clipped) continue;
        excerpts.push(clipped.text.trim());
        const aligned = pairSelection(pair.block, clipped.text, side === 'source' ? 'original' : 'translated', clipped.offset);
        segments.push({ id, ...aligned, offset: clipped.offset, ranges: [clipped.range] });
      }
      const first = segments[0];
      if (!first) return;
      const text = excerpts.join('\n\n');
      const context = segments.map(part => pairs.get(part.id)!.block.text).join('\n\n');
      const initialText = pairs.get(first.id)!.block.text;
      const index = initialText.indexOf(first.original);
      const sourceOffset = side === 'source' ? first.offset :
        index >= 0 && initialText.indexOf(first.original, index + 1) < 0 ? index : undefined;
      onSelect({ id: first.id, text, sourceText: context, context, segments,
        sourceQuote: side === 'source' ? text : segments.map(part => part.original).join('\n\n'),
        sourceOffset, translatedOffset: side === 'translation' ? first.offset : undefined,
        page, rect: segments.at(-1)!.ranges[0].getClientRects()[0] ?? range.getBoundingClientRect(), side,
        label: pairs.get(first.id)!.block.label! });
    }
    function schedule(): void {
      paneWindow.cancelAnimationFrame(selectionFrame);
      selectionFrame = paneWindow.requestAnimationFrame(read);
    }
    sheet.addEventListener('pointerover', event => hover(near(event.target as Node, sheet)?.dataset.anchor || ''), options);
    sheet.addEventListener('pointerleave', () => hover(''), options);
    sheet.addEventListener('pointerup', schedule, options);
    owner.addEventListener('keyup', event => {
      if ((event.shiftKey || event.key === 'Shift') && sheet.contains(paneWindow.getSelection()?.focusNode ?? null) &&
        !(event.target instanceof Element && event.target.closest('#card, #rail, dialog'))) schedule();
    }, options);
  }

  const pages = original.closest<HTMLElement>('.pages');
  const regions = pages && pairs.size && onRegion
    ? articleRegionPicker(doc, page, pages, original, translated, events.signal, onRegion, canContinueRegion) : undefined;
  connect(original, 'source');
  connect(translated, 'translation');
  setTranslations(translations);

  function rangeForQuote(paragraph: HTMLElement, quote: string, offset?: number): Range | null {
    const pair = pairs.get(paragraph.dataset.anchor || '');
    if (!pair) return null;
    const text = paragraph === pair.source ? pair.block.text : pair.block.translation || '';
    return rangeInArticle(paragraph.firstElementChild as HTMLElement, text, quote, offset);
  }
  function clearParts(parts?: SelectionSegment[]): void {
    for (const { id } of parts ?? []) {
      toggle(id, 'is-highlighted', false);
      toggle(id, 'has-text-selection', false);
    }
  }
  function clearLocation(): void {
    if (location) toggle(location.id, 'is-located', false);
    clearParts(location?.parts);
    location = undefined;
  }
  function select(hit?: SelectionHit): void {
    regions?.mark(hit?.regionText !== undefined ? hit.id : '');
    if (selectionHit) {
      clearParts(selectionHit.segments);
      if ('highlights' in CSS) CSS.highlights.delete('dsh-web-quote');
    }
    selectionHit = hit;
    if (!hit) return;
    clearLocation();
    toggle(activeId, 'is-highlighted', false);
    activeId = '';
    paintParts(hit.segments ?? [], hit.side);
  }
  function paintParts(parts: SelectionSegment[], side: ReadingSide): Range[] {
    const paintText = 'highlights' in CSS && typeof Highlight !== 'undefined';
    const ranges: Range[] = [];
    for (const part of parts) {
      const pair = pairs.get(part.id);
      if (!pair) continue;
      toggle(part.id, 'is-highlighted', true);
      toggle(part.id, 'has-text-selection', paintText);
      if (part.ranges.length) ranges.push(...part.ranges);
      else {
        const exact = rangeForQuote(pair[side], side === 'source' ? part.original : part.translated ?? '', part.offset);
        if (exact) ranges.push(exact);
      }
      const opposite = side === 'translation' ? rangeForQuote(pair.source, part.original)
        : rangeForQuote(pair.translation, part.translated ?? pair.block.translation ?? '');
      if (opposite) ranges.push(opposite);
    }
    if (paintText) CSS.highlights.set('dsh-web-quote', new Highlight(...ranges));
    return ranges;
  }
  function paintLocation(): Range | undefined {
    if (!location?.range) return;
    const { id, quote, target, range } = location;
    location.parts = restoreSelection(Array.from(pairs.values(), pair => pair.block), id, quote, target, range);
    if (location.parts) return paintParts(location.parts, target ? 'translation' : 'source')[0];
  }
  function highlight(id: string, on = true, quote?: string, target?: TranslatedLocator): void {
    if (selectionHit) return;
    if (on && activeId !== id) toggle(activeId, 'is-highlighted', false);
    toggle(id, 'is-highlighted', on);
    if (!on && activeId !== id) return;
    activeId = on ? id : '';
    if (!on && location?.parts) { paintParts(location.parts, location.target ? 'translation' : 'source'); return; }
    if (!('highlights' in CSS) || typeof Highlight === 'undefined') return;
    CSS.highlights.delete('dsh-web-quote');
    const marker = on ? { id, quote, target } : location;
    if (!marker?.quote) return;
    const pair = pairs.get(marker.id);
    if (!pair || ambiguousQuote(pair.block, marker.quote, marker.target)) return;
    const exact = marker.quote;
    const ranges = marker.target ? [rangeForQuote(pair.translation, marker.target.text, marker.target.offset),
      rangeForQuote(pair.source, pairSelection(pair.block, marker.target.text, 'translated').original)] :
      [rangeForQuote(pair.source, exact), rangeForQuote(pair.translation, pairSelection(pair.block, exact, 'original').translated ?? '')];
    const found = ranges.filter((r): r is Range => !!r);
    if (found.length) CSS.highlights.set('dsh-web-quote', new Highlight(...found));
  }

  function revealQuote(range: Range): void {
    const firstLine = range.getClientRects()[0];
    if (!firstLine) return;
    let scroller = range.startContainer.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight &&
      /auto|scroll|overlay/.test(paneWindow.getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
    const height = scroller ? scroller.clientHeight : paneWindow.innerHeight;
    if (firstLine.top >= top && firstLine.bottom <= top + height) return;
    const delta = firstLine.top - top - Math.max(0, (height - firstLine.height) / 2);
    if (scroller) scroller.scrollTop += delta;
    else paneWindow.scrollBy({ top: delta, behavior: 'instant' });
  }
  const view: PageView = {
    blocks: Array.from(pairs.values(), pair => pair.block), highlight, select, setTranslations,
    setPendingBlocks(ids) { pending = new Set(ids); setTranslations({}); },
    ...(regions && {
      beginRegion: (attach?: boolean) => regions.begin(attach), cancelRegion: () => regions.end(),
      reopenRegion: (id: string, receive?: RegionAction) => regions.reopen(id, receive)
    }),
    sourceRect(id) { return pairs.get(id)?.source.getBoundingClientRect() ?? regions?.rect(id) ?? null; },
    locate(id, quote, target, range) {
      if (regions?.rect(id)) {
        select();
        clearLocation();
        regions.mark(id, true);
        return true;
      }
      const pair = pairs.get(id);
      if (!pair) return false;
      select();
      clearLocation();
      location = { id, quote, target, range };
      toggle(id, 'is-located', true);
      for (const row of [pair.translation, pair.source]) row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const exact = paintLocation();
      if (exact) { revealQuote(exact); return true; }
      if (ambiguousQuote(pair.block, quote, target)) onAmbiguousQuote?.();
      else if (quote) {
        const range = target ? rangeForQuote(pair.translation, target.text, target.offset) :
          rangeForQuote(pair.source, quote) || rangeForQuote(pair.translation, quote);
        if (range) revealQuote(range);
      }
      highlight(id, true, quote, target);
      return true;
    },
    dispose() {
      events.abort();
      sizes.disconnect();
      paneWindow.cancelAnimationFrame(selectionFrame);
      paneWindow.cancelAnimationFrame(sizingFrame);
      if ('highlights' in CSS) CSS.highlights.delete('dsh-web-quote');
    }
  };
  return withAnnotationSurface(view, { original, blocks: () => view.blocks, signal: events.signal,
    panes: (['source', 'translation'] as const).map(side => ({
      side, host: side === 'source' ? original : translated,
      ranges(id: string, quote: string, offset?: number) {
        const pair = pairs.get(id);
        const range = pair && rangeForQuote(pair[side], quote, offset);
        return range ? [range] : [];
      }
    })) });
}
