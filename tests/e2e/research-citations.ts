import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import type { CitationStance, CitationStatement, CitationTallies } from '../../src/shared/citation-stance-types.js';
import { withHost } from './host.js';
import { openReaderPage } from './helpers/reader.js';
import { assertMobilePanelTargets } from './helpers/dom-probes.js';
import { assertNoZhEnglishLeaks, collectChromeStrings } from './helpers/i18n.js';

const calcTallies = (list: CitationStatement[]): CitationTallies => {
  const papers = new Set(list.map(s => s.citingDoi || s.citingDocId || s.citingTitle));
  const c = { supporting: 0, extending: 0, contrasting: 0, mentioning: 0, unclassified: 0, localBackCitations: 0 };
  for (const s of list) { if (s.source === 'local') c.localBackCitations++; c[s.stance]++; }
  return { citingPapers: papers.size, citationStatements: list.length, ...c };
};
const mkStmt = (p: Partial<CitationStatement> & Pick<CitationStatement, 'citingKey' | 'source' | 'citingTitle' | 'stance'>): CitationStatement => ({
  targetKey: 'arxiv:2309.06180', direction: 'cited_by', docId: 'pagedattention', citingAuthors: ['Ada Lovelace'], section: 'Results',
  context: 'PagedAttention divides the KV cache into blocks.', rationale: 'Grounded snippet.', isInfluential: false, isSelfCitation: false, manualOverride: false, updatedAt: '2026-01-01T00:00:00Z', ...p
});

async function run(): Promise<void> {
  await withHost(async host => {
    const browser = await chromium.launch({ executablePath: host.executable, headless: true });
    try {
      const pageErrors: string[] = [], consoleErrors: string[] = [];
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
      const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=5', { tag: 'cit-en', scope: { allowZotero503: true }, pageErrors, consoleErrors });
      const yr = new Date().getFullYear();
      const created = await (await ctx.request.post(host.origin + '/api/paper-reader/action', {
        data: { op: 'library.createAbstract', payload: { title: 'Adaptive Block Scheduling for Serving Pipelines', authors: 'Dana Park; Woosuk Kwon', year: String(yr - 1), doi: '10.1000/adaptive-kv', abstract: 'Building on arXiv:2309.06180 PagedAttention, we observe high page-table lookup latency under heterogeneous request batches.' } }
      })).json() as { doc: { id: string } };
      const localDocId = created.doc.id;
      if (!(await page.locator('#rail').isVisible())) await page.locator('#mobileRail').click();
      await page.locator('#refsTab').click();
      await page.locator('.ref-cit-local').waitFor({ state: 'visible' });
      assert.match(await page.locator('.ref-cit-local').innerText(), /★ 1 local/);
      assert.equal(await page.locator('.ref-cit-scite').getAttribute('target'), '_blank');
      assert.equal(await page.locator('.ref-cit-scite').getAttribute('rel'), 'noopener noreferrer');

      const longCtx = 'Unlike Kwon et al. (2023), PagedAttention incurs noticeable page-table indirection overhead on very long multi-turn prompts and degrades throughput when batch sequences mix short chat queries with 32k-token document contexts across heterogeneous worker GPUs in production serving clusters.';
      const target = { targetKey: 'arxiv:2309.06180', docId: 'pagedattention', title: 'PagedAttention: Efficient Memory Management', authors: ['Woosuk Kwon', 'Zhuohan Li'], year: 2023, arxivId: '2309.06180', sciteUrl: 'https://scite.ai/search?q=PagedAttention' };
      const citedStmts: CitationStatement[] = [
        mkStmt({ citingKey: `local:${localDocId}:p1`, source: 'local', citingDocId: localDocId, citingPage: 1, citingTitle: 'Adaptive Block Scheduling for Serving Pipelines', citingAuthors: ['Dana Park', 'Woosuk Kwon'], citingYear: yr - 1, section: 'Methods', context: longCtx, stance: 'contrasting', rationale: 'Notes lookup overhead.', isInfluential: true, isSelfCitation: true }),
        mkStmt({ citingKey: 'local:pagedattention:p6', source: 'local', citingDocId: 'pagedattention', citingPage: 6, citingTitle: 'Local Block Table Verification Note', citingAuthors: ['Elena Cho'], citingYear: yr, section: 'Results', stance: 'supporting', rationale: 'Validates block tables.' }),
        mkStmt({ citingKey: 's2:ext1', source: 's2', citingTitle: 'Disaggregated Prefix Paging', citingAuthors: ['Sam Patel'], citingYear: yr - 1, citingDoi: '10.1000/disagg-prefix', section: 'Introduction', context: 'We extend PagedAttention with prefix-aware remote KV pools.', stance: 'extending', rationale: 'Extends paging.', isInfluential: true }),
        mkStmt({ citingKey: 's2:ext1#1', source: 's2', citingTitle: 'Disaggregated Prefix Paging', citingAuthors: ['Sam Patel'], citingYear: yr - 1, citingDoi: '10.1000/disagg-prefix', section: 'Discussion', context: 'PagedAttention is widely deployed in LLM serving frameworks.', stance: 'mentioning', rationale: 'Background mention.' }),
        mkStmt({ citingKey: 's2:noctx', source: 's2', citingTitle: 'Survey of Inference Engines', citingAuthors: ['Lin Wu'], citingYear: yr - 5, citingDoi: '10.1000/survey-inf', section: 'Unknown', context: '', stance: 'unclassified', rationale: '' })
      ];
      const refStmts = [mkStmt({ direction: 'references', citingKey: 'local:ref1:p6', source: 'local', citingDocId: localDocId, citingPage: 6, citingTitle: 'Orca: Iteration-Level Scheduling', citingAuthors: ['Gyeong-In Yu'], citingYear: 2022, section: 'Introduction', context: 'Continuous batching from Orca motivates paged KV management.', stance: 'extending', rationale: 'Builds on Orca.' })];
      let forceOffline = false, delayReclass = false, releaseReclass = () => {};
      await page.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string; payload?: Record<string, unknown> };
        if (body.op === 'citations.summary') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ targetKey: target.targetKey, tallies: calcTallies(citedStmts), sciteUrl: target.sciteUrl, hasCachedExternal: true }) }); return; }
        if (body.op === 'citations.analyze') {
          const dir = body.payload?.direction === 'references' ? 'references' : 'cited_by', list = dir === 'references' ? refStmts : (forceOffline ? citedStmts.filter(s => s.source === 'local') : citedStmts);
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ target, direction: dir, tallies: calcTallies(list), statements: list, sciteUrl: target.sciteUrl, degraded: forceOffline ? ['s2'] : [], fromCache: !forceOffline, offline: forceOffline }) }); return;
        }
        if (body.op === 'citations.reclassify') {
          if (delayReclass) { delayReclass = false; await new Promise<void>(r => { releaseReclass = r; }); }
          const row = citedStmts.find(s => s.citingKey === String(body.payload?.citingKey ?? '')); if (row) { row.stance = body.payload?.stance as CitationStance; row.manualOverride = true; }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ statement: row, tallies: calcTallies(citedStmts) }) }); return;
        }
        await route.fallback();
      });

      await page.locator('#notesTab').click(); await page.locator('#refsTab').click();
      const conPill = page.locator('.ref-cit-pill[data-stance="contrasting"]'); await conPill.waitFor({ state: 'visible' });
      assert.match(await conPill.innerText(), /⊘ Contrasting 1/); await conPill.click();
      const ws = page.locator('#researchWorkspace'); await ws.waitFor({ state: 'visible' }); await ws.locator('.cit-card').first().waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.rw-nav-btn[aria-current="page"]').getAttribute('data-view'), 'citations');
      assert.equal(await ws.locator('.cit-unit[data-unit="papers"]').innerText(), 'Citing Papers (4)');
      assert.equal(await ws.locator('.cit-unit[data-unit="statements"]').innerText(), 'Citation Statements (5)');
      assert.equal(await ws.locator('.cit-tally-btn[data-stance="contrasting"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await ws.locator('.cit-facets input[data-stance="contrasting"]').isChecked(), true);
      assert.equal(await ws.locator('.cit-card').count(), 1); assert.equal(await ws.locator('.cit-scite-link').getAttribute('href'), target.sciteUrl);
      await ws.locator('.cit-tally-btn[data-stance="contrasting"]').focus(); await page.keyboard.press('Enter');
      assert.equal(await ws.locator('.cit-card').count(), 5); assert.equal(await ws.locator('.cit-dist-seg').count(), 5);
      assert.ok(await ws.evaluate(() => document.activeElement?.matches('.cit-tally-btn[data-stance="contrasting"]')));
      await ws.locator('.cit-dir-btn[data-dir="references"]').click(); await ws.locator('.cit-card', { hasText: 'Orca: Iteration-Level Scheduling' }).waitFor({ state: 'visible' });
      assert.match(await ws.locator('.cit-dir-btn[data-dir="cited_by"]').innerText(), /Cited by \(5\)/);
      await ws.locator('.cit-dir-btn[data-dir="cited_by"]').click(); await ws.locator('.cit-card').nth(4).waitFor({ state: 'visible' });
      await ws.locator('.cit-facets select[data-facet="section"]').selectOption('Methods'); assert.equal(await ws.locator('.cit-card').count(), 1);
      await ws.locator('.cit-facets select[data-facet="section"]').selectOption('');
      await ws.locator('.cit-facets select[data-facet="source"]').selectOption('local'); assert.equal(await ws.locator('.cit-card').count(), 2);
      await ws.locator('.cit-facets input[data-facet="excludeSelf"]').check(); assert.equal(await ws.locator('.cit-card').count(), 1);
      await ws.locator('.cit-clear-btn').click(); await ws.locator('.cit-facets select[data-facet="year"]').selectOption('2y'); assert.equal(await ws.locator('.cit-card').count(), 4);
      await ws.locator('.cit-clear-btn').click(); await ws.locator('.cit-search-input').fill('prefix-aware'); assert.equal(await ws.locator('.cit-card').count(), 1);
      await ws.locator('.cit-search-input').fill(''); await ws.locator('.cit-sort-select').selectOption('contrasting');
      assert.equal(await ws.locator('.cit-card').first().getAttribute('data-stance'), 'contrasting');
      const expBtn = ws.locator('.cit-card[data-stance="contrasting"] .cit-expand-btn'); await expBtn.focus(); await page.keyboard.press('Enter');
      assert.equal(await expBtn.getAttribute('aria-expanded'), 'true');
      assert.ok(await ws.evaluate(() => document.activeElement?.matches('.cit-expand-btn')));
      assert.match(await ws.locator('.cit-card[data-stance="unclassified"] .cit-no-ctx').innerText(), /No context available/);
      assert.ok(await ws.evaluate(() => document.querySelector('.cit-facet-select[data-facet="source"]')!.getBoundingClientRect().width <= document.querySelector('.cit-facet-select[data-facet="section"]')!.getBoundingClientRect().width + 1));
      const saveCard = ws.locator('.cit-card[data-citing-key="s2:ext1"]'); await saveCard.locator('.cit-save-abs').click(); await saveCard.locator('.cit-open-btn').waitFor({ state: 'visible' });
      await ws.locator('.cit-card[data-citing-key="s2:ext1#1"] .cit-open-btn').waitFor({ state: 'visible' });
      await ws.locator('.cit-tally-btn[data-stance="contrasting"]').click();
      await ws.locator(`.cit-reclass-select[data-citing-key="local:${localDocId}:p1"]`).selectOption('supporting');
      await page.waitForFunction(() => document.querySelector('.cit-tally-btn[data-stance="supporting"] .cit-tally-count')?.textContent === '2');
      assert.ok(await ws.evaluate(() => document.activeElement?.matches('.cit-clear-btn')));
      await ws.locator('.cit-clear-btn').click();
      assert.equal(await ws.locator(`.cit-card[data-citing-key="local:${localDocId}:p1"] .cit-manual-tag`).isVisible(), true);
      delayReclass = true;
      await ws.locator('.cit-reclass-select[data-citing-key="s2:ext1"]').selectOption('supporting');
      await ws.locator('.cit-dir-btn[data-dir="references"]').click(); await ws.locator('.cit-card', { hasText: 'Orca: Iteration-Level Scheduling' }).waitFor({ state: 'visible' });
      releaseReclass(); await page.waitForTimeout(80);
      assert.equal(await ws.locator('.cit-unit[data-unit="statements"]').innerText(), 'Citation Statements (1)');
      await ws.locator('.cit-dir-btn[data-dir="cited_by"]').click(); await ws.locator('.cit-card').nth(4).waitFor({ state: 'visible' });
      forceOffline = true; await ws.locator('.cit-refresh-btn').click();
      await ws.locator('.cit-banner[data-kind="offline"]').waitFor({ state: 'visible' }); assert.equal(await ws.locator('.cit-card').count(), 2);
      await ws.locator('.cit-card[data-citing-key="local:pagedattention:p6"] .cit-jump-btn').click();
      await page.locator('#returnWorkspace').waitFor({ state: 'visible' }); assert.equal((await page.locator('#pageCount').innerText()).trim(), '6 / 16');
      await page.locator('.return-workspace-go').click(); await ws.locator('.cit-banner[data-kind="offline"]').waitFor({ state: 'visible' });
      await ws.locator('.cit-search-input').fill('nomatch-xyz'); assert.equal(await ws.locator('.cit-card').count(), 0);
      await ws.locator('.rw-collapse-btn').click(); await ws.waitFor({ state: 'hidden' });
      await page.locator('.ref-cit-all').click(); await ws.locator('.cit-card').first().waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cit-search-input').inputValue(), ''); assert.equal(await ws.locator('.cit-card').count(), 2);
      await page.setViewportSize({ width: 1160, height: 900 });
      await page.waitForFunction(() => document.getElementById('researchWorkspace')?.getAttribute('data-rail-collapsed') === 'true');
      assert.ok(await ws.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(80);
      const mob = await ws.evaluate(() => {
        const sub = document.querySelector('.cit-subbar')!, cb = document.querySelector('.cit-dir-btn[data-dir="cited_by"]')!.getBoundingClientRect(), rf = document.querySelector('.cit-dir-btn[data-dir="references"]')!.getBoundingClientRect();
        return { top: document.querySelector('.cit-body')!.getBoundingClientRect().top, ov: document.documentElement.scrollWidth - innerWidth, subOv: sub.scrollWidth - sub.clientWidth, cbR: cb.right, rfR: rf.right };
      });
      assert.ok(mob.top <= 115 && mob.ov <= 1 && mob.subOv <= 1 && mob.cbR <= 390 && mob.rfR <= 390, JSON.stringify(mob));
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await ws.locator('.cit-filters-toggle').click(); await ws.locator('.cit-facets').waitFor({ state: 'visible' });
      await assertMobilePanelTargets(page, '.cit-facets');
      await page.keyboard.press('Escape'); await ws.locator('.cit-facets').waitFor({ state: 'hidden' }); await ctx.close();

      const zhCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
      const zhPage = await openReaderPage(zhCtx, host, '?doc=pagedattention&page=5', { tag: 'cit-zh', scope: { allowZotero503: true }, pageErrors, consoleErrors });
      await zhPage.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string };
        if (body.op === 'citations.analyze') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ target, direction: 'cited_by', tallies: calcTallies(citedStmts), statements: citedStmts, sciteUrl: target.sciteUrl, degraded: [], fromCache: false, offline: true }) }); return; }
        await route.fallback();
      });
      await zhPage.locator('#mobileRail').click(); await zhPage.locator('#refsTab').click();
      await zhPage.locator('.ref-cit-all').click(); await zhPage.locator('.cit-card').first().waitFor({ state: 'visible' });
      const zhItems = await collectChromeStrings(zhPage, '.cit-title, .cit-byline, .cit-doc-select, .cit-card-title, .cit-meta-text, .cit-ctx-text, .cit-rationale');
      assertNoZhEnglishLeaks(zhItems, 'zh-CN Citations View');
      assert.equal(zhItems.some(s => /智能引用大卡|摘要存根|纳排筛选/.test(s.text)), false);
      assert.deepEqual(await zhPage.locator('.cit-facets select[data-facet="section"] option').allInnerTexts(), ['全部', 'Introduction', 'Methods', 'Results', 'Discussion', '未知']);
      await zhCtx.close();
      assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
    } finally { await browser.close(); }
  }, {}, { modelFixture: true });
}

run().catch(error => { console.error(error); process.exit(1); });
