import type { DocPageHit, TopicRecord } from '../../shared/types.js';
import { api, byId, el, message, toast } from '../ui.js';
import { researchIcon } from './icons.js';
import { RESEARCH_VIEWS, researchText, researchViewMeta, researchViewName, type ResearchViewId } from './labels.js';
import type { InspectTarget, ResearchOpenContext, ResearchShellContext, ResearchViewModule, ResearchWorkspaceHost, ReturnAnchor, WorkspaceSnapshot } from './state.js';

interface DefaultViewState { query: string; hits: DocPageHit[]; searched: boolean; topic: string }

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
  private opened = false; private overlayOpen = false; private activeView: ResearchViewId = 'deep-search'; private activeTopicTag = '';
  private returnAnchor?: ReturnAnchor; private snapshot?: WorkspaceSnapshot; private openCtx?: ResearchOpenContext;
  private activeModule?: ResearchViewModule; private viewSeq = 0;
  private defaultState: DefaultViewState = { query: '', hits: [], searched: false, topic: '' };

  constructor(private readonly host: ResearchWorkspaceHost) {
    this.root.id = 'researchWorkspace'; this.root.hidden = true; this.root.ariaLabel = researchText.workspace();
    this.backdrop.hidden = true; this.main.tabIndex = -1;
    this.backdrop.addEventListener('click', () => { this.overlayOpen = false; this.syncRail(); });
    const mobileBar = el('header', 'rw-mobile-bar'), mobileCollapse = el('button', 'icon-btn rw-mobile-collapse');
    mobileCollapse.type = 'button'; mobileCollapse.ariaLabel = mobileCollapse.title = researchText.collapse();
    mobileCollapse.append(researchIcon('collapse', 18)); mobileCollapse.addEventListener('click', () => { void this.collapse(); });
    this.mobileSelect.ariaLabel = researchText.viewsNav();
    this.mobileSelect.addEventListener('change', () => { this.openCtx = undefined; this.switchView(this.mobileSelect.value as ResearchViewId); });
    mobileBar.append(mobileCollapse, this.mobileSelect);
    const railHead = el('div', 'rw-rail-head'), collapseBtn = el('button', 'rw-collapse-btn');
    collapseBtn.type = 'button'; collapseBtn.ariaLabel = collapseBtn.title = collapseBtn.dataset.tooltip = researchText.collapse();
    collapseBtn.append(researchIcon('collapse', 18), el('span', 'rw-label', researchText.collapse()));
    collapseBtn.addEventListener('click', () => { void this.collapse(); });
    this.railToggle.type = 'button'; this.railToggle.append(researchIcon('railToggle', 18));
    this.railToggle.addEventListener('click', () => this.toggleRail());
    railHead.append(collapseBtn, this.railToggle);
    const nav = el('nav', 'rw-nav'); nav.setAttribute('role', 'navigation'); nav.ariaLabel = researchText.viewsNav();
    for (const view of RESEARCH_VIEWS) {
      const name = researchViewName(view.id), btn = el('button', 'rw-nav-btn');
      btn.type = 'button'; btn.dataset.view = view.id; btn.ariaLabel = btn.title = btn.dataset.tooltip = name;
      btn.append(researchIcon(view.id, 18), el('span', 'rw-label', name));
      btn.addEventListener('click', () => { this.openCtx = undefined; if (this.overlayOpen) this.overlayOpen = false; this.switchView(view.id); });
      this.navButtons.set(view.id, btn); nav.append(btn); this.mobileSelect.append(new Option(name, view.id));
    }
    this.rail.append(railHead, nav); this.root.append(mobileBar, this.rail, this.backdrop, this.main); byId('reader').after(this.root);
    this.returnPill.id = 'returnWorkspace'; this.returnPill.hidden = true;
    this.returnPill.setAttribute('role', 'region'); this.returnPill.ariaLabel = researchText.workspace();
    this.returnGo.type = 'button'; this.returnGo.addEventListener('click', () => this.resumeFromPill());
    const returnClose = el('button', 'icon-btn return-workspace-close');
    returnClose.type = 'button'; returnClose.ariaLabel = returnClose.title = researchText.dismissReturn();
    returnClose.append(researchIcon('close', 14)); returnClose.addEventListener('click', () => this.dismissReturn());
    this.returnPill.append(this.returnGo, returnClose); byId('returnDiscussion').after(this.returnPill);
    window.addEventListener('resize', () => { if (this.opened) this.syncRail(); });
  }

  registerView(mod: ResearchViewModule): void { this.modules.set(mod.id, mod); }
  isOpen(): boolean { return this.opened; }
  notifyDocumentMutated(docId: string, deleted = false): void {
    if (deleted && this.returnAnchor?.doc === docId) this.returnAnchor = undefined;
    this.activeModule?.onDocumentMutated?.(docId);
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
    this.activeModule?.unmount?.(); this.activeModule = undefined;
    this.opened = this.overlayOpen = false; this.root.hidden = this.returnPill.hidden = true; this.snapshot = undefined;
    byId('reader').hidden = false;
    const anchor = this.returnAnchor; this.returnAnchor = undefined;
    if (anchor) { try { await this.host.restorePosition(anchor); } catch (err) { toast(message(err)); } }
    this.host.focusAfterCollapse();
  }
  async inspectInReader(target: InspectTarget): Promise<void> {
    const seq = ++this.viewSeq;
    const viewState = this.activeModule ? this.activeModule.saveState?.() : { ...this.defaultState, topic: this.activeTopicTag };
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
    if (this.overlayOpen) { this.overlayOpen = false; this.syncRail(); this.railToggle.focus({ preventScroll: true }); return true; }
    const active = document.activeElement;
    if (active instanceof Element && active.closest('#researchWorkspace') && active.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return false;
    if (this.activeModule?.handleEscape?.()) return true;
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

  private switchView(view: ResearchViewId, restoredState?: unknown, scrollTop = 0): void {
    const seq = ++this.viewSeq;
    this.activeModule?.unmount?.(); this.activeModule = undefined; this.activeView = view; this.mobileSelect.value = view;
    for (const [id, btn] of this.navButtons) { if (id === view) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current'); }
    this.syncRail(); this.main.replaceChildren();
    const mod = this.modules.get(view);
    if (mod) {
      this.activeModule = mod;
      const ctx: ResearchShellContext = {
        activeDocId: () => this.host.activeDocId(), activeTopic: () => this.activeTopicTag, setActiveTopic: tag => { this.activeTopicTag = tag; },
        openContext: () => this.openCtx, openView: (next, nextCtx) => this.open(next, nextCtx),
        inspectInReader: target => this.inspectInReader(target), notifyDocumentMutated: (docId, deleted) => this.notifyDocumentMutated(docId, deleted)
      };
      void Promise.resolve(mod.mount(this.main, ctx)).then(() => {
        if (seq !== this.viewSeq) return;
        if (restoredState !== undefined) mod.restoreState?.(restoredState);
        this.main.scrollTop = scrollTop;
      }).catch(error => { if (seq === this.viewSeq) toast(message(error)); });
      return;
    }
    this.mountDefaultView(view, seq, restoredState as DefaultViewState | undefined);
    this.main.scrollTop = scrollTop;
  }

  private mountDefaultView(view: ResearchViewId, seq: number, restored?: DefaultViewState): void {
    let activeSearch = 0;
    if (restored) { this.defaultState = { ...restored }; this.activeTopicTag = restored.topic; }
    const wrap = el('section', 'rw-shell-view'), head = el('div', 'rw-view-head'), topicBar = el('div', 'rw-topic-bar');
    const topicLabel = el('label', 'rw-topic-label', researchText.topicLabel()), topicSelect = el('select', 'rw-topic-select');
    topicSelect.id = 'rwTopicSelect'; topicLabel.htmlFor = topicSelect.id;
    const newTopicBtn = el('button', 'btn rw-topic-add-btn', '+ ' + researchText.newTopic()); newTopicBtn.type = 'button';
    const topicForm = el('form', 'rw-topic-form'), topicInput = el('input', 'search rw-topic-input'), topicSave = el('button', 'btn primary', researchText.saveTopic());
    topicForm.hidden = true; topicInput.type = 'text'; topicInput.required = true; topicInput.placeholder = researchText.topicPlaceholder(); topicInput.ariaLabel = researchText.newTopic(); topicSave.type = 'submit';
    topicForm.append(topicInput, topicSave); topicBar.append(topicLabel, topicSelect, newTopicBtn); head.append(el('h1', 'rw-view-title', researchViewName(view)), topicBar);
    const searchForm = el('form', 'rw-search-form'), searchInput = el('input', 'search rw-search-input'), searchBtn = el('button', 'btn primary', researchText.searchAction());
    searchInput.type = 'search'; searchInput.value = restored ? this.defaultState.query : (this.openCtx?.query ?? this.defaultState.query);
    searchInput.ariaLabel = researchText.searchLabel(); searchInput.placeholder = researchText.searchPlaceholder(); searchBtn.type = 'submit';
    searchForm.append(searchInput, searchBtn);
    const status = el('p', 'rw-status', researchText.searchHint()), results = el('ul', 'rw-results');
    status.setAttribute('role', 'status'); wrap.append(head, topicForm, searchForm, status, results); this.main.append(wrap);
    const renderTopics = (topics: TopicRecord[]) => { topicSelect.replaceChildren(new Option(researchText.allTopics(), ''), ...topics.map(t => new Option(t.name, t.tag))); topicSelect.value = this.activeTopicTag; };
    const renderHits = (hits: DocPageHit[], searched: boolean) => {
      results.replaceChildren(); status.textContent = searched ? (hits.length ? '' : researchText.searchEmpty()) : researchText.searchHint();
      for (const hit of hits) {
        const li = el('li'), btn = el('button', 'rw-hit'), top = el('div', 'rw-hit-head');
        btn.type = 'button'; top.append(el('strong', 'rw-hit-title', hit.docTitle), el('span', 'rw-hit-page', researchText.pageBadge(hit.page)));
        btn.append(top, el('p', 'rw-hit-snippet', hit.snippet));
        btn.addEventListener('click', () => { void this.inspectInReader({ docId: hit.docId, page: hit.page, quote: hit.snippet }).catch(err => toast(message(err))); });
        li.append(btn); results.append(li);
      }
    };
    renderTopics([]); renderHits(this.defaultState.hits, this.defaultState.searched);
    void api('topics.list', {}).then(({ topics }) => { if (seq === this.viewSeq) renderTopics(topics); }).catch(() => undefined);
    topicSelect.addEventListener('change', () => { this.activeTopicTag = this.defaultState.topic = topicSelect.value; });
    searchInput.addEventListener('input', () => { this.defaultState.query = searchInput.value; });
    newTopicBtn.addEventListener('click', () => { topicForm.hidden = !topicForm.hidden; if (!topicForm.hidden) topicInput.focus(); });
    topicForm.addEventListener('submit', async event => {
      event.preventDefault(); const name = topicInput.value.trim(); if (!name) return; topicSave.disabled = true;
      try { const { topic } = await api('topics.save', { name }), { topics } = await api('topics.list', {}); if (seq !== this.viewSeq) return; this.activeTopicTag = this.defaultState.topic = topic.tag; renderTopics(topics); topicInput.value = ''; topicForm.hidden = true; }
      catch (err) { if (seq === this.viewSeq) toast(message(err)); } finally { topicSave.disabled = false; }
    });
    searchForm.addEventListener('submit', async event => {
      event.preventDefault(); const query = searchInput.value.trim(), topic = this.activeTopicTag, searchSeq = ++activeSearch; this.defaultState.query = query;
      if (!query) { searchBtn.disabled = false; this.defaultState.hits = []; this.defaultState.searched = false; renderHits([], false); return; }
      searchBtn.disabled = true; status.textContent = researchText.searching();
      try {
        const docIds = topic ? (await api('library.list', {})).docs.filter(d => d.meta?.tags?.includes(topic)).map(d => d.id) : undefined;
        const { hits } = await api('pages.search', { query, ...(docIds ? { docIds } : {}), limit: 30 });
        if (seq !== this.viewSeq || searchSeq !== activeSearch) return;
        this.defaultState = { query, hits, searched: true, topic }; renderHits(hits, true);
      } catch (err) { if (seq === this.viewSeq && searchSeq === activeSearch) { toast(message(err)); status.textContent = message(err); } }
      finally { if (searchSeq === activeSearch) searchBtn.disabled = false; }
    });
  }
}
