import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type FrameLocator, type Page } from 'playwright-core';
import { openReader, withHost } from './host.js';

// Supply the original 12-page arXiv PDF (1512.03385) as a command-line argument.
const filename = process.argv[2];
if (!filename) throw new Error('Pass the path to Deep Residual Learning for Image Recognition.pdf.');
const bytes = await readFile(filename);
const docId = 'pdf-' + createHash('sha256').update(bytes).digest('hex');
type Reader = FrameLocator | Page;
type Patch = [name: string, x: number, y: number, width: number, height: number];
const regions: Record<number, Patch[]> = {
  2: [['upper weight layer', 136, 94, 38, 9], ['lower weight layer', 136, 119, 38, 9],
    ['upper relu', 159, 106, 16, 8], ['lower relu', 159, 146, 16, 9], ['identity', 205, 122, 28, 10],
    ['F(x)', 98, 106, 21, 10], ['F(x) + x', 106, 139, 40, 10]],
  3: [['Equation (1)', 122, 624, 165, 16], ['Equation (2)', 375, 262, 171, 17]],
  5: [['conv2 x', 131, 101, 24, 10], ['Table 1 including headers and grid', 124, 70, 347, 152],
    ['Table 2 including scores', 100, 443, 142, 39], ['Figure 4 including its axes', 87, 255, 417, 134]]
};

async function checkArtwork(reader: Reader, number: number): Promise<void> {
  const readings = await reader.locator('.pages').evaluate((pages, patches) => {
    const source = pages.querySelector<HTMLCanvasElement>('[data-pdf-side="source"] canvas')!;
    const target = pages.querySelector<HTMLCanvasElement>('[data-pdf-side="translation"] canvas')!;
    const overlay = [...pages.querySelectorAll<HTMLElement>('.pdf-translated-text:not([hidden])')];
    const plane = target.parentElement!.getBoundingClientRect();
    return patches.map(([name, x, y, width, height]) => {
      const [a, b] = [source, target].map(canvas => canvas.getContext('2d')!.getImageData(
        Math.round(x * canvas.width / 612), Math.round(y * canvas.height / 792),
        Math.round(width * canvas.width / 612), Math.round(height * canvas.height / 792)).data);
      let ink = 0, changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i] < 180) ink++;
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++;
      }
      const overlaps = overlay.filter(el => {
        const r = el.getBoundingClientRect();
        return r.left < plane.left + (x + width) * plane.width / 612 && r.right > plane.left + x * plane.width / 612 &&
          r.top < plane.top + (y + height) * plane.height / 792 && r.bottom > plane.top + y * plane.height / 792;
      }).map(el => el.dataset.blockId);
      return { name, ink, changed, overlaps };
    });
  }, regions[number]);
  for (const { name, ink, changed, overlaps } of readings) {
    assert.ok(ink > 15, name + ' must contain visible original ink');
    assert.equal(changed, 0, name + ' must retain every source pixel');
    assert.deepEqual(overlaps, [], name + ' must remain visible above the paper');
  }
  console.log('Page ' + number + ': ' + readings.map(p => p.name + ' (' + p.ink + ' ink pixels)').join(', '));
}

async function ready(reader: Reader, number: number): Promise<void> {
  await reader.getByRole('group', { name: 'Original, page ' + number, exact: true }).waitFor();
  await reader.locator('#loading').waitFor({ state: 'hidden' });
}

async function translated(reader: Reader, number: number): Promise<string> {
  const target = reader.getByRole('group', { name: 'Simplified Chinese, page ' + number, exact: true });
  await target.locator('.pdf-translated-text[data-role="paragraph"]:visible').first().waitFor({ timeout: 450_000 });
  await target.locator('.pdf-translation-state').waitFor({ state: 'hidden', timeout: 450_000 });
  const body = await target.locator('.pdf-translated-text[data-role="paragraph"]:visible').allInnerTexts();
  assert.match(body.join(' '), /\p{Script=Han}/u);
  if (number !== 3) {
    const caption = await target.locator('.pdf-translated-text[data-role="caption"]:visible').first().innerText();
    assert.match(caption, /\p{Script=Han}/u);
  }
  return body.join('\n');
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1840, height: 1040 }, deviceScaleFactor: 1.5, locale: 'en-US' });
    const page = await context.newPage();
    const reader = await openReader(page, host.authenticatedUrl);
    await reader.getByRole('button', { name: 'Open library' }).click();
    const [picker] = await Promise.all([page.waitForEvent('filechooser'), reader.getByRole('button', { name: 'Open a PDF' }).click()]);
    await picker.setFiles(filename);
    await ready(reader, 1);
    assert.equal(await reader.locator('#reader').getAttribute('data-reading-mode'), 'source');
    const link = new URL(await reader.locator('body').evaluate(body => body.ownerDocument.location.href));
    assert.equal(link.searchParams.get('doc'), docId);

    // Simulate entries saved by the previous extractor. Table cells and equations
    // used to be sent to the translator and must never cover newly preserved ink.
    const cache = path.join(host.scratch, 'reader', 'translations', docId);
    await mkdir(cache, { recursive: true });
    const obsolete = '\u65e7\u7248\u5217\u8868\u7ffb\u8bd1';
    await writeFile(path.join(cache, '3.json'), JSON.stringify({ 'p3-b11': obsolete, 'p3-b17': obsolete }));
    await writeFile(path.join(cache, '5.json'), JSON.stringify({ 'p5-b1': obsolete, 'p5-b2': obsolete, 'p5-b3': obsolete, 'p5-b6': obsolete, 'p5-b7': obsolete }));

    const standalone = await context.newPage();
    const requests: number[] = [];
    standalone.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/paper-reader/action')) {
        const body = request.postDataJSON();
        if (body.op === 'translation.page') requests.push(body.payload.page);
      }
    });
    const saved = new Map<number, string>();
    for (const number of [2, 3, 5]) {
      link.searchParams.set('page', String(number));
      await standalone.goto(link.href);
      await ready(standalone, number);
      if (number === 2) {
        // Importing above used Original only. The reading layout also applies in a new tab.
        const parallel = standalone.locator('#parallel');
        assert.equal(await parallel.getAttribute('aria-pressed'), 'false');
        await parallel.click();
        await standalone.getByLabel('Translation scope').selectOption('page');
      }
      await standalone.getByRole('group', { name: 'Simplified Chinese, page ' + number, exact: true }).waitFor();
      await checkArtwork(standalone, number);
      saved.set(number, await translated(standalone, number));
      await checkArtwork(standalone, number);
      assert.ok(!saved.get(number)!.includes(obsolete), 'Obsolete cached text must not replace unrelated prose.');
    }
    assert.deepEqual(requests, [2, 3, 5]);
    for (const number of [5, 3, 2]) {
      link.searchParams.set('page', String(number));
      if (number === 3) link.searchParams.set('anchor', 'p3-b11');
      else link.searchParams.delete('anchor');
      await standalone.goto(link.href);
      await ready(standalone, number);
      assert.equal(await translated(standalone, number), saved.get(number));
      if (number === 3) await standalone.locator('#original [data-block-id="p3-b11"].is-active').waitFor();
      await checkArtwork(standalone, number);
    }
    const old = await standalone.locator('#original canvas').elementHandle();
    await standalone.getByLabel('Zoom').selectOption('1.5');
    await old!.waitForElementState('hidden');
    assert.equal(await translated(standalone, 2), saved.get(2));
    await checkArtwork(standalone, 2);
    await standalone.reload();
    await ready(standalone, 2);
    assert.equal(await translated(standalone, 2), saved.get(2));
    await checkArtwork(standalone, 2);
    assert.deepEqual(requests, [2, 3, 5], 'Zoom and reload must reuse the saved prose translations.');

    const workspace = await standalone.locator('.workspace').boundingBox();
    assert.ok(workspace);
    const destination = path.join(host.artifacts, 'reviews', 'reader-workflow');
    await mkdir(destination, { recursive: true });
    await standalone.screenshot({ path: path.join(destination, 'figure-labels.png'), animations: 'disabled',
      clip: { ...workspace, height: Math.min(workspace.height, 560) } });
  } finally { await browser.close(); }
});
