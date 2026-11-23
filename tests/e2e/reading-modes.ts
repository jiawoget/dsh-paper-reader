import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator } from 'playwright-core';
import { withHost } from './host.js';

async function selectPassage(run: Locator): Promise<void> {
  await run.scrollIntoViewIfNeeded();
  await run.evaluate(element => {
    const node = element.firstChild;
    if (!(node instanceof Text)) throw new Error('Cannot select an empty PDF text run.');
    document.getSelection()!.setBaseAndExtent(node, 0, node, node.length);
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  });
}

await withHost(async ({ origin, authenticatedUrl, executable }) => {
  const browser = await chromium.launch({ executablePath: executable });
  try {
    const desktop = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const page = await desktop.newPage();
    const screenshots = process.env.PAPER_READER_MODES_ARTIFACTS;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const capture = async (name: string) => {
      if (screenshots) await page.screenshot({ path: path.join(screenshots, name) });
    };
    await page.goto(authenticatedUrl);
    await page.goto(origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6');
    const reader = page.locator('#reader');
    const original = reader.locator('#original'), translated = reader.locator('#translated');
    const card = page.locator('#card'), dock = reader.locator('#selectionDock');
    const renderPage = async () => {
      await original.locator('.pdf-native-text [data-block-id="block-tables"]').first().waitFor();
      await reader.locator('#loading').waitFor({ state: 'hidden' });
    };
    await renderPage();
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.equal(await translated.isVisible(), false);
    const sourceWidth = (await original.boundingBox())!.width;
    assert.ok(sourceWidth >= 720, 'The source-first page should use the available reading space.');

    const passage = original.locator('.pdf-native-text [data-block-id="block-tables"]').filter({ hasText: /mapping between logical/i }).first();
    await selectPassage(passage);
    await card.getByRole('heading', { name: 'Passage translation' }).waitFor();
    await card.getByText(/逻辑 KV 块/).first().waitFor();
    await page.setViewportSize({ width: 2100, height: 900 });
    await page.locator('#card:not([data-docked])').waitFor();
    const floating = (await card.boundingBox())!;
    const leftGutter = floating.x < (await original.boundingBox())!.x;
    const cornerX = floating.x + (leftGutter ? 4 : floating.width - 4);
    const cornerY = floating.y + floating.height - 4;
    await page.mouse.move(cornerX, cornerY);
    await page.mouse.down();
    await page.mouse.move(cornerX + (leftGutter ? -40 : 40), cornerY + 48, { steps: 8 });
    await page.mouse.up();
    const resized = (await card.boundingBox())!;
    assert.ok(resized.width > floating.width + 25 && resized.height > floating.height + 30,
      'Dragging the outer corner should enlarge the floating preview in both dimensions.');
    await page.setViewportSize({ width: 1440, height: 900 });
    await capture('C-Original.png');
    await card.getByRole('button', { name: 'Open bilingual view' }).click();
    assert.equal(await reader.getAttribute('data-reading-mode'), 'bilingual');
    await original.locator('.pdf-quote-mark').first().waitFor();
    await translated.locator('.pdf-quote-mark').first().waitFor();
    assert.ok((await original.boundingBox())!.width < sourceWidth);
    await dock.waitFor();
    const comparison = (await dock.boundingBox())!, paper = (await reader.locator('#paperScroll').boundingBox())!;
    assert.ok(comparison.y >= paper.y + paper.height - 1, 'Comparison actions should sit below the document, outside both panes.');
    const grip = dock.getByRole('separator', { name: 'Resize passage preview' });
    assert.ok(await grip.isVisible(), 'The docked selection needs a visible resize handle.');
    const handle = (await grip.boundingBox())!;
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 80, { steps: 8 });
    await page.mouse.up();
    assert.ok((await dock.boundingBox())!.height > comparison.height + 65);
    await grip.press('ArrowDown');
    assert.ok((await dock.boundingBox())!.height < comparison.height + 70);
    await grip.dblclick();
    assert.ok(Math.abs((await dock.boundingBox())!.height - comparison.height) < 2);
    await capture('B-Compare.png');

    await card.getByRole('button', { name: 'Write note' }).click();
    const note = dock.getByRole('textbox', { name: 'Your note' });
    const draft = 'The block table lets vLLM allocate physical KV blocks as a sequence grows.';
    await note.fill(draft);
    await capture('B-Bilingual.png');
    await reader.getByRole('button', { name: 'Original', exact: true }).click();
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.equal(await note.inputValue(), draft);
    await reader.getByRole('button', { name: 'Bilingual', exact: true }).click();
    assert.equal(await note.inputValue(), draft);
    assert.equal(await reader.locator('#pageCount').innerText(), '6 / 16');

    await page.setViewportSize({ width: 390, height: 844 });
    await reader.getByRole('button', { name: 'Translation', exact: true, pressed: true }).waitFor();
    assert.equal(await original.isVisible(), false);
    assert.equal(await translated.isVisible(), true);
    assert.ok((await translated.boundingBox())!.width >= 350);
    assert.equal(await note.inputValue(), draft);
    await capture('B-390.png');
    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await dock.getByRole('heading', { name: 'Reading discussion' }).waitFor();
    await dock.getByRole('button', { name: 'Close chat' }).click();
    await dock.getByRole('heading', { name: 'Selected passage' }).waitFor();
    assert.equal(await card.locator('.selection-chat').isVisible(), false);
    await card.getByRole('button', { name: 'Ask AI', exact: true }).waitFor();
    assert.ok(await card.getByRole('button', { name: 'Ask AI', exact: true }).evaluate(button => button === document.activeElement));
    await translated.locator('.pdf-quote-mark').first().waitFor();
    await card.getByRole('button', { name: 'Write note' }).click();
    assert.equal(await note.inputValue(), draft);
    await page.reload();
    await reader.locator('#loading').waitFor({ state: 'hidden' });
    assert.equal(await reader.getAttribute('data-reading-mode'), 'bilingual');
    assert.ok(await translated.isVisible(), 'The compact reader should resume in Simplified Chinese.');

    await reader.getByRole('combobox', { name: 'Zoom' }).selectOption('2');
    await reader.getByRole('button', { name: 'Original', exact: true }).click();
    const savedSource = new URL(origin + '/api/paper-reader/app/index.html');
    savedSource.search = new URLSearchParams({ doc: 'pagedattention', page: '6', anchor: 'parallel-sampling', targetQuote: '并行采样' }).toString();
    await page.goto(savedSource.href);
    const mark = translated.locator('.pdf-quote-mark').first();
    await mark.waitFor();
    const markBox = (await mark.boundingBox())!, viewport = (await reader.locator('#paperScroll').boundingBox())!;
    assert.ok(markBox.y < viewport.y + viewport.height && markBox.y + markBox.height > viewport.y,
      'A translated source link should bring the marked text into the visible pane.');

    await reader.getByRole('button', { name: 'Original', exact: true }).click();
    await reader.getByRole('button', { name: /Go to page/ }).click();
    const number = reader.getByRole('spinbutton', { name: 'Page number' });
    await number.fill('99');
    await number.press('Enter');
    assert.ok(await number.isVisible(), 'An out-of-range page should keep the jump form open.');
    await number.fill('5');
    await number.press('Enter');
    await reader.locator('[data-pdf-side="source"][aria-label="Original, page 5"]').waitFor();
    await reader.locator('#loading').waitFor({ state: 'hidden' });
    await reader.getByRole('button', { name: /Go to page/ }).click();
    await number.fill('6');
    await number.press('Enter');
    await renderPage();

    const readText = reader.getByRole('button', { name: 'Read text' });
    await readText.focus();
    await page.keyboard.press('Enter');
    const text = reader.getByRole('region', { name: 'Page text' });
    await text.waitFor();
    const block = text.locator('[data-passage-id="block-tables"]');
    assert.ok(await block.locator('p').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
    assert.ok(await reader.locator('#paperScroll').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    const use = block.getByRole('button', { name: /Use passage/ });
    const useHasFocus = () => use.evaluate(node => node === document.activeElement);
    for (let step = 0; step < 8 && !await useHasFocus(); step++) await page.keyboard.press('Tab');
    assert.ok(await useHasFocus(), 'The Read text control should lead to a passage through the regular Tab order.');
    await page.keyboard.press('Enter');
    await card.getByRole('heading', { name: 'Passage translation' }).waitFor();
    const translationFits = await card.locator('.passage-counterpart .meaning').evaluate(node => {
      const actions = document.querySelector('#card .card-actions')!.getBoundingClientRect();
      return node.getBoundingClientRect().bottom <= actions.top &&
        (node.scrollHeight <= node.clientHeight || getComputedStyle(node).overflowY === 'auto');
    });
    assert.ok(translationFits, 'Long translation previews should scroll without covering passage actions.');
    await capture('C-390-Read-text.png');
    assert.ok(await card.evaluate(node => node.contains(document.activeElement)), 'Keyboard selection should focus the passage tools.');
    await page.keyboard.press('Escape');
    assert.ok(await use.evaluate(node => node === document.activeElement), 'Closing the selection should return to the passage.');
    await page.keyboard.press('Enter');
    await card.getByRole('button', { name: 'Write note' }).press('Enter');
    const keyboardNote = 'A note written from the reflowed source passage.';
    await note.fill(keyboardNote);
    await card.getByRole('button', { name: 'Save note', exact: true }).press('Enter');
    await card.getByText('Note saved.', { exact: true }).waitFor();
    await reader.getByRole('button', { name: 'Show notebook' }).click();
    const saved = reader.locator('.cm-line[data-note-id]').filter({ hasText: keyboardNote });
    const noteId = await saved.getAttribute('data-note-id');
    assert.ok(noteId);
    await reader.locator('.source-chip[data-note-id=' + JSON.stringify(noteId) + ']').click();
    await original.locator('.pdf-quote-mark').first().waitFor();
    assert.equal(await text.isVisible(), false, 'Notes should open their original PDF source.');

    const phone = await browser.newPage({ locale: 'en-US', viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });
    await phone.goto(authenticatedUrl);
    await phone.goto(origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6');
    await phone.getByRole('button', { name: 'Read text' }).tap();
    const phoneText = phone.getByRole('region', { name: 'Page text' });
    const phoneBlock = phoneText.locator('[data-passage-id="block-tables"]');
    const phoneCard = phone.locator('#card');
    await phoneBlock.getByRole('button', { name: /Use passage/ }).tap();
    await phoneCard.getByRole('heading', { name: 'Passage translation' }).waitFor();
    assert.ok(await phone.locator('#paperScroll').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.ok(await phone.locator('.toolbar').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await phoneCard.getByRole('button', { name: 'Close selection' }).tap();
    const touchRange = (phrase: string, begin: boolean) => phoneBlock.locator('p').evaluate((node, { phrase, begin }) => {
      const value = node.firstChild as Text, start = value.data.indexOf(phrase);
      if (begin) node.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      document.getSelection()!.setBaseAndExtent(value, start, value, start + phrase.length);
      if (begin) node.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', bubbles: true }));
    }, { phrase, begin });
    await touchRange('physical KV blocks', true);
    await phoneCard.getByRole('heading', { name: 'physical KV blocks', exact: true }).waitFor();
    await touchRange('physical KV', false);
    await phoneCard.getByRole('heading', { name: 'physical KV', exact: true }).waitFor();
    await phone.setViewportSize({ width: 667, height: 375 });
    await phone.getByRole('button', { name: 'Paper chat', exact: true }).tap();
    await phoneCard.getByRole('button', { name: 'Ask AI', exact: true }).tap();
    assert.ok((await phone.locator('#paperScroll').boundingBox())!.height >= 90,
      'The short layout should reserve room for reading when both chat panels are open.');
    await phone.close();

    const fixture = await page.context().newPage();
    await fixture.setContent('<p>A simple lattice model describes the distance between neighboring nodes.</p>');
    const pdf = await fixture.pdf({ format: 'A4' });
    await fixture.close();
    const imported = await page.context().request.post(origin + '/api/paper-reader/import-pdf?title=Workflow%20translation%20fixture.pdf',
      { data: pdf, headers: { 'content-type': 'application/pdf' } });
    assert.ok(imported.ok());
    const { doc } = await imported.json() as { doc: { id: string } };
    await page.goto(origin + '/api/paper-reader/app/index.html?doc=' + encodeURIComponent(doc.id));
    await readText.click();
    const pendingBlock = text.locator('.reading-passage').first();
    const passageId = await pendingBlock.getAttribute('data-passage-id');
    assert.ok(passageId);
    const translation = '一个简单的格子模型描述了相邻节点之间的距离。';
    const pending = Promise.withResolvers<void>();
    await page.route('**/paper-reader/action', async route => {
      const request = route.request().postDataJSON();
      if (request?.op !== 'translation.get' || request.payload.docId !== doc.id) return route.continue();
      await pending.promise;
      await route.fulfill({ json: { translations: { [passageId]: translation } } });
    });
    try {
      await pendingBlock.getByRole('button', { name: /Use passage/ }).press('Enter');
      await card.getByText('Checking saved translations…', { exact: true }).waitFor();
      assert.equal(await card.getByText('Translation for this passage is unavailable.').count(), 0);
    } finally {
      pending.resolve();
    }
    await card.getByText(translation, { exact: true }).waitFor();
    console.log('Original, comparison dock, mobile language persistence, page jump, keyboard and touch selection, saved-source return, and translation status passed.');
  } finally {
    await browser.close();
  }
});
