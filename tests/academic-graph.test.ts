import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildCitationGraphEdges, computeCitationMapLayout, rankEarlierByCoCitation, reconstructInvertedAbstract, timelineCitationScale } from '../src/shared/graph-layout.js';
import type { GraphEdge, GraphNode, GraphPaper } from '../src/shared/types.js';
import { exploreCitationGraph, readGraphPaperInput, resolveAcademicPaper, type GraphContext } from '../src/server/academic-graph.js';
import { Library } from '../src/server/library.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { ensureResearchSchema, getGraphCache, setGraphCache } from '../src/server/research-store.js';
import { ServiceError } from '../src/server/service-types.js';
import { createServices } from '../src/server/services.js';

const jsonRes = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const makeOa = (id: string, title: string, year: number, citations: number, refs: string[] = [], extra: Record<string, unknown> = {}) => ({
  id: `https://openalex.org/${id}`, title, publication_year: year, cited_by_count: citations,
  authorships: [{ author: { display_name: 'Alice Smith' } }, { author: { display_name: 'Bob Zhang' } }],
  referenced_works: refs.map(r => `https://openalex.org/${r}`), related_works: [], ...extra
});

test('reconstructInvertedAbstract handles multi-position words, punctuation, and empty inputs', () => {
  assert.equal(reconstructInvertedAbstract(null), '');
  assert.equal(reconstructInvertedAbstract({}), '');
  assert.equal(reconstructInvertedAbstract({ 'KV-cache': [2, 6], PagedAttention: [0], reduces: [1], 'fragmentation,': [3], improving: [4], shared: [5], 'throughput.': [7] }),
    'PagedAttention reduces KV-cache fragmentation, improving shared KV-cache throughput.');
});

test('exploreCitationGraph batches 60 OpenAlex refs in <=2 requests and ranks Earlier by co-citation intersection', async () => {
  const db = new DatabaseSync(':memory:');
  ensureResearchSchema(db);
  const refsA = Array.from({ length: 60 }, (_, i) => `W${1000 + i}`), batchUrls: string[] = [];
  const fetchFn: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('/works/W1?')) return jsonRes(makeOa('W1', 'Seed A', 2023, 200, refsA));
    if (url.includes('/works/W2?')) return jsonRes(makeOa('W2', 'Seed B', 2024, 150, ['W1005', 'W1009']));
    if (url.includes('filter=openalex')) {
      batchUrls.push(url);
      const ids = decodeURIComponent(new URL(url).searchParams.get('filter') ?? '').replace('openalex:', '').split('|').filter(Boolean);
      return jsonRes({ results: ids.map(id => makeOa(id, `Ref ${id}`, 2019, id === 'W1000' ? 9000 : id === 'W1009' ? 500 : 100)) });
    }
    return jsonRes({}, 404);
  };
  try {
    const res = await exploreCitationGraph({ seeds: ['W1', 'W2'], direction: 'earlier', limit: 25 }, { withDb: (_, run) => run(db), fetchFn });
    assert.ok(batchUrls.length === 2 && res.nodes.length <= 25 && res.nodes.length >= 20);
    const earlier = res.nodes.filter(n => !n.isSeed);
    assert.deepEqual(earlier.slice(0, 2).map(n => n.id), ['W1009', 'W1005']);
    assert.ok(earlier[0].coCitations === 2 && earlier[0].firstAuthor === 'Alice Smith' && earlier[0].lastAuthor === 'Bob Zhang');
    assert.deepEqual(rankEarlierByCoCitation([earlier[2], earlier[1], earlier[0]], new Map([['W1005', 2], ['W1009', 2], [earlier[2].id, 1]]), 2).map(p => p.id), ['W1009', 'W1005']);
  } finally { db.close(); }
});

test('429 retry-after backoff succeeds; persistent failures use stale SQLite cache and graceful degradation', async () => {
  const db = new DatabaseSync(':memory:');
  ensureResearchSchema(db);
  const sleeps: number[] = [];
  let calls = 0;
  const ctx: GraphContext = {
    withDb: (_, run) => run(db), sleepFn: async ms => { sleeps.push(ms); },
    fetchFn: async input => {
      const url = String(input);
      if (url.includes('/works/W42')) return ++calls === 1 ? jsonRes({}, 429, { 'retry-after': '1' }) : jsonRes(makeOa('W42', 'Recovered Paper', 2022, 321, [], { doi: 'https://doi.org/10.1000/rec', abstract_inverted_index: { Recovered: [0], text: [1] }, related_works: ['https://openalex.org/W77'] }));
      return url.includes('W77') ? jsonRes({ results: [makeOa('W77', 'OA Related Fallback', 2023, 88)] }) : jsonRes({}, 429);
    }
  };
  try {
    const first = await resolveAcademicPaper('W42', ctx);
    assert.ok(first.paper?.title === 'Recovered Paper' && !first.fromCache);
    assert.deepEqual(sleeps, [1000]);
    assert.equal((await resolveAcademicPaper('W42', { ...ctx, fetchFn: async () => { throw new Error('cache miss'); } })).fromCache, true);
    const sim = await exploreCitationGraph({ seeds: ['W42'], direction: 'similar' }, ctx);
    assert.ok(sim.degraded.includes('s2') && sim.nodes.some(n => n.id === 'W77'));
    setGraphCache(db, 'oa:id:W99', 'openalex', makeOa('W99', 'Stale Cached Paper', 2021, 55), 1000);
    db.prepare('UPDATE graph_cache SET fetchedAt=? WHERE cacheKey=?').run(Date.now() - 10_000, 'oa:id:W99');
    assert.equal(getGraphCache(db, 'oa:id:W99')?.stale, true);
    const staleSleeps: number[] = [];
    const degraded = await resolveAcademicPaper('W99', { withDb: (_, run) => run(db), fetchFn: async () => jsonRes({}, 429), sleepFn: async ms => { staleSleeps.push(ms); } });
    assert.ok(degraded.paper?.title === 'Stale Cached Paper' && degraded.fromCache && degraded.degraded.includes('openalex'));
    assert.deepEqual(staleSleeps, [250, 500]);
    const dateSleeps: number[] = [];
    await resolveAcademicPaper('W98', { withDb: (_, run) => run(db), fetchFn: async u => String(u).includes('openalex') ? jsonRes({}, 429, { 'retry-after': new Date(Date.now() + 2000).toUTCString() }) : jsonRes({}, 404), sleepFn: async ms => { dateSleeps.push(ms); } });
    assert.ok(dateSleeps.length === 2 && dateSleeps[0] >= 500 && dateSleeps[0] <= 2500);
    const ac = new AbortController(), t0 = Date.now();
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(() => resolveAcademicPaper('W55', { withDb: (_, run) => run(db), fetchFn: async () => jsonRes({}, 429, { 'retry-after': '5' }), signal: ac.signal }), err => err instanceof ServiceError && err.status === 499);
    assert.ok(Date.now() - t0 < 200);
    assert.equal((await resolveAcademicPaper('2309.06180', { withDb: (_, run) => run(db), fetchFn: async u => String(u).includes('export.arxiv.org') ? new Response('<feed><entry><id>http://arxiv.org/api/errors#bad</id><title>Error</title><author><name>arXiv api core</name></author></entry></feed>') : jsonRes({}, 404) })).paper, null);
    assert.deepEqual([readGraphPaperInput({ title: 'T', arxivId: '../bad', pmid: '12a' }).arxivId, readGraphPaperInput({ title: 'T', arxivId: 'arXiv:2309.06180v2', pmid: '33567185' }).arxivId, readGraphPaperInput({ title: 'T', pmid: '12a' }).pmid, readGraphPaperInput({ title: 'T', pmid: '33567185' }).pmid], [undefined, '2309.06180', undefined, '33567185']);
  } finally { db.close(); }
});

test('computeCitationMapLayout produces finite, bounded, non-overlapping SVG coordinates for 1..45 nodes', () => {
  for (const count of [1, 12, 45]) {
    const nodes: GraphNode[] = Array.from({ length: count }, (_, i) => ({
      id: `W${i}`, title: `Paper ${i}`, authors: ['A. Author'], firstAuthor: 'A. Author', lastAuthor: 'A. Author',
      year: 2018 + (i % 7), citationCount: (i + 1) * 40, source: 'openalex', isSeed: i === 0, direction: i === 0 ? 'seed' : 'earlier'
    }));
    const edges: GraphEdge[] = nodes.slice(1).map(n => ({ source: 'W0', target: n.id, kind: 'cites' }));
    for (const mode of ['timeline', 'network'] as const) {
      const laid = computeCitationMapLayout(nodes, edges, mode, 820, 520);
      assert.equal(laid.length, count);
      for (let i = 0; i < laid.length; i++) {
        const a = laid[i];
        assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 20 && a.x <= 800 && a.y >= 20 && a.y <= 500);
        for (let j = i + 1; j < laid.length; j++) assert.ok(Math.hypot(a.x - laid[j].x, a.y - laid[j].y) >= a.radius + laid[j].radius - 0.5, `${mode} overlap`);
      }
    }
  }
});

test('graph.savePaper deduplicates abstract saves, tags doc_meta, upgrades on oa-pdf, and keeps API keys private', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-graph-save-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), pdfBytes = await readFile(path.resolve('public/assets/pagedattention.pdf'));
  const readResource = async (url: unknown) => ({ url: new URL(String(url)), type: 'application/pdf', bytes: pdfBytes });
  const act = createServices({ root, library: new Library(root, readResource, id => store.deleteDocument(id)), store, readResource });
  const saved = await act('settings.save', { openAlexEmail: 'user@example.edu', openAlexApiKey: 'oa-secret', semanticScholarApiKey: 's2-secret', ncbiApiKey: 'ncbi-secret' });
  assert.ok(saved.settings.openAlexEmail === 'user@example.edu' && saved.settings.hasOpenAlexApiKey && saved.settings.hasSemanticScholarApiKey && saved.settings.hasNcbiApiKey && !JSON.stringify(saved).includes('oa-secret'));
  const paper: GraphPaper = {
    id: 'W3127371223', title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity', authors: ['John Wilding'], firstAuthor: 'John Wilding', lastAuthor: 'John Wilding',
    year: 2021, venue: 'NEJM', doi: '10.1056/NEJMoa2032183', abstract: 'Semaglutide reduced body weight.', oaPdfUrl: 'https://example.org/p.pdf', source: 'openalex'
  };
  const first = await act('graph.savePaper', { paper, mode: 'abstract', topicTag: 'glp-1' });
  const second = await act('graph.savePaper', { paper, mode: 'abstract', topicTag: 'clinical' });
  assert.ok(first.doc.id === second.doc.id && first.doc.kind === 'abstract');
  assert.deepEqual(second.doc.meta?.tags, ['glp-1', 'clinical']);
  const upgraded = await act('graph.savePaper', { paper, mode: 'oa-pdf', topicTag: 'glp-1' });
  assert.ok(upgraded.doc.id === first.doc.id && upgraded.doc.kind === 'pdf' && upgraded.upgraded === true);
});

test('buildCitationGraphEdges creates direct DAG edges, bibliographic coupling/co-citation edges, and fallback only for orphans', () => {
  const mkNode = (id: string, isSeed = false): GraphNode => ({
    id, openAlexId: id.startsWith('W') ? id : undefined, title: `Paper ${id}`, authors: ['A'], firstAuthor: 'A', lastAuthor: 'A',
    year: 2023, citationCount: 50, source: 'openalex', isSeed
  });
  const nodes = [mkNode('W1', true), mkNode('W2'), mkNode('W3'), mkNode('W4'), mkNode('W5'), mkNode('ISO')];
  const refs = new Map<string, string[]>([
    ['W1', ['W2', 'W3']],
    ['W2', ['W3', 'EXT1', 'EXT2', 'EXT3']],
    ['W4', ['W2', 'W3', 'EXT1', 'EXT2', 'EXT3']],
    ['W5', ['EXT1', 'EXT2', 'EXT3']]
  ]);
  const related = new Map<string, string[]>();
  const fallbacks: GraphEdge[] = [
    { source: 'W1', target: 'W5', kind: 'related' },
    { source: 'W1', target: 'ISO', kind: 'related' }
  ];
  const edges = buildCitationGraphEdges(nodes, refs, related, fallbacks);
  assert.ok(edges.some(e => e.source === 'W2' && e.target === 'W3' && e.kind === 'cites' && e.weight === 1));
  assert.ok(edges.some(e => e.source === 'W4' && e.target === 'W2' && e.kind === 'cites'));
  const coupling = edges.find(e => e.kind === 'related' && ((e.source === 'W2' && e.target === 'W5') || (e.source === 'W5' && e.target === 'W2')));
  assert.ok(coupling && typeof coupling.weight === 'number' && coupling.weight > 0.2);
  assert.ok(edges.some(e => e.source === 'W1' && e.target === 'ISO' && e.kind === 'related'));
  assert.equal(edges.some(e => e.source === 'W1' && e.target === 'W5'), false);
});

test('exploreCitationGraph returns inter-paper citation edges in later mode and enriches S2 similar via one OA DOI batch', async () => {
  const db = new DatabaseSync(':memory:');
  ensureResearchSchema(db);
  let doiBatchCalls = 0;
  const fetchFn: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('/works/W10?')) return jsonRes(makeOa('W10', 'Seed 10', 2022, 500, [], { doi: 'https://doi.org/10.1000/s10' }));
    if (url.includes('filter=cites')) {
      return jsonRes({ results: [makeOa('W11', 'Citing 11', 2023, 200, ['W10']), makeOa('W12', 'Citing 12', 2024, 150, ['W10', 'W11'])] });
    }
    if (url.includes('recommendations/v1/papers')) {
      return jsonRes({
        recommendedPapers: [
          { paperId: 'S2A', title: 'S2 Paper A', year: 2023, citationCount: 90, externalIds: { DOI: '10.1000/a' }, authors: [{ name: 'A' }] },
          { paperId: 'S2B', title: 'S2 Paper B', year: 2024, citationCount: 60, externalIds: { DOI: '10.1000/b' }, authors: [{ name: 'B' }] }
        ]
      });
    }
    if (url.includes('filter=doi')) {
      doiBatchCalls++;
      return jsonRes({
        results: [
          makeOa('W201', 'S2 Paper A', 2023, 90, [], { doi: 'https://doi.org/10.1000/a' }),
          makeOa('W202', 'S2 Paper B', 2024, 60, ['W201'], { doi: 'https://doi.org/10.1000/b' })
        ]
      });
    }
    return jsonRes({ results: [] });
  };
  try {
    const later = await exploreCitationGraph({ seeds: ['W10'], direction: 'later', limit: 25 }, { withDb: (_, run) => run(db), fetchFn });
    assert.ok(later.edges.some(e => e.source === 'W12' && e.target === 'W11' && e.kind === 'cites'));
    const sim = await exploreCitationGraph({ seeds: ['W10'], direction: 'similar', limit: 25 }, { withDb: (_, run) => run(db), fetchFn });
    assert.equal(doiBatchCalls, 1);
    assert.ok(sim.edges.some(e => e.source === 'S2B' && e.target === 'S2A' && e.kind === 'cites'));
  } finally { db.close(); }
});

test('computeCitationMapLayout timeline mode orders Y by log10(citations + 1) with high-cited papers higher', () => {
  const mk = (id: string, citationCount: number): GraphNode => ({
    id, title: id, authors: ['A'], firstAuthor: 'A', lastAuthor: 'A', year: 2023, citationCount, source: 'openalex'
  });
  const nodes = [mk('tiny', 5), mk('low', 100), mk('mid', 1000), mk('high', 10000)];
  const laid = computeCitationMapLayout(nodes, [], 'timeline', 800, 480);
  const byId = new Map(laid.map(n => [n.id, n]));
  assert.ok(byId.get('high')!.y < byId.get('mid')!.y);
  assert.ok(byId.get('mid')!.y < byId.get('low')!.y);
  assert.ok(byId.get('low')!.y < byId.get('tiny')!.y);
  assert.deepEqual(timelineCitationScale(nodes).ticks, [0, 10, 100, 1000, 10000]);
});
