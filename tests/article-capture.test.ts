import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createServices } from '../src/server/services.js';
import { readArticleLocation, readArticleRegion } from '../src/shared/article-region.js';

const prefix = 'data:image/png;base64,';
const image = prefix + 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC';
const otherImage = prefix + 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR4nGNg+M/w/z8DAAn9Av7Z9RhEAAAAAElFTkSuQmCC';
const capture = {
  docId: 'book-' + 'a'.repeat(64), page: 2, location: 'source-p-2-p-3-1200-8500-8700-2400',
  image, regionText: '  Marginal cost\n边际成本', label: '第 2 节截图'
};
const webId = 'web-' + 'b'.repeat(64);

async function dataDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-article-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('reopening an article screenshot returns the original pixels and text after later captures', async t => {
  const root = await dataDirectory(t), run = createServices({ root });
  const [first, retry] = await Promise.all([run('article.capture.save', capture), run('article.capture.save', capture)]);
  assert.match(first.anchor, /^article-source-p-2-p-3-1200-8500-8700-2400-[a-f0-9]{32}$/u);
  assert.deepEqual(first, retry);
  const region = { side: 'source', start: 'p-2', end: 'p-3', left: 1200, top: 8500, right: 8700, bottom: 2400 };
  assert.deepEqual(readArticleLocation(capture.location), region);
  assert.deepEqual(readArticleRegion(first.anchor), region);
  const inputs = [
    capture, { ...capture, image: otherImage }, { ...capture, regionText: '' }, { ...capture, label: 'Second label' },
    { ...capture, location: 'translation-p-2-p-3-1200-8500-8700-2400' }, { ...capture, page: 1 },
    { ...capture, docId: 'book-' + 'b'.repeat(64) }, { ...capture, docId: webId, page: 1, location: 'both-p-2-p-2-0-0-10000-10000' }
  ];
  const saved = await Promise.all(inputs.map(input => run('article.capture.save', input)));
  assert.equal(new Set(saved.map(item => item.anchor)).size, inputs.length);
  const reopened = createServices({ root });
  for (const [index, input] of inputs.entries()) {
    const actual = await reopened('article.capture.get', { docId: input.docId, page: input.page, anchor: saved[index].anchor });
    assert.deepEqual(actual, { image: input.image, regionText: input.regionText, label: input.label });
  }
  assert.deepEqual(await reopened('article.capture.save', capture), first);
  assert.doesNotMatch(JSON.stringify(await reopened('state')), /data:image|iVBORw0/);
  assert.doesNotMatch(JSON.stringify(await reopened('chat.history', { docId: capture.docId })), /data:image|iVBORw0/);
});

test('article screenshots are scoped to their document and section and reject malformed geometry or pixels', async t => {
  const run = createServices({ root: await dataDirectory(t) });
  const { anchor } = await run('article.capture.save', capture);
  const key = { docId: capture.docId, page: capture.page, anchor };
  await assert.rejects(run('article.capture.get', { ...key, page: 1 }), { status: 404 });
  await assert.rejects(run('article.capture.get', { ...key, docId: 'book-' + 'c'.repeat(64) }), { status: 404 });
  for (const invalid of ['region-0-0-10000-10000', 'p-2', anchor.slice(0, -1), anchor + '0']) {
    await assert.rejects(run('article.capture.get', { ...key, anchor: invalid }), { status: 400 });
  }
  for (const location of [
    'source-p-0-p-1-0-0-1-1', 'source-p-3-p-2-0-0-1-1', 'source-p-2-p-2-1-1-1-2',
    'source-p-2-p-2-0-4-1-3', 'both-p-2-p-3-0-10001-1-2', 'translation-p-2-p-3-0-0-10001-10',
    'source-p-2-p-3-0-1-10000-10001', 'source-p-2-p-3--1-1-100-200', 'region-0-0-10000-10000'
  ]) await assert.rejects(run('article.capture.save', { ...capture, location }), { status: 400 });
  for (const change of [{ docId: 'pdf-' + 'd'.repeat(64) }, { docId: '../other' }, { page: 0 }, { page: 1.5 }]) {
    await assert.rejects(run('article.capture.save', { ...capture, ...change }), { status: 400 });
    await assert.rejects(run('article.capture.get', { ...key, ...change }), { status: 400 });
  }
  const corrupt = Buffer.from(image.slice(prefix.length), 'base64');
  corrupt[corrupt.indexOf('IDAT') + 5] ^= 255;
  for (const change of [
    { image: 'https://example.test/crop.png' }, { image: prefix + corrupt.toString('base64') },
    { regionText: undefined }, { regionText: 3 }, { label: '' }
  ]) await assert.rejects(run('article.capture.save', { ...capture, ...change }), { status: 400 });
});

test('the article capture store uses the DSH decoder mounted after the reader started', async t => {
  const ctx: { attachments?: { validateImage(): Promise<void> } } = {};
  const run = createServices({ root: await dataDirectory(t), ctx });
  ctx.attachments = { async validateImage() { throw Object.assign(Error('Host image limit'), { code: 'IMAGE_TOO_MANY_PIXELS' }); } };
  await assert.rejects(run('article.capture.save', capture), { status: 413 });
});

test('adding article screenshots to an existing v2 reader preserves earlier history', async t => {
  const root = await dataDirectory(t), run = createServices({ root });
  await run('history.add', { docId: capture.docId, page: 2, text: 'marginal cost', meaning: '边际成本' });
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'));
  try { db.exec('DROP TABLE IF EXISTS article_captures'); } finally { db.close(); }
  const reopened = createServices({ root });
  const saved = await reopened('article.capture.save', capture);
  assert.equal((await reopened('article.capture.get', { ...capture, anchor: saved.anchor })).image, image);
  assert.equal((await reopened('state')).history[0]?.meaning, '边际成本');
});
