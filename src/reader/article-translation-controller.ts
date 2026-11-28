import { targetsSimplifiedChinese } from '../shared/languages.js';
import type { DocumentInfo, PageView, ReaderBlock, Settings } from '../shared/types.js';
import { unchangedArticleBlock } from './article-content.js';
import { researchText } from './research/labels.js';
import { isAbortError, mkBtn } from './research/paper-intake.js';
import { api, byId, el, message, readerLabel as label } from './ui.js';

export interface BlockPosition { id: string; top: number; bottom: number }

export function canTranslateDocument(settings: Settings, targetLanguage: string): boolean {
  return settings.aiMode !== 'unconfigured' || Boolean(settings.localTranslationAvailable && targetsSimplifiedChinese(targetLanguage));
}

export function selectTranslationBatch(
  blocks: readonly ReaderBlock[],
  positions: ReadonlyMap<string, BlockPosition>,
  viewport: { top: number; bottom: number },
  options?: { force?: boolean; translated?: ReadonlySet<string>; maxBlocks?: number; maxChars?: number }
): ReaderBlock[] {
  const maxBlocks = options?.maxBlocks ?? 10, maxChars = options?.maxChars ?? 3500;
  const done = options?.translated, force = Boolean(options?.force);
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
  let chars = 0;
  for (const { block } of candidates) {
    if (batch.length >= maxBlocks || (batch.length > 0 && chars + block.text.length > maxChars)) break;
    batch.push(block);
    chars += block.text.length;
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
  private runId = 0; private raf = 0; private activeRun?: { key: string; ctrl: AbortController; paused: boolean };

  constructor(private readonly host: ArticleTranslationHost) {
    this.bar.hidden = true; this.bar.setAttribute('role', 'status'); this.bar.setAttribute('aria-live', 'polite');
    this.bar.append(this.status, this.actions);
  }
  private translatable(doc: DocumentInfo, view: PageView): ReaderBlock[] {
    return view.blocks.filter(b => b.text.trim() && !unchangedArticleBlock(doc.articleLayout?.[b.id]?.kind));
  }
  private measurePositions(): Map<string, BlockPosition> {
    const orig = byId('original'), pane = orig.getBoundingClientRect().height > 0 ? orig : byId('translated');
    const positions = new Map<string, BlockPosition>();
    for (const row of pane.querySelectorAll<HTMLElement>('[data-anchor]')) {
      const id = row.dataset.anchor, rect = id ? row.getBoundingClientRect() : undefined;
      if (id && rect) positions.set(id, { id, top: rect.top, bottom: rect.bottom });
    }
    return positions;
  }
  private showBar(state: 'running' | 'stopped' | 'unavailable' | 'error', text: string, ratio: number, buttons: HTMLElement[]): void {
    const host = byId('translated');
    if (this.bar.parentElement !== host) host.prepend(this.bar);
    this.bar.dataset.state = state; this.bar.style.setProperty('--progress', String(Math.max(0, Math.min(1, ratio))));
    this.status.textContent = text; this.actions.replaceChildren(...buttons); this.bar.hidden = false;
  }
  private hideBar(): void { this.bar.hidden = true; delete this.bar.dataset.state; }
  private showUnavailable(settings: Settings, target: string): void {
    const targetName = this.host.targetLanguageLabel();
    const guidance = settings.localTranslationAvailable && !targetsSimplifiedChinese(target)
      ? researchText.translationGuidanceLocalOnly(targetName) : researchText.translationGuidanceConnect(targetName);
    this.showBar('unavailable', guidance, 0, [
      mkBtn('btn primary', label('Connections', '连接设置'), () => this.host.openSettings()),
      mkBtn('btn', label('Retry', '重试'), () => { void this.start(false); })
    ]);
  }
  abort(): void {
    this.runId++;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.activeRun) { this.activeRun.paused = false; this.activeRun.ctrl.abort(); this.activeRun = undefined; }
    this.host.view()?.setPendingBlocks?.(new Set());
    this.hideBar();
  }
  stop(): void { if (this.activeRun) { this.activeRun.paused = true; this.activeRun.ctrl.abort(); } }
  sync(): void {
    const view = this.host.view();
    if (this.host.isPdf() || !this.host.isBilingual() || !view) { this.abort(); return; }
    const doc = this.host.doc(), page = this.host.page(), settings = this.host.settings(), target = this.host.targetLanguage();
    const all = this.translatable(doc, view);
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
    const all = this.translatable(doc, view);
    const completed = done ? new Set(done) : new Set<string>(force ? [] : all.filter(b => b.translation).map(b => b.id));
    if (!all.length || (!force && completed.size >= all.length)) return;
    const runId = ++this.runId, ctrl = new AbortController(), run = { key: `${doc.id}:${page}:${target}`, ctrl, paused: false };
    this.activeRun = run;
    const active = () => this.runId === runId && this.host.view() === view && this.host.doc().id === doc.id && this.host.page() === page && this.host.isBilingual();
    try {
      while (active()) {
        const rect = byId('paperScroll').getBoundingClientRect();
        const batch = selectTranslationBatch(all, this.measurePositions(), { top: rect.top, bottom: rect.bottom }, { force, translated: completed });
        if (!batch.length) break;
        this.showBar('running', researchText.translatingProgress(completed.size, all.length), completed.size / all.length, [mkBtn('btn', researchText.stop(), () => this.stop())]);
        view.setPendingBlocks?.(new Set(batch.map(b => b.id)));
        const { translations } = await api('translation.page', { docId: doc.id, page, targetLanguage: target, blocks: batch.map(({ id, text }) => ({ id, text })), ...(force ? { force: true } : {}) }, false, ctrl.signal);
        if (!active()) return;
        let added = 0;
        for (const b of batch) if (translations[b.id]?.trim()) { completed.add(b.id); added++; }
        view.setPendingBlocks?.(new Set());
        view.setTranslations?.(translations, force);
        this.host.onApplied(doc.id, page, translations);
        if (!added) break;
      }
      if (active()) { if (this.activeRun === run) this.activeRun = undefined; view.setPendingBlocks?.(new Set()); this.hideBar(); }
    } catch (error) {
      if (this.activeRun === run) this.activeRun = undefined;
      if (this.runId !== runId || this.host.view() !== view) return;
      view.setPendingBlocks?.(new Set());
      if (ctrl.signal.aborted || isAbortError(error)) {
        if (run.paused && completed.size < all.length && this.host.isBilingual()) this.showBar('stopped', researchText.pausedProgress(completed.size, all.length), completed.size / all.length, [mkBtn('btn primary', researchText.resumeTranslation(), () => { void this.start(force, completed); })]);
        else this.hideBar();
      } else this.showBar('error', message(error), completed.size / all.length, [mkBtn('btn primary', label('Retry', '重试'), () => { void this.start(force, completed); }), mkBtn('btn', label('Connections', '连接设置'), () => this.host.openSettings())]);
    }
  }
}
