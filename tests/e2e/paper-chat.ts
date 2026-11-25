import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { withHost } from './host.js';

const live = process.env.PAPER_READER_LIVE_CHAT === '1';
const paper = process.env.PAPER_READER_SELECTION_PDF || (live ? path.join(os.homedir(), 'Downloads', 'Deep Residual Learning for Image Recognition.pdf') : '');
const first = 'In Table 14, what localization error did the authors report for ILSVRC 2015 on validation and test? Give both percentages and the page in one sentence.';
const followup = 'Which of the two numbers you just gave is the test result? Reply in one sentence.';
async function selectedWord(page: Page): Promise<void> {
  await page.locator('#original .pdf-native-text span').filter({ hasText: 'residual' }).first().evaluate(element => {
    const node = element.firstChild!, start = node.textContent!.toLowerCase().indexOf('residual');
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, start + 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  });
}
await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1480, height: 940 } });
    const reader = await context.newPage();
    const real = existsSync(paper);
    if (!real && process.env.PAPER_READER_SELECTION_PDF) throw Error('The requested paper was not found.');
    let bytes: Buffer;
    if (real) bytes = await readFile(paper);
    else {
      const pages = Array.from({ length: 12 }, (_, i) => '<section>' + (i === 1 ? 'A residual is the difference from an identity mapping.'
        : i === 11 ? 'Table 14. Localization validation and test errors: 8.9 9.0' : 'This page belongs to a paper chat test document.') + '</section>');
      await reader.setContent('<style>section{break-after:page}section:last-child{break-after:auto}</style>' + pages.join(''));
      bytes = await reader.pdf({ format: 'A4' });
    }
    await reader.goto(host.authenticatedUrl);
    const add = await context.request.post(host.origin + '/api/paper-reader/import-pdf?title=' + encodeURIComponent(real ? path.basename(paper) : 'Paper chat fixture.pdf'),
      { headers: { 'content-type': 'application/pdf' }, data: bytes });
    assert.ok(add.ok());
    const docId: string = (await add.json()).doc.id;
    const cache = path.join(host.scratch, 'reader', 'translations', docId);
    await mkdir(cache, { recursive: true });
    if (real) await copyFile('tests/fixtures/resnet-selection-page-2.zh-CN.json', path.join(cache, '2.json'));
    if (!live) {
      await context.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'settings.save', payload: { baseUrl: 'http://127.0.0.1:4142' } } });
    }
    const address = host.origin + '/api/paper-reader/app/index.html?doc=' + docId + '&page=2';
    await reader.goto(address);
    const chat = reader.getByRole('region', { name: 'Paper chat' });
    const toggle = chat.getByRole('button', { name: 'Paper chat' });
    await toggle.click({ timeout: 10_000 });
    const field = chat.getByRole('textbox', { name: 'Message about this paper' });
    if (!live) {
      const { startModel } = await import('./paper-chat-model.js');
      const model = await startModel();
      try {
        await context.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'settings.save', payload: { baseUrl: model.origin } } });
        await exercise();
      } finally { await model.close(); }
    } else await exercise();

    async function exercise(): Promise<void> {
      const card = reader.locator('#card');
      const scope = chat.locator('.paper-chat-attachment');
      const whole = scope.getByText('Whole paper', { exact: true });
      const attach = scope.getByRole('button', { name: 'Use selected passage' });
      const remove = scope.getByRole('button', { name: 'Remove selected passage' });
      await whole.waitFor();
      await selectedWord(reader);
      await attach.waitFor();
      assert.equal(await remove.isVisible(), false);
      await card.getByRole('button', { name: 'Close selection' }).click();
      await attach.waitFor({ state: 'hidden' });
      await selectedWord(reader);
      await attach.click();
      await scope.getByText('Selected passage', { exact: true }).waitFor();
      await remove.click();
      await whole.waitFor();
      await attach.click();
      await card.getByRole('button', { name: 'Close selection' }).click();
      await remove.waitFor();
      await field.fill(first);
      await field.press('Enter');
      const answers = chat.locator('.paper-answer');
      const firstReply = answers.first();
      await firstReply.waitFor({ timeout: 125_000 });
      assert.match(await firstReply.innerText(), /8[.]9/);
      assert.match(await firstReply.innerText(), /9(?:[.]0)?\s*%/);
      assert.match(await firstReply.innerText(), /12/);
      await selectedWord(reader);
      await attach.waitFor();
      await field.fill(followup); await field.press('Enter');
      await answers.nth(1).waitFor({ timeout: 125_000 });
      assert.match(await answers.nth(1).innerText(), /9(?:[.]0)?\s*%/);

      await selectedWord(reader);
      await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
      const localInput = card.getByRole('textbox', { name: 'Message about this selection' });
      await localInput.fill('What does the selected word mean in this paper? Answer briefly.');
      await localInput.press('Enter');
      await card.locator('.selection-answer').waitFor({ timeout: 125_000 });
      await card.getByRole('button', { name: 'Close chat' }).click();
      await card.getByRole('button', { name: 'Close selection' }).click();
      await answers.nth(2).waitFor();
      const before = await chat.getByRole('log').innerText();
      await reader.goto(host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6');
      if (!await field.isVisible()) await toggle.click();
      await chat.getByText('Ask a question about this paper.').waitFor();
      assert.equal(await answers.count(), 0);
      await reader.goto(address);
      if (!await field.isVisible()) await toggle.click();
      await answers.nth(2).waitFor();
      assert.equal(await chat.getByRole('log').innerText(), before);
      await selectedWord(reader);
      await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
      await card.locator('.selection-answer').waitFor();
      await card.getByRole('button', { name: 'Close chat' }).click();
      await card.getByRole('button', { name: 'Close selection' }).click();
      const grip = chat.getByRole('separator', { name: 'Resize paper chat' });
      const height = (await chat.boundingBox())!.height;
      await grip.focus(); await grip.press('ArrowUp');
      assert.ok((await chat.boundingBox())!.height > height);
      await chat.getByRole('log').evaluate(log => { log.scrollTop = 0; });
      if (live) {
        const dest = path.join(host.artifacts, 'reviews', 'reading-desk');
        await mkdir(dest, { recursive: true });
        await reader.screenshot({ path: path.join(dest, 'paper-chat.png'), animations: 'disabled' });
      }
      const paperReply = answers.nth(1), row = paperReply.locator('..');
      const replyId = await paperReply.getAttribute('data-exchange-id');
      await row.getByRole('button', { name: 'Add to Notes' }).click();
      await row.getByRole('button', { name: 'View', exact: true }).click();
      const notebook = reader.locator('#rail');
      const citation = notebook.getByRole('link', { name: 'Paper chat', exact: true });
      const linked = new URL((await citation.getAttribute('href'))!);
      assert.equal(linked.searchParams.get('discussion'), replyId);
      assert.equal(await notebook.getByRole('link', { name: 'View discussion', exact: true }).count(), 0);
      await reader.goto(linked.href);
      const reopened = chat.locator('.paper-answer:focus');
      await reopened.waitFor();
      assert.equal(await reopened.getAttribute('data-exchange-id'), replyId);
      if (!live) {
        await reader.goto(address);
        if (!await field.isVisible()) await toggle.click();
        const chooser = reader.getByRole('dialog', { name: 'Question model' });
        const picker = chat.getByRole('button', { name: /^Question model/ });
        await picker.click();
        await chooser.waitFor({ state: 'visible' });
        assert.equal(await reader.locator('#dialog[open]').count(), 0);
        await picker.click(); await chooser.waitFor({ state: 'hidden' });
        await picker.click(); await chooser.waitFor({ state: 'visible' });
        await reader.keyboard.press('Escape'); await chooser.waitFor({ state: 'hidden' });
        await picker.click();
        await chooser.getByRole('option', { name: 'Reasoning model' }).click();
        await chooser.getByRole('button', { name: 'High', exact: true }).click();
        await chooser.waitFor({ state: 'hidden' });
        const modelTrigger = chat.getByRole('button', { name: /^Question model.*Reasoning model.*High/ });
        await modelTrigger.waitFor();
        assert.doesNotMatch(await modelTrigger.innerText(), /\breasoner\b/i);
        await field.click();
        await field.fill('Which model answers this whole-paper question?');
        const response = reader.waitForResponse(response => response.url().endsWith('/action') &&
          response.request().postDataJSON()?.op === 'chat.ask', { timeout: 45_000 });
        await chat.getByRole('button', { name: 'Send', exact: true }).click();
        assert.equal(await field.inputValue(), '');
        const reply = await response;
        assert.ok(reply.ok(), await reply.text());
        const finalFrame = (await reply.text()).trim().split('\n').at(-1)!;
        assert.equal(JSON.parse(finalFrame).text, 'reader-test / reasoner / high');
        await answers.filter({ hasText: 'reader-test / reasoner / high' }).waitFor();

        await field.fill('slow-stream-markdown full render check');
        await field.press('Enter');
        const stopBtn = chat.getByRole('button', { name: 'Stop', exact: true });
        await stopBtn.waitFor({ state: 'visible' });
        const streamBody = chat.locator('.chat-stream-body');
        await streamBody.locator('h3').waitFor({ state: 'visible' });
        await streamBody.locator('strong').waitFor({ state: 'visible' });
        assert.equal(await stopBtn.isVisible(), true);
        assert.doesNotMatch(await streamBody.innerText(), /###|\*\*/);
        await answers.filter({ hasText: 'Item two' }).waitFor({ timeout: 30_000 });

        const beforeAbort = await answers.count();
        await field.fill('slow-stream-markdown stop and retry check');
        await field.press('Enter');
        await stopBtn.waitFor({ state: 'visible' });
        await streamBody.locator('h3').waitFor({ state: 'visible' });
        await stopBtn.click();
        await stopBtn.waitFor({ state: 'hidden' });
        await chat.locator('.chat-stopped-body h3').waitFor({ state: 'visible' });
        await chat.getByText('Generation stopped').waitFor({ state: 'visible' });
        assert.equal(await answers.count(), beforeAbort);
        const histAfterStop = await (await context.request.post(host.origin + '/api/paper-reader/action', {
          data: { op: 'chat.history', payload: { docId } }
        })).json();
        assert.equal(histAfterStop.exchanges.some((e: { question: string }) => e.question.includes('stop and retry check')), false);
        await chat.locator('.chat-stopped-bar').getByRole('button', { name: 'Retry', exact: true }).click();
        await answers.nth(beforeAbort).waitFor({ timeout: 30_000 });

        const countBeforeDelete = await answers.count();
        await answers.last().locator('..').getByRole('button', { name: 'Delete', exact: true }).click();
        await reader.waitForFunction(expected => document.querySelectorAll('.paper-chat .paper-answer').length === expected, countBeforeDelete - 1);
        await chat.getByRole('button', { name: 'Clear chat', exact: true }).click();
        await chat.getByRole('button', { name: 'Confirm clear', exact: true }).click();
        await reader.reload();
        if (!await field.isVisible()) await toggle.click();
        const postClearHistory = await (await context.request.post(host.origin + '/api/paper-reader/action', {
          data: { op: 'chat.history', payload: { docId, thread: 'paper' } }
        })).json();
        assert.equal(postClearHistory.exchanges.length, 0);

        await selectedWord(reader);
        await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
        await card.getByRole('button', { name: /^Question model.*Reasoning model.*High/ }).click();
        await chooser.getByRole('option', { name: 'Plain model' }).click();
        await chooser.waitFor({ state: 'hidden' });
        await localInput.fill('Which model answers this passage question?');
        await localInput.press('Enter');
        await card.locator('.selection-answer').filter({ hasText: 'reader-test / plain / default' }).waitFor();
        console.log('Verified inline model popover, mid-stream Markdown rendering, Stop retention + Retry, Delete/Clear persistence, and switching models.');
      }
      console.log('Verified page-12 table grounding from imported page 2, opt-in attachment, whole-paper follow-up, passage history, resize and per-paper restoration (' +
        (live ? 'live DSH model' : 'grounding-checked model fixture') + ').');
    }
  } finally { await browser.close(); }
}, {}, { installedModelProfile: live, modelFixture: !live });
