import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { ReaderModel } from '../src/server/reader-model.js';
import { initialSettings, ServiceError } from '../src/server/service-types.js';
import { createServices } from '../src/server/services.js';

// A 2 × 1 RGB PNG. The left pixel is red and the right pixel is blue.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC';
const prefix = 'data:image/png;base64,';
const image = prefix + png;
const request = { mode: 'followup', question: 'What is on the right?', text: 'Selected area',
  context: 'Unrelated text outside the crop', regionText: 'Right-hand column', image };
const settings = { ...initialSettings, baseUrl: 'http://127.0.0.1:49125/v1', model: 'custom-reader' };
const completed = (answer: string) => Response.json({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] });

test('compatible endpoints receive the cropped pixels on every turn and the reader saves only the conversation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-region-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodies: string[] = [];
  const act = createServices({ root, fetchImpl: async (_url, init) => {
    bodies.push(String(init?.body));
    return completed(bodies.length === 1 ? 'Blue.' : 'Red.');
  } });
  await act('settings.save', settings);
  const source = { docId: 'figures', title: 'Color study', page: 1, anchor: 'area-1', label: 'Page 1 area',
    sourceUrl: 'http://localhost/reader?doc=figures&page=1', selected: 'Page 1 area', original: '', context: '', side: 'source' };
  const thread = 'selection-' + 'a'.repeat(64);
  const record = { docId: source.docId, source, thread, requestId: randomUUID(), question: request.question };
  assert.deepEqual(await act('ai', { ...request, record }), { text: 'Blue.' });
  const history = [{ role: 'user', content: request.question }, { role: 'assistant', content: 'Blue.' }];
  const question = 'And on the left?';
  assert.deepEqual(await act('ai', { ...request, text: '', question, answerQuote: 'Blue', history,
    record: { ...record, question, requestId: randomUUID(), answerQuote: 'Blue', answerTurn: 1 } }), { text: 'Red.' });
  const payloads = [];
  for (const body of bodies) {
    const envelope = JSON.parse(body);
    assert.equal(envelope.model, 'custom-reader');
    const parts = envelope.messages.at(-1).content;
    assert.ok(Array.isArray(parts), 'the provider must receive a multipart user message');
    const visual = parts.find(part => part.type === 'image_url');
    assert.equal(visual?.image_url.url, image);
    const pixels = await sharp(Buffer.from(visual.image_url.url.slice(prefix.length), 'base64')).raw().toBuffer();
    assert.deepEqual([...pixels], [255, 0, 0, 0, 0, 255]);
    const prompt = parts.find(part => part.type === 'text')?.text;
    assert.equal(typeof prompt, 'string');
    assert.doesNotMatch(prompt, /iVBORw0|Unrelated text outside the crop/);
    payloads.push(JSON.parse(prompt));
  }
  assert.equal(payloads[0].regionText, request.regionText);
  assert.equal(payloads[1].question, question);
  assert.equal(payloads[1].answerQuote, 'Blue');
  assert.deepEqual(payloads[1].history, history);
  const log = await createServices({ root })('chat.history', { docId: source.docId, thread });
  assert.deepEqual(log.exchanges.map(turn => turn.answer), ['Blue.', 'Red.']);
  assert.doesNotMatch(JSON.stringify(log), /data:image|iVBORw0/);
});

test('a plain passage keeps the existing text payload and still requires a selection', async () => {
  let body = '';
  const model = new ReaderModel({}, async (_url, init) => { body = String(init?.body); return completed('Ordinary answer'); });
  assert.deepEqual(await model.passage(settings, { mode: 'explain', text: 'Residual learning', context: 'Original context' }),
    { text: 'Ordinary answer' });
  assert.deepEqual(JSON.parse(JSON.parse(body).messages[1].content), { text: 'Residual learning', context: 'Original context' });
  await assert.rejects(model.passage(settings, { mode: 'explain', text: '' }), { status: 400 });
});

test('malformed, oversized or missing crops are rejected before provider access', async () => {
  let calls = 0;
  const model = new ReaderModel({}, async () => { calls++; return completed('unexpected'); });
  const corrupt = Buffer.from(png, 'base64');
  corrupt[corrupt.indexOf('IDAT') + 5] ^= 255;
  const tooWide = await sharp({ create: { width: 1601, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  for (const [candidate, status] of [
    [null, 400], [undefined, 400], ['https://example.test/image.png', 400], ['data:image/jpeg;base64,' + png, 400],
    [prefix + 'not-base64', 400], [prefix + Buffer.from('not a PNG').toString('base64'), 400],
    [prefix + Buffer.from(png, 'base64').subarray(0, 40).toString('base64'), 400], [prefix + corrupt.toString('base64'), 400],
    [prefix + tooWide.toString('base64'), 413], [prefix + 'A'.repeat(2 * 1024 * 1024), 413]
  ] as const) {
    await assert.rejects(model.passage(settings, { ...request, image: candidate }), { status });
  }
  assert.equal(calls, 0);
});

test('the mounted DSH image decoder enforces host limits before the configured endpoint receives a crop', async () => {
  let allowed = false;
  let received = 0;
  const model = new ReaderModel({ attachments: {
    async validateImage(input: { data: Uint8Array; mediaType: string }) {
      assert.equal(input.mediaType, 'image/png');
      assert.deepEqual(Buffer.from(input.data), Buffer.from(png, 'base64'));
      if (!allowed) throw Object.assign(Error('Private host diagnostic'), { code: 'IMAGE_TOO_MANY_PIXELS' });
    }
  } }, async () => { received++; return completed('Blue.'); });
  await assert.rejects(model.passage(settings, request), { status: 413 });
  assert.equal(received, 0);
  allowed = true;
  assert.deepEqual(await model.passage(settings, request), { text: 'Blue.' });
  assert.equal(received, 1);
});

test('explicit image rejection retries only with the text inside the crop and labels each answer', async () => {
  for (const explanation of [
    'This model does not support image input.',
    'The configured model is text-only.',
    'Multimodal input is not supported by this model.',
    'Invalid content type. image_url is only supported by certain models.',
    'Unknown variant `image_url`, expected `text` at line 1.',
    "Invalid type for 'messages[1].content': expected a string, but got an array instead.",
    'Unsupported content type: image_url.'
  ]) {
    const calls: string[] = [];
    const model = new ReaderModel({}, async (_url, init) => {
      calls.push(String(init?.body));
      if (calls.length % 2) return Response.json({ error: { message: explanation } }, { status: 422 });
      return completed('The right-hand column.');
    });
    const history = [{ role: 'assistant', content: 'Earlier answer.' }];
    for (const question of [request.question, 'Which column?']) {
      const { text } = await model.passage(settings, { ...request, question, history, targetLanguage: 'English' });
      assert.match(text, /only.*text.*selected area/i);
      assert.match(text, /The right-hand column/);
      const fallback = JSON.parse(calls.at(-1)!).messages[1].content;
      assert.equal(typeof fallback, 'string');
      assert.doesNotMatch(fallback, /iVBORw0|Unrelated text|Selected area/);
      assert.equal(JSON.parse(fallback).regionText, request.regionText);
      assert.deepEqual(JSON.parse(fallback).history, history);
    }
    assert.equal(calls.length, 4);
    assert.ok(Array.isArray(JSON.parse(calls[0]).messages[1].content));
  }
});

test('an image-only crop with a rejected image produces an actionable error that can be retried with a vision model', async () => {
  let calls = 0;
  const model = new ReaderModel({}, async () => {
    calls++;
    return Response.json({ error: { code: 'unsupported_image_input', message: 'Private provider diagnostic' } }, { status: 400 });
  });
  await assert.rejects(model.passage(settings, { ...request, regionText: '   ' }), (e: unknown) => {
    assert.ok(e instanceof ServiceError && e.status === 422);
    assert.match(e.message, /框内没有可提取的文字/);
    assert.match(e.message, /设置/);
    assert.match(e.message, /视觉|支持图片/);
    assert.doesNotMatch(e.message, /Private provider diagnostic/);
    return true;
  });
  assert.equal(calls, 1);
});

test('provider, network and image encoding failures do not silently turn into text-only answers', async () => {
  for (const [providerStatus, explanation, status] of [
    [401, 'This model does not support image input. PRIVATE', 403], [429, 'Image input is not supported. PRIVATE', 429],
    [503, 'Image input is not supported. PRIVATE', 502], [400, 'Invalid image content. PRIVATE', 502],
    [400, 'This model does not support image format GIF. PRIVATE', 502], [404, 'Unknown model. PRIVATE', 502],
    [400, 'Cannot process image 0: download failed. PRIVATE', 502],
    [400, 'This model does not support images larger than 512 pixels. PRIVATE', 502],
    [400, 'The model only supports text output. PRIVATE', 502],
    [400, "Invalid type for 'messages[1].content[1].image_url.url': expected a string. PRIVATE", 502],
    [0, 'network failure PRIVATE', 502]
  ] as const) {
    let calls = 0;
    const model = new ReaderModel({}, async () => {
      calls++;
      if (!providerStatus) throw Error(explanation);
      return Response.json({ error: { message: explanation } }, { status: providerStatus });
    });
    await assert.rejects(model.passage(settings, request), (e: unknown) => {
      assert.ok(e instanceof ServiceError && e.status === status);
      assert.doesNotMatch(e.message, /PRIVATE/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('DSH text-only catalog entries skip attachment storage and use only in-crop text', async () => {
  const streams: string[] = [];
  let saves = 0;
  const model = new ReaderModel({ attachments: { async saveImage() { saves++; } }, llm: {
    listProviders: () => [{ id: 'host' }], listModels: () => [{ id: 'text-reader', inputModalities: ['text'] }],
    async *stream(input: unknown) {
      streams.push(JSON.stringify(input));
      yield { type: 'text-delta', text: '右列。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  } }, fetch);
  for (const question of ['写了什么？', '再解释一句。']) {
    const { text } = await model.passage(initialSettings, { ...request, question });
    assert.match(text, /仅.*框内.*文字/);
    assert.match(text, /右列/);
  }
  await assert.rejects(model.passage(initialSettings, { ...request, regionText: '' }), { status: 422 });
  assert.equal(saves, 0);
  assert.equal(streams.length, 2);
  for (const stream of streams) {
    assert.match(stream, /Right-hand column/);
    assert.doesNotMatch(stream, /Unrelated text|data:image|iVBORw0/);
  }
});

test('DSH vision uses the host image attachment containing the crop and never embeds base64 in text', async () => {
  let savedBytes: Uint8Array | undefined;
  let streamed = '';
  const selection = { provider: 'dsh', model: 'vision', reasoningEffort: 'detailed' };
  const ref = { attachmentId: 'sha256:' + 'e'.repeat(64), mediaType: 'image/png', bytes: 93, width: 2, height: 1 };
  const model = new ReaderModel({ attachments: { async saveImage(input: { data: Uint8Array; mediaType: string }) {
    assert.equal(input.mediaType, 'image/png');
    savedBytes = input.data;
    return ref;
  } }, llm: {
    listProviders: () => [{ id: 'first' }, { id: 'dsh' }],
    listModels: (provider: string) => provider === 'first' ? [{ id: 'text', inputModalities: ['text'] }]
      : [{ id: 'vision', inputModalities: ['text', 'image'] }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'detailed' }] } }),
    async prepareCall(config: unknown) {
      assert.deepEqual(config, selection);
      return { config, inputModalities: ['text', 'image'], async *stream(input: unknown) {
        streamed = JSON.stringify(input);
        yield { type: 'text-delta', text: 'Blue.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
    async *stream() { assert.fail('Images must use the prepared host call.'); }
  } }, fetch);
  assert.deepEqual(await model.passage(initialSettings, { ...request, questionModel: selection, regionText: '' }), { text: 'Blue.' });
  assert.ok(savedBytes);
  assert.deepEqual(Buffer.from(savedBytes), Buffer.from(png, 'base64'));
  const packet = JSON.parse(streamed);
  assert.equal(packet.provider, 'dsh');
  assert.equal(packet.model, 'vision');
  assert.equal(packet.reasoningEffort, 'detailed');
  assert.deepEqual(packet.messages[0].content.find((part: { type: string }) => part.type === 'image'), { type: 'image', attachment: ref });
  assert.doesNotMatch(streamed, /iVBORw0|Unrelated text/);
});

test('oversized region replies are refused before they can enter reading history', async () => {
  const model = new ReaderModel({}, async () => completed('x'.repeat(48_001)));
  await assert.rejects(model.passage(settings, request), { status: 502 });
});

test('an endpoint echoing the screenshot is rejected before the conversation can store or render it', async () => {
  const model = new ReaderModel({}, async () => completed('Here is the figure: ![](' + image + ')'));
  await assert.rejects(model.passage(settings, request), (error: unknown) => {
    assert.ok(error instanceof ServiceError && error.status === 502);
    assert.doesNotMatch(error.message, /iVBORw0|data:image/);
    return true;
  });
});

// A second 2 × 1 RGB PNG with green and yellow pixels, distinct from the red and blue crop above.
const secondImage = prefix + 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR4nGNg+M/w/z8DAAn9Av7Z9RhEAAAAAElFTkSuQmCC';
const figure6 = { label: 'Figure 6', text: 'First block table', image };
const passage = { label: 'Section 4', text: 'A logical block maps to a physical block.' };
const comparison = { ...request, image: secondImage, regionText: 'Second block table',
  question: 'How does Figure 7 help explain Figure 6?', previousMaterial: [figure6, passage], targetLanguage: 'English',
  record: { source: { label: 'Figure 7' } } };

test('a question about saved notes sends the notes with their own crop or passage, including on text-only retry', async () => {
  const current = ['我需要你用德语解释下', '请用一个例子。'];
  const earlier = ['检查左图的块编号。'];
  const calls: string[] = [];
  const model = new ReaderModel({}, async (_url, init) => {
    calls.push(String(init?.body));
    return calls.length === 1
      ? Response.json({ error: { message: 'This model does not support image input.' } }, { status: 422 })
      : completed('The requested explanation is in German.');
  });
  const result = await model.passage(settings, { ...comparison, readerNotes: current,
    previousMaterial: [{ ...figure6, readerNotes: earlier }, passage],
    question: '根据我的这里的笔记和截图，看一看你需要做什么，用一句话回答' });
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    const envelope = JSON.parse(call);
    const content = envelope.messages[1].content;
    const data = JSON.parse(index === 0 ? content[0].text : content);
    assert.deepEqual(data.readerNotes, current);
    assert.deepEqual(data.previousMaterial[0].readerNotes, earlier);
    assert.equal(data.previousMaterial[1].readerNotes, undefined);
    assert.equal(data.regionText, comparison.regionText);
    assert.equal(data.question, '根据我的这里的笔记和截图，看一看你需要做什么，用一句话回答');
    assert.ok(!envelope.messages[0].content.includes(current[0]));
    if (index === 0) assert.deepEqual(content.slice(1).map((part: {image_url: {url: string}}) => part.image_url.url), [image, secondImage]);
  }
  assert.match(result.text, /notes/i);
});

test('a text-only model can identify what the reader wrote beside an image with no extractable text', async () => {
  const bodies: string[] = [];
  const model = new ReaderModel({}, async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return Response.json({ error: { message: 'This model does not support image input.' } }, { status: 422 });
    return completed('You asked for a German explanation.');
  });
  const result = await model.passage(settings, { ...request, regionText: '', readerNotes: ['Explain this in German.'],
    question: 'What does my note ask you to do?', targetLanguage: 'English' });
  assert.match(result.text, /saved notes/i);
  const input = JSON.parse(JSON.parse(bodies[1]).messages[1].content);
  assert.equal(input.regionText, '');
  assert.deepEqual(input.readerNotes, ['Explain this in German.']);
  assert.doesNotMatch(bodies[1], /data:image|iVBORw0|Unrelated text/);
});

test('compatible vision receives both labeled figures in reading order and only the exchange is saved', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-figures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sent = '';
  const act = createServices({ root, fetchImpl: async (_url, init) => { sent = String(init?.body); return completed('Compared.'); } });
  await act('settings.save', settings);
  const source = { docId: 'paper', title: 'Block tables', page: 6, anchor: 'figure-7', label: 'Figure 7',
    sourceUrl: 'http://localhost/reader?doc=paper&page=6', selected: comparison.regionText, original: '', context: '', side: 'source' };
  const record = { docId: source.docId, source, thread: 'selection-' + 'b'.repeat(64), requestId: randomUUID(), question: comparison.question };
  await act('ai', { ...comparison, record });
  const parts = JSON.parse(sent).messages[1].content;
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts.filter(part => part.type === 'image_url').map(part => part.image_url.url), [image, secondImage]);
  const prompt = parts.find(part => part.type === 'text').text;
  assert.doesNotMatch(prompt, /iVBORw0|Unrelated text outside the crop/);
  const data = JSON.parse(prompt);
  assert.deepEqual(data.previousMaterial, [{ label: 'Figure 6', text: figure6.text, imageNumber: 1 }, passage]);
  assert.equal(data.currentLabel, 'Figure 7');
  assert.equal(data.imageNumber, 2);
  assert.equal(data.regionText, comparison.regionText);
  const log = await createServices({ root })('chat.history', { docId: source.docId, thread: record.thread });
  assert.equal(log.exchanges[0]?.source?.anchor, 'figure-7');
  assert.doesNotMatch(JSON.stringify(log), /data:image|iVBORw0|previousMaterial/);
});

test('DSH receives each distinct crop as an attachment in the same order as the labeled text', async () => {
  const saved: string[] = [];
  let sent = '';
  const model = new ReaderModel({ attachments: { async saveImage(input: { data: Uint8Array }) {
    saved.push(prefix + Buffer.from(input.data).toString('base64'));
    return { attachmentId: 'crop-' + saved.length, mediaType: 'image/png', bytes: input.data.length, width: 2, height: 1 };
  } }, llm: {
    listProviders: () => [{ id: 'host' }], listModels: () => [{ id: 'vision', inputModalities: ['text', 'image'] }],
    async *stream(input: unknown) {
      sent = JSON.stringify(input);
      yield { type: 'text-delta', text: 'Two figures.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  } }, fetch);
  await model.passage(initialSettings, comparison);
  assert.deepEqual(saved, [image, secondImage]);
  const parts = JSON.parse(sent).messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts.filter(part => part.type === 'image').map(part => part.attachment.attachmentId), ['crop-1', 'crop-2']);
  assert.doesNotMatch(sent, /iVBORw0|Unrelated text outside the crop/);
  const data = JSON.parse(parts.find(part => part.type === 'text').text);
  assert.deepEqual(data.previousMaterial, [{ label: 'Figure 6', text: figure6.text, imageNumber: 1 }, passage]);
  assert.equal(data.currentLabel, 'Figure 7');
  assert.equal(data.imageNumber, 2);
});

test('an earlier screenshot stays attached when the current selection is a passage, and its raw PNG cannot enter an answer', async () => {
  let sent = '', answer = 'The paragraph explains the earlier figure.';
  const model = new ReaderModel({}, async (_url, init) => { sent = String(init?.body); return completed(answer); });
  const input = { mode: 'followup', text: passage.text, context: 'Section 4 explains the mapping.', question: 'How are they related?',
    previousMaterial: [figure6] };
  assert.deepEqual(await model.passage(settings, input), { text: answer });
  const parts = JSON.parse(sent).messages[1].content;
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts.filter(part => part.type === 'image_url').map(part => part.image_url.url), [image]);
  const data = JSON.parse(parts.find(part => part.type === 'text').text);
  assert.equal(data.text, passage.text);
  assert.equal(data.context, input.context);
  assert.equal(data.imageNumber, undefined);
  assert.deepEqual(data.previousMaterial, [{ label: 'Figure 6', text: figure6.text, imageNumber: 1 }]);
  answer = png;
  await assert.rejects(model.passage(settings, input), { status: 502 });
});

test('earlier passages reach a text endpoint alongside the current passage without requiring vision', async () => {
  let sent = '';
  const model = new ReaderModel({}, async (_url, init) => { sent = String(init?.body); return completed('Compared.'); });
  await model.passage(settings, { mode: 'followup', question: 'Compare these sentences.', text: 'Blocks can be shared.', previousMaterial: [passage] });
  const content = JSON.parse(sent).messages[1].content;
  assert.equal(typeof content, 'string');
  assert.deepEqual(JSON.parse(content).previousMaterial, [passage]);
  assert.equal(JSON.parse(content).text, 'Blocks can be shared.');
});

for (const provider of ['compatible', 'DSH'] as const) {
  test(provider + ' text-only fallback preserves all passages and extracted text, and refuses to discard an image-only source', async () => {
    const fallbacks: string[] = [];
    const model = provider === 'compatible' ? new ReaderModel({}, async (_url, init) => {
      const content = JSON.parse(String(init?.body)).messages[1].content;
      if (Array.isArray(content)) return Response.json({ error: { code: 'unsupported_image_input' } }, { status: 400 });
      fallbacks.push(content);
      return completed('Two block tables.');
    }) : new ReaderModel({ llm: {
      listProviders: () => [{ id: 'host' }], listModels: () => [{ id: 'text', inputModalities: ['text'] }],
      async *stream(input: { messages: { content: { text: string }[] }[] }) {
        fallbacks.push(input.messages[0].content[0].text);
        yield { type: 'text-delta', text: 'Two block tables.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    } }, fetch);
    const config = provider === 'compatible' ? settings : initialSettings;
    const answer = await model.passage(config, comparison);
    assert.match(answer.text, /only.*text/i);
    assert.match(answer.text, /Two block tables/);
    assert.doesNotMatch(fallbacks[0], /iVBORw0|imageNumber|Unrelated text outside the crop/);
    const data = JSON.parse(fallbacks[0]);
    assert.deepEqual(data.previousMaterial, [{ label: 'Figure 6', text: figure6.text }, passage]);
    assert.equal(data.regionText, comparison.regionText);
    assert.equal(data.currentLabel, 'Figure 7');
    await assert.rejects(model.passage(config, { ...comparison, previousMaterial: [{ ...figure6, text: '' }, passage] }), (error: unknown) => {
      assert.ok(error instanceof ServiceError && error.status === 422);
      assert.match(error.message, /vision/i);
      return true;
    });
    assert.equal(fallbacks.length, 1);
  });
}

test('invalid or excessive earlier evidence fails before provider access without dropping a selection', async () => {
  let calls = 0;
  const model = new ReaderModel({}, async () => { calls++; return completed('Unexpected.'); });
  const largePng = prefix + (await sharp({ create: { width: 600, height: 600, channels: 3, background: 'white' } })
    .png({ compressionLevel: 0 }).toBuffer()).toString('base64');
  for (const [previousMaterial, currentImage, status] of [
    ['not an array', image, 400], [[{ label: 'Figure 6', text: '', image: 'not a crop' }], image, 400],
    [[{ label: 'No selection', text: ' ' }], image, 400], [[{ text: 'Missing label' }], image, 400],
    [Array(8).fill(passage), image, 413], [[{ ...passage, text: 'a'.repeat(80_000) }, { ...passage, text: 'b'.repeat(80_000) }], image, 413],
    [[{ ...figure6, image: largePng }, { ...figure6, image: largePng }], largePng, 413]
  ] as const) {
    await assert.rejects(model.passage(settings, { ...comparison, previousMaterial, image: currentImage }), { status });
  }
  assert.equal(calls, 0);
});
