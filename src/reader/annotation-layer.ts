import type { PaperAnnotation } from '../shared/annotations.js';
import { readSelectionRange, readTranslatedLocator, type SavedSelectionRange } from '../shared/source-link.js';
import type { PageView, ReaderBlock, ReadingSide } from '../shared/types.js';
import { pairSelection } from './pdf/alignment.js';
import { restoreSelection } from './saved-selection.js';
import { ANNOTATION_COLORS, highlightName } from './annotation-colors.js';
import { el, icon, readerLabel as t } from './ui.js';

type Point = { x: number; y: number };

/** Each pane keeps ownership of its text nodes and of the passage order used when capturing selections. */
interface AnnotationPane {
  host: HTMLElement;
  side: ReadingSide;
  ranges(id: string, quote: string, offset?: number): Range[];
}
interface AnnotationSurface {
  original: HTMLElement;
  panes: AnnotationPane[];
  blocks(range: SavedSelectionRange | undefined, side: ReadingSide): ReaderBlock[];
  revealPassage?(id: string, translation?: string, offset?: number): void;
  signal: AbortSignal;
}
const surfaces = new WeakMap<PageView, AnnotationSurface>();

export function withAnnotationSurface<T extends PageView>(view: T, surface: AnnotationSurface): T {
  surfaces.set(view, surface);
  return view;
}

export function annotationLayoutChanged(original: HTMLElement): void {
  original.dispatchEvent(new Event('annotation-layout'));
}

function passages(mark: PaperAnnotation, surface: AnnotationSurface) {
  const url = URL.parse(mark.sourceUrl, location.href);
  const target = url && readTranslatedLocator(url);
  const range = url ? readSelectionRange(url) : undefined;
  const side = target ? 'translation' : 'source';
  const blocks = surface.blocks(range, side);
  const quote = url?.searchParams.get('quote') || mark.quote;
  const restored = range && restoreSelection(blocks, mark.anchor, quote, target || undefined, range);
  if (restored) return { parts: restored, side };
  const block = blocks.find(entry => entry.id === mark.anchor);
  if (!block) return { parts: [], side };
  // The saved original also survives a delayed or replaced translation.
  const text = target?.text || mark.quote;
  const paired = pairSelection(block, text, target ? 'translated' : 'original', target?.offset);
  if (target) paired.original = mark.quote;
  return { parts: [{ id: block.id, ...paired, offset: target?.offset }], side };
}

interface MountedPane {
  pane: AnnotationPane;
  overlay: HTMLElement;
  buttons: Map<string, HTMLButtonElement>;
}
interface MarkTarget {
  button: HTMLButtonElement;
  records: PaperAnnotation[];
  ranges: Range[];
}
const visible = (node: HTMLElement) => node.isConnected && node.getBoundingClientRect().width > 0;
const fraction = (value: number) => Math.max(0, Math.min(1, value));
const label = (a: PaperAnnotation) => (a.text.trim() || a.quote || a.label).replace(/\s+/gu, ' ').slice(0, 100);

function placeAt(node: HTMLElement, point: Point): void {
  node.style.left = fraction(point.x) * 100 + '%';
  node.style.top = fraction(point.y) * 100 + '%';
}

function firstVisibleLine(ranges: Range[], pane: DOMRect): DOMRect | undefined {
  for (const range of ranges) {
    const clip = range.startContainer.parentElement?.closest('.pdf-translated-text')?.getBoundingClientRect() ?? pane;
    for (const rect of range.getClientRects()) {
      const x = Math.max(rect.left, clip.left, pane.left), y = Math.max(rect.top, clip.top, pane.top);
      const width = Math.min(rect.right, clip.right, pane.right) - x, height = Math.min(rect.bottom, clip.bottom, pane.bottom) - y;
      if (width > .4 && height > .4) return new DOMRect(x, y, width, height);
    }
  }
}

export class AnnotationLayer {
  private surface?: AnnotationSurface;
  private binding?: AbortController;
  private records: PaperAnnotation[] = [];
  private panes: MountedPane[] = [];
  private targets: MarkTarget[] = [];
  private frame = 0;
  private chooser?: { box: HTMLElement; trigger: HTMLButtonElement; records: PaperAnnotation[] };
  private placement?: HTMLButtonElement;
  private locator?: HTMLButtonElement;

  constructor(private onOpen: (id: string, trigger: HTMLElement) => void, private onPlace: (point: Point) => void,
    private onCancel?: () => void) {}

  render(annotations: PaperAnnotation[], view: PageView | undefined): void {
    const next = view && surfaces.get(view);
    if (next !== this.surface) {
      this.destroy();
      if (next && !next.signal.aborted) this.bind(next);
    }
    this.records = annotations;
    this.paint();
  }

  private bind(surface: AnnotationSurface): void {
    this.surface = surface;
    this.binding = new AbortController();
    const { signal } = this.binding;
    const resize = new ResizeObserver(this.schedule);
    for (const pane of surface.panes) {
      const overlay = el('div', 'annotation-layer');
      pane.host.append(overlay);
      this.panes.push({ pane, overlay, buttons: new Map() });
      resize.observe(pane.host);
      // Keep glyphs selectable and allow citation hover on the original PDF.js text nodes.
      pane.host.addEventListener('click', event => this.hitTest(event, pane.host), { capture: true, signal });
      pane.host.addEventListener('scroll', this.schedule, { capture: true, signal });
    }
    surface.original.addEventListener('annotation-layout', this.schedule, { signal });
    document.addEventListener('scroll', () => this.positionChooser(), { capture: true, signal });
    window.addEventListener('resize', this.schedule, { signal });
    surface.signal.addEventListener('abort', () => this.destroy(), { once: true, signal });
    signal.addEventListener('abort', () => resize.disconnect(), { once: true });
  }

  private schedule = (): void => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
  };

  private paint(): void {
    const surface = this.surface;
    if (!surface) return;
    this.targets = [];
    const live = new Set<HTMLButtonElement>();
    const ink = new Map(ANNOTATION_COLORS.map(color => [color, new Highlight()]));
    const marks = this.records.filter(a => a.kind === 'highlight').map(mark => ({ mark, ...passages(mark, surface) }));
    for (const mounted of this.panes) {
      const { pane, overlay, buttons } = mounted;
      const box = overlay.getBoundingClientRect();
      if (box.width && box.height) {
        for (const { mark, parts, side } of marks) {
          const ranges = parts.flatMap(part => pane.ranges(part.id,
            pane.side === 'source' ? part.original : part.translated ?? '', side === pane.side ? part.offset : undefined));
          if (!ranges.length) continue;
          for (const range of ranges) ink.get(mark.color)?.add(range);
          const line = firstVisibleLine(ranges, box);
          if (!line) continue;
          const button = this.control(mounted, 'highlight:' + mark.id, 'annotation-highlight', [mark], ranges);
          button.ariaLabel = highlightName(mark.color) + ' · ' + label(mark);
          Object.assign(button.style, { left: line.left - box.left + 'px', top: line.top - box.top + 'px',
            width: line.width + 'px', height: line.height + 'px' });
          live.add(button);
        }
        if (pane.host === surface.original) {
          const groups: PaperAnnotation[][] = [];
          for (const note of this.records) {
            if (note.kind !== 'pin' || !note.point) continue;
            const point = note.point;
            const group = groups.find(([first]) => Math.abs(point.x - first.point!.x) * box.width < 33 &&
              Math.abs(point.y - first.point!.y) * box.height < 29);
            if (group) group.push(note);
            else groups.push([note]);
          }
          for (const group of groups) {
            const first = group[0];
            const button = this.control(mounted, 'pin:' + first.id, 'annotation-pin', group, []);
            placeAt(button, first.point!);
            if (button.dataset.count !== String(group.length)) {
              button.dataset.count = String(group.length);
              button.replaceChildren(icon('note', 14), ...(group.length > 1 ? [String(group.length)] : []));
            }
            button.title = button.ariaLabel = group.length > 1
              ? t('Choose from ' + group.length + ' page notes', '选择此处 ' + group.length + ' 条页边笔记之一')
              : t('Open page note', '打开页边笔记') + ' · ' + label(first);
            if (group.length > 1) button.setAttribute('aria-haspopup', 'dialog');
            else button.removeAttribute('aria-haspopup');
            live.add(button);
          }
        }
      }
      for (const [key, button] of buttons) {
        if (live.has(button)) continue;
        if (button === this.chooser?.trigger) this.closeChooser();
        button.remove(); buttons.delete(key);
      }
    }
    for (const [color, highlight] of ink) {
      const name = 'paper-annotation-' + color;
      if (highlight.size) { highlight.priority = -1; CSS.highlights.set(name, highlight); }
      else CSS.highlights.delete(name);
    }
    this.positionChooser();
  }

  private control(mounted: MountedPane, key: string, css: string, records: PaperAnnotation[], ranges: Range[]): HTMLButtonElement {
    let button = mounted.buttons.get(key);
    if (!button) {
      button = el('button', css);
      button.type = 'button';
      button.addEventListener('click', event => {
        event.stopPropagation();
        const target = this.targets.find(item => item.button === button);
        if (target) this.activate(target);
      });
      mounted.overlay.append(button);
      mounted.buttons.set(key, button);
    }
    button.dataset.annotationId = records[0].id;
    button.dataset.color = records[0].color;
    this.targets.push({ button, records, ranges });
    return button;
  }

  private hitTest(event: MouseEvent, host: HTMLElement): void {
    const glyph = event.target;
    if (event.button || !event.detail || this.placement || !document.getSelection()?.isCollapsed ||
        !(glyph instanceof Element) || glyph.closest('button, a, .annotation-layer')) return;
    for (const target of this.targets) {
      if (!host.contains(target.button)) continue;
      const hit = target.ranges.some(range => glyph.contains(range.startContainer) &&
        Array.from(range.getClientRects()).some(r => event.clientX >= r.left && event.clientX < r.right &&
          event.clientY >= r.top && event.clientY < r.bottom));
      if (!hit) continue;
      event.stopImmediatePropagation();
      this.activate(target);
      return;
    }
  }

  private activate(target: MarkTarget): void {
    if (this.placement) return;
    this.closeChooser();
    const { records, button } = target;
    if (records.length === 1) { this.onOpen(records[0].id, button); return; }
    const box = el('div', 'annotation-chooser');
    box.popover = 'auto'; box.setAttribute('role', 'dialog'); box.ariaLabel = t('Page notes at this position', '此处的页边笔记');
    box.append(el('strong', '', t('Page notes at this position', '此处的页边笔记')));
    records.forEach((record, index) => {
      const choice = el('button', '', (index + 1) + '. ' + label(record));
      choice.type = 'button';
      choice.onclick = () => { this.closeChooser(); this.onOpen(record.id, button); };
      box.append(choice);
    });
    box.addEventListener('toggle', () => { if (!box.matches(':popover-open') && this.chooser?.box === box) this.closeChooser(); });
    box.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      this.closeChooser(); button.focus({ preventScroll: true });
    });
    document.body.append(box);
    this.chooser = { box, trigger: button, records };
    button.ariaExpanded = 'true';
    box.showPopover();
    this.positionChooser();
    box.querySelector('button')?.focus({ preventScroll: true });
  }

  private positionChooser(): void {
    if (!this.chooser) return;
    const { box, trigger, records } = this.chooser;
    const current = this.targets.find(target => target.button === trigger)?.records;
    if (current?.length !== records.length || records.some((r, i) => r.id !== current[i].id || label(r) !== label(current[i]))) {
      const restoreFocus = box.contains(document.activeElement);
      this.closeChooser();
      if (restoreFocus && visible(trigger)) trigger.focus({ preventScroll: true });
      return;
    }
    const rect = trigger.getBoundingClientRect();
    box.style.left = Math.max(6, Math.min(rect.left, innerWidth - box.offsetWidth - 6)) + 'px';
    const top = rect.bottom + box.offsetHeight + 6 < innerHeight ? rect.bottom + 4 : rect.top - box.offsetHeight - 4;
    box.style.top = Math.max(6, top) + 'px';
  }

  private closeChooser(): void {
    if (!this.chooser) return;
    this.chooser.trigger.ariaExpanded = 'false';
    this.chooser.box.remove();
    this.chooser = undefined;
  }

  trigger(id: string): HTMLElement | undefined {
    const matches = this.targets.filter(t => t.records.some(a => a.id === id) && visible(t.button));
    const translated = matches[0]?.records[0].sourceUrl;
    if (translated && URL.parse(translated, location.href)?.searchParams.has('targetQuote')) {
      const peer = matches.find(t => this.panes.some(p => p.pane.side === 'translation' && p.overlay.contains(t.button)));
      if (peer) return peer.button;
    }
    return matches[0]?.button;
  }

  locate(annotation: PaperAnnotation): boolean {
    if (annotation.kind === 'highlight' && this.surface?.revealPassage) {
      const { parts, side } = passages(annotation, this.surface);
      const first = parts[0];
      if (first) this.surface.revealPassage(first.id, first.translated, side === 'translation' ? first.offset : undefined);
    }
    this.paint();
    const button = this.trigger(annotation.id);
    if (!button) return false;
    this.reveal(button);
    return true;
  }

  locatePoint(point: Point): boolean {
    const page = this.surface?.original;
    if (!page || !visible(page)) return false;
    this.locator?.remove();
    const marker = el('button', 'annotation-location');
    marker.type = 'button'; marker.tabIndex = -1; marker.ariaLabel = t('Referenced page position', '引用的页面位置');
    marker.append(icon('pin', 16));
    placeAt(marker, point);
    page.append(marker); this.locator = marker;
    marker.onblur = () => { marker.remove(); if (this.locator === marker) this.locator = undefined; };
    this.reveal(marker);
    return true;
  }

  private reveal(node: HTMLElement): void {
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    node.focus({ preventScroll: true });
  }

  place(enable: boolean): void {
    this.placement?.remove(); this.placement = undefined;
    const page = this.surface?.original;
    if (!enable || !page || !visible(page)) return;
    this.closeChooser();
    const tool = el('button', 'annotation-placement');
    const cross = el('span', 'annotation-crosshair');
    tool.type = 'button';
    tool.ariaLabel = t('Place page note. Use the arrow keys to move, Enter to place, or Escape to cancel.', '放置页边笔记。用方向键移动，按回车放置，按 Esc 取消。');
    const box = page.getBoundingClientRect();
    const scroller = page.closest('#paperScroll')?.getBoundingClientRect();
    const center = (from: number, to: number, min: number, max: number) =>
      fraction(((Math.max(from, min) + Math.min(to, max)) / 2 - from) / (to - from));
    let point = { x: center(box.left, box.right, scroller?.left ?? 0, scroller?.right ?? innerWidth),
      y: center(box.top, box.bottom, scroller?.top ?? 0, scroller?.bottom ?? innerHeight) };
    const track = (event: MouseEvent) => {
      const r = tool.getBoundingClientRect();
      point = { x: fraction((event.clientX - r.left) / r.width), y: fraction((event.clientY - r.top) / r.height) };
      placeAt(cross, point);
    };
    const finish = () => { this.place(false); this.onPlace(point); };
    tool.onpointermove = track;
    tool.onclick = event => { event.stopPropagation(); if (event.detail) track(event); finish(); };
    tool.onkeydown = event => {
      const step = event.shiftKey ? .05 : .01;
      if (event.key === 'ArrowRight') point.x = fraction(point.x + step);
      else if (event.key === 'ArrowLeft') point.x = fraction(point.x - step);
      else if (event.key === 'ArrowDown') point.y = fraction(point.y + step);
      else if (event.key === 'ArrowUp') point.y = fraction(point.y - step);
      else if (event.key === 'Escape') { this.place(false); this.onCancel?.(); }
      else if (event.key === 'Enter' || event.key === ' ') finish();
      else return;
      event.preventDefault(); event.stopPropagation();
      if (tool.isConnected) {
        placeAt(cross, point);
        cross.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    };
    placeAt(cross, point); tool.append(cross); page.append(tool);
    this.placement = tool; tool.focus({ preventScroll: true });
  }

  destroy(): void {
    this.binding?.abort(); this.binding = undefined;
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.closeChooser(); this.place(false);
    this.locator?.remove(); this.locator = undefined;
    for (const { overlay } of this.panes) overlay.remove();
    for (const color of ANNOTATION_COLORS) CSS.highlights.delete('paper-annotation-' + color);
    this.panes = []; this.targets = []; this.records = []; this.surface = undefined;
  }
}
