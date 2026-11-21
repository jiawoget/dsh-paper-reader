import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BookPlace } from '../src/shared/book-place.js';
import { ReaderStore } from '../src/server/reader-store.js';

test('book positions survive a new reader and an older tab finishing its save later', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-position-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'book-' + 'a'.repeat(64), other = 'book-' + 'b'.repeat(64);
  const store = new ReaderStore(root);
  const first: BookPlace = {page:3,anchor:'p-4',fraction:0.7,side:'source',updated:100};
  const next: BookPlace = {page:251,anchor:'p-12',fraction:0.45,side:'translation',updated:200};
  assert.equal(store.bookPosition(id), null);
  store.saveBookPosition(id, first);
  store.saveBookPosition(id, next);
  assert.deepEqual(store.saveBookPosition(id, first), next);
  const reopened = new ReaderStore(root);
  assert.deepEqual(reopened.bookPosition(id), next);
  assert.equal(reopened.bookPosition(other), null);
  assert.throws(() => reopened.saveBookPosition(id, {...next, fraction:2}), /Invalid reading position/);
  assert.deepEqual(reopened.bookPosition(id), next);
});
