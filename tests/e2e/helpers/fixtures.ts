import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startJsonFixture } from '../integration-fixtures.js';
import { isRecord } from './reader.js';

export function closeServer(server: Server): Promise<void> {
  return new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}

export function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

export function assertZeroSqliteRows(dbPath: string, docId: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const prefix = docId + '\u001f';
    for (const table of ['entries', 'annotations', 'chat_exchanges', 'book_positions', 'pdf_outlines', 'article_captures']) {
      assert.equal(countRows(db, `SELECT COUNT(*) AS n FROM ${table} WHERE docId=?`, docId), 0, `${table} must have 0 rows`);
    }
    for (const table of ['notebook_documents', 'notebook_vaults', 'notebooks']) {
      assert.equal(countRows(db, `SELECT COUNT(*) AS n FROM ${table} WHERE docId=? OR substr(docId,1,?)=?`, docId, prefix.length, prefix), 0, `${table} must have 0 rows`);
    }
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM citations WHERE identity=?', 'document/' + docId), 0, 'citations must have 0 rows');
  } finally { db.close(); }
}

export function snapshotDocSqliteCounts(dbPath: string, docId: string): { entries: number; annotations: number; chats: number; notebooks: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      entries: countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', docId),
      annotations: countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', docId),
      chats: countRows(db, 'SELECT COUNT(*) AS n FROM chat_exchanges WHERE docId=?', docId),
      notebooks: countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=?', docId)
    };
  } finally { db.close(); }
}

export async function startCompositePublisher(openStaxOrigin: string, articles: Map<string, string>) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const html = articles.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); return; }
    const target = new URL(req.url ?? '/', openStaxOrigin);
    const proxy = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); });
    req.pipe(proxy);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return { origin: `http://127.0.0.1:${addr.port}`, close: () => closeServer(server) };
}

export async function startRichZoteroFixture(options?: { libraryId?: string; collectionName?: string; includePartial?: boolean }) {
  const credential = randomUUID(), libraryId = options?.libraryId ?? '884442', collectionKey = 'CITECL42';
  const richItem = {
    key: 'RICHZT42', version: 3, links: { alternate: { href: `https://www.zotero.org/groups/${libraryId}/items/RICHZT42` } },
    meta: { creatorSummary: 'Ada Lovelace and Charles Babbage' },
    data: { itemType: 'journalArticle', title: 'Analytical Engine Memory Tables', date: '2024-05-10',
      DOI: '10.1000/zotero.2024.42', url: 'https://journal.example.org/analytical-engine', collections: [collectionKey] }
  };
  const partialItem = {
    key: 'PARTZT33', version: 4, links: { alternate: { href: `https://www.zotero.org/groups/${libraryId}/items/PARTZT33` } },
    meta: { creatorSummary: 'Grace Hopper' },
    data: { itemType: 'journalArticle', title: 'Zotero Refined Title Without DOI', date: '2025', DOI: '', url: '', collections: [collectionKey] }
  };
  const items = options?.includePartial ? [richItem, partialItem] : [richItem];
  const byKey = new Map(items.map(item => [item.key, item]));
  const server = await startJsonFixture((req, url) => {
    if (req.headers['zotero-api-key'] !== credential || req.headers['zotero-api-version'] !== '3') return { status: 403 };
    const base = '/groups/' + libraryId;
    if (url.pathname === base + '/collections') {
      return { status: 200, headers: { 'Total-Results': '1' }, value: [{ key: collectionKey, data: { name: options?.collectionName ?? 'Test Refs', parentCollection: false } }] };
    }
    if (url.pathname === base + '/items/top') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const matched = q ? items.filter(item => item.data.title.toLowerCase().includes(q)) : items;
      return { status: 200, value: matched.length ? matched : items };
    }
    const itemMatch = new RegExp(`^${base}/items/([A-Z0-9]+)$`).exec(url.pathname);
    return itemMatch && byKey.has(itemMatch[1]) ? { status: 200, value: byKey.get(itemMatch[1]) } : { status: 404 };
  });
  return { ...server, credential, libraryId, richItem, partialItem };
}

export interface LlmCall { mode: 'blocks' | 'passage' | 'vision' | 'paper-chat'; target: string; hasValidPng: boolean; system: string; }

const DEFAULT_PREFIXES: Record<string, string> = {
  'Japanese': '日本語訳: ', 'French': 'Traduction française : ', 'German': 'Deutsche Übersetzung: ',
  'Spanish': 'Traducción al español: ', 'Korean': '한국어 번역: ', 'Portuguese': 'Tradução em português: ',
  'Brazilian Portuguese': 'Tradução PT-BR: ', 'Esperanto': 'Esperanta traduko: '
};

function sendCompletion(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }]
  }));
}

export async function startVersatileLlmFixture(model = 'e2e-llm-fixture') {
  const key = randomUUID(), calls: LlmCall[] = [];
  let failNextWith502 = 0, holdNext = false, abortedCount = 0;
  let heldArrived: (() => void) | null = null, releaseHold: (() => void) | null = null;
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(403).end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
    if (!isRecord(body) || body.model !== model || !Array.isArray(body.messages)) { res.writeHead(400).end(); return; }
    if (failNextWith502 > 0) {
      failNextWith502--;
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Upstream 502 transient error' } }));
      return;
    }
    const messages = body.messages.filter(isRecord);
    const system = String(messages.find(m => m.role === 'system')?.content ?? '');
    const lastUser = messages.filter(m => m.role === 'user').at(-1)?.content;
    const imgPart = Array.isArray(lastUser) ? lastUser.find(p => isRecord(p) && p.type === 'image_url') as { image_url?: { url?: string } } | undefined : undefined;
    const dataUrl = imgPart?.image_url?.url ?? '';
    const hasValidPng = dataUrl.startsWith('data:image/png;base64,') &&
      Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (holdNext) {
      holdNext = false;
      const target = /Use ([^.]+) by default/.exec(system)?.[1]?.trim() ?? 'Unknown';
      calls.push({ mode: hasValidPng ? 'vision' : 'passage', target, hasValidPng, system });
      heldArrived?.(); heldArrived = null;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15_000);
        releaseHold = () => { clearTimeout(timer); resolve(); };
        res.once('close', () => { if (!res.writableEnded) abortedCount++; clearTimeout(timer); resolve(); });
      });
      if (!req.destroyed && !res.writableEnded) sendCompletion(res, 'Released held reply.');
      return;
    }
    const blockMatch = /Translate each passage in full into ([^.]+)\./.exec(system);
    if (blockMatch) {
      const target = blockMatch[1].trim();
      calls.push({ mode: 'blocks', target, hasValidPng: false, system });
      const parsed = JSON.parse(typeof lastUser === 'string' ? lastUser : '') as { blocks: { id: string; text: string }[] };
      const translations = Object.fromEntries(parsed.blocks.map(block => {
        if (target === 'Simplified Chinese') return [block.id, '简体中文译文：分页注意力按需映射逻辑块与物理块。'];
        if (target === 'English') return [block.id, block.text];
        const prefix = DEFAULT_PREFIXES[target] ?? `[${target}] `;
        return [block.id, prefix + (block.text.length > 84 ? block.text.slice(0, 68) : block.text)];
      }));
      sendCompletion(res, JSON.stringify({ translations }));
      return;
    }
    const translateMatch = /Translate into ([^.]+)\./.exec(system);
    const target = (translateMatch?.[1] ?? /Use ([^.]+) by default/.exec(system)?.[1] ?? 'English').trim();
    const isPaperChat = !translateMatch && /full paper|entire paper|document/i.test(system);
    calls.push({ mode: hasValidPng ? 'vision' : isPaperChat ? 'paper-chat' : 'passage', target, hasValidPng, system });
    const content = hasValidPng && target === 'German' ? 'Deutsche Antwort: Die Abbildung zeigt die Blockzuordnung.'
      : hasValidPng ? '截图解析：块表将逻辑块映射到物理显存块，避免连续分配碎片。'
      : isPaperChat ? '全文分析：该方案通过虚拟块表消除键值缓存内部碎片并支持前缀共享。'
      : target === 'German' ? 'Deutsche Übersetzung: Der Speicherblock wird dynamisch zugewiesen.'
      : `[${target}] Contextual answer for selected passage.`;
    sendCompletion(res, content);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`, key, model, calls,
    setFailNextWith502: (n: number) => { failNextWith502 = n; },
    setHoldNext: (v: boolean) => { holdNext = v; },
    waitForHeldRequest: () => new Promise<void>(resolve => { heldArrived = resolve; }),
    releaseHeld: () => { releaseHold?.(); releaseHold = null; },
    getAbortedCount: () => abortedCount,
    close: () => closeServer(server)
  };
}
