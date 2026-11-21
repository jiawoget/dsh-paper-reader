import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

interface Reply { status: number; value?: unknown; headers?: Record<string, string> }
type Handler = (request: IncomingMessage, url: URL, body: unknown) => Reply;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function start(handle: Handler) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const input: Buffer[] = [];
      for await (const chunk of req) input.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const raw = Buffer.concat(input).toString('utf8');
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      const reply = handle(req, new URL(req.url ?? '/', 'http://localhost'), body);
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(reply.value === undefined ? undefined : JSON.stringify(reply.value));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test fixture did not bind a loopback port.');
  return {
    origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
export async function modelFixture(answer = 'The request receives free physical blocks as its logical KV cache grows.', expectedContext = 'KV') {
  const key = randomUUID();
  const model = 'local-reading-fixture';
  let completed = 0;
  const server = await start((req, url, body) => {
    if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') return { status: 404 };
    if (req.headers.authorization !== 'Bearer ' + key) return { status: 403 };
    if (!record(body) || body.model !== model || !Array.isArray(body.messages) || !JSON.stringify(body.messages).includes(expectedContext)) return { status: 400 };
    completed++;
    return { status: 200, value: { choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] } };
  });
  return { ...server, key, model, answer, completed: () => completed };
}
export async function zoteroFixture() {
  const credential = randomUUID();
  const libraryId = '884421';
  const itemKey = 'PAGED222';
  const existing = 'SYSTEMS2';
  const extra = 'ATTENTN2';
  const title = 'PagedAttention · integration fixture';
  const alternate = 'https://www.zotero.org/groups/' + libraryId + '/items/' + itemKey;
  const memberships = new Set([existing]);
  const newItems = new Map<string, Record<string, unknown>>();
  let version = 5;
  let updates = 0;
  let searches = 0;
  let creates = 0;
  const server = await start((req, url, body) => {
    if (req.headers['zotero-api-key'] !== credential || req.headers['zotero-api-version'] !== '3') return { status: 403 };
    const path = '/groups/' + libraryId;
    const item = () => ({ key: itemKey, version, links: { alternate: { href: alternate } }, data: {
      itemType: 'journalArticle', title, DOI: '10.1145/3600006.3613165', url: 'https://arxiv.org/abs/2309.06180', collections: [...memberships]
    } });
    if (url.pathname === path + '/collections') return { status: 200, headers: { 'Total-Results': '3' }, value: [
      { key: existing, data: { name: 'Systems papers', parentCollection: false } },
      { key: extra, data: { name: 'Attention mechanisms', parentCollection: false } },
      { key: 'DISTRIB2', data: { name: 'Distributed inference', parentCollection: false } }
    ] };
    if (url.pathname === path + '/items/top') { searches++; return { status: 200, value: [item(), ...newItems.values()] }; }
    if (url.pathname === path + '/items' && req.method === 'POST') {
      const proposed: unknown = Array.isArray(body) ? body[0] : undefined;
      if (!record(proposed) || typeof proposed.key !== 'string' || proposed.version !== 0 ||
          proposed.title !== 'Allocator companion (fixture)' || proposed.itemType !== 'webpage' ||
          !Array.isArray(proposed.collections) || !proposed.collections.includes(extra)) return { status: 400 };
      if (newItems.has(proposed.key)) return { status: 412 };
      const remote = { key: proposed.key, version: 6, data: proposed };
      newItems.set(proposed.key, remote); creates++;
      return { status: 200, value: { successful: { '0': remote }, unchanged: {}, failed: {} } };
    }
    const newlyCreated = newItems.get(url.pathname.split('/').at(-1) ?? '');
    if (newlyCreated && req.method === 'GET') return { status: 200, value: newlyCreated };
    if (url.pathname !== path + '/items/' + itemKey) return { status: 404 };
    if (req.method !== 'PATCH') return { status: 200, value: item() };
    if (req.headers['if-unmodified-since-version'] !== String(version)) return { status: 412 };
    if (!record(body) || !Array.isArray(body.collections) || !body.collections.includes(existing)) return { status: 400 };
    for (const key of body.collections) {
      if (key !== existing && key !== extra && key !== 'DISTRIB2') return { status: 400 };
      memberships.add(key);
    }
    updates++; version++;
    return { status: 204 };
  });
  return { ...server, credential, libraryId, title, alternate, counts: () => ({ creates, updates, searches }), collections: () => [...memberships] };
}
