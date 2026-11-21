import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Library } from '../src/server/library.js';

test('web snapshots keep paragraph links after reopening and after source edits', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-ts-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new Library(root);
  const source = { title: 'Cache', url: 'https://example.org/article#intro', paragraphs: ['One.', 'Two.'] };
  const [a, b] = await Promise.all([library.importWeb(source), library.importWeb(source)]);
  assert.equal(a.id, b.id);
  const changed = await library.importWeb({ ...source, paragraphs: ['Zero.', ...source.paragraphs] });
  assert.notEqual(changed.id, a.id);
  assert.equal((await new Library(root).get(a.id)).paragraphs?.[1], 'Two.');
  assert.equal((await library.list()).filter(doc => doc.kind === 'web').length, 2);
  await assert.rejects(library.importWeb({ ...source, url: 'javascript:void(0)' }));
});

test('identical PDFs keep one identity and corrupt uploads do not appear in the library', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-ts-pdf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new Library(root);
  const bytes = Buffer.from('%PDF-1.7\nsample bytes for the storage layer');
  const first = await library.importPdf('before.pdf', bytes);
  assert.equal((await library.importPdf('after.pdf', bytes)).id, first.id);
  assert.deepEqual(await new Library(root).bytes(first.id), bytes);
  await assert.rejects(library.importPdf('bad.pdf', Buffer.from('no PDF header')));
  await assert.rejects(library.get('../private'));
});
