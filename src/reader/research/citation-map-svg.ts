import { computeCitationMapLayout } from '../../shared/graph-layout.js';
import type { GraphEdge, GraphNode } from '../../shared/types.js';
import { el, readerLabel as t } from '../ui.js';

export type AuthorLabelMode = 'first' | 'last';
export type GraphViewMode = 'network' | 'timeline';

interface NodeRef { node: GraphNode; group: SVGGElement; label: SVGTextElement }

const SVG_NS = 'http://www.w3.org/2000/svg', VIEW_W = 760, VIEW_H = 480;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function surname(author: string, fallbackTitle: string): string {
  const clean = author.replace(/\s+et\s+al\.?$/i, '').trim();
  const base = clean ? (clean.includes(',') ? clean.split(',')[0].trim() : (clean.split(/\s+/).at(-1) ?? clean)) : (fallbackTitle.split(/\s+/)[0] ?? '');
  return base.length > 14 ? base.slice(0, 13) + '…' : base;
}

function nodeCaption(node: GraphNode, authorMode: AuthorLabelMode): string {
  const name = surname(authorMode === 'last' ? (node.lastAuthor || node.firstAuthor) : (node.firstAuthor || node.lastAuthor), node.title);
  return node.year ? `${name} ${node.year}` : name;
}

function nodeAriaLabel(node: GraphNode, authorMode: AuthorLabelMode): string {
  return `${node.title} (${nodeCaption(node, authorMode)}) — ${node.inLibrary ? t('In library', '已在库') : t('New discovery', '外部新发现')}`;
}

export class CitationMapSvg {
  readonly root = el('div', 'cm-svg-wrap');
  private readonly svg = svgEl('svg', { class: 'cm-svg', viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  private readonly axisLayer = svgEl('g', { class: 'cm-axis' });
  private readonly edgeLayer = svgEl('g', { class: 'cm-edges' });
  private readonly nodeLayer = svgEl('g', { class: 'cm-nodes' });
  private readonly refs = new Map<string, NodeRef>();
  private readonly edgeEls: { el: SVGLineElement; source: string; target: string }[] = [];
  private authorMode: AuthorLabelMode = 'first';
  private hoveredId: string | null = null;

  constructor(private readonly callbacks: { onHover: (id: string | null) => void; onSelect: (id: string) => void }) {
    this.svg.setAttribute('aria-label', t('Citation map graph', '引文脉络图谱'));
    this.svg.append(this.axisLayer, this.edgeLayer, this.nodeLayer);
    const legend = el('div', 'cm-legend');
    legend.setAttribute('aria-hidden', 'true');
    for (const [cls, text] of [['is-lib', t('In library', '已在库')], ['is-disc', t('Newer discovery', '越深越新')], ['is-gold', t('Highlighted', '联动高亮')]] as const) {
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

    if (mode === 'timeline' && years.length) {
      const span = Math.max(1, hiY - loY), count = Math.min(6, span + 1);
      const ticks = hiY === loY ? [loY] : [...new Set(Array.from({ length: count }, (_, i) => Math.round(loY + (i * span) / Math.max(1, count - 1))))];
      const pad = Math.min(44, Math.max(24, Math.min(VIEW_W, plotH) * 0.08));
      this.axisLayer.append(svgEl('line', { class: 'cm-axis-line', x1: pad, y1: plotH - 4, x2: VIEW_W - pad, y2: plotH - 4 }));
      for (const yr of ticks) {
        const x = (hiY === loY ? VIEW_W / 2 : pad + ((yr - loY) / span) * (VIEW_W - pad * 2)).toFixed(1);
        this.axisLayer.append(svgEl('line', { class: 'cm-axis-tick', x1: x, y1: 18, x2: x, y2: plotH - 4 }));
        const txt = svgEl('text', { class: 'cm-axis-label', x, y: VIEW_H - 12, 'text-anchor': 'middle' });
        txt.textContent = String(yr); this.axisLayer.append(txt);
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) continue;
      const line = svgEl('line', { class: 'cm-edge', 'data-kind': edge.kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      this.edgeLayer.append(line); this.edgeEls.push({ el: line, source: edge.source, target: edge.target });
    }
    for (const item of placed) {
      const ratio = item.year !== undefined && hiY > loY ? Math.max(0, Math.min(1, (item.year - loY) / (hiY - loY))) : 0.5;
      const g = svgEl('g', {
        class: `cm-node${item.isSeed ? ' is-seed' : ''}${item.id === selectedId ? ' is-selected' : ''}`,
        tabindex: 0, role: 'button', 'data-node-id': item.id, 'data-kind': item.inLibrary ? 'library' : 'discovery',
        'data-recency': String(Math.min(3, Math.floor(ratio * 4))), transform: `translate(${item.x},${item.y})`, 'aria-label': nodeAriaLabel(item, authorMode)
      });
      if (item.docId) g.dataset.docId = item.docId;
      const label = svgEl('text', { class: 'cm-node-label', y: item.radius + 13, 'text-anchor': 'middle' });
      label.textContent = nodeCaption(item, authorMode);
      g.append(svgEl('circle', { class: 'cm-node-circle', r: item.radius }), label);
      const enter = () => { this.setHighlighted(item.id); this.callbacks.onHover(item.id); };
      const leave = () => { if (this.hoveredId === item.id) { this.setHighlighted(null); this.callbacks.onHover(null); } };
      g.addEventListener('mouseenter', enter); g.addEventListener('mouseleave', leave);
      g.addEventListener('focus', enter); g.addEventListener('blur', leave);
      g.addEventListener('click', () => this.callbacks.onSelect(item.id));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.callbacks.onSelect(item.id); } });
      this.nodeLayer.append(g); this.refs.set(item.id, { node: item, group: g, label });
    }
  }

  setAuthorMode(authorMode: AuthorLabelMode): void {
    this.authorMode = authorMode;
    for (const ref of this.refs.values()) {
      ref.label.textContent = nodeCaption(ref.node, authorMode);
      ref.group.setAttribute('aria-label', nodeAriaLabel(ref.node, authorMode));
    }
  }

  setHighlighted(nodeId: string | null): void {
    this.hoveredId = nodeId;
    for (const [id, ref] of this.refs) ref.group.classList.toggle('is-highlighted', id === nodeId);
    for (const edge of this.edgeEls) edge.el.classList.toggle('is-highlighted', Boolean(nodeId) && (edge.source === nodeId || edge.target === nodeId));
  }

  setSelected(nodeId: string | null): void {
    for (const [id, ref] of this.refs) ref.group.classList.toggle('is-selected', id === nodeId);
  }

  updateNodeInLibrary(nodeId: string, docId?: string, inLibrary = true): void {
    const ref = this.refs.get(nodeId);
    if (!ref) return;
    ref.node.inLibrary = inLibrary; ref.node.docId = inLibrary ? docId : undefined;
    ref.group.dataset.kind = inLibrary ? 'library' : 'discovery';
    if (inLibrary && docId) ref.group.dataset.docId = docId; else delete ref.group.dataset.docId;
    ref.group.setAttribute('aria-label', nodeAriaLabel(ref.node, this.authorMode));
  }
}
