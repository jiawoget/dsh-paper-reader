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

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('#more').click();
      await page.locator('#menu').getByRole('button', { name: 'Connections', exact: true }).click();
      const dlg = page.getByRole('dialog');
      await dlg.getByRole('tab', { name: 'Academic APIs', exact: true }).click();
      const saveBtnBox = (await dlg.getByRole('button', { name: 'Save connections', exact: true }).boundingBox())!;
      assert.ok(saveBtnBox.y + saveBtnBox.height <= 900);
      await dlg.getByLabel('OpenAlex email (polite pool)').fill('researcher@example.edu');
      await dlg.getByLabel('OpenAlex API key').fill('oa-secret-test');
      await dlg.getByRole('button', { name: 'Save connections', exact: true }).click();
      await dlg.waitFor({ state: 'hidden' });
      await page.locator('#more').click();
      await page.locator('#menu').getByRole('button', { name: 'Connections', exact: true }).click();
      await dlg.getByRole('tab', { name: 'Academic APIs', exact: true }).click();
      assert.equal(await dlg.getByLabel('OpenAlex email (polite pool)').inputValue(), 'researcher@example.edu');
      assert.equal(await dlg.getByLabel('OpenAlex API key').inputValue(), '');
      assert.equal(await dlg.getByLabel('OpenAlex API key').getAttribute('placeholder'), 'Key saved');
      await page.locator('#closeDialog').click();

      const seedP = { id: 'W1', openAlexId: 'W1', title: 'PagedAttention: Efficient Memory Management', authors: ['Woosuk Kwon', 'Ion Stoica'], firstAuthor: 'Woosuk Kwon', lastAuthor: 'Ion Stoica', year: 2023, venue: 'SOSP', doi: '10.1145/3600006.3613165', citationCount: 900, source: 'openalex', inLibrary: true, docId: 'pagedattention', abstract: 'Seed paper abstract.' };
      const discP = { id: 'W2', openAlexId: 'W2', title: 'FlashAttention: Fast and Memory-Efficient Attention', authors: ['Tri Dao', 'Christopher Re'], firstAuthor: 'Tri Dao', lastAuthor: 'Christopher Re', year: 2022, venue: 'NeurIPS', doi: '10.48550/arXiv.2205.14135', citationCount: 2400, source: 'openalex', inLibrary: false, oaPdfUrl: 'https://arxiv.org/pdf/2205.14135.pdf', abstract: 'IO-aware exact attention.' };
      const laterP = { id: 'W3', openAlexId: 'W3', title: 'vLLM-Next: Disaggregated Serving', authors: ['Alice Chen', 'Bob Zhang'], firstAuthor: 'Alice Chen', lastAuthor: 'Bob Zhang', year: 2025, venue: 'OSDI', citationCount: 120, source: 'openalex', inLibrary: false, abstract: 'Follow-up serving engine.' };
      const extraRows = Array.from({ length: 8 }, (_, i) => ({ id: `WX${i}`, openAlexId: `WX${i}`, title: `Related Systems Paper ${i + 1}`, authors: [`Author${i} One`, `Senior${i} Last`], firstAuthor: `Author${i} One`, lastAuthor: `Senior${i} Last`, year: 2019 + (i % 5), venue: 'SysML', citationCount: 50 + i, source: 'openalex', inLibrary: false }));
      await page.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string; payload?: { direction?: string } };
        if (body.op === 'graph.resolve') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paper: seedP, degraded: [], fromCache: false }) }); return; }
        if (body.op === 'graph.explore') {
          const isLater = body.payload?.direction === 'later';
          const nodes = isLater ? [{ ...discP, isSeed: true }, laterP] : [{ ...seedP, isSeed: true }, discP, ...extraRows];
          const edges = isLater ? [{ source: 'W3', target: 'W2', kind: 'cites' }] : [{ source: 'W1', target: 'W2', kind: 'cites' }];
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seeds: [isLater ? discP : seedP], nodes, edges, degraded: isLater ? ['s2'] : [], fromCache: false }) });
          return;
        }
        await route.fallback();
      });

      if (!(await page.locator('#rail').isVisible())) await page.locator('#mobileRail').click();
      await page.locator('#refsTab').click();
      await page.locator('.ref-graph-actions button[data-graph-dir="earlier"]').click();
      await ws.waitFor({ state: 'visible' });
      assert.equal(await ws.getAttribute('data-rail-collapsed'), 'true');
      await ws.locator('.cm-node[data-node-id="W2"]').waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cm-node[data-node-id="W1"]').getAttribute('data-kind'), 'library');
      assert.equal(await ws.locator('.cm-node[data-node-id="W2"]').getAttribute('data-kind'), 'discovery');
      assert.ok((await ws.locator('.cm-row[data-node-id="W2"] .cm-row-title').boundingBox())!.height >= 24);
      const baseW2Fill = await ws.locator('.cm-node[data-node-id="W2"] .cm-node-circle').evaluate(el => getComputedStyle(el).fill);
      await ws.locator('.cm-row[data-node-id="W2"]').hover();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.cm-node[data-node-id="W2"] .cm-node-circle')!).fill === 'rgb(217, 154, 0)');
      assert.notEqual(baseW2Fill, 'rgb(217, 154, 0)');
      await ws.locator('.cm-graph-bar').getByRole('button', { name: 'Timeline', exact: true }).click();
      assert.ok((await ws.locator('.cm-axis-label').count()) >= 2);
      await ws.locator('.cm-graph-bar').getByRole('button', { name: 'Last Author', exact: true }).click();
      assert.equal((await ws.locator('.cm-node[data-node-id="W2"] .cm-node-label').textContent())?.trim(), 'Re 2022');
      await ws.locator('.cm-list').evaluate(el => { el.scrollTop = 48; });
      await ws.locator('.cm-row[data-node-id="W2"] .cm-save-abs').click();
      await ws.locator('.cm-row[data-node-id="W2"] .cm-open-btn').waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cm-node[data-node-id="W2"]').getAttribute('data-kind'), 'library');
      assert.ok((await ws.locator('.cm-list').evaluate(el => el.scrollTop)) >= 40);
      await ws.locator('.cm-row[data-node-id="W2"] .cm-row-title').click();
      await ws.locator('.cm-detail').waitFor({ state: 'visible' });
      const widths = await ws.evaluate(() => ({ total: document.querySelector('.cm-split')!.getBoundingClientRect().width, graph: document.querySelector('.cm-graph-pane')!.getBoundingClientRect().width }));
      assert.ok(widths.graph / widths.total >= 0.55, JSON.stringify(widths));
      for (const [idx, dir] of (['later', 'earlier', 'later'] as const).entries()) {
        if (!(await ws.locator('.cm-detail').isVisible())) await ws.locator('.cm-row-title').first().click();
        await ws.locator(`.cm-detail-dirs button[data-dir="${dir}"]`).click();
        await ws.locator(`.cm-crumb[data-step="${idx + 1}"]`).waitFor({ state: 'visible' });
      }
      await ws.locator('.cm-degraded').waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cm-crumb').count(), 4);
      await page.setViewportSize({ width: 1024, height: 768 });
      const d1024 = await ws.evaluate(() => ({ ov: document.documentElement.scrollWidth - innerWidth, mOv: document.querySelector('.rw-main')!.scrollWidth - document.querySelector('.rw-main')!.clientWidth, sw: document.querySelector('.cm-split')!.getBoundingClientRect().width, mw: document.querySelector('.rw-main')!.clientWidth }));
      assert.ok(d1024.ov <= 1 && d1024.mOv <= 1 && d1024.sw <= d1024.mw + 1, JSON.stringify(d1024));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(80);
      const m4 = await ws.evaluate(() => ({ ov: document.documentElement.scrollWidth - innerWidth, mOv: document.querySelector('.rw-main')!.scrollWidth - document.querySelector('.rw-main')!.clientWidth, sw: document.querySelector('.cm-split')!.getBoundingClientRect().width }));
      assert.ok(m4.ov <= 1 && m4.mOv <= 1 && m4.sw <= 391, JSON.stringify(m4));
      const mCrumbs = await ws.locator('.cm-crumb').evaluateAll(els => els.map(el => ({ sw: el.scrollWidth, cw: el.clientWidth })));
      assert.ok(mCrumbs.length === 4 && mCrumbs.every(c => c.sw <= c.cw + 1), JSON.stringify(mCrumbs));
      await page.setViewportSize({ width: 1440, height: 900 });
      await ws.locator('.cm-crumb[data-step="0"]').click();
      assert.equal(await ws.locator('.cm-crumb').count(), 1);
      await ws.locator('.cm-detail .cm-open-btn').click();
      await page.locator('#returnWorkspace').waitFor({ state: 'visible' });
      assert.match(await page.locator('.return-workspace-go').innerText(), /Citation Map/);
      await page.locator('.return-workspace-go').click();
      await ws.waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cm-crumb').count(), 1);
      assert.equal(await ws.locator('.cm-graph-bar').getByRole('button', { name: 'Timeline', exact: true }).getAttribute('aria-pressed'), 'true');
      await ws.locator('.cm-back-btn').click();
      await ws.locator('.cm-detail').waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(100);
      const listTop = await ws.locator('.cm-list').evaluate(el => el.getBoundingClientRect().top);
      assert.ok(listTop <= 152, `Mobile top chrome above .cm-list ${listTop}px > 152px`);
      await ws.locator('.cm-mobile-tabs').getByRole('button', { name: 'Graph', exact: true }).click();
      assert.equal(await ws.locator('.cm-split').getAttribute('data-mobile-pane'), 'graph');
      const svgTop = await ws.locator('.cm-svg').evaluate(el => el.getBoundingClientRect().top);
      assert.ok(svgTop <= 152, `Mobile top chrome above .cm-svg ${svgTop}px > 152px`);
      await ws.locator('.cm-mobile-tabs').getByRole('button', { name: 'List', exact: true }).click();
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await page.unroute('**/api/paper-reader/action');
      await ctx.close();

      const zhCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
      const zhPage = await openReaderPage(zhCtx, host, '?doc=pagedattention&page=5', { tag: 'rw-zh', scope: { allowZotero503: true }, pageErrors, consoleErrors });
      await zhPage.locator('#mobileRail').click();
      await zhPage.locator('#refsTab').click();
      assert.deepEqual(await zhPage.locator('.ref-graph-actions button').allInnerTexts(), ['Earlier', 'Later', 'Similar']);
      assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Reference triggers');
      await zhPage.keyboard.press('Control+Shift+R'); await zhPage.locator('#researchWorkspace').waitFor({ state: 'visible' });
      assert.deepEqual((await zhPage.locator('.rw-nav-btn .rw-label').allTextContents()).map(s => s.trim()), ZH_VIEWS);
      assert.ok(await zhPage.locator('.rw-collapse-btn .rw-label').evaluate(el => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth));
      assertNoZhEnglishLeaks(await collectChromeStrings(zhPage, '#rwTopicSelect option:not([value=""])'), 'zh-CN Research Workspace');
      await zhPage.locator('.rw-nav-btn[data-view="citation-map"]').click();
      assertNoZhEnglishLeaks(await collectChromeStrings(zhPage, '.cm-seed-select'), 'zh-CN Citation Map');
      await zhCtx.close();
      assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
    } finally { await browser.close(); }
  });
}

run().catch(error => { console.error(error); process.exit(1); });
