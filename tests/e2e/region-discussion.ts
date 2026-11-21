import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import type { Operations } from '../../src/shared/types.js';
import { openReader, withHost, type HostFixture } from './host.js';

type Point = { x: number; y: number };
type Bounds = readonly [left: number, top: number, right: number, bottom: number];
interface Crop { aspect: number; pixels: number[] }
interface ModelPart { type: string; text?: string; image_url?: { url?: string } }
interface ModelMessage { role: string; content: string | ModelPart[] }
interface ModelCall { image?: string; text: string; answer: string }

const docId = 'pagedattention';
const sampleWidth = 64;
const sampleHeight = 48;
const firstRegion: Bounds = [.07, .16, .62, .83];
const otherRegion: Bounds = [.66, .14, .95, .70];
const phoneRegion: Bounds = [.11, .07, .78, .59];
const firstQuestion = '这张截图里箭头指向哪里？';
const followup = '逻辑块 0 怎样通过块表找到物理块？';
const otherQuestion = '右侧这个区域显示了哪些物理块？';
const afterReopen = '图中每行对应什么？';
const compactQuestion = 'Which objects in the screenshot are physical blocks?';
const replies = [
  '截图里的箭头从块表指向物理块。',
  '查块表的第 0 项，即可找到逻辑块 0 对应的物理块。',
  '这个选框只覆盖图右侧的一部分物理块。',
  '每行对应一个块表项，记录一个逻辑块的物理位置。',
  'The crop shows the block table and part of the physical block grid.',
  'The physical blocks are the cells on the right side of the crop.'
];

async function visionFixture() {
  const model = 'region-vision-fixture';
  const key = randomUUID();
  const calls: ModelCall[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(403).end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages: ModelMessage[] };
      if (body.model !== model || !Array.isArray(body.messages)) { res.writeHead(400).end(); return; }
      const users = body.messages.filter(message => message.role === 'user');
      const latest = users.at(-1)?.content;
      const image = Array.isArray(latest) ? latest.find(part => part.type === 'image_url')?.image_url?.url : undefined;
      const text = body.messages.filter(message => message.role !== 'system').map(({ content }) =>
        typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n');
      const answer = replies[calls.length] ?? 'This extra answer was not expected.';
      calls.push({ image, text, answer });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] }));
    } catch {
      res.writeHead(422).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    calls, model, key, baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}

async function action<K extends keyof Operations>(page: Page, host: HostFixture, op: K, payload: Operations[K][0]): Promise<Operations[K][1]> {
  const response = await page.request.post(host.origin + '/api/paper-reader/action', { data: { op, payload } });
  assert.ok(response.ok(), op + ' returned HTTP ' + response.status());
  return response.json();
}

function figure(page: Page) {
  return page.locator('#original .pdf-figure[data-block-id="figure-6"]');
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, 'The intended control or PDF crop must be visible.');
  return bounds;
}

async function drag(page: Page, start: Point, end: Point, touch: boolean): Promise<void> {
  if (!touch) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    return;
  }
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let step = 1; step <= 12; step++) {
      const x = start.x + (end.x - start.x) * (step / 12), y = start.y + (end.y - start.y) * (step / 12);
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await input.detach(); }
}

async function drawCrop(page: Page, area: Bounds, touch = false): Promise<Crop> {
  const trigger = page.locator('#captureRegion');
  if (touch) await trigger.tap();
  else await trigger.click();
  await page.locator('.pdf-capture-surface').waitFor();
  const subject = figure(page);
  await subject.scrollIntoViewIfNeeded();
  const rect = await box(subject);
  const start = { x: Math.round(rect.x + area[0] * rect.width), y: Math.round(rect.y + area[1] * rect.height) };
  const end = { x: Math.round(rect.x + area[2] * rect.width), y: Math.round(rect.y + area[3] * rect.height) };
  const width = end.x - start.x, height = end.y - start.y;
  const paper = await box(page.locator('#original canvas.pdf-raster'));
  const sourceArea = { x: (start.x - paper.x) / paper.width, y: (start.y - paper.y) / paper.height,
    width: width / paper.width, height: height / paper.height };
  await drag(page, start, end, touch);
  await page.locator('.pdf-capture-actions').waitFor();
  const marker = await box(page.locator('#original .pdf-region-marker'));
  const endError = Math.max(Math.abs(marker.x - start.x), Math.abs(marker.y - start.y),
    Math.abs(marker.x + marker.width - end.x), Math.abs(marker.y + marker.height - end.y));
  assert.ok(endError <= 2, 'The selection marker must follow both pointer endpoints.');

  // Sample the original PDF at a fixed resolution. The displayed phone canvas can change density between gestures.
  const pixels = await page.evaluate(async ({ sourceArea, sampleWidth, sampleHeight }) => {
    const moduleUrl = new URL('../vendor/pdf.mjs', location.href).href;
    const pdfjs: typeof import('pdfjs-dist') = await import(moduleUrl);
    const task = pdfjs.getDocument({ url: new URL('assets/pagedattention.pdf', location.href).href,
      standardFontDataUrl: new URL('../vendor/standard_fonts/', location.href).href });
    try {
      const sheet = await (await task.promise).getPage(6), viewport = sheet.getViewport({ scale: 3 });
      const source = document.createElement('canvas');
      source.width = Math.ceil(viewport.width); source.height = Math.ceil(viewport.height);
      await sheet.render({ canvas: source, viewport, background: '#ffffff' }).promise;
      const sample = document.createElement('canvas');
      sample.width = sampleWidth; sample.height = sampleHeight;
      const ctx = sample.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, sourceArea.x * source.width, sourceArea.y * source.height,
        sourceArea.width * source.width, sourceArea.height * source.height, 0, 0, sampleWidth, sampleHeight);
      return Array.from(ctx.getImageData(0, 0, sampleWidth, sampleHeight).data);
    } finally { await task.destroy(); }
  }, { sourceArea, sampleWidth, sampleHeight });
  assert.ok(pixels.some((value, index) => index % 4 === 0 && value < 190), 'The named PDF area contains drawn ink.');
  return { aspect: width / height, pixels };
}

async function matchesCrop(page: Page, url: string | undefined, expected: Crop): Promise<void> {
  assert.ok(url && url.startsWith('data:image/png;base64,'), 'The model must receive a PNG through image_url.');
  const png = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'The attachment must be usable PNG bytes.');
  const actualWidth = png.readUInt32BE(16), actualHeight = png.readUInt32BE(20);
  const actualAspect = actualWidth / actualHeight;
  assert.ok(Math.abs(actualAspect / expected.aspect - 1) < .05,
    'The PNG aspect ratio must fit the dragged box, received ' + actualWidth + '×' + actualHeight + '.');
  const values = await page.evaluate(async ({ url, sampleWidth, sampleHeight }) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = sampleWidth; canvas.height = sampleHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  }, { url, sampleWidth, sampleHeight });
  assert.ok(values.some((value, index) => index % 4 === 0 && value < 190), 'The PNG must contain ink from the PDF.');
  const meanError = values.reduce((total, value, index) => total + (index % 4 === 3 ? 0 : Math.abs(value - expected.pixels[index])), 0) /
    (sampleWidth * sampleHeight * 3);
  assert.ok(meanError < 14, 'The PNG must contain the pixels in the dragged box, mean sample error ' + meanError.toFixed(2) + '.');
}

function chat(page: Page) {
  return page.locator('#card .selection-chat');
}

async function sendQuestion(page: Page, question: string, touch = false): Promise<void> {
  const input = chat(page).getByRole('textbox');
  await input.fill(question);
  if (touch) await chat(page).getByRole('button', { name: 'Send', exact: true }).tap();
  else await input.press('Enter');
}

async function answer(page: Page, text: string): Promise<void> {
  await chat(page).locator('.selection-answer').getByText(text, { exact: true }).waitFor();
}

function priorTurns(call: ModelCall, question: string, answerText: string): void {
  const from = call.text.indexOf(question);
  assert.ok(from >= 0 && call.text.indexOf(answerText, from) > from, 'The model must receive the preceding reader and assistant turn in order.');
}

async function touchCancelRestoresView(page: Page, previousView: Locator): Promise<void> {
  const trigger = page.locator('#captureRegion');
  const surface = page.locator('.pdf-capture-surface');
  await previousView.waitFor();
  const offset = await page.locator('#paperScroll').evaluate(node => {
    node.scrollTo({ top: 145, left: 28, behavior: 'instant' });
    return { top: node.scrollTop, left: node.scrollLeft };
  });
  assert.ok(offset.top > 0, 'The cancellation check must start partway down the document.');
  await trigger.tap();
  await surface.waitFor();
  await page.locator('#original .pdf-sheet').waitFor();
  assert.equal(await previousView.isVisible(), false, 'The original paper must temporarily replace the current view.');
  await trigger.tap();
  await surface.waitFor({ state: 'hidden' });
  await previousView.waitFor();
  await page.waitForFunction(({ top, left }) => {
    const node = document.getElementById('paperScroll')!;
    return Math.abs(node.scrollTop - top) <= 1 && Math.abs(node.scrollLeft - left) <= 1;
  }, offset);
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  const model = await visionFixture();
  const directory = path.join(host.artifacts, 'reviews', 'region-discussion');
  const entry = host.origin + '/api/paper-reader/app/index.html?doc=' + docId + '&page=6';
  await mkdir(directory, { recursive: true });
  const screenshot = (page: Page, name: string) => page.screenshot({ path: path.join(directory, name + '.png'), animations: 'disabled' });
  try {
    const hostPage = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const pane = await openReader(hostPage, host.authenticatedUrl);
    await pane.locator('#original .pdf-figure[data-block-id="figure-6"]').waitFor();
    assert.ok(await pane.locator('#captureRegion').isVisible(), 'The PDF toolbar must offer screenshot questions in DSH.');
    await hostPage.close();

    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.authenticatedUrl);
    await action(page, host, 'settings.save', { baseUrl: model.baseUrl, apiKey: model.key, model: model.model });
    await page.goto(entry);
    await figure(page).waitFor();
    assert.ok(await page.locator('#captureRegion').isVisible(), 'The PDF toolbar must offer screenshot questions.');

    await drawCrop(page, firstRegion);
    await screenshot(page, '01-截图框选');
    await page.keyboard.press('Escape');
    await page.locator('.pdf-capture-surface').waitFor({ state: 'hidden' });
    await page.locator('.pdf-capture-actions').waitFor({ state: 'hidden' });
    assert.equal(await chat(page).isVisible(), false);
    assert.equal(model.calls.length, 0, 'Canceling selection must avoid a model request.');
    assert.ok(await page.locator('#captureRegion').evaluate(node => node === document.activeElement));

    await page.locator('#captureRegion').press('Enter');
    const surface = page.locator('.pdf-capture-surface');
    await surface.waitFor();
    assert.ok(await surface.evaluate(node => node === document.activeElement));
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    await page.locator('.pdf-capture-actions').getByRole('button', { name: '提问', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await surface.waitFor({ state: 'hidden' });
    assert.equal(model.calls.length, 0);

    const firstCrop = await drawCrop(page, firstRegion);
    await page.locator('.pdf-capture-actions').getByRole('button', { name: '提问', exact: true }).click();
    const input = chat(page).getByRole('textbox');
    await input.waitFor();
    assert.ok(await input.evaluate(node => node === document.activeElement), 'Ask should open the composer ready for typing.');
    assert.equal(model.calls.length, 0, 'Ask should wait for the reader to send a question.');
    await sendQuestion(page, firstQuestion);
    await answer(page, replies[0]);
    const first = model.calls[0];
    assert.equal(model.calls.length, 1);
    assert.ok(first.text.includes(firstQuestion));
    await matchesCrop(page, first.image, firstCrop);
    const preview = chat(page).locator('img').first();
    await preview.waitFor();
    assert.equal(await preview.getAttribute('src'), first.image);

    await sendQuestion(page, followup);
    await answer(page, replies[1]);
    const second = model.calls[1];
    assert.equal(model.calls.length, 2);
    assert.equal(second.image, first.image, 'A follow-up must send the same screenshot bytes again.');
    assert.ok(second.text.includes(followup));
    priorTurns(second, firstQuestion, first.answer);
    await screenshot(page, '02-同一截图继续追问');
    const draft = '回到图上核对后再继续。';
    await input.fill(draft);
    await chat(page).getByRole('button', { name: /查看原处/ }).click();
    await page.locator('#original .pdf-region-marker').waitFor();
    await page.getByRole('button', { name: '返回讨论', exact: true }).click();
    assert.equal(await input.inputValue(), draft);
    assert.equal(await preview.getAttribute('src'), first.image);
    assert.equal(model.calls.length, 2);

    const history = () => action(page, host, 'chat.history', { docId });
    const initial = (await history()).exchanges;
    const saved = initial.find(turn => turn.question === firstQuestion);
    assert.ok(saved?.source);
    assert.match(saved.source.anchor, /^region-\d+-\d+-\d+-\d+$/);
    assert.equal(new URL(saved.source.sourceUrl).searchParams.get('anchor'), saved.source.anchor);
    assert.equal(initial.find(turn => turn.question === followup)?.thread, saved.thread);
    await chat(page).getByRole('button', { name: '收起讨论', exact: true }).click();
    await page.locator('#zoom').selectOption('1.25');
    await page.locator('#parallel').click();
    const separateCrop = await drawCrop(page, otherRegion);
    await page.locator('.pdf-capture-actions').getByRole('button', { name: '单独提问', exact: true }).click();
    assert.equal(await chat(page).getByText(replies[0], { exact: true }).count(), 0);
    await sendQuestion(page, otherQuestion);
    await answer(page, replies[2]);
    const third = model.calls[2];
    assert.equal(model.calls.length, 3);
    assert.ok(third.text.includes(otherQuestion) && !third.text.includes(firstQuestion) && !third.text.includes(first.answer));
    assert.notEqual(third.image, first.image, 'A different part of the same figure must produce a different PNG.');
    await matchesCrop(page, third.image, separateCrop);
    const other = (await history()).exchanges.find(turn => turn.question === otherQuestion);
    assert.ok(other?.source);
    assert.notEqual(other.thread, saved.thread);
    assert.notEqual(other.source.anchor, saved.source.anchor);

    await page.reload();
    await page.locator('#loading').waitFor({ state: 'hidden' });
    await page.locator('#next').click();
    await page.waitForURL(url => url.searchParams.get('page') === '7');
    await page.getByRole('button', { name: '全文问答', exact: true }).click();
    const oldTurn = page.locator('.paper-chat-question').filter({ hasText: firstQuestion });
    await oldTurn.locator('.source-chip').click();
    await page.waitForURL(url => url.searchParams.get('page') === '6' && url.searchParams.get('anchor') === saved.source?.anchor);
    const marker = page.locator('#original .pdf-region-marker');
    await marker.click();
    await answer(page, replies[0]);
    await answer(page, replies[1]);
    assert.equal(model.calls.length, 3, 'Reopening a crop should restore both turns without sending a request.');
    await matchesCrop(page, (await preview.getAttribute('src')) ?? undefined, firstCrop);
    await sendQuestion(page, afterReopen);
    await answer(page, replies[3]);
    const resumed = model.calls[3];
    assert.ok(resumed.text.includes(afterReopen));
    priorTurns(resumed, firstQuestion, first.answer);
    priorTurns(resumed, followup, second.answer);
    await matchesCrop(page, resumed.image, firstCrop);
    assert.equal((await history()).exchanges.find(turn => turn.question === afterReopen)?.thread, saved.thread);
    assert.deepEqual(errors, []);
    console.log('PASS desktop drag, cancellation, cropped PDF pixels, repeated image and history, isolated crops, and saved source reopen.');

    const phone = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    phone.setDefaultTimeout(10_000);
    const phoneErrors: string[] = [];
    phone.on('pageerror', error => phoneErrors.push(error.message));
    await phone.goto(host.authenticatedUrl);
    await phone.goto(entry);
    await figure(phone).waitFor();
    await phone.locator('#zoom').selectOption('1.5');
    await phone.locator('#parallel').tap();
    await touchCancelRestoresView(phone, phone.locator('#translated .pdf-sheet'));
    assert.equal(await phone.locator('#parallel').getAttribute('aria-pressed'), 'true');
    await phone.locator('#originalMode').tap();
    await phone.locator('#zoom').selectOption('1');
    await phone.locator('#readText').tap();
    const pageText = phone.getByRole('region', { name: 'Page text' });
    await touchCancelRestoresView(phone, pageText);
    assert.equal(model.calls.length, 4, 'Canceling in translated or reflowed reading must not contact the model.');

    const title = phone.locator('#docTitle');
    assert.equal(await title.innerText(), 'PagedAttention.pdf');
    assert.ok((await box(title)).width >= 64, 'The compact toolbar must leave room for the paper title.');
    const compactCrop = await drawCrop(phone, phoneRegion, true);
    assert.ok((await box(title)).width >= 64, 'The paper title must remain visible while framing the screenshot.');
    await phone.locator('.pdf-capture-actions').getByRole('button', { name: 'Explain', exact: true }).tap();
    await answer(phone, replies[4]);
    const explained = model.calls[4];
    assert.equal(model.calls.length, 5, 'Explain should send one question after a touch crop.');
    await matchesCrop(phone, explained.image, compactCrop);
    await sendQuestion(phone, compactQuestion, true);
    await answer(phone, replies[5]);
    const phoneFollowup = model.calls[5];
    assert.equal(model.calls.length, 6);
    assert.equal(phoneFollowup.image, explained.image);
    assert.ok(phoneFollowup.text.includes(compactQuestion) && phoneFollowup.text.includes(explained.answer));
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const send = await box(chat(phone).getByRole('button', { name: 'Send', exact: true }));
    assert.ok(send.y + send.height <= 845, 'The compact composer must remain within reach.');
    await screenshot(phone, '03-触屏截图追问');
    await chat(phone).getByRole('button', { name: 'Close chat', exact: true }).tap();
    await pageText.waitFor();
    assert.deepEqual(phoneErrors, []);
    console.log('PASS compact translation and reflow restoration, touch crop, automatic explanation, and repeated attachment.');
  } finally {
    await browser.close();
    await model.close();
  }
});
