import assert from 'node:assert/strict';
import type { FrameLocator, Page } from 'playwright-core';

type ClipWin = Window & {
  __origWrite?: typeof navigator.clipboard.writeText;
};

export interface TranslatedBlockMetric {
  id: string | undefined;
  cssFont: number;
  visualFont: number;
  needsScroll: boolean;
  overflowY: string;
  scrollOverflows: boolean;
}

export interface TranslatedBlocksReport {
  bodySizes: TranslatedBlockMetric[];
  overlaps: number;
  pageOverflow: number;
  railWidth: number;
}

export async function blockClipboard(target: Page | FrameLocator): Promise<void> {
  await target.locator('body').evaluate(() => {
    const w = window as ClipWin;
    w.__origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    const stubs = { writeText() { return Promise.reject(new DOMException('Clipboard permission denied', 'NotAllowedError')); } };
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: stubs.writeText });
  });
}

export async function restoreClipboard(target: Page | FrameLocator): Promise<void> {
  await target.locator('body').evaluate(() => {
    const w = window as ClipWin;
    if (w.__origWrite) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: w.__origWrite });
  });
}

export async function inspectTranslatedBlocks(page: Page): Promise<TranslatedBlocksReport> {
  return page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('#translated .pdf-translated-text')).filter(el => !el.hidden && el.offsetWidth > 0);
    const bodySizes = blocks.filter(el => el.dataset.role === 'paragraph').map(el => {
      const rect = el.getBoundingClientRect();
      const cssFont = parseFloat(getComputedStyle(el).fontSize) || 0;
      return {
        id: el.dataset.blockId,
        cssFont,
        visualFont: cssFont * (rect.width / el.offsetWidth),
        needsScroll: el.classList.contains('needs-scroll'),
        overflowY: getComputedStyle(el).overflowY,
        scrollOverflows: el.scrollHeight > el.clientHeight + 2
      };
    });
    const rects = blocks.map(el => el.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlaps++;
      }
    }
    return {
      bodySizes,
      overlaps,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      railWidth: document.getElementById('rail')?.getBoundingClientRect().width ?? 0
    };
  });
}

export interface MobileChromeReport {
  topbarHeight: number;
  topChromeBottom: number;
  docTitleWidth: number;
  overflow: number;
  pageFormatVisible: boolean;
  bottomBar: { top: number; bottom: number; height: number; width: number; scrollWidth: number; clientWidth: number };
  toolbarOverflow: number;
  barOverlaps: { left: string; right: string; overlap: number }[];
  clippedButtons: { id: string; scrollWidth: number; clientWidth: number }[];
  undersizedControls: { id: string; label: string; width: number; height: number }[];
  pinCount: number;
}

export async function inspectMobileChrome(page: Page): Promise<MobileChromeReport> {
  return page.evaluate(() => {
    const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
    const paper = document.getElementById('paperScroll')!.getBoundingClientRect();
    const title = document.getElementById('docTitle')!.getBoundingClientRect();
    const fmt = document.getElementById('pageFormat')?.getBoundingClientRect();
    const barEl = document.getElementById('mobileBar')!;
    const bar = barEl.getBoundingClientRect();
    const toolbar = barEl.querySelector<HTMLElement>('.toolbar');
    const controls = [
      ...document.querySelectorAll<HTMLElement>('.topbar button, .topbar select, #mobileBar button, #mobileBar select, #original .annotation-pin')
    ];
    const undersizedControls: { id: string; label: string; width: number; height: number }[] = [];
    const clippedButtons: { id: string; scrollWidth: number; clientWidth: number }[] = [];
    const barButtons: { id: string; rect: DOMRect }[] = [];
    let pinCount = 0;
    for (const el of controls) {
      if (el.hidden || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.classList.contains('annotation-pin')) pinCount++;
      const id = el.id || el.className;
      if (r.width < 43.5 || r.height < 43.5) {
        undersizedControls.push({ id, label: el.getAttribute('aria-label') || el.textContent?.trim() || '', width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 });
      }
      if (barEl.contains(el)) {
        barButtons.push({ id, rect: r });
        if (el.scrollWidth > el.clientWidth + 1) clippedButtons.push({ id, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
    }
    barButtons.sort((a, b) => a.rect.left - b.rect.left);
    const barOverlaps: { left: string; right: string; overlap: number }[] = [];
    for (let i = 0; i < barButtons.length; i++) {
      for (let j = i + 1; j < barButtons.length; j++) {
        const a = barButtons[i], b = barButtons[j];
        if (Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) <= 2) continue;
        if (a.rect.right > b.rect.left + 0.5) {
          barOverlaps.push({ left: a.id, right: b.id, overlap: Math.round((a.rect.right - b.rect.left) * 10) / 10 });
        }
      }
    }
    return {
      topbarHeight: topbar.height,
      topChromeBottom: paper.top,
      docTitleWidth: title.width,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      pageFormatVisible: Boolean(fmt && fmt.width > 0 && fmt.height > 0),
      bottomBar: { top: bar.top, bottom: bar.bottom, height: bar.height, width: bar.width, scrollWidth: barEl.scrollWidth, clientWidth: barEl.clientWidth },
      toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : 0,
      barOverlaps,
      clippedButtons,
      undersizedControls,
      pinCount
    };
  });
}

export async function assertMobileChromeBudget(page: Page, viewportHeight: number, expectPin = false): Promise<MobileChromeReport> {
  const m = await inspectMobileChrome(page);
  assert.ok(m.topbarHeight <= 52, `Mobile .topbar height ${m.topbarHeight} > 52px`);
  assert.ok(m.topChromeBottom < 60 && m.topChromeBottom / viewportHeight < 0.18, `Mobile top chrome ${m.topChromeBottom}px exceeds <60px / <18% of ${viewportHeight}px`);
  assert.ok(m.docTitleWidth >= 64, `Mobile #docTitle width ${m.docTitleWidth} < 64px`);
  assert.ok(m.overflow <= 1, `Mobile horizontal overflow ${m.overflow} > 1px`);
  assert.equal(m.pageFormatVisible, false, 'Mobile idle #pageFormat must stay hidden');
  assert.ok(m.bottomBar.height >= 44 && m.bottomBar.height <= 64 && m.bottomBar.bottom >= viewportHeight - 2 && m.bottomBar.scrollWidth <= m.bottomBar.clientWidth + 1,
    'Mobile bottom bar geometry invalid: ' + JSON.stringify(m.bottomBar));
  assert.ok(m.toolbarOverflow <= 1, `Mobile #mobileBar .toolbar overflow ${m.toolbarOverflow} > 1px`);
  assert.deepEqual(m.barOverlaps, [], 'Mobile #mobileBar button overlaps: ' + JSON.stringify(m.barOverlaps));
  assert.deepEqual(m.clippedButtons, [], 'Mobile #mobileBar clipped buttons: ' + JSON.stringify(m.clippedButtons));
  assert.deepEqual(m.undersizedControls, [], 'Mobile controls below 44x44px: ' + JSON.stringify(m.undersizedControls));
  if (expectPin) assert.ok(m.pinCount >= 1, 'Expected at least one visible .annotation-pin >= 44x44px');
  return m;
}

export async function assertMobilePanelTargets(page: Page, rootSelector: string): Promise<void> {
  const res = await page.evaluate(sel => {
    const root = document.querySelector<HTMLElement>(sel);
    if (!root) return { visible: false, overflow: 0, count: 0, undersized: [] as { tag: string; label: string; width: number; height: number }[] };
    const rect = root.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && !root.hidden;
    const body = sel === '#rail' ? document.getElementById('railBody') : null;
    const bodyOverflow = body && body.getBoundingClientRect().width > 0 ? body.scrollWidth - body.clientWidth : 0;
    const overflow = Math.max(root.scrollWidth - root.clientWidth, bodyOverflow);
    const controls = [...root.querySelectorAll<HTMLElement>('button, a[href], select, input, textarea, summary, [role="tab"]')];
    const undersized: { tag: string; label: string; width: number; height: number }[] = [];
    let count = 0;
    for (const el of controls) {
      if (el.hidden || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      count++;
      const label = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.closest('label') : null;
      const hit = label ? label.getBoundingClientRect() : r;
      const minRaw = label ? 23.5 : 43.5;
      if (hit.width < 43.5 || hit.height < 43.5 || r.width < minRaw || r.height < minRaw) {
        const box = hit.width < 43.5 || hit.height < 43.5 ? hit : r;
        undersized.push({ tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : ''),
          label: el.getAttribute('aria-label') || label?.textContent?.trim() || el.textContent?.trim() || '', width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 });
      }
    }
    return { visible, overflow, count, undersized };
  }, rootSelector);
  assert.ok(res.visible && res.count >= 1, `Panel ${rootSelector} not visible or has no controls: ${JSON.stringify(res)}`);
  assert.ok(res.overflow <= 1, `Panel ${rootSelector} horizontal overflow ${res.overflow} > 1px`);
  assert.deepEqual(res.undersized, [], `Panel ${rootSelector} controls below 44x44px: ${JSON.stringify(res.undersized)}`);
}

export async function assertDesktopChromeCraft(page: Page): Promise<void> {
  const prevSize = page.viewportSize() ?? { width: 1440, height: 900 };
  const railTabs = [['contentsTab', 'Contents'], ['annotationsTab', 'Marks'], ['refsTab', 'Reference'], ['notesTab', 'Notes']] as const;
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768]] as const) {
    await page.setViewportSize({ width, height });
    if (await page.locator('#rail').isVisible()) await page.locator('#closeRail').click();
    const closedTop = await page.locator('.topbar').evaluate(el => el.getBoundingClientRect().height);
    await page.locator('#mobileRail').click();
    await page.locator('#rail').waitFor({ state: 'visible' });
    const tabIds = railTabs.map(([id]) => id);
    const baseLefts = await page.evaluate(ids => ids.map(id => document.getElementById(id)!.getBoundingClientRect().left), tabIds);
    for (const [id, name] of railTabs) {
      await page.locator('#' + id).click();
      assert.equal((await page.locator('#notebookHandle').innerText()).trim(), name);
      const tabCheck = await page.evaluate(ids => {
        const tablist = document.querySelector<HTMLElement>('.rail-head [role="tablist"]')!;
        return {
          overflow: tablist.scrollWidth - tablist.clientWidth,
          lefts: ids.map(tabId => document.getElementById(tabId)!.getBoundingClientRect().left)
        };
      }, tabIds);
      assert.ok(tabCheck.overflow <= 0, `Rail tablist clipped on ${id} at ${width}px: overflow=${tabCheck.overflow}`);
      for (let i = 0; i < railTabs.length; i++) {
        const shift = Math.abs(tabCheck.lefts[i] - baseLefts[i]);
        assert.ok(shift <= 0.5, `Rail tab ${railTabs[i][0]} shifted ${shift}px on ${id} at ${width}px`);
      }
    }
    await page.locator('.notebook-toolbar').waitFor({ state: 'visible' });
    const metrics = await page.evaluate(() => {
      const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
      const title = document.getElementById('docTitle')!.getBoundingClientRect();
      const footer = document.querySelector<HTMLElement>('.notebook-footer');
      const footerRect = footer?.getBoundingClientRect();
      const toolbar = document.querySelector<HTMLElement>('.notebook-toolbar');
      const toolbarButtons = toolbar ? [...toolbar.querySelectorAll<HTMLElement>('button')].filter(el => !el.hidden && el.getBoundingClientRect().width > 0) : [];
      const clippedToolbarButtons = toolbarButtons
        .filter(el => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
        .map(el => ({ text: el.textContent?.trim() || el.getAttribute('aria-label') || '', sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth }));
      return {
        topbarHeight: topbar.height,
        titleWidth: title.width,
        saveStateExists: Boolean(document.getElementById('saveState')),
        footerHeight: footerRect?.height ?? 0,
        footerOverflow: footer ? footer.scrollWidth - footer.clientWidth : 0,
        toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : -1,
        toolbarButtonCount: toolbarButtons.length,
        clippedToolbarButtons
      };
    });
    assert.equal(metrics.saveStateExists, false, '#saveState must be removed');
    assert.ok(Math.abs(metrics.topbarHeight - closedTop) <= 1, `Topbar jumped at ${width}px: ${closedTop} -> ${metrics.topbarHeight}`);
    assert.ok(metrics.titleWidth >= 80, `#docTitle width ${metrics.titleWidth} < 80px at ${width}px`);
    assert.ok(metrics.footerHeight > 0 && metrics.footerHeight <= 42 && metrics.footerOverflow <= 1,
      `Notebook footer wrapped or overflowed at ${width}px: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.toolbarButtonCount >= 4 && metrics.toolbarOverflow >= 0 && metrics.toolbarOverflow <= 1,
      `Notebook toolbar overflowed at ${width}px: ${JSON.stringify(metrics)}`);
    assert.deepEqual(metrics.clippedToolbarButtons, [], `Notebook toolbar buttons clipped/wrapped at ${width}px: ${JSON.stringify(metrics.clippedToolbarButtons)}`);
  }
  await page.locator('#closeRail').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#more').click();
  assert.equal(await page.locator('#menu').getByRole('button', { name: 'Library', exact: true }).count(), 0);
  await page.locator('#menu').getByRole('button', { name: 'Connections', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  const saveBox = (await dialog.getByRole('button', { name: 'Save connections', exact: true }).boundingBox())!;
  assert.ok(saveBox.y >= 0 && saveBox.y + saveBox.height <= 900, 'Save connections must be visible without scrolling');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize(prevSize);
}
