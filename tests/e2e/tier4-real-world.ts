import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium, type APIRequestContext, type BrowserContext, type Download, type FrameLocator, type Locator, type Page } from 'playwright-core';
import type { DocumentInfo, ReaderState } from '../../src/shared/types.js';
import { bookRoot, sections, startPublisherFixture } from './book-reading-fixture.js';
import { cardElement, clickCard, openToolbar, until } from './extension-controls.js';
import { withHost, type HostFixture } from './host.js';
import { startJsonFixture } from './integration-fixtures.js';
import { dragBox } from './selection-gestures.js';
import { markdownLinks, vaultSource, visibleMarkdown } from './vault-links.js';

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
  allowExpected502: boolean;
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
  'woosuk', 'et', 'al', 'key', 'value', 'kv', 'tier', 'llm', 'fixture'
]);
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
    const excluded = '.pdf-sheet, .pdf-reading-text p, .pdf-reading-text h2, .meaning, #card blockquote, .web-reading-sheet, .cm-content, .quote, .selection-excerpt blockquote, .selection-heading h2, #docTitle, #docMeta, #railBody h1, .list-row strong, .toc-entry, .toc-fold, .paper-answer, .selection-answer, .library-row-text strong, .library-row-text small, .doc-row strong, .doc-row small, #sourceInfo, .citation-export-status';
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

function attachErrorGuards(page: Page, tag: string, scope: ErrorScope, pageErrors: string[], consoleErrors: string[]): void {
  page.setDefaultTimeout(12_000);
  page.on('pageerror', err => pageErrors.push(`${tag}: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const url = msg.location().url;
    if (url.endsWith('/favicon.ico')) return;
    if (scope.allowZotero503 && text.includes('503') && url.endsWith('/api/paper-reader/action')) return;
    if (scope.allowExpected502 && text.includes('502') && url.endsWith('/api/paper-reader/action')) return;
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

async function openReaderInShell(page: Page, authenticatedUrl: string): Promise<FrameLocator> {
  await page.goto(authenticatedUrl, { waitUntil: 'domcontentloaded' });
  const sidebar = page.getByRole('button', { name: 'Paper Reader', exact: true });
  const noticeAction = page.getByRole('button', {
    name: /^(Continue|继续|Configure later|稍后配置|Skip(?: for now)?|跳过|Get started|开始使用|Open app|Got it|知道了)$/i
  });
  const closeDialog = page.getByRole('dialog').getByRole('button', { name: /^(Close|关闭)$/i });
  const pane = page.frameLocator('iframe[title="Paper Reader"]');
  const deadline = Date.now() + 35_000;
  let mounted = false;
  while (Date.now() < deadline) {
    if (await closeDialog.last().isVisible().catch(() => false)) {
      await closeDialog.last().click({ timeout: 1500 }).catch(() => undefined);
      continue;
    }
    const action = noticeAction.last();
    if (await action.isVisible().catch(() => false) && await action.isEnabled().catch(() => false)) {
      await action.click({ timeout: 1500 }).catch(() => undefined);
      continue;
    }
    if (mounted) {
      const usable = await pane.getByRole('button', { name: /^(Open library|打开资料库)$/ }).click({ trial: true, timeout: 600 }).then(() => true, () => false);
      if (usable) return pane;
    } else if (await sidebar.isVisible().catch(() => false)) {
      const opened = await sidebar.click({ timeout: 600 }).then(() => true, () => false);
      if (opened) {
        await pane.locator('[data-pdf-side="source"], .web-reading-sheet[data-side="source"]').first().waitFor({ timeout: 25_000 });
        mounted = true;
        continue;
      }
    }
    await page.waitForTimeout(100);
  }
  const labels = await page.getByRole('button').allTextContents();
  throw new Error('DSH shell onboarding did not reach Paper Reader. Controls: ' + labels.join(' | ').slice(0, 480));
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

async function makePdf(context: BrowserContext, title: string, paragraphs: string[], twoColumn = false): Promise<Buffer> {
  const builder = await context.newPage();
  try {
    const colCss = twoColumn ? 'section{column-count:2;column-gap:0.35in}' : '';
    await builder.setContent(
      `<style>@page{size:letter;margin:0.8in}body{font:13pt Georgia;line-height:1.45}${colCss}</style>` +
      `<h1>${title}</h1><section>` + paragraphs.map(p => `<p>${p}</p>`).join('') + '</section>'
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

async function saveTargetLanguage(reader: Page | FrameLocator, target: string, options?: { custom?: boolean; zh?: boolean }): Promise<void> {
  await reader.locator('#more').click();
  await reader.locator('#menu').getByRole('button', { name: options?.zh ? '连接设置' : 'Connections', exact: true }).click();
  const dialog = reader.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  const select = dialog.getByRole('combobox', { name: options?.zh ? '翻译目标语言' : 'Translation language', exact: true });
  if (options?.custom) {
    await select.selectOption('__custom__');
    const customInput = dialog.getByLabel(options?.zh ? '自定义目标语言' : 'Custom target language', { exact: true });
    await customInput.waitFor({ state: 'visible' });
    await customInput.fill(target);
  } else {
    await select.selectOption(target);
  }
  await dialog.getByRole('button', { name: options?.zh ? '保存连接设置' : 'Save connections', exact: true }).click();
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

function snapshotDocSqliteCounts(dbPath: string, docId: string): { entries: number; annotations: number; chats: number; notebooks: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      entries: countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', docId),
      annotations: countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', docId),
      chats: countRows(db, 'SELECT COUNT(*) AS n FROM chat_exchanges WHERE docId=?', docId),
      notebooks: countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=?', docId)
    };
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
  const libraryId = '884442';
  const richKey = 'RICHZT42';
  const collectionKey = 'CITECL42';
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
      return { status: 200, headers: { 'Total-Results': '1' }, value: [{ key: collectionKey, data: { name: 'Tier4 Refs', parentCollection: false } }] };
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
}

async function startVersatileLlmFixture() {
  const key = randomUUID();
  const model = 'tier4-llm-fixture';
  const calls: LlmCall[] = [];
  let failNextWith502 = 0;

  const prefixByTarget: Record<string, string> = {
    'Japanese': '日本語訳: ',
    'French': 'Traduction française : ',
    'Spanish': 'Traducción al español: ',
    'Korean': '한국어 번역: ',
    'Brazilian Portuguese': 'Tradução PT-BR: '
  };

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

    let hasValidPng = false;
    if (Array.isArray(lastUser)) {
      const imgPart = lastUser.find(p => isRecord(p) && p.type === 'image_url') as { image_url?: { url?: string } } | undefined;
      const dataUrl = imgPart?.image_url?.url ?? '';
      if (dataUrl.startsWith('data:image/png;base64,')) {
        const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
        hasValidPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      }
    }

    const blockMatch = /Translate each passage in full into ([^.]+)\./.exec(system);
    if (blockMatch) {
      const target = blockMatch[1].trim();
      calls.push({ mode: 'blocks', target, hasValidPng: false });
      const userStr = typeof lastUser === 'string' ? lastUser : '';
      const parsed = JSON.parse(userStr) as { blocks: { id: string; text: string }[] };
      const translations = Object.fromEntries(parsed.blocks.map(block => {
        if (target === 'Simplified Chinese') return [block.id, '简体中文译文：分页注意力按需映射逻辑块与物理块。'];
        const prefix = prefixByTarget[target] ?? `[${target}] `;
        const snippet = block.text.length > 84 ? block.text.slice(0, 68) : block.text;
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
    calls.push({ mode: hasValidPng ? 'vision' : isPaperChat ? 'paper-chat' : 'passage', target, hasValidPng });

    const content = hasValidPng
      ? '截图解析：块表将逻辑块映射到物理显存块，避免连续分配碎片。'
      : isPaperChat
        ? '全文分析：该方案通过虚拟块表消除键值缓存内部碎片并支持前缀共享。'
        : `[${target}] Contextual answer for selected passage.`;

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
    setFailNextWith502: (n: number) => { failNextWith502 = n; },
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

const T4_07_WEB_URL = 'https://research.google/pubs/t4-07-web2/';
const T4_07_WEB_HTML = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><title>Selective Isolation Benchmark</title>
  <meta name="citation_title" content="Selective Isolation for Multi-Document Synthesis">
  <meta name="citation_author" content="Patel, Priya">
  <meta name="citation_author" content="Kim, Minho">
  <meta name="citation_journal_title" content="Proceedings of Reader Systems">
  <meta name="citation_publication_date" content="2025/01/18">
  <meta name="citation_doi" content="10.1000/prs.2025.19">
</head><body><article>
  <h1>Selective Isolation for Multi-Document Synthesis</h1>
  <p>Multi-document research workflows require strict deletion isolation across notes, marks, chat logs, and vocabulary records.</p>
</article></body></html>`;

const publisherLog = path.join(os.tmpdir(), `paper-reader-tier4-pub-${randomUUID()}.ndjson`);
await writeFile(publisherLog, '', { flag: 'wx' });

try {
  const openStax = await startPublisherFixture();
  try {
    const publisherRouter = await startCompositePublisher(openStax.origin, new Map([['/pubs/t4-07-web2/', T4_07_WEB_HTML]]));
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
              // T4-06 (RUNS FIRST on pristine unconfigured host):
              // Error Recovery, Offline Resilience & Live Host Theme Switching inside DSH shell iframe
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'zh-CN', colorScheme: 'light',
                  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write']
                });
                const scope: ErrorScope = { allowZotero503: true, allowExpected502: false };
                try {
                  const shellPage = await ctx.newPage();
                  attachErrorGuards(shellPage, 'T4-06', scope, pageErrors, consoleErrors);
                  const iframe = await openReaderInShell(shellPage, host.authenticatedUrl);
                  await iframe.locator('#loading').waitFor({ state: 'hidden', timeout: 25_000 });

                  // 1. Unconfigured LLM + Korean: local OPUS-MT gated OFF + localized Chinese guidance + 503 RPC
                  await saveTargetLanguage(iframe, 'Korean', { zh: true });
                  await iframe.locator('#parallel').click();
                  await iframe.getByRole('group', { name: '韩语，第 6 页', exact: true }).waitFor();
                  const unavailable = iframe.locator('.pdf-translation-state[data-state="unavailable"]');
                  await unavailable.waitFor({ state: 'visible' });
                  const guidance = (await unavailable.textContent()) ?? '';
                  assert.match(guidance, /内置离线翻译仅支持简体中文|请连接翻译模型以将本页翻译为韩语/);
                  const gatedRpc = await rpc(ctx.request, host.origin, 'translation.page', {
                    docId: 'pagedattention', page: 6, targetLanguage: 'Korean',
                    blocks: [{ id: 'p1', text: 'Paged attention avoids fragmentation.' }]
                  });
                  assert.equal(gatedRpc.status, 503, 'Local OPUS-MT must be gated OFF for Korean when LLM is unconfigured');

                  // 2. Flaky 502 LLM retry -> HTTP 200 Korean succeeds
                  await iframe.locator('#more').click();
                  await iframe.locator('#menu').getByRole('button', { name: '连接设置', exact: true }).click();
                  const connDlg = iframe.getByRole('dialog');
                  await connDlg.waitFor({ state: 'visible' });
                  await connDlg.getByLabel('API 接口地址').fill(llm.baseUrl);
                  await connDlg.getByLabel('模型', { exact: true }).fill(llm.model);
                  await connDlg.getByLabel('API 密钥', { exact: true }).fill(llm.key);
                  await connDlg.getByRole('button', { name: '保存连接设置', exact: true }).click();
                  await connDlg.waitFor({ state: 'hidden' });
                  llm.setFailNextWith502(1);
                  try {
                    scope.allowExpected502 = true;
                    await iframe.locator('.pdf-translation-state').getByRole('button', { name: '重试翻译', exact: true }).click();
                    const errState = iframe.locator('.pdf-translation-state[data-state="error"]');
                    await errState.waitFor({ state: 'visible', timeout: 15_000 });
                    await errState.getByRole('button', { name: '重试翻译', exact: true }).waitFor({ state: 'visible' });
                  } finally {
                    scope.allowExpected502 = false;
                  }
                  await iframe.locator('.pdf-translation-state[data-state="error"]').getByRole('button', { name: '重试翻译', exact: true }).click();
                  await iframe.locator('#translated .pdf-translated-text[lang="ko"]:visible').first().waitFor({ timeout: 15_000 });
                  const koText = (await iframe.locator('#translated .pdf-translated-text[lang="ko"]:visible').allInnerTexts()).join('\n');
                  assert.ok(koText.includes('한국어 번역:'), 'Expected Korean translation after retry: ' + koText);

                  // 3. Clipboard NotAllowedError fallback + blocked notice + .ris download recovery
                  await iframe.locator('#mobileRail').click();
                  await iframe.locator('#refsTab').click();
                  await iframe.locator('.citation-export').waitFor({ state: 'visible' });
                  await iframe.locator('body').evaluate((_el, code) => { new Function(code)(); }, `
                    window.__origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
                    window.__origExecCommand = document.execCommand.bind(document);
                    window.__fallbackCopied = '';
                    Object.defineProperty(navigator.clipboard, 'writeText', {
                      configurable: true,
                      value: function () { return Promise.reject(new DOMException('Clipboard permission denied', 'NotAllowedError')); }
                    });
                    document.execCommand = function (command) {
                      if (command === 'copy') {
                        const active = document.activeElement;
                        window.__fallbackCopied = active && 'value' in active ? String(active.value) : '';
                        return true;
                      }
                      return false;
                    };
                  `);
                  await iframe.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
                  await iframe.locator('.citation-export-status').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor();
                  const fallbackBib = await iframe.locator('body').evaluate(() => (window as unknown as { __fallbackCopied: string }).__fallbackCopied);
                  assert.ok(fallbackBib.startsWith('@inproceedings{kwon2023efficient,\n'), fallbackBib);

                  await iframe.locator('body').evaluate((_el, code) => { new Function(code)(); }, `document.execCommand = function () { return false; };`);
                  await iframe.getByRole('button', { name: '复制 RIS', exact: true }).click();
                  await iframe.locator('.citation-export-status').filter({ hasText: '剪贴板权限受限，请改用下载按钮。' }).waitFor();
                  const [risDl] = await Promise.all([
                    shellPage.waitForEvent('download'),
                    iframe.getByRole('button', { name: '下载 .ris', exact: true }).click()
                  ]);
                  const risFile = await readDownload(risDl);
                  assert.equal(risFile.filename, 'kwon2023efficient.ris');
                  assert.ok(risFile.text.startsWith('TY  - CONF\n') && risFile.text.trimEnd().endsWith('ER  -'));

                  await iframe.locator('body').evaluate((_el, code) => { new Function(code)(); }, `
                    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: window.__origWriteText });
                    document.execCommand = window.__origExecCommand;
                  `);

                  // 4. Live parent body[data-ds-dark-theme] toggle with Paper chat & settingsDialog open inside iframe
                  await iframe.locator('.paper-chat-toggle').click();
                  await iframe.locator('.paper-chat-input textarea').waitFor({ state: 'visible' });
                  await iframe.locator('#more').click();
                  await iframe.locator('#menu').getByRole('button', { name: '连接设置', exact: true }).click();
                  const settingsDlg = iframe.locator('#dialog');
                  await settingsDlg.waitFor({ state: 'visible' });

                  const readIframeTheme = () => iframe.locator('html').evaluate(el => ({
                    theme: el.dataset.theme ?? '',
                    scheme: getComputedStyle(el).colorScheme
                  }));
                  for (const dark of [true, false, true]) {
                    await shellPage.evaluate(enable => {
                      if (enable) document.body.setAttribute('data-ds-dark-theme', '');
                      else document.body.removeAttribute('data-ds-dark-theme');
                    }, dark);
                    await until(async () => (await readIframeTheme()).theme === (dark ? 'dark' : 'light'),
                      `Iframe data-theme did not sync to ${dark ? 'dark' : 'light'}`);
                    const state = await readIframeTheme();
                    assert.ok(state.scheme.includes(dark ? 'dark' : 'light'), `Expected color-scheme ${dark ? 'dark' : 'light'}, got ${state.scheme}`);
                  }
                  await assertDarkAndContrast(settingsDlg.getByRole('heading', { name: '连接设置' }), 'T4-06 live dark settingsDialog', 0.12, 4.5);
                  await iframe.locator('#closeDialog').click();
                  await settingsDlg.waitFor({ state: 'hidden' });
                  await assertDarkAndContrast(iframe.locator('.paper-chat-input textarea'), 'T4-06 live dark Paper chat', 0.12, 4.5);

                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T4-06: Offline Korean gating, 502 retry, clipboard fallback + .ris recovery, and live host dark-theme sync.');
                } finally {
                  await ctx.close();
                }
              }

              // T4-01: Chinese Researcher Deep-Reading Imported arXiv PDF in Dark Mode (1440x900, Dark, zh-CN)
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'zh-CN', colorScheme: 'dark',
                  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write']
                });
                const scope: ErrorScope = { allowZotero503: true, allowExpected502: false };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'Simplified Chinese'
                  });
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T4-01', scope, pageErrors, consoleErrors);

                  // ? shortcuts modal in dark zh-CN
                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('Shift+?');
                  await page.locator('#shortcutsDialog').waitFor({ state: 'visible' });
                  await assertDarkAndContrast(page.locator('#shortcutsDialog h2'), 'T4-01 shortcuts heading', 0.12, 4.5);
                  await page.keyboard.press('Escape');
                  await page.locator('#shortcutsDialog').waitFor({ state: 'hidden' });

                  // Import 2-column synthetic arXiv PDF
                  const arxivPdf = await makePdf(ctx, 'arXiv:2401.12345 Paged KV Cache Scheduling', [
                    'Virtual block tables map logical token sequences onto non-contiguous physical GPU memory blocks without pre-allocating maximum sequence lengths.',
                    'Copy-on-write sharing lets parallel beam-search candidates share common prompt prefixes while isolating divergent generation trajectories cleanly.',
                    'Dynamic memory reclamation returns freed blocks to the global allocator immediately when requests finish, increasing effective batch size substantially.',
                    'Empirical traces across mixed-length workloads demonstrate lower tail latency and near-zero internal fragmentation under sustained serving load.'
                  ], true);
                  const imp = await ctx.request.post(host.origin + '/api/paper-reader/import-pdf?title=T4-01-Arxiv-2401.12345.pdf', {
                    headers: { 'content-type': 'application/pdf' }, data: arxivPdf
                  });
                  assert.equal(imp.status(), 200);
                  const { doc: arxivDoc } = await imp.json() as { doc: DocumentInfo };

                  await page.goto(host.origin + appPath + `?doc=${encodeURIComponent(arxivDoc.id)}&page=1`, { waitUntil: 'domcontentloaded' });
                  await page.locator('#loading').waitFor({ state: 'hidden' });

                  // Press 'b' for bilingual -> Simplified Chinese -> Japanese -> back to Simplified Chinese (0 extra calls)
                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('b');
                  assert.equal(await page.locator('#reader').getAttribute('data-reading-mode'), 'bilingual');
                  await page.locator('#translated .pdf-translated-text[lang="zh-CN"]:visible').first().waitFor();

                  await saveTargetLanguage(page, 'Japanese', { zh: true });
                  await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').first().waitFor();

                  const callsBeforeZhReturn = llm.calls.length;
                  await saveTargetLanguage(page, 'Simplified Chinese', { zh: true });
                  await page.locator('#translated .pdf-translated-text[lang="zh-CN"]:visible').first().waitFor();
                  assert.equal(llm.calls.length, callsBeforeZhReturn, 'Returning to cached Simplified Chinese must make 0 LLM calls');

                  // Open Notes sidebar + Shift++ zoom + 1440px bilingual floor & #saveState >= 12px
                  await page.locator('#mobileRail').click();
                  await page.locator('#rail').waitFor({ state: 'visible' });
                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('Shift++');
                  assert.equal(await page.locator('#zoom').inputValue(), '1.25');
                  const saveFont = await page.locator('#saveState').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
                  assert.ok(saveFont >= 12, `Expected #saveState >= 12px, got ${saveFont}`);
                  await until(async () => {
                    const sizes = await page.evaluate(() =>
                      Array.from(document.querySelectorAll<HTMLElement>('#translated .pdf-translated-text'))
                        .filter(el => !el.hidden && el.offsetWidth > 0 && el.dataset.role === 'paragraph')
                        .map(el => (parseFloat(getComputedStyle(el).fontSize) || 0) * (el.getBoundingClientRect().width / el.offsetWidth))
                    );
                    return sizes.length > 0 && sizes.every(s => s >= 11.5);
                  }, 'T4-01 1440px bilingual floor >= 11.5px');
                  await page.keyboard.press('-');
                  assert.equal(await page.locator('#zoom').inputValue(), '1');

                  // Highlight + Margin pin -> verify both in 标记 tab
                  await selectFirstPdfRun(page);
                  await page.locator('#card').getByRole('button', { name: '高亮', exact: true }).click();
                  const sheetBox = (await page.locator('#original .pdf-sheet').boundingBox())!;
                  await page.locator('#placePin').click();
                  await page.mouse.click(sheetBox.x + sheetBox.width * 0.25, sheetBox.y + sheetBox.height * 0.35);
                  const popover = page.locator('.annotation-popover');
                  await popover.waitFor({ state: 'visible' });
                  await popover.getByRole('textbox', { name: '备注' }).fill('页边关键结论');
                  await popover.getByRole('button', { name: '保存', exact: true }).click();
                  await popover.waitFor({ state: 'hidden' });

                  await page.locator('#annotationsTab').click();
                  await until(async () => (await page.locator('.annotation-entry').count()) >= 2, 'Expected both highlight and pin in 标记 tab');

                  // 全文问答 -> 记入笔记 -> verify in 笔记 tab
                  await page.locator('.paper-chat-toggle').click();
                  const chatBox = page.getByRole('textbox', { name: '对这篇文章提问', exact: true });
                  await chatBox.fill('这篇论文的核心内存调度机制是什么？');
                  await chatBox.press('Enter');
                  await page.locator('.paper-answer').first().waitFor({ state: 'visible' });
                  await page.locator('.paper-chat').getByRole('button', { name: '记入笔记', exact: true }).click();
                  await page.locator('.paper-chat').getByRole('button', { name: '查看', exact: true }).click();
                  assert.equal(await page.locator('#notesTab').getAttribute('aria-selected'), 'true');
                  await page.locator('#rail').getByRole('link', { name: '全文问答', exact: true }).waitFor();

                  // 文献 -> Copy & Download .bib / .ris
                  await page.locator('#refsTab').click();
                  await page.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor();
                  const bibClip = await page.evaluate(() => navigator.clipboard.readText());
                  assert.ok(bibClip.startsWith('@'), bibClip);
                  const [bibDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载 .bib', exact: true }).click()]);
                  assert.match((await readDownload(bibDl)).filename, /^[a-z0-9]+\.bib$/);
                  await page.getByRole('button', { name: '复制 RIS', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'RIS 已复制到剪贴板。' }).waitFor();
                  const [risDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载 .ris', exact: true }).click()]);
                  const risFile = await readDownload(risDl);
                  assert.match(risFile.filename, /^[a-z0-9]+\.ris$/);
                  assert.ok(risFile.text.trimEnd().endsWith('ER  -'));

                  // Save vocab + 生词与历史 ARIA ArrowRight/Home/End
                  assert.equal((await rpc(ctx.request, host.origin, 'vocab.save', {
                    docId: arxivDoc.id, title: arxivDoc.title, page: 1, anchor: 'p1', label: '第 1 页',
                    sourceUrl: page.url(), text: 'reclamation', meaning: '内存回收', context: 'Dynamic memory reclamation'
                  })).status, 200);
                  await page.locator('#more').click();
                  await page.locator('#menu').getByRole('button', { name: '生词与历史', exact: true }).click();
                  const colDlg = page.locator('#dialog');
                  await colDlg.waitFor({ state: 'visible' });
                  const vTab = colDlg.getByRole('tab', { name: '生词', exact: true });
                  const hTab = colDlg.getByRole('tab', { name: '历史', exact: true });
                  await vTab.focus();
                  await page.keyboard.press('ArrowRight');
                  assert.equal(await hTab.getAttribute('aria-selected'), 'true');
                  await page.keyboard.press('Home');
                  assert.equal(await vTab.getAttribute('aria-selected'), 'true');
                  await page.keyboard.press('End');
                  assert.equal(await hTab.getAttribute('aria-selected'), 'true');
                  await page.locator('#closeDialog').click();
                  await colDlg.waitFor({ state: 'hidden' });

                  // Reload persistence + full zh-CN chrome sweep
                  await page.reload({ waitUntil: 'domcontentloaded' });
                  await page.locator('#loading').waitFor({ state: 'hidden' });
                  assert.equal((await rpc<ReaderState>(ctx.request, host.origin, 'state')).body.settings.targetLanguage, 'Simplified Chinese');
                  if (!(await page.locator('#rail').isVisible())) await page.locator('#mobileRail').click();
                  await page.locator('#annotationsTab').click();
                  await until(async () => (await page.locator('.annotation-entry').count()) >= 2, 'Reloaded 标记 must retain 2 marks');
                  await page.locator('#notesTab').click();
                  await page.locator('#rail').getByRole('link', { name: '全文问答', exact: true }).waitFor();
                  if (!(await page.locator('.paper-answer').first().isVisible())) await page.locator('.paper-chat-toggle').click();
                  await page.locator('.paper-answer').first().waitFor({ state: 'visible' });
                  assertNoZhEnglishLeaks(await collectChromeStrings(page), 'T4-01 reloaded zh-CN');

                  await rpc(ctx.request, host.origin, 'library.delete', { id: arxivDoc.id });
                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T4-01: Chinese researcher deep-reading workflow in dark mode with full persistence and zero leaks.');
                } finally {
                  await ctx.close();
                }
              }

              // T4-02: Multilingual Scholar: French + Custom Language + Zotero + Obsidian Vault (1440x900, Light, en-US)
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light',
                  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write']
                });
                const scope: ErrorScope = { allowZotero503: false, allowExpected502: false };
                try {
                  await authContext(ctx, host);
                  const vault = path.join(host.scratch, 't4-02-vault');
                  await mkdir(vault, { recursive: true });
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'French',
                    vaultPath: vault, zoteroMode: 'web', zoteroLibraryType: 'group',
                    zoteroLibraryId: zotero.libraryId, zoteroApiKey: zotero.credential
                  });

                  const scholarPdf = await makePdf(ctx, 'Multilingual Scholar Manuscript', [
                    'Analytical engine memory tables decouple logical allocation from physical bank placement.',
                    'Portable citations link local reading archives with external Zotero bibliographic records.'
                  ]);
                  const imp = await ctx.request.post(host.origin + '/api/paper-reader/import-pdf?title=t4-02-scholar.pdf', {
                    headers: { 'content-type': 'application/pdf' }, data: scholarPdf
                  });
                  assert.equal(imp.status(), 200);
                  const { doc: scholarDoc } = await imp.json() as { doc: DocumentInfo };

                  const page = await openReaderPage(ctx, host, `?doc=${encodeURIComponent(scholarDoc.id)}&page=1`, 'T4-02', scope, pageErrors, consoleErrors);
                  await page.locator('#parallel').click();
                  await page.getByRole('group', { name: 'French, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text[lang="fr"]:visible').first().waitFor();
                  assert.ok((await page.locator('#translated .pdf-translated-text[lang="fr"]:visible').allInnerTexts()).join('\n').includes('Traduction française :'));
                  const callsAfterFr = llm.calls.length;

                  // Link Zotero item + export merged BibTeX & RIS
                  await page.locator('#mobileRail').click();
                  await page.locator('#refsTab').click();
                  await page.locator('#railBody input[aria-label="Search Zotero"]').fill('Analytical');
                  await page.getByRole('button', { name: 'Find item', exact: true }).click();
                  await page.getByRole('button', { name: zotero.richItem.data.title, exact: true }).click();
                  await page.getByRole('button', { name: 'Link this item', exact: true }).click();
                  await page.locator('#railBody').getByText('Linked reference', { exact: true }).waitFor();

                  await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor();
                  const bib = await page.evaluate(() => navigator.clipboard.readText());
                  assert.ok(bib.startsWith('@article{lovelace2024analytical,\n') && bib.includes('10.1000/zotero.2024.42'), bib);
                  const [risDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .ris', exact: true }).click()]);
                  const ris = await readDownload(risDl);
                  assert.ok(ris.text.includes('AU  - Ada Lovelace\n') && ris.text.includes('DO  - 10.1000/zotero.2024.42\n'));

                  // Save passage note + export portable Obsidian Markdown & verify via vault-links.ts
                  const noteCtx = { docId: scholarDoc.id, title: scholarDoc.title, page: 1, sourceUrl: page.url() };
                  assert.equal((await rpc(ctx.request, host.origin, 'note.save', {
                    ...noteCtx, anchor: 'p1', label: 'Page 1', quote: 'memory tables',
                    text: 'Key observation for multilingual synthesis.', insert: true
                  })).status, 200);
                  const exp = await rpc<{ path: string }>(ctx.request, host.origin, 'obsidian.export', noteCtx);
                  assert.equal(exp.status, 200);
                  assert.equal(path.dirname(exp.body.path), path.join(vault, 'Paper Reader'));
                  const md = visibleMarkdown(await readFile(exp.body.path, 'utf8'));
                  assert.ok(md.includes('Key observation for multilingual synthesis.'));
                  const links = markdownLinks(md);
                  const pdfLink = links.find(l => l.target.includes('.pdf'));
                  assert.ok(pdfLink, 'Expected portable PDF link in Obsidian note: ' + JSON.stringify(links));
                  const copied = vaultSource(vault, exp.body.path, pdfLink.target);
                  assert.equal(copied.fragment, 'page=1');
                  assert.ok((await readFile(copied.file)).subarray(0, 5).equals(Buffer.from('%PDF-')));
                  assert.ok(links.some(l => l.label === 'Zotero' && l.target === zotero.richItem.links.alternate.href));

                  // Switch to custom "Brazilian Portuguese" -> then back to French (0 extra LLM calls)
                  await saveTargetLanguage(page, 'Brazilian Portuguese', { custom: true });
                  await page.getByRole('group', { name: 'Brazilian Portuguese, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text:visible').first().waitFor();
                  const ptLang = await page.locator('#translated .pdf-translated-text:visible').first().getAttribute('lang');
                  assert.ok(ptLang === null || ptLang === 'und', 'Custom Brazilian Portuguese must omit lang or use und, got: ' + String(ptLang));
                  assert.ok((await page.locator('#translated .pdf-translated-text:visible').allInnerTexts()).join('\n').includes('Tradução PT-BR:'));
                  assert.ok(llm.calls.length > callsAfterFr, 'Custom language must invoke LLM');

                  const callsBeforeFrReturn = llm.calls.length;
                  await saveTargetLanguage(page, 'French');
                  await page.getByRole('group', { name: 'French, page 1', exact: true }).waitFor();
                  await page.locator('#translated .pdf-translated-text[lang="fr"]:visible').first().waitFor();
                  assert.equal(llm.calls.length, callsBeforeFrReturn, 'Returning to French must hit cache with 0 repeat LLM calls');

                  await rpc(ctx.request, host.origin, 'library.delete', { id: scholarDoc.id });
                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T4-02: French + custom Brazilian Portuguese + Zotero + Obsidian vault export + 0-call cache return.');
                } finally {
                  await ctx.close();
                }
              }

              // T4-04: Mobile Commuter Bilingual Reading, Screenshot Q&A & Citation Export (390x844, Dark, zh-CN)
              {
                const ctx = await browser.newContext({
                  viewport: { width: 390, height: 844 }, locale: 'zh-CN', colorScheme: 'dark',
                  isMobile: true, hasTouch: true, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write']
                });
                const scope: ErrorScope = { allowZotero503: true, allowExpected502: false };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'Simplified Chinese'
                  });
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T4-04', scope, pageErrors, consoleErrors);
                  const titleBox = await page.locator('#docTitle').boundingBox();
                  assert.ok(titleBox && titleBox.width >= 64);
                  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
                  await assertDarkAndContrast(page.locator('.topbar #docTitle'), 'T4-04 mobile topbar', 0.08, 4.5);

                  // #more -> 快捷键 & 生词与历史
                  await page.locator('#more').click();
                  await page.locator('#menu').getByRole('button', { name: '快捷键', exact: true }).click();
                  await page.locator('#shortcutsDialog').waitFor({ state: 'visible' });
                  await page.locator('#closeShortcuts').click();
                  await page.locator('#shortcutsDialog').waitFor({ state: 'hidden' });

                  await page.locator('#more').click();
                  await page.locator('#menu').getByRole('button', { name: '生词与历史', exact: true }).click();
                  await page.locator('#dialog').getByRole('tablist').waitFor();
                  await page.locator('#closeDialog').click();
                  await page.locator('#dialog').waitFor({ state: 'hidden' });

                  // Bottom-sheet tabs 目录/笔记/标记/文献
                  await page.locator('#mobileRail').click();
                  await page.locator('#rail').waitFor({ state: 'visible' });
                  assert.deepEqual(await page.locator('#rail .rail-head [role="tab"]').allInnerTexts(), ['目录', '笔记', '标记', '文献']);
                  await page.locator('#closeRail').click();
                  await page.locator('#rail').waitFor({ state: 'hidden' });

                  // Touch region screenshot capture (sharp F1) -> AI Q&A -> 记入笔记
                  await page.locator('#captureRegion').tap();
                  await page.locator('.pdf-capture-surface').waitFor({ state: 'visible' });
                  const fig = page.locator('#original .pdf-figure[data-block-id="figure-6"]');
                  await fig.scrollIntoViewIfNeeded();
                  const rect = (await fig.boundingBox())!;
                  await dragBox(
                    page,
                    { x: Math.round(rect.x + rect.width * 0.12), y: Math.round(rect.y + rect.height * 0.12) },
                    { x: Math.round(rect.x + rect.width * 0.78), y: Math.round(rect.y + rect.height * 0.62) },
                    true
                  );
                  await page.locator('.pdf-capture-actions').getByRole('button', { name: '提问', exact: true }).tap();
                  const composer = page.locator('#card .selection-chat textarea');
                  await composer.waitFor({ state: 'visible' });
                  await composer.fill('图中物理块如何分配？');
                  await page.locator('#card .selection-chat').getByRole('button', { name: '发送', exact: true }).click();
                  await page.locator('#card .selection-answer').getByText('截图解析：块表将逻辑块映射到物理显存块').waitFor();
                  const visionCall = llm.calls.at(-1);
                  assert.ok(visionCall?.hasValidPng, 'Mobile region Q&A must deliver valid sharp-decoded PNG bytes');
                  const natW = await page.locator('#card img').first().evaluate(img => (img as HTMLImageElement).naturalWidth);
                  assert.ok(natW > 0, 'Mobile cropped preview image must load');

                  await page.locator('#card').getByRole('button', { name: '记入笔记', exact: true }).click();
                  await page.locator('#card').getByText('已记入', { exact: true }).waitFor();
                  await page.locator('#card').getByRole('button', { name: '收起讨论', exact: true }).click();
                  await page.locator('#card').waitFor({ state: 'hidden' });

                  // Verify saved excerpt in 笔记 & copy BibTeX/RIS in 文献
                  await page.locator('#mobileRail').click();
                  await page.locator('#notesTab').click();
                  await page.locator('#rail .cm-content').filter({ hasText: '块表将逻辑块映射到物理显存块' }).waitFor();
                  await page.locator('#refsTab').click();
                  await page.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor();
                  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith('@inproceedings{kwon2023efficient,\n'));
                  await page.getByRole('button', { name: '复制 RIS', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'RIS 已复制到剪贴板。' }).waitFor();
                  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith('TY  - CONF\n'));

                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T4-04: Mobile 390x844 dark zh-CN touch screenshot Q&A + Notes + BibTeX/RIS export.');
                } finally {
                  await ctx.close();
                }
              }

              // T4-05: OpenStax Textbook Keyboard-First Multi-Chapter Study with Reduced Motion (1440x900, Dark, en-US)
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark', reducedMotion: 'reduce'
                });
                const scope: ErrorScope = { allowZotero503: true, allowExpected502: false };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'Spanish'
                  });
                  const opened = await rpc<{ doc: DocumentInfo }>(ctx.request, host.origin, 'web.open', { url: bookRoot + sections.start.slug });
                  assert.equal(opened.status, 200);
                  const bookId = opened.body.doc.id;

                  const page = await openReaderPage(ctx, host, `?doc=${encodeURIComponent(bookId)}&page=1`, 'T4-05', scope, pageErrors, consoleErrors);
                  const sheet = page.locator('.web-reading-sheet[data-side="source"]');
                  await sheet.waitFor({ state: 'visible' });
                  await assertDarkAndContrast(sheet.locator('h1, h2').first(), 'T4-05 OpenStax dark heading', 0.12, 4.5);
                  await assertDarkAndContrast(sheet.locator('p').first(), 'T4-05 OpenStax dark paragraph', 0.12, 4.5);

                  const motion = await page.evaluate(() => {
                    let has001 = false;
                    for (const s of Array.from(document.styleSheets)) {
                      try {
                        for (const r of Array.from(s.cssRules)) if (r.cssText.includes('0.01ms')) has001 = true;
                      } catch { /* ignore */ }
                    }
                    return { has001, scrollBehavior: getComputedStyle(document.getElementById('paperScroll')!).scrollBehavior };
                  });
                  assert.equal(motion.has001, false);
                  assert.equal(motion.scrollBehavior, 'auto');

                  await page.locator('#parallel').click();
                  await page.locator('#translate').click();
                  const trans = page.locator('.web-reading-sheet[data-side="translation"][lang="es"]');
                  await trans.getByText('Traducción al español:').first().waitFor();
                  const callsAfterSec1 = llm.calls.length;

                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('ArrowRight');
                  await page.waitForURL(u => u.searchParams.get('page') === '2');
                  await page.evaluate(() => { document.getElementById('paperScroll')!.scrollTop = 260; });
                  await page.waitForTimeout(350);

                  await page.locator('#mobileRail').click();
                  await page.locator('#contentsTab').click();
                  const section2Title = opened.body.doc.book!.sections[1].title;
                  await page.locator('#contentsPanel [aria-current="location"]').filter({ hasText: section2Title }).waitFor();

                  await page.locator('#notesTab').click();
                  const notesBox = page.getByRole('textbox', { name: 'Notes Markdown', exact: true });
                  await notesBox.click();
                  await page.keyboard.type('Chapter 2 study summary.');
                  await page.locator('.notebook-save').click();
                  await page.locator('.notebook-status[data-saved="true"]').waitFor();
                  await page.locator('#closeRail').click();

                  await page.locator('#paperScroll').focus();
                  await page.keyboard.press('ArrowLeft');
                  await page.waitForURL(u => u.searchParams.get('page') === '1');
                  await trans.getByText('Traducción al español:').first().waitFor();
                  assert.equal(llm.calls.length, callsAfterSec1, 'ArrowLeft back to section 1 must hit Spanish cache with 0 extra LLM calls');

                  // Delete active OpenStax book via Library UI and verify complete purge (including book_positions & book-sections/)
                  await page.locator('#library').click();
                  const dlg = page.getByRole('dialog');
                  await dlg.waitFor({ state: 'visible' });
                  await dlg.getByRole('tab', { name: 'On this device', exact: true }).click();
                  const row = dlg.locator('.library-device-item').filter({ hasText: opened.body.doc.title });
                  await row.getByRole('button', { name: 'Delete document', exact: true }).click();
                  await row.getByRole('button', { name: 'Confirm delete', exact: true }).click();
                  await dlg.getByText('Document removed from this device.', { exact: true }).waitFor();
                  await page.waitForURL(u => u.searchParams.get('doc') === 'pagedattention');
                  await page.locator('#loading').waitFor({ state: 'hidden' });

                  assert.equal(existsSync(path.join(host.scratch, 'reader', 'book-sections', bookId)), false, 'book-sections/<id> must be removed');
                  assertZeroSqliteRows(dbPath, bookId);
                  const leftoverKeys = await page.evaluate(id => Object.keys(localStorage).filter(k => k.includes(id)), bookId);
                  assert.deepEqual(leftoverKeys, [], 'Deleted OpenStax localStorage keys must be purged');

                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T4-05: OpenStax dark Spanish + ArrowRight/ArrowLeft cache + chapter note + complete delete purge.');
                } finally {
                  await ctx.close();
                }
              }

              // T4-07: Multi-Document Research Synthesis & Selective Deletion Isolation (1440x900, Light, en-US)
              {
                const ctx = await browser.newContext({
                  viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light',
                  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write']
                });
                const scope: ErrorScope = { allowZotero503: true, allowExpected502: false };
                try {
                  await authContext(ctx, host);
                  await resetSettings(ctx.request, host.origin, {
                    baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'Simplified Chinese'
                  });
                  const pdf1Bytes = await makePdf(ctx, 'Synthesis Target PDF One', [
                    'Selective deletion must remove only target document rows while keeping sibling records intact.'
                  ]);
                  const imp1 = await ctx.request.post(host.origin + '/api/paper-reader/import-pdf?title=t4-07-pdf1.pdf', {
                    headers: { 'content-type': 'application/pdf' }, data: pdf1Bytes
                  });
                  assert.equal(imp1.status(), 200);
                  const { doc: pdf1 } = await imp1.json() as { doc: DocumentInfo };

                  const web2Res = await rpc<{ doc: DocumentInfo }>(ctx.request, host.origin, 'web.open', { url: T4_07_WEB_URL });
                  assert.equal(web2Res.status, 200);
                  const web2 = web2Res.body.doc;

                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', 'T4-07', scope, pageErrors, consoleErrors);

                  // Populate Marks, Notes, Vocab, Paper chat, and localStorage across ALL 3 docs
                  const docs = [
                    { id: 'pagedattention', title: 'PagedAttention.pdf', page: 6, term: 'paged-term' },
                    { id: pdf1.id, title: pdf1.title, page: 1, term: 'pdf1-synthesis-term' },
                    { id: web2.id, title: web2.title, page: 1, term: 'web2-isolation-term' }
                  ];
                  for (const d of docs) {
                    const url = host.origin + appPath + `?doc=${encodeURIComponent(d.id)}&page=${d.page}`;
                    assert.equal((await rpc(ctx.request, host.origin, 'vocab.save', {
                      docId: d.id, title: d.title, page: d.page, anchor: 'p1', label: 'Page ' + d.page,
                      sourceUrl: url, text: d.term, meaning: 'meaning-' + d.term, context: 'context-' + d.term
                    })).status, 200);
                    assert.equal((await rpc(ctx.request, host.origin, 'annotation.save', {
                      id: randomUUID(), docId: d.id, title: d.title, page: d.page, anchor: 'point-400000-400000',
                      label: 'Page note', sourceUrl: url, kind: 'pin', color: 'purple', quote: '', text: 'mark-' + d.term,
                      point: { x: 0.4, y: 0.4 }
                    })).status, 200);
                    const nb = await rpc<{ revision: string }>(ctx.request, host.origin, 'notebook.get', {
                      docId: d.id, title: d.title, page: d.page, sourceUrl: url
                    });
                    assert.equal((await rpc(ctx.request, host.origin, 'notebook.write', {
                      docId: d.id, title: d.title, page: d.page, sourceUrl: url,
                      expectedRevision: nb.body.revision, markdown: '# Synthesis note for ' + d.term
                    })).status, 200);

                    await page.goto(url, { waitUntil: 'domcontentloaded' });
                    await page.locator('#loading').waitFor({ state: 'hidden' });
                    if (!(await page.locator('.paper-chat-input textarea').isVisible())) {
                      await page.locator('.paper-chat-toggle').click();
                    }
                    const chatInput = page.getByRole('textbox', { name: 'Message about this paper', exact: true });
                    await chatInput.fill('Question for ' + d.term);
                    await chatInput.press('Enter');
                    await page.locator('.paper-answer').last().waitFor({ state: 'visible' });
                  }

                  await page.evaluate(({ ids }) => {
                    for (const id of ids) {
                      localStorage.setItem('reader.page.' + id, '1');
                      localStorage.setItem('reader.tab.' + id, 'notes');
                      localStorage.setItem('reader.focus.' + id + '.1', 'p-1');
                    }
                  }, { ids: docs.map(d => d.id) });

                  const beforeSample = snapshotDocSqliteCounts(dbPath, 'pagedattention');
                  const beforeWeb2 = snapshotDocSqliteCounts(dbPath, web2.id);
                  assert.ok(beforeSample.entries >= 1 && beforeSample.annotations >= 1 && beforeSample.chats >= 1 && beforeSample.notebooks >= 1);
                  assert.ok(beforeWeb2.entries >= 1 && beforeWeb2.annotations >= 1 && beforeWeb2.chats >= 1 && beforeWeb2.notebooks >= 1);

                  // Navigate via collectionsDialog keyboard arrows -> jump to PDF #1
                  await page.locator('#more').click();
                  await page.locator('#menu').getByRole('button', { name: 'Vocabulary and history', exact: true }).click();
                  const colDlg = page.locator('#dialog');
                  await colDlg.waitFor({ state: 'visible' });
                  const vTab = colDlg.getByRole('tab', { name: 'Vocabulary', exact: true });
                  await vTab.focus();
                  await page.keyboard.press('ArrowRight');
                  await page.keyboard.press('Home');
                  assert.equal(await vTab.getAttribute('aria-selected'), 'true');
                  const pdf1Row = colDlg.locator('.list-row').filter({ hasText: 'pdf1-synthesis-term' });
                  await pdf1Row.getByRole('button', { name: pdf1.title, exact: true }).click();
                  await colDlg.waitFor({ state: 'hidden' });
                  await page.waitForURL(u => u.searchParams.get('doc') === pdf1.id);

                  // Export BibTeX on PDF #1 & RIS on Web #2
                  if (!(await page.locator('#rail').isVisible())) await page.locator('#mobileRail').click();
                  await page.locator('#refsTab').click();
                  await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
                  await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor();
                  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith('@'));

                  await page.goto(host.origin + appPath + `?doc=${encodeURIComponent(web2.id)}&page=1`, { waitUntil: 'domcontentloaded' });
                  await page.locator('#loading').waitFor({ state: 'hidden' });
                  if (!(await page.locator('#rail').isVisible())) await page.locator('#mobileRail').click();
                  await page.locator('#refsTab').click();
                  const [web2RisDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .ris', exact: true }).click()]);
                  const web2Ris = await readDownload(web2RisDl);
                  assert.ok(web2Ris.text.includes('AU  - Patel, Priya\n') && web2Ris.text.includes('DO  - 10.1000/prs.2025.19\n'));

                  // Delete PDF #1 via Library UI
                  await page.locator('#library').click();
                  const libDlg = page.getByRole('dialog');
                  await libDlg.waitFor({ state: 'visible' });
                  await libDlg.getByRole('tab', { name: 'On this device', exact: true }).click();
                  const row1 = libDlg.locator('.library-device-item').filter({ hasText: pdf1.title });
                  await row1.getByRole('button', { name: 'Delete document', exact: true }).click();
                  await row1.getByRole('button', { name: 'Confirm delete', exact: true }).click();
                  await libDlg.getByText('Document removed from this device.', { exact: true }).waitFor();
                  await page.locator('#closeDialog').click();

                  // Verify 100% purge for PDF #1 and 100% retention for pagedattention + Web #2
                  assertZeroSqliteRows(dbPath, pdf1.id);
                  assert.deepEqual(snapshotDocSqliteCounts(dbPath, 'pagedattention'), beforeSample, 'pagedattention SQLite rows must be 100% retained');
                  assert.deepEqual(snapshotDocSqliteCounts(dbPath, web2.id), beforeWeb2, 'Web #2 SQLite rows must be 100% retained');

                  const lsAudit = await page.evaluate(({ delId, keepA, keepB }) => {
                    const keys = Object.keys(localStorage);
                    return {
                      del: keys.filter(k => k.includes(delId)),
                      keepA: keys.filter(k => k.includes(keepA)),
                      keepB: keys.filter(k => k.includes(keepB))
                    };
                  }, { delId: pdf1.id, keepA: 'pagedattention', keepB: web2.id });
                  assert.deepEqual(lsAudit.del, [], 'PDF #1 localStorage keys must be purged');
                  assert.ok(lsAudit.keepA.length >= 3, 'pagedattention localStorage keys must remain intact');
                  assert.ok(lsAudit.keepB.length >= 3, 'Web #2 localStorage keys must remain intact');

                  await rpc(ctx.request, host.origin, 'library.delete', { id: web2.id });
                  await resetSettings(ctx.request, host.origin);
                  console.log('PASS T4-07: Multi-document synthesis, collections jump, BibTeX/RIS export, and selective deletion isolation.');
                } finally {
                  await ctx.close();
                }
              }
            } finally {
              await browser.close();
            }

            // T4-03 (RUNS LAST in launchPersistentContext):
            // Extension Academic Web Discovery -> Dark Reader Study -> Rename -> Complete Delete Lifecycle
            {
              const extServer = createServer((_req, res) => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
                  <html lang="en"><head><meta charset="utf-8"><title>Extension Lifecycle Study</title>
                  <meta name="citation_title" content="End-to-End Academic Web Capture Study">
                  <meta name="citation_author" content="Wang, Mei">
                  <meta name="citation_journal_title" content="Journal of Web Archiving">
                  <meta name="citation_publication_date" content="2025/04/01">
                  <meta name="citation_doi" content="10.1000/jwa.2025.77">
                  </head><body><article>
                  <h1>End-to-End Academic Web Capture Study</h1>
                  <p>Evaluating <strong id="term">PagedAttention</strong> capture, dark reading, renaming, and full deletion.</p>
                  </article></body></html>`);
              });
              await new Promise<void>(resolve => extServer.listen(0, '127.0.0.1', resolve));
              const extAddr = extServer.address();
              assert.ok(extAddr && typeof extAddr === 'object');
              const extUrl = `http://ext-cite-t4.test:${extAddr.port}/paper`;
              const profileDir = path.join(host.scratch, 't4-03-ext-profile-' + randomUUID().slice(0, 6));
              await mkdir(profileDir, { recursive: true });
              const scope: ErrorScope = { allowZotero503: true, allowExpected502: false };
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
                  '--no-proxy-server', '--host-resolver-rules=MAP ext-cite-t4.test 127.0.0.1'
                ]
              });
              try {
                const bcdp = await extCtx.browser()!.newBrowserCDPSession();
                const { id: extId } = await bcdp.send('Extensions.loadUnpacked', { path: extensionDir });
                await bcdp.detach();

                const authPage = extCtx.pages()[0] ?? await extCtx.newPage();
                await authPage.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
                await resetSettings(extCtx.request, host.origin, {
                  baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key, targetLanguage: 'Simplified Chinese'
                });

                const articlePage = await extCtx.newPage();
                attachErrorGuards(articlePage, 'T4-03-article', scope, pageErrors, consoleErrors);
                await articlePage.goto(extUrl, { waitUntil: 'domcontentloaded' });

                const popup = await openToolbar(articlePage, extId);
                const popupInfo = await popup.evaluate((helper: string) => {
                  const fn = new Function(helper + `return { lang: document.documentElement.lang, body: measureElement(document.body) };`) as () => { lang: string; body: ColorMetrics };
                  return fn();
                }, CONTRAST_HELPER) as { lang: string; body: ColorMetrics };
                assert.equal(popupInfo.lang, 'zh-CN');
                assert.ok(popupInfo.body.bgLum <= 0.08);
                await popup.click('summary');
                await popup.evaluate(origin => {
                  document.querySelector<HTMLInputElement>('#origin')!.value = origin;
                  document.querySelector('form')!.requestSubmit();
                }, host.origin);
                await until(() => popup.evaluate(() => /地址已保存/.test(document.querySelector('#message')?.textContent ?? ''), null),
                  'T4-03 popup origin save failed');
                await popup.click('#toggle');
                await popup.detach();

                await articlePage.locator('#term').dblclick();
                await until(async () => Boolean(await cardElement(articlePage, '.card')), 'T4-03 shadow card did not open');
                const cardInfo = await inspectClosedShadowCard(articlePage);
                assert.ok(cardInfo && cardInfo.lang === 'zh-CN' && cardInfo.card.colorScheme === 'dark');
                assert.ok(cardInfo.card.bgLum <= 0.08 && cardInfo.heading.ratio >= 4.5);
                assert.equal(cardInfo.translate, '翻译');
                assert.equal(cardInfo.note, '记入笔记');

                const [readerTab] = await Promise.all([
                  extCtx.waitForEvent('page'),
                  clickCard(articlePage, '[data-do="open"]')
                ]);
                attachErrorGuards(readerTab, 'T4-03-reader', scope, pageErrors, consoleErrors);
                await readerTab.waitForLoadState('domcontentloaded');
                await readerTab.locator('#loading').waitFor({ state: 'hidden', timeout: 25_000 });
                const articleId = new URL(readerTab.url()).searchParams.get('doc')!;
                assert.ok(articleId && articleId !== 'pagedattention');
                assert.equal(await readerTab.evaluate(() => document.documentElement.dataset.theme), 'dark');
                await assertDarkAndContrast(readerTab.locator('.web-reading-sheet[data-side="source"] h1'), 'T4-03 dark web sheet', 0.12, 4.5);

                // Add Mark, Paper chat turn, and Note + seed localStorage/sessionStorage
                assert.equal((await rpc(extCtx.request, host.origin, 'annotation.save', {
                  id: randomUUID(), docId: articleId, title: 'End-to-End Academic Web Capture Study', page: 1,
                  anchor: 'p-1', label: '第 1 段', sourceUrl: readerTab.url(), kind: 'highlight', color: 'yellow',
                  quote: 'PagedAttention', text: '扩展抓取高亮'
                })).status, 200);
                await readerTab.locator('.paper-chat-toggle').click();
                const chatBox = readerTab.getByRole('textbox', { name: '对这篇文章提问', exact: true });
                await chatBox.fill('总结这篇文章的网页抓取流程。');
                await chatBox.press('Enter');
                await readerTab.locator('.paper-answer').first().waitFor({ state: 'visible' });
                await readerTab.locator('.paper-chat').getByRole('button', { name: '记入笔记', exact: true }).click();
                await readerTab.locator('.paper-chat').getByText('已记入', { exact: true }).waitFor();

                await readerTab.evaluate(id => {
                  localStorage.setItem('reader.page.' + id, '1');
                  localStorage.setItem('reader.tab.' + id, 'notes');
                  sessionStorage.setItem('reader.selection-note-draft.' + JSON.stringify([id, 1, 'p-1', 'q']), 'draft');
                }, articleId);

                // Export BibTeX & RIS from <meta citation_*>
                if (!(await readerTab.locator('#rail').isVisible())) await readerTab.locator('#mobileRail').click();
                await readerTab.locator('#refsTab').click();
                await readerTab.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
                await readerTab.locator('.citation-export-status').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor();
                const extBib = await readerTab.evaluate(() => navigator.clipboard.readText());
                assert.ok(extBib.includes('Wang, Mei') && extBib.includes('10.1000/jwa.2025.77'), extBib);
                const [risDl] = await Promise.all([
                  readerTab.waitForEvent('download'),
                  readerTab.getByRole('button', { name: '下载 .ris', exact: true }).click()
                ]);
                const extRis = await readDownload(risDl);
                assert.ok(extRis.text.startsWith('TY  - JOUR\n') && extRis.text.includes('DO  - 10.1000/jwa.2025.77\n'));

                // Rename active article -> verify #docTitle -> Delete active article -> verify fallback + 0 SQLite/storage
                await readerTab.locator('#library').click();
                const dlg = readerTab.getByRole('dialog');
                await dlg.waitFor({ state: 'visible' });
                await dlg.getByRole('tab', { name: '本机文档', exact: true }).click();
                const itemRow = dlg.locator('.library-device-item').filter({ hasText: 'End-to-End Academic Web Capture Study' });
                await itemRow.getByRole('button', { name: '重命名文档', exact: true }).click();
                const titleInput = dlg.getByRole('textbox', { name: '文档标题', exact: true });
                await titleInput.fill('重命名后的深度研究文章');
                await dlg.getByRole('button', { name: '保存', exact: true }).click();
                await readerTab.locator('#docTitle').filter({ hasText: '重命名后的深度研究文章' }).waitFor();

                const renamedRow = dlg.locator('.library-device-item').filter({ hasText: '重命名后的深度研究文章' });
                await renamedRow.getByRole('button', { name: '删除文档', exact: true }).click();
                await renamedRow.getByRole('button', { name: '确认删除', exact: true }).click();
                await readerTab.locator('#toast').filter({ hasText: '已从本机删除文档。' }).waitFor();
                await readerTab.waitForURL(u => u.searchParams.get('doc') === 'pagedattention');
                await readerTab.locator('#loading').waitFor({ state: 'hidden' });

                assertZeroSqliteRows(dbPath, articleId);
                const remaining = await readerTab.evaluate(id => ({
                  local: Object.keys(localStorage).filter(k => k.includes(id)),
                  session: Object.keys(sessionStorage).filter(k => k.includes(id))
                }), articleId);
                assert.deepEqual(remaining.local, [], 'Deleted extension article localStorage keys must be purged');
                assert.deepEqual(remaining.session, [], 'Deleted extension article sessionStorage keys must be purged');
                console.log('PASS T4-03: Extension dark zh-CN capture -> study -> citation export -> rename -> full delete cascade.');
              } finally {
                await extCtx.close();
                await closeServer(extServer);
                await rm(profileDir, { recursive: true, force: true });
              }
            }

            assert.deepEqual(pageErrors, [], 'Unexpected pageerror events:\n' + pageErrors.join('\n'));
            assert.deepEqual(consoleErrors, [], 'Unexpected console.error events:\n' + consoleErrors.join('\n'));
            console.log('PASS Tier 4 (T4-01..T4-07): All 7 real-world researcher journeys passed.');
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
