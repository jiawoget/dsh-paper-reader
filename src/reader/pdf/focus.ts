import type { Box, PageLayout, Passage } from './model.js';
import type { Sheet } from './paper.js';

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
  constructor(private layout: PageLayout, private entries: Map<string, FocusEntry>, private source: Sheet,
    private target: Sheet, mode: TranslationFocus, initial: string | undefined, private changed: (id: string, label: string) => void,
    private repaint: (refit: boolean) => void, signal: AbortSignal) {
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
  setMode(mode: TranslationFocus): void {
    this.mode = mode;
    this.apply();
  }
  focus(id: string): void {
    if (id === this.id || !this.layout.passages.some(p => p.id === id)) return;
    this.id = id;
    if (this.mode === 'page') {
      this.target.outer.dataset.activeBlock = id;
      this.changed(id, 'Simplified Chinese');
      return;
    }
    this.apply();
  }
  private apply(): void {
    const entry = this.entries.get(this.id), page = this.layout.window;
    const box = entry?.passage.box;
    const index = box ? this.columns.findIndex(c => box.x >= c.left - 3 && box.x + box.width <= c.right + 3) : -1;
    // A title or abstract spanning several printed columns reads as one passage.
    const previous = this.effective;
    this.effective = this.mode === 'column' && box && index < 0 ? 'passage' : this.mode;
    const column = this.effective === 'column' ? this.columns[index] : undefined;
    this.target.outer.dataset.focus = this.effective;
    this.source.outer.dataset.focus = this.mode;
    this.target.outer.dataset.activeBlock = this.id;
    for (const [id, placed] of this.entries) {
      const active = this.mode !== 'page' && id === this.id;
      for (const node of [placed.source, placed.target, placed.translated]) node.classList.toggle('is-reading', active);
    }
    this.target.setWindow(column ? { ...page, x: column.left, width: column.right - column.left } : page);
    let label = 'Simplified Chinese';
    if (this.mode === 'column' && column) label = this.columns.length === 1 ? 'Single printed column' :
      this.columns.length === 2 ? (index === 0 ? 'Left printed column' : 'Right printed column') : 'Printed column ' + (index + 1);
    else if (this.effective === 'passage' && entry) label = entry.passage.label;
    this.changed(this.id, label);
    this.repaint(previous === 'passage' && this.effective !== 'passage');
    const scroller = this.target.outer.parentElement;
    if (column && entry && scroller) {
      const rect = entry.target.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) scroller.scrollTop += rect.top - bounds.top - 12;
    } else if (scroller) scroller.scrollTop = 0;
  }
}
