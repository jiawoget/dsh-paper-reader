import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Library } from '../src/server/library.js';
import { publicAddress, publicResource } from '../src/server/public-resource.js';
import { parseWebArticle } from '../src/server/web-article.js';

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
