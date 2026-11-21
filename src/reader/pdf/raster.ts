import type { PDFPageProxy, RenderTask } from 'pdfjs-dist/types/src/display/api.js';
import type { Box } from './model.js';
import { element, paintArtwork } from './paper.js';

/** Render at the physical size of the larger visible page, including a cropped column. */
export class PageRaster {
  original = this.canvas();
  readonly artwork = this.canvas();
  private drawing?: RenderTask;
  private updating?: Promise<void>;
  private timer = 0;

  constructor(private page: PDFPageProxy, private areas: Box[], private pageWidth: number,
    private pageHeight: number, private signal: AbortSignal) {
    signal.addEventListener('abort', () => { clearTimeout(this.timer); this.drawing?.cancel(); }, { once: true });
  }

  watchDensity(...sheets: HTMLElement[]): void {
    const visible = new Set<Element>();
    let previous = 0, timer = 0;
    let media: MediaQueryList | undefined;
    const check = () => {
      if (this.signal.aborted || document.hidden || !visible.size) return;
      const current = window.devicePixelRatio || 1;
      if (current === previous) return;
      previous = current;
      media?.removeEventListener('change', check);
      media = matchMedia('(resolution: ' + current + 'dppx)');
      media.addEventListener('change', check, { signal: this.signal });
      this.schedule();
    };
    const sync = () => {
      if (this.signal.aborted || document.hidden || !visible.size) {
        clearInterval(timer); timer = 0;
        return;
      }
      check();
      // Chromium can update DPR in a settled iframe without firing media-query or resize events.
      // Read just the ratio while paper is visible. Layout and PDF work run only when it changes.
      if (!timer) timer = window.setInterval(check, 600);
    };
    const visibility = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      sync();
    });
    for (const sheet of sheets) visibility.observe(sheet);
    document.addEventListener('visibilitychange', sync, { signal: this.signal });
    window.addEventListener('focus', check, { signal: this.signal });
    this.signal.addEventListener('abort', () => { visibility.disconnect(); clearInterval(timer); }, { once: true });
  }

  private canvas(): HTMLCanvasElement {
    const canvas = element('canvas', 'pdf-raster');
    canvas.width = canvas.height = 1;
    canvas.setAttribute('aria-hidden', 'true');
    return canvas;
  }

  private requestedWidth(): number {
    const width = Math.max(this.original.getBoundingClientRect().width, this.artwork.getBoundingClientRect().width);
    // Keep text and figures sharp at desktop zoom levels without allocating unbounded surfaces.
    const density = (window.devicePixelRatio || 1) * (window.visualViewport?.scale || 1);
    const scale = Math.min(Math.max(1, width * density / this.pageWidth),
      Math.sqrt(16_000_000 / (this.pageWidth * this.pageHeight)), 8192 / Math.max(this.pageWidth, this.pageHeight));
    return Math.max(1, Math.ceil(this.pageWidth * scale));
  }

  private async draw(): Promise<void> {
    while (!this.signal.aborted) {
      const width = this.requestedWidth();
      if (this.original.width >= width && this.original.width <= width * 1.12) return;
      const viewport = this.page.getViewport({ scale: width / this.pageWidth });
      const next = this.canvas();
      next.width = width;
      next.height = Math.ceil(viewport.height);
      this.drawing = this.page.render({ canvas: next, viewport, background: '#ffffff' });
      await this.drawing.promise;
      this.signal.throwIfAborted();
      const previous = this.original;
      this.artwork.width = next.width;
      this.artwork.height = next.height;
      paintArtwork(this.artwork, next, this.areas, this.pageWidth, this.pageHeight);
      previous.replaceWith(next);
      this.original = next;
      previous.width = previous.height = 1;
    }
  }

  refresh(): Promise<void> {
    this.updating ??= this.draw().finally(() => { this.updating = undefined; this.drawing = undefined; });
    return this.updating;
  }

  crop(area: Box, signal: AbortSignal): Promise<string> {
    return cropPdfPage(this.page, area, signal);
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      if (!this.signal.aborted) void this.refresh().catch(error => {
        if (!this.signal.aborted) console.error('Unable to refresh the PDF drawing.', error);
      });
    }, 110);
  }
}

export async function cropPdfPage(page: PDFPageProxy, area: Box, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // Render only this rectangle at a readable resolution, including on a small phone.
  const scale = Math.min(3, 1600 / Math.max(area.width, area.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.min(1600, Math.ceil(area.width * scale)));
  canvas.height = Math.max(1, Math.min(1600, Math.ceil(area.height * scale)));
  const task = page.render({ canvas, viewport: page.getViewport({ scale }),
    transform: [1, 0, 0, 1, -area.x * scale, -area.y * scale], background: '#ffffff' });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await task.promise;
    signal?.throwIfAborted();
    let image = canvas;
    let data = image.toDataURL('image/png');
    while (data.length > 2 * 1024 * 1024) {
      const next = document.createElement('canvas');
      next.width = Math.max(1, Math.floor(image.width * 0.75));
      next.height = Math.max(1, Math.floor(image.height * 0.75));
      next.getContext('2d')!.drawImage(image, 0, 0, next.width, next.height);
      image = next;
      data = image.toDataURL('image/png');
    }
    return data;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
