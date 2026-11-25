import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { bookRoot, bookTitle, chapters, cmsDetailPath, cmsPath, fixtureBlog, fixturePassages, googleUrl,
  sections, startPublisherFixture } from './book-reading-fixture.js';
import { openToolbar, until } from './extension-controls.js';
import { withHost, type HostFixture } from './host.js';
import { withNativeNotebook } from './native-notebook.js';
import { markdownLinks, vaultSource, visibleMarkdown } from './vault-links.js';

const live = process.argv.includes('--live');
const evidence = process.argv.includes('--evidence');
const runName = live ? 'live' : 'fixture';
const viewport = { width: 1440, height: 940 };
const mobile = { width: 390, height: 844 };
const appRoute = '/api/paper-reader/app/index.html';
const extension = fileURLToPath(new URL('../../dist/extension', import.meta.url));
const preload = new URL('./book-reading-preload.ts', import.meta.url).href;
const liveBlog = {
  title: 'Empty shelves or lost keys? Recall is the bottleneck for parametric factuality',
  noteQuote: 'recall becomes harder', wikiCaption: 'A fully automated pipeline', whyCaption: 'We compare two popularity tiers'
};
const livePassages = { first: 'Finance is the study', second: 'chief financial officer', otherChapter: 'executive management teams',
  resume: 'Financial planning is critical' };
const bookNotes = ['Compare how firms raise funds.', 'Revisit the treasurer’s role in the next case.', 'List two tradeoffs when choosing a legal structure.'];
const blogNote = 'Check whether alternate phrasing changes the recall gap.';
type Section = { slug: string; title: string };
type PublisherRequest = { url: string; method: string; accept: string };

function readRequests(source: string): PublisherRequest[] {
  return source.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as PublisherRequest);
}

function traceBook(filename: string) {
  const steps: { action: string; paths: string[] }[] = [];
  let seen = 0;
  return {
    steps,
    async expect(action: string, expected: string[]) {
      const newer = readRequests(await readFile(filename, 'utf8')).slice(seen);
      seen += newer.length;
      assert.ok(newer.every(request => request.method === 'GET'), 'Publisher access must stay read-only.');
      const paths = newer.map(request => new URL(request.url)).filter(url =>
        url.hostname === 'openstax.org' && (url.pathname.startsWith(new URL(bookRoot).pathname) || url.pathname.startsWith('/apps/cms/')))
        .map(url => url.pathname);
      steps.push({ action, paths });
      assert.deepEqual(paths, expected.map(value => value.startsWith('/') ? value : new URL(value, bookRoot).pathname), action);
      console.log(action + ' → ' + (paths.join(', ') || 'no OpenStax page requests'));
    }
  };
}

async function launch(host: HostFixture, profile: string, size = viewport): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(path.join(host.scratch, profile), {
    executablePath: host.executable, headless: true, viewport: size, locale: 'en-US',
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--no-proxy-server']
  });
  await context.route(/^https?:\/\//, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1' || live && ['GET', 'HEAD'].includes(request.method())) return route.continue();
    return route.abort();
  });
  return context;
}

async function openApp(page: Page, host: HostFixture) {
  page.setDefaultTimeout(12_000);
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
  await page.goto(host.origin + appRoute, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading').waitFor({ state: 'hidden' });
  await page.locator('#original .pdf-sheet, #original .web-reading-sheet').first().waitFor();
}

const original = (page: Page) => page.locator('#original').getByRole('article', { name: 'Original article', exact: true });
const paragraph = (page: Page, text: string) => original(page).locator('p')
  .filter({ hasText: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
const contentsPanel = (page: Page) => page.locator('#contentsPanel');
const contentsToggle = (page: Page) => page.locator('#contentsToggle');
const chapterTitle = (page: Page) => page.locator('.notebook-chapter');
const openLibrary = (page: Page) => page.getByRole('button', { name: 'Open library', exact: true }).click();

async function showContents(page: Page) {
  const contents = contentsPanel(page);
  if (!(await contents.isVisible())) await contentsToggle(page).click();
  await contents.waitFor();
  return contents;
}

async function currentContentsEntry(page: Page, title: string) {
  await until(async () => (await contentsPanel(page).locator('.toc-entry[aria-current="location"]').allTextContents())
    .some(text => text.trim() === title), 'Contents must mark the current location as ' + title + '.');
}

async function pasteAddress(page: Page, url: string) {
  await openLibrary(page);
  const library = page.getByRole('dialog', { name: 'Library', exact: true });
  await library.getByRole('button', { name: 'Open web page', exact: true }).click();
  await library.getByRole('textbox', { name: 'Web address', exact: true }).fill(url);
  await library.getByRole('button', { name: url.startsWith(bookRoot) ? 'Open book' : 'Read article', exact: true }).click();
  await Promise.race([
    library.waitFor({ state: 'hidden', timeout: 45_000 }),
    library.getByRole('link', { name: 'Open original page', exact: true }).waitFor({ timeout: 45_000 }).then(async () => {
      throw new Error('The reader could not open ' + url + '. ' + await library.locator('#library-url-form [role="status"]').innerText());
    })
  ]);
}

async function activeSection(page: Page, section: Section) {
  await original(page).getByRole('heading', { name: section.title, exact: true }).first().waitFor();
  const publisher = original(page).getByRole('link', { name: 'Access for free at OpenStax', exact: true });
  assert.equal(await publisher.getAttribute('href'), bookRoot + section.slug);
  assert.equal(await page.locator('#docTitle').innerText(), bookTitle);
  if (await contentsPanel(page).isVisible()) await currentContentsEntry(page, section.title);
  const location = new URL(page.url());
  const doc = location.searchParams.get('doc'), number = Number(location.searchParams.get('page'));
  assert.ok(doc && Number.isInteger(number) && number > 0);
  return { doc, number };
}

async function chooseSection(page: Page, section: Section) {
  const contents = await showContents(page);
  const group = contents.locator('details').filter({ has: page.locator('.toc-entry').filter({ hasText: section.title }) });
  if (await group.count() && !(await group.evaluate((element: HTMLDetailsElement) => element.open))) {
    await group.locator('summary').click();
  }
  await contents.getByRole('button', { name: section.title, exact: true }).click();
  return activeSection(page, section);
}

async function connectVault(page: Page, folder: string) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Connections', exact: true });
  await settings.getByRole('tab', { name: 'Obsidian', exact: true }).click();
  await settings.getByLabel('Obsidian vault folder', { exact: true }).fill(folder);
  await settings.getByRole('button', { name: 'Save connections', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
}

async function hideNotebook(page: Page) {
  const close = page.locator('#closeRail');
  if (await close.isVisible()) await close.click();
}

function noteLine(page: Page, value: string) {
  return page.locator('#rail .cm-line[data-note-id]').filter({ hasText: value });
}

async function openNotebook(page: Page, value: string) {
  const show = page.getByRole('button', { name: 'Show notes', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await noteLine(page, value).waitFor();
}

async function saveNote(page: Page, quote: string, value: string) {
  await hideNotebook(page);
  const target = paragraph(page, quote);
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent!.indexOf(text);
      if (start < 0) continue;
      document.getSelection()!.setBaseAndExtent(node, start, node, start + text.length);
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      return;
    }
    throw new Error('No selectable text for the note.');
  }, quote);
  const card = page.locator('#card');
  await card.getByRole('button', { name: 'Write note', exact: true }).click();
  await card.getByRole('textbox', { name: 'Your note' }).fill(value);
  await card.getByRole('button', { name: 'Save note', exact: true }).click();
  await card.locator('.selection-saved-note').getByText(value, { exact: true }).waitFor();
  await card.getByRole('button', { name: /^Close (?:selection|passage workspace)$/ }).click();
  const collapse = card.getByRole('button', { name: 'Close selection', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await openNotebook(page, value);
}

function evidenceDir(host: HostFixture) { return path.join(host.artifacts, 'reviews', 'books-and-blog'); }

async function screenshot(host: HostFixture, page: Page, label: string) {
  if (evidence) await page.screenshot({ path: path.join(evidenceDir(host), runName + '-' + label + '.png'), animations: 'disabled' });
}

async function fit(page: Page, target: Locator) {
  const bounds = await target.boundingBox(), width = page.viewportSize()?.width;
  assert.ok(bounds && width && bounds.x >= -0.5 && bounds.x + bounds.width <= width + 0.5);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
}

async function captureExtension(context: BrowserContext, host: HostFixture, url: string) {
  const session = await context.browser()!.newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: extension });
  await session.detach();
  const publisher = await context.newPage();
  const response = await publisher.goto(url, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), 'Chrome must open the real publisher page.');
  const setup = await openToolbar(publisher, id);
  await setup.evaluate(value => {
    document.querySelector<HTMLInputElement>('#origin')!.value = value;
    document.querySelector('form')!.requestSubmit();
  }, host.origin);
  await until(() => setup.evaluate(() => /address was saved|地址已保存/.test(document.querySelector('#message')?.textContent ?? ''), null),
    'The extension did not save the isolated host address.');
  const opened = context.waitForEvent('page', { timeout: 30_000 });
  await setup.click('#read');
  await setup.detach();
  const page = await opened;
  await page.waitForURL(address => address.origin === host.origin && address.pathname === appRoute);
  await publisher.close();
  return page;
}

async function verifyVault(vault: string, passages: typeof fixturePassages) {
  const root = path.join(vault, 'Paper Reader');
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.md'));
  const notebooks = await Promise.all(files.map(async relative => ({ relative, file: path.join(root, relative),
    markdown: await readFile(path.join(root, relative), 'utf8') })));
  const first = notebooks.find(item => item.markdown.includes(bookNotes[0]));
  const second = notebooks.find(item => item.markdown.includes(bookNotes[2]));
  assert.ok(first && second, 'The notes must live in Markdown files inside the configured vault.');
  assert.equal(path.dirname(first.relative), path.dirname(second.relative));
  assert.equal(path.dirname(first.relative), 'principles-finance', 'The two chapter files must share the publisher book folder.');
  assert.notEqual(first.file, second.file);
  assert.deepEqual(files.filter(file => path.dirname(file) === 'principles-finance').sort(), [first.relative, second.relative].sort());
  assert.ok(path.basename(first.file).includes('Introduction to Finance'));
  assert.ok(path.basename(second.file).includes('Corporate Structure and Governance'));
  assert.ok(first.markdown.includes(bookNotes[1]));
  assert.ok(!second.markdown.includes(bookNotes[0]) && !second.markdown.includes(bookNotes[1]));
  const links = await Promise.all([first, first, second].map(async (item, index) => {
    const quote = [passages.first, passages.second, passages.otherChapter][index];
    const section = [sections.first, sections.second, sections.otherChapter][index];
    const destinations = markdownLinks(visibleMarkdown(item.markdown));
    const i = destinations.findIndex(link => link.label.startsWith(section.title));
    assert.ok(i >= 0, 'A citation must name the publisher section where the note was made.');
    const publisher = new URL(destinations[i].target);
    assert.equal(publisher.origin + publisher.pathname, bookRoot + section.slug);
    assert.ok(publisher.hash, 'The publisher link must locate the cited passage.');
    if (!live) assert.equal(publisher.hash, ['#example-6', '#example-8', '#example-6'][index]);
    const copy = destinations[i + 1];
    assert.equal(copy?.label, 'Library copy');
    const { file, fragment } = vaultSource(vault, item.file, copy.target);
    assert.match(fragment, /^\^p-\d+$/u);
    const text = await readFile(file, 'utf8');
    assert.ok(text.split('\n').some(line => line.endsWith(' ' + fragment) && line.includes(quote)),
      'The vault copy must locate the quoted paragraph without loading the reader or publisher.');
    return { publisher, copy: copy.target, file };
  }));
  assert.equal(new Set(links.map(link => link.file)).size, 3, 'Each section has its own captured source.');
  return { first, second, links };
}

async function relativeTop(target: Locator) {
  return target.evaluate(element => element.getBoundingClientRect().top - document.querySelector('#paperScroll')!.getBoundingClientRect().top);
}

function readingAnchor(page: Page) {
  return page.locator('#paperScroll').evaluate(scroller => {
    const line = scroller.getBoundingClientRect().top + Math.min(48, scroller.clientHeight / 8);
    return [...scroller.querySelectorAll<HTMLElement>('#original .web-reading-row')].find(row => row.getBoundingClientRect().bottom > line)?.dataset.anchor;
  });
}

async function savedProgress(page: Page, host: HostFixture, docId: string) {
  const response = await page.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'book.progress.get', payload: { docId } } });
  assert.ok(response.ok());
  return response.json();
}

async function bookJourney(host: HostFixture, vault: string, trace: ReturnType<typeof traceBook>, fixtureOrigin?: string) {
  const passages = live ? livePassages : fixturePassages;
  const context = await launch(host, 'book-chrome');
  let saved: Awaited<ReturnType<typeof verifyVault>>;
  let bookId: string;
  let bookAnchor: string;
  let beforeTop: number;
  let localBeforeClose: string | null;
  let tocSections: number;
  let farPage: number;
  try {
    const page = context.pages()[0];
    await openApp(page, host);
    await pasteAddress(page, bookRoot);
    const landing = await activeSection(page, sections.start);
    bookId = landing.doc;
    await trace.expect('Open book landing', [cmsPath, cmsDetailPath, sections.start.slug]);
    const contents = contentsPanel(page);
    await contents.waitFor();
    await currentContentsEntry(page, sections.start.title);
    const groups = contents.locator('details');
    assert.ok(await groups.count() >= (live ? 20 : 3));
    tocSections = await contents.locator('.toc-entry').count();
    assert.ok(tocSections >= (live ? 250 : 9));
    for (const chapter of chapters) assert.ok(await groups.locator('summary').evaluateAll((summaries, title) =>
      summaries.some(summary => summary.textContent?.trim() === title), chapter));
    await hideNotebook(page);
    await contents.waitFor({ state: 'hidden' });
    await contentsToggle(page).press('Enter');
    await contents.waitFor();
    assert.equal(await contentsToggle(page).getAttribute('aria-expanded'), 'true');
    await currentContentsEntry(page, sections.start.title);
    await trace.expect('Inspect book contents without fetching more sections', []);
    await connectVault(page, vault);

    await page.getByRole('button', { name: 'Next section', exact: true }).click();
    const first = await activeSection(page, sections.first);
    assert.equal(first.doc, bookId);
    await trace.expect('Next section', [sections.first.slug]);
    await saveNote(page, passages.first, bookNotes[0]);
    assert.match(await chapterTitle(page).innerText(), /Introduction to Finance/);
    await hideNotebook(page);
    await page.getByRole('button', { name: 'Previous section', exact: true }).click();
    await activeSection(page, sections.start);
    await trace.expect('Previous cached section', []);

    const second = await chooseSection(page, sections.second);
    assert.equal(second.doc, bookId);
    await trace.expect('Contents to second section', [sections.second.slug]);
    await saveNote(page, passages.second, bookNotes[1]);
    await noteLine(page, bookNotes[0]).waitFor();
    await hideNotebook(page);

    const far = await chooseSection(page, sections.far);
    assert.ok(far.number - second.number >= (live ? 150 : 3));
    farPage = far.number;
    await trace.expect('Jump ahead with contents', [sections.far.slug]);
    const chapterTwo = await chooseSection(page, sections.otherChapter);
    await trace.expect('Open another publisher chapter', [sections.otherChapter.slug]);
    await saveNote(page, passages.otherChapter, bookNotes[2]);
    assert.match(await chapterTitle(page).innerText(), /Corporate Structure and Governance/);
    assert.equal(await noteLine(page, bookNotes[0]).count(), 0);
    assert.equal(chapterTwo.doc, bookId);
    saved = await verifyVault(vault, passages);
    const chapterUri = await page.getByRole('link', { name: 'Open in Obsidian', exact: true }).getAttribute('href');
    assert.ok(chapterUri);
    assert.equal(new URL(chapterUri).searchParams.get('path'), saved.second.file);
    await hideNotebook(page);

    if (live) {
      const captured = await captureExtension(context, host, bookRoot + sections.third.slug);
      const location = await activeSection(captured, sections.third);
      assert.equal(location.doc, bookId, 'Extension and URL entry must share the book identity.');
      await trace.expect('Read real publisher section from extension', [sections.third.slug]);
      await captured.close();
      await pasteAddress(page, bookRoot + sections.third.slug);
      assert.deepEqual(await activeSection(page, sections.third), location);
      await trace.expect('Paste same publisher section URL', []);
    }

    await chooseSection(page, sections.second);
    await openNotebook(page, bookNotes[0]);
    await noteLine(page, bookNotes[1]).waitFor();
    assert.equal(await page.locator('#rail .cm-content').getByText('# ' + chapters[0], { exact: true }).count(), 0);
    const chapterOneUri = await page.getByRole('link', { name: 'Open in Obsidian', exact: true }).getAttribute('href');
    assert.ok(chapterOneUri);
    assert.equal(new URL(chapterOneUri).searchParams.get('path'), saved.first.file);
    await screenshot(host, page, 'book-chapter-desktop');
    await hideNotebook(page);
    const spot = paragraph(page, passages.resume);
    const anchor = await spot.locator('..').getAttribute('data-anchor');
    assert.ok(anchor);
    bookAnchor = anchor;
    await spot.evaluate(element => {
      const scroll = document.querySelector('#paperScroll')!;
      const row = element.closest('.web-reading-row')!;
      scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 36;
    });
    beforeTop = await relativeTop(spot);
    assert.equal(await readingAnchor(page), bookAnchor, 'The saved paragraph must occupy the reading line.');
    localBeforeClose = await page.evaluate(id => localStorage.getItem('reader.book-position.' + id), bookId);
    await trace.expect('Return to cached section and read a paragraph', []);
  } finally { await context.close(); }

  const fresh = await launch(host, 'book-chrome-fresh');
  try {
    const page = fresh.pages()[0];
    await openApp(page, host);
    assert.equal(await page.evaluate(id => localStorage.getItem('reader.book-position.' + id), bookId), null);
    const hostAfterClose = await savedProgress(page, host, bookId);
    await openLibrary(page);
    const library = page.getByRole('dialog', { name: 'Library', exact: true });
    await library.getByRole('tab', { name: 'On this device', exact: true }).click();
    const row = library.getByRole('button', { name: /^Principles of Finance(?: |$)/ });
    await row.first().waitFor();
    assert.equal(await row.count(), 1);
    await row.click();
    await library.waitFor({ state: 'hidden' });
    assert.equal((await activeSection(page, sections.second)).doc, bookId);
    const spot = paragraph(page, passages.resume);
    assert.equal(await spot.locator('..').getAttribute('data-anchor'), bookAnchor);
    try {
      await until(async () => await readingAnchor(page) === bookAnchor && Math.abs(await relativeTop(spot) - beforeTop) <= 40,
        'A fresh Chrome profile must reopen at the same paragraph without browser-local state.');
    } catch (error) {
      console.error({ bookAnchor, beforeTop, actualAnchor: await readingAnchor(page), actualTop: await relativeTop(spot), localBeforeClose, hostAfterClose });
      throw error;
    }
    const restoredTop = await relativeTop(spot);
    await trace.expect('Reopen in fresh Chrome from device library', []);
    await screenshot(host, page, 'book-resume-desktop');
    await page.setViewportSize(mobile);
    await fit(page, original(page));
    await fit(page, contentsToggle(page));
    await fit(page, page.getByRole('button', { name: 'Next section', exact: true }));
    await spot.scrollIntoViewIfNeeded();
    await screenshot(host, page, 'book-390');
    await showContents(page);
    await fit(page, contentsPanel(page));
    await chooseSection(page, sections.first);
    await contentsPanel(page).waitFor({ state: 'hidden' });
    await trace.expect('Choose a cached book section from the narrow sidebar', []);
    await page.setViewportSize(viewport);
    await contentsPanel(page).waitFor({state:'visible'});

    await pasteAddress(page, bookRoot + sections.first.slug);
    assert.equal((await activeSection(page, sections.first)).doc, bookId);
    await trace.expect('Explicit section URL overrides saved reading position', []);
    await openNotebook(page, bookNotes[1]);
    const linkedNote = await noteLine(page, bookNotes[1]).getAttribute('data-note-id');
    assert.ok(linkedNote);
    const chip = page.locator('#rail .notebook-source[data-note-id=' + JSON.stringify(linkedNote) + '] .source-chip');
    assert.equal((await chip.innerText()).split(sections.second.title).length, 2);
    await chip.click();
    await activeSection(page, sections.second);
    await original(page).locator('.is-located').filter({ hasText: passages.second }).waitFor();
    await trace.expect('Click cross-section notebook source chip', []);

    let activated = saved.links[0].publisher.href;
    let nativeVerified = false;
    await withNativeNotebook(host.scratch, vault, saved.second.file, async native => {
      if (!native) return;
      const tree = native.locator('.nav-files-container');
      for (const folder of ['Paper Reader', 'principles-finance']) {
        const row = tree.locator('.nav-folder-title').filter({ has: native.getByText(folder, { exact: true }) }).first();
        const collapsed = await row.locator('..').evaluate(element => element.classList.contains('is-collapsed'));
        if (collapsed) await row.click();
      }
      await tree.locator('.nav-file-title').getByText(path.basename(saved.first.file, '.md'), { exact: true }).click();
      await native.bringToFront();
      const readingPane = native.locator('.workspace-split.mod-root');
      await readingPane.getByText(bookNotes[0], { exact: true }).first().waitFor();
      const preview = readingPane.locator('.markdown-preview-view');
      if (!await preview.isVisible()) await readingPane.locator('.view-actions').getByLabel(/switch to reading view|切换至阅读视图/i).click();
      const link = preview.locator('a[href=' + JSON.stringify(activated) + ']').first();
      await link.waitFor();
      // Observe native link activation without opening the machine's default browser or profile.
      await link.evaluate(element => element.addEventListener('click', event => {
        event.preventDefault(); event.stopImmediatePropagation(); document.documentElement.dataset.activatedPublisherLink = (element as HTMLAnchorElement).href;
      }, { capture: true, once: true }));
      await link.click();
      activated = await native.locator('html').getAttribute('data-activated-publisher-link') ?? '';
      assert.equal(activated, saved.links[0].publisher.href);
      await screenshot(host, native, 'obsidian-chapter');
      await link.locator('xpath=ancestor::p[1]').getByRole('link', { name: 'Library copy', exact: true }).click();
      const active = native.locator('.workspace-leaf.mod-active');
      await active.locator('.view-header-title').getByText(path.basename(saved.links[0].file, '.md'), { exact: true }).waitFor();
      await active.getByText(passages.first, { exact: false }).filter({ visible: true }).first().waitFor();
      nativeVerified = true;
    });
    const reopened = await fresh.newPage();
    if (fixtureOrigin) await reopened.route(bookRoot + '**', async route => {
      const response = await fresh.request.get(fixtureOrigin + new URL(route.request().url()).pathname,
        { headers: { 'x-reader-e2e-original-url': route.request().url() } });
      await route.fulfill({ response });
    });
    await reopened.goto(activated, { waitUntil: 'domcontentloaded' });
    const fragment = decodeURIComponent(saved.links[0].publisher.hash.slice(1));
    if (fragment.startsWith(':~:text=')) {
      assert.ok(fragment.includes(passages.first));
      await reopened.getByText(passages.first, {exact: false}).first().waitFor();
    } else {
      assert.ok((await reopened.locator('[id=' + JSON.stringify(fragment) + ']').innerText()).includes(passages.first));
    }
    await trace.expect('Follow vault citation directly to the original publisher paragraph', []);
    if (evidence) await writeFile(path.join(evidenceDir(host), runName + '-vault-and-resume.json'), JSON.stringify({
      tocSections, farPage, chapters: [saved.first.relative, saved.second.relative], nativeVerified,
      resumeAnchor: bookAnchor, resumeParagraph: passages.resume, originalPosition: beforeTop, restoredPosition: restoredTop,
      backlinks: saved.links.map(link => ({ original: link.publisher.href, copy: link.copy }))
    }, null, 2) + '\n');
    console.log('PASS ' + runName + ' book: stable identity, per-section loading, fresh-profile paragraph resume, chapter files, and source backlinks.' +
      (nativeVerified ? ' Obsidian opened the vault copy and exposed the matching publisher passage link.' : ''));
  } finally { await fresh.close(); }
}

async function headingInContents(page: Page, title: string) {
  const contents = await showContents(page);
  await contents.getByRole('button', { name: title, exact: true }).click();
  const target = original(page).getByRole('heading', { name: title, exact: true });
  await until(() => target.evaluate(element => {
    const box = element.getBoundingClientRect(), bounds = document.querySelector('#paperScroll')!.getBoundingClientRect();
    return box.bottom > bounds.top && box.top < bounds.bottom;
  }), 'The outline must scroll to ' + title + '.');
  if (await contents.isVisible()) await currentContentsEntry(page, title);
}

async function figure(page: Page, captionText: string) {
  const caption = original(page).locator('figcaption').filter({ hasText: captionText }).first();
  await caption.waitFor();
  const id = await caption.getAttribute('id');
  assert.ok(id, 'The image caption must be addressable by assistive technology.');
  const photo = original(page).locator('img[aria-describedby=' + JSON.stringify(id) + ']').first();
  await photo.scrollIntoViewIfNeeded();
  await until(() => photo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 1 && !!image.alt),
    'The real article figure must load with its own alt text and caption.');
  await photo.evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  if (live) assert.ok(await photo.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 20;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3]) colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
    }
    return colors.size > 3;
  }), 'Decoded publisher image must contain diagram pixels.');
  return photo;
}

async function checkGoogleStory(page: Page, blog: typeof fixtureBlog) {
  const story = original(page);
  await story.getByRole('heading', { name: blog.title, exact: true }).waitFor({ timeout: 45_000 });
  assert.equal(await story.getByRole('link', { name: 'Original webpage', exact: true }).getAttribute('href'), googleUrl);
  if (live) {
    await story.getByText(/^When LLMs get facts wrong/).waitFor();
    assert.equal(await story.locator('figure').count(), 8, 'The complete story should have eight distinct diagrams.');
    assert.equal(await story.locator('figcaption').count(), 9, 'The original nine caption paragraphs should be preserved.');
  }
  for (const chrome of ['Explore our many areas of focus', 'Other posts of interest', 'Privacy and Terms']) {
    assert.equal(await story.getByText(chrome, { exact: true }).count(), 0, 'Publisher chrome must stay out of the story: ' + chrome);
  }
  await headingInContents(page, 'Introducing WikiProfile');
  await figure(page, blog.wikiCaption);
  await headingInContents(page, 'Why does recall fail?');
  return figure(page, blog.whyCaption);
}

async function blogJourney(host: HostFixture) {
  const blog = live ? liveBlog : fixtureBlog;
  const context = await launch(host, 'blog-chrome');
  try {
    const page = context.pages()[0];
    await openApp(page, host);
    await pasteAddress(page, googleUrl);
    await checkGoogleStory(page, blog);
    const earlierHeading = original(page).getByRole('heading', { name: 'Introducing WikiProfile', exact: true });
    await earlierHeading.evaluate(element => {
      const scroll = document.querySelector('#paperScroll')!;
      scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
    });
    await currentContentsEntry(page, 'Introducing WikiProfile');
    await saveNote(page, blog.noteQuote, blogNote);
    await page.locator('#rail .source-chip').first().click();
    await original(page).locator('.is-located').filter({ hasText: blog.noteQuote }).waitFor();
    await screenshot(host, page, 'google-note-desktop');

    const reading = live ? await captureExtension(context, host, googleUrl) : page;
    await reading.setViewportSize(mobile);
    await hideNotebook(reading);
    const graphic = await checkGoogleStory(reading, blog);
    await fit(reading, original(reading));
    await fit(reading, graphic);
    await screenshot(host, reading, 'google-390');
    console.log('PASS ' + runName + ' Google article: title, sections, loaded figures with captions, cleaned body, linked note and 390 px viewport.');
  } finally { await context.close(); }
}

const filename = path.join(os.tmpdir(), 'paper-reader-publisher-' + randomUUID() + '.ndjson');
await writeFile(filename, '', { flag: 'wx' });
try {
  const fixture = live ? undefined : await startPublisherFixture();
  try {
    await withHost(async host => {
      const vault = path.join(host.scratch, 'Acceptance vault');
      await mkdir(path.join(vault, '.obsidian'), { recursive: true });
      if (evidence) await mkdir(evidenceDir(host), { recursive: true });
      const trace = traceBook(filename);
      try {
        if (!process.argv.includes('--blog-only')) await bookJourney(host, vault, trace, fixture?.origin);
        if (!process.argv.includes('--book-only')) await blogJourney(host);
      } finally {
        if (evidence) await writeFile(path.join(evidenceDir(host), runName + '-publisher-requests.json'), JSON.stringify({
          actions: trace.steps, requests: readRequests(await readFile(filename, 'utf8'))
        }, null, 2) + '\n');
      }
    }, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' '),
      PAPER_READER_E2E_PUBLISHER_FIXTURE: fixture?.origin,
      PAPER_READER_E2E_PUBLISHER_LOG: filename
    });
  } finally { await fixture?.close(); }
} finally { await rm(filename, { force: true }); }
