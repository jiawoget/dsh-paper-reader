import { targetsSimplifiedChinese } from '../shared/languages.js';
import type { DocumentInfo, PageView, ReaderBlock, Settings } from '../shared/types.js';
import { unchangedArticleBlock } from './article-content.js';
import { researchText } from './research/labels.js';
import { isAbortError, mkBtn } from './research/paper-intake.js';
import { api, byId, el, message, readerLabel as label } from './ui.js';

export interface BlockPosition { id: string; top: number; bottom: number }

export const canTranslateDocument = (s: Settings, target: string): boolean =>
  s.aiMode !== 'unconfigured' || Boolean(s.localTranslationAvailable && targetsSimplifiedChinese(target));
export const translationBatchBudget = (done: number): { maxBlocks: number; maxChars: number } =>
  done === 0 ? { maxBlocks: 4, maxChars: 1100 } : { maxBlocks: 8, maxChars: 1800 };

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

interface ArticleTranslationHost {
  doc: () => DocumentInfo; page: () => number; view: () => PageView | undefined;
  isPdf: () => boolean; isBilingual: () => boolean; settings: () => Settings;
  targetLanguage: () => string; targetLanguageLabel: () => string;
  onApplied: (docId: string, page: number, translations: Record<string, string>) => void;
  openSettings: () => void;
}

export class ArticleTranslationController {
  private readonly bar = el('div', 'article-translation-bar');
  private readonly status = el('span', 'article-translation-status');
  private readonly actions = el('div', 'article-translation-actions');
  private runId = 0; private raf = 0;
  private activeRun?: { key: string; ctrl: AbortController; paused: boolean; reprioritizing: boolean; cleanup: () => void };

  constructor(private readonly host: ArticleTranslationHost) {
    this.bar.hidden = true; this.bar.setAttribute('role', 'status'); this.bar.setAttribute('aria-live', 'polite');
    this.bar.append(this.status, this.actions);
  }
  private translatable(doc: DocumentInfo, view: PageView): ReaderBlock[] { return view.blocks.filter(b => b.text.trim() && !unchangedArticleBlock(doc.articleLayout?.[b.id]?.kind)); }
  private measurePositions(): Map<string, BlockPosition> {
    const orig = byId('original'), pane = orig.getBoundingClientRect().height > 0 ? orig : byId('translated'), positions = new Map<string, BlockPosition>();
    for (const row of pane.querySelectorAll<HTMLElement>('[data-anchor]')) {
      const id = row.dataset.anchor, r = id ? row.getBoundingClientRect() : undefined;
      if (id && r) positions.set(id, { id, top: r.top, bottom: r.bottom });
    }
    return positions;
  }
  private showBar(state: 'running' | 'stopped' | 'unavailable' | 'error', text: string, ratio: number, buttons: HTMLElement[]): void {
    const host = byId('paperScroll');
    if (this.bar.parentElement !== host) host.prepend(this.bar);
    this.bar.dataset.state = state; this.bar.style.setProperty('--progress', String(Math.max(0, Math.min(1, ratio))));
    this.status.textContent = text; this.actions.replaceChildren(...buttons); this.bar.hidden = false;
  }
  private hideBar(): void { this.bar.hidden = true; delete this.bar.dataset.state; }
  private showUnavailable(settings: Settings, target: string): void {
    const name = this.host.targetLanguageLabel();
    const text = settings.localTranslationAvailable && !targetsSimplifiedChinese(target) ? researchText.translationGuidanceLocalOnly(name) : researchText.translationGuidanceConnect(name);
    this.showBar('unavailable', text, 0, [mkBtn('btn primary', label('Connections', '连接设置'), () => this.host.openSettings()), mkBtn('btn', label('Retry', '重试'), () => { void this.start(false); })]);
  }
  abort(): void {
    this.runId++;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.activeRun) { this.activeRun.cleanup(); this.activeRun.paused = false; this.activeRun.ctrl.abort(); this.activeRun = undefined; }
    this.host.view()?.setPendingBlocks?.(new Set()); this.hideBar();
  }
  stop(): void { if (this.activeRun) { this.activeRun.paused = true; this.activeRun.ctrl.abort(); } }
  sync(): void {
    const view = this.host.view();
    if (this.host.isPdf() || !this.host.isBilingual() || !view) { this.abort(); return; }
    const doc = this.host.doc(), page = this.host.page(), settings = this.host.settings(), target = this.host.targetLanguage(), all = this.translatable(doc, view);
    if (!all.length || all.every(b => b.translation)) { this.abort(); return; }
    if (!canTranslateDocument(settings, target)) { this.abort(); this.showUnavailable(settings, target); return; }
    if (this.activeRun?.key === `${doc.id}:${page}:${target}`) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => { this.raf = 0; void this.start(false); });
  }
  async start(force = false, done?: Set<string>): Promise<void> {
    const view = this.host.view();
    if (this.host.isPdf() || !this.host.isBilingual() || !view) return;
    const doc = this.host.doc(), page = this.host.page(), settings = this.host.settings(), target = this.host.targetLanguage();
    if (!canTranslateDocument(settings, target)) { this.abort(); this.showUnavailable(settings, target); return; }
    this.abort();
    const all = this.translatable(doc, view), completed = done ? new Set(done) : new Set<string>(force ? [] : all.filter(b => b.translation).map(b => b.id));
    if (!all.length || (!force && completed.size >= all.length)) return;
    const scroller = byId('paperScroll'), runId = ++this.runId;
    let inFlight: string[] = [], scrollTimer = 0;
    const run = { key: `${doc.id}:${page}:${target}`, ctrl: new AbortController(), paused: false, reprioritizing: false, cleanup: () => {} };
    const active = () => this.runId === runId && this.host.view() === view && this.host.doc().id === doc.id && this.host.page() === page && this.host.targetLanguage() === target && this.host.isBilingual();
    const onScroll = () => {
      clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        scrollTimer = 0;
        if (!active() || !inFlight.length || run.paused || run.reprioritizing) return;
        const v = scroller.getBoundingClientRect(), pos = this.measurePositions();
        const inView = (id: string) => { const p = pos.get(id); return Boolean(p && p.bottom > p.top && p.bottom > v.top - 160 && p.top < v.bottom + 160); };
        if (!inFlight.some(inView) && all.some(b => !completed.has(b.id) && inView(b.id))) { run.reprioritizing = true; run.ctrl.abort(); }
      }, 320);
    };
    run.cleanup = () => { scroller.removeEventListener('scroll', onScroll); clearTimeout(scrollTimer); scrollTimer = 0; };
    this.activeRun = run; scroller.addEventListener('scroll', onScroll, { passive: true });
    try {
      while (active()) {
        const rect = scroller.getBoundingClientRect();
        const batch = selectTranslationBatch(all, this.measurePositions(), { top: rect.top, bottom: rect.bottom }, { ...translationBatchBudget(completed.size), force, translated: completed });
        if (!batch.length) break;
        this.showBar('running', researchText.translatingProgress(completed.size, all.length), completed.size / all.length, [mkBtn('btn', researchText.stop(), () => this.stop())]);
        view.setPendingBlocks?.(new Set(batch.map(b => b.id)));
        run.ctrl = new AbortController(); run.reprioritizing = false; inFlight = batch.map(b => b.id);
        let translations: Record<string, string>;
        try { ({ translations } = await api('translation.page', { docId: doc.id, page, targetLanguage: target, blocks: batch.map(({ id, text }) => ({ id, text })), ...(force ? { force: true } : {}) }, false, run.ctrl.signal)); }
        catch (error) { inFlight = []; if (run.reprioritizing && !run.paused && active()) continue; throw error; }
        inFlight = [];
        if (!active()) return;
        let added = 0;
        for (const b of batch) if (translations[b.id]?.trim()) { completed.add(b.id); added++; }
        view.setTranslations?.(translations, force); this.host.onApplied(doc.id, page, translations);
        if (!added) break;
      }
      if (active()) { view.setPendingBlocks?.(new Set()); this.hideBar(); }
    } catch (error) {
      if (!active()) return;
      view.setPendingBlocks?.(new Set());
      if (run.ctrl.signal.aborted || isAbortError(error)) {
        if (run.paused && completed.size < all.length) this.showBar('stopped', researchText.pausedProgress(completed.size, all.length), completed.size / all.length, [mkBtn('btn primary', researchText.resumeTranslation(), () => { void this.start(force, completed); })]);
        else this.hideBar();
      } else this.showBar('error', message(error), completed.size / all.length, [mkBtn('btn primary', label('Retry', '重试'), () => { void this.start(force, completed); }), mkBtn('btn', label('Connections', '连接设置'), () => this.host.openSettings())]);
    } finally {
      run.cleanup(); if (this.activeRun === run) this.activeRun = undefined;
      if (this.runId === runId && !active()) { if (this.host.view() === view) view.setPendingBlocks?.(new Set()); this.hideBar(); }
    }
  }
}
