import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { APIRequestContext, BrowserContext, Download, FrameLocator, Page } from 'playwright-core';
import type { Operations } from '../../../src/shared/types.js';
import type { HostFixture } from '../host.js';

const APP_PATH = '/api/paper-reader/app/index.html';

export interface ErrorScope {
  allowZotero503?: boolean; allowExpected502?: boolean; allowExpected400?: boolean;
  allowExpected404?: boolean; allowExpected409?: boolean; allowExpected500?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function attachErrorGuards(page: Page, tag: string, scope: ErrorScope, pageErrors: string[], consoleErrors: string[]): void {
  page.setDefaultTimeout(12_000);
  page.on('pageerror', err => pageErrors.push(`${tag}: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text(), url = msg.location().url;
    if (url.endsWith('/favicon.ico')) return;
    const isAction = url.endsWith('/api/paper-reader/action');
    if (scope.allowZotero503 && text.includes('503') && (isAction || text.includes('status of 503'))) return;
    if (scope.allowExpected502 && text.includes('502') && isAction) return;
    if (scope.allowExpected400 && text.includes('400') && isAction) return;
    if (scope.allowExpected404 && text.includes('404')) return;
    if (scope.allowExpected409 && text.includes('409') && isAction) return;
    if (scope.allowExpected500 && text.includes('500')) return;
    consoleErrors.push(`${tag}: ${text} (${url})`);
  });
}

export async function rpc<T = Record<string, unknown>>(
  request: APIRequestContext, origin: string, op: string, payload: Record<string, unknown> = {}
): Promise<{ status: number; body: T }> {
  const res = await request.post(origin + '/api/paper-reader/action', {
    headers: { 'content-type': 'application/json' }, data: { op, payload }
  });
  const text = await res.text();
  try { return { status: res.status(), body: JSON.parse(text) as T }; }
  catch { throw new Error(`RPC ${op} returned HTTP ${res.status()} non-JSON: ${text.slice(0, 120)}`); }
}

export async function action<K extends keyof Operations>(
  page: Page, origin: string, op: K, payload: Operations[K][0]
): Promise<Operations[K][1]> {
  const res = await page.request.post(origin + '/api/paper-reader/action', { data: { op, payload } });
  assert.ok(res.ok(), `${op} returned HTTP ${res.status()}`);
  return res.json();
}

export async function authContext(ctx: BrowserContext, host: HostFixture): Promise<void> {
  const res = await ctx.request.get(host.authenticatedUrl);
  assert.ok(res.ok(), `Failed to authenticate context: HTTP ${res.status()}`);
}

export async function resetSettings(request: APIRequestContext, origin: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await rpc(request, origin, 'settings.save', {
    baseUrl: '', model: 'deepseek-flash', clearApiKey: overrides.apiKey === undefined,
    targetLanguage: 'Simplified Chinese', vaultPath: '', zoteroMode: 'desktop',
    zoteroLibraryId: '', clearZoteroKey: overrides.zoteroApiKey === undefined, ...overrides
  });
  assert.equal(res.status, 200, 'resetSettings failed: HTTP ' + res.status);
}

export async function openReaderPage(
  context: BrowserContext, host: HostFixture, query = '?doc=pagedattention&page=6',
  guards?: { tag: string; scope: ErrorScope; pageErrors: string[]; consoleErrors: string[] }
): Promise<Page> {
  const page = await context.newPage();
  if (guards) attachErrorGuards(page, guards.tag, guards.scope, guards.pageErrors, guards.consoleErrors);
  else page.setDefaultTimeout(12_000);
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
  await page.goto(host.origin + APP_PATH + query, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 25_000 });
  return page;
}

export async function openReaderInShell(page: Page, authenticatedUrl: string): Promise<FrameLocator> {
  await page.goto(authenticatedUrl, { waitUntil: 'domcontentloaded' });
  const sidebar = page.getByRole('button', { name: 'Paper Reader', exact: true });
  const noticeAction = page.getByRole('button', { name: /^(Continue|继续|Configure later|稍后配置|Skip(?: for now)?|跳过|Get started|开始使用|Open app|Got it|知道了)$/i });
  const closeDialog = page.getByRole('dialog').getByRole('button', { name: /^(Close|关闭)$/i });
  const pane = page.frameLocator('iframe[title="Paper Reader"]');
  const deadline = Date.now() + 35_000;
  let mounted = false;
  while (Date.now() < deadline) {
    if (await closeDialog.last().isVisible().catch(() => false)) {
      await closeDialog.last().click({ timeout: 1500 }).catch(() => undefined);
      continue;
    }
    const nextAction = noticeAction.last();
    if (await nextAction.isVisible().catch(() => false) && await nextAction.isEnabled().catch(() => false)) {
      await nextAction.click({ timeout: 1500 }).catch(() => undefined);
      continue;
    }
    if (mounted) {
      if (await pane.getByRole('button', { name: /^(Open library|打开资料库)$/ }).click({ trial: true, timeout: 600 }).then(() => true, () => false)) return pane;
    } else if (await sidebar.isVisible().catch(() => false)) {
      if (await sidebar.click({ timeout: 600 }).then(() => true, () => false)) {
        await pane.locator('[data-pdf-side="source"], .web-reading-sheet[data-side="source"]').first().waitFor({ timeout: 25_000 });
        mounted = true;
        continue;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error('DSH shell onboarding did not reach Paper Reader. Controls: ' + (await page.getByRole('button').allTextContents()).join(' | ').slice(0, 480));
}

export async function readDownload(download: Download): Promise<{ filename: string; text: string }> {
  const filename = download.suggestedFilename();
  const filePath = await download.path();
  assert.ok(filePath, `Missing download path for ${filename}`);
  return { filename, text: await readFile(filePath, 'utf8') };
}

export async function makePdf(context: BrowserContext, title: string, paragraphs: string[], twoColumn = false): Promise<Buffer> {
  const builder = await context.newPage();
  try {
    const colCss = twoColumn ? 'section{column-count:2;column-gap:0.35in}' : '';
    await builder.setContent(
      `<style>@page{size:letter;margin:0.8in}body{font:13pt Georgia;line-height:1.45}${colCss}</style>` +
      `<h1>${title}</h1><section>` + paragraphs.map(p => `<p>${p}</p>`).join('') + '</section>'
    );
    return Buffer.from(await builder.pdf({ preferCSSPageSize: true }));
  } finally { await builder.close(); }
}

export async function selectFirstPdfRun(page: Page): Promise<void> {
  const firstRun = page.locator('#original .pdf-native-text [data-block-id]').first();
  await firstRun.waitFor({ state: 'visible' });
  const blockId = await firstRun.getAttribute('data-block-id');
  assert.ok(blockId, 'Expected PDF native text block ID');
  await page.locator(`#original .pdf-native-text [data-block-id="${blockId}"]`).evaluateAll(elements => {
    const start = elements[0]?.firstChild;
    let end = start;
    for (const node of elements) if (node.firstChild instanceof Text) end = node.firstChild;
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

export async function saveTargetLanguage(
  reader: Page | FrameLocator, target: string,
  options?: { custom?: boolean; zh?: boolean; baseUrl?: string; model?: string; apiKey?: string }
): Promise<void> {
  await reader.locator('#more').click();
  await reader.locator('#menu').getByRole('button', { name: options?.zh ? '连接设置' : 'Connections', exact: true }).click();
  const dialog = reader.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  if (options?.baseUrl !== undefined) await dialog.getByLabel(options.zh ? 'API 接口地址' : 'API base URL').fill(options.baseUrl);
  if (options?.model !== undefined) await dialog.getByLabel(options.zh ? '模型' : 'Model', { exact: true }).fill(options.model);
  if (options?.apiKey !== undefined) await dialog.getByLabel(options.zh ? 'API 密钥' : 'API key', { exact: true }).fill(options.apiKey);
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
