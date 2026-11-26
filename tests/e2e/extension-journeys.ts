import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { cardElement, clickCard, openToolbar, until } from './extension-controls.js';
import { withHost } from './host.js';

const preload = new URL('./book-reading-preload.ts', import.meta.url).href;
const logFile = path.join(os.tmpdir(), 'paper-reader-ext-journeys-' + randomUUID() + '.ndjson');
const pdfBytes = Buffer.concat([await readFile(path.resolve('public/assets/pagedattention.pdf')), Buffer.from('\n%ext-journey\n')]);
const paragraph = 'A repeated paragraph about blocks.';
let revised = false, rejectModel = true;
const fixture = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    for await (const _ of req) {}
    res.writeHead(rejectModel ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rejectModel ? { error: 'Invalid test key' } : { choices: [{ message: { content: '内存块' } }] }));
    return;
  }
  if (req.url === '/pdf/2309.06180.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="2309.06180.pdf"' });
    res.end(pdfBytes); return;
  }
  if (req.url === '/abs/2309.06180') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<meta name="citation_title" content="Direct ArXiv PDF Capture"><meta name="citation_author" content="Ada Lovelace"><article><p>Abstract.</p></article>');
    return;
  }
  const second = paragraph.replace('blocks', '<strong id="pick">blocks</strong>');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/empty' ? '<body><canvas></canvas></body>' :
    req.url === '/silent' ? '<title>Silent Saved Article</title><main><h1>Silent Saved Article</h1><p>Saved without switching browser tabs.</p></main>' :
    '<title>Reader capture test</title><main><h1><span id="other-pick">Test</span> article</h1><p>' + paragraph + '</p><p>' + second + '</p>' +
    (revised ? '<p>New paragraph in the second edition.</p>' : '') + '</main>');
});
await writeFile(logFile, '', { flag: 'wx' });
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
const address = fixture.address();
assert.ok(address && typeof address !== 'string');
const article = 'http://reading-notes.test:' + address.port, model = 'http://127.0.0.1:' + address.port + '/v1';

try {
  await withHost(async host => {
    const ctx = await chromium.launchPersistentContext(path.join(host.scratch, 'extension-journeys'), {
      executablePath: host.executable, headless: true, locale: 'en-US', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--no-proxy-server', '--host-resolver-rules=MAP reading-notes.test 127.0.0.1, MAP arxiv.org 127.0.0.1']
    });
    try {
      const cdp = await ctx.browser()!.newBrowserCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.resolve('dist/extension') });
      const one = ctx.pages()[0], two = await ctx.newPage();
      await one.goto(article + '/paper'); await two.goto(article + '/other');
      const menu = (tab: Page) => openToolbar(tab, id);
      async function configure(origin: string): Promise<void> {
        const popup = await menu(one);
        await popup.evaluate(value => {
          document.querySelector<HTMLInputElement>('#origin')!.value = value;
          document.querySelector('form')!.requestSubmit();
        }, origin);
        await until(() => popup.evaluate(() => /address was saved|地址已保存/.test(document.querySelector('#message')!.textContent!), null), 'Could not set the test DSH address.');
        await popup.detach();
      }
      async function lookup(expected: RegExp): Promise<void> {
        await one.bringToFront();
        await one.locator('#pick').dblclick();
        await until(async () => (await cardElement(one, 'h2'))?.text === 'blocks', 'The lookup card did not open.');
        await clickCard(one, '[data-do="translate"]');
        await until(async () => expected.test((await cardElement(one, '.answer'))?.text ?? ''), 'The lookup did not report ' + expected);
      }
      const stopped = createServer();
      await new Promise<void>(resolve => stopped.listen(0, '127.0.0.1', resolve));
      const offline = stopped.address();
      assert.ok(offline && typeof offline !== 'string');
      await new Promise<void>(resolve => stopped.close(() => resolve()));
      await configure('http://127.0.0.1:' + offline.port);
      let popup = await menu(one); await popup.click('#toggle'); await popup.detach();
      await lookup(/Could not reach your local DSH/);
      await configure(host.origin); await lookup(/sign in/i);
      const shell = await ctx.newPage(); await shell.goto(host.authenticatedUrl);
      await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'settings.save', payload: { baseUrl: model, model: 'extension-test' } } });
      await lookup(/model service denied access/i);
      rejectModel = false; await lookup(/内存块/);
      console.log('PASS service unavailable, unsigned browser, provider denial and successful retry are distinguishable in the actual lookup card.');

      popup = await menu(two);
      assert.equal(await popup.evaluate(() => document.querySelector('#toggle')!.getAttribute('aria-pressed'), null), 'false');
      await popup.detach();
      popup = await menu(one); await popup.click('#toggle');
      await until(() => popup.evaluate(() => /are off|划词已关闭/.test(document.querySelector('#message')!.textContent!), null), 'Selection cards should turn off.');
      await popup.detach();
      await one.locator('#pick').dblclick();
      assert.equal(await one.locator('[data-dsh-paper-reader]').count(), 0);
      popup = await menu(one); await popup.click('#toggle'); await popup.detach();
      await one.locator('#pick').dblclick();
      await until(async () => !!(await cardElement(one, 'h2')), 'The re-enabled selection must open.');
      await clickCard(one, '[data-do="note"]'); await clickCard(one, '[data-do="submit"]');
      await until(async () => /Added/.test((await cardElement(one, '.status'))?.text ?? ''), 'The blank note must save the selected text.');
      const opened = ctx.waitForEvent('page'); await clickCard(one, '[data-do="open"]');
      const reader = await opened;
      await reader.locator('#original [data-anchor="p-3"].is-highlighted').waitFor();
      const first = new URL(reader.url()).searchParams.get('doc')!;
      const state = await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'state', payload: {} } });
      const notes = (await state.json()).notes as {docId: string; anchor: string; text: string}[];
      assert.ok(notes.some(note => note.docId === first && note.anchor === 'p-3' && note.text === 'blocks'));
      console.log('PASS enabling one tab, disabling it, ordinary text selection, and saving a blank note on the second identical paragraph.');

      await one.bringToFront();
      await one.locator('#pick').dblclick();
      await until(async () => !!(await cardElement(one, 'h2')), 'The article lookup should reopen.');
      await clickCard(one, '[data-do="followup"]'); await clickCard(one, 'textarea');
      const unfinished = 'An unfinished question on the original website';
      await one.keyboard.insertText(unfinished);
      assert.equal((await cardElement(one, 'textarea'))?.text, unfinished);
      await one.locator('h1').click();
      const dismissed = await one.locator('[data-dsh-paper-reader]').count() === 0;
      await one.locator('#pick').dblclick();
      await until(async () => !!(await cardElement(one, 'h2')), 'The same article word should still be selectable.');
      await clickCard(one, '[data-do="followup"]');
      const restored = (await cardElement(one, 'textarea'))?.text === unfinished;
      console.log('External webpage quick card:', JSON.stringify({outsideClickDismissed:dismissed, sameSelectionRestoredDraft:restored}));
      assert.ok(restored, 'Reopening the same article selection should restore its unfinished question.');
      assert.equal(dismissed, false, 'An ordinary reading click should preserve the active draft.');
      await one.locator('#other-pick').dblclick();
      const otherSelection = await one.evaluate(() => getSelection()?.toString().trim());
      assert.ok(otherSelection && otherSelection !== 'blocks');
      await until(async () => (await cardElement(one, 'h2'))?.text === otherSelection, 'A deliberate new selection should open its own card.');
      await one.keyboard.press('Escape');
      await one.locator('[data-dsh-paper-reader]').waitFor({state:'detached'});
      await one.locator('#pick').dblclick();
      await until(async () => (await cardElement(one, 'textarea'))?.text === unfinished, 'Returning to the original range should recover its draft.');
      await clickCard(one, '[data-do="cancel"]');
      await one.locator('h1').click();
      assert.equal(await one.locator('[data-dsh-paper-reader]').count(), 0);
      console.log('PASS a different selection has its own card; returning to the original range restores the draft, and Cancel discards it.');

      async function capture(): Promise<string> {
        const popup = await menu(one), opened = ctx.waitForEvent('page');
        await popup.click('#read'); await popup.detach();
        const tab = await opened;
        await tab.locator('#original .web-reading-row').first().waitFor();
        return new URL(tab.url()).searchParams.get('doc')!;
      }
      assert.equal(await capture(), first);
      revised = true; await one.reload();
      const second = await capture();
      assert.notEqual(second, first);
      assert.equal(await reader.locator('#original .web-reading-row').count(), 3);
      const empty = await ctx.newPage(); await empty.goto(article + '/empty');
      popup = await menu(empty); await popup.click('#read');
      await until(() => popup.evaluate(() => /No visible article text/.test(document.querySelector('#message')!.textContent!), null), 'Empty articles should explain the failure.');
      await popup.detach();
      const restricted = await ctx.newPage(); await restricted.goto('chrome://settings/');
      popup = await menu(restricted); await popup.click('#read');
      await until(() => popup.evaluate(() => /regular webpage/.test(document.querySelector('#message')!.textContent!), null), 'Restricted pages should explain the failure.');
      await popup.detach();
      const silentTab = await ctx.newPage(); await silentTab.goto(article + '/silent');
      const tabsBeforeSilent = ctx.pages().length;
      popup = await menu(silentTab); await popup.click('#save');
      await until(() => popup.evaluate(() => /Saved to library/.test(document.querySelector('#message')!.textContent!), null), 'Silent save should report success.');
      assert.equal(ctx.pages().length, tabsBeforeSilent);
      await popup.detach();
      const arxivPdfTab = await ctx.newPage(); await arxivPdfTab.goto('http://arxiv.org:' + address.port + '/pdf/2309.06180.pdf');
      popup = await menu(arxivPdfTab);
      const pdfOpened = ctx.waitForEvent('page'); await popup.click('#read'); await popup.detach();
      const pdfReaderTab = await pdfOpened;
      await pdfReaderTab.locator('#docTitle').waitFor({ state: 'visible' });
      const libRes = await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'library.list', payload: {} } });
      const libDocs = (await libRes.json()).docs as { title: string; kind: string; paperTitle?: string }[];
      assert.ok(libDocs.some(d => d.title === 'Silent Saved Article'));
      assert.ok(libDocs.some(d => d.kind === 'pdf' && d.paperTitle === 'Direct ArXiv PDF Capture'));
      console.log('PASS unchanged capture, silent save without tab switch, direct arXiv PDF capture, and empty/restricted error handling.');
    } finally { await ctx.close(); }
  }, {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' '),
    PAPER_READER_E2E_PUBLISHER_FIXTURE: 'http://127.0.0.1:' + address.port,
    PAPER_READER_E2E_PUBLISHER_LOG: logFile
  });
} finally {
  await rm(logFile, { force: true });
  await new Promise<void>(resolve => { fixture.close(() => resolve()); fixture.closeAllConnections(); });
}
