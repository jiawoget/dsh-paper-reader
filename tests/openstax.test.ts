import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStaxLocation, openStaxUrl } from '../src/shared/openstax.js';
import { Library } from '../src/server/library.js';
import { parseOpenStaxPage, type ReadBookResource } from '../src/server/openstax.js';
import { openWebArticle } from '../src/server/web-article.js';

const slug = 'principles-finance';
const rootUrl = openStaxUrl(slug);
const entry = '1-why-it-matters';
const near = '1-1-what-is-finance';
const far = '20-2-commodity-price-risk';
const cms = 'https://openstax.org/apps/cms/api/books/' + slug + '/';

// Reduced REX structures from https://openstax.org/books/principles-finance/pages/1-1-what-is-finance.
// Body prose, illustration payloads and the smaller table of contents are fixtures.
const numberTitle = (number: string, text: string) =>
  '<span class="os-number">' + number + '</span><span class="os-divider"> </span><span class="os-text">' + text + '</span>';
const tree = { contents: [
  { slug: 'preface', title: 'Preface' },
  { slug: '1-introduction-to-finance', toc_type: 'chapter', title: numberTitle('1', 'Introduction to Finance'), contents: [
    { slug: entry, title: 'Why It Matters' }, { slug: near, title: numberTitle('1.1', 'What Is Finance?') }
  ] },
  { slug: '20-risk-management', toc_type: 'chapter', title: numberTitle('20', 'Risk Management'), contents: [
    { slug: far, title: numberTitle('20.2', 'Commodity Price Risk') }
  ] },
  { slug: 'index', title: 'Index' }
] };
const license = { name: 'Creative Commons Attribution-NonCommercial-ShareAlike License', url: 'http://creativecommons.org/licenses/by-nc-sa/4.0/' };
function sectionHtml(section: string): string {
  const state = { content: { params: { page: { slug: section } }, book: { slug, title: 'Principles of Finance', tree, license,
    authors: [{ value: { name: 'Julie Dahlquist', senior_author: true } }, { value: { name: 'Rainford Knight', senior_author: true } }] } } };
  return '<title>Publisher reader</title><script>window.__PRELOADED_STATE__ = ' + JSON.stringify(state) + ';</script>' +
    '<nav>Contents menu</nav><main><div id="main-content"><div data-type="page" data-book-content="true">' +
    '<h2>Section ' + section + '</h2><section id="sect-00001"><h3>Learning Outcomes</h3>' +
    '<p id="para-00001">A passage in ' + section + '.</p><div id="fig-00001" class="os-figure"><figure>' +
    '<button class="image-button-wrapper"><img src="/resources/' + section + '.png" alt="A chart"></button>' +
    '<figcaption>Chart caption</figcaption></figure></div></section></div>' +
    '<div data-type="footnote-refs"><h3>Footnotes</h3><ul><li id="foot-00001">Source note.</li></ul></div></div></main>' +
    '<details data-testid="attribution-details"><p>Access for free at <a href="' + rootUrl + entry + '">' + rootUrl + entry +
    '</a></p></details><footer>Back to library</footer>';
}
const resource = (source: string) => ({ bytes: Buffer.from(source) });
function publisher(calls: string[]): ReadBookResource {
  return async (url, kind) => {
    calls.push(url);
    if (kind === 'json') { assert.equal(url, cms); return resource(JSON.stringify({ webview_rex_link: rootUrl + entry })); }
    const section = openStaxLocation(url)?.section;
    assert.ok(section);
    return resource(sectionHtml(section));
  };
}

test('OpenStax sections retain source anchors, wrapped figures, footnotes, authors and the published attribution', () => {
  const { article, catalog } = parseOpenStaxPage(sectionHtml(near), slug, near, true);
  assert.equal(catalog?.title, 'Principles of Finance');
  assert.equal(catalog?.authors, 'Julie Dahlquist, Rainford Knight');
  assert.equal(catalog?.defaultPage, 2);
  assert.equal(catalog?.book.sections.length, 5);
  assert.deepEqual(catalog?.book.sections[2], { slug: near, title: '1.1 What Is Finance?', chapterId: '1-introduction-to-finance',
    chapterTitle: '1 Introduction to Finance', url: rootUrl + near });
  assert.equal(article.articleLayout?.['p-2'].kind, 'h3');
  assert.deepEqual(article.articleLayout?.['p-4'], { kind: 'image', image: { url: 'https://openstax.org/resources/' + near + '.png', alt: 'A chart' }, ids: ['fig-00001'] });
  assert.deepEqual(article.articleLayout?.['p-7'].ids, ['foot-00001']);
  assert.equal(article.paragraphs.includes('Contents menu'), false);
  assert.equal(article.paragraphs.includes('Back to library'), false);
  const attribution = article.articleLayout?.['p-8'];
  assert.equal(attribution?.kind, 'byline');
  assert.deepEqual(attribution?.spans?.map(span => span.value), [rootUrl + entry, license.url]);
  assert.throws(() => parseOpenStaxPage(sectionHtml(far), slug, near, false), /requested book section/);
});

test('a root resolves the published first section once; a reopened root and book listing need only metadata', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-openstax-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [], library = new Library(root, publisher(calls));
  const [opened, details] = await Promise.all([openWebArticle(library, rootUrl), openWebArticle(library, 'https://openstax.org/details/books/' + slug)]);
  assert.deepEqual(opened, details);
  assert.deepEqual(calls, [cms, rootUrl + entry]);
  assert.equal(opened.page, undefined);
  assert.equal(opened.doc.paragraphs, undefined);
  assert.equal(opened.doc.url, rootUrl);
  const initial = await library.bookSection(opened.doc.id, opened.doc.defaultPage!);
  assert.equal(initial.sectionPage, 2);
  assert.equal(initial.url, rootUrl + entry);
  assert.deepEqual(calls, [cms, rootUrl + entry]);
  const offline = new Library(root, async () => { throw Error('offline'); });
  assert.deepEqual((await openWebArticle(offline, rootUrl)).doc, opened.doc);
  const directory = path.join(root, 'documents', 'book-sections', opened.doc.id);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  await writeFile(path.join(directory, files[0]), '{damaged');
  const listed = (await offline.list()).find(doc => doc.id === opened.doc.id);
  assert.deepEqual(listed, opened.doc);
  assert.deepEqual((await openWebArticle(offline, rootUrl)).doc, opened.doc);
});

test('deep links download only their section and pin bookmarks, translations and images to that section across restarts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-openstax-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [], library = new Library(root, publisher(calls));
  const opened = await openWebArticle(library, rootUrl + near + '?utm_source=test#fig-00001');
  assert.match(opened.doc.id, /^book-[a-f\d]{64}$/);
  assert.equal(opened.doc.title, 'Principles of Finance');
  assert.equal(opened.page, 3);
  assert.equal(opened.anchor, 'p-4');
  assert.equal(opened.doc.url, rootUrl + near);
  const id = opened.doc.id;
  const fromExtension = await library.importWebDocument({ url: rootUrl + near + '#fig-00001', paragraphs: ['Browser snapshot'] });
  assert.deepEqual(fromExtension, opened);
  const pages = await Promise.all([library.bookSection(id, 4), openWebArticle(library, rootUrl + far).then(result => result.doc)]);
  assert.deepEqual(pages[0], pages[1]);
  assert.deepEqual(calls, [rootUrl + near, rootUrl + far]);
  assert.ok(pages[0].paragraphs?.some(p => p === 'A passage in ' + far + '.'));
  await assert.rejects(library.bookSection(id, 99), /Unknown book section/);
  await assert.rejects(openWebArticle(library, rootUrl + 'missing-section'), /not in the saved/);
  await assert.rejects(library.articleImage(id, 'p-4', async () => { throw Error('unexpected download'); }), /section number/);
  const image = async (url: string) => ({ type: 'image/png', bytes: Buffer.from(url) });
  for (const page of [3, 4]) {
    const picture = await library.articleImage(id, 'p-4', image, page);
    assert.equal(picture.bytes.toString(), 'https://openstax.org/resources/' + (page === 3 ? near : far) + '.png');
    await library.translate(id, page, [{ id: 'p-3', text: 'Source' }], async () => ({ 'p-3': 'Translation ' + page }));
  }
  const offline = new Library(root, async () => { throw Error('offline'); });
  assert.deepEqual(await openWebArticle(offline, rootUrl + near + '#fig-00001'), opened);
  assert.equal((await openWebArticle(offline, rootUrl)).page, undefined);
  assert.deepEqual(await offline.translations(id, 3), { 'p-3': 'Translation 3' });
  assert.deepEqual(await offline.translations(id, 4), { 'p-3': 'Translation 4' });
  assert.ok((await offline.articleImage(id, 'p-4', async () => { throw Error('offline'); }, 4)).bytes.toString().includes(far));
  assert.deepEqual(calls, [rootUrl + near, rootUrl + far]);
});

test('failed book import leaves no library entry and a failed section load can be retried', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-openstax-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let available = false;
  const source = publisher([]);
  const library = new Library(root, async (url, kind) => {
    if (!available) throw Error('publisher offline');
    return source(url, kind);
  });
  await assert.rejects(openWebArticle(library, rootUrl + near), /publisher offline/);
  assert.equal((await library.list()).filter(doc => doc.book).length, 0);
  available = true;
  const { doc } = await openWebArticle(library, rootUrl + near);
  available = false;
  await assert.rejects(library.bookSection(doc.id, 4), /publisher offline/);
  available = true;
  assert.equal((await library.bookSection(doc.id, 4)).url, rootUrl + far);
  assert.equal(openStaxLocation('https://openstax.org.example.com/books/' + slug), undefined);
  assert.equal(openStaxLocation('https://reader@openstax.org/books/' + slug), undefined);
  assert.equal(openStaxLocation(rootUrl + 'a%2Fb'), undefined);
});
