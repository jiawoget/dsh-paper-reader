import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStaticAssetHandler, etagMatches, pdfBytesResponse, shortDigest } from '../src/server/static-cache.js';
import { currentNotebookMarkdown, discardNotebook, flushNotebook, notebookDraftKey, type NotebookDraftHost } from '../src/reader/notebook-loader.js';

test('etagMatches handles strong, weak, comma-separated, and wildcard tags', () => {
  assert.equal(etagMatches('"abc123"', '"abc123"'), true);
  assert.equal(etagMatches('W/"abc123"', '"abc123"'), true);
  assert.equal(etagMatches('"other", W/"abc123"', '"abc123"'), true);
  assert.equal(etagMatches('*', '"abc123"'), true);
  assert.equal(etagMatches('"different"', '"abc123"'), false);
  assert.equal(etagMatches(null, '"abc123"'), false);
});

test('createStaticAssetHandler returns ETag, 304 on match, immutable for versioned/chunks/fonts, and invalidates on file edit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-static-cache-'));
  try {
    const file = path.join(dir, 'app.js');
    await writeFile(file, 'console.log(1);', 'utf8');
    const expectedHash = shortDigest(Buffer.from('console.log(1);', 'utf8'));
    const handler = createStaticAssetHandler('app/app.js', file, 'text/javascript; charset=utf-8');

    const first = await handler(new Request('http://127.0.0.1/api/paper-reader/app/app.js'));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('etag'), `"${expectedHash}"`);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.equal(await first.text(), 'console.log(1);');

    const notModified = await handler(new Request('http://127.0.0.1/api/paper-reader/app/app.js', {
      headers: { 'if-none-match': `"${expectedHash}"` }
    }));
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), '');

    const versioned = await handler(new Request(`http://127.0.0.1/api/paper-reader/app/app.js?v=${expectedHash}`));
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get('cache-control'), 'private, max-age=31536000, immutable');

    const mismatchedVersion = await handler(new Request('http://127.0.0.1/api/paper-reader/app/app.js?v=stale0000000'));
    assert.equal(mismatchedVersion.headers.get('cache-control'), 'private, no-cache');

    const chunkHandler = createStaticAssetHandler('app/chunks/pdf-view-ABC.js', file, 'text/javascript; charset=utf-8');
    const chunkRes = await chunkHandler(new Request('http://127.0.0.1/api/paper-reader/app/chunks/pdf-view-ABC.js'));
    assert.equal(chunkRes.headers.get('cache-control'), 'private, max-age=31536000, immutable');

    const vendorHandler = createStaticAssetHandler('vendor/pdf.mjs', file, 'text/javascript; charset=utf-8');
    const vendorRes = await vendorHandler(new Request('http://127.0.0.1/api/paper-reader/vendor/pdf.mjs'));
    assert.equal(vendorRes.headers.get('cache-control'), 'private, max-age=86400');

    const fontHandler = createStaticAssetHandler('app/assets/fonts/Geist-Variable.woff2', file, 'font/woff2');
    const fontRes = await fontHandler(new Request('http://127.0.0.1/api/paper-reader/app/assets/fonts/Geist-Variable.woff2'));
    assert.equal(fontRes.headers.get('cache-control'), 'private, max-age=86400');

    await writeFile(file, 'console.log(222);', 'utf8');
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);
    const refreshed = await handler(new Request('http://127.0.0.1/api/paper-reader/app/app.js', {
      headers: { 'if-none-match': `"${expectedHash}"` }
    }));
    assert.equal(refreshed.status, 200);
    assert.equal(await refreshed.text(), 'console.log(222);');
    assert.notEqual(refreshed.headers.get('etag'), `"${expectedHash}"`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pdfBytesResponse emits ETag and returns 304 when If-None-Match matches', async () => {
  const bytes = Buffer.from('%PDF-1.7 sample');
  const first = pdfBytesResponse(new Request('http://127.0.0.1/api/paper-reader/pdf?id=doc1'), bytes);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');

  const cached = pdfBytesResponse(new Request('http://127.0.0.1/api/paper-reader/pdf?id=doc1', {
    headers: { 'if-none-match': etag }
  }), bytes);
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
});

test('notebook-loader preserves stored drafts, markdown fallback, flush, and discard before CodeMirror loads', async () => {
  const store = new Map<string, string>();
  const prevStorage = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); }
    }
  });
  try {
    const app: NotebookDraftHost = {
      doc: { id: 'doc-1', title: 'Doc 1', kind: 'pdf', defaultPage: 1 },
      page: 1,
      notebook: { docId: 'doc-1', revision: 'r1', markdown: '# Saved prose', notes: [], parts: [], uri: '', desktopOpenAvailable: false, path: '' }
    };
    assert.equal(currentNotebookMarkdown(app), '# Saved prose');

    store.set(notebookDraftKey('doc-1'), JSON.stringify({ revision: 'r1', original: '# Saved prose', text: '# Edited draft' }));
    store.set(notebookDraftKey('doc-1/ch2'), JSON.stringify({ revision: 'r1', original: 'a', text: 'b' }));
    assert.equal(currentNotebookMarkdown(app), '# Edited draft');

    const saved: string[] = [];
    await flushNotebook(app, async draft => { saved.push(draft.text); });
    assert.deepEqual(saved, ['# Edited draft']);
    assert.equal(store.has(notebookDraftKey('doc-1')), false);

    store.set(notebookDraftKey('doc-1'), JSON.stringify({ revision: 'r2', original: 'x', text: 'y' }));
    discardNotebook(app, 'doc-1');
    assert.equal(store.size, 0);
  } finally {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: prevStorage });
  }
});
