import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
      assert.equal(await page.locator('#expandResearch').count(), 0);
      assert.equal(await page.locator('.topbar #workspaceSwitch .rw-sw-read[aria-pressed="true"]').count(), 1);
      await page.locator('.topbar #workspaceSwitch .rw-sw-research').click();
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
      await page.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string };
        if (body.op === 'citations.analyze') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ target: { targetKey: 'arxiv:2309.06180', docId: 'pagedattention', title: 'PagedAttention', authors: ['Woosuk Kwon'], year: 2023, arxivId: '2309.06180', sciteUrl: 'https://scite.ai/search?q=PagedAttention' }, direction: 'cited_by', tallies: { citingPapers: 1, citationStatements: 1, supporting: 1, extending: 0, contrasting: 0, mentioning: 0, unclassified: 0, localBackCitations: 1 }, statements: [{ targetKey: 'arxiv:2309.06180', direction: 'cited_by', citingKey: 'local:pagedattention:p6', docId: 'pagedattention', source: 'local', citingDocId: 'pagedattention', citingPage: 6, citingTitle: 'PagedAttention Block Table Evaluation', citingAuthors: ['Woosuk Kwon'], citingYear: 2024, section: 'Methods', context: 'PagedAttention organizes KV cache via block table mapping.', stance: 'supporting', rationale: 'Confirms block table layout.', isInfluential: false, isSelfCitation: false, manualOverride: false, updatedAt: '2026-01-01T00:00:00Z' }], sciteUrl: 'https://scite.ai/search?q=PagedAttention', degraded: [], fromCache: false, offline: true }) });
          return;
        }
        await route.fallback();
      });
      await ws.locator('.rw-nav-btn[data-view="citations"]').click();
      await ws.locator('.cit-search-input').fill('block table');
      const hit6 = ws.locator('.cit-jump-btn', { hasText: 'p. 6' }).first();
      await hit6.waitFor({ state: 'visible', timeout: 15_000 });
      await hit6.click();
      await page.locator('.topbar #returnWorkspace').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#pageCount').innerText()).trim(), '6 / 16');
      assert.match(await page.locator('.return-workspace-go').innerText(), /Citations/);
      assert.equal(await page.locator('#jumpBack').isEnabled(), true);
      await page.locator('#jumpBack').click();
      await page.waitForFunction(() => document.getElementById('pageCount')?.textContent?.trim() === '5 / 16');
      await page.locator('#jumpForward').click();
      await page.waitForFunction(() => document.getElementById('pageCount')?.textContent?.trim() === '6 / 16');
      await page.locator('.return-workspace-go').click();
      await ws.waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cit-search-input').inputValue(), 'block table');
      assert.ok((await ws.locator('.cit-card').count()) >= 1);
      await hit6.click();
      await page.locator('.topbar #returnWorkspace').waitFor({ state: 'visible' });
      await page.locator('.return-workspace-close').click();
      await page.locator('#returnWorkspace').waitFor({ state: 'hidden' });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(120);
      await page.keyboard.press('Control+Shift+R'); await ws.waitFor({ state: 'visible' });
      const mob = await ws.evaluate(() => ({ barH: document.querySelector('.rw-mobile-bar')!.getBoundingClientRect().height, ov: document.documentElement.scrollWidth - innerWidth }));
      assert.ok(mob.barH <= 56 && mob.barH / 844 <= 0.18 && mob.ov <= 1, JSON.stringify(mob));
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await ws.locator('.rw-mobile-select').selectOption('citations');
      await ws.locator('.cit-jump-btn', { hasText: 'p. 6' }).first().click();
      await page.locator('.topbar #returnWorkspace').waitFor({ state: 'visible' });
      const pillFit = await page.evaluate(() => {
        const go = document.querySelector('.return-workspace-go')!, pill = document.getElementById('returnWorkspace')!, bar = document.getElementById('mobileBar')!;
        return { sw: go.scrollWidth, cw: go.clientWidth, h: go.getBoundingClientRect().height, clear: pill.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top, ov: document.documentElement.scrollWidth - innerWidth };
      });
      assert.ok(pillFit.sw <= pillFit.cw && pillFit.h >= 44 && pillFit.clear && pillFit.ov <= 1, JSON.stringify(pillFit));
      await page.locator('.return-workspace-go').click(); await ws.waitFor({ state: 'visible' });
      await ws.locator('.rw-mobile-collapse').click(); await ws.waitFor({ state: 'hidden' });
      await assertMobileChromeBudget(page, 844);
      await page.unroute('**/api/paper-reader/action');

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
        const body = route.request().postDataJSON() as { op?: string; payload?: Record<string, unknown> };
        if (body.op === 'graph.resolve') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paper: seedP, degraded: [], fromCache: false }) }); return; }
        if (body.op === 'graph.savePaper') { assert.equal(body.payload?.mode, 'auto'); await route.continue({ postData: JSON.stringify({ ...body, payload: { ...body.payload, mode: 'abstract' } }) }); return; }
        if (body.op === 'graph.explore') {
          const isLater = body.payload?.direction === 'later';
          const nodes = isLater ? [{ ...discP, isSeed: true }, laterP] : [{ ...seedP, isSeed: true }, discP, ...extraRows];
          const edges = isLater ? [{ source: 'W3', target: 'W2', kind: 'cites' }] : [{ source: 'W1', target: 'W2', kind: 'cites' }];
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seeds: [isLater ? discP : seedP], nodes, edges, degraded: isLater ? ['s2'] : [], fromCache: false }) }); return;
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
      await page.waitForFunction((prev: string) => Boolean(document.querySelector('.cm-node[data-node-id="W2"].is-highlighted .cm-node-circle') && getComputedStyle(document.querySelector('.cm-node[data-node-id="W2"] .cm-node-circle')!).fill !== prev), baseW2Fill);
      assert.ok(await ws.evaluate(() => Boolean(document.querySelector('.cm-node[data-node-id="W1"].is-neighbor') && document.querySelector('.cm-node[data-node-id="WX0"].is-dimmed'))));
      await ws.locator('.cm-graph-bar').getByRole('button', { name: 'Timeline', exact: true }).click();
      assert.ok((await ws.locator('.cm-axis-label').count()) >= 2 && (await ws.locator('.cm-axis-y-label').count()) >= 2);
      await ws.locator('.cm-graph-bar').getByRole('button', { name: 'Last Author', exact: true }).click();
      assert.equal((await ws.locator('.cm-node[data-node-id="W2"] .cm-node-label').textContent())?.trim(), 'Re 2022');
      await ws.locator('.cm-list').evaluate(el => { el.scrollTop = 48; });
      await ws.locator('.cm-row[data-node-id="W2"] .cm-import-btn').click();
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
      await page.locator('.topbar #returnWorkspace').waitFor({ state: 'visible' });
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

      let trendsQueryCount = 0;
      const mkCells = (spec: [number, number, number | null, boolean, number][]) =>
        spec.map(([year, volume, yoyGrowth, lowBase, citationHeat]) => ({ year, volume, isYtd: year === 2026, yoyGrowth, lowBase, citations: citationHeat * 20, citationHeat }));
      const ftPaper = { id: 'FT1', openAlexId: 'W901', title: 'Draft-Verify Decoding for Fast LLMs', authors: ['Jane Doe', 'John Roe'], firstAuthor: 'Jane Doe', lastAuthor: 'John Roe', year: 2025, venue: 'ICML', citationCount: 185, source: 'openalex', inLibrary: false, oaPdfUrl: 'https://arxiv.org/pdf/2501.00001.pdf', abstract: 'Speculative decoding accelerates generation.' };
      const ftTopics = [
        { topicId: 'T1', topicName: 'KV Cache Compression', totalVolume: 480, recent2yr: 300, prior2yr: 120, growth: 1.5, lowBase: false, citationHeat: 64.2, localCount: 1, localDocIds: ['pagedattention'], cells: mkCells([[2022, 40, 0.25, false, 45], [2023, 80, 1, false, 70], [2024, 130, 0.625, false, 90], [2025, 170, 0.308, false, 60], [2026, 60, null, false, 15]]) },
        { topicId: 'T2', topicName: 'Speculative Decoding', totalVolume: 95, recent2yr: 60, prior2yr: 6, growth: 9, lowBase: true, citationHeat: 42.5, localCount: 0, localDocIds: [], cells: mkCells([[2022, 2, 0, true, 10], [2023, 4, 1, true, 20], [2024, 24, 5, true, 40], [2025, 48, 1, false, 55], [2026, 17, null, false, 12]]) }
      ];
      await page.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string; payload?: Record<string, unknown> };
        if (body.op === 'graph.savePaper') { assert.equal(body.payload?.mode, 'auto'); await route.continue({ postData: JSON.stringify({ ...body, payload: { ...body.payload, mode: 'abstract' } }) }); return; }
        if (body.op === 'trends.query') {
          trendsQueryCount++;
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: body.payload?.query ?? 'LLM inference', source: 'openalex', windowYears: 5, years: [2022, 2023, 2024, 2025, 2026], ytdYear: 2026, metric: 'volume', sort: 'fastest_growing', blindSpotsOnly: false, topics: ftTopics, degraded: [], fromCache: true, cachedAt: Date.now() }) }); return;
        }
        if (body.op === 'trends.papers') {
          const isLib = body.payload?.sort === 'library', papers = isLib ? [{ ...seedP, localDocId: 'pagedattention', primaryTopicId: 'T1', primaryTopicName: 'KV Cache Compression' }] : [{ ...ftPaper, primaryTopicId: body.payload?.topicId ?? 'T2', primaryTopicName: 'Speculative Decoding' }];
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: 'LLM inference', topicId: body.payload?.topicId ?? 'T2', topicName: isLib ? 'KV Cache Compression' : 'Speculative Decoding', year: body.payload?.year ?? 2025, source: 'openalex', sort: body.payload?.sort ?? 'representative', papers, degraded: [], fromCache: false }) }); return;
        }
        await route.fallback();
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await ws.locator('.rw-nav-btn[data-view="field-trends"]').click();
      assert.equal(await ws.getAttribute('data-rail-collapsed'), 'true');
      await ws.locator('.ft-starter-chip', { hasText: 'LLM inference' }).click();
      await ws.locator('.ft-table').waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.ft-col-year.is-ytd').innerText(), '2026* YTD');
      assert.equal(await ws.locator('.ft-drill').isVisible(), false);
      assert.equal(await ws.locator('.ft-pill.is-cache').count(), 1);
      await ws.locator('.ft-seg-btn[data-metric="growth"]').click();
      assert.equal(await ws.locator('.ft-cell[data-topic-id="T2"][data-year="2024"]').getAttribute('data-low-base'), 'true');
      assert.equal((await ws.locator('.ft-cell[data-topic-id="T1"][data-year="2026"]').innerText()).trim(), 'YTD*');
      await ws.locator('.ft-seg-btn[data-metric="citations"]').click();
      assert.equal((await ws.locator('.ft-cell[data-topic-id="T1"][data-year="2024"]').innerText()).trim(), '90');
      await ws.locator('.ft-sort').selectOption('blind_spots_first');
      assert.equal((await ws.locator('.ft-topic-name').first().innerText()).trim(), 'Speculative Decoding');
      await ws.locator('.ft-blind-btn').click(); assert.equal(await ws.locator('.ft-topic-name').count(), 1);
      await ws.locator('.ft-blind-btn').click(); assert.equal(await ws.locator('.ft-topic-name').count(), 2);
      assert.equal(trendsQueryCount, 1);
      await ws.locator('.ft-cell[data-topic-id="T2"][data-year="2024"]').focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.year), '2025');
      await ws.locator('.ft-cell[data-topic-id="T2"][data-year="2025"]').click(); await ws.locator('.ft-drill').waitFor({ state: 'visible' });
      await ws.locator('.ft-paper-card[data-paper-id="FT1"] .ft-import-btn').click();
      await ws.locator('.ft-paper-card[data-paper-id="FT1"] .ft-open-btn').waitFor({ state: 'visible' });
      assert.equal((await ws.locator('tr', { hasText: 'Speculative Decoding' }).locator('.ft-lib-btn').innerText()).trim(), '★ 1');
      await ws.locator('.ft-paper-card[data-paper-id="FT1"] .ft-open-btn').click();
      await page.locator('.topbar #returnWorkspace').waitFor({ state: 'visible' });
      assert.match(await page.locator('.return-workspace-go').innerText(), /Field Trends/);
      await page.locator('.return-workspace-go').click(); await ws.locator('.ft-drill').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape'); await ws.locator('.ft-drill').waitFor({ state: 'hidden' }); assert.equal(await ws.isVisible(), true);
      await ws.locator('tr', { hasText: 'KV Cache Compression' }).locator('.ft-lib-btn').click();
      await ws.locator('.ft-drill-tab[data-sort="library"][aria-pressed="true"]').waitFor({ state: 'visible' });
      await page.setViewportSize({ width: 1024, height: 768 });
      assert.ok(await ws.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('.ft-col-topic')!.getBoundingClientRect().width / document.querySelector('.ft-matrix-pane')!.getBoundingClientRect().width <= 0.31));
      await ws.locator('.ft-seg-btn[data-metric="volume"]').click();
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(80);
      const ftMob = await ws.evaluate(() => ({ top: document.querySelector('.ft-matrix-scroll')!.getBoundingClientRect().top, ov: document.documentElement.scrollWidth - innerWidth, metaGap: document.querySelector('.ft-footnote')!.getBoundingClientRect().left - document.querySelector('.ft-meta-pills')!.getBoundingClientRect().right, minCellW: Math.min(...[...document.querySelectorAll('.ft-cell')].map(el => el.getBoundingClientRect().width)) }));
      assert.ok(ftMob.top <= 150 && ftMob.ov <= 1 && ftMob.metaGap >= 0 && ftMob.minCellW >= 52, JSON.stringify(ftMob));
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await ws.locator('.ft-deep-btn').click();
      assert.equal(await ws.locator('.rw-nav-btn[aria-current="page"]').getAttribute('data-view'), 'deep-search');
      assert.match(await ws.locator('.ds-query-input').inputValue(), /KV Cache Compression/);
      await page.unroute('**/api/paper-reader/action');

      await page.setViewportSize({ width: 1440, height: 900 });
      await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'ai.selectModel', payload: { questionModel: { provider: 'reader-test', model: 'plain' } } } });
      await ws.locator('.rw-nav-btn[data-view="library-chat"]').click(); await ws.locator('.lc-scope-pane').waitFor({ state: 'visible' });
      await page.waitForFunction(() => (document.querySelector('.lc-scope-pill')?.textContent ?? '').includes('3 / 3'));
      const panes = await ws.evaluate(() => ({ rail: document.querySelector('.rw-rail')!.getBoundingClientRect(), chat: document.querySelector('.lc-chat-pane')!.getBoundingClientRect(), scope: document.querySelector('.lc-scope-pane')!.getBoundingClientRect() }));
      assert.ok(panes.rail.right <= panes.chat.left + 1 && panes.chat.right <= panes.scope.left + 1 && panes.scope.width >= 300 && panes.scope.width <= 340, JSON.stringify(panes));
      assert.match(await ws.locator('.lc-scope-pill').innerText(), /3 \/ 3 papers \(2 Abstract only\)/);
      const absGroup = ws.locator('input[data-group-id="kind:abstract"]'), untaggedGroup = ws.locator('input[data-group-id="tag:__untagged__"]');
      await absGroup.click();
      assert.equal(await absGroup.isChecked(), false); assert.equal(await untaggedGroup.evaluate(el => (el as HTMLInputElement).indeterminate), true);
      assert.equal((await ws.locator('.lc-scope-pill').innerText()).trim(), '1 / 3 papers');
      await absGroup.click();
      assert.equal(await absGroup.isChecked(), true); assert.equal(await untaggedGroup.evaluate(el => (el as HTMLInputElement).indeterminate), false);

      await ws.locator('.lc-input').fill('slow-stream-markdown stop check'); await ws.locator('.lc-input').press('Enter');
      const stopBtn = ws.locator('.lc-composer .chat-stop'); await stopBtn.waitFor({ state: 'visible' });
      await ws.locator('.lc-turn .chat-stream-body h3').waitFor({ state: 'visible' }); await stopBtn.click();
      await ws.locator('.lc-stopped-bar').waitFor({ state: 'visible' });
      assert.match(await ws.locator('.lc-answer-body h3').first().innerText(), /Key Result/);

      const lcCite = { key: 'pagedattention:p6', docId: 'pagedattention', authorLabel: 'Kwon et al.', year: '2023', page: 6, quote: 'PagedAttention divides the KV cache of each sequence into blocks.', title: 'PagedAttention: Efficient Memory Management', kind: 'pdf' as const };
      await page.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string };
        if (body.op === 'library.chat') {
          const answer = 'PagedAttention partitions KV cache into fixed blocks (Kwon et al., 2023, p. 6).';
          await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ delta: answer }) + '\n' + JSON.stringify({ answer, citations: [lcCite], truncatedCount: 0, usedDocIds: ['pagedattention'], usedAbstractOnlyIds: [] }) + '\n' });
          return;
        }
        await route.fallback();
      });
      await ws.locator('.lc-clear-btn').click(); await ws.locator('.lc-preset-chip[data-preset="compare_methods"]').click();
      const citeBtn = ws.locator('.lc-cite').first(); await citeBtn.waitFor({ state: 'visible' }); await citeBtn.hover();
      await ws.locator('.lc-popover').waitFor({ state: 'visible' }); assert.match(await ws.locator('.lc-pop-quote').innerText(), /divides the KV cache/);
      await citeBtn.click(); await page.locator('#returnWorkspace').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#pageCount').innerText()).trim(), '6 / 16'); assert.match(await page.locator('.return-workspace-go').innerText(), /Library Chat/);
      await page.locator('.return-workspace-go').click(); await ws.locator('.lc-cite').first().waitFor({ state: 'visible' });
      await ws.locator('.lc-save-note').first().click(); await ws.locator('.lc-save-note[data-saved="true"]').waitFor({ state: 'visible' });
      await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
      await ws.locator('.lc-save-note:not([data-saved="true"])').waitFor({ state: 'visible' });
      await ws.locator('.lc-save-note').first().click(); await ws.locator('.lc-save-note[data-saved="true"]').waitFor({ state: 'visible' });
      await page.locator('#toast').getByRole('button', { name: 'View', exact: true }).click(); await page.locator('#notesTab[aria-selected="true"]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => (document.getElementById('railBody')?.textContent ?? '').includes('PagedAttention partitions KV cache'));
      await page.locator('.return-workspace-go').click(); await ws.locator('.lc-cite').first().waitFor({ state: 'visible' });
      await page.setViewportSize({ width: 1024, height: 768 }); await ws.locator('.lc-scope-pane').waitFor({ state: 'hidden' });
      await ws.locator('.lc-scope-toggle').click(); await ws.locator('.lc-scope-pane').waitFor({ state: 'visible' });
      const s1024 = await ws.locator('.lc-scope-pane').evaluate(el => { const r = el.getBoundingClientRect(); return { w: r.width, l: r.left, r: r.right }; });
      assert.ok(s1024.w >= 280 && s1024.l >= 52 && s1024.r <= 1024, JSON.stringify(s1024));
      await page.keyboard.press('Escape'); await ws.locator('.lc-scope-pane').waitFor({ state: 'hidden' });

      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(80);
      const lcMob = await ws.evaluate(() => ({ top: document.querySelector('.lc-log')!.getBoundingClientRect().top, ov: document.documentElement.scrollWidth - innerWidth }));
      assert.ok(lcMob.top <= 150 && lcMob.ov <= 1, JSON.stringify(lcMob));
      await ws.locator('.lc-scope-pill').click(); await ws.locator('.lc-scope-pane').waitFor({ state: 'visible' });
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await page.keyboard.press('Escape'); await ws.locator('.lc-scope-pane').waitFor({ state: 'hidden' });
      await page.unroute('**/api/paper-reader/action');

      await page.setViewportSize({ width: 1440, height: 900 });
      await ws.locator('.rw-nav-btn[data-view="review-table"]').click(); await ws.locator('.rt-grid').waitFor({ state: 'visible' });
      assert.equal(await ws.getAttribute('data-rail-collapsed'), 'true'); assert.equal(await ws.locator('.rt-inspector').isVisible(), false);
      assert.ok(await ws.evaluate(() => document.querySelector('.rt-col-paper')!.getBoundingClientRect().width / document.querySelector('.rt-main-pane')!.getBoundingClientRect().width <= 0.31));
      assert.ok((await ws.locator('.rt-src-badge.is-pdf').count()) >= 1 && (await ws.locator('.rt-src-badge.is-abstract').count()) >= 1);

      await ws.locator('.rt-step-btn[data-step="screening"]').click();
      for (const crit of ['LLM serving', 'Open weights']) {
        await ws.locator('.rt-crit-in').fill(crit); await ws.locator('.rt-crit-add').click();
        await ws.locator('.rt-crit-chip', { hasText: crit }).waitFor({ state: 'visible' });
      }
      await ws.locator('.rt-screen-run').click();
      await ws.locator('.rt-part[data-part="excluded"] .rt-srow[data-doc-id="pagedattention"]').waitFor({ state: 'visible' });
      assert.ok((await ws.locator('.rt-threshold').boundingBox())!.height >= 24);
      await ws.locator('.rt-threshold').fill('40');
      await ws.locator('.rt-part[data-part="included"] .rt-srow[data-doc-id="pagedattention"]').waitFor({ state: 'visible' });
      await ws.locator('.rt-strict-btn').click();
      await ws.locator('.rt-part[data-part="excluded"] .rt-srow[data-doc-id="pagedattention"]').waitFor({ state: 'visible' });
      await ws.locator('.rt-srow[data-doc-id="pagedattention"] .rt-dec-btn[data-decision="yes"]').click();
      await ws.locator('.rt-part[data-part="included"] .rt-srow[data-doc-id="pagedattention"]').waitFor({ state: 'visible' });
      await ws.locator('.rt-save-next').click();
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.rt-srow.is-active')?.dataset.docId !== 'pagedattention');
      await ws.locator('.rt-srow[data-doc-id="pagedattention"] .rt-scrit-cell').first().click(); await ws.locator('.rt-inspector').waitFor({ state: 'visible' });
      await ws.locator('.rt-crit-chip .rt-crit-del').first().click(); await ws.locator('.rt-inspector').waitFor({ state: 'hidden' });

      await ws.locator('.rt-step-btn[data-step="extraction"]').click(); await ws.locator('.rt-grid').waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.rt-inspector').isVisible(), false);
      await ws.locator('.rt-pilot-btn').click();
      await ws.locator('.rt-cell[data-doc-id="pagedattention"][data-col-id="method"] .rt-cell-badge.is-verified').waitFor({ state: 'visible' });
      await ws.locator('.rt-stop-btn').click(); await ws.locator('.rt-stop-btn').waitFor({ state: 'hidden' });
      assert.match(await ws.locator('.rt-cell[data-doc-id="pagedattention"][data-col-id="method"]').innerText(), /PagedAttention block KV cache/);
      assert.equal(await ws.locator('.rt-cell[data-doc-id="pagedattention"][data-col-id="datasets"] .rt-cell-badge.is-unverified').count(), 1);
      await ws.locator('.rt-add-col-btn').click(); await ws.locator('.rt-col-picker').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape'); await ws.locator('.rt-col-picker').waitFor({ state: 'hidden' });
      await ws.locator('.rt-add-col-btn').click(); await ws.locator('.rt-col-picker').waitFor({ state: 'visible' });
      await ws.locator('.rt-col-name-in').fill('Throughput'); await ws.locator('.rt-col-submit').click();
      await ws.locator('.rt-col-label', { hasText: 'Throughput' }).waitFor({ state: 'visible' });

      const mCell = ws.locator('.rt-cell[data-doc-id="pagedattention"][data-col-id="method"]');
      await mCell.click(); await ws.locator('.rt-inspector').waitFor({ state: 'visible' });
      assert.match(await ws.locator('.rt-insp-quote').innerText(), /block tables/);
      await mCell.focus(); await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => (document.querySelector('.rt-insp-col')?.textContent ?? '').includes('Datasets'));
      assert.match(await ws.locator('.rt-insp-status').innerText(), /Unverified/);
      await ws.locator('.rt-insp-textarea').fill('ShareGPT + LMSYS-Chat-1M'); await ws.locator('.rt-insp-save').click();
      await ws.locator('.rt-cell[data-doc-id="pagedattention"][data-col-id="datasets"] .rt-cell-badge.is-manual').waitFor({ state: 'visible' });
      await mCell.click(); await ws.locator('.rt-insp-jump').click();
      await page.locator('.topbar #returnWorkspace').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#pageCount').innerText()).trim(), '6 / 16');
      assert.match(await page.locator('.return-workspace-go').innerText(), /Review Table/);
      await page.locator('.return-workspace-go').click(); await ws.locator('.rt-inspector').waitFor({ state: 'visible' });

      const [csvDl] = await Promise.all([page.waitForEvent('download'), ws.locator('.rt-export-csv').click()]);
      assert.match(csvDl.suggestedFilename(), /\.csv$/);
      await page.setViewportSize({ width: 1024, height: 768 });
      const rt1024 = await ws.locator('.rt-inspector').evaluate(el => { const r = el.getBoundingClientRect(); return { w: r.width, l: r.left, r: r.right }; });
      assert.ok(rt1024.w >= 320 && rt1024.l >= 52 && rt1024.r <= 1024, JSON.stringify(rt1024));
      await ws.locator('.rt-insp-textarea').focus(); await page.keyboard.press('Escape'); await ws.locator('.rt-inspector').waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(80);
      const rtMob = await ws.evaluate(() => { const eb = document.querySelector('.rt-extract-bar')!, b = document.querySelector('.rt-mcard .rt-src-badge')!; return { top: document.querySelector('.rt-body-scroll')!.getBoundingClientRect().top, cards: document.querySelectorAll('.rt-mcard').length, ov: document.documentElement.scrollWidth - innerWidth, ebOv: eb.scrollWidth - eb.clientWidth, bw: b.getBoundingClientRect().width }; });
      assert.ok(rtMob.top <= 150 && rtMob.cards >= 3 && rtMob.ov <= 1 && rtMob.ebOv <= 1 && rtMob.bw < 140, JSON.stringify(rtMob));
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await ws.locator('.rt-mcard-row').first().click(); await ws.locator('.rt-inspector').waitFor({ state: 'visible' });
      await assertMobilePanelTargets(page, '.rt-inspector');
      await page.keyboard.press('Escape'); await ws.locator('.rt-inspector').waitFor({ state: 'hidden' });
      await ws.locator('.rt-step-btn[data-step="screening"]').click();
      assert.ok(await ws.evaluate(() => { const sc = document.querySelector('.rt-screen-ctrls')!; return sc.scrollWidth <= sc.clientWidth + 1 && document.querySelector('.rt-body-scroll')!.getBoundingClientRect().top <= 150; }));

      const dsC1 = { id: 'DS1', openAlexId: 'W801', title: 'Virtual Block Table Paging for Tensor Heaps', authors: ['Lin Wu', 'Mei Zhou'], firstAuthor: 'Lin Wu', lastAuthor: 'Mei Zhou', year: 2024, venue: 'OSDI', doi: '10.1000/ds1', citationCount: 210, source: 'openalex' as const, inLibrary: false, abstract: 'Eliminates KV fragmentation with non-contiguous slabs.', matchScore: 94, rationale: 'Directly removes memory waste via block tables.', category: 'Block Paging', foundRound: 1 };
      const dsC2 = { id: 'DS2', openAlexId: 'W802', title: 'Prefix-Aware KV Eviction Engine', authors: ['Sam Patel'], firstAuthor: 'Sam Patel', lastAuthor: 'Sam Patel', year: 2025, venue: 'MLSys', doi: '10.1000/ds2', citationCount: 88, source: 'openalex' as const, inLibrary: false, abstract: 'Retains shared prompt prefixes under pressure.', matchScore: 82, rationale: 'Targets prefix reuse in autoregressive serving.', category: 'Prefix Sharing', foundRound: 2 };
      let dsRunCount = 0;
      const streamSrv = createServer((req, res) => {
        res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'content-type, accept');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
        const runNo = ++dsRunCount, curve1 = [{ round: 1, evaluated: 12, matched: 1, newMatches: 1 }];
        res.write(JSON.stringify({ type: 'progress', round: 1, totalRounds: 2, stage: 'score', evaluatedCount: 12, matchedCount: 1, newMatches: 1, saturationCurve: curve1, degraded: ['s2'], message: 'Round 1 scored', candidates: [dsC1] }) + '\n');
        if (runNo <= 2) { const tmr = setTimeout(() => res.end(), 20_000); req.on('close', () => clearTimeout(tmr)); return; }
        const curve2 = [...curve1, { round: 2, evaluated: 24, matched: 2, newMatches: 1 }];
        res.end(JSON.stringify({ type: 'result', result: { query: 'Eliminate KV fragmentation', overview: 'Key advances include [#1] (Wu, 2024) and [#2] (Patel, 2025).', categories: ['Block Paging', 'Prefix Sharing'], candidates: [dsC1, dsC2], roundsCompleted: 2, totalEvaluated: 24, saturationCurve: curve2, degraded: ['s2'], aborted: false } }) + '\n');
      });
      await new Promise<void>(r => streamSrv.listen(0, '127.0.0.1', r));
      const streamUrl = `http://127.0.0.1:${(streamSrv.address() as { port: number }).port}/`;
      const wlEntries: Record<string, unknown>[] = [];
      await page.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string; payload?: Record<string, unknown> };
        if (body.op === 'deepSearch.clarify') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: body.payload?.query ?? '', questions: [{ id: 'q1', question: 'Target hardware?', options: ['Single GPU', 'Multi-node'] }, { id: 'q2', question: 'Time window?', options: ['Last 3 years', 'All years'] }] }) }); return; }
        if (body.op === 'deepSearch.run') { await route.continue({ url: streamUrl }); return; }
        if (body.op === 'watchlist.list') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: wlEntries }) }); return; }
        if (body.op === 'watchlist.save') { const e = { id: 'wl1', kind: 'topic', label: String(body.payload?.label ?? 'KV Watch'), query: String(body.payload?.query ?? ''), sources: ['openalex'], cursorDate: '2025-01-01', seenKeys: [], unread: [], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }; wlEntries.splice(0, wlEntries.length, e); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entry: e }) }); return; }
        if (body.op === 'watchlist.check') { if (wlEntries[0]) (wlEntries[0] as { unread: unknown[] }).unread = [{ key: 'ds2', paper: dsC2, foundAt: '2025-02-01T00:00:00Z' }]; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: wlEntries, checkedCount: 1, newItemsCount: 1, degraded: [] }) }); return; }
        if (body.op === 'watchlist.markRead') { if (wlEntries[0]) (wlEntries[0] as { unread: unknown[] }).unread = []; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entry: wlEntries[0] }) }); return; }
        if (body.op === 'graph.savePaper') { assert.equal(body.payload?.mode, 'auto'); await route.continue({ postData: JSON.stringify({ ...body, payload: { ...body.payload, mode: 'abstract' } }) }); return; }
        if (body.op === 'graph.resolve' || body.op === 'graph.explore') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.op === 'graph.resolve' ? { paper: dsC1, degraded: [], fromCache: false } : { seeds: [dsC1], nodes: [{ ...dsC1, isSeed: true }], edges: [], degraded: [], fromCache: false }) }); return; }
        await route.fallback();
      });
      await page.setViewportSize({ width: 1440, height: 900 }); await ws.locator('.rw-nav-btn[data-view="deep-search"]').click();
      await ws.locator('.ds-query-input').fill('Eliminate KV fragmentation');
      await ws.locator('.ds-clarify-btn').click();
      await ws.locator('.ds-q-card').first().waitFor({ state: 'visible' }); assert.equal(await ws.locator('.ds-q-card').count(), 2);
      await ws.locator('.ds-opt-chip', { hasText: 'Single GPU' }).focus(); await page.keyboard.press('Enter');
      assert.ok(await ws.evaluate(() => document.activeElement?.classList.contains('ds-opt-chip') && document.activeElement.getAttribute('aria-pressed') === 'true'));
      await ws.locator('.ds-start-btn').click(); await ws.locator('.ds-curve-svg').waitFor({ state: 'visible' }); assert.equal(await ws.locator('.ds-scoping').count(), 0);
      await page.waitForFunction(() => document.querySelector('.ds-kpi[data-kpi="evaluated"] .ds-kpi-val')?.textContent === '12');
      await ws.locator('.ds-stop-btn').click(); await ws.locator('.ds-partial-banner').waitFor({ state: 'visible' }); assert.equal(await ws.locator('.ds-card').count(), 1);
      await ws.locator('.ds-edit-scope-btn').click(); await ws.locator('.ds-skip-btn').click();
      await page.waitForFunction(() => document.querySelector('.ds-kpi[data-kpi="evaluated"] .ds-kpi-val')?.textContent === '12');
      await ws.locator('.rw-nav-btn[data-view="citation-map"]').click(); await ws.locator('.rw-nav-btn[data-view="deep-search"]').click();
      await ws.locator('.ds-partial-banner').waitFor({ state: 'visible' }); assert.equal(await ws.locator('.ds-telemetry').count(), 0);
      await ws.locator('.ds-edit-scope-btn').click(); await ws.locator('.ds-skip-btn').click(); await ws.locator('.ds-cite-ref[data-rank="1"]').waitFor({ state: 'visible' });
      assert.ok(await ws.evaluate(() => [...document.querySelectorAll('.ds-sel-wrap, a.ds-title-link')].every(e => { const r = e.getBoundingClientRect(); return r.width >= 24 && r.height >= 24; })));
      await ws.locator('.ds-cat-chip[data-cat="Prefix Sharing"]').focus(); await page.keyboard.press('Enter');
      assert.equal(await ws.locator('.ds-card').count(), 1); assert.equal(await ws.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.cat), 'Prefix Sharing');
      await ws.locator('.ds-cite-ref[data-rank="1"]').click(); assert.equal(await ws.locator('.ds-card').count(), 2);
      assert.equal(await ws.locator('.ds-card[data-rank="1"] .ds-match-pill').innerText(), '★ 94%');
      await ws.locator('.ds-card[data-rank="1"] .ds-abs-toggle').focus(); await page.keyboard.press('Enter'); await ws.locator('.ds-card[data-rank="1"] .ds-abs-text').waitFor({ state: 'visible' });
      assert.ok(await ws.evaluate(() => document.activeElement?.matches('.ds-card[data-rank="1"] .ds-abs-toggle')));
      await ws.locator('.ds-card[data-rank="1"] .ds-sel-check').focus(); await page.keyboard.press('Space');
      assert.ok(await ws.evaluate(() => document.activeElement?.matches('.ds-card[data-rank="1"] .ds-sel-check') && !(document.querySelector('.ds-batch-save-btn') as HTMLButtonElement).disabled));
      await ws.locator('.ds-card[data-rank="1"] .ds-import-btn').click(); await ws.locator('.ds-card[data-rank="1"] .ds-open-btn').waitFor({ state: 'visible' }); assert.equal(await ws.locator('.ds-batch-save-btn').isDisabled(), true);
      await ws.locator('.ds-wl-btn').click(); await ws.locator('.wl-drawer').waitFor({ state: 'visible' });
      await ws.locator('.wl-add-input').fill('KV Paging Watch'); await ws.locator('.wl-add-btn').click();
      await ws.locator('.wl-check-one').click(); await ws.locator('.wl-unread-badge').waitFor({ state: 'visible' });
      await ws.locator('.wl-mark-read').click(); await ws.locator('.wl-unread-badge').waitFor({ state: 'hidden' });
      await ws.locator('.wl-add-input').focus(); await page.keyboard.press('Escape'); await ws.locator('.wl-drawer').waitFor({ state: 'hidden' });
      await ws.locator('.ds-to-review-btn').click(); await ws.locator('.rw-nav-btn[data-view="review-table"][aria-current="page"]').waitFor({ state: 'visible' });
      await ws.locator('.rw-nav-btn[data-view="deep-search"]').click(); await ws.locator('.ds-to-map-btn').click();
      assert.equal(await ws.locator('.rw-nav-btn[aria-current="page"]').getAttribute('data-view'), 'citation-map');
      await ws.locator('.rw-nav-btn[data-view="deep-search"]').click();
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(80);
      assert.ok(await ws.evaluate(() => document.querySelector('.ds-body')!.getBoundingClientRect().top <= 150 && document.documentElement.scrollWidth <= innerWidth + 1));
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await page.unroute('**/api/paper-reader/action'); streamSrv.close();
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
      await zhPage.locator('.ds-wl-btn').click(); await zhPage.locator('.wl-drawer').waitFor({ state: 'visible' });
      assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Deep Search & Watchlist', ['clarify', 'watchlist']);
      await zhPage.keyboard.press('Escape'); await zhPage.locator('.wl-drawer').waitFor({ state: 'hidden' });
      await zhPage.locator('.rw-nav-btn[data-view="citations"]').click();
      assertNoZhEnglishLeaks(await collectChromeStrings(zhPage, '.cit-title, .cit-byline, .cit-doc-select, .cit-card-title, .cit-meta-text, .cit-ctx-text, .cit-rationale'), 'zh-CN Citations');
      await zhPage.locator('.rw-nav-btn[data-view="citation-map"]').click();
      assertNoZhEnglishLeaks(await collectChromeStrings(zhPage, '.cm-seed-pill, .cm-seed-picker, .cm-crumb, .cm-row-title, .cm-row-meta'), 'zh-CN Citation Map');
      await zhPage.locator('.rw-nav-btn[data-view="field-trends"]').click();
      assertNoZhEnglishLeaks(await collectChromeStrings(zhPage, '.ft-starter-chip, .ft-topic-name'), 'zh-CN Field Trends');
      await zhPage.locator('.rw-nav-btn[data-view="library-chat"]').click();
      await zhPage.locator('.lc-scope-pane').waitFor({ state: 'visible' });
      const zhLc = await collectChromeStrings(zhPage, '.lc-doc-info, .lc-group-name');
      assertNoZhEnglishLeaks(zhLc, 'zh-CN Library Chat');
      assert.equal(zhLc.some(s => /全库\s*Copilot|摘要存根|筛抽矩阵|纳排筛选/.test(s.text)), false);
      await zhPage.locator('.rw-nav-btn[data-view="review-table"]').click();
      await zhPage.locator('.rt-grid').waitFor({ state: 'visible' });
      await zhPage.locator('.rt-add-col-btn').click(); await zhPage.locator('.rt-col-picker').waitFor({ state: 'visible' });
      const zhRt = await collectChromeStrings(zhPage, '.rt-paper-title, .rt-paper-meta, .rt-cell-val, .rt-mcard-v, .rt-col-label');
      assertNoZhEnglishLeaks(zhRt, 'zh-CN Review Table', ['screening', 'extraction', 'pico', 'pilot', 'evidence', 'verified', 'unverified', 'throughput']);
      assert.equal(zhRt.some(s => /纳排筛选|筛抽矩阵|摘要存根|全库\s*Copilot/.test(s.text)), false);
      await zhCtx.close();
      assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
    } finally { await browser.close(); }
  }, {}, { modelFixture: true });
}

run().catch(error => { console.error(error); process.exit(1); });
