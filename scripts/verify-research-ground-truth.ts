import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setGlobalProxyFromEnv } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exploreCitationGraph, resolveAcademicPaper, saveGraphPaper } from '../src/server/academic-graph.js';
import { classifyCitationContexts } from '../src/server/citation-stance.js';
import { queryFieldTrends, queryTrendPapers } from '../src/server/field-trends.js';
import { Library } from '../src/server/library.js';
import { extractDocumentPages, extractPdfPages } from '../src/server/pdf-text.js';
import { publicResource } from '../src/server/public-resource.js';
import { ReaderModel } from '../src/server/reader-model.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { ensureResearchSchema, getDocPages, replaceDocPages, saveTopic, searchDocPagesFts, setPaperCard } from '../src/server/research-store.js';
import { createServices } from '../src/server/services.js';
import { REVIEW_PRESETS, verifyQuote } from '../src/shared/review-types.js';
import { CITATION_STANCE_GOLD } from './citation-stance-gold.js';

if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) setGlobalProxyFromEnv();
const onlyArg = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const shouldRun = (phase: string) => !onlyArg || onlyArg === phase;

function loadDshWebLlmConfig(): { baseUrl: string; model: string; apiKey: string; extraHeaders: Record<string, string> } {
  const dshDir = path.join(homedir(), '.dsh'), patchPath = path.join(dshDir, 'profiles', 'web', 'cordis.patch.yml'), credsPath = path.join(dshDir, '.credentials.yaml');
  if (!existsSync(patchPath)) throw new Error(`Missing DSH profile config at ${patchPath}`);
  const yml = readFileSync(patchPath, 'utf8'), creds = existsSync(credsPath) ? readFileSync(credsPath, 'utf8') : '';
  for (const [provider, preferred] of [['internal', ['deepseek-v4-flash', 'qwen3.8']], ['onprem', ['gemma4-31b', 'qwen3.8-27B']]] as const) {
    const block = yml.match(new RegExp(`^\\s{6}${provider}:\\n([\\s\\S]*?)(?=^\\s{6}\\w+:|^\\-\\s|(?![\\s\\S]))`, 'm'))?.[1];
    if (!block) continue;
    const baseUrl = block.match(/baseURL:\s*(\S+)/)?.[1]?.trim() ?? '', keyEnv = block.match(/apiKeyEnv:\s*(\S+)/)?.[1]?.trim() ?? '';
    const apiKey = (process.env[keyEnv] ?? creds.match(new RegExp(`${keyEnv}:\\s*['"]?([^'"\\n\\r]+)`))?.[1] ?? '').trim();
    const model = preferred.find(m => block.includes(m)) ?? (block.match(/-\s+id:\s*(\S+)/)?.[1] ?? '');
    const apiKeyHdr = block.match(/^\s{10}api-key:\s*(\S+)/m)?.[1]?.trim();
    if (baseUrl && apiKey && model) return { baseUrl, model, apiKey, extraHeaders: apiKeyHdr ? { 'api-key': apiKeyHdr } : {} };
  }
  throw new Error('DSH web LLM provider config incomplete in ~/.dsh/profiles/web/cordis.patch.yml');
}

const db = new DatabaseSync(':memory:');
try {
  ensureResearchSchema(db);
  if (shouldRun('1')) {
    const pages = await extractPdfPages(await readFile(path.resolve('public/assets/pagedattention.pdf')));
    assert.equal(pages.length, 16, `expected 16 pages, got ${pages.length}`);
    replaceDocPages(db, 'pagedattention', pages);
    assert.equal(getDocPages(db, 'pagedattention').length, 16);
    const blockHits = searchDocPagesFts(db, '"block table"'), kvHits = searchDocPagesFts(db, 'KV cache');
    assert.ok(blockHits.some(h => h.docId === 'pagedattention' && h.page === 6), 'missing "block table" hit on page 6');
    assert.ok(kvHits.some(h => h.docId === 'pagedattention' && h.page === 1), 'missing "KV cache" hit on page 1');
    console.log(`PASS PR-1 ground-truth: pagedattention.pdf (${pages.length} pages) | "block table" -> p.${blockHits[0].page} (${blockHits.length} hits) | "KV cache" -> p.${kvHits[0].page} (${kvHits.length} hits)`);
  }

  const liveCtx = { withDb: <T>(_: boolean, run: (d: DatabaseSync) => T) => run(db) };
  if (shouldRun('2')) {
    const earlier = await exploreCitationGraph({ seeds: ['arXiv:2309.06180'], direction: 'earlier', limit: 35 }, liveCtx);
    const rootHit = earlier.nodes.find(n => !n.isSeed && /attention is all you need|flashattention|orca/i.test(n.title));
    assert.ok(rootHit, `PagedAttention Earlier missed foundational roots (got ${earlier.nodes.length} nodes)`);
    const citing = (await exploreCitationGraph({ seeds: ['arXiv:2309.06180'], direction: 'later', limit: 25 }, liveCtx)).nodes.filter(n => !n.isSeed);
    assert.ok(citing.length >= 5 && citing.every(n => !n.year || n.year >= 2023), `invalid Later citing papers (${citing.length})`);
    console.log(`PASS PR-2 CS/AI live ground-truth: PagedAttention Earlier=${earlier.nodes.length - earlier.seeds.length} (root: "${rootHit.title}", ${rootHit.year}) | Later=${citing.length} (top: "${citing[0].title}", ${citing[0].year}, ${citing[0].citationCount} cites)`);

    const nejm = await resolveAcademicPaper('10.1056/NEJMoa2032183', liveCtx);
    assert.ok(nejm.paper && nejm.paper.year === 2021 && (nejm.paper.abstract?.length ?? 0) > 100, 'invalid NEJM 10.1056/NEJMoa2032183 resolution');
    const clinical = (await exploreCitationGraph({ seeds: ['10.1056/NEJMoa2032183'], direction: 'later', limit: 25 }, liveCtx)).nodes.filter(n => !n.isSeed);
    assert.ok(clinical.length >= 5, `expected >=5 linked clinical papers, got ${clinical.length}`);
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'reader-gt-pr2-'));
    try {
      const store = new ReaderStore(tempRoot), library = new Library(tempRoot, publicResource, id => store.deleteDocument(id));
      const saved = await saveGraphPaper({ paper: nejm.paper, mode: 'abstract', topicTag: 'glp-1' }, {
        library, store, readResource: publicResource,
        indexDoc: async doc => { const p = await extractDocumentPages(doc); return p.length ? store.withDb(true, d => replaceDocPages(d, doc.id, p)) : 0; }
      });
      assert.ok(saved.doc.kind === 'abstract' && saved.doc.doi?.toLowerCase() === '10.1056/nejmoa2032183' && saved.doc.meta?.tags.includes('glp-1'));
      console.log(`PASS PR-2 Medicine live ground-truth: NEJM ${nejm.paper.year} abstract=${nejm.paper.abstract!.length} chars | linked=${clinical.length} (top: "${clinical[0].title}", ${clinical[0].year}) | saved=${saved.doc.id} (${saved.doc.kind})`);
    } finally { await rm(tempRoot, { recursive: true, force: true }); }
  }

  if (shouldRun('3a')) {
    for (const fieldQuery of ['LLM inference', 'GLP-1']) {
      const trends = await queryFieldTrends({ query: fieldQuery, source: 'openalex', windowYears: 5, topicLimit: 3 }, liveCtx);
      assert.ok(trends.topics.length >= 2, `expected >=2 topics for "${fieldQuery}", got ${trends.topics.length}`);
      let verifiedCells = 0;
      for (const topic of trends.topics) {
        const rawUrl = `https://api.openalex.org/works?search=${encodeURIComponent(fieldQuery)}&filter=primary_topic.id:${topic.topicId},publication_year:${trends.years[0]}-${trends.ytdYear}&group_by=publication_year`;
        const rawRes = await fetch(rawUrl, { headers: { 'User-Agent': 'DSH-Paper-Reader/0.1 (ground-truth)' } });
        assert.equal(rawRes.status, 200, `raw OpenAlex check failed (${rawRes.status}) for ${fieldQuery}/${topic.topicId}`);
        const rawJson = await rawRes.json() as { group_by?: { key?: string; count?: number }[] };
        const rawMap = new Map<number, number>((rawJson.group_by ?? []).map(g => [Number(g.key), Number(g.count ?? 0)]));
        for (const cell of topic.cells) {
          assert.equal(cell.volume, rawMap.get(cell.year) ?? 0, `cell mismatch for "${fieldQuery}" ${topic.topicId}/${cell.year}`);
          verifiedCells++;
        }
      }
      const targetTopic = trends.topics.find(t => t.cells.some(c => !c.isYtd && c.volume > 0)) ?? trends.topics[0];
      const targetCell = targetTopic.cells.find(c => !c.isYtd && c.volume > 0) ?? targetTopic.cells.find(c => c.volume > 0)!;
      const drill = await queryTrendPapers({ query: fieldQuery, topicId: targetTopic.topicId, topicName: targetTopic.topicName, year: targetCell.year, source: 'openalex', sort: 'representative', limit: 5 }, liveCtx);
      assert.ok(drill.papers.length >= 1, `expected drilldown papers for "${fieldQuery}" ${targetTopic.topicId}/${targetCell.year}`);
      for (const p of drill.papers) {
        assert.equal(p.year, targetCell.year, `paper year mismatch for ${p.id}`);
        assert.equal(p.primaryTopicId, targetTopic.topicId, `paper primary_topic mismatch for ${p.id}`);
      }
      console.log(`PASS PR-3a live ground-truth ("${fieldQuery}"): ${trends.topics.length} topics, ${verifiedCells}/${verifiedCells} cells exact match | drilldown ${targetTopic.topicId}/${targetCell.year} -> ${drill.papers.length} papers (top: "${drill.papers[0].title}")`);
    }
  }

  const openLive = async (prefix: string) => {
    const llm = loadDshWebLlmConfig(), tempRoot = await mkdtemp(path.join(tmpdir(), prefix));
    const store = new ReaderStore(tempRoot), library = new Library(tempRoot, publicResource, id => store.deleteDocument(id));
    const fetchImpl: typeof fetch = (u, init) => {
      const urlStr = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
      if (!urlStr.startsWith(llm.baseUrl)) return fetch(u, init);
      const h = new Headers(init?.headers); for (const [k, v] of Object.entries(llm.extraHeaders)) h.set(k, v); return fetch(u, { ...init, headers: h });
    };
    const model = new ReaderModel(undefined, fetchImpl), act = createServices({ root: tempRoot, store, library, fetchImpl });
    await act('settings.save', { baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey });
    return { llm, tempRoot, store, library, model, act };
  };

  if (shouldRun('3b')) {
    const { llm, tempRoot, store, act } = await openLive('reader-gt-pr3b-');
    try {
      assert.equal((await act('pages.index', { docId: 'pagedattention', force: true })).pages, 16);
      const flash = await act('library.createAbstract', {
        title: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness', authors: 'Dao et al.', venue: 'NeurIPS 2022', year: '2022', url: 'https://arxiv.org/abs/2205.14135',
        abstract: 'Transformers are slow and memory-hungry on long sequences due to quadratic self-attention complexity. FlashAttention is an IO-aware exact attention algorithm using tiling between GPU HBM and on-chip SRAM for faster wall-clock speed and linear memory scaling.'
      });
      const semaglutide = await act('library.createAbstract', {
        title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity', authors: 'Wilding et al.', venue: 'NEJM', year: '2021', doi: '10.1056/NEJMoa2032183',
        abstract: 'In a double-blind trial of 1961 adults with overweight or obesity without diabetes, once-weekly 2.4 mg semaglutide produced a mean body weight reduction of 14.9% versus 2.4% with placebo over 68 weeks, with mostly mild-to-moderate transient gastrointestinal adverse events.'
      });
      const docIds = ['pagedattention', flash.doc.id, semaglutide.doc.id];
      const firstCards = await act('library.cards', { docIds });
      assert.equal(firstCards.cards.length, 3); assert.equal(firstCards.generatedCount, 3);
      assert.equal(firstCards.cards.find(c => c.docId === 'pagedattention')?.sourceKind, 'pdf');
      assert.equal(firstCards.cards.find(c => c.docId === flash.doc.id)?.sourceKind, 'abstract');
      assert.equal((await act('library.cards', { docIds })).generatedCount, 0);
      const pageMap = new Map(store.withDb(false, d => getDocPages(d, 'pagedattention')).map(p => [p.page, p.text.replace(/\s+/g, ' ').trim()]));
      const verifyResult = (label: string, res: Awaited<ReturnType<typeof act<'library.chat'>>>) => {
        assert.ok(res.answer.length >= 80 && res.usedDocIds.length === 3 && res.usedAbstractOnlyIds.length === 2, `${label}: invalid answer/scope`);
        const pdfCites = res.citations.filter(c => c.docId === 'pagedattention' && c.kind === 'pdf');
        assert.ok(pdfCites.length >= 1, `${label}: missing PagedAttention citation (${res.answer.slice(0, 220)})`);
        for (const c of pdfCites) {
          assert.ok(typeof c.page === 'number' && c.page >= 1 && c.page <= 16 && (pageMap.get(c.page) ?? '').includes(c.quote), `${label}: unverified p.${c.page}`);
        }
        return pdfCites;
      };
      const chatRes = await act('library.chat', { docIds, question: 'How does PagedAttention manage KV cache memory fragmentation using virtual memory blocks compared with FlashAttention IO-aware tiling, and what comes only from abstracts? Cite exact page numbers.' });
      const chatCites = verifyResult('library-chat', chatRes);
      const openRes = await act('library.chat', { docIds, preset: 'limitations_open_problems' });
      const openCites = verifyResult('open-problems', openRes);
      console.log(`PASS PR-3b live ground-truth (${llm.model}): 3 cards cached | chat=${chatRes.answer.length} chars (${chatCites.map(c => `${c.authorLabel}, ${c.year}, p.${c.page}`).join('; ')}) | open_problems=${openRes.answer.length} chars (${openCites.map(c => `${c.authorLabel}, ${c.year}, p.${c.page}`).join('; ')})`);
    } finally { await rm(tempRoot, { recursive: true, force: true }); }
  }

  if (shouldRun('4')) {
    const { llm, tempRoot, store, library, act } = await openLive('reader-gt-pr4-');
    const miniPdf = (lines: string[]): Buffer => {
      const stream = 'BT /F1 11 Tf 48 740 Td 16 TL ' + lines.map((l, i) => (i ? 'T* ' : '') + `(${l.replace(/[\\()]/g, '\\$&')}) Tj`).join(' ') + ' ET';
      const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
      let pdf = '%PDF-1.7\n';
      const offs = objs.map((o, i) => { const p = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return p; });
      return Buffer.from(pdf + `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(p => String(p).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(pdf)}\n%%EOF\n`);
    };
    try {
      assert.equal((await act('pages.index', { docId: 'pagedattention', force: true })).pages, 16);
      const csPages = store.withDb(false, d => getDocPages(d, 'pagedattention'));
      await act('review.saveTable', { id: 'cs', preset: 'cs_ai', columns: REVIEW_PRESETS.cs_ai.columns.filter(c => ['method', 'key_metrics', 'limitations'].includes(c.id)) });
      const csRes = await act('review.extract', { tableId: 'cs', mode: 'all', docIds: ['pagedattention'] });
      const csVer = csRes.cells.filter(c => c.verified && typeof c.page === 'number' && c.page >= 1 && c.page <= 16 && verifyQuote({ quote: c.quote, page: c.page, sourceKind: 'pdf', pages: csPages }).verified);
      assert.ok(csRes.processedDocs === 1 && csRes.cells.length === 3 && csRes.cells.every(c => c.status === 'done' && c.value.length > 3 && c.sourceKind === 'pdf') && csVer.length >= 1);

      const stub = await act('library.createAbstract', {
        title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity', authors: 'Wilding et al.', venue: 'NEJM', year: '2021', doi: '10.1056/NEJMoa2032183',
        abstract: 'In a double-blind trial, we enrolled 1961 adults with a body-mass index of 30 or greater (or >=27 with weight-related coexisting conditions) who did not have diabetes, and randomly assigned them in a 2:1 ratio to 68 weeks of treatment with once-weekly subcutaneous semaglutide at a dose of 2.4 mg or placebo, plus lifestyle intervention. The mean change in body weight from baseline to week 68 was -14.9% in the semaglutide group as compared with -2.4% with placebo.'
      });
      await act('review.saveTable', { id: 'med', preset: 'pico', columns: REVIEW_PRESETS.pico.columns.filter(c => ['population', 'intervention', 'outcome'].includes(c.id)) });
      const medAbs = await act('review.extract', { tableId: 'med', mode: 'all', docIds: [stub.doc.id] });
      assert.ok(medAbs.cells.length === 3 && medAbs.cells.every(c => c.sourceKind === 'abstract' && c.page === null && c.value.length > 3) && medAbs.cells.some(c => c.verified));
      await act('review.setCell', { tableId: 'med', docId: stub.doc.id, colId: 'population', value: 'LOCKED: 1961 adults without diabetes (STEP 1)', reasoning: 'Manual lock' });
      const attached = await library.attachPdf(stub.doc.id, miniPdf([
        'STEP 1 Randomized Double-Blind Trial (NEJMoa2032183): 1961 adults without diabetes were randomized 2:1.',
        'Intervention: Once-weekly subcutaneous semaglutide 2.4 mg versus placebo for 68 weeks plus lifestyle intervention.',
        'Outcome: Mean body weight change at week 68 was -14.9% with semaglutide compared with -2.4% with placebo.'
      ]));
      store.withDb(true, d => replaceDocPages(d, attached.doc.id, attached.pages));
      assert.equal((await act('review.extract', { tableId: 'med', mode: 'reextract', docId: stub.doc.id })).processedDocs, 1);
      const medAll = (await act('review.get', { tableId: 'med' })).cells.filter(c => c.docId === stub.doc.id);
      const pop = medAll.find(c => c.colId === 'population')!, intv = medAll.find(c => c.colId === 'intervention')!, outc = medAll.find(c => c.colId === 'outcome')!;
      assert.equal(pop.value, 'LOCKED: 1961 adults without diabetes (STEP 1)'); assert.equal(pop.manualOverride, true);
      assert.equal(intv.sourceKind, 'pdf'); assert.equal(outc.sourceKind, 'pdf');
      console.log(`PASS PR-4 live ground-truth (${llm.model}): PagedAttention verified=${csVer.length}/3 (${csVer.map(c => `${c.colId}:p.${c.page}`).join(', ')}) | NEJMoa2032183 abstract verified=${medAbs.cells.filter(c => c.verified).length}/3 -> Attach PDF reextract upgraded intervention/outcome to pdf while population manualOverride stayed locked`);
    } finally { await rm(tempRoot, { recursive: true, force: true }); }
  }

  if (shouldRun('5')) {
    const { llm, tempRoot, act } = await openLive('reader-gt-pr5-');
    try {
      const csQuery = 'eliminating GPU KV-cache memory fragmentation in LLM serving via OS virtual memory paging';
      const medQuery = 'once-weekly GLP-1 receptor agonist subcutaneous treatment for weight reduction in adults with obesity without diabetes';
      const clarified = await act('deepSearch.clarify', { query: csQuery });
      assert.ok(clarified.questions.length >= 2 && clarified.questions.length <= 4, `expected 2-4 clarify questions, got ${clarified.questions.length}`);
      const csRes = await act('deepSearch.run', { query: csQuery, rounds: 2, maxResults: 20 });
      const pagedHit = csRes.candidates.find(c => c.arxivId?.startsWith('2309.06180') || /pagedattention|efficient memory management for large language model serving/i.test(c.title));
      assert.ok(pagedHit, `CS/AI non-keyword deep search missed PagedAttention (got ${csRes.candidates.length} candidates; degraded=${csRes.degraded.join(',')}; top=${csRes.candidates.slice(0, 5).map(c => c.title).join(' | ')})`);
      assert.ok(csRes.candidates.length >= 2 && csRes.overview.length >= 40, `CS/AI deep search returned too few results (${csRes.candidates.length})`);
      const medRes = await act('deepSearch.run', { query: medQuery, rounds: 2, maxResults: 20 });
      const medHits = medRes.candidates.filter(c => /semaglutide|tirzepatide|glp-1|incretin|weight|obesity/i.test(c.title + ' ' + (c.abstract ?? '')));
      assert.ok(medHits.length >= 2 && medRes.overview.length >= 40, `Medicine non-keyword deep search returned insufficient clinical literature (matched=${medHits.length}, degraded=${medRes.degraded.join(',')})`);
      console.log(`PASS PR-5 live ground-truth (${llm.model}): clarify=${clarified.questions.length}q | CS/AI hit "${pagedHit.title}" (score=${pagedHit.matchScore}, round=${pagedHit.foundRound}, total=${csRes.candidates.length}, degraded=[${csRes.degraded.join(',')}]) | Med hits=${medHits.length}/${medRes.candidates.length} (top: "${medHits[0].title}", score=${medHits[0].matchScore}, degraded=[${medRes.degraded.join(',')}])`);
    } finally { await rm(tempRoot, { recursive: true, force: true }); }
  }

  if (shouldRun('6')) {
    const { llm, tempRoot, store, model, act } = await openLive('reader-gt-pr6-');
    try {
      const goldMap = await classifyCitationContexts({ store, model }, CITATION_STANCE_GOLD);
      const misses = CITATION_STANCE_GOLD.filter(g => goldMap.get(g.id)?.stance !== g.expected).map(g => `${g.id}:${g.expected}->${goldMap.get(g.id)?.stance ?? 'none'}`);
      const correct = CITATION_STANCE_GOLD.length - misses.length, macroAcc = correct / CITATION_STANCE_GOLD.length;
      const conCases = CITATION_STANCE_GOLD.filter(g => g.expected === 'contrasting');
      const conHits = conCases.filter(g => goldMap.get(g.id)?.stance === 'contrasting').length, conRecall = conHits / conCases.length;
      assert.ok(macroAcc >= 0.85, `gold macro accuracy ${(macroAcc * 100).toFixed(1)}% < 85% (${correct}/${CITATION_STANCE_GOLD.length}; misses: ${misses.join(', ')})`);
      assert.ok(conRecall >= 0.8, `contrasting recall ${(conRecall * 100).toFixed(1)}% < 80% (${conHits}/${conCases.length}; misses: ${misses.join(', ')})`);
      const paged = await act('citations.analyze', { query: 'arXiv:2309.06180', limit: 20 });
      const pagedClassified = paged.statements.filter(s => s.context.length >= 20 && s.stance !== 'unclassified');
      assert.ok(paged.sciteUrl.startsWith('https://scite.ai/reports/'), `invalid PagedAttention sciteUrl: ${paged.sciteUrl}`);
      assert.ok(pagedClassified.length >= 1, `PagedAttention live citations returned 0 classified contexts (total=${paged.statements.length}, degraded=[${paged.degraded.join(',')}])`);
      const nejm = await act('citations.analyze', { doi: '10.1056/NEJMoa2032183', limit: 20 });
      const nejmClassified = nejm.statements.filter(s => s.context.length >= 20 && s.stance !== 'unclassified');
      assert.equal(nejm.sciteUrl, 'https://scite.ai/reports/10.1056%2FNEJMoa2032183');
      assert.ok(nejmClassified.length >= 1, `NEJMoa2032183 live citations returned 0 classified contexts (total=${nejm.statements.length}, degraded=[${nejm.degraded.join(',')}])`);
      console.log(`PASS PR-6 live ground-truth (${llm.model}): gold=${correct}/${CITATION_STANCE_GOLD.length} (${(macroAcc * 100).toFixed(1)}%), contrasting=${conHits}/${conCases.length} (${(conRecall * 100).toFixed(1)}%)${misses.length ? ` [misses: ${misses.join(', ')}]` : ''}`);
      console.log(`  PagedAttention: ${paged.tallies.citingPapers} papers / ${paged.tallies.citationStatements} stmts (sup=${paged.tallies.supporting}, ext=${paged.tallies.extending}, con=${paged.tallies.contrasting}, men=${paged.tallies.mentioning}, unc=${paged.tallies.unclassified}) | scite=${paged.sciteUrl} | degraded=[${paged.degraded.join(',')}]`);
      console.log(`  NEJMoa2032183: ${nejm.tallies.citingPapers} papers / ${nejm.tallies.citationStatements} stmts (sup=${nejm.tallies.supporting}, ext=${nejm.tallies.extending}, con=${nejm.tallies.contrasting}, men=${nejm.tallies.mentioning}, unc=${nejm.tallies.unclassified}) | scite=${nejm.sciteUrl} | degraded=[${nejm.degraded.join(',')}]`);
    } finally { await rm(tempRoot, { recursive: true, force: true }); }
  }

  if (shouldRun('7')) {
    const dshBin = [process.env.DSH_ENTRY, path.resolve(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/lib/bin.js'), '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'].find((f): f is string => Boolean(f && existsSync(f)));
    assert.ok(dshBin, 'Installed DSH binary not found');
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'reader-gt-pr7-')), readerHome = path.join(tempRoot, 'reader'), port = 29824;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const store = new ReaderStore(readerHome), library = new Library(readerHome, publicResource, id => store.deleteDocument(id));
      const pagedPages = await extractPdfPages(await readFile(path.resolve('public/assets/pagedattention.pdf')));
      store.updateDocTriage({ docId: 'pagedattention', status: 'reading', starred: true, tags: ['llm-serving'] });
      const citing = await library.createAbstract({
        title: 'SGLang RadixAttention Follow-up', authors: 'Zheng et al.', venue: 'NeurIPS 2024', year: '2024', doi: '10.1000/sglang-smoke',
        abstract: 'Extending PagedAttention (arXiv:2309.06180), which manages KV cache memory via block tables, we introduce radix tree prefix sharing.'
      });
      store.withDb(true, d => {
        replaceDocPages(d, 'pagedattention', pagedPages);
        replaceDocPages(d, citing.id, [{ page: 1, text: citing.abstract ?? '' }]);
        saveTopic(d, { id: 'llm-serving', name: 'LLM Serving', tag: 'llm-serving', description: 'KV cache inference' });
        setPaperCard(d, { docId: 'pagedattention', sourceKind: 'pdf', problem: 'KV cache fragmentation', method: 'Virtual memory block table', findings: 'Higher serving throughput', limitations: 'Block granularity trade-off', futureWork: 'Disaggregated serving', sourceHash: 'smoke', updatedAt: Date.now() });
      });
      const probePath = path.join(tempRoot, 'probe.mjs'), patchPath = path.join(tempRoot, 'probe.patch.yml');
      const probeCode = [
        "export const name = 'paper-reader-tool-probe'; export const inject = ['tools', 'connection'];",
        "export function apply(ctx) {",
        "  ctx.connection.fetch.register({ path: '/api/paper-reader-tool-probe', methods: ['GET'], requestBody: 'buffered', async fetch(req) {",
        "    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('paper_reader_')).sort();",
        "    const calls = [",
        "      { id: 'c1', name: 'paper_reader_search', arguments: JSON.stringify({ query: 'KV cache', limit: 5 }) },",
        "      { id: 'c2', name: 'paper_reader_topic_summary', arguments: JSON.stringify({ topic: 'LLM Serving' }) },",
        "      { id: 'c3', name: 'paper_reader_citation_stance', arguments: JSON.stringify({ docId: 'pagedattention', direction: 'cited_by' }) },",
        "      { id: 'c4', name: 'paper_reader_field_trends', arguments: JSON.stringify({ query: 'GLP-1', windowYears: 3, metric: 'volume', sources: ['europepmc'] }) },",
        "      { id: 'c5', name: 'paper_reader_search', arguments: JSON.stringify({ query: '', extra: 1 }) }",
        "    ];",
        "    const batch = await ctx.tools.execute({ calls, signal: req.signal });",
        "    return Response.json({ names, results: batch.results.map(r => ({ callId: r.callId, isError: r.result.isError, value: r.result.value, error: r.result.error?.message })) });",
        "  } });",
        "}"
      ].join('\n');
      await writeFile(probePath, probeCode);
      await writeFile(patchPath, JSON.stringify([{ insert: [{ id: 'paper-reader-tool-probe', name: probePath }] }]));
      const webPkgPath = path.join(homedir(), '.dsh', 'profiles', 'web', 'package.json');
      const hasLinkedPlugin = existsSync(webPkgPath) && readFileSync(webPkgPath, 'utf8').includes('"dsh-paper-reader"');
      const patchArgs = [...(hasLinkedPlugin ? [] : ['--patch', path.resolve('paper-reader.patch.yml')]), '--patch', patchPath];
      child = spawn(process.execPath, [dshBin, 'web', ...patchArgs, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
        cwd: process.cwd(), env: { ...process.env, PAPER_READER_HOME: readerHome }, windowsHide: true
      });
      const authUrl = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`DSH :${port} startup timed out: ${buf.slice(-600)}`)), 45_000);
        const onData = (chunk: Buffer) => { buf = (buf + chunk.toString('utf8')).slice(-16_384); const m = /dsh web: (https?:\/\/[^\s\x1b]+)\r?\n/.exec(buf); if (m) { clearTimeout(timer); resolve(m[1]); } };
        child!.stdout?.on('data', onData); child!.stderr?.on('data', onData);
        child!.once('error', e => { clearTimeout(timer); reject(e); });
        child!.once('exit', code => { clearTimeout(timer); reject(new Error(`DSH :${port} exited (${code}): ${buf.slice(-600)}`)); });
      });
      const dbPath = path.join(readerHome, 'reader.sqlite'), beforeBytes = await readFile(dbPath);
      const authRes = await fetch(authUrl, { redirect: 'manual' });
      const cookie = authRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
      const probeRes = await fetch(`http://127.0.0.1:${port}/api/paper-reader-tool-probe`, { headers: { cookie, origin: `http://127.0.0.1:${port}` } });
      assert.equal(probeRes.status, 200, `probe endpoint returned ${probeRes.status}: ${await probeRes.clone().text()}`);
      const report = await probeRes.json() as { names: string[]; results: { callId: string; isError: boolean; value?: Record<string, unknown>; error?: string }[] };
      assert.deepEqual(report.names, ['paper_reader_citation_stance', 'paper_reader_field_trends', 'paper_reader_search', 'paper_reader_topic_summary']);
      const byId = new Map(report.results.map(r => [r.callId, r]));
      const r1 = byId.get('c1')!, r2 = byId.get('c2')!, r3 = byId.get('c3')!, r4 = byId.get('c4')!, r5 = byId.get('c5')!;
      assert.equal(r1.isError, false, `search failed: ${r1.error}`);
      assert.ok(Array.isArray(r1.value?.pageHits) && (r1.value.pageHits as { docId: string }[]).some(h => h.docId === 'pagedattention'));
      assert.equal(r2.isError, false, `topic_summary failed: ${r2.error}`);
      assert.equal(r2.value?.documentCount, 1);
      assert.equal(r3.isError, false, `citation_stance failed: ${r3.error}`);
      assert.ok(String(r3.value?.sciteUrl ?? '').startsWith('https://scite.ai/') && Number((r3.value?.tallies as { localBackCitations?: number } | undefined)?.localBackCitations ?? 0) >= 1);
      assert.equal(r4.isError, false, `field_trends failed: ${r4.error}`);
      assert.ok(Array.isArray(r4.value?.topics) && (r4.value.topics as unknown[]).length >= 1, `expected live Europe PMC GLP-1 trends, got ${JSON.stringify(r4.value)}`);
      assert.equal(r5.isError, true, 'expected invalid search args to fail');
      assert.match(String(r5.error ?? ''), /invalid arguments/i);
      assert.equal(Buffer.compare(beforeBytes, await readFile(dbPath)), 0, 'live DSH host tools mutated reader.sqlite');
      console.log(`PASS PR-7 live DSH host smoke (127.0.0.1:${port}, ~/.dsh/profiles/web): 4 tools registered | search=${(r1.value!.pageHits as unknown[]).length} hits | topic_summary=1 doc | citation_stance=local+scite | field_trends(GLP-1/europepmc)=${(r4.value!.topics as unknown[]).length} topics | invalid_args=rejected | sqlite_writes=0`);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null && child.pid) {
        const stopped = once(child, 'exit'); child.kill(); await Promise.race([stopped, new Promise(r => setTimeout(r, 5000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
} finally { db.close(); }
