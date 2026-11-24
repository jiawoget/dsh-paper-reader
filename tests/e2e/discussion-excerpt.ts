import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator } from 'playwright-core';
import type { NotebookSnapshot } from '../../src/shared/types.js';
import { withHost } from './host.js';
import { modelFixture } from './integration-fixtures.js';

const sentence = '块表把每个逻辑块映射到一个物理块。';
const rest = '图 6 中，逻辑块 0 对应物理块 7，逻辑块 1 对应物理块 1。';
const answer = sentence + rest;

async function selectText(locator: Locator, text?: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element, value) => {
    const node = element.firstChild;
    if (!(node instanceof Text)) throw Error('Text is missing.');
    const at = value ? node.data.indexOf(value) : 0;
    if (at < 0) throw Error('The excerpt is missing.');
    document.getSelection()!.setBaseAndExtent(node, at, node, at + (value?.length ?? node.length));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  }, text);
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  const model = await modelFixture(answer, 'Block table');
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ locale: 'zh-CN', hasTouch: mobile, viewport: mobile
        ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      const errors: Error[] = [];
      page.on('pageerror', error => errors.push(error));
      await page.goto(host.authenticatedUrl);
      const entry = host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6';
      const endpoint = host.origin + '/api/paper-reader/action';
      const book = async (): Promise<NotebookSnapshot> => {
        const reply = await page.request.post(endpoint, { data: { op: 'notebook.get',
          payload: { docId: 'pagedattention', title: 'PagedAttention.pdf', sourceUrl: entry } } });
        assert.ok(reply.ok());
        return reply.json();
      };
      const write = async (markdown: string) => {
        const reply = await page.request.post(endpoint, { data: { op: 'notebook.write', payload: {
          docId: 'pagedattention', title: 'PagedAttention.pdf', sourceUrl: entry,
          expectedRevision: (await book()).revision, markdown } } });
        assert.ok(reply.ok());
      };
      const configured = await page.request.post(endpoint, { data: { op: 'settings.save',
        payload: { baseUrl: model.origin + '/v1', apiKey: model.key, model: model.model } } });
      assert.ok(configured.ok());
      const oldLink = '[p6-1234abcd]: <' + entry + '&anchor=block-tables>\n\n';
      const original = (mobile ? oldLink : '') + '先读图。再核对图注。';
      await write(original);
      await page.goto(entry);
      const run = page.locator('#original .pdf-native-text [data-block-id="figure-6"]').filter({ hasText: 'Block table' }).first();
      await run.waitFor();
      if (!mobile) {
        await page.getByRole('button', { name: '打开笔记' }).click();
        await page.getByRole('textbox', { name: '笔记 Markdown' }).click();
        await page.keyboard.press('Home');
        for (const _ of '先读图。') await page.keyboard.press('ArrowRight');
        await page.locator('#closeRail').click();
      }
      await selectText(run, mobile ? 'Block table translation' : undefined);
      const before = model.completed();
      await page.getByRole('button', { name: '解释', exact: true }).click();
      const chat = page.locator('.selection-chat:visible');
      const reply = chat.locator('.selection-answer').last();
      await reply.getByText(answer, { exact: true }).waitFor();
      assert.equal(model.completed(), before + 1, 'Explain sends exactly one question.');
      const input = chat.getByRole('textbox');
      const draft = '两个请求能引用同一个物理块吗？';
      await input.fill(draft);
      await selectText(reply.locator('p'), sentence);
      await chat.getByRole('button', { name: '记下选句', exact: true }).click();
      await chat.getByText('已记入', { exact: true }).waitFor();
      const clipped = (await book()).markdown;
      assert.ok(clipped.includes(sentence) && !clipped.includes(rest));
      assert.ok(clipped.indexOf(sentence) > clipped.indexOf(mobile ? original : '先读图。'));
      if (!mobile) assert.ok(clipped.indexOf(sentence) < clipped.indexOf('再核对图注。'));
      assert.equal(await input.inputValue(), draft);
      const directory = process.argv[2];
      if (directory) {
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, mobile ? 'mobile.png' : 'desktop.png') });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const dock = (await page.locator('#selectionDock').boundingBox())!;
      const send = (await chat.getByRole('button', { name: '发送' }).boundingBox())!;
      assert.ok(send.y + send.height <= dock.y + dock.height + 1, 'The complete composer must fit within the discussion.');
      await chat.getByRole('button', { name: '查看', exact: true }).click();
      if (!mobile) {
        const line = page.locator('#rail .cm-line').getByText('先读图。', { exact: true });
        await line.first().click();
        await page.keyboard.press('Home');
        await page.keyboard.insertText('补记。');
      }
      await page.locator('#rail .notebook-passage-link').last().click();
      await page.getByRole('button', { name: '返回讨论' }).click();
      assert.equal(await input.inputValue(), draft);
      await chat.getByRole('button', { name: '撤销', exact: true }).click();
      await chat.getByText('已记入', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal((await book()).markdown, (mobile ? '' : '补记。') + original);
      await input.press('Enter');
      await chat.locator('.selection-answer').nth(1).waitFor();
      if (!mobile) {
        let failOnce = true;
        await page.route('**/api/paper-reader/action', route => {
          if (failOnce && route.request().postDataJSON()?.op === 'notebook.write') {
            failOnce = false;
            return route.fulfill({ status: 503, json: { error: 'Notebook temporarily unavailable.' } });
          }
          return route.continue();
        });
      }
      await chat.getByRole('button', { name: '记入笔记', exact: true }).last().click();
      if (!mobile) {
        await chat.getByText('Notebook temporarily unavailable.', { exact: true }).waitFor();
        assert.ok(!(await book()).markdown.includes(sentence));
        await chat.getByRole('button', { name: '重试', exact: true }).click();
      }
      await chat.getByText('已记入', { exact: true }).waitFor();
      assert.equal((await book()).markdown.split(answer).length, 2, 'Retry must keep exactly one copy.');
      if (!mobile) {
        const turns = chat.locator('.chat-turn.assistant');
        await selectText(turns.first().locator('.selection-answer p'), sentence);
        await turns.first().getByRole('button', { name: '记下选句' }).click();
        await turns.first().getByText('已记入').waitFor();
        const external = '\n\n另一个窗口的补记。';
        await write((await book()).markdown + external);
        const refreshed = page.waitForResponse(response => response.url() === endpoint &&
          response.request().postDataJSON()?.op === 'notebook.get');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await refreshed;
        await turns.last().getByRole('button', { name: '撤销' }).click();
        await turns.last().getByText('已记入').waitFor({ state: 'hidden' });
        const remaining = (await book()).markdown;
        assert.ok(remaining.includes('\n\n> ' + sentence) && !remaining.includes(rest));
        await turns.first().getByRole('button', { name: '撤销' }).click();
        await turns.first().getByText('已记入').waitFor({ state: 'hidden' });
        assert.equal((await book()).markdown, '补记。' + original + external);
        await turns.last().getByRole('button', { name: '记入笔记' }).click();
        await turns.last().getByText('已记入').waitFor();
      }
      await chat.getByRole('button', { name: '查看', exact: true }).click();
      const source = page.locator('#rail .notebook-passage-link').last();
      const href = new URL((await source.getAttribute('href'))!);
      assert.equal(href.searchParams.get('anchor'), 'figure-6');
      await source.click();
      await page.waitForURL(url => url.searchParams.get('anchor') === 'figure-6');
      await page.locator('#original .pdf-quote-mark').first().waitFor();
      await page.reload();
      await page.locator('#loading').waitFor({ state: 'hidden' });
      const persisted = (await book()).markdown;
      assert.ok(persisted.includes(answer));
      const showNotes = page.getByRole('button', { name: '打开笔记' });
      if (await showNotes.isVisible()) await showNotes.click();
      const discussion = source.locator('..').getByRole('link', { name: '查看讨论', exact: true });
      const address = new URL((await discussion.getAttribute('href'))!);
      const replyId = href.searchParams.get('reply');
      assert.ok(replyId);
      assert.deepEqual([...address.searchParams], [['doc', 'pagedattention'], ['discussion', replyId]]);
      if (mobile) await discussion.tap();
      else {
        await source.press('Tab');
        assert.ok(await discussion.evaluate(link => link === document.activeElement));
        await discussion.press('Enter');
      }
      await chat.locator('.selection-answer:focus').waitFor();
      assert.equal(await chat.locator('.selection-answer:focus').getAttribute('data-reply-id'), replyId);
      await chat.getByText(draft, { exact: true }).waitFor();
      assert.equal((await book()).markdown, persisted, 'Following the discussion preserves the saved Markdown.');
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await model.close(); }
});
console.log('PASS discussion excerpts in the desktop and mobile reader.');
