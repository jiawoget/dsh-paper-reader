import {
  computeClusterHulls, computeShortestPathToSeed, detectCitationClusters, edgePairKey, selectBackboneEdges,
  type CitationCluster, type ClusterHull
} from '../../shared/graph-clusters.js';
import { computeCitationMapLayout, timelineCitationScale } from '../../shared/graph-layout.js';
import type { GraphEdge, GraphNode, PositionedGraphNode } from '../../shared/types.js';
import { el, readerLabel as t } from '../ui.js';
import { researchText } from './labels.js';

export type AuthorLabelMode = 'first' | 'last';
export type GraphViewMode = 'network' | 'timeline';

interface NodeRef { node: PositionedGraphNode; group: SVGGElement; label: SVGTextElement; anchor: 'start' | 'middle' | 'end'; lx: number }
interface EdgeRef { el: SVGLineElement; source: string; target: string; kind: GraphEdge['kind']; pairKey: string }
interface HaloRef { clusterId: string; group: SVGGElement }
const SVG_NS = 'http://www.w3.org/2000/svg', VIEW_W = 760, VIEW_H = 480, MIN_ZOOM = 0.5, MAX_ZOOM = 3.5;

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
const nodeAriaLabel = (node: GraphNode, m: AuthorLabelMode) => `${node.title} (${nodeCaption(node, m)}) — ${node.inLibrary ? researchText.inLibraryNode() : t('New discovery', '外部新发现')}`;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class CitationMapSvg {
  readonly root = el('div', 'cm-svg-wrap');
  private readonly svg = svgEl('svg', { class: 'cm-svg', viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  private readonly haloLayer = svgEl('g', { class: 'cm-halos' }); private readonly axisLayer = svgEl('g', { class: 'cm-axis' });
  private readonly edgeLayer = svgEl('g', { class: 'cm-edges' }); private readonly nodeLayer = svgEl('g', { class: 'cm-nodes' });
  private readonly refs = new Map<string, NodeRef>(); private readonly edgeEls: EdgeRef[] = []; private readonly haloEls: HaloRef[] = [];
  private currentNodes: PositionedGraphNode[] = []; private currentEdges: GraphEdge[] = [];
  private authorMode: AuthorLabelMode = 'first'; private hoveredId: string | null = null; private selectedId: string | null = null; private clusterFilter: string | null = null;
  private vb = { x: 0, y: 0, w: VIEW_W, h: VIEW_H }; private pan: { id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null; private suppressClickUntil = 0;

  constructor(private readonly callbacks: { onHover: (id: string | null) => void; onSelect: (id: string) => void }) {
    this.svg.setAttribute('aria-label', t('Citation map graph', '引文脉络图谱')); this.svg.dataset.zoom = '1.00';
    const defs = svgEl('defs');
    for (const [id, cls] of [['cm-arrow', 'cm-arrow-path'], ['cm-arrow-hi', 'cm-arrow-path is-hi']] as const) {
      const m = svgEl('marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' });
      m.append(svgEl('path', { class: cls, d: 'M1 1.5L7 4L1 6.5z' })); defs.append(m);
    }
    this.svg.append(defs, this.haloLayer, this.axisLayer, this.edgeLayer, this.nodeLayer);
    this.bindPanZoom();
    const legend = el('div', 'cm-legend'); legend.setAttribute('aria-hidden', 'true');
    for (const [cls, text] of [['is-seed', researchText.seedNode()], ['is-lib', researchText.inLibraryNode()], ['is-disc', researchText.yearRampLabel()], ['is-accent', researchText.pathFocusLabel()]] as const) {
      const item = el('span', 'cm-legend-item'); item.append(el('i', `cm-dot ${cls}`), text); legend.append(item);
    }
    this.root.append(this.svg, legend);
  }

  private applyViewBox(): void {
    const padX = VIEW_W * 0.55, padY = VIEW_H * 0.55;
    this.vb.x = clamp(this.vb.x, -padX, VIEW_W - this.vb.w + padX); this.vb.y = clamp(this.vb.y, -padY, VIEW_H - this.vb.h + padY);
    this.svg.setAttribute('viewBox', `${this.vb.x.toFixed(1)} ${this.vb.y.toFixed(1)} ${this.vb.w.toFixed(1)} ${this.vb.h.toFixed(1)}`);
    this.svg.dataset.zoom = (VIEW_W / this.vb.w).toFixed(2);
  }

  private bindPanZoom(): void {
    this.svg.addEventListener('wheel', e => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY); }, { passive: false });
    this.svg.addEventListener('pointerdown', e => { if (e.button === 0) this.pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: this.vb.x, vy: this.vb.y, moved: false }; });
    this.svg.addEventListener('pointermove', e => {
      if (!this.pan || this.pan.id !== e.pointerId) return;
      const dx = e.clientX - this.pan.sx, dy = e.clientY - this.pan.sy;
      if (!this.pan.moved && Math.hypot(dx, dy) < 5) return;
      if (!this.pan.moved) { this.pan.moved = true; this.svg.classList.add('is-panning'); this.svg.setPointerCapture(e.pointerId); }
      const rect = this.svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.vb.x = this.pan.vx - (dx / rect.width) * this.vb.w; this.vb.y = this.pan.vy - (dy / rect.height) * this.vb.h;
      this.applyViewBox();
    });
    const endPan = (e: PointerEvent) => {
      if (!this.pan || this.pan.id !== e.pointerId) return;
      if (this.pan.moved) { this.suppressClickUntil = Date.now() + 80; this.svg.classList.remove('is-panning'); if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId); }
      this.pan = null;
    };
    this.svg.addEventListener('pointerup', endPan); this.svg.addEventListener('pointercancel', endPan);
  }

  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    const curZoom = VIEW_W / this.vb.w, nextZoom = clamp(curZoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nextZoom - curZoom) < 0.001) return;
    const nextW = VIEW_W / nextZoom, nextH = VIEW_H / nextZoom;
    let fx = 0.5, fy = 0.5;
    if (clientX !== undefined && clientY !== undefined) {
      const rect = this.svg.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) { fx = clamp((clientX - rect.left) / rect.width, 0, 1); fy = clamp((clientY - rect.top) / rect.height, 0, 1); }
    }
    this.vb.x += (this.vb.w - nextW) * fx; this.vb.y += (this.vb.h - nextH) * fy; this.vb.w = nextW; this.vb.h = nextH;
    this.applyViewBox();
  }
  zoomIn(): void { this.zoomBy(1.25); }
  zoomOut(): void { this.zoomBy(0.8); }
  fitView(): void { this.vb = { x: 0, y: 0, w: VIEW_W, h: VIEW_H }; this.applyViewBox(); }

  private renderHalos(hulls: readonly ClusterHull[]): void {
    for (const h of hulls) {
      const g = svgEl('g', { class: 'cm-halo', 'data-cluster-id': h.clusterId, 'data-color': h.colorIndex });
      const lbl = svgEl('text', { class: 'cm-halo-label', x: h.labelX, y: h.labelY, 'text-anchor': 'middle' }); lbl.textContent = h.label;
      g.append(svgEl('ellipse', { class: 'cm-halo-bg', cx: h.cx, cy: h.cy, rx: h.rx, ry: h.ry }), lbl);
      this.haloLayer.append(g); this.haloEls.push({ clusterId: h.clusterId, group: g });
    }
  }

  render(nodes: GraphNode[], edges: GraphEdge[], mode: GraphViewMode, authorMode: AuthorLabelMode, selectedId: string | null): CitationCluster[] {
    this.authorMode = authorMode; this.hoveredId = null; this.selectedId = selectedId; this.clusterFilter = null;
    this.refs.clear(); this.edgeEls.length = 0; this.haloEls.length = 0;
    this.haloLayer.replaceChildren(); this.axisLayer.replaceChildren(); this.edgeLayer.replaceChildren(); this.nodeLayer.replaceChildren();
    this.fitView();
    const plotH = mode === 'timeline' ? VIEW_H - 34 : VIEW_H;
    const clusters = mode === 'network' ? detectCitationClusters(nodes, edges) : [];
    const placed = computeCitationMapLayout(nodes, edges, mode, VIEW_W, plotH, clusters), byId = new Map(placed.map(n => [n.id, n]));
    this.currentNodes = placed; this.currentEdges = edges;
    const years = placed.map(n => n.year).filter((y): y is number => typeof y === 'number' && Number.isFinite(y)).sort((a, b) => a - b);
    const loY = years[0] ?? 2018, hiY = years.at(-1) ?? Math.max(loY, new Date().getFullYear());

    if (mode === 'network' && clusters.length >= 2) this.renderHalos(computeClusterHulls(placed, clusters, VIEW_W, plotH));
    if (mode === 'timeline' && placed.length) {
      const padX = Math.min(72, Math.max(48, VIEW_W * 0.09)), padY = Math.min(44, Math.max(24, plotH * 0.08));
      const minY = padY, maxY = Math.max(minY + 1, plotH - padY), spanY = maxY - minY, { maxLog, ticks: yTicks } = timelineCitationScale(placed);
      const yCap = svgEl('text', { class: 'cm-axis-title', x: (padX - 8).toFixed(1), y: 14, 'text-anchor': 'end' }); yCap.textContent = t('Citations', '被引数'); this.axisLayer.append(yCap);
      for (const tick of yTicks) {
        const y = (minY + (1 - Math.log10(tick + 1) / maxLog) * spanY).toFixed(1);
        this.axisLayer.append(svgEl('line', { class: 'cm-axis-grid', x1: padX, y1: y, x2: VIEW_W - padX, y2: y }));
        const yTxt = svgEl('text', { class: 'cm-axis-y-label', x: (padX - 8).toFixed(1), y: (Number(y) + 3.5).toFixed(1), 'text-anchor': 'end' }); yTxt.textContent = fmtTick(tick); this.axisLayer.append(yTxt);
      }
      this.axisLayer.append(svgEl('line', { class: 'cm-axis-line', x1: padX, y1: plotH - 4, x2: VIEW_W - padX, y2: plotH - 4 }));
      if (years.length) {
        const span = Math.max(1, hiY - loY), count = Math.min(6, span + 1);
        const xTicks = hiY === loY ? [loY] : [...new Set(Array.from({ length: count }, (_, i) => Math.round(loY + (i * span) / Math.max(1, count - 1))))];
        for (const yr of xTicks) {
          const x = (hiY === loY ? VIEW_W / 2 : padX + ((yr - loY) / span) * (VIEW_W - padX * 2)).toFixed(1);
          this.axisLayer.append(svgEl('line', { class: 'cm-axis-tick', x1: x, y1: minY, x2: x, y2: plotH - 4 }));
          const txt = svgEl('text', { class: 'cm-axis-label', x, y: VIEW_H - 12, 'text-anchor': 'middle' }); txt.textContent = String(yr); this.axisLayer.append(txt);
        }
      }
    }
    const backbone = selectBackboneEdges(nodes, edges);
    for (const edge of edges) {
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 1, pk = edgePairKey(edge.source, edge.target);
      const trim = dist > a.radius + b.radius + 6, sOff = trim ? a.radius + 1 : 0, eOff = trim ? b.radius + (edge.kind === 'cites' ? 4 : 2) : 0;
      const attrs: Record<string, string | number> = {
        class: 'cm-edge', 'data-kind': edge.kind, 'data-backbone': backbone.has(pk) ? '1' : '0',
        x1: (a.x + (dx / dist) * sOff).toFixed(1), y1: (a.y + (dy / dist) * sOff).toFixed(1),
        x2: (b.x - (dx / dist) * eOff).toFixed(1), y2: (b.y - (dy / dist) * eOff).toFixed(1)
      };
      if (edge.kind === 'cites') attrs['marker-end'] = 'url(#cm-arrow)';
      else if (typeof edge.weight === 'number') attrs['stroke-width'] = (0.9 + Math.min(1, Math.max(0, edge.weight)) * 1.1).toFixed(2);
      const line = svgEl('line', attrs); this.edgeLayer.append(line); this.edgeEls.push({ el: line, source: edge.source, target: edge.target, kind: edge.kind, pairKey: pk });
    }
    for (const item of placed) {
      const ratio = item.year !== undefined && hiY > loY ? clamp((item.year - loY) / (hiY - loY), 0, 1) : 0.5;
      const g = svgEl('g', {
        class: `cm-node${item.isSeed ? ' is-seed' : ''}${item.id === selectedId ? ' is-selected' : ''}`,
        tabindex: 0, role: 'button', 'data-node-id': item.id, 'data-kind': item.inLibrary ? 'library' : 'discovery',
        'data-recency': String(Math.min(4, Math.floor(ratio * 5))), transform: `translate(${item.x},${item.y})`, 'aria-label': nodeAriaLabel(item, authorMode)
      });
      if (item.clusterId) g.dataset.clusterId = item.clusterId;
      if (item.docId) g.dataset.docId = item.docId;
      const anchor = item.x < 80 ? 'start' : item.x > VIEW_W - 80 ? 'end' : 'middle';
      const lx = anchor === 'start' ? Math.max(6 - item.x, -item.radius) : anchor === 'end' ? Math.min(VIEW_W - 6 - item.x, item.radius) : 0;
      const label = svgEl('text', { class: 'cm-node-label', x: lx.toFixed(1), y: item.radius + 14, 'text-anchor': anchor }); label.textContent = nodeCaption(item, authorMode);
      g.append(svgEl('circle', { class: 'cm-node-ring', r: (item.radius + 3.2).toFixed(1) }), svgEl('circle', { class: 'cm-node-circle', r: item.radius }), label);
      const enter = () => { this.setHighlighted(item.id); this.callbacks.onHover(item.id); };
      const leave = () => { if (this.hoveredId === item.id) { this.setHighlighted(null); this.callbacks.onHover(null); } };
      g.addEventListener('mouseenter', enter); g.addEventListener('mouseleave', leave); g.addEventListener('focus', enter); g.addEventListener('blur', leave);
      g.addEventListener('click', () => { if (Date.now() >= this.suppressClickUntil) this.callbacks.onSelect(item.id); });
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.callbacks.onSelect(item.id); } });
      this.nodeLayer.append(g); this.refs.set(item.id, { node: item, group: g, label, anchor, lx });
    }
    this.declutterLabels(); this.syncVisualState();
    return clusters;
  }

  private declutterLabels(): void {
    const boxes: [number, number, number, number][] = [];
    const circles = [...this.refs.values()].map(({ node: n }) => ({ id: n.id, x1: n.x - n.radius - 2, y1: n.y - n.radius - 2, x2: n.x + n.radius + 2, y2: n.y + n.radius + 2 }));
    const ordered = [...this.refs.values()].sort((a, b) => Number(Boolean(b.node.isSeed)) - Number(Boolean(a.node.isSeed)) || Number(Boolean(b.node.inLibrary)) - Number(Boolean(a.node.inLibrary)) || (b.node.citationCount ?? 0) - (a.node.citationCount ?? 0));
    for (const ref of ordered) {
      const w = Math.max(44, (ref.label.textContent?.length ?? 8) * 6.8 + 8), ly = ref.node.y + ref.node.radius + 14;
      const x1 = ref.anchor === 'start' ? ref.node.x + ref.lx : ref.anchor === 'end' ? ref.node.x + ref.lx - w : ref.node.x + ref.lx - w / 2;
      const y1 = ly - 12, x2 = x1 + w, y2 = ly + 3;
      const hit = !ref.node.isSeed && (boxes.some(b => x1 < b[2] && x2 > b[0] && y1 < b[3] && y2 > b[1]) || circles.some(c => c.id !== ref.node.id && x1 < c.x2 && x2 > c.x1 && y1 < c.y2 && y2 > c.y1));
      ref.label.classList.toggle('is-muted', hit);
      if (!hit) boxes.push([x1, y1, x2, y2]);
    }
  }

  private syncVisualState(): void {
    const activeId = this.hoveredId, active = Boolean(activeId), cf = this.clusterFilter, neighbors = new Set<string>();
    if (activeId) for (const e of this.edgeEls) { if (e.source === activeId) neighbors.add(e.target); else if (e.target === activeId) neighbors.add(e.source); }
    const pathTarget = activeId ?? this.selectedId;
    const path = pathTarget ? computeShortestPathToSeed(this.currentNodes, this.currentEdges, pathTarget) : { nodeIds: new Set<string>(), edgeKeys: new Set<string>() };
    const hasPath = path.nodeIds.size > 1;
    for (const [id, ref] of this.refs) {
      const isSelf = id === activeId, isNbr = active && !isSelf && neighbors.has(id), onPath = hasPath && path.nodeIds.has(id);
      ref.group.classList.toggle('is-highlighted', isSelf); ref.group.classList.toggle('is-neighbor', isNbr);
      ref.group.classList.toggle('is-seed-path', onPath); ref.group.classList.toggle('is-selected', id === this.selectedId);
      ref.group.classList.toggle('is-dimmed', active ? (!isSelf && !isNbr && !onPath) : Boolean(cf && ref.node.clusterId !== cf));
    }
    for (const edge of this.edgeEls) {
      const hit = active && (edge.source === activeId || edge.target === activeId), onPath = hasPath && path.edgeKeys.has(edge.pairKey);
      const sameCluster = !cf || (this.refs.get(edge.source)?.node.clusterId === cf && this.refs.get(edge.target)?.node.clusterId === cf);
      edge.el.classList.toggle('is-highlighted', hit); edge.el.classList.toggle('is-seed-path', onPath);
      edge.el.classList.toggle('is-dimmed', active ? (!hit && !onPath) : Boolean(cf && !sameCluster));
      if (edge.kind === 'cites') edge.el.setAttribute('marker-end', hit || onPath ? 'url(#cm-arrow-hi)' : 'url(#cm-arrow)');
    }
    const activeCluster = activeId ? this.refs.get(activeId)?.node.clusterId : null;
    for (const h of this.haloEls) {
      h.group.classList.toggle('is-active', Boolean(cf && cf === h.clusterId));
      h.group.classList.toggle('is-dimmed', Boolean((cf && cf !== h.clusterId) || (active && activeCluster !== h.clusterId)));
    }
  }

  setAuthorMode(authorMode: AuthorLabelMode): void {
    this.authorMode = authorMode;
    for (const ref of this.refs.values()) { ref.label.textContent = nodeCaption(ref.node, authorMode); ref.group.setAttribute('aria-label', nodeAriaLabel(ref.node, authorMode)); }
    this.declutterLabels();
  }
  setHighlighted(nodeId: string | null): void { this.hoveredId = nodeId; this.syncVisualState(); }
  setSelected(nodeId: string | null): void { this.selectedId = nodeId; this.syncVisualState(); }
  setClusterFilter(clusterId: string | null): void { this.clusterFilter = clusterId; this.syncVisualState(); }
  updateNodeInLibrary(nodeId: string, docId?: string, inLibrary = true): void {
    const ref = this.refs.get(nodeId); if (!ref) return;
    ref.node.inLibrary = inLibrary; ref.node.docId = inLibrary ? docId : undefined;
    ref.group.dataset.kind = inLibrary ? 'library' : 'discovery';
    if (inLibrary && docId) ref.group.dataset.docId = docId; else delete ref.group.dataset.docId;
    ref.group.setAttribute('aria-label', nodeAriaLabel(ref.node, this.authorMode));
  }
}
