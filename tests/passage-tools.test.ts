import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { bibliography, citationGroups, parseBibliography } from '../src/reader/bibliography.js';
import { passageDefinitions, passageLinks, passageLabel } from '../src/reader/passage-links.js';
import { positionHighlights } from '../src/reader/notebook-highlights.js';
import type { PaperAnnotation } from '../src/shared/annotations.js';

test('a numbered group keeps its printed order while expanding ranges and deduplicating entries', () => {
  assert.deepEqual(citationGroups('A [34, 49] and ［7–9，7；12］. Broken [4–1], [0], [v2] and [1–99999].')
    .map(({ text, numbers }) => [text, numbers]), [['[34, 49]', [34, 49]], ['［7–9，7；12］', [7, 8, 9, 12]]]);
});

test('bibliography titles come from numbered entries after the heading, across pages and before appendices', () => {
  const refs = parseBibliography([
    ['[34] This example in the body must be ignored.', 'References', '[34] B. D. Ripley. Pattern recognition and neural networks. Cambridge',
      'university press, 1996.', '[49] W. Venables and B. Ripley. Modern applied statistics with s-plus.'],
    ['1999.', '[50] J. Smith. 2021. A title split across', 'two lines. In Proceedings of a meeting.', '[51] OpenAI. 2020. https://openai.com/blog/openai-api',
      'Appendix A', '[52] This is an example in an appendix.']
  ]);
  assert.deepEqual([...refs.keys()], [34, 49, 50, 51]);
  assert.equal(refs.get(34)?.title, 'Pattern recognition and neural networks');
  assert.equal(refs.get(49)?.title, 'Modern applied statistics with s-plus');
  assert.equal(refs.get(50)?.title, 'A title split across two lines');
  assert.equal(refs.get(51)?.title, undefined);
  assert.match(refs.get(51)!.entry, /https:\/\/openai.com\/blog\/openai-api/u);
});

test('the bundled PDF resolves real reference titles once per open document', async () => {
  const bytes = await readFile(new URL('../public/assets/pagedattention.pdf', import.meta.url));
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const pdf = await task.promise, pagesRead: number[] = [];
    const paper = { pages: pdf.numPages, async textContent(number: number) {
      pagesRead.push(number);
      return (await pdf.getPage(number)).getTextContent();
    } };
    const [first, again] = await Promise.all([bibliography(paper), bibliography(paper)]);
    assert.equal(first.get(37)?.title, 'GPT-4 Technical Report');
    assert.equal(first.get(34)?.title, undefined);
    assert.ok(first.get(34)?.entry.includes('https://openai.com/blog/openai-api'));
    assert.equal(again.get(40)?.title, 'POET: Training Neural Networks on Tiny Devices with Integrated Rematerialization and Paging');
    assert.deepEqual(pagesRead, [16, 15, 14]);
  } finally { await task.destroy(); }
});

test('portable Markdown cell links resolve independently to their exact paper locations', () => {
  const paper = 'http://localhost:29812/api/paper-reader/app/index.html?doc=my-paper&page=4&anchor=p4-b1&quote=loss';
  const text = '| Measure | [p. 4 · loss][p4-1234abcd] and [p. 2 · input][p2-9876fedc] |\n\n' +
    '[p2-9876fedc]: <' + paper.replace('page=4', 'page=2').replace('p4-b1', 'p2-b3').replace('quote=loss', 'quote=input') + '>\n' +
    '[p4-1234abcd]: <' + paper + '>\n' +
    '[p3-eeeeffff]: <https://example.org/unrelated>\n';
  assert.deepEqual(passageLinks(text, passageDefinitions(text)).map(link =>
    [link.label, link.url.searchParams.get('anchor'), link.url.searchParams.get('quote')]),
    [['p. 4 · loss', 'p4-b1', 'loss'], ['p. 2 · input', 'p2-b3', 'input']]);
  assert.equal(passageDefinitions(text).length, 2);
  const label = passageLabel(2, 'Dark [cells] | and observations across multiple surprising experimental conditions.');
  assert.ok(label.startsWith('p. 2 · Dark [cells] |') && label.length < 48);
  const punctuated = '[Dark \\[cells\\] \\| light][p4-1234abcd]';
  assert.equal(passageLinks(punctuated, passageDefinitions(text))[0].label, 'Dark [cells] | light');
});

test('inline highlights follow the cited occurrence in older notebooks and leave uncited marks at the end', () => {
  const path = '/api/paper-reader/app/index.html?doc=paper&page=6&anchor=results';
  const url = new URL('http://localhost:29812' + path + '&targetQuote=块表&targetOffset=12&quote=table');
  const mark: PaperAnnotation = { id: 'one', docId: 'paper', title: 'Paper', page: 6, anchor: 'results', label: 'Results',
    sourceUrl: url.href, kind: 'highlight', color: 'yellow', quote: 'table', text: '', createdAt: '', updatedAt: '' };
  const first = new URL('http://localhost:29813' + path + '&quote=table&targetOffset=2&targetQuote=块表');
  const second = new URL(first);
  second.searchParams.set('targetOffset', '12');
  const other = new URL(url); other.searchParams.set('anchor', 'conclusion');
  const unrelated = { ...mark, id: 'two', anchor: 'conclusion', sourceUrl: other.href };
  const positions = positionHighlights([mark, unrelated], [{ url: first, at: 4 }, { url: second, at: 50 }, { url: second, at: 80 }], 100);
  assert.deepEqual(positions.map(({mark, at}) => [mark.id, at]), [['one', 50], ['two', 100]]);
});
test('a whole-paper answer links back to its own exchange without inventing a source page', () => {
  const id = '20104327-550f-4107-ab0a-c1365a621a09';
  const base = 'http://127.0.0.1:29812/api/paper-reader/app/index.html?doc=pagedattention&discussion=';
  const markdown = '[全文问答](<' + base + id + '>) [坏链接](<' + base + 'oops>)';
  const links = passageLinks(markdown, []);
  assert.deepEqual(links.map(link => [link.label, link.url.searchParams.get('discussion')]), [['全文问答', id]]);
});

test('saved answer citations retain their evidence and identify the discussion for that reply', () => {
  const id = '20104327-550f-4107-ab0a-c1365a621a09';
  const reader = 'http://localhost:29812/api/paper-reader/app/index.html?doc=paper';
  const source = reader + '&page=3&anchor=results&quote=table&rangeStart=17&rangeEnd=22&endAnchor=results';
  const saved = source + '&reply=' + id + '&noteBreaks=22';
  const markdown = '> A saved answer.\n\n[p. 3 · table](<' + saved + '>)\n\n' +
    '[My caption edited in Obsidian](<' + saved + '>)\n\n' +
    '[p. 3 · my note](<' + source + '>) [p. 3 · old note](<' + source + '&reply=unknown>) ' +
    '[Paper discussion](<' + reader + '&discussion=' + id + '>)';
  const links = passageLinks(markdown, passageDefinitions(markdown));
  assert.deepEqual(links.map(link => link.replyId), [id, id, undefined, undefined, undefined]);
  assert.equal(links[0].url.href, saved);
  assert.equal(markdown.slice(links[0].from, links[0].to), '[p. 3 · table](<' + saved + '>)');
});
