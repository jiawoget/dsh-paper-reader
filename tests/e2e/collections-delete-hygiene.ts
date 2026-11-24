import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { withHost, type HostFixture } from './host.js';

const appPath = '/api/paper-reader/app/index.html';

async function rpc(context: BrowserContext, host: HostFixture, op: string, payload: Record<string, unknown> = {}) {
  return context.request.post(host.origin + '/api/paper-reader/action', {
    data: { op, payload }
  });
}

async function makePdf(context: BrowserContext, heading: string, body: string): Promise<Buffer> {
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><html><body style="font:16px serif;padding:36px"><h1>${heading}</h1><p>${body}</p></body></html>`);
    return Buffer.from(await page.pdf({ format: 'Letter' }));
  } finally { await page.close(); }
}

function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return Number(row.n);
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const page: Page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Isolated E2E host has no live Zotero desktop daemon, so ignore expected 404/503 resource logs.
      if (/Failed to load resource: the server responded with a status of (?:404|503)\b/.test(text)) return;
      consoleErrors.push(text);
    });

    await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });

    // --- Block 1: F9 Collections WAI-ARIA Tablist (T1-F9-01, T1-F9-02, T2-F9-01, T2-F9-02) ---
    const sourceUrl = host.origin + appPath + '?doc=pagedattention&page=6&anchor=block-tables';
    for (const word of ['alpha-term', 'beta-term']) {
      const r = await rpc(context, host, 'vocab.save', {
        docId: 'pagedattention', title: 'PagedAttention.pdf', page: 6, anchor: 'block-tables',
        label: 'Left column', sourceUrl, text: word, meaning: 'Meaning for ' + word, context: 'Context'
      });
      assert.equal(r.status(), 200);
    }
    const histRes = await rpc(context, host, 'history.add', {
      docId: 'pagedattention', title: 'PagedAttention.pdf', page: 6, anchor: 'block-tables',
      label: 'Left column', sourceUrl, text: 'alpha-term', meaning: 'History meaning', context: 'Context'
    });
    assert.equal(histRes.status(), 200);

    await page.goto(host.origin + appPath + '?doc=pagedattention&page=6', { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').waitFor({ state: 'hidden' });

    await page.locator('#more').click();
    await page.locator('#menu').getByRole('button', { name: 'Vocabulary and history', exact: true }).click();
    const dialog = page.locator('#dialog');
    await dialog.waitFor({ state: 'visible' });

    // T1-F9-01: WAI-ARIA tablist / tab / tabpanel structure
    const tablist = dialog.getByRole('tablist');
    await tablist.waitFor();
    const vocabTab = dialog.getByRole('tab', { name: 'Vocabulary', exact: true });
    const historyTab = dialog.getByRole('tab', { name: 'History', exact: true });
    const panel = dialog.getByRole('tabpanel');
    await panel.waitFor();

    const panelId = await panel.getAttribute('id');
    const vocabId = await vocabTab.getAttribute('id');
    const historyId = await historyTab.getAttribute('id');
    assert.ok(panelId && vocabId && historyId);
    assert.equal(await vocabTab.getAttribute('aria-controls'), panelId);
    assert.equal(await historyTab.getAttribute('aria-controls'), panelId);
    assert.equal(await vocabTab.getAttribute('aria-selected'), 'true');
    assert.equal(await historyTab.getAttribute('aria-selected'), 'false');
    assert.equal(await vocabTab.getAttribute('tabindex'), '0');
    assert.equal(await historyTab.getAttribute('tabindex'), '-1');
    assert.equal(await panel.getAttribute('aria-labelledby'), vocabId);

    // T1-F9-02 & T2-F9-01: ArrowRight / ArrowLeft wrap-around, Home, End
    await vocabTab.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await historyTab.getAttribute('aria-selected'), 'true');
    assert.equal(await historyTab.getAttribute('tabindex'), '0');
    assert.equal(await vocabTab.getAttribute('tabindex'), '-1');
    assert.equal(await panel.getAttribute('aria-labelledby'), historyId);
    assert.equal(await page.evaluate(() => document.activeElement?.id), historyId);

    // Wrap-around ArrowRight from last -> first
    await page.keyboard.press('ArrowRight');
    assert.equal(await vocabTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), vocabId);

    // Wrap-around ArrowLeft from first -> last
    await page.keyboard.press('ArrowLeft');
    assert.equal(await historyTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), historyId);

    // Home -> first, End -> last, Home -> first
    await page.keyboard.press('Home');
    assert.equal(await vocabTab.getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End');
    assert.equal(await historyTab.getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await vocabTab.getAttribute('aria-selected'), 'true');

    // T2-F9-01 & T2-F9-02: Arrow keys in search <input> must NOT hijack tab switching; filter persists across tab switch
    const search = dialog.getByRole('searchbox');
    await search.fill('alpha');
    assert.equal(await panel.locator('.list-row').count(), 1);
    await search.press('ArrowLeft');
    await search.press('ArrowRight');
    assert.equal(await vocabTab.getAttribute('aria-selected'), 'true', 'Arrow keys inside search input must not switch tabs.');

    await historyTab.click();
    assert.equal(await search.inputValue(), 'alpha', 'Search query must persist across tab switches.');
    assert.equal(await panel.locator('.list-row').count(), 1);
    await vocabTab.click();
    await search.fill('');
    assert.equal(await panel.locator('.list-row').count(), 2);

    // Delete first vocabulary item and verify focus remains valid inside dialog (not lost to document.body)
    await panel.locator('.list-row').first().getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#collections-panel .list-row').length === 1);
    const focusAfterFirstDelete = await page.evaluate(() => ({
      inDialog: Boolean(document.getElementById('dialog')?.contains(document.activeElement)),
      tag: document.activeElement?.tagName
    }));
    assert.equal(focusAfterFirstDelete.inDialog, true, 'Focus must stay inside dialog after deleting a vocabulary item.');
    assert.equal(focusAfterFirstDelete.tag, 'BUTTON');

    // Delete remaining vocabulary item -> focus returns to active tab
    await panel.locator('.list-row').first().getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#collections-panel .list-row').length === 0);
    assert.equal(await page.evaluate(() => document.activeElement?.id), vocabId, 'Deleting last item must return focus to active tab.');

    await page.locator('#closeDialog').click();
    console.log('PASS F9 (Collections ARIA): role=tablist/tab/tabpanel, Arrow/Home/End wrap-around, search isolation & focus restoration.');

    // --- Block 2: F9 library.delete SQLite + localStorage Cascade & Active-Doc Fallback (T1-F9-03..05, T2-F9-03..06) ---
    const pdfA = await makePdf(context, 'Delete Target Paper A', 'Unique content for document alpha deletion test.');
    const pdfB = await makePdf(context, 'Control Paper B', 'Unique content for document beta control test.');
    const importA = await context.request.post(host.origin + '/api/paper-reader/import-pdf?title=Alpha-Delete.pdf', {
      headers: { 'Content-Type': 'application/pdf' }, data: pdfA
    });
    const importB = await context.request.post(host.origin + '/api/paper-reader/import-pdf?title=Beta-Keep.pdf', {
      headers: { 'Content-Type': 'application/pdf' }, data: pdfB
    });
    assert.equal(importA.status(), 200);
    assert.equal(importB.status(), 200);
    const docA = ((await importA.json()) as { doc: { id: string } }).doc;
    const docB = ((await importB.json()) as { doc: { id: string } }).doc;

    // Populate SQLite rows across tables for BOTH Doc A and Doc B
    for (const doc of [docA, docB]) {
      const url = host.origin + appPath + '?doc=' + doc.id + '&page=1';
      assert.equal((await rpc(context, host, 'vocab.save', {
        docId: doc.id, title: doc.id, page: 1, anchor: 'p1', label: 'Page 1', sourceUrl: url,
        text: 'term-' + doc.id.slice(0, 8), meaning: 'def', context: 'ctx'
      })).status(), 200);
      assert.equal((await rpc(context, host, 'history.add', {
        docId: doc.id, title: doc.id, page: 1, anchor: 'p1', label: 'Page 1', sourceUrl: url,
        text: 'lookup-' + doc.id.slice(0, 8), meaning: 'def', context: 'ctx'
      })).status(), 200);
      assert.equal((await rpc(context, host, 'annotation.save', {
        id: randomUUID(), docId: doc.id, title: doc.id, page: 1, anchor: 'point-500000-500000', label: 'Page note',
        sourceUrl: url, kind: 'pin', color: 'purple', quote: '', text: 'pin-' + doc.id.slice(0, 8),
        point: { x: 0.5, y: 0.5 }
      })).status(), 200);
      const nb = await (await rpc(context, host, 'notebook.get', { docId: doc.id, title: doc.id, page: 1, sourceUrl: url })).json() as { revision: string };
      assert.equal((await rpc(context, host, 'notebook.write', {
        docId: doc.id, title: doc.id, page: 1, sourceUrl: url, expectedRevision: nb.revision, markdown: '# Notes for ' + doc.id
      })).status(), 200);
    }

    // Open Doc A (active!) and populate localStorage keys for both Doc A & Doc B
    await page.goto(host.origin + appPath + '?doc=' + docA.id + '&page=1', { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').waitFor({ state: 'hidden' });
    await page.evaluate(({ idA, idB }) => {
      for (const id of [idA, idB]) {
        localStorage.setItem('reader.page.' + id, '1');
        localStorage.setItem('reader.tab.' + id, 'notes');
        localStorage.setItem('reader.pdf-pages.' + id, '1');
        localStorage.setItem('reader.focus.' + id + '.1', 'p1-b1');
        localStorage.setItem('reader.book-position.' + id, JSON.stringify({ page: 1, anchor: 'p1', fraction: 0, side: 'source', updated: 1 }));
        localStorage.setItem('reader.zotero.user:1:' + id, 'ITEMKEY');
      }
    }, { idA: docA.id, idB: docB.id });

    // Open Notes sidebar on active Doc A and dirty the editor to stress-test active-doc resurrection race!
    await page.locator('#mobileRail').click();
    const editor = page.getByRole('textbox', { name: 'Notes Markdown' });
    await editor.click();
    await page.keyboard.type(' unsaved-edit-before-delete');

    // Delete active Doc A through Library UI two-step confirmation
    await page.locator('#library').click();
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('tab', { name: 'On this device', exact: true }).click();
    const rowA = dialog.locator('.library-device-item').filter({ hasText: 'Alpha-Delete.pdf' });
    await rowA.getByRole('button', { name: 'Delete document', exact: true }).click();
    await rowA.getByRole('button', { name: 'Confirm delete', exact: true }).click();

    await dialog.getByText('Document removed from this device.', { exact: true }).waitFor();
    assert.equal(await rowA.count(), 0);
    // Reader navigated gracefully back to pagedattention
    await page.waitForURL(url => url.searchParams.get('doc') === 'pagedattention');
    await page.locator('#loading').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#docTitle').innerText(), 'PagedAttention.pdf');

    // Verify library.list omits Doc A, library.get returns 404, disk files removed
    const listAfter = await (await rpc(context, host, 'library.list')).json() as { docs: { id: string }[] };
    assert.equal(listAfter.docs.some(d => d.id === docA.id), false);
    assert.equal(listAfter.docs.some(d => d.id === docB.id), true);
    assert.equal((await rpc(context, host, 'library.get', { id: docA.id })).status(), 404);
    assert.equal(existsSync(path.join(host.scratch, 'reader', 'documents', docA.id + '.pdf')), false);
    assert.equal(existsSync(path.join(host.scratch, 'reader', 'documents', docB.id + '.pdf')), true);

    // Direct node:sqlite inspection on isolated PAPER_READER_HOME/reader.sqlite (T1-F9-04 & T2-F9-06)
    const db = new DatabaseSync(path.join(host.scratch, 'reader', 'reader.sqlite'), { readOnly: true });
    try {
      const prefixA = docA.id + '\u001f';
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', docA.id), 0);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', docA.id), 0);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM chat_exchanges WHERE docId=?', docA.id), 0);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=? OR substr(docId,1,?)=?', docA.id, prefixA.length, prefixA), 0, 'Active-doc delete must NOT resurrect notebook_documents!');
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_vaults WHERE docId=? OR substr(docId,1,?)=?', docA.id, prefixA.length, prefixA), 0);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebooks WHERE docId=? OR substr(docId,1,?)=?', docA.id, prefixA.length, prefixA), 0);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM book_positions WHERE docId=?', docA.id), 0, 'Active-doc delete must NOT resurrect book_positions!');
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM pdf_outlines WHERE docId=?', docA.id), 0);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM article_captures WHERE docId=?', docA.id), 0);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM citations WHERE identity=?', 'document/' + docA.id), 0);

      // Doc B retains 100% of its rows
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', docB.id), 2);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', docB.id), 1);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=?', docB.id), 1);
    } finally { db.close(); }

    // localStorage hygiene & Doc B isolation (T1-F9-05 & T2-F9-06)
    const storageAudit = await page.evaluate(({ idA, idB }) => {
      const keys = Object.keys(localStorage);
      return {
        remainingA: keys.filter(k => k.includes(idA)),
        remainingB: keys.filter(k => k.includes(idB)),
        lastDoc: localStorage.getItem('reader.last-document')
      };
    }, { idA: docA.id, idB: docB.id });
    assert.deepEqual(storageAudit.remainingA, [], 'All localStorage keys for deleted Doc A must be purged.');
    assert.ok(storageAudit.remainingB.length >= 6, 'Control Doc B localStorage keys must remain intact.');
    assert.equal(storageAudit.lastDoc, 'pagedattention');

    // T2-F9-04: Delete last user-imported document (Doc B) -> pagedattention remains with NO delete button
    const rowB = dialog.locator('.library-device-item').filter({ hasText: 'Beta-Keep.pdf' });
    await rowB.getByRole('button', { name: 'Delete document', exact: true }).click();
    await rowB.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await rowB.waitFor({ state: 'detached' });
    await dialog.locator('.doc-row').filter({ hasText: 'PagedAttention.pdf' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /Delete document/ }).count(), 0, 'Bundled sample must never have a delete button.');
    await page.locator('#closeDialog').click();

    // T2-F9-05: RPC boundary responses (400 sample, 404 traversal/malformed, 200 { deleted: false } nonexistent)
    assert.equal((await rpc(context, host, 'library.delete', { id: 'pagedattention' })).status(), 400);
    assert.equal((await rpc(context, host, 'library.delete', { id: '../escape' })).status(), 404);
    assert.equal((await rpc(context, host, 'library.delete', { id: 'pdf-bad' })).status(), 404);
    const missingId = 'pdf-' + 'f'.repeat(64);
    const missingRes = await rpc(context, host, 'library.delete', { id: missingId });
    assert.equal(missingRes.status(), 200);
    assert.deepEqual(await missingRes.json(), { id: missingId, deleted: false });

    assert.deepEqual(pageErrors, [], 'F9 pageerrors: ' + pageErrors.join('; '));
    assert.deepEqual(consoleErrors, [], 'F9 console errors: ' + consoleErrors.join('; '));
    await context.close();
    console.log('PASS F9 (library.delete cascade): SQLite 10-table purge, zero active-doc resurrection, localStorage cleanup, Doc B isolation, and RPC boundaries.');
  } finally { await browser.close(); }
});
