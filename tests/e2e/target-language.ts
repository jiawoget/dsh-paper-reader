import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type APIRequestContext, type FrameLocator, type Page } from 'playwright-core';
import type { DocumentInfo, ReaderState } from '../../src/shared/types.js';
import { openReader, withHost } from './host.js';
import { startJsonFixture } from './integration-fixtures.js';

type Reader = Page | FrameLocator;

interface RecordedCall {
  target: string;
  mode: 'blocks' | 'passage';
  system: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function action<T = Record<string, unknown>>(
  request: APIRequestContext,
  origin: string,
  op: string,
  payload: Record<string, unknown> = {}
): Promise<{ status: number; body: T }> {
  const response = await request.post(origin + '/api/paper-reader/action', {
    headers: { 'content-type': 'application/json' },
    data: { op, payload }
  });
  const body = await response.json() as T;
  return { status: response.status(), body };
}

async function multilingualModelFixture() {
  const key = randomUUID();
  const model = 'multilingual-fixture-v1';
  const calls: RecordedCall[] = [];
  const prefixByTarget: Record<string, string> = {
    'Japanese': '日本語訳: ',
    'French': 'Traduction française : ',
    'German': 'Deutsche Übersetzung: ',
    'Portuguese': 'Tradução em português: ',
    'Esperanto': 'Esperanta traduko: '
  };

  const server = await startJsonFixture((req, url, body) => {
    if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') return { status: 404 };
    if (req.headers.authorization !== 'Bearer ' + key) return { status: 403 };
    if (!isRecord(body) || body.model !== model || !Array.isArray(body.messages)) return { status: 400 };
    const messages = body.messages.filter(isRecord);
    const system = String(messages.find(m => m.role === 'system')?.content ?? '');
    const userContent = String(messages.find(m => m.role === 'user')?.content ?? '');

    const blockMatch = /Translate each passage in full into ([^.]+)\./.exec(system);
    if (blockMatch) {
      const target = blockMatch[1].trim();
      calls.push({ target, mode: 'blocks', system });
      const parsed = JSON.parse(userContent) as { blocks: { id: string; text: string }[] };
      const translations = Object.fromEntries(parsed.blocks.map(block => {
        if (target === 'Simplified Chinese') return [block.id, '简体中文译文：系统可以高效分配内存块。'];
        if (target === 'English') return [block.id, block.text];
        const prefix = prefixByTarget[target] ?? `[${target}] `;
        return [block.id, prefix + block.text];
      }));
      return {
        status: 200,
        value: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ translations }) }, finish_reason: 'stop' }] }
      };
    }

    const translateMatch = /Translate into ([^.]+)\./.exec(system);
    const defaultMatch = /Use ([^.]+) by default/.exec(system);
    const target = (translateMatch?.[1] ?? defaultMatch?.[1] ?? 'Unknown').trim();
    calls.push({ target, mode: 'passage', system });
    const answer = target === 'German'
      ? 'Deutsche Übersetzung: Der Speicherblock wird dynamisch zugewiesen.'
      : `[${target}] Passage answer.`;
    return {
      status: 200,
      value: { choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }
    };
  });

  return {
    ...server,
    baseUrl: server.origin + '/v1',
    key,
    model,
    calls
  };
}

async function openConnections(reader: Reader) {
  await reader.getByRole('button', { name: /^(More actions|更多操作)$/ }).click();
  await reader.locator('#menu').getByRole('button', { name: /^(Connections|连接设置)$/ }).click();
  const dialog = reader.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}

async function saveTargetLanguage(reader: Reader, target: string, options?: { custom?: boolean; baseUrl?: string; model?: string; apiKey?: string }) {
  const dialog = await openConnections(reader);
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

await withHost(async host => {
  const fixture = await multilingualModelFixture();
  const browser = await chromium.launch({
    executablePath: host.executable,
    headless: process.env.PAPER_READER_HEADED !== '1'
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 960 },
      locale: 'en-US'
    });
    const shellPage = await context.newPage();
    shellPage.setDefaultTimeout(12_000);
    const recordConsoleError = (tag: string, msg: { type(): string; text(): string; location(): { url: string } }) => {
      if (msg.type() !== 'error') return;
      const loc = msg.location().url;
      if (loc.endsWith('/favicon.ico')) return;
      consoleErrors.push(`${tag}: ${msg.text()} (${loc})`);
    };
    shellPage.on('pageerror', error => pageErrors.push('shell: ' + error.message));
    shellPage.on('console', msg => recordConsoleError('shell', msg));

    // T1-F2-01: Default target language is Simplified Chinese; bundled pagedattention p. 6 paints with 0 LLM calls.
    const iframeReader = await openReader(shellPage, host.authenticatedUrl);
    const initialState = await action<ReaderState>(context.request, host.origin, 'state');
    assert.equal(initialState.status, 200);
    assert.equal(initialState.body.settings.targetLanguage, 'Simplified Chinese');

    await iframeReader.getByRole('button', { name: 'Bilingual', exact: true }).click();
    await iframeReader.getByRole('group', { name: 'Simplified Chinese, page 6', exact: true }).waitFor();
    await iframeReader.locator('#loading').waitFor({ state: 'hidden' });
    const bundledText = await iframeReader.locator('#translated .pdf-translated-text[lang="zh-CN"][data-block-id]:visible').allInnerTexts();
    assert.ok(/\p{Script=Han}/u.test(bundledText.join('')), 'Bundled pagedattention page 6 must render Chinese.');
    assert.equal(await iframeReader.locator('#translationInfo').textContent(), 'Simplified Chinese');
    assert.equal(fixture.calls.length, 0);
    console.log('PASS T1-F2-01: Default targetLanguage is Simplified Chinese with bundled page 6 and 0 LLM calls.');

    // T2-F2-04 & T2-F2-05: Unconfigured non-Simplified-Chinese gates bundled .zh-CN.json and local OPUS-MT OFF.
    await saveTargetLanguage(iframeReader, 'Traditional Chinese');
    await iframeReader.getByRole('group', { name: 'Traditional Chinese, page 6', exact: true }).waitFor();
    await iframeReader.locator('#loading').waitFor({ state: 'hidden' });
    const unavailable = iframeReader.locator('.pdf-translation-state[data-state="unavailable"]');
    await unavailable.waitFor({ state: 'visible' });
    const guidance = await unavailable.textContent() ?? '';
    assert.match(guidance, /Connect a translation model|offline translator only supports Simplified Chinese/i);
    assert.equal(await iframeReader.locator('#translated .pdf-translated-text:visible').count(), 0);
    assert.equal(await iframeReader.locator('#translationInfo').textContent(), 'Traditional Chinese');

    const unconfiguredKorean = await action(context.request, host.origin, 'translation.page', {
      docId: 'pagedattention',
      page: 6,
      targetLanguage: 'Korean',
      blocks: [{ id: 'p1', text: 'The memory allocator assigns blocks dynamically.' }]
    });
    assert.equal(unconfiguredKorean.status, 503);
    console.log('PASS T2-F2-04 & T2-F2-05: Bundled .zh-CN.json and local OPUS-MT gated OFF for non-Simplified-Chinese.');

    // T2-F2-01: Empty / whitespace targetLanguage rejected (HTTP 400), prior value intact.
    for (const bad of ['', '   ', '   \t ']) {
      const res = await action(context.request, host.origin, 'settings.save', { targetLanguage: bad });
      assert.equal(res.status, 400, 'Expected 400 for ' + JSON.stringify(bad));
    }
    assert.equal((await action<ReaderState>(context.request, host.origin, 'state')).body.settings.targetLanguage, 'Traditional Chinese');
    console.log('PASS T2-F2-01: Empty and whitespace targetLanguage rejected with HTTP 400.');

    // T2-F2-02: 64-char accepted vs 65-char and control chars rejected (HTTP 400).
    const maxLen = 'L'.repeat(64);
    assert.equal((await action(context.request, host.origin, 'settings.save', { targetLanguage: maxLen })).status, 200);
    assert.equal((await action<ReaderState>(context.request, host.origin, 'state')).body.settings.targetLanguage, maxLen);
    for (const bad of ['L'.repeat(65), 'French\nJapanese', 'French\0', 'French\r']) {
      const res = await action(context.request, host.origin, 'settings.save', { targetLanguage: bad });
      assert.equal(res.status, 400, 'Expected 400 for ' + JSON.stringify(bad));
    }
    assert.equal((await action<ReaderState>(context.request, host.origin, 'state')).body.settings.targetLanguage, maxLen);
    console.log('PASS T2-F2-02: 64-char accepted; 65-char and control chars rejected with HTTP 400.');

    // Open direct standalone reader page in same authenticated context for fast deterministic reload & selection checks.
    const readerUrl = await iframeReader.locator('body').evaluate(body => body.ownerDocument.location.href);
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    page.on('pageerror', error => pageErrors.push('reader: ' + error.message));
    page.on('console', msg => recordConsoleError('reader', msg));
    await page.goto(readerUrl);
    await page.locator('#loading').waitFor({ state: 'hidden' });

    // T1-F2-02: Configure mock LLM + select preset 'Japanese', persist across reload.
    await saveTargetLanguage(page, 'Japanese', { baseUrl: fixture.baseUrl, model: fixture.model, apiKey: fixture.key });
    await page.reload();
    await page.locator('#loading').waitFor({ state: 'hidden' });
    assert.equal((await action<ReaderState>(context.request, host.origin, 'state')).body.settings.targetLanguage, 'Japanese');
    assert.equal(await page.locator('#translationInfo').textContent(), 'Japanese');
    const reopenedDialog = await openConnections(page);
    assert.equal(await reopenedDialog.getByRole('combobox', { name: 'Translation language', exact: true }).inputValue(), 'Japanese');
    assert.equal(await reopenedDialog.getByLabel('Custom target language', { exact: true }).isVisible(), false);
    await page.locator('#closeDialog').click();
    await reopenedDialog.waitFor({ state: 'hidden' });
    console.log('PASS T1-F2-02: Preset Japanese persists across reload and updates #translationInfo.');

    // Create & import synthetic 1-page English PDF.
    const pdfBuilder = await context.newPage();
    await pdfBuilder.setContent(
      '<style>@page{size:letter;margin:1in}body{font:16pt Georgia;line-height:1.5}</style>' +
      '<p>The memory allocator assigns physical blocks dynamically as sequence length grows.</p>' +
      '<p>Paged attention eliminates internal fragmentation across concurrent requests.</p>'
    );
    const pdfBytes = await pdfBuilder.pdf({ preferCSSPageSize: true });
    await pdfBuilder.close();
    const importResp = await context.request.post(host.origin + '/api/paper-reader/import-pdf?title=TargetLangTest.pdf', {
      headers: { 'content-type': 'application/pdf' },
      data: pdfBytes
    });
    assert.equal(importResp.status(), 200);
    const { doc: pdfDoc } = await importResp.json() as { doc: DocumentInfo };

    // T1-F2-03: Bilingual PDF translation into non-Chinese preset (Japanese).
    const callsBeforeJa = fixture.calls.length;
    await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=' + encodeURIComponent(pdfDoc.id) + '&page=1');
    await page.getByRole('group', { name: 'Japanese, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').first().waitFor();
    const jaText = (await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').allInnerTexts()).join('\n');
    assert.ok(jaText.includes('日本語訳:'), 'Expected Japanese translation, got: ' + jaText);
    assert.ok(fixture.calls.slice(callsBeforeJa).some(c => c.mode === 'blocks' && c.target === 'Japanese'));
    console.log('PASS T1-F2-03: Bilingual PDF translated into Japanese with lang="ja" and sheet aria-label.');

    // T2-F2-03: Multi-language cache isolation (legacy 1.json vs ja/1.json vs fr/1.json) + zero-call switch back.
    await saveTargetLanguage(page, 'Simplified Chinese');
    await page.getByRole('group', { name: 'Simplified Chinese, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text[lang="zh-CN"]:visible').first().waitFor();
    const zhText = (await page.locator('#translated .pdf-translated-text[lang="zh-CN"]:visible').allInnerTexts()).join('\n');
    assert.ok(zhText.includes('简体中文译文'), 'Expected Simplified Chinese translation, got: ' + zhText);

    await saveTargetLanguage(page, 'French');
    await page.getByRole('group', { name: 'French, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text[lang="fr"]:visible').first().waitFor();
    const frText = (await page.locator('#translated .pdf-translated-text[lang="fr"]:visible').allInnerTexts()).join('\n');
    assert.ok(frText.includes('Traduction française :'), 'Expected French translation, got: ' + frText);

    const cacheDir = path.join(host.scratch, 'reader', 'translations', pdfDoc.id);
    assert.equal(existsSync(path.join(cacheDir, '1.json')), true, 'Legacy 1.json must exist for Simplified Chinese.');
    assert.equal(existsSync(path.join(cacheDir, 'ja', '1.json')), true, 'ja/1.json must exist for Japanese.');
    assert.equal(existsSync(path.join(cacheDir, 'fr', '1.json')), true, 'fr/1.json must exist for French.');

    const callsBeforeSwitchBack = fixture.calls.length;
    await saveTargetLanguage(page, 'Simplified Chinese');
    await page.getByRole('group', { name: 'Simplified Chinese, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text[lang="zh-CN"]:visible').first().waitFor();
    assert.equal(fixture.calls.length, callsBeforeSwitchBack, 'Switching back to Simplified Chinese must hit legacy 1.json with 0 LLM calls.');

    await saveTargetLanguage(page, 'Japanese');
    await page.getByRole('group', { name: 'Japanese, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text[lang="ja"]:visible').first().waitFor();
    assert.equal(fixture.calls.length, callsBeforeSwitchBack, 'Switching back to Japanese must hit ja/1.json with 0 LLM calls.');
    console.log('PASS T2-F2-03: Multi-language cache isolation verified on disk and on switch-back (0 LLM calls).');

    // T2-F2-06: Non-Simplified-Chinese English target is NOT rejected by backend or client translationQualityError.
    await saveTargetLanguage(page, 'English');
    await page.getByRole('group', { name: 'English, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text[lang="en"]:visible').first().waitFor();
    const enText = (await page.locator('#translated .pdf-translated-text[lang="en"]:visible').allInnerTexts()).join('\n');
    assert.ok(enText.includes('memory allocator'), 'English translation must render without quality-check rejection.');
    console.log('PASS T2-F2-06: English translation accepted without false-positive translationQualityError.');

    // T1-F2-04: Custom target language 'Portuguese' translates and reloads from isolated cache with 0 LLM calls.
    const callsBeforePt = fixture.calls.length;
    await saveTargetLanguage(page, 'Portuguese', { custom: true });
    await page.getByRole('group', { name: 'Portuguese, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text:visible').first().waitFor();
    const ptText = (await page.locator('#translated .pdf-translated-text:visible').allInnerTexts()).join('\n');
    assert.ok(ptText.includes('Tradução em português:'), 'Expected Portuguese translation, got: ' + ptText);
    assert.equal(await page.locator('#translationInfo').textContent(), 'Portuguese');
    assert.ok(fixture.calls.slice(callsBeforePt).some(c => c.mode === 'blocks' && c.target === 'Portuguese'));

    const callsAfterPt = fixture.calls.length;
    await page.reload();
    await page.getByRole('group', { name: 'Portuguese, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text:visible').first().waitFor();
    assert.equal(fixture.calls.length, callsAfterPt, 'Reloading custom Portuguese must hit disk cache with 0 repeat LLM calls.');
    console.log('PASS T1-F2-04: Custom Portuguese translated and reloaded from cache with 0 repeat LLM calls.');

    // T2-F2-07: Custom language 'Esperanto' omits lang attribute (never 'zh-CN'), persists & pre-populates across reload.
    const ptDialog = await openConnections(page);
    assert.equal(await ptDialog.getByRole('combobox', { name: 'Translation language', exact: true }).inputValue(), '__custom__');
    assert.equal(await ptDialog.getByLabel('Custom target language', { exact: true }).inputValue(), 'Portuguese');
    await ptDialog.getByLabel('Custom target language', { exact: true }).fill('Esperanto');
    await ptDialog.getByRole('button', { name: 'Save connections', exact: true }).click();
    await ptDialog.waitFor({ state: 'hidden' });

    await page.getByRole('group', { name: 'Esperanto, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text:visible').first().waitFor();
    const eoText = (await page.locator('#translated .pdf-translated-text:visible').allInnerTexts()).join('\n');
    assert.ok(eoText.includes('Esperanta traduko:'), 'Expected Esperanto translation, got: ' + eoText);
    const eoLang = await page.locator('#translated .pdf-translated-text:visible').first().getAttribute('lang');
    assert.ok(eoLang === null || eoLang === 'und', 'Custom language must omit lang or use und (never zh-CN), got: ' + String(eoLang));

    await page.reload();
    await page.locator('#loading').waitFor({ state: 'hidden' });
    assert.equal((await action<ReaderState>(context.request, host.origin, 'state')).body.settings.targetLanguage, 'Esperanto');
    const eoDialog = await openConnections(page);
    assert.equal(await eoDialog.getByRole('combobox', { name: 'Translation language', exact: true }).inputValue(), '__custom__');
    assert.equal(await eoDialog.getByLabel('Custom target language', { exact: true }).inputValue(), 'Esperanto');
    await page.locator('#closeDialog').click();
    await eoDialog.waitFor({ state: 'hidden' });
    console.log('PASS T2-F2-07: Custom Esperanto omits lang (never zh-CN) and persists across reload.');

    // T1-F2-05: Web article translation respects targetLanguage (French) & caches across reload.
    await saveTargetLanguage(page, 'French');
    const importedWeb = await action<{ doc: DocumentInfo }>(context.request, host.origin, 'web.import', {
      url: 'https://example.org/multilingual-article',
      title: 'Multilingual Article Fixture',
      paragraphs: [
        'Dynamic memory management improves throughput in serving systems.',
        'Shared prefix caching avoids redundant key-value computation.'
      ]
    });
    assert.equal(importedWeb.status, 200);
    await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=' + encodeURIComponent(importedWeb.body.doc.id) + '&page=1');
    await page.locator('#loading').waitFor({ state: 'hidden' });
    const webSheet = page.locator('.web-reading-sheet[data-side="translation"]');
    await webSheet.waitFor();
    assert.equal(await webSheet.getAttribute('lang'), 'fr');
    assert.equal(await page.locator('#translationInfo').textContent(), 'French');

    const callsBeforeWeb = fixture.calls.length;
    await page.getByRole('button', { name: 'Translate article', exact: true }).click();
    await webSheet.getByText('Traduction française :').first().waitFor();
    assert.ok(fixture.calls.slice(callsBeforeWeb).some(c => c.mode === 'blocks' && c.target === 'French'));

    const callsAfterWeb = fixture.calls.length;
    await page.reload();
    await webSheet.getByText('Traduction française :').first().waitFor();
    assert.equal(await webSheet.getAttribute('lang'), 'fr');
    assert.equal(fixture.calls.length, callsAfterWeb, 'Reloading translated web article must hit cache with 0 LLM calls.');
    console.log('PASS T1-F2-05: Web article translated into French with lang="fr" and cached across reload.');

    // T1-F2-06: Selection card lookup & quick-action starter follow targetLanguage (German).
    await saveTargetLanguage(page, 'German');
    await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=' + encodeURIComponent(pdfDoc.id) + '&page=1');
    await page.getByRole('group', { name: 'German, page 1', exact: true }).waitFor();
    await page.locator('#translated .pdf-translated-text[lang="de"]:visible').first().waitFor();

    const firstRun = page.locator('#original .pdf-native-text [data-block-id]').first();
    const blockId = await firstRun.getAttribute('data-block-id');
    assert.ok(blockId);
    await page.locator('#original .pdf-native-text [data-block-id="' + blockId + '"]').evaluateAll(elements => {
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

    const card = page.locator('#card');
    await card.waitFor({ state: 'visible' });
    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const starter = page.getByRole('button', { name: 'Translate to German', exact: true });
    await starter.waitFor({ state: 'visible' });
    const callsBeforeSelection = fixture.calls.length;
    await starter.click();
    await page.locator('.selection-chat-log').getByText('Deutsche Übersetzung: Der Speicherblock').waitFor();
    assert.ok(
      fixture.calls.slice(callsBeforeSelection).some(c => c.mode === 'passage' && c.target === 'German' && c.system.includes('Translate into German.')),
      'Selection AI call must target German.'
    );
    console.log('PASS T1-F2-06: Selection card quick-action starter and AI call follow German targetLanguage.');

    // ZH UI spot-check: localized targetLanguage labels and settings controls in zh-CN locale.
    assert.equal((await action(context.request, host.origin, 'settings.save', { targetLanguage: 'Japanese' })).status, 200);
    const zhContext = await browser.newContext({
      viewport: { width: 1600, height: 960 },
      locale: 'zh-CN'
    });
    const zhPage = await zhContext.newPage();
    zhPage.setDefaultTimeout(12_000);
    zhPage.on('pageerror', error => pageErrors.push('zh: ' + error.message));
    zhPage.on('console', msg => recordConsoleError('zh', msg));
    await zhPage.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
    await zhPage.goto(host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6');
    await zhPage.locator('#loading').waitFor({ state: 'hidden' });
    assert.equal(await zhPage.locator('#translationInfo').textContent(), '日语');
    const zhDialog = await openConnections(zhPage);
    const zhSelect = zhDialog.getByRole('combobox', { name: '翻译目标语言', exact: true });
    assert.equal(await zhSelect.inputValue(), 'Japanese');
    const zhOptions = await zhSelect.locator('option').allTextContents();
    assert.ok(zhOptions.includes('日语'), 'Expected 日语 option in zh-CN');
    assert.ok(zhOptions.includes('自定义…'), 'Expected 自定义… option in zh-CN');
    await zhContext.close();
    console.log('PASS ZH UI spot-check: #translationInfo and Settings language controls localized in zh-CN.');

    assert.deepEqual(pageErrors, [], 'Expected zero page errors, saw: ' + pageErrors.join('\n'));
    assert.deepEqual(consoleErrors, [], 'Expected zero console errors, saw: ' + consoleErrors.join('\n'));
    await context.close();
    console.log('PASS all 13 F2 target-language E2E scenarios + zh-CN UI check.');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
