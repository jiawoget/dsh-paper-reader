import type { Box } from './model.js';

export interface PaperPoint { x: number; y: number }
export interface PaperRegion { left: number; top: number; right: number; bottom: number }
const units = 10_000;

/** Store the two corners relative to the full rotated PDF page, independent of zoom and margins. */
export function pagePoint(x: number, y: number, plane: Box): PaperPoint {
  const unit = (offset: number, size: number) => Math.max(0, Math.min(units, Math.round(offset / size * units)));
  return { x: unit(x - plane.x, plane.width), y: unit(y - plane.y, plane.height) };
}

export function regionAnchor(a: PaperPoint, b: PaperPoint): string | undefined {
  if (a.x === b.x || a.y === b.y) return;
  return ['region', Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)].join('-');
}

export function readRegion(anchor: string): PaperRegion | undefined {
  const match = /^region-(\d{1,5})-(\d{1,5})-(\d{1,5})-(\d{1,5})$/.exec(anchor);
  if (!match) return;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (right > units || bottom > units || left >= right || top >= bottom) return;
  return { left, top, right, bottom };
}

export function regionBox(r: PaperRegion, page: Box): Box {
  return { x: page.x + r.left * page.width / units, y: page.y + r.top * page.height / units,
    width: (r.right - r.left) * page.width / units, height: (r.bottom - r.top) * page.height / units };
}

export function figureAtRegion(crop: Box, passages: readonly { label: string; illustration?: Box }[]): string | undefined {
  for (const { label, illustration: art } of passages) {
    if (!art) continue;
    const width = Math.min(crop.x + crop.width, art.x + art.width) - Math.max(crop.x, art.x);
    const height = Math.min(crop.y + crop.height, art.y + art.height) - Math.max(crop.y, art.y);
    if (width > 0 && height > 0 && width * height >= 0.7 * crop.width * crop.height) return label;
  }
}

export function screenshotFigureLabel(label: string): string | undefined {
  const name = label.split(' · ').at(-1)?.trim() ?? '';
  return /^(?:Fig(?:ure)?\.?|Table|图|表)\s*\d+[a-z]?$/iu.test(name) ? name : undefined;
}
