import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { DocumentInfo, ReaderState } from '../../src/shared/types.js';
import { bookRoot, sections, startPublisherFixture } from './book-reading-fixture.js';
import { cardElement, clickCard, openToolbar, until } from './extension-controls.js';
import { assertDarkAndContrast, computeElementMetrics, inspectShadowCardMetrics, type RawElementSample } from './helpers/contrast.js';
import {
  failClipboardExecCommand, inspectTranslatedBlocks, mockClipboardFallback, readClipboardFallback, restoreClipboard
} from './helpers/dom-probes.js';
import {
  assertZeroSqliteRows, closeServer, snapshotDocSqliteCounts,
  startCompositePublisher, startRichZoteroFixture, startVersatileLlmFixture
} from './helpers/fixtures.js';
import { assertNoZhEnglishLeaks, collectChromeStrings } from './helpers/i18n.js';
import {
  attachErrorGuards, authContext, makePdf, openReaderInShell, openReaderPage,
  readDownload, resetSettings, rpc, saveTargetLanguage, selectFirstPdfRun, type ErrorScope
} from './helpers/reader.js';
import { withHost } from './host.js';
import { dragBox } from './selection-gestures.js';
import { markdownLinks, vaultSource, visibleMarkdown } from './vault-links.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const extensionDir = path.join(projectRoot, 'dist/extension');
const zoteroPreload = new URL('./integration-zotero-preload.ts', import.meta.url).href;
const publisherPreload = new URL('./book-reading-preload.ts', import.meta.url).href;
const appPath = '/api/paper-reader/app/index.html';

async function importPdf(ctx: BrowserContext, origin: string, file: string, title: string, paragraphs: string[], twoColumn = false): Promise<DocumentInfo> {
  const bytes = await makePdf(ctx, title, paragraphs, twoColumn);
  const res = await ctx.request.post(`${origin}/api/paper-reader/import-pdf?title=${encodeURIComponent(file)}`, {
    headers: { 'content-type': 'application/pdf' }, data: bytes
  });
  assert.equal(res.status(), 200);
  return ((await res.json()) as { doc: DocumentInfo }).doc;
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

async function deleteDocInLibrary(page: Page, title: string): Promise<void> {
  await page.locator('#library').click();
  const dlg = page.getByRole('dialog');
  await dlg.waitFor({ state: 'visible' });
  await dlg.getByRole('tab', { name: 'On this device', exact: true }).click();
  const row = dlg.locator('.library-device-item').filter({ hasText: title });
  await row.getByRole('button', { name: 'Delete document', exact: true }).click();
  await row.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await dlg.getByText('Document removed from this device.', { exact: true }).waitFor();
}

const publisherLog = path.join(os.tmpdir(), `paper-reader-tier4-pub-${randomUUID()}.ndjson`);
await writeFile(publisherLog, '', { flag: 'wx' });
const cleanups: (() => Promise<void>)[] = [() => rm(publisherLog, { force: true })];

try {
  const openStax = await startPublisherFixture();
  cleanups.push(() => openStax.close());
  const publisherRouter = await startCompositePublisher(openStax.origin, new Map([['/pubs/t4-07-web2/', T4_07_WEB_HTML]]));
  cleanups.push(() => publisherRouter.close());
  const zotero = await startRichZoteroFixture({ collectionName: 'Tier4 Refs' });
  cleanups.push(() => zotero.close());
  const llm = await startVersatileLlmFixture('tier4-llm-fixture');
  cleanups.push(() => llm.close());
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

                  await saveTargetLanguage(iframe, 'Korean', { zh: true, baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.key });
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

                  await iframe.locator('#mobileRail').click();
                  await iframe.locator('#refsTab').click();
                  await iframe.locator('.citation-export').waitFor({ state: 'visible' });
                  await mockClipboardFallback(iframe);
                  await iframe.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
                  await iframe.locator('.citation-export-status').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor();
                  const fallbackBib = await readClipboardFallback(iframe);
                  assert.ok(fallbackBib.startsWith('@inproceedings{kwon2023efficient,\n'), fallbackBib);

                  await failClipboardExecCommand(iframe);
                  await iframe.getByRole('button', { name: '复制 RIS', exact: true }).click();
                  await iframe.locator('.citation-export-status').filter({ hasText: '剪贴板权限受限，请改用下载按钮。' }).waitFor();
                  const [risDl] = await Promise.all([
                    shellPage.waitForEvent('download'),
                    iframe.getByRole('button', { name: '下载 .ris', exact: true }).click()
                  ]);
                  const risFile = await readDownload(risDl);
                  assert.equal(risFile.filename, 'kwon2023efficient.ris');
                  assert.ok(risFile.text.startsWith('TY  - CONF\n') && risFile.text.trimEnd().endsWith('ER  -'));

                  await restoreClipboard(iframe);

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
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', { tag: 'T4-01', scope, pageErrors, consoleErrors });

                  const arxivDoc = await importPdf(ctx, host.origin, 'T4-01-Arxiv-2401.12345.pdf', 'arXiv:2401.12345 Paged KV Cache Scheduling', [
                    'Virtual block tables map logical token sequences onto non-contiguous physical GPU memory blocks without pre-allocating maximum sequence lengths.',
                    'Copy-on-write sharing lets parallel beam-search candidates share common prompt prefixes while isolating divergent generation trajectories cleanly.',
                    'Dynamic memory reclamation returns freed blocks to the global allocator immediately when requests finish, increasing effective batch size substantially.',
                    'Empirical traces across mixed-length workloads demonstrate lower tail latency and near-zero internal fragmentation under sustained serving load.'
                  ], true);

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
                    const m = await inspectTranslatedBlocks(page);
                    return m.bodySizes.length > 0 && m.bodySizes.every(b => b.visualFont >= 11.5);
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
                  assertNoZhEnglishLeaks(await collectChromeStrings(page, '.citation-export-status'), 'T4-01 reloaded zh-CN', ['tier', 'llm', 'fixture']);

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

                  const scholarDoc = await importPdf(ctx, host.origin, 't4-02-scholar.pdf', 'Multilingual Scholar Manuscript', [
                    'Analytical engine memory tables decouple logical allocation from physical bank placement.',
                    'Portable citations link local reading archives with external Zotero bibliographic records.'
                  ]);

                  const page = await openReaderPage(ctx, host, `?doc=${encodeURIComponent(scholarDoc.id)}&page=1`, { tag: 'T4-02', scope, pageErrors, consoleErrors });
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
                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', { tag: 'T4-04', scope, pageErrors, consoleErrors });
                  const titleBox = await page.locator('#docTitle').boundingBox();
                  assert.ok(titleBox && titleBox.width >= 64);
                  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
                  await assertDarkAndContrast(page.locator('.topbar #docTitle'), 'T4-04 mobile topbar', 0.08, 4.5);

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

                  const page = await openReaderPage(ctx, host, `?doc=${encodeURIComponent(bookId)}&page=1`, { tag: 'T4-05', scope, pageErrors, consoleErrors });
                  const sheet = page.locator('.web-reading-sheet[data-side="source"]');
                  await sheet.waitFor({ state: 'visible' });
                  await assertDarkAndContrast(sheet.locator('h1, h2').first(), 'T4-05 OpenStax dark heading', 0.12, 4.5);
                  await assertDarkAndContrast(sheet.locator('p').first(), 'T4-05 OpenStax dark paragraph', 0.12, 4.5);

                  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('paperScroll')!).scrollBehavior), 'auto');

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

                  await deleteDocInLibrary(page, opened.body.doc.title);
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
                  const pdf1 = await importPdf(ctx, host.origin, 't4-07-pdf1.pdf', 'Synthesis Target PDF One', [
                    'Selective deletion must remove only target document rows while keeping sibling records intact.'
                  ]);

                  const web2Res = await rpc<{ doc: DocumentInfo }>(ctx.request, host.origin, 'web.open', { url: T4_07_WEB_URL });
                  assert.equal(web2Res.status, 200);
                  const web2 = web2Res.body.doc;

                  const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', { tag: 'T4-07', scope, pageErrors, consoleErrors });

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

                  await deleteDocInLibrary(page, pdf1.title);
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
                const rawPopup = await popup.evaluate(() => {
                  const layers: string[] = [];
                  for (let cur: Element | null = document.body; cur && cur.nodeType === 1; cur = cur.parentElement) layers.push(getComputedStyle(cur).backgroundColor);
                  const style = getComputedStyle(document.body);
                  const darkRoot = document.documentElement.dataset.theme === 'dark' || getComputedStyle(document.documentElement).colorScheme.includes('dark');
                  return {
                    lang: document.documentElement.lang,
                    body: { fg: style.color, layers, darkRoot, fontSize: parseFloat(style.fontSize) || 0, colorScheme: style.colorScheme }
                  };
                }, null) as { lang: string; body: RawElementSample };
                assert.equal(rawPopup.lang, 'zh-CN');
                assert.ok(computeElementMetrics(rawPopup.body).bgLum <= 0.08);
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
                const cardMetrics = await inspectShadowCardMetrics(articlePage, '.card');
                const headingMetrics = await inspectShadowCardMetrics(articlePage, 'h2');
                assert.ok(cardMetrics && cardMetrics.lang === 'zh-CN' && cardMetrics.colorScheme === 'dark');
                assert.ok(cardMetrics.bgLum <= 0.08 && headingMetrics && headingMetrics.ratio >= 4.5);
                assert.equal(cardMetrics.translate, '翻译');
                assert.equal(cardMetrics.note, '记入笔记');

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
  for (const close of cleanups.reverse()) await close();
}
