import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  DEFAULT_TARGET_LANGUAGE,
  TARGET_LANGUAGE_MAX_LENGTH,
  TARGET_LANGUAGE_PRESETS,
  findTargetLanguagePreset,
  parseTargetLanguage,
  targetLanguageBcp47,
  targetLanguageLabel,
  targetsSimplifiedChinese
} from '../src/shared/languages.js';
import { targetsSimplifiedChinese as reexportedTargetsSimplifiedChinese } from '../src/shared/translation-quality.js';
import { Library, translationCacheSlug } from '../src/server/library.js';
import { createServices } from '../src/server/services.js';

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'paper-reader-target-lang-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('curated target language presets have unique ids, labels, BCP-47 tags, and slugs', () => {
  assert.equal(DEFAULT_TARGET_LANGUAGE, 'Simplified Chinese');
  assert.equal(TARGET_LANGUAGE_MAX_LENGTH, 64);
  assert.equal(TARGET_LANGUAGE_PRESETS.length, 8);
  assert.equal(reexportedTargetsSimplifiedChinese, targetsSimplifiedChinese);

  const ids = new Set(TARGET_LANGUAGE_PRESETS.map(p => p.id));
  const slugs = new Set(TARGET_LANGUAGE_PRESETS.map(p => p.slug));
  assert.equal(ids.size, 8);
  assert.equal(slugs.size, 8);
  assert.deepEqual(
    TARGET_LANGUAGE_PRESETS.map(p => [p.id, p.bcp47, p.slug]),
    [
      ['Simplified Chinese', 'zh-CN', ''],
      ['Traditional Chinese', 'zh-TW', 'zh-tw'],
      ['English', 'en', 'en'],
      ['Japanese', 'ja', 'ja'],
      ['Korean', 'ko', 'ko'],
      ['French', 'fr', 'fr'],
      ['German', 'de', 'de'],
      ['Spanish', 'es', 'es']
    ]
  );
  for (const preset of TARGET_LANGUAGE_PRESETS) {
    assert.ok(preset.labelEn.length > 0);
    assert.ok(preset.labelZh.length > 0);
    assert.equal(findTargetLanguagePreset(preset.id), preset);
    assert.equal(targetLanguageBcp47(preset.id), preset.bcp47);
    assert.equal(targetLanguageLabel(preset.id, false), preset.labelEn);
    assert.equal(targetLanguageLabel(preset.id, true), preset.labelZh);
  }
});

test('targetsSimplifiedChinese, BCP-47 lookup, and labels distinguish presets and custom languages', () => {
  for (const value of ['Simplified Chinese', 'simplified chinese', 'Chinese', 'Chinese (Simplified)', 'zh', 'zh-CN', 'zh-Hans']) {
    assert.equal(targetsSimplifiedChinese(value), true, value);
    assert.equal(targetLanguageBcp47(value), 'zh-CN', value);
  }
  for (const value of ['Traditional Chinese', 'zh-TW', 'zh-Hant', 'Japanese', 'English', 'French', 'Esperanto', 'Portuguese']) {
    assert.equal(targetsSimplifiedChinese(value), false, value);
  }
  assert.equal(targetLanguageBcp47('Traditional Chinese'), 'zh-TW');
  assert.equal(targetLanguageBcp47('zh-TW'), 'zh-TW');
  assert.equal(targetLanguageBcp47('Esperanto'), undefined);
  assert.equal(targetLanguageBcp47('Portuguese'), undefined);
  assert.equal(targetLanguageBcp47('Italian'), undefined);
  assert.equal(targetLanguageLabel('  Portuguese  ', false), 'Portuguese');
  assert.equal(targetLanguageLabel('  Portuguese  ', true), 'Portuguese');
});

test('parseTargetLanguage enforces trimming, 64-char limit, and raw-input control-character rejection', () => {
  assert.deepEqual(parseTargetLanguage('  French  '), { ok: true, value: 'French' });
  const maxLen = 'A'.repeat(64);
  assert.deepEqual(parseTargetLanguage(maxLen), { ok: true, value: maxLen });

  for (const bad of ['', '   ', '   \t ', 'A'.repeat(65), 'Japanese\n', 'Ja\npanese', 'Japanese\r', 'Japanese\0', 'Japanese\x7f', null, undefined, 123, {}]) {
    const parsed = parseTargetLanguage(bad);
    assert.equal(parsed.ok, false, 'Expected rejection for: ' + JSON.stringify(bad));
  }
});

test('translationCacheSlug produces legacy empty slug, preset slugs, and collision-free path-safe custom slugs', () => {
  assert.equal(translationCacheSlug(), '');
  assert.equal(translationCacheSlug('Simplified Chinese'), '');
  assert.equal(translationCacheSlug('zh-CN'), '');
  assert.equal(translationCacheSlug('Traditional Chinese'), 'zh-tw');
  assert.equal(translationCacheSlug('Japanese'), 'ja');
  assert.equal(translationCacheSlug('French'), 'fr');

  for (const dangerous of ['../../etc/passwd', '../ja', 'a/b\\c', '..']) {
    const slug = translationCacheSlug(dangerous);
    assert.match(slug, /^custom-[a-z0-9-]+$/);
    assert.ok(!slug.includes('/'), slug);
    assert.ok(!slug.includes('\\'), slug);
    assert.ok(!slug.includes('..'), slug);
  }

  const distinctPairs: [string, string][] = [
    ['C++', 'C#'],
    ['中文（香港）', 'ไทย'],
    ['Portuguese', 'Brazilian Portuguese']
  ];
  for (const [left, right] of distinctPairs) {
    const a = translationCacheSlug(left);
    const b = translationCacheSlug(right);
    assert.match(a, /^custom-[a-z0-9-]+$/);
    assert.match(b, /^custom-[a-z0-9-]+$/);
    assert.notEqual(a, b, `${left} vs ${right}`);
  }

  assert.throws(() => translationCacheSlug(''), { status: 400 });
  assert.throws(() => translationCacheSlug('Japanese\n'), { status: 400 });
});

test('settings.save persists preset/custom targetLanguage, rejects invalid values cleanly, and migrates legacy prefs', async t => {
  const root = await temporary(t);
  let act = createServices({ root });

  assert.equal((await act('state')).settings.targetLanguage, 'Simplified Chinese');

  const savedJa = await act('settings.save', { targetLanguage: 'Japanese' });
  assert.equal(savedJa.settings.targetLanguage, 'Japanese');

  // Reopen store to confirm persistence across restarts.
  act = createServices({ root });
  assert.equal((await act('state')).settings.targetLanguage, 'Japanese');

  // Saving an unrelated setting preserves targetLanguage.
  await act('settings.save', { zoteroMode: 'desktop' });
  assert.equal((await act('state')).settings.targetLanguage, 'Japanese');

  // Custom language and exact 64-char boundary succeed.
  await act('settings.save', { targetLanguage: '  Portuguese  ' });
  assert.equal((await act('state')).settings.targetLanguage, 'Portuguese');
  const maxLen = 'A'.repeat(64);
  await act('settings.save', { targetLanguage: maxLen });
  assert.equal((await act('state')).settings.targetLanguage, maxLen);

  // Invalid values throw HTTP 400 and leave prior persisted targetLanguage intact.
  for (const invalid of ['', '   ', '   \t ', null, 'A'.repeat(65), 'Japanese\n', 'Japanese\0', 'Ja\rpanese']) {
    await assert.rejects(act('settings.save', { targetLanguage: invalid }), { status: 400 });
    assert.equal((await act('state')).settings.targetLanguage, maxLen);
  }

  // Legacy prefs JSON without targetLanguage defaults cleanly to Simplified Chinese.
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'));
  try {
    db.prepare('INSERT OR REPLACE INTO prefs VALUES(1, ?)').run(JSON.stringify({
      baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '',
      vaultPath: '', zoteroLibraryId: '', zoteroLibraryType: 'user', zoteroApiKey: ''
    }));
  } finally {
    db.close();
  }
  act = createServices({ root });
  assert.equal((await act('state')).settings.targetLanguage, 'Simplified Chinese');
});

test('Library partitions translation caches per target language, preserves legacy Simplified Chinese layout, and deletes all languages', async t => {
  const root = await temporary(t);
  const library = new Library(root);
  const doc = await library.importPdf('Multilingual.pdf', Buffer.from('%PDF-1.7\nmultilingual cache isolation'));
  const pageBlocks = [{ id: 'p1', text: 'The system allocates memory blocks dynamically.' }];

  let calls = 0;
  const zh = await library.translate(doc.id, 1, pageBlocks, async () => { calls++; return { p1: '系统动态分配内存块。' }; }, 'Simplified Chinese');
  const ja = await library.translate(doc.id, 1, pageBlocks, async () => { calls++; return { p1: 'システムはメモリブロックを動的に割り当てます。' }; }, 'Japanese');
  const fr = await library.translate(doc.id, 1, pageBlocks, async () => { calls++; return { p1: 'Le système alloue dynamiquement des blocs mémoire.' }; }, 'French');
  const pt = await library.translate(doc.id, 1, pageBlocks, async () => { calls++; return { p1: 'O sistema aloca blocos de memória dinamicamente.' }; }, 'Portuguese');

  assert.equal(calls, 4);
  assert.equal(zh.p1, '系统动态分配内存块。');
  assert.equal(ja.p1, 'システムはメモリブロックを動的に割り当てます。');
  assert.equal(fr.p1, 'Le système alloue dynamiquement des blocs mémoire.');
  assert.equal(pt.p1, 'O sistema aloca blocos de memória dinamicamente.');

  const baseDir = path.join(root, 'translations', doc.id);
  const ptSlug = translationCacheSlug('Portuguese');
  assert.equal(existsSync(path.join(baseDir, '1.json')), true);
  assert.equal(existsSync(path.join(baseDir, 'ja', '1.json')), true);
  assert.equal(existsSync(path.join(baseDir, 'fr', '1.json')), true);
  assert.equal(existsSync(path.join(baseDir, ptSlug, '1.json')), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(baseDir, '1.json'), 'utf8')), zh);

  // Switching back to Simplified Chinese hits legacy 1.json with zero repeat translate calls.
  const cachedZh = await library.translate(doc.id, 1, pageBlocks, async () => { calls++; return { p1: 'unexpected' }; }, 'Simplified Chinese');
  assert.deepEqual(cachedZh, zh);
  assert.equal(calls, 4);
  assert.deepEqual(await library.translations(doc.id, 1, 'Japanese'), ja);
  assert.deepEqual(await library.translations(doc.id, 1, 'French'), fr);

  // Web articles isolate per language as well.
  const web = await library.importWeb({ url: 'https://example.org/paper', title: 'Example', paragraphs: ['Memory blocks scale efficiently.'] });
  const webBlocks = [{ id: 'p-1', text: 'Memory blocks scale efficiently.' }];
  await library.translate(web.id, 1, webBlocks, async () => ({ 'p-1': 'Les blocs mémoire montent en charge efficacement.' }), 'French');
  await library.translate(web.id, 1, webBlocks, async () => ({ 'p-1': '内存块可以高效扩展。' }), 'Simplified Chinese');
  assert.equal((await library.translations(web.id, 1, 'French'))['p-1'], 'Les blocs mémoire montent en charge efficacement.');
  assert.equal((await library.translations(web.id, 1, 'Simplified Chinese'))['p-1'], '内存块可以高效扩展。');

  // Deleting a document removes legacy and all language-partitioned cache files.
  const removed = await library.delete(doc.id);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(baseDir), false);
});

test('Chinese quality checks and local OPUS-MT fallback are strictly gated on Simplified Chinese', async t => {
  const root = await temporary(t);
  const library = new Library(root);
  const doc = await library.importPdf('QualityGate.pdf', Buffer.from('%PDF-1.7\nquality gate test'));
  const englishSentence = 'The library has forty-seven books on the blue shelf.';
  const blocks = [{ id: 'prose', text: englishSentence }];

  // Non-Simplified-Chinese targets must NOT trigger Simplified Chinese echo rejection.
  for (const [lang, output] of [
    ['English', englishSentence],
    ['French', 'La bibliotheque contient quarante-sept livres sur le rayon bleu.'],
    ['Spanish', 'La biblioteca tiene cuarenta y siete libros en el estante azul.'],
    ['Japanese', '図書館の青い棚には47冊の本があります。']
  ] as const) {
    const res = await library.translate(doc.id, 1, blocks, async () => ({ prose: output }), lang);
    assert.equal(res.prose, output, lang);
  }

  // Simplified Chinese still rejects English echo and decoder loops.
  await assert.rejects(library.translate(doc.id, 1, blocks, async () => ({ prose: englishSentence }), 'Simplified Chinese'), { status: 502 });
  await assert.rejects(
    library.translate(doc.id, 1, blocks, async () => ({ prose: '结果表明。' + '重复词，'.repeat(12) }), 'Simplified Chinese'),
    { status: 502 }
  );

  // ReaderModel.blocks also gates translationQualityError on Simplified Chinese.
  let modelReply = englishSentence;
  const act = createServices({
    root,
    fetchImpl: async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ translations: { prose: modelReply } }) }, finish_reason: 'stop' }]
    })
  });
  await act('settings.save', { baseUrl: 'http://127.0.0.1:8123/v1', model: 'fixture', targetLanguage: 'English' });
  const enResult = await act('ai.blocks', { blocks, documentKind: 'pdf' });
  assert.equal(enResult.translations.prose, englishSentence);

  await act('settings.save', { targetLanguage: 'Simplified Chinese' });
  await assert.rejects(act('ai.blocks', { blocks, documentKind: 'pdf' }), { status: 502 });
  modelReply = '蓝色书架上有四十七本书。';
  assert.equal((await act('ai.blocks', { blocks, documentKind: 'pdf' })).translations.prose, modelReply);

  // Unconfigured LLM with non-Simplified-Chinese targetLanguage throws 503 without falling back to local OPUS-MT.
  const unconfigured = createServices({ root: await temporary(t) });
  for (const lang of ['Japanese', 'Traditional Chinese', 'French']) {
    await unconfigured('settings.save', { targetLanguage: lang });
    await assert.rejects(unconfigured('ai.blocks', { blocks, documentKind: 'pdf' }), { status: 503 });
  }
});

test('ReaderModel propagates settings.targetLanguage into passage and block prompts with per-request override', async t => {
  const root = await temporary(t);
  const prompts: string[] = [];
  const act = createServices({
    root,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      const system = payload.messages.find(m => m.role === 'system')?.content ?? '';
      prompts.push(system);
      const isBlocks = system.includes('Return only JSON shaped as');
      const content = isBlocks
        ? JSON.stringify({ translations: { p1: '日本語訳: ブロック' } })
        : 'Answer in configured language.';
      return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    }
  });
  await act('settings.save', { baseUrl: 'http://127.0.0.1:8124/v1', model: 'fixture', targetLanguage: 'German' });

  await act('ai', { mode: 'translate', text: 'KV cache', context: 'KV cache blocks.' });
  assert.match(prompts.at(-1)!, /Translate into German\./);

  await act('ai', { mode: 'explain', text: 'KV cache', context: 'KV cache blocks.' });
  assert.match(prompts.at(-1)!, /Use German by default/);

  await act('ai', { mode: 'followup', text: 'KV cache', context: 'KV cache blocks.', question: 'How does it scale?' });
  assert.match(prompts.at(-1)!, /Use German by default/);

  // Explicit per-request override beats settings.targetLanguage.
  await act('ai', { mode: 'translate', text: 'KV-Cache', context: 'KV-Cache', targetLanguage: 'English' });
  assert.match(prompts.at(-1)!, /Translate into English\./);

  // ai.blocks uses settings.targetLanguage when request omits targetLanguage.
  await act('settings.save', { targetLanguage: 'Japanese' });
  const blockResult = await act('ai.blocks', { blocks: [{ id: 'p1', text: 'Blocks scale linearly.' }], documentKind: 'pdf' });
  assert.equal(blockResult.translations.p1, '日本語訳: ブロック');
  assert.match(prompts.at(-1)!, /Translate each passage in full into Japanese\./);
});
