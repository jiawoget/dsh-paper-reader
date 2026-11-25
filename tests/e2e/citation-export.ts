import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import type { DocumentInfo } from '../../src/shared/types.js';
import { closeServer, startRichZoteroFixture } from './helpers/fixtures.js';
import { makePdf, readDownload } from './helpers/reader.js';
import { withHost } from './host.js';

const zoteroPreload = new URL('./integration-zotero-preload.ts', import.meta.url).href;
const publisherPreload = new URL('./book-reading-preload.ts', import.meta.url).href;

const ARTICLE_URLS = {
  academic: 'https://research.google/pubs/citation-fixture/',
  localMerge: 'https://research.google/pubs/local-merge-fixture/',
  nonAscii: 'https://research.google/pubs/non-ascii-fixture/'
};

function startAcademicPublisherFixture() {
  const pages = new Map<string, string>([
    [
      '/pubs/citation-fixture/',
      `<!doctype html><html><head>
        <meta charset="utf-8">
        <title>Academic Fixture Site</title>
        <meta name="citation_title" content="Structured Memory Hierarchies for Long-Context Serving">
        <meta name="citation_author" content="Smith, Alice">
        <meta name="citation_author" content="Doe, Bob">
        <meta name="citation_journal_title" content="Journal of Machine Reading">
        <meta name="citation_publication_date" content="2024/05/12">
        <meta name="citation_publisher" content="Academic Press">
        <meta name="citation_doi" content="10.1000/jmr.2024.09">
        <meta name="description" content="First line of summary.&#10;ER  - &#10;Second line of summary.">
      </head><body><article>
        <h1>Structured Memory Hierarchies for Long-Context Serving</h1>
        <p>This fixture article verifies academic meta tag extraction into BibTeX and RIS citation exports.</p>
      </article></body></html>`
    ],
    [
      '/pubs/local-merge-fixture/',
      `<!doctype html><html><head>
        <meta charset="utf-8">
        <title>Local Merge Fixture</title>
        <meta name="citation_title" content="Local Metadata Preservation Paper">
        <meta name="citation_author" content="Local Author">
        <meta name="citation_journal_title" content="Systems Review">
        <meta name="citation_publication_date" content="2023">
        <meta name="citation_doi" content="10.1000/local.doi">
      </head><body><article>
        <h1>Local Metadata Preservation Paper</h1>
        <p>This fixture carries a local DOI and URL that a partial Zotero item must not clobber.</p>
      </article></body></html>`
    ],
    [
      '/pubs/non-ascii-fixture/',
      `<!doctype html><html><head>
        <meta charset="utf-8">
        <title>中文文献测试</title>
        <meta name="citation_title" content="大语言模型 100% 推理 &amp; 缓存_优化 #1 }">
        <meta name="citation_author" content="张三">
        <meta name="citation_author" content="李四">
        <meta name="citation_publication_date" content="2025">
      </head><body><article>
        <h1>大语言模型 100% 推理 &amp; 缓存_优化 #1 }</h1>
        <p>用于验证中文标题、作者与 LaTeX 特殊字符转义及 ASCII 引文键生成。</p>
      </article></body></html>`
    ]
  ]);

  return new Promise<{ origin: string; close: () => Promise<void> }>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const html = pages.get(url.pathname);
      if (!html) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Publisher fixture failed to bind a loopback port.'));
        return;
      }
      resolve({
        origin: 'http://127.0.0.1:' + address.port,
        close: () => closeServer(server)
      });
    });
  });
}

async function openReferenceTab(page: Page) {
  if (!(await page.locator('#rail').isVisible())) {
    await page.locator('#mobileRail').click();
    await page.locator('#rail').waitFor({ state: 'visible' });
  }
  await page.locator('#refsTab').click();
  await page.locator('.citation-export').waitFor({ state: 'visible' });
}

async function openWebArticleViaLibrary(page: Page, url: string) {
  await page.locator('#library').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  const openWebBtn = dialog.getByRole('button', { name: 'Open web page', exact: true });
  if ((await openWebBtn.getAttribute('aria-expanded')) !== 'true') {
    await openWebBtn.click();
  }
  await dialog.locator('#library-url').fill(url);
  await dialog.getByRole('button', { name: 'Read article', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.web-reading-sheet[data-side="source"]').waitFor({ state: 'visible' });
}

const publisherLog = path.join(os.tmpdir(), 'paper-reader-citation-pub-' + randomUUID() + '.ndjson');
await writeFile(publisherLog, '', { flag: 'wx' });

try {
  const publisher = await startAcademicPublisherFixture();
  const zotero = await startRichZoteroFixture({ libraryId: '884421', collectionName: 'Citation Export Tests', includePartial: true });
  try {
    await withHost(async host => {
      const browser = await chromium.launch({
        executablePath: host.executable,
        headless: process.env.PAPER_READER_HEADED !== '1'
      });
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      let zoteroConfigured = false;
      const attachErrorListeners = (tag: string, page: Page) => {
        page.on('pageerror', error => pageErrors.push(`${tag}: ${error.message}`));
        page.on('response', response => {
          if (response.status() < 400) return;
          const url = response.url();
          if (url.endsWith('/favicon.ico')) return;
          const postData = response.request().postData() ?? '';
          const expectedDesktopProbe = !zoteroConfigured && response.status() === 503 && postData.includes('"op":"zotero.get"');
          if (!expectedDesktopProbe) {
            consoleErrors.push(`${tag}: HTTP ${response.status()} ${url} (${postData.slice(0, 120)})`);
          }
        });
        page.on('console', msg => {
          if (msg.type() !== 'error') return;
          const loc = msg.location().url;
          if (loc.endsWith('/favicon.ico')) return;
          // Chromium logs a generic 503 console error for the expected Zotero desktop probe before web Zotero is configured.
          if (!zoteroConfigured && msg.text().includes('503 (Service Unavailable)') && loc.endsWith('/api/paper-reader/action')) return;
          consoleErrors.push(`${tag}: ${msg.text()} (${loc})`);
        });
      };

      try {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: 'en-US',
          acceptDownloads: true,
          permissions: ['clipboard-read', 'clipboard-write']
        });
        const page = await context.newPage();
        page.setDefaultTimeout(12_000);
        attachErrorListeners('en-US', page);

        // Authenticate session cookie, then open standalone reader directly on pagedattention.
        await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
        await page.goto(host.origin + '/api/paper-reader/app/index.html', { waitUntil: 'domcontentloaded' });
        await page.locator('#original [data-pdf-side="source"]').first().waitFor({ timeout: 25_000 });

        await openReferenceTab(page);

        // T1-F3-01: Copy BibTeX on bundled pagedattention.
        await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        await page.locator('#toast').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        const copiedBib = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(copiedBib.startsWith('@inproceedings{kwon2023efficient,\n'), copiedBib);
        assert.ok(copiedBib.includes('  title = {Efficient Memory Management for Large Language Model Serving with PagedAttention},'));
        assert.ok(copiedBib.includes('  author = {Kwon and others},'));
        assert.ok(copiedBib.includes('  year = {2023},'));
        assert.ok(copiedBib.includes('  doi = {10.1145/3600006.3613165},'));
        assert.ok(copiedBib.includes('  eprint = {2309.06180},'));
        assert.ok(copiedBib.includes('  archivePrefix = {arXiv}'));
        assert.equal(copiedBib.includes('undefined'), false);
        console.log('PASS T1-F3-01: Copy BibTeX on pagedattention.');

        // T1-F3-02: Download .bib on bundled pagedattention.
        const [bibDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .bib', exact: true }).click()
        ]);
        const downloadedBib = await readDownload(bibDownload);
        assert.match(downloadedBib.filename, /^[a-z0-9]+\.bib$/);
        assert.equal(downloadedBib.filename, 'kwon2023efficient.bib');
        assert.equal(downloadedBib.text, copiedBib);
        console.log('PASS T1-F3-02: Download .bib on pagedattention.');

        // T1-F3-03: Copy RIS on bundled pagedattention.
        await page.getByRole('button', { name: 'Copy RIS', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'RIS copied to clipboard.' }).waitFor({ state: 'visible' });
        await page.locator('#toast').filter({ hasText: 'RIS copied to clipboard.' }).waitFor({ state: 'visible' });
        const copiedRis = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(copiedRis.startsWith('TY  - CONF\n'), copiedRis);
        assert.ok(copiedRis.includes('TI  - Efficient Memory Management for Large Language Model Serving with PagedAttention\n'));
        assert.ok(copiedRis.includes('AU  - Kwon et al.\n'));
        assert.ok(copiedRis.includes('PY  - 2023\n'));
        assert.ok(copiedRis.includes('DO  - 10.1145/3600006.3613165\n'));
        assert.ok(copiedRis.includes('UR  - https://arxiv.org/abs/2309.06180\n'));
        assert.ok(copiedRis.includes('N1  - arXiv:2309.06180\n'));
        assert.ok(copiedRis.endsWith('ER  - '));
        assert.equal(copiedRis.includes('undefined'), false);
        console.log('PASS T1-F3-03: Copy RIS on pagedattention.');

        // T1-F3-04: Download .ris on bundled pagedattention.
        const [risDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .ris', exact: true }).click()
        ]);
        const downloadedRis = await readDownload(risDownload);
        assert.match(downloadedRis.filename, /^[a-z0-9]+\.ris$/);
        assert.equal(downloadedRis.filename, 'kwon2023efficient.ris');
        assert.equal(downloadedRis.text, copiedRis);
        console.log('PASS T1-F3-04: Download .ris on pagedattention.');

        type ClipWin = Window & { __origWrite?: typeof navigator.clipboard.writeText; __origExec?: typeof document.execCommand; __copied?: string };
        await page.evaluate(() => {
          const w = window as ClipWin;
          w.__origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
          w.__origExec = document.execCommand.bind(document);
          w.__copied = '';
          const stubs = {
            writeText() { return Promise.reject(new DOMException('Clipboard permission denied', 'NotAllowedError')); },
            execCommand(cmd: string) {
              if (cmd !== 'copy') return false;
              const a = document.activeElement;
              w.__copied = a && 'value' in a ? String(a.value) : '';
              return true;
            }
          };
          Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: stubs.writeText });
          document.execCommand = stubs.execCommand;
        });
        await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => (window as ClipWin).__copied ?? ''), copiedBib);
        await page.evaluate(() => { const s = { execCommand() { return false; } }; document.execCommand = s.execCommand; });
        await page.getByRole('button', { name: 'Copy RIS', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'Clipboard access was blocked. Use Download instead.' }).waitFor({ state: 'visible' });
        const [recoveryDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .ris', exact: true }).click()
        ]);
        assert.equal((await readDownload(recoveryDownload)).text, copiedRis);
        await page.evaluate(() => {
          const w = window as ClipWin;
          if (w.__origWrite) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: w.__origWrite });
          if (w.__origExec) document.execCommand = w.__origExec;
        });
        console.log('PASS T2-F3-07: Clipboard NotAllowedError fallback and blocked-clipboard download recovery.');

        // T2-F3-01: Sparse bare-filename PDF notes.pdf (with Zotero still unconfigured).
        const pdfBytes = await makePdf(context, 'Scratch Notes', ['Undated local draft PDF for citation export testing.']);
        const importRes = await context.request.post(host.origin + '/api/paper-reader/import-pdf?title=notes.pdf', {
          headers: { 'content-type': 'application/pdf' },
          data: pdfBytes
        });
        assert.equal(importRes.status(), 200);
        const importedNotes = (await importRes.json()) as { doc: DocumentInfo };
        assert.equal(importedNotes.doc.title, 'notes.pdf');

        await page.goto(`${host.origin}/api/paper-reader/app/index.html?doc=${encodeURIComponent(importedNotes.doc.id)}`, {
          waitUntil: 'domcontentloaded'
        });
        await page.locator('#original [data-pdf-side="source"]').first().waitFor({ timeout: 25_000 });
        await openReferenceTab(page);

        await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        const sparseBib = await page.evaluate(() => navigator.clipboard.readText());
        assert.equal(sparseBib, '@misc{notes,\n  title = {notes}\n}');
        assert.equal(sparseBib.includes('undefined'), false);

        await page.getByRole('button', { name: 'Copy RIS', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'RIS copied to clipboard.' }).waitFor({ state: 'visible' });
        const sparseRis = await page.evaluate(() => navigator.clipboard.readText());
        assert.equal(sparseRis, 'TY  - GEN\nTI  - notes\nER  - ');

        const [sparseDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .bib', exact: true }).click()
        ]);
        assert.equal((await readDownload(sparseDownload)).filename, 'notes.bib');
        console.log('PASS T2-F3-01: Sparse bare-filename notes.pdf export.');

        // Configure loopback Zotero for T1-F3-06, T2-F3-08, and clean Library dialog opening.
        await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
        const settings = page.getByRole('dialog');
        await settings.waitFor({ state: 'visible' });
        await settings.getByRole('combobox', { name: /Zotero connection/ }).selectOption('web');
        await settings.getByRole('combobox', { name: /Library type/ }).selectOption('group');
        await settings.getByLabel('Zotero library ID').fill(zotero.libraryId);
        await settings.getByLabel('Zotero API key').fill(zotero.credential);
        await settings.getByRole('button', { name: 'Save connections', exact: true }).click();
        await settings.waitFor({ state: 'hidden' });
        zoteroConfigured = true;

        // T1-F3-06: Link sparse notes.pdf to rich Zotero item and export immediately without reloading.
        await page.locator('#railBody input[aria-label="Search Zotero"]').fill('Analytical');
        await page.getByRole('button', { name: 'Find item', exact: true }).click();
        await page.getByRole('button', { name: zotero.richItem.data.title, exact: true }).click();
        await page.getByRole('button', { name: 'Link this item', exact: true }).click();
        await page.locator('#railBody').getByText('Linked reference', { exact: true }).waitFor({ state: 'visible' });

        // Immediate export (no reload).
        await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        const enrichedBib = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(enrichedBib.startsWith('@article{lovelace2024analytical,\n'), enrichedBib);
        assert.ok(enrichedBib.includes('  title = {Analytical Engine Memory Tables},'));
        assert.ok(enrichedBib.includes('  author = {Ada Lovelace and Charles Babbage},'));
        assert.ok(enrichedBib.includes('  year = {2024},'));
        assert.ok(enrichedBib.includes('  doi = {10.1000/zotero.2024.42},'));
        assert.ok(enrichedBib.includes('  url = {https://journal.example.org/analytical-engine}'));

        const [enrichedRisDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .ris', exact: true }).click()
        ]);
        const enrichedRis = await readDownload(enrichedRisDownload);
        assert.equal(enrichedRis.filename, 'lovelace2024analytical.ris');
        assert.ok(enrichedRis.text.startsWith('TY  - JOUR\n'));
        assert.ok(enrichedRis.text.includes('AU  - Ada Lovelace\nAU  - Charles Babbage\n'));
        assert.ok(enrichedRis.text.includes('PY  - 2024\n'));
        assert.ok(enrichedRis.text.includes('DO  - 10.1000/zotero.2024.42\n'));

        // Reload and verify linked Zotero enrichment persists.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#original [data-pdf-side="source"]').first().waitFor({ timeout: 25_000 });
        await openReferenceTab(page);
        await page.locator('#railBody').getByText('Linked reference', { exact: true }).waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), enrichedBib);
        console.log('PASS T1-F3-06: Zotero-linked document enriches BibTeX and RIS immediately and after reload.');

        // T1-F3-05 (+ T2-F3-03 multiline abstract): Academic web HTML <meta citation_*> via real web.open.
        await openWebArticleViaLibrary(page, ARTICLE_URLS.academic);
        await openReferenceTab(page);
        const railText = await page.locator('#railBody').textContent();
        assert.equal(railText?.includes('undefined'), false, 'Reference panel must not render undefined');

        await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        const webBib = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(webBib.startsWith('@article{smith2024structured,\n'), webBib);
        assert.ok(webBib.includes('  author = {Smith, Alice and Doe, Bob},'));
        assert.ok(webBib.includes('  journal = {Journal of Machine Reading},'));
        assert.ok(webBib.includes('  publisher = {Academic Press},'));
        assert.ok(webBib.includes('  year = {2024},'));
        assert.ok(webBib.includes('  doi = {10.1000/jmr.2024.09},'));

        await page.getByRole('button', { name: 'Copy RIS', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'RIS copied to clipboard.' }).waitFor({ state: 'visible' });
        const webRis = await page.evaluate(() => navigator.clipboard.readText());
        const webRisLines = webRis.split('\n');
        assert.equal(webRisLines[0], 'TY  - JOUR');
        assert.ok(webRisLines.includes('AU  - Smith, Alice'));
        assert.ok(webRisLines.includes('AU  - Doe, Bob'));
        assert.ok(webRisLines.includes('JO  - Journal of Machine Reading'));
        assert.ok(webRisLines.includes('PB  - Academic Press'));
        assert.ok(webRisLines.includes('PY  - 2024'));
        assert.ok(webRisLines.includes('DO  - 10.1000/jmr.2024.09'));
        assert.equal(webRisLines.filter(line => line === 'ER  - ').length, 1);
        assert.equal(webRisLines.at(-1), 'ER  - ');
        assert.ok(webRisLines.some(line => line.startsWith('AB  - First line of summary.') && line.includes('Second line of summary.')));
        console.log('PASS T1-F3-05: Academic HTML <meta citation_*> extraction into BibTeX and RIS.');

        // T2-F3-06 (+ T2-F3-02 browser spot-check): Non-ASCII Chinese title + LaTeX special chars.
        await openWebArticleViaLibrary(page, ARTICLE_URLS.nonAscii);
        await openReferenceTab(page);
        await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        const cjkBib = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(cjkBib.includes('100\\%'), cjkBib);
        assert.ok(cjkBib.includes('\\&'), cjkBib);
        assert.ok(cjkBib.includes('\\_'), cjkBib);
        assert.ok(cjkBib.includes('\\#1'), cjkBib);
        assert.ok(cjkBib.includes('\\textbraceright{}'), cjkBib);
        const [cjkBibDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .bib', exact: true }).click()
        ]);
        const cjkBibFile = await readDownload(cjkBibDownload);
        assert.match(cjkBibFile.filename, /^[a-z0-9]+\.bib$/);
        const [cjkRisDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('button', { name: 'Download .ris', exact: true }).click()
        ]);
        const cjkRisFile = await readDownload(cjkRisDownload);
        assert.match(cjkRisFile.filename, /^[a-z0-9]+\.ris$/);
        console.log('PASS T2-F3-02/T2-F3-06: Non-ASCII Chinese + LaTeX special char export & ASCII filenames.');

        // T2-F3-08: Partial Zotero item preserves local doi/url without overwriting with empty strings.
        await openWebArticleViaLibrary(page, ARTICLE_URLS.localMerge);
        await openReferenceTab(page);
        await page.locator('#railBody input[aria-label="Search Zotero"]').fill('Without DOI');
        await page.getByRole('button', { name: 'Find item', exact: true }).click();
        await page.getByRole('button', { name: zotero.partialItem.data.title, exact: true }).click();
        await page.getByRole('button', { name: 'Link this item', exact: true }).click();
        await page.locator('#railBody').getByText('Linked reference', { exact: true }).waitFor({ state: 'visible' });

        await page.getByRole('button', { name: 'Copy BibTeX', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'BibTeX copied to clipboard.' }).waitFor({ state: 'visible' });
        const mergedBib = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(mergedBib.includes('  title = {Zotero Refined Title Without DOI},'), mergedBib);
        assert.ok(mergedBib.includes('  author = {Grace Hopper},'), mergedBib);
        assert.ok(mergedBib.includes('  year = {2025},'), mergedBib);
        assert.ok(mergedBib.includes('  doi = {10.1000/local.doi},'), mergedBib);
        assert.ok(mergedBib.includes(`  url = {${ARTICLE_URLS.localMerge}}`), mergedBib);

        await page.getByRole('button', { name: 'Copy RIS', exact: true }).click();
        await page.locator('.citation-export-status').filter({ hasText: 'RIS copied to clipboard.' }).waitFor({ state: 'visible' });
        const mergedRis = await page.evaluate(() => navigator.clipboard.readText());
        assert.ok(mergedRis.includes('DO  - 10.1000/local.doi\n'), mergedRis);
        assert.ok(mergedRis.includes(`UR  - ${ARTICLE_URLS.localMerge}\n`), mergedRis);
        console.log('PASS T2-F3-08: Partial Zotero merge preserves local doi and url.');

        await context.close();

        // zh-CN locale check.
        const zhContext = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: 'zh-CN',
          acceptDownloads: true,
          permissions: ['clipboard-read', 'clipboard-write']
        });
        const zhPage = await zhContext.newPage();
        zhPage.setDefaultTimeout(12_000);
        attachErrorListeners('zh-CN', zhPage);

        await zhPage.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
        await zhPage.goto(host.origin + '/api/paper-reader/app/index.html', { waitUntil: 'domcontentloaded' });
        await zhPage.locator('#original [data-pdf-side="source"]').first().waitFor({ timeout: 25_000 });
        await openReferenceTab(zhPage);

        assert.equal(await zhPage.locator('#refsTab').textContent(), '文献');
        await zhPage.locator('.citation-export h3').filter({ hasText: '导出引文' }).waitFor({ state: 'visible' });
        await zhPage.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
        await zhPage.locator('.citation-export-status').filter({ hasText: 'BibTeX 已复制到剪贴板。' }).waitFor({ state: 'visible' });
        await zhPage.getByRole('button', { name: '复制 RIS', exact: true }).click();
        await zhPage.locator('.citation-export-status').filter({ hasText: 'RIS 已复制到剪贴板。' }).waitFor({ state: 'visible' });
        const [zhDownload] = await Promise.all([
          zhPage.waitForEvent('download'),
          zhPage.getByRole('button', { name: '下载 .bib', exact: true }).click()
        ]);
        assert.equal((await readDownload(zhDownload)).filename, 'kwon2023efficient.bib');
        await zhPage.locator('.citation-export-status').filter({ hasText: '已下载 kwon2023efficient.bib。' }).waitFor({ state: 'visible' });
        await zhContext.close();
        console.log('PASS zh-CN: Localized citation export controls, status, and download.');

        assert.deepEqual(pageErrors, [], 'Unexpected pageerror events');
        assert.deepEqual(consoleErrors, [], 'Unexpected console.error events');
      } finally {
        await browser.close();
      }
    }, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + zoteroPreload, '--import=' + publisherPreload].filter(Boolean).join(' '),
      READER_TEST_ZOTERO_ORIGIN: zotero.origin,
      PAPER_READER_E2E_PUBLISHER_FIXTURE: publisher.origin,
      PAPER_READER_E2E_PUBLISHER_LOG: publisherLog
    });
  } finally {
    await zotero.close();
    await publisher.close();
  }
} finally {
  await rm(publisherLog, { force: true });
}
