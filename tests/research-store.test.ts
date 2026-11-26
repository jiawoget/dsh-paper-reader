import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CreateAbstractInput, DocPageHit, TopicRecord } from '../src/shared/types.js';
import { abstractDocId } from '../src/server/abstract-library.js';
import { apply } from '../src/server/index.js';
import { Library } from '../src/server/library.js';
import { extractDocumentPages, extractPdfPages } from '../src/server/pdf-text.js';
import { ReaderStore } from '../src/server/reader-store.js';
import {
  buildFtsQuery, deleteTopic, getDocPages, hasDocPages,
  listTopics, replaceDocPages, saveTopic, searchDocPagesFts, segmentFtsText
} from '../src/server/research-store.js';
import { createServices } from '../src/server/services.js';

const samplePdfPath = path.resolve('public/assets/pagedattention.pdf');

test('abstract-only creation deduplicates by DOI, preserves docId/tags/notes across Attach PDF, and rejects corrupt PDFs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-abstract-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root);
  const library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root, library, store });
  const input: CreateAbstractInput = {
    title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity',
    paperTitle: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity',
    authors: 'Wilding et al.', venue: 'NEJM', year: '2021', doi: '10.1056/NEJMoa2032183',
    abstract: 'Semaglutide reduced body weight in adults with obesity without diabetes.'
  };
  const expectedId = abstractDocId(input);
  assert.match(expectedId, /^abs-[a-f0-9]{64}$/);
  const first = await act('library.createAbstract', input);
  assert.equal(first.doc.id, expectedId);
  assert.equal(first.doc.kind, 'abstract');
  assert.equal(store.withDb(false, db => hasDocPages(db, expectedId)), true);

  const dup = await act('library.createAbstract', {
    title: input.title, doi: 'https://doi.org/10.1056/NEJMoa2032183', publisher: 'Massachusetts Medical Society'
  });
  assert.equal(dup.doc.id, expectedId);
  assert.equal(dup.doc.publisher, 'Massachusetts Medical Society');

  await act('library.triage', { docId: expectedId, status: 'reading', starred: true, tags: ['glp-1', 'clinical'] });
  const savedNote = await act('note.save', {
    docId: expectedId, title: input.title, page: 1, anchor: 'abstract', label: 'Abstract',
    sourceUrl: `http://127.0.0.1:29812/api/paper-reader/app/index.html?doc=${expectedId}&page=1`,
    quote: 'Semaglutide reduced body weight', text: 'Key phase 3 clinical endpoint'
  });

  await assert.rejects(
    library.attachPdf(expectedId, Buffer.from('%PDF-1.7\ncorrupt non-pdf body')),
    (err: unknown) => err instanceof Error && 'status' in err && (err as { status: number }).status === 400
  );
  assert.equal((await library.get(expectedId)).kind, 'abstract');
  assert.equal(existsSync(path.join(root, 'documents', expectedId + '.pdf')), false);

  const pdfBytes = await readFile(samplePdfPath);
  const race = await Promise.allSettled([library.attachPdf(expectedId, pdfBytes), library.attachPdf(expectedId, pdfBytes)]);
  const fulfilled = race.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<Library['attachPdf']>>> => r.status === 'fulfilled');
  const rejected = race.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof Error && 'status' in rejected[0].reason && rejected[0].reason.status === 400);
  const attached = fulfilled[0].value;
  store.withDb(true, db => replaceDocPages(db, attached.doc.id, attached.pages));
  assert.equal(attached.doc.id, expectedId);
  assert.equal(attached.doc.kind, 'pdf');
  assert.equal(attached.doc.doi, '10.1056/NEJMoa2032183');
  assert.equal(attached.pages.length, 16);
  assert.equal(existsSync(path.join(root, 'documents', expectedId + '.pdf')), true);
  assert.equal((await act('library.createAbstract', { title: input.title, doi: input.doi })).doc.kind, 'pdf');

  const afterGet = await act('library.get', { id: expectedId });
  assert.equal(afterGet.doc.kind, 'pdf');
  assert.equal(afterGet.doc.meta?.status, 'reading');
  assert.equal(afterGet.doc.meta?.starred, true);
  assert.deepEqual(afterGet.doc.meta?.tags, ['glp-1', 'clinical']);
  assert.equal(store.state().notes.some(n => n.id === savedNote.note.id && n.docId === expectedId), true);

  const hits: DocPageHit[] = (await act('pages.search', { query: '"block table"', docIds: [expectedId] })).hits;
  assert.ok(hits.some(h => h.docId === expectedId && h.page === 6 && h.docKind === 'pdf'));

  await act('library.delete', { id: expectedId });
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true });
  t.after(() => db.close());
  for (const table of ['doc_pages', 'doc_pages_fts', 'doc_meta', 'entries']) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE docId=?`).get(expectedId) as { n: number };
    assert.equal(Number(row.n), 0, `${table} should have 0 orphan rows`);
  }
});

test('server-side PagedAttention extraction and bilingual FTS5 search handle EN, ZH, and special operators', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-fts-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root);
  const library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root, library, store });

  assert.equal((await extractPdfPages(await readFile(samplePdfPath))).length, 16);
  const indexed = await act('pages.index', { docId: 'pagedattention', force: true });
  assert.deepEqual(indexed, { indexed: 1, pages: 16 });
  assert.equal(store.withDb(false, db => getDocPages(db, 'pagedattention')).length, 16);
  assert.ok((await act('pages.search', { query: '"block table"' })).hits.some(h => h.docId === 'pagedattention' && h.page === 6));
  assert.ok((await act('pages.search', { query: 'KV cache' })).hits.some(h => h.docId === 'pagedattention' && h.page === 1));

  const web = await act('web.import', {
    url: 'https://example.org/zh-paged', title: '虚拟内存分页综述',
    paragraphs: ['本文分析大语言模型推理中的虚拟内存分页、KV缓存、LLM推理与GLP1抑制剂优化。']
  });
  assert.equal((await extractDocumentPages(web.doc)).length, 1);
  assert.equal(segmentFtsText('虚拟内存分页'), '虚 拟 内 存 分 页');
  assert.equal(buildFtsQuery('KV缓存'), '"KV" "缓 存"');
  for (const query of ['分页', 'KV缓存', 'LLM推理', 'GLP1抑制剂']) {
    assert.ok((await act('pages.search', { query })).hits.some(h => h.docId === web.doc.id && h.page === 1), query);
  }
  assert.equal(buildFtsQuery('*** ??? ---'), '');
  assert.ok(Array.isArray(store.withDb(false, db => searchDocPagesFts(db, 'NOT (KV:cache) "unclosed * ^ GLP-1'))));
});

test('topics CRUD supports list, create, update, and delete', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-topics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root);
  const act = createServices({ root, store });
  assert.deepEqual((await act('topics.list', {})).topics, []);
  const created: TopicRecord = (await act('topics.save', {
    name: 'LLM Serving', tag: 'llm-serving', zoteroCollection: 'COL123', description: 'KV cache and scheduling papers'
  })).topic;
  assert.equal(created.name, 'LLM Serving');
  const updated = store.withDb(true, db => saveTopic(db, {
    id: created.id, name: 'LLM Serving Systems', tag: 'llm-serving', zoteroCollection: 'COL123', description: 'Updated'
  }));
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(store.withDb(false, listTopics).length, 1);
  const longTopic: TopicRecord = (await act('topics.save', {
    name: 'Large Language Model Serving and KV Cache Memory Management'
  })).topic;
  assert.equal(longTopic.tag, 'Large Language Model Serving and KV Cach');
  await act('topics.delete', { id: longTopic.id });
  assert.deepEqual(await act('topics.delete', { id: created.id }), { id: created.id, deleted: true });
  assert.deepEqual(store.withDb(true, db => deleteTopic(db, created.id)), { id: created.id, deleted: false });
  assert.deepEqual((await act('topics.list', {})).topics, []);
});

test('HTTP attach-pdf and import-pdf routes validate inputs, upgrade stubs, and populate FTS5', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-http-attach-'));
  const prevHome = process.env.PAPER_READER_HOME;
  process.env.PAPER_READER_HOME = root;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.PAPER_READER_HOME;
    else process.env.PAPER_READER_HOME = prevHome;
    await rm(root, { recursive: true, force: true });
  });
  const routes = new Map<string, (req: Request) => Promise<Response>>();
  apply({
    connection: { fetch: { register: r => routes.set(r.path, r.fetch) } },
    inject: () => () => {}
  });
  const call = (p: string, init: RequestInit) => routes.get(p)!(new Request('http://dsh.internal' + p + (init.method === 'POST' ? '' : ''), init));
  const action = (op: string, payload: Record<string, unknown>) =>
    routes.get('/api/paper-reader/action')!(new Request('http://dsh.internal/api/paper-reader/action', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, payload })
    }));
  const created = await (await action('library.createAbstract', { title: 'Paywalled Trial', doi: '10.1056/NEJMoa2032183' })).json() as { doc: { id: string } };
  const attachUrl = `http://dsh.internal/api/paper-reader/attach-pdf?id=${created.doc.id}`;
  const attach = routes.get('/api/paper-reader/attach-pdf')!;

  assert.equal((await attach(new Request(attachUrl, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'bad' }))).status, 415);
  assert.equal((await attach(new Request(attachUrl, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.7\nbroken' }))).status, 400);

  const pdfBytes = await readFile(samplePdfPath);
  const ok = await attach(new Request(attachUrl, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdfBytes }));
  assert.equal(ok.status, 200);
  const body = await ok.json() as { doc: { id: string; kind: string }; pages: number };
  assert.equal(body.doc.id, created.doc.id);
  assert.equal(body.doc.kind, 'pdf');
  assert.equal(body.pages, 16);

  const imp = await call('/api/paper-reader/import-pdf', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdfBytes });
  assert.equal(imp.status, 200);
  const searched = await (await action('pages.search', { query: '"block table"', docIds: [created.doc.id] })).json() as { hits: DocPageHit[] };
  assert.ok(searched.hits.some(h => h.docId === created.doc.id && h.page === 6));
});
