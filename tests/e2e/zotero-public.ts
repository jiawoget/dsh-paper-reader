import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { withHost } from './host.js';

// Zotero's Web API v3 basics page uses this public book as its example item.
// Every request to the real Web API in this exercise is a GET. Linking writes to the isolated reader database.
const id = '475425', itemKey = 'X42A7DEE', query = 'Electron Microscopy and Analysis 1993';
const response = await fetch('https://api.zotero.org/users/' + id + '/items/' + itemKey, { headers: { 'Zotero-API-Version': '3' } });
assert.equal(response.status, 200);
const book = await response.json();
assert.match(book.data.title, /Electron Microscopy and Analysis 1993/);
await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1380, height: 900 } }), page = await context.newPage();
    await page.goto(host.authenticatedUrl);
    const imported = await context.request.post(host.origin + '/api/paper-reader/action', {
      data: { op: 'web.import', payload: { title: query, url: book.links.alternate.href, paragraphs: [book.data.title] } }
    });
    assert.ok(imported.ok());
    const doc = (await imported.json()).doc;
    await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=' + doc.id);
    await page.getByRole('button', { name: 'Show notes' }).click();
    const tab = page.getByRole('tab', { name: 'Reference' });
    await tab.click();
    await page.getByRole('button', { name: 'Connection settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Zotero connection').selectOption('web');
    await dialog.getByLabel('Zotero library ID').fill(id);
    assert.equal(await dialog.getByLabel('Zotero API key').inputValue(), '');
    await dialog.getByRole('button', { name: 'Test Zotero connection' }).click();
    await dialog.getByText('Public web library connected · read and link items').waitFor();
    await dialog.getByRole('button', { name: 'Save connections' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('.zotero-connection').getByText('Public web library connected · read and link items').waitFor();
    assert.ok(await page.getByRole('button', { name: 'Add to library' }).isDisabled());
    await page.getByRole('searchbox', { name: 'Search Zotero' }).fill(query);
    await page.getByRole('button', { name: 'Find item' }).click();
    await page.getByRole('button', { name: book.data.title, exact: true }).click();
    await page.getByRole('button', { name: 'Link this item' }).click();
    await page.getByText('Linked reference').waitFor();
    await page.reload();
    await tab.click();
    await page.getByText('Public web library connected · read and link items').waitFor();
    assert.ok((await page.getByRole('link', { name: 'Open in Zotero' }).getAttribute('href'))?.includes(itemKey));
    const destination = path.join(host.artifacts, 'reviews', 'reading-desk');
    await mkdir(destination, { recursive: true });
    await page.screenshot({ path: path.join(destination, 'zotero-public.png'), animations: 'disabled' });
    console.log('Verified real public Zotero Web API v3 test, search, link, reload and read-only controls for the documented example book.');
  } finally { await browser.close(); }
});
