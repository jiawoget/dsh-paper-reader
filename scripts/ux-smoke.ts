import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { withHost } from '../tests/e2e/host.js';
import { openReaderPage } from '../tests/e2e/helpers/reader.js';
import { assertDesktopChromeCraft, assertMobileChromeBudget, assertMobilePanelTargets } from '../tests/e2e/helpers/dom-probes.js';

async function run(): Promise<void> {
  const started = Date.now();
  await withHost(async host => {
    const browser = await chromium.launch({ executablePath: host.executable, headless: true });
    try {
      for (const colorScheme of ['light', 'dark'] as const) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme, locale: 'en-US' });
        const pageErrors: string[] = [], consoleErrors: string[] = [];
        const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', {
          tag: `ux-smoke-${colorScheme}`, scope: { allowZotero503: true }, pageErrors, consoleErrors
        });
        await assertDesktopChromeCraft(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(120);
        await assertMobileChromeBudget(page, 844);
        await page.locator('#mobileRail').click();
        await page.locator('#rail').waitFor({ state: 'visible' });
        await assertMobilePanelTargets(page, '#rail');
        await page.locator('#closeRail').click();
        await page.locator('#rail').waitFor({ state: 'hidden' });
        await page.locator('#more').click();
        await page.locator('#menu').waitFor({ state: 'visible' });
        await assertMobilePanelTargets(page, '#menu');
        await page.locator('#menu').getByRole('button', { name: 'Connections', exact: true }).click();
        await page.getByRole('dialog').waitFor({ state: 'visible' });
        await assertMobilePanelTargets(page, '#dialog');
        assert.deepEqual(pageErrors, [], `Page errors (${colorScheme}): ${pageErrors.join('; ')}`);
        assert.deepEqual(consoleErrors, [], `Console errors (${colorScheme}): ${consoleErrors.join('; ')}`);
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  });
  console.log(`PASS ux-smoke (desktop 1024-1440px + mobile 390x844 light/dark) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
