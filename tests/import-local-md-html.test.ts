import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unchangedArticleBlock } from '../src/reader/article-content.js';
import { importLocalFile } from '../src/server/file-import.js';
import { apply } from '../src/server/index.js';
import { Library } from '../src/server/library.js';
import { parseMarkdownArticle } from '../src/server/markdown-article.js';
import { HTML_LIMIT } from '../src/server/public-resource.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { createServices } from '../src/server/services.js';

function makeLocalDeps(root: string) {
  const store = new ReaderStore(root);
  const library = new Library(root, undefined, id => store.deleteDocument(id));
  return { library, store, act: createServices({ root, library, store }) };
}

test('small local Markdown extracts frontmatter, heading slugs, KaTeX math, verbatim code, tables, and escapes XSS', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-local-md-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { library, store, act } = makeLocalDeps(root);

  const md = `---
title: "FlashAttention Study Notes"
author: Ada Lovelace
date: 2025-04-12
doi: 10.1145/3600006.3613165
---

# Overview

Inline formula $a^2 + b^2 = c^2$ with **bold**, \`inline_code\`, and <script>alert("xss")</script>.

$$
E = m c^2
$$

\`\`\`math
\\sum_{i=1}^{n} x_i
\`\`\`

\`\`\`python
def kernel(x):
    return x * 2
\`\`\`

> Blockquote insight about SRAM tiling.

- First bullet point
- Second bullet point

| Tile | SRAM | Speedup |
| --- | --- | --- |
| 64 | 96 KB | 2.4x |

## Overview

Second overview body.

### Overview

Third overview body.`;

  const { doc } = await importLocalFile({ library, store }, { filename: 'ignored_name.md', bytes: Buffer.from(md, 'utf8') });
  assert.ok(doc.id.startsWith('web-'));
  assert.equal(doc.title, 'FlashAttention Study Notes');
  assert.equal(doc.authors, 'Ada Lovelace');
  assert.equal(doc.year, '2025');
  assert.equal(doc.doi, '10.1145/3600006.3613165');
  assert.equal(doc.url, undefined);
  assert.equal(doc.paragraphs?.some(p => p.includes('FlashAttention Study Notes')), false);

  const blocks = Object.values(doc.articleLayout ?? {});
  assert.deepEqual(blocks.filter(b => /^h[1-6]$/.test(b.kind)).flatMap(b => b.ids ?? []), ['overview', 'overview-1', 'overview-2']);
  assert.ok(blocks.some(b => b.kind === 'p' && b.spans?.some(s => s.kind === 'math' && s.value === 'a^2 + b^2 = c^2')));
  const equations = blocks.filter(b => b.kind === 'equation');
  assert.deepEqual(equations.map(e => e.spans?.[0]?.value), ['E = m c^2', '\\sum_{i=1}^{n} x_i']);
  for (const kind of ['pre', 'equation', 'table'] as const) {
    assert.ok(blocks.some(b => b.kind === kind));
    assert.equal(unchangedArticleBlock(kind), true);
  }
  assert.equal(unchangedArticleBlock('p'), false);
  assert.ok(blocks.some(b => b.kind === 'quote') && blocks.some(b => b.kind === 'list'));
  assert.equal((await act('pages.search', { query: 'SRAM tiling', docIds: [doc.id] })).hits[0]?.page, 1);

  assert.equal(parseMarkdownArticle('# First Heading Title\n\nBody.', 'fallback_stem.markdown').title, 'First Heading Title');
  assert.equal(parseMarkdownArticle('Plain paragraph without headings.', 'my_research-notes.markdown').title, 'my research notes');
});

test('large local Markdown (>140 blocks) auto-shards, resolves cross-section anchors, indexes FTS, and cascades delete', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-large-md-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { library, store, act } = makeLocalDeps(root);

  const lines = ['---', 'title: Distributed Systems Field Guide', '---', '', '# Chapter 1 Introduction', '', 'MD_EARLY_TOKEN See [Jump to Target](#target-section).', ''];
  for (let i = 1; i <= 55; i++) lines.push(`Intro paragraph ${i} discussing consensus logs and quorum replication.`, '');
  lines.push('## Target Section', '', 'MD_TARGET_TOKEN Raft leader election and log compaction invariants.', '');
  for (let i = 1; i <= 55; i++) lines.push(`Target paragraph ${i} explaining snapshot transfer and term safety.`, '');
  lines.push('# Chapter 2 Storage Engine', '', 'MD_TAIL_TOKEN Log-structured merge trees with Bloom filters.', '');
  for (let i = 1; i <= 45; i++) lines.push(`Storage paragraph ${i} detailing compaction throughput.`, '');

  const { doc } = await importLocalFile({ library, store }, { filename: 'guide.markdown', bytes: Buffer.from(lines.join('\n'), 'utf8') });
  assert.ok(doc.id.startsWith('book-') && doc.book && doc.book.sections.length >= 3 && doc.url === undefined);
  assert.equal(doc.title, 'Distributed Systems Field Guide');

  const targetPage = doc.book.anchorPages?.['target-section'];
  assert.ok(targetPage && targetPage > 1);
  assert.ok(Object.values(doc.articleLayout ?? {}).flatMap(b => b.spans ?? []).some(s => s.kind === 'link' && s.value === '#target-section'));
  for (let p = 1; p <= doc.book.sections.length; p++) {
    const sec = library.cachedSection(doc, p);
    assert.ok(sec?.paragraphs?.length && sec.paragraphs.length <= 120 && sec.paragraphs.reduce((n, s) => n + s.length, 0) <= 80_000);
  }
  assert.equal((await act('pages.search', { query: 'MD_EARLY_TOKEN', docIds: [doc.id] })).hits[0]?.page, 1);
  assert.equal((await act('pages.search', { query: 'MD_TARGET_TOKEN', docIds: [doc.id] })).hits[0]?.page, targetPage);
  assert.equal((await act('pages.search', { query: 'MD_TAIL_TOKEN', docIds: [doc.id] })).hits[0]?.page, doc.book.sections.length);
  assert.equal((await act('book.pages', { docId: doc.id })).pages.length, doc.book.sections.length);

  const secDir = path.join(root, 'documents', 'book-sections', doc.id);
  assert.equal(existsSync(secDir), true);
  assert.equal((await act('library.delete', { id: doc.id })).deleted, true);
  assert.equal(existsSync(secDir), false);
  assert.equal((await act('pages.search', { query: 'MD_TARGET_TOKEN', docIds: [doc.id] })).hits.length, 0);
});

test('large local HTML (>6 MB) strips Sphinx chrome, auto-shards, indexes FTS, and HTTP import-file enforces 413/415', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-local-html-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { library, store, act } = makeLocalDeps(root);

  const filler = 'Streaming multiprocessor warp scheduling coalesced transactions shared memory banks. '.repeat(55);
  const chunks = [
    '<!doctype html><html><head><meta charset="utf-8"><title>Offline GPU Manual</title></head><body>',
    '<div class="sphinxsidebar">LOCAL_CHROME_LEAK</div><nav class="wy-nav-side">LOCAL_NAV_LEAK</nav><script>window.__bad=1;</script><main>'
  ];
  for (let c = 1; c <= 6; c++) {
    chunks.push(`<section id="ch-${c}"><h1>Chapter ${c} GPU Kernels</h1>`);
    if (c === 3) {
      chunks.push('<p>LOCAL_HTML_MID_TOKEN Cooperative launch notes.</p><pre><code>__global__ void scale(float *a) { a[threadIdx.x] *= 2.0f; }</code></pre><table><tr><th>Arch</th><th>SM</th></tr><tr><td>Hopper</td><td>9.0</td></tr></table>');
    }
    for (let p = 1; p <= 240; p++) chunks.push(`<p>Ch${c}P${p}: ${filler}</p>`);
    chunks.push('</section>');
  }
  chunks.push('</main><footer>LOCAL_FOOTER_LEAK</footer></body></html>');
  const htmlBytes = Buffer.from(chunks.join('\n'), 'utf8');
  assert.ok(htmlBytes.length > 6 * 1024 * 1024);

  const { doc } = await importLocalFile({ library, store }, { filename: 'gpu-manual.htm', bytes: htmlBytes });
  assert.ok(doc.id.startsWith('book-') && doc.book && doc.book.sections.length >= 6 && doc.url === undefined);
  const midHit = (await act('pages.search', { query: 'LOCAL_HTML_MID_TOKEN', docIds: [doc.id] })).hits[0];
  assert.ok(midHit && midHit.page > 1);
  assert.equal((await act('pages.search', { query: 'LOCAL_CHROME_LEAK', docIds: [doc.id] })).hits.length, 0);
  const midKinds = new Set(Object.values(library.cachedSection(doc, midHit.page)?.articleLayout ?? {}).map(b => b.kind));
  assert.equal(midKinds.has('pre') && midKinds.has('table'), true);

  await assert.rejects(importLocalFile({ library, store }, { filename: 'huge.md', bytes: Buffer.alloc(HTML_LIMIT + 1, 65) }), { status: 413 });
  await assert.rejects(importLocalFile({ library, store }, { filename: 'malware.exe', bytes: Buffer.from('MZ') }), { status: 415 });
  await assert.rejects(importLocalFile({ library, store }, { filename: 'bin.md', bytes: Buffer.from([0, 1, 2, 3]) }), { status: 415 });

  const prevHome = process.env.PAPER_READER_HOME;
  process.env.PAPER_READER_HOME = root;
  t.after(() => { if (prevHome === undefined) delete process.env.PAPER_READER_HOME; else process.env.PAPER_READER_HOME = prevHome; });
  const routes = new Map<string, (req: Request) => Promise<Response>>();
  apply({ connection: { fetch: { register(r: { path: string; fetch(req: Request): Promise<Response> }) { routes.set(r.path, r.fetch); } } }, inject: () => () => {} });
  const importRoute = routes.get('/api/paper-reader/import-file')!;
  const mdResp = await importRoute(new Request('http://dsh.internal/api/paper-reader/import-file', {
    method: 'POST', headers: { 'x-filename': encodeURIComponent('Quick Note.md'), 'content-type': 'text/markdown' }, body: '# Quick Note\n\nHTTP route markdown body.'
  }));
  assert.equal(mdResp.status, 200);
  assert.equal(((await mdResp.json()) as { doc: { title: string } }).doc.title, 'Quick Note');
  assert.equal((await importRoute(new Request('http://dsh.internal/api/paper-reader/import-file?filename=bad.exe', { method: 'POST', body: 'x' }))).status, 415);
  assert.equal((await importRoute(new Request('http://dsh.internal/api/paper-reader/import-file?filename=big.html', { method: 'POST', headers: { 'content-length': String(HTML_LIMIT + 10) }, body: '<p>x</p>' }))).status, 413);
});
