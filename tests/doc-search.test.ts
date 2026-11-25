import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentInfo } from '../src/shared/types.js';
import { buildSearchSources, extractTranslatedBlocks, searchDocument } from '../src/reader/doc-search-index.js';
import { readPaper } from '../src/reader/paper-evidence.js';
import type { PdfDocument } from '../src/reader/pdf-view.js';
import { findTextMatches } from '../src/reader/pdf/selection.js';

function fakePdf(pages: { str: string; hasEOL?: boolean }[][], failOnce = false): { pdf: PdfDocument; calls: number[] } {
  const calls: number[] = [];
  let shouldFail = failOnce;
  const pdf: PdfDocument = {
    pages: pages.length, async outline() { return []; }, async outlinePages() { return []; }, async cropRegion() { return ''; },
    async textContent(page) {
      calls.push(page);
      if (shouldFail) { shouldFail = false; throw new Error('transient pdf read error'); }
      return { items: pages[page - 1].map(item => ({ str: item.str, hasEOL: Boolean(item.hasEOL) })), styles: {}, lang: null } as Awaited<ReturnType<PdfDocument['textContent']>>;
    },
    async render() { throw new Error('unused'); }, async destroy() {}
  };
  return { pdf, calls };
}

test('readPaper caches PDF scans in WeakMap, evicts rejected scans for retry, and preserves Web path', async () => {
  const doc: DocumentInfo = { id: 'p1', title: 'Demo', kind: 'pdf' };
  const ok = fakePdf([[{ str: 'Self-', hasEOL: true }, { str: 'attention works' }], [{ str: 'KV', hasEOL: true }, { str: 'cache waste' }]]);
  const [first, second] = await Promise.all([readPaper(doc, ok.pdf), readPaper(doc, ok.pdf)]);
  assert.strictEqual(first, second); assert.strictEqual(second, await readPaper(doc, ok.pdf));
  assert.deepEqual(ok.calls, [1, 2]);
  assert.equal(first[0].text, 'Selfattention works'); assert.equal(first[1].text, 'KV\ncache waste');
  const flaky = fakePdf([[{ str: 'Recovered page' }]], true);
  await assert.rejects(() => readPaper(doc, flaky.pdf), /transient pdf read error/);
  assert.equal((await readPaper(doc, flaky.pdf))[0].text, 'Recovered page'); assert.deepEqual(flaky.calls, [1, 1]);
  assert.equal((await readPaper({ id: 'w1', title: 'Article', kind: 'web', paragraphs: ['First paragraph'] }))[0].text, '[Paragraph 1] First paragraph');
});

test('searchDocument handles cross-page PDF normalization, metacharacters, hyphens, line wraps, and boundaries', () => {
  const doc: DocumentInfo = { id: 'p2', title: 'Paper', kind: 'pdf' };
  const sources = buildSearchSources(doc, [
    { page: 1, text: 'Selfattention and O(n^2) cost [5] (p. 6) path\\to\\file in final form.' },
    { page: 2, text: 'Memory KV\ncache in a batch reduces waste. Self-attention scales well.' }
  ], new Map());
  const hyphen = searchDocument(sources, 'self-attention');
  assert.equal(hyphen.matches.length, 2); assert.deepEqual(hyphen.groups.map(g => g.page), [1, 2]);
  assert.equal(hyphen.matches[0].snippet.slice(hyphen.matches[0].matchStart, hyphen.matches[0].matchEnd), 'Selfattention');
  assert.equal(hyphen.matches[1].snippet.slice(hyphen.matches[1].matchStart, hyphen.matches[1].matchEnd), 'Self-attention');
  for (const q of ['kv cache', '[5]', '(p. 6)', 'O(n^2)', 'path\\to\\file']) assert.equal(searchDocument(sources, q).matches.length, 1);
  const boundary = searchDocument(sources, 'in a');
  assert.equal(boundary.matches.length, 1); assert.equal(boundary.matches[0].page, 2);
  assert.equal(searchDocument(sources, '   ').matches.length, 0);
});

test('buildSearchSources indexes Web/Book paragraphs without synthetic prefixes and includes real translations only', () => {
  const doc: DocumentInfo = { id: 'w2', title: 'Web', kind: 'web', sectionPage: 3, paragraphs: ['Alpha intro.', 'Figure caption', 'Beta note.'], articleLayout: { 'p-2': { kind: 'image' } } };
  const translated = extractTranslatedBlocks([
    { id: 'p-1', text: 'Alpha intro.', label: 'P1', translation: '虚拟内存简介。' },
    { id: 'p-2', text: 'Figure caption', label: 'P2', translation: 'Figure caption' },
    { id: 'p-3', text: 'Beta note.', label: 'P3', translation: '   ' }
  ]);
  assert.deepEqual(translated, [{ id: 'p-1', text: '虚拟内存简介。' }]);
  const sources = buildSearchSources(doc, undefined, new Map([[3, translated]]));
  assert.equal(searchDocument(sources, 'Paragraph 1').matches.length, 0);
  assert.equal(searchDocument(sources, 'Figure caption').matches.length, 0);
  const zh = searchDocument(sources, '虚拟内存');
  assert.equal(zh.matches.length, 1); assert.equal(zh.matches[0].side, 'translation');
  assert.equal(zh.matches[0].blockId, 'p-1'); assert.equal(zh.matches[0].page, 3);
});

test('findTextMatches enforces whitespace boundaries and clips multi-span hits per text node', () => {
  const single = [{ data: 'final in a box' }], singleHits = findTextMatches(single, 'in a');
  assert.equal(singleHits.length, 1); assert.equal(single[0].data.slice(singleHits[0][0].start, singleHits[0][0].end), 'in a');
  const spans = [{ data: 'Prefix in' }, { data: 'a suffix' }], splitHits = findTextMatches(spans, 'in a');
  assert.equal(splitHits.length, 1); assert.equal(splitHits[0].length, 2);
  assert.equal(spans[0].data.slice(splitHits[0][0].start, splitHits[0][0].end), 'in');
  assert.equal(spans[1].data.slice(splitHits[0][1].start, splitHits[0][1].end), 'a');
});
