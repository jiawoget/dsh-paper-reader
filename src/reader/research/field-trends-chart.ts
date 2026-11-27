import type { TrendCell, TrendMetric, TrendTopicRow } from '../../shared/research-types.js';
import { el, readerLabel as t } from '../ui.js';
import { researchText } from './labels.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_MAX_SERIES = 6;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls = '', attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / pow;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
}

interface TrendChartPoint {
  year: number; yearIndex: number; x: number; y: number; value: number; isYtd: boolean; lowBase: boolean; cell: TrendCell;
}
interface TrendChartSeries {
  row: TrendTopicRow; styleIndex: number; hidden: boolean; points: TrendChartPoint[]; solidPath: string; ytdPath: string; areaPath: string;
}
interface TrendChartModel {
  width: number; height: number; pad: { top: number; right: number; bottom: number; left: number };
  years: number[]; ytdYear: number; yearXs: number[]; metric: TrendMetric;
  yScale: { min: number; max: number; ticks: { value: number; y: number; label: string }[]; zeroLine: boolean; zeroY: number };
  series: TrendChartSeries[];
}
interface TrendChartCallbacks {
  onSelectPoint: (row: TrendTopicRow, cell: TrendCell) => void; onFocusChange?: (topicId: string) => void;
}
interface TrendChartUpdate {
  rows: ReadonlyArray<TrendTopicRow>; years: ReadonlyArray<number>; ytdYear: number; metric: TrendMetric; selectedKey: string;
}

export function formatChartValue(value: number | null, metric: TrendMetric, isYtd = false, lowBase = false): string {
  if (metric === 'growth') {
    if (isYtd) return 'YTD*';
    if (value === null || !Number.isFinite(value)) return '—';
    const pct = Math.round(value * 100), s = pct > 999 ? '>+999%' : pct > 0 ? `+${pct}%` : pct === 0 ? '0%' : `${pct}%`;
    return lowBase ? `${s}°` : s;
  }
  const n = value !== null && Number.isFinite(value) ? value : 0;
  if (metric === 'volume') return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n));
  if (n <= 0) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n < 10 ? n.toFixed(1).replace(/\.0$/, '') : String(Math.round(n));
}

export function computeYScale(minVal: number, maxVal: number, metric: TrendMetric): { min: number; max: number; ticks: number[]; zeroLine: boolean } {
  const safeMin = Number.isFinite(minVal) ? minVal : 0, safeMax = Number.isFinite(maxVal) ? maxVal : 0;
  if (metric !== 'growth') {
    const hi = Math.max(0, safeMax);
    if (hi <= 0) return { min: 0, max: 1, ticks: [0, 1], zeroLine: false };
    const step = niceStep(hi / 4), max = round6(Math.ceil(hi / step) * step), ticks: number[] = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(round6(v));
    return { min: 0, max, ticks, zeroLine: false };
  }
  const lo = Math.min(0, safeMin), hi = Math.max(0, safeMax);
  if (lo === 0 && hi === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1], zeroLine: false };
  const step = niceStep(Math.max(hi - lo, 0.2) / 4);
  const min = lo < 0 ? round6(Math.floor(lo / step) * step) : 0, max = hi > 0 ? round6(Math.ceil(hi / step) * step) : 0;
  const ticks: number[] = [];
  for (let v = min; v <= max + step * 0.001; v += step) ticks.push(round6(Math.abs(v) < 1e-9 ? 0 : v));
  if (min < 0 && max > 0 && !ticks.includes(0)) { ticks.push(0); ticks.sort((a, b) => a - b); }
  return { min, max, ticks, zeroLine: min < 0 && max > 0 };
}

const pathFrom = (pts: ReadonlyArray<{ x: number; y: number }>): string => pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
const cellMetricVal = (cell: TrendCell, metric: TrendMetric): number | null =>
  metric === 'volume' ? (Number.isFinite(cell.volume) ? cell.volume : 0)
  : metric === 'citations' ? (Number.isFinite(cell.citationHeat) ? cell.citationHeat : 0)
  : (cell.isYtd || cell.yoyGrowth === null || !Number.isFinite(cell.yoyGrowth) ? null : cell.yoyGrowth);

export function buildTrendChartModel(
  rows: ReadonlyArray<TrendTopicRow>, years: ReadonlyArray<number>, ytdYear: number, metric: TrendMetric,
  opts?: { width?: number; height?: number; maxSeries?: number; hiddenIds?: ReadonlySet<string> }
): TrendChartModel {
  const width = Math.max(320, Math.round(opts?.width ?? 760)), height = Math.max(200, Math.round(opts?.height ?? 300));
  const pad = { top: 20, right: width < 480 ? 20 : 28, bottom: 36, left: width < 480 ? 48 : 56 };
  const plotW = Math.max(40, width - pad.left - pad.right), plotH = Math.max(40, height - pad.top - pad.bottom);
  const yearList = [...years], yearXs = yearList.map((_, i) => round1(yearList.length <= 1 ? pad.left + plotW / 2 : pad.left + (i / (yearList.length - 1)) * plotW));
  const rawPerRow = rows.slice(0, opts?.maxSeries ?? DEFAULT_MAX_SERIES).map(row => {
    const byYear = new Map<number, TrendCell>(row.cells.map(c => [c.year, c]));
    const vals = yearList.map((year, yearIndex) => {
      const cell = byYear.get(year), val = cell ? cellMetricVal(cell, metric) : null;
      return !cell || val === null ? null : { year, yearIndex, value: val, isYtd: Boolean(cell.isYtd || year === ytdYear), lowBase: Boolean(cell.lowBase), cell };
    });
    return { row, hidden: Boolean(opts?.hiddenIds?.has(row.topicId)), vals };
  });
  const collectRange = (onlyVisible: boolean) => {
    let minV = Infinity, maxV = -Infinity;
    for (const item of rawPerRow) {
      if (onlyVisible && item.hidden) continue;
      for (const v of item.vals) if (v) { if (v.value < minV) minV = v.value; if (v.value > maxV) maxV = v.value; }
    }
    return Number.isFinite(minV) && Number.isFinite(maxV) ? { minV, maxV } : null;
  };
  const range = collectRange(true) ?? collectRange(false) ?? { minV: 0, maxV: 0 };
  const scale = computeYScale(range.minV, range.maxV, metric), span = scale.max - scale.min || 1;
  const yOf = (v: number) => round1(pad.top + (1 - (v - scale.min) / span) * plotH);
  const zeroY = yOf(Math.max(scale.min, Math.min(scale.max, 0)));
  const series: TrendChartSeries[] = rawPerRow.map((item, styleIndex) => {
    const points: TrendChartPoint[] = item.vals.flatMap(v => v ? [{ ...v, x: yearXs[v.yearIndex], y: yOf(v.value) }] : []);
    const splitYtd = metric !== 'growth' && points.length >= 2 && points[points.length - 1].isYtd;
    const solidPts = splitYtd ? points.slice(0, -1) : points, ytdPts = splitYtd ? points.slice(-2) : [];
    const areaPath = points.length >= 2 ? `M ${points[0].x} ${zeroY} ${points.map(p => `L ${p.x} ${p.y}`).join(' ')} L ${points[points.length - 1].x} ${zeroY} Z` : '';
    return { row: item.row, styleIndex, hidden: item.hidden, points, solidPath: solidPts.length >= 2 ? pathFrom(solidPts) : '', ytdPath: ytdPts.length === 2 ? pathFrom(ytdPts) : '', areaPath };
  });
  return {
    width, height, pad, years: yearList, ytdYear, yearXs, metric,
    yScale: { ...scale, zeroY, ticks: scale.ticks.map(v => ({ value: v, y: yOf(v), label: formatChartValue(v, metric) })) }, series
  };
}

export class FieldTrendsChart {
  readonly root = el('div', 'ft-chart-wrap');
  private readonly legendEl = el('div', 'ft-legend');
  private readonly canvasEl = el('div', 'ft-chart-canvas');
  private readonly tooltipEl = el('div', 'ft-tooltip');
  private readonly hiddenIds = new Set<string>();
  private readonly ac = new AbortController();
  private ro: ResizeObserver | null = null;
  private svgNode: SVGSVGElement | null = null;
  private crosshairEl: SVGLineElement | null = null;
  private state: TrendChartUpdate | null = null;
  private model: TrendChartModel | null = null;
  private focusedId = '';
  private selectedKey = '';
  private lastWidth = 0;

  constructor(private readonly cb: TrendChartCallbacks) {
    this.tooltipEl.hidden = true; this.tooltipEl.setAttribute('role', 'status');
    this.root.append(this.legendEl, this.canvasEl, this.tooltipEl);
    const sig = { signal: this.ac.signal };
    window.addEventListener('resize', () => this.hideTooltip(), { ...sig, passive: true });
    window.addEventListener('scroll', () => this.hideTooltip(), { ...sig, capture: true, passive: true });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.hideTooltip(); }, sig);
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => { const w = this.measureWidth(); if (this.state && Math.abs(w - this.lastWidth) >= 16) this.render(); });
      this.ro.observe(this.canvasEl);
    }
  }

  focusedTopicId(): string { return this.focusedId; }
  update(next: TrendChartUpdate): void {
    this.state = next; this.selectedKey = next.selectedKey;
    const valid = new Set(next.rows.slice(0, DEFAULT_MAX_SERIES).map(r => r.topicId));
    for (const id of [...this.hiddenIds]) if (!valid.has(id)) this.hiddenIds.delete(id);
    this.ensureFocus(next.rows.slice(0, DEFAULT_MAX_SERIES)); this.render();
  }
  setFocused(topicId: string): void {
    if (!this.state || !this.state.rows.slice(0, DEFAULT_MAX_SERIES).some(r => r.topicId === topicId)) return;
    this.hiddenIds.delete(topicId);
    if (this.focusedId === topicId) return;
    this.focusedId = topicId; this.cb.onFocusChange?.(this.focusedId); this.render();
  }
  setSelected(selectedKey: string): void {
    this.selectedKey = selectedKey;
    if (!this.svgNode) return;
    for (const pt of this.svgNode.querySelectorAll<SVGGElement>('.ft-point')) {
      const hit = `${pt.dataset.topicId}:${pt.dataset.year}` === selectedKey;
      pt.classList.toggle('is-selected', hit); pt.setAttribute('aria-pressed', String(hit));
    }
  }
  hideTooltip(): void {
    this.tooltipEl.hidden = true;
    if (this.crosshairEl) this.crosshairEl.style.visibility = 'hidden';
    if (this.svgNode) for (const pt of this.svgNode.querySelectorAll('.ft-point.is-hover-col')) pt.classList.remove('is-hover-col');
  }
  destroy(): void {
    this.hideTooltip(); this.ac.abort(); this.ro?.disconnect(); this.ro = null;
    this.svgNode = null; this.crosshairEl = null; this.state = null; this.model = null; this.root.replaceChildren();
  }

  private measureWidth(): number { const cw = this.canvasEl.clientWidth; return cw > 0 ? Math.max(320, Math.min(820, Math.round(cw))) : 760; }
  private ensureFocus(plotted: ReadonlyArray<TrendTopicRow>): void {
    const visible = plotted.filter(r => !this.hiddenIds.has(r.topicId));
    if (!visible.length && plotted.length) { this.hiddenIds.clear(); visible.push(...plotted); }
    const nextFocus = visible.some(r => r.topicId === this.focusedId) ? this.focusedId : (visible[0]?.topicId ?? '');
    if (nextFocus !== this.focusedId) { this.focusedId = nextFocus; if (nextFocus) this.cb.onFocusChange?.(nextFocus); }
  }
  private toggleLegend(topicId: string): void {
    if (!this.state) return;
    const plotted = this.state.rows.slice(0, DEFAULT_MAX_SERIES), visibleCount = plotted.filter(r => !this.hiddenIds.has(r.topicId)).length;
    if (this.hiddenIds.has(topicId)) { this.hiddenIds.delete(topicId); this.focusedId = topicId; }
    else if (this.focusedId !== topicId) this.focusedId = topicId;
    else if (visibleCount > 1) { this.hiddenIds.add(topicId); this.ensureFocus(plotted); }
    this.cb.onFocusChange?.(this.focusedId); this.render();
  }
  private render(): void {
    if (!this.state) return;
    this.hideTooltip();
    const w = this.measureWidth(); this.lastWidth = w;
    const model = buildTrendChartModel(this.state.rows, this.state.years, this.state.ytdYear, this.state.metric, { width: w, height: w < 480 ? 240 : 300, hiddenIds: this.hiddenIds });
    this.model = model; this.renderLegend(model); this.renderSvg(model);
  }
  private renderLegend(model: TrendChartModel): void {
    this.legendEl.replaceChildren();
    for (const s of model.series) {
      const focused = !s.hidden && s.row.topicId === this.focusedId;
      const btn = el('button', `ft-legend-item${focused ? ' is-focused' : ''}${s.hidden ? ' is-hidden' : ''}`);
      btn.type = 'button'; btn.dataset.topicId = s.row.topicId; btn.dataset.series = String(s.styleIndex);
      btn.setAttribute('aria-pressed', String(focused)); btn.title = s.row.topicName;
      btn.ariaLabel = s.hidden ? t(`Show ${s.row.topicName}`, `显示「${s.row.topicName}」`)
        : focused ? t(`${s.row.topicName} (focused; click to hide)`, `「${s.row.topicName}」（当前聚焦，再次点击隐藏）`) : t(`Focus ${s.row.topicName}`, `聚焦「${s.row.topicName}」`);
      btn.append(el('span', 'ft-legend-dot'), el('span', 'ft-legend-name', s.row.topicName));
      btn.addEventListener('click', () => this.toggleLegend(s.row.topicId));
      this.legendEl.append(btn);
    }
    if (this.hiddenIds.size > 0) {
      const reset = el('button', 'btn ft-legend-reset', researchText.resetSeries());
      reset.type = 'button'; reset.addEventListener('click', () => { this.hiddenIds.clear(); this.render(); });
      this.legendEl.append(reset);
    }
  }
  private renderSvg(model: TrendChartModel): void {
    const svg = svgEl('svg', 'ft-chart-svg', { viewBox: `0 0 ${model.width} ${model.height}`, role: 'img', 'aria-label': t('Field trends chart', '研究趋势折线图') });
    const { pad, width, height, yScale, years, ytdYear, yearXs } = model;
    for (const tk of yScale.ticks) {
      svg.append(svgEl('line', `ft-grid-line${yScale.zeroLine && tk.value === 0 ? ' is-zero' : ''}`, { x1: pad.left, y1: tk.y, x2: width - pad.right, y2: tk.y }));
      const lbl = svgEl('text', 'ft-axis-y', { x: pad.left - 8, y: tk.y + 4, 'text-anchor': 'end' }); lbl.textContent = tk.label; svg.append(lbl);
    }
    for (let i = 0; i < years.length; i++) {
      const y = years[i], isYtd = y === ytdYear;
      const lbl = svgEl('text', `ft-axis-x${isYtd ? ' is-ytd' : ''}`, { x: yearXs[i], y: height - 12, 'text-anchor': 'middle' });
      lbl.textContent = isYtd ? (width < 480 ? `${y}*` : `${y}* YTD`) : String(y); svg.append(lbl);
    }
    const crosshair = svgEl('line', 'ft-crosshair', { x1: pad.left, y1: pad.top, x2: pad.left, y2: height - pad.bottom });
    crosshair.style.visibility = 'hidden'; svg.append(crosshair); this.crosshairEl = crosshair;
    const ordered = [...model.series].filter(s => !s.hidden).sort((a, b) => Number(a.row.topicId === this.focusedId) - Number(b.row.topicId === this.focusedId));
    const hitRadius = width < 480 ? 22 : 16;
    for (const s of ordered) {
      const focused = s.row.topicId === this.focusedId;
      const g = svgEl('g', `ft-series${focused ? ' is-focused' : ''}`, { 'data-topic-id': s.row.topicId, 'data-series': String(s.styleIndex) });
      if (focused && s.areaPath) g.append(svgEl('path', 'ft-series-area', { d: s.areaPath }));
      if (s.solidPath) g.append(svgEl('path', 'ft-series-line', { d: s.solidPath }));
      if (s.ytdPath) g.append(svgEl('path', 'ft-series-ytd', { d: s.ytdPath, 'stroke-dasharray': '4 4' }));
      for (const pt of s.points) {
        const key = `${s.row.topicId}:${pt.year}`, selected = key === this.selectedKey;
        const valText = formatChartValue(pt.value, model.metric, pt.isYtd, pt.lowBase);
        const pg = svgEl('g', `ft-point${focused ? ' is-focused' : ''}${selected ? ' is-selected' : ''}`, {
          role: 'button', tabindex: 0, 'aria-pressed': String(selected),
          'aria-label': `${s.row.topicName}, ${pt.isYtd ? `${pt.year}* YTD` : pt.year}: ${valText}`,
          'data-topic-id': s.row.topicId, 'data-year': String(pt.year), 'data-year-index': String(pt.yearIndex), 'data-series': String(s.styleIndex)
        });
        pg.append(svgEl('circle', 'ft-point-hit', { cx: pt.x, cy: pt.y, r: hitRadius }), svgEl('circle', 'ft-point-dot', { cx: pt.x, cy: pt.y, r: focused ? 4 : 3 }));
        pg.addEventListener('click', e => { e.stopPropagation(); this.cb.onSelectPoint(s.row, pt.cell); });
        pg.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.cb.onSelectPoint(s.row, pt.cell); }
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const sibs = [...g.querySelectorAll<SVGGElement>('.ft-point')], next = sibs[sibs.indexOf(pg) + (e.key === 'ArrowRight' ? 1 : -1)];
            if (next) { e.preventDefault(); next.focus(); }
          }
        });
        pg.addEventListener('focus', () => { const r = pg.getBoundingClientRect(); this.showColumn(pt.yearIndex, r.right, r.top); });
        g.append(pg);
      }
      svg.append(g);
    }
    svg.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch' || !model.yearXs.length) return;
      const rect = svg.getBoundingClientRect(); if (!rect.width) return;
      const svgX = ((e.clientX - rect.left) / rect.width) * model.width;
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < model.yearXs.length; i++) { const d = Math.abs(model.yearXs[i] - svgX); if (d < bestDist) { bestDist = d; best = i; } }
      this.showColumn(best, e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', () => this.hideTooltip());
    svg.addEventListener('focusout', e => { if (!(e.relatedTarget instanceof Node && svg.contains(e.relatedTarget))) this.hideTooltip(); });
    this.svgNode = svg; this.canvasEl.replaceChildren(svg);
  }
  private showColumn(yearIndex: number, clientX: number, clientY: number): void {
    const model = this.model;
    if (!model || !this.svgNode || !this.crosshairEl || yearIndex < 0 || yearIndex >= model.years.length) return;
    const year = model.years[yearIndex], isYtd = year === model.ytdYear, x = model.yearXs[yearIndex];
    this.crosshairEl.setAttribute('x1', String(x)); this.crosshairEl.setAttribute('x2', String(x)); this.crosshairEl.style.visibility = 'visible';
    for (const pt of this.svgNode.querySelectorAll<SVGGElement>('.ft-point')) pt.classList.toggle('is-hover-col', Number(pt.dataset.yearIndex) === yearIndex);
    this.tooltipEl.replaceChildren(el('div', 'ft-tip-head', isYtd ? `${year}* YTD` : String(year)));
    if (model.metric === 'growth' && isYtd) this.tooltipEl.append(el('div', 'ft-tip-note', researchText.ytdGrowthNote()));
    const entries = model.series.filter(s => !s.hidden).map(s => {
      const cell = s.row.cells.find(c => c.year === year);
      return { s, cell, val: cell ? cellMetricVal(cell, model.metric) : null };
    }).sort((a, b) => (b.val ?? -Infinity) - (a.val ?? -Infinity));
    for (const { s, cell, val } of entries) {
      const rowEl = el('div', `ft-tip-row${s.row.topicId === this.focusedId ? ' is-focused' : ''}`); rowEl.dataset.series = String(s.styleIndex);
      rowEl.append(el('span', 'ft-legend-dot'), el('span', 'ft-tip-name', s.row.topicName), el('span', 'ft-tip-val', formatChartValue(val, model.metric, Boolean(cell?.isYtd || isYtd), Boolean(cell?.lowBase))));
      this.tooltipEl.append(rowEl);
    }
    this.tooltipEl.hidden = false;
    const vw = typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1024, vh = typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : 768;
    const tw = this.tooltipEl.offsetWidth || 200, th = this.tooltipEl.offsetHeight || 120;
    this.tooltipEl.style.left = `${Math.round(clientX + 16 + tw <= vw - 8 ? clientX + 16 : Math.max(8, clientX - tw - 16))}px`;
    this.tooltipEl.style.top = `${Math.round(Math.max(8, Math.min(clientY - 12, vh - th - 8)))}px`;
  }
}
