import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { until } from './extension-controls.js';
import { assertDarkAndContrast } from './helpers/contrast.js';
import { inspectTranslatedBlocks } from './helpers/dom-probes.js';
import { startVersatileLlmFixture } from './helpers/fixtures.js';
import { authContext, openReaderPage, resetSettings, rpc, type ErrorScope } from './helpers/reader.js';
import { withHost } from './host.js';
import { dragBox } from './selection-gestures.js';

const llm = await startVersatileLlmFixture('tier3-llm-fixture');
try {
  await withHost(async host => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const browser = await chromium.launch({
      executablePath: host.executable,
      headless: process.env.PAPER_READER_HEADED !== '1'
    });

    try {
      {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
        const scope: ErrorScope = { allowZotero503: true };
        try {
          await authContext(ctx, host);
          await resetSettings(ctx.request, host.origin, {
            baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'German'
          });
          const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', { tag: 'T3-09', scope, pageErrors, consoleErrors });

          await page.locator('#captureRegion').click();
          await page.locator('.pdf-capture-surface').waitFor({ state: 'visible' });
          const fig = page.locator('#original .pdf-figure[data-block-id="figure-6"]');
          await fig.scrollIntoViewIfNeeded();
          const rect = (await fig.boundingBox())!;
          await dragBox(
            page,
            { x: Math.round(rect.x + rect.width * 0.08), y: Math.round(rect.y + rect.height * 0.16) },
            { x: Math.round(rect.x + rect.width * 0.62), y: Math.round(rect.y + rect.height * 0.80) },
            false
          );
          const captureActions = page.locator('.pdf-capture-actions');
          await captureActions.waitFor({ state: 'visible' });
          await assertDarkAndContrast(captureActions.getByRole('button', { name: 'Ask', exact: true }), 'T3-09 capture Ask', 0.12, 4.5);

          llm.setHoldNext(true);
          const heldPromise = llm.waitForHeldRequest();
          await captureActions.getByRole('button', { name: 'Ask', exact: true }).click();
          const composer = page.locator('#card .selection-chat textarea');
          await composer.waitFor({ state: 'visible' });
          const question = 'Was zeigt dieses Blockzuordnungsdiagramm?';
          await composer.fill(question);
          await composer.press('Enter');

          const stopBtn = page.locator('#card').getByRole('button', { name: 'Stop', exact: true });
          await stopBtn.waitFor({ state: 'visible' });
          await heldPromise;
          const heldCall = llm.calls.at(-1);
          assert.ok(heldCall?.hasValidPng, 'Vision request must carry valid PNG bytes decoded by sharp');
          assert.ok(heldCall?.target === 'German', 'Vision request must target German');

          await stopBtn.click();
          await stopBtn.waitFor({ state: 'hidden' });
          await until(() => llm.getAbortedCount() >= 1, 'Expected Stop button to abort in-flight LLM request');
          assert.equal(await page.locator('#card .selection-answer').count(), 0);
          assert.equal(await page.locator('#card .chat-error:visible').count(), 0);
          assert.equal(await composer.inputValue(), question, 'Aborted prompt must be restored in composer');

          await composer.press('Enter');
          await page.locator('#card .selection-answer').getByText('Deutsche Antwort:').waitFor();
          const previewWidth = await page.locator('#card img').first().evaluate(img => (img as HTMLImageElement).naturalWidth);
          assert.ok(previewWidth > 0, 'Cropped PNG preview must render with naturalWidth > 0');

          await page.locator('#card').getByRole('button', { name: 'Close chat', exact: true }).click();
          await page.locator('#card').waitFor({ state: 'hidden' });

          await page.locator('#placePin').click();
          await page.mouse.click(rect.x + rect.width * 0.2, rect.y + rect.height * 0.3);
          const popover = page.locator('.annotation-popover');
          await popover.waitFor({ state: 'visible' });
          await assertDarkAndContrast(popover.getByRole('textbox', { name: 'Comment' }), 'T3-09 pin popover', 0.12, 4.5);
          await popover.getByRole('textbox', { name: 'Comment' }).fill('German pin check');
          await popover.getByRole('button', { name: 'Save', exact: true }).click();
          await popover.waitFor({ state: 'hidden' });
          await page.locator('#original .annotation-pin').first().waitFor({ state: 'visible' });
          const listed = await rpc<{ annotations: { text: string }[] }>(ctx.request, host.origin, 'annotation.list', { docId: 'pagedattention' });
          assert.ok(listed.body.annotations.some(a => a.text === 'German pin check'));

          await resetSettings(ctx.request, host.origin);
          console.log('PASS T3-09: PDF region screenshot (sharp) + German + Stop abort recovery + dark Marks pin.');
        } finally {
          llm.releaseHeld();
          await ctx.close();
        }
      }

      {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
        const scope: ErrorScope = { allowZotero503: true };
        try {
          await authContext(ctx, host);
          await resetSettings(ctx.request, host.origin, {
            baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'Japanese'
          });
          const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', { tag: 'T3-10', scope, pageErrors, consoleErrors });
          await page.locator('#parallel').click();
          await page.getByLabel('Translation scope').selectOption('page');
          await page.locator('#mobileRail').click();
          await page.locator('#rail').waitFor({ state: 'visible' });
          await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').first().waitFor();

          const pdfSheetStyle = await page.locator('#original .pdf-sheet').evaluate(el => ({
            bg: getComputedStyle(el).backgroundColor,
            scheme: getComputedStyle(el).colorScheme
          }));
          assert.equal(pdfSheetStyle.bg, 'rgb(255, 255, 255)', '.pdf-sheet must stay white paper');
          assert.equal(pdfSheetStyle.scheme, 'light', '.pdf-sheet must declare light color-scheme');
          await assertDarkAndContrast(page.locator('.topbar #docTitle'), 'T3-10 dark topbar', 0.08, 4.5);
          await assertDarkAndContrast(page.locator('#rail #notesTab'), 'T3-10 dark rail', 0.08, 4.5);

          await until(async () => {
            const m = await inspectTranslatedBlocks(page);
            return m.bodySizes.length > 0 && m.bodySizes.every(b => b.visualFont >= 11.5);
          }, '1440px Japanese bilingual body blocks must meet >= 11.5px visual font floor');
          const metrics = await inspectTranslatedBlocks(page);
          assert.equal(metrics.overlaps, 0, 'Japanese translated blocks must not overlap');
          assert.ok(metrics.pageOverflow <= 1, 'Zero horizontal overflow at 1440px');

          for (const width of [1440, 1380]) {
            await page.setViewportSize({ width, height: 900 });
            const statusSize = await page.locator('.notebook-status').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
            assert.ok(statusSize >= 12, `.notebook-status fontSize at ${width}px must be >= 12px, got ${statusSize}`);
          }
          await page.setViewportSize({ width: 1440, height: 900 });

          await page.locator('#paperScroll').focus();
          await page.keyboard.press('Shift++');
          assert.equal(await page.locator('#zoom').inputValue(), '1.25');
          await page.keyboard.press('-');
          assert.equal(await page.locator('#zoom').inputValue(), '1');
          await page.keyboard.press('n');
          assert.equal(await page.locator('#reader').getAttribute('data-notebook-open'), 'false');
          await page.keyboard.press('n');
          assert.equal(await page.locator('#reader').getAttribute('data-notebook-open'), 'true');
          await page.keyboard.press('Shift++');
          assert.equal(await page.locator('#zoom').inputValue(), '1.25');

          await page.locator('#more').click();
          await page.locator('#menu').getByRole('button', { name: 'Reset reading layout', exact: true }).click();
          await page.locator('#toast').filter({ hasText: 'Reading layout reset.' }).waitFor();
          assert.equal(await page.locator('#zoom').inputValue(), '1');
          assert.equal(await page.locator('#reader').getAttribute('data-reading-mode'), 'source');
          assert.equal(await page.locator('#reader').getAttribute('data-notebook-open'), 'false');

          const internalLink = page.locator('#original .pdf-link-internal[data-link-kind="internal"]').first();
          await internalLink.waitFor();
          await internalLink.click();
          await page.waitForFunction(() => document.getElementById('pageCount')?.textContent !== '6 / 16');
          await page.locator('#jumpBack').click();
          await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '6 / 16');

          await page.locator('#paperScroll').focus();
          await page.keyboard.press('Control+f');
          const searchInput = page.locator('#docSearch .doc-search-input');
          await searchInput.waitFor({ state: 'visible' });
          await assertDarkAndContrast(searchInput, 'T3-10 dark docSearch input', 0.12, 4.5);
          await searchInput.fill('LLaMA-13B');
          await page.locator('#docSearchResults .doc-search-hit').first().waitFor({ state: 'visible' });
          await searchInput.press('Enter');
          await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '12 / 16');
          assert.equal(await page.locator('#docSearch .doc-search-count').textContent(), '1 / 1');
          await page.waitForFunction(() => (CSS.highlights.get('paper-find-current')?.size ?? 0) > 0 && (CSS.highlights.get('paper-find-matches')?.size ?? 0) > 0);
          await page.locator('#paperScroll').focus();
          await page.keyboard.press('Alt+ArrowLeft');
          await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '6 / 16');
          await page.keyboard.press('Control+f');
          await searchInput.fill('FasterTransformer');
          await page.waitForFunction(() => document.querySelector('#docSearch .doc-search-count')?.textContent === '– / 14');
          assert.equal(await page.locator('#docSearchResults .doc-search-hit').count(), 14);
          await page.locator('#docSearchResults .doc-search-hit').first().click();
          await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '1 / 16');
          assert.equal(await page.locator('#docSearch .doc-search-count').textContent(), '1 / 14');
          await page.waitForFunction(() => (CSS.highlights.get('paper-find-current')?.size ?? 0) > 0);
          await searchInput.press('Escape');
          await page.locator('#docSearch').waitFor({ state: 'hidden' });
          assert.ok(await page.evaluate(() => !CSS.highlights.has('paper-find-matches') && !CSS.highlights.has('paper-find-current')));
          await page.locator('#paperScroll').focus();
          await page.keyboard.press('n');
          await page.locator('#rail .cm-editor .cm-content').click();
          await page.keyboard.press('Control+f');
          assert.equal(await page.locator('#docSearch').isVisible(), false);
          await page.locator('#closeRail').click();

          await page.locator('#pageCount').click();
          await page.locator('#pageNumber').fill('1');
          await page.locator('#pageJump button[type="submit"]').click();
          const extLink = page.locator('#original .pdf-link-external[href*="github.com/vllm-project/vllm"]').first();
          await extLink.waitFor();
          assert.equal(await extLink.getAttribute('target'), '_blank');
          assert.equal(await extLink.getAttribute('rel'), 'noopener noreferrer');

          await resetSettings(ctx.request, host.origin);
          console.log('PASS T3-10: 1440px Japanese bilingual floor + #saveState >= 12px + Shift++/- + n + layout reset.');
        } finally {
          await ctx.close();
        }
      }

      {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
        const scope: ErrorScope = { allowZotero503: true };
        try {
          await authContext(ctx, host);
          const longParagraphs = Array.from({ length: 24 }, (_, i) => `Section ${i + 1}: Detailed long-form benchmark analysis of kv-cache memory scheduling across multiple workloads.`);
          const webId = (await rpc<{ doc: { id: string } }>(ctx.request, host.origin, 'web.import', { title: 'Zebra Long Web Article', url: 'https://example.org/zebra-article', paragraphs: longParagraphs })).body.doc.id;
          const webUrl = host.origin + '/api/paper-reader/app/index.html?doc=' + webId + '&page=1&anchor=p-12';
          assert.equal((await rpc(ctx.request, host.origin, 'note.save', { docId: webId, title: 'Zebra Long Web Article', page: 1, anchor: 'p-12', label: 'Paragraph 12', sourceUrl: webUrl, quote: 'Section 12:', text: 'Unique crosslib-note-sentinel for jump test' })).status, 200);
          assert.equal((await rpc(ctx.request, host.origin, 'annotation.save', { id: randomUUID(), docId: webId, title: 'Zebra Long Web Article', page: 1, anchor: 'p-14', label: 'Paragraph 14', sourceUrl: webUrl, kind: 'highlight', color: 'green', quote: 'Section 14: Detailed', text: 'Unique crosslib-mark-sentinel' })).status, 200);

          const page = await openReaderPage(ctx, host, '?doc=' + webId, { tag: 'W3-2', scope, pageErrors, consoleErrors });
          await page.evaluate(() => { const s = document.getElementById('paperScroll')!; s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * 0.55); });
          await page.waitForTimeout(450);
          await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#loading').waitFor({ state: 'hidden' });
          await until(async () => (await page.evaluate(() => document.getElementById('paperScroll')!.scrollTop)) > 100, 'Web scroll progress did not restore');

          await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=3', { waitUntil: 'domcontentloaded' });
          await page.locator('#loading').waitFor({ state: 'hidden' });
          await page.evaluate(() => { const s = document.getElementById('paperScroll')!; s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * 0.5); });
          await page.waitForTimeout(450);
          await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#loading').waitFor({ state: 'hidden' });
          assert.equal(await page.locator('#pageCount').innerText(), '3 / 16');
          await until(async () => (await page.evaluate(() => document.getElementById('paperScroll')!.scrollTop)) > 60, 'PDF scroll progress did not restore');

          const titles = await page.evaluate(() => ['library', 'pageCount', 'parallel', 'contentsTab', 'notesTab', 'annotationsTab', 'refsTab', 'captureRegion', 'mobileRail', 'contentsToggle'].map(id => document.getElementById(id)!.title));
          for (const [idx, hint] of ['(L)', '(G)', '(B)', '(C)', '(N)', '(M)', '(R)', '(S)', '(N)', '(C)'].entries()) assert.ok(titles[idx].includes(hint), `Missing ${hint} in ${titles[idx]}`);

          await page.locator('#paperScroll').focus();
          await page.keyboard.press('g'); await page.locator('#pageJump').waitFor({ state: 'visible' });
          assert.equal(await page.evaluate(() => document.activeElement?.id), 'pageNumber');
          await page.keyboard.press('Escape');
          await page.keyboard.press('m'); assert.equal(await page.locator('#annotationsTab').getAttribute('aria-selected'), 'true');
          await page.keyboard.press('r'); assert.equal(await page.locator('#refsTab').getAttribute('aria-selected'), 'true');
          await page.locator('.ref-tags-host .tp-trigger').click();
          await page.locator('.tp-popover .tp-input').fill('reader-ref-tag');
          await page.locator('.tp-popover .tp-input').press('Enter');
          await page.locator('.ref-tags-host .tp-chip', { hasText: 'reader-ref-tag' }).waitFor({ state: 'visible' });
          await page.keyboard.press('Escape');
          await page.locator('.tp-popover').waitFor({ state: 'detached' });
          assert.equal(await page.locator('#reader').getAttribute('data-notebook-open'), 'true');
          await page.locator('#paperScroll').focus();
          await page.keyboard.press('r'); assert.equal(await page.locator('#reader').getAttribute('data-notebook-open'), 'false');
          await page.keyboard.press('s'); await page.locator('.pdf-capture-surface').waitFor({ state: 'visible' });
          await page.keyboard.press('Escape'); await page.locator('.pdf-capture-surface').waitFor({ state: 'hidden' });
          await page.keyboard.press('Shift+?'); await page.locator('#shortcutsDialog').waitFor({ state: 'visible' });
          const scLayout = await page.evaluate(() => {
            const dlg = document.getElementById('shortcutsDialog')!, body = document.getElementById('shortcutsBody')!;
            return { cols: getComputedStyle(body).gridTemplateColumns.trim().split(/\s+/).length, fits: dlg.scrollHeight <= dlg.clientHeight + 2 };
          });
          assert.deepEqual(scLayout, { cols: 2, fits: true });
          await page.keyboard.press('Escape');

          await page.locator('#paperScroll').focus(); await page.keyboard.press('l');
          const dlg = page.locator('#dialog'); await dlg.waitFor({ state: 'visible' });
          assert.ok((await dlg.locator('.library-device-item').filter({ hasText: 'PagedAttention.pdf' }).innerText()).includes('p. 3 / 16'));
          const webItem = dlg.locator('.library-device-item').filter({ hasText: 'Zebra Long Web Article' });
          assert.match(await webItem.innerText(), /\d+%/);
          await webItem.getByRole('button', { name: 'Star document', exact: true }).click();
          await webItem.getByRole('button', { name: 'Remove star', exact: true }).waitFor();
          await webItem.locator('.library-status-btn').click();
          await webItem.locator('.library-status-btn[data-status="done"]').waitFor();
          await webItem.locator('.tp-trigger').click();
          const tpPop = dlg.locator('.tp-popover');
          await tpPop.waitFor({ state: 'visible' });
          await tpPop.locator('.tp-input').fill('systems'); await tpPop.locator('.tp-input').press('Enter');
          await webItem.locator('.library-tag', { hasText: 'systems' }).waitFor({ state: 'visible' });
          await tpPop.locator('.tp-input').fill('ml'); await tpPop.locator('.tp-input').press('Enter');
          await webItem.locator('.library-tag', { hasText: 'ml' }).waitFor({ state: 'visible' });
          await page.keyboard.press('Escape'); await tpPop.waitFor({ state: 'detached' });
          assert.equal(await dlg.isVisible(), true);
          await dlg.locator('.library-tag-filter').selectOption('systems'); assert.equal(await dlg.locator('.library-device-item').count(), 1);
          await dlg.locator('.library-tag-filter').selectOption('');

          const rowChecks = dlg.locator('.library-device-item .library-check');
          await rowChecks.nth(0).click(); await rowChecks.nth(1).click();
          await dlg.locator('.library-bulk-tag-btn').click();
          await dlg.locator('.library-bulk-chip[data-tag="systems"]').click();
          await until(async () => (await dlg.locator('.library-device-item .library-tag', { hasText: 'systems' }).count()) === 2, 'Bulk chip add did not apply to both rows');
          await dlg.locator('.library-bulk-mode-btn[data-mode="remove"]').click();
          await dlg.locator('.library-bulk-chip[data-tag="systems"]').click();
          await until(async () => (await dlg.locator('.library-device-item .library-tag', { hasText: 'systems' }).count()) === 0, 'Bulk chip remove did not clear tag');
          await dlg.locator('.library-bulk-tag-cancel').click();
          await dlg.locator('.library-bulk-clear').click();
          await dlg.getByLabel('Filter by status').selectOption('starred'); assert.equal(await dlg.locator('.library-device-item').count(), 1);
          await dlg.getByLabel('Filter by status').selectOption('all');
          await dlg.getByLabel('Filter by type').selectOption('web'); assert.equal(await dlg.locator('.library-device-item').count(), 1);
          await dlg.getByLabel('Filter by type').selectOption('all');
          await dlg.getByLabel('Sort documents').selectOption('title');
          assert.ok((await dlg.locator('.library-device-item').first().innerText()).includes('PagedAttention.pdf'));

          await dlg.getByRole('searchbox').fill('crosslib-note-sentinel');
          const noteHit = dlg.locator('.library-search-hit').filter({ hasText: 'crosslib-note-sentinel' });
          await noteHit.waitFor({ state: 'visible' }); assert.equal(await noteHit.locator('.library-hit-kind').innerText(), 'Note');
          await noteHit.click(); await dlg.waitFor({ state: 'hidden' });
          await page.waitForURL(url => url.searchParams.get('doc') === webId);
          assert.equal(await page.locator('#notesTab').getAttribute('aria-selected'), 'true');
          await page.locator('#rail .cm-content').click(); await page.keyboard.type('glmr');
          assert.equal(await dlg.isVisible(), false);
          await page.locator('#closeRail').click();
          await page.getByRole('button', { name: 'Research', exact: true }).click();
          await page.locator('.rw-nav-btn[data-view="review-table"]').click();
          await page.locator('.rt-paper-btn').first().click();
          await page.locator('.rt-insp-tags .tp-trigger').click();
          await page.locator('.tp-popover .tp-input').fill('review-cat');
          await page.locator('.tp-popover .tp-input').press('Enter');
          await page.locator('.rt-insp-tags .tp-chip', { hasText: 'review-cat' }).waitFor({ state: 'visible' });
          await page.keyboard.press('Escape');
          await page.locator('.tp-popover').waitFor({ state: 'detached' });
          await page.locator('.rt-tag-filter').selectOption('review-cat');
          assert.equal(await page.locator('.rt-grid .rt-paper-btn').count(), 1);
          await page.locator('.rw-collapse-btn').click();
          console.log('PASS W3-2: Library triage, cross-surface TagPicker, bulk tag chips, cross-library jump, shortcuts & ? modal.');
        } finally { await ctx.close(); }
      }
    } finally {
      await browser.close();
    }

    assert.deepEqual(pageErrors, [], 'Unexpected pageerror events:\n' + pageErrors.join('\n'));
    assert.deepEqual(consoleErrors, [], 'Unexpected console.error events:\n' + consoleErrors.join('\n'));
    console.log('PASS Tier 3 (T3-09, T3-10): Unique cross-feature scenarios passed.');
  });
} finally {
  await llm.close();
}
