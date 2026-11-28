import { targetsSimplifiedChinese } from '../shared/languages.js';
import type { DocumentInfo, PageView, ReaderBlock, Settings } from '../shared/types.js';
import { unchangedArticleBlock } from './article-content.js';
import { researchText } from './research/labels.js';
import { isAbortError, mkBtn } from './research/paper-intake.js';
import { api, byId, el, message, readerLabel as label } from './ui.js';

export interface BlockPosition { id: string; top: number; bottom: number }

export const AUTO_TRANSLATE_MAX_BLOCKS = 24, AUTO_TRANSLATE_MAX_CHARS = 8000;
export const VIEWPORT_BUFFER_PX = 160, VIEWPORT_BURST_MAX_BLOCKS = 12, VIEWPORT_BURST_MAX_CHARS = 3500;

export const canTranslateDocument = (s: Settings, target: string): boolean =>
  s.aiMode !== 'unconfigured' || Boolean(s.localTranslationAvailable && targetsSimplifiedChinese(target));
export const translationBatchBudget = (done: number): { maxBlocks: number; maxChars: number } =>
  done === 0 ? { maxBlocks: 4, maxChars: 1100 } : { maxBlocks: 8, maxChars: 1800 };

export function isLongTranslationScope(blocks: readonly ReaderBlock[], maxBlocks = AUTO_TRANSLATE_MAX_BLOCKS, maxChars = AUTO_TRANSLATE_MAX_CHARS): boolean {
  for (let count = 0, chars = 0, i = 0; i < blocks.length; i++) {
    const len = blocks[i].text.trim().length;
    if (len && (++count > maxBlocks || (chars += len) > maxChars)) return true;
  }
  return false;
}

export function selectTranslationBatch(blocks: readonly ReaderBlock[], positions: ReadonlyMap<string, BlockPosition>,
  viewport: { top: number; bottom: number }, options?: { force?: boolean; translated?: ReadonlySet<string>; maxBlocks?: number; maxChars?: number }): ReaderBlock[] {
  const maxBlocks = options?.maxBlocks ?? 8, maxChars = options?.maxChars ?? 1800, done = options?.translated, force = Boolean(options?.force);
  const candidates: { block: ReaderBlock; index: number; distance: number }[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block.text.trim() || (force ? done?.has(block.id) : Boolean(block.translation || done?.has(block.id)))) continue;
    const pos = positions.get(block.id);
    const distance = !pos || pos.bottom <= pos.top ? Number.POSITIVE_INFINITY
      : pos.bottom > viewport.top && pos.top < viewport.bottom ? 0
      : pos.top >= viewport.bottom ? pos.top - viewport.bottom
      : (viewport.top - pos.bottom) * 1.15;
    candidates.push({ block, index, distance });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
  const batch: ReaderBlock[] = [];
  for (let chars = 0, i = 0; i < candidates.length; i++) {
    const { block } = candidates[i];
    if (batch.length >= maxBlocks || (batch.length > 0 && chars + block.text.length > maxChars)) break;
    batch.push(block); chars += block.text.length;
  }
  return batch;
}

export function selectViewportBatch(blocks: readonly ReaderBlock[], positions: ReadonlyMap<string, BlockPosition>,
  viewport: { top: number; bottom: number }, options?: { force?: boolean; translated?: ReadonlySet<string>; bufferPx?: number; maxBlocks?: number; maxChars?: number; anchorId?: string }): ReaderBlock[] {
  const buffer = options?.bufferPx ?? VIEWPORT_BUFFER_PX, winTop = viewport.top - buffer, winBottom = viewport.bottom + buffer, anchorId = options?.anchorId;
  const anchor = anchorId ? blocks.find(b => b.id === anchorId) : undefined;
  const inScope: ReaderBlock[] = anchor ? [anchor] : [];
  const effectivePositions = anchor ? new Map(positions).set(anchor.id, { id: anchor.id, top: viewport.top, bottom: Math.max(viewport.top + 1, viewport.bottom) }) : positions;
  for (const block of blocks) {
    if (block.id === anchorId) continue;
    const pos = positions.get(block.id);
    if (pos && pos.bottom > pos.top && pos.bottom > winTop && pos.top < winBottom) inScope.push(block);
  }
  return inScope.length ? selectTranslationBatch(inScope, effectivePositions, viewport, {
    force: options?.force, translated: options?.translated,
    maxBlocks: options?.maxBlocks ?? VIEWPORT_BURST_MAX_BLOCKS, maxChars: options?.maxChars ?? VIEWPORT_BURST_MAX_CHARS
  }) : [];
}

type BarState = 'hidden' | 'prompt' | 'running' | 'stopped' | 'unavailable' | 'error';
type TranslateReq = { docId: string; page: number; targetLanguage: string; blocks: { id: string; text: string }[]; force?: boolean };
interface BarSnapshot { state: BarState; text: string; done: number; total: number; visibleMissing: number; autoOnScroll: boolean }

interface ArticleTranslationHost {
  doc: () => DocumentInfo; page: () => number; view: () => PageView | undefined;
  isPdf: () => boolean; isBilingual: () => boolean; settings: () => Settings;
  targetLanguage: () => string; targetLanguageLabel: () => string;
  onApplied: (docId: string, page: number, translations: Record<string, string>) => void; openSettings: () => void;
  translatePage?: (req: TranslateReq, signal: AbortSignal) => Promise<Record<string, string>>;
  measureViewport?: () => { top: number; bottom: number; positions: Map<string, BlockPosition> };
  scheduleFrame?: (fn: () => void) => number; cancelFrame?: (id: number) => void;
  onStateChange?: (snapshot: BarSnapshot) => void;
}

export class ArticleTranslationController {
  private bar?: HTMLDivElement; private status?: HTMLSpanElement; private actions?: HTMLDivElement;
  private runId = 0; private raf = 0; private autoOnScroll = false; private lastDocId?: string;
  private activeRun?: { key: string; ctrl: AbortController; paused: boolean; reprioritizing: boolean; cleanup: () => void };
  private standby?: { key: string; doc: DocumentInfo; page: number; target: string; view: PageView; mode: 'prompt' | 'stopped'; force: boolean; completed?: Set<string>; cleanup: () => void };

  constructor(private readonly host: ArticleTranslationHost) {}
  private ensureBar() {
    if (!this.bar || !this.status || !this.actions) {
      this.bar = el('div', 'article-translation-bar'); this.status = el('span', 'article-translation-status'); this.actions = el('div', 'article-translation-actions');
      this.bar.hidden = true; this.bar.setAttribute('role', 'status'); this.bar.setAttribute('aria-live', 'polite'); this.bar.append(this.status, this.actions);
    }
    return { bar: this.bar, status: this.status, actions: this.actions };
  }
  private schedule(fn: () => void): number { return this.host.scheduleFrame ? this.host.scheduleFrame(fn) : typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : Number(setTimeout(fn, 0)); }
  private cancelSchedule(id: number): void { if (this.host.cancelFrame) this.host.cancelFrame(id); else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); else clearTimeout(id); }
  private context() {
    const view = this.host.view();
    return this.host.isPdf() || !this.host.isBilingual() || !view ? undefined
      : { doc: this.host.doc(), page: this.host.page(), settings: this.host.settings(), target: this.host.targetLanguage(), view, key: `${this.host.doc().id}:${this.host.page()}:${this.host.targetLanguage()}` };
  }
  private matches(docId: string, page: number, target: string, view: PageView): boolean { return !this.host.isPdf() && this.host.isBilingual() && this.host.view() === view && this.host.doc().id === docId && this.host.page() === page && this.host.targetLanguage() === target; }
  private translatable(doc: DocumentInfo, view: PageView): ReaderBlock[] { return view.blocks.filter(b => b.text.trim() && !unchangedArticleBlock(doc.articleLayout?.[b.id]?.kind)); }
  private measurePositions(): Map<string, BlockPosition> {
    const orig = byId('original'), pane = orig.getBoundingClientRect().height > 0 ? orig : byId('translated'), positions = new Map<string, BlockPosition>();
    for (const row of pane.querySelectorAll<HTMLElement>('[data-anchor]')) { const id = row.dataset.anchor, r = id ? row.getBoundingClientRect() : undefined; if (id && r) positions.set(id, { id, top: r.top, bottom: r.bottom }); }
    return positions;
  }
  private getViewport() {
    if (this.host.measureViewport) return this.host.measureViewport();
    const r = byId('paperScroll').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, positions: this.measurePositions() };
  }
  private visibleBatch(all: readonly ReaderBlock[], opts?: { force?: boolean; translated?: ReadonlySet<string>; anchorId?: string }): ReaderBlock[] {
    const vp = this.getViewport(); return selectViewportBatch(all, vp.positions, { top: vp.top, bottom: vp.bottom }, opts);
  }
  private showBar(state: Exclude<BarState, 'hidden'>, text: string, ratio: number, buildButtons: () => HTMLElement[], meta?: { done?: number; total?: number; visibleMissing?: number }): void {
    this.host.onStateChange?.({ state, text, done: meta?.done ?? 0, total: meta?.total ?? 0, visibleMissing: meta?.visibleMissing ?? 0, autoOnScroll: this.autoOnScroll });
    if (typeof document === 'undefined') return;
    const { bar, status, actions } = this.ensureBar(), host = byId('paperScroll');
    if (bar.parentElement !== host) host.prepend(bar);
    bar.dataset.state = state; bar.style.setProperty('--progress', String(Math.max(0, Math.min(1, ratio)))); status.textContent = text; actions.replaceChildren(...buildButtons()); bar.hidden = false;
  }
  private hideBar(): void {
    this.host.onStateChange?.({ state: 'hidden', text: '', done: 0, total: 0, visibleMissing: 0, autoOnScroll: this.autoOnScroll });
    if (this.bar) { this.bar.hidden = true; delete this.bar.dataset.state; }
  }
  private showUnavailable(settings: Settings, target: string): void {
    const name = this.host.targetLanguageLabel();
    this.showBar('unavailable', settings.localTranslationAvailable && !targetsSimplifiedChinese(target) ? researchText.translationGuidanceLocalOnly(name) : researchText.translationGuidanceConnect(name), 0,
      () => [mkBtn('btn primary', label('Connections', '连接设置'), () => this.host.openSettings()), mkBtn('btn', label('Retry', '重试'), () => this.sync())]);
  }
  private clearStandby(): void { if (this.standby) { this.standby.cleanup(); this.standby = undefined; } }
  private renderStandbyBar(): void {
    const s = this.standby; if (!s) return;
    const all = this.translatable(s.doc, s.view), done = s.force ? (s.completed?.size ?? 0) : all.filter(b => Boolean(b.translation)).length;
    if (!all.length || done >= all.length) { this.clearStandby(); this.hideBar(); return; }
    const visibleMissing = this.visibleBatch(all, s.force ? { force: true, translated: s.completed } : undefined).length;
    const text = s.mode === 'stopped' ? researchText.pausedProgress(done, all.length) : done === 0 ? researchText.longSectionPrompt(all.length) : visibleMissing > 0 ? researchText.longSectionProgress(done, all.length) : researchText.screenTranslated(done, all.length);
    this.showBar(s.mode, text, done / all.length, () => {
      const toggle = mkBtn('btn article-scroll-toggle', researchText.autoTranslateScroll(), () => this.setAutoOnScroll(!this.autoOnScroll));
      toggle.setAttribute('aria-pressed', String(this.autoOnScroll));
      return [
        ...(visibleMissing > 0 ? [mkBtn('btn primary', researchText.translateScreen(), () => { void this.translateViewport(undefined, s.force ? { force: true, done: s.completed } : undefined); })] : []),
        s.mode === 'stopped' ? mkBtn(visibleMissing === 0 ? 'btn primary' : 'btn', researchText.resumeTranslation(), () => { void this.start(s.force, s.completed); }) : mkBtn('btn', researchText.translateAll(), () => { void this.start(false); }),
        toggle
      ];
    }, { done, total: all.length, visibleMissing });
  }
  private enterStandby(doc: DocumentInfo, page: number, target: string, view: PageView, mode: 'prompt' | 'stopped', force: boolean, completed?: Set<string>): void {
    if (!this.matches(doc.id, page, target, view)) return;
    this.clearStandby();
    const all = this.translatable(doc, view), done = force ? (completed?.size ?? 0) : all.filter(b => Boolean(b.translation)).length;
    if (!all.length || done >= all.length) { this.hideBar(); return; }
    let scrollTimer = 0, cleanup = () => {};
    if (typeof document !== 'undefined') {
      const scroller = byId('paperScroll'), translated = byId('translated');
      const onScroll = () => { clearTimeout(scrollTimer); scrollTimer = window.setTimeout(() => { scrollTimer = 0; this.handleScroll(); }, 240); };
      const onClick = (e: MouseEvent) => {
        if (e.defaultPrevented || e.button !== 0 || this.activeRun) return;
        const sel = window.getSelection(); if (sel && !sel.isCollapsed && sel.toString().trim()) return;
        const row = (e.target instanceof Element ? e.target : e.target instanceof Node ? e.target.parentElement : null)?.closest<HTMLElement>('[data-anchor].is-untranslated');
        if (row?.dataset.anchor && translated.contains(row)) void this.translateViewport(row.dataset.anchor, force ? { force: true, done: completed } : undefined);
      };
      translated.classList.add('can-click-translate'); scroller.addEventListener('scroll', onScroll, { passive: true }); translated.addEventListener('click', onClick);
      cleanup = () => { scroller.removeEventListener('scroll', onScroll); translated.removeEventListener('click', onClick); translated.classList.remove('can-click-translate'); clearTimeout(scrollTimer); scrollTimer = 0; };
    }
    this.standby = { key: `${doc.id}:${page}:${target}`, doc, page, target, view, mode, force, completed, cleanup };
    this.renderStandbyBar();
  }
  private triggerScrollBurst(): void {
    const s = this.standby; if (!s || this.activeRun) return;
    if (!this.matches(s.doc.id, s.page, s.target, s.view)) { this.clearStandby(); this.hideBar(); return; }
    if (this.autoOnScroll && this.visibleBatch(this.translatable(s.doc, s.view), s.force ? { force: true, translated: s.completed } : undefined).length) void this.translateViewport(undefined, s.force ? { force: true, done: s.completed } : undefined);
    else this.renderStandbyBar();
  }
  getAutoOnScroll(): boolean { return this.autoOnScroll; }
  setAutoOnScroll(on: boolean): void { if (this.autoOnScroll !== on) { this.autoOnScroll = on; this.triggerScrollBurst(); } }
  handleScroll(): void { this.triggerScrollBurst(); }
  abort(): void {
    this.runId++; if (this.raf) { this.cancelSchedule(this.raf); this.raf = 0; }
    this.clearStandby();
    if (this.activeRun) { this.activeRun.cleanup(); this.activeRun.paused = false; this.activeRun.ctrl.abort(); this.activeRun = undefined; }
    this.host.view()?.setPendingBlocks?.(new Set()); this.hideBar();
  }
  stop(): void { if (this.activeRun) { this.activeRun.paused = true; this.activeRun.ctrl.abort(); } }
  sync(): void {
    const ctx = this.context(); if (!ctx) { this.abort(); return; }
    const { doc, page, settings, target, view, key } = ctx;
    if (this.lastDocId !== doc.id) { this.lastDocId = doc.id; this.autoOnScroll = false; }
    const all = this.translatable(doc, view);
    if (!all.length || all.every(b => b.translation)) { this.abort(); return; }
    if (!canTranslateDocument(settings, target)) { this.abort(); this.showUnavailable(settings, target); return; }
    if (this.activeRun?.key === key || (this.standby?.key === key && this.standby.view === view)) return;
    this.abort();
    const isLong = isLongTranslationScope(all);
    this.raf = this.schedule(() => { this.raf = 0; if (isLong) this.enterStandby(doc, page, target, view, 'prompt', false); else void this.start(false); });
  }
  async translateViewport(anchorId?: string, opts?: { force?: boolean; done?: Set<string> }): Promise<void> { await this.runBatches('viewport', { anchorId, ...opts }); }
  async start(force = false, done?: Set<string>): Promise<void> { await this.runBatches('all', { force, done }); }
  private async runBatches(mode: 'all' | 'viewport', opts: { force?: boolean; done?: Set<string>; anchorId?: string }): Promise<void> {
    const ctx = this.context(); if (!ctx) return;
    const { doc, page, settings, target, view, key } = ctx;
    const inherit = mode === 'viewport' && opts.force === undefined && this.standby?.key === key && this.standby.view === view && this.standby.force;
    const force = Boolean(inherit ? true : opts.force), doneOpt = inherit ? this.standby?.completed : opts.done;
    if (!canTranslateDocument(settings, target)) { this.abort(); this.showUnavailable(settings, target); return; }
    const all = this.translatable(doc, view);
    let firstBatch = mode === 'viewport' ? this.visibleBatch(all, { ...(opts.anchorId ? { anchorId: opts.anchorId } : {}), ...(force ? { force: true, translated: doneOpt } : {}) }) : undefined;
    if (mode === 'viewport' && !firstBatch?.length) { if (this.standby) this.renderStandbyBar(); else if (isLongTranslationScope(all)) this.enterStandby(doc, page, target, view, force ? 'stopped' : 'prompt', force, force ? doneOpt : undefined); return; }
    this.abort();
    const completed = doneOpt ? new Set(doneOpt) : new Set<string>(force ? [] : all.filter(b => b.translation).map(b => b.id));
    if (!all.length || completed.size >= all.length) return;
    const runId = ++this.runId; let inFlight: string[] = [], scrollTimer = 0;
    const run = { key, ctrl: new AbortController(), paused: false, reprioritizing: false, cleanup: () => {} };
    const active = () => this.runId === runId && this.matches(doc.id, page, target, view);
    if (mode === 'all' && typeof document !== 'undefined') {
      const scroller = byId('paperScroll');
      const onScroll = () => {
        clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
          scrollTimer = 0; if (!active() || !inFlight.length || run.paused || run.reprioritizing) return;
          const v = scroller.getBoundingClientRect(), pos = this.measurePositions();
          const inView = (id: string) => { const p = pos.get(id); return Boolean(p && p.bottom > p.top && p.bottom > v.top - VIEWPORT_BUFFER_PX && p.top < v.bottom + VIEWPORT_BUFFER_PX); };
          if (!inFlight.some(inView) && all.some(b => !completed.has(b.id) && inView(b.id))) { run.reprioritizing = true; run.ctrl.abort(); }
        }, 320);
      };
      run.cleanup = () => { scroller.removeEventListener('scroll', onScroll); clearTimeout(scrollTimer); scrollTimer = 0; };
      scroller.addEventListener('scroll', onScroll, { passive: true });
    }
    this.activeRun = run;
    try {
      while (active()) {
        const vp = firstBatch ? undefined : this.getViewport();
        const batch = firstBatch ?? (mode === 'viewport' ? [] : selectTranslationBatch(all, vp!.positions, { top: vp!.top, bottom: vp!.bottom }, { ...translationBatchBudget(completed.size), force, translated: completed }));
        firstBatch = undefined; if (!batch.length) break;
        this.showBar('running', researchText.translatingProgress(completed.size, all.length), completed.size / all.length, () => [mkBtn('btn', researchText.stop(), () => this.stop())], { done: completed.size, total: all.length, visibleMissing: batch.length });
        view.setPendingBlocks?.(new Set(batch.map(b => b.id)));
        run.ctrl = new AbortController(); run.reprioritizing = false; inFlight = batch.map(b => b.id);
        let translations: Record<string, string>;
        const req: TranslateReq = { docId: doc.id, page, targetLanguage: target, blocks: batch.map(({ id, text }) => ({ id, text })), ...(force ? { force: true } : {}) };
        try { translations = this.host.translatePage ? await this.host.translatePage(req, run.ctrl.signal) : (await api('translation.page', req, false, run.ctrl.signal)).translations; }
        catch (error) { inFlight = []; if (run.reprioritizing && !run.paused && active()) continue; throw error; }
        inFlight = []; if (!active()) return;
        let added = 0; for (const b of batch) if (translations[b.id]?.trim()) { completed.add(b.id); added++; }
        view.setTranslations?.(translations, force); this.host.onApplied(doc.id, page, translations);
        if (mode === 'viewport' || !added) break;
      }
      if (active()) {
        view.setPendingBlocks?.(new Set()); if (this.activeRun === run) this.activeRun = undefined;
        if (mode === 'viewport' && completed.size < all.length) this.enterStandby(doc, page, target, view, force ? 'stopped' : 'prompt', force, force ? completed : undefined); else this.hideBar();
      }
    } catch (error) {
      if (!active()) return;
      view.setPendingBlocks?.(new Set()); if (this.activeRun === run) this.activeRun = undefined;
      if (run.ctrl.signal.aborted || isAbortError(error)) {
        if (run.paused && (mode === 'viewport' || completed.size < all.length)) {
          if (mode === 'viewport') this.enterStandby(doc, page, target, view, force ? 'stopped' : 'prompt', force, force ? completed : undefined);
          else if (isLongTranslationScope(all)) this.enterStandby(doc, page, target, view, 'stopped', force, completed);
          else this.showBar('stopped', researchText.pausedProgress(completed.size, all.length), completed.size / all.length, () => [mkBtn('btn primary', researchText.resumeTranslation(), () => { void this.start(force, completed); })], { done: completed.size, total: all.length });
        } else this.hideBar();
      } else this.showBar('error', message(error), completed.size / all.length,
        () => [mkBtn('btn primary', label('Retry', '重试'), () => { void (mode === 'viewport' ? this.translateViewport(opts.anchorId, force ? { force: true, done: completed } : undefined) : this.start(force, completed)); }), mkBtn('btn', label('Connections', '连接设置'), () => this.host.openSettings())], { done: completed.size, total: all.length });
    } finally {
      run.cleanup(); if (this.activeRun === run) this.activeRun = undefined;
      if (this.runId === runId && !active()) { if (this.host.view() === view) view.setPendingBlocks?.(new Set()); this.hideBar(); }
    }
  }
}
