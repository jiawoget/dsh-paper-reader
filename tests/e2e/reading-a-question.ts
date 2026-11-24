import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import sharp from 'sharp';
import { openReader, withHost, type HostFixture } from './host.js';

const firstQuestion = '图 6 中，块表的箭头指向哪里？';
const followupQuestion = '对照图 7，两个请求如何复用同一片物理内存？';
const separateQuestion = '第 4.4 节说并行采样为读者提供什么？';
const firstSentence = '块表把逻辑块映射到物理块。';
const firstAnswer = firstSentence + '图 6 中，逻辑块 0 映射到物理块 7。';
const excerpt = '同一片物理内存容纳两个请求的 KV 缓存。';
const followupAnswer = excerpt + '每个请求的块表独立记录映射。';
const separateAnswer = '它从同一个提示生成多个输出，供使用者选择。';
const ownNote = '我的判断：容量可按块分配，每个请求保留自己的索引。';
const answers = new Map([[firstQuestion, firstAnswer], [followupQuestion, followupAnswer], [separateQuestion, separateAnswer]]);
const baseline = process.argv.includes('--baseline');
const mode = process.argv.includes('--mobile') ? [true] : process.argv.includes('--desktop') ? [false] : [false, true];

type Point = { x: number; y: number };
type Capture = { width: number; height: number; pixels: number[] };
type Part = { type: string; text?: string; image_url?: { url: string } };
type Message = { role: string; content: string | Part[] };
type ModelCall = { question: string; history?: unknown; images: string[] };

async function localModel() {
  const key = randomUUID();
  const name = 'reading-two-figures';
  const calls: ModelCall[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' ||
      request.headers.authorization !== 'Bearer ' + key) {
      response.writeHead(403).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages: Message[] };
      const images = envelope.messages.flatMap(message => typeof message.content === 'string' ? [] :
        message.content.flatMap(part => part.image_url ? [part.image_url.url] : []));
      const inputs = envelope.messages.filter(message => message.role === 'user').flatMap(message =>
        typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => part.text ? [part.text] : []));
      const input = JSON.parse(inputs.at(-1) || '{}') as { question: string; history?: unknown };
      const answer = answers.get(input.question);
      if (envelope.model !== name || !answer) { response.writeHead(422).end(); return; }
      calls.push({ ...input, images });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] }));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { key, name, url: 'http://127.0.0.1:' + address.port + '/v1', calls,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

function options(mobile: boolean) {
  return { locale: 'zh-CN', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 };
}

async function activate(control: Locator, mobile: boolean) {
  if (mobile) await control.tap();
  else await control.click();
}

async function readerUrl(browser: Browser, host: HostFixture) {
  // The installed host's onboarding fixture uses English. Read the actual
  // standalone link there, then use Chinese browser sessions for the journey.
  const context = await browser.newContext({ ...options(false), locale: 'en-US' });
  const shell = await context.newPage();
  const pane = await openReader(shell, host.authenticatedUrl);
  await pane.getByRole('button', { name: 'More actions' }).click();
  const [page] = await Promise.all([context.waitForEvent('page'), pane.getByRole('button', { name: 'Open in new tab' }).click()]);
  await page.getByText('PagedAttention.pdf', { exact: true }).waitFor();
  const url = page.url();
  await context.close();
  return url;
}

async function openDesk(browser: Browser, host: HostFixture, url: string, mobile: boolean) {
  const context = await browser.newContext(options(mobile));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByText('PagedAttention.pdf', { exact: true }).waitFor();
  return { context, page };
}

async function connect(page: Page, model: Awaited<ReturnType<typeof localModel>>, mobile: boolean) {
  await activate(page.getByRole('button', { name: '更多操作' }), mobile);
  await activate(page.getByRole('button', { name: '连接设置', exact: true }), mobile);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('API 接口地址').fill(model.url);
  await dialog.getByLabel('模型', { exact: true }).fill(model.name);
  await dialog.getByLabel('API 密钥', { exact: true }).fill(model.key);
  await activate(dialog.getByRole('button', { name: '保存连接设置' }), mobile);
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('连接设置已保存。', { exact: true }).waitFor({ state: 'hidden' });
}

async function gesture(page: Page, start: Point, end: Point, touch = false, pace = 0) {
  if (!touch) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 14 });
    await page.mouse.up();
    return;
  }
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let step = 1; step <= 14; step++) {
      if (pace) await new Promise<void>(resolve => setTimeout(resolve, pace));
      const x = start.x + (end.x - start.x) * step / 14, y = start.y + (end.y - start.y) * step / 14;
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await input.detach(); }
}

function figure(page: Page, number: 6 | 7) {
  return page.locator('#original .pdf-figure[data-block-id="figure-' + number + '"]');
}

async function drawFigure(page: Page, number: 6 | 7, mobile: boolean): Promise<Capture> {
  await page.locator('.pdf-capture-surface').waitFor();
  const region = figure(page, number);
  await region.scrollIntoViewIfNeeded();
  const rect = await region.boundingBox();
  assert.ok(rect, 'The visible Figure ' + number + ' should be available to capture.');
  const start = { x: Math.round(rect.x + rect.width * .01), y: Math.round(rect.y + rect.height * .025) };
  const end = { x: Math.round(rect.x + rect.width * .99), y: Math.round(rect.y + rect.height * .975) };
  const width = end.x - start.x, height = end.y - start.y;
  // The canvas is the PDF raster visible beneath the screenshot tool.
  const pixels = await page.locator('#original canvas.pdf-raster').evaluate((node, area) => {
    const source = node as HTMLCanvasElement, bounds = source.getBoundingClientRect();
    const sample = document.createElement('canvas');
    sample.width = 48;
    sample.height = 32;
    const context = sample.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    const sx = source.width / bounds.width, sy = source.height / bounds.height;
    context.drawImage(source, (area.start.x - bounds.left) * sx, (area.start.y - bounds.top) * sy,
      area.width * sx, area.height * sy, 0, 0, sample.width, sample.height);
    return Array.from(context.getImageData(0, 0, sample.width, sample.height).data);
  }, { start, width, height });
  await gesture(page, start, end, mobile);
  return { width, height, pixels };
}

async function crop(page: Page, number: 6 | 7, mobile: boolean) {
  await activate(page.getByRole('button', { name: '截图问 AI' }), mobile);
  const capture = await drawFigure(page, number, mobile);
  const choices = page.locator('.pdf-capture-actions');
  await choices.waitFor();
  return { choices, capture };
}

function discussion(page: Page) {
  return page.locator('.selection-chat:visible');
}

async function ask(page: Page, question: string, mobile: boolean) {
  const conversation = discussion(page);
  await conversation.getByRole('textbox').fill(question);
  await activate(conversation.getByRole('button', { name: '发送', exact: true }), mobile);
  const reply = conversation.locator('.selection-answer').getByText(answers.get(question)!, { exact: true });
  await reply.waitFor();
  return reply;
}

async function textPoints(locator: Locator, phrase: string) {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((element, value) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node;
    while ((node = walker.nextNode()) instanceof Text) nodes.push(node);
    const content = nodes.map(text => text.data).join('');
    const start = content.indexOf(value);
    if (start < 0) throw Error('Cannot locate the printed text: ' + value);
    const end = start + value.length;
    const range = document.createRange();
    let offset = 0;
    for (const text of nodes) {
      const last = offset + text.data.length;
      if (start >= offset && start < last) range.setStart(text, start - offset);
      if (end > offset && end <= last) {
        range.setEnd(text, end - offset);
        break;
      }
      offset = last;
    }
    const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
    const left = rects[0], right = rects.at(-1)!;
    return { start: { x: left.left + .2, y: left.top + left.height / 2 },
      end: { x: right.right - .2, y: right.top + right.height / 2 } };
  }, phrase);
}

async function mouseSelect(page: Page, locator: Locator, phrase: string) {
  const bounds = await textPoints(locator, phrase);
  await gesture(page, bounds.start, bounds.end);
}

function summarize(call: ModelCall) {
  return { question: call.question, history: call.history, images: call.images.map(url => {
    const png = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
    return { header: png.subarray(0, 8).toString('hex'), size: [png.readUInt32BE(16), png.readUInt32BE(20)],
      digest: createHash('sha256').update(png).digest('hex') };
  }) };
}

async function checkPixels(url: string | undefined, expected: Capture) {
  assert.ok(url?.startsWith('data:image/png;base64,'), 'The model must receive a real PNG attachment.');
  const png = Buffer.from(url!.replace(/^data:image\/png;base64,/, ''), 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(Math.abs(width / height / (expected.width / expected.height) - 1) < .05);
  const values = await sharp(png).resize(48, 32, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const difference = values.reduce((total, value, index) =>
    total + (index % 4 === 3 ? 0 : Math.abs(value - expected.pixels[index])), 0) / (48 * 32 * 3);
  assert.ok(difference < 21, 'The PNG should contain the drawn PDF region. Mean pixel error: ' + difference.toFixed(2));
}

const originalSentence = 'Each block table entry records the corresponding physical blocks of a logical block and the number of filled positions.';

async function readTranslation(page: Page, mobile: boolean) {
  if (mobile) {
    await activate(page.getByRole('button', { name: '读正文', exact: true }), mobile);
    const paragraph = page.getByRole('region', { name: '本页正文' }).getByText(originalSentence, { exact: false }).first();
    await mouseSelect(page, paragraph, originalSentence);
  } else {
    const textLayer = page.locator('#original .pdf-native-text');
    const left = textLayer.getByText('physical KV blocks of each request. Each block table entry', { exact: true });
    const right = textLayer.getByText('and the number of filled positions. Separating logical and', { exact: true });
    await left.scrollIntoViewIfNeeded();
    await right.scrollIntoViewIfNeeded();
    const from = await textPoints(left, 'Each block table entry');
    const to = await textPoints(right, 'and the number of filled positions.');
    await gesture(page, from.start, to.end);
  }
  const selection = page.locator('#card');
  await selection.getByRole('heading', { name: '选段译文' }).waitFor();
  await selection.getByText('每个表项记录该逻辑块对应的物理块，以及已填入多少个位置。', { exact: true }).waitFor();
  return selection;
}

async function saveReaderNote(page: Page, reply: Locator, mobile: boolean) {
  await mouseSelect(page, reply, excerpt);
  const turn = reply.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," chat-turn ")][1]');
  await activate(turn.getByRole('button', { name: '记下选句', exact: true }), mobile);
  await turn.getByText('已记入', { exact: true }).waitFor();
  const notebook = page.getByLabel('阅读笔记', { exact: true });
  const editor = notebook.getByRole('textbox', { name: '笔记 Markdown' });
  await activate(turn.getByRole('button', { name: '查看', exact: true }), mobile);
  await editor.press('Control+End');
  await page.keyboard.insertText('\n\n' + ownNote);
  await activate(notebook.getByRole('button', { name: '保存', exact: true }), mobile);
  await notebook.getByText('已保存到本机', { exact: true }).waitFor();
  return notebook;
}

async function readEarlierReply(page: Page, conversation: Locator, mobile: boolean) {
  const first = conversation.getByText(firstAnswer, { exact: true });
  const log = conversation.getByRole('log');
  const area = await log.boundingBox(), answer = await first.boundingBox();
  assert.ok(area && answer);
  if (answer.y >= area.y && answer.y + answer.height <= area.y + area.height) return;
  const center = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  if (mobile) {
    const startsInLog = await log.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), center);
    assert.ok(startsInLog, 'The reader should be able to start a swipe inside the discussion.');
    const offset = () => log.evaluate(node => node.scrollTop);
    const before = await offset();
    await gesture(page, center, { x: center.x, y: Math.min(page.viewportSize()!.height - 15, center.y + area.height * .75) }, true, 20);
    const after = await offset();
    console.log('390 px discussion touch scroll: ' + before + ' → ' + after);
    assert.ok(after < before, 'Swiping from the discussion should move toward the earlier reply.');
  } else {
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, -area.height);
  }
  await page.waitForFunction(expected => {
    const log = document.querySelector('.selection-chat:not([hidden]) [role="log"]');
    const answer = [...(log?.querySelectorAll('.selection-answer p') ?? [])].find(item => item.textContent?.trim() === expected);
    if (!log || !answer) return false;
    const viewport = log.getBoundingClientRect(), reply = answer.getBoundingClientRect();
    return reply.top >= viewport.top - 1 && reply.bottom <= viewport.bottom + 1;
  }, firstAnswer);
}

for (const mobile of mode) await withHost(async host => {
  const model = await localModel();
  const browser = await chromium.launch({ executablePath: host.executable });
  const evidence = process.env.PAPER_READER_QUESTION_ARTIFACTS ?? path.join(host.artifacts, 'reviews', 'reading-a-question');
  await mkdir(evidence, { recursive: true });
  const photo = (page: Page, name: string) => page.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled', scale: 'css' });
  try {
    const url = await readerUrl(browser, host);
    const device = mobile ? 'phone' : 'desktop';
    const { context, page } = await openDesk(browser, host, url, mobile);
    await connect(page, model, mobile);
    const pageJump = page.getByRole('button', { name: /跳转到页码/ });
    if (!(await pageJump.innerText()).includes('6 /')) {
      await activate(pageJump, mobile);
      await page.getByRole('spinbutton', { name: '页码' }).fill('6');
      await activate(page.getByRole('button', { name: '跳转', exact: true }), mobile);
    }
    await figure(page, 6).waitFor();
    await page.getByText('正在打开文档…', { exact: true }).waitFor({ state: 'hidden' });
    console.log(device + ' loaded page ' + await pageJump.innerText());
    const selection = await readTranslation(page, mobile);
    await photo(page, (baseline ? 'old-' : '') + device + '-translation');
    await activate(selection.getByRole('button', { name: /关闭选区|Close selection/ }), mobile);
    await selection.waitFor({ state: 'hidden' });
    assert.equal(model.calls.length, 0, 'Glancing at the bundled translation should leave the model and notebook untouched.');

    const before = await crop(page, 6, mobile);
    console.log(device + ' first screenshot options ' + await before.choices.innerText());
    await activate(before.choices.getByRole('button', { name: '提问', exact: true }), mobile);
    await ask(page, firstQuestion, mobile);
    assert.equal(model.calls.length, 1);
    await checkPixels(model.calls[0]?.images[0], before.capture);
    let second: Capture;
    if (baseline) {
      const after = await crop(page, 7, mobile);
      second = after.capture;
      console.log(device + ' Figure 7 options: ' + JSON.stringify(await after.choices.allTextContents()));
      await photo(page, 'old-' + device + '-second-crop');
      await activate(after.choices.getByRole('button', { name: '提问', exact: true }), mobile);
      await discussion(page).getByRole('textbox').waitFor();
      assert.equal(await discussion(page).getByText(firstAnswer, { exact: true }).count(), 0);
      await photo(page, 'old-' + device + '-second-composer');
    } else {
      const addScreenshot = discussion(page).getByRole('button', { name: '再截一张', exact: true });
      const draft = discussion(page).getByRole('textbox');
      await draft.fill('对照相邻的图之后再问。');
      await activate(addScreenshot, mobile);
      await page.getByRole('button', { name: '取消截图', exact: true }).waitFor();
      if (mobile) await page.getByRole('button', { name: '取消截图', exact: true }).tap();
      else await page.keyboard.press('Escape');
      assert.equal(await draft.inputValue(), '对照相邻的图之后再问。');
      assert.equal(model.calls.length, 1, 'Canceling the additional screenshot must not send another message.');
      await draft.fill(followupQuestion);
      await activate(addScreenshot, mobile);
      second = await drawFigure(page, 7, mobile);
      await discussion(page).getByText(firstAnswer, { exact: true }).waitFor();
      assert.equal(await draft.inputValue(), followupQuestion);
      await discussion(page).getByRole('button', { name: '图 6', exact: true }).first().waitFor();
      await discussion(page).getByRole('button', { name: '图 7', exact: true }).first().waitFor();
      if (mobile) await photo(page, device + '-added-figure');
    }
    const reply = await ask(page, followupQuestion, mobile).catch(async error => {
      await photo(page, device + '-send-failure');
      console.log(JSON.stringify({ device, modelCalls: model.calls.length }));
      throw error;
    });
    assert.equal(model.calls.length, 2);
    const comparison = model.calls[1];
    const history = JSON.stringify(comparison.history ?? []);
    if (baseline) {
      assert.deepEqual(comparison.history, []);
      assert.equal(comparison.images.length, 1);
      await checkPixels(comparison.images[0], second);
    } else {
      assert.equal(comparison.images.length, 2);
      await checkPixels(comparison.images[0], before.capture);
      await checkPixels(comparison.images[1], second);
      assert.notEqual(comparison.images[0], comparison.images[1]);
      assert.ok(history.indexOf(firstQuestion) >= 0 && history.indexOf(firstAnswer) > history.indexOf(firstQuestion));
      await photo(page, device + '-two-replies');
    }
    console.log(JSON.stringify({ calls: model.calls.map(summarize) }));
    const notebook = await saveReaderNote(page, reply, mobile);
    if (!baseline) {
      await activate(notebook.getByRole('button', { name: '关闭笔记' }), mobile);
      const other = await crop(page, 6, mobile);
      await other.choices.getByRole('button', { name: '接着问', exact: true }).waitFor();
      await other.choices.getByRole('button', { name: '单独提问', exact: true }).waitFor();
      await activate(other.choices.getByRole('button', { name: '接着问', exact: true }), mobile);
      await page.locator('.pdf-capture-surface').waitFor({ state: 'hidden' });
      await discussion(page).getByText(firstAnswer, { exact: true }).waitFor();
      await discussion(page).getByText(followupAnswer, { exact: true }).waitFor();
      assert.equal(model.calls.length, 2);

      if (await page.getByRole('button', { name: '读正文', exact: true }).isVisible())
        await activate(page.getByRole('button', { name: '读正文', exact: true }), mobile);
      const text = page.getByRole('region', { name: '本页正文' }).getByRole('button', { name: /选中此段.*Parallel sampling/ });
      await activate(text, mobile);
      const card = page.locator('#card');
      await card.getByRole('button', { name: '接着问', exact: true }).waitFor();
      await activate(card.getByRole('button', { name: '单独提问', exact: true }), mobile);
      await ask(page, separateQuestion, mobile);
      assert.equal(model.calls.length, 3);
      assert.deepEqual(model.calls[2].history, []);
      assert.deepEqual(model.calls[2].images, []);
    }
    await context.close();

    const reopened = await openDesk(browser, host, url, mobile);
    const nextPage = reopened.page;
    await activate(nextPage.getByRole('button', { name: '打开笔记', exact: true }), mobile);
    const freshNotebook = nextPage.getByLabel('阅读笔记', { exact: true });
    const freshEditor = freshNotebook.getByRole('textbox', { name: '笔记 Markdown' });
    await freshEditor.getByText(ownNote, { exact: true }).waitFor();
    const content = await freshEditor.innerText();
    assert.equal(content.split(excerpt).length, 2);
    assert.ok(!content.includes('每个请求的块表独立记录映射。'), 'Only the selected sentence should be in the notebook.');
    const links = freshNotebook.getByRole('link');
    console.log(device + ' fresh notebook links ' + JSON.stringify(await links.allTextContents()));
    await photo(nextPage, (baseline ? 'old-' : '') + device + '-notebook');
    const source = freshNotebook.getByRole('link', { name: baseline ? /截图选区/ : /图 7/ });
    await activate(source.last(), mobile);
    await nextPage.waitForURL(address => /region-/.test(address.searchParams.get('anchor') ?? ''));
    const marker = nextPage.locator('#original .pdf-region-marker');
    await marker.waitFor();
    const markerBox = await marker.boundingBox();
    const figureBox = await figure(nextPage, 7).boundingBox();
    assert.ok(markerBox && figureBox &&
      Math.abs((markerBox.x + markerBox.width / 2) - (figureBox.x + figureBox.width / 2)) < 10 &&
      Math.abs((markerBox.y + markerBox.height / 2) - (figureBox.y + figureBox.height / 2)) < 10,
      'The notebook citation should outline Figure 7.');
    await photo(nextPage, (baseline ? 'old-' : '') + device + '-reopened-source');
    if (!baseline) {
      await nextPage.waitForFunction(() => {
        const scroll = document.querySelector('#paperScroll');
        const mark = document.querySelector('#original .pdf-region-marker');
        if (!scroll || !mark) return false;
        const viewport = scroll.getBoundingClientRect(), region = mark.getBoundingClientRect();
        const center = document.elementFromPoint(region.x + region.width / 2, region.y + region.height / 2);
        return region.top >= viewport.top - 1 && region.bottom <= viewport.bottom + 1 &&
          Boolean(center?.closest('#original'));
      }, undefined, { timeout: 3500 });
    }
    if (baseline) {
      assert.equal(await freshNotebook.getByRole('link', { name: '查看讨论', exact: true }).count(), 0);
      await activate(marker, mobile);
      await discussion(nextPage).getByText(followupAnswer, { exact: true }).waitFor();
      assert.equal(await discussion(nextPage).getByText(firstAnswer, { exact: true }).count(), 0);
    } else {
      await activate(nextPage.getByRole('button', { name: '继续问这张截图', exact: true }), mobile);
      const fromFigure = discussion(nextPage);
      await fromFigure.getByRole('textbox').waitFor();
      for (const line of [firstQuestion, firstAnswer, followupQuestion, followupAnswer])
        await fromFigure.getByText(line, { exact: true }).waitFor();
      assert.equal(model.calls.length, 3, 'Opening the discussion from its figure must not re-ask the model.');
      await activate(fromFigure.getByRole('button', { name: '收起讨论', exact: true }), mobile);

      const close = freshNotebook.getByRole('button', { name: '关闭笔记' });
      if (!(await freshNotebook.isVisible()))
        await activate(nextPage.getByRole('button', { name: '打开笔记', exact: true }), mobile);
      await activate(freshNotebook.getByRole('link', { name: '查看讨论', exact: true }), mobile);
      const conversation = discussion(nextPage);
      for (const line of [firstQuestion, firstAnswer, followupQuestion, followupAnswer])
        await conversation.getByText(line, { exact: true }).waitFor();
      await conversation.getByRole('button', { name: '图 7', exact: true }).first().waitFor();
      assert.equal(await conversation.getByText(separateAnswer, { exact: true }).count(), 0);
      assert.equal(model.calls.length, 3, 'Opening a saved discussion must not re-ask the model.');
      if (await close.isVisible()) await activate(close, mobile);
      await photo(nextPage, device + '-reopened-discussion');
      await readEarlierReply(nextPage, conversation, mobile);
      if (mobile) await photo(nextPage, device + '-earlier-reply');
      await activate(conversation.getByRole('button', { name: '收起讨论', exact: true }), mobile);
      await activate(nextPage.getByRole('button', { name: '下一页' }), mobile);
      await nextPage.waitForURL(address => address.searchParams.get('page') === '7');
      assert.match(await nextPage.getByRole('button', { name: /跳转到页码/ }).innerText(), /7 \/ 16/);
    }
    await reopened.context.close();
    console.log('PASS ' + device + ' ' + (baseline ? 'baseline' : 'reader journey'));
  } finally { await browser.close(); await model.close(); }
});
