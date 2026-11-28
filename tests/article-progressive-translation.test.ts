import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canTranslateDocument, selectTranslationBatch, type BlockPosition } from '../src/reader/article-translation-controller.js';
import type { ReaderBlock, Settings } from '../src/shared/types.js';
import { createServices } from '../src/server/services.js';

const baseSettings: Settings = {
  baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasApiKey: false, aiMode: 'unconfigured',
  targetLanguage: 'Simplified Chinese', vaultPath: '', zoteroLibraryType: 'user', zoteroLibraryId: '', hasZoteroKey: false
};

test('selectTranslationBatch prioritizes visible viewport blocks outward, enforces char/count caps, and handles oversized paragraphs', () => {
  const blocks: ReaderBlock[] = Array.from({ length: 16 }, (_, i) => ({ id: `p-${i + 1}`, text: `Paragraph ${i + 1} content.` }));
  const positions = new Map<string, BlockPosition>(blocks.map((b, i) => [b.id, { id: b.id, top: i * 100, bottom: i * 100 + 80 }]));
  const midBatch = selectTranslationBatch(blocks, positions, { top: 800, bottom: 1180 }, { maxBlocks: 5 });
  assert.deepEqual(midBatch.map(b => b.id), ['p-9', 'p-10', 'p-11', 'p-12', 'p-13']);
  const nextBatch = selectTranslationBatch(blocks, positions, { top: 800, bottom: 1180 }, { maxBlocks: 5, translated: new Set(midBatch.map(b => b.id)) });
  assert.deepEqual(nextBatch.map(b => b.id), ['p-8', 'p-14', 'p-7', 'p-15', 'p-6']);
  const singleOversized = selectTranslationBatch([{ id: 'big', text: 'A'.repeat(4200) }, { id: 'small', text: 'B'.repeat(400) }], new Map(), { top: 0, bottom: 500 }, { maxChars: 3500 });
  assert.deepEqual(singleOversized.map(b => b.id), ['big']);
  const capped = selectTranslationBatch([{ id: 'a', text: 'x'.repeat(2000) }, { id: 'b', text: 'y'.repeat(2000) }, { id: 'c', text: 'z'.repeat(200) }], new Map(), { top: 0, bottom: 500 }, { maxChars: 3500 });
  assert.deepEqual(capped.map(b => b.id), ['a']);
  blocks[8].translation = '已有译文';
  assert.deepEqual(selectTranslationBatch(blocks.slice(8, 11), positions, { top: 800, bottom: 1180 }).map(b => b.id), ['p-10', 'p-11']);
  assert.deepEqual(selectTranslationBatch(blocks.slice(8, 11), positions, { top: 800, bottom: 1180 }, { force: true }).map(b => b.id), ['p-9', 'p-10', 'p-11']);
});

test('canTranslateDocument honors configured LLM and local Simplified Chinese across non-PDF documents', () => {
  assert.equal(canTranslateDocument(baseSettings, 'Simplified Chinese'), false);
  assert.equal(canTranslateDocument({ ...baseSettings, localTranslationAvailable: true }, 'Simplified Chinese'), true);
  assert.equal(canTranslateDocument({ ...baseSettings, localTranslationAvailable: true }, 'Japanese'), false);
  assert.equal(canTranslateDocument({ ...baseSettings, aiMode: 'api' }, 'Japanese'), true);
  assert.equal(canTranslateDocument({ ...baseSettings, aiMode: 'dsh' }, 'French'), true);
});

test('translation.page merges partial batches incrementally into disk cache and honors AbortSignal without losing prior batches', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'paper-reader-prog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let callCount = 0;
  const act = createServices({
    root: dir,
    fetchImpl: async (_input, init) => {
      callCount++;
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: { content: string }[] };
      const parsed = JSON.parse(body.messages[1].content) as { blocks: ReaderBlock[] };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: Object.fromEntries(parsed.blocks.map(b => [b.id, `译文:${b.id}`])) }) } }] });
    }
  });
  await act('settings.save', { baseUrl: 'http://127.0.0.1:8123/v1', model: 'prog-fixture' });
  const { doc } = await act('web.import', { url: 'https://example.org/progressive-article', title: 'Progressive Article', paragraphs: ['First paragraph.', 'Second paragraph.', 'Third paragraph.', 'Fourth paragraph.'] });
  assert.deepEqual((await act('translation.page', { docId: doc.id, page: 1, blocks: [{ id: 'p-3', text: 'Third paragraph.' }] })).translations, { 'p-3': '译文:p-3' });
  assert.deepEqual((await act('translation.page', { docId: doc.id, page: 1, blocks: [{ id: 'p-1', text: 'First paragraph.' }] })).translations, { 'p-3': '译文:p-3', 'p-1': '译文:p-1' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(act('translation.page', { docId: doc.id, page: 1, blocks: [{ id: 'p-2', text: 'Second paragraph.' }] }, { signal: aborted.signal }), { status: 499 });
  assert.equal(callCount, 2);
  assert.deepEqual((await act('translation.get', { docId: doc.id, page: 1 })).translations, { 'p-3': '译文:p-3', 'p-1': '译文:p-1' });
});
