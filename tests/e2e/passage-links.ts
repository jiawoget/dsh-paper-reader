import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import type { DocumentInfo, NotebookSnapshot } from '../../src/shared/types.js';
import { cardMoreAction } from './helpers/reader.js';
import { withHost } from './host.js';
import { modelFixture } from './integration-fixtures.js';
import { dragAnswer } from './selection-gestures.js';
import { markdownLinks, vaultSource, visibleMarkdown } from './vault-links.js';

const actualPaper = process.argv[2];
const referenceTitles = ['Pattern recognition and neural networks', 'Modern applied statistics with s-plus'];
const training = 'more difficult to train', shortcut = 'input to the output [34, 49]';
const header = '| Topic | Reading note |', firstRow = '| Training | Compare  with the baseline. |',
  secondRow = '| Shortcut | See  for the earlier method. |';
const prose = 'Compare this translation with the source.';
const table = [prose, '', header, '| --- | --- |', firstRow, secondRow].join('\n');

async function glyph(run: Locator, value: string): Promise<{ x: number; y: number }> {
  await run.scrollIntoViewIfNeeded();
  return run.evaluate((element, text) => {
    const node = element.firstChild as Text, start = node.data.indexOf(text);
    if (start < 0) throw Error('The printed citation could not be found.');
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, start + text.length);
    const r = range.getClientRects()[0];
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, value);
}

async function select(run: Locator, text: string): Promise<void> {
  await run.scrollIntoViewIfNeeded();
  await run.evaluate((element, value) => {
    const node = element.firstChild as Text, from = node.data.indexOf(value);
    if (from < 0) throw Error('The selected passage was missing from its PDF text run.');
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(node, from, node, from + value.length);
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  }, text);
}

async function caret(page: Page, rail: Locator, row: string, offset: number): Promise<void> {
  await rail.locator('.cm-line').filter({ hasText: row }).click();
  await page.keyboard.press('Home');
  for (let n = 0; n < offset; n++) await page.keyboard.press('ArrowRight');
}

async function followPassage(page: Page, link: Locator): Promise<URL> {
  const href = new URL((await link.getAttribute('href'))!);
  await link.click();
  // The previous sheet and its markers stay visible until PDF.js finishes rendering the destination.
  await page.waitForURL(url => url.pathname === href.pathname &&
    Array.from(href.searchParams).every(([key, value]) => url.searchParams.get(key) === value));
  await page.locator('#loading').waitFor({ state: 'hidden' });
  const pane = href.searchParams.has('targetQuote') ? '#translated' : '#original';
  await page.locator(pane + ' .pdf-sheet[aria-label$=", page ' + href.searchParams.get('page') + '"] .pdf-quote-mark').first().waitFor();
  return href;
}

async function exactMarker(run: Locator, value: string, pane: string): Promise<boolean> {
  return run.evaluate((element, { text, pane }) => {
    const node = element.firstChild as Text, start = node.data.indexOf(text);
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, start + text.length);
    const expected = Array.from(range.getClientRects()).filter(r => r.width > .4);
    const marks = Array.from(document.querySelectorAll(pane + ' .pdf-quote-mark'), marker => marker.getBoundingClientRect());
    return expected.length > 0 && expected.every(r => marks.some(m =>
      Math.abs(r.left - m.left) < 2 && Math.abs(r.width - m.width) < 2 && Math.abs(r.top - m.top) < 2));
  }, { text: value, pane });
}

async function draftReview(page: Page, run: Locator, endpoint: string, directory: string): Promise<void> {
  const answer = 'A **residual block** passes the input along a shortcut while its layers learn the change to that input. ' +
    'The two paths meet at \\(y=x+F(x)\\). The paper cites [34, 49] for earlier uses of input-to-output connections.';
  const model = await modelFixture(answer, shortcut);
  try {
    const settings = await page.request.post(endpoint, { data: { op: 'settings.save',
      payload: { baseUrl: model.origin + '/v1', apiKey: model.key, model: model.model } } });
    assert.ok(settings.ok());
    await page.reload();
    await select(run, shortcut);
    const card = page.locator('#card');
    const dock = page.getByRole('region', { name: 'Passage workspace', exact: true });
    const ask = card.getByRole('button', { name: 'Ask AI', exact: true });
    const write = card.getByRole('button', { name: 'Write note', exact: true });
    await ask.click();
    await dock.waitFor();
    const question = card.getByRole('textbox', { name: 'Message about this selection' });
    assert.ok(await question.evaluate(node => node === document.activeElement));
    await question.fill('What does a residual block do with the input?');
    await question.press('Enter');
    const excerpt = card.locator('.selection-answer strong').getByText('residual block', { exact: true });
    await excerpt.waitFor();
    assert.equal(model.completed(), 1);
    assert.equal(await card.getByRole('button', { name: 'Translate to Chinese' }).count(), 0);
    await page.screenshot({ path: path.join(directory, 'selection-chat.png'), animations: 'disabled' });
    await write.click();
    const editor = card.getByRole('textbox', { name: 'Your note', exact: true });
    await editor.fill('This block preserves the input through a shortcut.');
    const points = await editor.evaluate((node: HTMLTextAreaElement) => {
      const style = getComputedStyle(node), measure = document.createElement('canvas').getContext('2d')!;
      const rect = node.getBoundingClientRect(), left = rect.left + node.clientLeft + parseFloat(style.paddingLeft);
      measure.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
      return { from: left + measure.measureText('This ').width + .2, to: left + measure.measureText('This block').width - .2,
        y: rect.top + node.clientTop + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2 };
    });
    await page.mouse.move(points.from, points.y); await page.mouse.down();
    await page.mouse.move(points.to, points.y, { steps: 8 }); await page.mouse.up();
    assert.equal(await editor.evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionEnd)), 'block');
    const pick = () => dragAnswer(page, excerpt);
    await ask.click();
    await pick();
    const insert = card.getByRole('button', { name: 'Insert into note' });
    await insert.click();
    assert.equal(await editor.inputValue(), 'This residual block preserves the input through a shortcut.');
    await editor.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(5, 19); });
    await card.getByRole('button', { name: 'Save note', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, 'selection-draft-excerpts.png'), animations: 'disabled' });
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await card.getByRole('button', { name: 'Close passage workspace', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await card.getByRole('button', { name: 'Close selection', exact: true }).waitFor();
    assert.ok(await write.evaluate(node => node === document.activeElement), 'Closing the workspace should return focus to the note action.');
    assert.ok(await exactMarker(run, shortcut, '#original'), 'Closing the workspace should retain the selected PDF passage.');
    await ask.click();
    await excerpt.waitFor();
    assert.equal(model.completed(), 1, 'Reopening the passage workspace should restore the existing answer.');
    await pick(); await insert.click();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), 'residual block');
    await card.getByRole('button', { name: 'Save note', exact: true }).click();
    await card.getByText('Note saved.', { exact: true }).waitFor();
  } finally { await model.close(); }
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1580, height: 945 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12_000);
    await page.goto(host.authenticatedUrl);
    let bytes: Buffer;
    if (actualPaper) bytes = await readFile(actualPaper);
    else {
      const fixture = await context.newPage();
      await fixture.setContent('<style>@page{size:letter;margin:1in}article+article{break-before:page}p{font:14px Georgia}</style>' +
        '<article><h1>Residual learning</h1><p>Deeper neural networks are more difficult to train.</p></article>' +
        '<article><h1>Shortcut connections</h1><p>Connect the input to the output [34, 49]. This comparison also cites [34–36].</p></article>' +
        '<article><h1>References</h1><p>[34] B. D. Ripley. Pattern recognition and neural networks. Cambridge university press, 1996.</p>' +
        '<p>[35] A. Romero. 2015. Hints for thin deep nets. In ICLR.</p><p>[36] A. Researcher. 2014. A comparison of networks. In CVPR.</p>' +
        '<p>[49] W. Venables and B. Ripley. Modern applied statistics with s-plus. 1999.</p></article>');
      bytes = await fixture.pdf({ preferCSSPageSize: true });
      await fixture.close();
    }
    const title = actualPaper ? path.basename(actualPaper) : 'Residual learning and shortcut connections.pdf';
    const imported = await context.request.post(host.origin + '/api/paper-reader/import-pdf?title=' + encodeURIComponent(title),
      { headers: { 'Content-Type': 'application/pdf' }, data: bytes });
    assert.ok(imported.ok());
    const { doc } = await imported.json() as { doc: DocumentInfo };
    const vault = path.join(host.scratch, 'Passage notebook');
    const cache = path.join(host.scratch, 'reader', 'translations', doc.id);
    await Promise.all([mkdir(vault), mkdir(cache, { recursive: true })]);
    await context.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'settings.save', payload: { vaultPath: vault } } });
    if (actualPaper) {
      await copyFile(new URL('../fixtures/resnet-selection-page-2.zh-CN.json', import.meta.url), path.join(cache, '2.json'));
    } else {
      await writeFile(path.join(cache, '2.json'), JSON.stringify({
        'p2-b1': '捷径连接', 'p2-b2': '将输入连接到输出 [34, 49]。这一比较还引用了 [34–36]。'
      }));
    }
    const address = host.origin + '/api/paper-reader/app/index.html?doc=' + doc.id;
    await page.goto(address + '&page=1');
    await page.getByRole('button', { name: 'Show notes', exact: true }).click();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    const rail = page.getByRole('textbox', { name: 'Notes Markdown' });
    const card = page.locator('#card');
    const run = (value: string) => page.locator('#original .pdf-native-text [data-block-id]').filter({ hasText: value }).first();
    await run(training).waitFor();
    await rail.click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
    await page.keyboard.insertText(table);
    await caret(page, rail, firstRow, firstRow.indexOf(' with'));
    await select(run(training), training);
    await cardMoreAction(card, 'Insert passage link');
    const links = rail.locator('a.notebook-passage-link');
    await links.first().waitFor();
    assert.equal(await links.nth(0).innerText(), 'p. 1 · ' + training);
    await card.getByRole('button', { name: 'Close selection' }).click();
    await caret(page, rail, secondRow, secondRow.indexOf(' for the'));
    await page.getByRole('button', { name: 'Next page' }).click();
    const paperRun = run(shortcut);
    const tooltip = page.locator('.citation-preview');
    const checkTitles = async () => {
      for (const title of referenceTitles) await tooltip.getByText(title, { exact: true }).waitFor();
      assert.equal(await tooltip.locator('li').count(), 2);
    };
    await paperRun.waitFor();
    await page.getByRole('button', { name: 'Bilingual', exact: true }).click();
    await page.getByRole('button', { name: 'Bilingual', exact: true, pressed: true }).waitFor();
    const firstCite = page.locator('#original .pdf-citation-focus').filter({ visible: true }).first();
    await firstCite.waitFor();
    const citeBox = (await firstCite.boundingBox())!;
    assert.ok(citeBox.width >= 23.5 && citeBox.height >= 23.5);
    await firstCite.focus();
    await tooltip.locator('.citation-actions button').first().waitFor();
    await page.keyboard.press('Tab');
    assert.ok(await tooltip.evaluate(node => node.contains(document.activeElement)));
    await page.keyboard.press('Escape');
    await tooltip.waitFor({ state: 'hidden' });
    assert.ok(await firstCite.evaluate(node => node === document.activeElement));
    const printed = await glyph(paperRun, '[34, 49]');
    await page.mouse.move(printed.x, printed.y);
    await checkTitles();
    await firstCite.click();
    await tooltip.getByRole('button', { name: 'Copy', exact: true }).first().waitFor();
    const jumpRef = tooltip.getByRole('button', { name: /^Jump to References \(p\. \d+\)$/ }).first();
    await jumpRef.click();
    await tooltip.waitFor({ state: 'hidden' });
    await page.locator('#jumpBack').click();
    await paperRun.waitFor();
    const directory = path.join(host.artifacts, 'reviews', 'reading-desk');
    await mkdir(directory, { recursive: true });
    if (actualPaper) await page.screenshot({ path: path.join(directory, 'numbered-reference-preview.png'), animations: 'disabled' });
    const target = page.locator('#translated .pdf-translated-text').filter({ hasText: '[34, 49]' }).first();
    const chinese = await glyph(target, '[34, 49]');
    await page.mouse.move(chinese.x, chinese.y);
    await checkTitles();
    if (!actualPaper) {
      const group = page.locator('#translated').getByRole('button', { name: 'References 34, 35, 36', exact: true });
      await group.focus();
      await tooltip.getByText('Hints for thin deep nets', { exact: true }).waitFor();
      await page.setViewportSize({ width: 1590, height: 945 });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.ok(await group.evaluate(node => node === document.activeElement), 'A notebook layout resize preserves keyboard focus on the printed citation.');
      await tooltip.getByText('A comparison of networks', { exact: true }).waitFor();
      assert.equal(await tooltip.locator('li').count(), 3);
    }
    await page.mouse.move(2, 2);
    await select(paperRun, shortcut);
    const cited = card.locator('.selection-excerpt').getByRole('button', { name: 'References 34, 49', exact: true });
    await cited.focus(); await checkTitles();
    await page.keyboard.press('Escape');
    await card.locator('.selection-counterpart summary').click();
    await card.locator('.selection-counterpart').getByRole('button', { name: 'References 34, 49', exact: true }).first().focus();
    await checkTitles();
    await page.keyboard.press('Escape');
    await cardMoreAction(card, 'Insert passage link');
    await links.nth(1).waitFor();
    await page.keyboard.press('Control+z');
    assert.equal(await links.count(), 1, 'Undo removes the second insertion in a single edit.');
    await page.keyboard.press('Control+y'); await links.nth(1).waitFor();
    await page.keyboard.press('Control+s');
    await page.getByText('Saved to vault', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Close selection' }).click();
    if (actualPaper) {
      const splitter = page.getByRole('separator', { name: 'Resize notes' });
      for (let i = 0; i < 4; i++) await splitter.press('ArrowLeft');
      await followPassage(page, links.nth(1));
      assert.ok(await exactMarker(paperRun, shortcut, '#original'));
      await page.screenshot({ path: path.join(directory, 'notebook-inline-passage-links.png'), animations: 'disabled' });
      await splitter.dblclick();
    }
    const snapshot = await (await context.request.post(host.origin + '/api/paper-reader/action', {
      data: { op: 'notebook.get', payload: { docId: doc.id, title: doc.title, sourceUrl: address } }
    })).json() as NotebookSnapshot;
    assert.ok(snapshot.path && snapshot.path.startsWith(vault));
    const raw = await readFile(snapshot.path, 'utf8');
    const rows = visibleMarkdown(raw).split(/\r?\n/u);
    const copied = new Set<string>();
    for (const [i, [topic, quote, suffix]] of [['Training', training, ' with the baseline. |'],
      ['Shortcut', shortcut, ' for the earlier method. |']].entries()) {
      const row = rows.find(line => line.startsWith('| ' + topic + ' |'));
      assert.ok(row && row.endsWith(suffix), 'A passage link must stay inside the original table cell.');
      const destinations = markdownLinks(row);
      assert.equal(destinations.length, 1);
      assert.equal(destinations[0].label, 'p. ' + (i + 1) + ' · ' + quote);
      const copy = vaultSource(vault, snapshot.path, destinations[0].target);
      assert.equal(copy.fragment, 'page=' + (i + 1));
      copied.add(copy.file);
    }
    assert.equal(copied.size, 1, 'Both page links must refer to the same PDF.');
    assert.deepEqual(await readFile([...copied][0]), bytes);
    assert.equal(snapshot.markdown.split(/\r?\n/u).filter(row => /^\[p\d+-[a-f\d]{8}\]: <http/u.test(row)).length, 2);
    await appendFile(snapshot.path, '\nRevisit the shortcut connections in Figure 2.\n');
    await page.reload();
    await rail.getByText('Revisit the shortcut connections in Figure 2.', { exact: true }).waitFor();
    for (const [n, value] of [training, shortcut].entries()) {
      const link = links.nth(n);
      const href = await followPassage(page, link);
      assert.equal(href.searchParams.get('quote'), value);
      assert.equal(href.searchParams.get('page'), String(n + 1));
      assert.ok(href.searchParams.has('rangeStart') && href.searchParams.has('rangeEnd'));
      assert.ok(await exactMarker(run(value), value, '#original'), 'The link must restore its precise printed text.');
    }
    // Replace a remembered notebook selection with a linked Chinese phrase amid free prose.
    await caret(page, rail, prose, prose.indexOf('this translation'));
    for (const _ of 'this translation') await page.keyboard.press('Shift+ArrowRight');
    await select(target, '连接到输出');
    await cardMoreAction(card, 'Insert passage link');
    const proseLink = rail.getByRole('link', { name: 'p. 2 · 连接到输出' });
    await proseLink.waitFor();
    assert.equal(await proseLink.locator('..').innerText(), 'Compare p. 2 · 连接到输出 with the source.');
    assert.equal(await links.count(), 3);
    await page.keyboard.press('Control+s');
    await page.getByText('Saved to vault', { exact: true }).waitFor();
    assert.equal((await followPassage(page, proseLink)).searchParams.get('targetQuote'), '连接到输出');
    assert.ok(await exactMarker(target, '连接到输出', '#translated'));
    if (actualPaper) await draftReview(page, run(shortcut), host.origin + '/api/paper-reader/action', directory);
    assert.deepEqual(errors, []);
    console.log('PASS two exact cross-page notebook links in separate table cells, undo, portable vault Markdown and reload. ' +
      'Verified numbered bibliography hover and keyboard focus on the PDF, translation and selection card. Paper: ' + title);
  } finally { await browser.close(); }
});
