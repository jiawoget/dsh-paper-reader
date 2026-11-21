import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { openToolbar, until } from './extension-controls.js';
import { withHost, type HostFixture } from './host.js';
import { fixtureCollection, fixturePdfTitle, startLibraryFixture } from './web-zotero-delivery-fixture.js';

const arxiv = {
  url: 'https://arxiv.org/html/2404.19737v1',
  title: 'Better & Faster Large Language Models via Multi-token Prediction',
  section: '2 Method'
};
const blog = {
  url: 'https://go.dev/blog/slices-intro',
  title: 'Go Slices: usage and internals',
  section: 'Slice internals',
  quote: 'A slice is a descriptor of an array segment.'
};
// These identifiers belong to the public library used by Zotero's Web API docs.
const publicLibrary = '475425';
const publicCollection = 'ID5R4RZ8';
const publicItemKey = 'A52ZIF29';
const publicItemTitle = 'creating_bibliographies [Zotero Documentation]';
const publicArticle = {
  url: 'https://www.zotero.org/support/creating_bibliographies',
  title: 'Creating Bibliographies',
  section: 'Quick Copy',
  quote: 'Simply select items in the center column'
};
const desktopViewport = { width: 1440, height: 940 };
const mobileViewport = { width: 390, height: 844 };
const appRoute = '/api/paper-reader/app/index.html';
const extensionPath = fileURLToPath(new URL('../../dist/extension', import.meta.url));
const fixturePreload = new URL('./web-zotero-delivery-preload.ts', import.meta.url).href;
const results = (...names: string[]) => names.join(' · ');

async function launch(host: HostFixture, useFixture = false): Promise<BrowserContext> {
  const args = ['--enable-unsafe-extension-debugging', '--no-proxy-server'];
  if (useFixture) args.push('--host-resolver-rules=MAP reader-delivery.test 127.0.0.1');
  const context = await chromium.launchPersistentContext(path.join(host.scratch, 'delivery-chrome'), {
    executablePath: host.executable, headless: true, viewport: desktopViewport, locale: 'en-US',
    ignoreDefaultArgs: ['--disable-extensions'], args
  });
  // Opening external publishers must not submit data to them. Loopback requests
  // can still save notes and settings in the disposable reader store.
  await context.route(/^https?:\/\//, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== '127.0.0.1' && !['GET', 'HEAD'].includes(request.method())) return route.abort();
    return route.continue();
  });
  return context;
}

async function openApp(page: Page, host: HostFixture): Promise<void> {
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
  await page.goto(host.origin + appRoute, { waitUntil: 'domcontentloaded' });
  await page.locator('#original .pdf-sheet').first().waitFor();
  await page.locator('#loading').waitFor({ state: 'hidden' });
}

async function library(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: 'Library', exact: true });
  if (!await dialog.isVisible()) await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Zotero', exact: true }).waitFor({ timeout: 6_000 });
  return dialog;
}

function zotero(dialog: Locator) { return dialog.getByRole('tab', { name: 'Zotero', exact: true }); }
function device(dialog: Locator) { return dialog.getByRole('tab', { name: 'On this device', exact: true }); }
function row(dialog: Locator, title: string) {
  return dialog.getByRole('button', { name: new RegExp('^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?: |$)') });
}
function collection(dialog: Locator) { return dialog.getByRole('combobox', { name: 'Collection', exact: true }); }

async function configureZotero(page: Page, mode: 'desktop' | 'web'): Promise<void> {
  await (await library(page)).getByRole('button', { name: 'Connection settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Zotero connection', exact: true });
  await dialog.getByLabel('Zotero connection').selectOption(mode);
  if (mode === 'web') {
    await dialog.getByLabel('Zotero library ID').fill(publicLibrary);
    assert.equal(await dialog.getByLabel('Zotero API key').inputValue(), '');
  }
  await dialog.getByRole('button', { name: 'Test Zotero connection', exact: true }).click();
  await dialog.getByText(mode === 'web' ? /Public web library connected/ : /Desktop library connected/).waitFor();
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

function documentId(page: Page): string {
  const id = new URL(page.url()).searchParams.get('doc');
  assert.ok(id, 'The opened document must have a local identity.');
  return id;
}

function note(panel: Page, text: string) {
  return panel.locator('#rail .cm-line[data-note-id]').filter({ hasText: text });
}

async function showNote(page: Page, text: string): Promise<void> {
  const show = page.getByRole('button', { name: 'Show notebook', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await note(page, text).waitFor();
}

async function savePassageNote(page: Page, scope: Locator, quote: string, text: string, section?: string): Promise<void> {
  const rail = page.getByRole('button', { name: 'Close notebook', exact: true });
  if (await rail.isVisible()) await rail.click();
  await scope.scrollIntoViewIfNeeded();
  await scope.evaluate((element, value) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent!.indexOf(value);
      if (start < 0) continue;
      document.getSelection()!.setBaseAndExtent(node, start, node, start + value.length);
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      return;
    }
    throw new Error('The source passage could not be found as selectable text.');
  }, quote);
  const card = page.locator('#card');
  if (section) assert.equal(await card.locator('.selection-location').innerText(), section);
  await card.getByRole('button', { name: 'Write note', exact: true }).click();
  await card.getByRole('textbox', { name: 'Your note' }).fill(text);
  await card.getByRole('button', { name: 'Save note', exact: true }).click();
  await card.locator('.selection-saved-note').getByText(text, { exact: true }).waitFor();
  await card.getByRole('button', { name: /^Close (?:selection|passage workspace)$/ }).click();
  const collapse = card.getByRole('button', { name: 'Close selection', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await showNote(page, text);
}

const original = (page: Page) => page.locator('#original').getByRole('article', { name: 'Original article', exact: true });

async function article(page: Page, expected: { title: string; url: string; section: string }): Promise<Locator> {
  const source = original(page);
  await source.getByRole('heading', { name: expected.title, exact: true }).first().waitFor({ timeout: 45_000 });
  await source.getByRole('heading', { name: expected.section, exact: true }).waitFor();
  const publisher = source.getByRole('link', { name: 'Original webpage', exact: true });
  assert.equal((await publisher.getAttribute('href'))?.replace(/^http:/, 'https:'), expected.url.replace(/^http:/, 'https:'));
  return source;
}

async function goToSection(page: Page, section: string): Promise<void> {
  const source = original(page);
  const contents = page.locator('#contentsPanel');
  if (!(await contents.isVisible())) await page.locator('#contentsToggle').click();
  await contents.getByRole('button', { name: section, exact: true }).click();
  const target = source.getByRole('heading', { name: section, exact: true });
  await until(() => target.evaluate(element => {
    const box = element.getBoundingClientRect(), viewport = document.querySelector('#paperScroll')!.getBoundingClientRect();
    return box.bottom > viewport.top && box.top < viewport.bottom;
  }), 'The contents link must scroll to the real section heading.');
}

async function pasteAddress(page: Page, url: string): Promise<void> {
  const dialog = await library(page);
  await dialog.getByRole('button', { name: 'Open web page', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Web address', exact: true }).fill(url);
  await dialog.getByRole('button', { name: 'Read article', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 45_000 });
}

async function captureArticle(context: BrowserContext, host: HostFixture, url: string): Promise<Page> {
  const browser = await context.browser()!.newBrowserCDPSession();
  const { id } = await browser.send('Extensions.loadUnpacked', { path: extensionPath });
  await browser.detach();
  const publisher = await context.newPage();
  const response = await publisher.goto(url, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), 'The publisher page must open in Chrome.');
  const setup = await openToolbar(publisher, id);
  await setup.evaluate(value => {
    document.querySelector<HTMLInputElement>('#origin')!.value = value;
    document.querySelector('form')!.requestSubmit();
  }, host.origin);
  await until(() => setup.evaluate(() => /address was saved|地址已保存/.test(document.querySelector('#message')?.textContent ?? ''), null),
    'The extension did not keep the isolated DSH address.');
  const opened = context.waitForEvent('page', { timeout: 30_000 });
  await setup.click('#read');
  await setup.detach();
  const reader = await opened;
  await reader.waitForURL(url => url.origin === host.origin && url.pathname === appRoute);
  const target = new URL(reader.url());
  assert.equal(target.origin, host.origin);
  assert.equal(target.pathname, appRoute);
  await publisher.close();
  return reader;
}

async function reopenOnDevice(page: Page, title: string, id: string): Promise<void> {
  const dialog = await library(page);
  await device(dialog).click();
  await row(dialog, title).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(documentId(page), id, 'Reopening from the library must reuse the saved reading document.');
}

async function fitViewport(page: Page, surface: Locator): Promise<void> {
  const box = await surface.boundingBox(), viewport = page.viewportSize();
  assert.ok(box && viewport && box.x >= -0.5 && box.x + box.width <= viewport.width + 0.5,
    'The surface must stay inside its viewport.');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'Reading controls must not cause the page to scroll horizontally.');
}

function screenshot(host: HostFixture, page: Page, name: string): Promise<Buffer> {
  return page.screenshot({ path: path.join(host.artifacts, 'reviews', 'web-zotero', name + '.png'), animations: 'disabled' });
}

async function fixtureAcceptance(): Promise<void> {
  const fixture = await startLibraryFixture();
  const fixtureArticle = fixture.article;
  try {
    await withHost(async host => {
      const context = await launch(host, true);
      try {
        const page = context.pages()[0];
        await openApp(page, host);
        await configureZotero(page, 'desktop');
        let dialog = await library(page);
        await zotero(dialog).click();
        await dialog.getByText(/no (?:zotero )?items/i).waitFor();
        fixture.populate();
        await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
        await collection(dialog).selectOption(fixtureCollection);
        assert.match(await collection(dialog).locator('option:checked').innerText(), /Systems.*Papers/);
        const search = dialog.getByRole('searchbox', { name: 'Search Zotero', exact: true });
        await search.fill('No item matches this fixture query');
        await dialog.getByText(/no (?:matching|results|items match)/i).waitFor();
        await search.fill('PagedAttention');
        await row(dialog, fixturePdfTitle).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.locator('#original .pdf-sheet').first().waitFor();
        const pdfId = documentId(page);
        assert.notEqual(pdfId, 'pagedattention', 'The Zotero attachment imported as its own file.');
        const attachmentRequest = fixture.requests.find(request => request.path === fixture.filePath);
        assert.ok(attachmentRequest, 'Opening must read bytes from the Zotero attachment route.');
        const pdfQuote = 'Efficient Memory Management';
        const pdfNote = 'Revisit how block allocation affects KV-cache fragmentation.';
        const pdfRun = page.locator('#original .pdf-native-text [data-block-id]').filter({ hasText: pdfQuote }).first();
        await savePassageNote(page, pdfRun, pdfQuote, pdfNote);
        await screenshot(host, page, 'fixture-zotero-pdf-note-desktop');

        const reader = await captureArticle(context, host, fixtureArticle.url);
        await article(reader, fixtureArticle);
        await goToSection(reader, fixtureArticle.section);
        const articleNote = 'Compare the number of physical blocks with current cache occupancy.';
        await savePassageNote(reader, original(reader).locator('p').filter({ hasText: fixtureArticle.quote }), fixtureArticle.quote, articleNote);
        await fixture.close();

        dialog = await library(reader);
        await zotero(dialog).click();
        await dialog.getByText(/open zotero on this computer/i).waitFor();
        assert.ok(await device(dialog).isVisible(), 'The offline panel leaves local documents accessible.');
        await screenshot(host, reader, 'fixture-zotero-offline-desktop');
        await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await reopenOnDevice(reader, fixturePdfTitle, pdfId);
        await showNote(reader, pdfNote);
        fixture.assertReadOnly();
        console.log('PASS fixture ' + results('empty library', 'nested collection', 'search/no match', 'PDF and linked note', 'web extension', 'offline fallback and reopen'));
      } finally { await context.close(); }
    }, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + fixturePreload].filter(Boolean).join(' '),
      PAPER_READER_TEST_DESKTOP_ZOTERO: fixture.origin
    });
  } finally { await fixture.close(); }
}

async function liveArticleAcceptance(): Promise<void> {
  await withHost(async host => {
    const context = await launch(host);
    try {
      const page = context.pages()[0];
      await openApp(page, host);
      await pasteAddress(page, arxiv.url);
      const originalPaper = await article(page, arxiv);
      await goToSection(page, arxiv.section);
      const caption = originalPaper.locator('figcaption').filter({ hasText: /Figure 1.*Overview of multi-token prediction/ }).first();
      await caption.waitFor();
      const figure = originalPaper.locator('figure img').first();
      await figure.scrollIntoViewIfNeeded();
      await until(() => figure.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
        'The original arXiv figure must render, with its caption preserved.');
      const captionId = await caption.getAttribute('id');
      assert.ok(captionId && await figure.getAttribute('aria-describedby') === captionId,
        'Assistive technology must be able to associate the figure with its caption.');
      assert.ok(await originalPaper.locator('math').count(), 'The original arXiv math must retain its semantics.');
      await figure.evaluate(el => el.scrollIntoView({ block: 'start' }));
      await page.mouse.move(8, 8);
      await screenshot(host, page, 'live-arxiv-figure-desktop');
      console.log('PASS live arXiv URL entry, outline jump, figure, caption, and math.');

      const reader = await captureArticle(context, host, blog.url);
      const originalBlog = await article(reader, blog);
      assert.ok(await originalBlog.locator('pre').filter({ hasText: 'var a [4]int' }).count(), 'The publisher code sample must retain its block format.');
      assert.equal(await originalBlog.getByText('Skip to Main Content', { exact: true }).count(), 0);
      const diagram = originalBlog.locator('figure img').nth(1);
      await diagram.scrollIntoViewIfNeeded();
      await until(() => diagram.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
        'The Go Blog slice diagram must load from the captured page.');
      await goToSection(reader, blog.section);
      const blogId = documentId(reader), blogNote = 'Check when a re-slice shares the backing array.';
      await savePassageNote(reader, originalBlog.locator('p').filter({ hasText: blog.quote }), blog.quote, blogNote, blog.section);
      await reader.locator('#rail .source-chip').first().click();
      await originalBlog.locator('.is-located').filter({ hasText: blog.quote }).waitFor();
      await screenshot(host, reader, 'live-go-blog-note-desktop');
      await reader.setViewportSize(mobileViewport);
      await reader.getByRole('button', { name: 'Close notebook', exact: true }).click();
      await goToSection(reader, blog.section);
      await fitViewport(reader, originalBlog);
      await screenshot(host, reader, 'live-go-blog-390');
      await reopenOnDevice(page, blog.title, blogId);
      await showNote(page, blogNote);
      await page.locator('#rail .source-chip').first().click();
      await original(page).locator('.is-located').filter({ hasText: blog.quote }).waitFor();
      console.log('PASS live Go Blog extension capture, source link, code, diagram, outline, note backlink and 390 px layout.');
    } finally { await context.close(); }
  });
}

async function liveZoteroAcceptance(): Promise<void> {
  const api = 'https://api.zotero.org/users/' + publicLibrary;
  const response = await fetch(api + '/items/' + publicItemKey, { headers: { 'Zotero-API-Version': '3' } });
  assert.equal(response.status, 200, 'The published example library must respond without credentials.');
  const item = await response.json();
  assert.equal(item.data.title, publicItemTitle);
  assert.ok(item.data.collections.includes(publicCollection));
  assert.equal(item.data.url.replace(/^http:/, 'https:'), publicArticle.url);

  await withHost(async host => {
    const context = await launch(host);
    try {
      const page = context.pages()[0];
      await openApp(page, host);
      await configureZotero(page, 'web');
      let dialog = await library(page);
      await zotero(dialog).click();
      await collection(dialog).selectOption(publicCollection);
      assert.match(await collection(dialog).locator('option:checked').innerText(), /Zotero techy stuff/);
      await dialog.getByRole('searchbox', { name: 'Search Zotero', exact: true }).fill('creating_bibliographies');
      await row(dialog, publicItemTitle).waitFor();
      await screenshot(host, page, 'live-zotero-collection-desktop');
      await page.setViewportSize(mobileViewport);
      await fitViewport(page, dialog);
      await fitViewport(page, dialog.getByRole('searchbox', { name: 'Search Zotero', exact: true }));
      await fitViewport(page, collection(dialog));
      await screenshot(host, page, 'live-zotero-collection-390');
      await page.setViewportSize(desktopViewport);
      await row(dialog, publicItemTitle).click();
      await dialog.waitFor({ state: 'hidden', timeout: 45_000 });
      const source = await article(page, publicArticle);
      const referenceId = documentId(page), referenceNote = 'Check Quick Copy before exporting the bibliography.';
      await savePassageNote(page, source.locator('p').filter({ hasText: publicArticle.quote }), publicArticle.quote, referenceNote);
      await reopenOnDevice(page, 'PagedAttention.pdf', 'pagedattention');
      dialog = await library(page);
      await zotero(dialog).click();
      await collection(dialog).selectOption(publicCollection);
      await dialog.getByRole('searchbox', { name: 'Search Zotero', exact: true }).fill('creating_bibliographies');
      await row(dialog, publicItemTitle).click();
      await dialog.waitFor({ state: 'hidden', timeout: 45_000 });
      assert.equal(documentId(page), referenceId);
      await showNote(page, referenceNote);
      await screenshot(host, page, 'live-zotero-url-note-desktop');
      console.log('PASS real public Zotero ' + results('read-only connection', 'live collection and search', 'URL opening', 'saved note', 'reopen from same Zotero item'));
    } finally { await context.close(); }
  });
}

await mkdir(fileURLToPath(new URL('../../artifacts/reviews/web-zotero/', import.meta.url)), { recursive: true });
if (process.argv.includes('--live')) {
  await liveArticleAcceptance();
  await liveZoteroAcceptance();
} else if (process.argv.includes('--live-zotero')) await liveZoteroAcceptance();
else await fixtureAcceptance();
