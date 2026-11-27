import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  computeCellYoyGrowth, computeCitationHeat, computeTrendGrowth, filterTrendTopics, sortTrendTopics, type TrendTopicRow
} from '../src/shared/research-types.js';
import { buildTrendChartModel, computeYScale, formatChartValue } from '../src/reader/research/field-trends-chart.js';
import { matchLocalDocsForTopic, queryFieldTrends, queryTrendPapers, type TrendContext } from '../src/server/field-trends.js';
import { Library } from '../src/server/library.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { ensureResearchSchema, setGraphCache } from '../src/server/research-store.js';
import { ServiceError } from '../src/server/service-types.js';
import { createServices } from '../src/server/services.js';

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Field Trends pure math: exact Growth (excluding YTD), YoY, Citation Heat, sorting, and blindSpotsOnly', () => {
  const g1 = computeTrendGrowth({ 2022: 10, 2023: 15, 2024: 40, 2025: 60, 2026: 1 }, 2026);
  assert.deepEqual(g1, { recent2yr: 100, prior2yr: 25, growth: (100 - 25) / 25, lowBase: false });
  const gLow = computeTrendGrowth(new Map([[2022, 2], [2023, 7], [2024, 30], [2025, 50], [2026, 0]]), 2026);
  assert.deepEqual(gLow, { recent2yr: 80, prior2yr: 9, growth: (80 - 9) / 9, lowBase: true });
  const gZero = computeTrendGrowth({ 2024: 5, 2025: 3 }, 2026);
  assert.deepEqual(gZero, { recent2yr: 8, prior2yr: 0, growth: 8, lowBase: true });
  assert.equal(computeTrendGrowth({ 2022: 5, 2023: 5, 2024: 20, 2025: 20 }, 2026).lowBase, false);

  assert.deepEqual(computeCellYoyGrowth(25, 10, false), { yoyGrowth: 1.5, lowBase: false });
  assert.deepEqual(computeCellYoyGrowth(8, 2, false), { yoyGrowth: 3, lowBase: true });
  assert.deepEqual(computeCellYoyGrowth(4, 100, true), { yoyGrowth: null, lowBase: false });
  assert.equal(computeCitationHeat(105, 4), 26.3);
  assert.equal(computeCitationHeat(0, 5), 0);
  assert.equal(computeCitationHeat(50, 0), 0);

  const row = (id: string, totalVolume: number, growth: number, lowBase: boolean, citationHeat: number, localCount: number): TrendTopicRow => ({
    topicId: id, topicName: id, totalVolume, recent2yr: 0, prior2yr: lowBase ? 2 : 20, growth, lowBase, citationHeat, localCount, localDocIds: [], cells: []
  });
  const rows = [row('T1', 500, 1.5, false, 80, 2), row('T2', 200, 9.0, true, 120, 0), row('T3', 300, 2.5, false, 40, 0), row('T4', 900, 0.5, false, 60, 1)];
  assert.deepEqual(sortTrendTopics(rows, 'fastest_growing').map(r => r.topicId), ['T3', 'T1', 'T4', 'T2']);
  assert.deepEqual(sortTrendTopics(rows, 'hottest', 'volume').map(r => r.topicId), ['T4', 'T1', 'T3', 'T2']);
  assert.deepEqual(sortTrendTopics(rows, 'hottest', 'citations').map(r => r.topicId), ['T2', 'T1', 'T4', 'T3']);
  assert.deepEqual(sortTrendTopics(rows, 'blind_spots_first', 'growth').map(r => r.topicId), ['T3', 'T2', 'T4', 'T1']);
  assert.deepEqual(sortTrendTopics(rows, 'blind_spots_first', 'citations').map(r => r.topicId), ['T2', 'T3', 'T4', 'T1']);
  assert.deepEqual(filterTrendTopics(rows, true).map(r => r.topicId), ['T2', 'T3']);
  assert.equal(filterTrendTopics(rows, false).length, 4);
});

test('queryFieldTrends parses OpenAlex/Europe PMC, caches in graph_cache, falls back on 429/offline, and honors AbortSignal', async () => {
  const db = new DatabaseSync(':memory:');
  ensureResearchSchema(db);
  const fetchFn: typeof fetch = async input => {
    const url = new URL(String(input)), f = url.searchParams.get('filter') ?? '', gb = url.searchParams.get('group_by') ?? '';
    if (url.hostname === 'api.openalex.org') {
      if (gb === 'primary_topic.id') return jsonRes({ group_by: [
        { key: 'unknown', key_display_name: 'unknown', count: 999 },
        { key: 'https://openalex.org/T10028', key_display_name: 'Topic Modeling', count: 145 },
        { key: 'https://openalex.org/T11714', key_display_name: 'Multimodal Learning', count: 38 }
      ] });
      if (gb === 'publication_year' && f.includes('T10028')) return jsonRes({ group_by: [
        { key: '2022', count: 10 }, { key: '2023', count: 15 }, { key: '2024', count: 40 }, { key: '2025', count: 60 }, { key: '2026', count: 20 }
      ] });
      if (gb === 'publication_year' && f.includes('T11714')) return jsonRes({ group_by: [
        { key: '2022', count: 2 }, { key: '2023', count: 3 }, { key: '2024', count: 10 }, { key: '2025', count: 18 }, { key: '2026', count: 5 }
      ] });
      if (f.includes('T10028')) return jsonRes({ results: [{ publication_year: 2024, cited_by_count: 100 }, { publication_year: 2025, cited_by_count: 200 }] });
      if (f.includes('T11714')) return jsonRes({ results: [{ publication_year: 2025, cited_by_count: 40 }] });
    }
    if (url.hostname === 'www.ebi.ac.uk') {
      const q = url.searchParams.get('query') ?? '', hits: Record<string, number> = { 2022: 12, 2023: 18, 2024: 45, 2025: 75, 2026: 30 };
      if (url.searchParams.get('resultType') === 'core') return jsonRes({ resultList: { result: [{ meshHeadingList: { meshHeading: [{ descriptorName: 'Humans' }, { descriptorName: 'Glucagon-Like Peptide-1 Receptor' }] } }] } });
      const ym = /PUB_YEAR:(\d{4})/.exec(q)?.[1];
      return ym && hits[ym] !== undefined ? jsonRes({ hitCount: hits[ym] }) : jsonRes({ resultList: { result: [{ pubYear: '2025', citedByCount: 90 }, { pubYear: '2024', citedByCount: 30 }] } });
    }
    return jsonRes({}, 404);
  };
  const ctx: TrendContext = { withDb: (_, run) => run(db), fetchFn, nowYear: 2026 };
  try {
    const res = await queryFieldTrends({ query: 'LLM inference', source: 'openalex', windowYears: 3, sort: 'fastest_growing' }, ctx);
    assert.deepEqual(res.years, [2024, 2025, 2026]);
    assert.ok(res.ytdYear === 2026 && !res.fromCache && res.topics.length === 2);
    const t1 = res.topics[0];
    assert.ok(t1.topicId === 'T10028' && t1.totalVolume === 120 && t1.growth === (100 - 25) / 25 && !t1.lowBase && t1.citationHeat === 150);
    assert.deepEqual(t1.cells.map(c => [c.year, c.volume, c.isYtd]), [[2024, 40, false], [2025, 60, false], [2026, 20, true]]);
    assert.ok(t1.cells[2].yoyGrowth === null && res.topics[1].lowBase);

    const hit = await queryFieldTrends({ query: 'LLM inference', source: 'openalex', windowYears: 3 }, { ...ctx, fetchFn: async () => { throw new Error('offline'); } });
    assert.ok(hit.fromCache && typeof hit.cachedAt === 'number' && hit.cachedAt > 0 && hit.topics[0].totalVolume === 120);

    const staleAt = Date.now() - 86_400_000;
    db.prepare('UPDATE graph_cache SET fetchedAt=?, ttlMs=1000').run(staleAt);
    const offline = await queryFieldTrends({ query: 'LLM inference', source: 'openalex', windowYears: 3 }, { ...ctx, fetchFn: async () => jsonRes({}, 429), sleepFn: async () => {} });
    assert.ok(offline.fromCache && offline.cachedAt === staleAt && offline.degraded.includes('openalex'));

    const epmc = await queryFieldTrends({ query: 'GLP-1', source: 'europepmc', windowYears: 5 }, ctx);
    assert.ok(epmc.topics[0].topicName === 'Glucagon-Like Peptide-1 Receptor' && epmc.topics[0].totalVolume === 180 && epmc.topics[0].growth === (120 - 30) / 30 && epmc.topics[0].citationHeat === 60);

    const mixed = await queryFieldTrends({ query: 'GLP-1', source: 'all', windowYears: 5 }, {
      ...ctx, fetchFn: async u => String(u).includes('ebi.ac.uk') ? jsonRes({}, 503) : fetchFn(u), sleepFn: async () => {}
    });
    assert.ok(mixed.topics.length >= 2 && mixed.degraded.includes('europepmc'));

    const ac = new AbortController();
    ac.abort();
    setGraphCache(db, 'oa:trends:topics:abortcheck:2022-2026', 'openalex', { group_by: [{ key: 'https://openalex.org/T1', key_display_name: 'A', count: 5 }] }, 60_000);
    await assert.rejects(() => queryFieldTrends({ query: 'abortcheck', windowYears: 5 }, { ...ctx, signal: ac.signal }), e => e instanceof ServiceError && e.status === 499);
    setGraphCache(db, 'oa:trends:topics:abortempty:2022-2026', 'openalex', { group_by: [] }, 60_000);
    await assert.rejects(() => queryFieldTrends({ query: 'abortempty', windowYears: 5 }, { ...ctx, fetchFn: async () => { throw new Error('must not fetch'); }, signal: ac.signal }), e => e instanceof ServiceError && e.status === 499);

    setGraphCache(db, 'oa:trends:topics:partialfail:2024-2026', 'openalex', { group_by: [{ key: 'https://openalex.org/T10028', key_display_name: 'Topic Modeling', count: 145 }, { key: 'https://openalex.org/T11714', key_display_name: 'Multimodal Learning', count: 38 }] }, 60_000);
    const partialCtx: TrendContext = { ...ctx, sleepFn: async () => {}, fetchFn: async u => String(u).includes('T11714') ? jsonRes({}, 500) : fetchFn(u) };
    await queryFieldTrends({ query: 'partialfail', source: 'openalex', windowYears: 3 }, partialCtx);
    const partial = await queryFieldTrends({ query: 'partialfail', source: 'openalex', windowYears: 3 }, partialCtx);
    assert.deepEqual(partial.topics.map(r => r.topicId), ['T10028']);
    assert.ok(!partial.fromCache && partial.degraded.includes('openalex'));
  } finally { db.close(); }
});

test('trends.query local coverage matches doc_meta live on add/tag/delete, and trends.papers enforces cell invariants & validation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-trends-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root);
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input)), f = url.searchParams.get('filter') ?? '', gb = url.searchParams.get('group_by') ?? '';
    if (gb === 'primary_topic.id') return jsonRes({ group_by: [{ key: 'https://openalex.org/T10028', key_display_name: 'Quantized Inference', count: 50 }] });
    if (gb === 'publication_year') return jsonRes({ group_by: [{ key: '2022', count: 5 }, { key: '2023', count: 5 }, { key: '2024', count: 20 }, { key: '2025', count: 20 }] });
    if (f.includes('publication_year:2025') && !gb && url.searchParams.get('select')?.includes('title')) {
      return jsonRes({ results: [
        { id: 'https://openalex.org/W10', title: 'Matched Quantized Paper', publication_year: 2025, cited_by_count: 88, doi: 'https://doi.org/10.1000/q1',
          authorships: [{ author: { display_name: 'Jane Doe' } }], best_oa_location: { pdf_url: 'https://arxiv.org/pdf/2501.00001.pdf' },
          primary_topic: { id: 'https://openalex.org/T10028', display_name: 'Quantized Inference' } },
        { id: 'https://openalex.org/W11', title: 'Wrong Year Paper', publication_year: 2024, cited_by_count: 99, primary_topic: { id: 'https://openalex.org/T10028', display_name: 'Quantized Inference' } },
        { id: 'https://openalex.org/W12', title: 'Wrong Topic Paper', publication_year: 2025, cited_by_count: 99, primary_topic: { id: 'https://openalex.org/T99999', display_name: 'Other' } }
      ] });
    }
    return jsonRes({ results: [{ publication_year: 2025, cited_by_count: 88 }] });
  };
  const act = createServices({ root, library: new Library(root, undefined, id => store.deleteDocument(id)), store, fetchImpl });

  assert.equal((await act('trends.query', { query: 'quantization', windowYears: 5 })).topics[0].localCount, 0);
  const { doc } = await act('library.createAbstract', { title: 'Matched Quantized Paper', year: '2025', doi: '10.1000/q1', authors: 'Jane Doe', abstract: 'Fast serving study.' });
  await act('library.triage', { docId: doc.id, tags: ['T10028'] });
  const afterTag = await act('trends.query', { query: 'quantization', windowYears: 5 });
  assert.deepEqual(afterTag.topics[0].localDocIds, [doc.id]);
  assert.equal(afterTag.topics[0].localCount, 1);

  const drill = await act('trends.papers', { query: 'quantization', topicId: 'T10028', topicName: 'Quantized Inference', year: 2025, sort: 'representative' });
  assert.equal(drill.papers.length, 1);
  assert.ok(drill.papers[0].year === 2025 && drill.papers[0].primaryTopicId === 'T10028' && drill.papers[0].inLibrary && drill.papers[0].localDocId === doc.id && drill.papers[0].oaPdfUrl === 'https://arxiv.org/pdf/2501.00001.pdf');

  const libDrill = await act('trends.papers', { query: 'quantization', topicId: 'T10028', topicName: 'Quantized Inference', year: 2025, sort: 'library' });
  assert.deepEqual(libDrill.papers.map(p => p.localDocId), [doc.id]);

  await act('library.triage', { docId: doc.id, tags: [] });
  assert.equal((await act('trends.query', { query: 'quantization', windowYears: 5 })).topics[0].localCount, 0);
  await act('library.triage', { docId: doc.id, tags: ['Quantized Inference'] });
  assert.equal((await act('trends.query', { query: 'quantization', windowYears: 5 })).topics[0].localCount, 1);
  await act('library.delete', { id: doc.id });
  assert.equal((await act('trends.query', { query: 'quantization', windowYears: 5 })).topics[0].localCount, 0);
  assert.deepEqual(matchLocalDocsForTopic('T1', 'Topic Modeling', [{ id: 'd1', kind: 'abstract', title: 'Unrelated', meta: { status: 'unread', starred: false, tags: ['mod'] } }]), []);
  assert.deepEqual(matchLocalDocsForTopic('epmc:all', 'GLP-1 (Europe PMC / PubMed)', [{ id: 'd1', kind: 'abstract', title: 'Semaglutide GLP-1 Trial' }, { id: 'd2', kind: 'pdf', title: 'Unrelated Study' }], new Map([['d2', 'Europe PMC / PubMed Central']])), ['d1']);
  assert.deepEqual(matchLocalDocsForTopic('T1', 'Models for Language and Vision', [{ id: 'd3', kind: 'abstract', title: 'Unrelated', meta: { status: 'unread', starred: false, tags: ['for', 'and'] } }]), []);

  const db = new DatabaseSync(':memory:');
  ensureResearchSchema(db);
  try {
    let seenEpmcQ = '';
    const epmcDrill = await queryTrendPapers({ query: 'cancer) OR (PUB_YEAR:2020', topicId: 'epmc:mesh:obesity', topicName: 'Obesity\\', year: 2024, source: 'europepmc', sort: 'newest' }, {
      withDb: (_, run) => run(db),
      fetchFn: async u => { seenEpmcQ = new URL(String(u)).searchParams.get('query') ?? ''; return jsonRes({ resultList: { result: [{ pmid: '12345', title: 'GLP-1 Trial', pubYear: '2024', citedByCount: 15 }, { pmid: '12346', title: 'Old Trial', pubYear: '2021', citedByCount: 50 }] } }); }
    });
    assert.equal(seenEpmcQ, '(cancer or PUB_YEAR 2020) AND MESH:"Obesity" AND PUB_YEAR:2024');
    assert.ok(epmcDrill.papers.length === 1 && epmcDrill.papers[0].year === 2024 && epmcDrill.papers[0].primaryTopicId === 'epmc:mesh:obesity');
    const epmcLib = await queryTrendPapers({ query: 'GLP-1', topicId: 'epmc:all', topicName: 'GLP-1 (Europe PMC / PubMed)', year: 2024, source: 'europepmc', sort: 'library' }, {
      withDb: (_, run) => run(db), docs: [{ id: 'd1', kind: 'abstract', title: 'Semaglutide GLP-1 Trial', year: '2024' }]
    });
    assert.ok(epmcLib.papers.length === 1 && epmcLib.papers[0].source === 'europepmc');
    await assert.rejects(() => queryTrendPapers({ query: 'GLP-1', topicId: 'epmc:mesh:', year: 2024, source: 'europepmc' }, { withDb: (_, run) => run(db) }), e => e instanceof ServiceError && e.status === 400);
    await assert.rejects(() => queryTrendPapers({ query: 'GLP-1', topicId: 'bad-id', year: 2024, source: 'europepmc' }, { withDb: (_, run) => run(db) }), e => e instanceof ServiceError && e.status === 400);
  } finally { db.close(); }

  await assert.rejects(() => act('trends.query', { query: 'x', windowYears: 4 as 5 }), e => e instanceof ServiceError && e.status === 400);
  await assert.rejects(() => act('trends.papers', { query: 'x', topicId: 'T1', year: 1800 }), e => e instanceof ServiceError && e.status === 400);
});

test('Field Trends chart model: top-6 slicing, YTD dashed split, growth null-YTD + negative baseline, Y-scale & edge cases', () => {
  const mkRow = (id: string, vols: number[], yoys: (number | null)[], heats: number[]): TrendTopicRow => ({
    topicId: id, topicName: `Topic ${id}`, totalVolume: vols.reduce((a, b) => a + b, 0),
    recent2yr: 50, prior2yr: 25, growth: 1, lowBase: false, citationHeat: heats[0] ?? 0, localCount: 0, localDocIds: [],
    cells: [2023, 2024, 2025, 2026].slice(0, vols.length).map((year, i) => ({
      year, volume: vols[i], isYtd: year === 2026, yoyGrowth: yoys[i] ?? null, lowBase: i === 0, citations: (heats[i] ?? 0) * 10, citationHeat: heats[i] ?? 0
    }))
  });
  const eight = Array.from({ length: 8 }, (_, i) => mkRow(`T${i}`, [10 + i, 20 + i, 40 + i, 15 + i], [null, 0.5, 1.0, null], [5, 12, 35, 8]));
  const volModel = buildTrendChartModel(eight, [2023, 2024, 2025, 2026], 2026, 'volume');
  assert.equal(volModel.series.length, 6);
  assert.equal(volModel.series[0].points.length, 4);
  assert.ok(volModel.series[0].solidPath.startsWith('M ') && volModel.series[0].ytdPath.startsWith('M ') && volModel.series[0].areaPath.endsWith(' Z'));
  assert.equal(volModel.series[0].solidPath.split(' L ').length, 3);
  assert.equal(volModel.series[0].ytdPath.split(' L ').length, 2);
  assert.equal(volModel.yScale.min, 0);
  assert.ok(volModel.yScale.max >= 47 && !volModel.yScale.zeroLine);

  const citeModel = buildTrendChartModel(eight.slice(0, 2), [2023, 2024, 2025, 2026], 2026, 'citations');
  assert.ok(citeModel.series[0].ytdPath.startsWith('M ') && citeModel.yScale.max >= 35);
  assert.equal(formatChartValue(1500, 'volume'), '1.5k');
  assert.equal(formatChartValue(4.2, 'citations'), '4.2');
  assert.equal(formatChartValue(null, 'growth', true), 'YTD*');
  assert.equal(formatChartValue(0.25, 'growth', false, true), '+25%°');

  const negRows = [mkRow('NEG', [100, 75, 120, 30], [0.1, -0.25, 0.6, null], [20, 15, 30, 5])];
  const growthModel = buildTrendChartModel(negRows, [2023, 2024, 2025, 2026], 2026, 'growth');
  assert.equal(growthModel.series[0].points.length, 3);
  assert.equal(growthModel.series[0].ytdPath, '');
  assert.ok(growthModel.yScale.zeroLine && growthModel.yScale.min < 0 && growthModel.yScale.max > 0);
  assert.ok(growthModel.yScale.ticks.some(tk => tk.value === 0 && tk.label === '0%'));

  const hiddenRescale = buildTrendChartModel(
    [mkRow('BIG', [1000, 2000], [null, 1], [100, 200]), mkRow('SMALL', [10, 20], [null, 1], [1, 2])],
    [2023, 2024], 2026, 'volume', { hiddenIds: new Set(['BIG']) }
  );
  assert.ok(hiddenRescale.yScale.max <= 40 && hiddenRescale.series[0].hidden && !hiddenRescale.series[1].hidden);

  const emptyModel = buildTrendChartModel([], [], 2026, 'volume');
  assert.deepEqual(emptyModel.series, []);
  assert.deepEqual(emptyModel.yearXs, []);
  const oneYr = buildTrendChartModel([mkRow('ONE', [Number.NaN], [Number.NaN], [Number.NaN])], [2023], 2026, 'volume');
  assert.equal(oneYr.yearXs.length, 1);
  assert.ok(Number.isFinite(oneYr.yearXs[0]) && Number.isFinite(oneYr.series[0].points[0].y));
  assert.deepEqual(computeYScale(Number.NaN, Number.NaN, 'growth'), { min: 0, max: 1, ticks: [0, 0.5, 1], zeroLine: false });
});
