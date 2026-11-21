import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium, type FrameLocator, type Locator, type Page, type Response } from 'playwright-core';
import { openReader, withHost } from './host.js';

const sentences = [
  'The farmer planted 37 apple trees beside the river last spring.',
  'The train carried 84 passengers from the station to the city.'
];
type Translations = Record<string, string>;
type Block = { id: string; text: string };
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

async function echoProvider() {
  const requests: Block[][] = [];
  const errors: string[] = [];
  const model = 'paper-reader-echo-fault';
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, model);
      const message = body.messages.find((entry: { role: string }) => entry.role === 'user');
      const { blocks }: { blocks: Block[] } = JSON.parse(message.content);
      assert.ok(Array.isArray(blocks) && blocks.length > 0);
      requests.push(blocks);
      const translations = Object.fromEntries(blocks.map(block => [block.id, block.text]));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        role: 'assistant', content: JSON.stringify({ translations })
      } }] }));
    } catch (error) {
      errors.push(String(error));
      response.writeHead(400).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { model, requests, errors, url: 'http://127.0.0.1:' + address.port + '/v1',
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function newPdf(page: Page): Promise<Buffer> {
  const source = await page.context().newPage();
  try {
    await source.setContent('<style>@page{size:letter;margin:1in}body{margin:0;font:16pt Arial}p+p{break-before:page}</style>'
      + sentences.map(sentence => '<p>' + sentence + '</p>').join(''));
    return await source.pdf({ preferCSSPageSize: true });
  } finally { await source.close(); }
}

function sheet(reader: FrameLocator | Page, side: 'Original' | 'Simplified Chinese', number: number): Locator {
  return reader.getByRole('group', { name: side + ', page ' + number, exact: true });
}

async function inkPixels(sheet: Locator): Promise<number> {
  return sheet.locator('canvas.pdf-raster').evaluate(canvas => {
    const sample = new OffscreenCanvas(384, 496);
    const context = sample.getContext('2d')!;
    context.drawImage(canvas as HTMLCanvasElement, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 175 && pixels[i + 3] > 200) dark++;
    return dark;
  });
}

function painted(sheet: Locator): Promise<Translations> {
  return sheet.locator('.pdf-translated-text[lang="zh-CN"][data-block-id]:visible').evaluateAll(nodes =>
    Object.fromEntries(nodes.map(node => [node.getAttribute('data-block-id')!, (node.textContent || '').trim()])));
}

function cache(reader: FrameLocator, docId: string, page: number): Promise<Translations> {
  return reader.locator('body').evaluate(async (body, payload) => {
    const response = await fetch(new URL('../action', body.ownerDocument.baseURI), {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'translation.get', payload })
    });
    if (!response.ok) throw new Error('Translation cache read failed with HTTP ' + response.status + '.');
    return (await response.json()).translations;
  }, { docId, page });
}

function resultFor(response: Response, docId: string, number: number): boolean {
  const request = response.request();
  if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/paper-reader/action')) return false;
  const body = request.postDataJSON();
  return body.op === 'translation.page' && body.payload.docId === docId && body.payload.page === number;
}

function gate() {
  return { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
}

async function started(signal: Promise<void>, description: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([signal, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(description + ' did not request a translation.')), 25_000);
    })]);
  } finally { clearTimeout(timer); }
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable, headless: process.env.PAPER_READER_HEADED !== '1' });
  const faulty = await echoProvider();
  const gates = [gate(), gate()];
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    const pdf = await newPdf(page);
    const docId = 'pdf-' + createHash('sha256').update(pdf).digest('hex');
    const reader = await openReader(page, host.authenticatedUrl);
    await reader.getByRole('button', { name: 'Bilingual', exact: true }).click();
    await reader.getByRole('button', { name: 'More actions' }).click();
    await reader.getByRole('button', { name: 'Connections', exact: true }).click();
    const dialog = reader.getByRole('dialog');
    const urlField = dialog.getByLabel('API base URL');
    const modelField = dialog.getByLabel('Model', { exact: true });
    const originalUrl = await urlField.inputValue();
    const originalModel = await modelField.inputValue();
    await urlField.fill(faulty.url);
    await modelField.fill(faulty.model);
    await dialog.getByRole('button', { name: 'Save connections' }).click();
    await dialog.waitFor({ state: 'hidden' });

    await reader.getByRole('button', { name: 'Open library' }).click();
    const [picker] = await Promise.all([page.waitForEvent('filechooser'),
      reader.getByRole('button', { name: 'Open a PDF' }).click()]);
    const [failure] = await Promise.all([page.waitForResponse(response => resultFor(response, docId, 1), { timeout: 40_000 }),
      picker.setFiles({ name: 'Translation recovery field notes.pdf', mimeType: 'application/pdf', buffer: pdf })]);
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(!failure.ok(), 'The model response is valid JSON but repeats the English source.');
    const failureMessage: string = (await failure.json()).error;
    assert.match(failureMessage, /English|untranslated/i);
    assert.deepEqual(faulty.errors, []);
    assert.deepEqual(faulty.requests.map(blocks => clean(blocks.map(block => block.text).join(' '))), [sentences[0]]);
    const status = reader.locator('.pdf-translation-state');
    await reader.locator('.pdf-translation-state[data-state="error"]').waitFor();
    assert.equal(await status.locator('.pdf-status-message').innerText(), failureMessage);
    const retry = status.getByRole('button', { name: 'Retry translation' });
    await retry.waitFor();
    const original = sheet(reader, 'Original', 1);
    const target = sheet(reader, 'Simplified Chinese', 1);
    assert.equal(clean(await original.locator('.pdf-native-text').innerText()), sentences[0]);
    assert.deepEqual(await painted(target), {});
    assert.equal(await target.locator('.pdf-native-text').count(), 0, 'The target must not expose English selection text.');
    const sourceInk = await inkPixels(original);
    const targetInk = await inkPixels(target);
    assert.ok(sourceInk > 150 && targetInk < sourceInk * 0.1, 'The failed, text-only page must mask the original raster glyphs.');
    assert.deepEqual(await cache(reader, docId, 1), {}, 'An echoed PDF translation must never be cached.');

    await status.getByRole('button', { name: 'Connections', exact: true }).click();
    assert.equal(await urlField.inputValue(), faulty.url);
    assert.equal(await modelField.inputValue(), faulty.model);
    await urlField.fill(originalUrl);
    await modelField.fill(originalModel);
    await dialog.getByRole('button', { name: 'Save connections' }).click();
    await dialog.waitFor({ state: 'hidden' });

    const requestedPages: number[] = [];
    // Hold outbound requests only. The real DSH host supplies every successful response and cache entry.
    await page.context().route('**/api/paper-reader/action', async route => {
      const request = route.request();
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        if (body.op === 'translation.page' && body.payload.docId === docId) {
          const number = Number(body.payload.page);
          requestedPages.push(number);
          const hold = gates[number - 1];
          if (hold) { hold.started.resolve(); await hold.release.promise; }
        }
      }
      await route.continue();
    });
    await retry.click();
    await started(gates[0].started.promise, 'Retry');
    await reader.locator('.pdf-translation-state[data-state="loading"]').waitFor();
    await reader.getByRole('button', { name: 'Next page' }).click();
    await started(gates[1].started.promise, 'The second page');
    const second = sheet(reader, 'Simplified Chinese', 2);
    await second.waitFor();
    await second.locator('.pdf-translation-state[data-state="loading"]').waitFor();
    assert.equal(clean(await sheet(reader, 'Original', 2).locator('.pdf-native-text').innerText()), sentences[1]);
    const firstReply = page.waitForResponse(response => resultFor(response, docId, 1), { timeout: 150_000 });
    gates[0].release.resolve();
    const firstResponse = await firstReply;
    assert.equal(firstResponse.status(), 200, await firstResponse.text());
    const firstMap: Translations = (await firstResponse.json()).translations;
    assert.deepEqual(Object.keys(firstMap).sort(), faulty.requests[0].map(block => block.id).sort());
    const firstText = Object.values(firstMap).join(' ');
    assert.match(firstText, /\u82f9\u679c/u, 'The recovered first page must translate the apple trees.');
    assert.match(firstText, /37/, 'The first page must retain the number of trees.');
    await second.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.deepEqual(await painted(second), {}, 'The late page-one response must not paint on page two.');
    assert.deepEqual(await cache(reader, docId, 1), firstMap);
    assert.deepEqual(await cache(reader, docId, 2), {});

    const secondReply = page.waitForResponse(response => resultFor(response, docId, 2), { timeout: 150_000 });
    gates[1].release.resolve();
    const secondResponse = await secondReply;
    assert.equal(secondResponse.status(), 200, await secondResponse.text());
    const secondMap: Translations = (await secondResponse.json()).translations;
    const secondText = Object.values(secondMap).join(' ');
    assert.match(secondText, /\u4e58\u5ba2|\u65c5\u5ba2/u, 'The second page must translate the passengers.');
    assert.match(secondText, /84/, 'The second page must retain its own passenger count.');
    assert.notDeepEqual(Object.values(secondMap), Object.values(firstMap));
    await status.waitFor({ state: 'hidden' });
    assert.deepEqual(await painted(second), secondMap);
    assert.deepEqual(await cache(reader, docId, 2), secondMap);
    await reader.getByRole('button', { name: 'Previous page' }).click();
    await target.locator('.pdf-translated-text:visible').first().waitFor();
    assert.deepEqual(await painted(target), firstMap);
    const savedUrl = await reader.locator('body').evaluate(body => body.ownerDocument.location.href);
    assert.equal(new URL(savedUrl).searchParams.get('doc'), docId);
    assert.equal(new URL(savedUrl).searchParams.get('page'), '1');
    const reopened = await page.context().newPage();
    await reopened.goto(savedUrl);
    const restored = sheet(reopened, 'Simplified Chinese', 1);
    await restored.locator('.pdf-translated-text:visible').first().waitFor();
    assert.deepEqual(await painted(restored), firstMap);
    assert.deepEqual(requestedPages, [1, 2], 'Paging back and reopening must use the exact saved page.');
    assert.equal(faulty.requests.length, 1);
    assert.deepEqual(browserErrors, []);
    console.log('PASS PDF recovery: the English echo returned HTTP ' + failure.status() + ' and left an empty cache. '
      + 'Original and failed target rasters contained ' + sourceInk + ' and ' + targetInk + ' dark pixels. '
      + 'After connection repair, two real inference requests translated 37 apple trees and 84 passengers. '
      + 'The late first response stayed off page two, and reopening restored the exact saved text without another request.');
  } finally {
    for (const hold of gates) hold.release.resolve();
    await browser.close();
    await faulty.close();
  }
});
