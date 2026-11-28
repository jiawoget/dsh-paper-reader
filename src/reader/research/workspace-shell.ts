import { closeTagPopover, isTagPopoverOpen } from '../tag-picker.js';
import { byId, el, message, readerLabel as label, toast } from '../ui.js';
import { dismissInfoTip, researchIcon } from './icons.js';
import { RESEARCH_VIEWS, researchText, researchViewMeta, researchViewName, type ResearchViewId } from './labels.js';
import { createWorkspaceFloatCallbacks, PaperFloatBar } from './paper-float-bar.js';
import { clearAbstractOnly } from './paper-intake.js';
import type { InspectTarget, ResearchOpenContext, ResearchShellContext, ResearchViewModule, ResearchWorkspaceHost, ReturnAnchor, WorkspaceSnapshot } from './state.js';

const COMPACT_BP = 1200;

export class ResearchWorkspace {
  private readonly root = el('section', 'research-workspace');
  private readonly rail = el('aside', 'rw-rail');
  private readonly backdrop = el('div', 'rw-rail-backdrop');
  private readonly main = el('div', 'rw-main');
  private readonly railToggle = el('button', 'icon-btn rw-rail-toggle');
  private readonly mobileSelect = el('select', 'rw-mobile-select');
  private readonly navButtons = new Map<ResearchViewId, HTMLButtonElement>();
  private readonly returnPill = el('div', 'return-workspace');
  private readonly returnGo = el('button', 'return-workspace-go');
  private readonly modules = new Map<ResearchViewId, ResearchViewModule>();
  private readonly railPref: Record<'dense' | 'regular', boolean | undefined> = { dense: undefined, regular: undefined };
  private readonly floatBar: PaperFloatBar;
  private opened = false; private overlayOpen = false; private activeView: ResearchViewId = 'deep-search'; private activeTopicTag = '';
  private returnAnchor?: ReturnAnchor; private snapshot?: WorkspaceSnapshot; private openCtx?: ResearchOpenContext;
  private activeModule?: ResearchViewModule; private shellCtx?: ResearchShellContext; private viewSeq = 0;
  private viewsPromise?: Promise<void>;

  constructor(private readonly host: ResearchWorkspaceHost) {
    this.root.id = 'researchWorkspace'; this.root.hidden = true; this.root.ariaLabel = researchText.workspace();
    this.backdrop.hidden = true; this.main.tabIndex = -1;
    this.backdrop.addEventListener('click', () => { this.overlayOpen = false; this.syncRail(); });
    const mobileBar = el('header', 'rw-mobile-bar'), mobileCollapse = el('button', 'icon-btn rw-mobile-collapse');
    mobileCollapse.type = 'button'; mobileCollapse.ariaLabel = mobileCollapse.title = researchText.collapse();
    mobileCollapse.append(researchIcon('read', 20)); mobileCollapse.addEventListener('click', () => { void this.collapse(); });
    this.mobileSelect.ariaLabel = researchText.viewsNav();
    this.mobileSelect.addEventListener('change', () => { this.openCtx = undefined; this.switchView(this.mobileSelect.value as ResearchViewId); });
    mobileBar.append(mobileCollapse, this.mobileSelect);
    const railHead = el('div', 'rw-rail-head'), railSwitch = el('div', 'rw-rail-switch');
    railSwitch.setAttribute('role', 'group'); railSwitch.ariaLabel = researchText.modeSwitch();
    const collapseBtn = el('button', 'rw-collapse-btn');
    collapseBtn.type = 'button'; collapseBtn.setAttribute('aria-pressed', 'false');
    collapseBtn.ariaLabel = collapseBtn.title = collapseBtn.dataset.tooltip = researchText.collapse();
    collapseBtn.append(researchIcon('read', 18), el('span', 'rw-label', researchText.readMode()));
    collapseBtn.addEventListener('click', () => { void this.collapse(); });
    const railActive = el('button', 'rw-rail-active');
    railActive.type = 'button'; railActive.setAttribute('aria-pressed', 'true');
    railActive.ariaLabel = researchText.researchMode();
    railActive.append(researchIcon('research', 18), el('span', 'rw-label', researchText.researchMode()));
    railSwitch.append(collapseBtn, railActive);
    this.railToggle.type = 'button'; this.railToggle.append(researchIcon('railToggle', 18));
    this.railToggle.addEventListener('click', () => this.toggleRail());
    railHead.append(railSwitch, this.railToggle);
    const nav = el('nav', 'rw-nav'); nav.setAttribute('role', 'navigation'); nav.ariaLabel = researchText.viewsNav();
    for (const view of RESEARCH_VIEWS) {
      const name = researchViewName(view.id), btn = el('button', 'rw-nav-btn');
      btn.type = 'button'; btn.dataset.view = view.id; btn.ariaLabel = btn.title = btn.dataset.tooltip = name;
      btn.append(researchIcon(view.id, 18), el('span', 'rw-label', name));
      btn.addEventListener('click', () => { this.openCtx = undefined; if (this.overlayOpen) this.overlayOpen = false; this.switchView(view.id); });
      this.navButtons.set(view.id, btn); nav.append(btn); this.mobileSelect.append(new Option(name, view.id));
    }
    this.rail.append(railHead, nav); this.root.append(mobileBar, this.rail, this.backdrop, this.main); byId('reader').after(this.root);
    this.floatBar = new PaperFloatBar(this.root, createWorkspaceFloatCallbacks(() => this.shellCtx), { isSuppressed: () => isTagPopoverOpen() });
    const switcher = el('div', 'rw-mode-switch');
    switcher.id = 'workspaceSwitch'; switcher.setAttribute('role', 'group'); switcher.ariaLabel = researchText.modeSwitch();
    const readBtn = el('button', 'rw-sw-btn rw-sw-read');
    readBtn.type = 'button'; readBtn.setAttribute('aria-pressed', 'true'); readBtn.ariaLabel = researchText.readMode();
    readBtn.append(researchIcon('read', 18), el('span', 'rw-sw-txt', researchText.readMode()));
    const researchBtn = el('button', 'rw-sw-btn rw-sw-research');
    researchBtn.type = 'button'; researchBtn.setAttribute('aria-pressed', 'false');
    researchBtn.ariaLabel = researchText.researchMode(); researchBtn.title = researchText.expandWithKey();
    researchBtn.append(researchIcon('research', 18), el('span', 'rw-sw-txt', researchText.researchMode()));
    researchBtn.addEventListener('click', () => this.open());
    researchBtn.addEventListener('pointerenter', () => { void this.ensureViews().catch(() => undefined); }, { once: true });
    switcher.append(readBtn, researchBtn);
    this.returnPill.id = 'returnWorkspace'; this.returnPill.hidden = true;
    this.returnPill.setAttribute('role', 'region'); this.returnPill.ariaLabel = researchText.workspace();
    this.returnGo.type = 'button'; this.returnGo.addEventListener('click', () => this.resumeFromPill());
    const returnClose = el('button', 'icon-btn return-workspace-close');
    returnClose.type = 'button'; returnClose.ariaLabel = returnClose.title = researchText.dismissReturn();
    returnClose.append(researchIcon('close', 16)); returnClose.addEventListener('click', () => this.dismissReturn());
    this.returnPill.append(this.returnGo, returnClose);
    byId('contentsToggle').after(switcher, this.returnPill);
    window.addEventListener('resize', () => { if (this.opened) this.syncRail(); });
  }

  registerView(mod: ResearchViewModule): void { this.modules.set(mod.id, mod); }
  isOpen(): boolean { return this.opened; }
  notifyDocumentMutated(docId: string, deleted = false): void {
    if (deleted) { clearAbstractOnly(docId); if (this.returnAnchor?.doc === docId) this.returnAnchor = undefined; }
    this.activeModule?.onDocumentMutated?.(docId, deleted);
  }
  open(view?: ResearchViewId, ctx?: ResearchOpenContext): void {
    if (!this.opened && !view && !ctx && this.snapshot) { this.resumeFromPill(); return; }
    this.host.prepareOpen();
    if (!this.opened && !this.returnAnchor) this.returnAnchor = this.host.capturePosition();
    this.returnPill.hidden = true; this.opened = true; this.openCtx = ctx;
    if (ctx?.topic !== undefined) this.activeTopicTag = ctx.topic;
    byId('reader').hidden = true; this.root.hidden = false;
    this.switchView(view ?? this.activeView); this.main.focus({ preventScroll: true });
  }
  async collapse(): Promise<void> {
    if (!this.opened) return;
    ++this.viewSeq;
    closeTagPopover(); this.floatBar.hide();
    this.activeModule?.unmount?.(); this.activeModule = undefined; this.shellCtx = undefined;
    this.opened = this.overlayOpen = false; this.root.hidden = this.returnPill.hidden = true; this.snapshot = undefined;
    byId('reader').hidden = false;
    const anchor = this.returnAnchor; this.returnAnchor = undefined;
    if (anchor) { try { await this.host.restorePosition(anchor); } catch (err) { toast(message(err)); } }
    this.host.focusAfterCollapse();
  }
  async inspectInReader(target: InspectTarget): Promise<void> {
    const seq = ++this.viewSeq;
    closeTagPopover(); this.floatBar.hide();
    const viewState = this.activeModule?.saveState?.();
    this.activeModule?.unmount?.(); this.activeModule = undefined;
    this.snapshot = { activeView: this.activeView, viewState, scrollTop: this.main.scrollTop };
    this.opened = this.overlayOpen = false; this.root.hidden = true; byId('reader').hidden = false;
    try { await this.host.inspectFromWorkspace(target, this.returnAnchor); }
    catch (error) { if (seq === this.viewSeq && this.snapshot) this.resumeFromPill(); throw error; }
    if (seq !== this.viewSeq || !this.snapshot) return;
    const text = researchText.returnTo(researchViewName(this.activeView));
    this.returnGo.textContent = '← ' + text; this.returnGo.ariaLabel = text; this.returnPill.hidden = false;
  }

  handleEscape(): boolean {
    if (!this.opened) return false;
    if (dismissInfoTip()) return true;
    if (this.overlayOpen) { this.floatBar.hide(); this.overlayOpen = false; this.syncRail(); this.railToggle.focus({ preventScroll: true }); return true; }
    const active = document.activeElement;
    if (active instanceof Element && active.closest('#researchWorkspace') && active.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return false;
    if (this.activeModule?.handleEscape?.()) { this.floatBar.hide(); return true; }
    if (!this.floatBar.root.hidden) { this.floatBar.hide(); return true; }
    void this.collapse(); return true;
  }

  private resumeFromPill(): void {
    this.host.prepareOpen();
    const snap = this.snapshot; this.snapshot = undefined; this.returnPill.hidden = true; this.opened = true;
    byId('reader').hidden = true; this.root.hidden = false;
    this.switchView(snap?.activeView ?? this.activeView, snap?.viewState, snap?.scrollTop ?? 0);
    this.main.focus({ preventScroll: true });
  }

  private dismissReturn(): void { this.returnPill.hidden = true; this.snapshot = undefined; this.returnAnchor = undefined; }
  private toggleRail(): void {
    if (innerWidth <= COMPACT_BP) this.overlayOpen = !this.overlayOpen;
    else { const kind = researchViewMeta(this.activeView).dense ? 'dense' : 'regular'; this.railPref[kind] = !(this.railPref[kind] ?? kind === 'dense'); }
    this.syncRail();
  }
  private syncRail(): void {
    const compact = innerWidth <= COMPACT_BP, dense = researchViewMeta(this.activeView).dense;
    const collapsed = compact ? true : (this.railPref[dense ? 'dense' : 'regular'] ?? dense);
    if (!compact) this.overlayOpen = false;
    this.root.dataset.railCollapsed = String(collapsed); this.root.dataset.railOverlay = this.overlayOpen ? 'open' : 'closed';
    this.backdrop.hidden = !this.overlayOpen;
    const expanded = !collapsed || this.overlayOpen, tip = expanded ? researchText.collapseRail() : researchText.expandRail();
    this.railToggle.setAttribute('aria-expanded', String(expanded)); this.railToggle.ariaLabel = this.railToggle.title = this.railToggle.dataset.tooltip = tip;
  }

  private ensureViews(): Promise<void> {
    if (this.modules.size) return Promise.resolve();
    return (this.viewsPromise ??= import('./index.js').then(({ registerResearchViews }) => {
      registerResearchViews(this);
    }, err => { this.viewsPromise = undefined; throw err; }));
  }

  private switchView(view: ResearchViewId, restoredState?: unknown, scrollTop = 0): void {
    const seq = ++this.viewSeq;
    closeTagPopover(); this.floatBar.hide();
    this.activeModule?.unmount?.(); this.activeModule = undefined; this.activeView = view; this.mobileSelect.value = view;
    for (const [id, btn] of this.navButtons) { if (id === view) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current'); }
    this.syncRail(); this.main.replaceChildren();
    const mod = this.modules.get(view);
    if (!mod) {
      if (!this.modules.size) {
        this.main.append(el('p', 'hint', label('Loading…', '正在加载…')));
        void this.ensureViews().then(() => { if (seq === this.viewSeq && this.modules.has(view)) this.switchView(view, restoredState, scrollTop); })
          .catch(error => {
            if (seq !== this.viewSeq) return;
            const text = message(error);
            this.main.replaceChildren(el('p', 'hint', text));
            toast(text);
          });
      }
      return;
    }
    this.activeModule = mod;
    const ctx: ResearchShellContext = {
      activeDocId: () => this.host.activeDocId(), activeTopic: () => this.activeTopicTag, setActiveTopic: tag => { this.activeTopicTag = tag; },
      openContext: () => this.openCtx, openView: (next, nextCtx) => this.open(next, nextCtx),
      inspectInReader: target => this.inspectInReader(target), notifyDocumentMutated: (docId, deleted) => this.notifyDocumentMutated(docId, deleted),
      refreshNotebook: docId => this.host.refreshNotebook?.(docId), paperFloatBar: this.floatBar, openSettings: tab => this.host.openSettings?.(tab), arxivFormat: () => this.host.arxivFormat?.() ?? 'html',
      createModelPicker: this.host.createModelPicker, currentQuestionModel: this.host.currentQuestionModel,
      aiConfigured: this.host.aiConfigured, syncActiveDocMeta: this.host.syncActiveDocMeta
    };
    this.shellCtx = ctx;
    void Promise.resolve(mod.mount(this.main, ctx)).then(() => {
      if (seq !== this.viewSeq) return;
      if (restoredState !== undefined) mod.restoreState?.(restoredState);
      this.main.scrollTop = scrollTop;
    }).catch(error => { if (seq === this.viewSeq) toast(message(error)); });
  }
}
