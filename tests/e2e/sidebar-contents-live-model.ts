import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { withHost } from './host.js';

const name = 'PagedAttention (no bookmarks).pdf';
const recordEvidence = process.argv.includes('--evidence');

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 940 } });
    page.setDefaultTimeout(25_000);
    await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
    await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=1');
    await page.locator('#loading').waitFor({ state: 'hidden' });
    await page.locator('#contentsToggle').click();
    await page.locator('.toc-entry').first().waitFor();
    const readEntries = () => page.locator('#contentsPanel .toc-entry').evaluateAll(nodes => nodes.map(node => ({
      title: node.querySelector('.toc-label')!.textContent!,
      page: Number(node.querySelector('.toc-page')!.textContent)
    })));
    const native = await readEntries();

    // Rename the catalog's bookmark key in memory. Equal byte lengths preserve this PDF's cross-reference offsets.
    const original = await readFile(new URL('../../public/assets/pagedattention.pdf', import.meta.url));
    const input = Buffer.from(original.toString('latin1').replaceAll('/Outlines', '/NoOutlns'), 'latin1');
    assert.equal(input.length, original.length);
    assert.ok(!input.equals(original));
    await page.locator('#library').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '打开文件', exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: input });
    await page.getByText(name, { exact: true }).first().waitFor();
    if (!await page.locator('#contentsPanel').isVisible()) await page.locator('#contentsToggle').click();

    const generation = page.waitForResponse(response => response.url().endsWith('/action') &&
      response.request().postDataJSON()?.op === 'outline.generate', { timeout: 300_000 });
    await page.locator('#generateOutline').click();
    const response = await generation;
    if (!response.ok()) throw Error('Model request failed with HTTP ' + response.status() + '. ' + (await response.json()).error);
    await page.locator('.toc-origin').waitFor();
    const generated = await readEntries();
    assert.ok(new Set(generated.map(entry => entry.page)).size >= 3, 'The PDF should have sections on at least three distinct pages.');
    const target = generated.find(entry => entry.page > 1 && /pagedattention|evaluation|implementation/i.test(entry.title));
    assert.ok(target, 'The outline must identify a substantive section of the paper.');
    const button = page.locator('#contentsPanel').getByRole('button', { name: target.title, exact: true });
    if (!await button.isVisible()) {
      for (const fold of await page.locator('.toc-fold[aria-expanded="false"]').all()) {
        if (await fold.isVisible()) await fold.click();
      }
    }
    await button.click();
    await page.waitForFunction(number => new URL(location.href).searchParams.get('page') === String(number), target.page);
    const current = page.locator('.toc-entry[aria-current="location"]').filter({ hasText: target.title });
    await current.waitFor();
    await page.reload();
    await page.locator('.toc-origin').waitFor();
    await current.waitFor();
    assert.deepEqual(await readEntries(), generated);

    if (recordEvidence) {
      const directory = path.join(host.artifacts, 'reviews', 'sidebar-contents');
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, 'live-pdf-ai-zh.png') });
      await writeFile(path.join(directory, 'live-model-outline.json'), JSON.stringify({
        document: 'PagedAttention, 16-page public paper with bookmarks removed for this test',
        original: native, generated, jumped: target
      }, null, 2));
    }
    console.log('Generated ' + generated.length + ' entries. Reopened ' + target.title + ' on page ' + target.page + '.');
  } finally {
    await browser.close();
  }
}, {}, { installedModelProfile: true });
