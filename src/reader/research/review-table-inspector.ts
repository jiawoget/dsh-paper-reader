import { SUGGESTED_REVIEW_COLUMNS, type ExtractionCell, type ReviewColumn, type ReviewColumnType, type ReviewDecision } from '../../shared/review-types.js';
import type { DocumentInfo } from '../../shared/types.js';
import { abstractOnlyLabel } from '../abstract-view.js';
import { el, readerLabel as t } from '../ui.js';
import { researchIcon } from './icons.js';
import { mkBtn } from './paper-intake.js';

interface InspectorTarget { doc: DocumentInfo; colId: string; colLabel: string; isScreening: boolean; cell?: ExtractionCell }
interface InspectorCallbacks { onClose: () => void; onSaveOverride: (docId: string, colId: string, value: string, reasoning?: string) => Promise<void>; onRetry: (docId: string, colId: string) => Promise<void>; onJump: (docId: string, page: number, quote?: string) => void }
const COL_ZH: Readonly<Record<string, string>> = {
  method: '方法', datasets: '数据集', key_metrics: '核心指标', main_result: '主要结果', limitations: '局限性',
  population: '研究人群 (P)', intervention: '干预措施 (I)', comparator: '对照组 (C)', outcome: '结局指标 (O)', study_design: '研究设计',
  sample_size: '样本量', code_repo: '代码仓库', primary_endpoint: '主要终点', adverse_events: '不良事件'
};
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
const closeIconBtn = (cls: string, label: string, onClick: () => void) => {
  const b = el('button', `icon-btn ${cls}`); b.type = 'button'; b.ariaLabel = b.title = label; b.append(researchIcon('close', 16)); b.addEventListener('click', onClick); return b;
};

export class ReviewTableInspector {
  readonly backdrop = el('div', 'rt-insp-backdrop'); readonly root = el('aside', 'rt-inspector');
  private readonly titleEl = el('h2', 'rt-insp-title'); private readonly subEl = el('div', 'rt-insp-sub');
  private readonly statusRow = el('div', 'rt-insp-status'); private readonly quotePageEl = el('span', 'rt-insp-page');
  private readonly quoteEl = el('blockquote', 'rt-insp-quote'); private readonly reasonEl = el('p', 'rt-insp-reason');
  private readonly valueArea = el('textarea', 'rt-insp-textarea'); private readonly decSelect = el('select', 'rt-select rt-insp-dec');
  private readonly reasonIn = el('input', 'search rt-insp-reason-in');
  private readonly saveBtn = el('button', 'btn primary rt-insp-save', t('Save override', '保存覆写'));
  private readonly jumpBtn = el('button', 'btn primary rt-insp-jump');
  private readonly retryBtn = el('button', 'btn rt-insp-retry', t('Retry cell', '重抽此格'));
  private target: InspectorTarget | null = null; private busy = false;

  constructor(private readonly cb: InspectorCallbacks) {
    this.backdrop.hidden = this.root.hidden = true;
    this.backdrop.addEventListener('click', () => this.close());
    this.root.setAttribute('aria-label', t('Evidence Inspector', 'Evidence 证据核验'));
    const head = el('div', 'rt-insp-head'), headText = el('div', 'rt-insp-head-text');
    headText.append(this.titleEl, this.subEl);
    head.append(headText, closeIconBtn('rt-insp-close', t('Close Evidence Inspector', '关闭 Evidence 面板'), () => this.close()));
    const body = el('div', 'rt-insp-body'), qHead = el('div', 'rt-insp-sec-head'), qSec = el('section', 'rt-insp-sec'), rSec = el('section', 'rt-insp-sec'), form = el('form', 'rt-insp-edit');
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
    body.append(this.statusRow, qSec, rSec, form);
    const foot = el('div', 'rt-insp-foot');
    this.jumpBtn.type = this.retryBtn.type = 'button';
    this.jumpBtn.addEventListener('click', () => { if (this.target) this.cb.onJump(this.target.doc.id, this.target.cell?.page ?? 1, this.target.cell?.quote || undefined); });
    this.retryBtn.addEventListener('click', () => { if (this.target && !this.busy) void this.cb.onRetry(this.target.doc.id, this.target.colId); });
    foot.append(this.jumpBtn, this.retryBtn); this.root.append(head, body, foot);
  }

  isOpen(): boolean { return this.target !== null && !this.root.hidden; }
  setBusy(busy: boolean): void { this.busy = busy; this.saveBtn.disabled = this.retryBtn.disabled = busy; }
  close(): void { if (!this.target && this.root.hidden) return; this.target = null; this.backdrop.hidden = this.root.hidden = true; this.cb.onClose(); }
  show(target: InspectorTarget): void {
    this.target = target; this.backdrop.hidden = this.root.hidden = false;
    const { doc, cell, colLabel, isScreening } = target, badge = cellBadgeInfo(cell);
    this.titleEl.textContent = doc.paperTitle || doc.title;
    this.subEl.replaceChildren(el('span', 'rt-insp-col', colLabel), el('span', `rt-src-badge ${doc.kind === 'abstract' ? 'is-abstract' : 'is-pdf'}`, coverageLabel(doc.kind)));
    this.statusRow.replaceChildren(el('span', `rt-badge is-${badge.kind}`, badge.full));
    if (cell?.sourceKind === 'abstract' && doc.kind !== 'abstract') this.statusRow.append(el('span', 'rt-stale-note', t('From abstract — PDF attached', '源自摘要，已附加 PDF')));
    this.quotePageEl.textContent = cell?.page ? t(`p. ${cell.page}`, `第 ${cell.page} 页`) : doc.kind === 'abstract' ? t('Abstract', '摘要') : '';
    this.quoteEl.textContent = cell?.quote || t('No verbatim quote captured.', '未捕获原文引句。');
    this.reasonEl.textContent = cell?.reasoning || t('No reasoning recorded yet.', '暂无判断依据。');
    this.decSelect.hidden = this.reasonIn.hidden = !isScreening; this.valueArea.hidden = isScreening;
    if (isScreening) { const v = cell?.value?.toLowerCase(); this.decSelect.value = v === 'yes' || v === 'no' || v === 'maybe' ? v : 'maybe'; this.reasonIn.value = cell?.reasoning ?? ''; }
    else this.valueArea.value = cell?.value ?? '';
    this.jumpBtn.textContent = doc.kind === 'abstract' ? t('Open Abstract ↗', '打开摘要 ↗') : t(`Jump to p. ${cell?.page ?? 1} ↗`, `跳原文第 ${cell?.page ?? 1} 页 ↗`);
    this.retryBtn.hidden = isScreening; this.setBusy(this.busy);
  }
}

export class ReviewColumnPicker {
  readonly backdrop = el('div', 'rt-col-backdrop'); readonly root = el('section', 'rt-col-picker');
  private readonly sugList = el('div', 'rt-col-sug'); private readonly nameIn = el('input', 'search rt-col-name-in');
  private readonly promptIn = el('textarea', 'rt-col-prompt-in'); private readonly typeSel = el('select', 'rt-select rt-col-type-in');
  private existing = new Set<string>();

  constructor(private readonly onAdd: (col: ReviewColumn) => Promise<void>) {
    this.backdrop.hidden = this.root.hidden = true; this.backdrop.addEventListener('click', () => this.close());
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-label', t('Add Column', '添加提取列'));
    const head = el('div', 'rt-picker-head'), body = el('div', 'rt-col-body'), form = el('form', 'rt-col-form'), foot = el('div', 'rt-col-foot');
    head.append(el('h2', 'rt-col-title', t('Add Column', '添加提取列')), closeIconBtn('rt-col-close', t('Close column picker', '关闭添加列窗口'), () => this.close()));
    form.id = 'rtAddColForm'; this.nameIn.type = 'text'; this.nameIn.required = true; this.nameIn.maxLength = 80;
    this.nameIn.placeholder = t('e.g., Inference Latency', '例如：推理延迟'); this.promptIn.rows = 2; this.promptIn.maxLength = 500;
    this.promptIn.placeholder = t('What should be extracted from each paper?', '描述要从每篇文献中提取的信息…');
    for (const [val, en, zh] of [['text', 'Text', '文本'], ['boolean', 'Boolean', '布尔值'], ['number', 'Number', '数值'], ['list', 'List', '列表']] as const) this.typeSel.append(new Option(t(en, zh), val));
    const field = (lbl: string, ctrl: HTMLElement) => { const f = el('label', 'rt-col-field'); f.append(el('span', 'rt-insp-label', lbl), ctrl); return f; };
    form.append(field(t('Column name', '列名称'), this.nameIn), field(t('Extraction prompt', '提取指令'), this.promptIn), field(t('Output type', '输出类型'), this.typeSel));
    form.addEventListener('submit', e => {
      e.preventDefault(); const name = this.nameIn.value.trim(); if (!name) return;
      void this.onAdd({ id: slugColumnId(name, this.existing), name, prompt: this.promptIn.value.trim() || name, type: this.typeSel.value as ReviewColumnType }).then(() => this.close());
    });
    body.append(el('span', 'rt-insp-label', t('Suggested columns', '推荐列')), this.sugList, el('span', 'rt-insp-label', t('Custom column', '自定义列')), form);
    const addBtn = el('button', 'btn primary rt-col-submit', t('Add column', '添加列')); addBtn.type = 'submit'; addBtn.setAttribute('form', 'rtAddColForm');
    foot.append(mkBtn('btn', t('Cancel', '取消'), () => this.close()), addBtn); this.root.append(head, body, foot);
  }

  isOpen(): boolean { return !this.root.hidden; }
  close(): void { this.backdrop.hidden = this.root.hidden = true; }
  open(existingIds: readonly string[]): void {
    this.existing = new Set(existingIds); this.nameIn.value = this.promptIn.value = ''; this.typeSel.value = 'text'; this.sugList.replaceChildren();
    for (const col of SUGGESTED_REVIEW_COLUMNS) {
      const added = this.existing.has(col.id), btn = mkBtn('btn rt-sug-btn', (added ? '✓ ' : '+ ') + reviewColLabel(col), () => { if (!added) void this.onAdd({ ...col }).then(() => this.close()); });
      btn.disabled = added; btn.dataset.colId = col.id; btn.title = col.prompt; this.sugList.append(btn);
    }
    this.backdrop.hidden = this.root.hidden = false; this.nameIn.focus({ preventScroll: true });
  }
}
