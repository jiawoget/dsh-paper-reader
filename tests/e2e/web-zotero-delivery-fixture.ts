import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

export const fixtureCollection = 'PAPERS22';
export const fixturePdfTitle = 'PagedAttention from Zotero (fixture)';
const fixtureArticle = {
  title: 'Reading a systems experiment',
  section: 'Sizing the cache',
  quote: 'A cache block holds the state for several consecutive tokens.'
};

export async function startLibraryFixture() {
  const originalPdf = await readFile(new URL('../../public/assets/pagedattention.pdf', import.meta.url));
  // Keep the real PDF's page content but make the attachment distinguishable from the bundled sample.
  const pdf = Buffer.concat([originalPdf, Buffer.from('\n% Zotero delivery attachment fixture\n')]);
  const collections = [
    { key: 'SYSTEMS2', data: { name: 'Systems', parentCollection: false } },
    { key: fixtureCollection, data: { name: 'Papers', parentCollection: 'SYSTEMS2' } }
  ];
  const key = 'DELPAPR2', fileKey = 'DELFILE2', item = {
    key, version: 1, library: { type: 'user', id: 0 },
    links: { alternate: { href: 'https://www.zotero.org/users/0/items/' + key } },
    data: { key, itemType: 'conferencePaper', title: fixturePdfTitle, date: '2023', collections: [fixtureCollection],
      creators: [{ creatorType: 'author', firstName: 'Woosuk', lastName: 'Kwon' }] },
    meta: { numChildren: 1 }
  };
  const attachment = {
    key: fileKey, version: 1, library: { type: 'user', id: 0 },
    data: { key: fileKey, parentItem: key, itemType: 'attachment', linkMode: 'imported_file', contentType: 'application/pdf',
      filename: 'pagedattention.pdf', title: 'Full Text PDF' }
  };
  const article = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${fixtureArticle.title}</title>
  <nav><a href="/">Publisher navigation</a></nav><main><article><h1>${fixtureArticle.title}</h1>
  <p>As a request grows, the system can add blocks to its attention cache.</p><h2 id="cache">${fixtureArticle.section}</h2>
  <p>${fixtureArticle.quote} Free blocks can be assigned as requests arrive or grow.</p>
  <h2 id="measure">Measuring throughput</h2><p>Compare batches of different lengths so fragmentation appears in the benchmark.</p>
  </article></main><footer>Publisher footer</footer></html>`;

  const requests: { method: string; path: string }[] = [];
  let populated = false, closed = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/systems' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(article);
      return;
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404).end(); return; }
    requests.push({ method: req.method || '', path: url.pathname });
    const headers = { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'delivery-fixture' };
    const json = (value: unknown) => {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json',
        ...(Array.isArray(value) ? { 'Total-Results': String(value.length) } : {}) }).end(JSON.stringify(value));
    };
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    if (url.pathname === '/api/') { json({}); return; }
    const prefix = '/api/users/0';
    if (url.pathname === prefix + '/collections') { json(collections); return; }
    if ([prefix + '/items/top', prefix + '/collections/' + fixtureCollection + '/items/top'].includes(url.pathname)) {
      const query = (url.searchParams.get('q') || '').toLowerCase();
      json(populated && item.data.title.toLowerCase().includes(query) ? [item] : []);
      return;
    }
    if (url.pathname === prefix + '/items/' + key) { json(item); return; }
    if (url.pathname === prefix + '/items/' + key + '/children') { json([attachment]); return; }
    if (url.pathname === prefix + '/items/' + fileKey) { json(attachment); return; }
    if (url.pathname === prefix + '/items/' + fileKey + '/file') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length) }).end(pdf);
      return;
    }
    res.writeHead(404, headers).end();
  });
  // Never send this fixture's test traffic to an existing Zotero Desktop installation.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    origin: 'http://127.0.0.1:' + address.port,
    article: { ...fixtureArticle, url: 'http://reader-delivery.test:' + address.port + '/systems' },
    requests,
    filePath: '/api/users/0/items/' + fileKey + '/file',
    populate: () => { populated = true; },
    assertReadOnly: () => assert.ok(requests.length && requests.every(request => request.method === 'GET'),
      'Browsing and opening must use GET requests only'),
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  };
}
