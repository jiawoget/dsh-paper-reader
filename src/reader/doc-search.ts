import type { DocumentInfo, PageView } from '../shared/types.js';
import { buildSearchSources, extractTranslatedBlocks, searchDocument, type SearchBlock, type SearchResult } from './doc-search-index.js';
import { readPaper, type PaperPage } from './paper-evidence.js';
import { findQuotes } from './pdf/selection.js';
import type { PdfDocument } from './pdf-view.js';
import { api, byId, el, icon, readerLabel as label, type Glyph } from './ui.js';

interface DocSearchHost {
  doc: () => DocumentInfo; page: () => number; targetLanguage: () => string; view: () => PageView | undefined;
  isBilingual: () => boolean; showSource: () => void; showTranslation: () => void; navigateToPage: (page: number) => Promise<void>;
  pushHistory: () => void; focusBlock: (id: string) => void;
}
const EMPTY: SearchResult = { query: '', matches: [], groups: [] };

function textNodes(root: Element): Text[] {
  const nodes: Text[] = [], walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n instanceof Text && n.data) nodes.push(n);
  return nodes;
}
function scanBlocks(elements: Iterable<HTMLElement>, attr: 'anchor' | 'blockId', query: string, out: Range[]): Map<string, Range[][]> {
  const byBlock = new Map<string, Range[][]>();
  for (const node of elements) {
    const id = node.dataset[attr], hits = id ? findQuotes(textNodes(node), query) : [];
    if (!id || !hits.length) continue;
    byBlock.set(id, hits);
    for (const hit of hits) out.push(...hit);
  }
  return byBlock;
}
function control(css: string, glyph: Glyph, onClick: () => void, caption?: string): HTMLButtonElement {
  const btn = el('button', 'icon-btn ' + css); btn.type = 'button';
  if (caption) btn.ariaLabel = btn.title = caption;
  btn.append(icon(glyph, 15)); btn.addEventListener('click', onClick);
  return btn;
}

export class DocSearch {
  private readonly workspace = document.querySelector<HTMLElement>('.workspace')!;
  private readonly root = el('section', 'doc-search');
  private readonly input = el('input', 'doc-search-input');
  private readonly countEl = el('span', 'doc-search-count');
  private readonly resultsEl = el('div', 'doc-search-results');
  private readonly listBtn: HTMLButtonElement; private readonly prevBtn: HTMLButtonElement; private readonly nextBtn: HTMLButtonElement;
  private readonly translations = new Map<string, Map<number, SearchBlock[]>>();
  private readonly bookPages = new Map<string, Promise<PaperPage[]>>();
  private doc: DocumentInfo; private pdf?: PdfDocument; private result: SearchResult = EMPTY;
  private active = -1; private searching = false; private listOpen = false; private autoExpanded = false; private userToggledList = false; private pendingReveal = false;
  private searchEpoch = 0; private jumpEpoch = 0; private debounceTimer?: number; private repaintFrame = 0; private returnFocus?: HTMLElement; private fallbackLayer?: HTMLElement;

  constructor(private readonly host: DocSearchHost) {
    this.doc = host.doc();
    this.root.id = 'docSearch'; this.root.setAttribute('role', 'search');
    this.root.ariaLabel = label('Document search', '文档搜索'); this.root.hidden = true;
    this.input.type = 'search'; this.input.autocomplete = 'off'; this.input.spellcheck = false;
    this.input.ariaLabel = this.input.placeholder = label('Find in document…', '搜索本文内容…');
    this.countEl.setAttribute('aria-live', 'polite'); this.countEl.setAttribute('aria-atomic', 'true');
    this.resultsEl.id = 'docSearchResults'; this.resultsEl.hidden = true;
    this.listBtn = control('doc-search-list-btn', 'contents', () => { this.listOpen = !this.isListExpanded(); this.userToggledList = true; this.renderState(); });
    this.listBtn.setAttribute('aria-controls', this.resultsEl.id);
    this.prevBtn = control('doc-search-prev', 'up', () => { void this.flushAndStep(-1); }, label('Previous match', '上一个匹配'));
    this.nextBtn = control('doc-search-next', 'down', () => { void this.flushAndStep(1); }, label('Next match', '下一个匹配'));
    const closeBtn = control('doc-search-close', 'close', () => this.close(true), label('Close search', '关闭搜索'));
    const bar = el('div', 'doc-search-bar');
    bar.append(this.input, this.countEl, this.listBtn, this.prevBtn, this.nextBtn, closeBtn);
    this.root.append(bar, this.resultsEl); this.workspace.append(this.root);
    this.input.addEventListener('input', () => {
      clearTimeout(this.debounceTimer); this.debounceTimer = undefined; this.userToggledList = false; this.searchEpoch++;
      if (!this.input.value.trim()) { this.clearState(); return; }
      this.debounceTimer = window.setTimeout(() => { this.debounceTimer = undefined; void this.runSearch(true); }, 120);
    });
    this.root.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); return; }
      if (event.key === 'Enter' && event.target === this.input) { event.preventDefault(); void this.flushAndStep(event.shiftKey ? -1 : 1); }
    });
    const sync = () => this.syncGeometry(), ro = new ResizeObserver(sync);
    ro.observe(this.workspace); ro.observe(byId('paperScroll')); window.addEventListener('resize', sync);
    this.renderState();
  }

  get isOpen(): boolean { return !this.root.hidden; }
  open(): void {
    const wasHidden = this.root.hidden;
    if (wasHidden) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      this.root.hidden = false; this.syncGeometry();
      const sel = window.getSelection(), node = sel && !sel.isCollapsed ? sel.anchorNode : null;
      const picked = node && (byId('original').contains(node) || byId('translated').contains(node)) ? sel!.toString().trim() : '';
      if (picked && picked.length <= 80 && !/[\r\n]/.test(picked)) this.input.value = picked;
    }
    this.input.focus({ preventScroll: true }); this.input.select();
    if (wasHidden && this.input.value.trim()) void this.runSearch(true);
  }
  close(restore = true): void {
    if (this.root.hidden) return;
    clearTimeout(this.debounceTimer); this.debounceTimer = undefined;
    this.searchEpoch++; this.jumpEpoch++; this.pendingReveal = false; this.root.hidden = true; this.clearHighlights();
    const target = this.returnFocus; this.returnFocus = undefined;
    if (restore) (target?.isConnected && !target.closest('[hidden]') ? target : byId('paperScroll')).focus({ preventScroll: true });
  }
  reset(): void { this.close(false); this.listOpen = this.userToggledList = false; this.clearState(); }
  document(doc: DocumentInfo, pdf?: PdfDocument): void {
    const sameBook = Boolean(doc.book && doc.id === this.doc.id);
    this.doc = doc; this.pdf = pdf;
    if (sameBook) return;
    this.bookPages.clear(); this.jumpEpoch++; this.clearState();
    if (!this.root.hidden && this.input.value.trim()) void this.runSearch(true);
  }
  recordTranslations(docId: string, page: number, map: Record<string, string>): void {
    const view = this.host.view();
    const blocks = docId === this.doc.id && page === this.host.page() && view?.blocks.length ? extractTranslatedBlocks(view.blocks)
      : Object.entries(map).map(([id, text]) => ({ id, text: text.trim() })).filter(b => b.text);
    if (!blocks.length) return;
    this.cacheFor(docId).set(page, blocks);
    if (!this.root.hidden && this.input.value.trim() && docId === this.doc.id) void this.runSearch(false, true);
  }
  syncPage(): void {
    const view = this.host.view();
    if (view?.blocks.length) {
      const translated = extractTranslatedBlocks(view.blocks), cache = this.cacheFor(this.doc.id);
      if (translated.length) cache.set(this.host.page(), translated);
      else if (!this.pdf) cache.delete(this.host.page());
    }
    if (!this.root.hidden && this.input.value.trim()) this.paintPage();
  }
  paintPage(): Range | undefined {
    const query = this.result.query;
    if (this.root.hidden || !query) { this.clearHighlights(); return undefined; }
    const allRanges: Range[] = [], orig = byId('original'), trans = byId('translated');
    let sourceHits: Range[][] = [], sourceByBlock = new Map<string, Range[][]>(), transByBlock = new Map<string, Range[][]>();
    const readText = orig.querySelector<HTMLElement>('.pdf-reading-text:not([hidden])'), native = !readText ? orig.querySelector<HTMLElement>('.pdf-native-text') : null;
    if (readText || native) {
      const nodes = readText ? [...readText.querySelectorAll('.reading-passage > :is(p, h2)')].flatMap(textNodes)
        : [...native!.querySelectorAll('[role="presentation"]')].map(s => s.firstChild).filter((n): n is Text => n instanceof Text && Boolean(n.data));
      sourceHits = findQuotes(nodes, query); for (const hit of sourceHits) allRanges.push(...hit);
    } else {
      sourceByBlock = scanBlocks(orig.querySelectorAll<HTMLElement>('.web-reading-sheet .web-reading-row[data-anchor]:not([data-kind="image"])'), 'anchor', query, allRanges);
      for (const hits of sourceByBlock.values()) sourceHits.push(...hits);
    }
    if (this.host.isBilingual() || trans.offsetWidth > 0) {
      transByBlock = trans.querySelector('.pdf-sheet')
        ? scanBlocks(trans.querySelectorAll<HTMLElement>('.pdf-translated-text[data-block-id]:not([hidden])'), 'blockId', query, allRanges)
        : scanBlocks(trans.querySelectorAll<HTMLElement>('.web-reading-sheet .web-reading-row[data-anchor]:not(.is-untranslated):not([data-kind="image"])'), 'anchor', query, allRanges);
    }
    const active = this.active >= 0 ? this.result.matches[this.active] : undefined;
    let currentRanges: Range[] | undefined;
    if (active && active.page === this.host.page()) {
      const hits = active.blockId ? (active.side === 'source' ? sourceByBlock : transByBlock).get(active.blockId) : undefined;
      currentRanges = hits ? (hits[active.occurrence] ?? hits[0]) : active.side === 'source' && sourceHits.length ? sourceHits[Math.min(active.occurrence, sourceHits.length - 1)] : undefined;
    }
    this.applyHighlights(allRanges, currentRanges ?? []);
    return currentRanges?.[0];
  }

  private clearState(): void {
    this.searchEpoch++; this.result = EMPTY; this.active = -1;
    this.searching = this.autoExpanded = this.pendingReveal = false; this.clearHighlights(); this.renderState();
  }
  private cacheFor(docId: string): Map<number, SearchBlock[]> {
    const key = docId + ':' + this.host.targetLanguage();
    return this.translations.get(key) ?? this.translations.set(key, new Map()).get(key)!;
  }
  private async flushAndStep(delta: 1 | -1): Promise<void> {
    const query = this.input.value.trim();
    if (!query) return;
    if (this.debounceTimer || this.result.query !== query || this.searching) {
      clearTimeout(this.debounceTimer); this.debounceTimer = undefined; await this.runSearch(false);
      if (this.root.hidden || this.input.value.trim() !== query || this.result.query !== query) return;
    }
    const total = this.result.matches.length;
    if (!total) return;
    const onPage = this.active < 0 ? this.result.matches.findIndex(m => m.page === this.host.page()) : -1;
    await this.jumpTo(this.active < 0 ? (onPage >= 0 ? onPage : delta > 0 ? 0 : total - 1) : (this.active + delta + total) % total);
  }
  private loadBookPages(docId: string): Promise<PaperPage[]> {
    const cached = this.bookPages.get(docId);
    if (cached) return cached;
    const job = api('book.pages', { docId }).then(res => res.pages).catch(error => { this.bookPages.delete(docId); throw error; });
    this.bookPages.set(docId, job);
    return job;
  }
  private async runSearch(autoSelect: boolean, preserveActive = false): Promise<void> {
    const query = this.input.value.trim(), epoch = ++this.searchEpoch;
    if (!query) return;
    const translated = this.host.view()?.blocks ? extractTranslatedBlocks(this.host.view()!.blocks) : [];
    if (translated.length) this.cacheFor(this.doc.id).set(this.host.page(), translated);
    const prev = preserveActive && this.active >= 0 ? this.result.matches[this.active] : undefined;
    let pdfPages, bookPages;
    if (this.pdf || this.doc.book) {
      this.searching = true; this.renderState();
      try {
        if (this.pdf) pdfPages = await readPaper(this.doc, this.pdf);
        else bookPages = await this.loadBookPages(this.doc.id);
      } catch { if (epoch === this.searchEpoch) { this.searching = false; this.renderState(); } return; }
      if (epoch !== this.searchEpoch || this.root.hidden) return;
      this.searching = false;
    }
    this.result = searchDocument(buildSearchSources(this.doc, pdfPages, this.cacheFor(this.doc.id), bookPages), query);
    if (!preserveActive) this.pendingReveal = false;
    if (!this.result.matches.length) { this.active = -1; this.autoExpanded = false; }
    else if (prev) this.active = this.result.matches.findIndex(m => m.page === prev.page && m.side === prev.side && m.blockId === prev.blockId && m.occurrence === prev.occurrence);
    else if (autoSelect) {
      const onPage = this.result.matches.findIndex(m => m.page === this.host.page());
      const hit = onPage >= 0 ? this.result.matches[onPage] : undefined;
      const hiddenSide = hit ? (hit.side === 'translation' ? !this.host.isBilingual() : byId('original').offsetWidth === 0) : false;
      this.active = onPage; this.autoExpanded = onPage < 0 || hiddenSide;
    }
    else this.active = -1;
    this.renderState();
    const active = this.pendingReveal && this.active >= 0 ? this.result.matches[this.active] : undefined;
    if (active?.page === this.host.page() && active.side === 'translation' && active.blockId) this.host.focusBlock(active.blockId);
    const current = this.paintPage();
    if ((autoSelect || this.pendingReveal) && current) { this.pendingReveal = false; this.revealRange(current); }
  }
  private async jumpTo(index: number): Promise<void> {
    const match = this.result.matches[index];
    if (!match) return;
    const epoch = ++this.jumpEpoch; this.active = index; this.pendingReveal = false;
    if (this.autoExpanded && !this.userToggledList) this.autoExpanded = false;
    this.renderState();
    if (match.side === 'translation' && !this.host.isBilingual()) this.host.showTranslation();
    else if (match.side === 'source' && byId('original').offsetWidth === 0) this.host.showSource();
    if (match.page !== this.host.page()) { await this.host.navigateToPage(match.page); if (epoch !== this.jumpEpoch || this.root.hidden) return; }
    else this.host.pushHistory();
    if (match.side === 'translation' && match.blockId) this.host.focusBlock(match.blockId);
    const current = this.paintPage();
    if (current) this.revealRange(current);
    else if (match.side === 'translation') this.pendingReveal = true;
  }
  private applyHighlights(allRanges: Range[], currentRanges: Range[]): void {
    this.fallbackLayer?.remove(); this.fallbackLayer = undefined;
    if ('highlights' in CSS && typeof Highlight !== 'undefined') {
      for (const [name, ranges, priority] of [['paper-find-matches', allRanges, 1], ['paper-find-current', currentRanges, 2]] as const) {
        if (!ranges.length) CSS.highlights.delete(name);
        else { const h = new Highlight(...ranges); h.priority = priority; CSS.highlights.set(name, h); }
      }
      return;
    }
    const pages = document.querySelector<HTMLElement>('.pages');
    if (!pages || !allRanges.length) return;
    const base = pages.getBoundingClientRect(), layer = el('div', 'doc-search-fallback'); layer.setAttribute('aria-hidden', 'true');
    for (const [ranges, current] of [[allRanges, false], [currentRanges, true]] as const) {
      for (const range of ranges) for (const r of range.getClientRects()) {
        if (r.width <= 0.4 || r.height <= 0.4) continue;
        const mark = el('div', current ? 'doc-search-fallback-mark is-current' : 'doc-search-fallback-mark');
        Object.assign(mark.style, { left: (r.left - base.left) + 'px', top: (r.top - base.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
        layer.append(mark);
      }
    }
    pages.append(layer); this.fallbackLayer = layer;
  }
  private clearHighlights(): void {
    if (this.repaintFrame) { cancelAnimationFrame(this.repaintFrame); this.repaintFrame = 0; }
    this.fallbackLayer?.remove(); this.fallbackLayer = undefined;
    if ('highlights' in CSS) { CSS.highlights?.delete('paper-find-matches'); CSS.highlights?.delete('paper-find-current'); }
  }
  private revealRange(range: Range): void {
    const anchor = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const innerBox = anchor?.closest<HTMLElement>('.pdf-translated-text.needs-scroll');
    if (innerBox) {
      const box = innerBox.getBoundingClientRect(), line = range.getClientRects()[0] ?? range.getBoundingClientRect();
      if (box.height && (line.top < box.top || line.bottom > box.bottom)) innerBox.scrollTop += (line.top - box.top - box.height * 0.3) * innerBox.offsetHeight / box.height;
    }
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const translated = byId('translated'), scroller = anchor && translated.contains(anchor) && translated.scrollHeight > translated.clientHeight + 2 ? translated : byId('paperScroll');
    const sRect = scroller.getBoundingClientRect(), barRect = this.root.hidden ? undefined : this.root.getBoundingClientRect();
    const topSafe = barRect && barRect.bottom > sRect.top ? Math.max(64, barRect.bottom - sRect.top + 16) : 64;
    if (rect.top < sRect.top + topSafe || rect.bottom > sRect.bottom - 24) scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + (rect.top - sRect.top) - Math.max(topSafe, (sRect.height - rect.height) * 0.38)), behavior: 'instant' });
    if (rect.left < sRect.left + 16 || rect.right > sRect.right - 16) scroller.scrollTo({ left: Math.max(0, scroller.scrollLeft + (rect.left - sRect.left) - (sRect.width - rect.width) * 0.4), behavior: 'instant' });
  }
  private isListExpanded(): boolean { return Boolean(this.input.value.trim() && !this.searching && (this.userToggledList ? this.listOpen : this.autoExpanded)); }
  private renderState(): void {
    const query = this.input.value.trim(), total = this.result.matches.length, expanded = this.isListExpanded();
    this.countEl.textContent = !query ? '' : this.searching ? label('Searching…', '正在搜索…') : !total ? '0 / 0' : this.active >= 0 ? (this.active + 1) + ' / ' + total : '– / ' + total;
    this.prevBtn.disabled = this.nextBtn.disabled = total === 0; this.listBtn.disabled = !query || this.searching;
    this.listBtn.setAttribute('aria-expanded', String(expanded));
    this.listBtn.ariaLabel = this.listBtn.title = expanded ? label('Hide matches', '收起匹配列表') : label('Show all matches', '展开匹配列表');
    this.resultsEl.hidden = !expanded; this.resultsEl.replaceChildren();
    if (!expanded) return;
    if (!total) { this.resultsEl.append(el('p', 'doc-search-empty', label('No matches', '无匹配结果'))); return; }
    const multiPage = Boolean(this.pdf || this.doc.book);
    for (const group of this.result.groups) {
      const sec = this.doc.book?.sections[group.page - 1];
      this.resultsEl.append(el('div', 'doc-search-page', sec ? sec.title : multiPage ? label('Page ' + group.page, '第 ' + group.page + ' 页') : label('Matches', '匹配结果')));
      for (const { index, match } of group.matches) {
        const hit = el('button', 'doc-search-hit'); hit.type = 'button';
        if (index === this.active) hit.setAttribute('aria-current', 'true');
        if (match.side === 'translation') hit.append(el('span', 'doc-search-badge', label('Translated text', '译文')));
        const snippet = el('span', 'doc-search-snippet');
        snippet.append(document.createTextNode(match.snippet.slice(0, match.matchStart)), el('mark', '', match.snippet.slice(match.matchStart, match.matchEnd)), document.createTextNode(match.snippet.slice(match.matchEnd)));
        hit.append(snippet); hit.addEventListener('click', () => { void this.jumpTo(index); }); this.resultsEl.append(hit);
      }
    }
    this.resultsEl.querySelector<HTMLElement>('.doc-search-hit[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  private syncGeometry(): void {
    if (this.root.hidden) return;
    const ws = this.workspace.getBoundingClientRect(), paper = byId('paperScroll').getBoundingClientRect();
    this.root.style.setProperty('--search-top', Math.max(8, Math.round(paper.top - ws.top + 8)) + 'px');
    this.root.style.setProperty('--search-end', Math.max(8, Math.round(ws.right - paper.right + 16)) + 'px');
    this.root.style.setProperty('--search-max-h', Math.max(120, Math.round(paper.height - 24)) + 'px');
    if (this.fallbackLayer && !this.repaintFrame) this.repaintFrame = requestAnimationFrame(() => { this.repaintFrame = 0; if (!this.root.hidden && this.fallbackLayer) this.paintPage(); });
  }
}
