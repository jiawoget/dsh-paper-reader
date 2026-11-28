import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  computeClusterHulls, computeShortestPathToSeed, detectCitationClusters, edgePairKey, extractClusterLabel, selectBackboneEdges
} from '../src/shared/graph-clusters.js';
import { buildCitationGraphEdges, computeCitationMapLayout, rankEarlierByCoCitation, reconstructInvertedAbstract, timelineCitationScale } from '../src/shared/graph-layout.js';
import { filterLibraryPapers, PAPER_PICKER_VISIBLE_CAP } from '../src/reader/research/paper-picker.js';
import type { DocumentInfo, GraphEdge, GraphNode, GraphPaper } from '../src/shared/types.js';
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
  const mk = (id: string, citationCount: number, year = 2023): GraphNode => ({
    id, title: id, authors: ['A'], firstAuthor: 'A', lastAuthor: 'A', year, citationCount, source: 'openalex'
  });
  const nodes = [mk('tiny', 5), mk('low', 100), mk('mid', 1000), mk('high', 10000)];
  const laid = computeCitationMapLayout(nodes, [], 'timeline', 800, 480);
  const byId = new Map(laid.map(n => [n.id, n]));
  assert.ok(byId.get('high')!.y < byId.get('mid')!.y);
  assert.ok(byId.get('mid')!.y < byId.get('low')!.y);
  assert.ok(byId.get('low')!.y < byId.get('tiny')!.y);
  assert.deepEqual(timelineCitationScale(nodes).ticks, [0, 10, 100, 1000, 10000]);
  assert.deepEqual(timelineCitationScale([mk('nan', Number.NaN), mk('inf', Number.POSITIVE_INFINITY)]), { maxLog: 1, ticks: [0, 10] });
  const cohort = [mk('top30k', 30488, 2024), ...Array.from({ length: 19 }, (_, i) => mk(`c${i}`, 800 + i * 120, 2024)), mk('other23', 1200, 2023), mk('other25', 900, 2025)];
  const padY = Math.min(44, Math.max(24, 446 * 0.08)), spanY = 446 - padY * 2, { maxLog } = timelineCitationScale(cohort);
  const yOf = (c: number) => padY + (1 - Math.log10(c + 1) / maxLog) * spanY;
  const placed = computeCitationMapLayout(cohort, [], 'timeline', 760, 446), pMap = new Map(placed.map(n => [n.id, n]));
  for (const n of placed) assert.ok(Math.abs(n.y - yOf(n.citationCount ?? 0)) <= 16, `${n.id} drifted: ${n.y} vs ${yOf(n.citationCount ?? 0)}`);
  assert.ok(pMap.get('top30k')!.y > yOf(100_000) && pMap.get('top30k')!.y < yOf(10_000) && pMap.get('c0')!.y < yOf(100));
});

test('graph.savePaper mode=auto handles arXiv HTML/PDF/404-fallback, OA PDF, DOI lookup, and paywall abstract fallback', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-smart-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), pdfBytes = await readFile(path.resolve('public/assets/pagedattention.pdf')), fetched: string[] = [];
  const readResource = async (raw: unknown) => {
    const url = new URL(String(raw));
    fetched.push(url.href);
    if (url.pathname === '/html/2606.06523v3' || url.pathname === '/html/2606.06524v2' || url.pathname === '/html/2501.00001') {
      return { url, type: 'text/html', bytes: Buffer.from('<!doctype html><html><head><title>Lean4Agent</title></head><body><article><h1>Lean4Agent</h1><p>Full arXiv HTML body text.</p></article></body></html>') };
    }
    if (url.pathname === '/pdf/2606.06523v3.pdf' || url.pathname === '/pdf/2309.06180.pdf' || url.pathname === '/open.pdf' || url.pathname === '/oa-discovered.pdf') {
      return { url, type: 'application/pdf', bytes: pdfBytes };
    }
    if (url.hostname === 'api.openalex.org' && url.pathname.includes('10.1000%2Foa-doi')) {
      return { url, type: 'application/json', bytes: Buffer.from(JSON.stringify({ best_oa_location: { pdf_url: 'https://repo.example/oa-discovered.pdf' } })) };
    }
    if (url.pathname === '/10.1000/paywalled') {
      return { url, type: 'text/html', bytes: Buffer.from('<article><h1>Paywalled Paper</h1><p>Buy article or subscribe to read full text.</p></article>') };
    }
    throw Object.assign(new Error('HTTP 404'), { status: 502 });
  };
  const act = createServices({ root, library: new Library(root, readResource, id => store.deleteDocument(id)), store, readResource });

  assert.equal((await act('state')).settings.arxivFormat, 'html');
  await assert.rejects(act('settings.save', { arxivFormat: 'epub' }), { status: 400 });
  const prefPdf = await act('settings.save', { arxivFormat: 'pdf' });
  assert.equal(prefPdf.settings.arxivFormat, 'pdf');
  assert.equal((await act('state')).settings.arxivFormat, 'pdf');
  await act('settings.save', { arxivFormat: 'html' });

  const arxivPaper: GraphPaper = {
    id: 'W-AX1', title: 'Lean4Agent: Formal Modeling', authors: ['Jane Doe', 'John Roe'], firstAuthor: 'Jane Doe', lastAuthor: 'John Roe',
    year: 2026, venue: 'arXiv', arxivId: '2606.06523v3', oaPdfUrl: 'https://arxiv.org/pdf/2606.06523v3.pdf',
    url: 'https://arxiv.org/abs/2606.06523v3', abstract: 'Formal workflow verification.', source: 'arxiv'
  };
  const axHtml = await act('graph.savePaper', { paper: arxivPaper });
  assert.equal(axHtml.mode, 'oa-html'); assert.equal(axHtml.doc.kind, 'web'); assert.equal(axHtml.arxivFallback, undefined);
  assert.equal(axHtml.doc.authors, 'Jane Doe; John Roe'); assert.equal(axHtml.doc.year, '2026'); assert.equal(axHtml.doc.url, 'https://arxiv.org/html/2606.06523v3');

  const axPdf = await act('graph.savePaper', { paper: arxivPaper, arxivFormat: 'pdf' });
  assert.equal(axPdf.mode, 'oa-pdf'); assert.equal(axPdf.doc.kind, 'pdf'); assert.equal(axPdf.arxivFallback, undefined);

  const oldArxiv: GraphPaper = {
    id: 'W-AX2', title: 'Older Pre-LaTeXML Paper', authors: ['Woosuk Kwon'], firstAuthor: 'Woosuk Kwon', lastAuthor: 'Woosuk Kwon',
    year: 2023, arxivId: '2309.06180', oaPdfUrl: 'https://arxiv.org/pdf/2309.06180.pdf', source: 'openalex'
  };
  const axFallback = await act('graph.savePaper', { paper: oldArxiv });
  assert.equal(axFallback.mode, 'oa-pdf'); assert.equal(axFallback.doc.kind, 'pdf'); assert.equal(axFallback.arxivFallback, 'html-to-pdf');

  const directOa: GraphPaper = {
    id: 'W-OA1', title: 'Direct OA Full Text', authors: ['Ada Lovelace'], firstAuthor: 'Ada Lovelace', lastAuthor: 'Ada Lovelace',
    year: 2024, venue: 'ICML', oaPdfUrl: 'https://repo.example/open.pdf', source: 'openalex'
  };
  const oaRes = await act('graph.savePaper', { paper: directOa });
  assert.equal(oaRes.mode, 'oa-pdf'); assert.equal(oaRes.doc.kind, 'pdf'); assert.equal(oaRes.attachPdfSuggested, undefined);

  const doiOa: GraphPaper = {
    id: 'W-DOI1', title: 'DOI Discovered OA Paper', authors: ['Grace Hopper'], firstAuthor: 'Grace Hopper', lastAuthor: 'Grace Hopper',
    year: 2025, doi: '10.1000/oa-doi', source: 'openalex'
  };
  const doiRes = await act('graph.savePaper', { paper: doiOa });
  assert.equal(doiRes.mode, 'oa-pdf'); assert.equal(doiRes.doc.kind, 'pdf'); assert.equal(doiRes.attachPdfSuggested, undefined);

  const paywalled: GraphPaper = {
    id: 'W-PAY1', title: 'Paywalled Journal Paper', authors: ['Alan Turing'], firstAuthor: 'Alan Turing', lastAuthor: 'Alan Turing',
    year: 2024, venue: 'Closed Journal', doi: '10.1000/paywalled', abstract: 'Closed-access study abstract.', source: 'openalex'
  };
  const payRes = await act('graph.savePaper', { paper: paywalled });
  assert.equal(payRes.mode, 'abstract'); assert.equal(payRes.doc.kind, 'abstract');
  assert.equal(payRes.fallback, 'abstract_only'); assert.equal(payRes.attachPdfSuggested, true);

  fetched.length = 0;
  const oaArxivUrlPaper: GraphPaper = {
    id: 'W-AX-OA', title: 'Venue Paper With arXiv OA PDF', authors: ['Linus Torvalds'], firstAuthor: 'Linus Torvalds', lastAuthor: 'Linus Torvalds',
    year: 2026, doi: '10.1145/3600006.3613165', url: 'https://dl.acm.org/doi/10.1145/3600006.3613165',
    oaPdfUrl: 'https://arxiv.org/pdf/2606.06524v2.pdf', source: 's2'
  };
  const oaArxivRes = await act('graph.savePaper', { paper: oaArxivUrlPaper });
  assert.equal(oaArxivRes.mode, 'oa-html'); assert.equal(oaArxivRes.doc.kind, 'web');
  assert.equal(oaArxivRes.doc.url, 'https://arxiv.org/html/2606.06524v2');
  assert.deepEqual(fetched, ['https://arxiv.org/html/2606.06524v2']);

  fetched.length = 0;
  const nonArxivVerPaper: GraphPaper = {
    id: 'W-AX-VER', title: 'Repo URL Ending In Version', authors: ['Ken Thompson'], firstAuthor: 'Ken Thompson', lastAuthor: 'Ken Thompson',
    year: 2025, arxivId: '2501.00001', url: 'https://github.com/org/model-v9', oaPdfUrl: 'https://arxiv.org/pdf/2501.00001.pdf', source: 'openalex'
  };
  const nonArxivVerRes = await act('graph.savePaper', { paper: nonArxivVerPaper });
  assert.equal(nonArxivVerRes.mode, 'oa-html'); assert.equal(nonArxivVerRes.doc.kind, 'web');
  assert.equal(nonArxivVerRes.doc.url, 'https://arxiv.org/html/2501.00001');
  assert.deepEqual(fetched, ['https://arxiv.org/html/2501.00001']);
});

test('citation clustering, labels, shortest path to seed, backbone edges, hulls, and 500-paper picker cap', () => {
  const mk = (id: string, title: string, citationCount: number, year: number, isSeed = false, topic?: string): GraphNode => ({
    id, title, authors: ['A. Researcher'], firstAuthor: 'A. Researcher', lastAuthor: 'A. Researcher', year, citationCount, source: 'openalex', isSeed, topic
  });
  const nodes: GraphNode[] = [
    mk('S0', 'PagedAttention KV Cache Serving', 4000, 2023, true, 'KV Cache Serving'), mk('A1', 'Paged KV Cache Block Allocation', 800, 2024, false, 'KV Cache Serving'),
    mk('A2', 'Prefix KV Cache Sharing Pools', 420, 2024, false, 'KV Cache Serving'), mk('A3', 'Distributed KV Cache Routing', 180, 2025, false, 'KV Cache Serving'),
    mk('B1', 'Speculative Decoding Draft Verification', 1200, 2023, false, 'Speculative Decoding'), mk('B2', 'Tree Speculative Decoding Acceleration', 520, 2024, false, 'Speculative Decoding'),
    mk('B3', 'Medusa Speculative Decoding Heads', 900, 2024, false, 'Speculative Decoding'), mk('B4', 'Parallel Speculative Decoding Trees', 110, 2025, false, 'Speculative Decoding'),
    mk('C1', 'Activation-Aware Weight Quantization', 2200, 2023, false, 'Weight Quantization'), mk('C2', 'SmoothQuant INT8 Weight Quantization', 1500, 2023, false, 'Weight Quantization'),
    mk('C3', 'Sub-bit Weight Quantization Kernels', 75, 2024, false, 'Weight Quantization'), mk('C4', 'Mixed Precision Weight Quantization', 12, 2025, false, 'Weight Quantization')
  ];
  const edges: GraphEdge[] = [
    { source: 'S0', target: 'A1', kind: 'cites', weight: 1 }, { source: 'A1', target: 'A2', kind: 'cites', weight: 1 }, { source: 'A2', target: 'A3', kind: 'related', weight: 0.85 },
    { source: 'A1', target: 'A3', kind: 'related', weight: 0.7 }, { source: 'S0', target: 'B1', kind: 'cites', weight: 1 }, { source: 'B1', target: 'B2', kind: 'cites', weight: 1 },
    { source: 'B2', target: 'B3', kind: 'related', weight: 0.9 }, { source: 'B3', target: 'B4', kind: 'related', weight: 0.8 }, { source: 'S0', target: 'C1', kind: 'cites', weight: 1 },
    { source: 'C1', target: 'C2', kind: 'cites', weight: 1 }, { source: 'C2', target: 'C3', kind: 'related', weight: 0.85 }, { source: 'C3', target: 'C4', kind: 'related', weight: 0.75 },
    { source: 'A3', target: 'B4', kind: 'related', weight: 0.2 }, { source: 'B4', target: 'C4', kind: 'related', weight: 0.18 }, { source: 'A1', target: 'C3', kind: 'related', weight: 0.16 }
  ];
  const c1 = detectCitationClusters(nodes, edges);
  assert.deepEqual(c1, detectCitationClusters([...nodes].reverse(), [...edges].reverse()));
  assert.ok(c1.length >= 3 && c1.length <= 5, `expected 3..5 clusters, got ${c1.length}`);
  for (const c of c1) assert.ok(c.label.trim().split(/\s+/).length >= 1 && c.label.trim().split(/\s+/).length <= 3, `bad label: ${c.label}`);
  assert.match(extractClusterLabel(nodes.slice(4, 8), nodes), /Speculative|Decoding/i);
  const tiny = detectCitationClusters(nodes.slice(0, 3), edges.slice(0, 2));
  assert.ok(tiny.length >= 1 && tiny.length <= 2);
  const path3 = computeShortestPathToSeed(nodes, edges, 'B4');
  assert.deepEqual([...path3.nodeIds].sort(), ['A1', 'A3', 'B4', 'S0']);
  assert.ok(path3.edgeKeys.size === 3 && path3.edgeKeys.has(edgePairKey('S0', 'A1')) && path3.edgeKeys.has(edgePairKey('A3', 'B4')));
  assert.deepEqual([...computeShortestPathToSeed([...nodes, mk('ISO', 'Isolated', 5, 2022)], edges, 'ISO').nodeIds], ['ISO']);
  const backbone = selectBackboneEdges(nodes, edges);
  assert.ok(backbone.has(edgePairKey('S0', 'A1')) && backbone.has(edgePairKey('B1', 'B2')) && !backbone.has(edgePairKey('A1', 'C3')));
  const placed = computeCitationMapLayout(nodes, edges, 'network', 760, 480, c1), hulls = computeClusterHulls(placed, c1, 760, 480);
  const radii = placed.filter(n => !n.isSeed).map(n => n.radius);
  assert.ok(hulls.length >= 3 && Math.max(...radii) - Math.min(...radii) >= 6 && Math.hypot(hulls[0].cx - hulls[1].cx, hulls[0].cy - hulls[1].cy) > 120);
  const docs: DocumentInfo[] = Array.from({ length: 520 }, (_, i) => ({
    id: `doc-${i}`, kind: 'pdf', title: i === 412 ? 'Quantum Attention Compression' : `Serving Paper ${i}`,
    authors: i === 412 ? 'Ada Lovelace' : `Author ${i}`, year: String(2018 + (i % 8)),
    meta: { status: 'unread', starred: false, tags: i === 412 ? ['quantization'] : ['serving'] }
  }));
  const all = filterLibraryPapers(docs, ''), hit = filterLibraryPapers(docs, 'quantum quantization');
  assert.ok(all.total === 520 && all.matched === 520 && all.items.length === PAPER_PICKER_VISIBLE_CAP && hit.matched === 1 && hit.items[0]?.id === 'doc-412');
  const enDash = [mk('E1', 'Vision--Language Pre--Training', 100, 2024, true), mk('E2', 'Self--Supervised End--to--End Vision--Language', 50, 2025)];
  assert.ok(detectCitationClusters(enDash, [{ source: 'E1', target: 'E2', kind: 'related', weight: Number.NaN }])[0]!.label.length <= 24);
  const cjk = [mk('Z1', '基于分层注意力机制的超大规模语言模型推理加速与显存压缩方法研究', 10, 2025), mk('Z2', '大语言模型推理加速与量化技术综述', 12, 2025)];
  const longEn = [mk('L1', 'Electroencephalography Representations Optimization', 10, 2025), mk('L2', 'Electroencephalography Representations Decoding', 12, 2025)];
  assert.ok(extractClusterLabel(cjk, cjk).length <= 24 && extractClusterLabel(longEn, longEn).length <= 24);
  const ph = computeShortestPathToSeed([mk('S', 'Seed', 10, 2023, true), mk('T', 'Target', 5, 2024)], [{ source: 'S', target: 'PHANTOM', kind: 'cites' }, { source: 'PHANTOM', target: 'T', kind: 'cites' }], 'T');
  assert.deepEqual([...ph.nodeIds], ['T']);
});
