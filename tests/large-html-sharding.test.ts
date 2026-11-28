import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unchangedArticleBlock } from '../src/reader/article-content.js';
import { buildSearchSources, searchDocument } from '../src/reader/doc-search-index.js';
import { decodeHtml, type ResourceReader } from '../src/server/academic-intake.js';
import { importShardedBook } from '../src/server/book-import.js';
import { Library } from '../src/server/library.js';
import { HTML_LIMIT } from '../src/server/public-resource.js';
import { createServices } from '../src/server/services.js';
import { openWebArticle, parseWebArticle } from '../src/server/web-article.js';
import { shardArticle, shouldShardArticle } from '../src/shared/doc-sharding.js';

function buildSyntheticCudaManualHtml(): string {
  const filler = 'Warp execution schedules thirty-two threads in lockstep across streaming multiprocessors with coalesced global memory transactions and low-latency shared memory banks. '.repeat(26);
  const longKernel = Array.from({ length: 420 }, (_, i) =>
    `__device__ inline float lane_step_${i}(float x, int tid) { return __fmaf_rn(x, 1.0001f, (float)(tid & 31)); }`
  ).join('\n');
  const parts: string[] = [
    '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic CUDA C++ Programming Guide</title></head><body>',
    '<nav class="wy-nav-side"><div id="searchbox">CHROME_SEARCHBOX_TOKEN</div><div class="toctree-wrapper">CHROME_TOCTREE_TOKEN</div></nav>',
    '<div class="sphinxsidebar">CHROME_SPHINX_SIDEBAR_TOKEN</div>',
    '<div class="wy-breadcrumbs">CHROME_BREADCRUMBS_TOKEN</div>',
    '<div role="complementary">CHROME_COMPLEMENTARY_TOKEN</div>',
    '<div class="rst-versions">CHROME_RST_VERSIONS_TOKEN</div>',
    '<div role="main" class="document"><div itemprop="articleBody">',
    '<section id="manual-root"><h1>CUDA C++ Programming Guide<a class="headerlink" href="#manual-root">¶</a></h1>'
  ];
  const chapters = 10, sectionsPerChapter = 3, parasPerSection = 52;
  for (let c = 1; c <= chapters; c++) {
    parts.push(`<section id="chapter-${c}"><h1>Chapter ${c}: GPU Architecture Subsystem ${c}<a class="headerlink" href="#chapter-${c}">¶</a></h1>`);
    for (let s = 1; s <= sectionsPerChapter; s++) {
      const secId = c === 5 && s === 2 ? 'kernel-launch' : `sec-${c}-${s}`;
      const extraAnchor = c === 8 && s === 1 ? '<a name="legacy-warp-anchor"></a>' : '';
      const spanAnchor = c === 10 && s === 3 ? '<span id="inline-final-anchor"></span>' : '';
      parts.push(`<section id="${secId}">${extraAnchor}${spanAnchor}<h2>${c}.${s} Subsystem Topic ${c}-${s}<a class="headerlink" href="#${secId}">¶</a></h2>`);
      if (c === 1 && s === 1) {
        parts.push('<p>EARLY_SENTINEL_ALPHA See <a href="#kernel-launch">Kernel Launch Details</a>, <a href="#legacy-warp-anchor">Legacy Warp</a>, and <a href="#inline-final-anchor">Final Target</a>.</p>');
      }
      if (c === 5 && s === 2) {
        parts.push('<p>MIDDLE_SENTINEL_OMEGA Launching cooperative grids across multiple streaming multiprocessors.</p>');
        parts.push('<pre><code>__global__ void saxpy(int n, float a, float *x, float *y) {\n  int i = blockIdx.x * blockDim.x + threadIdx.x;\n  if (i < n) y[i] = a * x[i] + y[i];\n}</code></pre>');
        parts.push('<table><thead><tr><th>Compute Cap</th><th>Max Threads</th><th>Shared Mem</th></tr></thead><tbody><tr><td>8.0</td><td>1024</td><td>164 KB</td></tr><tr><td>9.0</td><td>1024</td><td>228 KB</td></tr></tbody></table>');
        parts.push('<div class="math notranslate nohighlight">T_{\\text{eff}} = \\frac{N_{\\text{bytes}}}{\\Delta t}</div>');
        parts.push('<div class="ltx_equation">E = m c^2</div>');
      }
      if (c === 7 && s === 1) {
        parts.push(`<pre><code>${longKernel}</code></pre>`);
      }
      if (c === 10 && s === 3) {
        parts.push('<p>FINAL_SENTINEL_ZETA Summary of memory fences and asynchronous barrier primitives.</p>');
      }
      for (let p = 1; p <= parasPerSection; p++) {
        if (p === 26) parts.push(`<h3 id="sub-${c}-${s}">Subsection ${c}.${s}.1 Detailed Notes</h3>`);
        parts.push(`<p>C${c}S${s}P${p}: ${filler}</p>`);
      }
      if (c === 10 && s === 3) {
        parts.push('<p id="manual-tail-anchor">TAIL_SENTINEL_END Concluding hardware appendix reference.</p>');
      }
      parts.push('</section>');
    }
    parts.push('</section>');
  }
  parts.push('</div></div><div class="prev-next-area">CHROME_PREVNEXT_TOKEN</div><footer>CHROME_FOOTER_TOKEN</footer></body></html>');
  return parts.join('\n');
}

test('large single-page HTML technical manual (>6 MB, >1500 blocks) strips chrome, auto-shards, preserves anchors, protects code/tables/math, and indexes all sections', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-large-html-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manualUrl = 'https://docs.example.org/cuda/archive/12.8.0/cuda-c-programming-guide/index.html';
  const html = buildSyntheticCudaManualHtml();
  const bytes = Buffer.from(html, 'utf8');
  assert.ok(bytes.length > 6 * 1024 * 1024, `expected > 6 MB synthetic HTML, got ${bytes.length}`);
  assert.equal(HTML_LIMIT, 32 * 1024 * 1024);

  const decoded = decodeHtml(bytes, 'text/html', 'utf-8');
  assert.equal(decoded.length, html.length);
  assert.throws(() => decodeHtml(Buffer.alloc(HTML_LIMIT + 1), 'text/html', 'utf-8'), /readable HTML/);

  const parsed = parseWebArticle(decoded, manualUrl);
  assert.ok(parsed.paragraphs.length > 1500, `expected > 1500 paragraphs, got ${parsed.paragraphs.length}`);
  assert.equal(shouldShardArticle(parsed), true);
  const joinedText = parsed.paragraphs.join('\n');
  for (const chromeToken of [
    'CHROME_SEARCHBOX_TOKEN', 'CHROME_TOCTREE_TOKEN', 'CHROME_SPHINX_SIDEBAR_TOKEN',
    'CHROME_BREADCRUMBS_TOKEN', 'CHROME_COMPLEMENTARY_TOKEN', 'CHROME_RST_VERSIONS_TOKEN',
    'CHROME_PREVNEXT_TOKEN', 'CHROME_FOOTER_TOKEN'
  ]) {
    assert.equal(joinedText.includes(chromeToken), false, `chrome leaked: ${chromeToken}`);
  }
  assert.equal(joinedText.includes('¶'), false);

  const readLocal: ResourceReader = async (raw) => ({
    url: new URL(String(raw).split('#')[0]),
    bytes,
    type: 'text/html',
    charset: 'utf-8'
  });
  const act = createServices({ root, readResource: readLocal });
  const opened = await act('web.open', { url: manualUrl });
  const doc = opened.doc;
  assert.ok(doc.id.startsWith('book-'));
  assert.ok(doc.book && doc.book.sections.length >= 25);
  assert.equal(doc.sectionPage, 1);

  const library = new Library(root, readLocal);
  const kernelPage = doc.book.anchorPages?.['kernel-launch'];
  const legacyPage = doc.book.anchorPages?.['legacy-warp-anchor'];
  const finalPage = doc.book.anchorPages?.['inline-final-anchor'];
  const tailPage = doc.book.anchorPages?.['manual-tail-anchor'];
  assert.ok(kernelPage && kernelPage > 1 && kernelPage < doc.book.sections.length);
  assert.ok(legacyPage && legacyPage > kernelPage);
  assert.ok(finalPage && finalPage > legacyPage);
  assert.equal(tailPage, doc.book.sections.length);

  for (let p = 1; p <= doc.book.sections.length; p++) {
    const sec = library.cachedSection(doc, p);
    assert.ok(sec && sec.paragraphs && sec.paragraphs.length > 0);
    assert.ok(sec.paragraphs.length <= 120, `section ${p} exceeded 120 blocks: ${sec.paragraphs.length}`);
    const secChars = sec.paragraphs.reduce((sum, text) => sum + text.length, 0);
    assert.ok(secChars <= 80_000, `section ${p} exceeded 80 KB text: ${secChars}`);
  }

  const kernelSection = (await act('book.section', { docId: doc.id, page: kernelPage })).doc;
  const kinds = Object.values(kernelSection.articleLayout ?? {}).map(b => b.kind);
  assert.ok(kinds.includes('pre'));
  assert.ok(kinds.includes('table'));
  assert.ok(kinds.includes('equation'));
  for (const kind of ['pre', 'table', 'equation', 'image'] as const) assert.equal(unchangedArticleBlock(kind), true);
  assert.equal(unchangedArticleBlock('p'), false);

  const openedAtAnchor = await openWebArticle(library, manualUrl + '#kernel-launch', readLocal);
  assert.equal(openedAtAnchor.page, kernelPage);
  assert.ok(openedAtAnchor.anchor && kernelSection.articleLayout?.[openedAtAnchor.anchor]?.ids?.includes('kernel-launch'));

  const longCodeSection = (await act('book.section', { docId: doc.id, page: doc.book.anchorPages!['sec-7-1'] })).doc;
  const preBlocks = Object.entries(longCodeSection.articleLayout ?? {}).filter(([, b]) => b.kind === 'pre');
  assert.ok(preBlocks.length >= 2, 'oversized >20k <pre> block should split cleanly across multiple pre blocks');
  for (const [id] of preBlocks) {
    const idx = Number(id.slice(2)) - 1;
    assert.ok((longCodeSection.paragraphs?.[idx]?.length ?? 0) <= 20_000);
  }

  const earlyHits = (await act('pages.search', { query: 'EARLY_SENTINEL_ALPHA', docIds: [doc.id] })).hits;
  const middleHits = (await act('pages.search', { query: 'MIDDLE_SENTINEL_OMEGA', docIds: [doc.id] })).hits;
  const finalHits = (await act('pages.search', { query: 'TAIL_SENTINEL_END', docIds: [doc.id] })).hits;
  assert.equal(earlyHits[0]?.page, 1);
  assert.equal(middleHits[0]?.page, kernelPage);
  assert.equal(finalHits[0]?.page, doc.book.sections.length);

  const { pages: bookPages } = await act('book.pages', { docId: doc.id });
  assert.equal(bookPages.length, doc.book.sections.length);
  const searchSources = buildSearchSources(doc, undefined, new Map(), bookPages);
  assert.equal(searchDocument(searchSources, 'TAIL_SENTINEL_END').matches[0]?.page, doc.book.sections.length);
  assert.equal(searchDocument(searchSources, 'MIDDLE_SENTINEL_OMEGA').matches[0]?.page, kernelPage);

  const sectionsDir = path.join(root, 'documents', 'book-sections', doc.id);
  assert.equal(existsSync(sectionsDir), true);
  const missingSlugFile = path.join(sectionsDir, 'missing-test');
  assert.equal(existsSync(missingSlugFile), false);
  await rm(sectionsDir, { recursive: true, force: true });
  await assert.rejects(library.bookSection(doc.id, 1), { status: 404 });

  const direct = await importShardedBook(library, { title: 'Direct Sharded Manual', url: 'https://docs.example.org/direct', sharded: shardArticle(parsed) });
  assert.ok(direct.doc.id.startsWith('book-') && direct.doc.book!.sections.length === doc.book.sections.length);

  const deleted = await act('library.delete', { id: doc.id });
  assert.equal(deleted.deleted, true);
  assert.equal(existsSync(path.join(root, 'documents', doc.id + '.json')), false);
  assert.equal(existsSync(sectionsDir), false);
  assert.equal((await act('pages.search', { query: 'MIDDLE_SENTINEL_OMEGA', docIds: [doc.id] })).hits.length, 0);
});
