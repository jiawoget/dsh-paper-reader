import { LIBRARY_PAGE_SIZE } from '../shared/library-relevance.js';
import { researchText } from './research/labels.js';
import { button, el, message, toast } from './ui.js';

interface BulkCallbacks {
  onShowMore: () => void;
  onAddTag: (docIds: string[], tag: string) => Promise<void>;
  onOpenReview: (docIds: string[]) => void;
  onDelete: (docIds: string[]) => Promise<void>;
}

export class LibraryBulkController {
  readonly stripEl = el('div', 'library-sel-strip');
  readonly bulkEl = el('div', 'library-bulk-actions');
  readonly pagerEl = el('div', 'library-pager');
  private readonly countEl = el('span', 'library-sel-count');
  private readonly selVisBtn: HTMLButtonElement;
  private readonly selected = new Set<string>();
  private lastClickedId: string | null = null;
  private visibleIds: string[] = [];
  private filteredIds: string[] = [];
  private listHost: HTMLElement | null = null;
  private busy = false; private confirmingDelete = false; private tagOpen = false;

  constructor(private readonly cb: BulkCallbacks) {
    this.selVisBtn = button(researchText.triageSelectVisible(), () => this.toggleVisible(), 'text-btn library-sel-vis');
    this.stripEl.append(this.countEl, this.selVisBtn); this.stripEl.hidden = true;
    this.bulkEl.hidden = true; this.bulkEl.setAttribute('role', 'region'); this.bulkEl.ariaLabel = researchText.libraryBulkBar();
    this.pagerEl.append(button(researchText.triageShowMore(LIBRARY_PAGE_SIZE), () => this.cb.onShowMore(), 'btn library-show-more'));
    this.pagerEl.hidden = true;
  }

  bindList(list: HTMLElement): void { this.listHost = list; }
  remove(docId: string): void {
    this.selected.delete(docId); if (this.lastClickedId === docId) this.lastClickedId = null;
    this.confirmingDelete = false; this.sync();
  }
  clear(): void { this.selected.clear(); this.lastClickedId = null; this.confirmingDelete = false; this.tagOpen = false; this.sync(); }

  updateView(validIds: ReadonlySet<string>, visibleIds: string[], filteredIds: string[], totalCount: number, hasMore: boolean): void {
    for (const id of [...this.selected]) if (!validIds.has(id)) this.selected.delete(id);
    if (this.lastClickedId && !validIds.has(this.lastClickedId)) this.lastClickedId = null;
    this.visibleIds = visibleIds; this.filteredIds = filteredIds;
    this.stripEl.hidden = totalCount === 0;
    this.countEl.textContent = researchText.triageShowing(visibleIds.length, filteredIds.length, totalCount);
    this.selVisBtn.disabled = visibleIds.length === 0 || this.busy;
    this.pagerEl.hidden = !hasMore;
    this.sync();
  }

  makeCheckbox(docId: string): HTMLLabelElement {
    const wrap = el('label', 'library-check-wrap'), input = el('input', 'library-check');
    input.type = 'checkbox'; input.dataset.docId = docId; input.checked = this.selected.has(docId);
    input.ariaLabel = researchText.selectPaper();
    input.addEventListener('click', event => {
      event.stopPropagation();
      const checked = input.checked;
      this.confirmingDelete = false;
      if (event.shiftKey && this.lastClickedId && this.lastClickedId !== docId) {
        let order = this.visibleIds, a = order.indexOf(this.lastClickedId), b = order.indexOf(docId);
        if (a < 0 || b < 0) { order = this.filteredIds; a = order.indexOf(this.lastClickedId); b = order.indexOf(docId); }
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            if (checked) this.selected.add(order[i]); else this.selected.delete(order[i]);
          }
        } else if (checked) this.selected.add(docId); else this.selected.delete(docId);
      } else if (checked) this.selected.add(docId); else this.selected.delete(docId);
      this.lastClickedId = docId; this.sync();
    });
    wrap.append(input); return wrap;
  }

  private toggleVisible(): void {
    if (!this.visibleIds.length || this.busy) return;
    const allSelected = this.visibleIds.every(id => this.selected.has(id));
    for (const id of this.visibleIds) { if (allSelected) this.selected.delete(id); else this.selected.add(id); }
    this.confirmingDelete = false; this.sync();
  }

  private async runBusy(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.sync();
    try { await work(); } catch (error) { toast(message(error)); }
    finally { this.busy = false; this.sync(); }
  }

  private sync(): void {
    if (this.listHost) {
      for (const cb of this.listHost.querySelectorAll<HTMLInputElement>('.library-check[data-doc-id]')) cb.checked = this.selected.has(cb.dataset.docId!);
    }
    const n = this.selected.size;
    this.selVisBtn.disabled = this.visibleIds.length === 0 || this.busy;
    this.bulkEl.hidden = n === 0;
    if (!n) { this.confirmingDelete = false; this.tagOpen = false; this.bulkEl.replaceChildren(); return; }
    const ids = [...this.selected], count = el('span', 'library-bulk-count', researchText.triageSelectedCount(n));
    if (this.confirmingDelete) {
      const confirmBtn = button(researchText.libraryConfirmDeleteN(n), () => { void this.runBusy(() => this.cb.onDelete(ids)); }, 'btn library-delete-confirm library-bulk-del-confirm');
      const cancelBtn = button(researchText.resourceCancel(), () => { this.confirmingDelete = false; this.sync(); }, 'btn library-bulk-del-cancel');
      confirmBtn.disabled = cancelBtn.disabled = this.busy;
      this.bulkEl.replaceChildren(count, confirmBtn, cancelBtn); cancelBtn.focus({ preventScroll: true }); return;
    }
    if (this.tagOpen) {
      const form = el('form', 'library-bulk-tag-form'), input = el('input', 'search library-bulk-tag-in');
      input.type = 'text'; input.maxLength = 40; input.required = true;
      input.ariaLabel = input.placeholder = researchText.libraryTagInput();
      const applyBtn = el('button', 'btn primary library-bulk-tag-apply', researchText.libraryApplyTag());
      applyBtn.type = 'submit'; applyBtn.disabled = this.busy;
      const cancelBtn = button(researchText.resourceCancel(), () => { this.tagOpen = false; this.sync(); }, 'btn library-bulk-tag-cancel');
      cancelBtn.disabled = this.busy;
      form.onsubmit = event => {
        event.preventDefault(); const tag = input.value.trim(); if (!tag) { input.focus(); return; }
        void this.runBusy(async () => { await this.cb.onAddTag(ids, tag); this.tagOpen = false; });
      };
      form.append(input, applyBtn, cancelBtn); this.bulkEl.replaceChildren(count, form); input.focus(); return;
    }
    const tagBtn = button(researchText.libraryAddTag(), () => { this.tagOpen = true; this.sync(); }, 'btn library-bulk-tag-btn');
    const reviewBtn = button(researchText.libraryOpenReview(), () => this.cb.onOpenReview(ids), 'btn library-bulk-review-btn');
    const delBtn = button(researchText.libraryDeleteN(n), () => { this.confirmingDelete = true; this.sync(); }, 'btn library-delete-confirm library-bulk-del-btn');
    const clearBtn = button(researchText.triageClearSel(), () => this.clear(), 'text-btn library-bulk-clear');
    tagBtn.disabled = reviewBtn.disabled = delBtn.disabled = this.busy;
    this.bulkEl.replaceChildren(count, tagBtn, reviewBtn, delBtn, clearBtn);
  }
}
