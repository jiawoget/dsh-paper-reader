import type { FrameLocator, Page } from 'playwright-core';

type ClipWin = Window & {
  __origWrite?: typeof navigator.clipboard.writeText;
  __origExec?: typeof document.execCommand;
  __copied?: string;
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

export async function mockClipboardFallback(target: Page | FrameLocator): Promise<void> {
  await target.locator('body').evaluate(() => {
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
}

export async function readClipboardFallback(target: Page | FrameLocator): Promise<string> {
  return target.locator('body').evaluate(() => (window as ClipWin).__copied ?? '');
}

export async function failClipboardExecCommand(target: Page | FrameLocator): Promise<void> {
  await target.locator('body').evaluate(() => {
    const stubs = { execCommand() { return false; } };
    document.execCommand = stubs.execCommand;
  });
}

export async function restoreClipboard(target: Page | FrameLocator): Promise<void> {
  await target.locator('body').evaluate(() => {
    const w = window as ClipWin;
    if (w.__origWrite) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: w.__origWrite });
    if (w.__origExec) document.execCommand = w.__origExec;
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
