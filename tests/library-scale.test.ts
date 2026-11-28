import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { filterDocsByQuery, LIBRARY_PAGE_SIZE, rankDocsByRelevance, slicePage } from '../src/shared/library-relevance.js';
import type { DocumentInfo } from '../src/shared/types.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { replaceDocPages } from '../src/server/research-store.js';
import { createServices } from '../src/server/services.js';

const hasHttpStatus = (code: number) => (err: unknown) =>
  err instanceof Error && 'status' in err && (err as { status: number }).status === code;

function makeSyntheticDocs(count: number): DocumentInfo[] {
  const topics = ['quantization', 'retrieval', 'vision', 'robotics', 'compiler', 'database', 'genomics', 'security'];
  return Array.from({ length: count }, (_, i) => {
    const topic = topics[i % topics.length], special = i === 17 || i === 243 || i === 489;
    return {
      id: `abs-${createHash('sha256').update(`scale-doc-${i}`).digest('hex')}`, kind: 'abstract',
      title: special ? `Sparse KV Cache Quantization Study ${i}` : `${topic} Systems Benchmark Study ${i}`,
      authors: `Author ${i}`, year: String(2019 + (i % 7)),
      abstract: special ? 'Sparse KV cache quantization reduces memory footprint for long-context transformer inference.' : `Empirical evaluation of ${topic} workloads with throughput and latency analysis.`,
      meta: { status: i % 3 === 0 ? 'done' : 'unread', starred: i % 20 === 0, tags: special ? ['kv-cache', 'screen:yes'] : [topic] }
    };
  });
}

function makeStubLlmHost() {
  return {
    llm: {
      listProviders: () => [{ id: 'scale-mock' }],
      listModels: async () => [{ id: 'fast', name: 'Fast', inputModalities: ['text'] }],
      stream: async function* (req: { system: string }) {
        const text = req.system.includes('Return ONLY valid JSON')
          ? JSON.stringify({ problem: 'Memory bottleneck', method: 'KV paging', findings: 'Lower memory', limitations: 'Abstract only', futureWork: 'Extend' })
          : 'Synthesized answer across scoped library papers.';
        yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  };
}

test('520-paper BM25 relevance ranking runs in < 50ms and slicePage bounds pages', () => {
  const docs = makeSyntheticDocs(520);
  rankDocsByRelevance('warmup', docs.slice(0, 10));
  const t0 = performance.now(), ranked = rankDocsByRelevance('sparse kv cache quantization', docs), elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 50, `Expected 520-paper ranking < 50ms, took ${elapsedMs.toFixed(2)}ms`);
  const top3 = new Set(ranked.slice(0, 3).map(r => r.docId));
  assert.ok(top3.has(docs[17].id) && top3.has(docs[243].id) && top3.has(docs[489].id) && ranked[0].score > ranked[3].score);
  const firstPage = slicePage(ranked, LIBRARY_PAGE_SIZE), secondPage = slicePage(ranked, 100);
  assert.deepEqual([firstPage.shown, firstPage.total, firstPage.hasMore, secondPage.shown, secondPage.hasMore], [50, 520, true, 100, true]);
  const multiWord = filterDocsByQuery('sparse kv cache', docs);
  assert.deepEqual(multiWord.slice(0, 3).map(d => d.id), ranked.slice(0, 3).map(r => r.docId));
  assert.equal(multiWord.length, rankDocsByRelevance('sparse kv cache', docs).filter(r => r.score > 0).length);
  assert.ok(filterDocsByQuery('quant', docs).length > 0 && filterDocsByQuery('2022', docs).length > 0);
  assert.equal(filterDocsByQuery('zzzznonexistent999', docs).length, 0);
  assert.equal(filterDocsByQuery('   ', docs).length, 520);
});

test('library.bulkTriage updates atomically and library.bulkDelete cascades SQLite while skipping pagedattention', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paper-reader-bulk-'));
  try {
    const svc = createServices({ root });
    const a = (await svc('library.createAbstract', { title: 'Bulk Paper A', abstract: 'Memory paging study alpha.' })).doc;
    const b = (await svc('library.createAbstract', { title: 'Bulk Paper B', abstract: 'Memory paging study beta.' })).doc;
    const c = (await svc('library.createAbstract', { title: 'Bulk Paper C', abstract: 'Memory paging study gamma.' })).doc;
    await svc('note.save', { docId: a.id, title: a.title, page: 1, anchor: 'p-1', label: 'Note', sourceUrl: '', quote: 'alpha', text: 'Note on A' });
    await svc('annotation.save', { id: randomUUID(), kind: 'highlight', docId: b.id, title: b.title, page: 1, anchor: 'p-1', label: 'Mark', sourceUrl: '', quote: 'beta', color: 'yellow', text: 'Mark on B' });
    await svc('doc.resources.add', { docId: a.id, url: 'https://github.com/example/repo-a', title: 'Repo A' });

    assert.equal((await svc('library.bulkTriage', { docIds: [a.id, b.id, a.id], addTags: ['Systems', 'Priority'], status: 'reading', starred: true })).updated, 2);
    assert.equal((await svc('library.bulkTriage', { docIds: [a.id, b.id], removeTags: ['systems'], addTags: ['Verified'] })).updated, 2);
    const metaA = (await svc('library.list', {})).docs.find(d => d.id === a.id)?.meta;
    assert.deepEqual(metaA?.tags, ['Priority', 'Verified']);
    assert.equal(metaA?.status, 'reading'); assert.equal(metaA?.starred, true);

    await assert.rejects(() => svc('library.bulkTriage', { docIds: [] }), hasHttpStatus(400));
    await assert.rejects(() => svc('library.bulkTriage', { docIds: [a.id] }), hasHttpStatus(400));
    await assert.rejects(() => svc('library.bulkTriage', { docIds: [a.id], status: 'bad' as 'done' }), hasHttpStatus(400));

    const missingId = `abs-${'0'.repeat(64)}`;
    const deleted = await svc('library.bulkDelete', { docIds: [a.id, b.id, 'pagedattention', missingId] });
    assert.deepEqual(deleted, { deletedIds: [a.id, b.id], skippedIds: ['pagedattention', missingId] });
    const remainingIds = new Set((await svc('library.list', {})).docs.map(d => d.id));
    assert.deepEqual([remainingIds.has(a.id), remainingIds.has(b.id), remainingIds.has(c.id), remainingIds.has('pagedattention')], [false, false, true, true]);

    const db = new DatabaseSync(path.join(root, 'reader.sqlite'));
    try {
      for (const id of [a.id, b.id]) {
        for (const [sql, params] of [
          ['SELECT COUNT(*) AS n FROM doc_meta WHERE docId=?', [id]],
          ['SELECT COUNT(*) AS n FROM doc_pages WHERE docId=?', [id]],
          ['SELECT COUNT(*) AS n FROM doc_pages_fts WHERE docId=?', [id]],
          ['SELECT COUNT(*) AS n FROM doc_resources WHERE doc_id=? OR target_doc_id=?', [id, id]],
          ['SELECT COUNT(*) AS n FROM entries WHERE docId=?', [id]],
          ['SELECT COUNT(*) AS n FROM annotations WHERE docId=?', [id]]
        ] as const) assert.equal(Number(db.prepare(sql).get(...params)?.n), 0);
      }
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('520-paper backend scale: pages.search (>900 chunking), library.exportRefs, and library.chat accept >500 docIds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'paper-reader-520-'));
  try {
    const libDir = path.join(root, 'documents'), docs = makeSyntheticDocs(520);
    await mkdir(libDir, { recursive: true });
    await Promise.all(docs.map((doc, i) => writeFile(path.join(libDir, `${doc.id}.json`), JSON.stringify({
      id: doc.id, kind: 'abstract', title: doc.title, authors: doc.authors, year: doc.year,
      abstract: i === 510 ? 'UniqueAnchorToken520 sparse KV eviction benchmark.' : doc.abstract,
      createdAt: new Date(Date.now() - i * 1000).toISOString()
    }))));
    const store = new ReaderStore(root);
    store.withDb(true, db => {
      for (let i = 0; i < docs.length; i++) replaceDocPages(db, docs[i].id, [{ page: 1, text: i === 510 ? 'UniqueAnchorToken520 sparse KV eviction benchmark.' : docs[i].abstract ?? docs[i].title }]);
    });
    const svc = createServices({ root, store, ctx: makeStubLlmHost() }), allIds = docs.map(d => d.id);
    const search520 = await svc('pages.search', { query: 'UniqueAnchorToken520', docIds: allIds });
    assert.equal(search520.hits.length, 1); assert.equal(search520.hits[0].docId, docs[510].id);
    const padded970 = [...allIds, ...Array.from({ length: 450 }, (_, i) => `abs-${i.toString(16).padStart(64, 'e')}`)];
    assert.equal((await svc('pages.search', { query: 'UniqueAnchorToken520', docIds: padded970 })).hits[0]?.docId, docs[510].id);
    assert.equal((await svc('library.exportRefs', { format: 'bibtex', docIds: allIds })).count, 520);
    const chat = await svc('library.chat', { docIds: allIds, question: 'Compare KV cache approaches' });
    assert.deepEqual([chat.usedDocIds.length, chat.truncatedCount, chat.answer.includes('Synthesized answer')], [30, 490, true]);
    const overCap = Array.from({ length: 5001 }, (_, i) => `abs-${i.toString(16).padStart(64, 'b')}`);
    await assert.rejects(() => svc('library.chat', { docIds: overCap, question: 'test' }), hasHttpStatus(400));
    await assert.rejects(() => svc('pages.search', { query: 'test', docIds: overCap }), hasHttpStatus(400));
    await assert.rejects(() => svc('library.bulkDelete', { docIds: overCap }), hasHttpStatus(400));
  } finally { await rm(root, { recursive: true, force: true }); }
});
