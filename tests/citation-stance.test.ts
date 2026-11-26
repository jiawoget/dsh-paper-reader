import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSciteUrl, classifyCitationContexts, scanLocalBackCitations } from '../src/server/citation-stance.js';
import { Library } from '../src/server/library.js';
import { ReaderModel } from '../src/server/reader-model.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { ensureResearchSchema, hasResearchSchema, replaceDocPages } from '../src/server/research-store.js';
import { createServices } from '../src/server/services.js';

const okJson = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
const hasStatus = (status: number) => (err: unknown) => err instanceof Error && 'status' in err && (err as { status: number }).status === status;
const stubLlm = (onCall: (items: { idx: number; context: string }[]) => string) => ({
  llm: {
    listProviders: () => [{ id: 'test' }], listModels: async () => [{ id: 'test-model', name: 'Test', inputModalities: ['text'] }],
    stream: async function* (req: { messages: { content: { text?: string }[] }[] }) {
      const body = JSON.parse(req.messages[0]?.content[0]?.text || '{}') as { items?: { idx: number; context: string }[] };
      yield { type: 'text-delta', text: onCall(body.items ?? []) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
});

test('buildSciteUrl, unclassified guard, offline local back-citations, cache/reclassify persistence, and dual-doc cascade delete', async t => {
  assert.equal(buildSciteUrl('https://doi.org/10.1056/NEJMoa2032183', 'Semaglutide'), 'https://scite.ai/reports/10.1056%2FNEJMoa2032183');
  assert.equal(buildSciteUrl('', 'PagedAttention KV Cache'), 'https://scite.ai/search?q=PagedAttention%20KV%20Cache');

  const mem = new DatabaseSync(':memory:'); t.after(() => mem.close());
  for (const ddl of ['CREATE TABLE doc_pages(docId TEXT, page INTEGER, text TEXT, updatedAt INTEGER)', 'CREATE VIRTUAL TABLE doc_pages_fts USING fts5(docId, page, text)', 'CREATE TABLE topics(id TEXT PRIMARY KEY)', 'CREATE TABLE graph_cache(cacheKey TEXT PRIMARY KEY)', 'CREATE TABLE paper_cards(doc_id TEXT PRIMARY KEY)', 'CREATE TABLE extraction_tables(id TEXT PRIMARY KEY)', 'CREATE TABLE extraction_cells(table_id TEXT, doc_id TEXT, col_id TEXT)', 'CREATE TABLE watchlist(id TEXT PRIMARY KEY)']) mem.exec(ddl);
  assert.equal(hasResearchSchema(mem), false); ensureResearchSchema(mem); assert.equal(hasResearchSchema(mem), true);
  const root = await mkdtemp(path.join(tmpdir(), 'reader-citations-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));

  let offlineMode = true, s2Mode: 'initial' | 'refresh' | 'empty' = 'initial', failLlm = false;
  const counts = { s2: 0, llm: 0 }, seenContexts: string[] = [];
  const host = stubLlm(items => {
    counts.llm++;
    if (failLlm) throw new Error('LLM provider unavailable');
    for (const it of items) seenContexts.push(it.context);
    return JSON.stringify({ results: items.map(it => ({ idx: it.idx, stance: /limitation|overhead|fail/i.test(it.context) ? 'contrasting' : /build|extend/i.test(it.context) ? 'extending' : 'supporting', rationale: 'Grounded classification from snippet.', section: 'Results' })) });
  });
  const EPMC_XML = '<article><body><sec><title>Introduction</title><p>Background text on obesity trials.</p></sec><sec><title>Results</title><p>First results paragraph cites <xref rid="b1-2">2</xref> showing no effect.</p><p>Second paragraph <xref rid="b1">1</xref> corroborates 14.9% weight reduction.</p></sec></body><back><ref-list><ref id="b1"><pub-id pub-id-type="pmid">33567185</pub-id></ref></ref-list></back></article>';
  const fetchImpl: typeof fetch = async input => {
    if (offlineMode) throw Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' });
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'api.openalex.org' && url.pathname.includes('2401.99999')) return okJson({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/paged-test', title: 'Virtual Block Caching for High-Throughput Language Model Serving', publication_year: 2023, authorships: [{ author: { display_name: 'Woosuk Kwon' } }] });
    if (url.hostname === 'api.semanticscholar.org' && url.pathname.includes('/citations')) {
      counts.s2++;
      if (s2Mode === 'empty' || url.pathname.includes('NEJMoa2032183')) return okJson({ data: [] });
      if (s2Mode === 'refresh') return okJson({ data: [{ isInfluential: false, intents: ['result'], contexts: ['We extend PagedAttention with adaptive paging for multi-tenant serving clusters.'], citingPaper: { paperId: 's2-c3', title: 'Adaptive Paging Followup', year: 2025, authors: [{ name: 'Dan Xu' }], externalIds: { DOI: '10.1000/c3' } } }] });
      return okJson({ data: [
        { isInfluential: true, intents: ['result'], contexts: ['Unlike Kwon et al. (2023), PagedAttention incurs high page-table lookup overhead on long prompts and fails under heterogeneous batch sizes.'], citingPaper: { paperId: 's2-c1', title: 'FastKV Scheduling Analysis', year: 2024, authors: [{ name: 'Bob Lin' }], externalIds: { DOI: '10.1000/fastkv' }, url: 'https://example.org/fastkv' } },
        { isInfluential: false, intents: [], contexts: [], citingPaper: { paperId: 's2-c2', title: 'No-Context Survey Paper', year: 2025, authors: [{ name: 'Cara Wu' }], externalIds: { DOI: '10.1000/nocontext' } } }
      ] });
    }
    if (url.hostname === 'www.ebi.ac.uk') {
      if (url.pathname.endsWith('/PMC999999/fullTextXML')) return new Response(EPMC_XML, { status: 200, headers: { 'content-type': 'application/xml' } });
      const q = url.searchParams.get('query') ?? '';
      if (q.includes('10.1056/NEJMoa2032183')) return okJson({ resultList: { result: [{ pmid: '33567185', title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity', pubYear: '2021', authorString: 'Wilding JPH' }] } });
      if (q.includes('CITES:33567185_MED')) return okJson({ resultList: { result: [{ pmcid: 'PMC999999', pmid: '40000001', title: 'Clinical Replication Trial', pubYear: '2024', authorString: 'Eva Chen' }] } });
    }
    return new Response('', { status: 404 });
  };

  const act = createServices({ root, ctx: host, library, store, fetchImpl });
  const docA = (await act('library.createAbstract', { title: 'Virtual Block Caching for High-Throughput Language Model Serving', authors: 'Woosuk Kwon; Zhuohan Li', year: '2023', doi: '10.1000/paged-test', abstract: 'Virtual block caching eliminates KV cache fragmentation via memory blocks.' })).doc;
  const docB = (await act('library.createAbstract', { title: 'Heterogeneous Block Scheduling for Serving Pipelines', authors: 'Dana Park; Woosuk Kwon', year: '2024', doi: '10.1000/local-b', abstract: 'Local citing document.' })).doc;
  store.withDb(true, db => {
    replaceDocPages(db, docA.id, [{ page: 1, text: 'Virtual Block Caching for High-Throughput Language Model Serving (10.1000/paged-test) by Woosuk Kwon 2023.' }]);
    replaceDocPages(db, docB.id, [{ page: 1, text: '1 Introduction. Serving large models efficiently requires careful memory layout.' }, { page: 2, text: '2 Methods. We design a two-tier block allocator for inference servers.' }, { page: 3, text: '3 Results. Building upon Kwon et al. (2023) and 10.1000/paged-test, we extend virtual block caching with adaptive block sizes to cut tail latency by 28%.' }]);
  });
  const emptyGuard = await classifyCitationContexts({ store, model: new ReaderModel(host, fetchImpl) }, [{ id: 'empty-1', targetTitle: docA.title, citingTitle: 'Empty', context: '   ' }]);
  assert.equal(emptyGuard.get('empty-1')?.stance, 'unclassified'); assert.equal(counts.llm, 0);
  const offlineRes = await createServices({ root, library, store, fetchImpl })('citations.analyze', { docId: docA.id });
  assert.ok(offlineRes.offline && offlineRes.tallies.localBackCitations === 1 && offlineRes.statements.length === 1);
  assert.ok(offlineRes.statements[0].citingDocId === docB.id && offlineRes.statements[0].citingPage === 3 && offlineRes.statements[0].section === 'Results' && offlineRes.statements[0].isSelfCitation && offlineRes.statements[0].context.includes('10.1000/paged-test'));
  const summaryBefore = await act('citations.summary', { doi: '10.1000/paged-test' });
  assert.ok(summaryBefore.tallies.localBackCitations === 1 && !summaryBefore.hasCachedExternal && summaryBefore.sciteUrl === 'https://scite.ai/reports/10.1000%2Fpaged-test');
  const localRefs = scanLocalBackCitations({ targetKey: offlineRes.target.targetKey, docId: docB.id, title: docB.title, authors: ['Dana Park'], year: 2024 }, [docA, docB], id => store.withDb(false, db => db.prepare('SELECT page, text FROM doc_pages WHERE docId=? ORDER BY page').all(id).map(r => ({ page: Number(r.page), text: String(r.text) }))), 'references');
  assert.ok(localRefs.length === 1 && localRefs[0].docId === docB.id && localRefs[0].citingDocId === docA.id && localRefs[0].citingPage === 3);

  offlineMode = false;
  const firstOnline = await act('citations.analyze', { docId: docA.id });
  assert.equal(firstOnline.offline, false); assert.equal(firstOnline.fromCache, false); assert.equal(counts.s2, 1); assert.equal(counts.llm, 1); assert.equal(seenContexts.length, 2);
  assert.deepEqual(firstOnline.tallies, { citingPapers: 3, citationStatements: 3, supporting: 0, extending: 1, contrasting: 1, mentioning: 0, unclassified: 1, localBackCitations: 1 });
  const noCtxRow = firstOnline.statements.find(s => s.citingTitle === 'No-Context Survey Paper')!;
  assert.ok(noCtxRow.context === '' && noCtxRow.stance === 'unclassified');
  const cachedRun = await act('citations.analyze', { docId: docA.id });
  assert.equal(cachedRun.fromCache, true); assert.equal(counts.s2, 1); assert.equal(counts.llm, 1);
  const byArxiv = await act('citations.analyze', { query: 'arXiv:2401.99999' });
  assert.ok(byArxiv.target.docId === docA.id && byArxiv.statements.some(s => s.citingDocId === docB.id && s.isSelfCitation) && !byArxiv.statements.some(s => s.citingDocId === docA.id));

  await assert.rejects(() => Promise.resolve(act('citations.reclassify', { targetKey: firstOnline.target.targetKey, direction: 'cited_by', citingKey: 's2:s2-c1', stance: 'bogus' as 'supporting' })), hasStatus(400));
  const reclassed = await act('citations.reclassify', { targetKey: firstOnline.target.targetKey, direction: 'cited_by', citingKey: 's2:s2-c1', stance: 'supporting', rationale: 'Manual expert review' });
  assert.ok(reclassed.statement.stance === 'supporting' && reclassed.statement.manualOverride && reclassed.tallies.supporting === 1 && reclassed.tallies.contrasting === 0);
  store.withDb(true, db => replaceDocPages(db, docB.id, [{ page: 4, text: '3 Results. Building upon Kwon et al. (2023) and 10.1000/paged-test, we extend virtual block caching with adaptive block sizes.' }]));
  assert.equal((await act('citations.summary', { docId: docA.id })).tallies.localBackCitations, 1);
  s2Mode = 'refresh';
  const refreshed = await act('citations.analyze', { docId: docA.id, forceRefresh: true });
  const refKeys = new Set(refreshed.statements.map(s => s.citingKey)), kept = refreshed.statements.find(s => s.citingKey === 's2:s2-c1')!;
  assert.ok(refKeys.has(`local:${docB.id}:p4`) && !refKeys.has(`local:${docB.id}:p3`) && refKeys.has('s2:s2-c3') && !refKeys.has('s2:s2-c2') && kept.stance === 'supporting' && kept.manualOverride && kept.rationale === 'Manual expert review');

  const epmcStmt = (await act('citations.analyze', { doi: '10.1056/NEJMoa2032183' })).statements.find(s => s.source === 'europepmc')!;
  assert.ok(epmcStmt.section === 'Results' && epmcStmt.context.includes('corroborates 14.9% weight reduction') && !epmcStmt.context.includes('no effect'));
  s2Mode = 'empty'; failLlm = true;
  const llmFailRes = await act('citations.analyze', { docId: docA.id, forceRefresh: true });
  assert.ok(llmFailRes.offline === false && llmFailRes.degraded.includes('llm'));

  const roDb = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true }); t.after(() => roDb.close());
  assert.equal(Number((roDb.prepare("SELECT COUNT(*) AS n FROM graph_cache WHERE payload LIKE '%<sec%' OR payload LIKE '%<ref%'").get() as { n: number }).n), 0);
  await act('library.delete', { id: docB.id });
  assert.equal(Number((roDb.prepare('SELECT COUNT(*) AS n FROM citation_stances WHERE citing_doc_id=?').get(docB.id) as { n: number }).n), 0);
  await act('library.delete', { id: docA.id });
  assert.equal(Number((roDb.prepare('SELECT COUNT(*) AS n FROM citation_stances WHERE doc_id=? OR citing_doc_id=?').get(docA.id, docA.id) as { n: number }).n), 0);
});
