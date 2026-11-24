import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium, type APIRequestContext, type BrowserContext, type Download, type Locator, type Page } from 'playwright-core';
import type { DocumentInfo } from '../../src/shared/types.js';
import { bookRoot, sections, startPublisherFixture } from './book-reading-fixture.js';
import { cardElement, clickCard, openToolbar, until } from './extension-controls.js';
import { withHost, type HostFixture } from './host.js';
import { startJsonFixture } from './integration-fixtures.js';
import { dragBox } from './selection-gestures.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const extensionDir = path.join(projectRoot, 'dist/extension');
const zoteroPreload = new URL('./integration-zotero-preload.ts', import.meta.url).href;
const publisherPreload = new URL('./book-reading-preload.ts', import.meta.url).href;
const appPath = '/api/paper-reader/app/index.html';

interface ColorMetrics {
  fg: string;
  bg: string;
  fgLum: number;
  bgLum: number;
  ratio: number;
  fontSize: number;
  colorScheme: string;
}

interface ErrorScope {
  allowZotero503: boolean;
}

const CONTRAST_HELPER = `
function parseCssColor(raw) {
  if (!raw || raw === 'transparent') return [0, 0, 0, 0];
  const srgb = /color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/.exec(raw);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] !== undefined ? Number(srgb[4]) : 1];
  const rgba = /rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,/\\s]+([\\d.]+%?))?\\s*\\)/.exec(raw);
  if (!rgba) return [0, 0, 0, 1];
  let a = 1;
  if (rgba[4] !== undefined) a = rgba[4].endsWith('%') ? parseFloat(rgba[4]) / 100 : Number(rgba[4]);
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), a];
}
function composite(top, bottom) {
  const a = top[3], outA = a + bottom[3] * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  return [
    (top[0] * a + bottom[0] * bottom[3] * (1 - a)) / outA,
    (top[1] * a + bottom[1] * bottom[3] * (1 - a)) / outA,
    (top[2] * a + bottom[2] * bottom[3] * (1 - a)) / outA,
    outA
  ];
}
function relLum(rgb) {
  const c = v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * c(rgb[0]) + 0.7152 * c(rgb[1]) + 0.0722 * c(rgb[2]);
}
function contrastRatio(a, b) {
  const l1 = Math.max(a, b), l2 = Math.min(a, b);
  return (l1 + 0.05) / (l2 + 0.05);
}
function effectiveBg(el) {
  const layers = [];
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    layers.push(parseCssColor(getComputedStyle(cur).backgroundColor));
  }
  const darkRoot = document.documentElement.dataset.theme === 'dark' ||
    getComputedStyle(document.documentElement).colorScheme.includes('dark');
  let acc = darkRoot ? [19, 22, 31, 1] : [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i][3] > 0) acc = composite(layers[i], acc);
  }
  return acc;
}
function measureElement(el) {
  const style = getComputedStyle(el);
  const bg = effectiveBg(el);
  const fgRaw = parseCssColor(style.color);
  const fg = fgRaw[3] < 1 ? composite(fgRaw, bg) : fgRaw;
  const fgLum = relLum(fg), bgLum = relLum(bg);
  return {
    fg: style.color,
    bg: 'rgb(' + Math.round(bg[0]) + ', ' + Math.round(bg[1]) + ', ' + Math.round(bg[2]) + ')',
    fgLum, bgLum,
    ratio: contrastRatio(fgLum, bgLum),
    fontSize: parseFloat(style.fontSize) || 0,
    colorScheme: style.colorScheme
  };
}
`;

const ZH_ENGLISH_ALLOWLIST = new Set([
  'bibtex', 'ris', 'bib', 'doi', 'arxiv', 'obsidian', 'zotero', 'dsh', 'pdf', 'url', 'markdown',
  'openstax', 'html', 'api', 'http', 'https', 'ocr', 'ctrl', 'cmd', 'shift', 'alt', 'esc',
  'enter', 'home', 'end', 'pagedattention', 'sosp', 'kwon', 'paper', 'reader', 'vllm', 'token',
  'efficient', 'management', 'large', 'language', 'model', 'serving', 'with',
  'woosuk', 'et', 'al', 'key', 'value', 'kv'
]);
const BANNED_EN_RE = /\b(?:Annotations|Paper conversation|Paper discussion|Reading notebook|Notebook)\b/i;
const BANNED_ZH_RE = /(?:阅读笔记本|笔记本|批注索引|批注|Obsidian\s*仓库|已存入仓库|存入仓库)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function measureLocator(locator: Locator): Promise<ColorMetrics> {
  return locator.evaluate((el, helper) => {
    const fn = new Function('el', helper + '\nreturn measureElement(el);') as (node: Element) => ColorMetrics;
    return fn(el);
  }, CONTRAST_HELPER);
}

async function assertDarkAndContrast(locator: Locator, label: string, maxBgLum = 0.12, minRatio = 4.5): Promise<ColorMetrics> {
  const m = await measureLocator(locator);
  assert.ok(m.bgLum <= maxBgLum, `${label}: expected dark bg lum <= ${maxBgLum}, got ${m.bgLum.toFixed(4)} (${m.bg})`);
  assert.ok(m.ratio >= minRatio, `${label}: expected contrast >= ${minRatio}:1, got ${m.ratio.toFixed(2)}:1 (fg=${m.fg}, bg=${m.bg})`);
  return m;
}

async function collectChromeStrings(page: Page): Promise<{ text: string; source: string }[]> {
  return page.evaluate(() => {
    const excluded = '.pdf-sheet, .pdf-reading-text p, .pdf-reading-text h2, .meaning, #card blockquote, .web-reading-sheet, .cm-content, .quote, .selection-excerpt blockquote, .selection-heading h2, #docTitle, #docMeta, #railBody h1, .list-row strong, .toc-entry, .toc-fold, .paper-answer, .selection-answer, .library-row-text strong, .library-row-text small, .doc-row strong, .doc-row small, #sourceInfo';
    const items: { text: string; source: string }[] = [];
    const seen = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest(excluded)) continue;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'SVG' || el.closest('svg')) continue;
      const hidden = el.closest('[hidden]') && !el.closest('dialog[open]');
      const idTag = el.id ? '#' + el.id : el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : el.tagName.toLowerCase();
      const candidates: [string | null | undefined, string][] = [
        [el.getAttribute('aria-label'), `${idTag}[aria-label]`],
        [el.getAttribute('title'), `${idTag}[title]`],
        [el.getAttribute('placeholder'), `${idTag}[placeholder]`]
      ];
      if (!hidden) {
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) candidates.push([child.textContent, `${idTag}:text`]);
        }
      }
      for (const [raw, source] of candidates) {
        const value = (raw ?? '').replace(/\s+/gu, ' ').trim();
        if (!value) continue;
        const key = source + '|' + value;
        if (!seen.has(key)) { seen.add(key); items.push({ text: value, source }); }
      }
    }
    return items;
  });
}

function assertNoZhEnglishLeaks(items: { text: string; source: string }[], label: string): void {
  const leaks: string[] = [];
  for (const item of items) {
    assert.equal(item.text.match(BANNED_ZH_RE), null, `[${label}] Banned ZH term in ${item.source}: ${JSON.stringify(item.text)}`);
    const bad = (item.text.match(/[A-Za-z]{3,}/g) ?? []).filter(w => !ZH_ENGLISH_ALLOWLIST.has(w.toLowerCase()));
    if (bad.length) leaks.push(`${item.source}: "${item.text}" -> [${bad.join(', ')}]`);
  }
  assert.deepEqual(leaks, [], `[${label}] Untranslated English in zh-CN:\n${leaks.join('\n')}`);
}

function assertNoEnBannedTerms(items: { text: string; source: string }[], label: string): void {
  const bad = items.filter(item => BANNED_EN_RE.test(item.text)).map(item => `${item.source}: "${item.text}"`);
  assert.deepEqual(bad, [], `[${label}] Banned EN drift terms:\n${bad.join('\n')}`);
}

function attachErrorGuards(page: Page, tag: string, scope: ErrorScope, pageErrors: string[], consoleErrors: string[]): void {
  page.setDefaultTimeout(12_000);
  page.on('pageerror', err => pageErrors.push(`${tag}: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const url = msg.location().url;
    if (url.endsWith('/favicon.ico')) return;
    if (scope.allowZotero503 && text.includes('503') && url.endsWith('/api/paper-reader/action')) return;
    consoleErrors.push(`${tag}: ${text} (${url})`);
  });
}

async function rpc<T = Record<string, unknown>>(
  request: APIRequestContext,
  origin: string,
  op: string,
  payload: Record<string, unknown> = {}
): Promise<{ status: number; body: T }> {
  const res = await request.post(origin + '/api/paper-reader/action', {
    headers: { 'content-type': 'application/json' },
    data: { op, payload }
  });
  const text = await res.text();
  try {
    return { status: res.status(), body: JSON.parse(text) as T };
  } catch {
    throw new Error(`RPC ${op} returned HTTP ${res.status()} non-JSON: ${text.slice(0, 120)}`);
  }
}

async function authContext(ctx: BrowserContext, host: HostFixture): Promise<void> {
  const res = await ctx.request.get(host.authenticatedUrl);
  assert.ok(res.ok(), `Failed to authenticate context: HTTP ${res.status()}`);
}

async function resetSettings(request: APIRequestContext, origin: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await rpc(request, origin, 'settings.save', {
    baseUrl: '',
    model: 'deepseek-flash',
    clearApiKey: overrides.apiKey === undefined,
    targetLanguage: 'Simplified Chinese',
    vaultPath: '',
    zoteroMode: 'desktop',
    zoteroLibraryId: '',
    clearZoteroKey: overrides.zoteroApiKey === undefined,
    ...overrides
  });
  assert.equal(res.status, 200, 'resetSettings failed: HTTP ' + res.status);
}

async function openReaderPage(
  context: BrowserContext,
  host: HostFixture,
  query: string,
  tag: string,
  scope: ErrorScope,
  pageErrors: string[],
  consoleErrors: string[]
): Promise<Page> {
  const page = await context.newPage();
  attachErrorGuards(page, tag, scope, pageErrors, consoleErrors);
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
  await page.goto(host.origin + appPath + query, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 25_000 });
  return page;
}

async function readDownload(download: Download): Promise<{ filename: string; text: string }> {
  const filename = download.suggestedFilename();
  const filePath = await download.path();
  assert.ok(filePath, `Missing download path for ${filename}`);
  return { filename, text: await readFile(filePath, 'utf8') };
}

async function makePdf(context: BrowserContext, title: string, paragraphs: string[]): Promise<Buffer> {
  const builder = await context.newPage();
  try {
    await builder.setContent(
      `<style>@page{size:letter;margin:1in}body{font:15pt Georgia;line-height:1.5}</style>` +
      `<h1>${title}</h1>` + paragraphs.map(p => `<p>${p}</p>`).join('')
    );
    return Buffer.from(await builder.pdf({ preferCSSPageSize: true }));
  } finally {
    await builder.close();
  }
}

async function selectFirstPdfRun(page: Page): Promise<void> {
  const firstRun = page.locator('#original .pdf-native-text [data-block-id]').first();
  await firstRun.waitFor({ state: 'visible' });
  const blockId = await firstRun.getAttribute('data-block-id');
  assert.ok(blockId, 'Expected PDF native text block ID');
  await page.locator(`#original .pdf-native-text [data-block-id="${blockId}"]`).evaluateAll(elements => {
    const start = elements[0]?.firstChild;
    let end = start;
    for (const node of elements) {
      if (node.firstChild instanceof Text) end = node.firstChild;
    }
    if (!(start instanceof Text) || !(end instanceof Text)) throw new Error('Missing PDF source text runs.');
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    elements[0].dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  });
}

async function saveTargetLanguage(page: Page, target: string, options?: { custom?: boolean; baseUrl?: string; model?: string; apiKey?: string }): Promise<void> {
  await page.locator('#more').click();
  await page.locator('#menu').getByRole('button', { name: /^(Connections|连接设置)$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  if (options?.baseUrl !== undefined) await dialog.getByLabel('API base URL').fill(options.baseUrl);
  if (options?.model !== undefined) await dialog.getByLabel('Model', { exact: true }).fill(options.model);
  if (options?.apiKey !== undefined) await dialog.getByLabel('API key', { exact: true }).fill(options.apiKey);
  const select = dialog.getByRole('combobox', { name: 'Translation language', exact: true });
  if (options?.custom) {
    await select.selectOption('__custom__');
    const customInput = dialog.getByLabel('Custom target language', { exact: true });
    await customInput.waitFor({ state: 'visible' });
    await customInput.fill(target);
  } else {
    await select.selectOption(target);
  }
  await dialog.getByRole('button', { name: 'Save connections', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

function assertZeroSqliteRows(dbPath: string, docId: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const prefix = docId + '\u001f';
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', docId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', docId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM chat_exchanges WHERE docId=?', docId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=? OR substr(docId,1,?)=?', docId, prefix.length, prefix), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_vaults WHERE docId=? OR substr(docId,1,?)=?', docId, prefix.length, prefix), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebooks WHERE docId=? OR substr(docId,1,?)=?', docId, prefix.length, prefix), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM book_positions WHERE docId=?', docId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM pdf_outlines WHERE docId=?', docId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM article_captures WHERE docId=?', docId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM citations WHERE identity=?', 'document/' + docId), 0);
  } finally {
    db.close();
  }
}

async function startCompositePublisher(openStaxOrigin: string, articles: Map<string, string>) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const html = articles.get(pathname);
    if (html) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
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

async function startRichZoteroFixture() {
  const credential = randomUUID();
  const libraryId = '884432';
  const richKey = 'RICHZT32';
  const collectionKey = 'CITECL32';
  const richItem = {
    key: richKey,
    version: 3,
    links: { alternate: { href: `https://www.zotero.org/groups/${libraryId}/items/${richKey}` } },
    meta: { creatorSummary: 'Ada Lovelace and Charles Babbage' },
    data: {
      itemType: 'journalArticle',
      title: 'Analytical Engine Memory Tables',
      date: '2024-05-10',
      DOI: '10.1000/zotero.2024.42',
      url: 'https://journal.example.org/analytical-engine',
      collections: [collectionKey]
    }
  };
  const server = await startJsonFixture((req, url) => {
    if (req.headers['zotero-api-key'] !== credential || req.headers['zotero-api-version'] !== '3') return { status: 403 };
    const base = '/groups/' + libraryId;
    if (url.pathname === base + '/collections') {
      return { status: 200, headers: { 'Total-Results': '1' }, value: [{ key: collectionKey, data: { name: 'Tier3 Refs', parentCollection: false } }] };
    }
    if (url.pathname === base + '/items/top') return { status: 200, value: [richItem] };
    if (url.pathname === base + '/items/' + richKey) return { status: 200, value: richItem };
    return { status: 404 };
  });
  return { ...server, credential, libraryId, richItem };
}

interface LlmCall {
  mode: 'blocks' | 'passage' | 'vision' | 'paper-chat';
  target: string;
  hasValidPng: boolean;
  system: string;
}

async function startVersatileLlmFixture() {
  const key = randomUUID();
  const model = 'tier3-llm-fixture';
  const calls: LlmCall[] = [];
  let holdNext = false;
  let abortedCount = 0;
  let heldArrived: (() => void) | null = null;
  let releaseHold: (() => void) | null = null;

  const prefixByTarget: Record<string, string> = {
    'Japanese': '日本語訳: ',
    'French': 'Traduction française : ',
    'German': 'Deutsche Übersetzung: ',
    'Spanish': 'Traducción al español: ',
    'Italian': 'Traduzione italiana: '
  };

  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(403).end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
    if (!isRecord(body) || body.model !== model || !Array.isArray(body.messages)) { res.writeHead(400).end(); return; }

    const messages = body.messages.filter(isRecord);
    const system = String(messages.find(m => m.role === 'system')?.content ?? '');
    const lastUser = messages.filter(m => m.role === 'user').at(-1)?.content;

    let hasValidPng = false;
    if (Array.isArray(lastUser)) {
      const imgPart = lastUser.find(p => isRecord(p) && p.type === 'image_url') as { image_url?: { url?: string } } | undefined;
      const dataUrl = imgPart?.image_url?.url ?? '';
      if (dataUrl.startsWith('data:image/png;base64,')) {
        const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
        hasValidPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      }
    }

    if (holdNext) {
      holdNext = false;
      const target = /Use ([^.]+) by default/.exec(system)?.[1]?.trim() ?? 'Unknown';
      calls.push({ mode: hasValidPng ? 'vision' : 'passage', target, hasValidPng, system });
      heldArrived?.();
      heldArrived = null;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15_000);
        releaseHold = () => { clearTimeout(timer); resolve(); };
        res.once('close', () => {
          if (!res.writableEnded) abortedCount++;
          clearTimeout(timer);
          resolve();
        });
      });
      if (req.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Released held reply.' } }]
      }));
      return;
    }

    const blockMatch = /Translate each passage in full into ([^.]+)\./.exec(system);
    if (blockMatch) {
      const target = blockMatch[1].trim();
      calls.push({ mode: 'blocks', target, hasValidPng: false, system });
      const userStr = typeof lastUser === 'string' ? lastUser : '';
      const parsed = JSON.parse(userStr) as { blocks: { id: string; text: string }[] };
      const translations = Object.fromEntries(parsed.blocks.map(block => {
        if (target === 'Simplified Chinese') return [block.id, '简体中文译文：系统高效管理键值块内存。'];
        const prefix = prefixByTarget[target] ?? `[${target}] `;
        const snippet = block.text.length > 90 ? block.text.slice(0, 72) : block.text;
        return [block.id, prefix + snippet];
      }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ translations }) } }]
      }));
      return;
    }

    const translateMatch = /Translate into ([^.]+)\./.exec(system);
    const defaultMatch = /Use ([^.]+) by default/.exec(system);
    const target = (translateMatch?.[1] ?? defaultMatch?.[1] ?? 'English').trim();
    const isPaperChat = system.toLowerCase().includes('full paper') || system.toLowerCase().includes('entire paper') || system.toLowerCase().includes('document');
    calls.push({ mode: hasValidPng ? 'vision' : isPaperChat ? 'paper-chat' : 'passage', target, hasValidPng, system });

    let content = 'Paper chat answer: block tables map logical KV blocks to physical blocks.';
    if (hasValidPng && target === 'German') content = 'Deutsche Antwort: Die Abbildung zeigt die Blockzuordnung.';
    else if (target === 'Japanese') content = '日本語訳: メモリアロケータはブロックを動的に割り当てます。';
    else if (target === 'German') content = 'Deutsche Übersetzung: Der Speicherblock wird dynamisch zugewiesen.';

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }]
    }));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    key,
    model,
    calls,
    setHoldNext: (v: boolean) => { holdNext = v; },
    waitForHeldRequest: () => new Promise<void>(resolve => { heldArrived = resolve; }),
    releaseHeld: () => { releaseHold?.(); releaseHold = null; },
    getAbortedCount: () => abortedCount,
    close: () => closeServer(server)
  };
}

async function inspectClosedShadowCard(page: Page): Promise<{
  lang: string | null;
  ariaLabel: string | null;
  translate: string | null;
  note: string | null;
  card: ColorMetrics;
  heading: ColorMetrics;
} | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-dsh-paper-reader]' });
    if (!nodeId) return null;
    const { node } = await cdp.send('DOM.describeNode', { nodeId, pierce: true });
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: CONTRAST_HELPER }],
      functionDeclaration: function(this: ShadowRoot, helper: string) {
        const cardEl = this.querySelector<HTMLElement>('.card');
        const h2El = this.querySelector<HTMLElement>('h2');
        if (!cardEl || !h2El) return null;
        const fn = new Function('root', 'cardEl', 'h2El', helper + `
          function measureInShadow(el) {
            const style = getComputedStyle(el);
            const layers = [];
            for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
              layers.push(parseCssColor(getComputedStyle(cur).backgroundColor));
            }
            const darkCard = getComputedStyle(cardEl).colorScheme.includes('dark');
            let acc = darkCard ? [29, 32, 43, 1] : [255, 255, 255, 1];
            for (let i = layers.length - 1; i >= 0; i--) if (layers[i][3] > 0) acc = composite(layers[i], acc);
            const fgRaw = parseCssColor(style.color);
            const fg = fgRaw[3] < 1 ? composite(fgRaw, acc) : fgRaw;
            const fgLum = relLum(fg), bgLum = relLum(acc);
            return {
              fg: style.color,
              bg: 'rgb(' + Math.round(acc[0]) + ', ' + Math.round(acc[1]) + ', ' + Math.round(acc[2]) + ')',
              fgLum, bgLum, ratio: contrastRatio(fgLum, bgLum),
              fontSize: parseFloat(style.fontSize) || 0, colorScheme: style.colorScheme
            };
          }
          return {
            lang: cardEl.getAttribute('lang'),
            ariaLabel: cardEl.getAttribute('aria-label'),
            translate: root.querySelector('[data-do="translate"]')?.textContent ?? null,
            note: root.querySelector('[data-do="note"]')?.textContent ?? null,
            card: measureInShadow(cardEl),
            heading: measureInShadow(h2El)
          };
        `) as (root: ShadowRoot, c: HTMLElement, h: HTMLElement) => unknown;
        return fn(this, cardEl, h2El);
      }.toString()
    });
    return result.value;
  } finally {
    await cdp.detach();
  }
}

const T3_05_ARTICLE_URL = 'https://research.google/pubs/t3-05-article/';
const T3_05_ARTICLE_HTML = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><title>Structured Memory Hierarchies</title>
  <meta name="citation_title" content="Structured Memory Hierarchies for Long-Context Serving">
  <meta name="citation_author" content="Smith, Alice">
  <meta name="citation_author" content="Doe, Bob">
  <meta name="citation_journal_title" content="Journal of Machine Reading">
  <meta name="citation_publication_date" content="2024/05/12">
  <meta name="citation_publisher" content="Academic Press">
  <meta name="citation_doi" content="10.1000/jmr.2024.09">
</head><body><article>
  <h1>Structured Memory Hierarchies for Long-Context Serving</h1>
  <p>Structured paging eliminates external fragmentation when serving long-context requests in dark reading mode.</p>
  <blockquote>Block-level indirection preserves throughput across concurrent autoregressive decoders.</blockquote>
  <pre><code>const blockId = logicalTable[tokenIndex >> 4];</code></pre>
  <table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody><tr><td>Throughput</td><td>2.4x</td></tr></tbody></table>
  <figure><img alt="Block grid" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'%3E%3Crect width='100' height='50' fill='%234c3a8c'/%3E%3C/svg%3E"><figcaption>Figure 1: Logical to physical block mapping.</figcaption></figure>
</article></body></html>`;

const publisherLog = path.join(os.tmpdir(), `paper-reader-tier3-pub-${randomUUID()}.ndjson`);
await writeFile(publisherLog, '', { flag: 'wx' });

try {
  const openStax = await startPublisherFixture();
  try {
    const publisherRouter = await startCompositePublisher(openStax.origin, new Map([['/pubs/t3-05-article/', T3_05_ARTICLE_HTML]]));
    try {
      const zotero = await startRichZoteroFixture();
      try {
        const llm = await startVersatileLlmFixture();
        try {
          await withHost(async host => {
            const pageErrors: string[] = [];
            const consoleErrors: string[] = [];
            const dbPath = path.join(host.scratch, 'reader', 'reader.sqlite');

            const browser = await chromium.launch({
              executablePath: host.executable,
              headless: process.env.PAPER_READER_HEADED !== '1'
            });

            try {
              // T3-01: Dark Mode + zh-CN + ? Shortcuts Modal + collectionsDialog ARIA Tablist (+ Library 16 页)
              {
                const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', colorScheme: 'dark' });
                const scope: ErrorScope = { allowZotero503: true };
                try {
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T3-01', scope, pageErrors, consoleErrors);
                  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
                  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
                  await assertDarkAndContrast(page.locator('.topbar #docTitle'), 'T3-01 topbar #docTitle', 0.08, 4.5);

                  const srcUrl = host.origin + appPath + '?doc=pagedattention&page=6';
                  assert.equal((await rpc(ctx.request, host.origin, 'vocab.save', {
                    docId: 'pagedattention', title: 'PagedAttention.pdf', page: 6, anchor: 'p6', label: '第 6 页',
                    sourceUrl: srcUrl, text: 'fragmentation', meaning: '内存碎片', context: 'KV cache fragmentation'
                  })).status, 200);
                  assert.equal((await rpc(ctx.request, host.origin, 'history.add', {
                    docId: 'pagedattention', title: 'PagedAttention.pdf', page: 6, anchor: 'p6', label: '第 6 页',
                    sourceUrl: srcUrl, text: 'indirection', meaning: '间接寻址', context: 'block table indirection'
                  })).status, 200);

                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('Shift+?');
                  const shortcuts = page.locator('#shortcutsDialog');
                  await shortcuts.waitFor({ state: 'visible' });
                  assert.equal(await shortcuts.evaluate(el => (el as HTMLDialogElement).open), true);
                  await shortcuts.getByRole('heading', { name: '快捷键', exact: true }).waitFor();
                  for (const sel of ['h2', 'h3', 'th', 'td', 'kbd']) {
                    const m = await assertDarkAndContrast(shortcuts.locator(sel).first(), `T3-01 shortcuts ${sel}`, 0.12, 4.5);
                    assert.ok(m.fontSize >= 12, `T3-01 shortcuts ${sel} fontSize >= 12, got ${m.fontSize}`);
                  }
                  assertNoZhEnglishLeaks(await collectChromeStrings(page), 'T3-01 shortcuts');
                  await page.keyboard.press('Escape');
                  await shortcuts.waitFor({ state: 'hidden' });
                  assert.equal(await page.evaluate(() => document.activeElement?.id), 'paperScroll');

                  await page.locator('#more').click();
                  await page.locator('#menu').getByRole('button', { name: '生词与历史', exact: true }).click();
                  const dialog = page.locator('#dialog');
                  await dialog.waitFor({ state: 'visible' });
                  await assertDarkAndContrast(dialog.getByRole('heading', { name: '生词与历史' }), 'T3-01 collections heading', 0.12, 4.5);
                  const vocabTab = dialog.getByRole('tab', { name: '生词', exact: true });
                  const historyTab = dialog.getByRole('tab', { name: '历史', exact: true });
                  const panel = dialog.getByRole('tabpanel');
                  const vocabId = await vocabTab.getAttribute('id');
                  const historyId = await historyTab.getAttribute('id');
                  assert.equal(await vocabTab.getAttribute('aria-selected'), 'true');
                  assert.equal(await vocabTab.getAttribute('tabindex'), '0');
                  assert.equal(await historyTab.getAttribute('tabindex'), '-1');
                  assert.equal(await panel.getAttribute('aria-labelledby'), vocabId);

                  await vocabTab.focus();
                  await page.keyboard.press('ArrowRight');
                  assert.equal(await historyTab.getAttribute('aria-selected'), 'true');
                  assert.equal(await panel.getAttribute('aria-labelledby'), historyId);
                  await page.keyboard.press('End');
                  assert.equal(await historyTab.getAttribute('aria-selected'), 'true');
                  await page.keyboard.press('Home');
                  assert.equal(await vocabTab.getAttribute('aria-selected'), 'true');
                  await page.keyboard.press('ArrowLeft');
                  assert.equal(await historyTab.getAttribute('aria-selected'), 'true');
                  assertNoZhEnglishLeaks(await collectChromeStrings(page), 'T3-01 collections');
                  await page.locator('#closeDialog').click();
                  await dialog.waitFor({ state: 'hidden' });

                  // Closes minor T2-F7-04 partial gap: verify localized '16 页' counter in zh-CN Library dialog.
                  await page.locator('#library').click();
                  await dialog.waitFor({ state: 'visible' });
                  await dialog.getByRole('tab', { name: '本机文档', exact: true }).click();
                  const sampleRow = dialog.locator('.doc-row').filter({ hasText: 'PagedAttention.pdf' });
                  await sampleRow.waitFor({ state: 'visible' });
                  assert.ok((await sampleRow.innerText()).includes('16 页'), 'Expected 16 页 in zh-CN Library row');
                  await page.locator('#closeDialog').click();
                  console.log('PASS T3-01: Dark mode + zh-CN + ? shortcuts + collections ARIA tablist + 16 页 counter.');
                } finally {
                  await ctx.close();
                }
              }

              // T3-02: Non-Chinese Target Language + Bilingual PDF + Selection Card + Cache Switch Back
              {
                const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light' });
                const scope: ErrorScope = { allowZotero503: true };
                try {
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T3-02', scope, pageErrors, consoleErrors);
                  await saveTargetLanguage(page, 'Japanese', { baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key });

                  const pdfBytes = await makePdf(ctx, 'Multilingual Cache Verification', [
                    'The memory allocator assigns physical blocks dynamically as sequence length grows.',
                    'Paged attention eliminates internal fragmentation across concurrent serving batches.'
                  ]);
                  const imp = await ctx.request.post(host.origin + '/api/paper-reader/import-pdf?title=T3-02-Multilang.pdf', {
                    headers: { 'content-type': 'application/pdf' }, data: pdfBytes
                  });
                  assert.equal(imp.status(), 200);
                  const { doc: pdfDoc } = await imp.json() as { doc: DocumentInfo };

                  await page.goto(host.origin + appPath + `?doc=${encodeURIComponent(pdfDoc.id)}&page=1`, { waitUntil: 'domcontentloaded' });
                  await page.locator('#loading').waitFor({ state: 'hidden' });
                  await page.locator('#parallel').click();
                  await page.getByRole('group', { name: 'Japanese, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').first().waitFor();
                  const jaText = (await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').allInnerTexts()).join('\n');
                  assert.ok(jaText.includes('日本語訳:'), 'Expected Japanese translation: ' + jaText);

                  await selectFirstPdfRun(page);
                  const card = page.locator('#card');
                  await card.waitFor({ state: 'visible' });
                  assertNoEnBannedTerms(await collectChromeStrings(page), 'T3-02 selection card');
                  await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
                  const starter = page.getByRole('button', { name: 'Translate to Japanese', exact: true });
                  await starter.waitFor({ state: 'visible' });
                  await starter.click();
                  await page.locator('.selection-chat-log').getByText('日本語訳: メモリアロケータ').waitFor();
                  await page.keyboard.press('Escape');
                  if (await card.isVisible()) await page.keyboard.press('Escape');
                  await card.waitFor({ state: 'hidden' });

                  await saveTargetLanguage(page, 'French');
                  await page.getByRole('group', { name: 'French, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text[lang="fr"]:visible').first().waitFor();
                  assert.ok((await page.locator('#translated .pdf-translated-text[lang="fr"]:visible').allInnerTexts()).join('\n').includes('Traduction française :'));

                  await saveTargetLanguage(page, 'Italian', { custom: true });
                  await page.getByRole('group', { name: 'Italian, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text:visible').first().waitFor();
                  const itLang = await page.locator('#translated .pdf-translated-text:visible').first().getAttribute('lang');
                  assert.ok(itLang === null || itLang === 'und', 'Custom Italian must omit lang or use und, got: ' + String(itLang));
                  assert.ok((await page.locator('#translated .pdf-translated-text:visible').allInnerTexts()).join('\n').includes('Traduzione italiana:'));

                  await saveTargetLanguage(page, 'Simplified Chinese');
                  await page.getByRole('group', { name: 'Simplified Chinese, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text[lang="zh-CN"]:visible').first().waitFor();
                  assert.ok((await page.locator('#translated .pdf-translated-text[lang="zh-CN"]:visible').allInnerTexts()).join('\n').includes('简体中文译文'));

                  const cacheDir = path.join(host.scratch, 'reader', 'translations', pdfDoc.id);
                  assert.equal(existsSync(path.join(cacheDir, '1.json')), true);
                  assert.equal(existsSync(path.join(cacheDir, 'ja', '1.json')), true);
                  assert.equal(existsSync(path.join(cacheDir, 'fr', '1.json')), true);

                  const callsBeforeBack = llm.calls.length;
                  await saveTargetLanguage(page, 'Japanese');
                  await page.getByRole('group', { name: 'Japanese, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').first().waitFor();
                  await saveTargetLanguage(page, 'Simplified Chinese');
                  await page.getByRole('group', { name: 'Simplified Chinese, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text[lang="zh-CN"]:visible').first().waitFor();
                  assert.equal(llm.calls.length, callsBeforeBack, 'Switching back across cached languages must make 0 LLM calls');

                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T3-02: Japanese/French/custom Italian/Simplified Chinese + Selection Card + 0-call cache switch-back.');
                } finally {
                  await ctx.close();
                }
              }

              // T3-03: Reference BibTeX/RIS Export in Dark Mode + zh-CN
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'zh-CN', colorScheme: 'dark',
                  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write']
                });
                const scope: ErrorScope = { allowZotero503: true };
                try {
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T3-03', scope, pageErrors, consoleErrors);
                  await page.locator('#mobileRail').click();
                  await page.locator('#refsTab').click();
                  const cite = page.locator('.citation-export');
                  await cite.waitFor({ state: 'visible' });
                  await assertDarkAndContrast(cite.locator('h3'), 'T3-03 citation heading', 0.12, 4.5);
                  for (const name of ['复制 BibTeX', '下载 .bib', '复制 RIS', '下载 .ris']) {
                    await assertDarkAndContrast(cite.getByRole('button', { name, exact: true }), `T3-03 ${name}`, 0.12, 4.5);
                  }
                  assertNoZhEnglishLeaks(await collectChromeStrings(page), 'T3-03 refs');

                  await cite.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor();
                  await page.locator('#toast').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor();
                  const bibClip = await page.evaluate(() => navigator.clipboard.readText());
                  assert.ok(bibClip.startsWith('@inproceedings{kwon2023efficient,\n'), bibClip);

                  const [bibDl] = await Promise.all([
                    page.waitForEvent('download'),
                    cite.getByRole('button', { name: '下载 .bib', exact: true }).click()
                  ]);
                  const bibFile = await readDownload(bibDl);
                  assert.equal(bibFile.filename, 'kwon2023efficient.bib');
                  assert.equal(bibFile.text, bibClip);
                  await page.locator('.citation-export-status').filter({ hasText: '已下载 kwon2023efficient.bib。' }).waitFor();

                  await cite.getByRole('button', { name: '复制 RIS', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'RIS 已复制到剪贴板。' }).waitFor();
                  const risClip = await page.evaluate(() => navigator.clipboard.readText());
                  assert.ok(risClip.startsWith('TY  - CONF\n') && risClip.trimEnd().endsWith('ER  -'), risClip);

                  const [risDl] = await Promise.all([
                    page.waitForEvent('download'),
                    cite.getByRole('button', { name: '下载 .ris', exact: true }).click()
                  ]);
                  const risFile = await readDownload(risDl);
                  assert.equal(risFile.filename, 'kwon2023efficient.ris');
                  assert.equal(risFile.text, risClip);
                  console.log('PASS T3-03: Reference BibTeX/RIS copy & download in dark zh-CN.');
                } finally {
                  await ctx.close();
                }
              }

              // T3-04: Zotero-Linked Reference Export + Unified Marks / Paper chat / Notes Workflow
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light',
                  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write']
                });
                const scope: ErrorScope = { allowZotero503: false };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key,
                    zoteroMode: 'web', zoteroLibraryType: 'group', zoteroLibraryId: zotero.libraryId, zoteroApiKey: zotero.credential
                  });
                  const pdfBytes = await makePdf(ctx, 'Sparse Zotero Draft', [
                    'Analytical engine memory tables organize logical segments across physical banks.'
                  ]);
                  const imp = await ctx.request.post(host.origin + '/api/paper-reader/import-pdf?title=t3-04-sparse.pdf', {
                    headers: { 'content-type': 'application/pdf' }, data: pdfBytes
                  });
                  assert.equal(imp.status(), 200);
                  const { doc: sparseDoc } = await imp.json() as { doc: DocumentInfo };

                  const page = await openReaderPage(ctx, host, `?doc=${encodeURIComponent(sparseDoc.id)}&page=1`, 'T3-04', scope, pageErrors, consoleErrors);
                  await page.locator('#mobileRail').click();
                  await page.locator('#refsTab').click();
                  await page.locator('#railBody input[aria-label="Search Zotero"]').fill('Analytical');
                  await page.getByRole('button', { name: 'Find item', exact: true }).click();
                  await page.getByRole('button', { name: zotero.richItem.data.title, exact: true }).click();
                  await page.getByRole('button', { name: 'Link this item', exact: true }).click();
                  await page.locator('#railBody').getByText('Linked reference', { exact: true }).waitFor();

                  await selectFirstPdfRun(page);
                  await page.locator('#card').getByRole('button', { name: 'Highlight', exact: true }).click();
                  await page.locator('#annotationsTab').click();
                  await page.locator('.annotation-entry').first().waitFor({ state: 'visible' });

                  await page.locator('.paper-chat-toggle').click();
                  const chatInput = page.getByRole('textbox', { name: 'Message about this paper', exact: true });
                  await chatInput.fill('How do logical segments map to physical banks?');
                  await chatInput.press('Enter');
                  await page.locator('.paper-answer').first().waitFor({ state: 'visible' });
                  await page.locator('.paper-chat').getByRole('button', { name: 'Add to Notes', exact: true }).click();
                  await page.locator('.paper-chat').getByRole('button', { name: 'View', exact: true }).click();
                  assert.equal(await page.locator('#notesTab').getAttribute('aria-selected'), 'true');
                  await page.locator('#rail').getByRole('link', { name: 'Paper chat', exact: true }).waitFor();

                  await page.locator('#refsTab').click();
                  await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor();
                  const mergedBib = await page.evaluate(() => navigator.clipboard.readText());
                  assert.ok(mergedBib.startsWith('@article{lovelace2024analytical,\n'), mergedBib);
                  assert.ok(mergedBib.includes('  author = {Ada Lovelace and Charles Babbage},'));
                  assert.ok(mergedBib.includes('  doi = {10.1000/zotero.2024.42},'));

                  const [risDl] = await Promise.all([
                    page.waitForEvent('download'),
                    page.getByRole('button', { name: 'Download .ris', exact: true }).click()
                  ]);
                  const mergedRis = await readDownload(risDl);
                  assert.equal(mergedRis.filename, 'lovelace2024analytical.ris');
                  assert.ok(mergedRis.text.startsWith('TY  - JOUR\n') && mergedRis.text.includes('DO  - 10.1000/zotero.2024.42\n'));
                  assertNoEnBannedTerms(await collectChromeStrings(page), 'T3-04');

                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T3-04: Zotero-linked export + unified Marks / Paper chat / Notes workflow.');
                } finally {
                  await ctx.close();
                }
              }

              // T3-05: Academic Web Article (<meta citation_*>) + Dark .web-reading-sheet + Export + library.delete Cascade
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark',
                  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write']
                });
                const scope: ErrorScope = { allowZotero503: true };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, { baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key });
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T3-05', scope, pageErrors, consoleErrors);

                  await page.locator('#library').click();
                  const dialog = page.getByRole('dialog');
                  await dialog.waitFor({ state: 'visible' });
                  const openWebBtn = dialog.getByRole('button', { name: 'Open web page', exact: true });
                  if ((await openWebBtn.getAttribute('aria-expanded')) !== 'true') await openWebBtn.click();
                  await dialog.locator('#library-url').fill(T3_05_ARTICLE_URL);
                  await dialog.getByRole('button', { name: 'Read article', exact: true }).click();
                  await dialog.waitFor({ state: 'hidden' });

                  const sheet = page.locator('.web-reading-sheet[data-side="source"]');
                  await sheet.waitFor({ state: 'visible' });
                  const deletedId = new URL(page.url()).searchParams.get('doc')!;
                  assert.ok(deletedId && deletedId !== 'pagedattention');

                  for (const sel of ['h1', 'p', 'blockquote', 'pre', 'td', 'figcaption']) {
                    await assertDarkAndContrast(sheet.locator(sel).first(), `T3-05 dark web ${sel}`, 0.12, 4.5);
                  }

                  // Populate Note, Mark, Paper chat, and localStorage/sessionStorage for the web article
                  const articleUrl = page.url();
                  assert.equal((await rpc(ctx.request, host.origin, 'annotation.save', {
                    id: randomUUID(), docId: deletedId, title: 'Structured Memory Hierarchies', page: 1,
                    anchor: 'p-1', label: 'Paragraph 1', sourceUrl: articleUrl, kind: 'highlight', color: 'yellow',
                    quote: 'Structured paging', text: 'Dark web highlight'
                  })).status, 200);
                  await page.locator('#mobileRail').click();
                  await page.locator('#notesTab').click();
                  const notesBox = page.getByRole('textbox', { name: 'Notes Markdown', exact: true });
                  await notesBox.click();
                  await page.keyboard.type('Dark web reading note');
                  await page.locator('.notebook-save').click();
                  await page.locator('.notebook-status[data-saved="true"]').waitFor();

                  await page.locator('.paper-chat-toggle').click();
                  const chatBox = page.getByRole('textbox', { name: 'Message about this paper', exact: true });
                  await chatBox.fill('Summarize block-level indirection.');
                  await chatBox.press('Enter');
                  await page.locator('.paper-answer').first().waitFor({ state: 'visible' });

                  await page.evaluate(id => {
                    localStorage.setItem('reader.page.' + id, '1');
                    localStorage.setItem('reader.tab.' + id, 'notes');
                    localStorage.setItem('reader.focus.' + id + '.1', 'p-1');
                    sessionStorage.setItem('reader.selection-note-draft.' + JSON.stringify([id, 1, 'p-1', 'q']), 'draft');
                  }, deletedId);

                  await page.locator('#refsTab').click();
                  await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor();
                  const webBib = await page.evaluate(() => navigator.clipboard.readText());
                  assert.ok(webBib.startsWith('@article{smith2024structured,\n'), webBib);
                  assert.ok(webBib.includes('  doi = {10.1000/jmr.2024.09},'));
                  const [risDl] = await Promise.all([
                    page.waitForEvent('download'),
                    page.getByRole('button', { name: 'Download .ris', exact: true }).click()
                  ]);
                  const webRis = await readDownload(risDl);
                  assert.ok(webRis.text.startsWith('TY  - JOUR\n') && webRis.text.includes('AU  - Smith, Alice\n') && webRis.text.trimEnd().endsWith('ER  -'));

                  await page.locator('#library').click();
                  await dialog.waitFor({ state: 'visible' });
                  await dialog.getByRole('tab', { name: 'On this device', exact: true }).click();
                  const row = dialog.locator('.library-device-item').filter({ hasText: 'Structured Memory Hierarchies' });
                  await row.getByRole('button', { name: 'Delete document', exact: true }).click();
                  await row.getByRole('button', { name: 'Confirm delete', exact: true }).click();
                  await dialog.getByText('Document removed from this device.', { exact: true }).waitFor();
                  await page.waitForURL(u => u.searchParams.get('doc') === 'pagedattention');
                  await page.locator('#loading').waitFor({ state: 'hidden' });

                  assertZeroSqliteRows(dbPath, deletedId);
                  const remainingStorage = await page.evaluate(id => ({
                    local: Object.keys(localStorage).filter(k => k.includes(id)),
                    session: Object.keys(sessionStorage).filter(k => k.includes(id))
                  }), deletedId);
                  assert.deepEqual(remainingStorage.local, [], 'Deleted article localStorage keys must be purged');
                  assert.deepEqual(remainingStorage.session, [], 'Deleted article sessionStorage keys must be purged');

                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T3-05: Academic web article + dark reading sheet + export + full library.delete cascade.');
                } finally {
                  await ctx.close();
                }
              }

              // T3-06: Mobile Viewport (390x844) + Dark Mode + zh-CN + Unified Marks/Paper chat/Notes + Shortcuts/More Menu
              {
                const ctx = await browser.newContext({
                  viewport: { width: 390, height: 844 }, locale: 'zh-CN', colorScheme: 'dark',
                  isMobile: true, hasTouch: true
                });
                const scope: ErrorScope = { allowZotero503: true };
                try {
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T3-06', scope, pageErrors, consoleErrors);
                  const titleBox = await page.locator('#docTitle').boundingBox();
                  assert.ok(titleBox && titleBox.width >= 64, `Expected #docTitle >= 64px, got ${titleBox?.width}`);
                  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
                  await assertDarkAndContrast(page.locator('.topbar #docTitle'), 'T3-06 mobile topbar', 0.08, 4.5);

                  await page.locator('#more').click();
                  await page.locator('#menu').getByRole('button', { name: '快捷键', exact: true }).click();
                  const shortcuts = page.locator('#shortcutsDialog');
                  await shortcuts.waitFor({ state: 'visible' });
                  await assertDarkAndContrast(shortcuts.locator('h2'), 'T3-06 mobile shortcuts heading', 0.12, 4.5);
                  const closeBox = await page.locator('#closeShortcuts').boundingBox();
                  assert.ok(closeBox && closeBox.width >= 44 && closeBox.height >= 44, 'Mobile #closeShortcuts must be >= 44x44');
                  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
                  await page.locator('#closeShortcuts').click();
                  await shortcuts.waitFor({ state: 'hidden' });

                  await page.locator('#mobileRail').click();
                  await page.locator('#rail').waitFor({ state: 'visible' });
                  assert.equal(await page.locator('#reader').getAttribute('data-notebook-pose'), 'sheet');
                  assert.equal(await page.locator('#rail').getAttribute('role'), 'dialog');
                  assert.equal(await page.locator('#rail').getAttribute('aria-modal'), 'true');
                  await assertDarkAndContrast(page.locator('#rail .rail-head [role="tab"][aria-selected="true"]'), 'T3-06 mobile rail tab', 0.12, 4.5);
                  const tabTexts = await page.locator('#rail .rail-head [role="tab"]').allInnerTexts();
                  assert.deepEqual(tabTexts, ['目录', '笔记', '标记', '文献']);
                  for (const sel of ['#contentsTab', '#notesTab', '#annotationsTab', '#refsTab']) {
                    await page.locator(sel).click();
                    assert.equal(await page.locator(sel).getAttribute('aria-selected'), 'true');
                  }
                  await page.locator('#closeRail').click();
                  await page.locator('#rail').waitFor({ state: 'hidden' });

                  await page.locator('.paper-chat-toggle').click();
                  await page.locator('.paper-chat-input textarea').waitFor({ state: 'visible' });
                  await assertDarkAndContrast(page.locator('.paper-chat-input textarea'), 'T3-06 mobile paper chat input', 0.12, 4.5);
                  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
                  assertNoZhEnglishLeaks(await collectChromeStrings(page), 'T3-06 mobile zh-CN');
                  console.log('PASS T3-06: Mobile 390x844 dark zh-CN + shortcuts + bottom-sheet tabs + Paper chat.');
                } finally {
                  await ctx.close();
                }
              }

              // T3-07: OpenStax Book (ArrowLeft/ArrowRight) + Spanish Target Language + prefers-reduced-motion: reduce
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark', reducedMotion: 'reduce'
                });
                const scope: ErrorScope = { allowZotero503: true };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'Spanish'
                  });
                  const openBook = await rpc<{ doc: DocumentInfo }>(ctx.request, host.origin, 'web.open', { url: bookRoot + sections.start.slug });
                  assert.equal(openBook.status, 200);
                  const bookId = openBook.body.doc.id;

                  const page = await openReaderPage(ctx, host, `?doc=${encodeURIComponent(bookId)}&page=1`, 'T3-07', scope, pageErrors, consoleErrors);
                  const motionAudit = await page.evaluate(() => {
                    let hasBannedKill = false;
                    for (const sheet of Array.from(document.styleSheets)) {
                      try {
                        for (const rule of Array.from(sheet.cssRules)) {
                          if (rule.cssText.includes('0.01ms')) hasBannedKill = true;
                        }
                      } catch { /* ignore */ }
                    }
                    return {
                      hasBannedKill,
                      scrollBehavior: getComputedStyle(document.getElementById('paperScroll')!).scrollBehavior
                    };
                  });
                  assert.equal(motionAudit.hasBannedKill, false, 'Zero 0.01ms !important rule allowed');
                  assert.equal(motionAudit.scrollBehavior, 'auto', 'Reduced motion must set scroll-behavior: auto');

                  await page.locator('#parallel').click();
                  await page.locator('#translate').click();
                  const transSheet = page.locator('.web-reading-sheet[data-side="translation"][lang="es"]');
                  await transSheet.getByText('Traducción al español:').first().waitFor();
                  const callsAfterSec1 = llm.calls.length;

                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('ArrowRight');
                  await page.waitForURL(u => u.searchParams.get('page') === '2');
                  await page.locator('#loading').waitFor({ state: 'hidden' });
                  const section2Title = openBook.body.doc.book!.sections[1].title;
                  await page.locator('#docMeta').filter({ hasText: section2Title }).waitFor();

                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('ArrowLeft');
                  await page.waitForURL(u => u.searchParams.get('page') === '1');
                  await transSheet.getByText('Traducción al español:').first().waitFor();
                  assert.equal(llm.calls.length, callsAfterSec1, 'Returning to section 1 must hit Spanish cache with 0 repeat LLM calls');

                  await rpc(ctx.request, host.origin, 'library.delete', { id: bookId });
                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T3-07: OpenStax ArrowRight/ArrowLeft + Spanish cache + reducedMotion.');
                } finally {
                  await ctx.close();
                }
              }

              // T3-09: PDF Region Screenshot (sharp F1) + German Target Language + Streaming Abort (Stop) + Marks Pin
              {
                const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
                const scope: ErrorScope = { allowZotero503: true };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'German'
                  });
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T3-09', scope, pageErrors, consoleErrors);

                  await page.locator('#captureRegion').click();
                  await page.locator('.pdf-capture-surface').waitFor({ state: 'visible' });
                  const fig = page.locator('#original .pdf-figure[data-block-id="figure-6"]');
                  await fig.scrollIntoViewIfNeeded();
                  const rect = (await fig.boundingBox())!;
                  await dragBox(
                    page,
                    { x: Math.round(rect.x + rect.width * 0.08), y: Math.round(rect.y + rect.height * 0.16) },
                    { x: Math.round(rect.x + rect.width * 0.62), y: Math.round(rect.y + rect.height * 0.80) },
                    false
                  );
                  const captureActions = page.locator('.pdf-capture-actions');
                  await captureActions.waitFor({ state: 'visible' });
                  await assertDarkAndContrast(captureActions.getByRole('button', { name: 'Ask', exact: true }), 'T3-09 capture Ask', 0.12, 4.5);

                  llm.setHoldNext(true);
                  const heldPromise = llm.waitForHeldRequest();
                  await captureActions.getByRole('button', { name: 'Ask', exact: true }).click();
                  const composer = page.locator('#card .selection-chat textarea');
                  await composer.waitFor({ state: 'visible' });
                  const question = 'Was zeigt dieses Blockzuordnungsdiagramm?';
                  await composer.fill(question);
                  await composer.press('Enter');

                  const stopBtn = page.locator('#card').getByRole('button', { name: 'Stop', exact: true });
                  await stopBtn.waitFor({ state: 'visible' });
                  await heldPromise;
                  const heldCall = llm.calls.at(-1);
                  assert.ok(heldCall?.hasValidPng, 'Vision request must carry valid PNG bytes decoded by sharp');
                  assert.ok(heldCall?.target === 'German', 'Vision request must target German');

                  await stopBtn.click();
                  await stopBtn.waitFor({ state: 'hidden' });
                  await until(() => llm.getAbortedCount() >= 1, 'Expected Stop button to abort in-flight LLM request');
                  assert.equal(await page.locator('#card .selection-answer').count(), 0);
                  assert.equal(await page.locator('#card .chat-error:visible').count(), 0);
                  assert.equal(await composer.inputValue(), question, 'Aborted prompt must be restored in composer');

                  // Re-send and verify clean German recovery + rendered screenshot preview
                  await composer.press('Enter');
                  await page.locator('#card .selection-answer').getByText('Deutsche Antwort:').waitFor();
                  const previewWidth = await page.locator('#card img').first().evaluate(img => (img as HTMLImageElement).naturalWidth);
                  assert.ok(previewWidth > 0, 'Cropped PNG preview must render with naturalWidth > 0');

                  await page.locator('#card').getByRole('button', { name: 'Close chat', exact: true }).click();
                  await page.locator('#card').waitFor({ state: 'hidden' });

                  await page.locator('#placePin').click();
                  await page.mouse.click(rect.x + rect.width * 0.2, rect.y + rect.height * 0.3);
                  const popover = page.locator('.annotation-popover');
                  await popover.waitFor({ state: 'visible' });
                  await assertDarkAndContrast(popover.getByRole('textbox', { name: 'Comment' }), 'T3-09 pin popover', 0.12, 4.5);
                  await popover.getByRole('textbox', { name: 'Comment' }).fill('German pin check');
                  await popover.getByRole('button', { name: 'Save', exact: true }).click();
                  await popover.waitFor({ state: 'hidden' });
                  await page.locator('#original .annotation-pin').first().waitFor({ state: 'visible' });
                  const listed = await rpc<{ annotations: { text: string }[] }>(ctx.request, host.origin, 'annotation.list', { docId: 'pagedattention' });
                  assert.ok(listed.body.annotations.some(a => a.text === 'German pin check'));

                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T3-09: PDF region screenshot (sharp) + German + Stop abort recovery + dark Marks pin.');
                } finally {
                  llm.releaseHeld();
                  await ctx.close();
                }
              }

              // T3-10: 1440px Bilingual PDF (Japanese) + Open Sidebar + Shift++/- Zoom + Layout Reset + Dark Contrast
              {
                const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
                const scope: ErrorScope = { allowZotero503: true };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'Japanese'
                  });
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T3-10', scope, pageErrors, consoleErrors);
                  await page.locator('#parallel').click();
                  await page.getByLabel('Translation scope').selectOption('page');
                  await page.locator('#mobileRail').click();
                  await page.locator('#rail').waitFor({ state: 'visible' });
                  await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').first().waitFor();

                  const pdfSheetStyle = await page.locator('#original .pdf-sheet').evaluate(el => ({
                    bg: getComputedStyle(el).backgroundColor,
                    scheme: getComputedStyle(el).colorScheme
                  }));
                  assert.equal(pdfSheetStyle.bg, 'rgb(255, 255, 255)', '.pdf-sheet must stay white paper');
                  assert.equal(pdfSheetStyle.scheme, 'light', '.pdf-sheet must declare light color-scheme');
                  await assertDarkAndContrast(page.locator('.topbar #docTitle'), 'T3-10 dark topbar', 0.08, 4.5);
                  await assertDarkAndContrast(page.locator('#rail #notesTab'), 'T3-10 dark rail', 0.08, 4.5);

                  const inspectTranslated = () => page.evaluate(() => {
                    const blocks = Array.from(document.querySelectorAll<HTMLElement>('#translated .pdf-translated-text')).filter(el => !el.hidden && el.offsetWidth > 0);
                    const bodySizes = blocks.filter(el => el.dataset.role === 'paragraph').map(el => {
                      const rect = el.getBoundingClientRect();
                      const cssFont = parseFloat(getComputedStyle(el).fontSize) || 0;
                      return cssFont * (rect.width / el.offsetWidth);
                    });
                    const rects = blocks.map(el => el.getBoundingClientRect());
                    let overlaps = 0;
                    for (let i = 0; i < rects.length; i++) {
                      for (let j = i + 1; j < rects.length; j++) {
                        const a = rects[i], b = rects[j];
                        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlaps++;
                      }
                    }
                    return { bodySizes, overlaps, pageOverflow: document.documentElement.scrollWidth - window.innerWidth };
                  });

                  await until(async () => {
                    const m = await inspectTranslated();
                    return m.bodySizes.length > 0 && m.bodySizes.every(s => s >= 11.5);
                  }, '1440px Japanese bilingual body blocks must meet >= 11.5px visual font floor');
                  const metrics = await inspectTranslated();
                  assert.equal(metrics.overlaps, 0, 'Japanese translated blocks must not overlap');
                  assert.ok(metrics.pageOverflow <= 1, 'Zero horizontal overflow at 1440px');

                  for (const width of [1440, 1380]) {
                    await page.setViewportSize({ width, height: 900 });
                    const saveSize = await page.locator('#saveState').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
                    assert.ok(saveSize >= 12, `#saveState fontSize at ${width}px must be >= 12px, got ${saveSize}`);
                  }
                  await page.setViewportSize({ width: 1440, height: 900 });

                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('Shift++');
                  assert.equal(await page.locator('#zoom').inputValue(), '1.25');
                  await page.keyboard.press('-');
                  assert.equal(await page.locator('#zoom').inputValue(), '1');
                  await page.keyboard.press('n');
                  assert.equal(await page.locator('#reader').getAttribute('data-notebook-open'), 'false');
                  await page.keyboard.press('n');
                  assert.equal(await page.locator('#reader').getAttribute('data-notebook-open'), 'true');
                  await page.keyboard.press('Shift++');
                  assert.equal(await page.locator('#zoom').inputValue(), '1.25');

                  await page.locator('#more').click();
                  await page.locator('#menu').getByRole('button', { name: 'Reset reading layout', exact: true }).click();
                  await page.locator('#toast').filter({ hasText: 'Reading layout reset.' }).waitFor();
                  assert.equal(await page.locator('#zoom').inputValue(), '1');
                  assert.equal(await page.locator('#reader').getAttribute('data-reading-mode'), 'source');
                  assert.equal(await page.locator('#reader').getAttribute('data-notebook-open'), 'false');

                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T3-10: 1440px Japanese bilingual floor + #saveState >= 12px + Shift++/- + n + layout reset.');
                } finally {
                  await ctx.close();
                }
              }
            } finally {
              await browser.close();
            }

            // T3-08: Extension Dark Mode + zh-CN Card + Web Capture into Dark Reader + Reference Export
            {
              const extServer = createServer((_req, res) => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
                  <html lang="en"><head><meta charset="utf-8"><title>Extension Citation Fixture</title>
                  <meta name="citation_title" content="Dark Extension Captured Paper">
                  <meta name="citation_author" content="Chen, Lin">
                  <meta name="citation_journal_title" content="Browser Systems Letters">
                  <meta name="citation_publication_date" content="2025/02/14">
                  <meta name="citation_doi" content="10.1000/bsl.2025.08">
                  </head><body><article>
                  <h1>Dark Extension Captured Paper</h1>
                  <p>Studying <strong id="term">PagedAttention</strong> inside a dark zh-CN browser extension card.</p>
                  </article></body></html>`);
              });
              await new Promise<void>(resolve => extServer.listen(0, '127.0.0.1', resolve));
              const extAddr = extServer.address();
              assert.ok(extAddr && typeof extAddr === 'object');
              const extArticleUrl = `http://ext-cite-t3.test:${extAddr.port}/paper`;
              const profileDir = path.join(host.scratch, 't3-08-ext-profile-' + randomUUID().slice(0, 6));
              await mkdir(profileDir, { recursive: true });
              const scope: ErrorScope = { allowZotero503: true };
              const extCtx = await chromium.launchPersistentContext(profileDir, {
                executablePath: host.executable,
                headless: process.env.PAPER_READER_HEADED !== '1',
                viewport: { width: 1440, height: 900 },
                locale: 'zh-CN',
                colorScheme: 'dark',
                acceptDownloads: true,
                permissions: ['clipboard-read', 'clipboard-write'],
                env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
                ignoreDefaultArgs: ['--disable-extensions'],
                args: [
                  '--force-dark-mode', '--lang=zh-CN', '--enable-unsafe-extension-debugging',
                  '--no-proxy-server', '--host-resolver-rules=MAP ext-cite-t3.test 127.0.0.1'
                ]
              });
              try {
                const bcdp = await extCtx.browser()!.newBrowserCDPSession();
                const { id: extId } = await bcdp.send('Extensions.loadUnpacked', { path: extensionDir });
                await bcdp.detach();

                // Authenticate DSH session cookie in tab 0 so reader tab opened by extension is logged in
                const authPage = extCtx.pages()[0] ?? await extCtx.newPage();
                await authPage.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });

                const articlePage = await extCtx.newPage();
                attachErrorGuards(articlePage, 'T3-08-article', scope, pageErrors, consoleErrors);
                await articlePage.goto(extArticleUrl, { waitUntil: 'domcontentloaded' });

                const popup = await openToolbar(articlePage, extId);
                const popupInfo = await popup.evaluate((helper: string) => {
                  const fn = new Function(helper + `return { lang: document.documentElement.lang, body: measureElement(document.body) };`) as () => { lang: string; body: ColorMetrics };
                  return fn();
                }, CONTRAST_HELPER) as { lang: string; body: ColorMetrics };
                assert.equal(popupInfo.lang, 'zh-CN');
                assert.ok(popupInfo.body.bgLum <= 0.08, `Expected dark extension popup, got lum ${popupInfo.body.bgLum}`);

                await popup.click('summary');
                await popup.evaluate(origin => {
                  document.querySelector<HTMLInputElement>('#origin')!.value = origin;
                  document.querySelector('form')!.requestSubmit();
                }, host.origin);
                await until(() => popup.evaluate(() => /地址已保存/.test(document.querySelector('#message')?.textContent ?? ''), null),
                  'Extension popup did not save origin in zh-CN');
                await popup.click('#toggle');
                await popup.detach();

                await articlePage.locator('#term').dblclick();
                await until(async () => Boolean(await cardElement(articlePage, '.card')), 'Extension selection card did not open');
                const cardInfo = await inspectClosedShadowCard(articlePage);
                assert.ok(cardInfo, 'Closed shadow-DOM card info missing');
                assert.equal(cardInfo.lang, 'zh-CN');
                assert.equal(cardInfo.card.colorScheme, 'dark');
                assert.ok(cardInfo.card.bgLum <= 0.08, `Dark card bgLum <= 0.08, got ${cardInfo.card.bgLum}`);
                assert.ok(cardInfo.heading.ratio >= 4.5, `Dark card heading contrast >= 4.5, got ${cardInfo.heading.ratio}`);
                assert.equal(cardInfo.translate, '翻译');
                assert.equal(cardInfo.note, '记入笔记');

                const [readerTab] = await Promise.all([
                  extCtx.waitForEvent('page'),
                  clickCard(articlePage, '[data-do="open"]')
                ]);
                attachErrorGuards(readerTab, 'T3-08-reader', scope, pageErrors, consoleErrors);
                await readerTab.waitForLoadState('domcontentloaded');
                await readerTab.locator('#loading').waitFor({ state: 'hidden', timeout: 25_000 });
                assert.equal(await readerTab.evaluate(() => document.documentElement.dataset.theme), 'dark');
                const capturedSheet = readerTab.locator('.web-reading-sheet[data-side="source"]');
                await capturedSheet.waitFor({ state: 'visible' });
                await assertDarkAndContrast(capturedSheet.locator('h1'), 'T3-08 captured dark web sheet', 0.12, 4.5);

                await readerTab.locator('#mobileRail').click();
                await readerTab.locator('#refsTab').click();
                await readerTab.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
                await readerTab.locator('.citation-export-status').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor();
                const extBib = await readerTab.evaluate(() => navigator.clipboard.readText());
                assert.ok(extBib.includes('Dark Extension Captured Paper'), extBib);
                assert.ok(extBib.includes('Chen, Lin'), extBib);
                assert.ok(extBib.includes('10.1000/bsl.2025.08'), extBib);

                const [extRisDl] = await Promise.all([
                  readerTab.waitForEvent('download'),
                  readerTab.getByRole('button', { name: '下载 .ris', exact: true }).click()
                ]);
                const extRis = await readDownload(extRisDl);
                assert.ok(extRis.text.startsWith('TY  - JOUR\n') && extRis.text.includes('DO  - 10.1000/bsl.2025.08\n'));
                console.log('PASS T3-08: Extension dark zh-CN popup & card + web capture into dark reader + citation export.');
              } finally {
                await extCtx.close();
                await closeServer(extServer);
                await rm(profileDir, { recursive: true, force: true });
              }
            }

            assert.deepEqual(pageErrors, [], 'Unexpected pageerror events:\n' + pageErrors.join('\n'));
            assert.deepEqual(consoleErrors, [], 'Unexpected console.error events:\n' + consoleErrors.join('\n'));
            console.log('PASS Tier 3 (T3-01..T3-10): All 10 cross-feature pairwise E2E scenarios passed.');
          }, {
            NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + zoteroPreload, '--import=' + publisherPreload].filter(Boolean).join(' '),
            READER_TEST_ZOTERO_ORIGIN: zotero.origin,
            PAPER_READER_E2E_PUBLISHER_FIXTURE: publisherRouter.origin,
            PAPER_READER_E2E_PUBLISHER_LOG: publisherLog
          });
        } finally {
          await llm.close();
        }
      } finally {
        await zotero.close();
      }
    } finally {
      await publisherRouter.close();
    }
  } finally {
    await openStax.close();
  }
} finally {
  await rm(publisherLog, { force: true });
}
