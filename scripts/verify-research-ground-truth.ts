import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { setGlobalProxyFromEnv } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exploreCitationGraph, resolveAcademicPaper, saveGraphPaper } from '../src/server/academic-graph.js';
import { queryFieldTrends, queryTrendPapers } from '../src/server/field-trends.js';
import { Library } from '../src/server/library.js';
import { extractDocumentPages, extractPdfPages } from '../src/server/pdf-text.js';
import { publicResource } from '../src/server/public-resource.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { ensureResearchSchema, getDocPages, replaceDocPages, searchDocPagesFts } from '../src/server/research-store.js';

if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) setGlobalProxyFromEnv();
const pages = await extractPdfPages(await readFile(path.resolve('public/assets/pagedattention.pdf')));
assert.equal(pages.length, 16, `expected 16 pages, got ${pages.length}`);

const db = new DatabaseSync(':memory:');
try {
  ensureResearchSchema(db);
  replaceDocPages(db, 'pagedattention', pages);
  assert.equal(getDocPages(db, 'pagedattention').length, 16);
  const blockHits = searchDocPagesFts(db, '"block table"'), kvHits = searchDocPagesFts(db, 'KV cache');
  assert.ok(blockHits.some(h => h.docId === 'pagedattention' && h.page === 6), 'missing "block table" hit on page 6');
  assert.ok(kvHits.some(h => h.docId === 'pagedattention' && h.page === 1), 'missing "KV cache" hit on page 1');
  console.log(`PASS PR-1 ground-truth: pagedattention.pdf (${pages.length} pages) | "block table" -> p.${blockHits[0].page} (${blockHits.length} hits) | "KV cache" -> p.${kvHits[0].page} (${kvHits.length} hits)`);

  const liveCtx = { withDb: <T>(_: boolean, run: (d: DatabaseSync) => T) => run(db) };
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
} finally { db.close(); }
