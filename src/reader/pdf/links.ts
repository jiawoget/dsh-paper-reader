import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api.js';
import { el, readerLabel as label, safeWeb } from '../ui.js';
import { resolvePdfDestination, type PdfDestCache, type PdfLinkDestination } from './outline.js';

interface LinkAnnotation { subtype?: string; rect?: number[]; url?: string; unsafeUrl?: string; dest?: string | unknown[] }
const destCaches = new WeakMap<PDFDocumentProxy, PdfDestCache>();

export function viewportBox(
  viewport: Pick<ReturnType<PDFPageProxy['getViewport']>, 'convertToViewportPoint'>, rect?: readonly number[]
): { x: number; y: number; width: number; height: number } | undefined {
  if (!rect || rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) return;
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
  if (Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1)
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width, height };
}

export function dedupeCitePdfLinks(plane: ParentNode): void {
  const cites = Array.from(plane.querySelectorAll<HTMLElement>('.pdf-link[data-link-kind="cite"]'));
  if (!cites.length) return;
  const focuses = Array.from(plane.querySelectorAll<HTMLElement>('.pdf-citation-focus'), n => n.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
  for (const link of cites) {
    const r = link.getBoundingClientRect();
    const hit = r.width > 0 && r.height > 0 && focuses.some(c => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top);
    link.tabIndex = hit ? -1 : 0;
    link.style.pointerEvents = hit ? 'none' : '';
    if (hit) link.setAttribute('aria-hidden', 'true'); else link.removeAttribute('aria-hidden');
  }
}

export async function mountPdfLinks(
  pdf: PDFDocumentProxy, page: PDFPageProxy, viewport: ReturnType<PDFPageProxy['getViewport']>,
  plane: HTMLElement, signal: AbortSignal, onInternal?: (dest: PdfLinkDestination) => void
): Promise<void> {
  const annots = await page.getAnnotations({ intent: 'display' }).catch(() => []) as LinkAnnotation[];
  if (signal.aborted || !plane.isConnected || !annots.length) return;
  const layer = el('div', 'pdf-link-layer');
  let down: { x: number; y: number } | undefined;
  const isDragOrSelect = (e: MouseEvent) => {
    const moved = e.detail > 0 && down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 : false;
    down = undefined;
    return moved || !(window.getSelection()?.isCollapsed ?? true);
  };
  const cache = destCaches.get(pdf) ?? destCaches.set(pdf, { pages: new Map(), viewports: new Map() }).get(pdf)!;
  for (const annot of annots) {
    if (annot.subtype !== 'Link') continue;
    const box = viewportBox(viewport, annot.rect);
    if (!box) continue;
    const href = safeWeb(annot.url) ?? safeWeb(annot.unsafeUrl);
    let node: HTMLElement;
    if (href) {
      const link = el('a', 'pdf-link pdf-link-external');
      link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.title = href; link.ariaLabel = label('Open external link', '打开外部链接');
      link.addEventListener('click', e => { if (isDragOrSelect(e)) e.preventDefault(); });
      node = link;
    } else if (annot.dest) {
      const btn = el('button', 'pdf-link pdf-link-internal'), rawDest = annot.dest;
      btn.type = 'button';
      btn.dataset.linkKind = typeof rawDest === 'string' && /^cite\./i.test(rawDest) ? 'cite' : 'internal';
      btn.ariaLabel = label('Jump to linked location', '跳转到链接位置');
      btn.addEventListener('click', async e => {
        if (isDragOrSelect(e)) return;
        const target = await resolvePdfDestination(pdf, rawDest, cache).catch(() => undefined);
        if (!signal.aborted && target) onInternal?.(target);
      });
      node = btn;
    } else continue;
    node.draggable = false;
    node.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    Object.assign(node.style, { left: box.x + 'px', top: box.y + 'px', width: box.width + 'px', height: box.height + 'px' });
    layer.append(node);
  }
  if (!layer.childElementCount || signal.aborted || !plane.isConnected) return;
  plane.append(layer);
  dedupeCitePdfLinks(plane);
}
