import { computeCitationMapLayout, timelineCitationScale } from '../../shared/graph-layout.js';
import type { GraphEdge, GraphNode, PositionedGraphNode } from '../../shared/types.js';
import { el, readerLabel as t } from '../ui.js';

export type AuthorLabelMode = 'first' | 'last';
export type GraphViewMode = 'network' | 'timeline';

interface NodeRef { node: PositionedGraphNode; group: SVGGElement; label: SVGTextElement; anchor: 'start' | 'middle' | 'end'; lx: number }
interface EdgeRef { el: SVGLineElement; source: string; target: string; kind: GraphEdge['kind'] }
const SVG_NS = 'http://www.w3.org/2000/svg', VIEW_W = 760, VIEW_H = 480;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}
function surname(author: string, fallbackTitle: string): string {
  const clean = author.replace(/\s+et\s+al\.?$/i, '').trim();
  const base = clean ? (clean.includes(',') ? clean.split(',')[0].trim() : (clean.split(/\s+/).at(-1) ?? clean)) : (fallbackTitle.split(/\s+/)[0] ?? '');
  return base.length > 12 ? base.slice(0, 11) + '…' : base;
}
const fmtTick = (n: number): string => n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${n / 1000}k` : String(n);
const nodeCaption = (node: GraphNode, m: AuthorLabelMode) => { const n = surname(m === 'last' ? (node.lastAuthor || node.firstAuthor) : (node.firstAuthor || node.lastAuthor), node.title); return node.year ? `${n} ${node.year}` : n; };
const nodeAriaLabel = (node: GraphNode, m: AuthorLabelMode) => `${node.title} (${nodeCaption(node, m)}) — ${node.inLibrary ? t('In library', '已在库') : t('New discovery', '外部新发现')}`;

export class CitationMapSvg {
  readonly root = el('div', 'cm-svg-wrap');
  private readonly svg = svgEl('svg', { class: 'cm-svg', viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  private readonly axisLayer = svgEl('g', { class: 'cm-axis' }); private readonly edgeLayer = svgEl('g', { class: 'cm-edges' }); private readonly nodeLayer = svgEl('g', { class: 'cm-nodes' });
  private readonly refs = new Map<string, NodeRef>(); private readonly edgeEls: EdgeRef[] = [];
  private authorMode: AuthorLabelMode = 'first'; private hoveredId: string | null = null;

  constructor(private readonly callbacks: { onHover: (id: string | null) => void; onSelect: (id: string) => void }) {
    this.svg.setAttribute('aria-label', t('Citation map graph', '引文脉络图谱'));
    const defs = svgEl('defs');
    for (const [id, cls] of [['cm-arrow', 'cm-arrow-path'], ['cm-arrow-hi', 'cm-arrow-path is-hi']] as const) {
      const m = svgEl('marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' });
      m.append(svgEl('path', { class: cls, d: 'M1 1.5L7 4L1 6.5z' }));
      defs.append(m);
    }
    this.svg.append(defs, this.axisLayer, this.edgeLayer, this.nodeLayer);
    const legend = el('div', 'cm-legend'); legend.setAttribute('aria-hidden', 'true');
    for (const [cls, text] of [['is-lib', t('In library', '已在库')], ['is-disc', t('Newer discovery', '越深越新')], ['is-accent', t('1-hop focus', '联动聚焦')]] as const) {
      const item = el('span', 'cm-legend-item'); item.append(el('i', `cm-dot ${cls}`), text); legend.append(item);
    }
    this.root.append(this.svg, legend);
  }

  render(nodes: GraphNode[], edges: GraphEdge[], mode: GraphViewMode, authorMode: AuthorLabelMode, selectedId: string | null): void {
    this.authorMode = authorMode; this.hoveredId = null; this.refs.clear(); this.edgeEls.length = 0;
    this.axisLayer.replaceChildren(); this.edgeLayer.replaceChildren(); this.nodeLayer.replaceChildren();
    const plotH = mode === 'timeline' ? VIEW_H - 34 : VIEW_H;
    const placed = computeCitationMapLayout(nodes, edges, mode, VIEW_W, plotH), byId = new Map(placed.map(n => [n.id, n]));
    const years = placed.map(n => n.year).filter((y): y is number => typeof y === 'number' && Number.isFinite(y)).sort((a, b) => a - b);
    const loY = years[0] ?? 2018, hiY = years.at(-1) ?? Math.max(loY, new Date().getFullYear());

    if (mode === 'timeline' && placed.length) {
      const padX = Math.min(72, Math.max(48, VIEW_W * 0.09)), padY = Math.min(44, Math.max(24, plotH * 0.08));
      const minY = padY, maxY = Math.max(minY + 1, plotH - padY), spanY = maxY - minY;
      const { maxLog, ticks: yTicks } = timelineCitationScale(placed);
      const yCap = svgEl('text', { class: 'cm-axis-title', x: (padX - 8).toFixed(1), y: 14, 'text-anchor': 'end' });
      yCap.textContent = t('Citations', '被引数'); this.axisLayer.append(yCap);
      for (const tick of yTicks) {
        const y = (minY + (1 - Math.log10(tick + 1) / maxLog) * spanY).toFixed(1);
        this.axisLayer.append(svgEl('line', { class: 'cm-axis-grid', x1: padX, y1: y, x2: VIEW_W - padX, y2: y }));
        const yTxt = svgEl('text', { class: 'cm-axis-y-label', x: (padX - 8).toFixed(1), y: (Number(y) + 3.5).toFixed(1), 'text-anchor': 'end' });
        yTxt.textContent = fmtTick(tick); this.axisLayer.append(yTxt);
      }
      this.axisLayer.append(svgEl('line', { class: 'cm-axis-line', x1: padX, y1: plotH - 4, x2: VIEW_W - padX, y2: plotH - 4 }));
      if (years.length) {
        const span = Math.max(1, hiY - loY), count = Math.min(6, span + 1);
        const xTicks = hiY === loY ? [loY] : [...new Set(Array.from({ length: count }, (_, i) => Math.round(loY + (i * span) / Math.max(1, count - 1))))];
        for (const yr of xTicks) {
          const x = (hiY === loY ? VIEW_W / 2 : padX + ((yr - loY) / span) * (VIEW_W - padX * 2)).toFixed(1);
          this.axisLayer.append(svgEl('line', { class: 'cm-axis-tick', x1: x, y1: minY, x2: x, y2: plotH - 4 }));
          const txt = svgEl('text', { class: 'cm-axis-label', x, y: VIEW_H - 12, 'text-anchor': 'middle' });
          txt.textContent = String(yr); this.axisLayer.append(txt);
        }
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 1;
      const trim = dist > a.radius + b.radius + 6;
      const sOff = trim ? a.radius + 1 : 0, eOff = trim ? b.radius + (edge.kind === 'cites' ? 4 : 2) : 0;
      const attrs: Record<string, string | number> = {
        class: 'cm-edge', 'data-kind': edge.kind,
        x1: (a.x + (dx / dist) * sOff).toFixed(1), y1: (a.y + (dy / dist) * sOff).toFixed(1),
        x2: (b.x - (dx / dist) * eOff).toFixed(1), y2: (b.y - (dy / dist) * eOff).toFixed(1)
      };
      if (edge.kind === 'cites') attrs['marker-end'] = 'url(#cm-arrow)';
      else if (typeof edge.weight === 'number') attrs['stroke-width'] = (0.9 + Math.min(1, Math.max(0, edge.weight)) * 1.1).toFixed(2);
      const line = svgEl('line', attrs);
      this.edgeLayer.append(line); this.edgeEls.push({ el: line, source: edge.source, target: edge.target, kind: edge.kind });
    }
    for (const item of placed) {
      const ratio = item.year !== undefined && hiY > loY ? Math.max(0, Math.min(1, (item.year - loY) / (hiY - loY))) : 0.5;
      const g = svgEl('g', {
        class: `cm-node${item.isSeed ? ' is-seed' : ''}${item.id === selectedId ? ' is-selected' : ''}`,
        tabindex: 0, role: 'button', 'data-node-id': item.id, 'data-kind': item.inLibrary ? 'library' : 'discovery',
        'data-recency': String(Math.min(3, Math.floor(ratio * 4))), transform: `translate(${item.x},${item.y})`, 'aria-label': nodeAriaLabel(item, authorMode)
      });
      if (item.docId) g.dataset.docId = item.docId;
      const anchor = item.x < 80 ? 'start' : item.x > VIEW_W - 80 ? 'end' : 'middle';
      const lx = anchor === 'start' ? Math.max(6 - item.x, -item.radius) : anchor === 'end' ? Math.min(VIEW_W - 6 - item.x, item.radius) : 0;
      const label = svgEl('text', { class: 'cm-node-label', x: lx.toFixed(1), y: item.radius + 13, 'text-anchor': anchor });
      label.textContent = nodeCaption(item, authorMode);
      g.append(svgEl('circle', { class: 'cm-node-circle', r: item.radius }), label);
      const enter = () => { this.setHighlighted(item.id); this.callbacks.onHover(item.id); };
      const leave = () => { if (this.hoveredId === item.id) { this.setHighlighted(null); this.callbacks.onHover(null); } };
      g.addEventListener('mouseenter', enter); g.addEventListener('mouseleave', leave);
      g.addEventListener('focus', enter); g.addEventListener('blur', leave);
      g.addEventListener('click', () => this.callbacks.onSelect(item.id));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.callbacks.onSelect(item.id); } });
      this.nodeLayer.append(g); this.refs.set(item.id, { node: item, group: g, label, anchor, lx });
    }
    this.declutterLabels();
  }

  private declutterLabels(): void {
    const boxes: [number, number, number, number][] = [];
    const circles = [...this.refs.values()].map(({ node: n }) => ({ id: n.id, x1: n.x - n.radius - 2, y1: n.y - n.radius - 2, x2: n.x + n.radius + 2, y2: n.y + n.radius + 2 }));
    const ordered = [...this.refs.values()].sort((a, b) => Number(Boolean(b.node.isSeed)) - Number(Boolean(a.node.isSeed)) || Number(Boolean(b.node.inLibrary)) - Number(Boolean(a.node.inLibrary)) || (b.node.citationCount ?? 0) - (a.node.citationCount ?? 0));
    for (const ref of ordered) {
      const w = Math.max(44, (ref.label.textContent?.length ?? 8) * 6.8 + 8), ly = ref.node.y + ref.node.radius + 13;
      const x1 = ref.anchor === 'start' ? ref.node.x + ref.lx : ref.anchor === 'end' ? ref.node.x + ref.lx - w : ref.node.x + ref.lx - w / 2;
      const y1 = ly - 12, x2 = x1 + w, y2 = ly + 3;
      const hit = !ref.node.isSeed && (boxes.some(b => x1 < b[2] && x2 > b[0] && y1 < b[3] && y2 > b[1]) || circles.some(c => c.id !== ref.node.id && x1 < c.x2 && x2 > c.x1 && y1 < c.y2 && y2 > c.y1));
      ref.label.classList.toggle('is-muted', hit);
      if (!hit) boxes.push([x1, y1, x2, y2]);
    }
  }

  setAuthorMode(authorMode: AuthorLabelMode): void {
    this.authorMode = authorMode;
    for (const ref of this.refs.values()) { ref.label.textContent = nodeCaption(ref.node, authorMode); ref.group.setAttribute('aria-label', nodeAriaLabel(ref.node, authorMode)); }
    this.declutterLabels();
  }
  setHighlighted(nodeId: string | null): void {
    this.hoveredId = nodeId;
    const active = Boolean(nodeId), neighbors = new Set<string>();
    if (nodeId) {
      for (const e of this.edgeEls) {
        if (e.source === nodeId) neighbors.add(e.target);
        else if (e.target === nodeId) neighbors.add(e.source);
      }
    }
    for (const [id, ref] of this.refs) {
      const isSelf = id === nodeId, isNbr = active && !isSelf && neighbors.has(id);
      ref.group.classList.toggle('is-highlighted', isSelf);
      ref.group.classList.toggle('is-neighbor', isNbr);
      ref.group.classList.toggle('is-dimmed', active && !isSelf && !isNbr);
    }
    for (const edge of this.edgeEls) {
      const hit = active && (edge.source === nodeId || edge.target === nodeId);
      edge.el.classList.toggle('is-highlighted', hit);
      edge.el.classList.toggle('is-dimmed', active && !hit);
      if (edge.kind === 'cites') edge.el.setAttribute('marker-end', hit ? 'url(#cm-arrow-hi)' : 'url(#cm-arrow)');
    }
  }
  setSelected(nodeId: string | null): void { for (const [id, ref] of this.refs) ref.group.classList.toggle('is-selected', id === nodeId); }
  updateNodeInLibrary(nodeId: string, docId?: string, inLibrary = true): void {
    const ref = this.refs.get(nodeId); if (!ref) return;
    ref.node.inLibrary = inLibrary; ref.node.docId = inLibrary ? docId : undefined;
    ref.group.dataset.kind = inLibrary ? 'library' : 'discovery';
    if (inLibrary && docId) ref.group.dataset.docId = docId; else delete ref.group.dataset.docId;
    ref.group.setAttribute('aria-label', nodeAriaLabel(ref.node, this.authorMode));
  }
}
