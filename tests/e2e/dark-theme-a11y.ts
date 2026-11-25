import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type FrameLocator, type Page } from 'playwright-core';
import { cardElement, clickCard, openToolbar, until } from './extension-controls.js';
import {
  assertBorderContrast, assertBorderContrastBothThemes, assertContrast, assertDarkSurface,
  composite, computeBorderMetrics, computeElementMetrics, contrastRatio,
  inspectShadowCardMetrics, measureLocator, parseCssColor, relLum,
  type RawBorderSample, type RawElementSample
} from './helpers/contrast.js';
import { closeServer } from './helpers/fixtures.js';
import { action, attachErrorGuards, openReaderPage, type ErrorScope } from './helpers/reader.js';
import { openReader, withHost, type HostFixture } from './host.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const evidence = process.argv.includes('--evidence');

async function startRichWebFixture() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dark Theme Contrast Study</title>
  <meta name="citation_title" content="Dark Theme Contrast Study">
  <meta name="citation_author" content="Lin, Wei">
  <meta name="citation_publication_date" content="2025">
</head>
<body>
  <article>
    <h1>Dark Theme Contrast Study</h1>
    <p>Paragraph one examines <a href="https://research.google/ref">semantic color tokens</a> and inline <code>color-scheme</code> across academic reading interfaces.</p>
    <p>Paragraph two verifies highlight and link contrast when a reader opens an anchored citation.</p>
    <blockquote>A blockquote must retain crisp contrast and a visible border on dark reading sheets.</blockquote>
    <pre><code>const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;</code></pre>
    <table>
      <thead><tr><th>Surface</th><th>Contrast</th></tr></thead>
      <tbody><tr><td>Reading sheet</td><td>13.84:1</td></tr></tbody>
    </table>
    <figure>
      <img alt="Sample diagram" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='60'%3E%3Crect width='120' height='60' fill='%2359358e'/%3E%3C/svg%3E">
      <figcaption>Figure 1: Caption typography must remain legible in dark mode.</figcaption>
    </figure>
  </article>
</body>
</html>`;
  const server = createServer((req, res) => {
    if (req.url === '/dark-theme-article') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    articleUrl: 'https://research.google/dark-theme-article',
    close: () => closeServer(server)
  };
}

async function startExtensionPagesFixture() {
  const pageHtml = (bg: string, fg: string, title: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;padding:40px;background:${bg};color:${fg};font:17px/1.6 Georgia,serif}</style>
</head>
<body><main><h1>${title}</h1><p>This article examines <strong id="term">luminance</strong> across dark and light pages.</p></main></body>
</html>`;
  const server = createServer((req, res) => {
    if (req.url === '/white') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml('#ffffff', '#181a20', 'White Host Page'));
      return;
    }
    if (req.url === '/dark') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml('#12141a', '#e8eaf2', 'Dark Host Page'));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    whiteUrl: `http://contrast-host.test:${addr.port}/white`,
    darkUrl: `http://contrast-host.test:${addr.port}/dark`,
    close: () => closeServer(server)
  };
}

async function runStaticCssAudit(): Promise<void> {
  const readerFiles = [
    'reader.css', 'paper-chat.css', 'pdf-view.css', 'article-view.css',
    'notebook.css', 'citations.css', 'selection-card.css', 'selection-workspace.css',
    'reading-desk.css', 'library.css', 'annotation-layer.css', 'annotations.css'
  ];
  for (const name of readerFiles) {
    const text = await readFile(path.join(project, 'public', name), 'utf8');
    assert.ok(!/0\.01ms/.test(text), `public/${name} must not contain banned 0.01ms reduced-motion kill`);
    assert.ok(!/font-size:\s*([0-9]|1[01](\.[0-9]+)?)px/.test(text), `public/${name} must not declare sub-12px functional UI font sizes`);
  }
  const deskCss = await readFile(path.join(project, 'public/reading-desk.css'), 'utf8');
  assert.ok(!deskCss.includes('.article-body'), 'reading-desk.css must remove dead .article-body selector');
  assert.match(deskCss, /:root\[data-theme="dark"\][\s\S]*color-scheme:\s*dark;/, 'reading-desk.css must set color-scheme: dark on :root[data-theme="dark"]');

  const annCss = await readFile(path.join(project, 'public/annotations.css'), 'utf8');
  assert.ok(!annCss.includes('var(--text'), 'annotations.css must not reference undefined var(--text)');

  const popupCss = await readFile(path.join(project, 'extension/popup.css'), 'utf8');
  assert.match(popupCss, /@media\s*\(prefers-color-scheme:\s*dark\)/, 'extension/popup.css must support prefers-color-scheme: dark');
  assert.match(popupCss, /color-scheme:\s*dark;/, 'extension/popup.css must declare color-scheme: dark');
  assert.ok(!/font-size:\s*([0-9]|1[01](\.[0-9]+)?)px/.test(popupCss), 'extension/popup.css must respect >= 12px floor');

  const cardCss = await readFile(path.join(project, 'src/extension/card-style.ts'), 'utf8');
  assert.match(cardCss, /@media\s*\(prefers-color-scheme:\s*dark\)/, 'card-style.ts must support prefers-color-scheme: dark');
  assert.match(cardCss, /color-scheme:\s*dark;/, 'card-style.ts must declare color-scheme: dark');
  assert.ok(!/font-size:\s*([0-9]|1[01](\.[0-9]+)?)px/.test(cardCss), 'card-style.ts must respect >= 12px floor');

  console.log('PASS Phase 1 (T1-F5-01, T2-F4-01): Static CSS audit verified 0 banned motion kills, 0 dead selectors, 0 undefined --text, >= 12px floor, and dark tokens across all 14 stylesheets.');
}

async function runBrowserPhases(host: HostFixture, publisherArticleUrl: string): Promise<void> {
  const browser = await chromium.launch({
    executablePath: host.executable,
    headless: process.env.PAPER_READER_HEADED !== '1'
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const darkScope: ErrorScope = { allowZotero503: true, allowExpected400: true, allowExpected409: true };
  const attachErrorListeners = (tag: string, page: Page) => attachErrorGuards(page, tag, darkScope, pageErrors, consoleErrors);
  const snap = async (page: Page, name: string) => {
    if (!evidence) return;
    await mkdir(host.artifacts, { recursive: true });
    await page.screenshot({ path: path.join(host.artifacts, name + '.png') });
  };

  try {
    // -------------------------------------------------------------------------
    // Phase 2: DSH Shell Iframe Live Host Theme Sync (T1-F4-01, T2-F4-02)
    // -------------------------------------------------------------------------
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light' });
      const page = await ctx.newPage();
      page.setDefaultTimeout(12_000);
      attachErrorListeners('phase2-iframe', page);
      const frame: FrameLocator = await openReader(page, host.authenticatedUrl);

      const readTheme = () => frame.locator(':root').evaluate(el => ({
        theme: (el as HTMLElement).dataset.theme,
        scheme: getComputedStyle(el).colorScheme
      }));
      assert.deepEqual(await readTheme(), { theme: 'light', scheme: 'light' });

      await page.evaluate(() => document.body.toggleAttribute('data-ds-dark-theme', true));
      await until(async () => (await readTheme()).theme === 'dark', 'Iframe did not switch to dark when host set data-ds-dark-theme');
      assert.equal((await readTheme()).scheme, 'dark');
      const topDark = await assertDarkSurface(frame.locator('.topbar'), 'iframe dark topbar', 0.08);
      assert.ok(topDark.fgLum > 0.70, `Expected dark primary ink lum > 0.70, got ${topDark.fgLum}`);
      await assertContrast(frame.locator('#docTitle'), 'iframe dark #docTitle', 4.5);

      // Jump to page 1 and open citation preview while toggling Dark -> Light -> Dark -> "false" -> "0" -> "" -> remove.
      await frame.locator('#pageCount').click();
      await frame.locator('#pageNumber').fill('1');
      await frame.locator('#pageNumber').press('Enter');
      await frame.locator('#loading').waitFor({ state: 'hidden' });
      await frame.locator('#original .pdf-citation-focus').first().focus();
      const preview = frame.locator('.citation-preview');
      await preview.waitFor({ state: 'visible' });
      await assertDarkSurface(preview, 'iframe dark .citation-preview', 0.12);
      await assertContrast(preview, 'iframe dark .citation-preview text', 4.5);

      // Open settingsDialog and toggle Light -> Dark -> "false" -> "0" -> "" -> remove live.
      await frame.locator('#more').click();
      await frame.getByRole('button', { name: 'Connections', exact: true }).click();
      const dialog = frame.getByRole('dialog');
      await dialog.waitFor({ state: 'visible' });
      await assertDarkSurface(dialog, 'iframe dark settingsDialog', 0.08);

      await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'));
      await until(async () => (await readTheme()).theme === 'light', 'Live toggle Dark -> Light failed');
      assert.equal((await readTheme()).scheme, 'light');
      await assertContrast(dialog.locator('h2'), 'iframe light settingsDialog h2', 4.5);

      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
      await until(async () => (await readTheme()).theme === 'dark', 'Live toggle Light -> Dark failed');
      assert.equal((await readTheme()).scheme, 'dark');
      await assertContrast(dialog.locator('h2'), 'iframe dark settingsDialog h2', 4.5);

      // Explicit "false", "0", and case/whitespace variants must normalize cleanly.
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', 'false'));
      await until(async () => (await readTheme()).theme === 'light', 'Explicit data-ds-dark-theme="false" must resolve to light');
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', '0'));
      assert.equal((await readTheme()).theme, 'light', 'Explicit data-ds-dark-theme="0" must resolve to light');
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', 'true'));
      await until(async () => (await readTheme()).theme === 'dark', 'Explicit data-ds-dark-theme="true" must resolve to dark');
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ' FALSE '));
      await until(async () => (await readTheme()).theme === 'light', 'data-ds-dark-theme=" FALSE " must resolve to light');
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ' TRUE '));
      await until(async () => (await readTheme()).theme === 'dark', 'data-ds-dark-theme=" TRUE " must resolve to dark');
      await frame.locator('#closeDialog').click();
      await dialog.waitFor({ state: 'hidden' });

      // Place a margin pin on page 6 and verify live toggle with .annotation-popover open.
      await frame.locator('#pageCount').click();
      await frame.locator('#pageNumber').fill('6');
      await frame.locator('#pageNumber').press('Enter');
      await frame.locator('#loading').waitFor({ state: 'hidden' });
      await frame.locator('#placePin').click();
      const figure = frame.locator('#original .pdf-figure[data-block-id="figure-6"]');
      await figure.scrollIntoViewIfNeeded();
      const figBox = (await figure.boundingBox())!;
      await page.mouse.click(figBox.x + figBox.width * 0.2, figBox.y + figBox.height * 0.35);
      const popover = frame.locator('.annotation-popover');
      await popover.waitFor({ state: 'visible' });
      await assertDarkSurface(popover, 'iframe dark .annotation-popover', 0.12);
      await assertContrast(popover.locator('h2'), 'iframe dark .annotation-popover h2', 4.5);
      await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'));
      await until(async () => (await readTheme()).theme === 'light', 'Live toggle with popover open failed');
      await assertContrast(popover.locator('h2'), 'iframe light .annotation-popover h2', 4.5);
      await ctx.close();
      console.log('PASS Phase 2 (T1-F4-01, T2-F4-02): Host body[data-ds-dark-theme] live sync verified across iframe, dialogs, citation preview, and annotation popover.');
    }

    // -------------------------------------------------------------------------
    // Phase 3: Standalone Dark Mode, All Core Surfaces, Dialogs, Popovers, Conflict & A11y
    // (T1-F4-02, T1-F4-03, T1-F4-05, T1-F5-01, T1-F5-04, T1-F5-05, T2-F4-01, T2-F4-04, T2-F4-05, T2-F4-06, T2-F5-03)
    // -------------------------------------------------------------------------
    {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        colorScheme: 'dark',
        reducedMotion: 'reduce'
      });
      const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', { tag: 'phase3-dark', scope: darkScope, pageErrors, consoleErrors });
      const appUrl = host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6';

      // Standalone prefers-color-scheme: dark & reduced motion checks.
      const rootMeta = await page.evaluate(() => {
        const rules: string[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules)) rules.push(rule.cssText);
          } catch { /* ignore */ }
        }
        return {
          theme: document.documentElement.dataset.theme,
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          scrollBehavior: getComputedStyle(document.getElementById('paperScroll')!).scrollBehavior,
          hasBannedMotion: rules.some(text => text.includes('0.01ms'))
        };
      });
      assert.equal(rootMeta.theme, 'dark');
      assert.equal(rootMeta.colorScheme, 'dark');
      assert.equal(rootMeta.scrollBehavior, 'auto');
      assert.equal(rootMeta.hasBannedMotion, false, 'document.styleSheets must not contain 0.01ms motion kill');

      // Core dark chrome luminance & primary ink contrast.
      for (const [sel, label] of [['.topbar', '.topbar'], ['#paperScroll', '#paperScroll']] as const) {
        const m = await assertDarkSurface(page.locator(sel), label, 0.08);
        assert.ok(m.fgLum > 0.70, `${label}: primary ink lum ${m.fgLum} must exceed 0.70`);
        await assertContrast(page.locator(sel), label, 4.5);
      }
      await assertContrast(page.locator('#docTitle'), '#docTitle', 4.5);
      await assertContrast(page.locator('#docMeta'), '#docMeta', 4.5);

      // Focus ring contrast (>= 3.0:1) in dark mode with reducedMotion: reduce (T1-F5-04, T2-F5-03).
      await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      const outlineWidth = await focused.evaluate(el => parseFloat(getComputedStyle(el).outlineWidth) || 0);
      assert.ok(outlineWidth >= 2, 'Keyboard focus must display >= 2px outline under reduced motion');
      await assertContrast(focused, 'focus ring', 3.0, 'outlineColor');

      // Read text mode (.pdf-reading-text) must render dark with >= 4.5:1 contrast (fixes .lane > div #fff bug!).
      await page.locator('#readText').click();
      const readingText = page.locator('.pdf-reading-text');
      await readingText.waitFor({ state: 'visible' });
      await assertDarkSurface(readingText, '.pdf-reading-text', 0.08);
      await assertContrast(readingText.locator('p').first(), '.pdf-reading-text p', 4.5);
      await page.locator('#readText').click();
      await page.locator('#original .pdf-sheet').waitFor({ state: 'visible' });

      // Notes sidebar, CodeMirror, .md-markup, status dots, and Obsidian conflict diff (T1-F4-03, T1-F5-04, T2-F4-05, T2-F4-06).
      await page.locator('#mobileRail').click();
      const rail = page.locator('#rail');
      await rail.waitFor({ state: 'visible' });
      await assertDarkSurface(rail, '#rail', 0.08);
      await assertContrast(page.locator('#saveState'), '#saveState text', 4.5);
      await assertContrast(page.locator('#saveState'), '#saveState::before dot', 3.0, 'backgroundColor', '::before');
      await page.mouse.move(0, 0);
      await assertBorderContrastBothThemes(page, page.locator('#notebookPose'), '#notebookPose select');
      await assertBorderContrastBothThemes(page, page.locator('#highlightDisplay'), '#highlightDisplay select');

      const cmContent = rail.locator('.notebook-writing-area .cm-content');
      await cmContent.waitFor({ state: 'visible' });
      await assertDarkSurface(rail.locator('.notebook-writing-area .cm-editor'), 'CodeMirror .cm-editor', 0.08);
      await assertContrast(rail.locator('.notebook-writing-area .cm-editor'), 'CodeMirror .cm-editor text', 4.5);
      await cmContent.click();
      await page.keyboard.type('# Dark Note\nSome **bold** observation.');
      const mdMarkup = rail.locator('.notebook-writing-area .md-markup').first();
      await mdMarkup.waitFor({ state: 'visible' });
      await assertContrast(mdMarkup, '.md-markup', 4.5);
      await assertContrast(rail.locator('.notebook-status'), '.notebook-status::before dot', 3.0, 'backgroundColor', '::before');

      // Finding #2: .cm-cursorLayer must not blink under prefers-reduced-motion: reduce (after typing, on focus, and after live toggle).
      const readCursorAnim = () => rail.locator('.notebook-writing-area .cm-cursorLayer').evaluate(el => {
        const s = getComputedStyle(el);
        return { name: s.animationName, duration: s.animationDuration };
      });
      const cursorAfterType = await readCursorAnim();
      assert.equal(cursorAfterType.name, 'none', 'CodeMirror .cm-cursorLayer must not blink after typing under reduced motion');
      assert.equal(cursorAfterType.duration, '0s', 'CodeMirror .cm-cursorLayer duration must be 0s after typing under reduced motion');
      await page.locator('#saveState').click();
      await cmContent.click();
      const cursorOnFocus = await readCursorAnim();
      assert.equal(cursorOnFocus.name, 'none', 'CodeMirror .cm-cursorLayer must not blink on focus under reduced motion');
      assert.equal(cursorOnFocus.duration, '0s', 'CodeMirror .cm-cursorLayer duration must be 0s on focus under reduced motion');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await until(async () => (await readCursorAnim()).name !== 'none', 'Live reducedMotion -> no-preference should re-enable CM6 cursor blink');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await until(async () => {
        const a = await readCursorAnim();
        return a.name === 'none' && a.duration === '0s';
      }, 'Live no-preference -> reducedMotion should disable CM6 cursor blink immediately');

      // Finding #1: Focused and blurred .cm-selectionBackground in BOTH dark & light modes (beats CM6 (0,5,0) default).
      await page.keyboard.press('Control+a');
      const cmSel = rail.locator('.notebook-writing-area .cm-selectionBackground').first();
      await cmSel.waitFor({ state: 'visible' });
      const checkCmSelection = async (scheme: 'dark' | 'light', focused: boolean) => {
        const raw = await rail.locator('.notebook-writing-area').evaluate(root => {
          const sel = root.querySelector<HTMLElement>('.cm-selectionBackground')!;
          const line = root.querySelector<HTMLElement>('.cm-line')!;
          const layers: string[] = [];
          for (let cur = sel.parentElement; cur && cur.nodeType === 1; cur = cur.parentElement) {
            layers.push(getComputedStyle(cur).backgroundColor);
          }
          const darkRoot = document.documentElement.dataset.theme === 'dark' || getComputedStyle(document.documentElement).colorScheme.includes('dark');
          return { selBg: getComputedStyle(sel).backgroundColor, lineFg: getComputedStyle(line).color, layers, darkRoot };
        });
        let base: [number, number, number, number] = raw.darkRoot ? [19, 22, 31, 1] : [255, 255, 255, 1];
        for (let i = raw.layers.length - 1; i >= 0; i--) {
          const layer = parseCssColor(raw.layers[i]);
          if (layer[3] > 0) base = composite(layer, base);
        }
        const bgRaw = parseCssColor(raw.selBg);
        const bg = bgRaw[3] < 1 ? composite(bgRaw, base) : bgRaw;
        const fgRaw = parseCssColor(raw.lineFg);
        const fg = fgRaw[3] < 1 ? composite(fgRaw, bg) : fgRaw;
        const bgLum = relLum(bg), ratio = contrastRatio(relLum(fg), bgLum);
        assert.notEqual(raw.selBg, 'rgb(215, 212, 240)', `CM6 default selection leaked in ${scheme} (${focused ? 'focused' : 'blurred'})`);
        if (scheme === 'dark') {
          assert.ok(bgLum < 0.10, `Dark CM6 ${focused ? 'focused' : 'blurred'} selection must stay dark, got bgLum=${bgLum.toFixed(4)} (${raw.selBg})`);
        }
        assert.ok(ratio >= 4.5, `CM6 ${scheme} ${focused ? 'focused' : 'blurred'} selection contrast must be >= 4.5:1, got ${ratio.toFixed(2)}:1 (${raw.selBg})`);
      };
      await checkCmSelection('dark', true);
      await page.locator('#saveState').click();
      await checkCmSelection('dark', false);
      await page.emulateMedia({ colorScheme: 'light' });
      await checkCmSelection('light', false);
      await cmContent.click();
      await page.keyboard.press('Control+a');
      await checkCmSelection('light', true);
      await page.emulateMedia({ colorScheme: 'dark' });

      // Trigger notebook conflict diff (.notebook-issue + .notebook-latest) and check dark contrast.
      const currentBook = await action(page, host.origin, 'notebook.get', { docId: 'pagedattention', title: 'PagedAttention.pdf', sourceUrl: appUrl });
      await action(page, host.origin, 'notebook.write', {
        docId: 'pagedattention', title: 'PagedAttention.pdf', sourceUrl: appUrl,
        markdown: '# External Update\nWritten from another window.', expectedRevision: currentBook.revision
      });
      await rail.locator('.notebook-save').click();
      const nbIssue = rail.locator('.notebook-issue');
      await nbIssue.waitFor({ state: 'visible' });
      await assertDarkSurface(nbIssue, '.notebook-issue', 0.12);
      await assertContrast(nbIssue, '.notebook-issue text', 4.5);
      await nbIssue.getByRole('button', { name: 'Compare latest' }).click();
      const nbLatest = rail.locator('.notebook-latest').first();
      await nbLatest.waitFor({ state: 'visible' });
      await assertDarkSurface(nbLatest, '.notebook-latest', 0.12);
      await assertContrast(nbLatest, '.notebook-latest text', 4.5);
      await nbIssue.getByRole('button', { name: 'Use saved file' }).click();

      // Reading guide (.notebook-guide .quote & .source-chip) contrast check (unconditional).
      const guideSummary = rail.locator('.notebook-guide > summary');
      await guideSummary.waitFor({ state: 'visible' });
      await guideSummary.click();
      await assertContrast(rail.locator('.notebook-guide .quote').first(), '.notebook-guide .quote', 4.5);
      await assertContrast(rail.locator('.notebook-guide .source-chip').first(), '.notebook-guide .source-chip', 4.5);
      await guideSummary.click();

      // Selection card dark check + highlight -> Marks tab (annotations.css cascade) + stale-revision .annotation-error.
      const run = page.locator('#original .pdf-native-text [data-block-id="block-tables"]').filter({ hasText: /mapping between logical/i }).first();
      await run.evaluate(e => {
        const text = e.firstChild as Text;
        const candidates = [...document.querySelectorAll('#original .pdf-native-text [data-block-id="block-tables"]')];
        const last = candidates.slice(candidates.indexOf(e)).find(node => node.textContent?.includes('each request'))?.firstChild as Text;
        document.getSelection()!.setBaseAndExtent(text, text.data.indexOf('the mapping'), last, last.data.indexOf('each request') + 'each request'.length);
        e.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      });
      const card = page.locator('#card');
      await card.waitFor({ state: 'visible' });
      await assertDarkSurface(card, '#card', 0.08);
      await assertContrast(card.locator('.word-head h2'), '#card h2', 4.5);
      const directMeaning = card.locator('.passage-counterpart .meaning');
      await directMeaning.waitFor({ state: 'visible' });
      await assertContrast(directMeaning, '#card .passage-counterpart .meaning', 4.5);
      const explainBtn = card.locator('.selection-explain-action');
      await explainBtn.waitFor({ state: 'visible' });
      await assertContrast(explainBtn, '#card .selection-explain-action', 4.5);
      await page.getByRole('button', { name: 'Highlight', exact: true }).click();
      await page.locator('#annotationsTab').click();
      const annWorkspace = rail.locator('.annotation-workspace');
      await annWorkspace.waitFor({ state: 'visible' });
      await assertDarkSurface(annWorkspace, '.annotation-workspace', 0.08);
      await assertContrast(annWorkspace.locator('h2'), '.annotation-workspace h2', 4.5);
      const annEntry = rail.locator('.annotation-entry').first();
      await annEntry.waitFor({ state: 'visible' });
      await assertContrast(annEntry.locator('strong'), '.annotation-entry strong', 4.5);
      await annEntry.click();
      const commentBox = rail.getByRole('textbox', { name: 'Comment', exact: true });
      await commentBox.fill('Local dark-mode draft.');
      const latestMark = (await action(page, host.origin, 'annotation.list', { docId: 'pagedattention' })).annotations[0];
      await action(page, host.origin, 'annotation.save', { ...latestMark, text: 'Concurrent edit.', expectedUpdatedAt: latestMark.updatedAt });
      await rail.getByRole('button', { name: 'Save', exact: true }).click();
      const annError = rail.locator('.annotation-error');
      await annError.waitFor({ state: 'visible' });
      await assertContrast(annError, '.annotation-error', 4.5);
      await rail.getByRole('button', { name: 'Keep my draft' }).click();
      await rail.getByRole('button', { name: 'Save', exact: true }).click();

      // Reference tab (including M3 .citation-export controls & .trail) in dark mode.
      await page.locator('#refsTab').click();
      const citeExport = rail.locator('.citation-export');
      await citeExport.waitFor({ state: 'visible' });
      await assertContrast(rail.locator('.trail'), '#refsTab .trail', 4.5);
      await assertDarkSurface(citeExport, '.citation-export', 0.08);
      await assertContrast(citeExport.locator('h3'), '.citation-export h3', 4.5);
      await assertContrast(citeExport.locator('.btn').first(), '.citation-export .btn', 4.5);

      // Paper chat transcript, textarea & resize grip contrast (Finding #4: >= 3.0:1 in dark & light) (T1-F4-03, T2-F4-06).
      await page.locator('.paper-chat-toggle').click();
      const chatTranscript = page.locator('.paper-chat-transcript');
      await chatTranscript.waitFor({ state: 'visible' });
      await assertDarkSurface(chatTranscript, '.paper-chat-transcript', 0.08);
      const chatInput = page.locator('.paper-chat-input textarea');
      await assertDarkSurface(chatInput, '.paper-chat-input textarea', 0.08);
      assert.equal((await measureLocator(chatInput)).colorScheme, 'dark');
      await assertContrast(chatInput, '.paper-chat-input textarea text', 4.5);
      await assertBorderContrastBothThemes(page, chatInput, '.paper-chat-input textarea');
      const grip = page.locator('.paper-chat-grip');
      await grip.waitFor({ state: 'visible' });
      await assertContrast(grip, '.paper-chat-grip::after (dark)', 3.0, 'backgroundColor', '::after');
      await page.emulateMedia({ colorScheme: 'light' });
      await assertContrast(grip, '.paper-chat-grip::after (light)', 3.0, 'backgroundColor', '::after');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.locator('.paper-chat-toggle').click();

      // All 3 late-loaded dialogs: libraryDialog, settingsDialog, collectionsDialog (T1-F4-05, T2-F4-01).
      await page.locator('#library').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible' });
      await assertDarkSurface(dialog, 'libraryDialog', 0.08);
      await dialog.getByRole('tab', { name: 'Zotero', exact: true }).click();
      await dialog.locator('.reader-library select').first().waitFor({ state: 'visible' });
      await assertBorderContrastBothThemes(page, dialog.locator('.reader-library .search').first(), 'libraryDialog .search');
      await assertBorderContrastBothThemes(page, dialog.locator('.reader-library select').first(), 'libraryDialog select');
      await dialog.getByRole('tab', { name: 'On this device', exact: true }).click();
      await assertContrast(dialog.locator('.library-row-text strong').first(), 'libraryDialog row strong', 4.5);
      const openWebBtn = dialog.getByRole('button', { name: 'Open web page', exact: true });
      await openWebBtn.click();
      const urlInput = dialog.locator('#library-url');
      await assertDarkSurface(urlInput, '#library-url input', 0.08);
      assert.equal((await measureLocator(urlInput)).colorScheme, 'dark');
      await assertBorderContrastBothThemes(page, urlInput, 'libraryDialog #library-url');
      await urlInput.fill('ftp://invalid.example');
      await dialog.getByRole('button', { name: 'Read article', exact: true }).click();
      const libStatus = dialog.locator('.library-url .library-status');
      await libStatus.waitFor({ state: 'visible' });
      await assertContrast(libStatus, 'libraryDialog invalid URL status', 4.5);
      await page.locator('#closeDialog').click();
      await dialog.waitFor({ state: 'hidden' });

      await page.locator('#more').click();
      await page.getByRole('button', { name: 'Connections', exact: true }).click();
      await dialog.waitFor({ state: 'visible' });
      await assertDarkSurface(dialog, 'settingsDialog', 0.08);
      const langSelect = dialog.locator('.field select').first();
      await assertDarkSurface(langSelect, 'settingsDialog select', 0.08);
      assert.equal((await measureLocator(langSelect)).colorScheme, 'dark');
      await assertContrast(langSelect, 'settingsDialog select text', 4.5);
      await assertBorderContrastBothThemes(page, langSelect, 'settingsDialog .field select');
      await assertBorderContrastBothThemes(page, dialog.locator('.field input').first(), 'settingsDialog .field input');
      await page.locator('#closeDialog').click();
      await dialog.waitFor({ state: 'hidden' });

      await page.locator('#more').click();
      await page.getByRole('button', { name: 'Vocabulary and history', exact: true }).click();
      await dialog.waitFor({ state: 'visible' });
      await assertDarkSurface(dialog, 'collectionsDialog', 0.08);
      await assertContrast(dialog.locator('h2'), 'collectionsDialog h2', 4.5);
      await assertBorderContrastBothThemes(page, dialog.locator('.search').first(), 'collectionsDialog .search');
      await page.locator('#closeDialog').click();
      await dialog.waitFor({ state: 'hidden' });

      // Region capture on PDF: .pdf-sheet stays white paper while .pdf-capture-actions stays dark (T2-F4-04).
      await page.locator('#closeRail').click();
      const pdfSheet = page.locator('#original .pdf-sheet');
      const sheetStyle = await pdfSheet.evaluate(el => ({
        bg: getComputedStyle(el).backgroundColor,
        scheme: getComputedStyle(el).colorScheme
      }));
      assert.equal(sheetStyle.bg, 'rgb(255, 255, 255)', '.pdf-sheet must stay white paper in dark mode');
      assert.equal(sheetStyle.scheme, 'light', '.pdf-sheet must keep color-scheme: light');

      await page.locator('#captureRegion').click();
      const captureSurface = page.locator('#original .pdf-capture-surface');
      await captureSurface.waitFor({ state: 'visible' });
      const capBox = (await captureSurface.boundingBox())!;
      await page.mouse.move(capBox.x + 80, capBox.y + 80);
      await page.mouse.down();
      await page.mouse.move(capBox.x + 220, capBox.y + 170, { steps: 6 });
      await page.mouse.up();
      const capActions = page.locator('.pdf-capture-actions');
      await capActions.waitFor({ state: 'visible' });
      await assertDarkSurface(capActions, '.pdf-capture-actions', 0.08);
      await assertContrast(capActions.locator('.btn').first(), '.pdf-capture-actions .btn', 4.5);
      await page.keyboard.press('Escape');

      // Citation hover preview & annotation popover containment + contrast in BOTH dark and light (T1-F5-05).
      await page.locator('#pageCount').click();
      await assertBorderContrastBothThemes(page, page.locator('#pageJump input'), '#pageJump input');
      await page.locator('#pageNumber').fill('1');
      await page.locator('#pageNumber').press('Enter');
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await page.locator('#original .pdf-citation-focus').first().focus();
      const citePreview = page.locator('.citation-preview');
      await citePreview.waitFor({ state: 'visible' });
      for (const scheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const box = (await citePreview.boundingBox())!;
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900,
          `.citation-preview must remain in viewport bounds in ${scheme} mode`);
        await assertContrast(citePreview, `.citation-preview (${scheme})`, 4.5);
      }
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.keyboard.press('Escape');

      await page.locator('#pageCount').click();
      await page.locator('#pageNumber').fill('6');
      await page.locator('#pageNumber').press('Enter');
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await page.locator('#placePin').click();
      const fig6 = page.locator('#original .pdf-figure[data-block-id="figure-6"]');
      await fig6.scrollIntoViewIfNeeded();
      const fig6Box = (await fig6.boundingBox())!;
      await page.mouse.click(fig6Box.x + fig6Box.width * 0.2, fig6Box.y + fig6Box.height * 0.35);
      const annPop = page.locator('.annotation-popover');
      await annPop.waitFor({ state: 'visible' });
      for (const scheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const box = (await annPop.boundingBox())!;
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900,
          `.annotation-popover must remain in viewport bounds in ${scheme} mode`);
        await assertContrast(annPop.locator('h2'), `.annotation-popover h2 (${scheme})`, 4.5);
      }
      await page.emulateMedia({ colorScheme: 'dark' });

      // Overlapping margin pins -> .annotation-chooser dark surface & >= 4.5:1 contrast.
      await annPop.getByRole('textbox', { name: 'Comment', exact: true }).fill('First pin');
      await annPop.getByRole('button', { name: 'Save', exact: true }).click();
      if (await annPop.isVisible()) await page.keyboard.press('Escape');
      await annPop.waitFor({ state: 'hidden' });
      await page.locator('#placePin').click();
      await page.mouse.click(fig6Box.x + fig6Box.width * 0.2 + 4, fig6Box.y + fig6Box.height * 0.35);
      await annPop.waitFor({ state: 'visible' });
      await annPop.getByRole('textbox', { name: 'Comment', exact: true }).fill('Second pin');
      await annPop.getByRole('button', { name: 'Save', exact: true }).click();
      if (await annPop.isVisible()) await page.keyboard.press('Escape');
      await annPop.waitFor({ state: 'hidden' });
      await page.locator('#original .annotation-pin[data-count="2"]').click();
      const chooser = page.locator('.annotation-chooser');
      await chooser.waitFor({ state: 'visible' });
      await assertDarkSurface(chooser, '.annotation-chooser', 0.08);
      await assertContrast(chooser.locator('strong'), '.annotation-chooser strong', 4.5);
      await assertContrast(chooser.locator('button').first(), '.annotation-chooser button', 4.5);
      await page.keyboard.press('Escape');
      await chooser.waitFor({ state: 'hidden' });

      await snap(page, 'phase3-dark-mode');
      await ctx.close();
      console.log('PASS Phase 3 (T1-F4-02/03/05, T1-F5-01/04/05, T2-F4-01/04/05/06, T2-F5-03): All core dark surfaces, dialogs, popovers, conflicts, Read text, and browser surfaces verified.');
    }

    // -------------------------------------------------------------------------
    // Phase 4: .web-reading-sheet Rich Blocks vs .pdf-sheet White Paper (T1-F4-04, T2-F4-03)
    // -------------------------------------------------------------------------
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
      const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', { tag: 'phase4-web-sheet', scope: darkScope, pageErrors, consoleErrors });

      await page.locator('#library').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByRole('button', { name: 'Open web page', exact: true }).click();
      await dialog.locator('#library-url').fill(publisherArticleUrl);
      await dialog.getByRole('button', { name: 'Read article', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const sheet = page.locator('.web-reading-sheet[data-side="source"]');
      await sheet.waitFor({ state: 'visible' });

      // Navigate with anchor to activate .is-highlighted / .is-located styling.
      const articleUrl = new URL(page.url());
      articleUrl.searchParams.set('anchor', 'p-2');
      await page.goto(articleUrl.toString());
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await sheet.waitFor({ state: 'visible' });

      await assertDarkSurface(sheet, '.web-reading-sheet', 0.12);
      for (const [sel, name] of [
        ['h1', 'web h1'],
        ['p', 'web p'],
        ['a', 'web link'],
        ['code', 'web inline code'],
        ['blockquote', 'web blockquote'],
        ['pre', 'web pre'],
        ['td', 'web td'],
        ['figcaption', 'web figcaption'],
        ['.is-located, .is-highlighted', 'web highlighted row']
      ] as const) {
        const el = sheet.locator(sel).first();
        await el.waitFor({ state: 'visible' });
        await assertContrast(el, name, 4.5);
      }
      await snap(page, 'phase4-web-reading-sheet-dark');
      await ctx.close();
      console.log('PASS Phase 4 (T1-F4-04, T2-F4-03): .web-reading-sheet rich blocks & highlight contrast passed >= 4.5:1 in dark mode.');
    }

    // -------------------------------------------------------------------------
    // Phase 5: Breakpoints, 1440px Bilingual Floor, 200% Zoom & 390px Mobile Dark Mode
    // (T1-F5-02, T1-F5-03, T2-F5-01, T2-F5-02, T2-F5-04, T2-F5-05)
    // -------------------------------------------------------------------------
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
      const page = await openReaderPage(ctx, host, '?doc=pagedattention&page=6', { tag: 'phase5-layout', scope: darkScope, pageErrors, consoleErrors });

      // Enable bilingual mode and verify bilingual #card (.selection-excerpt, .selection-counterpart, .chat-starter).
      await page.getByRole('button', { name: 'Bilingual', exact: true }).click();
      await page.locator('#translated .pdf-translated-text').first().waitFor({ state: 'visible' });
      await assertBorderContrastBothThemes(page, page.locator('#translationMode'), '#translationMode select');
      const translatedBlock = page.locator('#translated .pdf-translated-text[data-block-id="block-tables"]');
      await translatedBlock.waitFor({ state: 'visible' });
      await translatedBlock.evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode() as Text | null;
        if (!text || text.data.length < 4) throw new Error('Missing translated text node');
        document.getSelection()!.setBaseAndExtent(text, 0, text, Math.min(20, text.data.length));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      });
      const bilingualCard = page.locator('#card');
      await bilingualCard.waitFor({ state: 'visible' });
      await assertDarkSurface(bilingualCard, 'bilingual #card', 0.08);
      await assertContrast(bilingualCard.locator('.selection-excerpt blockquote'), '#card .selection-excerpt blockquote', 4.5);
      await bilingualCard.locator('.selection-counterpart > summary').click();
      await assertContrast(bilingualCard.locator('.selection-counterpart .meaning'), '#card .selection-counterpart .meaning', 4.5);
      await bilingualCard.locator('.selection-chat-action').click();
      const chatStarter = bilingualCard.locator('.chat-starter').first();
      await chatStarter.waitFor({ state: 'visible' });
      await assertDarkSurface(chatStarter, '#card .chat-starter', 0.08);
      await assertContrast(chatStarter, '#card .chat-starter', 4.5);
      const composer = bilingualCard.locator('.chat-composer textarea');
      await assertBorderContrastBothThemes(page, composer, '#card .chat-composer textarea');
      // Naturally trigger multi-draft switcher (#card select.chat-drafts) and verify Dark & Light border (>= 3.0:1) and text (>= 4.5:1) contrast.
      await composer.fill('Summarize the KV block mapping.');
      await composer.press('Enter');
      const firstAnswer = bilingualCard.locator('.selection-answer').first();
      await firstAnswer.waitFor({ state: 'visible' });
      await composer.fill('Unsent draft on memory fragmentation.');
      await firstAnswer.evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode() as Text | null;
        if (!text || text.data.trim().length < 4) throw new Error('Missing answer text node for follow-up quote');
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, Math.min(11, text.data.length));
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await bilingualCard.getByRole('group', { name: 'Selected answer text' }).getByRole('button', { name: 'Ask follow-up', exact: true }).click();
      const chatDrafts = bilingualCard.locator('select.chat-drafts');
      await chatDrafts.waitFor({ state: 'visible' });
      await assertDarkSurface(chatDrafts, '#card select.chat-drafts', 0.08);
      assert.equal((await measureLocator(chatDrafts)).colorScheme, 'dark');
      await assertContrast(chatDrafts, '#card select.chat-drafts text (dark)', 4.5);
      await assertBorderContrastBothThemes(page, chatDrafts, '#card select.chat-drafts');
      await page.emulateMedia({ colorScheme: 'light' });
      try {
        await assertContrast(chatDrafts, '#card select.chat-drafts text (light)', 4.5);
      } finally {
        await page.emulateMedia({ colorScheme: 'dark' });
      }
      await page.keyboard.press('Escape');
      if (await bilingualCard.isVisible()) await page.keyboard.press('Escape');
      await bilingualCard.waitFor({ state: 'hidden' });

      await page.locator('#mobileRail').click();
      await page.locator('#rail').waitFor({ state: 'visible' });

      // Breakpoint sweep for #saveState >= 12px (T1-F5-02, T2-F5-01).
      for (const width of [1381, 1380, 1280, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        const size = await page.locator('#saveState').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
        assert.ok(size >= 12, `#saveState fontSize at ${width}px must be >= 12px, got ${size}px`);
      }

      // 1440x900 bilingual + open sidebar + page scope (T1-F5-03).
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByLabel('Translation scope').selectOption('page');
      const inspectTranslated = () => page.evaluate(() => {
        const blocks = Array.from(document.querySelectorAll<HTMLElement>('#translated .pdf-translated-text')).filter(el => !el.hidden && el.offsetWidth > 0);
        const bodySizes = blocks.filter(el => el.dataset.role === 'paragraph').map(el => {
          const rect = el.getBoundingClientRect();
          const cssFont = parseFloat(getComputedStyle(el).fontSize) || 0;
          const visualFont = cssFont * (rect.width / el.offsetWidth);
          return {
            id: el.dataset.blockId,
            cssFont,
            visualFont,
            needsScroll: el.classList.contains('needs-scroll'),
            overflowY: getComputedStyle(el).overflowY,
            scrollOverflows: el.scrollHeight > el.clientHeight + 2
          };
        });
        const rects = blocks.map(el => ({ id: el.dataset.blockId, r: el.getBoundingClientRect() }));
        let overlaps = 0;
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i].r, b = rects[j].r;
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ox > 2 && oy > 2) overlaps++;
          }
        }
        return {
          bodySizes,
          overlaps,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          railWidth: document.getElementById('rail')!.getBoundingClientRect().width
        };
      });

      await until(async () => {
        const m = await inspectTranslated();
        return m.bodySizes.length > 0 && m.bodySizes.every(b => b.visualFont >= 11.5);
      }, '1440px bilingual + open sidebar translated body blocks must reach >= 11.5px visual font floor');
      const openMetrics = await inspectTranslated();
      assert.equal(openMetrics.overlaps, 0, 'Translated blocks must not overlap at 1440px bilingual + open sidebar');
      assert.ok(openMetrics.pageOverflow <= 1, `Zero horizontal overflow expected at 1440px, got ${openMetrics.pageOverflow}px`);

      // Finding #3: Page 1 at 1440x900 Bilingual Full page must stay >= 11.5px and monotonic when closing #rail.
      await page.locator('#pageCount').click();
      await page.locator('#pageNumber').fill('1');
      await page.locator('#pageNumber').press('Enter');
      await page.locator('#loading').waitFor({ state: 'hidden' });
      const p1BodyIds = ['p1-r3', 'p1-r5', 'p1-r7', 'p1-r26', 'p1-r26-2'] as const;
      await until(async () => {
        const m = await inspectTranslated();
        const byId = new Map(m.bodySizes.map(b => [b.id, b.visualFont]));
        return p1BodyIds.every(id => (byId.get(id) ?? 0) >= 11.5);
      }, 'Page 1 1440x900 bilingual + open rail body paragraphs must reach >= 11.5px visual font');
      const p1Open = await inspectTranslated();
      assert.equal(p1Open.overlaps, 0, 'Page 1 bilingual + open rail must have 0 overlaps');
      assert.ok(p1Open.pageOverflow <= 1, `Page 1 bilingual + open rail overflow must be <= 1px, got ${p1Open.pageOverflow}px`);
      const openById = new Map(p1Open.bodySizes.map(b => [b.id, b.visualFont]));

      await page.locator('#closeRail').click();
      await until(async () => page.locator('#translated .pdf-sheet').evaluate(el => el.getBoundingClientRect().width > 640),
        'Closing #rail at 1440x900 should widen translated sheet past 640px');
      await until(async () => {
        const m = await inspectTranslated();
        const byId = new Map(m.bodySizes.map(b => [b.id, b.visualFont]));
        return p1BodyIds.every(id => (byId.get(id) ?? 0) >= 11.5);
      }, 'Page 1 1440x900 bilingual + closed rail body paragraphs must stay >= 11.5px visual font');
      const p1Closed = await inspectTranslated();
      assert.equal(p1Closed.overlaps, 0, 'Page 1 bilingual + closed rail must have 0 overlaps');
      assert.ok(p1Closed.pageOverflow <= 1, `Page 1 bilingual + closed rail overflow must be <= 1px, got ${p1Closed.pageOverflow}px`);
      const closedById = new Map(p1Closed.bodySizes.map(b => [b.id, b.visualFont]));
      for (const id of p1BodyIds) {
        const before = openById.get(id)!;
        const after = closedById.get(id)!;
        assert.ok(after >= 11.5, `Page 1 ${id} with #rail closed must be >= 11.5px, got ${after.toFixed(2)}px`);
        assert.ok(after >= before - 0.1, `Closing #rail must not shrink Page 1 ${id} (${before.toFixed(2)}px -> ${after.toFixed(2)}px)`);
      }

      // Return to Page 6 with #rail open for widened-sidebar, 200% zoom, and mobile checks.
      await page.locator('#mobileRail').click();
      await page.locator('#rail').waitFor({ state: 'visible' });
      await page.locator('#pageCount').click();
      await page.locator('#pageNumber').fill('6');
      await page.locator('#pageNumber').press('Enter');
      await page.locator('#loading').waitFor({ state: 'hidden' });

      // Widen sidebar via #notesSplit keyboard (T2-F5-02).
      const notesSplit = page.locator('#notesSplit');
      await notesSplit.focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
      await until(async () => (await inspectTranslated()).railWidth >= 420, 'Sidebar did not widen to >= 420px');
      await until(async () => {
        const m = await inspectTranslated();
        return m.bodySizes.length > 0 && m.bodySizes.every(b => b.visualFont >= 11.5);
      }, 'Widened sidebar bilingual translated body blocks must keep >= 11.5px visual font floor');
      const widenedMetrics = await inspectTranslated();
      assert.equal(widenedMetrics.overlaps, 0, 'Translated blocks must not overlap with widened sidebar');
      assert.ok(widenedMetrics.pageOverflow <= 1, `Zero horizontal overflow expected with widened sidebar, got ${widenedMetrics.pageOverflow}px`);
      const scrolledBlocks = widenedMetrics.bodySizes.filter(b => b.scrollOverflows);
      assert.ok(scrolledBlocks.every(b => b.needsScroll && b.overflowY === 'auto'),
        'Overflowing translated blocks must enable .needs-scroll with overflow-y: auto');
      await snap(page, 'phase5-1440-bilingual-widened');

      // 200% zoom in bilingual mode at 1440x900 (T2-F5-05).
      await page.locator('#zoom').selectOption('2');
      await until(async () => page.evaluate(() => {
        const s = document.getElementById('paperScroll')!;
        return s.scrollWidth > s.clientWidth + 10;
      }), '200% zoom should make #paperScroll scrollable');
      const zoomCheck = await page.evaluate(() => {
        const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
        const rail = document.getElementById('rail')!.getBoundingClientRect();
        return {
          docOverflow: document.documentElement.scrollWidth - window.innerWidth,
          topbarOk: topbar.right <= window.innerWidth + 1 && topbar.top >= 0,
          railOk: rail.right <= window.innerWidth + 1 && rail.width >= 200
        };
      });
      assert.ok(zoomCheck.docOverflow <= 1, `200% zoom must not overflow document width (got ${zoomCheck.docOverflow})`);
      assert.ok(zoomCheck.topbarOk && zoomCheck.railOk, '200% zoom must not clip topbar or sidebar');

      // Reset zoom & check 390x844 mobile dark mode (T2-F5-04).
      await page.locator('#zoom').selectOption('1');
      await page.locator('#closeRail').click();
      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await page.evaluate(() => ({
        titleWidth: document.getElementById('docTitle')!.getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth - window.innerWidth
      }));
      assert.ok(mobile.titleWidth >= 64, `Mobile #docTitle width must be >= 64px, got ${mobile.titleWidth}px`);
      assert.ok(mobile.overflow <= 1, `Mobile dark mode must have zero horizontal overflow, got ${mobile.overflow}px`);
      await assertDarkSurface(page.locator('.topbar'), 'mobile dark .topbar', 0.08);
      await assertContrast(page.locator('#docTitle'), 'mobile dark #docTitle', 4.5);
      await page.locator('#more').click();
      await page.getByRole('button', { name: 'Connections', exact: true }).click();
      const mobileDialog = page.getByRole('dialog');
      await mobileDialog.waitFor({ state: 'visible' });
      const closeDialogBox = (await page.locator('#closeDialog').boundingBox())!;
      assert.ok(closeDialogBox.width >= 44 && closeDialogBox.height >= 44,
        `Mobile #closeDialog must meet 44x44px touch target, got ${closeDialogBox.width}x${closeDialogBox.height}`);
      await page.locator('#closeDialog').click();
      await mobileDialog.waitFor({ state: 'hidden' });
      await snap(page, 'phase5-mobile-390-dark');
      await ctx.close();
      console.log('PASS Phase 5 (T1-F5-02/03, T2-F5-01/02/04/05): #saveState >= 12px sweep, 1440px bilingual floor (open & widened), 200% zoom, and 390x844 mobile dark verified.');
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(pageErrors, [], 'Uncaught page errors detected: ' + pageErrors.join('; '));
  assert.deepEqual(consoleErrors, [], 'Unexpected console errors detected: ' + consoleErrors.join('; '));
}

async function runExtensionPhase(host: HostFixture): Promise<void> {
  const extPages = await startExtensionPagesFixture();
  const context = await chromium.launchPersistentContext(path.join(host.scratch, 'ext-dark-profile'), {
    executablePath: host.executable,
    headless: process.env.PAPER_READER_HEADED !== '1',
    viewport: { width: 1280, height: 820 },
    colorScheme: 'dark',
    locale: 'en-US',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--force-dark-mode', '--enable-unsafe-extension-debugging', '--no-proxy-server', '--host-resolver-rules=MAP contrast-host.test 127.0.0.1']
  });
  const pageErrors: string[] = [];
  try {
    const bcdp = await context.browser()!.newBrowserCDPSession();
    const { id } = await bcdp.send('Extensions.loadUnpacked', { path: path.join(project, 'dist/extension') });
    await bcdp.detach();

    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    page.on('pageerror', err => pageErrors.push(err.message));
    await page.goto(extPages.whiteUrl);

    // Inspect extension popup in dark mode (T1-F4-06).
    const menu = await openToolbar(page, id);
    await menu.click('summary');
    const rawPopup = await menu.evaluate(() => {
      const darkRoot = document.documentElement.dataset.theme === 'dark' || getComputedStyle(document.documentElement).colorScheme.includes('dark');
      const selectors = [
        ['body', 'body'], ['h1', 'h1'], ['message', '#message'], ['primary', '.primary'],
        ['secondary', '.secondary'], ['summary', 'summary'], ['origin', '#origin'], ['plain', '.plain']
      ] as const;
      const items: Record<string, RawElementSample> = {};
      for (const [k, sel] of selectors) {
        const el = document.querySelector<HTMLElement>(sel)!;
        const layers: string[] = [];
        for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) layers.push(getComputedStyle(cur).backgroundColor);
        const s = getComputedStyle(el);
        items[k] = { fg: s.color, layers, darkRoot, fontSize: parseFloat(s.fontSize) || 0, colorScheme: s.colorScheme };
      }
      const inp = document.querySelector<HTMLElement>('.address input')!;
      const inpLayers: string[] = [];
      for (let cur: Element | null = inp; cur && cur.nodeType === 1; cur = cur.parentElement) inpLayers.push(getComputedStyle(cur).backgroundColor);
      const inpStyle = getComputedStyle(inp);
      return {
        scheme: getComputedStyle(document.documentElement).colorScheme,
        items,
        originBorder: {
          fg: inpStyle.color, layers: inpLayers, parentLayers: inp.parentElement ? inpLayers.slice(1) : inpLayers, darkRoot,
          borderTopColor: inpStyle.borderTopColor, borderTopWidth: parseFloat(inpStyle.borderTopWidth) || 0,
          fontSize: parseFloat(inpStyle.fontSize) || 0, colorScheme: inpStyle.colorScheme
        }
      };
    }, null) as { scheme: string; items: Record<'body' | 'h1' | 'message' | 'primary' | 'secondary' | 'summary' | 'origin' | 'plain', RawElementSample>; originBorder: RawBorderSample };
    const popupBody = computeElementMetrics(rawPopup.items.body);
    const popupPlain = computeElementMetrics(rawPopup.items.plain);
    const originBorder = computeBorderMetrics(rawPopup.originBorder);
    assert.equal(rawPopup.scheme, 'dark', 'Extension popup must declare dark color-scheme');
    assert.ok(popupBody.bgLum <= 0.08, `Extension popup body must be dark, got lum ${popupBody.bgLum}`);
    assert.ok(popupPlain.fontSize >= 12, `Extension popup .plain must be >= 12px, got ${popupPlain.fontSize}`);
    for (const key of ['h1', 'message', 'primary', 'secondary', 'summary', 'origin', 'plain'] as const) {
      const m = computeElementMetrics(rawPopup.items[key]);
      assert.ok(m.ratio >= 4.5, `Extension popup ${key} contrast must be >= 4.5:1, got ${m.ratio.toFixed(2)}:1`);
    }
    assert.ok(originBorder.borderWidth >= 1 && originBorder.ratio >= 3.0,
      `Extension popup .address input dark border contrast must be >= 3.0:1, got ${originBorder.ratio.toFixed(2)}:1`);
    await menu.click('#toggle');
    await menu.detach();

    // Verify extension popup .address input border contrast in Light theme too.
    const lightPopupPage = await context.newPage();
    try {
      await lightPopupPage.emulateMedia({ colorScheme: 'light' });
      await lightPopupPage.goto('chrome-extension://' + id + '/popup.html');
      await lightPopupPage.locator('summary').click();
      await assertBorderContrast(lightPopupPage.locator('.address input'), 'extension popup .address input (light)', 3.0);
    } finally {
      await lightPopupPage.close();
    }

    // Verify closed-shadow-DOM card legibility on BOTH white (#ffffff) and dark (#12141a) host pages (T1-F4-06, T2-F4-07).
    for (const [label, url, needsEnable] of [
      ['white host page', extPages.whiteUrl, false],
      ['dark host page', extPages.darkUrl, true]
    ] as const) {
      if (needsEnable) {
        await page.goto(url);
        const toggleMenu = await openToolbar(page, id);
        await toggleMenu.click('#toggle');
        await toggleMenu.detach();
      }
      await page.locator('#term').dblclick();
      await until(async () => (await cardElement(page, 'h2'))?.text === 'luminance', `Card did not open on ${label}`);

      const cardBox = await inspectShadowCardMetrics(page, '.card');
      assert.ok(cardBox, `Missing .card metrics on ${label}`);
      assert.equal(cardBox.colorScheme, 'dark', `.card on ${label} must resolve dark color-scheme`);
      assert.ok(cardBox.bgLum <= 0.08, `.card on ${label} must be dark, got lum ${cardBox.bgLum}`);
      assert.ok(cardBox.borderTopWidth >= 1, `.card on ${label} must keep visible >= 1px border`);
      assert.notEqual(cardBox.boxShadow, 'none', `.card on ${label} must keep elevation shadow`);

      for (const sel of ['h2', '.hint', '.modes button', '.foot .primary', '.foot [data-do="open"]']) {
        const m = await inspectShadowCardMetrics(page, sel);
        assert.ok(m, `Missing ${sel} on ${label}`);
        assert.ok(m.ratio >= 4.5, `Dark card ${sel} on ${label}: expected >= 4.5:1, got ${m.ratio.toFixed(2)}:1`);
        if (sel === '.foot [data-do="open"]') {
          assert.ok(m.fontSize >= 12, `Card open link must be >= 12px, got ${m.fontSize}`);
        }
      }

      await clickCard(page, '[data-do="note"]');
      await until(async () => Boolean(await cardElement(page, '.editor textarea')), `Note textarea did not open on ${label}`);
      const ta = await inspectShadowCardMetrics(page, '.editor textarea');
      assert.ok(ta && ta.bgLum <= 0.08 && ta.ratio >= 4.5,
        `Dark card textarea on ${label} must be dark with >= 4.5:1 contrast`);
      assert.ok(ta.borderTopWidth >= 1 && ta.borderRatio >= 3.0,
        `Dark card textarea border on ${label} must have >= 3.0:1 contrast (SC 1.4.11), got ${ta.borderRatio.toFixed(2)}:1 (${ta.borderColor})`);

      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      const lightCard = await inspectShadowCardMetrics(page, '.card');
      const lightHeading = await inspectShadowCardMetrics(page, 'h2');
      const lightTa = await inspectShadowCardMetrics(page, '.editor textarea');
      assert.ok(lightCard && lightCard.bgLum > 0.9, `Light card on ${label} must render crisp white surface`);
      assert.ok(lightHeading && lightHeading.ratio >= 4.5, `Light card h2 on ${label} must have >= 4.5:1 contrast`);
      assert.ok(lightTa && lightTa.borderTopWidth >= 1 && lightTa.borderRatio >= 3.0,
        `Light card textarea border on ${label} must have >= 3.0:1 contrast (SC 1.4.11), got ${lightTa?.borderRatio.toFixed(2)}:1 (${lightTa?.borderColor})`);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await cdp.detach();
    }

    assert.deepEqual(pageErrors, [], 'Extension phase page errors: ' + pageErrors.join('; '));
    console.log('PASS Phase 6 (T1-F4-06, T2-F4-07): MV3 extension popup and closed-shadow-DOM card verified in dark & light modes on both white and dark host pages.');
  } finally {
    await context.close();
    await extPages.close();
  }
}

await runStaticCssAudit();

const publisherLog = path.join(os.tmpdir(), 'paper-reader-dark-a11y-pub-' + randomUUID() + '.ndjson');
await writeFile(publisherLog, '', { flag: 'wx' });
const publisher = await startRichWebFixture();
try {
  await withHost(async host => {
    await runBrowserPhases(host, publisher.articleUrl);
    await runExtensionPhase(host);
  }, {
    PAPER_READER_E2E_PUBLISHER_FIXTURE: publisher.origin,
    PAPER_READER_E2E_PUBLISHER_LOG: publisherLog,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import', new URL('./book-reading-preload.ts', import.meta.url).href].filter(Boolean).join(' ')
  }, { modelFixture: true });
} finally {
  await publisher.close();
  await rm(publisherLog, { force: true });
}
console.log('Verified all 23 F4 & F5 dark theme and accessibility scenarios.');
