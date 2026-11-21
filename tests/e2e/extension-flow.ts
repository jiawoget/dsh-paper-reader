import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { cardElement, clickCard, openToolbar, until } from './extension-controls.js';
import { openReader, withHost } from './host.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const title = 'Decoding with PagedAttention and vLLM';
const passages = [
  'For each request, the block table records the mapping between its logical KV blocks and their physical KV blocks.',
  'The block engine divides memory into physical KV blocks. CPU memory is divided in the same way for swapping.',
  'Physical blocks are allocated on demand as new tokens and their KV caches are generated.',
  'Blocks fill from left to right. A new physical block is allocated only after the existing blocks fill up.',
  'As a result, the wasted space for each request is at most one block, and the system can use its memory efficiently.'
];
const question = 'Why does this limit wasted space?';
const annotation = 'A partially filled block is needed only at the end of the sequence.';

// This provider is a deterministic test double for the model only. Its answers
// come from the bundled translation of the same passages. DSH, Chrome, the
// browser extension, the notebook and the article translation cache remain real.
async function fixtures() {
  const sample: Record<string, string> = JSON.parse(await readFile(path.join(project, 'public/assets/pagedattention-page-6.zh-CN.json'), 'utf8'));
  const sentences = (key: string) => Array.from(new Intl.Segmenter('zh-Hans', { granularity: 'sentence' }).segment(sample[key]), part => part.segment.trim());
  const table = sentences('block-tables');
  const allocation = sentences('two-requests');
  const answers = [sample['section-4-3'], table[2], table[0] + table[1], allocation[0], allocation[1], allocation[2]];
  const translation = new Map([title, ...passages].map((text, i) => [text, answers[i]]));
  const requests: { text?: string; context?: string; question?: string; history?: { role: string; content: string }[]; blocks?: { id: string; text: string }[] }[] = [];
  const source = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
  <style>*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#232832;font:17px/1.64 Georgia,"Times New Roman",serif}main{max-width:890px;margin:32px auto;padding:32px 66px 48px;background:#fff;border:1px solid #e2e5eb;border-radius:8px}.masthead{display:flex;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid #d9dce2;font:600 13px system-ui,sans-serif;color:#4d576b}.source{margin:25px 0 8px;font:12px system-ui,sans-serif;color:#667182}h1{margin:8px 0 21px;font:500 37px/1.14 Georgia,serif;letter-spacing:-.9px}p{margin:14px 0}footer{margin-top:26px;padding-top:10px;border-top:1px solid #e6e8ee;font:12px system-ui,sans-serif;color:#697483}strong{font-weight:600}</style>
  <main><header class="masthead"><span>Systems reading notes</span><span>Inference systems</span></header>
  <div class="source">Kwon et al. &nbsp;·&nbsp; SOSP 2023 &nbsp;·&nbsp; Section 4.3</div>
  <article><h1>${title}</h1><p>${passages[0].replace('mapping', '<strong id="term">mapping</strong>')}</p><p>${passages[1]}</p><p><span id="sentence">${passages[2]}</span></p><p>${passages[3]}</p><p>${passages[4]}</p></article>
  <footer>Reading excerpt adapted from Efficient Memory Management for Large Language Model Serving with PagedAttention.</footer></main></html>`;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/paper') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(source); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(parts).toString()) as { messages: { role: string; content: string }[] };
      const input: typeof requests[number] = JSON.parse(body.messages.find(m => m.role === 'user')!.content);
      requests.push(input);
      let content: string;
      if (input.blocks) {
        const values: Record<string, string> = {};
        for (const block of input.blocks) {
          const text = translation.get(block.text);
          assert.ok(text, 'Unexpected article paragraph: ' + block.text);
          values[block.id] = text;
        }
        content = JSON.stringify({ translations: values });
      } else if (input.question) {
        assert.equal(input.question, question);
        assert.equal(input.text, passages[2]);
        assert.ok(input.context?.includes(passages[2]));
        assert.ok(input.history?.some(turn => turn.role === 'assistant' && turn.content === answers[3]));
        content = allocation[1] + allocation[2];
      } else {
        const text = input.text === 'mapping' ? table[2] : translation.get(input.text || '');
        assert.ok(text, 'Unexpected selected text');
        content = text;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
    } catch (error) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  assert.ok(typeof bound === 'object' && bound);
  return {
    api: 'http://127.0.0.1:' + bound.port + '/v1', article: 'http://reading-notes.test:' + bound.port + '/paper',
    requests, word: table[2], sentence: answers[3], followup: allocation[1] + allocation[2], answers,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}

async function selectSentence(browserPage: Page): Promise<void> {
  await browserPage.bringToFront();
  await browserPage.keyboard.press('Escape');
  await browserPage.locator('#sentence').scrollIntoViewIfNeeded();
  const range = await browserPage.locator('#sentence').evaluate(el => {
    const range = new Range();
    range.selectNodeContents(el);
    return Array.from(range.getClientRects(), r => ({ left: r.left, right: r.right, y: r.top + r.height / 2 }));
  });
  await browserPage.mouse.move(range[0].left + 0.1, range[0].y);
  await browserPage.mouse.down();
  await browserPage.mouse.move(range.at(-1)!.right - 0.1, range.at(-1)!.y, { steps: 20 });
  await browserPage.mouse.up();
  assert.equal(await browserPage.evaluate(() => getSelection()?.toString().trim()), passages[2], 'The mouse drag must cover the source sentence');
}

async function saveArticleCard(page: Page, filename: string): Promise<void> {
  const article = await page.locator('main').boundingBox();
  const card = await page.locator('[data-dsh-paper-reader]').boundingBox();
  const viewport = page.viewportSize()!;
  assert.ok(article && card);
  const x = Math.max(0, Math.floor(Math.min(article.x, card.x) - 12));
  const y = Math.max(0, Math.floor(Math.min(article.y, card.y) - 10));
  const right = Math.min(viewport.width, Math.ceil(Math.max(article.x + article.width, card.x + card.width) + 12));
  const bottom = Math.min(viewport.height, Math.ceil(Math.max(article.y + article.height, card.y + card.height) + 18));
  await page.screenshot({ path: filename, clip: { x, y, width: right - x, height: bottom - y } });
}

await withHost(async host => {
  const fixture = await fixtures();
  try {
    const context = await chromium.launchPersistentContext(path.join(host.scratch, 'browser-profile'), {
      executablePath: host.executable, headless: process.env.PAPER_READER_HEADED !== '1', viewport: { width: 1512, height: 940 },
      deviceScaleFactor: 1, locale: 'en-US', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--no-proxy-server', '--host-resolver-rules=MAP reading-notes.test 127.0.0.1']
    });
    try {
      const shell = context.pages()[0];
      const pane = await openReader(shell, host.authenticatedUrl);
      await pane.getByRole('button', { name: 'More actions' }).click();
      await pane.getByRole('button', { name: 'Connections', exact: true }).click();
      await pane.getByLabel('API base URL').fill(fixture.api);
      await pane.getByLabel('Model', { exact: true }).fill('local-reading-fixture');
      await pane.getByRole('button', { name: 'Save connections' }).click();
      await pane.getByRole('dialog').waitFor({ state: 'hidden' });
      const browser = await context.browser()!.newBrowserCDPSession();
      const { id } = await browser.send('Extensions.loadUnpacked', { path: path.join(project, 'dist/extension') });
      const page = await context.newPage();
      await page.goto(fixture.article);
      const menu = await openToolbar(page, id);
      await menu.click('summary');
      await menu.evaluate(value => { document.querySelector<HTMLInputElement>('#origin')!.value = value; }, host.origin);
      await menu.evaluate(() => { document.querySelector('form')!.requestSubmit(); }, null);
      await until(() => menu.evaluate(() => /address was saved|地址已保存/.test(document.querySelector('#message')!.textContent!), null), 'The toolbar did not save its DSH address');
      await menu.screenshot(path.join(host.artifacts, '01-extension-entry.png'));
      await menu.click('#toggle');
      await menu.detach();
      await page.locator('#term').dblclick();
      await until(async () => (await cardElement(page, 'h2'))?.text === 'mapping', 'The selected word did not open a card');
      assert.equal(fixture.requests.length, 0);
      console.log('PASS 01: Native extension toolbar set the real DSH address and enabled cards on the active tab. Selecting text made no model request.');

      await clickCard(page, '[data-do="translate"]');
      await until(async () => (await cardElement(page, '.answer'))?.text === fixture.word, 'The word lookup did not arrive from the configured provider');
      const docsBeforeSave = await shell.evaluate(async () => {
        const res = await fetch('/api/paper-reader/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'library.list', payload: {} }) });
        return (await res.json()).docs as { kind: string }[];
      });
      assert.equal(docsBeforeSave.some(doc => doc.kind === 'web'), false);
      await clickCard(page, '[data-do="vocab"]');
      await until(async () => (await cardElement(page, '.status'))?.text === 'Saved to your vocabulary.', 'The looked-up word was not saved');
      await selectSentence(page);
      await until(async () => (await cardElement(page, 'h2'))?.text === passages[2], 'The full sentence was not selected');
      await clickCard(page, '[data-do="translate"]');
      await until(async () => (await cardElement(page, '.answer'))?.text === fixture.sentence, 'The sentence translation did not arrive');
      await saveArticleCard(page, path.join(host.artifacts, '02-web-lookup.png'));
      console.log('PASS 02: Real mouse selections of a word and a full sentence returned their contextual translations. A lookup alone left the article library unchanged.');

      await clickCard(page, '[data-do="followup"]');
      await clickCard(page, 'textarea');
      await page.keyboard.insertText(question);
      await clickCard(page, '[data-do="submit"]');
      await until(async () => (await cardElement(page, '.answer'))?.text === fixture.followup, 'The contextual answer did not arrive');
      assert.equal((await cardElement(page, '.question'))?.text, question);
      await saveArticleCard(page, path.join(host.artifacts, '03-context.png'));
      console.log('PASS 03: The model endpoint received the actual sentence, its paragraph, the earlier translation and the follow-up question. The card displayed the question and answer.');

      await clickCard(page, '[data-do="note"]');
      await clickCard(page, 'textarea');
      await page.keyboard.insertText(annotation);
      await clickCard(page, '[data-do="submit"]');
      await until(async () => (await cardElement(page, '.status'))?.text === 'Added to this article’s notes.', 'The source-bound note did not save');
      const opened = context.waitForEvent('page');
      await clickCard(page, '[data-do="open"]');
      const reader = await opened;
      await reader.locator('#original [data-anchor="p-4"].is-highlighted').waitFor();
      const jump = new URL(reader.url());
      assert.equal(jump.origin, host.origin);
      assert.equal(jump.pathname, '/api/paper-reader/app/index.html');
      assert.equal(jump.searchParams.get('anchor'), 'p-4');
      await reader.getByRole('button', { name: 'Bilingual', exact: true }).click();
      await reader.getByRole('button', { name: 'Show notebook' }).click();
      await reader.locator('.cm-line[data-note-id]').filter({hasText: annotation}).waitFor();
      await reader.getByRole('button', { name: 'Translate article' }).click();
      await reader.getByText(fixture.answers[3], { exact: true }).waitFor();
      await reader.reload();
      const translated = reader.locator('#translated .web-reading-row > :first-child');
      await translated.first().waitFor();
      assert.deepEqual(await translated.allTextContents(), fixture.answers);
      await reader.setViewportSize({ width: 1360, height: 760 });
      await reader.locator('.source-chip').click();
      await reader.locator('#original .web-reading-row.is-highlighted[data-anchor="p-4"]').waitFor();
      await reader.mouse.move(8, 8);
      await reader.screenshot({ path: path.join(host.artifacts, '04-web-article.png') });
      console.log('PASS 04: The extension captured six real paragraphs. DSH opened the saved sentence, paired and translated both columns, retained translations on reload, and restored the note to paragraph four.');

      await shell.bringToFront();
      await pane.getByRole('button', { name: 'Open library' }).click();
      await pane.getByRole('tab', { name: 'On this device' }).click();
      await pane.getByRole('button', { name: new RegExp(title) }).click();
      await pane.locator('#original .web-reading-row').first().waitFor();
      await pane.getByRole('button', { name: 'More actions' }).click();
      await pane.getByRole('button', { name: 'Vocabulary and history' }).click();
      const dialog = pane.getByRole('dialog');
      await dialog.getByText('mapping', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'History' }).click();
      await dialog.getByText(passages[2], { exact: true }).waitFor();
      await dialog.getByText('mapping', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Vocabulary' }).click();
      await dialog.getByRole('searchbox').fill('mapping');
      assert.equal(await dialog.locator('.list-row').count(), 1);
      await pane.locator('#toast').waitFor({ state: 'hidden' });
      await shell.screenshot({ path: path.join(host.artifacts, '08-vocabulary.png') });
      await dialog.getByRole('button', { name: title }).click();
      await pane.locator('#original .is-highlighted[data-anchor="p-2"]').waitFor();
      console.log('PASS 08: Genuine DSH Vocabulary and History contained the saved word and recorded lookups. Filtering found the word; its source button returned to paragraph two.');
    } finally { await context.close(); }
  } finally { await fixture.close(); }
});
