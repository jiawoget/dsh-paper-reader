import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  AUTO_TRANSLATE_MAX_BLOCKS, AUTO_TRANSLATE_MAX_CHARS, ArticleTranslationController,
  VIEWPORT_BUFFER_PX, VIEWPORT_BURST_MAX_BLOCKS, VIEWPORT_BURST_MAX_CHARS,
  canTranslateDocument, isLongTranslationScope, selectTranslationBatch, selectViewportBatch,
  translationBatchBudget, type BlockPosition
} from '../src/reader/article-translation-controller.js';
import type { DocumentInfo, PageView, ReaderBlock, Settings } from '../src/shared/types.js';
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
  assert.deepEqual(translationBatchBudget(0), { maxBlocks: 4, maxChars: 1100 });
  assert.deepEqual(translationBatchBudget(4), { maxBlocks: 8, maxChars: 1800 });
  assert.equal(selectTranslationBatch(blocks, positions, { top: 0, bottom: 800 }, translationBatchBudget(0)).length, 4);
});

test('canTranslateDocument honors configured LLM and local Simplified Chinese across non-PDF documents', () => {
  assert.equal(canTranslateDocument(baseSettings, 'Simplified Chinese'), false);
  assert.equal(canTranslateDocument({ ...baseSettings, localTranslationAvailable: true }, 'Simplified Chinese'), true);
  assert.equal(canTranslateDocument({ ...baseSettings, localTranslationAvailable: true }, 'Japanese'), false);
  assert.equal(canTranslateDocument({ ...baseSettings, aiMode: 'api' }, 'Japanese'), true);
  assert.equal(canTranslateDocument({ ...baseSettings, aiMode: 'dsh' }, 'French'), true);
});

test('translation.page merges partial batches incrementally into disk cache and preserves chunk 1 on mid-flight inter-chunk abort', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'paper-reader-prog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let callCount = 0; const midAbort = new AbortController();
  const act = createServices({ root: dir, fetchImpl: async (_input, init) => {
    callCount++;
    const parsed = JSON.parse((JSON.parse(String(init?.body ?? '{}')) as { messages: { content: string }[] }).messages[1].content) as { blocks: ReaderBlock[] };
    if (parsed.blocks.some(b => b.id === 'p-15')) { midAbort.abort(); throw new DOMException('Aborted', 'AbortError'); }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: Object.fromEntries(parsed.blocks.map(b => [b.id, `译文:${b.id}`])) }) } }] });
  } });
  await act('settings.save', { baseUrl: 'http://127.0.0.1:8123/v1', model: 'prog-fixture' });
  const paragraphs = Array.from({ length: 16 }, (_, i) => `Paragraph ${i + 1}.`);
  const { doc } = await act('web.import', { url: 'https://example.org/progressive-article', title: 'Progressive Article', paragraphs });
  assert.deepEqual((await act('translation.page', { docId: doc.id, page: 1, blocks: [{ id: 'p-3', text: paragraphs[2] }] })).translations, { 'p-3': '译文:p-3' });
  assert.deepEqual((await act('translation.page', { docId: doc.id, page: 1, blocks: [{ id: 'p-1', text: paragraphs[0] }] })).translations, { 'p-3': '译文:p-3', 'p-1': '译文:p-1' });
  await assert.rejects(act('translation.page', { docId: doc.id, page: 1, blocks: paragraphs.map((text, i) => ({ id: `p-${i + 1}`, text })) }, { signal: midAbort.signal }), { status: 499 });
  const cached = (await act('translation.get', { docId: doc.id, page: 1 })).translations;
  assert.equal(callCount, 4); assert.equal(Object.keys(cached).length, 14); assert.equal(cached['p-14'], '译文:p-14'); assert.equal(cached['p-15'], undefined);
});

const mkBlocks = (n: number, len = 60): ReaderBlock[] => Array.from({ length: n }, (_, i) => ({ id: `p-${i + 1}`, text: `P${i + 1} ` + 'x'.repeat(Math.max(1, len - 5)) }));
const mkPositions = (blocks: readonly ReaderBlock[], step = 100): Map<string, BlockPosition> => new Map(blocks.map((b, i) => [b.id, { id: b.id, top: i * step, bottom: i * step + 80 }]));
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('isLongTranslationScope and selectViewportBatch enforce thresholds, viewport bounds, caps, and anchor priority', () => {
  assert.deepEqual([AUTO_TRANSLATE_MAX_BLOCKS, AUTO_TRANSLATE_MAX_CHARS, VIEWPORT_BUFFER_PX, VIEWPORT_BURST_MAX_BLOCKS, VIEWPORT_BURST_MAX_CHARS], [24, 8000, 160, 12, 3500]);
  const exact24 = Array.from({ length: 24 }, (_, i) => ({ id: `b-${i}`, text: 'a'.repeat(i < 8 ? 334 : 333) }));
  assert.equal(isLongTranslationScope([...exact24, { id: 'blank', text: '   ' }]), false);
  assert.equal(isLongTranslationScope([...exact24, { id: 'b-24', text: 'z' }]), true);
  assert.equal(isLongTranslationScope([{ id: 'huge', text: 'a'.repeat(8001) }]), true);
  const blocks = mkBlocks(30, 80), pos = mkPositions(blocks, 100);
  assert.deepEqual(selectViewportBatch(blocks, pos, { top: 0, bottom: 500 }).map(b => b.id), ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7']);
  assert.equal(selectViewportBatch(mkBlocks(20, 40), mkPositions(mkBlocks(20, 40), 30), { top: 0, bottom: 900 }).length, 12);
  assert.equal(selectViewportBatch(mkBlocks(10, 1000), mkPositions(mkBlocks(10, 1000), 50), { top: 0, bottom: 900 }).length, 3);
  assert.deepEqual(selectViewportBatch([{ id: 'big', text: 'a'.repeat(4200) }, { id: 's', text: 'ok' }], new Map([['big', { id: 'big', top: 0, bottom: 80 }], ['s', { id: 's', top: 100, bottom: 150 }]]), { top: 0, bottom: 500 }).map(b => b.id), ['big']);
  assert.equal(selectViewportBatch(blocks, pos, { top: 0, bottom: 300 }, { anchorId: 'p-25' })[0].id, 'p-25');
  assert.deepEqual(selectViewportBatch(blocks, pos, { top: 5000, bottom: 5500 }), []);
});

test('ArticleTranslationController gates long sections, runs single viewport bursts, honors scroll toggle, skips non-prose, and supports Translate all with Stop/Resume', async () => {
  const mkHarness = (blocks: ReaderBlock[], layout?: DocumentInfo['articleLayout'], docId = 'doc-1') => {
    let vpTop = 0, vpBottom = 420, currentDoc: DocumentInfo = { id: docId, title: 'T', kind: 'web', articleLayout: layout };
    const positions = mkPositions(blocks, 100), calls: string[][] = [], states: { state: string; done: number; total: number; visibleMissing: number }[] = [];
    const view: PageView = {
      blocks, setPendingBlocks() {}, select() {}, highlight() {}, locate: () => false, sourceRect: () => null, dispose() {},
      setTranslations: (vals, overwrite) => { for (const b of blocks) { const v = vals[b.id]?.trim(); if (v) b.translation = overwrite ? v : (b.translation || v); } }
    };
    let onCall: ((ids: string[], signal: AbortSignal) => Promise<Record<string, string>>) | undefined;
    const ctrl = new ArticleTranslationController({
      doc: () => currentDoc, page: () => 1, view: () => view, isPdf: () => false, isBilingual: () => true,
      settings: () => ({ ...baseSettings, aiMode: 'api' }), targetLanguage: () => 'Simplified Chinese', targetLanguageLabel: () => 'Chinese',
      onApplied() {}, openSettings() {}, measureViewport: () => ({ top: vpTop, bottom: vpBottom, positions }),
      scheduleFrame: fn => { fn(); return 1; }, cancelFrame() {},
      onStateChange: s => states.push({ state: s.state, done: s.done, total: s.total, visibleMissing: s.visibleMissing }),
      translatePage: async (req, signal) => { const ids = req.blocks.map(b => b.id); calls.push(ids); return onCall ? onCall(ids, signal) : Object.fromEntries(ids.map(id => [id, `译:${id}`])); }
    });
    return { ctrl, calls, states, setVp: (t: number, b: number) => { vpTop = t; vpBottom = b; }, setDoc: (id: string) => { currentDoc = { ...currentDoc, id }; }, setOnCall: (fn: typeof onCall) => { onCall = fn; } };
  };

  const skipIds = ['c-1', 't-1', 'e-1', 'i-1'];
  const shortLayout: DocumentInfo['articleLayout'] = { 'c-1': { kind: 'pre' }, 't-1': { kind: 'table' }, 'e-1': { kind: 'equation' }, 'i-1': { kind: 'image' }, ...Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`x-${i}`, { kind: 'pre' as const }])) };
  const shortH = mkHarness([...mkBlocks(6, 40), ...skipIds.map(id => ({ id, text: 'skip' })), ...Array.from({ length: 22 }, (_, i) => ({ id: `x-${i}`, text: 'code' }))], shortLayout, 'short');
  shortH.ctrl.sync(); await flush();
  assert.deepEqual(shortH.calls.flat(), ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6']);
  assert.equal(shortH.states.at(-1)?.state, 'hidden');

  const longBlocks: ReaderBlock[] = [...mkBlocks(30, 60), ...skipIds.map(id => ({ id, text: 'skip' }))];
  const h = mkHarness(longBlocks, { 'c-1': { kind: 'pre' }, 't-1': { kind: 'table' }, 'e-1': { kind: 'equation' }, 'i-1': { kind: 'image' } }, 'long-1');
  h.ctrl.sync(); await flush();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.states.at(-1), { state: 'prompt', done: 0, total: 30, visibleMissing: 6 });
  assert.equal(h.ctrl.getAutoOnScroll(), false);

  await h.ctrl.translateViewport();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6']);
  assert.deepEqual(h.states.at(-1), { state: 'prompt', done: 6, total: 30, visibleMissing: 0 });
  assert.equal(longBlocks[20].translation, undefined);

  h.setVp(1500, 1920); h.ctrl.handleScroll(); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.states.at(-1)?.visibleMissing, 8);

  h.ctrl.setAutoOnScroll(true); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].length, 8);
  h.ctrl.handleScroll(); await flush();
  assert.equal(h.calls.length, 2);

  h.setDoc('long-2'); h.ctrl.sync(); await flush();
  assert.equal(h.ctrl.getAutoOnScroll(), false);
  assert.equal(h.calls.length, 2);

  let batchNum = 0;
  h.setOnCall(async (ids, signal) => {
    if (++batchNum === 2) { h.ctrl.stop(); assert.equal(signal.aborted, true); throw new DOMException('Aborted', 'AbortError'); }
    return Object.fromEntries(ids.map(id => [id, `译:${id}`]));
  });
  await h.ctrl.start(false);
  assert.equal(h.states.at(-1)?.state, 'stopped');
  const doneAfterStop = longBlocks.slice(0, 30).filter(b => b.translation).length;
  assert.ok(doneAfterStop > 14 && doneAfterStop < 30);

  h.setOnCall(undefined);
  await h.ctrl.start(false);
  assert.equal(h.states.at(-1)?.state, 'hidden');
  assert.equal(longBlocks.slice(0, 30).every(b => Boolean(b.translation)), true);
  assert.equal(h.calls.flat().some(id => skipIds.includes(id)), false);
});
