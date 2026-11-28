import { LIBRARY_PAGE_SIZE, rankDocsByRelevance, slicePage } from '../../shared/library-relevance.js';
import type { ReviewDecision, ReviewExportFormat, ReviewRerankResult } from '../../shared/review-types.js';
import type { DocumentInfo, TopicRecord } from '../../shared/types.js';
import { el, message, toast } from '../ui.js';
import { researchText } from './labels.js';
import { isAbortError, mkBtn } from './paper-intake.js';

export type ReviewTriageStep = 'screening' | 'extraction';
export interface SavedTriageState { topicQuery: string; tagFilter: string; topicScope: 'matches' | 'all'; extractScope: 'included' | 'all' }
interface TriageViewResult { pageItems: DocumentInfo[]; filtered: DocumentInfo[]; totalCount: number; matchedCount: number; includedCount: number; hasQuery: boolean; hasMore: boolean }
interface TriageCallbacks {
  onChange: () => void; onBulkDecision: (docIds: string[], decision: ReviewDecision) => Promise<void>;
  onBulkScreen: (docIds: string[]) => Promise<void>; onBulkExtract: (docIds: string[]) => Promise<void>;
  onBulkExport: (docIds: string[], format: ReviewExportFormat) => void;
  onRerank: (topic: string, docIds: string[], signal: AbortSignal) => Promise<ReviewRerankResult>;
}
const TOP_INCLUDE_CAP = 10;

export class ReviewTriageBar {
  readonly barEl = el('div', 'rt-triage-bar'); readonly bulkEl = el('div', 'rt-bulk-bar'); readonly pagerEl = el('div', 'rt-pager');
  private readonly topicIn = el('input', 'search rt-topic-in'); private readonly tagSel = el('select', 'rt-select rt-tag-filter');
  private readonly topicSeg = el('div', 'rt-seg rt-topic-seg'); private readonly extractSeg = el('div', 'rt-seg rt-extract-seg');
  private readonly pagerCount = el('span', 'rt-pager-count');
  private readonly matchesBtn: HTMLButtonElement; private readonly allLibBtn: HTMLButtonElement;
  private readonly incOnlyBtn: HTMLButtonElement; private readonly extAllBtn: HTMLButtonElement;
  private readonly rerankBtn: HTMLButtonElement; private readonly rerankStopBtn: HTMLButtonElement;
  private readonly includeTopBtn: HTMLButtonElement; private readonly selVisBtn: HTMLButtonElement;
  private readonly selMatchedBtn: HTMLButtonElement; private readonly showMoreBtn: HTMLButtonElement;
  private topicQuery = ''; private tagFilter = ''; private aiTopic = '';
  private topicScope: 'matches' | 'all' = 'matches'; private extractScope: 'included' | 'all' = 'included';
  private pageLimit = LIBRARY_PAGE_SIZE; private step: ReviewTriageStep = 'extraction';
  private busy = false; private reranking = false; private rerankAbort: AbortController | null = null;
  private aiScores = new Map<string, { score: number; rationale?: string }>();
  private scores = new Map<string, { score: number; ai: boolean; rationale?: string }>();
  private selectedIds = new Set<string>(); private lastClickedId: string | null = null;
  private visibleOrder: string[] = []; private matchedIds: string[] = []; private rerankCandidateIds: string[] = [];
  private domHost: HTMLElement | null = null;

  constructor(private readonly cb: TriageCallbacks) {
    Object.assign(this.topicIn, { type: 'search', maxLength: 300, placeholder: researchText.triageTopicPlaceholder(), ariaLabel: researchText.triageTopicLabel() });
    this.topicIn.addEventListener('input', () => { this.topicQuery = this.topicIn.value; this.pageLimit = LIBRARY_PAGE_SIZE; if (this.aiTopic !== this.topicQuery.trim()) { this.aiTopic = ''; this.aiScores.clear(); } this.cb.onChange(); });
    this.tagSel.ariaLabel = researchText.triageTagLabel();
    this.tagSel.addEventListener('change', () => { this.tagFilter = this.tagSel.value; this.pageLimit = LIBRARY_PAGE_SIZE; this.cb.onChange(); });
    const segBtn = (attr: 'scope' | 'extractScope', val: string, fn: () => void) => { const b = mkBtn('btn rt-seg-btn', '', fn); b.dataset[attr] = val; return b; };
    this.matchesBtn = segBtn('scope', 'matches', () => { if (this.topicScope !== 'matches') { this.topicScope = 'matches'; this.pageLimit = LIBRARY_PAGE_SIZE; this.cb.onChange(); } });
    this.allLibBtn = segBtn('scope', 'all', () => { if (this.topicScope !== 'all') { this.topicScope = 'all'; this.pageLimit = LIBRARY_PAGE_SIZE; this.cb.onChange(); } });
    this.topicSeg.setAttribute('role', 'group'); this.topicSeg.append(this.matchesBtn, this.allLibBtn);
    this.incOnlyBtn = segBtn('extractScope', 'included', () => { if (this.extractScope !== 'included') { this.extractScope = 'included'; this.pageLimit = LIBRARY_PAGE_SIZE; this.cb.onChange(); } });
    this.extAllBtn = segBtn('extractScope', 'all', () => { if (this.extractScope !== 'all') { this.extractScope = 'all'; this.pageLimit = LIBRARY_PAGE_SIZE; this.cb.onChange(); } });
    this.extractSeg.setAttribute('role', 'group'); this.extractSeg.append(this.incOnlyBtn, this.extAllBtn);
    this.rerankBtn = mkBtn('btn rt-rerank-btn', researchText.triageAiRerank(), () => { void this.runRerank(); });
    this.rerankStopBtn = mkBtn('btn rt-rerank-stop', researchText.stop(), () => this.rerankAbort?.abort()); this.rerankStopBtn.hidden = true;
    this.includeTopBtn = mkBtn('btn rt-include-top-btn', '', () => { const t = this.matchedIds.slice(0, TOP_INCLUDE_CAP); if (t.length) void this.cb.onBulkDecision(t, 'yes'); });
    this.selVisBtn = mkBtn('btn rt-sel-vis-btn', researchText.triageSelectVisible(), () => this.toggleVisibleSelection());
    this.selMatchedBtn = mkBtn('btn rt-sel-matched-btn', '', () => { for (const id of this.matchedIds) this.selectedIds.add(id); this.syncSelectionUi(); });
    this.barEl.append(this.topicIn, this.tagSel, this.topicSeg, this.extractSeg, this.rerankBtn, this.rerankStopBtn, this.includeTopBtn, this.selVisBtn, this.selMatchedBtn);
    this.bulkEl.hidden = true; this.bulkEl.setAttribute('role', 'region'); this.bulkEl.ariaLabel = researchText.paperActions();
    this.showMoreBtn = mkBtn('btn rt-show-more-btn', researchText.triageShowMore(LIBRARY_PAGE_SIZE), () => { this.pageLimit += LIBRARY_PAGE_SIZE; this.cb.onChange(); });
    this.pagerEl.append(this.pagerCount, this.showMoreBtn); this.pagerEl.hidden = true;
  }

  bindHost(host: HTMLElement): void { this.domHost = host; }
  setVisibleOrder(ids: string[]): void { this.visibleOrder = ids; this.syncSelectionUi(); }
  setBusy(busy: boolean): void { this.busy = busy; this.syncControlsDisabled(); }
  abort(): void { this.rerankAbort?.abort(); this.rerankAbort = null; this.reranking = false; }
  clearSelection(): void { this.selectedIds.clear(); this.lastClickedId = null; this.syncSelectionUi(); }
  makeEmptyNode(): HTMLElement { const box = el('div', 'rt-empty'); box.append(el('p', '', researchText.triageNoMatches()), mkBtn('btn rt-show-all-btn', researchText.triageShowAll(), () => this.resetFilters())); return box; }
  resetFilters(): void { this.topicQuery = this.topicIn.value = this.tagFilter = this.tagSel.value = this.aiTopic = ''; this.topicScope = 'matches'; this.extractScope = 'all'; this.pageLimit = LIBRARY_PAGE_SIZE; this.aiScores.clear(); this.cb.onChange(); }
  saveState(): SavedTriageState { return { topicQuery: this.topicQuery, tagFilter: this.tagFilter, topicScope: this.topicScope, extractScope: this.extractScope }; }
  restoreState(s?: SavedTriageState): void { if (!s) return; this.topicQuery = this.topicIn.value = s.topicQuery ?? ''; this.tagFilter = s.tagFilter ?? ''; this.topicScope = s.topicScope ?? 'matches'; this.extractScope = s.extractScope ?? 'included'; }
  syncTags(docs: readonly DocumentInfo[], topics: readonly TopicRecord[]): void {
    const tagMap = new Map<string, string>();
    for (const tp of topics) { const tag = tp.tag || tp.name; if (tag) tagMap.set(tag, tp.name && tp.name !== tag ? `${tp.name} (#${tag})` : tag); }
    for (const d of docs) for (const tag of d.meta?.tags ?? []) if (tag && !/^screen:/i.test(tag) && !tagMap.has(tag)) tagMap.set(tag, tag);
    if (this.tagFilter && !tagMap.has(this.tagFilter)) this.tagFilter = '';
    this.tagSel.replaceChildren(new Option(researchText.triageTagAll(), ''), ...[...tagMap.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([v, l]) => new Option(l, v)));
    this.tagSel.value = this.tagFilter;
  }
  computeView(docs: readonly DocumentInfo[], step: ReviewTriageStep, isIncluded: (doc: DocumentInfo) => boolean): TriageViewResult {
    this.step = step;
    const validIds = new Set(docs.map(d => d.id));
    for (const id of [...this.selectedIds]) if (!validIds.has(id)) this.selectedIds.delete(id);
    const tagged = this.tagFilter ? docs.filter(d => d.meta?.tags?.includes(this.tagFilter)) : [...docs], q = this.topicQuery.trim(), hasQuery = q.length > 0;
    this.scores.clear();
    let ordered = tagged, matchedCount = 0;
    if (hasQuery) {
      const bm25Map = new Map(rankDocsByRelevance(q, tagged).map((m, idx) => [m.docId, { score: m.score, idx }])), useAi = this.aiTopic === q && this.aiScores.size > 0;
      for (const d of tagged) {
        const ai = useAi ? this.aiScores.get(d.id) : undefined, score = ai ? ai.score : (bm25Map.get(d.id)?.score ?? 0);
        if (score > 0 || ai) this.scores.set(d.id, { score, ai: Boolean(ai), rationale: ai?.rationale });
      }
      ordered = [...tagged].sort((a, b) => (this.scores.get(b.id)?.score ?? 0) - (this.scores.get(a.id)?.score ?? 0) || (bm25Map.get(b.id)?.score ?? 0) - (bm25Map.get(a.id)?.score ?? 0) || (bm25Map.get(a.id)?.idx ?? 0) - (bm25Map.get(b.id)?.idx ?? 0));
      this.matchedIds = ordered.filter(d => (this.scores.get(d.id)?.score ?? 0) > 0).map(d => d.id); matchedCount = this.matchedIds.length;
      this.rerankCandidateIds = (matchedCount ? this.matchedIds : ordered.map(d => d.id)).slice(0, 40);
      if (this.topicScope === 'matches') ordered = ordered.filter(d => (this.scores.get(d.id)?.score ?? 0) > 0);
    } else { this.matchedIds = []; this.rerankCandidateIds = []; }
    const includedList = ordered.filter(isIncluded), filtered = step === 'extraction' && this.extractScope === 'included' ? includedList : ordered, page = slicePage(filtered, this.pageLimit);
    this.visibleOrder = page.items.map(d => d.id);
    this.syncBarUi(docs.length, tagged.length, matchedCount, includedList.length, ordered.length, page.shown, filtered.length, page.hasMore, hasQuery);
    this.syncSelectionUi();
    return { pageItems: page.items, filtered, totalCount: docs.length, matchedCount, includedCount: includedList.length, hasQuery, hasMore: page.hasMore };
  }
  makeRelevancePill(docId: string): HTMLElement | null {
    const entry = this.scores.get(docId); if (!entry) return null;
    const pill = el('span', 'rt-rel-pill', `${entry.ai ? '★ ' : ''}${entry.score}%`);
    pill.dataset.tier = entry.score >= 70 ? 'high' : entry.score >= 35 ? 'mid' : 'low';
    pill.dataset.ai = String(entry.ai); pill.title = researchText.triageRelTitle(entry.score, entry.ai, entry.rationale); return pill;
  }
  makeCheckbox(docId: string): HTMLLabelElement {
    const wrap = el('label', 'rt-check-wrap'), input = el('input', 'rt-check');
    input.type = 'checkbox'; input.dataset.docId = docId; input.checked = this.selectedIds.has(docId); input.ariaLabel = researchText.selectPaper();
    input.addEventListener('click', e => {
      e.stopPropagation(); const checked = input.checked;
      if (e.shiftKey && this.lastClickedId && this.lastClickedId !== docId) {
        const a = this.visibleOrder.indexOf(this.lastClickedId), b = this.visibleOrder.indexOf(docId);
        if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { if (checked) this.selectedIds.add(this.visibleOrder[i]); else this.selectedIds.delete(this.visibleOrder[i]); }
      } else { if (checked) this.selectedIds.add(docId); else this.selectedIds.delete(docId); }
      this.lastClickedId = docId; this.syncSelectionUi();
    });
    wrap.append(input); return wrap;
  }
  makeHeaderCheckbox(): HTMLLabelElement {
    const wrap = el('label', 'rt-check-wrap rt-head-check-wrap'), input = el('input', 'rt-check rt-head-check');
    input.type = 'checkbox'; input.ariaLabel = researchText.triageSelectVisible();
    input.addEventListener('click', e => { e.stopPropagation(); this.toggleVisibleSelection(); });
    wrap.append(input); this.syncHeadCheckbox(input); return wrap;
  }

  private toggleVisibleSelection(): void {
    const allSel = this.visibleOrder.length > 0 && this.visibleOrder.every(id => this.selectedIds.has(id));
    for (const id of this.visibleOrder) { if (allSel) this.selectedIds.delete(id); else this.selectedIds.add(id); }
    this.syncSelectionUi();
  }
  private syncHeadCheckbox(input: HTMLInputElement): void {
    const sel = this.visibleOrder.filter(id => this.selectedIds.has(id)).length;
    input.checked = this.visibleOrder.length > 0 && sel === this.visibleOrder.length;
    input.indeterminate = sel > 0 && sel < this.visibleOrder.length;
  }
  private syncBarUi(total: number, tagged: number, matched: number, inc: number, extAll: number, shown: number, filtered: number, hasMore: boolean, hasQuery: boolean): void {
    this.topicSeg.hidden = !hasQuery; this.matchesBtn.textContent = researchText.triageMatches(matched); this.matchesBtn.setAttribute('aria-pressed', String(this.topicScope === 'matches'));
    this.allLibBtn.textContent = researchText.triageAllLibrary(tagged); this.allLibBtn.setAttribute('aria-pressed', String(this.topicScope === 'all'));
    this.extractSeg.hidden = this.step !== 'extraction'; this.incOnlyBtn.textContent = researchText.triageIncludedToggle(inc); this.incOnlyBtn.setAttribute('aria-pressed', String(this.extractScope === 'included'));
    this.extAllBtn.textContent = researchText.triageAllToggle(extAll); this.extAllBtn.setAttribute('aria-pressed', String(this.extractScope === 'all'));
    this.rerankBtn.hidden = !hasQuery; this.rerankBtn.textContent = this.reranking ? researchText.triageReranking() : researchText.triageAiRerank(); this.rerankStopBtn.hidden = !this.reranking;
    this.includeTopBtn.hidden = !hasQuery || matched === 0; this.includeTopBtn.textContent = matched > TOP_INCLUDE_CAP ? researchText.triageIncludeTop(TOP_INCLUDE_CAP) : researchText.triageIncludeMatches(matched);
    this.selMatchedBtn.hidden = !hasQuery || matched === 0; this.selMatchedBtn.textContent = researchText.triageSelectMatched(matched);
    this.selVisBtn.disabled = shown === 0; this.pagerEl.hidden = total === 0;
    this.pagerCount.textContent = researchText.triageShowing(shown, filtered, total); this.showMoreBtn.hidden = !hasMore;
    this.syncControlsDisabled();
  }
  private syncSelectionUi(): void {
    const n = this.selectedIds.size; this.bulkEl.hidden = n === 0;
    if (this.domHost) {
      for (const cb of this.domHost.querySelectorAll<HTMLInputElement>('.rt-check[data-doc-id]')) cb.checked = this.selectedIds.has(cb.dataset.docId!);
      for (const h of this.domHost.querySelectorAll<HTMLInputElement>('.rt-head-check')) this.syncHeadCheckbox(h);
    }
    if (!n) { this.bulkEl.replaceChildren(); return; }
    const ids = [...this.selectedIds], act = (cls: string, lbl: string, key: string, fn: () => void) => { const b = mkBtn(cls, lbl, fn); b.dataset.bulk = key; return b; };
    const btns = this.step === 'screening'
      ? [act('btn primary rt-bulk-inc', researchText.triageIncludeN(n), 'yes', () => { void this.cb.onBulkDecision(ids, 'yes'); }), act('btn rt-bulk-maybe', researchText.triageMaybeN(n), 'maybe', () => { void this.cb.onBulkDecision(ids, 'maybe'); }), act('btn rt-bulk-exc', researchText.triageExcludeN(n), 'no', () => { void this.cb.onBulkDecision(ids, 'no'); }), act('btn rt-bulk-screen', researchText.triageAiScreenN(n), 'screen', () => { void this.cb.onBulkScreen(ids); })]
      : [act('btn primary rt-bulk-extract', researchText.triageExtractN(n), 'extract', () => { void this.cb.onBulkExtract(ids); }), act('btn rt-bulk-export', researchText.triageExportN(n), 'export-md', () => this.cb.onBulkExport(ids, 'markdown')), act('btn rt-bulk-export-csv', 'CSV', 'export-csv', () => this.cb.onBulkExport(ids, 'csv')), act('btn rt-bulk-exclude', researchText.triageMoveExcluded(), 'no', () => { void this.cb.onBulkDecision(ids, 'no'); })];
    this.bulkEl.replaceChildren(el('span', 'rt-bulk-count', researchText.triageSelectedCount(n)), ...btns, mkBtn('btn rt-bulk-clear', researchText.triageClearSel(), () => this.clearSelection()));
    this.syncControlsDisabled();
  }
  private syncControlsDisabled(): void {
    const dis = this.busy || this.reranking;
    this.rerankBtn.disabled = dis || !this.rerankCandidateIds.length; this.includeTopBtn.disabled = dis;
    for (const b of this.bulkEl.querySelectorAll<HTMLButtonElement>('button:not(.rt-bulk-clear)')) b.disabled = dis;
  }
  private async runRerank(): Promise<void> {
    const topic = this.topicQuery.trim();
    if (!topic || !this.rerankCandidateIds.length || this.reranking || this.busy) return;
    const ctrl = new AbortController(); this.reranking = true; this.rerankAbort = ctrl; this.rerankStopBtn.hidden = false; this.rerankBtn.textContent = researchText.triageReranking(); this.syncControlsDisabled();
    try {
      const res = await this.cb.onRerank(topic, this.rerankCandidateIds, ctrl.signal);
      if (this.rerankAbort !== ctrl) return;
      if (res.scores.length) { this.aiTopic = topic; this.aiScores = new Map(res.scores.map(s => [s.docId, { score: s.score, rationale: s.rationale }])); toast(researchText.triageRerankDone(res.scores.length)); }
      if (res.degraded) toast(researchText.triageRerankDegraded());
      this.cb.onChange();
    } catch (err) { if (this.rerankAbort === ctrl && !isAbortError(err)) toast(message(err)); }
    finally { if (this.rerankAbort === ctrl) { this.rerankAbort = null; this.reranking = false; this.rerankStopBtn.hidden = true; this.rerankBtn.textContent = researchText.triageAiRerank(); this.syncControlsDisabled(); } }
  }
}
