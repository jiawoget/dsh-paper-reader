import type { DocumentInfo, GraphPaper } from '../../shared/types.js';
import { el, message, toast } from '../ui.js';
import { researchIcon, type ResearchIconName } from './icons.js';
import { researchText, researchViewName } from './labels.js';
import { saveGraphPaper } from './paper-intake.js';
import type { ResearchShellContext } from './state.js';

export interface PaperFloatTarget {
  paper?: GraphPaper; doc?: DocumentInfo; inLibrary?: boolean; onSaved?: (doc: DocumentInfo) => void;
}
export interface PaperFloatCallbacks {
  onRead: (target: PaperFloatTarget) => void | Promise<void>;
  onAskAi: (target: PaperFloatTarget) => void | Promise<void>;
  onCitations: (target: PaperFloatTarget) => void | Promise<void>;
  onCitationMap: (target: PaperFloatTarget) => void | Promise<void>;
  onSave?: (target: PaperFloatTarget) => void | Promise<void>;
}

type FloatActionKey = 'read' | 'ask-ai' | 'citations' | 'citation-map' | 'save';

const ACTION_DEFS: readonly { key: FloatActionKey; icon: ResearchIconName; label: () => string }[] = [
  { key: 'read', icon: 'read', label: () => researchText.readMode() },
  { key: 'ask-ai', icon: 'ask-ai', label: () => researchText.askAi() },
  { key: 'citations', icon: 'citations', label: () => researchViewName('citations') },
  { key: 'citation-map', icon: 'citation-map', label: () => researchViewName('citation-map') },
  { key: 'save', icon: 'save', label: () => researchText.savePaper() }
];

const isTargetInLibrary = (t: PaperFloatTarget): boolean => Boolean(t.inLibrary || t.doc || t.paper?.inLibrary);
const paperSeedQuery = (p: GraphPaper): string => p.openAlexId || p.doi || (p.arxivId ? `arXiv:${p.arxivId}` : p.s2Id || p.title);

export function createWorkspaceFloatCallbacks(getShell: () => ResearchShellContext | undefined): PaperFloatCallbacks {
  const ensureDocId = async (target: PaperFloatTarget, preferOaPdf = false): Promise<string | undefined> => {
    const existing = target.doc?.id ?? (target.paper?.inLibrary ? target.paper.docId : undefined);
    if (existing || !target.paper) return existing;
    const doc = await saveGraphPaper(target.paper, preferOaPdf && target.paper.oaPdfUrl ? 'oa-pdf' : 'abstract', getShell());
    target.paper.inLibrary = target.inLibrary = true;
    target.paper.docId = doc.id;
    target.onSaved?.(doc);
    return doc.id;
  };
  return {
    async onRead(target) { const docId = await ensureDocId(target, false); if (docId) await getShell()?.inspectInReader({ docId, page: 1 }); },
    async onAskAi(target) { const docId = await ensureDocId(target, false); if (docId) await getShell()?.inspectInReader({ docId, page: 1, openChat: true }); },
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
    async onSave(target) { if (!isTargetInLibrary(target)) await ensureDocId(target, true); }
  };
}

export class PaperFloatBar {
  readonly root = el('div', 'pf-bar');
  private readonly targets = new WeakMap<HTMLElement, PaperFloatTarget>();
  private readonly buttons = new Map<FloatActionKey, HTMLButtonElement>();
  private readonly ac = new AbortController();
  private activeItem: HTMLElement | null = null;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private busy = false;

  constructor(private readonly host: HTMLElement, private callbacks: PaperFloatCallbacks) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'toolbar');
    this.root.ariaLabel = researchText.paperActions();
    for (const def of ACTION_DEFS) {
      const btn = el('button', 'pf-btn'), text = def.label();
      btn.type = 'button'; btn.dataset.action = def.key; btn.ariaLabel = btn.title = text;
      btn.append(researchIcon(def.icon, 20), el('span', 'pf-lbl', text));
      btn.addEventListener('click', e => { e.stopPropagation(); void this.invoke(def.key); });
      this.buttons.set(def.key, btn); this.root.append(btn);
    }
    host.append(this.root);
    this.bindEvents();
  }

  attach(itemEl: HTMLElement, target: PaperFloatTarget): void {
    itemEl.dataset.paperFloat = '1';
    this.targets.set(itemEl, target);
    if (this.activeItem === itemEl && !this.root.hidden) this.syncButtons(target);
  }

  setCallbacks(callbacks: PaperFloatCallbacks): void {
    this.callbacks = callbacks;
    const cur = this.activeItem && !this.root.hidden ? this.targets.get(this.activeItem) : undefined;
    if (cur) this.syncButtons(cur);
  }

  showFor(itemEl: HTMLElement): void {
    const target = this.targets.get(itemEl);
    if (!target || !itemEl.isConnected) return;
    this.cancelHide(); this.activeItem = itemEl; this.syncButtons(target);
    this.root.hidden = false; this.root.classList.add('is-visible');
    this.position(itemEl);
  }

  hide(): void {
    this.cancelHide(); this.activeItem = null;
    this.root.classList.remove('is-visible'); this.root.hidden = true;
  }

  destroy(): void { this.hide(); this.ac.abort(); this.root.remove(); }

  private cancelHide(): void { if (this.hideTimer !== undefined) { clearTimeout(this.hideTimer); this.hideTimer = undefined; } }
  private scheduleHide(delay = 180): void { this.cancelHide(); this.hideTimer = setTimeout(() => { this.hideTimer = undefined; if (!this.busy) this.hide(); }, delay); }

  private itemFromNode(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null;
    const item = node.closest<HTMLElement>('[data-paper-float="1"]');
    return item && this.host.contains(item) && this.targets.has(item) ? item : null;
  }

  private syncButtons(target: PaperFloatTarget): void {
    const saved = isTargetInLibrary(target);
    for (const [key, btn] of this.buttons) { btn.hidden = key === 'save' && (saved || !this.callbacks.onSave); btn.disabled = this.busy; }
  }

  private position(itemEl: HTMLElement): void {
    const r = itemEl.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { this.hide(); return; }
    const vw = typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1024;
    const vh = typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : 768;
    const bw = this.root.offsetWidth || 260, bh = this.root.offsetHeight || 36;
    const belowTop = r.bottom + 2;
    const top = belowTop + bh <= vh - 8 ? Math.max(8, belowTop) : Math.max(8, r.top - bh - 4);
    const left = Math.max(8, Math.min(r.right - bw - 8, vw - bw - 8));
    this.root.style.top = `${Math.round(top)}px`;
    this.root.style.left = `${Math.round(left)}px`;
  }

  private async invoke(key: FloatActionKey): Promise<void> {
    if (this.busy || !this.activeItem) return;
    const target = this.targets.get(this.activeItem);
    const fn = key === 'read' ? this.callbacks.onRead : key === 'ask-ai' ? this.callbacks.onAskAi
      : key === 'citations' ? this.callbacks.onCitations : key === 'citation-map' ? this.callbacks.onCitationMap : this.callbacks.onSave;
    if (!target || !fn) return;
    this.busy = true; this.syncButtons(target);
    try {
      await fn(target);
      if (key === 'save') { if (this.activeItem && !this.root.hidden) this.syncButtons(target); }
      else this.hide();
    } catch (err) { toast(message(err)); }
    finally {
      this.busy = false;
      const cur = this.activeItem && !this.root.hidden ? this.targets.get(this.activeItem) : undefined;
      if (cur) this.syncButtons(cur);
    }
  }

  private bindEvents(): void {
    const signal = this.ac.signal;
    const staysInside = (next: EventTarget | null) => next instanceof Node && (this.root.contains(next) || Boolean(this.activeItem?.contains(next)));
    this.host.addEventListener('pointerover', e => {
      if ((e as PointerEvent).pointerType === 'touch') return;
      if (e.target instanceof Node && this.root.contains(e.target)) { this.cancelHide(); return; }
      const item = this.itemFromNode(e.target); if (item) this.showFor(item);
    }, { signal });
    this.host.addEventListener('pointerout', e => {
      const next = (e as PointerEvent).relatedTarget;
      if ((e as PointerEvent).pointerType === 'touch' || this.root.hidden || staysInside(next) || this.itemFromNode(next)) return;
      this.scheduleHide();
    }, { signal });
    this.root.addEventListener('pointerenter', () => this.cancelHide(), { signal });
    this.root.addEventListener('pointerleave', e => { if (!staysInside((e as PointerEvent).relatedTarget)) this.scheduleHide(); }, { signal });
    this.host.addEventListener('focusin', e => {
      if (e.target instanceof Node && this.root.contains(e.target)) { this.cancelHide(); return; }
      const item = this.itemFromNode(e.target); if (item) this.showFor(item); else if (!this.root.hidden) this.hide();
    }, { signal });
    this.host.addEventListener('focusout', e => { if (!this.root.hidden && !staysInside((e as FocusEvent).relatedTarget)) this.scheduleHide(80); }, { signal });
    this.host.addEventListener('click', e => {
      if (!(e.target instanceof Element) || this.root.contains(e.target)) return;
      if (e.target.closest('button, a[href], input, select, textarea')) { if (!this.root.hidden) this.hide(); return; }
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
