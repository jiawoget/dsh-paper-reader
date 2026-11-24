import type { Box, Passage } from './model.js';
import type { ReadingSide } from '../../shared/types.js';
import { DEFAULT_TARGET_LANGUAGE } from '../../shared/languages.js';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export function place(node: HTMLElement, r: Box): void {
  Object.assign(node.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
}

export interface Sheet {
  outer: HTMLElement;
  plane: HTMLDivElement;
  readonly scale: number;
  attach(host: HTMLElement, zoom: number): void;
  setWindow(bounds: Box): void;
  resize(): void;
}

export function makeSheet(side: ReadingSide, page: number, window: Box, width: number, height: number, targetLanguage = DEFAULT_TARGET_LANGUAGE): Sheet {
  const outer = element('div', 'pdf-sheet');
  outer.dataset.pdfSide = side;
  outer.setAttribute('role', 'group');
  outer.ariaLabel = (side === 'source' ? 'Original' : targetLanguage) + ', page ' + page;
  const scale = element('div', 'pdf-scale-plane');
  const plane = element('div', 'pdf-coordinate-plane');
  place(plane, { x: -window.x, y: -window.y, width, height });
  scale.append(plane);
  outer.append(scale);
  let ratio = 1;
  return { outer, plane,
    get scale() { return ratio; },
    attach(host, zoom) {
      outer.style.width = zoom * 100 + '%';
      host.replaceChildren(outer);
      this.resize();
    },
    setWindow(bounds) {
      window = bounds;
      outer.style.aspectRatio = bounds.width + ' / ' + bounds.height;
      place(plane, { x: -bounds.x, y: -bounds.y, width, height });
      this.resize();
    },
    resize() {
      outer.style.aspectRatio = window.width + ' / ' + window.height;
      const pixels = outer.getBoundingClientRect().width;
      if (pixels) {
        ratio = pixels / window.width;
        scale.style.transform = 'scale(' + ratio + ')';
      }
    }
  };
}

export function newAnchor(passage: Passage, figure = false): HTMLElement {
  const area = figure ? passage.illustration : passage.box;
  const node = figure ? element('button', 'pdf-figure') : element('div', 'pdf-anchor');
  node.dataset.blockId = passage.id;
  node.ariaLabel = passage.label;
  if (node instanceof HTMLButtonElement) {
    node.type = 'button';
    node.title = passage.label;
  } else node.setAttribute('aria-hidden', 'true');
  if (area) place(node, area);
  return node;
}

export function translatedText(passage: Passage, lang: string | null = 'zh-CN'): HTMLDivElement {
  const node = element('div', 'pdf-translated-text');
  if (lang) node.lang = lang;
  node.dir = 'auto';
  node.dataset.blockId = passage.id;
  node.dataset.role = passage.role;
  place(node, passage.box);
  return node;
}

export function fitText(node: HTMLElement, passage: Passage, sheetScale = 1, minVisualPx = 0): void {
  if (node.hidden || !node.isConnected || node.clientHeight === 0) return;
  node.classList.remove('needs-scroll');
  const baseMax = Math.max(6, Math.min(58, passage.fontSize * (passage.role === 'heading' ? 1.08 : 1)));
  let floor = Math.min(baseMax, Math.max(5, baseMax * 0.65));
  let maximum = baseMax;
  // When a bilingual sheet scales below 1:1 (e.g. 1440px with an open or widened sidebar),
  // keep translated prose at a readable visual size and let overflowing boxes scroll vertically.
  if (minVisualPx > 0 && sheetScale > 0 && sheetScale < 1.05) {
    const isSmallNote = passage.role === 'caption' || passage.fontSize < 8.5 || passage.id.startsWith('ref-');
    const targetVisualPx = isSmallNote ? Math.min(minVisualPx, 10) : minVisualPx;
    const scaledFloor = Math.min(24, targetVisualPx / sheetScale);
    floor = Math.max(floor, scaledFloor);
    maximum = Math.max(maximum, floor);
  }
  let lower = floor, upper = maximum;
  node.style.fontSize = maximum + 'px';
  const fits = () => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth;
  if (fits()) return;
  for (let i = 0; i < 7; i++) {
    const middle = (lower + upper) / 2;
    node.style.fontSize = middle + 'px';
    if (fits()) lower = middle;
    else upper = middle;
  }
  node.style.fontSize = lower + 'px';
  if (!fits()) node.classList.add('needs-scroll');
}

export function cropFigure(canvas: HTMLCanvasElement, rect: Box, pageWidth: number, pageHeight: number): string | null {
  const target = document.createElement('canvas');
  target.width = Math.max(1, Math.min(800, Math.round(rect.width * canvas.width / pageWidth)));
  target.height = Math.max(1, Math.round(target.width * rect.height / rect.width));
  const ctx = target.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(canvas, rect.x * canvas.width / pageWidth, rect.y * canvas.height / pageHeight,
    rect.width * canvas.width / pageWidth, rect.height * canvas.height / pageHeight, 0, 0, target.width, target.height);
  return target.toDataURL('image/png');
}

/** Keep original paper ink everywhere except the regions reserved for translated passages. */
export function paintArtwork(canvas: HTMLCanvasElement, image: HTMLCanvasElement, areas: Box[],
  pageWidth: number, pageHeight: number): void {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('The browser could not display the translated page.');
  context.drawImage(image, 0, 0);
  const sx = canvas.width / pageWidth, sy = canvas.height / pageHeight;
  context.fillStyle = '#fff';
  for (const r of areas) {
    const x = Math.floor(r.x * sx), y = Math.floor(r.y * sy);
    context.fillRect(x, y, Math.ceil((r.x + r.width) * sx) - x, Math.ceil((r.y + r.height) * sy) - y);
  }
}
