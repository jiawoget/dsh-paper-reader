import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JournalNote, SelectionHit } from '../src/shared/types.js';
import { notesForSelection, selectionKey, type SelectionContext } from '../src/reader/selection-context.js';
import { answerMarkdown } from '../src/reader/answer-markdown.js';
import * as discussion from '../src/reader/selection-context.js';

const source = { docId: 'paper', title: 'Residual learning', page: 1, anchor: 'abstract', label: 'Abstract',
  sourceUrl: 'http://localhost/api/paper-reader/app/index.html?doc=paper&page=1&anchor=abstract' };
const original = 'The residual function is easier to optimize.';
const translation = 'La fonction résiduelle est plus facile à optimiser.';

test('comparing figures reuses each earlier source once and keeps a second quote in the same paragraph distinct', () => {
  const a = { ...source, selected: original, original, context: original, side: 'source' as const };
  const second = { ...a, original: 'Optimize the residual.', selected: 'Optimize the residual.' };
  const figure = { ...a, anchor: 'region-15-100-5400-6600', page: 6, label: 'Figure 6' };
  const next = { ...figure, anchor: 'region-5500-100-9700-6600', label: 'Figure 7' };
  const elsewhere = { ...a, docId: 'other-paper' };
  assert.deepEqual(discussion.previousDiscussionSources([a, figure, a, second, next, elsewhere], next), [a, figure, second]);
});
function selection(side: 'source' | 'translation', text: string, exactPair: boolean, offset?: number): SelectionContext {
  const hit: SelectionHit = { id: 'abstract', side, text, label: 'Abstract', page: 1, context: original,
    rect: {} as DOMRect, translatedOffset: offset };
  return { source, hit, original, selection: text, context: original, exactPair, pairedTranslation: translation, record: async () => {} };
}
function note(id: string, text: string, offset?: number): JournalNote {
  const url = new URL(source.sourceUrl);
  if (text !== original) url.searchParams.set('targetQuote', text);
  if (offset !== undefined) url.searchParams.set('targetOffset', String(offset));
  return { ...source, id, sourceUrl: url.href, quote: original, context: text, text: id, createdAt: '', updatedAt: '' };
}

test('corresponding source and translation selections reopen the same notes and conversation', () => {
  const sourceHit = selection('source', original, true);
  const targetHit = selection('translation', translation, true, 0);
  const saved = [note('first', original), note('second', translation, 0), note('different translated term', 'facile', 30)];
  assert.deepEqual(notesForSelection(saved, sourceHit).map(item => item.id), ['first', 'second']);
  assert.deepEqual(notesForSelection(saved, targetHit).map(item => item.id), ['first', 'second']);
  assert.equal(selectionKey(sourceHit), selectionKey(targetHit));
});

test('repeated translated fragments with only paragraph context keep their own notes and drafts', () => {
  const first = selection('translation', 'residual', false, 12);
  const second = selection('translation', 'residual', false, 53);
  const saved = [note('whole paper selection', original), note('first mention', 'residual', 12), note('second mention', 'residual', 53)];
  assert.deepEqual(notesForSelection(saved, second).map(item => item.id), ['second mention']);
  assert.notEqual(selectionKey(first), selectionKey(second));
});

test('an existing translated selection reopens after its English alignment narrows from a paragraph to a sentence', () => {
  const saved = note('annotation from an earlier reader', 'facile', 50);
  saved.quote = 'First sentence. ' + original + ' Final sentence.';
  const current = selection('translation', 'facile', false, 50);
  current.hit.sourceText = saved.quote;
  assert.deepEqual(notesForSelection([saved], current).map(n => n.id), [saved.id]);
  assert.deepEqual(notesForSelection([saved], selection('translation', 'facile', false, 72)), []);
});

test('repeated English terms reopen the note and draft for the selected occurrence', () => {
  function occurrence(offset: number) {
    const item = selection('source', 'input', false);
    item.original = 'input';
    item.hit.sourceText = 'input plus another input';
    item.hit.sourceOffset = offset;
    return item;
  }
  function linked(id: string, offset: number) {
    return { ...note(id, original), quote: 'input', context: 'input', sourceUrl: source.sourceUrl +
      '&rangeStart=' + offset + '&endAnchor=abstract&rangeEnd=' + (offset + 5) + '&rangeTail=input' };
  }
  const first = occurrence(0), second = occurrence(19);
  assert.deepEqual(notesForSelection([linked('first', 0), linked('second', 19)], second).map(n => n.id), ['second']);
  assert.notEqual(selectionKey(first), selectionKey(second));
});

test('a restored discussion includes the saved notes on each exact material', () => {
  const a = 'region-100-200-300-400', b = 'region-101-200-300-400';
  const crop = { ...source, anchor: a, selected: 'Screenshot', original: '', context: '', side: 'source' as const };
  const saved = { ...note('a', '我需要你用德语解释下'), anchor: a };
  const others = [{ ...saved, id: 'neighbor', anchor: b }, { ...saved, id: 'next', page: crop.page + 1 },
    { ...saved, id: 'elsewhere', docId: 'other paper' }];
  assert.deepEqual(discussion.notesForRecordedSource([...others, saved], crop).map(n => n.id), ['a']);

  const url = (offset: number) => source.sourceUrl + '&rangeStart=' + offset + '&endAnchor=abstract&rangeEnd=' + (offset + 5) + '&rangeTail=input';
  const word = { ...crop, anchor: source.anchor, selected: 'input', original: 'input', context: 'input plus another input', sourceUrl: url(19) };
  const first = { ...saved, anchor: word.anchor, quote: 'input', context: 'input', sourceUrl: url(0) };
  const second = { ...first, id: 'second', sourceUrl: url(19) };
  assert.deepEqual(discussion.notesForRecordedSource([first, second], word).map(n => n.id), ['second']);
});

test('clearing a linked note in Markdown leaves the remaining notes usable in a question', () => {
  const empty = { ...note('cleared', original), text: ' \n ' };
  const written = { ...note('saved', original), text: '用德语解释。\n\n保留 *KV* 这个术语。' };
  assert.deepEqual(discussion.readerNoteTexts([empty, written]), [written.text]);
  assert.equal(discussion.readerNoteTexts([empty]), undefined);
});

test('answers render Markdown and both math delimiter styles while code stays literal', () => {
  const rendered = answerMarkdown([
    'A **residual** for $x$ and \\(y\\).',
    '', '\\[ F(x) = H(x) - x \\]', '', '$$z^2$$', '',
    '- A [paper](https://example.org/paper)', '- `$literal$`', '', '```text', '\\[literal\\]', '```'
  ].join('\n'));
  assert.match(rendered, /<strong>residual<\/strong>/u);
  assert.match(rendered, /<ul>/u);
  assert.match(rendered, /<a href="https:\/\/example\.org\/paper"[^>]*rel="noopener noreferrer"/u);
  assert.match(rendered, /<code>\$literal\$<\/code>/u);
  assert.match(rendered, /<pre><code[^>]*>\\\[literal\\\]/u);
  assert.equal((rendered.match(/class="katex"/gu) ?? []).length, 4);
  assert.equal((rendered.match(/class="katex-display"/gu) ?? []).length, 2);
});

test('answer markup keeps unsupported formulas readable and embedded resources inert', () => {
  const rendered = answerMarkdown('<img src=x onerror=alert(1)> ![diagram](https://example.org/a.png) [bad](javascript:alert(1))\n\n\\(\\href{javascript:alert(1)}{click}\\)\n\n$\\unknowncommand$\n\n**Next paragraph**');
  assert.doesNotMatch(rendered, /<img\b|<script\b|href="javascript:/iu);
  assert.match(rendered, /diagram/u);
  assert.match(rendered, /unknowncommand/u);
  assert.match(rendered, /<strong>Next paragraph<\/strong>/u);
});

test('Chinese emphasis next to punctuation and display math embedded in prose render in a model answer', () => {
  const rendered = answerMarkdown('**残差函数（residual function）**的定义：\\[ F(x)=H(x)-x \\]，其中 $$x$$ 是输入。');
  assert.match(rendered, /<strong>残差函数（residual function）<\/strong>/u);
  assert.equal((rendered.match(/class="katex-display"/gu) ?? []).length, 2);
});
