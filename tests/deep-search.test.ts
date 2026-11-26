import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../src/server/index.js';
import { Library } from '../src/server/library.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { ensureResearchSchema, hasResearchSchema } from '../src/server/research-store.js';
import { createServices } from '../src/server/services.js';

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const statusIs = (code: number) => (e: unknown) => e instanceof Error && 'status' in e && (e as { status: number }).status === code;
const oaWork = (id: string, title: string, year: number, pubDate: string, doi: string, words: string[], refs: string[] = []) => ({
  id: `https://openalex.org/${id}`, title, publication_year: year, publication_date: pubDate, doi: `https://doi.org/${doi}`, cited_by_count: 40,
  authorships: [{ author: { display_name: 'Alice Researcher' } }], referenced_works: refs.map(r => `https://openalex.org/${r}`), related_works: [],
  abstract_inverted_index: Object.fromEntries(words.map((w, i) => [w, [i]]))
});
const makeHost = (reply: (sys: string, data: Record<string, unknown>, sig?: AbortSignal) => Promise<string> | string) => ({
  llm: { listProviders: () => [{ id: 'mock' }], listModels: async () => [{ id: 'mock-m', name: 'Mock', inputModalities: ['text'] }],
    stream: async function* (req: { system: string; messages: { content: { text?: string }[] }[]; signal: AbortSignal }) {
      yield { type: 'text-delta', text: await reply(req.system, JSON.parse(req.messages[0]?.content[0]?.text || '{}') as Record<string, unknown>, req.signal) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }
});

test('deep search holdout multi-round gain finds zero-keyword target B in round 2, supports clarify, degradation, abort, and NDJSON streaming', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-deep-search-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paperA = oaWork('W100', 'Mitigating memory fragmentation in autoregressive inference via block tables', 2023, '2023-09-12', '10.1000/pa', ['We', 'eliminate', 'memory', 'fragmentation', 'using', 'virtual', 'block', 'table', 'paging'], ['W200']);
  const paperB = oaWork('W200', 'Non-Contiguous Virtual Block Table Paging for Tensor Stores', 2024, '2024-03-01', '10.1000/pb', ['A', 'slab', 'allocator', 'using', 'virtual', 'block', 'table', 'paging', 'across', 'GPU', 'heaps']);
  const paperNoise = oaWork('W300', 'Unrelated agricultural soil moisture survey', 2022, '2022-05-01', '10.1000/pn', ['Seasonal', 'soil', 'moisture', 'data']);
  const userQuery = 'memory fragmentation in autoregressive inference', queryWords = new Set(['memory', 'fragmentation', 'autoregressive', 'inference']);
  assert.equal((paperB.title + ' ' + Object.keys(paperB.abstract_inverted_index).join(' ')).toLowerCase().split(/\W+/).some(w => queryWords.has(w)), false);

  let s2Fail = true, round2Called = false, clarifyBroken = false;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'api.semanticscholar.org') return s2Fail ? new Response('rate limit', { status: 429, headers: { 'retry-after': '0' } }) : jsonRes({ data: [], recommendedPapers: [] });
    if (url.hostname === 'www.ebi.ac.uk') return jsonRes({ resultList: { result: [] } });
    if (url.hostname === 'export.arxiv.org') return new Response('<feed></feed>', { status: 200 });
    if (url.hostname === 'api.openalex.org') {
      if (url.pathname === '/works/W100') return jsonRes(paperA);
      const filter = url.searchParams.get('filter') ?? '', search = (url.searchParams.get('search') ?? '').toLowerCase();
      if (filter.includes('openalex:W200') || search.includes('virtual block table')) { round2Called = true; return jsonRes({ results: [paperB] }); }
      if (filter.includes('cites:W100')) { round2Called = true; return jsonRes({ results: [] }); }
      return jsonRes({ results: [paperA, paperNoise] });
    }
    return new Response('', { status: 404 });
  };
  const ctx = makeHost((sys, data) => {
    if (sys.includes('clarifying questions')) return clarifyBroken ? 'not json' : JSON.stringify({ questions: [{ id: 'scope', question: 'Target hardware?', options: ['Single GPU', 'Cluster'] }, { id: 'window', question: 'Years?', options: ['2023+', 'All'] }] });
    if (sys.includes('Decompose')) return JSON.stringify({ queries: ['memory fragmentation autoregressive inference'], synonyms: ['kv cache allocation'] });
    if (sys.includes('Evaluate candidate')) {
      const papers = (data.papers as { id: string; title: string }[]) ?? [];
      return JSON.stringify({ scores: papers.map(p => p.title.includes('Non-Contiguous')
        ? { id: p.id, score: 91, rationale: 'Introduces virtual block table paging directly solving allocation waste.', category: 'Block Paging', terms: ['slab allocator'] }
        : p.title.includes('Mitigating') ? { id: p.id, score: 94, rationale: 'Addresses memory fragmentation in autoregressive decoding.', category: 'KV Allocation', terms: ['virtual block table'] }
        : { id: p.id, score: 10, rationale: 'Off-topic soil study.', category: 'Other', terms: [] }) });
    }
    if (sys.includes('fresh concise English')) { round2Called = true; return JSON.stringify({ queries: ['virtual block table paging'] }); }
    return 'Executive synthesis highlighting [#1] (Alice Researcher, 2023) and [#2] (Alice Researcher, 2024).';
  });

  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id)), act = createServices({ root, ctx, library, store, fetchImpl });
  await act('library.createAbstract', { title: paperA.title, doi: '10.1000/pa', abstract: 'Local abstract' });
  assert.equal((await act('deepSearch.clarify', { query: userQuery })).questions.length, 2);
  clarifyBroken = true;
  const zhFb = await act('deepSearch.clarify', { query: '大语言模型显存碎片优化' });
  assert.ok(zhFb.questions.length === 3 && /[\u4e00-\u9fff]/.test(zhFb.questions[0].question));

  const full = await act('deepSearch.run', { query: userQuery, answers: { scope: 'Single GPU' }, rounds: 2, maxResults: 10 });
  assert.equal(full.aborted, false); assert.equal(full.roundsCompleted, 2); assert.equal(full.saturationCurve.length, 2);
  assert.ok(full.degraded.includes('s2') && full.overview.includes('[#1]') && full.categories.length >= 2);
  const foundA = full.candidates.find(c => c.doi === '10.1000/pa'), foundB = full.candidates.find(c => c.doi === '10.1000/pb');
  assert.ok(foundA && foundA.foundRound === 1 && foundA.inLibrary === true && foundB && foundB.foundRound === 2 && foundB.matchScore >= 85 && foundB.rationale.length > 10);
  assert.equal(full.candidates.some(c => c.doi === '10.1000/pb' && c.foundRound === 1), false);

  s2Fail = false; round2Called = false;
  const ac = new AbortController(), events: Record<string, unknown>[] = [];
  const partial = await act('deepSearch.run', { query: userQuery, rounds: 3 }, {
    signal: ac.signal, onDelta: d => { const ev = JSON.parse(d) as Record<string, unknown>; events.push(ev); if (ev.round === 1 && ev.stage === 'score' && Number(ev.evaluatedCount) > 0) ac.abort(); }
  });
  assert.equal(partial.aborted, true); assert.equal(partial.roundsCompleted, 1); assert.equal(round2Called, false);
  assert.ok(partial.candidates.some(c => c.doi === '10.1000/pa') && !partial.candidates.some(c => c.doi === '10.1000/pb') && events.some(e => e.type === 'progress' && e.stage === 'score'));
  for (const bad of [{ query: '   ' }, { query: 'ok', rounds: 'bad' }, { query: 'ok', answers: 'bad' }])
    await assert.rejects(() => Promise.resolve(act('deepSearch.run', bad)), statusIs(400));

  const prevHome = process.env.PAPER_READER_HOME, prevFetch = globalThis.fetch; process.env.PAPER_READER_HOME = root; globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = prevFetch; if (prevHome === undefined) delete process.env.PAPER_READER_HOME; else process.env.PAPER_READER_HOME = prevHome; });
  const routes = new Map<string, (req: Request) => Promise<Response>>();
  apply({ connection: { fetch: { register: r => routes.set(r.path, r.fetch) } }, inject: (svcs, setup) => { if (svcs[0] === 'llm') setup({ llm: ctx.llm } as never); return () => {}; } });
  const ndRes = await routes.get('/api/paper-reader/action')!(new Request('http://dsh.internal/api/paper-reader/action', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ op: 'deepSearch.run', payload: { query: userQuery, rounds: 1 } }) }));
  const frames = (await ndRes.text()).trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  assert.ok(frames.some(f => f.type === 'progress') && frames.at(-1)?.type === 'result');
});

test('watchlist tracks topic and paper incrementally with zero LLM tokens, deduplicates cursor checks, and cascades on deleteDocument', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-watchlist-')); t.after(() => rm(root, { recursive: true, force: true }));
  const mem = new DatabaseSync(':memory:'); t.after(() => mem.close());
  for (const sql of ['CREATE TABLE doc_pages(docId TEXT, page INTEGER, text TEXT, updatedAt INTEGER)', 'CREATE VIRTUAL TABLE doc_pages_fts USING fts5(docId, page, text)', 'CREATE TABLE topics(id TEXT PRIMARY KEY)', 'CREATE TABLE graph_cache(cacheKey TEXT PRIMARY KEY)', 'CREATE TABLE paper_cards(doc_id TEXT PRIMARY KEY)', 'CREATE TABLE extraction_tables(id TEXT PRIMARY KEY)', 'CREATE TABLE extraction_cells(table_id TEXT, doc_id TEXT, col_id TEXT)']) mem.exec(sql);
  assert.equal(hasResearchSchema(mem), false); ensureResearchSchema(mem); assert.equal(hasResearchSchema(mem), true);

  let llmCalls = 0, phase = 1;
  const ctx = makeHost(() => { llmCalls++; throw new Error('Watchlist must never call LLM'); });
  const p1 = oaWork('W501', 'GLP-1 Trial Update One', 2025, '2025-01-10', '10.1000/w1', ['Semaglutide']), p2 = oaWork('W502', 'GLP-1 Trial Update Two', 2025, '2025-02-01', '10.1000/w2', ['Tirzepatide']);
  const cite1 = oaWork('W601', 'Follow-up Citing Seed Paper', 2025, '2025-01-15', '10.1000/c1', ['Followup'], ['W900']);
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'api.openalex.org') {
      const f = url.searchParams.get('filter') ?? '';
      if (url.pathname.includes('10.1000') || url.pathname === '/works/W900') return jsonRes(oaWork('W900', 'Seed Paper', 2024, '2024-01-01', '10.1000/seed', ['Seed']));
      if (f.includes('cites:W900')) return jsonRes({ results: [cite1] });
      return jsonRes({ results: phase === 1 ? [p1] : [p1, p2] });
    }
    return url.hostname === 'www.ebi.ac.uk' ? jsonRes({ resultList: { result: [] } }) : new Response('<feed></feed>', { status: 200 });
  };
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id)), act = createServices({ root, ctx, library, store, fetchImpl });
  const doc = (await act('library.createAbstract', { title: 'Seed Paper', doi: '10.1000/seed', abstract: 'Seed abstract' })).doc;
  const topicW = (await act('watchlist.save', { kind: 'topic', label: 'GLP-1 Watch', query: 'GLP-1 obesity', sources: ['openalex'], cursorDate: '2025-01-01' })).entry;
  const paperW = (await act('watchlist.save', { kind: 'paper', docId: doc.id, sources: ['openalex'], cursorDate: '2025-01-01' })).entry;
  assert.equal((await act('watchlist.list', {})).entries.length, 2);

  const chk1 = await act('watchlist.check', {});
  assert.equal(chk1.checkedCount, 2); assert.equal(chk1.newItemsCount, 2);
  const t1 = chk1.entries.find(e => e.id === topicW.id)!, pEntry1 = chk1.entries.find(e => e.id === paperW.id)!;
  assert.ok(t1.cursorDate === '2025-01-10' && t1.unread.length === 1 && t1.lastCheckedAt && pEntry1.workId === 'W900' && pEntry1.unread.length === 1);
  assert.equal((await act('watchlist.check', {})).newItemsCount, 0);

  phase = 2;
  const chk3 = await act('watchlist.check', { id: topicW.id });
  assert.equal(chk3.newItemsCount, 1); assert.equal(chk3.entries.find(e => e.id === topicW.id)?.cursorDate, '2025-02-01');
  assert.equal((await act('watchlist.markRead', { id: topicW.id })).entry.unread.length, 0); assert.equal(llmCalls, 0);

  await act('library.delete', { id: doc.id });
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true }); t.after(() => db.close());
  assert.equal(hasResearchSchema(db), true);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE doc_id=?').get(doc.id) as { n: number }).n), 0);
  assert.equal((await act('watchlist.list', {})).entries.length, 1);
  assert.equal((await act('watchlist.delete', { id: topicW.id })).deleted, true);
});
