import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import type { NotebookSnapshot } from '../../src/shared/types.js';
import { withHost } from './host.js';

// Pass the original ResNet PDF and optionally a cached page-two translation.
const [paper, cachedPage] = process.argv.slice(2);
if (!paper) throw Error('Pass Deep Residual Learning for Image Recognition.pdf.');
const bytes = await readFile(paper);
const docId = 'pdf-' + createHash('sha256').update(bytes).digest('hex');
const original = (id: string) => '#original .pdf-native-text [data-block-id="' + id + '"]';
const translated = (id: string) => '#translated .pdf-translated-text[data-block-id="' + id + '"]';

async function afterLayout(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function dragText(page: Page, start: Locator, end: Locator, endOffset: number): Promise<void> {
  const point = (node: Element, offset: number) => {
    const text = node.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, Math.max(0, offset - 1));
    range.setEnd(text, Math.max(1, offset));
    const rect = range.getClientRects()[0];
    return { x: offset ? rect.right - .1 : rect.left + .1, y: rect.top + rect.height / 2 };
  };
  const first = await start.evaluate(point, 0), last = await end.evaluate(point, endOffset);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(last.x, last.y, { steps: 15 });
  await page.mouse.up();
  await afterLayout(page);
}

async function covered(page: Page, selector: string | Locator, pane: string, offset = 0): Promise<boolean> {
  const target = typeof selector === 'string' ? page.locator(selector) : selector;
  return target.first().evaluate((node, options) => {
    const text = node.firstChild as Text;
    const glyph = document.createRange();
    glyph.setStart(text, options.offset);
    glyph.setEnd(text, options.offset + 1);
    const r = glyph.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return [...document.querySelectorAll(options.pane + ' .pdf-quote-mark')].some(mark => {
      const box = mark.getBoundingClientRect();
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    });
  }, { pane, offset });
}

async function checkChatDock(card: Locator, compact: boolean): Promise<void> {
  assert.equal(await card.getAttribute('data-workspace'), 'chat');
  const layout = await card.evaluate(node => {
    const dock = node.closest('#selectionDock')!.getBoundingClientRect();
    const paper = document.querySelector('#paperScroll')!.getBoundingClientRect();
    const workspace = document.querySelector('.workspace')!.getBoundingClientRect();
    const chat = node.querySelector('.selection-chat')!;
    const conversation = chat.getBoundingClientRect();
    const inPaper = document.elementFromPoint(paper.left + 18, paper.top + paper.height / 2)?.closest('#paperScroll');
    return {
      fullWidth: Math.abs(dock.width - workspace.width) < 2,
      belowPaper: Math.abs(dock.top - paper.bottom) < 2 && dock.bottom <= workspace.bottom,
      paperReachable: Boolean(inPaper),
      contained: getComputedStyle(chat).overflowY === 'auto' && conversation.bottom <= dock.bottom + 1,
      besidePaper: dock.left >= paper.right - 1 || dock.right <= paper.left + 1
    };
  });
  assert.ok(layout.paperReachable && layout.contained &&
    (compact ? layout.fullWidth && layout.belowPaper : layout.besidePaper),
    'The standalone discussion must leave the paper reachable, beside it on desktop and below it on a phone: ' + JSON.stringify(layout));
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1680, height: 940 }, deviceScaleFactor: 1, hasTouch: true });
    const reader = await ctx.newPage();
    const errors: string[] = [];
    reader.on('pageerror', error => errors.push(error.message));
    await reader.goto(host.authenticatedUrl);
    const response = await ctx.request.post(host.origin + '/api/paper-reader/import-pdf?title=' + encodeURIComponent(path.basename(paper)), {
      headers: { 'Content-Type': 'application/pdf' }, data: bytes
    });
    assert.equal(response.status(), 200);
    // Exercise the legacy paragraph-only cache deterministically, including when no model is installed.
    const cache = path.join(host.scratch, 'reader', 'translations', docId);
    await mkdir(cache, { recursive: true });
    const translationFile = cachedPage || new URL('../fixtures/resnet-selection-page-2.zh-CN.json', import.meta.url);
    await copyFile(translationFile, path.join(cache, '2.json'));
    await reader.goto(host.origin + '/api/paper-reader/app/index.html?doc=' + docId + '&page=2');
    await reader.locator('#loading').waitFor({ state: 'hidden' });
    await reader.getByRole('button', { name: 'Original', exact: true, pressed: true }).waitFor();
    const section = reader.locator(original('p2-b3'));
    const boundary = section.filter({ hasText: 'Formally, denoting' });
    const thirdSentence = await boundary.evaluate(run => run.textContent!.indexOf('Formally'));
    const card = reader.locator('#card');
    const pickPassage = () => dragText(reader, section.first(), boundary, thirdSentence - 1);
    await pickPassage();
    await card.getByRole('heading', { name: 'Passage translation' }).waitFor();
    await card.locator('.passage-counterpart .meaning').filter({ hasText: /\p{Script=Han}/u }).waitFor();
    const sheet = (await reader.locator('#original').boundingBox())!;
    const anchored = (await card.boundingBox())!;
    assert.ok(anchored.x + anchored.width <= sheet.x + 1 || anchored.x >= sheet.x + sheet.width - 1,
      'With room beside the original, the passage card must sit outside the PDF.');
    const scrolled = await reader.locator('#paperScroll').evaluate(node => {
      const before = node.scrollTop;
      node.scrollTop += 40;
      return node.scrollTop - before;
    });
    await afterLayout(reader);
    assert.ok(scrolled > 0 && Math.abs((await card.boundingBox())!.y - anchored.y + scrolled) < 2,
      'The passage card must follow the source as the paper scrolls.');
    await card.getByRole('button', { name: 'Open bilingual view', exact: true }).click();
    await reader.getByRole('button', { name: 'Bilingual', exact: true, pressed: true }).waitFor();
    await reader.locator(translated('p2-b3')).waitFor({ timeout: 300_000 });
    await card.getByRole('button', { name: 'Close selection', exact: true }).click();
    await reader.locator('#paperScroll').evaluate(node => { node.scrollTop = 0; });
    await afterLayout(reader);
    await pickPassage();
    await card.getByRole('heading', { name: 'Selected passage' }).waitFor();
    assert.ok(await card.locator('.selection-excerpt').evaluate(el => el.getBoundingClientRect().height <= 26));
    assert.ok(await card.getByRole('button', { name: 'Explain', exact: true }).isVisible());
    assert.ok(await card.getByRole('button', { name: 'Ask AI', exact: true }).isVisible());
    assert.ok(await covered(reader, original('p2-b3'), '#original'), 'Selected English glyphs must remain highlighted.');
    assert.ok(await covered(reader, translated('p2-b3'), '#translated'), 'The paired Chinese text lines must be highlighted.');
    const thirdChinese = await reader.locator(translated('p2-b3')).evaluate(p => {
      const sentences = Array.from(new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(p.textContent!));
      if (sentences.length !== 6) throw Error('This regression uses the verified six-sentence ResNet page-two translation.');
      return sentences[2].index;
    });
    assert.equal(await covered(reader, boundary, '#original', thirdSentence), false, 'The third English sentence is outside the selection.');
    assert.equal(await covered(reader, translated('p2-b3'), '#translated', thirdChinese), false,
      'The third aligned Chinese sentence must stay outside a selection of the first two English sentences.');
    assert.equal(await covered(reader, translated('p2-b4'), '#translated'), false);

    const excerpt = card.locator('.selection-excerpt');
    const collapsed = (await excerpt.boundingBox())!.height;
    const line = await excerpt.locator('blockquote').evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
    assert.ok(collapsed <= Math.max(line, 24) + 2, 'The complete collapsed quotation control must fit on one line.');
    await card.getByRole('button', { name: 'Show full passage' }).click();
    assert.ok((await excerpt.boundingBox())!.height >= collapsed * 2);
    await card.getByRole('button', { name: 'Show less' }).click();

    const directory = path.join(host.artifacts, 'reviews', 'floating-workspace');
    await mkdir(directory, { recursive: true });
    await reader.screenshot({ path: path.join(directory, 'resnet-page-2-paired-selection.png'), animations: 'disabled' });

    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const composer = card.getByLabel('Message about this selection');
    const draft = 'What does the residual formulation change?';
    await composer.fill(draft);
    await composer.evaluate(element => { element.style.height = '245px'; });
    await afterLayout(reader);
    await checkChatDock(card, false);
    await card.getByRole('button', { name: 'Write note', exact: true }).click();
    await card.getByLabel('Your note', { exact: true }).waitFor();
    assert.equal(await card.getAttribute('data-workspace'), 'note');
    assert.ok(await composer.isHidden(), 'The note and question share the same workspace.');
    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    assert.equal(await composer.inputValue(), draft, 'Switching to the note must preserve the question draft.');
    await reader.evaluate(() => window.getSelection()?.removeAllRanges());
    assert.ok(await covered(reader, original('p2-b3'), '#original') && await covered(reader, translated('p2-b3'), '#translated'),
      'Both text highlights must outlast native focus and selection while composing in Ask AI.');
    await card.getByRole('button', { name: 'Close chat', exact: true }).click();
    await card.getByRole('button', { name: 'Close selection', exact: true }).click();
    assert.equal(await reader.locator('.pdf-quote-mark').count(), 0);

    // Use the real DOM selection, including a partial ending paragraph, in the opposite direction.
    await reader.locator(translated('p2-b3')).evaluate((first, lastSelector) => {
      const selection = window.getSelection()!;
      const last = document.querySelector(lastSelector)!;
      selection.setBaseAndExtent(first.firstChild!, 5, last.firstChild!, 8);
      last.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    }, translated('p2-b4'));
    await card.waitFor();
    for (const id of ['p2-b3', 'p2-b4']) assert.ok(await covered(reader, original(id), '#original'), 'The original counterpart must include ' + id);
    assert.equal(await covered(reader, translated('p2-b3'), '#translated', 0), false);
    assert.ok(await covered(reader, translated('p2-b3'), '#translated', 6));
    assert.ok(await covered(reader, translated('p2-b4'), '#translated', 7));
    assert.equal(await covered(reader, translated('p2-b4'), '#translated', 9), false);
    await card.getByRole('button', { name: 'Locate', exact: true }).click();
    await reader.reload();
    await reader.locator(translated('p2-b3')).waitFor();
    await afterLayout(reader);
    assert.ok(await covered(reader, translated('p2-b3'), '#translated', 6));
    assert.ok(await covered(reader, translated('p2-b4'), '#translated', 7), 'Reload must restore the selected final block of a multi-paragraph Chinese backlink.');
    assert.equal(await covered(reader, translated('p2-b4'), '#translated', 9), false);
    const repeatedWord = section.filter({ hasText: 'ers fit a residual mapping.' });
    const chooseMapping = (locator: Locator) => locator.evaluate(run => {
      const text = run.firstChild as Text;
      const at = text.data.indexOf('mapping');
      window.getSelection()!.setBaseAndExtent(text, at, text, at + 7);
      run.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      return at;
    });
    const occurrence = await chooseMapping(repeatedWord);
    await card.getByRole('heading', { name: 'mapping', exact: true }).waitFor();
    const body = 'This occurrence describes a residual mapping.';
    await card.getByRole('button', { name: 'Write note' }).click();
    await card.getByLabel('Your note').fill(body);
    await card.getByRole('button', { name: 'Save note', exact: true }).click();
    await card.getByText(body, { exact: true }).waitFor();
    const bookResponse = await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'notebook.get',
      payload: { docId, title: path.basename(paper), sourceUrl: reader.url() } } });
    assert.equal(bookResponse.status(), 200);
    const book = await bookResponse.json() as NotebookSnapshot;
    const note = book.notes.find(saved => saved.text === body);
    assert.ok(note && book.markdown.includes(note.sourceUrl), 'The Markdown source must retain the saved occurrence.');
    await card.getByRole('button', { name: 'Locate', exact: true }).click();
    await reader.goto(note.sourceUrl);
    await reader.reload();
    await repeatedWord.waitFor();
    assert.ok(await covered(reader, repeatedWord, '#original', occurrence), 'A repeated English word must restore at the selected occurrence after reload.');
    const earlierWord = section.filter({ hasText: 'desired underlying mapping, we explicitly' });
    await chooseMapping(earlierWord);
    await card.getByRole('button', { name: 'Write note' }).waitFor();
    assert.equal(await card.getByText(body, { exact: true }).count(), 0);
    await chooseMapping(repeatedWord);
    await card.getByRole('button', { name: 'Notes (1)', exact: true }).click();
    await card.getByText(body, { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Close passage workspace', exact: true }).click();
    await reader.locator('#paperScroll').focus();
    await reader.keyboard.press('Shift+ArrowRight');
    await afterLayout(reader);
    assert.equal(await reader.locator('#pageCount').innerText(), '2 / 12', 'Extending text from the keyboard must stay on the current page.');
    await reader.locator(translated('p2-b5')).evaluate(node => {
      window.getSelection()!.setBaseAndExtent(node.firstChild!, 3, node.firstChild!, 8);
      node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    });
    await afterLayout(reader);
    assert.equal(await covered(reader, original('p2-b3'), '#original'), false);
    assert.ok(await covered(reader, original('p2-b5'), '#original'));

    await reader.setViewportSize({ width: 390, height: 650 });
    await afterLayout(reader);
    const mobile = (await card.boundingBox())!;
    const paperBounds = (await reader.locator('#paperScroll').boundingBox())!;
    assert.ok(Math.abs(mobile.x) < 1 && Math.abs(mobile.width - 390) < 1 &&
      mobile.y >= paperBounds.y + paperBounds.height - 1 && mobile.y + mobile.height <= 650,
      'The compact preview must fit below the paper without overlapping it after a viewport resize.');
    await card.getByRole('button', { name: 'Ask AI', exact: true }).tap();
    await composer.waitFor();
    await checkChatDock(card, true);
    await reader.keyboard.press('Escape');
    await card.getByRole('button', { name: 'Close selection', exact: true }).waitFor();
    await reader.keyboard.press('Escape');
    assert.equal(await reader.locator('.pdf-quote-mark').count(), 0);
    assert.ok(await card.isHidden());

    await reader.getByRole('button', { name: 'Original', exact: true }).click();
    await reader.goto(host.origin + '/api/paper-reader/app/index.html?doc=' + docId + '&page=7');
    await reader.getByRole('button', { name: 'Read text' }).click();
    await reader.locator('.reading-passage[data-passage-id="p7-b7"] p').evaluate(first => {
      const last = document.querySelector('.reading-passage[data-passage-id="p7-b10"] p')!;
      document.getSelection()!.setBaseAndExtent(first.firstChild!, 0, last.firstChild!, 32);
      last.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    });
    await card.getByRole('button', { name: 'Locate', exact: true }).click();
    assert.equal(new URL(reader.url()).searchParams.get('rangeOrder'), 'reflow');
    await reader.locator('#original .pdf-quote-mark').first().waitFor();
    assert.ok(await covered(reader, original('p7-b7'), '#original'));
    assert.ok(await covered(reader, original('p7-b10'), '#original'));
    assert.equal(await covered(reader, original('p7-b8'), '#original'), false);
    assert.equal(await covered(reader, original('p7-b9'), '#original'), false);
    assert.deepEqual(errors, []);
    console.log('Passed anchored translation, paired native selections, partial multi-block ranges, shared workspace and compact viewport containment on imported ResNet page 2.');
  } finally { await browser.close(); }
});
