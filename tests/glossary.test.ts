import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGlossaryPrompt, matchGlossary, parseGlossary, type GlossaryEntry } from '../src/shared/glossary.js';

test('parseGlossary handles comments, blanks, full-width separators, bare terms, and last-wins duplicates', () => {
  const raw = [
    '',
    '  # comment line',
    'KV cache = 键值缓存',
    'PagedAttention ＝ 分页注意力',
    'Transformer',
    'vLLM = ',
    ' = ignored',
    'expr = a = b',
    'kv cache = KV 缓存'
  ].join('\r\n');
  const parsed: GlossaryEntry[] = parseGlossary(raw);
  assert.deepEqual(parsed, [
    { term: 'kv cache', translation: 'KV 缓存' },
    { term: 'PagedAttention', translation: '分页注意力' },
    { term: 'Transformer' },
    { term: 'vLLM' },
    { term: 'expr', translation: 'a = b' }
  ]);
  assert.deepEqual(parseGlossary(''), []);
  assert.deepEqual(parseGlossary(undefined), []);
});

test('matchGlossary enforces ASCII boundaries while matching punctuation, CJK, and line wraps', () => {
  const entries = parseGlossary([
    'AI = 人工智能',
    'KV-cache = 键值缓存',
    'C++',
    'O(n^2)',
    '[CLS]',
    'block table = 块表',
    '注意力 = Attention'
  ].join('\n'));
  assert.deepEqual(matchGlossary('Please wait for every detail before proceeding.', entries), []);
  assert.deepEqual(
    matchGlossary('In AI systems, kv-cache and C++ code achieve O(n^2) with [CLS] over a block\ntable and 多头注意力机制.', entries).map(e => e.term),
    ['AI', 'KV-cache', 'C++', 'O(n^2)', '[CLS]', 'block table', '注意力']
  );
  assert.deepEqual(matchGlossary('ABC++ and FOO(n^2) and myKV-cache2', entries), []);
});

test('formatGlossaryPrompt includes only matched entries and returns empty string on zero matches', () => {
  const raw = 'KV cache = 键值缓存\nPagedAttention\nUnmatched = 不会出现';
  assert.equal(formatGlossaryPrompt(raw, 'No relevant words here.'), '');
  const prompt = formatGlossaryPrompt(raw, 'PagedAttention manages KV cache blocks.');
  assert.ok(prompt.includes('KV cache => 键值缓存'));
  assert.ok(prompt.includes('PagedAttention (keep unchanged)'));
  assert.ok(!prompt.includes('Unmatched'));
});
