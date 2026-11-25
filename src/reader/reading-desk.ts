import type { TranslationFocus } from './pdf/focus.js';
import { parseZoom, type ZoomSetting } from './pdf-controls.js';
import { byId, el, readerLabel as label } from './ui.js';

export type ReadingMode = 'source' | 'bilingual';
export const compactReader = '(max-width: 700px), (max-width: 900px) and (max-height: 520px)';
type SidebarPosition = 'left' | 'right' | 'float';
type HighlightDisplay = 'inline' | 'separate';
interface DeskSettings {
  proportion?: number;
  previewHeight?: number;
  notebookWidth?: number;
  notebookDock?: SidebarPosition;
  highlightDisplay?: HighlightDisplay;
  notebookFloating?: boolean;
  notebookPosition?: { x: number; y: number };
  notebookOpen?: boolean;
  drawerOpen?: boolean;
  focus?: TranslationFocus;
  mode?: ReadingMode;
  zoom?: ZoomSetting;
}
const preference = 'reader.desk.layout';
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
function read(): DeskSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(preference) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const settings = value as DeskSettings & { compactNotebookOpen?: boolean };
    if (typeof settings.compactNotebookOpen === 'boolean') {
      // Older layouts stored the sidebar's only open/closed choice under the compact key.
      settings.notebookOpen ??= settings.compactNotebookOpen;
      settings.drawerOpen ??= settings.compactNotebookOpen;
      delete settings.compactNotebookOpen;
    }
    return settings;
  }
  catch { return {}; }
}

export class ReadingDesk {
  private settings = read();
  private narrow = matchMedia(compactReader);
  private mobileBar = matchMedia('(max-width: 520px)');
  private readingWidth = matchMedia('(max-width: 1280px)');
  private root = byId('reader');
  private returnTo?: HTMLElement;
  private discussion?: { select: HTMLSelectElement; handle: HTMLElement };
  private pdf = false;
  private book = false;
  private contents = false;
  private effectiveFocus?: TranslationFocus;
  get focus(): TranslationFocus {
    return this.settings.focus === 'column' || this.settings.focus === 'passage' || this.settings.focus === 'page' ? this.settings.focus
      : this.readingWidth.matches ? 'column' : 'page';
  }
  get zoom(): ZoomSetting { return parseZoom(this.settings.zoom); }
  get mode(): ReadingMode { return this.settings.mode === 'bilingual' ? 'bilingual' : 'source'; }
  get isNarrow(): boolean { return this.narrow.matches; } get isMobileBar(): boolean { return this.mobileBar.matches; }
  get visibleLanguage(): 'original' | 'translation' { return this.isNarrow && this.mode === 'bilingual' ? 'translation' : 'original'; }
  get notebookOpen(): boolean {
    if (this.isNarrow) return this.settings.drawerOpen ?? this.settings.notebookOpen ?? false;
    return this.settings.notebookOpen ?? this.book;
  }
  get highlightDisplay(): HighlightDisplay { return this.settings.highlightDisplay === 'separate' ? 'separate' : 'inline'; }
  private get position(): SidebarPosition {
    const dock = this.settings.notebookDock;
    if (dock === 'left' || dock === 'right' || dock === 'float') return dock;
    return this.settings.notebookFloating === true ? 'float' : 'right';
  }
  private get pose(): SidebarPosition | 'sheet' { return this.isNarrow ? 'sheet' : this.position; }
  private save(): void { localStorage.setItem(preference, JSON.stringify(this.settings)); }
  setZoom(value: ZoomSetting): void { this.settings.zoom = value; this.save(); }
  setMode(mode: ReadingMode): void { this.settings.mode = mode; this.apply(); this.save(); }
  setFocus(value: TranslationFocus): void { this.settings.focus = value; this.effectiveFocus = undefined; this.apply(); this.save(); }
  setEffectiveFocus(value: TranslationFocus): void { this.effectiveFocus = value; this.root.dataset.translationView = this.pdf ? value : 'page'; }
  setDocument(pdf: boolean, book = false): void { this.pdf = pdf; this.book = book; this.effectiveFocus = undefined; this.apply(); }
  setContents(active: boolean): void {
    this.contents = active;
    this.updateSidebarButtons();
  }
  showNotebook(value = true, drawerOnly = false): void {
    const rail = byId('rail'), active = document.activeElement;
    const trigger = byId(this.contents ? 'contentsToggle' : 'mobileRail');
    if (value && active instanceof HTMLElement && !rail.contains(active) && active !== document.body) this.returnTo = active;
    if (value === this.notebookOpen) return;
    if (drawerOnly && this.isNarrow) this.settings.drawerOpen = value;
    else {
      this.settings.notebookOpen = value;
      delete this.settings.drawerOpen;
    }
    this.applyKeepingPage();
    this.save();
    if (value) (this.isNarrow ? byId('closeRail') : rail.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus({ preventScroll: true });
    else if (rail.contains(active) || this.isNarrow) {
      (this.returnTo?.getClientRects().length ? this.returnTo : trigger).focus({ preventScroll: true });
    }
  }
  reset(): void {
    this.settings = { highlightDisplay: this.highlightDisplay };
    this.effectiveFocus = undefined;
    this.apply();
    this.save();
  }
  dismissDrawer(): boolean {
    if (!this.isNarrow || !this.notebookOpen) return false;
    this.showNotebook(false, true);
    return true;
  }
  private notebookLimits(): [number, number] {
    const max = Math.max(160, Math.min(740, this.root.clientWidth * .45));
    return [Math.min(235, max), max];
  }
  private applyKeepingPage(): void {
    const paper = byId('paperScroll'), page = byId(this.visibleLanguage === 'original' ? 'original' : 'translated');
    const offset = paper.scrollTop / Math.max(page.offsetHeight, 1);
    const translation = byId('translated');
    const translationOffset = translation.scrollTop / Math.max(translation.scrollHeight, 1);
    this.apply();
    paper.scrollTop = offset * page.offsetHeight;
    if (translationOffset) translation.scrollTop = translationOffset * translation.scrollHeight;
  }
  private syncMobileBar(): void {
    const mobile = this.mobileBar.matches, bar = byId('mobileBar');
    if (mobile === !bar.hidden) return;
    bar.hidden = !mobile;
    const toolbar = this.root.querySelector('.toolbar')!, capture = byId('captureRegion'), zoom = byId('zoomControl'), theme = byId('pdfThemeControl'), chat = this.root.querySelector('.paper-chat');
    if (mobile) { bar.append(toolbar, capture, ...(chat ? [chat] : [])); byId('menu').append(zoom, theme); }
    else { byId('mobileRail').before(toolbar, capture); toolbar.querySelector('.reader-mode-switch')!.before(zoom, theme); if (chat) byId('selectionDock').after(chat); }
  }
  private apply(): void {
    this.syncMobileBar();
    const preferred = this.pdf ? this.focus : 'page', bilingual = this.mode === 'bilingual';
    this.root.dataset.translationView = this.pdf ? (this.effectiveFocus ?? preferred) : 'page';
    this.root.dataset.readingMode = this.mode;
    this.root.dataset.compactLanguage = this.visibleLanguage;
    this.root.querySelector('.workspace')?.classList.toggle('single', !bilingual);
    byId('originalMode').setAttribute('aria-pressed', String(!bilingual));
    byId('parallel').setAttribute('aria-pressed', String(bilingual));
    this.applyNotebook();
    const previewHeight = this.settings.previewHeight;
    if (typeof previewHeight === 'number' && Number.isFinite(previewHeight)) {
      this.root.style.setProperty('--preview-height', previewHeight + 'px');
    } else this.root.style.removeProperty('--preview-height');
    const proportion = clamp(this.settings.proportion ?? (preferred === 'page' ? .5 : .62), .25, .76);
    this.root.style.setProperty('--source-track', proportion + 'fr');
    this.root.style.setProperty('--target-track', (1 - proportion) + 'fr');
    const pageSplit = byId('pageSplit');
    pageSplit.setAttribute('aria-valuemin', '25'); pageSplit.setAttribute('aria-valuemax', '76');
    pageSplit.setAttribute('aria-valuenow', String(Math.round(proportion * 100)));
    pageSplit.setAttribute('aria-valuetext', label(Math.round(proportion * 100) + '% original', '原文占 ' + Math.round(proportion * 100) + '%'));
    const scope = byId<HTMLSelectElement>('translationMode');
    scope.hidden = !this.pdf;
    scope.value = this.effectiveFocus === 'column' && this.focus === 'page' ? 'column' : this.focus;
  }
  private applyNotebook(): void {
    this.root.dataset.notebookOpen = String(this.notebookOpen);
    const rail = byId('rail');
    rail.classList.toggle('open', this.notebookOpen);
    const pose = this.pose;
    this.root.dataset.notebookPose = pose;
    const drawer = pose === 'sheet' && this.notebookOpen;
    this.root.querySelector<HTMLElement>('.workspace')!.inert = drawer;
    byId('card').inert = drawer;
    if (drawer) {
      const entering = !rail.hasAttribute('aria-modal');
      rail.setAttribute('role', 'dialog'); rail.setAttribute('aria-modal', 'true');
      if (entering && !rail.contains(document.activeElement)) byId('closeRail').focus({ preventScroll: true });
    }
    else { rail.removeAttribute('role'); rail.removeAttribute('aria-modal'); }
    byId('notebookBackdrop').hidden = !drawer;
    const handle = byId('notebookHandle'), poseControl = byId<HTMLSelectElement>('notebookPose');
    handle.tabIndex = pose === 'float' ? 0 : -1;
    const move = label('Drag or use the arrow keys to move', '拖动或用方向键移动');
    handle.title = pose === 'float' ? move : '';
    poseControl.hidden = pose === 'sheet';
    poseControl.value = this.position;
    if (this.discussion) {
      this.discussion.select.value = this.position;
      this.discussion.handle.tabIndex = pose === 'float' && !this.notebookOpen ? 0 : -1;
      this.discussion.handle.title = this.discussion.handle.tabIndex === 0 ? move : '';
    }
    this.updateSidebarButtons();
    const [small, large] = this.notebookLimits();
    const size = this.settings.notebookWidth;
    if (typeof size === 'number' && Number.isFinite(size)) this.root.style.setProperty('--rail-width', clamp(size, small, large) + 'px');
    else this.root.style.removeProperty('--rail-width');
    this.placeFloat();
    const notesSplit = byId('notesSplit');
    notesSplit.setAttribute('aria-valuemin', String(Math.round(small))); notesSplit.setAttribute('aria-valuemax', String(Math.round(large)));
    notesSplit.setAttribute('aria-valuenow', String(rail.offsetWidth));
  }
  private updateSidebarButtons(): void {
    const notes = this.notebookOpen && !this.contents, contents = this.notebookOpen && this.contents;
    const toggle = byId('mobileRail');
    toggle.ariaLabel = toggle.title = notes ? label('Hide notes', '收起笔记') : label('Show notes', '打开笔记');
    toggle.setAttribute('aria-expanded', String(notes));
    const nav = byId('contentsToggle');
    nav.title = contents ? label('Hide contents', '收起目录') : label('Show contents', '打开目录');
    nav.setAttribute('aria-expanded', String(contents));
  }
  private bindPosition(select: HTMLSelectElement, name: string, signal?: AbortSignal): void {
    select.ariaLabel = select.title = name;
    for (const [value, caption] of [['left', label('Dock left', '左侧停靠')], ['right', label('Dock right', '右侧停靠')], ['float', label('Float', '悬浮')]]) {
      const option = el('option', '', caption);
      option.value = value;
      select.append(option);
    }
    select.value = this.position;
    select.addEventListener('change', () => {
      this.settings.notebookDock = select.value as SidebarPosition;
      delete this.settings.notebookFloating;
      this.applyKeepingPage();
      this.save();
    }, { signal });
  }
  attachDiscussion(header: HTMLElement, signal: AbortSignal): void {
    const handle = header.querySelector('h3')!;
    const select = el('select', 'sidebar-position discussion-position');
    select.id = 'discussionPosition';
    handle.after(select);
    this.discussion = { select, handle };
    this.bindPosition(select, label('Discussion position', '讨论栏位置'), signal);
    this.connectFloat(handle, byId('selectionDock'), signal);
    signal.addEventListener('abort', () => { if (this.discussion?.select === select) this.discussion = undefined; }, { once: true });
    this.applyNotebook();
  }
  connect(onDefaultFocusChange: (mode: TranslationFocus) => void, onHighlightDisplay: () => void): void {
    const paper = byId('paperScroll');
    const resize = new ResizeObserver(() => this.root.style.setProperty('--paper-height', paper.clientHeight + 'px'));
    resize.observe(paper);
    const dock = byId('selectionDock'), previewGrip = byId('passageSplit');
    previewGrip.ariaLabel = previewGrip.title = label('Resize passage preview', '调整选段窗口高度');
    const maxPreviewHeight = () => Math.max(64, Math.floor(innerHeight * .65));
    new ResizeObserver(() => {
      this.placeFloat();
      previewGrip.setAttribute('aria-valuemin', '64');
      previewGrip.setAttribute('aria-valuemax', String(maxPreviewHeight()));
      previewGrip.setAttribute('aria-valuenow', String(dock.offsetHeight));
    }).observe(dock);
    this.split(previewGrip, (change, reset) => {
      this.settings.previewHeight = reset ? undefined : clamp(dock.offsetHeight - change, 64, maxPreviewHeight());
    });
    window.addEventListener('resize', () => this.apply()); this.mobileBar.addEventListener('change', () => this.apply());
    const viewport = window.visualViewport;
    if (viewport) {
      const fitSheet = () => {
        this.root.style.setProperty('--sheet-viewport-height', viewport.height + 'px');
        this.root.style.setProperty('--sheet-bottom', Math.max(0, this.root.clientHeight - viewport.offsetTop - viewport.height) + 'px');
      };
      viewport.addEventListener('resize', fitSheet);
      viewport.addEventListener('scroll', fitSheet);
      fitSheet();
    }
    this.readingWidth.addEventListener('change', () => {
      if (!this.settings.focus) onDefaultFocusChange(this.focus);
    });
    byId('closeRail').addEventListener('click', () => this.showNotebook(false));
    byId('notebookBackdrop').addEventListener('click', () => this.showNotebook(false));
    byId('rail').addEventListener('keydown', event => this.notebookKey(event));
    this.bindPosition(byId<HTMLSelectElement>('notebookPose'), label('Sidebar position', '侧边栏位置'));
    const display = byId<HTMLSelectElement>('highlightDisplay');
    display.value = this.highlightDisplay;
    display.addEventListener('change', () => {
      this.settings.highlightDisplay = display.value === 'separate' ? 'separate' : 'inline';
      this.save(); onHighlightDisplay();
    });
    this.connectFloat(byId('notebookHandle'), byId('rail'));
    this.split(byId('pageSplit'), (change, reset) => {
      const grid = paper.querySelector<HTMLElement>('.pages')!;
      const total = grid.clientWidth - byId('pageSplit').offsetWidth;
      const width = byId('original').getBoundingClientRect().width;
      const min = Math.min(.43, Math.max(.25, 200 / Math.max(total, 1)));
      this.settings.proportion = reset ? undefined : clamp((width + change) / total, min, 1 - min);
    });
    this.split(byId('notesSplit'), (change, reset) => {
      const width = byId('rail').getBoundingClientRect().width;
      this.settings.notebookWidth = reset ? undefined : clamp(width + (this.pose === 'left' ? change : -change), ...this.notebookLimits());
    });
    this.apply();
  }
  private notebookKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.showNotebook(false);
      return;
    }
    if (event.key !== 'Tab' || this.pose !== 'sheet') return;
    const candidates = byId('rail').querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], summary, [tabindex], [contenteditable="true"]');
    const controls = Array.from(candidates).filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus({ preventScroll: true });
    }
  }
  private placeFloat(): void {
    if (this.pose !== 'float') return;
    const panel = byId(this.notebookOpen ? 'rail' : 'selectionDock');
    if (!panel.offsetWidth) return;
    const at = this.settings.notebookPosition;
    this.positionFloat(panel, at?.x ?? this.root.clientWidth - panel.offsetWidth - 20, at?.y ?? 64);
  }
  private positionFloat(rail: HTMLElement, x: number, y: number): void {
    const left = clamp(Number.isFinite(x) ? x : 0, 0, this.root.clientWidth - rail.offsetWidth);
    const top = clamp(Number.isFinite(y) ? y : 0, 0, this.root.clientHeight - rail.offsetHeight);
    this.root.style.setProperty('--float-x', left + 'px');
    this.root.style.setProperty('--float-y', top + 'px');
  }
  private connectFloat(handle: HTMLElement, rail: HTMLElement, signal?: AbortSignal): void {
    let held: { id: number; dx: number; dy: number } | undefined;
    const remember = () => {
      this.settings.notebookPosition = { x: rail.offsetLeft, y: rail.offsetTop };
      this.save();
    };
    handle.addEventListener('pointerdown', event => {
      if (this.pose !== 'float' || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      held = { id: event.pointerId, dx: event.clientX - rail.offsetLeft, dy: event.clientY - rail.offsetTop };
      handle.setPointerCapture(event.pointerId);
    }, { signal });
    handle.addEventListener('pointermove', event => {
      if (held?.id === event.pointerId && this.pose === 'float') this.positionFloat(rail, event.clientX - held.dx, event.clientY - held.dy);
    }, { signal });
    handle.addEventListener('lostpointercapture', () => { if (held && this.pose === 'float') remember(); held = undefined; }, { signal });
    handle.addEventListener('keydown', event => {
      if (this.pose !== 'float') return;
      const distance = event.shiftKey ? 60 : 20;
      const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
      const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      event.stopPropagation();
      this.positionFloat(rail, rail.offsetLeft + dx, rail.offsetTop + dy);
      remember();
    }, { signal });
  }
  private split(grip: HTMLElement, adjust: (delta: number, reset: boolean) => void): void {
    let pointer: number | undefined, last = 0;
    const horizontal = () => grip.getAttribute('aria-orientation') === 'horizontal';
    const coordinate = (event: PointerEvent) => horizontal() ? event.clientY : event.clientX;
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); grip.focus({ preventScroll: true });
      pointer = event.pointerId; last = coordinate(event);
      grip.setPointerCapture(pointer);
      this.root.classList.add('is-resizing');
    });
    grip.addEventListener('pointermove', event => {
      if (pointer !== event.pointerId) return;
      adjust(coordinate(event) - last, false); last = coordinate(event); this.applyKeepingPage();
    });
    grip.addEventListener('lostpointercapture', () => {
      pointer = undefined; this.root.classList.remove('is-resizing'); this.save();
    });
    grip.addEventListener('keydown', event => {
      const [decrease, increase] = horizontal() ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
      if (![decrease, increase, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const distance = event.key === 'Home' || event.key === 'End' ? (horizontal() ? innerHeight : innerWidth) : event.shiftKey ? 60 : 20;
      const reversed = grip.id === 'passageSplit' || (grip.id === 'notesSplit' && this.pose === 'right');
      adjust(event.key === decrease || event.key === (reversed ? 'End' : 'Home') ? -distance : distance, false);
      this.applyKeepingPage(); this.save();
    });
    grip.addEventListener('dblclick', () => { adjust(0, true); this.applyKeepingPage(); this.save(); });
  }
}
