import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createServices } from '../src/server/services.js';
import { Library } from '../src/server/library.js';

const desktop = 'http://127.0.0.1:23119';
const parent = 'PAPER222', child = 'PDF22222', folder = 'FLDR2222';
function item(key: string, itemType: string, data: Record<string, unknown> = {}) {
  return { key, version: 2, data: { key, itemType, title: 'The paper', collections: [], ...data } };
}
function instance(id: string) {
  return new Response('{}', { headers: { 'Zotero-API-Version': '3', 'Zotero-Server-ID': id } });
}
async function setup(t: TestContext, handler: (url: URL, options: RequestInit) => Response | Promise<Response>) {
  const root = await mkdtemp(path.join(tmpdir(), 'zotero-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const act = createServices({ root, fetchImpl: (url, options) => Promise.resolve(handler(new URL(String(url)), options ?? {})) });
  return { root, act };
}

test('the default library reads real item metadata and scoped collection pages with raw offsets', async t => {
  const { act } = await setup(t, (url, options) => {
    assert.equal(url.origin, desktop);
    if (url.pathname === '/api/') return instance('desktopA');
    assert.equal(new Headers(options.headers).get('Zotero-Server-ID'), 'desktopA');
    if (url.pathname.endsWith('/collections')) return Response.json([
      { key: 'PARENT22', data: { name: 'Reading', parentCollection: false } },
      { key: folder, links: { alternate: { href: 'https://www.zotero.org/users/88/collections/' + folder } },
        data: { name: 'Papers', parentCollection: 'PARENT22' } }
    ]);
    assert.equal(url.pathname, '/api/users/0/collections/' + folder + '/items/top');
    assert.equal(url.searchParams.get('q'), 'The');
    const records = url.searchParams.get('start') === '0' ? [
      item('NTE22222', 'note', { collections: undefined }), item(parent, 'journalArticle'),
      item('ANN22222', 'annotation', { collections: undefined })
    ] : [item(child, 'attachment', { title: 'Standalone', contentType: 'application/pdf' })];
    return Response.json(records, { headers: { 'Total-Results': '4' } });
  });
  assert.equal((await act('state')).settings.zoteroMode, 'desktop');
  const collections = await act('zotero.collections');
  assert.equal(collections.collections[1]?.parentCollection, 'PARENT22');
  assert.equal(collections.collections[1]?.webUrl, 'https://www.zotero.org/users/88/collections/' + folder);
  const first = await act('zotero.browse', { query: 'The', collection: folder, library: collections.library });
  assert.deepEqual(first.items.map(it => it.key), [parent]);
  assert.equal(first.nextStart, 3);
  const last = await act('zotero.browse', { query: 'The', collection: folder, start: first.nextStart, library: first.library });
  assert.equal(last.items[0]?.key, child);
  assert.equal(last.nextStart, null);
});

test('open uses the PDF Zotero actually attached and restores a previous reading without re-importing it', async t => {
  let pdf: URL;
  let fileReads = 0;
  let instanceId = 'desktopA';
  const { root, act } = await setup(t, (url, options) => {
    assert.equal(options.method ?? 'GET', 'GET');
    if (url.pathname === '/api/') return instance(instanceId);
    if (url.pathname.endsWith('/' + parent + '/children')) return Response.json([
      { key: child, version: 3, data: { itemType: 'attachment', parentItem: parent, filename: 'Paper.pdf', contentType: 'application/pdf' } }
    ]);
    if (url.pathname.endsWith('/' + child + '/file')) {
      fileReads++;
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: pdf.href } });
    }
    if (url.pathname.endsWith('/' + parent)) return Response.json(item(parent, 'journalArticle', { url: 'https://example.org/article' }));
    if (url.pathname.endsWith('/top')) return Response.json([item(parent, 'journalArticle')]);
    throw Error('Unexpected request ' + url.pathname);
  });
  pdf = pathToFileURL(path.join(root, 'paper.pdf'));
  await writeFile(pdf, '%PDF-1.7\nZotero reading fixture');
  const { library } = await act('zotero.browse');
  const opened = await act('zotero.open', { key: parent, library });
  assert.ok(opened.kind === 'document');
  assert.equal(opened.doc.kind, 'pdf');
  assert.equal((await act('zotero.get', { docId: opened.doc.id })).item?.key, parent);
  await act('note.save', { docId: opened.doc.id, title: 'My paper', page: 1, anchor: 'p1:1', text: 'Read this again.', quote: 'Quote' });
  const reopened = await act('zotero.open', { key: parent, library });
  assert.ok(reopened.kind === 'document');
  assert.equal(reopened.doc.id, opened.doc.id);
  assert.equal(fileReads, 1);
  assert.equal((await act('state')).notes.find(note => note.docId === reopened.doc.id)?.text, 'Read this again.');
  const vaultPath = path.join(root, 'Vault');
  await mkdir(vaultPath);
  await act('settings.save', { vaultPath });
  const file = await act('obsidian.export', { docId: opened.doc.id, title: opened.doc.title });
  const exported = await readFile(file.path, 'utf8');
  assert.match(exported, /https:\/\/example\.org\/article/);
  assert.ok(exported.includes('zotero://select/library/items/' + parent));
  assert.doesNotMatch(exported, /127\.0\.0\.1|localhost/);
  instanceId = 'desktopB';
  await assert.rejects(act('zotero.open', { key: parent, library }), { status: 409 });
  await assert.rejects(act('zotero.collections', { library }), { status: 409 });
  await assert.rejects(act('zotero.link', { docId: opened.doc.id, key: parent, library }), { status: 409 });
});

test('a configured Web library can read a standalone PDF without forwarding its key to file storage', async t => {
  const storage = 'https://zoterofilestorage.s3.us-east-1.amazonaws.com/example';
  const { act } = await setup(t, (url, options) => {
    const headers = new Headers(options.headers);
    if (url.href === storage) {
      assert.equal(headers.get('Zotero-API-Key'), null);
      return new Response('%PDF-1.7\ntest');
    }
    assert.equal(url.origin, 'https://api.zotero.org');
    assert.equal(headers.get('Zotero-API-Key'), 'private-example');
    if (url.pathname.endsWith('/file')) return new Response(null, { status: 302, headers: { location: storage } });
    const record = item(child, 'attachment', { filename: 'attachment.pdf', contentType: 'application/pdf' });
    return Response.json(url.pathname.endsWith('/top') ? [record] : record);
  });
  await act('settings.save', { zoteroLibraryId: '9876', zoteroApiKey: 'private-example' });
  const { library, mode } = await act('zotero.browse');
  assert.equal(mode, 'web');
  const opened = await act('zotero.open', { library, key: child });
  assert.ok(opened.kind === 'document');
  assert.equal(opened.doc.kind, 'pdf');
});

test('source-only items open their article; a linked item reuses the same reader document; metadata-only items return their Zotero record', async t => {
  const article = 'https://example.org/article';
  let data: Record<string, unknown> = { url: article };
  const { act, root } = await setup(t, (url, options) => {
    assert.equal(options.method ?? 'GET', 'GET');
    if (url.pathname === '/api/') return instance('desktopA');
    if (url.pathname.endsWith('/children')) return Response.json([]);
    const record = item(parent, 'journalArticle', data);
    return Response.json(url.pathname.endsWith('/top') ? [record] : record);
  });
  const { library } = await act('zotero.browse');
  assert.deepEqual(await act('zotero.open', { library, key: parent }), { kind: 'article', url: article });
  data = { url: 'https://arxiv.org/abs/2309.06180v1' };
  assert.equal((await act('zotero.open', { library, key: parent }) as {url:string}).url, 'https://arxiv.org/pdf/2309.06180v1');
  data = {};
  assert.deepEqual(await act('zotero.open', { library, key: parent }), { kind: 'unavailable', zoteroUrl: 'zotero://select/library/items/' + parent });
  const doc = await new Library(root).importWeb({ url: article, title: 'Article', paragraphs: ['The text.'] });
  await act('zotero.link', { library, key: parent, docId: doc.id });
  const opened = await act('zotero.open', { library, key: parent });
  assert.ok(opened.kind === 'document');
  assert.equal(opened.doc.id, doc.id);
});

test('a public library with restricted or oversized attachments still opens the published article', async t => {
  const url = 'https://example.org/full-text';
  let file = () => new Response(null, { status: 403 });
  const { act } = await setup(t, endpoint => {
    if (endpoint.pathname.endsWith('/file')) return file();
    if (endpoint.pathname.endsWith('/children')) return Response.json([
      item(child, 'attachment', { parentItem: parent, contentType: 'application/pdf' })
    ]);
    const citation = item(parent, 'journalArticle', { url });
    return Response.json(endpoint.pathname.endsWith('/top') ? [citation] : citation);
  });
  await act('settings.save', { zoteroLibraryId: '88' });
  const { library } = await act('zotero.browse');
  assert.deepEqual(await act('zotero.open', { library, key: parent }), { kind: 'article', url });
  file = () => new Response(null, { headers: { 'Content-Length': String(90 * 1024 * 1024) } });
  assert.deepEqual(await act('zotero.open', { library, key: parent }), { kind: 'article', url });
});
