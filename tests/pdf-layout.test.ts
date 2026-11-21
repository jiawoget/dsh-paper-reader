import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractLayout } from '../src/reader/pdf/extract.js';
import { correspondingText } from '../src/reader/pdf/alignment.js';
import type { Passage } from '../src/reader/pdf/model.js';
import { restoreSelection } from '../src/reader/saved-selection.js';
import { readSelectionRange, writeSelectionRange } from '../src/shared/source-link.js';

test('saved coordinates identify the chosen occurrence and reject a changed quote, tail or anchor', () => {
  const blocks = [{ id: 'p-1', text: 'Net scores net gains.' }, { id: 'p-2', text: 'The net result.' }];
  const range = { start: 11, end: 7, endAnchor: 'p-2', tail: 'The net' };
  const link = new URL('https://example.test/paper');
  writeSelectionRange(link, range);
  assert.deepEqual(readSelectionRange(link), range);
  const result = restoreSelection(blocks, 'p-1', 'net gains. The net', undefined, range);
  assert.deepEqual(result?.map(part => [part.id, part.offset, part.original]), [['p-1', 11, 'net gains.'], ['p-2', 0, 'The net']]);
  assert.equal(restoreSelection(blocks, 'p-1', 'different', undefined, range), undefined);
  assert.equal(restoreSelection(blocks, 'p-1', 'net gains.', undefined, { ...range, tail: 'new' }), undefined);
  assert.equal(restoreSelection(blocks, 'p-1', 'net gains.', undefined, { ...range, endAnchor: 'missing' }), undefined);
  link.searchParams.set('rangeStart', '-1');
  assert.equal(readSelectionRange(link), undefined);
});

test('a shared scientific identifier only narrows an unaligned counterpart when both occurrences are unambiguous', () => {
  const passage: Passage = { id: 'r', label: 'Research', role: 'paragraph', box: { x: 0, y: 0, width: 10, height: 10 },
    indices: [], fontSize: 10, text: 'The features from ImageNet improve the VLAD descriptor in VLAD space.',
    translation: '\u6765\u81eaImageNet\u7684\u7279\u5f81\u6539\u5584\u4e86VLAD\u7a7a\u95f4\u4e2d\u7684VLAD\u63cf\u8ff0\u7b26\u3002' };
  assert.equal(correspondingText(passage, 'ImageNet', 'original'), 'ImageNet');
  assert.equal(correspondingText(passage, 'ImageNet', 'translated'), 'ImageNet');
  assert.equal(correspondingText(passage, 'VLAD', 'translated'), undefined);
  assert.equal(correspondingText(passage, 'mageNet', 'original'), undefined);
});

test('matching scientific landmarks recover exact sentence spans from saved paragraph translations', () => {
  const text = 'The paper introduces the problem. H(x) denotes the mapping. F(x) gives the residual. The study compares both.';
  const translation = '\u6587\u4e2d\u4ecb\u7ecd\u95ee\u9898\u3002  H(x)\u8868\u793a\u6620\u5c04\u3002\nF(x)\u7ed9\u51fa\u6b8b\u5dee\u3002\u7814\u7a76\u6bd4\u8f83\u4e86\u4e24\u8005\u3002';
  assert.equal(correspondingText({ text, translation }, 'problem. H(x) denotes', 'original'),
    '\u6587\u4e2d\u4ecb\u7ecd\u95ee\u9898\u3002  H(x)\u8868\u793a\u6620\u5c04\u3002');
  assert.equal(correspondingText({ text, translation }, '\u7ed9\u51fa\u6b8b\u5dee', 'translated'), 'F(x) gives the residual.');
  const reversed = translation.replace('H(x)', 'TEMP').replace('F(x)', 'H(x)').replace('TEMP', 'F(x)');
  assert.equal(correspondingText({ text, translation: reversed }, 'introduces', 'original'), undefined);
  assert.equal(correspondingText({ text, translation: translation.replace('\u6620\u5c04\u3002', '\u6620\u5c04\uff0c') }, 'introduces', 'original'), undefined);
  assert.equal(correspondingText({ text: 'A paper. A result.', translation: '\u8bba\u6587\u3002\u7ed3\u679c\u3002' }, 'paper', 'original'), undefined);
});

test('a selected block-table definition and its Chinese passage point into the real page-six text layer', async () => {
  const bytes = await readFile(new URL('../public/assets/pagedattention.pdf', import.meta.url));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const book = await task.promise;
    assert.equal(book.numPages, 16);
    const page = await book.getPage(6);
    const content = await page.getTextContent(), viewport = page.getViewport({ scale: 1 });
    const translations: Record<string, string> = JSON.parse(await readFile(
      new URL('../public/assets/pagedattention-page-6.zh-CN.json', import.meta.url), 'utf8'));
    const layout = extractLayout(content, viewport, 6, hash, translations);
    const definition = layout.passages.find(p => p.id === 'block-tables');
    assert.ok(definition);
    assert.match(definition.text, /block tables—the mapping between logical and physical KV blocks of each request/);
    assert.equal(definition.translation, translations['block-tables']);
    assert.match(definition.translation ?? '', /\p{Script=Han}/u);
    const lastOccurrence = definition.translation!.lastIndexOf('KV');
    assert.match(correspondingText(definition, 'KV', 'translated', lastOccurrence) ?? '', /^Separating logical and physical/);
    assert.ok(definition.indices.some(i => {
      const run = content.items[i];
      return run && 'str' in run && run.str === 'block tables';
    }));
    const [left, right] = ['figure-6', 'figure-7'].map(id => layout.passages.find(p => p.id === id));
    assert.ok(left?.illustration && right?.illustration);
    assert.ok(left.illustration.x + left.illustration.width < right.illustration.x);
    assert.ok(left.illustration.y + left.illustration.height < definition.box.y);
    assert.match(right.text, /two requests at the same time/);
    assert.match(layout.passages.find(p => p.id === 'decoding-steps')?.text ?? '', /to demonstrate/);
    assert.ok(layout.window.x > 20 && layout.window.x < 54);
    assert.ok(layout.window.y > 25 && layout.window.y < 72);

    const unrecognized = extractLayout(content, viewport, 6, 'other bytes', translations);
    assert.ok(unrecognized.passages.length > 2);
    assert.ok(unrecognized.passages.every(p => !p.translation));
    assert.deepEqual(unrecognized.window, { x: 0, y: 0, width: 612, height: 792 });
    const otherPage = await book.getPage(5);
    const other = extractLayout(await otherPage.getTextContent(), otherPage.getViewport({ scale: 1 }), 5, hash);
    assert.ok(other.passages.every(p => !p.translation));
    assert.ok(other.passages.some(p => p.text.includes('virtual memory')));
  } finally {
    await task.destroy();
  }
});
