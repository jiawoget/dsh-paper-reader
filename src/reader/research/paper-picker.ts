import type { DocumentInfo, GraphPaper } from '../../shared/types.js';
import { el } from '../ui.js';
import { researchText } from './labels.js';
import { mkBtn } from './paper-intake.js';

export const PAPER_PICKER_VISIBLE_CAP = 40;

export interface PaperPickerExternalItem { id: string; title: string; meta?: string; paper?: GraphPaper }
interface PaperPickerOptions {
  docs: () => readonly DocumentInfo[]; selectedDocId?: () => string; currentReadingDocId?: () => string;
  ariaLabel?: string; placeholder?: string; searchAriaLabel?: string;
  pickerClass?: string; searchClass?: string; listClass?: string; optionClass?: string;
  onSelectDoc: (doc: DocumentInfo) => void;
  onSelectExternal?: (item: PaperPickerExternalItem) => void;
  onSubmitRaw?: (query: string, hasOptions: boolean) => boolean;
  externalSearch?: (query: string, signal: AbortSignal) => Promise<PaperPickerExternalItem[]>;
  onClose?: (refocus: boolean) => void;
}

const shortAuthors = (raw?: string): string => {
  const s = (raw ?? '').trim(), parts = s ? (s.includes(';') ? s.split(';') : s.split(',')).map(p => p.trim()).filter(Boolean) : [];
  const first = parts[0] ?? s, head = first.length > 36 ? first.slice(0, 35) + '…' : first;
  return parts.length > 1 ? `${head} et al.` : head;
};

export function filterLibraryPapers(
  docs: readonly DocumentInfo[], query: string, cap = PAPER_PICKER_VISIBLE_CAP
): { total: number; matched: number; items: DocumentInfo[] } {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = tokens.length ? docs.filter(d => {
    const hay = `${d.paperTitle || d.title} ${d.authors ?? ''} ${d.year ?? ''} ${d.doi ?? ''} ${(d.meta?.tags ?? []).join(' ')}`.toLowerCase();
    return tokens.every(tok => hay.includes(tok));
  }) : [...docs];
  return { total: docs.length, matched: matched.length, items: matched.slice(0, Math.max(1, cap)) };
}

export class PaperPicker {
  readonly root: HTMLElement;
  readonly searchInput: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly currentWrap: HTMLElement;
  private optionBtns: HTMLButtonElement[] = [];
  private activeIdx = -1;
  private extItems: PaperPickerExternalItem[] = [];
  private extLoading = false;
  private extTimer: ReturnType<typeof setTimeout> | undefined;
  private extCtrl: AbortController | null = null;
  private extSeq = 0;

  constructor(private readonly opts: PaperPickerOptions) {
    this.root = el('div', opts.pickerClass ?? 'pp-picker');
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-label', opts.ariaLabel ?? researchText.pickerFilterLabel()); this.root.hidden = true;
    this.searchInput = el('input', `search ${opts.searchClass ?? 'pp-search'}`); this.searchInput.type = 'search';
    this.searchInput.ariaLabel = opts.searchAriaLabel ?? researchText.pickerFilterLabel(); this.searchInput.placeholder = opts.placeholder ?? researchText.pickerFilterPlaceholder();
    this.currentWrap = el('div', 'pp-current-wrap'); this.countEl = el('div', 'pp-count');
    this.listEl = el('div', opts.listClass ?? 'pp-list'); this.listEl.setAttribute('role', 'listbox');
    this.root.append(this.searchInput, this.currentWrap, this.countEl, this.listEl);
    this.searchInput.addEventListener('input', () => { this.activeIdx = -1; this.scheduleExternal(); this.render(); });
    this.root.addEventListener('keydown', e => {
      if (!e.isComposing && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.opts.onClose?.(true); }
    });
    this.searchInput.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' && this.optionBtns.length) { e.preventDefault(); this.moveFocus(1); }
      else if (e.key === 'ArrowUp' && this.optionBtns.length) { e.preventDefault(); this.moveFocus(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.activeIdx >= 0 && this.optionBtns[this.activeIdx]) this.optionBtns[this.activeIdx].click();
        else if (this.opts.onSubmitRaw?.(this.searchInput.value.trim(), this.optionBtns.length > 0)) return;
        else this.optionBtns[0]?.click();
      }
    });
  }

  private abortExternal(): void { ++this.extSeq; if (this.extTimer) { clearTimeout(this.extTimer); this.extTimer = undefined; } this.extCtrl?.abort(); this.extCtrl = null; this.extLoading = false; }
  private scheduleExternal(): void {
    this.abortExternal(); this.extItems = [];
    const q = this.searchInput.value.trim();
    if (!this.opts.externalSearch || q.length < 2) return;
    const seq = this.extSeq; this.extLoading = true;
    this.extTimer = setTimeout(() => {
      this.extCtrl = new AbortController();
      void this.opts.externalSearch!(q, this.extCtrl.signal).then(items => {
        if (seq === this.extSeq) { this.extLoading = false; this.extItems = items; this.render(); }
      }).catch(() => { if (seq === this.extSeq) { this.extLoading = false; this.render(); } });
    }, 220);
  }
  private moveFocus(delta: number): void {
    const n = this.optionBtns.length;
    this.activeIdx = this.activeIdx < 0 ? (delta > 0 ? 0 : n - 1) : (this.activeIdx + delta + n) % n;
    this.optionBtns.forEach((b, i) => b.classList.toggle('is-focused', i === this.activeIdx));
    this.optionBtns[this.activeIdx]?.scrollIntoView({ block: 'nearest' });
  }

  open(): void { this.root.hidden = false; this.searchInput.value = ''; this.activeIdx = -1; this.extItems = []; this.abortExternal(); this.render(); this.searchInput.focus({ preventScroll: true }); }
  close(): void { this.root.hidden = true; this.abortExternal(); }
  refresh(): void { if (!this.root.hidden) this.render(); }
  dispose(): void { this.abortExternal(); }

  private render(): void {
    const docs = this.opts.docs(), selected = this.opts.selectedDocId?.() ?? '';
    const { total, matched, items } = filterLibraryPapers(docs, this.searchInput.value);
    const curId = this.opts.currentReadingDocId?.() ?? '', curDoc = curId ? docs.find(d => d.id === curId) : undefined;
    this.currentWrap.replaceChildren(); this.currentWrap.hidden = !curDoc;
    if (curDoc) { const btn = mkBtn('btn pp-current-btn', researchText.pickerCurrentPaper(), () => this.opts.onSelectDoc(curDoc)); btn.dataset.currentDocId = curDoc.id; this.currentWrap.append(btn); }
    this.countEl.textContent = researchText.pickerCount(items.length, matched, total);
    this.listEl.replaceChildren(); this.optionBtns = [];
    const optCls = this.opts.optionClass ?? 'pp-opt';
    for (const d of items) {
      const full = d.paperTitle || d.title, meta = [shortAuthors(d.authors), d.year ?? ''].filter(Boolean).join(' · ');
      const opt = mkBtn(`${optCls}${d.id === selected ? ' is-active' : ''}`, '', () => this.opts.onSelectDoc(d));
      opt.setAttribute('role', 'option'); opt.setAttribute('aria-selected', String(d.id === selected)); opt.dataset.docId = d.id;
      opt.append(el('span', `${optCls}-title`, full), ...(meta ? [el('span', `${optCls}-meta`, meta)] : []));
      this.listEl.append(opt); this.optionBtns.push(opt);
    }
    const shownIds = new Set(items.map(d => d.id));
    const extShown = this.extItems.filter(item => !item.paper?.docId || !shownIds.has(item.paper.docId));
    if (!items.length && !this.extLoading && !extShown.length) this.listEl.append(el('p', 'cm-seed-empty', researchText.pickerEmpty()));
    if (this.extLoading) this.listEl.append(el('p', 'cm-seed-empty', researchText.pickerSearching()));
    else if (extShown.length && this.opts.onSelectExternal) {
      this.listEl.append(el('div', 'pp-section-label', researchText.pickerExternalHeading()));
      for (const item of extShown) {
        const opt = mkBtn(`${optCls} is-external`, '', () => this.opts.onSelectExternal!(item));
        opt.setAttribute('role', 'option'); opt.dataset.extId = item.id;
        opt.append(el('span', `${optCls}-title`, item.title), ...(item.meta ? [el('span', `${optCls}-meta`, item.meta)] : []));
        this.listEl.append(opt); this.optionBtns.push(opt);
      }
    }
    if (this.activeIdx >= this.optionBtns.length) this.activeIdx = -1;
    this.optionBtns.forEach((b, i) => b.classList.toggle('is-focused', i === this.activeIdx));
  }
}
