import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { withHost } from './host.js';
import { openReaderPage } from './helpers/reader.js';
import { assertMobileChromeBudget, assertMobilePanelTargets } from './helpers/dom-probes.js';
import { assertNoZhEnglishLeaks, collectChromeStrings } from './helpers/i18n.js';

const EN_VIEWS = ['Deep Search', 'Citation Map', 'Citations', 'Review Table', 'Field Trends', 'Library Chat'];
const ZH_VIEWS = ['深度检索', '引文脉络', '引用分析', '文献筛选与提取', '研究趋势', '文献库对话'];

async function run(): Promise<void> {
  await withHost(async host => {
    const browser = await chromium.launch({ executablePath: host.executable, headless: true });
    try {
      const pageErrors: string[] = [], consoleErrors: string[] = [];
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
      const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=5', { tag: 'rw-en', scope: { allowZotero503: true }, pageErrors, consoleErrors });
      assert.equal(await page.locator('.topbar #expandResearch').count(), 0);
      if (!(await page.locator('#rail').isVisible())) await page.locator('#mobileRail').click();
      await page.locator('#expandResearch').click();
      const ws = page.locator('#researchWorkspace');
      await ws.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#reader').isVisible(), false);
      assert.equal(await ws.locator('[role="tablist"]').count(), 0);
      assert.deepEqual((await ws.locator('.rw-nav-btn .rw-label').allTextContents()).map(s => s.trim()), EN_VIEWS);
      assert.equal(await ws.locator('.rw-nav-btn[aria-current="page"]').getAttribute('data-view'), 'deep-search');
      assert.ok(Math.abs((await ws.locator('.rw-rail').boundingBox())!.width - 220) <= 2);
      assert.ok(await ws.locator('.rw-collapse-btn .rw-label').evaluate(el => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth));

      for (const denseId of ['citation-map', 'review-table', 'field-trends']) {
        await ws.locator(`.rw-nav-btn[data-view="${denseId}"]`).click();
        assert.equal(await ws.getAttribute('data-rail-collapsed'), 'true');
        const c = await ws.evaluate(() => ({ rail: document.querySelector('.rw-rail')!.getBoundingClientRect().width, labels: [...document.querySelectorAll('.rw-nav-btn .rw-label')].filter(el => getComputedStyle(el).display !== 'none').length, svgs: document.querySelectorAll('.rw-nav-btn svg').length }));
        assert.ok(Math.abs(c.rail - 52) <= 2 && c.labels === 0 && c.svgs === 6);
      }

      await page.setViewportSize({ width: 1160, height: 900 });
      await ws.locator('.rw-nav-btn[data-view="deep-search"]').click();
      assert.equal(await ws.getAttribute('data-rail-collapsed'), 'true');
      const mainW = (await ws.locator('.rw-main').boundingBox())!.width;
      await ws.locator('.rw-rail-toggle').click();
      assert.equal(await ws.getAttribute('data-rail-overlay'), 'open');
      assert.ok(Math.abs((await ws.locator('.rw-rail').boundingBox())!.width - 220) <= 2);
      assert.ok(Math.abs((await ws.locator('.rw-main').boundingBox())!.width - mainW) <= 1);
      assert.ok(await ws.locator('.rw-collapse-btn .rw-label').evaluate(el => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth));
      await page.keyboard.press('Escape');
      assert.equal(await ws.getAttribute('data-rail-overlay'), 'closed'); assert.equal(await ws.isVisible(), true);
      await page.keyboard.press('Escape'); await ws.waitFor({ state: 'hidden' });
      assert.equal((await page.locator('#pageCount').innerText()).trim(), '5 / 16');
      await page.locator('#more').click(); await page.locator('#menu').waitFor({ state: 'visible' });
      await page.keyboard.press('Control+Shift+R'); await ws.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#menu').isVisible(), false);
      await page.keyboard.press('Control+Shift+R'); await ws.waitFor({ state: 'hidden' });
      await page.locator('#library').click(); await page.locator('.library-workspace-btn').click();
      await ws.waitFor({ state: 'visible' }); assert.equal(await page.locator('#dialog').isVisible(), false);
      await ws.locator('.rw-topic-add-btn').click(); await ws.locator('.rw-topic-input').fill('KV Cache');
      await ws.locator('.rw-topic-form button[type="submit"]').click();
      await page.waitForFunction(() => (document.getElementById('rwTopicSelect') as HTMLSelectElement | null)?.value === 'KV Cache');
      await ws.locator('#rwTopicSelect').selectOption('');

      await ws.locator('.rw-search-input').fill('block table');
      await ws.locator('.rw-search-form button[type="submit"]').click();
      const hit6 = ws.locator('.rw-hit', { hasText: 'p. 6' }).first();
      await hit6.waitFor({ state: 'visible', timeout: 15_000 });
      await hit6.click();
      await page.locator('#returnWorkspace').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#pageCount').innerText()).trim(), '6 / 16');
      assert.match(await page.locator('.return-workspace-go').innerText(), /Deep Search/);
      assert.equal(await page.locator('#jumpBack').isEnabled(), true);
      await page.locator('#jumpBack').click();
      await page.waitForFunction(() => document.getElementById('pageCount')?.textContent?.trim() === '5 / 16');
      await page.locator('#jumpForward').click();
      await page.waitForFunction(() => document.getElementById('pageCount')?.textContent?.trim() === '6 / 16');
      await page.locator('.return-workspace-go').click();
      await ws.waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.rw-search-input').inputValue(), 'block table');
      assert.ok((await ws.locator('.rw-hit').count()) >= 1);
      await hit6.click();
      await page.locator('#returnWorkspace').waitFor({ state: 'visible' });
      await page.locator('.return-workspace-close').click();
      await page.locator('#returnWorkspace').waitFor({ state: 'hidden' });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(120);
      await page.keyboard.press('Control+Shift+R'); await ws.waitFor({ state: 'visible' });
      const mob = await ws.evaluate(() => ({ barH: document.querySelector('.rw-mobile-bar')!.getBoundingClientRect().height, ov: document.documentElement.scrollWidth - innerWidth }));
      assert.ok(mob.barH <= 56 && mob.barH / 844 <= 0.18 && mob.ov <= 1, JSON.stringify(mob));
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await ws.locator('.rw-mobile-select').selectOption('review-table');
      assert.equal((await ws.locator('.rw-view-title').innerText()).trim(), 'Review Table');
      await ws.locator('.rw-hit', { hasText: 'p. 6' }).first().click();
      await page.locator('#returnWorkspace').waitFor({ state: 'visible' });
      const pillFit = await page.evaluate(() => {
        const go = document.querySelector('.return-workspace-go')!, pill = document.getElementById('returnWorkspace')!, bar = document.getElementById('mobileBar')!;
        return { sw: go.scrollWidth, cw: go.clientWidth, h: go.getBoundingClientRect().height, clear: pill.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top, ov: document.documentElement.scrollWidth - innerWidth };
      });
      assert.ok(pillFit.sw <= pillFit.cw && pillFit.h >= 44 && pillFit.clear && pillFit.ov <= 1, JSON.stringify(pillFit));
      await page.locator('.return-workspace-go').click(); await ws.waitFor({ state: 'visible' });
      await ws.locator('.rw-mobile-collapse').click(); await ws.waitFor({ state: 'hidden' });
      await assertMobileChromeBudget(page, 844);
      await ctx.close();

      const zhCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
      const zhPage = await openReaderPage(zhCtx, host, '?doc=pagedattention&page=5', { tag: 'rw-zh', scope: { allowZotero503: true }, pageErrors, consoleErrors });
      await zhPage.keyboard.press('Control+Shift+R'); await zhPage.locator('#researchWorkspace').waitFor({ state: 'visible' });
      assert.deepEqual((await zhPage.locator('.rw-nav-btn .rw-label').allTextContents()).map(s => s.trim()), ZH_VIEWS);
      assert.ok(await zhPage.locator('.rw-collapse-btn .rw-label').evaluate(el => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth));
      assertNoZhEnglishLeaks(await collectChromeStrings(zhPage, '#rwTopicSelect option:not([value=""])'), 'zh-CN Research Workspace');
      await zhCtx.close();
      assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
    } finally { await browser.close(); }
  });
}

run().catch(error => { console.error(error); process.exit(1); });
