import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const bookRoot = 'https://openstax.org/books/principles-finance/pages/';
export const bookTitle = 'Principles of Finance';
export const cmsPath = '/apps/cms/api/books/principles-finance/';
export const cmsDetailPath = '/apps/cms/api/v2/pages/583/';
export const googleUrl = 'https://research.google/blog/empty-shelves-or-lost-keys-recall-is-the-bottleneck-for-parametric-factuality/';

export const sections = {
  start: { slug: '1-why-it-matters', title: 'Why It Matters' },
  first: { slug: '1-1-what-is-finance', title: '1.1 What Is Finance?' },
  second: { slug: '1-2-the-role-of-finance-in-an-organization', title: '1.2 The Role of Finance in an Organization' },
  third: { slug: '1-3-importance-of-data-and-technology', title: '1.3 Importance of Data and Technology' },
  otherChapter: { slug: '2-1-business-structures', title: '2.1 Business Structures' },
  far: { slug: '19-1-what-is-working-capital', title: '19.1 What Is Working Capital?' }
};
export const chapters = ['1 Introduction to Finance', '2 Corporate Structure and Governance',
  '19 The Importance of Trade Credit and Working Capital in Planning'];
export const fixturePassages = { first: 'Measure the whole transaction', second: 'The treasurer checks the calendar',
  otherChapter: 'Compare the two business structures', resume: 'The forecast begins with a sales estimate' };
export const fixtureBlog = { title: 'Reading an article about factual recall', noteQuote: 'The order of the question',
  wikiCaption: 'A fixture diagram shows the evaluation pipeline.', whyCaption: 'A fixture chart compares two query orders.' };

function chapter(slug: string, title: string, contents: {slug: string; title: string}[]) {
  return { slug, title, toc_type: 'chapter', contents };
}

const tree = { contents: [
  { slug: 'preface', title: 'Preface' },
  chapter('1-introduction-to-finance', chapters[0], [sections.start, sections.first, sections.second, sections.third]),
  chapter('2-corporate-structure-and-governance', chapters[1], [{ slug: '2-why-it-matters', title: 'Why It Matters' }, sections.otherChapter]),
  chapter('19-the-importance-of-trade-credit-and-working-capital-in-planning', chapters[2],
    [{ slug: '19-why-it-matters', title: 'Why It Matters' }, sections.far])
] };

function bookPage(slug: string, title: string): string {
  const parts: string[] = [];
  for (let index = 1; index <= 36; index++) {
    const opening = slug === sections.first.slug && index === 6 ? fixturePassages.first :
      slug === sections.second.slug && index === 8 ? fixturePassages.second :
      slug === sections.second.slug && index === 22 ? fixturePassages.resume :
      slug === sections.otherChapter.slug && index === 6 ? fixturePassages.otherChapter :
      'Worked example ' + index + ' for section ' + slug;
    parts.push(`<p id="example-${index}">${opening}. Observe how the dates and amounts affect the outcome of the example. Enter each change in the appropriate column. When the period ends, compare the total with the starting projection before deciding what to adjust.</p>`);
  }
  const state = { content: { book: { slug: 'principles-finance', title: bookTitle, tree },
    params: { book: { slug: 'principles-finance' }, page: { slug } } } };
  return `<!doctype html><html><head><title>${title} - ${bookTitle} | OpenStax</title></head><body>
    <main><div id="book-content" data-book-content="true" data-type="page"><h2>${title}</h2>${parts.join('')}</div>
    <div class="reader-footer">Fixture publisher tools</div></main>
    <script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script></body></html>`;
}

const articleDetails = (topic: string) => Array.from({ length: 18 }, (_, index) =>
  `<p>Example ${index + 1} illustrates ${topic}. Researchers record each query and compare the returned claim against a reference answer. The same expected fact must remain recoverable when the question is phrased differently.</p>`).join('');

export const fixtureGooglePage = `<!doctype html><html><head><title>${fixtureBlog.title}</title></head><body>
  <nav>Explore our many areas of focus</nav><main><article>
  <h1>${fixtureBlog.title}</h1><p>Can a model retrieve a fact it already learned?</p>
  <h2>Introducing WikiProfile</h2><p>The evaluation uses two different phrasings per fact.</p>
  <figure><img src="/book-reading-fixture-wiki.svg" alt="Two paths through the evaluation"><figcaption>${fixtureBlog.wikiCaption}</figcaption></figure>
  ${articleDetails('how the evaluation pipeline works')}
  <h2>Why does recall fail?</h2><p>${fixtureBlog.noteQuote} influences retrieval of information.</p>
  <figure><img src="/book-reading-fixture-recall.svg" alt="Two bars showing different recall rates"><figcaption>${fixtureBlog.whyCaption}</figcaption></figure>
  ${articleDetails('the effect of different prompts on recall')}
  </article><section><h2>Other posts of interest</h2><p>Read more publisher posts.</p></section></main>
  <footer>Privacy and Terms</footer></body></html>`;

const illustration = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="90" viewBox="0 0 300 90"><path d="M12 10h104v70H12z" fill="#146c94"/><path d="M144 10h144v70H144z" fill="#608f53"/></svg>';

export async function startPublisherFixture() {
  const server = createServer((request, response) => {
    const target = URL.parse(String(request.headers['x-reader-e2e-original-url'] ?? ''));
    if (!target || request.method !== 'GET') { response.writeHead(405).end(); return; }
    const send = (value: string, type = 'text/html; charset=utf-8') => response.writeHead(200, { 'Content-Type': type }).end(value);
    if (target.origin === 'https://research.google') {
      if (target.href === googleUrl) { send(fixtureGooglePage); return; }
      if (/^\/book-reading-fixture-(?:wiki|recall)\.svg$/.test(target.pathname)) { send(illustration, 'image/svg+xml'); return; }
    }
    if (target.origin === 'https://openstax.org') {
      if (target.pathname === cmsPath) { response.writeHead(302, { Location: cmsDetailPath }).end(); return; }
      if (target.pathname === cmsDetailPath) {
        send(JSON.stringify({ title: bookTitle, slug: 'principles-finance', webview_rex_link: bookRoot + sections.start.slug }), 'application/json');
        return;
      }
      const slug = target.href.slice(bookRoot.length);
      const item = tree.contents.flatMap(entry => 'contents' in entry ? entry.contents : [entry]).find(entry => entry.slug === slug);
      if (target.href.startsWith(bookRoot) && item) { send(bookPage(item.slug, item.title)); return; }
    }
    response.writeHead(404).end('No fixture at this publisher address.');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { origin: 'http://127.0.0.1:' + address.port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
