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
const pairKey = (a: string, b: string): string => a < b ? `${a}|${b}` : `${b}|${a}`;
const nodeRankCmp = (a: GraphNode, b: GraphNode): number =>
  Number(Boolean(b.isSeed)) - Number(Boolean(a.isSeed)) || (b.coCitations ?? 0) - (a.coCitations ?? 0) || (b.citationCount ?? 0) - (a.citationCount ?? 0) || (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id);

export function timelineCitationScale(nodes: readonly GraphNode[]): { maxLog: number; ticks: number[] } {
  const maxCite = nodes.reduce((m, n) => Math.max(m, Math.max(0, n.citationCount ?? 0)), 0);
  const maxExp = Math.max(1, Math.ceil(Math.log10(Math.max(1, maxCite))));
  const maxLog = Math.max(maxExp, Math.log10(maxCite + 1));
  const step = maxExp > 5 ? 2 : 1, ticks: number[] = [0];
  for (let e = step; e <= maxExp; e += step) ticks.push(10 ** e);
  if (ticks.at(-1)! < 10 ** maxExp) ticks.push(10 ** maxExp);
  return { maxLog, ticks };
}

export function buildCitationGraphEdges(
  nodes: readonly GraphNode[],
  refsByNodeId: ReadonlyMap<string, readonly string[]>,
  relatedByNodeId: ReadonlyMap<string, readonly string[]>,
  seedFallbackEdges: readonly GraphEdge[] = []
): GraphEdge[] {
  if (!nodes.length) return [];
  const oaToNodeId = new Map<string, string>(), nodeIds = new Set<string>(), seedIds = new Set<string>();
  const refSets = new Map<string, Set<string>>(), relSets = new Map<string, Set<string>>();
  for (const n of nodes) {
    nodeIds.add(n.id);
    if (n.isSeed) seedIds.add(n.id);
    oaToNodeId.set(n.id, n.id);
    if (n.openAlexId) oaToNodeId.set(n.openAlexId, n.id);
    const refs = refsByNodeId.get(n.id);
    if (refs?.length) refSets.set(n.id, new Set(refs));
    const rels = relatedByNodeId.get(n.id);
    if (rels?.length) relSets.set(n.id, new Set(rels));
  }
  const edges: GraphEdge[] = [], citesKeys = new Set<string>(), directPairs = new Set<string>(), coCites = new Map<string, number>();
  for (const u of nodes) {
    const refs = refSets.get(u.id);
    if (!refs) continue;
    const inMap: string[] = [];
    for (const refId of refs) {
      const vId = oaToNodeId.get(refId);
      if (!vId || vId === u.id) continue;
      const ck = `${u.id}->${vId}`;
      if (!citesKeys.has(ck)) {
        citesKeys.add(ck); directPairs.add(pairKey(u.id, vId)); inMap.push(vId);
        edges.push({ source: u.id, target: vId, kind: 'cites', weight: 1 });
      }
    }
    for (let i = 0; i < inMap.length; i++) {
      for (let j = i + 1; j < inMap.length; j++) {
        const pk = pairKey(inMap[i], inMap[j]);
        coCites.set(pk, (coCites.get(pk) ?? 0) + 1);
      }
    }
  }
  const simCandidates: { source: string; target: string; weight: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const u = nodes[i], v = nodes[j], pk = pairKey(u.id, v.id);
      if (directPairs.has(pk)) continue;
      const ru = refSets.get(u.id), rv = refSets.get(v.id);
      let shared = 0;
      if (ru && rv) {
        const [small, big] = ru.size <= rv.size ? [ru, rv] : [rv, ru];
        for (const r of small) if (big.has(r)) shared++;
      }
      const bc = shared > 0 && ru && rv ? shared / Math.sqrt(ru.size * rv.size) : 0;
      const co = coCites.get(pk) ?? 0;
      const oaRel = Boolean(
        (u.openAlexId && relSets.get(v.id)?.has(u.openAlexId)) || (v.openAlexId && relSets.get(u.id)?.has(v.openAlexId)) ||
        relSets.get(u.id)?.has(v.id) || relSets.get(v.id)?.has(u.id)
      );
      if (shared >= 2 || co >= 2 || oaRel) {
        const w = Number(clamp(bc + (co >= 2 ? Math.min(0.45, co * 0.12) : 0) + (oaRel ? 0.2 : 0), 0.15, 0.95).toFixed(3));
        simCandidates.push({ source: u.id, target: v.id, weight: w });
      }
    }
  }
  simCandidates.sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const simCap = Math.ceil(nodes.length * 2.5), simDeg = new Map<string, number>();
  let simCount = 0;
  for (const c of simCandidates) {
    if (simCount >= simCap) break;
    if ((simDeg.get(c.source) ?? 0) >= 3 || (simDeg.get(c.target) ?? 0) >= 3) continue;
    edges.push({ source: c.source, target: c.target, kind: 'related', weight: c.weight });
    simDeg.set(c.source, (simDeg.get(c.source) ?? 0) + 1); simDeg.set(c.target, (simDeg.get(c.target) ?? 0) + 1);
    simCount++;
  }
  const deg = new Map<string, number>(), seen = new Set<string>();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    seen.add(`${e.source}->${e.target}:${e.kind}`);
  }
  for (const e of seedFallbackEdges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target) || e.source === e.target) continue;
    const orphanSrc = !seedIds.has(e.source) && (deg.get(e.source) ?? 0) === 0;
    const orphanTgt = !seedIds.has(e.target) && (deg.get(e.target) ?? 0) === 0;
    const key = `${e.source}->${e.target}:${e.kind}`;
    if ((!orphanSrc && !orphanTgt) || seen.has(key)) continue;
    seen.add(key);
    edges.push({ ...e, weight: e.weight ?? (e.kind === 'cites' ? 1 : 0.4) });
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return edges;
}

export function computeCitationMapLayout(
  nodes: GraphNode[], edges: GraphEdge[], mode: 'timeline' | 'network', width: number, height: number
): PositionedGraphNode[] {
  if (!nodes.length) return [];
  const safeW = Math.max(160, Number.isFinite(width) ? width : 800), safeH = Math.max(160, Number.isFinite(height) ? height : 500);
  const padX = mode === 'timeline' ? Math.min(72, Math.max(48, safeW * 0.09)) : Math.min(68, Math.max(36, safeW * 0.085));
  const padY = Math.min(44, Math.max(24, safeH * 0.08));
  const minX = padX, maxX = Math.max(minX + 1, safeW - padX), minY = padY, maxY = Math.max(minY + 1, safeH - padY);
  const spanX = maxX - minX, spanY = maxY - minY, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const scale = Math.min(1, Math.max(5, Math.min(14, Math.sqrt((spanX * spanY) / (nodes.length * 14)))) / 14);
  const gap = Math.max(2, Math.round(4 * scale));
  const items = nodes.map(n => ({
    node: n, x: cx, y: cy, tx: cx, ty: cy,
    r: Math.max(5, Math.round((n.isSeed ? 13 : 8 + Math.min(6, Math.round(Math.log10(Math.max(0, n.citationCount ?? 0) + 1) * 1.8))) * scale))
  }));
  const idIndex = new Map(items.map((item, idx) => [item.node.id, idx]));

  if (mode === 'timeline') {
    const years = items.map(i => i.node.year).filter((y): y is number => typeof y === 'number' && Number.isFinite(y)).sort((a, b) => a - b);
    const medY = years[Math.floor(years.length / 2)] ?? 2020, loY = years[0] ?? medY - 1, hiY = years.at(-1) ?? medY + 1;
    const { maxLog } = timelineCitationScale(nodes);
    items.forEach((item, idx) => {
      const yVal = typeof item.node.year === 'number' && Number.isFinite(item.node.year) ? item.node.year : medY;
      item.x = item.tx = hiY === loY ? minX + ((idx + 0.5) / items.length) * spanX : minX + ((yVal - loY) / Math.max(1, hiY - loY)) * spanX;
      const logC = Math.log10(Math.max(0, item.node.citationCount ?? 0) + 1);
      item.y = item.ty = clamp(minY + (1 - logC / maxLog) * spanY, minY, maxY);
    });
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
      items[idx].x = clamp(cx + Math.cos(a) * (spanX * 0.48 * frac), minX, maxX);
      items[idx].y = clamp(cy + Math.sin(a) * (spanY * 0.46 * frac), minY, maxY);
    });
  }

  const edgeSpecs = edges
    .map(e => [idIndex.get(e.source), idIndex.get(e.target), clamp(e.weight ?? (e.kind === 'cites' ? 1 : 0.6), 0.15, 1)] as const)
    .filter((p): p is readonly [number, number, number] => p[0] !== undefined && p[1] !== undefined && p[0] !== p[1]);
  const cell = Math.sqrt((spanX * spanY) / Math.max(1, items.length)), idealEdge = Math.hypot(spanX, spanY) * 0.34;
  const sepX = Math.min(88, Math.max(34, cell * 1.1)), sepY = Math.min(46, Math.max(22, cell * 0.58));
  for (let step = 0, total = mode === 'network' ? 90 : 70; step < total; step++) {
    if (mode === 'network' && step < 40) {
      for (const [ai, bi, w] of edgeSpecs) {
        const a = items[ai], b = items[bi], dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 1;
        const targetDist = idealEdge * (1.2 - 0.4 * w), pull = ((dist - targetDist) / dist) * (0.005 + 0.008 * w);
        a.x += dx * pull; a.y += dy * pull; b.x -= dx * pull; b.y -= dy * pull;
      }
    } else if (mode === 'timeline' && step < 40) {
      for (const item of items) { item.x += (item.tx - item.x) * 0.14; item.y += (item.ty - item.y) * 0.14; }
    }
    const labelPass = mode === 'network' && step < 65, repelPass = mode === 'network' && step < 45;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        let dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
        if (dist < 0.001) { const ang = ((i * 31 + j * 17) % 360) * (Math.PI / 180); dx = Math.cos(ang); dy = Math.sin(ang); dist = 1; }
        const minDist = a.r + b.r + gap;
        if (dist < minDist) {
          const push = (minDist - dist) * 0.52, ux = dx / dist, uy = dy / dist, xw = mode === 'timeline' ? 0.45 : 1;
          a.x -= ux * push * xw; a.y -= uy * push; b.x += ux * push * xw; b.y += uy * push;
        } else {
          if (repelPass && dist < idealEdge * 1.1) {
            const rf = Math.min(4, (cell * cell * 0.16) / (dist * dist + 60)), ux = dx / dist, uy = dy / dist;
            a.x -= ux * rf; a.y -= uy * rf; b.x += ux * rf; b.y += uy * rf;
          }
          if (labelPass) {
            const nd = Math.hypot(dx / sepX, dy / sepY);
            if (nd < 1) { const f = (1 - nd) * 0.22; a.x -= dx * f; a.y -= dy * f; b.x += dx * f; b.y += dy * f; }
          }
        }
      }
    }
    for (const item of items) {
      item.x = clamp(Number.isFinite(item.x) ? item.x : cx, minX, maxX);
      item.y = clamp(Number.isFinite(item.y) ? item.y : cy, minY, maxY);
    }
  }
  return items.map(({ node, x, y, r }) => ({ ...node, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), radius: r }));
}
