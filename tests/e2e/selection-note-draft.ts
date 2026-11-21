import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { JournalNote, Operations } from '../../src/shared/types.js';

const origin = 'http://127.0.0.1:31231';
const draft = 'Check the optimization argument. 残差';
const quote = 'Residual learning is easier to optimize.';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const { outputFiles: [bundle] } = await build({
  stdin: {
    resolveDir: packageRoot,
    contents: `
      import { SelectionWorkspace } from './src/reader/selection-workspace.ts';
      const card = document.querySelector('#card');
      const app = { doc: { kind: 'pdf', id: '', title: 'Research paper' }, state: { notes: [] }, refresh: async () => {} };
      const workspace = new SelectionWorkspace(app);
      const original = ${JSON.stringify(quote)};
      const context = original + ' A follow-up. ' + original;
      const open = (docId, page, sourceOffset, side = 'source') => {
        app.doc.id = docId;
        const anchor = 'abstract';
        const pairedTranslation = '残差学习更容易优化。';
        const selection = side === 'source' ? original : pairedTranslation;
        const sourceUrl = new URL(location.origin + '/app/index.html?doc=' + docId + '&page=' + page + '&anchor=' + anchor + '&rangeStart=' + sourceOffset);
        if (side === 'translation') sourceUrl.searchParams.set('targetQuote', pairedTranslation);
        const source = { docId, page, anchor, title: 'Research paper', label: 'Abstract', sourceUrl: sourceUrl.href };
        const hit = { id: anchor, page, side, text: selection, context, sourceText: context, sourceOffset };
        const { actions, notes, chat } = workspace.open({ source, hit, original, selection, context, exactPair: true, pairedTranslation, record: async () => {} });
        card.replaceChildren(actions, notes, chat);
      };
      document.querySelector('#first').onclick = () => open('first-paper', 1, 0);
      document.querySelector('#second').onclick = () => open('second-paper', 1, 0);
      document.querySelector('#page').onclick = () => open('first-paper', 2, 0);
      document.querySelector('#paired').onclick = () => open('first-paper', 1, 0, 'translation');
      document.querySelector('#occurrence').onclick = () => open('first-paper', 1, original.length + ' A follow-up. '.length);
      document.querySelector('#close').onclick = () => { workspace.close(); card.replaceChildren(); };
    `
  },
  bundle: true, platform: 'browser', write: false
});

const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' && process.env.ProgramFiles
  ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined);
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ locale: 'en-US' });
  page.setDefaultTimeout(5_000);
  const saves: Operations['note.save'][0][] = [];
  // Exercise the real workspace in a fresh browser context with a local note-save fixture.
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.url() === origin + '/app/index.html') return route.fulfill({ contentType: 'text/html', body: `
      <!doctype html><html lang="en"><meta charset="utf-8"><title>Selection note draft</title>
      <button id="first">First passage</button><button id="second">Other paper</button>
      <button id="page">Other page</button><button id="occurrence">Second occurrence</button>
      <button id="paired">Paired translation</button><button id="close">Close selection</button>
      <section id="card"></section><dialog id="dialog"></dialog><div id="toast" hidden></div>
      <script src="./workspace.js"></script>` });
    if (request.url() === origin + '/app/workspace.js') return route.fulfill({ contentType: 'application/javascript', body: bundle.text });
    if (request.url() === origin + '/action') {
      const { op, payload } = request.postDataJSON();
      assert.equal(op, 'note.save');
      saves.push(payload);
      if (saves.length === 1) return route.fulfill({ status: 503, json: { error: 'Save temporarily unavailable.' } });
      const note: JournalNote = { ...payload, id: 'saved-note', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
      return route.fulfill({ json: { note } });
    }
    return route.abort();
  });
  const errors: Error[] = [];
  page.on('pageerror', error => errors.push(error));
  const first = page.getByRole('button', { name: 'First passage' });
  const paired = page.getByRole('button', { name: 'Paired translation' });
  const editor = page.getByRole('textbox', { name: 'Your note' });
  const save = page.getByRole('button', { name: 'Save note', exact: true });
  await page.goto(origin + '/app/index.html');
  await first.click();
  await page.getByRole('button', { name: 'Write note' }).click();
  await editor.fill(draft);
  await editor.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(10, 22));
  await page.getByRole('button', { name: 'Close selection' }).click();
  await first.click();
  assert.equal(await editor.inputValue(), draft, 'Closing and reopening must restore the manual draft.');

  await page.reload();
  for (const context of ['Other paper', 'Other page', 'Second occurrence']) {
    await page.getByRole('button', { name: context }).click();
    assert.equal(await editor.count(), 0, `${context} must have its own draft.`);
  }
  await first.click();
  assert.equal(await editor.count(), 1, 'Reloading and reselecting must reopen the manual draft.');
  assert.equal(await editor.inputValue(), draft);
  assert.deepEqual(await editor.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]), [10, 22]);
  await page.getByRole('button', { name: 'Write note' }).click();
  assert.ok(await editor.isVisible(), 'The action must keep an already open note visible.');
  assert.equal(await editor.evaluate(field => document.activeElement === field), true);

  await save.click();
  await page.getByRole('alert').getByText('Save temporarily unavailable.').waitFor();
  assert.equal(await editor.inputValue(), draft);
  await page.reload();
  await paired.click();
  assert.equal(await editor.inputValue(), draft, 'The paired translation must recover the same failed draft.');
  await save.click();
  await first.click();
  await page.locator('.selection-saved-note').getByText(draft, { exact: true }).waitFor();
  assert.equal(await editor.count(), 0);
  assert.equal(saves[1].createId, saves[0].createId, 'Retry a recovered draft with the same save ID.');
  assert.ok(saves[1].createId);
  assert.equal(saves[1].quote, quote);
  assert.equal(saves[1].sourceUrl, origin + '/app/index.html?doc=first-paper&page=1&anchor=abstract&rangeStart=0');

  await page.reload();
  await first.click();
  assert.equal(await editor.count(), 0, 'A successful save must clear the recovered draft.');
  await page.getByRole('button', { name: 'Write note' }).click();
  await editor.fill('Explicitly discarded draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await first.click();
  assert.equal(await editor.count(), 0, 'An explicit cancel must clear the recovered draft.');
  assert.deepEqual(errors, []);
  console.log('PASS selection note draft recovery across close, reload, paired translation, failed save, successful retry, and cancel.');
} finally {
  await browser.close();
}
