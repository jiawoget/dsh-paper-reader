import type { DocumentInfo, GraphPaper } from '../../shared/types.js';
import { el, message, toast } from '../ui.js';
import { researchIcon, type ResearchIconName } from './icons.js';
import { researchText, researchViewName } from './labels.js';
import { saveGraphPaper } from './paper-intake.js';
import type { ResearchShellContext } from './state.js';

export interface PaperFloatTarget { paper?: GraphPaper; doc?: DocumentInfo; inLibrary?: boolean; onSaved?: (doc: DocumentInfo) => void; }
export interface PaperFloatCallbacks {
  onRead: (target: PaperFloatTarget) => void | Promise<void>; onAskAi: (target: PaperFloatTarget) => void | Promise<void>;
  onCitations: (target: PaperFloatTarget) => void | Promise<void>; onCitationMap: (target: PaperFloatTarget) => void | Promise<void>;
  onSave?: (target: PaperFloatTarget) => void | Promise<void>;
}
type FloatActionKey = 'read' | 'ask-ai' | 'citations' | 'citation-map' | 'save';
const ACTION_DEFS: readonly { key: FloatActionKey; icon: ResearchIconName; label: () => string }[] = [
  { key: 'read', icon: 'read', label: () => researchText.readMode() }, { key: 'ask-ai', icon: 'ask-ai', label: () => researchText.askAi() },
  { key: 'citations', icon: 'citations', label: () => researchViewName('citations') },
  { key: 'citation-map', icon: 'citation-map', label: () => researchViewName('citation-map') },
  { key: 'save', icon: 'save', label: () => researchText.savePaper() }
];

const isTargetInLibrary = (t: PaperFloatTarget): boolean => Boolean(t.inLibrary || t.doc || t.paper?.inLibrary);
const paperSeedQuery = (p: GraphPaper): string => p.openAlexId || p.doi || (p.arxivId ? `arXiv:${p.arxivId}` : p.s2Id || p.title);

export function createWorkspaceFloatCallbacks(getShell: () => ResearchShellContext | undefined): PaperFloatCallbacks {
  const ensureDocId = async (target: PaperFloatTarget): Promise<string | undefined> => {
    const existing = target.doc?.id ?? (target.paper?.inLibrary ? target.paper.docId : undefined);
    if (existing || !target.paper) return existing;
    const doc = await saveGraphPaper(target.paper, { mode: 'auto' }, getShell());
    target.paper.inLibrary = target.inLibrary = true; target.paper.docId = doc.id; target.onSaved?.(doc);
    return doc.id;
  };
  return {
    async onRead(target) { const docId = await ensureDocId(target); if (docId) await getShell()?.inspectInReader({ docId, page: 1 }); },
    async onAskAi(target) { const docId = await ensureDocId(target); if (docId) await getShell()?.inspectInReader({ docId, page: 1, openChat: true }); },
    onCitations(target) {
      const shell = getShell(); if (!shell) return;
      if (target.doc) shell.openView('citations', { docId: target.doc.id });
      else if (target.paper) shell.openView('citations', { docId: target.paper.docId, doi: target.paper.doi, arxivId: target.paper.arxivId, query: target.paper.title });
    },
    onCitationMap(target) {
      const shell = getShell(); if (!shell) return;
      if (target.doc) shell.openView('citation-map', { seedDocId: target.doc.id });
      else if (target.paper) shell.openView('citation-map', target.paper.inLibrary && target.paper.docId ? { seedDocId: target.paper.docId } : { query: paperSeedQuery(target.paper) });
    },
    async onSave(target) { if (!isTargetInLibrary(target)) await ensureDocId(target); }
  };
}

interface PaperFloatOptions { placement?: 'auto' | 'outside'; isSuppressed?: () => boolean; }

export class PaperFloatBar {
  readonly root = el('div', 'pf-bar');
  private readonly targets = new WeakMap<HTMLElement, PaperFloatTarget>();
  private readonly buttons = new Map<FloatActionKey, HTMLButtonElement>();
  private readonly ac = new AbortController();
  private activeItem: HTMLElement | null = null;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private hideAfterBusy = false;

  constructor(private readonly host: HTMLElement, private readonly callbacks: PaperFloatCallbacks, private readonly options?: PaperFloatOptions) {
    this.root.hidden = true; this.root.setAttribute('role', 'toolbar'); this.root.ariaLabel = researchText.paperActions();
    for (const def of ACTION_DEFS) {
      const btn = el('button', 'pf-btn'), text = def.label();
      btn.type = 'button'; btn.dataset.action = def.key; btn.ariaLabel = btn.title = text;
      btn.append(researchIcon(def.icon, 20), el('span', 'pf-lbl', text));
      btn.addEventListener('click', e => { e.stopPropagation(); void this.invoke(def.key); });
      this.buttons.set(def.key, btn); this.root.append(btn);
    }
    host.append(this.root); this.bindEvents();
  }

  attach(itemEl: HTMLElement, target: PaperFloatTarget): void {
    itemEl.dataset.paperFloat = '1'; this.targets.set(itemEl, target);
    if (this.activeItem === itemEl && !this.root.hidden) this.syncButtons(target);
  }
  showFor(itemEl: HTMLElement): void {
    if (this.options?.isSuppressed?.()) { this.hide(); return; }
    if (this.busy) { if (this.activeItem === itemEl) this.cancelHide(); return; }
    const target = this.targets.get(itemEl);
    if (!target || !itemEl.isConnected) return;
    this.cancelHide(); this.activeItem = itemEl; this.syncButtons(target);
    this.root.hidden = false; this.root.classList.add('is-visible'); this.position(itemEl);
  }
  hide(): void { this.cancelHide(); this.activeItem = null; this.root.classList.remove('is-visible'); this.root.hidden = true; }
  destroy(): void { this.hide(); this.ac.abort(); this.root.remove(); }

  private cancelHide(): void { this.hideAfterBusy = false; if (this.hideTimer !== undefined) { clearTimeout(this.hideTimer); this.hideTimer = undefined; } }
  private scheduleHide(delay = 180): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => { this.hideTimer = undefined; if (this.busy) this.hideAfterBusy = true; else this.hide(); }, delay);
  }
  private itemFromNode(node: EventTarget | null): HTMLElement | null {
    const item = node instanceof Element ? node.closest<HTMLElement>('[data-paper-float="1"]') : null;
    return item && this.host.contains(item) && this.targets.has(item) ? item : null;
  }
  private syncButtons(target: PaperFloatTarget): void {
    const saved = isTargetInLibrary(target);
    for (const [key, btn] of this.buttons) { btn.hidden = key === 'save' && (saved || !this.callbacks.onSave); btn.disabled = this.busy; }
  }
  private position(itemEl: HTMLElement): void {
    const r = itemEl.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { this.hide(); return; }
    this.root.classList.remove('is-compact');
    const vw = typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1024;
    const vh = typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : 768;
    if (vw <= 700 || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)) { this.root.style.top = this.root.style.left = ''; return; }
    let bw = this.root.offsetWidth || 260, bh = this.root.offsetHeight || 36;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    const centerTop = () => clamp(r.top + (r.height - bh) / 2, 8, vh - bh - 8);
    const sideTop = () => r.height < bh + 28 ? centerTop() : clamp(r.top + 8, 8, vh - bh - 8);
    let left: number, top: number;
    if (this.options?.placement === 'outside') {
      if (r.right + bw + 12 <= vw) { left = r.right + 8; top = centerTop(); }
      else {
        this.root.classList.add('is-compact'); bw = this.root.offsetWidth || 168; bh = this.root.offsetHeight || 36;
        if (r.right + bw + 12 <= vw) { left = r.right + 8; top = centerTop(); }
        else if (r.left - bw - 12 >= 8) { left = r.left - bw - 8; top = centerTop(); }
        else { left = clamp(r.right - bw, 8, vw - bw - 8); top = r.top - bh - 4 >= 8 ? r.top - bh - 4 : Math.min(vh - bh - 8, r.bottom + 4); }
      }
    } else if (r.width < bw + 180 && r.right + bw + 16 <= vw) { left = r.right + 8; top = sideTop(); }
    else if (r.width < bw + 180 && r.left - bw - 16 >= 8) { left = r.left - bw - 8; top = sideTop(); }
    else {
      if (r.width < bw + 180) { this.root.classList.add('is-compact'); bw = this.root.offsetWidth || 168; bh = this.root.offsetHeight || 36; }
      left = clamp(r.right - bw - 8, 8, vw - bw - 8);
      top = r.height < bh + 28 ? centerTop() : clamp(r.bottom - bh - 4, Math.max(8, r.top + 4), vh - bh - 8);
    }
    this.root.style.top = `${Math.round(top)}px`;
    this.root.style.left = `${Math.round(left)}px`;
  }
  private async invoke(key: FloatActionKey): Promise<void> {
    if (this.busy || !this.activeItem) return;
    const invokedItem = this.activeItem, target = this.targets.get(invokedItem);
    const fn = key === 'read' ? this.callbacks.onRead : key === 'ask-ai' ? this.callbacks.onAskAi
      : key === 'citations' ? this.callbacks.onCitations : key === 'citation-map' ? this.callbacks.onCitationMap : this.callbacks.onSave;
    if (!target || !fn) return;
    this.busy = true; this.syncButtons(target);
    try {
      await fn(target);
      if (this.activeItem === invokedItem) {
        if (key === 'save') { if (!this.root.hidden) this.syncButtons(this.targets.get(invokedItem) ?? target); }
        else this.hide();
      }
    } catch (err) { toast(message(err)); }
    finally {
      this.busy = false;
      if (this.hideAfterBusy) this.hide();
      else if (this.activeItem === invokedItem && !this.root.hidden) { const cur = this.targets.get(invokedItem); if (cur) this.syncButtons(cur); }
    }
  }

  private bindEvents(): void {
    const signal = this.ac.signal;
    const staysInside = (next: EventTarget | null) => next instanceof Node && (this.root.contains(next) || Boolean(this.activeItem?.contains(next)));
    const isCheck = (node: EventTarget | null) => node instanceof Element && Boolean(node.closest('input[type="checkbox"], .library-check-wrap, .rt-check-wrap, .lc-doc-check-wrap'));
    this.host.addEventListener('pointerover', e => {
      if ((e as PointerEvent).pointerType === 'touch') return;
      if (e.target instanceof Node && this.root.contains(e.target)) { this.cancelHide(); return; }
      if (isCheck(e.target)) { if (!this.root.hidden) this.hide(); return; }
      const item = this.itemFromNode(e.target); if (item) this.showFor(item);
    }, { signal });
    this.host.addEventListener('pointerout', e => {
      const next = (e as PointerEvent).relatedTarget;
      if ((e as PointerEvent).pointerType === 'touch' || this.root.hidden || staysInside(next) || (!this.busy && this.itemFromNode(next))) return;
      this.scheduleHide();
    }, { signal });
    this.root.addEventListener('pointerenter', () => this.cancelHide(), { signal });
    this.root.addEventListener('pointerleave', e => { if (!staysInside((e as PointerEvent).relatedTarget)) this.scheduleHide(); }, { signal });
    this.host.addEventListener('focusin', e => {
      if (e.target instanceof Node && this.root.contains(e.target)) { this.cancelHide(); return; }
      if (isCheck(e.target)) { if (!this.root.hidden) this.hide(); return; }
      const item = this.itemFromNode(e.target); if (item) this.showFor(item); else if (!this.root.hidden) this.hide();
    }, { signal });
    this.host.addEventListener('focusout', e => { if (!this.root.hidden && !staysInside((e as FocusEvent).relatedTarget)) this.scheduleHide(80); }, { signal });
    this.host.addEventListener('click', e => {
      if (!(e.target instanceof Element) || this.root.contains(e.target)) return;
      if (e.target.closest('button, a[href], input, select, textarea, label')) { if (!this.root.hidden) this.hide(); return; }
      const item = this.itemFromNode(e.target); if (item) this.showFor(item);
    }, { signal });
    this.host.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || this.root.hidden) return;
      const returnItem = this.activeItem, insideBar = document.activeElement instanceof Node && this.root.contains(document.activeElement);
      this.hide();
      if (insideBar) {
        e.preventDefault(); e.stopPropagation();
        if (returnItem) (returnItem.querySelector<HTMLElement>('button, a[href], input, [tabindex]') ?? returnItem).focus({ preventScroll: true });
      }
    }, { signal });
    this.host.addEventListener('scroll', () => { if (!this.root.hidden) this.hide(); }, { capture: true, passive: true, signal });
    document.addEventListener('pointerdown', e => { if (!this.root.hidden && !staysInside(e.target)) this.hide(); }, { signal });
    window.addEventListener('resize', () => { if (!this.root.hidden) this.hide(); }, { passive: true, signal });
  }
}
