import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator } from 'playwright-core';
import { bookRoot, sections, startPublisherFixture } from './book-reading-fixture.js';
import { cardElement, openToolbar, until } from './extension-controls.js';
import { computeElementMetrics, inspectShadowCardMetrics, type RawElementSample } from './helpers/contrast.js';
import { assertNoEnBannedTerms, assertNoZhEnglishLeaks, collectChromeStrings } from './helpers/i18n.js';
import { openReaderPage, type ErrorScope } from './helpers/reader.js';
import { withHost, type HostFixture } from './host.js';

const extensionPath = fileURLToPath(new URL('../../dist/extension', import.meta.url));
const preload = new URL('./book-reading-preload.ts', import.meta.url).href;
const appPath = '/api/paper-reader/app/index.html';
const defaultScope: ErrorScope = { allowZotero503: true, allowExpected404: true };

async function assertShortcutsDialogContrast(dialog: Locator, label: string): Promise<void> {
  const samples = await dialog.evaluate((): (RawElementSample & { tag: string })[] => {
    const darkRoot = document.documentElement.dataset.theme === 'dark';
    return [...document.querySelectorAll('#shortcutsDialog h2, #shortcutsDialog h3, #shortcutsDialog th, #shortcutsDialog td, #shortcutsDialog kbd')].map(el => {
      const layers: string[] = [];
      for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) layers.push(getComputedStyle(cur).backgroundColor);
      const s = getComputedStyle(el);
      return { tag: el.tagName, fg: s.color, layers, darkRoot, fontSize: parseFloat(s.fontSize) || 0, colorScheme: s.colorScheme };
    });
  });
  for (const s of samples) {
    const m = computeElementMetrics(s);
    assert.ok(m.ratio >= 4.5, `${label} shortcuts contrast < 4.5 on ${s.tag}: ${m.ratio.toFixed(2)}`);
    assert.ok(m.fontSize >= 12, `${label} shortcuts fontSize < 12px on ${s.tag}: ${m.fontSize}`);
  }
}

async function testF6Shortcuts(host: HostFixture): Promise<void> {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    // 1. Desktop en-US shortcuts on PDF, OpenStax book, and web article
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [], consoleErrors: string[] = [];
    const page = await openReaderPage(context, host, '?doc=pagedattention&page=6', { tag: 'F6', scope: defaultScope, pageErrors, consoleErrors });

    const paperScroll = page.locator('#paperScroll');
    await paperScroll.focus();
    await page.keyboard.press('Shift+?');
    const dialog = page.locator('#shortcutsDialog');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), true);
    await dialog.getByRole('heading', { name: 'Keyboard shortcuts', exact: true }).waitFor();
    assert.ok(await dialog.locator('table.shortcuts-table').count() >= 4, 'Shortcuts dialog should render grouped semantic tables.');

    await assertShortcutsDialogContrast(dialog, 'Light');

    // Repeated Shift+? while open causes no duplicate/error
    await page.keyboard.press('Shift+?');
    assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'paperScroll', 'Escape must restore focus to prior element.');

    // T1-F6-02: #more -> Keyboard shortcuts opens modal; Close button restores focus to #more
    await page.locator('#more').click();
    await page.locator('#menu').getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await dialog.waitFor({ state: 'visible' });
    await page.locator('#closeShortcuts').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'more', 'Close button must restore focus to #more.');

    // T1-F6-03 & T2-F6-06: Shift++, =, - zoom stepping & clamping at Fit width (1) and 200% (2)
    await paperScroll.focus();
    const zoom = page.locator('#zoom');
    assert.equal(await zoom.inputValue(), '1');
    await page.keyboard.press('Shift++');
    assert.equal(await zoom.inputValue(), '1.25', 'Shift++ must step zoom from 1 to 1.25.');
    await page.keyboard.press('=');
    assert.equal(await zoom.inputValue(), '1.5');
    await page.keyboard.press('Shift++');
    assert.equal(await zoom.inputValue(), '2');
    await page.keyboard.press('Shift++');
    assert.equal(await zoom.inputValue(), '2', 'Zoom must clamp at 200%.');
    await page.keyboard.press('-');
    assert.equal(await zoom.inputValue(), '1.5');
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    assert.equal(await zoom.inputValue(), '1');
    await page.keyboard.press('-');
    assert.equal(await zoom.inputValue(), '0.75'); await page.keyboard.press('-'); assert.equal(await zoom.inputValue(), '0.75', 'Zoom must clamp at 75%.'); await page.keyboard.press('=');

    // T1-F6-04: b, n, c toggle bilingual, Notes (twice to prove repeat toggle works after focus moves to #notesTab!), Contents
    const reader = page.locator('#reader');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    await page.keyboard.press('b');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'bilingual');
    await page.keyboard.press('b');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');

    assert.equal(await reader.getAttribute('data-notebook-open'), 'false');
    await page.keyboard.press('n');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'true');
    assert.equal(await page.locator('#notesTab').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('n');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'false', 'Pressing n a second time must toggle Notes closed even when #notesTab had focus.');

    await page.keyboard.press('c');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'true');
    assert.equal(await page.locator('#contentsTab').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('c');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'false', 'Pressing c a second time must toggle Contents closed.');

    // T1-F6-05 & T2-F6-05: ArrowRight / ArrowLeft PDF pagination + clamps at page 1 & page 16
    await paperScroll.focus();
    assert.equal(await page.locator('#pageCount').innerText(), '6 / 16');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '7 / 16');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '6 / 16');
    // Jump to page 1 and check ArrowLeft clamp
    await page.locator('#pageCount').click();
    await page.locator('#pageNumber').fill('1');
    await page.locator('#pageJump button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '1 / 16');
    await paperScroll.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#pageCount').innerText(), '1 / 16');
    // Jump to page 16 and check ArrowRight clamp
    await page.locator('#pageCount').click();
    await page.locator('#pageNumber').fill('16');
    await page.locator('#pageJump button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '16 / 16');
    await paperScroll.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#pageCount').innerText(), '16 / 16');

    // T2-F6-02: Modifier suppression (Ctrl+b, Meta+c, Alt+n, Ctrl++, Alt+ArrowLeft)
    await page.keyboard.press('Control+b');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    await page.keyboard.press('Meta+c');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'false');
    await page.keyboard.press('Alt+n');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'false');
    await page.keyboard.press('Control++');
    assert.equal(await zoom.inputValue(), '1');
    await page.keyboard.press('Control+ArrowLeft');
    assert.equal(await page.locator('#pageCount').innerText(), '16 / 16');
    await page.keyboard.press('Alt+ArrowLeft'); await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '1 / 16');
    await page.keyboard.press('Alt+ArrowRight'); await page.waitForFunction(() => document.getElementById('pageCount')?.textContent === '16 / 16');

    // T2-F6-03: Suppression when #pageJump popover or libraryDialog is open
    await page.locator('#pageCount').click();
    await page.locator('#pageJump').waitFor({ state: 'visible' });
    await page.keyboard.press('b');
    await page.keyboard.press('Shift+?');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), false);
    await page.keyboard.press('Escape');

    await page.locator('#library').click();
    await page.locator('#dialog').waitFor({ state: 'visible' });
    await page.keyboard.press('b');
    await page.keyboard.press('Shift+?');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), false);
    await page.locator('#closeDialog').click();

    // T2-F6-01: Suppression inside <select>, CodeMirror .cm-editor, <textarea>, <input>, [contenteditable]
    await zoom.focus();
    await page.keyboard.press('b');
    await page.keyboard.press('Shift+?');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), false);

    // CodeMirror .cm-editor
    await paperScroll.focus();
    await page.keyboard.press('n');
    const cmEditor = page.getByRole('textbox', { name: 'Notes Markdown' });
    await cmEditor.click();
    await page.keyboard.type('bn?c+-');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'true');
    assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), false);
    assert.equal(await zoom.inputValue(), '1');

    // Paper chat <textarea>
    await page.locator('.paper-chat-toggle').click();
    const chatTextarea = page.getByRole('textbox', { name: 'Message about this paper' });
    await chatTextarea.click();
    await page.keyboard.type('b?n');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), false);
    assert.equal(await chatTextarea.inputValue(), 'b?n');
    await page.locator('.paper-chat-toggle').click();
    await page.locator('#closeRail').click();

    // Synthetic [contenteditable] and <input> inside page
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'test-ce';
      box.contentEditable = 'true';
      document.body.append(box);
      box.focus();
    });
    await page.keyboard.type('b?n');
    assert.equal(await reader.getAttribute('data-reading-mode'), 'source');
    assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), false);
    await page.evaluate(() => document.getElementById('test-ce')?.remove());

    // T1-F6-06 & T2-F6-05: OpenStax book ArrowRight / ArrowLeft section nav & boundary clamps
    const bookRes = await context.request.post(host.origin + '/api/paper-reader/action', {
      data: { op: 'web.open', payload: { url: bookRoot + sections.start.slug } }
    });
    assert.equal(bookRes.status(), 200);
    const { doc: bookDoc } = await bookRes.json() as { doc: { id: string; book: { sections: { title: string }[] } } };
    await page.goto(host.origin + appPath + '?doc=' + bookDoc.id + '&page=1', { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').waitFor({ state: 'hidden' });
    await page.locator('#paperScroll').focus();
    // Clamp at section 1
    await page.keyboard.press('ArrowLeft');
    assert.equal(new URL(page.url()).searchParams.get('page'), '1');
    // Step section 1 -> 2 -> 1
    await page.keyboard.press('ArrowRight');
    await page.waitForURL(url => url.searchParams.get('page') === '2');
    await page.locator('#loading').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#docMeta').innerText(), bookDoc.book.sections[1].title);
    await page.locator('#paperScroll').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForURL(url => url.searchParams.get('page') === '1');
    await page.locator('#loading').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#docMeta').innerText(), bookDoc.book.sections[0].title);
    // Clamp at last section
    const lastSection = String(bookDoc.book.sections.length);
    await page.goto(host.origin + appPath + '?doc=' + bookDoc.id + '&page=' + lastSection, { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').waitFor({ state: 'hidden' });
    await page.locator('#paperScroll').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(new URL(page.url()).searchParams.get('page'), lastSection);

    // T2-F6-04: Non-book web article ArrowLeft / ArrowRight is safe no-op (zero pageerror)
    const webRes = await context.request.post(host.origin + '/api/paper-reader/action', {
      data: { op: 'web.import', payload: { title: 'Plain Web Article', url: 'https://example.org/plain-article', paragraphs: ['First paragraph.', 'Second paragraph.'] } }
    });
    assert.equal(webRes.status(), 200);
    const { doc: webDoc } = await webRes.json() as { doc: { id: string } };
    await page.goto(host.origin + appPath + '?doc=' + webDoc.id, { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').waitFor({ state: 'hidden' });
    await page.locator('#paperScroll').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    assert.equal(new URL(page.url()).searchParams.get('doc'), webDoc.id);

    assert.deepEqual(pageErrors, [], 'F6 desktop pageerrors: ' + pageErrors.join('; '));
    assert.deepEqual(consoleErrors, [], 'F6 desktop console errors: ' + consoleErrors.join('; '));
    await context.close();

    // 2. Dark mode + 390x844 mobile check for #shortcutsDialog
    const mobileDark = await browser.newContext({
      locale: 'zh-CN',
      colorScheme: 'dark',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    const mPageErrors: string[] = [], mConsoleErrors: string[] = [];
    const mPage = await openReaderPage(mobileDark, host, '?doc=pagedattention&page=6', { tag: 'F6-mobile', scope: defaultScope, pageErrors: mPageErrors, consoleErrors: mConsoleErrors });
    assert.equal(await mPage.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await mPage.locator('#more').click();
    await mPage.locator('#menu').getByRole('button', { name: '快捷键', exact: true }).click();
    const mDialog = mPage.locator('#shortcutsDialog');
    await mDialog.waitFor({ state: 'visible' });
    const mobileAudit = await mDialog.evaluate(() => {
      const closeRect = document.getElementById('closeShortcuts')!.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        dialogOverflow: document.getElementById('shortcutsDialog')!.scrollWidth - document.getElementById('shortcutsDialog')!.clientWidth,
        closeWidth: closeRect.width,
        closeHeight: closeRect.height
      };
    });
    assert.ok(mobileAudit.overflow <= 1, `Mobile page horizontal overflow: ${mobileAudit.overflow}`);
    assert.ok(mobileAudit.dialogOverflow <= 1, `Shortcuts dialog horizontal overflow at 390x844: ${mobileAudit.dialogOverflow}`);
    assert.ok(mobileAudit.closeWidth >= 44 && mobileAudit.closeHeight >= 44, `Mobile closeShortcuts target < 44px: ${mobileAudit.closeWidth}x${mobileAudit.closeHeight}`);
    await assertShortcutsDialogContrast(mDialog, 'Dark');
    assert.deepEqual(mPageErrors, []);
    assert.deepEqual(mConsoleErrors, []);
    await mobileDark.close();
    console.log('PASS F6: shortcuts modal (light/dark/390x844), Shift+?/?/Shift++/=/-, b/n/c repeat toggles, PDF & OpenStax Arrow nav, web no-op, suppression guards.');
  } finally { await browser.close(); }
}

async function testImeEscapeGuards(host: HostFixture): Promise<void> {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [], consoleErrors: string[] = [];
    const page = await openReaderPage(context, host, '?doc=pagedattention&page=6', { tag: 'IME', scope: defaultScope, pageErrors, consoleErrors });
    const reader = page.locator('#reader');

    const dispatchImeEscapes = async (selector: string): Promise<void> => {
      const checked = await page.locator(selector).evaluate(target => {
        const el = target as HTMLElement;
        el.focus();
        const evComposing = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
        el.dispatchEvent(evComposing);
        const evKeyCode229 = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true });
        el.dispatchEvent(evKeyCode229);
        return { isComposing: evComposing.isComposing, keyCode229: evKeyCode229.keyCode };
      });
      assert.equal(checked.isComposing, true, `KeyboardEvent.isComposing must be true on ${selector}`);
      assert.equal(checked.keyCode229, 229, `KeyboardEvent.keyCode must be 229 on ${selector}`);
    };

    // (a) Notes CodeMirror editor (.cm-content)
    await page.locator('#mobileRail').click();
    assert.equal(await reader.getAttribute('data-notebook-open'), 'true');
    const cmContent = page.locator('.cm-content');
    await cmContent.waitFor({ state: 'visible' });
    await cmContent.click();
    await dispatchImeEscapes('.cm-content');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'true', 'IME Escape in Notes CodeMirror editor must not close sidebar.');
    await page.keyboard.press('Escape');
    assert.equal(await reader.getAttribute('data-notebook-open'), 'false', 'Normal Escape in Notes CodeMirror editor must still close sidebar.');

    // (b) Selection Card chat composer (#card .chat-composer textarea)
    await page.locator('#readText').click();
    await page.getByRole('region', { name: '本页正文' }).getByRole('button', { name: /选中此段 · 左栏 · 块表$/ }).click();
    const card = page.locator('#card');
    await card.waitFor({ state: 'visible' });
    await card.getByRole('button', { name: '提问', exact: true }).click();
    const chatComposer = page.locator('#card .chat-composer textarea');
    await chatComposer.waitFor({ state: 'visible' });
    assert.equal(await card.getAttribute('data-workspace'), 'chat');
    await dispatchImeEscapes('#card .chat-composer textarea');
    assert.equal(await card.isVisible(), true, 'IME Escape in Selection Card chat composer must keep card open.');
    assert.equal(await card.getAttribute('data-workspace'), 'chat', 'IME Escape in Selection Card chat composer must keep chat workspace open.');
    await page.keyboard.press('Escape');
    assert.equal(await card.getAttribute('data-workspace'), null, 'Normal Escape must exit Selection Card chat workspace.');
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'hidden' });
    await page.locator('#readText').click();

    // (c) Marks popover textarea (.annotation-popover textarea)
    const figure = page.locator('#original .pdf-figure[data-block-id="figure-6"]');
    await figure.scrollIntoViewIfNeeded();
    const bounds = (await figure.boundingBox())!;
    await page.locator('#placePin').click();
    await page.mouse.click(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.35);
    const popover = page.locator('.annotation-popover');
    await popover.waitFor({ state: 'visible' });
    const popoverTextarea = page.locator('.annotation-popover textarea');
    await popoverTextarea.waitFor({ state: 'visible' });
    await dispatchImeEscapes('.annotation-popover textarea');
    assert.equal(await popover.isVisible(), true, 'IME Escape in Marks popover textarea must keep popover open.');
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'hidden' });

    assert.deepEqual(pageErrors, [], 'IME Escape test pageerrors: ' + pageErrors.join('; '));
    assert.deepEqual(consoleErrors, [], 'IME Escape test console errors: ' + consoleErrors.join('; '));
    await context.close();
    console.log('PASS IME Escape guards: Notes (.cm-content), Selection Card chat composer, and Marks popover ignore composing Escape and dismiss on normal Escape.');
  } finally { await browser.close(); }
}

async function testF7AndF8I18nAndTerminology(host: HostFixture): Promise<void> {
  const browser = await chromium.launch({ executablePath: host.executable });
  try {
    // 1. zh-CN full sweep across topbar, all 4 sidebar tabs, all 4 modals, selection card/notes/chat, Paper chat, empty & error states
    const zhCtx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const zhPageErrors: string[] = [], zhConsoleErrors: string[] = [];
    const zhPage = await openReaderPage(zhCtx, host, '?doc=pagedattention&page=6', { tag: 'F7-zh', scope: defaultScope, pageErrors: zhPageErrors, consoleErrors: zhConsoleErrors });

    assert.equal(await zhPage.evaluate(() => document.documentElement.lang), 'zh-CN');
    assert.equal(await zhPage.locator('#mobileRail').getAttribute('aria-label'), '打开笔记');
    assert.equal(await zhPage.locator('#rail').getAttribute('aria-label'), '阅读笔记');
    assert.equal(await zhPage.locator('#closeRail').getAttribute('aria-label'), '关闭笔记');
    assert.equal(await zhPage.locator('#notesSplit').getAttribute('aria-label'), '调整笔记宽度');
    assert.equal(await zhPage.locator('#notebookPose').getAttribute('aria-label'), '笔记位置');
    assert.equal(await zhPage.locator('.paper-chat').getAttribute('aria-label'), '全文问答');

    // Open sidebar and inspect all 4 tabs
    await zhPage.locator('#mobileRail').click();
    assert.deepEqual(
      await zhPage.locator('.rail-head [role="tab"]').allInnerTexts(),
      ['目录', '笔记', '标记', '文献']
    );
    assert.equal(await zhPage.locator('.highlight-preference').isVisible(), false);
    assert.deepEqual(
      await zhPage.locator('#highlightDisplay option').allTextContents(),
      ['随笔记显示', '仅在标记中显示']
    );
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Notes tab');

    await zhPage.getByText('阅读提示', { exact: true }).click();
    await zhPage.getByText('第 6 页要点', { exact: true }).waitFor();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Reading guide');

    await zhPage.locator('#annotationsTab').click();
    await zhPage.locator('.annotation-workspace').getByRole('heading', { name: '标记', exact: true }).waitFor();
    assert.equal((await zhPage.locator('#notebookHandle').innerText()).trim(), '标记');
    assert.equal(await zhPage.locator('.annotation-workspace').getAttribute('aria-label'), '本篇标记');
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Marks tab');

    // Reference tab
    await zhPage.locator('#refsTab').click();
    await zhPage.getByText('导出引文', { exact: true }).waitFor();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Reference tab');

    // Contents tab
    await zhPage.locator('#contentsTab').click();
    await zhPage.locator('.toc-fold').first().waitFor();
    const foldLabel = await zhPage.locator('.toc-fold').first().getAttribute('aria-label');
    assert.ok(foldLabel?.startsWith('下级目录 · '), `Expected localized TOC fold aria-label, got: ${foldLabel}`);
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Contents tab');

    // Paper chat drawer (unconfigured model state)
    await zhPage.locator('.paper-chat-toggle').click();
    await zhPage.getByText('请连接模型以使用全文问答。', { exact: true }).waitFor();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Paper chat');
    await zhPage.locator('.paper-chat-toggle').click();

    // Selection card + selection notes + selection chat (unconfigured) + Active passage & Page text sampleAreas zh-CN checks
    await zhPage.locator('#closeRail').click();
    await zhPage.locator('#parallel').click();
    await zhPage.locator('#translationMode').selectOption('passage');
    const translationInfo = (await zhPage.locator('#translationInfo').innerText()).trim();
    assert.equal(translationInfo, '左栏 · 块表', `Expected localized #translationInfo in Active passage mode, got: ${translationInfo}`);
    await zhPage.locator('#translationMode').selectOption('page');
    await zhPage.locator('#originalMode').click();

    // Open Page text (#readText) and verify every .passage-pick[aria-label] & #card .selection-location has zero English leaks
    await zhPage.locator('#readText').click();
    const pickLabels = await zhPage.locator('.passage-pick').evaluateAll(els => els.map(el => el.getAttribute('aria-label') || ''));
    assert.ok(pickLabels.length >= 6, `Expected passage-pick buttons in #readText, got ${pickLabels.length}`);
    for (const pickLabel of pickLabels) {
      assert.doesNotMatch(pickLabel, /\b(?:Figure|Left column|Section|Block tables|Batching|Decoding|Parallel|Memory)\b/i,
        `Untranslated sampleAreas label in .passage-pick[aria-label]: ${pickLabel}`);
    }
    assert.ok(pickLabels.some(l => l.includes('图 6')));
    assert.ok(pickLabels.some(l => l.includes('左栏 · 块表')));
    assert.ok(pickLabels.some(l => l.includes('第 4.3 节 · 并行缓存访问')));
    assert.ok(pickLabels.some(l => l.includes('第 4.4 节 · 并行采样')));

    const card = zhPage.locator('#card');
    await zhPage.getByRole('region', { name: '本页正文' }).getByRole('button', { name: /选中此段 · 图 6$/ }).click();
    await card.waitFor({ state: 'visible' });
    assert.equal((await card.locator('.selection-location').innerText()).trim(), '第 6 页 · 图 6');
    await zhPage.keyboard.press('Escape');

    await zhPage.getByRole('region', { name: '本页正文' }).getByRole('button', { name: /选中此段 · 左栏 · 块表$/ }).click();
    await card.waitFor({ state: 'visible' });
    assert.equal((await card.locator('.selection-location').innerText()).trim(), '第 6 页 · 左栏 · 块表');
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Selection card');
    await card.getByRole('button', { name: '记笔记', exact: true }).click();
    await card.getByRole('textbox', { name: '笔记内容', exact: true }).waitFor();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Selection notes');
    await card.getByRole('button', { name: '提问', exact: true }).click();
    await card.getByRole('textbox', { name: '针对此选段提问', exact: true }).waitFor();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Selection chat');
    await zhPage.keyboard.press('Escape');
    await zhPage.keyboard.press('Escape');
    await zhPage.locator('#readText').click();

    // Verify page 7 Marks .source-chip does not duplicate "第 7 页 · " prefix
    await zhPage.goto(host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=7', { waitUntil: 'domcontentloaded' });
    await zhPage.locator('#loading').waitFor({ state: 'hidden' });
    await zhPage.locator('#readText').click();
    await zhPage.getByRole('region', { name: '本页正文' }).getByRole('button', { name: /选中此段 · 第 7 页 · 第 2 段$/ }).click();
    await card.waitFor({ state: 'visible' });
    assert.equal((await card.locator('.selection-location').innerText()).trim(), '第 7 页 · 第 2 段');
    await card.getByRole('button', { name: '高亮', exact: true }).click();
    if (await zhPage.locator('#rail').isHidden()) await zhPage.locator('#mobileRail').click();
    await zhPage.locator('#annotationsTab').click();
    await zhPage.locator('.annotation-entry').first().click();
    const page7Chip = (await zhPage.locator('.annotation-editor .source-chip').innerText()).trim();
    assert.equal(page7Chip, '第 7 页 · 第 2 段', `Expected deduplicated Marks .source-chip, got: ${page7Chip}`);
    await zhPage.locator('.annotation-editor').getByRole('button', { name: '移除', exact: true }).click();
    await zhPage.locator('.annotation-editor').getByRole('button', { name: '移除标记', exact: true }).click();
    await zhPage.locator('#closeRail').click();
    await zhPage.locator('#readText').click();
    await zhPage.goto(host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6', { waitUntil: 'domcontentloaded' });
    await zhPage.locator('#loading').waitFor({ state: 'hidden' });

    // All 4 modals in zh-CN: Library (+ invalid URL error), Connections, Vocabulary & history, Shortcuts
    await zhPage.locator('#library').click();
    const modal = zhPage.locator('#dialog');
    await modal.waitFor({ state: 'visible' });
    await modal.getByRole('tab', { name: '本机文档', exact: true }).click();
    const sampleRow = modal.locator('.doc-row').filter({ hasText: 'PagedAttention.pdf' });
    await sampleRow.waitFor({ state: 'visible' });
    assert.ok((await sampleRow.innerText()).includes('16 页'), 'Expected 16 页 in zh-CN Library row');
    await modal.getByRole('button', { name: '打开网页', exact: true }).click();
    await modal.getByLabel('网页地址', { exact: true }).fill('ftp://invalid.example');
    await modal.locator('#library-url-form').evaluate(form => (form as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true })));
    await modal.getByText('请输入以 http 或 https 开头的网页地址。', { exact: true }).waitFor();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Library modal');
    await zhPage.locator('#closeDialog').click();

    await zhPage.locator('#more').click();
    await zhPage.locator('#menu').getByRole('button', { name: '连接设置', exact: true }).click();
    await modal.waitFor({ state: 'visible' });
    const zhLangSelect = modal.getByRole('combobox', { name: '翻译目标语言', exact: true });
    await zhLangSelect.selectOption('__custom__');
    const zhCustomInput = modal.getByLabel('自定义目标语言', { exact: true });
    await zhCustomInput.fill('   ');
    await modal.getByRole('button', { name: '保存连接设置', exact: true }).click();
    const zhToast = zhPage.locator('#toast');
    await zhToast.waitFor({ state: 'visible' });
    assert.equal((await zhToast.innerText()).trim(), '请输入翻译目标语言。');
    await zhCustomInput.evaluate(el => {
      const input = el as HTMLInputElement;
      input.removeAttribute('maxlength');
      input.value = 'A'.repeat(65);
    });
    await modal.getByRole('button', { name: '保存连接设置', exact: true }).click();
    await zhToast.waitFor({ state: 'visible' });
    assert.equal((await zhToast.innerText()).trim(), '翻译目标语言最多 64 个字符。');
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Connections AI tab');
    await modal.getByRole('tab', { name: 'Obsidian', exact: true }).click();
    await modal.getByLabel('Obsidian 笔记库文件夹', { exact: true }).waitFor();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Connections Obsidian tab');
    await modal.getByRole('tab', { name: 'Zotero', exact: true }).click();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Connections Zotero tab');
    await zhPage.locator('#closeDialog').click();

    await zhPage.locator('#more').click();
    await zhPage.locator('#menu').getByRole('button', { name: '生词与历史', exact: true }).click();
    await modal.waitFor({ state: 'visible' });
    await modal.getByRole('tab', { name: '生词', exact: true }).waitFor();
    await modal.getByRole('tab', { name: '历史', exact: true }).waitFor();
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Collections modal');
    await zhPage.locator('#closeDialog').click();

    await zhPage.locator('#more').click();
    await zhPage.locator('#menu').getByRole('button', { name: '快捷键', exact: true }).click();
    await zhPage.locator('#shortcutsDialog').waitFor({ state: 'visible' });
    assertNoZhEnglishLeaks(await collectChromeStrings(zhPage), 'zh-CN Shortcuts modal');
    await zhPage.locator('#closeShortcuts').click();

    assert.deepEqual(zhPageErrors, []);
    assert.deepEqual(zhConsoleErrors, []);
    await zhCtx.close();

    // 2. T2-F7-02: Bare 'zh' activates Chinese UI (including localized sampleAreas labels)
    const bareZhCtx = await browser.newContext({ locale: 'zh', viewport: { width: 1280, height: 800 } });
    const bareZhPage = await openReaderPage(bareZhCtx, host);
    assert.equal(await bareZhPage.evaluate(() => document.documentElement.lang), 'zh-CN');
    assert.equal(await bareZhPage.locator('#annotationsTab').innerText(), '标记');
    await bareZhPage.locator('#parallel').click();
    await bareZhPage.locator('#translationMode').selectOption('passage');
    assert.equal((await bareZhPage.locator('#translationInfo').innerText()).trim(), '左栏 · 块表');
    await bareZhCtx.close();

    // 3. T2-F7-03: Non-Chinese locale ('ja-JP') defaults cleanly to English with zero Chinese leakage in chrome
    const jaCtx = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1280, height: 800 } });
    const jaPage = await openReaderPage(jaCtx, host);
    assert.equal(await jaPage.evaluate(() => document.documentElement.lang), 'en');
    await jaPage.locator('#mobileRail').click();
    const jaStrings = await collectChromeStrings(jaPage);
    for (const item of jaStrings) {
      assert.equal(/\p{Script=Han}/u.test(item.text), false, `ja-JP chrome leaked Chinese in ${item.source}: ${item.text}`);
    }
    await jaCtx.close();

    // 4. en-US full terminology sweep (T1-F8-01, T1-F8-03, T2-F8-01..05)
    const enCtx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const enPageErrors: string[] = [], enConsoleErrors: string[] = [];
    const enPage = await openReaderPage(enCtx, host, '?doc=pagedattention&page=6', { tag: 'F8-en', scope: defaultScope, pageErrors: enPageErrors, consoleErrors: enConsoleErrors });
    assert.equal(await enPage.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await enPage.locator('#mobileRail').getAttribute('aria-label'), 'Show notes');
    assert.equal(await enPage.locator('#rail').getAttribute('aria-label'), 'Reading notes');
    assert.equal(await enPage.locator('#closeRail').getAttribute('aria-label'), 'Close notes');
    assert.equal(await enPage.locator('#notesSplit').getAttribute('aria-label'), 'Resize notes');
    assert.equal(await enPage.locator('#notebookPose').getAttribute('aria-label'), 'Notes position');
    assert.equal(await enPage.locator('.paper-chat').getAttribute('aria-label'), 'Paper chat');

    await enPage.locator('#mobileRail').click();
    assert.deepEqual(
      await enPage.locator('.rail-head [role="tab"]').allInnerTexts(),
      ['Contents', 'Notes', 'Marks', 'Reference']
    );
    assert.equal(await enPage.locator('.highlight-preference').isVisible(), false);
    assert.deepEqual(
      await enPage.locator('#highlightDisplay option').allTextContents(),
      ['In Notes', 'In Marks only']
    );
    assertNoEnBannedTerms(await collectChromeStrings(enPage), 'en-US Notes tab');

    await enPage.locator('#annotationsTab').click();
    await enPage.locator('.annotation-workspace').getByRole('heading', { name: 'Marks', exact: true }).waitFor();
    assert.equal((await enPage.locator('#notebookHandle').innerText()).trim(), 'Marks');
    assert.equal(await enPage.locator('.annotation-workspace').getAttribute('aria-label'), 'Marks for this paper');
    assertNoEnBannedTerms(await collectChromeStrings(enPage), 'en-US Marks tab');

    await enPage.locator('#refsTab').click();
    assertNoEnBannedTerms(await collectChromeStrings(enPage), 'en-US Reference tab');

    await enPage.locator('.paper-chat-toggle').click();
    assertNoEnBannedTerms(await collectChromeStrings(enPage), 'en-US Paper chat');
    await enPage.locator('.paper-chat-toggle').click();

    await enPage.locator('#more').click();
    await enPage.locator('#menu').getByRole('button', { name: 'Connections', exact: true }).click();
    assertNoEnBannedTerms(await collectChromeStrings(enPage), 'en-US Connections AI tab');
    await enPage.locator('#dialog').getByRole('tab', { name: 'Obsidian', exact: true }).click();
    await enPage.locator('#dialog').getByLabel('Obsidian vault folder', { exact: true }).waitFor();
    assertNoEnBannedTerms(await collectChromeStrings(enPage), 'en-US Connections Obsidian tab');
    await enPage.locator('#dialog').getByRole('tab', { name: 'Zotero', exact: true }).click();
    assertNoEnBannedTerms(await collectChromeStrings(enPage), 'en-US Connections Zotero tab');
    await enPage.locator('#closeDialog').click();

    await enPage.locator('#more').click();
    await enPage.locator('#menu').getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await enPage.locator('#shortcutsDialog').waitFor({ state: 'visible' });
    assertNoEnBannedTerms(await collectChromeStrings(enPage), 'en-US Shortcuts modal');
    await enPage.locator('#closeShortcuts').click();

    assert.deepEqual(enPageErrors, []);
    assert.deepEqual(enConsoleErrors, []);
    await enCtx.close();

    console.log('PASS F7 & F8: complete EN/ZH/bare-zh/ja-JP i18n and strict Marks/Paper chat/Notes terminology unification verified with 0 leaks.');
  } finally { await browser.close(); }
}

async function testExtensionLocale(host: HostFixture, locale: 'zh-CN' | 'en-US'): Promise<void> {
  const articleServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Locale Probe</title></head><body><article><h1>Locale Probe</h1><p><span id="term">PagedAttention</span> manages virtual KV blocks across requests.</p></article></body></html>');
  });
  await new Promise<void>(resolve => articleServer.listen(0, '127.0.0.1', resolve));
  const address = articleServer.address();
  assert.ok(address && typeof address === 'object');
  const articleUrl = `http://locale-probe.test:${address.port}/article`;
  const profileDir = path.join(host.scratch, 'ext-profile-' + locale + '-' + randomUUID().slice(0, 6));
  await mkdir(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: host.executable,
    headless: true,
    locale,
    env: { ...process.env, LANG: locale === 'zh-CN' ? 'zh_CN.UTF-8' : 'en_US.UTF-8', LC_ALL: locale === 'zh-CN' ? 'zh_CN.UTF-8' : 'en_US.UTF-8' },
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--lang=' + locale, '--enable-unsafe-extension-debugging', '--no-proxy-server', '--host-resolver-rules=MAP locale-probe.test 127.0.0.1']
  });
  try {
    const cdp = await context.browser()!.newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
    await cdp.detach();

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(articleUrl, { waitUntil: 'domcontentloaded' });
    const popup = await openToolbar(page, id);
    const popupLang = await popup.evaluate(() => document.documentElement.lang, null);
    assert.equal(popupLang, locale === 'zh-CN' ? 'zh-CN' : 'en');
    await popup.click('summary');
    await popup.evaluate(origin => {
      document.querySelector<HTMLInputElement>('#origin')!.value = origin;
      document.querySelector('form')!.requestSubmit();
    }, host.origin);
    await until(() => popup.evaluate(() => /address was saved|地址已保存/.test(document.querySelector('#message')?.textContent ?? ''), null),
      'Extension popup did not save origin.');
    await popup.click('#toggle');
    await popup.detach();

    await page.locator('#term').dblclick();
    await until(async () => Boolean(await cardElement(page, '.card')), 'Extension selection card did not open.');
    const cardInfo = await inspectShadowCardMetrics(page, '.card');
    assert.ok(cardInfo, 'Extension selection card DOM info missing.');

    if (locale === 'zh-CN') {
      assert.equal(cardInfo.lang, 'zh-CN');
      assert.equal(cardInfo.ariaLabel, 'DSH 划词卡片');
      assert.equal(cardInfo.closeAria, '关闭卡片');
      assert.equal(cardInfo.translate, '翻译');
      assert.equal(cardInfo.note, '记入笔记');
      assert.match(cardInfo.hint ?? '', /DSH 模型/);
    } else {
      assert.equal(cardInfo.lang, 'en');
      assert.equal(cardInfo.ariaLabel, 'DSH selection card');
      assert.equal(cardInfo.closeAria, 'Close card');
      assert.equal(cardInfo.translate, 'Translate');
      assert.equal(cardInfo.note, 'Add to Notes');
    }
  } finally {
    await context.close();
    articleServer.close();
    articleServer.closeAllConnections();
    await rm(profileDir, { recursive: true, force: true });
  }
}

const logFile = path.join(os.tmpdir(), 'paper-reader-shortcuts-i18n-' + randomUUID() + '.ndjson');
await writeFile(logFile, '', { flag: 'wx' });
try {
  const fixture = await startPublisherFixture();
  try {
    await withHost(async host => {
      await testF6Shortcuts(host);
      await testImeEscapeGuards(host);
      await testF7AndF8I18nAndTerminology(host);
      await testExtensionLocale(host, 'zh-CN');
      await testExtensionLocale(host, 'en-US');
      console.log('PASS extension locale consistency: zh-CN & en-US popup + shadow-DOM card verified.');
    }, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' '),
      PAPER_READER_E2E_PUBLISHER_FIXTURE: fixture.origin,
      PAPER_READER_E2E_PUBLISHER_LOG: logFile
    });
  } finally { await fixture.close(); }
} finally { await rm(logFile, { force: true }); }
