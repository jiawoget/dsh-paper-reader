import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page, type Request, type Route } from 'playwright-core';
import sharp from 'sharp';
import { openReader, withHost, type HostFixture } from './host.js';

const note = '我需要你用德语解释下';
const firstQuestion = '根据我的这里的笔记和截图，看一看你需要做什么，用一句话回答';
const nextQuestion = '请现在按笔记里的要求解释这张截图。';
const extraNote = '请保留 KV 缓存这个术语。';
const revisedNote = '这次请用法语解释这段截图。\n\n只解释图下方的这几行。';
const otherNote = '右栏只关注解码阶段，请用日语回答。';
const receipt = '测试服务已收到请求。';
const baseline = process.argv.includes('--baseline');
const devices = process.argv.includes('--mobile') ? [true] : process.argv.includes('--desktop') ? [false] : [false, true];

type Point = { x: number; y: number };
type Capture = { width: number; height: number; raster: string };
type Part = { type: string; text?: string; image_url?: { url: string } };
type Message = { role: string; content: string | Part[] };
type ModelCall = { system: string; input: {
  question: string; regionText?: string; readerNotes?: string[]; previousMaterial?: { readerNotes?: string[] }[]; history?: unknown
}; images: string[] };

async function requestRecorder() {
  const key = randomUUID(), model = 'reading-note-recorder';
  const calls: ModelCall[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer ' + key) {
      response.writeHead(403).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages: Message[] };
      assert.equal(body.model, model);
      const system = body.messages.find(message => message.role === 'system')?.content;
      const user = body.messages.findLast(message => message.role === 'user')?.content;
      assert.equal(typeof system, 'string');
      assert.ok(user);
      const parts = typeof user === 'string' ? [{ type: 'text', text: user }] : user;
      const input = JSON.parse(parts.filter(part => part.type === 'text').map(part => part.text).join('')) as ModelCall['input'];
      const images = parts.flatMap(part => part.image_url ? [part.image_url.url] : []);
      calls.push({ system: system as string, input, images });
      // A receipt lets the discussion continue without simulating a correct model answer.
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: receipt } }] }));
    } catch {
      response.writeHead(422).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { key, model, url: 'http://127.0.0.1:' + address.port + '/v1', calls,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

async function standaloneUrl(browser: Browser, host: HostFixture) {
  const context = await browser.newContext({ locale: 'en-US' });
  try {
    const pane = await openReader(await context.newPage(), host.authenticatedUrl);
    await pane.getByRole('button', { name: 'More actions' }).click();
    const [page] = await Promise.all([context.waitForEvent('page'), pane.getByRole('button', { name: 'Open in new tab' }).click()]);
    await page.getByText('PagedAttention.pdf', { exact: true }).waitFor();
    return page.url();
  } finally { await context.close(); }
}

async function tapOrClick(control: Locator, mobile: boolean) {
  if (mobile) await control.tap();
  else await control.click();
}

async function connect(page: Page, model: Awaited<ReturnType<typeof requestRecorder>>, mobile: boolean) {
  await tapOrClick(page.getByRole('button', { name: '更多操作' }), mobile);
  await tapOrClick(page.getByRole('button', { name: '连接设置', exact: true }), mobile);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('API 接口地址').fill(model.url);
  await dialog.getByLabel('模型', { exact: true }).fill(model.model);
  await dialog.getByLabel('API 密钥', { exact: true }).fill(model.key);
  await tapOrClick(dialog.getByRole('button', { name: '保存连接设置' }), mobile);
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('连接设置已保存。', { exact: true }).waitFor({ state: 'hidden' });
}

async function drag(page: Page, start: Point, end: Point, mobile: boolean) {
  if (!mobile) {
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
      const x = start.x + (end.x - start.x) * step / 12;
      const y = start.y + (end.y - start.y) * step / 12;
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await input.detach(); }
}

const blockTableLines = [
  'physical KV blocks of each request. Each block table entry',
  'and the number of filled positions. Separating logical and'
] as const;
const decodingLines = [
  'requests and the latest tokens for generation phase requests)',
  'computation, vLLM uses the PagedAttention kernel to access'
] as const;
async function captureArea(page: Page, lines: readonly [string, string], mobile: boolean): Promise<Capture> {
  await tapOrClick(page.getByRole('button', { name: '截图问 AI', exact: true }), mobile);
  await page.locator('.pdf-capture-surface').waitFor();
  const layer = page.locator('#original .pdf-native-text');
  const top = layer.getByText(lines[0], { exact: true });
  const bottom = layer.getByText(lines[1], { exact: true });
  await top.scrollIntoViewIfNeeded();
  await bottom.scrollIntoViewIfNeeded();
  const first = await top.boundingBox(), last = await bottom.boundingBox();
  assert.ok(first && last);
  const start = { x: Math.floor(Math.min(first.x, last.x) - 2), y: Math.floor(first.y - 2) };
  const end = { x: Math.ceil(Math.max(first.x + first.width, last.x + last.width) + 2), y: Math.ceil(last.y + last.height + 2) };
  const width = end.x - start.x, height = end.y - start.y;
  assert.ok(width > 30 && height > 12 && start.x >= 0 && start.y >= 0 && end.x <= page.viewportSize()!.width && end.y <= page.viewportSize()!.height,
    `The page 6 text should be in view before capturing. ${JSON.stringify({ start, end })}`);
  const raster = await page.locator('#original canvas.pdf-raster').evaluate((node, area) => {
    const source = node as HTMLCanvasElement, bounds = source.getBoundingClientRect();
    const sample = document.createElement('canvas');
    const sx = source.width / bounds.width, sy = source.height / bounds.height;
    sample.width = Math.ceil(area.width * sx);
    sample.height = Math.ceil(area.height * sy);
    sample.getContext('2d')!.drawImage(source, (area.start.x - bounds.left) * sx, (area.start.y - bounds.top) * sy,
      area.width * sx, area.height * sy, 0, 0, sample.width, sample.height);
    return sample.toDataURL('image/png');
  }, { start, width, height });
  await drag(page, start, end, mobile);
  await page.locator('.pdf-capture-actions').waitFor();
  return { width, height, raster };
}

function pngBytes(image: string) {
  assert.ok(image?.startsWith('data:image/png;base64,'), 'Selected PDF pixels must arrive as a PNG attachment.');
  const png = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return png;
}

async function checkPixels(url: string, capture: Capture) {
  const png = pngBytes(url);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(Math.abs(width / height / (capture.width / capture.height) - 1) < .06);
  // The on-screen page and attachment rasterize the same type at different resolutions.
  const sample = (image: Buffer) => sharp(image).flatten({ background: '#fff' }).resize(64, 32, { fit: 'fill' }).greyscale().blur(.7).raw().toBuffer();
  const [actual, reference] = await Promise.all([sample(png), sample(pngBytes(capture.raster))]);
  assert.ok(actual.some(value => value < 200) && reference.some(value => value < 200), 'Both the drawn area and attachment should contain PDF ink.');
  const error = actual.reduce((sum, value, index) => sum + Math.abs(value - reference[index]), 0) / actual.length;
  const blank = reference.reduce((sum, value) => sum + 255 - value, 0) / reference.length;
  assert.ok(error < blank * .65, 'The attachment must contain the drawn PDF region. Mean pixel difference: ' + error.toFixed(2) + ', blank: ' + blank.toFixed(2));
  return error;
}

function discussion(page: Page) { return page.locator('.selection-chat:visible'); }

function notes(page: Page) { return discussion(page).getByLabel('当前选区笔记'); }

function composer(page: Page) { return discussion(page).getByRole('textbox', { name: '针对此选段提问' }); }

function noteEditor(page: Page) { return notes(page).getByRole('textbox', { name: '笔记内容', exact: true }); }

function savedNote(page: Page, text: string) { return notes(page).locator('.selection-saved-note').filter({ hasText: text }); }

async function saveNote(page: Page, text: string, mobile: boolean) {
  await noteEditor(page).fill(text);
  await tapOrClick(notes(page).getByRole('button', { name: '保存笔记', exact: true }), mobile);
  await noteEditor(page).waitFor({ state: 'hidden' });
  await savedNote(page, text.split('\n')[0]).waitFor();
}

async function send(page: Page, question: string, mobile: boolean) {
  await composer(page).fill(question);
  await tapOrClick(discussion(page).getByRole('button', { name: '发送', exact: true }), mobile);
}

async function readReply(page: Page, recorder: Awaited<ReturnType<typeof requestRecorder>>, question: string, submit: () => Promise<void>) {
  const previous = recorder.calls.length;
  const answers = discussion(page).locator('.selection-answer').getByText(receipt, { exact: true });
  const index = await answers.count();
  await submit();
  await answers.nth(index).waitFor();
  assert.equal(recorder.calls.length, previous + 1);
  const call = recorder.calls[previous];
  assert.equal(call.input.question, question);
  return call;
}

function ask(page: Page, recorder: Awaited<ReturnType<typeof requestRecorder>>, question: string, mobile: boolean) {
  return readReply(page, recorder, question, () => send(page, question, mobile));
}

async function sendWhileSaving<T>(page: Page, sendQuestion: (release: () => void) => Promise<T>, failSave = false) {
  const action = '**/api/paper-reader/action';
  const release = Promise.withResolvers<void>();
  const isNoteSave = (request: Request) => request.url().endsWith('/api/paper-reader/action') &&
    request.method() === 'POST' && request.postDataJSON().op === 'note.save';
  const delay = async (route: Route) => {
    if (isNoteSave(route.request())) {
      await release.promise;
      if (failSave) return route.fulfill({ status: 503, json: { error: 'Test note save temporarily unavailable.' } });
    }
    await route.continue();
  };
  await page.route(action, delay);
  try {
    await Promise.all([page.waitForRequest(isNoteSave), notes(page).getByRole('button', { name: '保存笔记', exact: true }).click()]);
    assert.equal(await notes(page).getByRole('button', { name: '保存中…', exact: true }).isDisabled(), true);
    return await sendQuestion(release.resolve);
  } finally {
    release.resolve();
    await page.unroute(action, delay);
  }
}

function summarize({ system, input, images }: ModelCall) {
  return { system, input, images: images.map(image => {
    const png = pngBytes(image);
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: createHash('sha256').update(png).digest('hex') };
  }) };
}

function checkNotes(call: ModelCall, expected: string[]) {
  assert.deepEqual([...(call.input.readerNotes ?? [])].sort(), [...expected].sort(),
    'The model must receive exactly the saved notes for «' + call.input.question + '». Provider fields: ' + Object.keys(call.input).join(', '));
}

async function reopenFirstCapture(page: Page, mobile: boolean) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#loading').waitFor({ state: 'hidden' });
  await tapOrClick(page.getByRole('button', { name: '全文问答', exact: true }), mobile);
  const turn = page.locator('.paper-chat-question').filter({ hasText: firstQuestion });
  await tapOrClick(turn.locator('.source-chip'), mobile);
  await tapOrClick(page.locator('#original').getByRole('button', { name: '继续问这张截图', exact: true }), mobile);
  await discussion(page).getByText(firstQuestion, { exact: true }).waitFor();
  await discussion(page).getByText(nextQuestion, { exact: true }).waitFor();
}

for (const mobile of devices) await withHost(async host => {
  const model = await requestRecorder();
  const browser = await chromium.launch({ executablePath: host.executable });
  const device = mobile ? 'phone' : 'desktop';
  const evidence = process.env.PAPER_READER_NOTE_ARTIFACTS ?? path.join(host.artifacts, 'reviews', 'selection-note-discussion');
  await mkdir(evidence, { recursive: true });
  const prefix = path.join(evidence, (baseline ? 'old-' : 'new-') + device);
  const pixelErrors: Record<string, number> = {};
  try {
    const url = await standaloneUrl(browser, host);
    const page = await browser.newPage({ locale: 'zh-CN', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByText('PagedAttention.pdf', { exact: true }).waitFor();
    await connect(page, model, mobile);
    const pageJump = page.getByRole('button', { name: /跳转到页码/ });
    if (!(await pageJump.innerText()).includes('6 /')) {
      await tapOrClick(pageJump, mobile);
      await page.getByRole('spinbutton', { name: '页码' }).fill('6');
      await tapOrClick(page.getByRole('button', { name: '跳转', exact: true }), mobile);
    }
    const capture = await captureArea(page, blockTableLines, mobile);
    await tapOrClick(page.locator('.pdf-capture-actions').getByRole('button', { name: '记笔记', exact: true }), mobile);
    await saveNote(page, note, mobile);
    assert.equal(model.calls.length, 0, 'Saving a note does not contact the model.');
    const first = await ask(page, model, firstQuestion, mobile);
    const photo = () => page.screenshot({ path: prefix + '.png', animations: 'disabled', scale: 'css' });
    if (mobile) await photo();
    const next = await ask(page, model, nextQuestion, mobile);
    assert.equal(first.images.length, 1);
    assert.match(first.input.regionText ?? '', /Each block table entry records the corresponding physical blocks/);
    pixelErrors.first = await checkPixels(first.images[0], capture);
    assert.deepEqual(next.images, first.images, 'Both prompts should receive the same screenshot.');
    const preview = discussion(page).getByRole('img', { name: '框选的 PDF 区域' });
    assert.equal(await preview.getAttribute('src'), first.images[0]);
    assert.deepEqual(next.input.history, [{ role: 'user', content: firstQuestion }, { role: 'assistant', content: receipt }]);
    if (!mobile) await photo();
    checkNotes(first, [note]);
    checkNotes(next, [note]);

    await tapOrClick(notes(page).getByRole('button', { name: '再记一条', exact: true }), mobile);
    await noteEditor(page).fill(extraNote);
    checkNotes(await ask(page, model, '这个框里说块表记录了什么？', mobile), [note]);
    if (mobile) await saveNote(page, extraNote, mobile);
    else {
      const question = '现在连刚保存的笔记一起看。';
      const beforeFailure = model.calls.length;
      const problem = discussion(page).getByRole('alert').getByText('请先保存这条笔记，再重试提问。', { exact: true });
      const retry = discussion(page).getByRole('button', { name: '重试', exact: true });
      await sendWhileSaving(page, async release => {
        await send(page, question, false);
        release();
        await problem.waitFor();
      }, true);
      assert.equal(model.calls.length, beforeFailure, 'A failed save should stop the pending question before it reaches the model.');
      assert.equal(await noteEditor(page).inputValue(), extraNote, 'A failed save should preserve the note draft.');
      assert.equal(await composer(page).inputValue(), question, 'A failed save should preserve the unsent question.');
      await retry.click();
      await problem.waitFor();
      assert.equal(model.calls.length, beforeFailure, 'Retry should still wait for a successful save.');
      const saved = await sendWhileSaving(page, release => readReply(page, model, question, async () => {
        await retry.click();
        release();
      }));
      checkNotes(saved, [note, extraNote]);
    }
    await tapOrClick(savedNote(page, note).getByRole('button', { name: '编辑', exact: true }), mobile);
    await saveNote(page, revisedNote, mobile);
    checkNotes(await ask(page, model, '请按这里最新保存的笔记回答。', mobile), [revisedNote, extraNote]);

    await tapOrClick(discussion(page).getByRole('button', { name: '收起讨论', exact: true }), mobile);
    const otherCapture = await captureArea(page, decodingLines, mobile);
    await tapOrClick(page.locator('.pdf-capture-actions').getByRole('button', { name: '记笔记', exact: true }), mobile);
    await saveNote(page, otherNote, mobile);
    const other = await ask(page, model, '让我看看这个框的笔记和正文。', mobile);
    checkNotes(other, [otherNote]);
    assert.deepEqual(other.input.history, [], 'A separate screenshot on the same page must have its own discussion.');
    assert.equal(other.images.length, 1);
    assert.notEqual(other.images[0], first.images[0]);
    pixelErrors.other = await checkPixels(other.images[0], otherCapture);

    const beforeReopen = model.calls.length;
    await reopenFirstCapture(page, mobile);
    await savedNote(page, revisedNote.split('\n')[0]).waitFor();
    await savedNote(page, extraNote).waitFor();
    assert.equal(model.calls.length, beforeReopen, 'Reopening the original discussion should load it without calling the model.');
    const reopened = await ask(page, model, '重新打开后，这个框有哪些笔记？', mobile);
    checkNotes(reopened, [revisedNote, extraNote]);
    assert.equal(reopened.images.length, 1);
    pixelErrors.reopened = await checkPixels(reopened.images[0], capture);

    if (!mobile) {
      const noteId = await savedNote(page, extraNote).getAttribute('data-note-id');
      assert.ok(noteId);
      await page.locator('#mobileRail').click();
      const notebook = page.getByLabel('阅读笔记', { exact: true });
      const linkedNote = notebook.locator('.notebook-source[data-note-id=' + JSON.stringify(noteId) + ']');
      await linkedNote.getByRole('button', { name: '删除关联笔记', exact: true }).click();
      await notebook.getByRole('button', { name: '保存', exact: true }).click();
      await notebook.getByText('已保存到本机', { exact: true }).waitFor();
      await page.locator('#closeRail').click();
      await savedNote(page, extraNote).waitFor({ state: 'hidden' });
      checkNotes(await ask(page, model, '删除一条后，这个框还剩哪些笔记？', mobile), [revisedNote]);

      await page.getByRole('button', { name: '读正文', exact: true }).click();
      await page.getByRole('region', { name: '本页正文' }).getByRole('button', { name: /选中此段.*Parallel cache access/ }).click();
      await page.locator('#card').getByRole('button', { name: '接着问', exact: true }).click();
      const mixed = await ask(page, model, '也看看这段原文，按前一张截图的笔记解释。', mobile);
      checkNotes(mixed, []);
      assert.deepEqual(mixed.input.previousMaterial?.map(material => material.readerNotes), [[revisedNote]]);
      assert.deepEqual(mixed.images, first.images);
    }
    assert.deepEqual(errors, []);
    console.log('PASS ' + device + ': actual PDF pixels, both original questions, unsaved draft, edited and added notes, independent same-page crop, refresh and reopen' +
      (mobile ? '.' : ', send during successful and failed saves, and note deletion.'));
  } finally {
    if (model.calls.length) await writeFile(prefix + '-requests.json', JSON.stringify({ pixelErrors, calls: model.calls.map(summarize) }, null, 2) + '\n');
    await browser.close();
    await model.close();
  }
});
