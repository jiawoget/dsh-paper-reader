import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServices, type ServiceOptions } from '../src/server/services.js';
import { Library } from '../src/server/library.js';

const passage = {
  docId: 'attention', page: 6, anchor: 'p6:11', title: 'Attention',
  sourceUrl: 'http://127.0.0.1:29812/api/paper-reader/app/index.html?doc=attention&page=6&anchor=p6%3A11'
};

if (process.argv[2] === '--concurrent-note-writer') {
  const [, , , root, label] = process.argv;
  const act = createServices({ root });
  for (let n = 0; n < 8; n++) {
    await act('note.save', { docId: 'paper', page: 1, anchor: 'word', text: '    note ' + label + '-' + n + '\n' });
  }
  process.exit(0);
}

async function setup(t: TestContext, options: Omit<ServiceOptions, 'root'> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-reader-ts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, act: createServices({ root, ...options }) };
}

test('different passages retain independent notes, vocabulary and history across database reopen', async t => {
  const { act, root } = await setup(t);
  const { note } = await act('note.save', { ...passage, label: 'Method', quote: 'Physical pages', text: 'Draft' });
  const second = createServices({ root });
  await second('note.save', { id: note.id, text: 'Blocks are non-contiguous' });
  const word = { ...passage, text: 'paging', meaning: 'paged memory allocation', context: 'cache paging' };
  const { word: first } = await act('vocab.save', word);
  const { word: duplicate } = await second('vocab.save', { ...word, text: 'Paging' });
  assert.equal(first.id, duplicate.id);
  await Promise.all([act('vocab.save', { ...word, anchor: 'p6:12' }), second('history.add', { text: 'browser lookup', sourceUrl: 'https://arxiv.org/' })]);
  const reopened = await createServices({ root })('state');
  assert.equal(reopened.notes[0]?.createdAt, note.createdAt);
  assert.equal(reopened.notes[0]?.sourceUrl, passage.sourceUrl);
  assert.equal(reopened.notes[0]?.quote, 'Physical pages');
  assert.equal(reopened.notes[0]?.text, 'Blocks are non-contiguous');
  assert.equal(reopened.vocabulary.length, 2);
  assert.equal(reopened.history[0]?.docId, '');
  await act('vocab.delete', { id: first.id });
  await second('note.delete', { id: note.id });
  assert.equal((await act('state')).notes.length, 0);
  await assert.rejects(act('note.save', { id: note.id, text: 'lost update' }), { status: 404 });
  for (const change of [{ page: 0 }, { sourceUrl: 'data:text/plain,x' }, { docId: {} }]) {
    await assert.rejects(act('note.save', { ...passage, ...change, text: 'x' }), { status: 400 });
  }
});

test('private settings are revision-safe, allow key removal and prevent a key from crossing origins', async t => {
  const { act } = await setup(t);
  const secrets = { apiKey: 'TEST-CREDENTIAL-01', zoteroApiKey: 'TEST-CREDENTIAL-02' };
  await act('settings.save', { ...secrets, baseUrl: 'https://model.example/v1', zoteroLibraryId: '88' });
  await act('settings.save', { apiKey: '', zoteroApiKey: '', model: 'actual-model' });
  const state = await act('state');
  assert.equal(state.settings.hasApiKey, true);
  assert.equal(state.settings.hasZoteroKey, true);
  assert.doesNotMatch(JSON.stringify(state), /TEST-CREDENTIAL/);
  await assert.rejects(act('settings.save', { apiKey: 'line1\nline2' }), { status: 400 });
  await assert.rejects(act('settings.save', { baseUrl: 'https://other:password@host.example/' }), { status: 400 });
  await assert.rejects(act('settings.save', { vaultPath: 'relative/path' }), { status: 400 });
  const changed = await act('settings.save', { baseUrl: 'https://another.example/v1', clearZoteroKey: true });
  assert.equal(changed.settings.hasApiKey, false);
  assert.equal(changed.settings.hasZoteroKey, false);
  await assert.rejects(act('ai', { mode: 'translate', text: 'no key' }), { status: 503 });
  assert.equal((await act('settings.save', { zoteroLibraryId: '' })).settings.zoteroMode, 'desktop');
  assert.equal((await act('zotero.status', { zoteroMode: 'web' })).connected, false);
});

test('simultaneous reader processes retain every note with its Markdown formatting', async t => {
  const { act, root } = await setup(t);
  const run = promisify(execFile);
  const worker = fileURLToPath(import.meta.url);
  await Promise.all(['one', 'two', 'three'].map(label => run(process.execPath, ['--import', 'tsx', worker, '--concurrent-note-writer', root, label])));
  const { notes } = await act('state');
  assert.equal(notes.length, 24);
  assert.ok(notes.some(note => note.text === '    note three-4\n'));
});

test('Markdown export preserves journal edits and reconnects to each saved passage', async t => {
  const { act, root } = await setup(t);
  const vaultPath = path.join(root, 'Notes');
  await mkdir(vaultPath);
  await act('settings.save', { vaultPath });
  const { note } = await act('note.save', { ...passage, quote: 'Cache pages', text: 'Review this argument' });
  await act('vocab.save', { ...passage, text: 'cache', meaning: 'cached data' });
  const exported = await act('obsidian.export', { ...passage, title: '../../Attention' });
  assert.equal(path.dirname(exported.path), path.join(vaultPath, 'Paper Reader'));
  const markdown = await readFile(exported.path, 'utf8');
  assert.doesNotMatch(markdown, /127\.0\.0\.1|Open in Paper Reader/);
  assert.match(markdown, /Page 6/);
  assert.match(markdown, /cached data/);
  await writeFile(exported.path, markdown.replace('Review this argument', 'Comparison with another paper'));
  await appendFile(exported.path, '\n### Journal\nA handwritten thought.\n');
  await act('note.save', { id: note.id, text: 'Revised in the reader' });
  const saved = await act('obsidian.export', { ...passage, title: 'Attention revised' });
  assert.equal(saved.path, exported.path);
  const merged = await readFile(saved.path, 'utf8');
  for (const content of ['A handwritten thought.', 'Comparison with another paper', 'Revised in the reader']) assert.ok(merged.includes(content));
  await act('obsidian.export', { ...passage, title: 'Attention revised' });
  assert.equal(await readFile(saved.path, 'utf8'), merged);
  const published = await act('obsidian.export', { ...passage, sourceUrl: 'https://journal.example/paper' });
  const linked = await readFile(published.path, 'utf8');
  assert.ok(linked.includes('https://journal.example/paper'));
  assert.doesNotMatch(linked, /journal\.example\/api\/paper-reader/);
});

test('exported web citations use a publisher text fragment and a portable copy while the stored quote keeps its full text', async t => {
  const { act, root } = await setup(t);
  const vaultPath = path.join(root, 'Vault');
  await mkdir(vaultPath);
  await act('settings.save', { vaultPath });
  const quote = 'block tables & "physical+blocks"';
  const doc = await new Library(root).importWeb({ url:'https://journal.example/paper', title:'Attention', paragraphs:[quote] });
  const sourceUrl = 'http://localhost:30617/api/paper-reader/app/index.html?doc=' + doc.id;
  const request = { docId: doc.id, title: 'Attention', sourceUrl };
  await act('note.save', { ...request, page:6, anchor: 'p-1', quote, text: 'How the physical block references work.' });
  const file = await act('obsidian.export', request);
  const md = await readFile(file.path, 'utf8');
  const destination = md.match(/\[Page 6\]\(<([^>]+)>\)/)?.[1];
  assert.ok(destination);
  assert.match(destination, /%26/);
  assert.match(destination, /%2B/i);
  const link = new URL(destination);
  assert.equal(link.origin, 'https://journal.example');
  assert.equal(link.pathname, '/paper');
  assert.equal(decodeURIComponent(link.hash), '#:~:text=' + quote);
  assert.match(md, /\[Library copy\]/);
  const longQuote = 'block tables '.repeat(1000);
  await act('note.save', { ...request, page:6, anchor: 'p-1', quote: longQuote, text: 'Another passage' });
  await act('obsidian.export', request);
  const all = [...(await readFile(file.path, 'utf8')).matchAll(/\[Page 6\]\(<([^>]+)>\)/g)].map(match => new URL(match[1]));
  const excerpt = all.map(url => decodeURIComponent(url.hash).slice('#:~:text='.length)).find(value => value.startsWith('block tables block tables'));
  assert.ok(excerpt && excerpt.length <= 320 && longQuote.startsWith(excerpt));
  assert.equal((await act('state')).notes.find(n=>n.text==='Another passage')?.quote,longQuote);
});

test('OpenAI-compatible requests include selection and prior conversation, exact block IDs are checked', async t => {
  let reply = 'cached data';
  const bodies: string[] = [];
  const { act } = await setup(t, { fetchImpl: async (input, init) => {
    assert.equal(String(input), 'https://model.example/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer TEST-KEY');
    bodies.push(String(init?.body));
    return Response.json({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
  } });
  await act('settings.save', { baseUrl: 'https://model.example/v1', apiKey: 'TEST-KEY', model: 'paper-model' });
  assert.deepEqual(await act('ai', { mode: 'followup', text: 'cache', context: 'its pages', question: 'Why?',
    answerQuote: 'some pages', history: [{ role: 'assistant', content: 'First reply.' }] }), { text: 'cached data' });
  for (const text of ['paper-model', 'cache', 'its pages', 'Why?', 'First reply.']) assert.ok(bodies[0]?.includes(text));
  assert.equal(JSON.parse(JSON.parse(bodies[0]!).messages[1].content).answerQuote, 'some pages');
  const blocks = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }];
  reply = '{"translations":{"b":"second","a":"first"}}';
  assert.deepEqual(await act('ai.blocks', { blocks }), { translations: { a: 'first', b: 'second' } });
  reply = '{"translations":{"a":"first"}}';
  await assert.rejects(act('ai.blocks', { blocks }), { status: 502 });
});

test('a loopback model works through HTTP with no invented bearer token', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, undefined);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Local answer' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const host = server.address();
  assert.ok(host && typeof host === 'object');
  const { act } = await setup(t);
  const { settings } = await act('settings.save', { baseUrl: 'http://127.0.0.1:' + host.port + '/v1', model: 'local-test' });
  assert.equal(settings.aiMode, 'api');
  assert.equal(settings.hasApiKey, false);
  assert.equal((await act('ai', { mode: 'translate', text: 'A test sentence' })).text, 'Local answer');
});

test('DSH one-shot requests consume final text and report missing native credentials', async t => {
  let accepted = true;
  let failureCode = 'MISSING_CREDENTIAL';
  const ctx = { llm: {
    listProviders: () => [{ id: 'host-provider' }],
    listModels: async () => [{ id: 'host-model' }],
    async *stream(request: unknown) {
      assert.ok(JSON.stringify(request).includes('host-model'));
      yield { type: 'reasoning-delta', text: 'reasoning' };
      yield { type: 'text-delta', text: 'Term explained' };
      yield { type: 'finish', reason: accepted ? { kind: 'stop' } : { kind: 'error', failure: { code: failureCode } } };
    }
  } };
  const { act } = await setup(t, { ctx });
  assert.equal((await act('state')).settings.aiMode, 'dsh');
  assert.deepEqual(await act('ai', { mode: 'explain', text: 'pages' }), { text: 'Term explained' });
  accepted = false;
  for (const code of ['MISSING_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID']) {
    failureCode = code;
    await assert.rejects(act('ai', { mode: 'translate', text: 'pages' }), { status: 503 });
  }
});

test('Zotero collection paging, metadata search, additive writes and optimistic concurrency use Web API v3', async t => {
  let version = 7;
  const writes: string[][] = [];
  const { act } = await setup(t, { fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(url.origin, 'https://api.zotero.org');
    assert.ok(url.pathname.startsWith('/groups/88/'));
    assert.equal(headers.get('Zotero-API-Version'), '3');
    assert.equal(headers.get('Zotero-API-Key'), 'TEST-ZOTERO');
    const prior = version === 7 ? ['EXISTING'] : ['EXISTING', 'THIRDPAR'];
    const item = { key: 'ITEM2345', version, data: { itemType: 'journalArticle', title: 'Cache', collections: prior } };
    if (url.pathname.endsWith('/collections')) {
      const first = Number(url.searchParams.get('start') ?? '0') === 0;
      return Response.json([{ key: first ? 'EXISTING' : 'READINGS', data: { name: first ? 'Personal' : 'Reading', parentCollection: false } }], { headers: { 'Total-Results': '2' } });
    }
    if (url.pathname.endsWith('/items/top')) {
      assert.equal(url.searchParams.get('q'), 'Cache');
      return Response.json([item]);
    }
    assert.ok(url.pathname.endsWith('/items/ITEM2345'));
    if (init?.method !== 'PATCH') return Response.json(item);
    assert.equal(headers.get('If-Unmodified-Since-Version'), String(version));
    const body: unknown = JSON.parse(String(init.body));
    assert.deepEqual(body, { collections: [...prior, 'READINGS'] });
    writes.push(prior);
    return new Response(null, { status: version++ === 7 ? 412 : 204 });
  } });
  await act('settings.save', { zoteroApiKey: 'TEST-ZOTERO', zoteroLibraryId: '88', zoteroLibraryType: 'group' });
  assert.deepEqual((await act('zotero.collections')).collections.map(row => row.name), ['Personal', 'Reading']);
  assert.equal((await act('zotero.search', { query: 'Cache' })).items[0]?.title, 'Cache');
  const saved = await act('zotero.save', { docId: 'paper', key: 'ITEM2345', collections: ['READINGS'] });
  assert.deepEqual(saved.collections, ['EXISTING', 'THIRDPAR', 'READINGS']);
  assert.equal(writes.length, 2);
  const linked = await act('zotero.get', { docId: 'paper' });
  assert.equal(linked.item?.key, 'ITEM2345');
  assert.deepEqual(await act('zotero.get', { docId: 'another-paper' }), { item: null });
});

test('an interrupted Zotero creation is retried using its reserved key without an extra remote item', async t => {
  let issued = '';
  let attempts = 0;
  const { act } = await setup(t, { fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/items/top')) return Response.json([]);
    if (init?.method === 'POST') {
      attempts++;
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(Array.isArray(body));
      const first: unknown = body[0];
      assert.ok(first && typeof first === 'object' && 'key' in first && typeof first.key === 'string');
      assert.ok('DOI' in first && first.DOI === '10.1000/cache');
      issued = first.key;
      throw new Error('connection interrupted after upstream saved the item');
    }
    if (issued && url.pathname.endsWith('/' + issued)) {
      return Response.json({ key: issued, version: 2, data: { title: 'Cache', itemType: 'journalArticle', collections: ['READINGS'] } });
    }
    return new Response(null, { status: 404 });
  } });
  await act('settings.save', { zoteroApiKey: 'TEST-ZOTERO', zoteroLibraryId: '88' });
  const paper = { title: 'Cache', doi: '10.1000/cache', url: 'https://doi.org/10.1000/cache', collections: ['READINGS'] };
  await assert.rejects(act('zotero.save', paper), { status: 502 });
  assert.equal((await act('zotero.save', paper)).key, issued);
  assert.equal(attempts, 1);
});

test('a Zotero save only succeeds after its per-item response confirms the requested key', async t => {
  let allow = false;
  let objectKey = '';
  const { act } = await setup(t, { fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/items/top')) return Response.json([]);
    if (init?.method !== 'POST') return new Response(null, { status: 404 });
    const packet: unknown = JSON.parse(String(init.body));
    assert.ok(Array.isArray(packet));
    const proposed: unknown = packet[0];
    assert.ok(proposed && typeof proposed === 'object' && 'key' in proposed && typeof proposed.key === 'string');
    objectKey = proposed.key;
    if (!allow) return Response.json({ successful: {}, failed: { '0': { code: 403, message: 'sensitive upstream diagnostic' } } });
    return Response.json({ successful: { '0': { key: objectKey, data: proposed, version: 3 } }, failed: {} });
  } });
  await act('settings.save', { zoteroApiKey: 'SAMPLE', zoteroLibraryId: '77' });
  const paper = { title: 'A test article', doi: '10.1000/example', collections: [] };
  await assert.rejects(act('zotero.save', paper), (error: unknown) => {
    assert.ok(error instanceof Error && 'status' in error && error.status === 403);
    assert.doesNotMatch(error.message, /sensitive upstream diagnostic/);
    return true;
  });
  allow = true;
  assert.deepEqual(await act('zotero.save', paper), { created: true, key: objectKey, collections: [] });
});

test('chat.delete validates docId, requestId, and thread inputs', async t => {
  const { act } = await setup(t);
  await assert.rejects(act('chat.delete', { thread: 'paper' }), { status: 400 });
  await assert.rejects(act('chat.delete', { docId: 'doc1' }), { status: 400 });
  await assert.rejects(act('chat.delete', { docId: 'doc1', requestId: 'not-a-uuid' }), { status: 400 });
  await assert.rejects(act('chat.delete', { docId: 'doc1', thread: 'invalid-thread' }), { status: 400 });
  assert.deepEqual(await act('chat.delete', { docId: 'doc1', requestId: '11111111-1111-4111-8111-111111111111' }), { deleted: 0 });
});
