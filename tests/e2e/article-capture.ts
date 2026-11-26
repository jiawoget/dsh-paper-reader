import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import sharp from 'sharp';
import type { Operations } from '../../src/shared/types.js';
import { bookRoot, bookTitle, fixtureBlog, fixturePassages, googleUrl, sections, startPublisherFixture } from './book-reading-fixture.js';
import { withHost, type HostFixture } from './host.js';
import { startJsonFixture } from './integration-fixtures.js';
import { dragBox } from './selection-gestures.js';

const appRoute = '/api/paper-reader/app/index.html';
const bookAddress = bookRoot + sections.first.slug;
const translatedPassage = '计算融资总额。比较每笔交易发生的时间和金额，再判断现金流是否足以支付下一期账款。';
const followup = '图中的两种资金来源是什么？';
const afterReload = '重开讨论后，这张图的右侧是什么颜色？';
const compareCrops = '图中的融资方式与这段中英对照文字有什么关系？';
const replies = [
  '蓝色和绿色分别代表银行融资和股权融资。',
  '这张图比较的是银行融资和股权融资。',
  '右侧方块是绿色的。',
  '第一张图区分资金来源，第二张截图中的中英文段落比较每笔交易的时间和金额。',
  '这段译文要求比较每笔交易的时间和金额。',
  '这张流程图用两个色块表示评估步骤。'
];
type Bounds = readonly [left: number, top: number, right: number, bottom: number];
type ModelInput = { regionText: string; question?: string; history?: { role: string; content: string }[] };
type ModelPart = { type: string; text?: string; image_url?: { url: string } };
const captureButton = (page: Page) => page.getByRole('button', { name: /^(截图问 AI|Ask with a screenshot)$/ });
const cropActions = (page: Page) => page.getByRole('group', { name: /^(截图操作|Screenshot actions)$/ });
const chat = (page: Page) => page.locator('#card .selection-chat');
const preview = (page: Page) => chat(page).getByRole('img').first();

async function startVisionModel() {
  const model = 'article-vision-fixture', apiKey = randomUUID();
  const calls: { image: string; previousImages: string[]; input: ModelInput }[] = [];
  const server = await startJsonFixture((req, url, body) => {
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return { status: 404 };
    if (req.headers.authorization !== 'Bearer ' + apiKey) return { status: 403 };
    const envelope = body as { model: string; messages: { role: string; content: string | ModelPart[] }[] };
    const content = envelope.messages.findLast(message => message.role === 'user')?.content;
    if (envelope.model !== model || !content) return { status: 422 };
    let answer: string;
    if (typeof content === 'string') {
      const { blocks } = JSON.parse(content) as { blocks?: { id: string; text: string }[] };
      if (!blocks?.length) return { status: 422 };
      const translations = Object.fromEntries(blocks.map(({ id, text }) => [id,
        text.startsWith(fixturePassages.first) ? translatedPassage : '本段介绍交易金额和日期，并给出一个计算示例。']));
      answer = JSON.stringify({ translations });
    } else {
      const images = content.flatMap(part => part.type === 'image_url' && part.image_url ? [part.image_url.url] : []);
      const image = images.pop();
      const text = content.find(part => part.type === 'text')?.text;
      if (!image?.startsWith('data:image/png;base64,') || !text || calls.length >= replies.length) return { status: 422 };
      answer = replies[calls.length];
      calls.push({ image, previousImages: images, input: JSON.parse(text) as ModelInput });
    }
    return { status: 200, value: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] } };
  });
  return { ...server, calls, settings: { baseUrl: server.origin + '/v1', model, apiKey } };
}

async function action<K extends keyof Operations>(page: Page, op: K, payload: Operations[K][0]): Promise<Operations[K][1]> {
  const response = await page.request.post(new URL('/api/paper-reader/action', page.url()).href, { data: { op, payload } });
  assert.ok(response.ok(), op + ' returned HTTP ' + response.status());
  return response.json();
}

async function openPage(browser: Browser, host: HostFixture, phone = false) {
  const page = await browser.newPage(phone
    ? { locale: 'en-US', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { locale: 'zh-CN', viewport: { width: 1440, height: 940 } });
  page.setDefaultTimeout(12_000);
  await page.route(/^https?:\/\//, route => new URL(route.request().url()).origin === host.origin ? route.continue() : route.abort());
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
  return page;
}

async function openAddress(page: Page, host: HostFixture, url: string, title: string) {
  await page.goto(host.origin + appRoute, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^(打开资料库|Open library)$/ }).click();
  const library = page.getByRole('dialog');
  await library.getByRole('button', { name: /^(打开网页|Open web page)$/ }).click();
  await library.getByRole('textbox', { name: /^(网页地址|Web address)$/ }).fill(url);
  await library.getByRole('button', { name: url === bookAddress ? /^(打开书籍|Open book)$/ : /^(阅读文章|Read article)$/ }).click();
  await library.waitFor({ state: 'hidden' });
  await page.locator('#original').getByRole('heading', { name: title, exact: true }).first().waitFor();
  if (await page.locator('#closeRail').isVisible()) await page.locator('#closeRail').click();
}

async function drawCrop(page: Page, target: Locator, area: Bounds, touch = false) {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate(async node => { if (node instanceof HTMLImageElement) await node.decode(); });
  if (touch) await captureButton(page).tap();
  else await captureButton(page).click();
  await page.getByRole('button', { name: /^(取消截图|Cancel screenshot)$/ }).waitFor();
  if (touch) assert.equal(await page.locator('#original .web-reading-sheet').isVisible(), false, 'Touch capture must keep translation visible.');
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box, 'The same reading material must remain visible when capture starts.');
  const x = Math.round(box.x + area[0] * box.width), y = Math.round(box.y + area[1] * box.height);
  const right = Math.round(box.x + area[2] * box.width), bottom = Math.round(box.y + area[3] * box.height);
  const crop = await dragRectangle(page, x, y, right, bottom, touch);
  await cropActions(page).waitFor();
  return crop;
}

async function dragRectangle(page: Page, x: number, y: number, right: number, bottom: number, touch = false) {
  const clip = { x, y, width: right - x, height: bottom - y };
  const viewport = page.viewportSize()!;
  assert.ok(x >= 0 && y >= 0 && right <= viewport.width && bottom <= viewport.height, 'Drag endpoints must be on screen.');
  // Chromium captures the exact on-screen rectangle before the selection marker covers it.
  const reference = await page.screenshot({ clip, animations: 'disabled', scale: 'css' });
  await dragBox(page, { x, y }, { x: right, y: bottom }, touch);
  return { reference, width: clip.width, height: clip.height };
}

async function matchesPixels(url: string, crop: Awaited<ReturnType<typeof drawCrop>>) {
  const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.ok(Math.abs(metadata.width / metadata.height / (crop.width / crop.height) - 1) < .045, 'The PNG must match the dragged proportions.');
  const width = 80, height = Math.max(8, Math.round(width * crop.height / crop.width));
  const sample = (image: Buffer) => sharp(image).flatten({ background: '#fff' }).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [actual, expected] = await Promise.all([sample(png), sample(crop.reference)]);
  let error = 0, ink = 0;
  for (let i = 0; i < expected.length; i++) {
    error += Math.abs(actual[i] - expected[i]);
    ink += 255 - expected[i];
  }
  assert.ok(ink / expected.length > 8, 'The reference rectangle must contain visible illustration or text pixels.');
  assert.ok(error / ink < .45, 'Model attachment pixels must match the dragged viewport rectangle (relative error ' + (error / ink).toFixed(2) + ').');
}

const visibleAnswer = (page: Page, index: number) => chat(page).locator('.selection-answer').getByText(replies[index], { exact: true }).waitFor();
async function explain(page: Page, index: number, touch = false) {
  const button = cropActions(page).getByRole('button', { name: /^(解释|Explain)$/ });
  if (touch) await button.tap(); else await button.click();
  await visibleAnswer(page, index);
}
async function follow(page: Page, question: string, index: number) {
  const input = chat(page).getByRole('textbox');
  await input.fill(question);
  await input.press('Enter');
  await visibleAnswer(page, index);
}
async function screenshot(page: Page, host: HostFixture, name: string) {
  if (!process.argv.includes('--evidence')) return;
  const directory = path.join(host.artifacts, 'reviews', 'article-capture');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name + '.png'), animations: 'disabled' });
}

async function run(host: HostFixture) {
  const browser = await chromium.launch({ executablePath: host.executable });
  const model = await startVisionModel();
  try {
    const page = await openPage(browser, host);
    await action(page, 'settings.save', model.settings);
    await openAddress(page, host, bookAddress, sections.first.title);
    assert.equal(await page.locator('#docTitle').innerText(), bookTitle);
    await page.locator('#parallel').click();
    await page.locator('#translated .web-reading-sheet').waitFor();
    assert.ok(await captureButton(page).isVisible(), 'OpenStax 1.1 in bilingual view must offer 截图问 AI in the reader toolbar.');
    await page.getByRole('button', { name: '翻译本节', exact: true }).click();
    await page.locator('#translated').getByText(translatedPassage, { exact: true }).waitFor();
    const entry = new URL(page.url());
    const docId = entry.searchParams.get('doc')!, section = Number(entry.searchParams.get('page'));
    const diagram = page.locator('#original').getByRole('img', { name: 'Bank financing and equity financing' });
    const area: Bounds = [.24, .15, .72, .67];
    await drawCrop(page, diagram, area);
    await page.keyboard.press('Escape');
    await cropActions(page).waitFor({ state: 'hidden' });
    assert.equal(await chat(page).isVisible(), false);
    assert.equal(model.calls.length, 0, 'Canceling a book screenshot must not send a model request.');

    await drawCrop(page, diagram, area);
    assert.equal(await page.locator('.pdf-capture-cutout').isVisible(), true);
    await cropActions(page).getByRole('button', { name: '取消', exact: true }).click();
    await cropActions(page).waitFor({ state: 'hidden' });
    assert.equal(model.calls.length, 0);
    await drawCrop(page, diagram, area);
    await cropActions(page).getByRole('button', { name: '钉选', exact: true }).click();
    const bookPin = page.locator('.figure-pin-card').first();
    await bookPin.waitFor();
    assert.ok(await bookPin.locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth > 0));
    await bookPin.locator('.figure-pin-close').click();
    await bookPin.waitFor({ state: 'hidden' });

    const crop = await drawCrop(page, diagram, area);
    await screenshot(page, host, '01-book-bilingual-selection');
    await explain(page, 0);
    assert.equal(model.calls.length, 1);
    const first = model.calls[0];
    await matchesPixels(first.image, crop);
    assert.ok(await preview(page).getAttribute('src') === first.image, 'The chat preview must show the PNG received by the vision model.');
    await screenshot(page, host, '02-book-explanation');
    await follow(page, followup, 1);
    assert.equal(model.calls.length, 2);
    assert.ok(model.calls[1].image === first.image, 'A follow-up must resend the same PNG bytes.');
    assert.equal(model.calls[1].input.question, followup);
    assert.ok(model.calls[1].input.history?.some(turn => turn.content === replies[0]));
    const history = () => action(page, 'chat.history', { docId });
    const exchanges = (await history()).exchanges;
    const saved = exchanges.find(turn => turn.answer === replies[0]);
    assert.ok(saved?.source);
    assert.equal(saved.source.docId, docId);
    assert.equal(saved.source.page, section);
    assert.equal(saved.source.side, 'source');
    assert.match(saved.source.anchor, /^article-/);
    assert.equal(new URL(saved.source.sourceUrl).searchParams.get('anchor'), saved.source.anchor);
    assert.equal(exchanges.find(turn => turn.question === followup)?.thread, saved.thread);

    await page.reload();
    await page.locator('#original').getByRole('heading', { name: sections.first.title, exact: true }).first().waitFor();
    await page.getByRole('button', { name: '下一节', exact: true }).click();
    await page.locator('#original').getByRole('heading', { name: sections.second.title, exact: true }).first().waitFor();
    await page.getByRole('button', { name: '本节问答', exact: true }).click();
    await page.locator('.paper-chat-reply').filter({ hasText: replies[0] }).getByRole('button', { name: '继续问这张截图' }).click();
    await visibleAnswer(page, 0);
    await visibleAnswer(page, 1);
    assert.equal(new URL(page.url()).searchParams.get('page'), String(section));
    assert.ok(await preview(page).getAttribute('src') === first.image, 'Reopening the discussion must restore the original PNG.');
    assert.equal(model.calls.length, 2, 'Opening the saved discussion must not send a new explanation.');
    await follow(page, afterReload, 2);
    assert.equal(model.calls.length, 3);
    assert.ok(model.calls[2].image === first.image, 'The model must receive the same PNG after reloading and switching sections.');
    assert.deepEqual(model.calls[2].input.history?.map(turn => turn.content), [saved.question, replies[0], followup, replies[1]]);
    assert.equal((await history()).exchanges.find(turn => turn.question === afterReload)?.thread, saved.thread);
    console.log('PASS OpenStax 1.1 bilingual diagram: cancel, Explain, exact selected pixels, follow-up, reload and resume from another section.');

    await chat(page).getByRole('button', { name: '再截一张', exact: true }).click();
    await page.getByRole('button', { name: '取消截图', exact: true }).waitFor();
    const sourceParagraph = page.locator('#original p').filter({ hasText: fixturePassages.first });
    const translation = page.locator('#translated').getByText(translatedPassage, { exact: true });
    await sourceParagraph.scrollIntoViewIfNeeded();
    await translation.scrollIntoViewIfNeeded();
    const sourceBox = await sourceParagraph.boundingBox(), translatedBox = await translation.boundingBox();
    assert.ok(sourceBox && translatedBox && translatedBox.x > sourceBox.x + sourceBox.width);
    const both = await dragRectangle(page, Math.floor(sourceBox.x), Math.floor(Math.min(sourceBox.y, translatedBox.y)),
      Math.round(translatedBox.x + translatedBox.width * .92), Math.ceil(translatedBox.y + translatedBox.height));
    await chat(page).getByRole('button', { name: '移除刚加入的材料', exact: true }).waitFor();
    assert.equal(model.calls.length, 3, 'Adding material should wait for a question.');
    await follow(page, compareCrops, 3);
    assert.equal(model.calls.length, 4);
    const combined = model.calls[3];
    assert.ok(combined.previousImages.length === 1 && combined.previousImages[0] === first.image,
      'The previous diagram must reach the model with its original PNG bytes alongside the new crop.');
    assert.ok(combined.image !== first.image);
    assert.ok(combined.input.regionText.includes(fixturePassages.first) && combined.input.regionText.includes('计算融资总额'),
      'Dragging across both panes must include the selected English and Chinese text.');
    await matchesPixels(combined.image, both);
    assert.equal((await history()).exchanges.find(turn => turn.question === compareCrops)?.thread, saved.thread);
    console.log('PASS cross-column drag: one PNG contains both languages, and the model receives the earlier diagram alongside it.');

    const phone = await openPage(browser, host, true);
    await phone.goto(entry.href);
    await phone.locator('#parallel').tap();
    const translated = phone.locator('#translated').getByText(translatedPassage, { exact: true });
    const textCrop = await drawCrop(phone, translated, [0, .04, .97, .90], true);
    await explain(phone, 4, true);
    assert.equal(model.calls.length, 5);
    await matchesPixels(model.calls[4].image, textCrop);
    assert.match(model.calls[4].input.regionText, /[\u3400-\u9fff]/u, 'A translated crop must supply text from the Chinese pane.');
    const phoneTurn = (await action(phone, 'chat.history', { docId })).exchanges.find(turn => turn.answer === replies[4]);
    assert.equal(phoneTurn?.source?.side, 'translation');
    assert.notEqual(phoneTurn?.source?.anchor, saved.source.anchor);
    await screenshot(phone, host, '03-mobile-translation-explanation');
    await chat(phone).getByRole('button', { name: 'Close chat', exact: true }).tap();
    await translated.waitFor();
    assert.equal(await phone.locator('#original .web-reading-sheet').isVisible(), false);
    console.log('PASS 390px translation-only reader: touch drag, Chinese text pixels, Explain and return to the translation.');

    const article = await openPage(browser, host);
    await openAddress(article, host, googleUrl, fixtureBlog.title);
    const image = article.locator('#original').getByRole('img', { name: 'Two paths through the evaluation' });
    const articleCrop = await drawCrop(article, image, [.32, .04, .94, .71]);
    await explain(article, 5);
    assert.equal(model.calls.length, 6);
    await matchesPixels(model.calls[5].image, articleCrop);
    assert.ok(model.calls[5].image !== first.image, 'A different crop must send different PNG bytes.');
    console.log('PASS ordinary HTML article: a different figure crop opens a model-backed explanation.');
  } finally { await browser.close(); await model.close(); }
}

const fixture = await startPublisherFixture({ includeFinanceDiagram: true });
const scratch = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-article-capture-'));
try {
  await withHost(run, {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + new URL('./book-reading-preload.ts', import.meta.url).href].filter(Boolean).join(' '),
    PAPER_READER_E2E_PUBLISHER_FIXTURE: fixture.origin,
    PAPER_READER_E2E_PUBLISHER_LOG: path.join(scratch, 'publisher.ndjson')
  });
} finally {
  await fixture.close();
  await rm(scratch, { recursive: true, force: true });
}
