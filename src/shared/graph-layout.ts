import type { GraphEdge, GraphNode, GraphPaper, PositionedGraphNode } from './types.js';

export function reconstructInvertedAbstract(inv: Record<string, number[]> | null | undefined): string {
  if (!inv || typeof inv !== 'object') return '';
  const pairs: [number, string][] = [];
  for (const [word, positions] of Object.entries(inv)) {
    if (!word || !Array.isArray(positions)) continue;
    for (const pos of positions) if (typeof pos === 'number' && Number.isInteger(pos) && pos >= 0 && pos < 50_000) pairs.push([pos, word]);
  }
  return pairs.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ').replace(/\s+/g, ' ').trim();
}

export function rankEarlierByCoCitation(candidates: GraphPaper[], seedCountMap: Map<string, number>, limit: number): GraphPaper[] {
  const unique = new Map<string, GraphPaper>();
  for (const p of candidates) if (!unique.has(p.id) || (p.citationCount ?? 0) > (unique.get(p.id)!.citationCount ?? 0)) unique.set(p.id, p);
  return [...unique.values()]
    .sort((a, b) => (seedCountMap.get(b.id) ?? 0) - (seedCountMap.get(a.id) ?? 0) || (b.citationCount ?? 0) - (a.citationCount ?? 0) || (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.floor(limit)));
}

const clamp = (v: number, lo: number, hi: number): number => v < lo ? lo : v > hi ? hi : v;
const nodeRankCmp = (a: GraphNode, b: GraphNode): number =>
  Number(Boolean(b.isSeed)) - Number(Boolean(a.isSeed)) || (b.coCitations ?? 0) - (a.coCitations ?? 0) || (b.citationCount ?? 0) - (a.citationCount ?? 0) || (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id);

export function computeCitationMapLayout(
  nodes: GraphNode[], edges: GraphEdge[], mode: 'timeline' | 'network', width: number, height: number
): PositionedGraphNode[] {
  if (!nodes.length) return [];
  const safeW = Math.max(160, Number.isFinite(width) ? width : 800), safeH = Math.max(160, Number.isFinite(height) ? height : 500);
  const pad = Math.min(44, Math.max(24, Math.min(safeW, safeH) * 0.08));
  const minX = pad, maxX = Math.max(minX + 1, safeW - pad), minY = pad, maxY = Math.max(minY + 1, safeH - pad);
  const spanX = maxX - minX, spanY = maxY - minY, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const scale = Math.min(1, Math.max(5, Math.min(14, Math.sqrt((spanX * spanY) / (nodes.length * 14)))) / 14);
  const gap = Math.max(2, Math.round(4 * scale));
  const items = nodes.map(n => ({
    node: n, x: cx, y: cy, tx: cx,
    r: Math.max(5, Math.round((n.isSeed ? 13 : 8 + Math.min(6, Math.round(Math.log10(Math.max(0, n.citationCount ?? 0) + 1) * 1.8))) * scale))
  }));
  const idIndex = new Map(items.map((item, idx) => [item.node.id, idx]));

  if (mode === 'timeline') {
    const years = items.map(i => i.node.year).filter((y): y is number => typeof y === 'number' && Number.isFinite(y)).sort((a, b) => a - b);
    const medY = years[Math.floor(years.length / 2)] ?? 2020, loY = years[0] ?? medY - 1, hiY = years.at(-1) ?? medY + 1;
    const buckets = new Map<number, number[]>();
    items.forEach((item, idx) => {
      const yVal = typeof item.node.year === 'number' && Number.isFinite(item.node.year) ? item.node.year : medY;
      item.x = item.tx = hiY === loY ? minX + ((idx + 0.5) / items.length) * spanX : minX + ((yVal - loY) / Math.max(1, hiY - loY)) * spanX;
      buckets.set(yVal, [...(buckets.get(yVal) ?? []), idx]);
    });
    for (const bucket of buckets.values()) {
      bucket.sort((ai, bi) => nodeRankCmp(items[ai].node, items[bi].node));
      bucket.forEach((idx, rank) => { items[idx].y = bucket.length === 1 ? cy : minY + ((rank + 0.5) / bucket.length) * spanY; });
    }
  } else {
    const order = items.map((_, idx) => idx).sort((ai, bi) => nodeRankCmp(items[ai].node, items[bi].node));
    const seeds = order.filter(i => items[i].node.isSeed), others = order.filter(i => !items[i].node.isSeed);
    const innerR = Math.min(spanX, spanY) * 0.14;
    seeds.forEach((idx, rank) => {
      const a = (rank / Math.max(1, seeds.length)) * Math.PI * 2 - Math.PI / 2;
      items[idx].x = seeds.length === 1 ? cx : cx + Math.cos(a) * innerR;
      items[idx].y = seeds.length === 1 ? cy : cy + Math.sin(a) * innerR;
    });
    others.forEach((idx, rank) => {
      const frac = Math.sqrt((rank + 1) / (others.length + 1)), a = rank * 2.399963229728653;
      items[idx].x = clamp(cx + Math.cos(a) * (spanX * 0.44 * frac), minX, maxX);
      items[idx].y = clamp(cy + Math.sin(a) * (spanY * 0.44 * frac), minY, maxY);
    });
  }

  const edgePairs = edges.map(e => [idIndex.get(e.source), idIndex.get(e.target)] as const)
    .filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined && p[0] !== p[1]);
  const idealEdge = Math.min(spanX, spanY) * 0.22;
  for (let step = 0, total = mode === 'network' ? 90 : 70; step < total; step++) {
    if (mode === 'network' && step < 45) {
      for (const [ai, bi] of edgePairs) {
        const a = items[ai], b = items[bi], dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 1;
        const pull = ((dist - idealEdge) / dist) * 0.04;
        a.x += dx * pull; a.y += dy * pull; b.x -= dx * pull; b.y -= dy * pull;
      }
      for (const item of items) { item.x += (cx - item.x) * 0.015; item.y += (cy - item.y) * 0.015; }
    } else if (mode === 'timeline' && step < 40) for (const item of items) item.x += (item.tx - item.x) * 0.14;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        let dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r + gap;
        if (dist >= minDist) continue;
        if (dist < 0.001) { const ang = ((i * 31 + j * 17) % 360) * (Math.PI / 180); dx = Math.cos(ang); dy = Math.sin(ang); dist = 1; }
        const push = (minDist - dist) * 0.52, ux = dx / dist, uy = dy / dist, xw = mode === 'timeline' ? 0.45 : 1;
        a.x -= ux * push * xw; a.y -= uy * push; b.x += ux * push * xw; b.y += uy * push;
      }
    }
    for (const item of items) {
      item.x = clamp(Number.isFinite(item.x) ? item.x : cx, minX, maxX);
      item.y = clamp(Number.isFinite(item.y) ? item.y : cy, minY, maxY);
    }
  }
  return items.map(({ node, x, y, r }) => ({ ...node, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), radius: r }));
}
