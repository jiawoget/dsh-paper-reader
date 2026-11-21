import type { SelectionHit } from '../../shared/types.js';
import { activateAfterTouchDrag, button, el, message, readerLabel as label, toast } from '../ui.js';
import type { Box } from './model.js';
import { place, type Sheet } from './paper.js';
import type { PageRaster } from './raster.js';
import { pagePoint, readRegion, regionAnchor, regionBox, type PaperPoint } from './region-geometry.js';

export type RegionIntent = 'ask' | 'explain' | 'note' | 'continue' | 'reopen';
export type RegionAction = (hit: SelectionHit, intent: RegionIntent) => void | Promise<void>;
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high));

function textInside(runs: HTMLElement[], area: DOMRect): string {
  const inside = (x: number, y: number) => area.left <= x && x <= area.right && area.top <= y && y <= area.bottom;
  const lines: string[] = [];
  const range = document.createRange();
  for (const run of runs) {
    const node = run.firstChild;
    if (!(node instanceof Text) || !node.data.trim()) continue;
    const r = run.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= area.left || r.bottom <= area.top || r.left >= area.right || r.top >= area.bottom) continue;
    if (inside(r.left, r.top) && inside(r.right, r.bottom)) { lines.push(node.data); continue; }
    let part = '', start = 0;
    for (const character of node.data) {
      const end = start + character.length;
      range.setStart(node, start); range.setEnd(node, end);
      const glyph = range.getBoundingClientRect();
      if (inside(glyph.x + glyph.width / 2, glyph.y + glyph.height / 2)) part += character;
      start = end;
    }
    if (part.trim()) lines.push(part);
  }
  return lines.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 100_000);
}

export class PdfRegionPicker {
  private readonly surface = el('div', 'pdf-capture-surface');
  private readonly cursor = el('i', 'pdf-capture-cursor');
  private readonly marker = el('button', 'pdf-region-marker');
  private readonly actions = el('div', 'pdf-capture-actions');
  private readonly ask = button(label('Ask', '提问'), () => this.submit('ask'), 'btn primary');
  private readonly follow = button(label('Ask in this discussion', '接着问'), () => this.submit('continue'), 'btn primary');
  private readonly explain = button(label('Explain', '解释'), () => this.submit('explain'), 'btn');
  private readonly note = button(label('Write note', '记笔记'), () => this.submit('note'), 'btn');
  private startPoint?: PaperPoint;
  private keyboard?: { x: number; y: number };
  private pointer?: number;
  private selected = '';
  private pending?: AbortController;
  private attach = false;

  constructor(private sheet: Sheet, private raster: PageRaster, private runs: HTMLElement[], private page: number,
    private paper: Box, private signal: AbortSignal, private deliver?: RegionAction,
    private figureFor?: (area: Box) => string | undefined, private canContinue?: (anchor: string) => boolean) {
    this.marker.type = 'button';
    this.marker.hidden = this.surface.hidden = this.cursor.hidden = true;
    this.marker.tabIndex = -1;
    this.marker.ariaLabel = this.marker.title = label('Continue this screenshot discussion', '继续问这张截图');
    this.marker.addEventListener('click', event => {
      event.stopPropagation();
      if (this.marker.dataset.reopen === 'true') void this.submit('reopen').catch(error => toast(message(error)));
    }, { signal });
    this.sheet.plane.append(this.marker);
    this.surface.tabIndex = 0;
    this.surface.setAttribute('role', 'group');
    this.surface.ariaLabel = label('Screenshot area. Move with the arrow keys and press Enter at two opposite corners.',
      '截图范围。用方向键移动，按回车定下两个对角。');
    this.surface.append(this.cursor);
    this.sheet.outer.append(this.surface);
    this.actions.setAttribute('role', 'group');
    this.actions.ariaLabel = label('Screenshot actions', '截图操作');
    this.actions.append(this.follow, this.explain, this.ask, this.note);
    for (const control of [this.follow, this.explain, this.ask, this.note]) activateAfterTouchDrag(control);
    this.surface.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      this.reset();
      this.pointer = event.pointerId;
      this.surface.setPointerCapture(event.pointerId);
      this.startPoint = this.point(event.clientX, event.clientY);
    }, { signal });
    this.surface.addEventListener('pointermove', event => {
      if (this.pointer !== event.pointerId || !this.startPoint) return;
      this.draw(this.point(event.clientX, event.clientY));
    }, { signal });
    this.surface.addEventListener('pointerup', event => {
      if (this.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      this.draw(this.point(event.clientX, event.clientY));
      this.pointer = undefined;
      this.finishBox();
    }, { signal });
    this.surface.addEventListener('lostpointercapture', () => { if (this.pointer !== undefined) this.reset(); }, { signal });
    this.surface.addEventListener('click', event => event.stopPropagation(), { signal });
    this.surface.addEventListener('keydown', event => this.keydown(event), { signal });
    window.addEventListener('resize', () => this.positionActions(), { signal });
    document.addEventListener('scroll', () => this.positionActions(), { capture: true, passive: true, signal });
    signal.addEventListener('abort', () => this.end(), { once: true });
  }

  begin(attach = false): void {
    this.reset();
    this.attach = attach;
    this.surface.hidden = false;
    this.surface.focus({ preventScroll: true });
  }

  end(): void { this.reset(); this.attach = false; this.surface.hidden = true; }

  async reopen(id: string, receive?: RegionAction): Promise<void> {
    this.mark(id, true);
    await this.submit('reopen', receive);
  }

  private reset(): void {
    this.pending?.abort();
    this.pending = undefined;
    this.startPoint = undefined;
    this.keyboard = undefined;
    this.pointer = undefined;
    this.cursor.hidden = true;
    this.actions.remove();
    this.mark();
  }

  private point(x: number, y: number): PaperPoint {
    const frame = this.sheet.outer.getBoundingClientRect();
    return pagePoint(clamp(x, frame.left, frame.right), clamp(y, frame.top, frame.bottom), this.sheet.plane.getBoundingClientRect());
  }

  private draw(point: PaperPoint): void {
    if (this.startPoint) this.mark(regionAnchor(this.startPoint, point));
  }

  rect(id: string): DOMRect | null {
    const region = readRegion(id);
    if (!region) return null;
    const r = regionBox(region, this.sheet.plane.getBoundingClientRect());
    return new DOMRect(r.x, r.y, r.width, r.height);
  }

  mark(id = '', reopen = false): void {
    const region = readRegion(id);
    this.marker.hidden = !region;
    this.selected = region ? id : '';
    this.marker.dataset.reopen = String(reopen);
    this.marker.tabIndex = reopen ? 0 : -1;
    this.marker.setAttribute('aria-hidden', String(!reopen));
    if (region) place(this.marker, regionBox(region, this.paper));
    if (region && reopen) this.marker.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }

  private finishBox(): void {
    this.startPoint = undefined;
    const r = this.rect(this.selected);
    if (!r || r.width < 5 || r.height < 5) { this.reset(); return; }
    if (this.attach) {
      void this.submit('continue').catch(error => toast(message(error)));
      return;
    }
    const follow = this.canContinue?.(this.selected) === true;
    this.follow.hidden = !follow;
    this.explain.hidden = follow;
    this.ask.classList.toggle('primary', !follow);
    this.ask.textContent = follow ? label('Ask separately', '单独提问') : label('Ask', '提问');
    document.body.append(this.actions);
    this.positionActions();
    (follow ? this.follow : this.ask).focus({ preventScroll: true });
  }

  private positionActions(): void {
    if (!this.actions.isConnected) return;
    const r = this.rect(this.selected);
    if (!r) return;
    const frame = this.sheet.outer.closest('#paperScroll')?.getBoundingClientRect();
    const margin = 6, top = Math.max(margin, frame?.top ?? 0);
    const bottom = Math.min(innerHeight, frame?.bottom ?? innerHeight) - margin;
    const width = this.actions.offsetWidth, height = this.actions.offsetHeight;
    this.actions.style.left = clamp(r.right - width, margin, innerWidth - width - margin) + 'px';
    this.actions.style.top = clamp(r.bottom + margin + height <= bottom ? r.bottom + margin : r.top - margin - height, top, bottom - height) + 'px';
  }

  private keydown(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = this.surface.getBoundingClientRect();
    const scroll = this.surface.closest('#paperScroll')?.getBoundingClientRect() ?? bounds;
    const left = Math.max(0, bounds.left, scroll.left), top = Math.max(0, bounds.top, scroll.top);
    const right = Math.min(innerWidth, bounds.right, scroll.right), bottom = Math.min(innerHeight, bounds.bottom, scroll.bottom);
    const cursor = this.keyboard ??= { x: left + (right - left) / 3, y: top + (bottom - top) / 3 };
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft') cursor.x -= step;
    if (event.key === 'ArrowRight') cursor.x += step;
    if (event.key === 'ArrowUp') cursor.y -= step;
    if (event.key === 'ArrowDown') cursor.y += step;
    cursor.x = clamp(cursor.x, left, right); cursor.y = clamp(cursor.y, top, bottom);
    this.cursor.hidden = false;
    this.cursor.style.left = cursor.x - bounds.x + 'px';
    this.cursor.style.top = cursor.y - bounds.y + 'px';
    const point = this.point(cursor.x, cursor.y);
    if (this.startPoint) this.draw(point);
    if (event.key === 'Enter' || event.key === ' ') {
      if (this.startPoint) { this.finishBox(); this.cursor.hidden = true; }
      else this.startPoint = point;
    }
  }

  private async submit(intent: RegionIntent, deliver = this.deliver): Promise<void> {
    const id = this.selected, region = readRegion(id), rect = this.rect(id);
    if (!region || !rect || !deliver || this.pending ||
      (!this.attach && !this.actions.isConnected && this.marker.dataset.reopen !== 'true')) return;
    const pending = this.pending = new AbortController();
    const signal = AbortSignal.any([this.signal, pending.signal]);
    const regionText = textInside(this.runs, rect);
    const area = regionBox(region, this.paper);
    const figure = this.figureFor?.(area);
    const pageLabel = label('Page ' + this.page + ' screenshot', '第 ' + this.page + ' 页截图') + (figure
      ? ' · ' + label(figure, figure.replace(/^Figure /i, '图 ').replace(/^Table /i, '表 ')) : '');
    try {
      const image = await this.raster.crop(area, signal);
      if (signal.aborted) return;
      const trigger = this.surface.ownerDocument.getElementById('captureRegion') ?? undefined;
      const hit: SelectionHit = { id, image, regionText, page: this.page, side: 'source', text: regionText || pageLabel,
        context: regionText, sourceQuote: regionText || pageLabel, label: pageLabel, rect, trigger };
      this.pending = undefined;
      this.end();
      await deliver(hit, intent);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
}
