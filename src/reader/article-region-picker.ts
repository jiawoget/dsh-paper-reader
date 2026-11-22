import { readArticleLocation, readArticleRegion } from '../shared/article-region.js';
import type { DocumentInfo, ReadingSide, RegionAction } from '../shared/types.js';
import { captureArticleArea } from './article-raster.js';
import { RegionPicker } from './region-picker.js';
import { api, readerLabel as label } from './ui.js';

const units = 10_000;
const fraction = (offset: number, length: number) => Math.max(0, Math.min(units, Math.round(offset / length * units)));

export function articleRegionPicker(doc: DocumentInfo, page: number, pages: HTMLElement, original: HTMLElement,
  translated: HTMLElement, signal: AbortSignal, deliver: RegionAction, canContinue?: (id: string) => boolean): RegionPicker {
  const sheets = { source: original, translation: translated };
  const rows = (sheet: HTMLElement) => Array.from(sheet.querySelectorAll<HTMLElement>('.web-reading-row'));
  const columns = { source: rows(original), translation: rows(translated) };
  const indices = new Map(columns.source.map((row, index) => [row.dataset.anchor!, index]));

  // Paragraph boundaries survive reflow. Include the intervening whitespace in each row's band.
  function band(side: ReadingSide, index: number) {
    const rows = columns[side], sheet = sheets[side].getBoundingClientRect();
    const top = index ? rows[index].getBoundingClientRect().top : sheet.top;
    const bottom = rows[index + 1]?.getBoundingClientRect().top ?? sheet.bottom;
    return { top, height: Math.max(1, bottom - top) };
  }

  function verticalPoint(side: ReadingSide, y: number) {
    const rows = columns[side];
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) {
      const middle = Math.ceil((lo + hi) / 2);
      if (rows[middle].getBoundingClientRect().top <= y) lo = middle;
      else hi = middle - 1;
    }
    const row = band(side, lo);
    return { id: rows[lo].dataset.anchor!, offset: fraction(y - row.top, row.height) };
  }

  return new RegionPicker({
    outer: pages, plane: pages,
    point(x, y) {
      const pane = pages.getBoundingClientRect();
      return { x: x - pane.left, y: y - pane.top };
    },
    anchor(start, end) {
      const pane = pages.getBoundingClientRect();
      const left = pane.left + Math.min(start.x, end.x), right = pane.left + Math.max(start.x, end.x);
      const includes = (sheet: HTMLElement) => {
        const rect = sheet.getBoundingClientRect();
        return rect.width > 0 && right > rect.left && left < rect.right;
      };
      const source = includes(original), translation = includes(translated);
      if (!source && !translation) return;
      const side = source ? 'source' : 'translation', both = source && translation;
      const width = both ? pane : sheets[side].getBoundingClientRect();
      const first = verticalPoint(side, pane.top + Math.min(start.y, end.y));
      const last = verticalPoint(side, pane.top + Math.max(start.y, end.y));
      return [both ? 'both' : side, first.id, last.id, fraction(left - width.left, width.width),
        first.offset, fraction(right - width.left, width.width), last.offset].join('-');
    },
    rect(id) {
      const location = readArticleRegion(id) ?? readArticleLocation(id);
      if (!location) return null;
      const first = indices.get(location.start), last = indices.get(location.end);
      if (first === undefined || last === undefined) return null;
      const side = location.side === 'both' ? (original.offsetWidth ? 'source' : 'translation') : location.side;
      const frame = (location.side === 'both' ? pages : sheets[side]).getBoundingClientRect();
      if (!frame.width || !sheets[side].offsetWidth) return null;
      const a = band(side, first), b = band(side, last);
      const top = a.top + a.height * location.top / units, bottom = b.top + b.height * location.bottom / units;
      return new DOMRect(frame.x + frame.width * location.left / units, top,
        frame.width * (location.right - location.left) / units, bottom - top);
    },
    async capture(id, rect, signal) {
      const saved = readArticleRegion(id), location = saved ?? readArticleLocation(id)!;
      const side: ReadingSide = location.side === 'translation' ? 'translation' : 'source';
      if (saved) {
        const crop = await api('article.capture.get', { docId: doc.id, page, anchor: id });
        return { ...crop, id, side };
      }
      const crop = await captureArticleArea(pages, rect, signal);
      signal.throwIfAborted();
      const name = location.side === 'both' ? label('Bilingual screenshot', '双语截图') :
        side === 'translation' ? label('Translation screenshot', '译文截图') : label('Original screenshot', '原文截图');
      const section = doc.book?.sections[page - 1]?.title ?? doc.title;
      const caption = section.slice(0, 450) + ' · ' + name;
      const { anchor } = await api('article.capture.save', { docId: doc.id, page, location: id, ...crop, label: caption });
      return { ...crop, id: anchor, side, label: caption };
    }
  }, page, signal, deliver, canContinue);
}
