import type { GraphEdge, GraphNode, PositionedGraphNode } from './types.js';

export interface CitationCluster { id: string; label: string; nodeIds: string[]; count: number; colorIndex: number }
export interface ClusterHull { clusterId: string; label: string; colorIndex: number; cx: number; cy: number; rx: number; ry: number; labelX: number; labelY: number }
export const edgePairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const STOP = new Set('the and for with from into over under via using based towards toward through between beyond without within across about after before are was were that this these those its their our can may not but all any one two new novel fast high low large deep neural model models paper study approach method methods analysis system systems framework learning network networks efficient improved better multi pre self end real time data task tasks performance scale scaling language general unified automatic adaptive dynamic effective evaluation survey review benchmark benchmarks'.split(' '));
const SHORT_KEEP = new Set(['kv', 'ai', 'rl', 'qa', 'lm', '3d', '2d', 'ir', 'ml', 'dl', 'io', 'os']);
const ACRONYMS = new Set(['kv', 'llm', 'llms', 'gpu', 'gpus', 'cpu', 'rag', 'rlhf', 'nlp', 'vlm', 'moe', 'lora', 'ai', 'rl', 'qa', 'lm', '3d', '2d', 'sft', 'dpo', 'ppo', 'mlp', 'cnn', 'rnn', 'gnn', 'vit', 'nerf', 'cuda', 'fp8', 'int4', 'int8']);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const fmtTok = (tok: string): string => ACRONYMS.has(tok) ? tok.toUpperCase() : tok.includes('-') ? tok.split('-').map(fmtTok).join('-') : tok[0].toUpperCase() + tok.slice(1);

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().replace(/[^a-z0-9\p{Script=Han}-]+/gu, ' ').split(/\s+/)) {
    const c = w.replace(/^-+|-+$/g, '');
    if (!c || /^\d+$/.test(c) || STOP.has(c) || (c.length < 3 && !SHORT_KEEP.has(c) && !/\p{Script=Han}/u.test(c))) continue;
    out.push(c);
  }
  return out;
}

export function extractClusterLabel(clusterNodes: readonly GraphNode[], allNodes: readonly GraphNode[], avoid?: ReadonlySet<string>): string {
  const docFreq = new Map<string, number>(), tf = new Map<string, number>(), cDf = new Map<string, number>();
  const scan = (toks: string[], bag: Set<string>, mult = 0) => {
    for (let i = 0; i < toks.length; i++) {
      bag.add(toks[i]); if (mult) tf.set(toks[i], (tf.get(toks[i]) ?? 0) + mult);
      if (i + 1 < toks.length && toks[i] !== toks[i + 1]) {
        const bi = `${toks[i]} ${toks[i + 1]}`; bag.add(bi);
        if (mult) tf.set(bi, (tf.get(bi) ?? 0) + mult * 1.15);
      }
    }
  };
  for (const n of allNodes) { const s = new Set<string>(); scan(tokenize(n.title), s); if (n.topic) scan(tokenize(n.topic), s); for (const t of s) docFreq.set(t, (docFreq.get(t) ?? 0) + 1); }
  for (const n of clusterNodes) { const s = new Set<string>(); scan(tokenize(n.title), s, 1); if (n.topic) scan(tokenize(n.topic), s, 1.5); for (const t of s) cDf.set(t, (cDf.get(t) ?? 0) + 1); }
  const total = Math.max(1, allNodes.length);
  const ranked = [...tf.entries()]
    .map(([term, f]) => ({ term, score: f * (Math.log((total + 1) / ((docFreq.get(term) ?? 1) + 1)) + 0.35) * (term.includes(' ') ? ((cDf.get(term) ?? 0) >= 2 ? 1.45 : 1.05) : 1) }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term)).map(x => x.term);
  for (const top of ranked) {
    const words = top.split(' ');
    let label = words.map(fmtTok).join(' ');
    if (words.length === 1) {
      const sec = ranked.find(r => !r.includes(' ') && r !== top && !top.includes(r) && !r.includes(top));
      if (sec) label = `${fmtTok(top)} ${fmtTok(sec)}`;
    }
    if (!avoid?.has(label.toLowerCase())) return label;
  }
  const fb = clusterNodes[0]?.title.split(/\s+/).filter(Boolean).slice(0, 2).join(' ') || 'Topic';
  return fb.length > 22 ? fb.slice(0, 21) + '…' : fb;
}

export function detectCitationClusters(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): CitationCluster[] {
  if (!nodes.length) return [];
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id)), byId = new Map(sorted.map(n => [n.id, n]));
  const adj = new Map<string, Map<string, number>>(sorted.map(n => [n.id, new Map()]));
  const add = (u: string, v: string, w: number) => { if (u !== v && adj.has(u) && adj.has(v)) { adj.get(u)!.set(v, (adj.get(u)!.get(v) ?? 0) + w); adj.get(v)!.set(u, (adj.get(v)!.get(u) ?? 0) + w); } };
  for (const e of edges) add(e.source, e.target, clamp(e.weight ?? (e.kind === 'cites' ? 1 : 0.55), 0.15, 1));
  const toks = new Map(sorted.map(n => [n.id, new Set([...tokenize(n.title), ...(n.topic ? tokenize(n.topic) : [])])]));
  for (let i = 0; i < sorted.length; i++) {
    const a = toks.get(sorted[i].id)!;
    if (!a.size) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = toks.get(sorted[j].id)!; let sh = 0;
      for (const w of a) if (b.has(w)) sh++;
      if (sh > 0) add(sorted[i].id, sorted[j].id, clamp((sh / Math.sqrt(a.size * b.size)) * 0.55, 0.08, 0.55));
    }
  }
  const lbls = new Map(sorted.map(n => [n.id, n.id]));
  for (let it = 0; it < 12; it++) {
    let ch = false;
    for (const n of sorted) {
      const nbrs = adj.get(n.id)!, wt = new Map<string, number>();
      if (!nbrs.size) continue;
      for (const [v, w] of nbrs) { const l = lbls.get(v)!; wt.set(l, (wt.get(l) ?? 0) + w * (byId.get(v)?.isSeed && !n.isSeed ? 0.35 : 1)); }
      let best = lbls.get(n.id)!, bw = -1;
      for (const [l, w] of wt) if (w > bw + 1e-9 || (Math.abs(w - bw) <= 1e-9 && l.localeCompare(best) < 0)) { bw = w; best = l; }
      if (best !== lbls.get(n.id)) { lbls.set(n.id, best); ch = true; }
    }
    if (!ch) break;
  }
  const gMap = new Map<string, string[]>();
  for (const n of sorted) { const l = lbls.get(n.id)!; (gMap.get(l) ?? (gMap.set(l, []), gMap.get(l)!)).push(n.id); }
  const groups = [...gMap.values()].map(ids => ids.sort());
  const minK = sorted.length < 6 ? 1 : 3, maxK = sorted.length <= 2 ? 1 : sorted.length < 6 ? 2 : Math.min(5, Math.floor(sorted.length / 2));
  const aff = (a: string[], b: string[]): number => { let s = 0; const bs = new Set(b); for (const u of a) for (const [v, w] of adj.get(u)!) if (bs.has(v)) s += w; return s / Math.max(1, Math.sqrt(a.length * b.length)); };
  while (groups.length > maxK || (groups.length > minK && groups.some(g => g.length === 1))) {
    const sIdx = groups.length > maxK ? -1 : groups.findIndex(g => g.length === 1);
    let bi = 0, bj = 1, bs = -1;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      if (sIdx >= 0 && i !== sIdx && j !== sIdx) continue;
      const sc = aff(groups[i], groups[j]) + 0.001 / (groups[i].length + groups[j].length);
      if (sc > bs + 1e-12) { bs = sc; bi = i; bj = j; }
    }
    groups[bi] = [...groups[bi], ...groups[bj]].sort(); groups.splice(bj, 1);
  }
  while (groups.length < minK) {
    let big = 0;
    for (let i = 1; i < groups.length; i++) if (groups[i].length > groups[big].length) big = i;
    if (groups[big].length < 2) break;
    const ord = [...groups[big]].sort((a, b) => (byId.get(a)!.year ?? 0) - (byId.get(b)!.year ?? 0) || [...toks.get(a)!].sort().join(',').localeCompare([...toks.get(b)!].sort().join(',')) || a.localeCompare(b));
    const mid = Math.floor(ord.length / 2);
    groups[big] = ord.slice(0, mid).sort(); groups.push(ord.slice(mid).sort());
  }
  groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const used = new Set<string>();
  return groups.map((nodeIds, idx) => {
    const label = extractClusterLabel(nodeIds.map(id => byId.get(id)!), sorted, used); used.add(label.toLowerCase());
    return { id: `c${idx}`, label, nodeIds, count: nodeIds.length, colorIndex: idx % 5 };
  });
}

export function computeShortestPathToSeed(nodes: readonly GraphNode[], edges: readonly GraphEdge[], targetId: string): { nodeIds: Set<string>; edgeKeys: Set<string> } {
  const seeds = new Set(nodes.filter(n => n.isSeed).map(n => n.id));
  if (!targetId || !nodes.some(n => n.id === targetId)) return { nodeIds: new Set(), edgeKeys: new Set() };
  if (seeds.has(targetId) || !seeds.size) return { nodeIds: new Set([targetId]), edgeKeys: new Set() };
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    (adj.get(e.source) ?? (adj.set(e.source, []), adj.get(e.source)!)).push(e.target);
    (adj.get(e.target) ?? (adj.set(e.target, []), adj.get(e.target)!)).push(e.source);
  }
  for (const list of adj.values()) list.sort();
  const prev = new Map<string, string | null>([[targetId, null]]), q = [targetId];
  let hit: string | null = null;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h]; if (seeds.has(cur)) { hit = cur; break; }
    for (const nxt of adj.get(cur) ?? []) if (!prev.has(nxt)) { prev.set(nxt, cur); q.push(nxt); }
  }
  if (!hit) return { nodeIds: new Set([targetId]), edgeKeys: new Set() };
  const nodeIds = new Set<string>(), edgeKeys = new Set<string>();
  for (let cur: string | null = hit; cur; cur = prev.get(cur) ?? null) { nodeIds.add(cur); const p = prev.get(cur); if (p) edgeKeys.add(edgePairKey(cur, p)); }
  return { nodeIds, edgeKeys };
}

export function selectBackboneEdges(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Set<string> {
  const seeds = new Set(nodes.filter(n => n.isSeed).map(n => n.id)), keep = new Set<string>();
  const inc = new Map<string, { key: string; w: number; c: number; other: string }[]>();
  const push = (u: string, v: string, e: GraphEdge, key: string) => { (inc.get(u) ?? (inc.set(u, []), inc.get(u)!)).push({ key, w: e.weight ?? (e.kind === 'cites' ? 1 : 0.5), c: e.kind === 'cites' ? 1 : 0, other: v }); };
  for (const e of edges) {
    if (e.source === e.target) continue;
    const key = edgePairKey(e.source, e.target);
    if (seeds.has(e.source) || seeds.has(e.target)) keep.add(key);
    push(e.source, e.target, e, key); push(e.target, e.source, e, key);
  }
  for (const list of inc.values()) { list.sort((a, b) => b.w - a.w || b.c - a.c || a.other.localeCompare(b.other)); for (const item of list.slice(0, 2)) keep.add(item.key); }
  return keep;
}

export function computeClusterHulls(placed: readonly PositionedGraphNode[], clusters: readonly CitationCluster[], viewW = 760, viewH = 480): ClusterHull[] {
  const byId = new Map(placed.map(n => [n.id, n])), hulls: ClusterHull[] = [];
  for (const c of clusters) {
    const pts = c.nodeIds.map(id => byId.get(id)).filter((n): n is PositionedGraphNode => Boolean(n));
    if (pts.length < 2) continue;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let dx = 0, dy = 0;
    for (const p of pts) { dx = Math.max(dx, Math.abs(p.x - cx) + p.radius); dy = Math.max(dy, Math.abs(p.y - cy) + p.radius); }
    const rx = clamp(dx + 24, 42, viewW * 0.44), ry = clamp(dy + 22, 34, viewH * 0.44);
    hulls.push({ clusterId: c.id, label: c.label, colorIndex: c.colorIndex, cx: Number(cx.toFixed(1)), cy: Number(cy.toFixed(1)), rx: Number(rx.toFixed(1)), ry: Number(ry.toFixed(1)), labelX: Number(clamp(cx, 62, viewW - 62).toFixed(1)), labelY: Number(clamp(cy - ry + 14, 15, viewH - 10).toFixed(1)) });
  }
  for (let i = 1; i < hulls.length; i++) for (let j = 0; j < i; j++) {
    if (Math.abs(hulls[i].labelX - hulls[j].labelX) < 92 && Math.abs(hulls[i].labelY - hulls[j].labelY) < 16) hulls[i].labelY = Number(clamp(hulls[i].cy + hulls[i].ry - 6, 15, viewH - 10).toFixed(1));
  }
  return hulls;
}
