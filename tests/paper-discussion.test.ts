import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServices } from '../src/server/services.js';
import { paperEvidence } from '../src/reader/paper-evidence.js';

test('large papers retain distributed evidence on a tie and retrieve a distant passage using an English search expansion', () => {
  const pages = Array.from({ length: 180 }, (_, i) => ({
    page: i + 1, text: 'An ordinary observation. '.repeat(80) + (i === 142 ? ' A quokka-graded localization result was 3.09.' : '')
  }));
  const overview = paperEvidence('Long paper', pages, '概括全文。');
  assert.ok(overview.partial);
  const sampled = new Set(overview.excerpts.map(e => e.page));
  assert.ok([...sampled].filter(p => p > 90).length >= 17, 'A query without hits should distribute the budget across the entire paper.');
  const specific = paperEvidence('Long paper', pages, '定位的结果是多少？ quokka graded localization');
  assert.ok(specific.excerpts.some(p => p.page === 143 && p.text.includes('3.09')));
});

test('paper answers use evidence from other pages and persist alongside passage chat across service restarts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-discussion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, options) => {
    calls++;
    const packet = JSON.parse(String(options?.body));
    const data = JSON.parse(packet.messages[1].content);
    if (calls === 1) assert.equal(data.paper.excerpts[1].text, 'Our test set contains 732 questions.');
    if (calls === 3) assert.match(JSON.stringify(data.history), /732 questions/);
    return Response.json({ choices: [{ message: { content: 'The evaluation used 732 questions.' }, finish_reason: 'stop' }] });
  };
  const service = createServices({ root, fetchImpl });
  await service('settings.save', { baseUrl: 'http://127.0.0.1:4142', model: 'reading-test' });
  const paper = { title: 'Methods', pageCount: 2, partial: false, excerpts: [
    { page: 1, text: 'This paper compares methods.' }, { page: 2, text: 'Our test set contains 732 questions.' }
  ] };
  const ask = { docId: 'methods', requestId: randomUUID(), question: 'How many evaluation questions?', paper };
  await Promise.all([service('chat.ask', ask), service('chat.ask', ask)]);
  const source = { docId: 'methods', title: 'Methods', page: 2, anchor: 'p2-b3', label: 'Methods',
    sourceUrl: 'http://localhost:29812/api/paper-reader/app/index.html?doc=methods&page=2&anchor=p2-b3',
    selected: 'test set', original: 'test set', context: 'Our test set contains 732 questions.', side: 'source' };
  const record = { docId: 'methods', thread: 'selection-' + 'a'.repeat(64), requestId: randomUUID(), question: 'Explain the test set.', source };
  await service('ai', { mode: 'followup', text: 'test set', question: record.question, context: source.context, record });
  const reopened = createServices({ root, fetchImpl });
  await reopened('chat.ask', ask);
  assert.equal(calls, 2);
  const log = await reopened('chat.history', { docId: 'methods' });
  assert.deepEqual(log.exchanges.map(turn => [turn.question, turn.thread, turn.source?.page]), [
    [ask.question, 'paper', undefined], [record.question, record.thread, 2]
  ]);
  assert.deepEqual((await reopened('chat.history', { docId: 'other' })).exchanges, []);
  await reopened('chat.ask', { ...ask, requestId: randomUUID(), question: 'How many did you say?' });
  assert.equal(calls, 3);
});

test('desktop connection tests are read-only and filing uses an instance-bound key confirmed by Zotero', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-zotero-desktop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let authorized = 0, changed = false;
  const headers = { 'Zotero-Server-ID': 'disposable-instance', 'Zotero-API-Version': '3' };
  const service = createServices({ root, fetchImpl: async (raw, options) => {
    const url = new URL(String(raw)), h = new Headers(options?.headers);
    assert.equal(url.origin, 'http://127.0.0.1:23119');
    assert.notEqual(h.get('Zotero-API-Key'), 'WEB-CREDENTIAL');
    if (url.pathname === '/api/') return new Response('Zotero API', { headers });
    if (url.pathname === '/api/local/authorize') {
      assert.equal(h.get('Zotero-Server-ID'), 'disposable-instance');
      authorized++;
      return Response.json({ key: 'local-token', remember: true }, { headers });
    }
    const item = { key: 'ITEM2345', version: 5, data: { itemType: 'book', title: 'Methods', collections: changed ? ['READINGS'] : [] } };
    if (url.pathname === '/api/users/0/items/top') return Response.json([item], { headers });
    if (url.pathname === '/api/users/0/items/ITEM2345' && options?.method === 'PATCH') {
      assert.equal(h.get('Zotero-API-Key'), 'local-token');
      assert.equal(h.get('Zotero-Server-ID'), 'disposable-instance');
      changed = true;
      return new Response(null, { status: 204, headers });
    }
    if (url.pathname === '/api/users/0/items/ITEM2345') return Response.json(item, { headers });
    throw Error('Unexpected Zotero endpoint ' + url.pathname);
  } });
  await service('settings.save', { zoteroMode: 'desktop', zoteroApiKey: 'WEB-CREDENTIAL' });
  const status = await service('zotero.status', {});
  assert.equal(status.connected, true);
  assert.equal(status.access, 'confirm');
  await service('zotero.link', { docId: 'paper', key: 'ITEM2345' });
  assert.equal(authorized, 0);
  await service('zotero.save', { docId: 'paper', key: 'ITEM2345', collections: ['READINGS'] });
  assert.equal(authorized, 1);
  assert.deepEqual((await service('zotero.get', { docId: 'paper' })).item?.collections, ['READINGS']);
  assert.doesNotMatch(JSON.stringify(await service('state')), /WEB-CREDENTIAL|local-token/);
});

test('an existing reader can keep using its v2 database alongside a paper conversation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createServices({ root });
  await service('history.add', { docId: 'previous', page: 1, text: 'Prior lookup', meaning: 'Previous result.' });
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2, 'Already-open v0.1 readers accept schema versions through 2.');
    db.exec('DROP TABLE chat_exchanges; DROP TABLE zotero_authorizations');
  } finally { db.close(); }
  assert.deepEqual((await createServices({ root })('chat.history', { docId: 'previous' })).exchanges, []);
  assert.equal((await service('state')).history[0]?.meaning, 'Previous result.');
});

test('a public web library needs only its ID to search and link, and cannot file without a write credential', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-public-zotero-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reference = { key: 'X42A7DEE', version: 4, data: { itemType: 'book', title: 'Microscopy', collections: [] } };
  const service = createServices({ root, fetchImpl: async (raw, options) => {
    const url = new URL(String(raw));
    assert.equal(url.origin, 'https://api.zotero.org');
    assert.equal(new Headers(options?.headers).has('Zotero-API-Key'), false);
    assert.equal(options?.method ?? 'GET', 'GET');
    return Response.json(url.pathname.endsWith('/X42A7DEE') ? reference : [reference]);
  } });
  await service('settings.save', { zoteroMode: 'web', zoteroLibraryId: '475425' });
  assert.equal((await service('zotero.status')).access, 'read');
  assert.equal((await service('zotero.search', { query: 'microscopy' })).items[0].title, 'Microscopy');
  await service('zotero.link', { docId: 'reading', key: 'X42A7DEE' });
  assert.equal((await service('zotero.get', { docId: 'reading' })).item?.key, 'X42A7DEE');
  await assert.rejects(service('zotero.save', { title: 'New', collections: [] }), { status: 403 });
});
