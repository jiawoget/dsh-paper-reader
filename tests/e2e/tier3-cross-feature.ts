import assert from 'node:assert/strict';
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
