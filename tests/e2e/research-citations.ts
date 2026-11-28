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
        if (body.op === 'graph.savePaper') {
          assert.equal(body.payload?.mode, 'auto');
          await route.continue({ postData: JSON.stringify({ ...body, payload: { ...body.payload, mode: 'abstract' } }) });
          return;
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
      const saveCard = ws.locator('.cit-card[data-citing-key="s2:ext1"]'); await saveCard.locator('.cit-import-btn').click(); await saveCard.locator('.cit-open-btn').waitFor({ state: 'visible' });
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
      await ws.locator('.cit-wb-trigger').click(); await ws.locator('.cit-wb-picker').waitFor({ state: 'visible' });
      const mobPick = await ws.evaluate(() => { const r = document.querySelector('.cit-wb-picker')!.getBoundingClientRect(); const opts = [...document.querySelectorAll('.cit-wb-picker .pp-opt')].filter(o => o.scrollHeight > o.clientHeight + 2).length; return { l: r.left, r: r.right, ov: document.documentElement.scrollWidth - innerWidth, clip: opts }; });
      assert.ok(mobPick.l >= 0 && mobPick.r <= 390 && mobPick.ov <= 1 && mobPick.clip === 0, JSON.stringify(mobPick));
      await assertMobilePanelTargets(page, '.cit-wb-picker');
      await page.keyboard.press('Escape'); await ws.locator('.cit-wb-picker').waitFor({ state: 'hidden' });
      await ws.locator('.cit-filters-toggle').click(); await ws.locator('.cit-facets').waitFor({ state: 'visible' });
      await assertMobilePanelTargets(page, '.cit-facets');
      await page.keyboard.press('Escape'); await ws.locator('.cit-facets').waitFor({ state: 'hidden' });

      await page.setViewportSize({ width: 1440, height: 900 });
      await ws.locator('.cit-search-input').fill('nomatch-xyz');
      assert.equal(await ws.locator('.cit-card').count(), 0);
      await ws.locator('.cit-empty .cit-show-all-btn').waitFor({ state: 'visible' });
      await ws.locator('.cit-empty .cit-show-all-btn').click();
      assert.equal(await ws.locator('.cit-card').count(), 2);

      await page.unroute('**/api/paper-reader/action');
      const paperBTarget = { targetKey: 'doi:10.1000/adaptive-kv', docId: localDocId, title: 'Adaptive Block Scheduling for Serving Pipelines', authors: ['Dana Park'], year: yr - 1, doi: '10.1000/adaptive-kv', sciteUrl: 'https://scite.ai/search?q=Adaptive' };
      const paperBStmts: CitationStatement[] = [
        mkStmt({ targetKey: paperBTarget.targetKey, docId: localDocId, citingKey: 'oa:b1', source: 'openalex', citingTitle: 'Paper B Support One', stance: 'supporting', section: 'Results' }),
        mkStmt({ targetKey: paperBTarget.targetKey, docId: localDocId, citingKey: 'oa:b2', source: 'openalex', citingTitle: 'Paper B Mention Two', stance: 'mentioning', section: 'Discussion' })
      ];
      const extTarget = { targetKey: 'arxiv:1706.03762', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: 2017, arxivId: '1706.03762', sciteUrl: 'https://scite.ai/search?q=Attention' };
      const extStmts: CitationStatement[] = [mkStmt({ targetKey: extTarget.targetKey, docId: undefined, citingKey: 'oa:att1', source: 'openalex', citingTitle: 'BERT Pre-training', stance: 'extending', section: 'Introduction' })];
      const directDoiTarget = { targetKey: 'doi:10.1000/ext-direct', title: 'Direct DOI Benchmark Paper', authors: ['Grace Hopper'], year: 2024, doi: '10.1000/ext-direct', sciteUrl: 'https://scite.ai/reports/10.1000%2Fext-direct' };
      const directDoiStmts: CitationStatement[] = [mkStmt({ targetKey: directDoiTarget.targetKey, docId: undefined, citingKey: 'oa:dir1', source: 'openalex', citingTitle: 'Followup on Direct DOI', stance: 'supporting', section: 'Results' })];
      let resolveDocIds: string[] = [], summaryStale = false;
      const mapSeed = { id: 'W1', openAlexId: 'W1', title: 'PagedAttention: Efficient Memory Management', authors: ['Woosuk Kwon'], firstAuthor: 'Woosuk Kwon', lastAuthor: 'Woosuk Kwon', year: 2023, citationCount: 900, source: 'openalex', inLibrary: true, docId: 'pagedattention' };
      const mapAlt = { id: 'W9', openAlexId: 'W9', title: 'Adaptive Block Scheduling for Serving Pipelines', authors: ['Dana Park'], firstAuthor: 'Dana Park', lastAuthor: 'Dana Park', year: yr - 1, citationCount: 120, source: 'openalex', inLibrary: true, docId: localDocId };
      const mapNbr = { id: 'W2', openAlexId: 'W2', title: 'FlashAttention', authors: ['Tri Dao'], firstAuthor: 'Tri Dao', lastAuthor: 'Tri Dao', year: 2022, citationCount: 2400, source: 'openalex', inLibrary: false };
      const mapArxiv = { id: 'W4', openAlexId: 'W4', title: 'Lean4Agent: Formal Modeling', authors: ['Jane Doe'], firstAuthor: 'Jane Doe', lastAuthor: 'Jane Doe', year: 2026, arxivId: '2606.06523v3', oaPdfUrl: 'https://arxiv.org/pdf/2606.06523v3.pdf', citationCount: 40, source: 'arxiv', inLibrary: false };
      const mapFar = { id: 'W3', openAlexId: 'W3', title: 'Unrelated Kernel Paper', authors: ['Sam Lee'], firstAuthor: 'Sam Lee', lastAuthor: 'Sam Lee', year: 2021, citationCount: 30, source: 'openalex', inLibrary: false };
      const saveCalls: Record<string, unknown>[] = [], webOpenCalls: Record<string, unknown>[] = [];
      await page.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string; payload?: Record<string, unknown> };
        if (body.op === 'citations.summary') {
          const base = calcTallies(paperBStmts);
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ targetKey: paperBTarget.targetKey, tallies: summaryStale ? { ...base, contrasting: 1 } : base, sciteUrl: paperBTarget.sciteUrl, hasCachedExternal: true }) });
          return;
        }
        if (body.op === 'citations.analyze') {
          const isB = body.payload?.docId === localDocId, isExt = body.payload?.arxivId === '1706.03762', isDir = body.payload?.doi === '10.1000/ext-direct';
          const list = isDir ? directDoiStmts : isExt ? extStmts : isB ? paperBStmts : citedStmts.filter(s => s.stance !== 'contrasting');
          const tgt = isDir ? directDoiTarget : isExt ? extTarget : isB ? paperBTarget : target;
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ target: tgt, direction: 'cited_by', tallies: calcTallies(list), statements: list, sciteUrl: tgt.sciteUrl, degraded: [], fromCache: true, offline: false }) });
          return;
        }
        if (body.op === 'graph.search') {
          const q = String(body.payload?.query ?? '').toLowerCase();
          if (q.includes('rate-limited')) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ papers: [], degraded: ['openalex', 'europepmc'] }) }); return; }
          const papers = q.includes('attention') ? [{ id: 'W-ATT', openAlexId: 'W-ATT', title: extTarget.title, authors: extTarget.authors, firstAuthor: 'Ashish Vaswani', lastAuthor: 'Ashish Vaswani', year: 2017, citationCount: 128000, arxivId: '1706.03762', venue: 'NeurIPS', source: 'openalex', inLibrary: false }] : [];
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ papers, degraded: [] }) });
          return;
        }
        if (body.op === 'graph.resolve') {
          const id = String(body.payload?.docId ?? '');
          if (id) resolveDocIds.push(id);
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paper: id === localDocId ? mapAlt : mapSeed, degraded: [], fromCache: false }) });
          return;
        }
        if (body.op === 'graph.explore') {
          const seed = String((body.payload?.seeds as string[] | undefined)?.[0] ?? '');
          const root = seed === 'W9' ? mapAlt : mapSeed;
          const extraNodes = [
            { id: 'W5', openAlexId: 'W5', title: 'FlashAttention-2 Hardware Tiling', authors: ['Tri Dao'], firstAuthor: 'Tri Dao', lastAuthor: 'Tri Dao', year: 2023, citationCount: 1600, source: 'openalex', topic: 'Flash Attention', inLibrary: false },
            { id: 'W6', openAlexId: 'W6', title: 'Speculative Decoding Draft Trees', authors: ['Chen Li'], firstAuthor: 'Chen Li', lastAuthor: 'Chen Li', year: 2024, citationCount: 640, source: 'openalex', topic: 'Speculative Decoding', inLibrary: false },
            { id: 'W7', openAlexId: 'W7', title: 'Parallel Speculative Decoding Verification', authors: ['Mina Sun'], firstAuthor: 'Mina Sun', lastAuthor: 'Mina Sun', year: 2025, citationCount: 220, source: 'openalex', topic: 'Speculative Decoding', inLibrary: false },
            { id: 'W8', openAlexId: 'W8', title: 'Weight Quantization Kernels INT4', authors: ['Leo Wu'], firstAuthor: 'Leo Wu', lastAuthor: 'Leo Wu', year: 2024, citationCount: 380, source: 'openalex', topic: 'Weight Quantization', inLibrary: false },
            { id: 'W10', openAlexId: 'W10', title: 'SmoothQuant Weight Quantization Scaling', authors: ['Kai Tan'], firstAuthor: 'Kai Tan', lastAuthor: 'Kai Tan', year: 2023, citationCount: 950, source: 'openalex', topic: 'Weight Quantization', inLibrary: false }
          ];
          const extraEdges = [
            { source: 'W2', target: 'W5', kind: 'cites', weight: 1 }, { source: 'W6', target: 'W7', kind: 'cites', weight: 1 },
            { source: 'W8', target: 'W10', kind: 'cites', weight: 1 }, { source: 'W5', target: 'W6', kind: 'related', weight: 0.25 },
            { source: 'W7', target: 'W8', kind: 'related', weight: 0.2 }
          ];
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seeds: [root], nodes: [{ ...root, isSeed: true }, mapNbr, mapFar, ...extraNodes], edges: [{ source: root.id, target: 'W2', kind: 'cites', weight: 1 }, { source: 'W2', target: 'W3', kind: 'related', weight: 0.6 }, ...extraEdges], degraded: [], fromCache: false }) });
          return;
        }
        if (body.op === 'graph.savePaper') {
          saveCalls.push(body.payload ?? {});
          const p = (body.payload?.paper ?? {}) as { id?: string; title?: string };
          if (p.id === 'W2') {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ doc: { id: 'abs-w2', kind: 'abstract', title: p.title ?? 'FlashAttention' }, mode: 'abstract', fallback: 'abstract_only', attachPdfSuggested: true }) });
            return;
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ doc: { id: 'pdf-w4', kind: 'pdf', title: p.title ?? 'Lean4Agent' }, mode: 'oa-pdf' }) });
          return;
        }
        if (body.op === 'web.open') {
          webOpenCalls.push(body.payload ?? {});
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ doc: { id: 'pagedattention', kind: 'pdf', title: 'PagedAttention', defaultPage: 1 } }) });
          return;
        }
        if (body.op === 'deepSearch.run') {
          const cand1 = { ...mapNbr, matchScore: 91, rationale: 'Matches KV paging.', category: 'Serving', foundRound: 1 };
          const cand2 = { ...mapArxiv, matchScore: 88, rationale: 'Formal workflow verification.', category: 'Verification', foundRound: 1 };
          await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', result: { query: 'KV paging', overview: 'Overview [#1] [#2].', categories: ['Serving', 'Verification'], candidates: [cand1, cand2], roundsCompleted: 2, totalEvaluated: 10, saturationCurve: [{ round: 1, evaluated: 10, matched: 2, newMatches: 2 }], degraded: ['s2'], aborted: false } }) + '\n' });
          return;
        }
        await route.fallback();
      });

      await ws.locator('.cit-facets select[data-facet="section"]').selectOption('Methods');
      assert.equal(await ws.locator('.cit-doc-select').count(), 0);
      await ws.locator('.cit-wb-trigger').click();
      await ws.locator('.cit-wb-picker').waitFor({ state: 'visible' });
      assert.match(await ws.locator('.cit-wb-picker .pp-count').innerText(), /3 papers/);
      await ws.locator('.cit-wb-search').fill('Adaptive');
      assert.match(await ws.locator('.cit-wb-picker .pp-count').innerText(), /1 of 3/);
      await ws.locator(`.cit-wb-picker .pp-opt[data-doc-id="${localDocId}"]`).click();
      await ws.locator('.cit-card', { hasText: 'Paper B Support One' }).waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cit-card').count(), 2);
      assert.equal(await ws.locator('.cit-facets select[data-facet="section"]').inputValue(), '');

      await ws.locator('.cit-wb-trigger').click();
      await ws.locator('.cit-wb-search').fill('rate-limited');
      await ws.locator('.cit-wb-picker .pp-ext-note').waitFor({ state: 'visible' });
      assert.match(await ws.locator('.cit-wb-picker .pp-ext-note').innerText(), /External search unavailable/);
      await ws.locator('.cit-wb-search').fill('Attention');
      await ws.locator('.cit-wb-picker .pp-opt.is-external').waitFor({ state: 'visible' });
      assert.match(await ws.locator('.cit-wb-picker .pp-opt.is-external .pp-opt-meta').innerText(), /128k cited/);
      await ws.locator('.cit-wb-picker .pp-opt.is-external').click();
      await ws.locator('.cit-card', { hasText: 'BERT Pre-training' }).waitFor({ state: 'visible' });
      assert.match(await ws.locator('.cit-title').innerText(), /Attention Is All You Need/);
      assert.equal(await ws.locator('.cit-recent-chip[data-recent-key="arxiv:1706.03762"]').getAttribute('aria-pressed'), 'true');

      await ws.locator('.cit-wb-trigger').click();
      await ws.locator('.cit-wb-search').fill('10.1000/ext-direct');
      await page.keyboard.press('Enter');
      await ws.locator('.cit-card', { hasText: 'Followup on Direct DOI' }).waitFor({ state: 'visible' });
      assert.match(await ws.locator('.cit-title').innerText(), /Direct DOI Benchmark Paper/);
      assert.equal(await ws.locator('.cit-recent-chip[data-recent-key="doi:10.1000/ext-direct"]').getAttribute('aria-pressed'), 'true');

      await ws.locator('.cit-recent-chip[data-recent-key="arxiv:1706.03762"]').click();
      await ws.locator('.cit-card', { hasText: 'BERT Pre-training' }).waitFor({ state: 'visible' });
      assert.match(await ws.locator('.cit-title').innerText(), /Attention Is All You Need/);
      assert.match(await ws.locator('.cit-recent-chip[data-recent-key="arxiv:1706.03762"]').innerText(), /Attention Is All You Need[\s\S]*2017/);

      await ws.locator(`.cit-recent-chip[data-recent-key="doc:${localDocId}"]`).click();
      await ws.locator('.cit-card', { hasText: 'Paper B Support One' }).waitFor({ state: 'visible' });
      assert.equal(await ws.locator(`.cit-recent-chip[data-recent-key="doc:${localDocId}"]`).getAttribute('aria-pressed'), 'true');
      await ws.locator('.rw-nav-btn[data-view="deep-search"]').click();
      await ws.locator('.rw-nav-btn[data-view="citations"]').click();
      assert.match(await ws.locator('.cit-title').innerText(), /Adaptive Block Scheduling/);
      await ws.locator('.cit-wb-trigger').click();
      assert.match((await ws.locator('.cit-wb-picker .pp-current-btn').getAttribute('title')) ?? '', /PagedAttention/);
      await ws.locator('.cit-wb-picker .pp-current-btn').click();
      await ws.locator('.cit-title', { hasText: 'PagedAttention' }).waitFor({ state: 'visible' });
      await ws.locator('.cit-recent-chip[data-recent-key="arxiv:1706.03762"]').waitFor({ state: 'visible' });

      await ws.locator('.rw-collapse-btn').click(); await ws.waitFor({ state: 'hidden' });
      await page.locator('#notesTab').click(); await page.locator('#refsTab').click();
      const zeroPill = page.locator('.ref-cit-pill[data-stance="contrasting"].is-zero');
      await zeroPill.waitFor({ state: 'visible' });
      await zeroPill.click();
      await ws.locator('.cit-card').first().waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cit-card').count(), 5);

      summaryStale = true;
      await ws.locator('.rw-collapse-btn').click(); await ws.waitFor({ state: 'hidden' });
      await page.locator('#notesTab').click(); await page.locator('#refsTab').click();
      await page.locator('.ref-cit-pill[data-stance="contrasting"]:not(.is-zero)').click();
      await ws.locator('.cit-card').first().waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.cit-card').count(), 5);
      assert.match(await ws.locator('.cit-status').innerText(), /No Contrasting citations found — showing all 5/);

      await ws.locator('.rw-nav-btn[data-view="citation-map"]').click();
      await ws.locator('.cm-node[data-node-id="W2"]').waitFor({ state: 'visible' });
      assert.ok(resolveDocIds.includes('pagedattention'));
      assert.equal(await ws.locator('.cm-seed-select').count(), 0);
      assert.match(await ws.locator('.cm-seed-title').innerText(), /PagedAttention/);
      assert.match((await ws.locator('.cm-edge[data-kind="cites"]').first().getAttribute('marker-end')) ?? '', /^url\(#cm-arrow(?:-hi)?\)$/);
      assert.ok((await ws.locator('.cm-edge[data-kind="related"]').count()) >= 1);
      assert.ok((await ws.locator('.cm-halo').count()) >= 2);
      const chipCount = await ws.locator('.cm-cluster-chip').count();
      assert.ok(chipCount >= 4, `expected All + >=3 cluster chips, got ${chipCount}`);
      const chipOverflow = await ws.locator('.cm-cluster-chip').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).length);
      assert.equal(chipOverflow, 0);
      await ws.locator('.cm-row[data-node-id="W1"]').hover();
      await page.waitForFunction(() => Boolean(document.querySelector('.cm-node[data-node-id="W1"].is-highlighted') && document.querySelector('.cm-node[data-node-id="W2"].is-neighbor') && document.querySelector('.cm-node[data-node-id="W3"].is-dimmed')));
      assert.equal(await ws.locator('.cm-edge[data-kind="cites"]').first().getAttribute('marker-end'), 'url(#cm-arrow-hi)');
      await ws.locator('.cm-row[data-node-id="W3"]').hover();
      await page.waitForFunction(() => Boolean(document.querySelector('.cm-node[data-node-id="W1"].is-seed-path') && document.querySelector('.cm-node[data-node-id="W2"].is-seed-path') && document.querySelector('.cm-edge.is-seed-path')));
      const firstClusterChip = ws.locator('.cm-cluster-chip:not([data-cluster-id="all"])').first(), cid = (await firstClusterChip.getAttribute('data-cluster-id'))!;
      await ws.locator(`.cm-node:not([data-cluster-id="${cid}"])`).first().click();
      await ws.locator('.cm-detail').waitFor({ state: 'visible' });
      await firstClusterChip.click();
      assert.equal(await firstClusterChip.getAttribute('aria-pressed'), 'true');
      assert.ok(!(await ws.locator('.cm-detail').isVisible()) && (await ws.locator(`.cm-halo[data-cluster-id="${cid}"].is-active:not(.is-dimmed)`).count()) === 1 && (await ws.locator(`.cm-node[data-cluster-id="${cid}"].is-dimmed`).count()) === 0);
      assert.ok((await ws.locator('.cm-node.is-dimmed').count()) >= 1);
      assert.ok((await ws.locator('.cm-row:not([hidden])').count()) < 8);
      await ws.locator('.cm-cluster-chip[data-cluster-id="all"]').click();
      assert.equal(await ws.locator('.cm-row:not([hidden])').count(), 8);
      await ws.locator('.cm-zoom-btn[data-zoom-act="in"]').click();
      assert.ok(Number(await ws.locator('.cm-svg').getAttribute('data-zoom')) > 1.1);
      await ws.locator('.cm-zoom-btn[data-zoom-act="fit"]').click();
      assert.equal(await ws.locator('.cm-svg').getAttribute('data-zoom'), '1.00');
      await ws.locator('.cm-graph-bar').getByRole('button', { name: 'Timeline', exact: true }).click();
      assert.equal(await ws.locator('.cm-cluster-bar').isVisible(), false);
      assert.equal(await ws.locator('.cm-halo').count(), 0);
      await ws.locator('.cm-graph-bar').getByRole('button', { name: 'Network', exact: true }).click();
      await ws.locator('.cm-seed-change').click();
      await ws.locator('.cm-seed-picker').waitFor({ state: 'visible' });
      assert.match(await ws.locator('.cm-seed-picker .pp-count').innerText(), /3 papers/);
      await ws.locator('.cm-seed-search').fill('Adaptive');
      assert.match(await ws.locator('.cm-seed-picker .pp-count').innerText(), /1 of 3/);
      await ws.locator(`.cm-seed-opt[data-doc-id="${localDocId}"]`).click();
      await ws.locator('.cm-node[data-node-id="W9"]').waitFor({ state: 'visible' });
      assert.ok(resolveDocIds.includes(localDocId));

      await ws.locator('.rw-nav-btn[data-view="deep-search"]').click();
      await ws.locator('.ds-query-input').fill('KV paging');
      await ws.locator('.ds-skip-btn').click();
      await ws.locator('.ds-card').first().waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.ds-degraded').count(), 0);
      await ws.locator('.ds-degraded-info').click();
      await ws.locator('.ds-degraded-pop').waitFor({ state: 'visible' });
      assert.match(await ws.locator('.ds-degraded-text').innerText(), /429/);
      await ws.locator('.ds-degraded-settings').click();
      await page.locator('#settings-panel-academic').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#settingsArxivFormat').inputValue(), 'html');
      await page.locator('#settingsArxivFormat').selectOption('pdf');
      await page.locator('#dialog button[type="submit"]').click();
      await page.locator('#dialog').waitFor({ state: 'hidden' });

      const nonArxivCard = ws.locator('.ds-card[data-paper-id="W2"]'), arxivCard = ws.locator('.ds-card[data-paper-id="W4"]');
      assert.equal(await ws.locator('.ds-save-abs, .ds-save-pdf').count(), 0);
      assert.equal(await nonArxivCard.locator('.arxiv-fmt-seg').count(), 0);
      assert.equal(await arxivCard.locator('.arxiv-fmt-seg').count(), 1);
      assert.equal(await arxivCard.locator('.arxiv-fmt-btn[data-format="html"]').getAttribute('aria-pressed'), 'true');
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(60);
      const mobFmtBox = await arxivCard.locator('.arxiv-fmt-btn[data-format="pdf"]').boundingBox();
      assert.ok(mobFmtBox && mobFmtBox.width >= 43.5 && mobFmtBox.height >= 43.5, JSON.stringify(mobFmtBox));
      await page.setViewportSize({ width: 1440, height: 900 });
      await arxivCard.locator('.arxiv-fmt-btn[data-format="pdf"]').click();
      assert.equal(await arxivCard.locator('.arxiv-fmt-btn[data-format="pdf"]').getAttribute('aria-pressed'), 'true');
      await arxivCard.locator('.ds-import-btn').click();
      await arxivCard.locator('.ds-open-btn').waitFor({ state: 'visible' });
      assert.equal(saveCalls.at(-1)?.mode, 'auto');
      assert.equal(saveCalls.at(-1)?.arxivFormat, 'pdf');

      await nonArxivCard.locator('.ds-import-btn').click();
      await nonArxivCard.locator('.ds-attach-btn').waitFor({ state: 'visible' });
      assert.match(await page.locator('#toast').innerText(), /No public full text found/);

      await page.reload();
      await page.locator('.pdf-sheet').first().waitFor({ state: 'visible' });
      await page.locator('#library').click();
      await page.locator('#dialog').waitFor({ state: 'visible' });
      await page.locator('.reader-library button[aria-controls="library-url-form"]').click();
      await page.locator('#library-url').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.library-arxiv-fmt').isVisible(), false);
      await page.locator('#library-url').fill('2606.06523v3');
      await page.locator('.library-arxiv-fmt').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.library-arxiv-fmt .arxiv-fmt-btn[data-format="pdf"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#library-url').fill('https://arxiv.org/html/2606.06523v3');
      assert.equal(await page.locator('.library-arxiv-fmt .arxiv-fmt-btn[data-format="html"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#library-url-form button[type="submit"]').click();
      await page.locator('#dialog').waitFor({ state: 'hidden' });
      assert.deepEqual(webOpenCalls.at(-1), { url: 'https://arxiv.org/html/2606.06523v3', arxivFormat: 'html' });
      await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'settings.save', payload: { arxivFormat: 'html' } } });
      await page.unroute('**/api/paper-reader/action');
      const quantDoc = (await (await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'library.createAbstract', payload: { title: 'KV Cache Quantization for Long Contexts', authors: 'Hana Kim', year: '2025', abstract: 'Sub-4-bit KV cache quantization accelerates long-context inference.' } } })).json() as { doc: { id: string } }).doc.id;
      const clinDoc = (await (await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'library.createAbstract', payload: { title: 'Clinical Semaglutide Weight Outcomes', authors: 'Dr. Lee', year: '2024', abstract: 'Randomized placebo-controlled weight management study.' } } })).json() as { doc: { id: string } }).doc.id;
      await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'library.triage', payload: { docId: quantDoc, tags: ['quantization'] } } });
      await ctx.request.post(host.origin + '/api/paper-reader/action', { data: { op: 'library.triage', payload: { docId: clinDoc, tags: ['clinical'] } } });
      await page.route('**/api/paper-reader/action', async route => {
        if ((route.request().postDataJSON() as { op?: string }).op === 'review.rerank') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scores: [{ docId: localDocId, score: 97, rationale: 'Directly optimizes serving pipelines' }, { docId: quantDoc, score: 86, rationale: 'Quantizes KV cache' }] }) }); return; }
        await route.fallback();
      });
      await page.keyboard.press('Control+Shift+R'); await ws.waitFor({ state: 'visible' });
      await ws.locator('.rw-nav-btn[data-view="review-table"]').click(); await ws.locator('.rt-grid').waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.rt-bulk-bar').isVisible(), false);
      await ws.locator('.rt-topic-in').fill('sub-4-bit'); await ws.locator('.rt-rel-pill').first().waitFor({ state: 'visible' });
      assert.ok(await ws.locator('.rt-grid tbody tr').first().getAttribute('data-doc-id') === quantDoc && !(await ws.locator('.rt-include-top-btn').isVisible()));
      await ws.locator('.rt-topic-in').fill('KV cache quantization'); await ws.locator('.rt-rel-pill').first().waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.rt-grid tbody tr').first().getAttribute('data-doc-id'), quantDoc);
      assert.match(await ws.locator('.rt-seg-btn[data-scope="matches"]').innerText(), /Topic matches \(/);
      await ws.locator('.rt-seg-btn[data-scope="all"]').click(); assert.ok((await ws.locator('.rt-grid tbody tr').count()) >= 4);
      await ws.locator('.rt-rerank-btn').click(); await ws.locator('.rt-rel-pill[data-ai="true"]').first().waitFor({ state: 'visible' });
      assert.equal(await ws.locator('.rt-grid tbody tr').first().getAttribute('data-doc-id'), localDocId);
      await ws.locator('.rt-topic-in').fill(''); await ws.locator('.rt-tag-filter').selectOption('clinical');
      assert.equal(await ws.locator('.rt-grid tbody tr').count(), 1); await ws.locator('.rt-tag-filter').selectOption('');
      await ws.locator('.rt-step-btn[data-step="screening"]').click(); await ws.locator('.rt-srow').first().waitFor({ state: 'visible' });
      assert.ok(await ws.evaluate(() => { const c = document.querySelector('.rt-content')!, p = document.querySelector('.rt-pager')!; c.scrollTop = 300; return c.getBoundingClientRect().bottom <= p.getBoundingClientRect().top + 1; }));
      const sChecks = ws.locator('.rt-srow .rt-check');
      await sChecks.nth(0).click(); await sChecks.nth(2).click({ modifiers: ['Shift'] });
      await ws.locator('.rt-bulk-bar').waitFor({ state: 'visible' }); assert.equal(await ws.locator('.rt-bulk-count').innerText(), '3 selected');
      await ws.locator('.rt-bulk-clear').click(); assert.equal(await ws.locator('.rt-bulk-bar').isVisible(), false);
      await ws.locator(`.rt-srow[data-doc-id="${clinDoc}"] .rt-check`).click(); await ws.locator('.rt-tag-filter').selectOption('quantization');
      await ws.locator(`.rt-srow[data-doc-id="${quantDoc}"] .rt-check`).click({ modifiers: ['Shift'] });
      assert.equal(await ws.locator('.rt-bulk-count').innerText(), '2 selected'); await ws.locator('.rt-bulk-clear').click(); await ws.locator('.rt-tag-filter').selectOption('');
      await ws.locator(`.rt-srow[data-doc-id="${clinDoc}"] .rt-check`).click(); await ws.locator('.rt-bulk-exc').click();
      await ws.locator(`.rt-part[data-part="excluded"] .rt-srow[data-doc-id="${clinDoc}"]`).waitFor({ state: 'visible' });
      await ws.locator('.rt-step-btn[data-step="extraction"]').click(); await ws.locator('.rt-grid').waitFor({ state: 'visible' });
      assert.ok(await ws.locator('.rt-seg-btn[data-extract-scope="included"]').getAttribute('aria-pressed') === 'true' && (await ws.locator(`.rt-grid tbody tr[data-doc-id="${clinDoc}"]`).count()) === 0);
      await ws.locator('.rt-seg-btn[data-extract-scope="all"]').click(); assert.equal(await ws.locator(`.rt-grid tbody tr[data-doc-id="${clinDoc}"]`).count(), 1);
      await ws.locator('.rt-seg-btn[data-extract-scope="included"]').click(); await ws.locator(`.rt-grid tbody tr[data-doc-id="${quantDoc}"] .rt-check`).click();
      assert.ok((await ws.locator('.rt-bulk-export').innerText()) === 'Export MD (1)' && (await ws.locator('.rt-bulk-export-csv').innerText()) === 'Export CSV (1)');
      const [selMd] = await Promise.all([page.waitForEvent('download'), ws.locator('.rt-bulk-export').click()]); assert.match(selMd.suggestedFilename(), /\.md$/);
      await ws.locator('.rt-bulk-exclude').click(); await page.waitForFunction(id => !document.querySelector(`.rt-grid tbody tr[data-doc-id="${id}"]`), quantDoc);
      await ws.locator('.rt-topic-in').fill('sub-4-bit'); await ws.locator('.rt-seg-btn[data-scope="matches"]').click();
      assert.equal(await ws.locator('.rt-sel-matched-btn').isVisible(), false);
      await ws.locator('.rt-export-btn').click(); await page.locator('#toast', { hasText: 'No papers match' }).waitFor({ state: 'visible' });
      await ws.locator('.rt-topic-in').fill('');
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(80);
      assert.ok(await ws.evaluate(() => { const b = document.querySelector('.rt-body-scroll')!, p = document.querySelector('.rt-pager')!, cards = [...document.querySelectorAll('.rt-mcard')]; b.scrollTop = 200; return b.getBoundingClientRect().top <= 150 && document.documentElement.scrollWidth <= innerWidth + 1 && cards.every(c => c.getBoundingClientRect().bottom <= p.getBoundingClientRect().top + 1); }));
      await assertMobilePanelTargets(page, '#researchWorkspace');
      await ctx.close();

      const zhCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
      const zhPage = await openReaderPage(zhCtx, host, '?doc=pagedattention&page=5', { tag: 'cit-zh', scope: { allowZotero503: true }, pageErrors, consoleErrors });
      await zhPage.route('**/api/paper-reader/action', async route => {
        const body = route.request().postDataJSON() as { op?: string };
        if (body.op === 'citations.analyze') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ target, direction: 'cited_by', tallies: calcTallies(citedStmts), statements: citedStmts, sciteUrl: target.sciteUrl, degraded: [], fromCache: false, offline: true }) }); return; }
        if (body.op === 'graph.search') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ papers: [], degraded: ['openalex'] }) }); return; }
        await route.fallback();
      });
      await zhPage.locator('#mobileRail').click(); await zhPage.locator('#refsTab').click();
      await zhPage.locator('.ref-cit-all').click(); await zhPage.locator('.cit-card').first().waitFor({ state: 'visible' });
      await zhPage.locator('.cit-wb-trigger').click();
      await zhPage.locator('.cit-wb-search').fill('rate-limited');
      await zhPage.locator('.cit-wb-picker .pp-ext-note').waitFor({ state: 'visible' });
      assert.equal(await zhPage.locator('.cit-wb-picker .pp-current-btn').innerText(), '当前精读文献');
      const zhItems = await collectChromeStrings(zhPage, '.cit-title, .cit-byline, .cit-wb-title, .cit-recent-chip, .pp-current-btn, .cit-card-title, .cit-meta-text, .cit-ctx-text, .cit-rationale');
      assertNoZhEnglishLeaks(zhItems, 'zh-CN Citations View');
      assert.equal(zhItems.some(s => /智能引用大卡|摘要存根|纳排筛选/.test(s.text)), false);
      assert.deepEqual(await zhPage.locator('.cit-facets select[data-facet="section"] option').allInnerTexts(), ['全部', 'Introduction', 'Methods', 'Results', 'Discussion', '未知']);
      await zhPage.locator('.rw-nav-btn[data-view="review-table"]').click(); await zhPage.locator('.rt-grid').waitFor({ state: 'visible' });
      await zhPage.locator('.rt-topic-in').fill('PagedAttention'); await zhPage.locator('.rt-grid tbody .rt-check').first().click();
      const zhRt = await collectChromeStrings(zhPage, '.rt-paper-title, .rt-paper-meta, .rt-cell-val, .rt-mcard-v, .rt-col-label, .rt-tag-filter option, .question-model-trigger');
      assertNoZhEnglishLeaks(zhRt, 'zh-CN Review Table Triage', ['pilot', 'screening', 'extraction', 'evidence']);
      await zhCtx.close();
      assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
    } finally { await browser.close(); }
  }, {}, { modelFixture: true });
}

run().catch(error => { console.error(error); process.exit(1); });
