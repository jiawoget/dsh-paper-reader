const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

export interface FloatBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface FloatController { place(x: number, y: number): { x: number; y: number }; clamp(): { x: number; y: number } }
interface FloatOptions {
  handle: HTMLElement; panel: HTMLElement; bounds: () => FloatBounds;
  enabled?: () => boolean; onMove?: (x: number, y: number) => void;
  onCommit?: (x: number, y: number) => void; onFocus?: () => void; signal?: AbortSignal;
}
interface SplitterOptions {
  grip: HTMLElement; root?: HTMLElement; reversed?: () => boolean; step?: number;
  onAdjust: (delta: number, reset: boolean) => void; onApply?: () => void; onCommit?: () => void; signal?: AbortSignal;
}

export function clampFloat(panel: HTMLElement, x: number, y: number, bounds: FloatBounds): { x: number; y: number } {
  const maxX = Math.max(bounds.minX, bounds.maxX - panel.offsetWidth), maxY = Math.max(bounds.minY, bounds.maxY - panel.offsetHeight);
  return { x: clamp(Number.isFinite(x) ? x : bounds.minX, bounds.minX, maxX), y: clamp(Number.isFinite(y) ? y : bounds.minY, bounds.minY, maxY) };
}

export function connectFloat(options: FloatOptions): FloatController {
  const { handle, panel, bounds, enabled, onMove, onCommit, onFocus, signal } = options;
  let held: { id: number; dx: number; dy: number } | undefined;
  const apply = (x: number, y: number) => {
    const pos = clampFloat(panel, x, y, bounds());
    if (onMove) onMove(pos.x, pos.y);
    else { panel.style.left = pos.x + 'px'; panel.style.top = pos.y + 'px'; }
    return pos;
  };
  handle.addEventListener('pointerdown', event => {
    if (enabled?.() === false || event.button !== 0 || !event.isPrimary) return;
    if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) return;
    onFocus?.(); event.preventDefault();
    held = { id: event.pointerId, dx: event.clientX - panel.offsetLeft, dy: event.clientY - panel.offsetTop };
    handle.setPointerCapture(event.pointerId);
  }, { signal });
  handle.addEventListener('pointermove', event => {
    if (held?.id === event.pointerId && enabled?.() !== false) apply(event.clientX - held.dx, event.clientY - held.dy);
  }, { signal });
  handle.addEventListener('lostpointercapture', () => { if (held && enabled?.() !== false) onCommit?.(panel.offsetLeft, panel.offsetTop); held = undefined; }, { signal });
  handle.addEventListener('keydown', event => {
    if (enabled?.() === false || event.target !== handle || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 60 : 20;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    onFocus?.(); event.preventDefault(); event.stopPropagation();
    const pos = apply(panel.offsetLeft + dx, panel.offsetTop + dy);
    onCommit?.(pos.x, pos.y);
  }, { signal });
  return { place: apply, clamp: () => apply(panel.offsetLeft, panel.offsetTop) };
}

export function bindSplitter(options: SplitterOptions): void {
  const { grip, root, reversed, step = 20, onAdjust, onApply, onCommit, signal } = options;
  let pointer: number | undefined, last = 0;
  const horizontal = () => grip.getAttribute('aria-orientation') === 'horizontal';
  const coordinate = (event: PointerEvent) => horizontal() ? event.clientY : event.clientX;
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); grip.focus({ preventScroll: true });
    pointer = event.pointerId; last = coordinate(event); grip.setPointerCapture(pointer); root?.classList.add('is-resizing');
  }, { signal });
  grip.addEventListener('pointermove', event => {
    if (pointer !== event.pointerId) return;
    onAdjust(coordinate(event) - last, false); last = coordinate(event); onApply?.();
  }, { signal });
  grip.addEventListener('lostpointercapture', () => {
    if (pointer === undefined) return;
    pointer = undefined; root?.classList.remove('is-resizing'); onCommit?.();
  }, { signal });
  grip.addEventListener('keydown', event => {
    const [decrease, increase] = horizontal() ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (event.altKey || event.ctrlKey || event.metaKey || ![decrease, increase, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const distance = event.key === 'Home' || event.key === 'End' ? (horizontal() ? innerHeight : innerWidth) : event.shiftKey ? step * 3 : step;
    onAdjust(event.key === decrease || event.key === (reversed?.() ? 'End' : 'Home') ? -distance : distance, false);
    onApply?.(); onCommit?.();
  }, { signal });
  grip.addEventListener('dblclick', () => { onAdjust(0, true); onApply?.(); onCommit?.(); }, { signal });
}
