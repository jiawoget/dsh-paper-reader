import type { TrendPaper, TrendPaperSort, TrendSource } from '../../shared/research-types.js';
import { api, el, message, readerLabel as t, safeWeb, toast } from '../ui.js';
import { researchIcon } from './icons.js';
import { formatCachedAt, formatDegradedSources, isAbortError, mkBtn, renderPaperActions, saveGraphPaper } from './paper-intake.js';
import type { ResearchShellContext } from './state.js';

interface DrilldownTarget { query: string; topicId: string; topicName: string; year: number; isYtd: boolean; source: TrendSource }
export interface DrilldownSavedState { target: DrilldownTarget; sort: TrendPaperSort; papers: TrendPaper[]; degraded: string[]; fromCache: boolean; cachedAt?: number; scrollTop: number }
interface DrilldownCallbacks {
  shell: () => ResearchShellContext | undefined; savingIds: Set<string>; onClose: () => void;
  onCoverageDelta: (topicId: string, delta: number) => void; onCoverageConfirmed: (topicId: string, docId: string) => void; onPaperSynced: (paperId: string, inLibrary: boolean, docId?: string) => void;
}

const SORTS: readonly [TrendPaperSort, () => string][] = [['representative', () => t('Representative', '高引代表作')], ['newest', () => t('Newest', '最新')], ['library', () => t('★ In Library', '★ 库内已有')]];
const clipAbstract = (text?: string) => { const c = (text ?? '').replace(/\s+/g, ' ').trim(); return !c ? t('No abstract available.', '暂无摘要。') : c.length > 220 ? c.slice(0, 219) + '…' : c; };
const normalizePaper = (p: TrendPaper): TrendPaper => { const docId = p.docId || p.localDocId; p.docId = p.localDocId = docId; p.inLibrary = Boolean(p.inLibrary || docId); return p; };

export class FieldTrendsDrilldown {
  readonly backdrop = el('div', 'ft-drill-backdrop'); readonly root = el('aside', 'ft-drill');
  private readonly titleEl = el('h2', 'ft-drill-title'); private readonly subEl = el('p', 'ft-drill-sub');
  private readonly statusEl = el('div', 'ft-drill-status'); private readonly listEl = el('div', 'ft-drill-list');
  private readonly sortBtns = new Map<TrendPaperSort, HTMLButtonElement>();
  private readonly slots = new Map<string, HTMLElement>();
  private target: DrilldownTarget | null = null; private sort: TrendPaperSort = 'representative';
  private papers: TrendPaper[] = []; private degraded: string[] = []; private fromCache = false; private cachedAt?: number;
  private reqSeq = 0; private ctrl: AbortController | null = null; private mounted = true;

  constructor(private readonly cb: DrilldownCallbacks) {
    this.backdrop.hidden = true; this.backdrop.addEventListener('click', () => this.close());
    this.root.hidden = true; this.root.setAttribute('aria-label', t('Topic papers drilldown', '方向代表作下钻'));
    const head = el('div', 'ft-drill-head'), headText = el('div', 'ft-drill-head-text'), closeBtn = el('button', 'icon-btn ft-drill-close');
    closeBtn.type = 'button'; closeBtn.ariaLabel = closeBtn.title = t('Close panel', '关闭面板');
    closeBtn.append(researchIcon('close', 16)); closeBtn.addEventListener('click', () => this.close());
    headText.append(this.titleEl, this.subEl); head.append(headText, closeBtn);
    const tabsEl = el('div', 'ft-drill-tabs'); tabsEl.setAttribute('role', 'group'); tabsEl.setAttribute('aria-label', t('Paper view', '论文排序视图'));
    for (const [key, fn] of SORTS) { const b = mkBtn('btn ft-drill-tab', fn(), () => { if (this.target && this.sort !== key) { this.sort = key; void this.load(); } }); b.dataset.sort = key; this.sortBtns.set(key, b); tabsEl.append(b); }
    this.statusEl.setAttribute('role', 'status');
    const foot = el('div', 'ft-drill-foot');
    foot.append(mkBtn('btn primary ft-deep-btn', t('Deep Search this direction', '对此方向深搜'), () => this.triggerDeepSearch()));
    this.root.append(head, tabsEl, this.statusEl, this.listEl, foot);
  }

  isOpen(): boolean { return this.target !== null && !this.root.hidden; }
  activeTarget(): DrilldownTarget | null { return this.target; }
  open(target: DrilldownTarget, initialSort: TrendPaperSort = 'representative'): void {
    this.target = target; this.sort = initialSort; this.papers = []; this.degraded = []; this.fromCache = false; this.cachedAt = undefined;
    this.backdrop.hidden = this.root.hidden = false; this.renderHeader(); this.syncTabs(); void this.load();
  }
  close(): void {
    if (!this.target && this.root.hidden) return;
    this.abortPending(); this.target = null; this.backdrop.hidden = this.root.hidden = true;
    this.listEl.replaceChildren(); this.slots.clear(); this.cb.onClose();
  }
  unmount(): void { this.mounted = false; this.abortPending(); this.slots.clear(); }
  saveState(): DrilldownSavedState | null {
    return !this.target || this.root.hidden ? null : { target: { ...this.target }, sort: this.sort, papers: [...this.papers], degraded: [...this.degraded], fromCache: this.fromCache, cachedAt: this.cachedAt, scrollTop: this.listEl.scrollTop };
  }
  restoreState(saved: DrilldownSavedState | null | undefined): void {
    this.abortPending();
    if (!saved) { this.target = null; this.backdrop.hidden = this.root.hidden = true; return; }
    this.target = { ...saved.target }; this.sort = saved.sort; this.papers = saved.papers.map(normalizePaper);
    this.degraded = [...saved.degraded]; this.fromCache = saved.fromCache; this.cachedAt = saved.cachedAt;
    this.backdrop.hidden = this.root.hidden = false; this.renderHeader(); this.syncTabs(); this.renderPapers(); this.listEl.scrollTop = saved.scrollTop ?? 0;
  }
  syncPaper(paperId: string, inLib: boolean, docId?: string): void { for (const p of this.papers) if (p.id === paperId) this.applyPaper(p, inLib, docId); }
  reconcileMissing(isMissing: (docId: string, paperId: string) => boolean): void {
    for (const p of this.papers) { const id = p.docId || p.localDocId; if (id && isMissing(id, p.id)) this.applyPaper(p, false); }
  }

  private applyPaper(p: TrendPaper, inLib: boolean, docId?: string): void {
    p.inLibrary = inLib; p.docId = p.localDocId = inLib ? docId : undefined;
    const s = this.slots.get(p.id); if (this.mounted && s) this.renderSlot(s, p);
  }

  private abortPending(): void { ++this.reqSeq; this.ctrl?.abort(); this.ctrl = null; }
  private syncTabs(): void { for (const [k, b] of this.sortBtns) b.setAttribute('aria-pressed', String(k === this.sort)); }
  private renderHeader(): void {
    if (!this.target) return;
    this.titleEl.textContent = this.target.topicName;
    const yr = this.target.isYtd ? `${this.target.year}* YTD` : String(this.target.year);
    this.subEl.textContent = this.sort === 'library' ? t(`Library papers · ${this.target.query}`, `本地库文献 · ${this.target.query}`) : `${yr} · ${this.target.query}`;
  }
  private async load(): Promise<void> {
    const tgt = this.target; if (!tgt) return;
    this.abortPending(); const seq = this.reqSeq; this.ctrl = new AbortController();
    this.renderHeader(); this.syncTabs(); this.listEl.replaceChildren(); this.slots.clear();
    this.statusEl.textContent = t('Loading papers…', '正在加载论文…');
    try {
      const res = await api('trends.papers', { query: tgt.query, topicId: tgt.topicId, topicName: tgt.topicName, year: tgt.year, source: tgt.source, sort: this.sort, limit: 15 }, false, this.ctrl.signal);
      if (!this.mounted || seq !== this.reqSeq) return;
      this.papers = res.papers.map(p => { const n = normalizePaper(p); if (this.cb.savingIds.has(n.id)) n.inLibrary = true; return n; });
      this.degraded = res.degraded; this.fromCache = res.fromCache; this.cachedAt = res.cachedAt; this.renderPapers();
    } catch (err) { if (this.mounted && seq === this.reqSeq && !isAbortError(err)) { this.statusEl.textContent = message(err); toast(message(err)); } }
  }
  private renderPapers(): void {
    this.slots.clear(); this.listEl.replaceChildren();
    const notes = [this.degraded.length ? formatDegradedSources(this.degraded) : '', this.fromCache ? formatCachedAt(this.cachedAt) : ''].filter(Boolean);
    const status = notes.map((s, i) => i < notes.length - 1 ? s.replace(/[.。]\s*$/, '') : s).join(' · ');
    if (!this.papers.length) {
      this.statusEl.textContent = status || (this.sort === 'library' ? t('No matching papers in your library for this subtopic yet.', '本地库中暂无该子方向的匹配文献。') : t('No papers returned for this topic and year.', '该子方向该年份暂未返回论文。'));
      return;
    }
    this.statusEl.textContent = status;
    for (const p of this.papers) {
      const card = el('article', 'ft-paper-card'); card.dataset.paperId = p.id;
      const authors = p.authors.length > 4 ? `${p.authors.slice(0, 4).join(', ')} et al.` : p.authors.join(', ');
      const meta = [authors, p.year ? String(p.year) : '', p.venue ?? '', p.citationCount !== undefined ? t(`${p.citationCount} citations`, `${p.citationCount} 次被引`) : ''].filter(Boolean).join(' · ');
      const href = safeWeb(p.url) ?? (p.doi ? safeWeb('https://doi.org/' + encodeURIComponent(p.doi)) : undefined);
      if (href) { const a = el('a', 'ft-paper-title', p.title); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; card.append(a); }
      else card.append(el('h3', 'ft-paper-title', p.title));
      const act = el('div', 'ft-paper-actions'); this.renderSlot(act, p);
      card.append(el('p', 'ft-paper-meta', meta), el('p', 'ft-paper-abs', clipAbstract(p.abstract)), act);
      this.listEl.append(card); this.slots.set(p.id, act);
      this.cb.shell()?.paperFloatBar?.attach(card, { paper: p, onSaved: doc => { p.inLibrary = true; p.docId = p.localDocId = doc.id; this.cb.onPaperSynced(p.id, true, doc.id); if (this.target) this.cb.onCoverageConfirmed(this.target.topicId, doc.id); } });
    }
  }
  private renderSlot(slot: HTMLElement, paper: TrendPaper): void {
    renderPaperActions(slot, paper, { prefix: 'ft', busy: this.cb.savingIds.has(paper.id), openLabel: t('Open', '打开'), onOpen: docId => { void this.cb.shell()?.inspectInReader({ docId, page: 1 }).catch(e => toast(message(e))); }, onSave: mode => { void this.saveInPlace(paper, mode); } });
  }
  private async saveInPlace(paper: TrendPaper, saveMode: 'abstract' | 'oa-pdf'): Promise<void> {
    if (this.cb.savingIds.has(paper.id) || !this.target) return;
    const topicId = this.target.topicId, prevInLib = Boolean(paper.inLibrary), prevDocId = paper.docId;
    const apply = (inLib: boolean, docId?: string) => { paper.inLibrary = inLib; paper.docId = paper.localDocId = inLib ? docId : undefined; this.cb.onPaperSynced(paper.id, inLib, docId); };
    this.cb.savingIds.add(paper.id); apply(true, prevDocId); if (!prevInLib) this.cb.onCoverageDelta(topicId, 1);
    try {
      const doc = await saveGraphPaper(paper, saveMode, this.cb.shell());
      this.cb.savingIds.delete(paper.id); apply(true, doc.id); this.cb.onCoverageConfirmed(topicId, doc.id);
    } catch (err) {
      this.cb.savingIds.delete(paper.id); apply(prevInLib, prevDocId);
      if (!prevInLib) this.cb.onCoverageDelta(topicId, -1); toast(message(err));
    }
  }
  private triggerDeepSearch(): void {
    const tgt = this.target, shell = this.cb.shell(); if (!tgt || !shell) return;
    const name = tgt.topicName.replace(/\s*\(Europe PMC \/ PubMed\)$/i, '').trim();
    shell.openView('deep-search', { query: name.toLowerCase().includes(tgt.query.toLowerCase()) ? name : `${name} ${tgt.query}`.trim() });
  }
}
