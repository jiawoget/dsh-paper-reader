import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIBRARY_PAGE_SIZE, rankDocsByRelevance, slicePage } from '../src/shared/library-relevance.js';
import {
  computeScreeningStatus, exportReviewCsv, exportReviewMarkdown, REVIEW_PRESETS, SUGGESTED_REVIEW_COLUMNS, verifyQuote,
  type ExtractionCell, type ReviewTable
} from '../src/shared/review-types.js';
import type { DocumentInfo } from '../src/shared/types.js';
import { apply } from '../src/server/index.js';
import { Library } from '../src/server/library.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { ensureResearchSchema, hasResearchSchema, replaceDocPages } from '../src/server/research-store.js';
import { createServices } from '../src/server/services.js';

const samplePdfPath = path.resolve('public/assets/pagedattention.pdf');
const statusIs = (code: number) => (e: unknown) => e instanceof Error && 'status' in e && (e as { status: number }).status === code;
const fakeHost = (reply: (sys: string, data: Record<string, unknown>, sig?: AbortSignal) => Promise<string> | string) => ({
  llm: {
    listProviders: () => [{ id: 'mock' }], listModels: async () => [{ id: 'mock-m', name: 'Mock', inputModalities: ['text'] }],
    stream: async function* (req: { system: string; messages: { content: { text?: string }[] }[]; signal: AbortSignal }) {
      yield { type: 'text-delta', text: await reply(req.system, JSON.parse(req.messages[0]?.content[0]?.text || '{}') as Record<string, unknown>, req.signal) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
});

test('verifyQuote normalizes whitespace/hyphens/ligatures, rejects fabricated quotes, and enforces abstract rules', () => {
  const pages = [
    { page: 1, text: 'PagedAttention eliminates KV-cache fragmen-\ntation using ﬁne-grained virtual memory blocks.' },
    { page: 6, text: 'The block table maps logical KV blocks to physical GPU memory blocks.' }
  ];
  assert.deepEqual(verifyQuote({ quote: 'KV cache fragmentation using fine-grained virtual memory', page: 1, sourceKind: 'pdf', pages }), { verified: true, page: 1 });
  assert.deepEqual(verifyQuote({ quote: 'block table maps logical KV blocks', page: 2, sourceKind: 'pdf', pages }), { verified: true, page: 6 });
  assert.deepEqual(verifyQuote({ quote: 'fabricated nonexistent benchmark result', page: 1, sourceKind: 'pdf', pages }), { verified: false, page: 1 });
  assert.deepEqual(verifyQuote({ quote: 'fabricated nonexistent benchmark result', page: 99, sourceKind: 'pdf', pages }), { verified: false, page: null });
  assert.deepEqual(verifyQuote({ quote: 'short', page: 1, sourceKind: 'pdf', pages }), { verified: false, page: 1 });
  assert.deepEqual(verifyQuote({ quote: 'mean body weight reduction of 14.9%', page: 2, sourceKind: 'abstract', abstract: 'Once-weekly semaglutide produced a mean body weight reduction of 14.9% versus placebo.' }), { verified: true, page: null });
  assert.deepEqual(verifyQuote({ quote: 'hallucinated trial endpoint', page: 1, sourceKind: 'abstract', abstract: 'Once-weekly semaglutide trial.' }), { verified: false, page: null });
  assert.deepEqual(REVIEW_PRESETS.general.columns.map(c => c.id), ['research_question', 'method', 'key_findings', 'limitations']);
  assert.equal(REVIEW_PRESETS.cs_ai.columns.length, 5); assert.equal(REVIEW_PRESETS.pico.columns.length, 5); assert.equal(REVIEW_PRESETS.custom.columns.length, 4);
  assert.ok(SUGGESTED_REVIEW_COLUMNS.length >= 4);
});

test('screening respects strictCriterion/threshold/manualOverride, syncs doc_meta, and upgrades legacy PR-3 schema', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-review-screen-')); t.after(() => rm(root, { recursive: true, force: true }));
  const mem = new DatabaseSync(':memory:'); t.after(() => mem.close());
  for (const sql of ['CREATE TABLE doc_pages(docId TEXT, page INTEGER, text TEXT, updatedAt INTEGER)', 'CREATE VIRTUAL TABLE doc_pages_fts USING fts5(docId, page, text)', 'CREATE TABLE topics(id TEXT PRIMARY KEY)', 'CREATE TABLE graph_cache(cacheKey TEXT PRIMARY KEY)', 'CREATE TABLE paper_cards(doc_id TEXT PRIMARY KEY)']) mem.exec(sql);
  assert.equal(hasResearchSchema(mem), false); ensureResearchSchema(mem); assert.equal(hasResearchSchema(mem), true);
  let onScreen: (() => Promise<void>) | undefined;
  const ctx = fakeHost(async (_sys, data) => {
    if (onScreen) { const fn = onScreen; onScreen = undefined; await fn(); }
    return JSON.stringify({ criteria: {
      c1: { decision: 'yes', quote: 'randomized controlled clinical trial', page: null, reasoning: 'RCT' },
      c2: { decision: String((data.paper as { title?: string })?.title ?? '').includes('Alpha') ? 'yes' : 'no', quote: 'semaglutide 2.4 mg', page: null, reasoning: 'Dose' }
    } });
  });
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id)), act = createServices({ root, ctx, library, store });
  const initTable = (await act('review.get', {})).table;
  assert.equal(initTable.preset, 'general');
  assert.deepEqual(initTable.columns.map(c => c.id), ['research_question', 'method', 'key_findings', 'limitations']);
  const d1 = await act('library.createAbstract', { title: 'Alpha Trial', authors: 'A et al.', year: '2024', abstract: 'A randomized controlled clinical trial of semaglutide 2.4 mg in adults.' });
  const d2 = await act('library.createAbstract', { title: 'Beta Trial', authors: 'B et al.', year: '2024', abstract: 'A randomized controlled clinical trial of placebo comparator only.' });
  const csSaved = await act('review.saveTable', { preset: 'cs_ai' });
  assert.equal(csSaved.table.preset, 'cs_ai'); assert.equal(csSaved.table.columns.length, 5);
  const customKeep = await act('review.saveTable', { preset: 'custom' });
  assert.equal(customKeep.table.preset, 'custom'); assert.equal(customKeep.table.columns.length, 5);
  const saved = await act('review.saveTable', { preset: 'pico', strictCriterion: true, threshold: 0.6, criteria: [{ id: 'c1', label: 'RCT' }, { id: 'c2', label: 'Semaglutide' }] });
  assert.equal(saved.table.preset, 'pico'); assert.equal(saved.table.columns.length, 5);
  const scr = await act('review.screen', { docIds: [d1.doc.id, d2.doc.id] });
  assert.equal(scr.processedDocs, 2);
  assert.ok(store.listDocMeta(d1.doc.id).get(d1.doc.id)?.tags.includes('screen:yes') && store.listDocMeta(d2.doc.id).get(d2.doc.id)?.tags.includes('screen:no'));
  const d2Cells = scr.cells.filter(c => c.docId === d2.doc.id && c.colId !== '__screen__');
  assert.equal(computeScreeningStatus(saved.table.criteria, d2Cells, true, 0.4).decision, 'no'); assert.equal(computeScreeningStatus(saved.table.criteria, d2Cells, false, 0.4).decision, 'yes');
  assert.equal(computeScreeningStatus(saved.table.criteria, d2Cells, false, 0.8).decision, 'no');
  assert.deepEqual(computeScreeningStatus([{ id: 'c1', label: 'RCT' }, { id: 'c2', label: 'Semaglutide', required: true }], d2Cells, false, 0.4), { decision: 'no', score: 0.5, manualOverride: false, included: false });
  const locked = await act('review.setCell', { docId: d2.doc.id, colId: '__screen__', value: 'maybe', reasoning: 'Borderline' });
  assert.equal(locked.cell.manualOverride, true); assert.ok(locked.meta?.tags.includes('screen:maybe') && !store.listDocMeta(d2.doc.id).get(d2.doc.id)?.tags.includes('screen:no'));
  await act('review.screen', { docIds: [d2.doc.id], force: true }); assert.ok(store.listDocMeta(d2.doc.id).get(d2.doc.id)?.tags.includes('screen:maybe'));
  onScreen = async () => { await act('review.setCell', { docId: d1.doc.id, colId: 'screen:c1', value: 'no', page: 5 }); };
  await act('review.screen', { docIds: [d1.doc.id], force: true });
  const d1Cells = new Map((await act('review.get', {})).cells.filter(c => c.docId === d1.doc.id).map(c => [c.colId, c]));
  assert.equal(d1Cells.get('screen:c1')?.value, 'no'); assert.equal(d1Cells.get('screen:c1')?.manualOverride, true); assert.equal(d1Cells.get('screen:c1')?.page, null);
  assert.equal(d1Cells.get('__screen__')?.value, 'no'); assert.ok(store.listDocMeta(d1.doc.id).get(d1.doc.id)?.tags.includes('screen:no'));
  for (const bad of [{ preset: 'bogus' }, { threshold: 1.5 }, { columns: [] }, { columns: [{ id: '__screen__', name: 'X', prompt: 'Y', type: 'text' }] }])
    await assert.rejects(() => Promise.resolve(act('review.saveTable', bad)), statusIs(400));
});

test('extraction enforces manualOverride lock, Pilot(3), Abort/resume, Attach PDF upgrade, delete cascade, and safe CSV/MD export', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-review-ext-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0, active = 0, maxActive = 0, siblingAborted = false, abortMode = false, deleteMidId = '', deleteQueuedId = '';
  const calledTitles: string[] = [], store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));
  const ctx = fakeHost(async (_sys, data, sig) => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    const paper = data.paper as { title: string; sourceKind: string }; calledTitles.push(paper.title);
    try {
      if (abortMode) await new Promise<void>((res, rej) => { const tm = setTimeout(res, paper.title === 'Doc 0' ? 10 : 80); sig?.addEventListener('abort', () => { clearTimeout(tm); siblingAborted = true; rej(new Error('aborted')); }, { once: true }); });
      if (deleteMidId && paper.title === 'Doc 4') { await act('library.delete', { id: deleteMidId }); deleteMidId = ''; }
      if (deleteQueuedId) { if (paper.title === 'Doc 0') { await act('library.delete', { id: deleteQueuedId }); deleteQueuedId = ''; } else if (paper.title === 'Doc 1') await new Promise(r => setTimeout(r, 20)); }
      return JSON.stringify({ cells: {
        method: { value: `M-${paper.sourceKind}-${calls}`, quote: paper.sourceKind === 'pdf' ? 'block table' : 'Semaglutide 2.4 mg weekly', page: paper.sourceKind === 'pdf' ? 6 : null, reasoning: 'R' },
        limitations: { value: '=CMD|"/C calc"', quote: 'hallucinated quote text', page: 99, reasoning: 'L' }
      } });
    } finally { active--; }
  });
  const act = createServices({ root, ctx, library, store });
  await act('review.saveTable', { preset: 'cs_ai', columns: [{ id: 'method', name: 'Method', prompt: 'Method', type: 'text' }, { id: 'limitations', name: 'Limitations', prompt: 'Limits', type: 'text' }] });
  const docs = await Promise.all(Array.from({ length: 5 }, (_, i) => act('library.createAbstract', { title: `Doc ${i}`, authors: `Auth ${i}`, year: '2024', doi: `10.1000/rev.${i}`, abstract: `Study ${i} evaluated Semaglutide 2.4 mg weekly with clear outcomes.` }).then(r => r.doc)));

  abortMode = true; const ac = new AbortController();
  const partial = await act('review.extract', { mode: 'pilot', docIds: docs.map(d => d.id) }, { signal: ac.signal, onDelta: () => ac.abort() });
  assert.equal(partial.aborted, true); assert.equal(partial.processedDocs, 1); assert.equal(siblingAborted, true); assert.ok(maxActive <= 2);
  abortMode = false; calls = 0; calledTitles.length = 0;
  const pilot = await act('review.extract', { mode: 'pilot', docIds: docs.map(d => d.id) });
  assert.equal(pilot.processedDocs, 3); assert.equal(pilot.skippedDocs, 1); assert.equal(calledTitles.includes('Doc 0'), false);
  deleteMidId = docs[4].id; await act('review.extract', { mode: 'all', docIds: docs.map(d => d.id) });
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true }); t.after(() => db.close());
  const cellCount = (id: string) => Number((db.prepare('SELECT COUNT(*) AS n FROM extraction_cells WHERE doc_id=?').get(id) as { n: number }).n);
  deleteQueuedId = docs[2].id; const qRes = await act('review.extract', { mode: 'reextract', docIds: docs.slice(0, 4).map(d => d.id) });
  assert.equal(cellCount(docs[4].id), 0); assert.equal(cellCount(docs[2].id), 0); assert.equal(qRes.processedDocs, 3); assert.equal(qRes.failedDocs, 0); assert.equal(new Set(qRes.cells.map(c => c.docId)).size, 3);

  await act('review.setCell', { docId: docs[0].id, colId: 'method', value: 'MANUAL-LOCK, "quoted"\nline2', reasoning: 'Human' });
  const beforeCalls = calls;
  assert.equal((await act('review.extract', { mode: 'cell', docId: docs[0].id, colId: 'method' })).processedDocs, 0); assert.equal(calls, beforeCalls);
  const attached = await library.attachPdf(docs[0].id, await readFile(samplePdfPath));
  store.withDb(true, d => replaceDocPages(d, attached.doc.id, attached.pages));
  assert.equal((await act('review.extract', { mode: 'reextract', docId: docs[0].id })).processedDocs, 1);
  const after = (await act('review.get', {})).cells.filter(c => c.docId === docs[0].id);
  const mCell = after.find(c => c.colId === 'method')!, lCell = after.find(c => c.colId === 'limitations')!;
  assert.equal(mCell.value, 'MANUAL-LOCK, "quoted"\nline2'); assert.equal(mCell.manualOverride, true);
  assert.equal(lCell.sourceKind, 'pdf'); assert.equal(lCell.verified, false); assert.equal(lCell.page, null);

  const csv = await act('review.export', { format: 'csv', docIds: [docs[0].id] }), md = await act('review.export', { format: 'markdown', docIds: [docs[0].id] });
  assert.ok(csv.content.includes('"MANUAL-LOCK, ""quoted""\nline2"') && csv.content.includes(`"'=CMD|""/C calc"""`) && md.content.includes('=CMD\\|"/C calc"') && !md.content.split('\n')[2].includes('\r'));
  const injTbl: ReviewTable = { id: 't', name: 'T', preset: 'cs_ai', criteria: [], columns: [{ id: 'c', name: 'C', prompt: '', type: 'text' }], strictCriterion: false, threshold: 0.6, updatedAt: 0 };
  const injCells: ExtractionCell[] = ['=1+1', '+2', '-3', '@SUM(A1)', '\t=1', '\r+1', '  =EVIL()'].map((v, i) => ({ tableId: 't', docId: `d${i}`, colId: 'c', value: v, quote: '', page: null, reasoning: '', verified: false, manualOverride: false, sourceKind: 'abstract', status: 'done', updatedAt: 0 }));
  const injCsv = exportReviewCsv(injTbl, injCells.map(c => ({ id: c.docId, kind: 'abstract', title: 'P' })), injCells);
  for (const tok of ["'=1+1", "'+2", "'-3", "'@SUM(A1)", "'  =EVIL()"]) assert.ok(injCsv.includes(tok));
  assert.ok(exportReviewMarkdown(injTbl, [{ id: 'd0', kind: 'abstract', title: 'A|B\n\\|x\\|' }], injCells.slice(0, 1)).includes('A\\|B \\|x\\|'));

  await act('library.delete', { id: docs[0].id }); assert.equal(cellCount(docs[0].id), 0);

  const prevHome = process.env.PAPER_READER_HOME; process.env.PAPER_READER_HOME = root;
  t.after(() => { if (prevHome === undefined) delete process.env.PAPER_READER_HOME; else process.env.PAPER_READER_HOME = prevHome; });
  const routes = new Map<string, (req: Request) => Promise<Response>>();
  apply({ connection: { fetch: { register: r => routes.set(r.path, r.fetch) } }, inject: (svcs, setup) => { if (svcs[0] === 'llm') setup({ llm: ctx.llm } as never); return () => {}; } });
  const streamRes = await routes.get('/api/paper-reader/action')!(new Request('http://dsh.internal/api/paper-reader/action', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ op: 'review.extract', payload: { mode: 'cell', docId: docs[1].id, colId: 'method', force: true } })
  }));
  const frames = (await streamRes.text()).trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  assert.ok(frames.some(f => typeof f.delta === 'string' && String(f.delta).includes('"kind":"extract"')));
});

test('BM25 relevance ranks 520 English+CJK papers in <50ms with bounded pagination', () => {
  const docs: DocumentInfo[] = Array.from({ length: 520 }, (_, i) => ({
    id: `doc-${i}`, kind: 'abstract', authors: `Author ${i}`, year: String(2020 + (i % 6)),
    title: i === 42 ? 'PagedAttention Virtual Memory KV Cache Serving' : i === 108 ? '大语言模型注意力机制与显存优化综述' : i === 250 ? '低比特量化推理加速方法' : `Synthetic Benchmark Study ${i}`,
    abstract: i === 42 ? 'Virtual memory paging eliminates KV cache fragmentation in LLM serving.' : i === 108 ? '系统分析大语言模型中的注意力机制与缓存管理策略。' : i === 250 ? '针对大模型的权重量化与推理加速。' : `Evaluation of synthetic topic cluster ${i % 17} across standard workloads.`,
    meta: { status: 'unread', starred: false, tags: i === 42 ? ['kv-cache', 'serving'] : i === 77 ? ['kv-cache'] : [`grp-${i % 10}`] }
  }));
  const t0 = performance.now(), ranked = rankDocsByRelevance('KV cache virtual memory paging', docs, new Map([['doc-300', 'virtual memory kv cache paging block table']]));
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 50, `Expected <50ms for 520 docs, got ${elapsedMs.toFixed(2)}ms`);
  assert.equal(ranked.length, 520); assert.equal(ranked[0].docId, 'doc-42'); assert.ok(ranked[0].score >= 85 && ranked[0].score <= 100);
  assert.ok(ranked.find(r => r.docId === 'doc-77')!.score > 0 && ranked.find(r => r.docId === 'doc-300')!.score > 0 && ranked.at(-1)!.score === 0);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
  const page = slicePage(ranked, LIBRARY_PAGE_SIZE);
  assert.deepEqual({ shown: page.shown, total: page.total, hasMore: page.hasMore }, { shown: 50, total: 520, hasMore: true });
  assert.equal(slicePage(ranked, Number.NaN).shown, LIBRARY_PAGE_SIZE);
  const zhRanked = rankDocsByRelevance('大模型注意力机制', docs), zhSingle = rankDocsByRelevance('量', docs);
  assert.ok(zhRanked[0].docId === 'doc-108' && zhRanked[0].score >= 70 && zhSingle[0].docId === 'doc-250' && zhSingle[0].score > 0);
});

test('review.bulkSetCell is atomic with doc_meta sync, accepts >500 docs, and review.rerank degrades cleanly offline', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-review-bulk-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));
  const seenAbstracts = new Map<string, string>();
  let malformed = false;
  const rerankHost = fakeHost((_sys, data) => {
    const scores: Record<string, { score: unknown; rationale: string }> = {};
    const papers = (data.papers as { docId: string; title: string; abstract?: string }[]) ?? [];
    for (const [idx, p] of papers.entries()) {
      seenAbstracts.set(p.docId, p.abstract ?? '');
      scores[p.docId] = malformed ? { score: idx === 0 ? null : idx === 1 ? '' : '82', rationale: 'Parsed' } : { score: p.title.includes('Target') ? 94 : 28, rationale: p.title.includes('Target') ? 'Direct match' : 'Tangential' };
    }
    return JSON.stringify({ scores });
  });
  const act = createServices({ root, ctx: rerankHost, library, store });
  const ids = (await Promise.all([
    act('library.createAbstract', { title: 'Target KV Cache Paging', authors: 'A', year: '2025', abstract: 'Virtual memory KV paging.' }),
    act('library.createAbstract', { title: 'Unrelated Vision Study', authors: 'B', year: '2024', abstract: 'Image classification benchmark.' }),
    act('library.createAbstract', { title: 'Elastic Block Study', authors: 'C', year: '2025', abstract: 'Eliminates KV cache fragmentation via paged serving.' })
  ])).map(r => r.doc.id);
  const rev = await act('review.get', {}), listed = (await act('library.list', {})).docs;
  assert.ok(rev.snippets?.[ids[2]]?.includes('KV cache fragmentation'));
  assert.ok(rankDocsByRelevance('KV cache fragmentation paged serving', listed, new Map(Object.entries(rev.snippets ?? {}))).find(r => r.docId === ids[2])!.score > 0);
  await act('review.saveTable', { criteria: [{ id: 'c1', label: 'KV scope' }] });
  assert.equal((await act('review.bulkSetCell', { docIds: [ids[0]], colId: 'screen:c1', value: 'yes' })).updatedCount, 1);
  const bulkYes = await act('review.bulkSetCell', { docIds: ids, colId: '__screen__', value: 'yes', reasoning: 'Top match' });
  assert.equal(bulkYes.updatedCount, 3);
  for (const id of ids) assert.ok(store.listDocMeta(id).get(id)?.tags.includes('screen:yes'));
  await assert.rejects(() => act('review.bulkSetCell', { docIds: ids, colId: 'nonexistent_col', value: 'yes' }), statusIs(400));
  await assert.rejects(() => act('review.bulkSetCell', { docIds: ids, colId: '__screen__', value: 'invalid_val' }), statusIs(400));
  store.withDb(true, db => db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON extraction_cells WHEN NEW.doc_id='${ids[1]}' BEGIN SELECT RAISE(ABORT, 'boom'); END;`));
  await assert.rejects(() => act('review.bulkSetCell', { docIds: ids, colId: '__screen__', value: 'no' }), statusIs(500));
  store.withDb(true, db => db.exec('DROP TRIGGER fail_second;'));
  assert.ok(store.listDocMeta(ids[0]).get(ids[0])?.tags.includes('screen:yes') && !store.listDocMeta(ids[0]).get(ids[0])?.tags.includes('screen:no'));

  const reranked = await act('review.rerank', { topic: 'KV cache serving', docIds: ids });
  assert.ok(reranked.degraded === undefined && reranked.scores.length === 3 && reranked.scores[0].score === 94 && reranked.scores.at(-1)!.score === 28 && reranked.scores[0].rationale === 'Direct match');
  assert.ok(seenAbstracts.get(ids[0])?.includes('Virtual memory KV paging.') && seenAbstracts.get(ids[2])?.includes('KV cache fragmentation'));
  malformed = true;
  const strictParsed = await act('review.rerank', { topic: 'KV cache serving', docIds: ids });
  assert.deepEqual(strictParsed.scores.map(s => [s.docId, s.score]), [[ids[2], 82]]);
  malformed = false;
  assert.deepEqual(await createServices({ root, library, store })('review.rerank', { topic: 'KV cache serving', docIds: ids }), { scores: [], degraded: true });

  const manyDocs: DocumentInfo[] = Array.from({ length: 950 }, (_, i) => ({ id: `syn-${i}`, kind: 'abstract', title: `Paper ${i}` }));
  const manySet = new Set(manyDocs.map(d => d.id));
  const bigLib = Object.assign(Object.create(library) as Library, { list: async () => manyDocs, get: async (id: string) => manyDocs.find(d => d.id === id)!, hasSync: (id: unknown) => typeof id === 'string' && manySet.has(id) });
  const bigAct = createServices({ root, ctx: rerankHost, library: bigLib, store });
  assert.equal((await bigAct('review.bulkSetCell', { docIds: manyDocs.map(d => d.id), colId: '__screen__', value: 'yes' })).updatedCount, 950);
  assert.equal((await bigAct('review.get', {})).cells.filter(c => c.docId.startsWith('syn-')).length, 950);
});
