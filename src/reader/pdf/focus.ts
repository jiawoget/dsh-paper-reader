import type { Box, PageLayout, Passage } from './model.js';
import type { Sheet } from './paper.js';
import { readerLabel } from '../ui.js';

export type TranslationFocus = 'page' | 'column' | 'passage';
interface FocusEntry { passage: Passage; source: HTMLElement; target: HTMLElement; translated: HTMLElement }
interface Column { left: number; right: number }

/** Infer printed gutters from overlapping runs of prose. Wide titles and abstracts can span them. */
function columns(layout: PageLayout): Column[] {
  const page = layout.window;
  const prose = layout.passages.filter(p => p.role === 'paragraph' && p.box.width > page.width * .18 &&
    p.box.width < page.width * .66).map(p => p.box).sort((a, b) => a.x - b.x);
  const groups: Box[][] = [];
  for (const rect of prose) {
    const group = groups.at(-1);
    if (group && rect.x - group[0].x < page.width * .10) group.push(rect);
    else groups.push([rect]);
  }
  const boundaries = [page.x];
  for (let i = 1; i < groups.length; i++) {
    const left = groups[i - 1], right = groups[i];
    const ends = left.flatMap(a => right.some(b => Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height) &&
      a.x + a.width <= b.x + 1) ? [a.x + a.width] : []);
    if (ends.length) boundaries.push((Math.max(...ends) + right[0].x) / 2);
  }
  boundaries.push(page.x + page.width);
  return boundaries.slice(1).map((right, i) => ({ left: boundaries[i], right }));
}

export class PdfFocus {
  private readonly columns: Column[];
  private id = '';
  private mode: TranslationFocus;
  private effective: TranslationFocus = 'page';
  private narrowLane = false;
  private allowNarrowPage = false;
  constructor(private layout: PageLayout, private entries: Map<string, FocusEntry>, private source: Sheet,
    private target: Sheet, mode: TranslationFocus, initial: string | undefined,
    private changed: (id: string, label: string, effective: TranslationFocus, degraded: boolean) => void,
    private repaint: (refit: boolean) => void, signal: AbortSignal, private targetLabel = 'Simplified Chinese') {
    this.columns = columns(layout);
    this.mode = mode;
    this.id = initial && layout.passages.some(p => p.id === initial) ? initial :
      (layout.passages.find(p => p.role === 'paragraph') ?? layout.passages[0])?.id ?? '';
    this.apply();
    source.outer.addEventListener('click', event => {
      const id = event.target instanceof Element && event.target.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
      if (id) { this.focus(id); return; }
      const plane = source.plane.getBoundingClientRect(), scale = plane.width / source.plane.offsetWidth;
      if (!scale) return;
      const x = (event.clientX - plane.x) / scale, y = (event.clientY - plane.y) / scale;
      const distance = ({ box: b }: Passage) => 4 * Math.max(0, b.x - x, x - b.x - b.width) + Math.max(0, b.y - y, y - b.y - b.height);
      const nearest = layout.passages.reduce<Passage | undefined>((best, entry) =>
        !best || distance(entry) < distance(best) ? entry : best, undefined);
      if (nearest) this.focus(nearest.id);
    }, { signal });
    document.addEventListener('selectionchange', () => {
      const node = document.getSelection()?.focusNode;
      if (!node || !source.outer.contains(node)) return;
      const el = node instanceof Element ? node : node.parentElement;
      const id = el?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
      if (id) this.focus(id);
    }, { signal });
  }
  setLaneWidth(width: number): void {
    if (width <= 0) return;
    const next = this.narrowLane ? width < 516 : width < 500;
    if (next === this.narrowLane) return;
    this.narrowLane = next;
    if (!next) this.allowNarrowPage = false;
    if (this.mode === 'page') this.apply();
  }
  setMode(mode: TranslationFocus, explicit = false): void {
    this.mode = mode;
    this.allowNarrowPage = explicit && mode === 'page' && this.narrowLane;
    this.apply();
  }
  focus(id: string): void {
    if (id === this.id || !this.layout.passages.some(p => p.id === id)) return;
    this.id = id;
    if (this.mode === 'page' && (!this.narrowLane || this.allowNarrowPage)) {
      this.target.outer.dataset.activeBlock = id;
      this.changed(id, this.targetLabel, 'page', false);
      return;
    }
    this.apply();
  }
  private apply(): void {
    const entry = this.entries.get(this.id), page = this.layout.window;
    const box = entry?.passage.box;
    const index = box ? this.columns.findIndex(c => box.x >= c.left - 3 && box.x + box.width <= c.right + 3) : -1;
    const previous = this.effective;
    const degraded = this.mode === 'page' && this.narrowLane && !this.allowNarrowPage;
    const baseMode: TranslationFocus = degraded ? 'column' : this.mode;
    this.effective = baseMode === 'column' && box && index < 0 ? 'passage' : baseMode;
    const column = this.effective === 'column' ? this.columns[index] : undefined;
    this.target.outer.dataset.focus = this.effective;
    this.source.outer.dataset.focus = baseMode;
    this.target.outer.dataset.activeBlock = this.id;
    for (const [id, placed] of this.entries) {
      const active = baseMode !== 'page' && id === this.id;
      for (const node of [placed.source, placed.target, placed.translated]) node.classList.toggle('is-reading', active);
    }
    this.target.setWindow(column ? { ...page, x: column.left, width: column.right - column.left } : page);
    let label = this.targetLabel;
    if (baseMode === 'column' && column) label = this.columns.length === 1 ? readerLabel('Single printed column', '单栏正文') :
      this.columns.length === 2 ? (index === 0 ? readerLabel('Left printed column', '左侧栏') : readerLabel('Right printed column', '右侧栏')) : readerLabel('Printed column ' + (index + 1), '第 ' + (index + 1) + ' 栏');
    else if (this.effective === 'passage' && entry) label = entry.passage.label;
    this.changed(this.id, label, this.effective, degraded);
    this.repaint(previous !== this.effective);
    const scroller = this.target.outer.parentElement;
    if (column && entry && scroller) {
      const rect = entry.target.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) scroller.scrollTop += rect.top - bounds.top - 12;
    } else if (scroller) scroller.scrollTop = 0;
  }
}
