import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type Page, type Response, type Route } from 'playwright-core';
import { bookRoot, sections, startPublisherFixture } from './book-reading-fixture.js';
import { assertMobilePanelTargets } from './helpers/dom-probes.js';
import { assertZeroSqliteRows, countRows } from './helpers/fixtures.js';
import { attachErrorGuards, makePdf, rpc, type ErrorScope } from './helpers/reader.js';
import { withHost } from './host.js';

const appPath = '/api/paper-reader/app/index.html';
const preload = new URL('./book-reading-preload.ts', import.meta.url).href;

const logFile = path.join(os.tmpdir(), 'paper-reader-collections-hygiene-' + randomUUID() + '.ndjson');
await writeFile(logFile, '', { flag: 'wx' });
try {
  const fixture = await startPublisherFixture();
  try {
    await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const page: Page = await context.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const errorScope: ErrorScope = { allowZotero503: true, allowExpected404: true, allowExpected500: false };
    attachErrorGuards(page, 'F9', errorScope, pageErrors, consoleErrors);

    await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });

    // --- Block 1: F9 Collections WAI-ARIA Tablist (T1-F9-01, T1-F9-02, T2-F9-01, T2-F9-02) ---
    const sourceUrl = host.origin + appPath + '?doc=pagedattention&page=6&anchor=block-tables';
    for (const word of ['alpha-term', 'beta-term']) {
      const r = await rpc(context.request, host.origin, 'vocab.save', {
        docId: 'pagedattention', title: 'PagedAttention.pdf', page: 6, anchor: 'block-tables',
        label: 'Left column', sourceUrl, text: word, meaning: 'Meaning for ' + word, context: 'Context'
      });
      assert.equal(r.status, 200);
    }
    const histRes = await rpc(context.request, host.origin, 'history.add', {
      docId: 'pagedattention', title: 'PagedAttention.pdf', page: 6, anchor: 'block-tables',
      label: 'Left column', sourceUrl, text: 'alpha-term', meaning: 'History meaning', context: 'Context'
    });
    assert.equal(histRes.status, 200);

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
    await page.setViewportSize({ width: 390, height: 844 });
    await assertMobilePanelTargets(page, '#dialog');
    await page.setViewportSize({ width: 1440, height: 900 });

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
    const pdfA = await makePdf(context, 'Delete Target Paper A', ['Unique content for document alpha deletion test.']);
    const pdfB = await makePdf(context, 'Control Paper B', ['Unique content for document beta control test.']);
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

    for (const doc of [docA, docB]) {
      const url = host.origin + appPath + '?doc=' + doc.id + '&page=1';
      assert.equal((await rpc(context.request, host.origin, 'vocab.save', {
        docId: doc.id, title: doc.id, page: 1, anchor: 'p1', label: 'Page 1', sourceUrl: url,
        text: 'term-' + doc.id.slice(0, 8), meaning: 'def', context: 'ctx'
      })).status, 200);
      assert.equal((await rpc(context.request, host.origin, 'history.add', {
        docId: doc.id, title: doc.id, page: 1, anchor: 'p1', label: 'Page 1', sourceUrl: url,
        text: 'lookup-' + doc.id.slice(0, 8), meaning: 'def', context: 'ctx'
      })).status, 200);
      assert.equal((await rpc(context.request, host.origin, 'annotation.save', {
        id: randomUUID(), docId: doc.id, title: doc.id, page: 1, anchor: 'point-500000-500000', label: 'Page note',
        sourceUrl: url, kind: 'pin', color: 'purple', quote: '', text: 'pin-' + doc.id.slice(0, 8),
        point: { x: 0.5, y: 0.5 }
      })).status, 200);
      const nb = (await rpc<{ revision: string }>(context.request, host.origin, 'notebook.get', { docId: doc.id, title: doc.id, page: 1, sourceUrl: url })).body;
      assert.equal((await rpc(context.request, host.origin, 'notebook.write', {
        docId: doc.id, title: doc.id, page: 1, sourceUrl: url, expectedRevision: nb.revision, markdown: '# Notes for ' + doc.id
      })).status, 200);
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
        sessionStorage.setItem('reader.selection-note-draft.' + JSON.stringify([id, 1, 'p1', 'quote']), 'unsaved selection note');
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
    assert.equal(await dialog.getByRole('tab', { name: 'On this device', exact: true }).getAttribute('aria-selected'), 'true');
    const rowA = dialog.locator('.library-device-item').filter({ hasText: 'Alpha-Delete.pdf' });
    const delA = rowA.getByRole('button', { name: 'Delete document', exact: true });
    assert.ok((await delA.locator('path').getAttribute('d'))?.startsWith('M4 7h16'));
    await delA.click();
    const cancelDel = rowA.getByRole('button', { name: 'Cancel', exact: true });
    await cancelDel.waitFor({ state: 'visible' });
    assert.equal(await cancelDel.evaluate(el => document.activeElement === el), true);
    await cancelDel.click();
    assert.equal(await rowA.count(), 1);
    assert.equal(await delA.evaluate(el => document.activeElement === el), true);
    await delA.click();
    await rowA.getByRole('button', { name: 'Confirm delete', exact: true }).click();

    await dialog.getByText('Document removed from this device.', { exact: true }).waitFor();
    assert.equal(await rowA.count(), 0);
    // Reader navigated gracefully back to pagedattention
    await page.waitForURL(url => url.searchParams.get('doc') === 'pagedattention');
    await page.locator('#loading').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#docTitle').innerText(), 'PagedAttention.pdf');

    const listAfter = (await rpc<{ docs: { id: string }[] }>(context.request, host.origin, 'library.list')).body;
    assert.equal(listAfter.docs.some(d => d.id === docA.id), false);
    assert.equal(listAfter.docs.some(d => d.id === docB.id), true);
    assert.equal((await rpc(context.request, host.origin, 'library.get', { id: docA.id })).status, 404);
    assert.equal(existsSync(path.join(host.scratch, 'reader', 'documents', docA.id + '.pdf')), false);
    assert.equal(existsSync(path.join(host.scratch, 'reader', 'documents', docB.id + '.pdf')), true);

    const dbPath = path.join(host.scratch, 'reader', 'reader.sqlite');
    assertZeroSqliteRows(dbPath, docA.id);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', docB.id), 2);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', docB.id), 1);
      assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=?', docB.id), 1);
    } finally { db.close(); }

    // localStorage & sessionStorage hygiene + Doc B isolation (T1-F9-05 & T2-F9-06)
    const storageAudit = await page.evaluate(({ idA, idB }) => {
      const keys = Object.keys(localStorage);
      const sessionKeys = Object.keys(sessionStorage);
      return {
        remainingA: keys.filter(k => k.includes(idA)),
        remainingB: keys.filter(k => k.includes(idB)),
        remainingSessionA: sessionKeys.filter(k => k.includes(idA)),
        remainingSessionB: sessionKeys.filter(k => k.includes(idB)),
        lastDoc: localStorage.getItem('reader.last-document')
      };
    }, { idA: docA.id, idB: docB.id });
    assert.deepEqual(storageAudit.remainingA, [], 'All localStorage keys for deleted Doc A must be purged.');
    assert.ok(storageAudit.remainingB.length >= 6, 'Control Doc B localStorage keys must remain intact.');
    assert.deepEqual(storageAudit.remainingSessionA, [], 'All sessionStorage draft keys (including selection-note-draft JSON key) for Doc A must be purged.');
    assert.ok(storageAudit.remainingSessionB.some(k => k.startsWith('reader.selection-note-draft.[')), 'Control Doc B selection-note-draft sessionStorage key must remain intact.');
    assert.equal(storageAudit.lastDoc, 'pagedattention');

    // T2-F9-04: Delete last user-imported document (Doc B) -> pagedattention remains with NO delete button
    const rowB = dialog.locator('.library-device-item').filter({ hasText: 'Beta-Keep.pdf' });
    await rowB.getByRole('button', { name: 'Delete document', exact: true }).click();
    await rowB.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await rowB.waitFor({ state: 'detached' });
    await dialog.locator('.doc-row').filter({ hasText: 'PagedAttention.pdf' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /Delete document/ }).count(), 0, 'Bundled sample must never have a delete button.');
    await page.locator('#closeDialog').click();

    // --- Block 3: Active OpenStax book delete regression (prevents book_positions SQLite resurrection) ---
    for (const suppressScrollend of [false, true]) {
      const openBookRes = await rpc<{ doc: { id: string; title: string } }>(context.request, host.origin, 'web.open', { url: bookRoot + sections.start.slug });
      assert.equal(openBookRes.status, 200);
      const { doc: bookDoc } = openBookRes.body;
      await page.goto(host.origin + appPath + '?doc=' + bookDoc.id + '&page=2', { waitUntil: 'domcontentloaded' });
      await page.locator('#loading').waitFor({ state: 'hidden' });

      // Scroll into paragraph so book_positions is recorded in SQLite before deletion
      await page.evaluate(({ id, suppress }) => {
        const scroller = document.getElementById('paperScroll')!;
        if (suppress) {
          scroller.addEventListener('scrollend', event => event.stopImmediatePropagation(), { capture: true });
        }
        scroller.scrollTop = 320;
        sessionStorage.setItem('reader.selection-note-draft.' + JSON.stringify([id, 2, 'p-3', 'book quote']), 'draft note');
      }, { id: bookDoc.id, suppress: suppressScrollend });
      await page.waitForTimeout(350);

      const dbBefore = new DatabaseSync(path.join(host.scratch, 'reader', 'reader.sqlite'), { readOnly: true });
      try {
        assert.equal(countRows(dbBefore, 'SELECT COUNT(*) AS n FROM book_positions WHERE docId=?', bookDoc.id), 1,
          'Expected initial book_positions row before deleting active book.');
      } finally { dbBefore.close(); }

      // Open Library -> On this device -> click Delete to reveal Confirm delete
      await page.locator('#library').click();
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByRole('tab', { name: 'On this device', exact: true }).click();
      const bookRow = dialog.locator('.library-device-item').filter({ hasText: bookDoc.title });
      await bookRow.getByRole('button', { name: 'Delete document', exact: true }).click();

      // Nudge scrollTop within the same paragraph (arms the 200 ms pending debounce timer & scrollend) and delete immediately!
      await page.evaluate(() => {
        const scroller = document.getElementById('paperScroll')!;
        scroller.scrollTop += 3;
      });
      await bookRow.getByRole('button', { name: 'Confirm delete', exact: true }).click();
      await page.waitForURL(url => url.searchParams.get('doc') === 'pagedattention');
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await page.locator('#closeDialog').click();

      // Wait well past the 200 ms debounce window to prove no stale save resurrects book_positions
      await page.waitForTimeout(600);
      const dbAfter = new DatabaseSync(path.join(host.scratch, 'reader', 'reader.sqlite'), { readOnly: true });
      try {
        assert.equal(countRows(dbAfter, 'SELECT COUNT(*) AS n FROM book_positions WHERE docId=?', bookDoc.id), 0,
          `Active OpenStax book delete (suppressScrollend=${suppressScrollend}) must NOT resurrect book_positions!`);
      } finally { dbAfter.close(); }

      const bookStorage = await page.evaluate(id => ({
        local: Object.keys(localStorage).filter(k => k.includes(id)),
        session: Object.keys(sessionStorage).filter(k => k.includes(id))
      }), bookDoc.id);
      assert.deepEqual(bookStorage.local, [], `Deleted book localStorage keys must be empty (suppressScrollend=${suppressScrollend}).`);
      assert.deepEqual(bookStorage.session, [], `Deleted book sessionStorage keys must be empty (suppressScrollend=${suppressScrollend}).`);
    }
    console.log('PASS F9 (active OpenStax book delete): 0 book_positions resurrection with normal scrollend and suppressed scrollend + 0 localStorage/sessionStorage orphans.');

    // --- Block 4: Active-doc HTTP 500 library.delete rollback regressions (zero editor/draft/scroll loss) ---
    // 4A: Active OpenStax book HTTP 500 rollback
    {
      const openBookRes = await rpc<{ doc: { id: string; title: string } }>(context.request, host.origin, 'web.open', { url: bookRoot + sections.start.slug });
      assert.equal(openBookRes.status, 200);
      const { doc: bookDoc } = openBookRes.body;
      await page.goto(host.origin + appPath + '?doc=' + bookDoc.id + '&page=2', { waitUntil: 'domcontentloaded' });
      await page.locator('#loading').waitFor({ state: 'hidden' });

      // Ensure Notes tab is open and CodeMirror is mounted
      if (await page.locator('#rail').isHidden()) await page.locator('#mobileRail').click();
      await page.locator('#notesTab').click();
      await page.locator('.reader-notebook .cm-editor').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.reader-notebook .cm-editor').count(), 1);

      // Scroll so initial book position is saved before the failed delete
      await page.evaluate(() => { document.getElementById('paperScroll')!.scrollTop = 260; });
      await page.waitForTimeout(350);
      const lsPlaceBefore = await page.evaluate(id => localStorage.getItem('reader.book-position.' + id), bookDoc.id);
      assert.ok(lsPlaceBefore, 'Expected initial localStorage book position before simulated HTTP 500 delete.');

      // Intercept library.delete with HTTP 500
      const route500 = async (route: Route) => {
        const body = route.request().postDataJSON() as { op?: string } | null;
        if (body?.op === 'library.delete') {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated delete failure 500' }) });
          return;
        }
        await route.continue();
      };
      await page.route('**/api/paper-reader/action', route500);
      errorScope.allowExpected500 = true;
      try {
        await page.locator('#library').click();
        await dialog.waitFor({ state: 'visible' });
        await dialog.getByRole('tab', { name: 'On this device', exact: true }).click();
        const bookRow = dialog.locator('.library-device-item').filter({ hasText: bookDoc.title });
        await bookRow.getByRole('button', { name: 'Delete document', exact: true }).click();
        await bookRow.getByRole('button', { name: 'Confirm delete', exact: true }).click();
        await page.locator('#toast').filter({ hasText: 'Simulated delete failure 500' }).waitFor({ state: 'visible' });
      } finally {
        errorScope.allowExpected500 = false;
        await page.unroute('**/api/paper-reader/action', route500);
      }
      await page.locator('#closeDialog').click();

      // Notes editor remains mounted and active book remains open
      assert.equal(new URL(page.url()).searchParams.get('doc'), bookDoc.id);
      assert.equal(await page.locator('.reader-notebook .cm-editor').count(), 1, 'Notes editor must stay mounted after HTTP 500 active-book delete.');

      // Scrolling paperScroll must continue triggering book.progress.save and updating localStorage
      let postRollbackSaves = 0;
      const onResponse = (res: Response) => {
        if (!res.url().endsWith('/api/paper-reader/action')) return;
        const body = res.request().postDataJSON() as { op?: string } | null;
        if (body?.op === 'book.progress.save' && res.status() === 200) postRollbackSaves++;
      };
      page.on('response', onResponse);
      try {
        await page.evaluate(() => { document.getElementById('paperScroll')!.scrollTop = 580; });
        await page.waitForTimeout(450);
      } finally {
        page.off('response', onResponse);
      }
      const lsPlaceAfter = await page.evaluate(id => localStorage.getItem('reader.book-position.' + id), bookDoc.id);
      assert.ok(postRollbackSaves >= 1, `Expected book.progress.save after HTTP 500 rollback, got ${postRollbackSaves}.`);
      assert.notEqual(lsPlaceAfter, lsPlaceBefore, 'localStorage book position must continue updating on scroll after HTTP 500 delete failure.');
    }

    // 4B: Active PDF with dirty Notes HTTP 500 rollback
    {
      const pdfRollback = await makePdf(context, 'Rollback Paper 500', ['Unique text for HTTP 500 active PDF delete rollback test.']);
      const importRollback = await context.request.post(host.origin + '/api/paper-reader/import-pdf?title=Rollback-500.pdf', {
        headers: { 'Content-Type': 'application/pdf' }, data: pdfRollback
      });
      assert.equal(importRollback.status(), 200);
      const pdfDoc = ((await importRollback.json()) as { doc: { id: string } }).doc;

      await page.goto(host.origin + appPath + '?doc=' + pdfDoc.id + '&page=1', { waitUntil: 'domcontentloaded' });
      await page.locator('#loading').waitFor({ state: 'hidden' });
      if (await page.locator('#rail').isHidden()) await page.locator('#mobileRail').click();
      await page.locator('#notesTab').click();
      await page.locator('.reader-notebook .cm-editor').waitFor({ state: 'visible' });

      // Hold any background notebook.write until after asserting the unsaved draft survived the 500 delete
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
      const routePdf500 = async (route: Route) => {
        const body = route.request().postDataJSON() as { op?: string } | null;
        if (body?.op === 'library.delete') {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated PDF delete 500' }) });
          return;
        }
        if (body?.op === 'notebook.write') {
          await writeGate;
        }
        await route.continue();
      };
      await page.route('**/api/paper-reader/action', routePdf500);
      const draftMarker = 'Unsaved rollback draft marker';
      errorScope.allowExpected500 = true;
      try {
        const notesEditor = page.getByRole('textbox', { name: 'Notes Markdown' });
        await notesEditor.click();
        await page.keyboard.type(draftMarker);
        const draftBefore = await page.evaluate(id => sessionStorage.getItem('reader.markdown-draft.' + id), pdfDoc.id);
        assert.ok(draftBefore?.includes(draftMarker), 'Expected dirty Notes draft in sessionStorage before failed delete.');

        await page.locator('#library').click();
        await dialog.waitFor({ state: 'visible' });
        await dialog.getByRole('tab', { name: 'On this device', exact: true }).click();
        const pdfRow = dialog.locator('.library-device-item').filter({ hasText: 'Rollback-500.pdf' });
        await pdfRow.getByRole('button', { name: 'Delete document', exact: true }).click();
        await pdfRow.getByRole('button', { name: 'Confirm delete', exact: true }).click();
        await page.locator('#toast').filter({ hasText: 'Simulated PDF delete 500' }).waitFor({ state: 'visible' });
        await page.locator('#closeDialog').click();

        // Editor remains mounted and unsaved text + sessionStorage draft remain 100% intact
        assert.equal(await page.locator('.reader-notebook .cm-editor').count(), 1, 'Notes editor must stay mounted after HTTP 500 active-PDF delete.');
        assert.ok((await page.locator('.reader-notebook .cm-content').innerText()).includes(draftMarker), 'Unsaved Notes text must remain in CodeMirror after HTTP 500 delete.');
        const draftAfter = await page.evaluate(id => sessionStorage.getItem('reader.markdown-draft.' + id), pdfDoc.id);
        assert.ok(draftAfter?.includes(draftMarker), 'Unsaved reader.markdown-draft.<id> must remain intact in sessionStorage after HTTP 500 delete.');
      } finally {
        errorScope.allowExpected500 = false;
        releaseWrite();
        await page.unroute('**/api/paper-reader/action', routePdf500);
      }

      // Switching Marks -> Notes keeps the editor mounted and usable
      await page.locator('#annotationsTab').click();
      await page.locator('#notesTab').click();
      await page.locator('.reader-notebook .cm-editor').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.reader-notebook .cm-editor').count(), 1, 'Notes editor must remain mounted after Marks -> Notes tab bounce.');
      const notesEditorAfter = page.getByRole('textbox', { name: 'Notes Markdown' });
      await notesEditorAfter.click();
      await page.keyboard.type(' + still usable');
      const finalEditorText = await page.locator('.reader-notebook .cm-content').innerText();
      assert.ok(finalEditorText.includes(draftMarker) && finalEditorText.includes('still usable'), 'Notes editor must remain editable after HTTP 500 delete rollback.');
    }
    console.log('PASS F9 (active-doc HTTP 500 delete rollback): OpenStax scroll tracking & dirty PDF Notes editor/draft remain 100% intact.');

    // T2-F9-05: RPC boundary responses (400 sample, 404 traversal/malformed, 200 { deleted: false } nonexistent)
    assert.equal((await rpc(context.request, host.origin, 'library.delete', { id: 'pagedattention' })).status, 400);
    assert.equal((await rpc(context.request, host.origin, 'library.delete', { id: '../escape' })).status, 404);
    assert.equal((await rpc(context.request, host.origin, 'library.delete', { id: 'pdf-bad' })).status, 404);
    const missingId = 'pdf-' + 'f'.repeat(64);
    const missingRes = await rpc(context.request, host.origin, 'library.delete', { id: missingId });
    assert.equal(missingRes.status, 200);
    assert.deepEqual(missingRes.body, { id: missingId, deleted: false });

    assert.deepEqual(pageErrors, [], 'F9 pageerrors: ' + pageErrors.join('; '));
    assert.deepEqual(consoleErrors, [], 'F9 console errors: ' + consoleErrors.join('; '));
    await context.close();
    console.log('PASS F9 (library.delete cascade): SQLite 10-table purge, zero active-doc resurrection, localStorage cleanup, Doc B isolation, and RPC boundaries.');
  } finally { await browser.close(); }
    }, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' '),
      PAPER_READER_E2E_PUBLISHER_FIXTURE: fixture.origin,
      PAPER_READER_E2E_PUBLISHER_LOG: logFile
    });
  } finally { await fixture.close(); }
} finally { await rm(logFile, { force: true }); }
