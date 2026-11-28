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

  const readLocal: ResourceReader = async (raw) => ({ url: new URL(String(raw).split('#')[0]), bytes, type: 'text/html', charset: 'utf-8' });
  const act = createServices({ root, readResource: readLocal });
  const { doc } = await act('web.open', { url: manualUrl });
  assert.ok(doc.id.startsWith('book-') && doc.book && doc.book.sections.length >= 25 && doc.sectionPage === 1);

  const library = new Library(root, readLocal);
  const { 'kernel-launch': kernelPage, 'legacy-warp-anchor': legacyPage, 'inline-final-anchor': finalPage, 'manual-tail-anchor': tailPage } = doc.book.anchorPages ?? {};
  assert.ok(kernelPage && kernelPage > 1 && legacyPage && legacyPage > kernelPage && finalPage && finalPage > legacyPage);
  assert.equal(tailPage, doc.book.sections.length);

  for (let p = 1; p <= doc.book.sections.length; p++) {
    const sec = library.cachedSection(doc, p);
    assert.ok(sec?.paragraphs?.length && sec.paragraphs.length <= 120, `section ${p} block count invalid`);
    const secChars = sec.paragraphs.reduce((sum, text) => sum + text.length, 0);
    assert.ok(secChars <= 80_000, `section ${p} exceeded 80 KB text: ${secChars}`);
  }

  const kernelSection = (await act('book.section', { docId: doc.id, page: kernelPage })).doc;
  const kinds = new Set(Object.values(kernelSection.articleLayout ?? {}).map(b => b.kind));
  for (const kind of ['pre', 'table', 'equation'] as const) assert.equal(kinds.has(kind), true);
  for (const kind of ['pre', 'table', 'equation', 'image'] as const) assert.equal(unchangedArticleBlock(kind), true);
  assert.equal(unchangedArticleBlock('p'), false);

  const openedAtAnchor = await openWebArticle(library, manualUrl + '#kernel-launch', readLocal);
  assert.equal(openedAtAnchor.page, kernelPage);
  assert.ok(openedAtAnchor.anchor && kernelSection.articleLayout?.[openedAtAnchor.anchor]?.ids?.includes('kernel-launch'));

  const longCodeSection = (await act('book.section', { docId: doc.id, page: doc.book.anchorPages!['sec-7-1'] })).doc;
  const preBlocks = Object.entries(longCodeSection.articleLayout ?? {}).filter(([, b]) => b.kind === 'pre');
  assert.ok(preBlocks.length >= 2, 'oversized >20k <pre> block should split cleanly across multiple pre blocks');
  for (const [id] of preBlocks) assert.ok((longCodeSection.paragraphs?.[Number(id.slice(2)) - 1]?.length ?? 0) <= 20_000);

  assert.equal((await act('pages.search', { query: 'EARLY_SENTINEL_ALPHA', docIds: [doc.id] })).hits[0]?.page, 1);
  assert.equal((await act('pages.search', { query: 'MIDDLE_SENTINEL_OMEGA', docIds: [doc.id] })).hits[0]?.page, kernelPage);
  assert.equal((await act('pages.search', { query: 'TAIL_SENTINEL_END', docIds: [doc.id] })).hits[0]?.page, doc.book.sections.length);

  const { pages: bookPages } = await act('book.pages', { docId: doc.id });
  assert.equal(bookPages.length, doc.book.sections.length);
  const searchSources = buildSearchSources(doc, undefined, new Map(), bookPages);
  assert.equal(searchDocument(searchSources, 'TAIL_SENTINEL_END').matches[0]?.page, doc.book.sections.length);
  assert.equal(searchDocument(searchSources, 'MIDDLE_SENTINEL_OMEGA').matches[0]?.page, kernelPage);

  const sectionsDir = path.join(root, 'documents', 'book-sections', doc.id);
  assert.equal(existsSync(sectionsDir), true);
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

test('sharding hardening: Sphinx titles, preamble dedup, non-BMP slugs, wide/empty tables, layout validation, and extension anchor mapping', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-shard-edge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const act = createServices({ root });
  const library = new Library(root);

  const cudaHtml = `<title>1. Introduction — CUDA C++ Programming Guide</title><main><p>Release notes 12.8</p><h1>1. Introduction</h1><p>Intro body.</p><h1>2. Model</h1><p>Model body.</p></main>`;
  const ptxHtml = `<title>1. Introduction — PTX ISA 9.5 documentation</title><main><h1>1. Introduction</h1><p>A</p><h1>2. ISA</h1><p>B</p></main>`;
  const dupTitleHtml = `<title>1. Introduction</title><main><p>Cover notes.</p><h1>1. Introduction</h1><p>Body.</p><h1>2. Next</h1><p>More.</p></main>`;
  const cudaParsed = parseWebArticle(cudaHtml, 'https://docs.example.org/cuda/index.html');
  assert.equal(cudaParsed.title, 'CUDA C++ Programming Guide');
  assert.equal(parseWebArticle(ptxHtml, 'https://docs.example.org/ptx/index.html').title, 'PTX ISA 9.5 documentation');
  const cudaSharded = shardArticle(cudaParsed);
  assert.deepEqual([...new Set(cudaSharded.bookSections.map(s => s.chapterTitle))], ['CUDA C++ Programming Guide', '1. Introduction', '2. Model']);
  const dupSharded = shardArticle(parseWebArticle(dupTitleHtml, 'https://docs.example.org/dup/index.html'));
  assert.deepEqual([...new Set(dupSharded.bookSections.map(s => s.chapterTitle))], ['Overview', '1. Introduction', '2. Next']);

  const wideRow = Array.from({ length: 700 }, (_, i) => `<td>${`col${i}_`.padEnd(40, 'x')}</td>`).join('');
  const tableHtml = `<title>Wide & Empty Tables</title><article><h1>Tables</h1><table><tr><td></td><td></td></tr><tr>${wideRow}</tr></table></article>`;
  const tableParsed = parseWebArticle(tableHtml, 'https://docs.example.org/tables');
  assert.equal(tableParsed.paragraphs.some(p => !p.trim()), false);
  const tableDoc = await library.importWebDocument(tableParsed);
  assert.ok(tableDoc.doc.id.startsWith('web-'));

  const nonBmpHeading = 'a'.repeat(76) + '\u{20000}' + 'tail';
  const nonBmpSharded = shardArticle({ url: 'https://docs.example.org/cjk', title: nonBmpHeading, paragraphs: [nonBmpHeading, 'Body paragraph.'], articleLayout: { 'p-1': { kind: 'h1' } } });
  const nonBmpImported = await importShardedBook(library, { title: nonBmpHeading, url: 'https://docs.example.org/cjk', sharded: nonBmpSharded });
  assert.ok(nonBmpImported.doc.id.startsWith('book-'));

  const longParas = Array.from({ length: 160 }, (_, i) => i === 0 ? 'IMAGE_ALT_SKIP_TOKEN' : i === 149 ? 'P150_SELECTED_TARGET' : `Paragraph number ${i + 1}`);
  await assert.rejects(library.importWebDocument({ url: 'https://docs.example.org/bad', title: 'Bad', paragraphs: longParas, articleLayout: { 'p-1': { kind: 'p', ids: 123 } } }), { status: 400 });
  await assert.rejects(library.importWebDocument({ url: 'https://docs.example.org/bad', title: 'Bad', paragraphs: longParas, articleLayout: { badkey: { kind: 'p' } } }), { status: 400 });
  await assert.rejects(library.importWebDocument({ url: 'https://docs.example.org/bad', title: 'Bad', paragraphs: longParas, anchor: 'p-999' }), { status: 400 });

  const extImported = await act('web.import', {
    url: 'https://docs.example.org/long-ext', title: 'Long Extension Page', paragraphs: longParas,
    articleLayout: { 'p-1': { kind: 'image', image: { url: 'https://docs.example.org/fig.png', alt: 'IMAGE_ALT_SKIP_TOKEN' } } },
    anchor: 'p-150'
  });
  assert.ok(extImported.doc.book && extImported.page && extImported.page > 1 && extImported.anchor);
  const anchorIdx = Number(extImported.anchor.slice(2)) - 1;
  assert.equal(extImported.doc.paragraphs?.[anchorIdx], 'P150_SELECTED_TARGET');
  const { pages } = await act('book.pages', { docId: extImported.doc.id });
  assert.equal(pages.some(p => p.text.includes('IMAGE_ALT_SKIP_TOKEN')), false);
});
