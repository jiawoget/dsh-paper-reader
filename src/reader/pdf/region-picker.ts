import type { RegionAction } from '../../shared/types.js';
import { RegionPicker } from '../region-picker.js';
import { readerLabel as label } from '../ui.js';
import type { Box } from './model.js';
import type { Sheet } from './paper.js';
import type { PageRaster } from './raster.js';
import { pagePoint, readRegion, regionAnchor, regionBox } from './region-geometry.js';

function textInside(runs: HTMLElement[], area: DOMRect): string {
  const inside = (x: number, y: number) => area.left <= x && x <= area.right && area.top <= y && y <= area.bottom;
  const lines: string[] = [];
  const range = document.createRange();
  for (const run of runs) {
    const node = run.firstChild;
    if (!(node instanceof Text) || !node.data.trim()) continue;
    const r = run.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= area.left || r.bottom <= area.top || r.left >= area.right || r.top >= area.bottom) continue;
    if (inside(r.left, r.top) && inside(r.right, r.bottom)) { lines.push(node.data); continue; }
    let part = '', start = 0;
    for (const character of node.data) {
      const end = start + character.length;
      range.setStart(node, start); range.setEnd(node, end);
      const glyph = range.getBoundingClientRect();
      if (inside(glyph.x + glyph.width / 2, glyph.y + glyph.height / 2)) part += character;
      start = end;
    }
    if (part.trim()) lines.push(part);
  }
  return lines.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 100_000);
}

export function pdfRegionPicker(sheet: Sheet, raster: PageRaster, runs: HTMLElement[], page: number,
  paper: Box, signal: AbortSignal, deliver?: RegionAction,
  figureFor?: (area: Box) => string | undefined, canContinue?: (anchor: string) => boolean): RegionPicker {
  return new RegionPicker({
    outer: sheet.outer, plane: sheet.plane,
    point: (x, y) => pagePoint(x, y, sheet.plane.getBoundingClientRect()),
    anchor: regionAnchor,
    rect(id) {
      const region = readRegion(id);
      if (!region) return null;
      const r = regionBox(region, sheet.plane.getBoundingClientRect());
      return new DOMRect(r.x, r.y, r.width, r.height);
    },
    async capture(id, rect, signal) {
      const area = regionBox(readRegion(id)!, paper), figure = figureFor?.(area);
      const name = label('Page ' + page + ' screenshot', '第 ' + page + ' 页截图') + (figure
        ? ' · ' + label(figure, figure.replace(/^Figure /i, '图 ').replace(/^Table /i, '表 ')) : '');
      const regionText = textInside(runs, rect);
      return { id, image: await raster.crop(area, signal), regionText, label: name, side: 'source' };
    }
  }, page, signal, deliver, canContinue);
}
