import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type FrameLocator, type Locator, type Page } from 'playwright-core';
import { localTranslationAvailable } from '../../src/server/local-translation.js';
import { openReader, withHost } from './host.js';

type Reader = Page | FrameLocator;
const pageTopics: string[][][] = JSON.parse(await readFile(
  new URL('../fixtures/pagedattention-topics.zh-CN.json', import.meta.url), 'utf8'));

function sheet(reader: Reader, side: 'source' | 'translated', pageNumber: number): Locator {
  const label = side === 'source' ? 'Original' : 'Simplified Chinese';
  return reader.getByRole('group', { name: label + ', page ' + pageNumber, exact: true });
}

async function ready(reader: Reader, number: number): Promise<void> {
  await sheet(reader, 'source', number).waitFor();
  await reader.locator('#loading').waitFor({ state: 'hidden' });
}

async function turn(reader: Reader, current: number, wanted: number): Promise<void> {
  const direction = Math.sign(wanted - current);
  for (let number = current; number !== wanted; number += direction) {
    await reader.getByRole('button', { name: direction < 0 ? 'Previous page' : 'Next page' }).click();
    await ready(reader, number + direction);
  }
}

async function targetText(reader: Reader, number: number): Promise<string> {
  const target = sheet(reader, 'translated', number);
  return target.locator('[lang="zh-CN"][data-block-id]:visible').allInnerTexts().then(parts => parts.join('\n'));
}

function han(text: string): number {
  return Array.from(text.matchAll(/\p{Unified_Ideograph}/gu)).length;
}

async function verifyBundledPage(reader: Reader, number: number): Promise<number> {
  const target = sheet(reader, 'translated', number);
  const text = await targetText(reader, number);
  const characters = han(text);
  assert.ok(characters >= (number === 16 ? 35 : 110),
    'Page ' + number + ' must paint its Chinese translation when opened. Found ' + characters + ' Chinese characters.');
  for (const alternatives of pageTopics[number - 1]) {
    assert.ok(alternatives.some(term => text.includes(term)), 'Missing a page-specific topic on page ' + number + ': ' + alternatives.join(' / '));
  }
  const readIds = (nodes: Element[]) => Array.from(new Set(nodes.map(node => (node as HTMLElement).dataset.blockId).filter(Boolean))).sort();
  const sourceIds = await sheet(reader, 'source', number).locator('.pdf-native-text [data-block-id]').evaluateAll(readIds);
  const targetIds = await target.locator('[lang="zh-CN"][data-block-id]:visible').evaluateAll(readIds);
  assert.deepEqual(targetIds, sourceIds, 'Every annotated source passage on page ' + number + ' needs a matching, visible translated region.');
  const missing = await target.locator('[lang="zh-CN"][data-block-id]').evaluateAll(nodes =>
    nodes.filter(node => !(node instanceof HTMLElement) || !node.innerText.trim() || node.getClientRects().length === 0)
      .map(node => (node as HTMLElement).dataset.blockId));
  assert.deepEqual(missing, [], 'Every translated region on page ' + number + ' must be visible and populated.');
  const clipped = await target.locator('[lang="zh-CN"][data-block-id]:visible').evaluateAll(nodes =>
    nodes.filter(node => node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2)
      .map(node => (node as HTMLElement).dataset.blockId));
  assert.deepEqual(clipped, [], 'The bilingual edition must fit each complete passage on page ' + number + '.');
  if (number === 4) {
    for (const value of ['800', '1.6', '20.4']) assert.ok(text.includes(value), 'Page 4 must preserve ' + value + '.');
  }
  return characters;
}

async function verifyFigureAndTextPixels(page: Page, reader: Reader): Promise<void> {
  const original = await sheet(reader, 'source', 4).screenshot({ animations: 'disabled' });
  const translation = await sheet(reader, 'translated', 4).screenshot({ animations: 'disabled' });
  const pixels = await page.evaluate(async ([left, right]) => {
    const [source, target] = await Promise.all([left, right].map(async base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(500, 647);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    }));
    let sourceFigure = 0, sharedFigure = 0, marked = 0, different = 0;
    for (let y = 25; y < 587; y++) {
      for (let x = 20; x < 480; x++) {
        const offset = (y * 500 + x) * 4;
        if (y < 118) {
          const originalRgb = source.subarray(offset, offset + 3);
          const translatedRgb = target.subarray(offset, offset + 3);
          if (Math.max(...originalRgb) - Math.min(...originalRgb) > 28) {
            sourceFigure++;
            if (Math.max(...translatedRgb) - Math.min(...translatedRgb) > 28) sharedFigure++;
          }
        } else if (y > 184) {
          if (source[offset] < 185 || target[offset] < 185) {
            marked++;
            if (Math.abs(source[offset] - target[offset]) > 38) different++;
          }
        }
      }
    }
    return { sourceFigure, sharedFigure, marked, different };
  }, [original.toString('base64'), translation.toString('base64')]);
  assert.ok(pixels.sourceFigure > 130 && pixels.sharedFigure / pixels.sourceFigure > 0.65,
    'The translated page must retain the colored Figure 3 diagram in its original position.');
  assert.ok(pixels.marked > 4500 && pixels.different / pixels.marked > 0.33,
    'The two rendered page bodies must have different glyphs. A duplicate English raster cannot pass.');
}

async function translationFixture() {
  const model = 'paper-reader-zh-fixture';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const message = body.messages.find((entry: { role: string }) => entry.role === 'user');
    const { blocks }: { blocks: { id: string; text: string }[] } = JSON.parse(message.content);
    const translate = (text: string) => {
      const count = /\b(\d+)\b/.exec(text)?.[1];
      if (/library|table/i.test(text)) return `图书馆有 ${count ?? ''} 本书。蓝色盒子在桌子上。`;
      if (/cat|chair|water/i.test(text)) return '猫正在椅子上睡觉。水在零度结冰。';
      return '中文译文：' + text;
    };
    const translations = Object.fromEntries(blocks.map(block => [block.id, translate(block.text)]));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      role: 'assistant', content: JSON.stringify({ translations })
    } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { model, url: 'http://127.0.0.1:' + address.port + '/v1',
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function importedPdf(browserPage: Page, reader: Reader, scratch: string): Promise<void> {
  const useLocalModel = localTranslationAvailable();
  const provider = useLocalModel ? undefined : await translationFixture();
  try {
    if (provider) {
      await reader.getByRole('button', { name: 'More actions' }).click();
      await reader.getByRole('button', { name: 'Connections', exact: true }).click();
      const dialog = reader.getByRole('dialog');
      await dialog.getByLabel('API base URL').fill(provider.url);
      await dialog.getByLabel('Model', { exact: true }).fill(provider.model);
      await dialog.getByRole('button', { name: 'Save connections' }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    const number = randomInt(20, 90);
    const fixture = await browserPage.context().newPage();
    await fixture.setContent('<style>@page{size:letter;margin:1in}body{font:18pt Georgia}section+section{break-before:page}</style>'
      + '<section>The library has ' + number + ' books. The blue box is on the table.</section>'
      + '<section>The cat is sleeping on a chair. Water freezes at zero degrees.</section>');
    const file = path.join(scratch, 'New reading sample.pdf');
    await fixture.pdf({ path: file, preferCSSPageSize: true });
    await fixture.close();
    const requests: string[] = [];
    browserPage.on('request', req => {
      if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/paper-reader/action')
        && req.postDataJSON()?.op === 'translation.page') requests.push('translation.page');
    });
    await reader.getByRole('button', { name: 'Open library' }).click();
    const [chooser] = await Promise.all([browserPage.waitForEvent('filechooser'),
      reader.getByRole('button', { name: 'Open a PDF' }).click()]);
    await chooser.setFiles(file);
    await reader.getByRole('dialog').waitFor({ state: 'hidden' });
    await ready(reader, 1);
    const first = sheet(reader, 'translated', 1);
    await first.getByText(/\u4e66/u).first().waitFor({ timeout: 150_000 });
    const firstText = await targetText(reader, 1);
    assert.ok(firstText.includes(String(number)) && /\u684c/u.test(firstText), 'Fresh inference must preserve the input quantity and the table.');
    await turn(reader, 1, 2);
    await sheet(reader, 'translated', 2).getByText(/\u732b/u).first().waitFor({ timeout: 150_000 });
    const secondText = await targetText(reader, 2);
    assert.ok(/\u6c34/u.test(secondText) && /\u6905/u.test(secondText), 'The second page must translate water and chair.');
    assert.ok(requests.length >= 2, 'Newly imported pages must go through the translation service.');
    const before = requests.length;
    await turn(reader, 2, 1);
    assert.equal(await targetText(reader, 1), firstText);
    const sourceUrl = await reader.locator('body').evaluate(body => body.ownerDocument.location.href);
    const reopened = await browserPage.context().newPage();
    let repeated = 0;
    reopened.on('request', req => {
      if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/paper-reader/action')
        && req.postDataJSON()?.op === 'translation.page') repeated++;
    });
    await reopened.goto(sourceUrl);
    await ready(reopened, 1);
    assert.equal(await targetText(reopened, 1), firstText);
    assert.equal(requests.length, before);
    assert.equal(repeated, 0, 'Reopening a translated PDF must read its saved page without another inference request.');
    await reopened.close();
    console.log('PASS imported PDF: two new pages translated through ' + (useLocalModel ? 'real local inference' : 'local HTTP translation fixture') + ', including the random input quantity. Reopen used the cached result.');
  } finally {
    await provider?.close();
  }
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable, headless: process.env.PAPER_READER_HEADED !== '1' });
  try {
    const context = await browser.newContext({ viewport: { width: 1760, height: 1010 }, deviceScaleFactor: 1.25, locale: 'en-US' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const reader = await openReader(page, host.authenticatedUrl);
    await reader.getByRole('button', { name: 'Bilingual', exact: true }).click();
    await ready(reader, 6);
    await turn(reader, 6, 4);
    await verifyBundledPage(reader, 4);
    await verifyFigureAndTextPixels(page, reader);
    await turn(reader, 4, 1);
    const counts: number[] = [];
    for (let number = 1; number <= 16; number++) {
      if (number > 1) await turn(reader, number - 1, number);
      counts.push(await verifyBundledPage(reader, number));
    }
    await turn(reader, 16, 4);
    await verifyBundledPage(reader, 4);
    const reopened = await page.context().newPage();
    await reopened.goto(await reader.locator('body').evaluate(body => body.ownerDocument.location.href));
    await reopened.reload();
    await ready(reopened, 4);
    await verifyBundledPage(reopened, 4);
    await reopened.close();
    if (!process.argv.includes('--bundled-only')) {
      await importedPdf(page, reader, host.scratch);
      await reader.getByRole('button', { name: 'Open library' }).click();
      await reader.getByRole('tab', { name: 'On this device' }).click();
      await reader.getByRole('dialog').getByRole('button', { name: /PagedAttention\.pdf/ }).click();
      await ready(reader, 4);
    }
    assert.deepEqual(errors, []);
    const readingArea = await reader.locator('.workspace').boundingBox();
    assert.ok(readingArea);
    await page.screenshot({
      path: path.join(host.artifacts, '05-pdf-reader.png'), animations: 'disabled',
      clip: { ...readingArea, height: Math.min(readingArea.height, Math.round(readingArea.width * 0.46)) }
    });
    console.log('PASS bundled PDF: 16/16 pages painted Chinese, page 4 retained its diagram and distinct Chinese text after navigation and reload. Chinese characters by page: ' + counts.join(', '));
  } finally { await browser.close(); }
});
