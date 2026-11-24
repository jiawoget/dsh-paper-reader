import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { cardElement, clickCard, openToolbar, until } from './e2e/extension-controls.js';
import type { PageView, SelectionHit } from '../src/shared/types.js';
import type { renderArticle } from '../src/reader/article-view.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const executablePath = [
  process.env.PAPER_READER_TEST_BROWSER, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(p => p && existsSync(p));
const skip = executablePath ? false : 'Set PAPER_READER_TEST_BROWSER to run the Chromium integration tests.';

test('web source and translated selections keep matching paragraph IDs after translation and restoration', { skip }, async t => {
  const result = await build({ entryPoints: [path.join(root, 'src/reader/article-view.ts')], bundle: true, format: 'esm', write: false });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'en-US' });
  await page.route('http://localhost/article.mjs', route => route.fulfill({ contentType: 'text/javascript', body: result.outputFiles[0].text }));
  const css = await readFile(path.join(root, 'public/article-view.css'), 'utf8');
  await page.route('http://localhost/article.css', route => route.fulfill({ contentType: 'text/css', body: css }));
  await page.route('http://localhost/snapshot', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/article.css"><div id="scroll" style="height:275px;overflow:auto"><div style="display:grid;grid-template-columns:1fr 1fr"><main id="src"></main><aside id="tr"></aside></div></div>' }));
  await page.goto('http://localhost/snapshot');
  type ArticleWindow = Window & { model?: PageView; hit?: SelectionHit };
  await page.evaluate(async () => {
    const moduleUrl = '/article.mjs';
    const module: { renderArticle: typeof renderArticle } = await import(moduleUrl);
    const state = window as ArticleWindow;
    state.model = module.renderArticle({
      doc: { id: 'web-1', kind: 'web', title: 'Repository note', paragraphs: ['First.', 'A repeated word.', 'A long paragraph. '.repeat(210) + 'Final location.'] },
      sourceEl: document.querySelector('#src')!, translationEl: document.querySelector('#tr')!,
      translations: {}, zoom: 1.5, onSelect(hit) { state.hit = hit; }
    });
  });
  const source = page.locator('#src [data-anchor="p-2"]');
  const translation = page.locator('#tr [data-anchor="p-2"]');
  assert.equal(await source.innerText(), 'A repeated word.');
  assert.ok(await source.evaluate(row => Number.parseFloat(getComputedStyle(row).fontSize) > 20), 'Web article type did not scale to 150%');
  assert.equal(await translation.innerText(), 'Awaiting translation');
  assert.equal(await page.evaluate(() => (window as ArticleWindow).model!.locate('p-2', 'word')), true);
  assert.equal(await page.evaluate(() => (window as ArticleWindow).model!.locate('p-99')), false);
  await page.evaluate(() => (window as ArticleWindow).model!.setTranslations?.({ 'p-2': 'A translated phrase.' }));
  assert.equal(await translation.innerText(), 'A translated phrase.');
  for (const [target, side] of [[source, 'source'], [translation, 'translation']] as const) {
    const point = await target.evaluate(row => {
      const range = new Range();
      range.selectNodeContents(row.firstElementChild!);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForFunction(side => (window as ArticleWindow).hit?.side === side, side, { timeout: 2500 });
    const hit = await page.evaluate(() => {
      const hit = (window as ArticleWindow).hit!;
      return { id: hit.id, page: hit.page, width: hit.rect.width, context: hit.context, text: hit.text };
    });
    assert.deepEqual([hit.id, hit.page, hit.context], ['p-2', 1, 'A repeated word.']);
    assert.ok(hit.text && hit.width > 0);
  }
  const locationVisible = await page.evaluate(() => {
    (window as ArticleWindow).model!.locate('p-3', 'Final location.');
    const text = document.querySelector('#src [data-anchor="p-3"] p')!.firstChild as Text;
    const range = new Range();
    range.setStart(text, text.data.indexOf('Final location.'));
    range.setEnd(text, text.length);
    const rect = range.getBoundingClientRect();
    const viewport = document.querySelector('#scroll')!.getBoundingClientRect();
    return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
  });
  assert.ok(locationVisible, 'Restoring a quote near the end of a long paragraph must bring the quoted text into view');
  const tintOnReturn = await page.evaluate(() => {
    (window as ArticleWindow).model!.highlight('p-3', false);
    return getComputedStyle(document.querySelector('#src [data-anchor="p-3"]')!).backgroundColor;
  });
  assert.notEqual(tintOnReturn, 'rgba(0, 0, 0, 0)', 'Leaving a source chip after following it must keep the restored paragraph visible');
  const paired = await page.evaluate(async () => {
    const model = (window as ArticleWindow).model!;
    model.setTranslations!({ 'p-1': 'Opening.', 'p-2': 'A translated phrase.' });
    const start = document.querySelector('#src [data-anchor="p-1"] p')!.firstChild!;
    const end = document.querySelector('#src [data-anchor="p-2"] p')!.firstChild!;
    window.getSelection()!.setBaseAndExtent(start, 2, end, 3);
    end.parentElement!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    await new Promise(requestAnimationFrame);
    const hit = (window as ArticleWindow).hit!;
    model.select(hit);
    window.getSelection()!.removeAllRanges();
    return [...CSS.highlights.get('dsh-web-quote') ?? []].map(range => range.toString()).sort();
  });
  assert.deepEqual(paired, ['rst.', 'A r', 'Opening.', 'A translated phrase.'].sort(),
    'Focus may leave the page while exact selected characters and both corresponding paragraphs stay visibly marked.');
  const richSelection = await page.evaluate(async () => {
    const moduleUrl = '/article.mjs';
    const { renderArticle: render }: { renderArticle: typeof renderArticle } = await import(moduleUrl);
    const state = window as ArticleWindow;
    state.model!.dispose?.();
    state.model = render({ doc: { id: 'web-rich', kind: 'web', title: 'Slices', paragraphs: ['Read x2 and len(s) here.'],
      articleLayout: { 'p-1': { kind: 'p', spans: [{ start: 5, end: 7, kind: 'math', value: 'x^2' }, { start: 12, end: 18, kind: 'code' }] } } },
      sourceEl: document.querySelector('#src')!, translationEl: document.querySelector('#tr')!, onSelect(hit) { state.hit = hit; } });
    const paragraph = document.querySelector<HTMLElement>('#src .web-reading-row p')!;
    const end = paragraph.querySelector('code')!.firstChild!;
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 2, end, 6);
    paragraph.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    await new Promise(requestAnimationFrame);
    const selection = { text: state.hit!.text, offset: state.hit!.sourceOffset, anchor: state.hit!.id };
    const restored = state.model!.locate('p-1', 'len(s)');
    return { selection, restored, nativeMath: !!paragraph.querySelector('math msup'),
      highlight: [...CSS.highlights.get('dsh-web-quote') || []].map(range => range.toString()) };
  });
  assert.deepEqual(richSelection, { selection: { text: 'ad x2 and len(s)', offset: 2, anchor: 'p-1' },
    restored: true, nativeMath: true, highlight: ['len(s)'] });
  const captureScript = await build({ entryPoints: [path.join(root, 'src/extension/web-page.ts')], bundle:true, format:'iife', globalName:'WebCapture', write:false });
  const publisher = page;
  await publisher.setContent('<article><h1>Examples</h1><pre><code>len(s)</code></pre><pre><code>len(s)</code></pre></article>');
  await publisher.addScriptTag({content:captureScript.outputFiles[0].text});
  const codePick = await publisher.evaluate(() => {
    const capture = (window as typeof window & {WebCapture:typeof import('../src/extension/web-page.js')}).WebCapture;
    const code = document.querySelectorAll('code')[1].firstChild!;
    getSelection()!.setBaseAndExtent(code,0,code,3);
    return { selected:capture.snapshot(capture.currentPick()), entire:capture.snapshot(null) };
  });
  assert.equal(codePick.selected.anchor, 'p-3', 'A repeated example must point to the code occurrence selected on the live webpage.');
  assert.equal(codePick.selected.label, 'Paragraph 3');
  assert.equal(codePick.entire.label, 'Paragraph 1');
  assert.deepEqual(codePick.selected.article,codePick.entire.article);

  const zhPage = await browser.newPage({ locale: 'zh-CN' });
  await zhPage.setContent('<article><h1>示例</h1><p>第一段。</p><p>第二段。</p></article>');
  await zhPage.addScriptTag({ content: captureScript.outputFiles[0].text });
  const zhPick = await zhPage.evaluate(() => {
    const capture = (window as typeof window & { WebCapture: typeof import('../src/extension/web-page.js') }).WebCapture;
    const para = document.querySelectorAll('p')[1].firstChild!;
    getSelection()!.setBaseAndExtent(para, 0, para, 3);
    return { selected: capture.snapshot(capture.currentPick()), entire: capture.snapshot(null) };
  });
  assert.equal(zhPick.selected.anchor, 'p-3');
  assert.equal(zhPick.selected.label, '第 3 段');
  assert.equal(zhPick.entire.anchor, 'p-1');
  assert.equal(zhPick.entire.label, '第 1 段');
  await zhPage.close();
});


test('a signed-in DSH tab receives user-requested lookups, and saving a quote captures its exact paragraph', { skip, timeout: 40000 }, async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'dsh-reader-browser-'));
  t.after(() => rm(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const extension = path.join(work, 'extension');
  await cp(path.join(root, 'extension'), extension, { recursive: true });
  await build({ entryPoints: ['popup', 'background', 'content'].map(name => path.join(root, 'src/extension', name + '.ts')),
    bundle: true, outdir: extension, format: 'iife', target: 'chrome120' });
  interface Operation { op: string; payload: Record<string, unknown> }
  const records: Operation[] = [];
  let online = false;
  let providerDenied = false;
  let origin = '';
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const operation: Operation = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('content-type', 'application/json');
      if (req.headers.origin !== origin || !req.headers.cookie?.includes('test-signin=active')) {
        res.writeHead(403); res.end('{"error":"Sign in"}'); return;
      }
      records.push(operation);
      if (operation.op === 'ai' && !online) { res.writeHead(503); res.end('{"error":"Configure a model first."}'); }
      else if (operation.op === 'ai' && providerDenied) { res.writeHead(403); res.end('{"error":"Model service denied access. Check the API key and its permissions."}'); }
      else if (operation.op === 'ai') res.end('{"text":"A sample definition."}');
      else if (operation.op === 'web.import') res.end(JSON.stringify({ doc: { id: 'web-53', ...operation.payload } }));
      else res.end('{}');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/paper') {
      res.end('<title>Page selection fixture</title><nav>Menu</nav><article><h1>Source paper</h1><p>A first paragraph.</p><p>The <b id="term">homograph</b> changes in context.</p><p hidden>Invisible</p></article>');
    } else { res.setHeader('set-cookie', 'test-signin=active; HttpOnly; SameSite=Strict; Path=/'); res.end('<title>Local DSH</title>Signed in'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert.ok(typeof address === 'object' && address);
  origin = 'http://127.0.0.1:' + address.port;
  const sourceUrl = 'http://reader-fixture.test:' + address.port + '/paper';
  const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
    executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-proxy-server', '--host-resolver-rules=MAP reader-fixture.test 127.0.0.1']
  });
  try {
    const dsh = context.pages()[0];
    await dsh.goto(origin);
    const cdp = await context.browser()!.newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    const page = await context.newPage();
    await page.goto(sourceUrl);
    const popup = await openToolbar(page, id);
    await popup.click('summary');
    await popup.evaluate(value => { document.querySelector<HTMLInputElement>('#origin')!.value = value; }, origin);
    await popup.click('button[type="submit"]');
    await until(() => popup.evaluate(() => /address was saved|地址已保存/.test(document.querySelector('#message')!.textContent!), null), 'The popup did not save the port');
    await popup.click('#toggle');
    await popup.detach();
    await page.locator('#term').dblclick();
    await until(async () => (await cardElement(page, 'h2'))?.text === 'homograph', 'No card at the selected word');
    assert.equal(records.length, 0);
    const card = await page.locator('[data-dsh-paper-reader]').boundingBox();
    const selected = await page.locator('#term').boundingBox();
    assert.ok(card && selected && Math.abs(card.x - selected.x) < 15 && Math.abs(card.y - selected.y - selected.height) < 20, JSON.stringify({ card, selected, viewport: page.viewportSize() }));
    await clickCard(page, '[data-do="translate"]');
    await until(async () => (await cardElement(page, '.answer'))?.text === 'Configure a model first.', 'Missing configuration was not reported');
    online = true;
    providerDenied = true;
    await clickCard(page, '[data-do="translate"]');
    await until(async () => (await cardElement(page, '.answer'))?.text.includes('API key') === true, 'The card must preserve a model provider credential error');
    providerDenied = false;
    await clickCard(page, '[data-do="translate"]');
    await until(() => records.some(call => call.op === 'history.add'), 'Lookup history was not saved');
    assert.equal(records.some(call => call.op === 'web.import'), false);
    assert.equal(records[0].payload.context, 'The homograph changes in context.');
    await clickCard(page, '[data-do="followup"]');
    await clickCard(page, 'textarea');
    await page.keyboard.insertText('What does this refer to?');
    await clickCard(page, '[data-do="submit"]');
    await until(() => records.some(call => call.payload.question === 'What does this refer to?'), 'Missing follow-up');
    await clickCard(page, '[data-do="vocab"]');
    await until(() => records.some(call => call.op === 'vocab.save'), 'Missing vocabulary entry');
    assert.deepEqual(records.find(call => call.op === 'web.import')?.payload.paragraphs, ['Source paper', 'A first paragraph.', 'The homograph changes in context.']);
    const word = records.find(call => call.op === 'vocab.save')!.payload;
    assert.deepEqual([word.docId, word.anchor, word.text, word.sourceUrl], ['web-53', 'p-3', 'homograph', sourceUrl]);
    await clickCard(page, '[data-do="note"]');
    await clickCard(page, 'textarea');
    await page.keyboard.insertText('Contrast the two readings.');
    await clickCard(page, '[data-do="submit"]');
    await until(() => records.some(call => call.op === 'note.save'), 'Missing note');
    const note = records.find(call => call.op === 'note.save')!.payload;
    assert.deepEqual([note.anchor, note.text, note.quote], ['p-3', 'Contrast the two readings.', 'homograph']);
    const opened = context.waitForEvent('page');
    await clickCard(page, '[data-do="open"]');
    await (await opened).waitForURL(origin + '/api/paper-reader/app/index.html?doc=web-53&page=1&anchor=p-3');
    assert.equal(records.filter(call => call.op === 'web.import').length, 1);
    await page.bringToFront();
    const sentence = page.locator('article p').nth(1);
    const bounds = await sentence.evaluate(paragraph => {
      const range = new Range();
      range.selectNodeContents(paragraph);
      return range.getBoundingClientRect().toJSON();
    });
    const lineY = bounds.top + bounds.height / 2;
    await page.mouse.move(bounds.left + 0.1, lineY);
    await page.mouse.down();
    await page.mouse.move(bounds.right - 0.1, lineY, { steps: 12 });
    await page.mouse.up();
    const phrase = 'The homograph changes in context.';
    await until(async () => (await cardElement(page, 'h2'))?.text === phrase, 'No card for the selected sentence');
    await context.clearCookies({ name: 'test-signin' });
    await clickCard(page, '[data-do="explain"]');
    await until(async () => (await cardElement(page, '.answer'))?.text.includes('sign in') === true, 'The expired session was not reported');
    await dsh.reload();
    await clickCard(page, '[data-do="explain"]');
    await until(() => records.some(call => call.payload.mode === 'explain' && call.payload.text === phrase), 'Missing sentence explanation');
  } finally { await context.close(); }
});
