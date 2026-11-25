import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'parse5';
import type { ResourceReader } from '../src/server/academic-intake.js';
import { htmlTree } from '../src/server/article-dom.js';
import { Library } from '../src/server/library.js';
import { publicAddress, publicResource } from '../src/server/public-resource.js';
import { openWebArticle, parseWebArticle } from '../src/server/web-article.js';
import { parseAcademicInput } from '../src/shared/academic-intake.js';
import { buildCitationMetadata, formatBibTeX, formatRIS } from '../src/shared/citation-export.js';
import { extractArticle } from '../src/shared/web-article.js';

test('HTML and saved webpages keep quote anchors, publication structure and relative figure links', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-web-article-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = 'https://example.org/html/article';
  const page = parseWebArticle(`<title>A site</title><nav>Menu</nav><article><h1>Reading experiments</h1>
    <section id="results"><h2>Results</h2><p>See <a href="#chart">Figure 1</a> for
    <math alttext="x_1"><semantics><msub><mi>x</mi><mn>1</mn></msub><annotation>x_1</annotation></semantics></math>.</p>
    <figure id="chart"><object type="image/svg+xml" data="fig/chart.svg"></object><figcaption>Figure 1. Measured.</figcaption></figure>
    <pre><code>var a [4]int
      a[0] = 1</code></pre><table><tr><th>n</th><th>score</th></tr><tr><td>5</td><td>1</td></tr></table>
    <aside>Related articles</aside><p hidden>Not in the article.</p><script>alert('untrusted')</script></section></article>`, url);
  assert.equal(page.title, 'Reading experiments');
  assert.deepEqual(page.paragraphs, ['Reading experiments', 'Results', 'See Figure 1 for x1.', 'Illustration', 'Figure 1. Measured.',
    'var a [4]int\n      a[0] = 1', 'n\tscore\n5\t1']);
  assert.deepEqual(page.articleLayout!['p-2'], { kind:'h2', ids:['results'] });
  assert.deepEqual(page.articleLayout!['p-4'].image, { url:'https://example.org/html/fig/chart.svg', alt:'' });
  const [reference, formula] = page.articleLayout!['p-3'].spans!;
  assert.equal(page.paragraphs[2].slice(reference.start, reference.end), 'Figure 1');
  assert.equal(reference.value, url + '#chart');
  assert.equal(formula.value, 'x_1');
  assert.deepEqual(parseWebArticle('<article><h2 id="slices">Slices<a href="#slices" aria-label="Go to slices">¶</a></h2></article>', url).paragraphs, ['Slices']);
  const library = new Library(root);
  const plain = await library.importWeb({ url, title:page.title, paragraphs:page.paragraphs });
  const structured = await library.importWeb(page);
  assert.equal(plain.id, structured.id);
  assert.deepEqual((await new Library(root).get(plain.id)).articleLayout, page.articleLayout);
  assert.ok((await library.list()).every(doc => !doc.articleLayout && !doc.paragraphs));
  let fetches = 0;
  const picture = { type:'image/svg+xml', bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') };
  await assert.rejects(library.articleImage(plain.id, 'p-4', async () => { throw new Error('offline'); }), /offline/);
  const download = async (url: string) => { fetches++; assert.equal(url, page.articleLayout!['p-4'].image!.url); return picture; };
  const [first, second] = await Promise.all([library.articleImage(plain.id, 'p-4', download), library.articleImage(plain.id, 'p-4', download)]);
  assert.equal(fetches, 1);
  assert.deepEqual(first, second);
  const afterRestart = await new Library(root).articleImage(plain.id, 'p-4', async () => { throw new Error('website is offline'); });
  assert.deepEqual(afterRestart, picture);
  await assert.rejects(library.importWeb({ ...page, articleLayout: { 'p-1': { kind:'image', image:{ url:'file:///private',alt:'' } } } }));
});

test('remote articles and their images accept only public HTTP destinations', async () => {
  for (const address of ['127.0.0.1','0.0.0.0','10.1.0.2','100.64.0.1','169.254.169.254','192.168.2.1','198.19.0.1',
    '::1','::ffff:7f00:1','fc00::1','fe80::1','ff02::1','64:ff9b::7f00:1','2002:7f00:1::','2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8','2606:4700:4700::1111']) assert.equal(publicAddress(address), true);
  for (const url of ['file:///tmp/test','https://admin:pass@example.org/','http://127.1/','http://[::1]/','http://server.internal/'])
    await assert.rejects(publicResource(url, 'document'), /public/);
});

test('parseWebArticle extracts academic HTML meta tags and persists sanitized citation fields through Library', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-web-meta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = 'https://journal.example.org/papers/meta-2024';
  const html = `<!doctype html><html><head>
    <title>Journal Site</title>
    <meta name="Citation_Title" content="Structured Attention for Long Contexts">
    <meta name="citation_author" content="Smith, Alice">
    <meta name="citation_author" content="Doe, Bob">
    <meta name="citation_author" content="smith, alice">
    <meta name="citation_journal_title" content="Journal of Machine Reading">
    <meta name="citation_publication_date" content="2024/05/12">
    <meta name="citation_publisher" content="Academic Press">
    <meta name="CITATION_DOI" content="https://doi.org/10.1000/jmr.2024.09">
    <meta name="citation_abstract" content="First line of abstract.&#10;Second line of abstract.">
    <meta name="citation_date" content="not-a-year">
    <meta content="missing-name">
    <meta name="empty_content" content="   ">
  </head><body><article><h1>Structured Attention</h1><p>Body paragraph with sufficient text.</p></article></body></html>`;

  const parsed = parseWebArticle(html, url);
  assert.equal(parsed.paperTitle, 'Structured Attention for Long Contexts');
  assert.equal(parsed.authors, 'Smith, Alice; Doe, Bob');
  assert.equal(parsed.venue, 'Journal of Machine Reading');
  assert.equal(parsed.year, '2024');
  assert.equal(parsed.publisher, 'Academic Press');
  assert.equal(parsed.doi, '10.1000/jmr.2024.09');
  assert.equal(parsed.abstract, 'First line of abstract.\nSecond line of abstract.');

  const library = new Library(root);
  const imported = await library.importWeb(parsed);
  const loaded = await library.get(imported.id);
  assert.equal(loaded.paperTitle, parsed.paperTitle);
  assert.equal(loaded.authors, 'Smith, Alice; Doe, Bob');
  assert.equal(loaded.venue, 'Journal of Machine Reading');
  assert.equal(loaded.year, '2024');
  assert.equal(loaded.publisher, 'Academic Press');
  assert.equal(loaded.doi, '10.1000/jmr.2024.09');
  assert.equal(loaded.abstract, parsed.abstract);

  const listed = (await library.list()).find(doc => doc.id === imported.id);
  assert.ok(listed);
  assert.equal(listed.abstract, undefined);
  assert.equal(listed.year, '2024');

  const meta = buildCitationMetadata(loaded);
  const bib = formatBibTeX(meta);
  const ris = formatRIS(meta);
  assert.ok(bib.startsWith('@article{smith2024structured,\n'), bib);
  assert.ok(bib.includes('  author = {Smith, Alice and Doe, Bob},'));
  assert.ok(bib.includes('  journal = {Journal of Machine Reading},'));
  assert.ok(bib.includes('  publisher = {Academic Press},'));
  assert.ok(bib.includes('  doi = {10.1000/jmr.2024.09},'));
  assert.ok(ris.includes('TY  - JOUR\n'));
  assert.ok(ris.includes('AU  - Smith, Alice\nAU  - Doe, Bob\n'));
  assert.ok(ris.includes('JO  - Journal of Machine Reading\n'));
  assert.ok(ris.includes('PB  - Academic Press\n'));
  assert.ok(ris.includes('PY  - 2024\n'));
  assert.ok(ris.includes('DO  - 10.1000/jmr.2024.09\n'));
  assert.ok(ris.includes('AB  - First line of abstract. Second line of abstract.\n'));
  assert.ok(ris.endsWith('ER  - '));

  const fallbackHtml = `<!doctype html><html><head>
    <meta name="dc.creator" content="Ada Lovelace">
    <meta name="dc.creator" content="Charles Babbage">
    <meta name="dc.date" content="2021-11-01">
    <meta name="dc.identifier" content="urn:isbn:9780000000000">
    <meta name="dc.publisher" content="Royal Society">
    <meta property="OG:Description" content="Fallback abstract from OpenGraph.">
  </head><body><article><h1>Fallback Paper</h1><p>Content text.</p></article></body></html>`;
  const fallback = parseWebArticle(fallbackHtml, 'https://journal.example.org/papers/fallback');
  assert.equal(fallback.authors, 'Ada Lovelace; Charles Babbage');
  assert.equal(fallback.year, '2021');
  assert.equal(fallback.doi, undefined);
  assert.equal(fallback.publisher, 'Royal Society');
  assert.equal(fallback.abstract, 'Fallback abstract from OpenGraph.');
});

test('extractArticle extracts head bibliographic meta tags under browser-like invisible callback and excludes template/noscript', () => {
  const url = 'https://journal.example.org/papers/extension-meta';
  const html = `<!doctype html><html><head>
    <base href="https://journal.example.org/assets/">
    <title>Journal Site</title>
    <meta name="citation_title" content="Structured Attention for Long Contexts">
    <meta name="citation_author" content="Van der Waals, Johannes Diderik">
    <meta name="citation_author" content="AT&amp;T Research">
    <meta name="citation_journal_title" content="Journal of Machine Reading">
    <meta name="citation_publication_date" content="2024/05/12">
    <meta name="citation_publisher" content="Academic Press">
    <meta name="citation_doi" content="https://doi.org/10.1000/jmr.2024.09">
    <meta name="citation_abstract" content="Abstract captured in browser DOM.">
    <template><meta name="citation_title" content="Template Poison"><meta name="citation_author" content="Template Author"></template>
    <noscript><meta name="citation_title" content="Noscript Poison"><meta name="citation_publisher" content="Noscript Press"></noscript>
  </head><body>
    <template><meta name="citation_doi" content="10.9999/template"></template>
    <noscript><meta name="citation_doi" content="10.9999/noscript"></noscript>
    <article><h1>Structured Attention</h1><p>Body paragraph with sufficient text.</p><img src="fig.png" alt="Figure"></article>
  </body></html>`;

  const hiddenHeadTags = new Set(['head', 'meta', 'title', 'base', 'style', 'script']);
  const browserLikeTree = {
    ...htmlTree,
    invisible: (node: Parameters<typeof htmlTree.tag>[0]) => hiddenHeadTags.has(htmlTree.tag(node))
  };

  const serverArticle = parseWebArticle(html, url);
  const extensionArticle = extractArticle(parse(html, { scriptingEnabled: false }), browserLikeTree, url, '').article;

  assert.equal(extensionArticle.paperTitle, serverArticle.paperTitle);
  assert.equal(extensionArticle.authors, serverArticle.authors);
  assert.equal(extensionArticle.venue, serverArticle.venue);
  assert.equal(extensionArticle.year, serverArticle.year);
  assert.equal(extensionArticle.doi, serverArticle.doi);
  assert.equal(extensionArticle.publisher, serverArticle.publisher);
  assert.equal(extensionArticle.abstract, serverArticle.abstract);
  assert.equal(extensionArticle.paperTitle, 'Structured Attention for Long Contexts');
  assert.equal(extensionArticle.authors, 'Van der Waals, Johannes Diderik; AT&T Research');
  assert.equal(extensionArticle.articleLayout?.['p-3']?.image?.url, 'https://journal.example.org/assets/fig.png');

  const excludedMetaHtml = `<!doctype html><html><head>
    <template><meta name="citation_title" content="Template Title"><meta name="citation_doi" content="10.1000/tpl"></template>
    <noscript><meta name="citation_author" content="Noscript Author"><meta name="citation_publisher" content="Noscript Press"></noscript>
  </head><body>
    <template><meta name="citation_venue" content="Template Venue"></template>
    <noscript><meta name="citation_abstract" content="Noscript Abstract"></noscript>
    <article><h1>Visible Heading</h1><p>Visible content.</p></article>
  </body></html>`;
  const excludedResult = extractArticle(parse(excludedMetaHtml, { scriptingEnabled: false }), browserLikeTree, url, '').article;
  assert.equal(excludedResult.paperTitle, undefined);
  assert.equal(excludedResult.authors, undefined);
  assert.equal(excludedResult.doi, undefined);
  assert.equal(excludedResult.publisher, undefined);
  assert.equal(excludedResult.abstract, undefined);
});

test('parseAcademicInput classifies arXiv, DOI, URL, and rejects unsafe schemes or traversal', () => {
  assert.deepEqual(parseAcademicInput('2309.06180v2'), { kind: 'arxiv', id: '2309.06180', versionedId: '2309.06180v2', absUrl: 'https://arxiv.org/abs/2309.06180v2', pdfUrl: 'https://arxiv.org/pdf/2309.06180v2.pdf' });
  assert.equal(parseAcademicInput('arXiv:hep-th/9901001v1')?.kind, 'arxiv');
  assert.equal(parseAcademicInput('10.48550/arXiv.2309.06180')?.kind, 'arxiv');
  assert.equal(parseAcademicInput('https://arxiv.org/html/2309.06180')?.kind, 'url');
  assert.deepEqual(parseAcademicInput('doi:10.1145/3600006.3613165.'), { kind: 'doi', doi: '10.1145/3600006.3613165', url: 'https://doi.org/10.1145/3600006.3613165' });
  assert.deepEqual(parseAcademicInput('https://doi.org/10.1002/%28SICI%291097-4571'), { kind: 'doi', doi: '10.1002/(SICI)1097-4571', url: 'https://doi.org/10.1002/(SICI)1097-4571' });
  for (const bad of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.org/a', '10.1000/../secret', '10.1000/a\\b', 'plain words']) assert.equal(parseAcademicInput(bad), null);
});

test('openWebArticle resolves arXiv and DOI targets through local readResource with metadata merge and fallbacks', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-academic-intake-'));
  const routes = new Map<string, { status?: number; type: string; body: string | Buffer }>([
    ['/abs/2309.06180v1', { type: 'text/html', body: '<meta name="citation_title" content="PagedAttention"><meta name="citation_author" content="Kwon, Woosuk"><meta name="citation_date" content="2023/09/12"><article><p>Abstract body.</p></article>' }],
    ['/pdf/2309.06180v1.pdf', { type: 'application/pdf', body: Buffer.from('%PDF-1.7\narxiv-bytes') }],
    ['/abs/2401.00002', { type: 'text/html', body: '<meta name="citation_title" content="Fallback Abs"><article><p>Readable abs text.</p></article>' }],
    ['/pdf/2401.00002.pdf', { status: 404, type: 'text/plain', body: 'missing' }],
    ['/10.1000/pdf-land', { type: 'text/html', body: '<meta name="citation_title" content="Landing Title"><meta name="citation_pdf_url" content="https://pub.example/full.pdf"><article><p>Landing body.</p></article>' }],
    ['/full.pdf', { type: 'application/pdf', body: Buffer.from('%PDF-1.7\ndoi-pdf-bytes') }],
    ['/works/10.1000%2Fpdf-land', { type: 'application/json', body: JSON.stringify({ message: { title: ['Crossref Title'], author: [{ family: 'Ada', given: 'Lovelace' }], 'container-title': ['Proc. Test'], published: { 'date-parts': [[2024]] }, publisher: 'ACM', abstract: '<jats:p>Clean summary.</jats:p>' } }) }],
    ['/10.1000/paywall', { status: 403, type: 'text/html', body: 'Forbidden' }],
    ['/works/10.1000%2Fpaywall', { type: 'application/json', body: JSON.stringify({ message: { title: ['Open Crossref PDF'], link: [{ 'content-type': 'application/pdf', URL: 'https://pub.example/cr.pdf' }] } }) }],
    ['/cr.pdf', { type: 'application/pdf', body: Buffer.from('%PDF-1.7\ncr-pdf-bytes') }],
    ['/abs/2309.06182', { type: 'application/octet-stream', body: 'MAINTENANCE' }],
    ['/pdf/2309.06182.pdf', { type: 'application/pdf', body: Buffer.from('%PDF-1.7\narxiv-rescue') }],
    ['/10.1000/non-html', { type: 'application/octet-stream', body: 'NON-HTML' }],
    ['/works/10.1000%2Fnon-html', { type: 'application/json', body: JSON.stringify({ message: { title: ['Rescued DOI'], link: [{ 'content-type': 'application/pdf', URL: 'https://pub.example/cr.pdf' }] } }) }],
    ['/10.1000/gated', { type: 'text/html', body: '<meta name="citation_pdf_url" content="https://pub.example/gated.pdf"><article><p>Teaser.</p></article>' }],
    ['/gated.pdf', { status: 403, type: 'text/html', body: 'Paywall' }],
    ['/works/10.1000%2Fgated', { type: 'application/json', body: JSON.stringify({ message: { title: ['OA Fallback'], link: [{ 'content-type': 'application/pdf', URL: 'https://pub.example/oa.pdf' }] } }) }],
    ['/oa.pdf', { type: 'application/pdf', body: Buffer.from('%PDF-1.7\noa-pdf-bytes') }]
  ]);
  const server = createServer((req, res) => {
    const entry = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (!entry) { res.writeHead(404).end(); return; }
    res.writeHead(entry.status ?? 200, { 'content-type': entry.type }).end(entry.body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }); });
  const readLocal: ResourceReader = async raw => {
    const target = new URL(String(raw)), res = await fetch(`http://127.0.0.1:${addr.port}${target.pathname}${target.search}`);
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: 502 });
    return { url: target, type: (res.headers.get('content-type') || '').split(';')[0], bytes: Buffer.from(await res.arrayBuffer()) };
  };
  const library = new Library(root, readLocal);
  const arxivDoc = (await openWebArticle(library, '2309.06180v1', readLocal)).doc, absFallback = (await openWebArticle(library, '2401.00002', readLocal)).doc;
  assert.equal(arxivDoc.kind, 'pdf'); assert.equal(arxivDoc.paperTitle, 'PagedAttention'); assert.equal(arxivDoc.venue, undefined); assert.equal(arxivDoc.url, 'https://arxiv.org/abs/2309.06180v1');
  assert.equal(absFallback.kind, 'web'); assert.equal(absFallback.paperTitle, 'Fallback Abs');
  const doiPdf = (await openWebArticle(library, '10.1000/pdf-land', readLocal)).doc, crFallback = (await openWebArticle(library, '10.1000/paywall', readLocal)).doc;
  assert.equal(doiPdf.kind, 'pdf'); assert.equal(doiPdf.paperTitle, 'Landing Title'); assert.equal(doiPdf.authors, 'Ada, Lovelace'); assert.equal(doiPdf.doi, '10.1000/pdf-land'); assert.equal(doiPdf.year, '2024');
  assert.equal(crFallback.kind, 'pdf'); assert.equal(crFallback.paperTitle, 'Open Crossref PDF');
  assert.equal((await openWebArticle(library, '2309.06182', readLocal)).doc.kind, 'pdf'); assert.equal((await openWebArticle(library, '10.1000/non-html', readLocal)).doc.kind, 'pdf');
  const oaDoc = (await openWebArticle(library, '10.1000/gated', readLocal)).doc; assert.equal(oaDoc.kind, 'pdf'); assert.equal(oaDoc.paperTitle, 'OA Fallback');
});
