import { REVIEW_PRESET_IDS, SUGGESTED_REVIEW_COLUMNS, type ExtractionCell, type ReviewColumn, type ReviewColumnType, type ReviewDecision, type ReviewPresetId } from '../../shared/review-types.js';
import type { DocumentInfo } from '../../shared/types.js';
import { abstractOnlyLabel } from '../abstract-view.js';
import { mountDocResourcesPanel } from '../doc-resources-panel.js';
import { el, readerLabel as t } from '../ui.js';
import { researchIcon, type ResearchIconName } from './icons.js';
import { researchText, researchViewName } from './labels.js';
import { mkBtn } from './paper-intake.js';

export type ReviewPaperAction = 'read' | 'ask-ai' | 'citations' | 'citation-map';
interface InspectorTarget { doc: DocumentInfo; colId: string; colLabel: string; isScreening: boolean; cell?: ExtractionCell }
interface InspectorCallbacks {
  onClose: () => void; onSaveOverride: (docId: string, colId: string, value: string, reasoning?: string) => Promise<void>;
  onRetry: (docId: string, colId: string) => Promise<void>; onJump: (docId: string, page: number, quote?: string) => void;
  onPaperAction?: (action: ReviewPaperAction, doc: DocumentInfo) => void; onAttachPaperHead?: (el: HTMLElement, doc: DocumentInfo) => void;
}
const COL_ZH: Readonly<Record<string, string>> = {
  research_question: '研究问题', method: '方法', key_findings: '核心发现', datasets: '数据集', key_metrics: '核心指标', main_result: '主要结果', limitations: '局限性',
  population: '研究人群 (P)', intervention: '干预措施 (I)', comparator: '对照组 (C)', outcome: '结局指标 (O)', study_design: '研究设计',
  sample_size: '样本量', code_repo: '代码仓库', primary_endpoint: '主要终点', adverse_events: '不良事件'
};
const PRESET_LABEL: Record<ReviewPresetId, () => string> = {
  general: () => researchText.presetGeneral(), cs_ai: () => researchText.presetCsAi(),
  pico: () => researchText.presetPico(), custom: () => researchText.presetCustom()
};
const PAPER_ACTIONS: readonly { key: ReviewPaperAction; icon: ResearchIconName; label: () => string }[] = [
  { key: 'read', icon: 'read', label: () => researchText.readMode() },
  { key: 'ask-ai', icon: 'ask-ai', label: () => researchText.askAi() },
  { key: 'citations', icon: 'citations', label: () => researchViewName('citations') },
  { key: 'citation-map', icon: 'citation-map', label: () => researchViewName('citation-map') }
];
const SUG_HINT_ZH: Readonly<Record<string, string>> = { sample_size: '参与者或评测样本总量。', code_repo: '公开代码仓库或复现资源链接。', primary_endpoint: '预设的主要临床或实验终点指标。', adverse_events: '报告的安全性表现与主要不良事件。' };
export const reviewColLabel = (col: Pick<ReviewColumn, 'id' | 'name'>): string => Object.hasOwn(COL_ZH, col.id) ? t(col.name, COL_ZH[col.id]) : col.name;
export const coverageLabel = (kind: DocumentInfo['kind']): string => kind === 'abstract' ? abstractOnlyLabel() : t('Full text', '全文');
export const decisionLabel = (d: ReviewDecision): string => d === 'yes' ? t('Yes', '纳入') : d === 'no' ? t('No', '排除') : t('Maybe', '待定');
export function cellBadgeInfo(cell?: ExtractionCell): { kind: 'manual' | 'verified' | 'unverified' | 'error' | 'empty'; short: string; full: string } {
  if (!cell) return { kind: 'empty', short: '', full: t('Not extracted yet', '尚未提取') };
  if (cell.status === 'error') return { kind: 'error', short: '!', full: t('! Failed', '! 提取失败') };
  if (cell.manualOverride) return { kind: 'manual', short: '✎', full: t('✎ Manual', '✎ 人工覆写') };
  if (cell.verified) return { kind: 'verified', short: '✓', full: '✓ Verified' };
  return cell.value ? { kind: 'unverified', short: '⚠', full: '⚠ Unverified' } : { kind: 'empty', short: '', full: t('Not extracted yet', '尚未提取') };
}
export function slugColumnId(name: string, existing: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'col';
  const safe = base === '__screen__' || base.startsWith('screen:') ? `col_${base}` : base;
  if (!existing.has(safe)) return safe;
  let i = 2; while (existing.has(`${safe}_${i}`)) i++; return `${safe}_${i}`;
}
const bindEsc = (node: HTMLElement, close: () => void) => node.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(); } });
const closeIconBtn = (cls: string, label: string, onClick: () => void) => {
  const b = el('button', `icon-btn ${cls}`); b.type = 'button'; b.ariaLabel = b.title = label; b.append(researchIcon('close', 16)); b.addEventListener('click', onClick); return b;
};

export class ReviewTableInspector {
  readonly backdrop = el('div', 'rt-insp-backdrop'); readonly root = el('aside', 'rt-inspector');
  private readonly headEl = el('div', 'rt-insp-head');
  private readonly titleEl = el('h2', 'rt-insp-title'); private readonly subEl = el('div', 'rt-insp-sub');
  private readonly cellBody = el('div', 'rt-insp-body'); private readonly cellFoot = el('div', 'rt-insp-foot');
  private readonly paperBody = el('div', 'rt-insp-body rt-insp-paper-body'); private readonly paperFoot = el('div', 'rt-insp-foot');
  private readonly statusRow = el('div', 'rt-insp-status'); private readonly quotePageEl = el('span', 'rt-insp-page');
  private readonly quoteEl = el('blockquote', 'rt-insp-quote'); private readonly reasonEl = el('p', 'rt-insp-reason');
  private readonly valueArea = el('textarea', 'rt-insp-textarea'); private readonly decSelect = el('select', 'rt-select rt-insp-dec');
  private readonly reasonIn = el('input', 'search rt-insp-reason-in');
  private readonly saveBtn = el('button', 'btn primary rt-insp-save', t('Save override', '保存覆写'));
  private readonly jumpBtn = el('button', 'btn primary rt-insp-jump');
  private readonly retryBtn = el('button', 'btn rt-insp-retry', t('Retry cell', '重抽此格'));
  private readonly paperTagsSec = el('section', 'rt-insp-sec'); private readonly paperTagsEl = el('div', 'rt-insp-tags');
  private readonly paperResSec = el('div', 'rt-insp-res');
  private readonly paperAbsEl = el('p', 'rt-insp-abstract');
  private readonly paperReadBtn = el('button', 'btn primary rt-insp-open', `${researchText.openInReader()} ↗`);
  private target: InspectorTarget | null = null; private paperDoc: DocumentInfo | null = null; private busy = false;

  constructor(private readonly cb: InspectorCallbacks) {
    this.backdrop.hidden = this.root.hidden = true;
    this.backdrop.addEventListener('click', () => this.close()); bindEsc(this.root, () => this.close());
    this.root.setAttribute('aria-label', t('Evidence Inspector', 'Evidence 证据核验'));
    const headText = el('div', 'rt-insp-head-text');
    headText.append(this.titleEl, this.subEl);
    this.headEl.append(headText, closeIconBtn('rt-insp-close', t('Close panel', '关闭侧栏'), () => this.close()));
    const qHead = el('div', 'rt-insp-sec-head'), qSec = el('section', 'rt-insp-sec'), rSec = el('section', 'rt-insp-sec'), form = el('form', 'rt-insp-edit');
    qHead.append(el('span', 'rt-insp-label', t('Verbatim Quote', '原文引句')), this.quotePageEl); qSec.append(qHead, this.quoteEl);
    rSec.append(el('span', 'rt-insp-label', t('Reasoning', '判断依据')), this.reasonEl);
    this.valueArea.rows = 3; this.valueArea.ariaLabel = t('Manual override value', '人工覆写内容'); this.valueArea.placeholder = t('Edit extracted value…', '编辑提取内容…');
    this.decSelect.ariaLabel = t('Screening decision', '筛选结论');
    for (const d of ['yes', 'maybe', 'no'] as const) this.decSelect.append(new Option(decisionLabel(d), d));
    this.reasonIn.type = 'text'; this.reasonIn.ariaLabel = t('Override note', '覆写说明'); this.reasonIn.placeholder = t('Optional note…', '可选说明…');
    this.saveBtn.type = 'submit';
    form.append(el('span', 'rt-insp-label', t('✎ Manual override', '✎ 人工覆写')), this.decSelect, this.reasonIn, this.valueArea, this.saveBtn);
    form.addEventListener('submit', e => {
      e.preventDefault(); if (!this.target || this.busy) return;
      const val = this.target.isScreening ? this.decSelect.value : this.valueArea.value.trim(); if (!val) return;
      void this.cb.onSaveOverride(this.target.doc.id, this.target.colId, val, this.target.isScreening ? (this.reasonIn.value.trim() || undefined) : undefined);
    });
    this.cellBody.append(this.statusRow, qSec, rSec, form);
    this.jumpBtn.type = this.retryBtn.type = this.paperReadBtn.type = 'button';
    this.jumpBtn.addEventListener('click', () => { if (this.target) this.cb.onJump(this.target.doc.id, this.target.cell?.page ?? 1, this.target.cell?.quote || undefined); });
    this.retryBtn.addEventListener('click', () => { if (this.target && !this.busy) void this.cb.onRetry(this.target.doc.id, this.target.colId); });
    this.cellFoot.append(this.jumpBtn, this.retryBtn);
    const actSec = el('section', 'rt-insp-sec'), actRow = el('div', 'rt-paper-actions');
    actRow.setAttribute('role', 'group'); actRow.ariaLabel = researchText.paperQuickActions();
    for (const def of PAPER_ACTIONS) {
      const btn = el('button', 'btn rt-paper-action'); btn.type = 'button'; btn.dataset.action = def.key;
      btn.append(researchIcon(def.icon, 18), el('span', '', def.label()));
      btn.addEventListener('click', () => { if (this.paperDoc) this.cb.onPaperAction?.(def.key, this.paperDoc); });
      actRow.append(btn);
    }
    actSec.append(el('span', 'rt-insp-label', researchText.paperQuickActions()), actRow);
    this.paperTagsSec.append(el('span', 'rt-insp-label', researchText.tagsHeading()), this.paperTagsEl);
    const absSec = el('section', 'rt-insp-sec');
    absSec.append(el('span', 'rt-insp-label', researchText.abstractHeading()), this.paperAbsEl);
    this.paperBody.append(actSec, this.paperTagsSec, this.paperResSec, absSec);
    this.paperReadBtn.addEventListener('click', () => { if (this.paperDoc) this.cb.onPaperAction?.('read', this.paperDoc); });
    this.paperFoot.append(this.paperReadBtn);
    this.paperBody.hidden = this.paperFoot.hidden = true;
    this.root.append(this.headEl, this.cellBody, this.cellFoot, this.paperBody, this.paperFoot);
  }

  isOpen(): boolean { return (this.target !== null || this.paperDoc !== null) && !this.root.hidden; }
  setBusy(busy: boolean): void { this.busy = busy; this.saveBtn.disabled = this.retryBtn.disabled = busy; }
  close(): void { if (!this.target && !this.paperDoc && this.root.hidden) return; this.target = null; this.paperDoc = null; this.backdrop.hidden = this.root.hidden = true; this.cb.onClose(); }
  show(target: InspectorTarget): void {
    this.target = target; this.paperDoc = null; this.backdrop.hidden = this.root.hidden = false;
    this.cellBody.hidden = this.cellFoot.hidden = false; this.paperBody.hidden = this.paperFoot.hidden = true;
    this.root.setAttribute('aria-label', t('Evidence Inspector', 'Evidence 证据核验'));
    const { doc, cell, colLabel, isScreening } = target, badge = cellBadgeInfo(cell);
    this.titleEl.textContent = doc.paperTitle || doc.title;
    this.subEl.replaceChildren(el('span', 'rt-insp-col', colLabel), el('span', `rt-src-badge ${doc.kind === 'abstract' ? 'is-abstract' : 'is-pdf'}`, coverageLabel(doc.kind)));
    this.statusRow.replaceChildren(el('span', `rt-badge is-${badge.kind}`, badge.full));
    if (cell?.sourceKind === 'abstract' && doc.kind !== 'abstract') this.statusRow.append(el('span', 'rt-stale-note', t('From abstract — PDF attached', '源自摘要，已附加 PDF')));
    this.quotePageEl.textContent = cell?.page ? t(`p. ${cell.page}`, `第 ${cell.page} 页`) : doc.kind === 'abstract' ? researchText.abstractHeading() : '';
    this.quoteEl.textContent = cell?.quote || t('No verbatim quote captured.', '未捕获原文引句。');
    this.reasonEl.textContent = cell?.reasoning || t('No reasoning recorded yet.', '暂无判断依据。');
    this.decSelect.hidden = this.reasonIn.hidden = !isScreening; this.valueArea.hidden = isScreening;
    if (isScreening) { const v = cell?.value?.toLowerCase(); this.decSelect.value = v === 'yes' || v === 'no' || v === 'maybe' ? v : 'maybe'; this.reasonIn.value = cell?.reasoning ?? ''; }
    else this.valueArea.value = cell?.value ?? '';
    this.jumpBtn.textContent = doc.kind === 'abstract' ? t('Open Abstract ↗', '打开摘要 ↗') : t(`Jump to p. ${cell?.page ?? 1} ↗`, `跳原文第 ${cell?.page ?? 1} 页 ↗`);
    this.retryBtn.hidden = isScreening; this.setBusy(this.busy); this.cb.onAttachPaperHead?.(this.headEl, doc);
  }
  showPaper(doc: DocumentInfo, docs?: readonly DocumentInfo[]): void {
    this.target = null; this.paperDoc = doc; this.backdrop.hidden = this.root.hidden = false;
    this.cellBody.hidden = this.cellFoot.hidden = true; this.paperBody.hidden = this.paperFoot.hidden = false;
    this.root.setAttribute('aria-label', researchText.paperSummary());
    this.titleEl.textContent = doc.paperTitle || doc.title;
    const meta = [doc.authors, doc.venue, doc.year].filter(Boolean).join(' · ');
    this.subEl.replaceChildren(...(meta ? [el('span', 'rt-insp-meta', meta)] : []), el('span', `rt-src-badge ${doc.kind === 'abstract' ? 'is-abstract' : 'is-pdf'}`, coverageLabel(doc.kind)));
    const tags = doc.meta?.tags?.filter(Boolean) ?? [];
    this.paperTagsSec.hidden = !tags.length;
    this.paperTagsEl.replaceChildren(...tags.map(tag => el('span', 'rt-insp-tag', tag)));
    mountDocResourcesPanel(this.paperResSec, { docId: doc.id, docs, onOpenDoc: id => this.cb.onJump(id, 1) });
    this.paperAbsEl.textContent = doc.abstract?.trim() || researchText.noAbstract();
    this.cb.onAttachPaperHead?.(this.headEl, doc);
  }
}

export class ReviewColumnPicker {
  readonly backdrop = el('div', 'rt-col-backdrop'); readonly root = el('section', 'rt-col-picker');
  private readonly tplList = el('div', 'rt-tpl-list');
  private readonly sugList = el('div', 'rt-col-sug'); private readonly nameIn = el('input', 'search rt-col-name-in');
  private readonly promptIn = el('textarea', 'rt-col-prompt-in'); private readonly typeSel = el('select', 'rt-select rt-col-type-in');
  private readonly addBtn = el('button', 'btn primary rt-col-submit', t('Add column', '添加列'));
  private existing = new Set<string>(); private activePreset: ReviewPresetId = 'general'; private busy = false; private prevFocus: HTMLElement | null = null;

  constructor(private readonly onAdd: (col: ReviewColumn) => Promise<boolean>, private readonly onApplyPreset: (preset: ReviewPresetId) => Promise<boolean>) {
    this.backdrop.hidden = this.root.hidden = true; this.backdrop.addEventListener('click', () => this.close()); bindEsc(this.root, () => this.close());
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-label', t('Add Column', '添加提取列'));
    const head = el('div', 'rt-picker-head'), body = el('div', 'rt-col-body'), form = el('form', 'rt-col-form'), foot = el('div', 'rt-col-foot');
    head.append(el('h2', 'rt-col-title', t('Add Column', '添加提取列')), closeIconBtn('rt-col-close', t('Close column picker', '关闭添加列窗口'), () => this.close()));
    this.tplList.setAttribute('role', 'group'); this.tplList.ariaLabel = researchText.templates();
    form.id = 'rtAddColForm'; this.nameIn.type = 'text'; this.nameIn.required = true; this.nameIn.maxLength = 80;
    this.nameIn.placeholder = t('e.g., Inference Latency', '例如：推理延迟'); this.promptIn.rows = 2; this.promptIn.maxLength = 500;
    this.promptIn.placeholder = t('What should be extracted from each paper?', '描述要从每篇文献中提取的信息…');
    for (const [val, en, zh] of [['text', 'Text', '文本'], ['boolean', 'Boolean', '布尔值'], ['number', 'Number', '数值'], ['list', 'List', '列表']] as const) this.typeSel.append(new Option(t(en, zh), val));
    const field = (lbl: string, ctrl: HTMLElement) => { const f = el('label', 'rt-col-field'); f.append(el('span', 'rt-insp-label', lbl), ctrl); return f; };
    form.append(field(t('Column name', '列名称'), this.nameIn), field(t('Extraction prompt', '提取指令'), this.promptIn), field(t('Output type', '输出类型'), this.typeSel));
    form.addEventListener('submit', e => {
      e.preventDefault(); const name = this.nameIn.value.trim(); if (!name) return;
      void this.submit({ id: slugColumnId(name, this.existing), name, prompt: this.promptIn.value.trim() || name, type: this.typeSel.value as ReviewColumnType });
    });
    body.append(el('span', 'rt-insp-label', researchText.templates()), this.tplList, el('span', 'rt-insp-label', t('Suggested columns', '推荐列')), this.sugList, el('span', 'rt-insp-label', t('Custom column', '自定义列')), form);
    this.addBtn.type = 'submit'; this.addBtn.setAttribute('form', 'rtAddColForm');
    foot.append(mkBtn('btn', t('Cancel', '取消'), () => this.close()), this.addBtn); this.root.append(head, body, foot);
  }

  private syncBusy(): void {
    this.addBtn.disabled = this.busy;
    for (const b of this.tplList.querySelectorAll<HTMLButtonElement>('.rt-tpl-btn')) { b.disabled = this.busy; b.setAttribute('aria-pressed', String(b.dataset.preset === this.activePreset)); }
    for (const b of this.sugList.querySelectorAll<HTMLButtonElement>('.rt-sug-btn')) b.disabled = this.busy || this.existing.has(b.dataset.colId!);
  }
  private async applyPreset(preset: ReviewPresetId): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.syncBusy();
    try {
      if (await this.onApplyPreset(preset)) {
        this.activePreset = preset;
        if (preset === 'custom') this.nameIn.focus({ preventScroll: true });
        else this.close();
      }
    } finally { this.busy = false; this.syncBusy(); }
  }
  private async submit(col: ReviewColumn): Promise<void> { if (this.busy) return; this.busy = true; this.syncBusy(); try { if (await this.onAdd(col)) this.close(); } finally { this.busy = false; this.syncBusy(); } }
  isOpen(): boolean { return !this.root.hidden; }
  close(): void { this.backdrop.hidden = this.root.hidden = true; if (this.prevFocus?.isConnected) this.prevFocus.focus({ preventScroll: true }); this.prevFocus = null; }
  open(existingIds: readonly string[], currentPreset: ReviewPresetId): void {
    this.prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.existing = new Set(existingIds); this.activePreset = currentPreset; this.busy = false;
    this.nameIn.value = this.promptIn.value = ''; this.typeSel.value = 'text';
    this.tplList.replaceChildren(); this.sugList.replaceChildren();
    for (const preset of REVIEW_PRESET_IDS) {
      const btn = mkBtn('btn rt-tpl-btn', PRESET_LABEL[preset](), () => { void this.applyPreset(preset); });
      btn.dataset.preset = preset; btn.setAttribute('aria-pressed', String(preset === currentPreset));
      this.tplList.append(btn);
    }
    for (const col of SUGGESTED_REVIEW_COLUMNS) {
      const added = this.existing.has(col.id), btn = mkBtn('btn rt-sug-btn', (added ? '✓ ' : '+ ') + reviewColLabel(col), () => { if (!added) void this.submit({ ...col }); });
      btn.disabled = added; btn.dataset.colId = col.id; btn.title = Object.hasOwn(SUG_HINT_ZH, col.id) ? t(col.prompt, SUG_HINT_ZH[col.id]) : t(col.prompt, ''); this.sugList.append(btn);
    }
    this.syncBusy(); this.backdrop.hidden = this.root.hidden = false; this.nameIn.focus({ preventScroll: true });
  }
}
