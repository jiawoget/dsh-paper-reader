import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import type { Operations } from '../../src/shared/types.js';
import { openReader, withHost, type HostFixture } from './host.js';
import { cardMoreAction, openCardMore } from './helpers/reader.js';
import { modelFixture } from './integration-fixtures.js';

const pdfId = 'pagedattention';
const sourceQuote = 'the mapping between logical';
const translatedQuote = '逻辑 KV 块';
const figureQuote = 'Block table translation';
const markComment = 'A block table is the indirection layer for the KV cache.';
const matchedNote = 'Read the distinction between logical and physical slots.';
const readDraft = 'The reflowed passage has the same source as the PDF.';
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

function readerUrl(host: HostFixture, doc = pdfId, page = 6): string {
  return host.origin + '/api/paper-reader/app/index.html?' + new URLSearchParams({ doc, page: String(page) });
}

async function action<K extends keyof Operations>(page: Page, host: HostFixture, op: K, payload: Operations[K][0]): Promise<Operations[K][1]> {
  const reply = await page.request.post(host.origin + '/api/paper-reader/action', { data: { op, payload } });
  assert.ok(reply.ok(), op + ' returned HTTP ' + reply.status());
  return reply.json();
}

function snapshot(page: Page, host: HostFixture, doc = pdfId, title = 'PagedAttention.pdf', number = 6) {
  return action(page, host, 'notebook.get', { docId: doc, title, sourceUrl: readerUrl(host, doc, number) });
}

async function open(page: Page, host: HostFixture, doc = pdfId, number = 6): Promise<void> {
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
  await page.goto(readerUrl(host, doc, number));
  await page.locator('#loading').waitFor({ state: 'hidden' });
}

function sourceRun(page: Page) {
  return page.locator('#original .pdf-native-text [data-block-id="block-tables"]').filter({ hasText: sourceQuote }).first();
}

function translatedRun(page: Page) {
  return page.locator('#translated .pdf-translated-text[data-block-id="block-tables"]');
}

function figureCaption(page: Page) {
  return page.locator('#original .pdf-native-text [data-block-id="figure-6"]').filter({ hasText: figureQuote }).first();
}

async function selectPhrase(page: Page, run: Locator, phrase: string, touch = false): Promise<void> {
  await run.scrollIntoViewIfNeeded();
  const points = await run.evaluate((element, { phrase, touch }) => {
    const node = element.firstChild;
    if (!(node instanceof Text)) throw Error('The selection fixture must be in a text node.');
    const at = node.data.indexOf(phrase);
    if (at < 0) throw Error('The selection fixture is missing: ' + phrase);
    if (touch) {
      // Playwright cannot move Chrome's native selection handles. Supply their
      // resulting DOM range and exercise the reader's touch-selection listener.
      element.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      document.getSelection()!.setBaseAndExtent(node, at, node, at + phrase.length);
      element.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', bubbles: true }));
      return;
    }
    const span = document.createRange();
    span.setStart(node, at);
    span.setEnd(node, at + phrase.length);
    const rects = [...span.getClientRects()].filter(rect => rect.width && rect.height);
    const start = rects[0], end = rects.at(-1)!;
    return { start: { x: start.left + .2, y: start.top + start.height / 2 },
      end: { x: end.right - .2, y: end.top + end.height / 2 } };
  }, { phrase, touch });
  if (points) {
    await page.mouse.move(points.start.x, points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
    await page.mouse.up();
  }
  await page.locator('#card').waitFor();
  assert.equal(await page.evaluate(() => getSelection()?.toString().trim()), phrase);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  assert.ok(result, 'An expected control or pane has no visible bounds.');
  return result;
}

async function pose(page: Page, position: 'left' | 'right' | 'float' | 'sheet'): Promise<void> {
  await page.locator('#reader[data-notebook-pose="' + position + '"]').waitFor();
  const rail = await box(page.locator('#rail'));
  const workspace = await box(page.locator('.workspace'));
  const reader = await box(page.locator('#reader'));
  if (position === 'left') assert.ok(rail.x + rail.width <= workspace.x + 1, 'The notebook must be to the left of the reading pane.');
  if (position === 'right') assert.ok(workspace.x + workspace.width <= rail.x + 1, 'The notebook must be to the right of the reading pane.');
  if (position === 'float' || position === 'sheet') {
    assert.ok(rail.x >= reader.x - 1 && rail.y >= reader.y - 1 &&
      rail.x + rail.width <= reader.x + reader.width + 1 && rail.y + rail.height <= reader.y + reader.height + 1,
    'The notebook must remain within the reader.');
    assert.ok(rail.x < workspace.x + workspace.width && workspace.x < rail.x + rail.width,
      'The notebook must overlay the reading area.');
  }
  if (position === 'sheet') assert.ok(Math.abs(rail.y + rail.height - reader.y - reader.height) <= 2);
}

async function pageJump(page: Page, number: number): Promise<void> {
  await page.locator('#pageCount').click();
  const field = page.getByRole('spinbutton', { name: 'Page number' });
  await field.fill(String(number));
  await field.press('Enter');
  await page.waitForURL(url => url.searchParams.get('page') === String(number));
  await page.locator('#loading').waitFor({ state: 'hidden' });
}

async function focused(locator: Locator): Promise<boolean> {
  return locator.evaluate(element => element === document.activeElement);
}

async function hasVisibleSourceMark(page: Page, side = 'original'): Promise<void> {
  await page.waitForFunction(side => {
    const paper = document.getElementById('paperScroll')!.getBoundingClientRect();
    return [...document.getElementById(side)!.querySelectorAll('.pdf-quote-mark')].some(mark => {
      const { top, bottom, left, right, width } = mark.getBoundingClientRect();
      return width > 0 && top < paper.bottom && bottom > paper.top && left < paper.right && right > paper.left;
    });
  }, side);
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  const model = await modelFixture();
  const directory = path.join(host.artifacts, 'reviews', 'notebook-scenarios');
  const failures: string[] = [];
  await mkdir(directory, { recursive: true });
  const capture = (page: Page, name: string) => page.screenshot({ path: path.join(directory, name + '.png') });
  const scenario = async (name: string, test: (page: Page) => Promise<void>, mobile = false, locale = 'en-US') => {
    if (process.argv[2] && process.argv[2] !== name) return;
    const context = await browser.newContext({ locale, viewport: mobile ? phone : desktop, hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await test(page);
      assert.deepEqual(pageErrors, [], 'Browser page errors');
      console.log('PASS ' + name);
    } catch (error) {
      failures.push(name);
      console.error('FAIL ' + name, error);
      await capture(page, 'failed-' + name).catch(() => undefined);
    } finally {
      await context.close();
    }
  };
  try {
    await scenario('pdf-reading', async page => {
      const pane = await openReader(page, host.authenticatedUrl);
      await pane.locator('[data-pdf-side="source"]').first().waitFor();
      await page.goto(readerUrl(host));
      const card = page.locator('#card');
      const original = page.getByRole('button', { name: 'Original', exact: true });
      const bilingual = page.getByRole('button', { name: 'Bilingual', exact: true });
      const scope = page.getByRole('combobox', { name: 'Translation scope', exact: true });
      await sourceRun(page).waitFor();
      assert.equal(await original.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#translated').isVisible(), false);
      await bilingual.click();
      await scope.selectOption('passage');
      await original.click();
      await selectPhrase(page, sourceRun(page), sourceQuote);
      const more = await openCardMore(card, { key: 'Enter' });
      const openComparison = more.getByRole('button', { name: 'Open bilingual view', exact: true });
      await openComparison.waitFor();
      assert.equal(await more.getByRole('button', { name: 'See full translation', exact: true }).count(), 0);
      await capture(page, '01-pdf-original-selection');
      await openComparison.press('Enter');
      assert.equal(await bilingual.getAttribute('aria-pressed'), 'true');
      assert.equal(await scope.inputValue(), 'passage', 'Opening bilingual view must respect the selected translation scope.');
      assert.ok(await focused(bilingual), 'Language switching should identify the newly active reading control.');
      await hasVisibleSourceMark(page, 'translated');
      assert.equal(await card.locator('.selection-language').isVisible(), false);
      await scope.selectOption('column');
      assert.equal(await scope.inputValue(), 'column');
      await scope.selectOption('page');
      assert.equal(await scope.inputValue(), 'page');
      await capture(page, '02-pdf-bilingual-selection');

      await card.getByRole('button', { name: 'Close selection', exact: true }).click();
      await selectPhrase(page, translatedRun(page), translatedQuote);
      await card.getByRole('heading', { name: translatedQuote, exact: true }).waitFor();
      assert.equal(await card.locator('.selection-language').isVisible(), false);
      await hasVisibleSourceMark(page, 'translated');
      await card.getByRole('button', { name: 'Close selection', exact: true }).click();
      await original.click();
      const rail = page.locator('#rail');
      assert.equal(await rail.isVisible(), false, 'The passage link should be inserted with the notebook initially closed.');
      await selectPhrase(page, figureCaption(page), figureQuote);
      await cardMoreAction(card, 'Insert passage link', { key: 'Enter' });
      await rail.getByRole('tab', { name: 'Notes', exact: true, selected: true }).waitFor();
      const link = rail.getByRole('link').filter({ hasText: figureQuote });
      const citation = await box(link), writingArea = await box(rail.locator('.cm-scroller'));
      assert.ok(citation.y >= writingArea.y - 1 && citation.y + citation.height <= writingArea.y + writingArea.height + 1,
        'The inserted passage link should be visible in the notebook.');
      assert.ok(await focused(rail.getByRole('textbox', { name: 'Notes Markdown', exact: true })));
      await capture(page, '16-insert-passage-link');
      await rail.locator('.notebook-status[data-saved="true"]').waitFor();
      assert.ok((await snapshot(page, host)).markdown.includes(figureQuote));
      await link.click();
      await page.waitForURL(url => url.searchParams.get('anchor') === 'figure-6' && url.searchParams.get('quote') === figureQuote);
      await hasVisibleSourceMark(page);
      await page.locator('#closeRail').click();

      const textToggle = page.locator('#readText');
      await textToggle.press('Enter');
      const text = page.getByRole('region', { name: 'Page text' });
      const block = text.locator('[data-passage-id="block-tables"]');
      const use = block.getByRole('button', { name: /Use passage/ });
      await text.waitFor();
      assert.equal(await textToggle.innerText(), 'View PDF page');
      for (let i = 0; i < 10 && !await focused(use); i++) await page.keyboard.press('Tab');
      assert.ok(await focused(use), 'The reflowed passage must be reachable through the regular Tab order.');
      await page.keyboard.press('Enter');
      await card.getByRole('heading', { name: 'Passage translation', exact: true }).waitFor();
      assert.ok(await card.evaluate(el => el.contains(document.activeElement)));
      await page.keyboard.press('Escape');
      assert.ok(await focused(use), 'Closing the card should restore focus to the passage.');
      await page.keyboard.press('Enter');
      await card.getByRole('button', { name: 'Write note', exact: true }).press('Enter');
      const draft = card.getByRole('textbox', { name: 'Your note' });
      await draft.fill(readDraft);
      await capture(page, '03-pdf-reflow-draft');
      await bilingual.press('Enter');
      assert.equal(await draft.inputValue(), readDraft);
      assert.equal(await text.isVisible(), false);
      await original.press('Enter');
      await text.waitFor();
      assert.equal(await draft.inputValue(), readDraft);
      await draft.press('Control+Enter');
      await card.getByText('Note saved.', { exact: true }).waitFor();
      await page.locator('#mobileRail').click();
      const line = rail.locator('.cm-line[data-note-id]').filter({ hasText: readDraft });
      const noteId = await line.getAttribute('data-note-id');
      assert.ok(noteId);
      await rail.locator('.source-chip[data-note-id=' + JSON.stringify(noteId) + ']').click();
      await hasVisibleSourceMark(page);
      assert.equal(await text.isVisible(), false, 'The note should reopen the original PDF page.');
      assert.equal(new URL(page.url()).searchParams.get('anchor'), 'block-tables');
    });

    await scenario('discussion', async page => {
      await open(page, host);
      await action(page, host, 'settings.save', { baseUrl: model.origin + '/v1', apiKey: model.key, model: model.model });
      await page.reload();
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await selectPhrase(page, sourceRun(page), sourceQuote);
      await page.locator('#card').getByRole('button', { name: 'Ask AI', exact: true }).press('Enter');
      await page.locator('#card .selection-chat').getByRole('button', { name: 'Explain', exact: true }).press('Enter');
      const chat = page.locator('#card .selection-chat');
      await chat.locator('.selection-answer').getByText(model.answer, { exact: true }).waitFor();
      assert.equal(model.completed(), 1, 'Explain should submit exactly one question.');
      const dock = page.locator('#selectionDock'), paper = page.locator('#paperScroll');
      const position = chat.getByRole('combobox', { name: 'Discussion position', exact: true });
      assert.equal(await position.inputValue(), 'right');
      const right = await box(dock), readingOnLeft = await box(paper);
      assert.ok(readingOnLeft.x + readingOnLeft.width <= right.x + 1);
      await capture(page, '10-discussion-docked-right');
      const draft = chat.getByRole('textbox', { name: 'Message about this selection', exact: true });
      const followup = 'How does changing the mapping affect available KV space?';
      await draft.fill(followup);
      await position.selectOption('left');
      const left = await box(dock), readingOnRight = await box(paper);
      assert.ok(left.x + left.width <= readingOnRight.x + 1, 'The discussion should move to the left of the paper.');
      assert.equal(await draft.inputValue(), followup);
      await capture(page, '11-discussion-docked-left');
      await position.selectOption('float');
      const floating = await box(dock), underlay = await box(paper);
      assert.ok(floating.x < underlay.x + underlay.width && floating.x + floating.width > underlay.x &&
        floating.y < underlay.y + underlay.height && floating.y + floating.height > underlay.y,
      'The detached discussion should overlay the paper.');
      await chat.getByRole('heading', { name: 'Reading discussion', exact: true }).press('ArrowLeft');
      assert.ok((await box(dock)).x < floating.x, 'The floating discussion should move with the keyboard.');
      assert.equal(await draft.inputValue(), followup);
      await capture(page, '12-discussion-floating');

      await chat.getByRole('button', { name: 'Add to Notes', exact: true }).click();
      await chat.getByText('Added', { exact: true }).waitFor();
      await chat.getByRole('button', { name: 'View', exact: true }).click();
      await pose(page, 'float');
      assert.equal(await page.locator('#notebookPose').inputValue(), 'float', 'The two sidebars must share the selected desktop position.');
      assert.equal(await position.isVisible(), false, 'The notebook already provides the shared position control.');
      const below = await box(dock), paperAbove = await box(paper);
      assert.ok(below.y >= paperAbove.y + paperAbove.height - 2 && paperAbove.height > 90,
        'A passage discussion should keep the paper reachable when the notebook is open.');
      assert.equal(await draft.inputValue(), followup);
      await page.locator('#rail .notebook-passage-link').filter({ hasText: sourceQuote }).last().click();
      await page.getByRole('button', { name: 'Back to discussion', exact: true }).waitFor();
      await hasVisibleSourceMark(page);
      await page.getByRole('button', { name: 'Back to discussion', exact: true }).press('Enter');
      assert.equal(await draft.inputValue(), followup);
      assert.ok(await focused(draft), 'The discussion should restore focus to the follow-up.');
      await page.setViewportSize(phone);
      await page.locator('#reader[data-notebook-pose="sheet"]').waitFor();
      await position.waitFor({ state: 'hidden' });
      const compact = await box(dock);
      assert.ok(compact.y + compact.height <= phone.height + 1);
      assert.ok((await box(paper)).height > 90);
      assert.equal(await draft.inputValue(), followup);
      await capture(page, '13-phone-discussion');
      await draft.press('Enter');
      await chat.locator('.selection-answer').nth(1).waitFor();
      assert.equal(model.completed(), 2);
    });

    await scenario('notebook', async page => {
      await open(page, host);
      const card = page.locator('#card'), rail = page.locator('#rail');
      const position = page.getByRole('combobox', { name: 'Notes position', exact: true });
      const display = page.getByRole('combobox', { name: 'Highlight display', exact: true });
      const notes = rail.getByRole('tab', { name: 'Notes', exact: true });
      const marks = rail.getByRole('tab', { name: 'Marks', exact: true });
      const initial = await snapshot(page, host);
      await selectPhrase(page, sourceRun(page), sourceQuote);
      await card.getByRole('button', { name: 'Highlight', exact: true }).click();
      await page.locator('#original .annotation-highlight').first().waitFor({ state: 'attached' });
      const saved = (await action(page, host, 'annotation.list', { docId: pdfId })).annotations.find(mark => mark.quote === sourceQuote);
      assert.ok(saved);
      assert.equal((await snapshot(page, host)).markdown, initial.markdown, 'Highlighting must leave Markdown intact.');

      await selectPhrase(page, sourceRun(page), sourceQuote);
      await card.getByRole('button', { name: 'Write note', exact: true }).click();
      await card.getByRole('textbox', { name: 'Your note' }).fill(matchedNote);
      await card.getByRole('button', { name: 'Save note', exact: true }).click();
      await card.getByText('Note saved.', { exact: true }).waitFor();
      await card.getByRole('button', { name: 'Close passage workspace' }).press('Enter');
      await card.getByRole('button', { name: 'Close selection' }).press('Enter');
      await page.locator('#mobileRail').click();
      await pose(page, 'right');
      assert.equal(await position.inputValue(), 'right');
      assert.equal(await display.inputValue(), 'inline');
      const highlight = rail.locator('.cm-content .notebook-highlight[data-annotation-id=' + JSON.stringify(saved.id) + ']');
      await highlight.getByText(sourceQuote, { exact: true }).waitFor();
      const baseline = await snapshot(page, host);

      await display.selectOption('separate');
      await notes.click();
      assert.equal(await highlight.isVisible(), false);
      await marks.press('Enter');
      const row = rail.locator('.annotation-entry').filter({ hasText: sourceQuote });
      await row.click();
      const comment = rail.getByRole('textbox', { name: 'Comment', exact: true });
      await comment.fill(markComment);
      await comment.press('Control+Home');
      await comment.press('Shift+ArrowRight');
      assert.deepEqual(await comment.evaluate(el => {
        const field = el as HTMLTextAreaElement;
        return [field.selectionStart, field.selectionEnd];
      }), [0, 1]);
      await position.selectOption('left');
      await pose(page, 'left');
      assert.equal(await comment.inputValue(), markComment);
      await capture(page, '04-notebook-docked-left-separate');

      await position.selectOption('float');
      await pose(page, 'float');
      const handle = page.locator('#notebookHandle');
      const resting = await box(rail);
      await handle.press('ArrowLeft');
      assert.ok((await box(rail)).x < resting.x, 'The floating notebook should move with the keyboard.');
      const grip = await box(handle);
      await page.mouse.move(grip.x + 9, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x - 68, grip.y + grip.height / 2 + 40, { steps: 8 });
      await page.mouse.up();
      const moved = await box(rail);
      assert.ok(moved.x < resting.x - 25 && moved.y > resting.y, 'The floating notebook should follow its drag handle.');
      assert.deepEqual(await comment.evaluate(el => {
        const field = el as HTMLTextAreaElement;
        return [field.value, field.selectionStart, field.selectionEnd];
      }), [markComment, 0, 1]);
      await capture(page, '05-notebook-floating-draft');
      await page.reload();
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await pose(page, 'float');
      assert.ok(Math.abs((await box(rail)).x - moved.x) <= 2 && Math.abs((await box(rail)).y - moved.y) <= 2);
      await rail.getByRole('tab', { name:'Marks', selected:true, exact:true }).waitFor();
      await notes.click();
      assert.equal(await display.inputValue(), 'separate');
      await marks.click();
      await rail.locator('.annotation-entry').filter({ hasText: markComment }).click();
      assert.equal(await comment.inputValue(), markComment);
      await position.selectOption('right');
      await pose(page, 'right');
      const width = (await box(rail)).width;
      await page.getByRole('separator', { name: 'Resize notes', exact: true }).press('ArrowLeft');
      assert.ok((await box(rail)).width > width, 'The right sidebar should resize from the keyboard.');
      await comment.press('Control+Enter');
      await rail.locator('.annotation-workspace').getByRole('heading', { name: 'Marks', exact: true }).waitFor();
      await notes.click();
      await display.selectOption('inline');
      await highlight.getByText(markComment, { exact: true }).waitFor();
      const note = rail.locator('.cm-line[data-note-id]').filter({ hasText: matchedNote });
      await note.waitFor();
      const adjacent = await rail.locator('.cm-content').evaluate((content, { id, text }) => {
        const entries = [...content.querySelectorAll('.cm-line[data-note-id], .notebook-highlight')];
        const mark = entries.findIndex(entry => entry.getAttribute('data-annotation-id') === id);
        const note = entries.findIndex(entry => entry.classList.contains('cm-line') && entry.textContent?.includes(text));
        return mark >= 0 && note >= 0 && Math.abs(mark - note) <= 1;
      }, { id: saved.id, text: matchedNote });
      assert.ok(adjacent, 'The matching note and highlight should be adjacent in the rich notebook.');
      const markdownMode = rail.getByRole('button', { name: 'Markdown', exact: true });
      await markdownMode.click();
      assert.equal(await highlight.isVisible(), false);
      await markdownMode.click();
      const edit = highlight.getByRole('button', { name: 'Edit highlight', exact: true });
      await edit.press('Enter');
      assert.equal(await comment.inputValue(), markComment);
      await rail.getByRole('button', { name: 'Close mark', exact: true }).press('Enter');
      await edit.waitFor();
      assert.ok(await focused(edit), 'Closing inline editing should return focus to its highlight.');
      assert.deepEqual(await snapshot(page, host), baseline, 'Changing highlight display and annotation comments must not write Markdown.');
      assert.ok(await page.locator('#original .annotation-highlight').first().count(), 'Showing highlights in the notebook must keep paper-side ink.');
      await capture(page, '06-notebook-docked-right-inline');

      await pageJump(page, 7);
      const source = highlight.getByRole('button', { name: 'View source · p. 6', exact: true });
      await source.click();
      await page.waitForURL(url => url.searchParams.get('page') === '6' && url.searchParams.get('anchor') === 'block-tables');
      await hasVisibleSourceMark(page);
      assert.equal(new URL(page.url()).searchParams.get('quote'), sourceQuote);
      await position.selectOption('left');
      await page.locator('#parallel').press('Enter');
      await page.setViewportSize({ width: 1024, height: 768 });
      await pose(page, 'left');
      assert.equal(await page.locator('#original').isVisible(), true);
      assert.equal(await page.locator('#translated').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.setViewportSize(phone);
      await pose(page, 'sheet');
      assert.equal(await position.isVisible(), false);
      await page.setViewportSize(desktop);
      await pose(page, 'left');
      assert.equal(await position.inputValue(), 'left');
    });

    await scenario('legacy-position', async page => {
      await page.addInitScript(origin => {
        if (location.origin !== origin || !location.pathname.endsWith('/paper-reader/app/index.html') ||
          localStorage.getItem('reader.desk.layout')) return;
        localStorage.setItem('reader.desk.layout', JSON.stringify({
          notebookFloating: true, notebookPosition: { x: 97, y: 73 }, compactNotebookOpen: true
        }));
      }, host.origin);
      await open(page, host);
      const position = page.getByRole('combobox', { name: '笔记位置', exact: true });
      await pose(page, 'float');
      const initial = await box(page.locator('#rail'));
      assert.ok(Math.abs(initial.x - 97) <= 1 && Math.abs(initial.y - 73) <= 1);
      await position.selectOption('left');
      await page.reload();
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await pose(page, 'left');
      assert.equal(await position.inputValue(), 'left');
      await page.locator('#closeRail').click();
      const card = page.locator('#card');
      await selectPhrase(page, figureCaption(page), figureQuote);
      await card.getByRole('button', { name: '高亮', exact: true }).click();
      await page.locator('#original .annotation-highlight').first().waitFor({ state: 'attached' });
      await page.locator('#mobileRail').click();
      await page.locator('#notesTab').click();
      await page.locator('#highlightDisplay').selectOption('inline');
      const highlight = page.locator('#rail .cm-content .notebook-highlight').filter({ hasText: figureQuote });
      await highlight.scrollIntoViewIfNeeded();
      await pose(page, 'left');
      await capture(page, '15-中文左侧内联笔记');

      await page.locator('#closeRail').click();
      await selectPhrase(page, sourceRun(page), sourceQuote);
      await (await openCardMore(card)).getByRole('button', { name: '打开双语对照', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.setViewportSize(phone);
      await cardMoreAction(card, '查看译文');
      await (await openCardMore(card)).getByRole('button', { name: '查看原文', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await capture(page, '14-chinese-reading-controls');
    }, false, 'zh-CN');

    await scenario('compact-reader', async page => {
      await open(page, host);
      const card = page.locator('#card'), rail = page.locator('#rail');
      const original = page.getByRole('button', { name: 'Original', exact: true });
      const translation = page.getByRole('button', { name: 'Translation', exact: true });
      await selectPhrase(page, sourceRun(page), sourceQuote, true);
      await cardMoreAction(card, 'Show translation', { mobile: true });
      assert.equal(await translation.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#original').isVisible(), false);
      await hasVisibleSourceMark(page, 'translated');
      assert.equal(await (await openCardMore(card, { mobile: true })).getByRole('button', { name: 'Show translation', exact: true }).count(), 0);
      await page.keyboard.press('Escape');
      await card.getByRole('button', { name: 'Close selection', exact: true }).tap();

      await selectPhrase(page, translatedRun(page), translatedQuote, true);
      await capture(page, '07-phone-translation-selection');
      await cardMoreAction(card, 'Show original', { mobile: true });
      assert.equal(await original.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#translated').isVisible(), false);
      await hasVisibleSourceMark(page);
      assert.ok(await sourceRun(page).evaluate((run, quote) => {
        const text = run.firstChild as Text, start = text.data.indexOf(quote);
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + quote.length);
        const phrase = range.getBoundingClientRect();
        const x = phrase.left + phrase.width / 2, y = phrase.top + phrase.height / 2;
        return [...document.querySelectorAll('#original .pdf-quote-mark')].some(node => {
          const mark = node.getBoundingClientRect();
          return x >= mark.left && x <= mark.right && y >= mark.top && y <= mark.bottom;
        });
      }, sourceQuote), 'Switching from Chinese should mark the matching English sentence.');
      await capture(page, '07b-phone-original-context');
      await card.getByRole('button', { name: 'Write note', exact: true }).tap();
      const draft = card.getByRole('textbox', { name: 'Your note' });
      const value = 'The note remains attached to the selected Chinese wording.';
      await draft.fill(value);
      await translation.tap();
      assert.equal(await draft.inputValue(), value);
      const toggle = page.locator('#mobileRail');
      await toggle.tap();
      await pose(page, 'sheet');
      assert.equal(await rail.getAttribute('aria-modal'), 'true');
      assert.equal(await page.locator('.workspace').evaluate(node => (node as HTMLElement).inert), true);
      assert.equal(await page.locator('#notebookPose').isVisible(), false);
      assert.ok(await focused(page.locator('#closeRail')));
      await page.keyboard.press('Shift+Tab');
      assert.ok(await rail.evaluate(node => node.contains(document.activeElement)), 'The dialog must trap focus.');
      await capture(page, '08-phone-notebook-sheet');
      await page.keyboard.press('Escape');
      assert.ok(await focused(toggle), 'Closing the sheet must restore focus to its opener.');
      assert.equal(await draft.inputValue(), value);
      await card.getByRole('button', { name: 'Save note', exact: true }).tap();
      await card.getByText('Note saved.', { exact: true }).waitFor();
      const note = (await snapshot(page, host)).notes.find(note => note.text === value);
      assert.ok(note);
      assert.equal(new URL(note.sourceUrl).searchParams.get('targetQuote'), translatedQuote);
      await page.reload();
      await page.locator('#loading').waitFor({ state: 'hidden' });
      assert.equal(await translation.getAttribute('aria-pressed'), 'true', 'The phone should retain the reading language after reload.');
      await toggle.tap();
      await rail.locator('.source-chip[data-note-id=' + JSON.stringify(note.id) + ']').tap();
      await hasVisibleSourceMark(page, 'translated');
      assert.equal(await rail.isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.setViewportSize({ width: 667, height: 375 });
      await translation.waitFor();
      await toggle.tap();
      await pose(page, 'sheet');
      assert.equal(await rail.getAttribute('aria-modal'), 'true');
      await capture(page, '08b-phone-landscape-notebook');
      await page.keyboard.press('Escape');
      await page.setViewportSize(phone);

      const annotations = () => action(page, host, 'annotation.list', { docId: pdfId });
      const savedAnnotations = await annotations();
      await page.getByRole('button', { name: 'Pin on PDF', exact: true }).tap();
      await page.getByRole('button', { name: 'Cancel placement', exact: true, pressed: true }).waitFor();
      const placement = page.locator('#original .pdf-sheet .annotation-placement');
      await placement.waitFor();
      assert.equal(await original.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#translated').isVisible(), false);
      assert.equal(await page.locator('#reader').getAttribute('data-page-format'), 'pdf');
      assert.ok(await focused(placement), 'The PDF placement tool should receive focus.');
      const crosshair = placement.locator('.annotation-crosshair');
      const before = await box(crosshair);
      await page.keyboard.press('ArrowLeft');
      assert.ok((await box(crosshair)).x < before.x);
      await capture(page, '17-phone-pin-on-pdf');
      await page.keyboard.press('Escape');
      await placement.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#placePin').getAttribute('aria-pressed'), 'false');
      assert.ok(await focused(page.locator('#more')));
      assert.deepEqual(await annotations(), savedAnnotations, 'Canceling placement must preserve the saved annotations.');
      assert.equal(await page.locator('#original .annotation-pin').count(), 0, 'Canceling placement must not leave an empty pin on the PDF.');
    }, true);

    await scenario('web-article', async page => {
      const text = 'A block ledger assigns each stream a storage slot.';
      const zh = '块账本会为每条流分配一个存储槽。';
      const title = 'Block ledger reading fixture';
      const webModel = await modelFixture(JSON.stringify({ translations: { 'p-1': zh } }), text);
      try {
        await page.goto(host.authenticatedUrl);
        await action(page, host, 'settings.save', { baseUrl: webModel.origin + '/v1', apiKey: webModel.key, model: webModel.model });
        const { doc } = await action(page, host, 'web.import', { title, url: 'https://example.test/block-ledger', paragraphs: [text] });
        await page.goto(readerUrl(host, doc.id, 1));
        const source = page.locator('#original .web-reading-row[data-anchor="p-1"] p');
        const target = page.locator('#translated .web-reading-row[data-anchor="p-1"] p');
        const card = page.locator('#card'), rail = page.locator('#rail');
        await source.waitFor();
        assert.equal(await page.locator('#readText').isVisible(), false);
        await selectPhrase(page, source, text);
        await cardMoreAction(card, 'Open bilingual view');
        await page.getByRole('button', { name: 'Translate article', exact: true }).click();
        await target.filter({ hasText: zh }).waitFor();
        assert.equal(await page.locator('#translationMode').isVisible(), false);
        await card.getByRole('button', { name: 'Close selection', exact: true }).click();
        await selectPhrase(page, target, zh);
        await card.getByRole('button', { name: 'Highlight', exact: true }).click();
        await page.locator('#translated .annotation-highlight').first().waitFor({ state: 'attached' });
        await page.locator('#mobileRail').click();
        const highlight = rail.locator('.notebook-highlight').filter({ hasText: zh });
        await highlight.waitFor();
        await capture(page, '09-web-bilingual-inline-highlight');
        await page.getByRole('combobox', { name: 'Highlight display', exact: true }).selectOption('separate');
        assert.equal(await highlight.isVisible(), false);
        await rail.getByRole('tab', { name: 'Marks', exact: true }).click();
        await rail.locator('.annotation-entry').filter({ hasText: zh }).click();
        await rail.getByRole('button', { name: /Article.*Paragraph 1/ }).click();
        await page.waitForURL(url => url.searchParams.get('anchor') === 'p-1' && url.searchParams.get('targetQuote') === zh);
        assert.equal(await webModel.completed(), 1);
      } finally { await webModel.close(); }
    });
  } finally {
    await browser.close();
    await model.close();
  }
  assert.deepEqual(failures, [], 'Reader scenarios with failures');
});
