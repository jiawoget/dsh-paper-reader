import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { hasDecoderRepetition, isUntranslatedEnglish } from '../src/shared/translation-quality.js';
import { Library } from '../src/server/library.js';
import { localTranslationAvailable, translateLocally } from '../src/server/local-translation.js';
import { createServices } from '../src/server/services.js';

const sentence = 'The library has forty-seven books on the blue shelf.';
const blocks = [{ id: 'prose', text: sentence }];
async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'paper-reader-local-mt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('English prose echoes are detected without rejecting names, references, symbols or identifiers', () => {
  assert.equal(isUntranslatedEnglish(sentence, sentence.toUpperCase()), true);
  assert.equal(isUntranslatedEnglish('These experiments verify that the results are reproducible.', 'These experiments verify that the results are reproducible'), true);
  assert.equal(isUntranslatedEnglish('The sun shines.', 'The sun shines.'), true);
  assert.equal(isUntranslatedEnglish('I love reading.', 'I love reading.'), true);
  assert.equal(isUntranslatedEnglish(sentence, 'Original source in English: ' + sentence), true);
  for (const exempt of ['Kwon, Li and Zhuang', 'Kwon et al.', 'PagedAttention', '512 GB', 'P(x) = f(x₁, …, xₙ)', 'Massachusetts Institute of Technology', '[12] A. Smith. The Book of Examples. 2023.']) {
    assert.equal(isUntranslatedEnglish(exempt, exempt), false, exempt);
  }
});

test('decoder loops are distinguished from decimal precision, dot leaders, equations and names', () => {
  for (const text of ['::::::::::::', '该实验已经结束' + '.'.repeat(80), '结果表明。' + '重复词，'.repeat(12), '这组数据集集集集集集显示']) {
    assert.equal(hasDecoderRepetition(text), true, text);
  }
  for (const text of ['0.0000000000001', 'P(A, A, A) = Σᵢ xᵢ', 'Wang, Wang & Wang', '第一章' + '.'.repeat(60) + '12', '结果尚未确定……']) {
    assert.equal(hasDecoderRepetition(text), false, text);
  }
});

test('a rejected PDF echo cannot replace a cached paragraph, and a later successful translation repairs it', async t => {
  const root = await temporary(t);
  const library = new Library(root);
  const doc = await library.importPdf('Example', Buffer.from('%PDF-1.7\nactual cache test'));
  const directory = path.join(root, 'translations', doc.id);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, '1.json');
  const original = JSON.stringify({ prose: sentence, name: 'Kwon' });
  await writeFile(file, original);
  await assert.rejects(library.translate(doc.id, 1, blocks, async () => ({ prose: sentence })), { status: 502 });
  assert.equal(await readFile(file, 'utf8'), original);
  const converted = '\u4e66\u67b6\u4e0a\u6709\u56db\u5341\u4e03\u672c\u4e66\u3002';
  const repaired = await library.translate(doc.id, 1, blocks, async pending => {
    assert.deepEqual(pending, blocks);
    return { prose: converted };
  });
  assert.deepEqual(repaired, { prose: converted, name: 'Kwon' });
});

test('old PDF clients only receive usable cache entries and can repair repeated decoder output', async t => {
  const root = await temporary(t);
  const library = new Library(root);
  const doc = await library.importPdf('Cache repair', Buffer.from('%PDF-1.7\nlegacy page cache'));
  const directory = path.join(root, 'translations', doc.id);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, '1.json');
  const good = { formula: 'P(x) = f(x₁, …, xₙ)；A₁, A₂, A₃', numbers: '0.0000000001', name: 'Wang, Wang, Wang & Liu', prose: '该研究采用残余网络。' };
  const broken = { first: '学习表征。' + '生命、'.repeat(55), second: '结果见图四。' + '、'.repeat(120),
    third: '得到更好的解。' + ' 土'.repeat(60) };
  const original = JSON.stringify({ ...good, ...broken });
  await writeFile(file, original);
  assert.deepEqual(await library.translations(doc.id, 1), good);
  const missing = Object.keys(broken).map(id => ({ id, text: sentence }));
  await assert.rejects(library.translate(doc.id, 1, missing, async () => broken), { status: 502, message: /retry/i });
  assert.equal(await readFile(file, 'utf8'), original);
  const repaired = Object.fromEntries(missing.map(({ id }) => [id, '蓝色书架上有四十七本书。']));
  const page = await library.translate(doc.id, 1, [...missing, { id: 'prose', text: 'We use residual networks.' }], async pending => {
    assert.deepEqual(pending, missing);
    return repaired;
  });
  assert.deepEqual(page, { ...good, ...repaired });
  assert.deepEqual(await library.translations(doc.id, 1), page);
});

test('reopening an old residual-learning title repairs only its malformed technical term', async t => {
  const root = await temporary(t), library = new Library(root);
  const doc = await library.importPdf('Research', Buffer.from('%PDF-1.7\nlegacy scientific title'));
  const directory = path.join(root, 'translations', doc.id);
  await mkdir(directory, { recursive: true });
  const title = 'Deep Residual Learning for Image Recognition';
  const corrupt = '\u6df1\u5c42\u7559\u7559\u7559\u5b66\u4e60\u4ee5\u8bc6\u522b\u56fe\u50cf';
  const valid = { alternative: '\u56fe\u50cf\u8bc6\u522b\u4e2d\u7684\u6df1\u5c42\u6b8b\u5dee\u5b66\u4e60', laughter: '\u54c8\u54c8\u54c8' };
  await writeFile(path.join(directory, '1.json'), JSON.stringify({ title: corrupt, ...valid }));
  assert.deepEqual(await library.translations(doc.id, 1), valid);
  const corrected = '\u7528\u4e8e\u56fe\u50cf\u8bc6\u522b\u7684\u6df1\u5ea6\u6b8b\u5dee\u5b66\u4e60';
  const all = [{ id: 'title', text: title }, { id: 'alternative', text: title }, { id: 'laughter', text: 'Ha ha ha' }];
  const recovered = await library.translate(doc.id, 1, all, async pending => {
    assert.deepEqual(pending, [all[0]]);
    return { title: corrected };
  });
  assert.deepEqual(recovered, { ...valid, title: corrected });
  assert.deepEqual(await new Library(root).translations(doc.id, 1), recovered);
});

test('an explicitly configured provider keeps its own errors and the reader rejects unchanged English paragraphs', async t => {
  let answer = sentence;
  const act = createServices({ root: await temporary(t), fetchImpl: async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ translations: { prose: answer } }) }, finish_reason: 'stop' }] }) });
  await act('settings.save', { baseUrl: 'http://127.0.0.1:8123/v1', model: 'fixture' });
  await assert.rejects(act('ai.blocks', { blocks }), { status: 502 });
  const reference = await act('ai.blocks', { blocks: [{ id: 'prose', text: 'Kwon' }], targetLanguage: 'English' });
  assert.equal(reference.translations.prose, sentence);
  answer = '该模型在 ImageNet 上使用残余网络。';
  const technical = [{ id: 'prose', text: 'The model uses residual networks on ImageNet.' }];
  assert.equal((await act('ai.blocks', { blocks: technical })).translations.prose, answer);
  answer += '环境署、'.repeat(15);
  await assert.rejects(act('ai.blocks', { blocks: technical }), { status: 502, message: /retry/i });
});

test('installed CPU model translates unseen prose without credentials or HTTP and keeps passage chat separate', async t => {
  if (!localTranslationAvailable()) return t.skip('The optional verified local translation weights are not installed.');
  let calls = 0;
  const act = createServices({ root: await temporary(t), fetchImpl: async () => { calls++; throw new Error('Unexpected HTTP request'); } });
  const state = await act('state');
  assert.equal(state.settings.localTranslationAvailable, true);
  assert.equal(state.settings.aiMode, 'unconfigured');
  const result = await act('ai.blocks', { blocks: [{ id: 'shelf', text: 'The library has 47 books on the blue shelf.' }] });
  assert.match(result.translations.shelf, /\p{Script=Han}/u);
  assert.match(result.translations.shelf, /47/);
  assert.notEqual(result.translations.shelf, 'The library has 47 books on the blue shelf.');
  await assert.rejects(act('ai', { mode: 'followup', text: 'Books', question: 'Where?' }), { status: 503 });
  await assert.rejects(act('ai.blocks', { blocks, targetLanguage: 'German' }), { status: 503 });
  assert.equal(calls, 0);
});

test('offline scientific passages keep identifiers, decimal values and technical terminology across sentences', async t => {
  if (!localTranslationAvailable()) return t.skip('The optional local translation weights are not installed.');
  const input = [
    { id: 'paragraph', text: 'The depth of representations is of central importance for many visual recognition tasks. Solely due to our extremely deep representations, we obtain a 28% relative improvement on the COCO object detection dataset. Deep residual nets are foundations of our submissions to ILSVRC & COCO 2015 competitions' },
    { id: 'heading', text: 'Deep Residual Learning for Speech Recognition' },
    { id: 'heldout', text: 'Our residual learning method reduces errors on ImageNet and CIFAR-10 by 3.57%.' },
    { id: 'email', text: '{janet, y-zheng}@example.edu' },
    { id: 'authors', text: 'Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun' }
  ];
  const result = await translateLocally(input);
  assert.ok(result.paragraph.length < 200, 'The short abstract excerpt must not expand into a page of repeated text.');
  for (const term of ['28%', 'COCO', 'ILSVRC', '残差网络']) assert.ok(result.paragraph.includes(term), term);
  assert.match(result.heading, /深度残差学习/);
  for (const term of ['残差学习', 'ImageNet', 'CIFAR-10', '3.57%']) assert.ok(result.heldout.includes(term), term);
  assert.equal(result.email, input[3].text);
  assert.equal(result.authors, input[4].text);
});

test('offline vision results preserve vector quantization and each named dataset task', async t => {
  if (!localTranslationAvailable()) return t.skip('The optional local translation weights are not installed.');
  const passages = [
    { id: 'vectors', text: 'For vector quantization, encoding residual vectors [17] is shown to be more effective than encoding original vectors.' },
    { id: 'benchmarks', text: 'The extremely deep representations also have excellent generalization performance on other recognition tasks, and lead us to further win the 1st places on: ImageNet detection, ImageNet localization, COCO detection, and COCO segmentation in ILSVRC & COCO 2015 competitions.' }
  ];
  const result = await translateLocally(passages);
  assert.match(result.vectors, /[\u5411\u77e2]\u91cf\u91cf\u5316/);
  assert.doesNotMatch(result.vectors, /\u4f20\u8bb0/);
  for (const task of [/ImageNet\s*\u68c0\u6d4b/, /ImageNet\s*\u5b9a\u4f4d/, /COCO\s*\u68c0\u6d4b/, /COCO\s*\u5206\u5272/]) {
    assert.match(result.benchmarks, task);
  }
});

test('a missing model directory is reported without starting a download', async t => {
  const directory = path.join(await temporary(t), 'weights-not-installed');
  assert.equal(localTranslationAvailable(directory), false);
  await assert.rejects(translateLocally(blocks, directory), { status: 503 });
});

test('missing DSH authorization permits local PDF translation while invalid credentials and web article errors remain visible', async t => {
  if (!localTranslationAvailable()) return t.skip('The optional local translation weights are not installed.');
  let reason = 'MISSING_CREDENTIAL';
  const ctx = { llm: {
    listProviders: () => [{ id: 'native' }], listModels: () => [{ id: 'chat' }],
    async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: reason } } }; }
  } };
  const act = createServices({ root: await temporary(t), ctx });
  const result = await act('ai.blocks', { blocks: [{ id: 'f', text: 'The sky is blue today.' }], documentKind: 'pdf' });
  assert.equal(result.provider, 'local');
  assert.match(result.translations.f, /\p{Script=Han}/u);
  await assert.rejects(act('ai.blocks', { blocks, documentKind: 'web' }), { status: 503, message: /authorization/ });
  reason = 'INVALID_CREDENTIAL';
  await assert.rejects(act('ai.blocks', { blocks, documentKind: 'pdf' }), { status: 503, message: /authorization/ });
});
