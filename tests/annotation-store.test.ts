import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createServices } from '../src/server/services.js';

const paper = { docId: 'pagedattention', title: 'PagedAttention', sourceUrl:
  'http://localhost:29812/api/paper-reader/app/index.html?doc=pagedattention&page=6&anchor=fig6&rangeStart=4&rangeEnd=10&endAnchor=fig6&rangeTail=blocks' };
const highlight = { ...paper, page: 6, anchor: 'fig6', label: 'Figure 6', kind: 'highlight', color: 'yellow', quote: 'blocks', text: '' };
async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-annotations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, act: createServices({ root }) };
}

test('a v2 notebook written before annotations retains its note IDs, links and Markdown after upgrading', async t => {
  const { root, act } = await setup(t);
  const { note } = await act('note.save', { ...highlight, text: 'Original note' });
  const book = await act('notebook.get', paper);
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'));
  try { db.exec('DROP TABLE annotations'); } finally { db.close(); }
  const reopen = createServices({ root });
  const { annotation } = await reopen('annotation.save', { ...highlight, id: randomUUID() });
  assert.deepEqual((await reopen('annotation.list', paper)).annotations, [annotation]);
  const after = await reopen('notebook.get', paper);
  assert.equal(after.markdown, book.markdown);
  assert.equal(after.notes[0].id, note.id);
  assert.equal(after.notes[0].sourceUrl, note.sourceUrl);
});

test('paper-scoped highlights and margin pins survive reopening without touching the notebook file or notes', async t => {
  const { root, act } = await setup(t);
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  await act('settings.save', { vaultPath });
  const initial = await act('notebook.get', paper);
  assert.ok(initial.path);
  const mark = { ...highlight, id: randomUUID() };
  const pin = { ...mark, id: randomUUID(), kind: 'pin', color: 'purple', point: { x: 0, y: 1 }, quote: '', text: 'Where is block 7?' };
  const saved = (await act('annotation.save', mark)).annotation;
  const savedPin = (await act('annotation.save', pin)).annotation;
  assert.deepEqual(saved, { ...mark, createdAt: saved.createdAt, updatedAt: saved.createdAt });
  assert.deepEqual(savedPin, { ...pin, createdAt: savedPin.createdAt, updatedAt: savedPin.createdAt });
  const reopen = createServices({ root });
  const all = (await reopen('annotation.list', paper)).annotations;
  assert.deepEqual(new Map(all.map(a => [a.id, a])), new Map([[mark.id, saved], [pin.id, savedPin]]));
  assert.deepEqual(await reopen('annotation.list', { docId: 'other' }), { annotations: [] });
  await assert.rejects(reopen('annotation.save', { ...pin, docId: 'other' }), { status: 409 });
  assert.deepEqual(await reopen('annotation.delete', { id: pin.id, docId: 'other', expectedUpdatedAt: savedPin.updatedAt }), { deleted: false });
  await reopen('annotation.delete', { id: pin.id, docId: pin.docId, expectedUpdatedAt: savedPin.updatedAt });
  assert.equal(await readFile(initial.path, 'utf8'), initial.markdown);
  assert.deepEqual((await reopen('state')).notes, []);
  assert.equal((await reopen('notebook.get', paper)).revision, initial.revision);
});

test('retries return the committed annotation while stale edits and deletes preserve the newer version', async t => {
  const { root, act } = await setup(t);
  const other = createServices({ root });
  const mark = { ...highlight, id: randomUUID() };
  const created = (await act('annotation.save', mark)).annotation;
  assert.deepEqual((await other('annotation.save', mark)).annotation, created);
  const edit = { ...mark, color: 'green', text: '  My note\n', expectedUpdatedAt: created.updatedAt };
  const changed = (await other('annotation.save', edit)).annotation;
  assert.equal(changed.createdAt, created.createdAt);
  assert.notEqual(changed.updatedAt, created.updatedAt);
  assert.equal(changed.text, edit.text);
  assert.deepEqual((await act('annotation.save', edit)).annotation, changed);
  await assert.rejects(act('annotation.save', mark), { status: 409 });
  await assert.rejects(act('annotation.save', { ...edit, text: 'concurrent edit' }), { status: 409 });
  await assert.rejects(act('annotation.delete', { ...mark, expectedUpdatedAt: created.updatedAt }), { status: 409 });
  assert.deepEqual((await act('annotation.list', paper)).annotations, [changed]);
  const remove = { id: mark.id, docId: paper.docId, expectedUpdatedAt: changed.updatedAt };
  assert.deepEqual(await act('annotation.delete', remove), { deleted: true });
  assert.deepEqual(await other('annotation.delete', remove), { deleted: false });
  await assert.rejects(other('annotation.save', { ...mark, expectedUpdatedAt: changed.updatedAt }), { status: 409 });
  const restored = (await act('annotation.save', { ...mark, color: 'green', text: edit.text })).annotation;
  assert.equal(restored.id, created.id);
  assert.notEqual(restored.updatedAt, changed.updatedAt);
  await assert.rejects(other('annotation.delete', remove), { status: 409 });
});

test('invalid pin positions, kinds, colors and creation IDs cannot enter the annotation index', async t => {
  const { act } = await setup(t);
  const mark = { ...highlight, id: randomUUID() };
  for (const changes of [
    { kind: 'pin' }, { kind: 'pin', point: { x: 1.1, y: 0 } }, { kind: 'pin', point: { x: -0.1, y: 0.5 } },
    { kind: 'pin', point: { x: '0.5', y: 0.1 } }, { kind: 'other' }, { color: 'blue' }, { id: 'invalid' },
    { page: 0 }, { sourceUrl: 'javascript:void(0)' }
  ]) await assert.rejects(act('annotation.save', { ...mark, ...changes }), { status: 400 });
  assert.deepEqual(await act('annotation.list', paper), { annotations: [] });
});
