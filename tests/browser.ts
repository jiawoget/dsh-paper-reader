import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type FrameLocator, type Locator, type Page } from 'playwright-core';
import { openReader, withHost } from './e2e/host.js';
import { cardMoreAction } from './e2e/helpers/reader.js';
import { markdownLinks, vaultSource, visibleMarkdown } from './e2e/vault-links.js';

async function screen(pane: FrameLocator, page: number): Promise<void> {
  await pane.locator(`#original [aria-label="Original, page ${page}"]`).waitFor();
  await pane.locator('#loading').waitFor({ state: 'hidden' });
}

async function dragWord(page: Page, run: Locator, text: string): Promise<void> {
  const bounds = await run.boundingBox();
  assert.ok(bounds, 'The text run must be visible.');
  const relative = await run.evaluate((el, term) => {
    const node = el.firstChild;
    if (!(node instanceof Text)) throw new Error('The text layer is missing the selected run.');
    const start = node.data.indexOf(term);
    if (start < 0) throw new Error('The requested words are missing from the page.');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + term.length);
    const box = range.getBoundingClientRect(), parent = el.getBoundingClientRect();
    return { x: box.left - parent.left, y: box.top - parent.top + box.height / 2, w: box.width };
  }, text);
  const x = bounds.x + relative.x, y = bounds.y + relative.y;
  await page.mouse.move(x + 0.12, y);
  await page.mouse.down();
  await page.mouse.move(x + relative.w - 0.12, y, { steps: 13 });
  await page.mouse.up();
}

async function upload(page: Page, pane: FrameLocator, file: string): Promise<void> {
  await pane.getByRole('button', { name: 'Open library' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), pane.getByRole('button', { name: 'Open file' }).click()]);
  await chooser.setFiles(file);
  await pane.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function closePassage(card: Locator): Promise<void> {
  const dock = card.getByRole('button', { name: 'Close passage workspace', exact: true });
  if (await dock.isVisible()) await dock.click();
  await card.getByRole('button', { name: 'Close selection', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
}

await withHost(async ({ origin, authenticatedUrl, scratch, executable }) => {
  const unauthorized = await fetch(origin + '/api/paper-reader/action', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'state' }) });
  assert.ok([401, 403].includes(unauthorized.status));
  const browser = await chromium.launch({ executablePath: executable, headless: process.env.PAPER_READER_HEADED !== '1' });
  try {
    const browserContext = await browser.newContext({ viewport: { width: 1580, height: 740 }, deviceScaleFactor: 1.5, locale: 'en-US' });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(12_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const pane = await openReader(page, authenticatedUrl);
    await screen(pane, 6);
    assert.equal(await pane.locator('#pageCount').innerText(), '6 / 16');
    const card = pane.locator('#card');
    await card.waitFor({ state: 'hidden' });
    const originalMode = pane.getByRole('button', { name: 'Original', exact: true });
    const bilingual = pane.getByRole('button', { name: 'Bilingual', exact: true });
    assert.equal(await originalMode.getAttribute('aria-pressed'), 'true');
    assert.equal(await pane.locator('#translated').isVisible(), false);
    await pane.getByRole('button', { name: 'Show notes', exact: true }).click();
    await pane.getByRole('textbox', { name: 'Notes Markdown' }).waitFor();
    await bilingual.click();
    await pane.getByRole('combobox', { name: 'Translation scope' }).selectOption('page');
    await pane.locator('#translated .pdf-translated-text').first().waitFor();
    const original = await pane.locator('#original').boundingBox();
    const companion = await pane.locator('#translated').boundingBox();
    assert.ok(original && companion && original.width > 250 && original.width === companion.width);
    const term = pane.locator('#original .pdf-native-text').getByText('block tables', { exact: true });
    await dragWord(page, term, 'block tables');
    await card.waitFor();
    assert.equal(await card.getByRole('heading').innerText(), 'block tables');
    assert.deepEqual(await pane.locator('#original').boundingBox(), original);
    assert.deepEqual(await pane.locator('#translated').boundingBox(), companion);
    await cardMoreAction(card, 'Save word');
    await pane.getByText('Saved to vocabulary.', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Write note' }).click();
    await card.getByLabel('Your note', { exact: true }).fill('Trace how the block table maps the physical cache.');
    await card.getByRole('button', { name: 'Save note' }).click();
    await card.getByText('Note saved.', { exact: true }).waitFor();
    await closePassage(card);
    const saved = pane.locator('.cm-line[data-note-id]').filter({ hasText: 'Trace how the block table maps the physical cache.' });
    await saved.waitFor();

    const translated = pane.locator('#translated .pdf-translated-text[data-block-id="block-tables"]');
    const dictionary: Record<string, string> = JSON.parse(await readFile(new URL('../public/assets/pagedattention-page-6.zh-CN.json', import.meta.url), 'utf8'));
    const chineseTerm = dictionary['block-tables'].match(/\u5757\u8868/u)?.[0];
    assert.ok(chineseTerm);
    await dragWord(page, translated, chineseTerm);
    await card.waitFor();
    assert.equal(await card.getByRole('heading').innerText(), chineseTerm);
    const definition = 'The KV block manager also maintains block tables—the mapping between logical and physical KV blocks of each request.';
    const sourceContext = card.locator('details').filter({ hasText: 'Original sentence context' });
    assert.equal(await sourceContext.getAttribute('open'), null);
    await sourceContext.locator('summary').click();
    assert.equal(await sourceContext.locator('p').innerText(), definition);
    await sourceContext.locator('summary').click();
    await card.getByRole('button', { name: 'Write note' }).click();
    await card.getByLabel('Your note', { exact: true }).fill('Look up this Chinese term again.');
    await card.getByRole('button', { name: 'Save note' }).click();
    await card.getByText('Note saved.', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Close passage workspace', exact: true }).click();
    const translatedNote = pane.locator('.cm-line[data-note-id]').filter({ hasText: 'Look up this Chinese term again.' });
    const translatedId = await translatedNote.getAttribute('data-note-id');
    const translatedSource = pane.locator('.notebook-source[data-note-id=' + JSON.stringify(translatedId) + ']');
    await translatedSource.getByRole('button', {name: 'Show quoted passage'}).click();
    assert.equal(await translatedSource.locator('.quote').innerText(), definition);
    assert.equal(await translatedSource.locator('.notebook-selection').innerText(), chineseTerm);
    await cardMoreAction(card, 'Locate');
    assert.ok(await pane.locator('#original .pdf-quote-mark').count() >= 2);
    const secondTerm = dictionary['block-tables'].match(/\u903b\u8f91/u)?.[0];
    assert.ok(secondTerm);
    await dragWord(page, translated, secondTerm);
    await card.getByRole('heading', { name: secondTerm, exact: true }).waitFor();
    assert.equal(await sourceContext.getAttribute('open'), null);
    assert.ok(await card.getByRole('button', { name: 'Write note' }).isVisible(), 'Different translated terms in one original sentence need distinct notes.');
    await closePassage(card);

    await pane.getByText('Reading guide', {exact:true}).click();
    const thumbnail = pane.getByRole('button', { name: 'Locate Figure 6' });
    assert.ok((await thumbnail.locator('img').getAttribute('src'))?.startsWith('data:image/png;base64,'));
    await thumbnail.click();
    await pane.locator('#original .pdf-figure.is-active[data-block-id="figure-6"]').waitFor();
    await pane.locator('#original .pdf-figure[data-block-id="figure-6"]').click();
    await card.getByRole('heading', { name: /Figure 6\. Block table translation in vLLM/ }).waitFor();
    await closePassage(card);

    await pane.getByRole('combobox', { name: 'Zoom' }).selectOption('1.5');
    await pane.locator('.pages[style*="150%"]').waitFor();
    const enlarged = await pane.locator('#original').boundingBox(), enlargedTarget = await pane.locator('#translated').boundingBox();
    assert.ok(enlarged && enlargedTarget && enlarged.width > original.width * 1.46 && enlarged.x + enlarged.width <= enlargedTarget.x);
    await pane.getByRole('combobox', { name: 'Zoom' }).selectOption('1');
    await pane.locator('.pages[style*="100%"]').waitFor();
    await originalMode.click();
    await pane.locator('.workspace.single').waitFor();
    assert.equal(await pane.locator('#translated').isVisible(), false);
    await bilingual.click();
    await pane.locator('#translated .pdf-translated-text').first().waitFor();
    await pane.getByRole('button', { name: 'Next page' }).click();
    await screen(pane, 7);
    const samplingCaption = pane.locator('#translated [lang="zh-CN"][data-block-id="figure-8"]');
    await samplingCaption.waitFor();
    assert.match(await samplingCaption.innerText(), /\p{Unified_Ideograph}/u);
    await pane.locator('.source-chip[data-note-id=' + JSON.stringify(await saved.getAttribute('data-note-id')) + ']').click();
    await screen(pane, 6);
    const recorded = new URL(await pane.locator('body').evaluate(() => location.href));
    assert.equal(recorded.searchParams.get('anchor'), 'block-tables');
    assert.equal(recorded.searchParams.get('quote'), 'block tables');
    await pane.locator('#original .pdf-quote-mark').first().waitFor();

    const vault = path.join(scratch, 'acceptance-vault');
    await mkdir(vault);
    await pane.getByRole('button', { name: 'Connect Obsidian' }).click();
    await pane.getByLabel('Obsidian vault folder').fill(vault);
    await pane.getByRole('button', { name: 'Save connections' }).click();
    await pane.getByText('Connections saved.', { exact: true }).waitFor();
    await pane.getByText('Saved to vault', {exact: true}).waitFor();
    const directory = path.join(vault, 'Paper Reader');
    const markdown = (await readdir(directory)).find(entry => entry.endsWith('.md'));
    assert.ok(markdown, 'The Obsidian vault export must write a Markdown notebook file.');
    const noteFile = path.join(directory, markdown);
    const exported = await readFile(noteFile, 'utf8');
    const visible = visibleMarkdown(exported);
    const links = markdownLinks(visible);
    const copyLink = links.find(link => link.target.startsWith('Sources/') && link.target.endsWith('#page=6'));
    assert.ok(copyLink && visible.includes('block tables'), 'The actual note export must include a portable vault source link for the page 6 note.');
    const copy = vaultSource(vault, noteFile, copyLink.target);
    assert.equal(copy.fragment, 'page=6', 'The vault source link must cite page 6.');
    assert.ok((await readFile(copy.file)).subarray(0, 5).equals(Buffer.from('%PDF-')));
    const deep = await browserContext.newPage();
    await deep.goto(recorded.href);
    await deep.locator('#original .pdf-quote-mark').first().waitFor();
    await deep.reload();
    const showNotes = deep.getByRole('button', { name: 'Show notes', exact: true });
    if (await showNotes.isVisible()) await showNotes.click();
    await deep.locator('.notebook-source .source-chip').first().waitFor();
    await deep.close();
    await pane.locator('#toast').waitFor({ state: 'hidden' });
    await pane.locator('#railBody').evaluate(el => { el.scrollTop = 0; });
    await dragWord(page, term, 'block tables');
    await card.getByRole('heading', { name: 'block tables', exact: true }).waitFor();
    // At compact bilingual scale (< 1.125 inside the DSH shell with Notes open), M4's readability floor
    // keeps translated prose >= 11.5px visual size with explicit .needs-scroll vertical scrolling.
    const compactFit = await pane.locator('#translated .pdf-translated-text').evaluateAll(elements =>
      elements.filter((el): el is HTMLElement => el instanceof HTMLElement && !el.hidden && el.offsetWidth > 0).map(el => {
        const rect = el.getBoundingClientRect();
        const cssFont = parseFloat(getComputedStyle(el).fontSize) || 0;
        return {
          id: el.dataset.blockId, role: el.dataset.role,
          visualFont: cssFont * (rect.width / el.offsetWidth),
          overflows: el.scrollHeight - el.clientHeight > 2,
          needsScroll: el.classList.contains('needs-scroll')
        };
      }));
    assert.ok(compactFit.some(b => b.role === 'paragraph'), 'Expected translated paragraphs at compact scale.');
    assert.ok(compactFit.filter(b => b.role === 'paragraph').every(b => b.visualFont >= 11.5),
      'Compact bilingual translated paragraphs must keep the >= 11.5px visual readability floor.');
    assert.ok(compactFit.filter(b => b.overflows).every(b => b.needsScroll),
      'Any compact overflowing translated block must enable .needs-scroll.');
    // At full-scale desktop sheet width (sheetScale >= 1.125), every curated translation fits with zero nested scrollbar.
    await pane.getByRole('combobox', { name: 'Zoom' }).selectOption('2');
    await pane.locator('.pages[style*="200%"]').waitFor();
    await pane.locator('#translated .pdf-sheet').evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const clipped = await pane.locator('#translated .pdf-translated-text').evaluateAll(elements =>
      elements.filter(el => el instanceof HTMLElement && (el.offsetWidth - el.clientWidth > 2 || el.scrollHeight - el.clientHeight > 2))
        .map(el => (el as HTMLElement).dataset.blockId));
    assert.deepEqual(clipped, [], 'Every curated translation must fit without a nested scrollbar.');
    await pane.getByRole('combobox', { name: 'Zoom' }).selectOption('1');
    await pane.locator('.pages[style*="100%"]').waitFor();
    await closePassage(card);

    const fixture = await browserContext.newPage();
    await fixture.setContent('<html lang="en"><title>Cache allocation</title><style>@page{size:letter;margin:1in}body{font:15pt Georgia,serif}section+section{break-before:page}</style><section><h1>Cache allocation</h1><p>Logical addresses name blocks independently of their physical locations.</p></section><section><h1>Independent requests</h1><p>Each request owns a sequence and its own cache mapping.</p></section></html>');
    const originalName = path.join(scratch, 'Cache allocation.pdf'), renamed = path.join(scratch, 'Renamed paper.pdf');
    await fixture.pdf({ path: originalName, preferCSSPageSize: true });
    await fixture.close();
    await upload(page, pane, originalName);
    await screen(pane, 1);
    assert.equal(await pane.locator('#pageCount').innerText(), '1 / 2');
    await pane.getByRole('button', { name: 'Next page' }).click();
    await screen(pane, 2);
    const importedRun = pane.locator('#original .pdf-native-text').getByText('Each request owns a sequence and its own cache mapping.', { exact: true });
    await dragWord(page, importedRun, 'cache mapping');
    await card.getByRole('heading', { name: 'cache mapping', exact: true }).waitFor();
    await card.getByRole('button', { name: 'Write note' }).click();
    await card.getByRole('button', { name: 'Save quote' }).click();
    await pane.locator('.cm-line[data-note-id]').filter({ hasText: 'cache mapping' }).waitFor();
    await closePassage(card);
    const before = new URL(await pane.locator('body').evaluate(() => location.href)).searchParams.get('doc');
    assert.match(before ?? '', /^pdf-[0-9a-f]{64}$/);
    await pane.getByRole('button', { name: 'Open library' }).click();
    await pane.getByRole('tab', { name: 'On this device' }).click();
    await pane.getByRole('dialog').getByRole('button', { name: /PagedAttention\.pdf/ }).click();
    await screen(pane, 6);
    await rename(originalName, renamed);
    await upload(page, pane, renamed);
    await screen(pane, 2);
    assert.equal(new URL(await pane.locator('body').evaluate(() => location.href)).searchParams.get('doc'), before);
    await pane.locator('.cm-line[data-note-id]').filter({ hasText: 'cache mapping' }).waitFor();
    await pane.getByRole('button', { name: 'Open library' }).click();
    await pane.getByRole('tab', { name: 'On this device' }).click();
    await pane.getByRole('dialog').getByRole('button', { name: /Cache allocation\.pdf/ }).waitFor();
    assert.equal(await pane.getByRole('dialog').locator('.doc-row').count(), 2);
    assert.deepEqual(errors, []);
    console.log('PASS PDF reader: source-first default, bilingual comparison, page-six diagrams, selection dock, sentence restoration, note backlinks, Obsidian export, zoom, and persistent imports under renamed files.');
  } finally { await browser.close(); }
});
