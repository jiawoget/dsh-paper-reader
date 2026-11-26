import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { answerMarkdown } from '../src/reader/answer-markdown.js';
import { parseCustomPrompts, promptsForScope, type CustomPromptScope, type CustomPromptTemplate, type PromptScope, type ResearchPrompt } from '../src/reader/chat-prompts.js';
import { createServices } from '../src/server/services.js';

test('built-in research prompts cover paper and selection scopes in EN and ZH with clickable (p. N) brief', () => {
  const scopes: readonly PromptScope[] = ['paper', 'selection'];
  for (const scope of scopes) {
    const en: ResearchPrompt[] = promptsForScope(scope, '', false), zh: ResearchPrompt[] = promptsForScope(scope, '', true);
    assert.equal(en.length, 4); assert.equal(zh.length, 4);
    assert.deepEqual(en.map(p => p.id), zh.map(p => p.id));
    assert.ok(en.every((p, i) => p.label !== zh[i].label && p.prompt !== zh[i].prompt));
  }
  assert.match(promptsForScope('paper', '', false).find(p => p.id === 'brief')!.prompt, /\(p\. N\)/);
  assert.match(answerMarkdown('PagedAttention cuts waste (p. 6).', 16), /class="page-cite-chip" data-page="6"/);
});

test('parseCustomPrompts handles scopes, full-width delimiters, comments, malformed lines, dedup, and 20-item cap', () => {
  const raw = ['', '# ignore', 'missing', '| no label', 'no prompt | ', 'Summary | 3 bullets',
    'paper: Ablations | Missing ablations', 'selection: Proof | Check step 2', 'region：图表读数｜列出坐标轴数值', 'summary | Updated bullets'].join('\r\n');
  const parsed: CustomPromptTemplate[] = parseCustomPrompts(raw);
  const scopes: CustomPromptScope[] = parsed.map(p => p.scope);
  assert.deepEqual(scopes, ['paper', 'selection', 'selection', 'all']);
  assert.equal(parsed[2].label, '图表读数');
  assert.equal(parsed[3].prompt, 'Updated bullets');
  assert.deepEqual(promptsForScope('paper', raw, false).filter(p => p.custom).map(p => p.label), ['Ablations', 'summary']);
  assert.deepEqual(promptsForScope('selection', raw, false).filter(p => p.custom).map(p => p.label), ['Proof', '图表读数', 'summary']);
  assert.equal(parseCustomPrompts(Array.from({ length: 25 }, (_, i) => `P${i} | Prompt ${i}`).join('\n')).length, 20);
  assert.deepEqual(parseCustomPrompts('paper: | foo\nselection: | foo\nregion: | foo\npaper：| foo\nregion：  ｜ foo'), []);
});

test('settings.save persists customPrompts in prefs, preserves on partial save, and validates length and control chars', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-prompts-'));
  try {
    const act = createServices({ root });
    assert.equal((await act('settings.save', { customPrompts: 'paper: Brief | Check\r\nShared | Go' })).settings.customPrompts, 'paper: Brief | Check\nShared | Go');
    await act('settings.save', { model: 'deepseek-chat' });
    assert.equal((await createServices({ root })('state')).settings.customPrompts, 'paper: Brief | Check\nShared | Go');
    await assert.rejects(() => act('settings.save', { customPrompts: 'bad\u0007prompt' }), { status: 400 });
    await assert.rejects(() => act('settings.save', { customPrompts: 'x'.repeat(8001) }), { status: 400 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
