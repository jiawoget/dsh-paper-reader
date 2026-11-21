import assert from 'node:assert/strict';
import type { Frame, Page } from 'playwright-core';

/** Change physical density after rendering settles, keeping the DSH iframe and every CSS width fixed. */
export async function idleDensity(tab: Page, reader: Frame) {
  const session = await tab.context().newCDPSession(tab);
  const metrics = (deviceScaleFactor: number) => session.send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, mobile: false, deviceScaleFactor
  });
  await tab.bringToFront();
  await metrics(1);
  await reader.getByLabel('Translation scope').selectOption('page');
  await reader.locator('#original canvas').waitFor();
  await reader.waitForFunction(() => document.getElementById('loading')!.hidden);
  const probe = await reader.locator('#original .pdf-sheet').evaluateHandle(sheet => {
    const events = { media: 0, resize: 0, visualViewport: 0, cssBox: 0, deviceBox: 0 };
    const listeners = new AbortController(), options = { signal: listeners.signal };
    const media = matchMedia('(resolution: 1dppx)');
    media.addEventListener('change', () => events.media++, options);
    window.addEventListener('resize', () => events.resize++, options);
    window.visualViewport?.addEventListener('resize', () => events.visualViewport++, options);
    const css = new ResizeObserver(() => events.cssBox++);
    const pixels = new ResizeObserver(() => events.deviceBox++);
    css.observe(sheet); pixels.observe(sheet, { box: 'device-pixel-content-box' });
    return {
      read() {
        return { dpr: devicePixelRatio, width: innerWidth, mediaMatches: media.matches, events: { ...events },
          canvases: [...document.querySelectorAll<HTMLCanvasElement>('.pdf-raster')].map(canvas => ({
            side: canvas.closest<HTMLElement>('[data-pdf-side]')?.dataset.pdfSide,
            css: canvas.getBoundingClientRect().width, physical: canvas.width
          })) };
      },
      dispose() { listeners.abort(); css.disconnect(); pixels.disconnect(); }
    };
  });
  try {
    const read = () => probe.evaluate(measure => measure.read());
    const drawsAt = async (dpr: number) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const reading = await read();
        if (reading.dpr === dpr && reading.canvases.length === 2 && reading.canvases.every(canvas =>
          Math.abs(canvas.physical - canvas.css * dpr) <= 2)) return reading;
        if (Date.now() > deadline) throw new Error('Idle DPR ' + dpr + ' left stale PDF surfaces: ' + JSON.stringify(reading));
        await tab.waitForTimeout(100);
      }
    };
    await drawsAt(1);
    // Stay idle well beyond the 110ms pane-resize debounce before each transition.
    await tab.waitForTimeout(1000);
    const initial = await read();
    await metrics(1.5);
    const raised = await drawsAt(1.5);
    await tab.waitForTimeout(1000);
    await metrics(1);
    const lowered = await drawsAt(1);
    for (const next of [raised, lowered]) {
      assert.equal(next.width, initial.width);
      for (const [index, canvas] of next.canvases.entries()) assert.equal(canvas.css, initial.canvases[index].css);
    }
    return { initial, raised, lowered };
  } finally {
    await probe.evaluate(measure => measure.dispose());
    await probe.dispose();
    await session.detach();
  }
}
