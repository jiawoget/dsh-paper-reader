import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { until } from './extension-controls.js';
import { withHost, type HostFixture } from './host.js';
import { bookmarkTitles, outlinePdf, printedHeadings, startOutlineModel } from './sidebar-contents-fixture.js';

const appRoute = '/api/paper-reader/app/index.html';
const desktop = { width: 1440, height: 940 };
const mobile = { width: 390, height: 844 };
const plainTitle = 'Study without PDF bookmarks.pdf';
const bookTitle = 'Study with PDF bookmarks.pdf';
const scanTitle = 'Image-only study scan.pdf';
const evidence = process.argv.includes('--evidence');
const panel = (page: Page) => page.locator('#contentsPanel');
const toggle = (page: Page) => page.locator('#contentsToggle');
const generate = (page: Page) => panel(page).locator('#generateOutline');
const entry = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
type OutlineModel = Awaited<ReturnType<typeof startOutlineModel>>;

async function openApp(page: Page, host: HostFixture) {
  page.setDefaultTimeout(12_000);
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
  await page.goto(host.origin + appRoute, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading').waitFor({ state: 'hidden' });
  await page.locator('#original .pdf-sheet').waitFor();
}

async function importPdf(page: Page, title: string, buffer: Buffer) {
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Library', exact: true });
  const choice = page.waitForEvent('filechooser');
  await library.getByRole('button', { name: 'Open a PDF', exact: true }).click();
  await (await choice).setFiles({ name: title, mimeType: 'application/pdf', buffer });
  await library.waitFor({ state: 'hidden' });
  await page.locator('#loading').waitFor({ state: 'hidden' });
  await page.locator('#original .pdf-sheet').waitFor();
  assert.equal(await page.locator('#docTitle').innerText(), title);
  return new URL(page.url()).searchParams.get('doc');
}

async function showContents(page: Page) {
  if (!(await panel(page).isVisible())) await toggle(page).click();
  await panel(page).waitFor();
  assert.equal(await page.locator('#contentsTab').getAttribute('aria-selected'), 'true');
}

async function current(item: Locator, title: string) {
  await until(async () => await item.getAttribute('aria-current') === 'location', 'Contents must mark the current location as ' + title + '.');
}

async function sourcePage(page: Page, number: number) {
  await page.waitForURL(url => url.searchParams.get('page') === String(number));
  await page.locator('#loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#pageCount').innerText(), number + ' / 3');
}

async function headingVisible(page: Page, heading: string) {
  const text = page.locator('#original .pdf-native-text span').filter({ hasText: heading }).first();
  await text.waitFor();
  await until(() => text.evaluate(element => {
    const scroller = document.querySelector('#paperScroll')!.getBoundingClientRect();
    const line = element.getBoundingClientRect();
    return line.top >= scroller.top - 12 && line.bottom <= scroller.bottom;
  }), 'The selected destination must reveal the reading line: ' + heading);
}

async function nestedEntry(page: Page, parent: string, child: string) {
  await entry(page, parent).locator('xpath=ancestor::li[1]').locator('ul').getByRole('button', { name: child, exact: true }).waitFor();
}

async function reloadDestination(page: Page, title: string, heading: string) {
  const destination = new URL(page.url()).searchParams;
  const anchor = destination.get('anchor');
  assert.ok(anchor, 'A Contents jump must keep the specific destination in the address.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sourcePage(page, 2);
  const restored = new URL(page.url()).searchParams;
  assert.equal(restored.get('doc'), destination.get('doc'));
  assert.equal(restored.get('anchor'), anchor);
  await showContents(page);
  await headingVisible(page, heading);
  await current(entry(page, title), title);
}

async function screenshot(host: HostFixture, page: Page, name: string) {
  if (!evidence) return;
  const directory = path.join(host.artifacts, 'reviews', 'sidebar-contents');
  await mkdir(directory, { recursive: true });
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(directory, name + '.png'), animations: 'disabled' });
}

async function configureModel(page: Page, model: OutlineModel) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Connections', exact: true });
  await settings.getByLabel('API base URL', { exact: true }).fill(model.baseUrl);
  await settings.getByLabel('Model', { exact: true }).fill(model.model);
  await settings.getByLabel('API key', { exact: true }).fill(model.key);
  await settings.getByRole('button', { name: 'Save connections', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
}

async function nativePdf(page: Page, host: HostFixture, model: OutlineModel) {
  await showContents(page);
  await current(entry(page, '4.2 KV Cache Manager'), '4.2 KV Cache Manager');
  await page.locator('#zoom').selectOption('2');
  await page.locator('#paperScroll').evaluate(el => { el.scrollTop = Math.round(el.scrollHeight * 0.46); });
  await current(entry(page, '4.3 Decoding with PagedAttention and vLLM'), '4.3 Decoding with PagedAttention and vLLM');
  await page.locator('#zoom').selectOption('1');
  await page.locator('#closeRail').click();
  await importPdf(page, bookTitle, outlinePdf('bookmarked'));
  await showContents(page);
  const [opening, design, controls, findings] = bookmarkTitles;
  await entry(page, opening).waitFor();
  assert.equal(await panel(page).locator('.toc-entry').count(), 4);
  await nestedEntry(page, design, controls);
  const fold = panel(page).getByRole('button', { name: 'Subsections of ' + design, exact: true });
  await fold.press('Enter');
  await entry(page, controls).waitFor({ state: 'hidden' });
  await fold.press('Enter');
  await entry(page, controls).waitFor();
  assert.equal(await generate(page).count(), 0);
  assert.equal(await panel(page).getByText('AI-generated contents', { exact: true }).count(), 0);

  await entry(page, design).click();
  await sourcePage(page, 2);
  await headingVisible(page, printedHeadings[1].text);
  const scroll = page.locator('#paperScroll');
  const early = await scroll.evaluate(element => element.scrollTop);
  await current(entry(page, design), design);
  await entry(page, controls).click();
  await sourcePage(page, 2);
  await headingVisible(page, printedHeadings[2].text);
  assert.ok(await scroll.evaluate(element => element.scrollTop) > early + 200, 'A second bookmark on page 2 must change the within-page reading position.');
  await current(entry(page, controls), controls);
  await scroll.evaluate((element, top) => { element.scrollTop = top + 50; }, early);
  await current(entry(page, design), design);
  await entry(page, controls).click();
  await current(entry(page, controls), controls);
  await reloadDestination(page, controls, printedHeadings[2].text);
  await screenshot(host, page, 'native-pdf-desktop');

  await page.locator('#closeRail').click();
  await panel(page).waitFor({ state: 'hidden' });
  await toggle(page).press('Enter');
  await current(entry(page, controls), controls);
  await entry(page, findings).click();
  await sourcePage(page, 3);
  await current(entry(page, findings), findings);
  assert.equal(model.received(), 0, 'PDF bookmarks must take priority without contacting the model.');
  console.log('PASS Native PDF bookmarks preserve hierarchy, jump to named and same-page destinations, restore the current entry after reload, and make no model requests.');
}

async function generatedPdf(page: Page, host: HostFixture, model: OutlineModel) {
  const doc = await importPdf(page, plainTitle, outlinePdf('plain'));
  assert.ok(doc);
  await showContents(page);
  await panel(page).getByRole('status').filter({ hasText: /no bookmarks/i }).waitFor();
  assert.equal(model.received(), 0, 'Opening unbookmarked contents should wait for the reader’s AI action.');

  await generate(page).click();
  await panel(page).getByRole('button', { name: /try again/i }).waitFor();
  assert.match(await panel(page).getByRole('status').innerText(), /model|outline|contents/i);
  assert.equal(await panel(page).locator('.toc-entry').count(), 0, 'An ungrounded model reply must leave no clickable contents.');
  assert.equal(model.received(), 1);
  await screenshot(host, page, 'pdf-generation-retry');
  await generate(page).click();
  await panel(page).getByText('AI-generated contents', { exact: true }).waitFor();
  for (const heading of printedHeadings) await entry(page, heading.text).waitFor();
  await nestedEntry(page, printedHeadings[1].text, printedHeadings[2].text);
  assert.deepEqual(model.calls, Array.from({ length: 2 }, () => ({
    pages: [1, 2, 3], matched: printedHeadings.map(heading => heading.text)
  })), 'Both model calls must contain all actual source pages and heading text.');

  await entry(page, printedHeadings[2].text).click();
  await sourcePage(page, 2);
  await headingVisible(page, printedHeadings[2].text);
  await current(entry(page, printedHeadings[2].text), printedHeadings[2].text);
  await page.locator('#closeRail').click();
  await panel(page).waitFor({ state: 'hidden' });
  await reloadDestination(page, printedHeadings[2].text, printedHeadings[2].text);
  await screenshot(host, page, 'generated-pdf-desktop');
  console.log('PASS PDF text reaches the configured loopback model, an ungrounded response offers retry, and the successful outline restores the source position and current entry after reload.');
  return doc;
}

async function fit(page: Page, locator: Locator) {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && viewport && bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1,
    'Contents must fit the narrow viewport.');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'The reader must fit without horizontal window scrolling.');
}

async function mobilePdf(browser: Browser, host: HostFixture, model: OutlineModel, doc: string) {
  const context = await browser.newContext({ locale: 'en-US', viewport: mobile, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openApp(page, host);
    await page.getByRole('button', { name: 'Open library', exact: true }).click();
    const library = page.getByRole('dialog', { name: 'Library', exact: true });
    await library.getByRole('tab', { name: 'On this device', exact: true }).click();
    await library.getByRole('button').filter({ hasText: plainTitle }).click();
    await library.waitFor({ state: 'hidden' });
    assert.equal(new URL(page.url()).searchParams.get('doc'), doc);
    await toggle(page).waitFor();
    await fit(page, toggle(page));
    await showContents(page);
    await panel(page).getByText('AI-generated contents', { exact: true }).waitFor();
    await fit(page, panel(page));
    assert.equal(await page.locator('#rail').getAttribute('aria-modal'), 'true');
    assert.equal(model.received(), 2, 'A fresh browser profile must get the saved outline without another model request.');
    await screenshot(host, page, 'cached-pdf-390');
    await page.keyboard.press('Escape');
    await panel(page).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'contentsToggle');

    await showContents(page);
    await entry(page, printedHeadings[3].text).click();
    await sourcePage(page, 3);
    await panel(page).waitFor({ state: 'hidden' });
    await fit(page, page.locator('#paperScroll'));
    console.log('PASS 390 px drawer reopens a cached outline in a fresh browser profile, fits, restores focus on Escape, and closes after a jump.');

    await importPdf(page, scanTitle, outlinePdf('scan'));
    await showContents(page);
    await generate(page).click();
    await panel(page).getByRole('status').filter({ hasText: /no readable text.*OCR/i }).waitFor();
    assert.equal(await panel(page).locator('.toc-entry').count(), 0);
    assert.equal(model.received(), 2, 'An image-only PDF must not be sent to the text model.');
    await screenshot(host, page, 'scan-no-text-390');
    console.log('PASS Image-only PDF explains how to proceed with OCR and sends no model request.');
  } finally {
    await context.close();
  }
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  const model = await startOutlineModel();
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: desktop });
    const page = await context.newPage();
    await openApp(page, host);
    await configureModel(page, model);
    await nativePdf(page, host, model);
    if (!process.argv.includes('--native-only')) {
      const doc = await generatedPdf(page, host, model);
      await context.close();
      await mobilePdf(browser, host, model, doc);
    }
  } finally {
    await browser.close();
    await model.close();
  }
});
