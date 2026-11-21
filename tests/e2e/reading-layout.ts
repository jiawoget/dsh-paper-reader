import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import { openReader, withHost } from './host.js';
import { idleDensity } from './idle-density.js';

const filename = process.argv[2];
const title = filename ? path.basename(filename) : 'PagedAttention.pdf';
const bytes = await readFile(filename ?? new URL('../../public/assets/pagedattention.pdf', import.meta.url));
const pageNumber = filename ? 2 : 6;
const example = filename ? 'p2-b3' : 'block-tables';

async function rasterMetrics(page: Page) {
  return page.locator('.pdf-raster').evaluateAll(nodes => nodes.map(node => {
    const canvas = node as HTMLCanvasElement;
    const displayed = canvas.getBoundingClientRect();
    return { side: canvas.closest<HTMLElement>('[data-pdf-side]')?.dataset.pdfSide,
      cssWidth: displayed.width, backingWidth: canvas.width, backingHeight: canvas.height,
      ratio: canvas.width / displayed.width, dpr: window.devicePixelRatio };
  }));
}

const box = async (locator: Locator) => { const rect = await locator.boundingBox(); assert.ok(rect); return rect; };
async function drag(page: Page, locator: Locator, dx: number, dy = 0): Promise<void> {
  const rect = await box(locator), x = rect.x + rect.width / 2, y = rect.y + Math.min(rect.height / 2, 30);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 }); await page.mouse.up();
}
async function selectText(run: Locator): Promise<void> {
  await run.scrollIntoViewIfNeeded();
  await run.evaluate(el => {
    const node = el.firstChild as Text;
    document.getSelection()!.setBaseAndExtent(node, 0, node, Math.min(11, node.length));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  });
}

async function notebookLayouts(page: Page): Promise<void> {
  const rail = page.locator('#rail'), paper = page.locator('#paperScroll');
  const editor = rail.getByRole('textbox', { name: 'Notebook Markdown' });
  const show = page.getByRole('button', { name: 'Show notebook' });
  const close = rail.getByRole('button', { name: 'Close notebook' });
  await page.getByRole('button', { name: 'Bilingual', exact: true }).click();
  await show.click();
  const workspace = await box(page.locator('.workspace')), right = await box(rail), frame = await box(page.locator('#reader'));
  assert.ok(right.x >= workspace.x + workspace.width && right.height >= workspace.height - 1,
    'The notebook stays docked on the chosen side in bilingual mode.');
  const grip = page.getByRole('separator', { name: 'Resize notebook' });
  assert.equal(await grip.getAttribute('aria-orientation'), 'vertical');
  await grip.press('ArrowLeft');
  assert.ok((await box(rail)).width >= right.width + 18);

  await editor.click();
  await editor.press('Control+End');
  await editor.press('End');
  await page.keyboard.insertText(' draft ending');
  await editor.press('Shift+ArrowLeft');
  const editorNode = await editor.elementHandle();
  const selected = () => page.evaluate(() => document.getSelection()?.toString());
  assert.equal(await selected(), 'g');
  await page.getByLabel('Zoom').selectOption('2');
  const position = await paper.evaluate(node => {
    node.scrollTop = 120;
    return node.scrollTop / document.querySelector('#original')!.scrollHeight;
  });
  assert.ok(position > 0);
  const positionControl = rail.getByRole('combobox', { name: 'Notebook position' });
  await positionControl.selectOption('float');
  const floated = await box(rail);
  assert.ok(floated.width < workspace.width * .65 && floated.y < workspace.height);
  assert.ok(Math.abs(position - await paper.evaluate(node =>
    node.scrollTop / document.querySelector('#original')!.scrollHeight)) < .005);
  const handle = rail.getByRole('heading', { name: 'Notebook', exact: true });
  await drag(page, handle, 500, 900);
  const bounded = await box(rail);
  assert.ok(Math.abs(bounded.x + bounded.width - frame.width) <= 1 && Math.abs(bounded.y + bounded.height - frame.height) <= 1);
  await drag(page, handle, floated.x - bounded.x, floated.y - bounded.y);
  await drag(page, handle, -90, 30);
  const moved = await box(rail);
  assert.ok(Math.abs(moved.x - floated.x + 90) < 2 && Math.abs(moved.y - floated.y - 30) < 2);
  await handle.press('ArrowLeft');
  await handle.press('ArrowUp');
  const nudged = await box(rail);
  assert.ok(nudged.x < moved.x && nudged.y < moved.y);
  await editor.focus();
  assert.equal(await selected(), 'g', 'Moving the notebook keeps the editor selection.');
  await close.click();
  assert.ok(await show.evaluate(node => node === document.activeElement));
  await show.click();
  assert.deepEqual(await box(rail), nudged);
  assert.ok(await editorNode!.evaluate(node => node.isConnected));
  await handle.press('Escape');
  assert.ok(await rail.isHidden());
  await show.press('Enter');
  await page.setViewportSize({ width: 390, height: 740 });
  await positionControl.waitFor({ state: 'hidden' });
  for (const viewport of [{ width: 390, height: 740 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const sheet = await box(page.getByRole('dialog', { name: 'Reading notebook' }));
    assert.ok(Math.abs(sheet.width - viewport.width) <= 1 && Math.abs(sheet.y + sheet.height - viewport.height) <= 1);
    const dismiss = await box(close);
    assert.ok(sheet.y > 0 && dismiss.y >= sheet.y, JSON.stringify({ viewport, sheet, dismiss }));
    assert.ok(await editorNode!.evaluate(node => node.isConnected));
    await close.press('Escape');
    assert.ok(await show.evaluate(node => node === document.activeElement));
    await show.press('Enter');
    assert.ok(await close.evaluate(node => node === document.activeElement));
    await close.press('Shift+Tab');
    assert.ok(await rail.evaluate(node => node.contains(document.activeElement)));
  }
  await page.setViewportSize({ width: 1000, height: 800 });
  await positionControl.waitFor();
  await page.reload();
  await positionControl.waitFor();
  assert.deepEqual(await box(rail), nudged);
  await positionControl.selectOption('right');
  await editor.waitFor();
  assert.ok((await editor.innerText()).includes('draft ending'));
  await close.click();
  await page.getByLabel('Zoom').selectOption('1');
  await page.getByRole('button', { name: 'Original', exact: true }).click();
}

async function dragWord(page: Page, run: Locator, word: string): Promise<string> {
  await run.scrollIntoViewIfNeeded();
  const glyphs = await run.evaluate((el, word) => {
    const node = el.firstChild as Text, index = node.data.toLowerCase().indexOf(word);
    if (index < 0) throw new Error('Missing test word ' + word);
    const range = document.createRange();
    range.setStart(node, index); range.setEnd(node, index + word.length);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2, selected: range.toString() };
  }, word);
  await page.mouse.move(glyphs.left + .1, glyphs.y); await page.mouse.down();
  await page.mouse.move(glyphs.right - .1, glyphs.y, { steps: 12 }); await page.mouse.up();
  return glyphs.selected;
}

async function chatDuringFirstPaint(page: Page, run: Locator, word: string, previousAnchor: string): Promise<void> {
  // Hold the real PDF.js graphics worker while text extraction and native selection run normally.
  const gate = Promise.withResolvers<void>();
  let waiting = false;
  await page.context().route('**/vendor/pdf.renderer.mjs', async route => {
    waiting = true;
    await gate.promise;
    await route.continue();
  }, { times: 1 });
  await page.evaluate(anchor => {
    const url = new URL(location.href);
    url.searchParams.set('anchor', anchor);
    history.replaceState(null, '', url);
  }, previousAnchor);
  const selection = page.locator('#card .selection-main'), chat = page.locator('#card .selection-chat');
  const composer = chat.getByLabel('Message about this selection'), mark = page.locator('#original .pdf-quote-mark').first();
  const draft = 'I started this question before the PDF finished drawing.';
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await run.waitFor();
    assert.ok(waiting, 'The graphics worker must be waiting while selectable text is mounted.');
    assert.equal(await page.locator('#original canvas').evaluate(node => (node as HTMLCanvasElement).width), 1);
    assert.notEqual(await run.evaluate(node => getComputedStyle(node).color), 'rgba(0, 0, 0, 0)',
      'Source glyphs must be readable before artwork is available.');
    const picked = await dragWord(page, run, word);
    await selection.getByRole('heading', { name: picked, exact: true }).waitFor({ timeout: 3500 });
    await mark.waitFor();
    await selection.getByRole('button', { name: 'Ask AI' }).click();
    await composer.pressSequentially(draft);
    const liveCard = await selection.elementHandle(), liveChat = await chat.elementHandle();
    const originalMark = await box(mark);
    assert.equal(await composer.inputValue(), draft);
    assert.ok(await page.locator('#loading').isVisible());
    assert.equal(await page.locator('#original canvas').evaluate(node => (node as HTMLCanvasElement).width), 1);
    gate.resolve();
    await page.locator('#loading').waitFor({ state: 'hidden' });
    assert.ok(await page.locator('#original canvas').evaluate(node => (node as HTMLCanvasElement).width > 1));
    assert.ok(await liveCard!.evaluate(node => node.isConnected) && await liveChat!.evaluate(node => node.isConnected));
    assert.equal(await composer.inputValue(), draft);
    assert.ok(await composer.evaluate(node => document.activeElement === node));
    const paintedMark = await box(mark);
    assert.ok(Math.abs(paintedMark.x-originalMark.x)<1 && Math.abs(paintedMark.y-originalMark.y)<1 &&
      Math.abs(paintedMark.width-originalMark.width)<1 && Math.abs(paintedMark.height-originalMark.height)<1);
    assert.equal(await run.evaluate(node => getComputedStyle(node).color), 'rgba(0, 0, 0, 0)');
    assert.equal(new URL(page.url()).searchParams.get('anchor'), null);
    await selection.getByRole('button', { name: 'Close passage workspace' }).click();
    await selection.getByRole('button', { name: 'Close selection' }).click();
  } finally { gate.resolve(); }
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(host.authenticatedUrl);
    const result = await context.request.post(host.origin + '/api/paper-reader/import-pdf?title=' + encodeURIComponent(title), {
      headers: { 'Content-Type': 'application/pdf' }, data: bytes
    });
    assert.equal(result.status(), 200);
    const { doc } = await result.json() as { doc: { id: string } };
    const id = doc.id;
    if (filename) assert.equal(id, 'pdf-' + createHash('sha256').update(bytes).digest('hex'));
    if (filename) {
      const translations = path.join(host.scratch, 'reader', 'translations', id);
      await mkdir(translations, { recursive: true });
      await copyFile(new URL('../fixtures/resnet-selection-page-2.zh-CN.json', import.meta.url), path.join(translations, '2.json'));
    }
    const destination = filename ? path.join(host.artifacts, 'reviews', 'reading-desk') : path.join(host.scratch, 'review');
    await mkdir(destination, { recursive: true });
    await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=' + id + '&page=' + pageNumber);
    await page.locator('#original .pdf-native-text span[data-block-id]').first().waitFor();
    await page.getByText('Opening document…', { exact: true }).waitFor({state:'hidden'});
    const reader = page.locator('#reader'), original = reader.locator('#original'), translated = reader.locator('#translated');
    const rail = reader.locator('#rail');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.ok((await box(original)).width >= 720 && await translated.isHidden());
    assert.ok(await rail.isHidden());
    await notebookLayouts(page);
    await page.getByRole('button', { name: 'Bilingual', exact: true }).click();
    await page.getByLabel('Translation scope').selectOption('page');
    await translated.locator('.pdf-translated-text[data-block-id="'+example+'"]').waitFor();
    await page.waitForFunction(() => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.pdf-raster')];
      return canvases.length === 2 && canvases.every(canvas => {
        const physicalWidth = canvas.getBoundingClientRect().width * devicePixelRatio;
        return physicalWidth > 0 && canvas.width >= physicalWidth - 1 && canvas.width <= physicalWidth * 1.12;
      });
    });
    const initial = await rasterMetrics(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForFunction(() => document.querySelector('.pdf-raster')!.getBoundingClientRect().width > 650);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLCanvasElement>('.pdf-raster')].every(canvas =>
      canvas.width >= canvas.getBoundingClientRect().width * devicePixelRatio - 2), { }, { timeout: 8000 }).catch(async () => {
      throw new Error('Resizing left stale PDF pixels: ' + JSON.stringify({ initial, enlarged: await rasterMetrics(page) }));
    });
    const enlarged = await rasterMetrics(page);
    assert.ok(enlarged.every((canvas, index) => canvas.backingWidth > initial[index].backingWidth));
    await page.screenshot({ path: path.join(destination, 'pdf-resolution.png'), scale: 'device' });
    const liveRun = page.locator('#original .pdf-native-text [data-block-id="'+example+'"]').first();
    const originalNode = await liveRun.elementHandle();
    await page.getByLabel('Zoom').selectOption('1.5');
    await page.waitForFunction(old => {
      const canvas = document.querySelector<HTMLCanvasElement>('#original .pdf-raster')!;
      return canvas.width > old * 1.45 && canvas.width >= canvas.getBoundingClientRect().width * devicePixelRatio - 2;
    }, enlarged[0].backingWidth, { timeout: 6500 }).catch(async () => {
      throw new Error('Zoom did not resolve: ' + JSON.stringify({ enlarged, zoomed: await rasterMetrics(page),
        style: await page.locator('.pages').getAttribute('style'), mode: await page.locator('#translated .pdf-sheet').getAttribute('data-focus'), failures }));
    });
    const zoomed = await rasterMetrics(page);
    assert.ok(await originalNode!.evaluate(node => node.isConnected), 'Rerendering must preserve real PDF text and its selection ranges.');
    await writeFile(path.join(destination, 'pdf-resolution.json'), JSON.stringify({ document: title, page: pageNumber, initial, enlarged, zoomed }, null, 2));
    await page.getByLabel('Zoom').selectOption('1');

    await page.getByRole('button', { name: 'Show notebook' }).click();
    await rail.waitFor();
    const before = await box(original), oldRail = await box(rail);
    await drag(page, page.getByRole('separator', { name: 'Resize original and translation' }), 125);
    assert.ok((await box(original)).width > before.width + 110);
    await drag(page, page.getByRole('separator', { name: 'Resize notebook' }), -85);
    const sizedRail = await box(rail), sizedSource = await box(original);
    assert.ok(sizedRail.width > oldRail.width + 77);
    await page.reload(); await liveRun.waitFor();
    assert.ok(Math.abs(sizedRail.width - (await box(rail)).width) < 2 && Math.abs(sizedSource.width - (await box(original)).width) < 2);
    await page.screenshot({ path: path.join(destination, 'resizable-panes.png'), scale: 'css' });

    const sourceRuns = page.locator('#original .pdf-native-text span[data-block-id]');
    const sides = await sourceRuns.evaluateAll((runs, example) => {
      const frame = document.querySelector('#original')!.getBoundingClientRect();
      return [false, true].map(right => {
        if (!right) return example;
        const run = runs.find(el => el.textContent!.trim().length > 20 && el.getBoundingClientRect().top > frame.top + 30 &&
          ((el.getBoundingClientRect().left - frame.left) / frame.width > .5) === right &&
          document.querySelector('#translated .pdf-translated-text[data-role="paragraph"][data-block-id="'+ (el as HTMLElement).dataset.blockId + '"]:not([hidden])'));
        if (!run) throw new Error('Missing printed column.');
        return (run as HTMLElement).dataset.blockId!;
      });
    }, example);
    const right = sourceRuns.filter({ hasText: /./ }).and(page.locator('[data-block-id="'+sides[1]+'"]')).first();
    const left = page.locator('#original .pdf-native-text span[data-block-id="'+sides[0]+'"]').first();
    await page.getByLabel('Translation scope').selectOption('column');
    await left.click();
    await page.getByText('Left printed column', { exact: true }).waitFor();
    await right.click();
    await page.getByText('Right printed column', { exact: true }).waitFor();
    assert.ok(await left.isVisible() && await right.isVisible(), 'The whole source page must remain visible.');
    await page.screenshot({ path: path.join(destination, 'active-printed-column.png'), scale: 'css' });
    await page.getByLabel('Translation scope').selectOption('passage');
    await left.evaluate(el => {
      const text = el.firstChild as Text;
      document.getSelection()!.collapse(text, 1);
    });
    const focus = page.locator('#translated .pdf-translated-text:visible');
    await page.waitForFunction(id => document.querySelector('#translated [data-active-block]')?.getAttribute('data-active-block') === id, sides[0]);
    assert.equal(await focus.count(), 1);
    assert.equal(await focus.getAttribute('data-block-id'), sides[0]);
    assert.ok(await focus.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    await page.screenshot({ path: path.join(destination, 'active-passage.png'), scale: 'css' });
    const word = filename ? 'residual' : 'physical';
    const run = page.locator('#original .pdf-native-text span[data-block-id="'+sides[0]+'"]').filter({ hasText: word }).first();
    await chatDuringFirstPaint(page, run, word, sides[1]);
    await focus.waitFor();
    assert.equal(await page.getByLabel('Translation scope').inputValue(), 'passage');
    assert.equal(await focus.getAttribute('data-block-id'), sides[0]);

    const picked = await dragWord(page, run, word);
    const selection = page.locator('#card .selection-main'), dock = reader.locator('#selectionDock');
    const ask = selection.getByRole('button', { name: 'Ask AI' });
    const write = selection.getByRole('button', { name: 'Write note' });
    const question = dock.getByRole('textbox', { name: 'Message about this selection' });
    const note = dock.getByRole('textbox', { name: 'Your note' });
    const mark = original.locator('.pdf-quote-mark').first();
    await selection.getByRole('heading', { name: picked, exact: true }).waitFor();
    await mark.waitFor();
    await ask.click();
    await question.fill('Which feature is preserved?');
    const unobstructed = await mark.evaluate(mark => {
      const r = mark.getBoundingClientRect();
      return Boolean(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#original'));
    });
    assert.ok(unobstructed, 'The shared dock must leave the selected text exposed.');
    assert.ok((await box(dock)).y >= (await box(reader.locator('#paperScroll'))).y + (await box(reader.locator('#paperScroll'))).height - 1);
    await write.click();
    await note.fill('Keep this draft with the selected phrase.');
    assert.ok(await question.isHidden());
    await ask.click();
    assert.equal(await question.inputValue(), 'Which feature is preserved?');
    assert.ok(await note.isHidden());
    await page.screenshot({ path: path.join(destination, 'shared-passage-dock.png'), scale: 'css' });
    await dock.getByRole('button', { name: 'Close chat' }).click();
    await question.waitFor({ state: 'hidden' });
    assert.ok(await dock.isVisible(), 'Closing chat should return to the comparison strip.');
    assert.ok(await ask.evaluate(el => document.activeElement === el));
    assert.ok(await mark.isVisible());
    await write.press('Enter');
    assert.equal(await note.inputValue(), 'Keep this draft with the selected phrase.');
    await note.press('Escape');
    await note.waitFor({ state: 'hidden' });
    assert.ok(await dock.isVisible(), 'Closing the note should return to the comparison strip.');
    assert.ok(await write.evaluate(el => document.activeElement === el));
    assert.ok(await mark.isVisible());
    await selection.getByRole('button', { name: 'Close selection' }).click();
    await mark.waitFor({ state: 'hidden' });
    assert.ok(await reader.locator('#paperScroll').evaluate(el => document.activeElement === el));
    await page.getByLabel('More actions').click();
    await page.getByRole('button', { name: 'Reset reading layout' }).click();
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.ok(await translated.isHidden() && await rail.isHidden());
    await page.getByRole('button', { name: 'Bilingual', exact: true }).click();
    assert.equal(await page.getByLabel('Translation scope').inputValue(), 'page');
    assert.ok(Math.abs((await box(original)).width - (await box(translated)).width) < 2);

    const laptops = [];
    for (const size of [{ width: 1280, height: 720, dpr: 1.5 }, { width: 1536, height: 864, dpr: 1.25 }]) {
      const laptop = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dpr, locale: 'en-US' });
      const embedded = await laptop.newPage();
      const frame = await openReader(embedded, host.authenticatedUrl);
      const desk = frame.locator('#reader'), showNotebook = frame.getByRole('button', { name: 'Show notebook' });
      assert.equal(await desk.getAttribute('data-reading-mode'), 'source');
      assert.ok((await box(frame.locator('#original'))).width >= 720 && await frame.locator('#translated').isHidden());
      assert.equal(await desk.getAttribute('data-notebook-open'), 'false');
      await frame.getByRole('button', { name: 'Bilingual', exact: true }).click();
      assert.equal(await frame.getByLabel('Translation scope').inputValue(), 'column');
      await showNotebook.click();
      await frame.locator('#original .pdf-native-text [data-block-id="iteration-compute"]').first().click();
      await frame.getByText('Right printed column', { exact: true }).waitFor();
      const dimensions = await desk.evaluate(el => {
        const original = el.querySelector('#original')!.getBoundingClientRect(), target = el.querySelector('#translated')!.getBoundingClientRect();
        const action = el.querySelector('#more')!.getBoundingClientRect();
        return { iframe: innerWidth, original: original.width, translation: target.width, buttonsInFrame: action.right <= innerWidth,
          overflow: document.documentElement.scrollWidth - innerWidth, notesOpen: el.getAttribute('data-notebook-open') };
      });
      assert.ok(dimensions.iframe < size.width && dimensions.original > 400 && dimensions.translation > 220 && dimensions.buttonsInFrame && dimensions.overflow <= 1);
      if (size.width === 1280) {
        await frame.getByRole('tab', { name: 'Notes', exact: true }).waitFor();
        const notebook = frame.locator('#rail'), start = (await box(notebook)).width;
        const grip = frame.getByRole('separator', { name: 'Resize notebook' });
        await drag(embedded, grip, -45);
        assert.ok((await box(notebook)).width >= start + 40);
        await grip.press('ArrowRight');
        assert.ok(Math.abs((await box(notebook)).width - start - 25) < 3);
        const guide = frame.getByText('Reading guide', { exact: true });
        await guide.click();
        const link = frame.getByRole('button', { name: 'p. 6 · Left column', exact: true });
        await link.click();
        assert.ok(await notebook.isVisible());
        await selectText(frame.locator('#original .pdf-native-text [data-block-id="iteration-compute"]').first());
        await frame.getByRole('button', { name: 'Close selection' }).click();
      }
      const actual = await frame.locator('.pdf-raster').first().evaluate(async () => {
        const deadline = performance.now() + 8000;
        for (;;) {
          const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.pdf-raster')];
          const ratios = canvases.map(canvas => canvas.width / canvas.getBoundingClientRect().width);
          if (ratios.length === 2 && ratios.every(ratio => ratio >= devicePixelRatio - .005)) return ratios;
          if (performance.now() > deadline) throw new Error('Embedded rasters remained below display density: ' + ratios);
          await new Promise(requestAnimationFrame);
        }
      });
      await embedded.screenshot({ path: path.join(destination, 'laptop-'+size.width+'.png'), scale: 'device' });
      laptops.push({ ...size, ...dimensions, canvasPixelsPerCssPixel: actual });
      if (size.width === 1536) {
        const visibleReader = embedded.frames().find(candidate => candidate.url().includes('/api/paper-reader/app/index.html'));
        assert.ok(visibleReader);
        await visibleReader.goto(host.origin + '/api/paper-reader/app/index.html?doc=' + id + '&page=' + pageNumber);
        const density = await idleDensity(embedded, visibleReader);
        await writeFile(path.join(destination, 'idle-density.json'), JSON.stringify({ paper: title, page: pageNumber, ...density }, null, 2));
      }
      await laptop.close();
    }
    await writeFile(path.join(destination, 'laptop-layouts.json'), JSON.stringify(laptops, null, 2));
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
});
