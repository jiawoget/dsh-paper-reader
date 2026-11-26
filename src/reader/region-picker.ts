import type { ReadingSide, RegionAction, RegionIntent, SelectionHit } from '../shared/types.js';
import { activateAfterTouchDrag, button, el, message, readerLabel as label, toast } from './ui.js';

type Point = { x: number; y: number };
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high));

interface RegionSurface {
  outer: HTMLElement;
  plane: HTMLElement;
  point(clientX: number, clientY: number): Point;
  anchor(start: Point, end: Point): string | undefined;
  rect(anchor: string): DOMRect | null;
  capture(anchor: string, rect: DOMRect, signal: AbortSignal): Promise<{
    id: string; image: string; regionText: string; label: string; side: ReadingSide;
  }>;
}

export class RegionPicker {
  private readonly surface = el('div', 'pdf-capture-surface');
  private readonly cutout = el('div', 'pdf-capture-cutout');
  private readonly cursor = el('i', 'pdf-capture-cursor');
  private readonly marker = el('button', 'pdf-region-marker');
  private readonly actions = el('div', 'pdf-capture-actions');
  private readonly ask = button(label('Ask', '提问'), () => this.submit('ask'), 'btn primary');
  private readonly follow = button(label('Ask in this discussion', '接着问'), () => this.submit('continue'), 'btn primary');
  private readonly explain = button(label('Explain', '解释'), () => this.submit('explain'), 'btn');
  private readonly note = button(label('Write note', '记笔记'), () => this.submit('note'), 'btn');
  private readonly pin = button(label('Pin', '钉选'), () => this.submit('pin'), 'btn', 'pin');
  private readonly copyPng = button(label('Copy PNG', '复制 PNG'), () => this.submit('copy'), 'btn');
  private readonly savePng = button(label('Save PNG', '保存 PNG'), () => this.submit('save'), 'btn', 'import');
  private readonly cancelBtn = button(label('Cancel', '取消'), () => this.cancel(), 'btn');
  private startPoint?: Point;
  private keyboard?: { x: number; y: number };
  private pointer?: number;
  private selected = '';
  private pending?: AbortController;
  private attach = false;

  constructor(private sheet: RegionSurface, private page: number, private signal: AbortSignal,
    private deliver?: RegionAction, private canContinue?: (anchor: string) => boolean) {
    this.marker.type = 'button';
    this.marker.hidden = this.surface.hidden = this.cutout.hidden = this.cursor.hidden = true;
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
    this.surface.append(this.cutout, this.cursor);
    this.sheet.outer.append(this.surface);
    this.actions.setAttribute('role', 'group');
    this.actions.ariaLabel = label('Screenshot actions', '截图操作');
    const primaryRow = el('div', 'pdf-capture-row'), toolsRow = el('div', 'pdf-capture-row pdf-capture-tools');
    primaryRow.append(this.follow, this.explain, this.ask, this.note);
    toolsRow.append(this.pin, this.copyPng, this.savePng, this.cancelBtn);
    this.actions.append(primaryRow, toolsRow);
    for (const control of [this.follow, this.explain, this.ask, this.note, this.pin, this.copyPng, this.savePng, this.cancelBtn]) activateAfterTouchDrag(control);
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
    window.addEventListener('resize', () => { this.syncCutout(); this.positionActions(); }, { signal });
    document.addEventListener('scroll', () => this.positionActions(), { capture: true, passive: true, signal });
    signal.addEventListener('abort', () => {
      this.end();
      this.surface.remove();
      this.marker.remove();
    }, { once: true });
  }

  begin(attach = false): void {
    this.reset();
    this.attach = attach;
    this.surface.hidden = false;
    this.surface.focus({ preventScroll: true });
  }

  end(): void { this.reset(); this.attach = false; this.surface.hidden = true; }

  private cancel(): void {
    this.end();
    void this.deliver?.({ id: '', text: '', context: '', page: this.page, rect: new DOMRect(), side: 'source', label: '' }, 'cancel');
  }

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
    this.cutout.hidden = true;
    delete this.surface.dataset.hasBox;
    this.actions.remove();
    this.mark();
  }

  private point(x: number, y: number): Point {
    const frame = this.sheet.outer.getBoundingClientRect();
    return this.sheet.point(clamp(x, frame.left, frame.right), clamp(y, frame.top, frame.bottom));
  }

  private draw(point: Point): void {
    if (this.startPoint) this.mark(this.sheet.anchor(this.startPoint, point));
  }

  rect(id: string): DOMRect | null { return this.sheet.rect(id); }

  mark(id = '', reopen = false): void {
    this.selected = id;
    this.marker.dataset.reopen = String(reopen);
    this.marker.tabIndex = reopen ? 0 : -1;
    this.marker.setAttribute('aria-hidden', String(!reopen));
    this.refresh();
    if (reopen && !this.marker.hidden) this.marker.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }

  refresh(): void {
    const rect = this.selected && this.rect(this.selected);
    this.marker.hidden = !rect;
    this.syncCutout(rect || undefined);
    if (!rect) return;
    const plane = this.sheet.plane.getBoundingClientRect();
    Object.assign(this.marker.style, {
      left: (rect.x - plane.x) / plane.width * 100 + '%', top: (rect.y - plane.y) / plane.height * 100 + '%',
      width: rect.width / plane.width * 100 + '%', height: rect.height / plane.height * 100 + '%'
    });
    this.positionActions();
  }

  private syncCutout(rect = this.selected ? this.rect(this.selected) : null): void {
    if (this.surface.hidden || !rect) {
      this.cutout.hidden = true;
      delete this.surface.dataset.hasBox;
      return;
    }
    const outer = this.sheet.outer.getBoundingClientRect();
    this.surface.dataset.hasBox = 'true';
    this.cutout.hidden = false;
    Object.assign(this.cutout.style, {
      left: rect.x - outer.x + 'px', top: rect.y - outer.y + 'px',
      width: rect.width + 'px', height: rect.height + 'px'
    });
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
    this.actions.style.left = clamp(r.right - width, margin, Math.max(margin, innerWidth - width - margin)) + 'px';
    this.actions.style.top = clamp(r.bottom + margin + height <= bottom ? r.bottom + margin : r.top - margin - height, top, Math.max(top, bottom - height)) + 'px';
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
    const id = this.selected, rect = this.rect(id);
    if (!rect || !deliver || this.pending ||
      (!this.attach && !this.actions.isConnected && this.marker.dataset.reopen !== 'true')) return;
    const pending = this.pending = new AbortController();
    const signal = AbortSignal.any([this.signal, pending.signal]);
    try {
      const crop = await this.sheet.capture(id, rect, signal);
      if (signal.aborted) return;
      const trigger = this.surface.ownerDocument.getElementById('captureRegion') ?? undefined;
      const text = crop.regionText || crop.label;
      const hit: SelectionHit = { ...crop, text, sourceQuote: text, context: crop.regionText, page: this.page, rect, trigger };
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
