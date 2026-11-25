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
  const published = 'https://example.org/paper.pdf';
  assert.equal((await library.importPdf('published.pdf', bytes, published)).url, published);
  assert.equal((await new Library(root).get(first.id)).url, published);
  assert.deepEqual(await new Library(root).bytes(first.id), bytes);
  await assert.rejects(library.importPdf('bad.pdf', Buffer.from('no PDF header')));
  await assert.rejects(library.get('../private'));
});

test('saved documents can be renamed and deleted with their cached translations while protecting the bundled sample', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-ts-manage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new Library(root);
  const bytes = Buffer.from('%PDF-1.7\nmanageable document bytes');
  const imported = await library.importPdf('Draft.pdf', bytes);
  await library.translate(imported.id, 1, [{ id: 'p1', text: 'Hello world.' }], async () => ({ p1: '你好世界。' }));
  assert.deepEqual(await library.translations(imported.id, 1), { p1: '你好世界。' });

  const renamed = await library.rename(imported.id, 'Final Paper.pdf');
  assert.equal(renamed.title, 'Final Paper.pdf');
  assert.equal((await library.get(imported.id)).title, 'Final Paper.pdf');
  await assert.rejects(library.rename(imported.id, '   '));
  await assert.rejects(library.rename('pagedattention', 'Other'));

  assert.deepEqual(await library.delete(imported.id), { id: imported.id, deleted: true });
  await assert.rejects(library.get(imported.id));
  assert.deepEqual(await library.translations(imported.id, 1), {});
  assert.equal((await library.list()).some(doc => doc.id === imported.id), false);
  await assert.rejects(library.delete('pagedattention'));
});

test('importWeb sanitizes optional bibliographic metadata without altering content-hash identity', async t => {
  const rootA = await mkdtemp(path.join(tmpdir(), 'reader-ts-meta-a-'));
  const rootB = await mkdtemp(path.join(tmpdir(), 'reader-ts-meta-b-'));
  t.after(() => Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })]));
  const libA = new Library(rootA);
  const libB = new Library(rootB);
  const base = { title: 'Sanitized Article', url: 'https://example.org/meta-test', paragraphs: ['Alpha.', 'Beta.'] };

  const plain = await libA.importWeb(base);
  const enriched = await libB.importWeb({
    ...base,
    paperTitle: 'Clean\u0000Title\nWith Controls',
    authors: 'Alice Smith;\u0007 Bob Jones',
    venue: 'Conference\t2025',
    year: 'not-a-year',
    doi: 'not-a-valid-doi',
    publisher: 'A'.repeat(600),
    abstract: 'Line 1\r\nLine 2\u0000'
  });

  assert.equal(enriched.id, plain.id);
  assert.equal(enriched.paperTitle, 'Clean Title With Controls');
  assert.equal(enriched.authors, 'Alice Smith; Bob Jones');
  assert.equal(enriched.venue, 'Conference 2025');
  assert.equal(enriched.year, undefined);
  assert.equal(enriched.doi, undefined);
  assert.equal(enriched.publisher?.length, 500);
  assert.equal(enriched.abstract, 'Line 1\nLine 2');
});

test('translate guards Object.prototype block IDs such as toString on cache lookup and model results', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-ts-proto-block-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new Library(root);
  const doc = await library.importPdf('Proto.pdf', Buffer.from('%PDF-1.7\nprototype id test'));

  let calls = 0;
  const first = await library.translate(doc.id, 1, [{ id: 'toString', text: 'Hello world.' }], async () => {
    calls += 1;
    return { toString: '你好世界。' };
  });
  assert.equal(calls, 1);
  assert.equal(first.toString, '你好世界。');

  const cached = await library.translate(doc.id, 1, [{ id: 'toString', text: 'Hello world.' }], async () => {
    calls += 1;
    return { toString: '不应重复调用。' };
  });
  assert.equal(calls, 1);
  assert.equal(cached.toString, '你好世界。');

  await assert.rejects(
    library.translate(doc.id, 2, [{ id: 'toString', text: 'Hello world.' }], async () => ({})),
    (error: unknown) => error instanceof Error && (error as Error & { status?: number }).status === 502 && /omitted a paragraph/i.test(error.message)
  );
});

test('translate with force overwrites only requested blocks and preserves cache on failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-ts-force-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new Library(root);
  const doc = await library.importPdf('Force.pdf', Buffer.from('%PDF-1.7\nforce test'));
  const blocks = [{ id: 'b1', text: 'First block text.' }, { id: 'b2', text: 'Second block text.' }];
  await library.translate(doc.id, 1, blocks, async () => ({ b1: '初版一。', b2: '初版二。' }));

  const updated = await library.translate(doc.id, 1, [blocks[0]], async batch => {
    assert.deepEqual(batch.map(b => b.id), ['b1']);
    return { b1: '重译一。' };
  }, undefined, true);
  assert.equal(updated.b1, '重译一。');
  assert.equal(updated.b2, '初版二。');

  await assert.rejects(
    library.translate(doc.id, 1, [blocks[0]], async () => { throw Object.assign(new Error('upstream failed'), { status: 502 }); }, undefined, true),
    { status: 502 }
  );
  const afterFailure = await library.translations(doc.id, 1);
  assert.equal(afterFailure.b1, '重译一。');
  assert.equal(afterFailure.b2, '初版二。');
});

test('importPdf enriches missing metadata on duplicate bytes and updateMeta validates and serializes atomic writes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-ts-update-meta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new Library(root);
  const bytes = Buffer.from('%PDF-1.7\nmetadata enrichment and update test');
  const first = await library.importPdf('Paper.pdf', bytes, undefined, { paperTitle: 'Initial Title', year: '2023' });
  assert.equal(first.paperTitle, 'Initial Title'); assert.equal(first.year, '2023');
  const enriched = await library.importPdf('Paper2.pdf', bytes, 'https://arxiv.org/abs/2309.06180', { paperTitle: 'Should Not Clobber', authors: 'Alice Smith', doi: '10.1145/123.456' });
  assert.equal(enriched.id, first.id); assert.equal(enriched.paperTitle, 'Initial Title'); assert.equal(enriched.authors, 'Alice Smith'); assert.equal(enriched.url, 'https://arxiv.org/abs/2309.06180');
  const edited = await library.updateMeta({ id: first.id, paperTitle: 'Edited Paper', authors: ['Alice Smith', 'Bob Jones'], venue: 'SOSP', year: '2024', doi: 'https://doi.org/10.1145/999.1' });
  assert.equal(edited.paperTitle, 'Edited Paper'); assert.equal(edited.authors, 'Alice Smith; Bob Jones'); assert.equal(edited.doi, '10.1145/999.1');
  const cleared = await library.updateMeta({ id: first.id, authors: [], venue: '', doi: '' });
  assert.equal(cleared.authors, undefined); assert.equal(cleared.venue, undefined); assert.equal(cleared.doi, undefined); assert.equal(cleared.paperTitle, 'Edited Paper');
  await assert.rejects(library.updateMeta({ id: 'pagedattention', paperTitle: 'No' }), { status: 400 });
  await assert.rejects(library.updateMeta({ id: first.id, year: '99' }), { status: 400 });
  await assert.rejects(library.updateMeta({ id: first.id, doi: 'bad-doi' }), { status: 400 });
  await assert.rejects(library.updateMeta({ id: 'pdf-' + '0'.repeat(64), paperTitle: 'Missing' }), { status: 404 });
  await Promise.all([library.rename(first.id, 'Concurrent.pdf'), library.updateMeta({ id: first.id, authors: 'Concurrent Author' }), library.updateMeta({ id: first.id, venue: 'OSDI' })]);
  const finalDoc = await library.get(first.id);
  assert.equal(finalDoc.title, 'Concurrent.pdf'); assert.equal(finalDoc.authors, 'Concurrent Author'); assert.equal(finalDoc.venue, 'OSDI');
});
