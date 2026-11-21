import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Library } from '../src/server/library.js';
import { createServices } from '../src/server/services.js';

async function libraryFor(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-pdf-outline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, library: new Library(root) };
}

const pages = [
  { page: 1, lines: [{ text: '1 Introduction', top: 0.17, prominent: true }] },
  { page: 2, lines: [{ text: 'We raised the temperature of each sample independently.', top: 0.46 }] }
];

function reply(content: string) {
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
}

test('the selected source line fixes each destination, simultaneous readers share generation, and contents survive a restart by PDF identity', async t => {
  const { root, library } = await libraryFor(t);
  const bytes = Buffer.from('%PDF-1.7\noutline storage fixture');
  const doc = await library.importPdf('Study.pdf', bytes);
  const other = await library.importPdf('Study.pdf', Buffer.from('%PDF-1.7\nother study'));
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0;
  const fetchImpl: typeof fetch = async (url, options) => {
    requests++;
    assert.equal(String(url), 'https://reader.example/v1/chat/completions');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer OUTLINE-TEST-SECRET');
    const request = JSON.parse(String(options?.body));
    assert.equal(request.model, 'configured-model');
    assert.doesNotMatch(JSON.stringify(request.messages), /OUTLINE-TEST-SECRET/);
    started.resolve();
    await release.promise;
    return reply(JSON.stringify({ entries: [
      { id: 'p2-l1', title: 'Independent temperature control', level: 3, page: 400, top: -5 },
      { id: 'p1-l1', title: 'A new name for the opening', level: 1 }
    ] }));
  };
  const act = createServices({ root, fetchImpl });
  await act('settings.save', { baseUrl: 'https://reader.example/v1', apiKey: 'OUTLINE-TEST-SECRET', model: 'configured-model' });
  assert.deepEqual(await act('outline.get', { docId: doc.id }), { entries: [] });
  const input = { docId: doc.id, pageCount: 2, pages };
  const first = act('outline.generate', input);
  await started.promise;
  const second = act('outline.generate', input);
  assert.deepEqual(await act('outline.get', { docId: doc.id }), { entries: [] });
  release.resolve();
  const expected = { entries: [
    { title: '1 Introduction', page: 1, top: 0.17, level: 1 },
    { title: 'Independent temperature control', page: 2, top: 0.46, level: 2 }
  ] };
  assert.deepEqual(await Promise.all([first, second]), [expected, expected]);
  const reopened = createServices({ root, fetchImpl });
  const renamed = await library.importPdf('Renamed.pdf', bytes);
  assert.deepEqual(await reopened('outline.get', { docId: renamed.id }), expected);
  assert.deepEqual(await reopened('outline.generate', input), expected);
  assert.deepEqual(await reopened('outline.get', { docId: other.id }), { entries: [] });
  assert.equal(requests, 1);
});

test('long PDFs cover the middle and last pages in bounded calls and a failed later chunk leaves the whole outline retryable', async t => {
  const { root, library } = await libraryFor(t);
  const doc = await library.importPdf('Long report.pdf', Buffer.from('%PDF-1.7\nlong report'));
  const total = 117;
  const longPages = Array.from({ length: total }, (_, index) => ({ page: index + 1, lines: [
    { text: `Section ${index + 1}`, top: 0.18 },
    ...Array.from({ length: 9 }, () => ({ text: '本文逐项核对每份样本在测试前后的结果。'.repeat(7), top: 0.35 }))
  ] }));
  const visited = new Set<number>();
  const pick = new Set([1, 61, 117]);
  let failOnMiddle = true, calls = 0;
  const act = createServices({ root, fetchImpl: async (_url, options) => {
    calls++;
    const message: string = JSON.parse(String(options?.body)).messages[1].content;
    assert.ok(Buffer.byteLength(message) < 40_000, 'Each completion must fit a modest context window.');
    const batch = JSON.parse(message) as { pages: { page: number; lines: { id: string }[] }[] };
    for (const page of batch.pages) visited.add(page.page);
    if (failOnMiddle && batch.pages.some(p => p.page === 61)) return reply('{"entries":[{"id":"p5000-l5","level":1}]}');
    return reply(JSON.stringify({ entries: batch.pages.filter(p => pick.has(p.page)).map(p => ({ id: p.lines[0].id, level: 1 })) }));
  } });
  await act('settings.save', { baseUrl: 'http://127.0.0.1:8301/v1' });
  const input = { docId: doc.id, pageCount: total, pages: longPages };
  await assert.rejects(act('outline.generate', input), { status: 502 });
  assert.deepEqual(await createServices({ root })('outline.get', { docId: doc.id }), { entries: [] });
  failOnMiddle = false;
  visited.clear(); calls = 0;
  assert.deepEqual((await act('outline.generate', input)).entries.map(entry => entry.page), [1, 61, 117]);
  assert.equal(visited.size, total);
  assert.ok(calls > 1);
});

test('invalid page evidence, non-PDF identities, scanned PDFs and missing models produce actionable errors without saved contents', async t => {
  const { root, library } = await libraryFor(t);
  const act = createServices({ root });
  const docId = (await library.importPdf('Notes.pdf', Buffer.from('%PDF-1.7\nnotes'))).id;
  const article = await library.importWeb({ url: 'https://example.org', paragraphs: ['Article body.'] });
  await assert.rejects(act('outline.generate', { docId: article.id, pages, pageCount: 2 }), { status: 415 });
  await assert.rejects(act('outline.get', { docId: 'pdf-' + '0'.repeat(64) }), { status: 404 });
  for (const invalid of [
    { pages, pageCount: 3 }, { pages: [pages[1], pages[1]], pageCount: 2 },
    { pages: [{ page: 1, lines: [{ text: 'Introduction', top: -0.1 }] }], pageCount: 1 }
  ]) await assert.rejects(act('outline.generate', { docId, ...invalid }), { status: 400 });
  await assert.rejects(act('outline.generate', { docId, pageCount: 1, pages: [{ page: 1, lines: [] }] }), { status: 422, message: /OCR/ });
  await assert.rejects(act('outline.generate', { docId, pages, pageCount: 2 }), { status: 503, message: /Settings/ });
  assert.deepEqual(await act('outline.get', { docId }), { entries: [] });
});

test('a DSH model can generate contents after returning malformed or empty output for an earlier attempt', async t => {
  const { root, library } = await libraryFor(t);
  const docId = (await library.importPdf('DSH.pdf', Buffer.from('%PDF-1.7\nDSH'))).id;
  let answer = 'broken JSON';
  const act = createServices({ root, ctx: { llm: {
    listProviders: () => [{ id: 'lab' }], listModels: () => [{ id: 'text-model', inputModalities: ['text'] }],
    async *stream(request: { provider: string; model: string; messages: { content: { text: string }[] }[] }) {
      assert.equal(request.provider, 'lab');
      assert.equal(request.model, 'text-model');
      assert.equal(JSON.parse(request.messages[0].content[0].text).pages[0].lines[0].text, '1 Introduction');
      yield { type: 'text-delta', text: answer };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  } } });
  const input = { docId, pages, pageCount: 2 };
  for (const invalid of ['broken JSON', '{"entries":[]}', '{"entries":[{"id":"p1-l1","level":0}]}']) {
    answer = invalid;
    await assert.rejects(act('outline.generate', input), { status: 502 });
    assert.deepEqual(await act('outline.get', { docId }), { entries: [] });
  }
  answer = '```json\n{"entries":[{"id":"p1-l1","level":1}]}\n```';
  assert.deepEqual(await act('outline.generate', input), { entries: [{ page: 1, title: '1 Introduction', top: 0.17, level: 1 }] });
});
