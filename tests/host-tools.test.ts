import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { registerPaperReaderTools, ToolArgsError, type HostToolDefinition, type HostToolsRegistry } from '../src/server/host-tools.js';
import { Library } from '../src/server/library.js';
import { publicResource } from '../src/server/public-resource.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { replaceDocPages, saveTopic, setPaperCard, upsertCitationStances } from '../src/server/research-store.js';

const EXPECTED_TOOLS = ['paper_reader_search', 'paper_reader_topic_summary', 'paper_reader_citation_stance', 'paper_reader_field_trends'];

function mockTrendFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('api.openalex.org/works') && url.includes('group_by=primary_topic.id')) return jsonRes({ group_by: [{ key: 'https://openalex.org/T1001', key_display_name: 'LLM Serving', count: 120 }] });
    if (url.includes('api.openalex.org/works') && url.includes('group_by=publication_year')) return jsonRes({ group_by: [{ key: '2024', count: 40 }, { key: '2025', count: 80 }] });
    if (url.includes('api.openalex.org/works') && url.includes('cited_by_count:desc')) return jsonRes({ results: [{ publication_year: 2024, cited_by_count: 50 }, { publication_year: 2025, cited_by_count: 70 }] });
    if (url.includes('europepmc/webservices/rest/search')) return jsonRes({ hitCount: 15, resultList: { result: [{ pubYear: '2024', citedByCount: 12 }] } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'doc_pages_fts_%' ORDER BY name").all();
  return Object.fromEntries(rows.map(r => { const n = String(r.name); return [n, Number(db.prepare(`SELECT count(*) AS n FROM "${n}"`).get()?.n ?? 0)]; }));
}

async function assertToolArgsError(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ToolArgsError, `expected ToolArgsError, got ${String(err)}`);
    assert.equal(err.name, 'ToolArgsError'); assert.equal(err.status, 400); assert.equal(err.code, 'INVALID_ARGS');
    return true;
  });
}

describe('DSH host read-only tools', () => {
  test('registers 4 read-only tools, returns accurate seeded data, rejects bad args, and never mutates SQLite', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'paper-reader-tools-'));
    try {
      const store = new ReaderStore(root), library = new Library(root, publicResource, id => store.deleteDocument(id));
      store.updateDocTriage({ docId: 'pagedattention', status: 'reading', starred: true, tags: ['llm-serving'] });
      store.save('note', { docId: 'pagedattention', title: 'PagedAttention', page: 6, text: 'Block table maps logical KV blocks to physical blocks.', quote: 'block table' });
      store.saveAnnotation({ id: randomUUID(), docId: 'pagedattention', kind: 'highlight', page: 6, color: 'green', text: 'KV cache paging highlight', quote: 'virtual memory paging' });
      const citing = await library.createAbstract({
        title: 'FlashDecoding++: Faster LLM Inference', authors: 'Hong et al.', venue: 'MLSys', year: '2024', doi: '10.1000/flash-dec',
        abstract: 'Unlike PagedAttention (arXiv:2309.06180), which relies on virtual memory block tables for KV cache allocation, our kernel overlaps softmax synchronization.'
      });
      store.withDb(true, db => {
        replaceDocPages(db, 'pagedattention', [
          { page: 1, text: 'PagedAttention manages KV cache memory efficiently in LLM serving.' },
          { page: 6, text: 'The block table translates logical KV cache blocks to non-contiguous physical blocks.' }
        ]);
        replaceDocPages(db, citing.id, [{ page: 1, text: citing.abstract ?? '' }]);
        saveTopic(db, { id: 'topic-llm', name: 'LLM Serving', tag: 'llm-serving', description: 'Inference engines' });
        setPaperCard(db, {
          docId: 'pagedattention', sourceKind: 'pdf', problem: 'KV cache fragmentation', method: 'Virtual memory block table',
          findings: '2-4x throughput gain', limitations: 'Block-level copy-on-write overhead on small beams', futureWork: 'Extend paging to disaggregated prefill/decode',
          sourceHash: 'abc123', updatedAt: 1700000000000
        });
        db.prepare('INSERT INTO extraction_tables(id,name,preset,criteria_json,columns_json,strict_criterion,threshold,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run('t1', 'CS/AI Matrix', 'cs_ai', '[]', JSON.stringify([{ id: 'method', name: 'Method', type: 'text' }]), 0, 0.6, 1700000000000);
        db.prepare('INSERT INTO extraction_cells(table_id,doc_id,col_id,value,quote,page,reasoning,verified,manual_override,source_kind,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run('t1', 'pagedattention', 'method', 'PagedAttention block table', 'block table translates', 6, 'Grounded', 1, 0, 'pdf', 'done', 1700000000000);
        upsertCitationStances(db, [{
          targetKey: 'doi:10.1145/3600006.3613165', direction: 'cited_by', citingKey: 's2:ext-1', docId: 'pagedattention', source: 's2',
          citingTitle: 'SGLang RadixAttention', citingAuthors: ['Zheng et al.'], citingYear: 2024, section: 'Methods',
          context: 'Building upon PagedAttention, RadixAttention shares KV prefixes via a radix tree.', stance: 'extending',
          rationale: 'Extends KV cache sharing with prefix trees.', isInfluential: true, isSelfCitation: false, manualOverride: false, updatedAt: '2025-01-01T00:00:00Z'
        }]);
      });

      const registered = new Map<string, HostToolDefinition>();
      let disposed = 0, teardown: (() => void) | undefined;
      const registry: HostToolsRegistry = { register(def) { registered.set(def.name, def); return () => { disposed++; registered.delete(def.name); }; } };
      registerPaperReaderTools({ inject(services, setup) { assert.deepEqual(services, ['tools']); teardown = setup({ tools: registry }); } }, { root, library, fetchFn: mockTrendFetch() });
      assert.deepEqual([...registered.keys()], EXPECTED_TOOLS);
      for (const tool of registered.values()) {
        assert.equal(tool.parameters.type, 'object'); assert.equal(tool.parameters.additionalProperties, false); assert.equal(tool.isConcurrencySafe(), true);
      }

      const dbPath = path.join(root, 'reader.sqlite'), observer = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const beforeVersion = Number(observer.prepare('PRAGMA data_version').get()?.data_version ?? 0), beforeCounts = tableCounts(observer), beforeBytes = await readFile(dbPath);
        const searchRes = await registered.get('paper_reader_search')!.execute({ query: 'block table', topic: 'LLM Serving', limit: 5 }) as { pageHits: { docId: string; page: number }[]; noteHits: { docId: string }[] };
        assert.ok(searchRes.pageHits.some(h => h.docId === 'pagedattention' && h.page === 6));
        assert.ok(searchRes.noteHits.some(h => h.docId === 'pagedattention'));
        const markRes = await registered.get('paper_reader_search')!.execute({ query: 'virtual memory paging', limit: 5 }) as { highlightHits: { docId: string }[] };
        assert.ok(markRes.highlightHits.some(h => h.docId === 'pagedattention'));
        assert.match(registered.get('paper_reader_search')!.output.render({}, searchRes)[0].text, /pagedattention/);

        const topicRes = await registered.get('paper_reader_topic_summary')!.execute({ topic: 'LLM Serving' }) as {
          documentCount: number; paperCards: { docId: string }[]; extractionTables: { rows: { docId: string }[] }[]; limitations: unknown[]; openProblems: unknown[];
        };
        assert.equal(topicRes.documentCount, 1); assert.equal(topicRes.paperCards[0].docId, 'pagedattention');
        assert.equal(topicRes.extractionTables[0].rows[0].docId, 'pagedattention'); assert.equal(topicRes.limitations.length, 1); assert.equal(topicRes.openProblems.length, 1);
        const allRes = await registered.get('paper_reader_topic_summary')!.execute({}) as { scope: string; documentCount: number };
        assert.equal(allRes.scope, 'library'); assert.equal(allRes.documentCount, 2);

        const stanceRes = await registered.get('paper_reader_citation_stance')!.execute({ docId: 'pagedattention', direction: 'cited_by' }) as {
          sciteUrl: string; tallies: { extending: number; localBackCitations: number }; statements: { source: string; citingDocId?: string }[];
        };
        assert.ok(stanceRes.sciteUrl.startsWith('https://scite.ai/')); assert.equal(stanceRes.tallies.extending, 1); assert.equal(stanceRes.tallies.localBackCitations, 1);
        assert.ok(stanceRes.statements.some(s => s.source === 'local' && s.citingDocId === citing.id));

        const trendsRes = await registered.get('paper_reader_field_trends')!.execute({ query: 'LLM inference', windowYears: 3, metric: 'volume', sources: ['openalex', 'europepmc'] }) as {
          source: string; topics: { topicId: string; localCount: number }[];
        };
        assert.equal(trendsRes.source, 'all'); assert.ok(trendsRes.topics.some(t => t.topicId === 'T1001' && t.localCount === 1));

        assert.equal(Number(observer.prepare('PRAGMA data_version').get()?.data_version ?? 0), beforeVersion);
        assert.deepEqual(tableCounts(observer), beforeCounts);
        assert.equal(Buffer.compare(beforeBytes, await readFile(dbPath)), 0);
      } finally { observer.close(); }

      const invalidCases: [string, unknown][] = [
        ['paper_reader_search', {}], ['paper_reader_search', { query: '   ' }], ['paper_reader_search', { query: 'kv', extra: true }],
        ['paper_reader_search', { query: 'kv', limit: 0 }], ['paper_reader_search', { query: 'kv', limit: 51 }], ['paper_reader_search', { query: 'kv', limit: 2.5 }],
        ['paper_reader_topic_summary', { topic: 42 }], ['paper_reader_topic_summary', { unknownKey: 'x' }],
        ['paper_reader_citation_stance', {}], ['paper_reader_citation_stance', { docId: 'pagedattention', direction: 'invalid' }],
        ['paper_reader_field_trends', { query: 'llm', windowYears: 4 }], ['paper_reader_field_trends', { query: 'llm', metric: 'invalid' }],
        ['paper_reader_field_trends', { query: 'llm', sources: ['arxiv'] }], ['paper_reader_field_trends', { query: 'llm', sources: [] }],
        ['paper_reader_field_trends', { query: '((()))', sources: ['europepmc'] }], ['paper_reader_search', Object.create({ query: 'kv' })]
      ];
      for (const [name, badArgs] of invalidCases) await assertToolArgsError(() => registered.get(name)!.execute(badArgs));

      teardown?.();
      assert.equal(disposed, 4); assert.equal(registered.size, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('creates zero files on empty root and never mutates chmod 0444 legacy v2 reader.sqlite', async () => {
    const emptyRoot = await mkdtemp(path.join(tmpdir(), 'paper-reader-empty-')), legacyRoot = await mkdtemp(path.join(tmpdir(), 'paper-reader-legacy-'));
    const runAll = async (root: string) => {
      const tools = new Map<string, HostToolDefinition>();
      registerPaperReaderTools({ inject(_s, setup) { setup({ tools: { register(d) { tools.set(d.name, d); return () => {}; } } }); } }, { root, library: new Library(root, publicResource), fetchFn: mockTrendFetch() });
      const search = await tools.get('paper_reader_search')!.execute({ query: 'PagedAttention' }) as { metadataHits: { docId: string }[]; noteHits: { docId: string }[] };
      await tools.get('paper_reader_topic_summary')!.execute({});
      await tools.get('paper_reader_citation_stance')!.execute({ docId: 'pagedattention', direction: 'cited_by' });
      await tools.get('paper_reader_field_trends')!.execute({ query: 'LLM inference', windowYears: 3, sources: ['openalex', 'europepmc'] });
      return search;
    };
    const dbPath = path.join(legacyRoot, 'reader.sqlite');
    try {
      const searchEmpty = await runAll(emptyRoot);
      assert.ok(searchEmpty.metadataHits.some(h => h.docId === 'pagedattention'));
      assert.deepEqual(readdirSync(emptyRoot), []);

      const legacyDb = new DatabaseSync(dbPath);
      try {
        legacyDb.exec("CREATE TABLE prefs(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL) STRICT; CREATE TABLE entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, docId TEXT NOT NULL, page INTEGER NOT NULL, anchor TEXT NOT NULL, text TEXT NOT NULL, label TEXT NOT NULL, quote TEXT NOT NULL, updatedAt TEXT NOT NULL) STRICT; CREATE TABLE annotations(id TEXT PRIMARY KEY, docId TEXT NOT NULL, content TEXT, updatedAt TEXT NOT NULL) STRICT; CREATE TABLE doc_meta(docId TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unread', starred INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', lastOpenedAt INTEGER, lastPage INTEGER, pageCount INTEGER, scrollFraction REAL) STRICT;");
        for (const t of ['citations', 'notebooks', 'notebook_documents', 'notebook_vaults', 'chat_exchanges', 'zotero_authorizations', 'zotero_sources', 'book_positions', 'pdf_outlines', 'article_captures']) legacyDb.exec(`CREATE TABLE ${t}(id TEXT PRIMARY KEY) STRICT`);
        legacyDb.prepare("INSERT INTO entries(id,kind,docId,page,anchor,text,label,quote,updatedAt) VALUES('n1','note','pagedattention',6,'','PagedAttention legacy note','','','2025-01-01T00:00:00Z')").run();
        legacyDb.exec('PRAGMA user_version=2');
      } finally { legacyDb.close(); }
      await chmod(dbPath, 0o444);
      const beforeBytes = await readFile(dbPath), beforeMtime = statSync(dbPath).mtimeMs;
      const searchLegacy = await runAll(legacyRoot);
      assert.equal(searchLegacy.noteHits.length, 1);
      assert.equal(Buffer.compare(beforeBytes, await readFile(dbPath)), 0);
      assert.equal(statSync(dbPath).mtimeMs, beforeMtime);
      assert.deepEqual(readdirSync(legacyRoot), ['reader.sqlite']);
      const obs = new DatabaseSync(dbPath, { readOnly: true });
      try { assert.equal(Object.keys(tableCounts(obs)).length, 14); } finally { obs.close(); }
    } finally {
      await chmod(dbPath, 0o600).catch(() => {});
      await rm(emptyRoot, { recursive: true, force: true });
      await rm(legacyRoot, { recursive: true, force: true });
    }
  });

  test('degrades gracefully when ctx.inject or tools service is unavailable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'paper-reader-tools-graceful-'));
    try {
      const library = new Library(root, publicResource);
      assert.doesNotThrow(() => registerPaperReaderTools(undefined, { root, library }));
      assert.doesNotThrow(() => registerPaperReaderTools({}, { root, library }));
      assert.doesNotThrow(() => registerPaperReaderTools({ inject: (_s, setup) => setup({}) }, { root, library }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
