import type { PDFPageProxy, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { box, type Box, type PageGraphics, type PageLayout, type Passage, type PassageRole } from './model.js';
import { sampleAreas, sampleDigest, sampleWindow } from './sample.js';
import { alignSample } from './alignment.js';
import regions from './paper-regions.json' with { type: 'json' };

type Viewport = ReturnType<PDFPageProxy['getViewport']>;
interface Run {
  index: number;
  text: TextItem;
  baseX: number;
  baseY: number;
  size: number;
  box: Box;
}
interface Line {
  text: string;
  runs: Run[];
  box: Box;
  size: number;
}

function union(boxes: Box[]): Box {
  const left = Math.min(...boxes.map(b => b.x));
  const top = Math.min(...boxes.map(b => b.y));
  return box(left, top, Math.max(...boxes.map(b => b.x + b.width)) - left,
    Math.max(...boxes.map(b => b.y + b.height)) - top);
}

function collectRuns(content: TextContent, view: Viewport): Run[] {
  const result: Run[] = [];
  const [a, b, c, d] = view.transform;
  let nativeIndex = 0;
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const index = nativeIndex++;
    if (!item.str) continue;
    const [m, n, u, v, x, y] = item.transform.map(Number);
    const [baseX, baseY] = view.convertToViewportPoint(x, y);
    const size = Math.max(0.1, Math.hypot(a * u + c * v, b * u + d * v));
    const style = content.styles[item.fontName];
    const angle = Math.atan2(b * m + d * n, a * m + c * n) + (style?.vertical ? Math.PI / 2 : 0);
    const cx = Math.cos(angle), cy = Math.sin(angle);
    const rise = size * (style?.ascent ?? 0.8);
    const x0 = baseX + cy * rise, y0 = baseY - cx * rise;
    const advance = (style?.vertical ? item.height : item.width) * Math.hypot(a, b);
    const xs = [x0, x0 + cx * advance, x0 - cy * size, x0 + cx * advance - cy * size];
    const ys = [y0, y0 + cy * advance, y0 + cx * size, y0 + cy * advance + cx * size];
    result.push({ index, text: item, baseX, baseY, size, box: box(Math.min(...xs), Math.min(...ys),
      Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) });
  }
  return result;
}

function readLines(runs: Run[]): Line[] {
  const result: Line[] = [];
  let row: Run[] = [];
  const end = () => {
    if (!row.length) return;
    const parts: string[] = [];
    for (let i = 0; i < row.length; i++) {
      const run = row[i], before = row[i - 1];
      if (before && run.box.x - before.box.x - before.box.width > run.size * 0.13
        && !/\s$/.test(before.text.str) && !/^\s/.test(run.text.str)) parts.push(' ');
      parts.push(run.text.str);
    }
    const text = parts.join('').trim();
    if (text) result.push({ text, runs: row, box: union(row.map(r => r.box)), size: Math.max(...row.map(r => r.size)) });
    row = [];
  };
  for (const run of runs) {
    const before = row.at(-1);
    if (before && (Math.abs(run.baseY - before.baseY) > Math.max(2.5, run.size * 0.39)
      || run.box.x - before.box.x - before.box.width > run.size * 2.7
      || before.box.x - run.box.x > run.size * 0.67)) end();
    row.push(run);
    if (run.text.hasEOL) end();
  }
  end();
  return result;
}

function prose(lines: Line[]): string {
  return lines.map(line => line.text).join('\n')
    .replace(/\b(self|cross|fine|multi|single|real|large|fixed|end)-\n(?=\p{Ll})/gu, '$1-')
    .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1')
    .replace(/\s+/g, ' ').replace(/([1-3])\s*○/g, (_, digit: string) => '①②③'[Number(digit) - 1]).trim();
}

function annotated(runs: Run[], translations: Readonly<Record<string, string>>): PageLayout {
  return {
    registered: true,
    window: sampleWindow,
    passages: sampleAreas.map(area => {
      const r = area.box;
      const matches = runs.filter(s => s.baseX >= r.x - 1 && s.baseX <= r.x + r.width + 1
        && s.baseY >= r.y && s.baseY < r.y + r.height);
      const text = prose(readLines(matches)), translation = translations[area.id];
      return { ...area, translation, text, sentencePairs: alignSample(area.id, text, translation),
        indices: matches.map(s => s.index), fontSize: 10.4 };
    })
  };
}

function dominantSize(lines: Line[]): number {
  const histogram = new Map<number, number>();
  for (const line of lines) {
    const size = Math.max(1, Math.round(line.size * 2) / 2);
    histogram.set(size, (histogram.get(size) ?? 0) + Math.min(125, line.text.length));
  }
  return [...histogram].sort((one, two) => two[1] - one[1])[0]?.[0] ?? 10;
}

/** Printed reading order and glyph geometry, without building a translated page. */
export function printedLines(content: TextContent, view: Viewport) {
  const lines = readLines(collectRuns(content, view));
  return { lines, bodySize: dominantSize(lines) };
}

function column(r: Box, width: number): number {
  if (r.x > width * 0.47) return 2;
  if (r.x + r.width < width * 0.55) return 1;
  return 0;
}

function adjacent(first: Line, previous: Line, next: Line): boolean {
  const gap = next.box.y - previous.box.y;
  const size = Math.max(previous.size, next.size);
  if (gap <= size * 0.45 || gap >= size * 1.6 || Math.abs(previous.size - next.size) > size * 0.23) return false;
  if (Math.abs(first.box.x - next.box.x) > size * 1.6) return false;
  return !(next.box.x - previous.box.x > size * 0.68 && /[.!?\u3002\uff01\uff1f]$/.test(previous.text));
}

/** Test whether consecutive printed lines flow together in the same typeface. */
export function sameTextFlow(previous: Line | undefined, next: Line | undefined): boolean {
  return Boolean(previous && next && previous.runs[0].text.fontName === next.runs[0].text.fontName &&
    adjacent(previous, previous, next));
}

interface FigureCaption { id: string; label: string; illustration?: Box }
const captionStart = /^(Figure|Fig\.?|Table|\u56fe|\u8868)\s*(\d+[a-z]?)\s*[.:\uff1a\uff0e]/i;

function overlapsHorizontally(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}

/** Join collinear cell borders, then find repeated rules spanning the same columns. */
function ruledAreas(rules: Box[], captions: Box[], size: number): Box[] {
  const rows = Map.groupBy(rules, r => Math.round(r.y + r.height / 2));
  const joined: Box[] = [];
  for (const row of rows.values()) {
    let span: Box | undefined;
    for (const r of row.sort((a, b) => a.x - b.x)) {
      if (span && r.x <= span.x + span.width + 1.5) span = union([span, r]);
      else { if (span) joined.push(span); span = r; }
    }
    if (span) joined.push(span);
  }
  const columns = Map.groupBy(joined.filter(r => r.width >= size * 3), r =>
    Math.round(r.x) + ':' + Math.round(r.x + r.width));
  const areas: Box[] = [];
  for (const column of columns.values()) {
    let group: Box[] = [];
    for (const r of column.sort((a, b) => a.y - b.y)) {
      const prev = group.at(-1);
      if (prev && (r.y - prev.y > size * 10 || captions.some(c => c.y > prev.y && c.y < r.y && overlapsHorizontally(c, r)))) {
        if (group.length >= 3) areas.push(union(group));
        group = [];
      }
      group.push(r);
    }
    if (group.length >= 3) areas.push(union(group));
  }
  return areas;
}

function nearestArtwork(caption: Box, candidates: Box[], size: number): Box | undefined {
  const nearby = candidates.filter(r => overlapsHorizontally(r, caption)).map(r => {
    const above = caption.y - r.y - r.height, below = r.y - caption.y - caption.height;
    return { r, above: above > below, gap: Math.max(above, below) };
  }).filter(item => item.gap >= -size * 0.45 && item.gap <= size * 2.5).sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
  const closest = nearby[0];
  if (closest) return union(nearby.filter(item => item.above === closest.above && Math.abs(item.gap - closest.gap) < size)
    .map(item => item.r));
}

function displayedMath(line: Line): boolean {
  // Keep ordinary sentences containing inline math in their paragraphs.
  const words = line.text.match(/\p{L}{3,}/gu) ?? [];
  return words.length <= 2 && !/\p{L}{2,}\s+\p{L}{2,}/u.test(line.text)
    && /[\p{Sm}^_{}]|\p{L}\(\p{L}\)/u.test(line.text);
}

function identifyCaptions(lines: Line[], view: Viewport, size: number, graphics?: PageGraphics, tables: Box[] = []): Map<Line, FigureCaption> {
  const result = new Map<Line, FigureCaption>();
  const proseLines = lines.filter(line => line.text.length >= 18 && line.size >= size * 0.83);
  for (const [index, caption] of lines.entries()) {
    const match = caption.text.match(captionStart);
    if (!match) continue;
    const isTable = /^(Table|\u8868)/i.test(match[1]);
    const entry: FigureCaption = { id: (isTable ? 'table-' : 'figure-') + match[2], label: (isTable ? 'Table ' : 'Figure ') + match[2] };
    if (graphics) {
      const printedCaption = [caption];
      for (let i = index + 1; i < lines.length && !captionStart.test(lines[i].text)
        && adjacent(caption, printedCaption.at(-1)!, lines[i]); i++) printedCaption.push(lines[i]);
      const candidates = isTable ? tables : graphics.forms;
      entry.illustration = nearestArtwork(caption.box, candidates, size)
        ?? nearestArtwork(union(printedCaption.map(line => line.box)), candidates, size);
      if (entry.illustration) { result.set(caption, entry); continue; }
    }
    const band = column(caption.box, view.width);
    const neighbors = proseLines.filter(line => line !== caption && (!band || column(line.box, view.width) === band));
    const above = neighbors.filter(line => line.box.y + line.box.height < caption.box.y - 2);
    const start = Math.max(view.height * 0.032, caption.box.y - view.height * 0.42,
      ...above.map(line => line.box.y + line.box.height + 3));
    const height = caption.box.y - start - 2;
    if (!isTable && height > size * 1.5) {
      const x = Math.min(caption.box.x, ...neighbors.map(line => line.box.x));
      const right = Math.max(caption.box.x + caption.box.width, ...neighbors.map(line => line.box.x + line.box.width));
      entry.illustration = box(x, start, right - x, height);
    }
    result.set(caption, entry);
  }
  return result;
}

function automatic(lines: Line[], view: Viewport, page: number, graphics?: PageGraphics): Passage[] {
  const size = dominantSize(lines);
  const tables = graphics ? ruledAreas(graphics.horizontalRules, lines.filter(l => captionStart.test(l.text)).map(l => l.box), size) : [];
  const captions = identifyCaptions(lines, view, size, graphics, tables);
  const diagrams = [...tables, ...[...captions.values()].flatMap(entry => entry.illustration ? [entry.illustration] : [])];
  const groups: { lines: Line[]; role: PassageRole; caption?: FigureCaption }[] = [];
  for (const line of lines) {
    const caption = captions.get(line);
    const mx = line.box.x + line.box.width / 2, my = line.box.y + line.box.height / 2;
    if (!caption && diagrams.some(r => r.x < mx && mx < r.x + r.width && r.y < my && my < r.y + r.height)) continue;
    if (graphics && !caption && displayedMath(line)) continue;
    if (!caption && (/^[\s\d.,+−°–%()]+$/u.test(line.text) || (line.size < size * 0.65 && line.text.length < 24))) continue;
    const isHeading = line.text.length < 110 && (line.size > size * 1.18 || /^\d+(?:\.\d+)*\s+\p{Lu}/u.test(line.text));
    const previous = groups.at(-1);
    if (previous && !caption && !isHeading && previous.role !== 'heading'
      && adjacent(previous.lines[0], previous.lines[previous.lines.length - 1], line)) {
      previous.lines.push(line);
    } else groups.push({ lines: [line], role: caption ? 'caption' : isHeading ? 'heading' : 'paragraph', caption });
  }
  const used = new Set<string>();
  return groups.map(({ lines: rows, role, caption }, index) => {
    const area = union(rows.map(line => line.box));
    const text = prose(rows);
    const id = caption && !used.has(caption.id) ? caption.id : `p${page}-b${index + 1}`;
    used.add(id);
    const zh = typeof navigator !== 'undefined' && /^zh(?:-|$)/i.test(navigator.language || '');
    return { id, text, role, label: caption?.label ?? (role === 'heading' ? text : zh ? `第 ${page} 页 · 第 ${index + 1} 段` : `Page ${page} · Paragraph ${index + 1}`),
      illustration: caption?.illustration, indices: rows.flatMap(line => line.runs.map(r => r.index)), fontSize: rows[0].size,
      box: box(Math.max(0, area.x - 0.6), Math.max(0, area.y - 0.8), area.width + 1.2, area.height + 1.8) };
  });
}

export function extractLayout(content: TextContent, view: Viewport, page: number, digest: string,
  translations: Readonly<Record<string, string>> = {}, graphics?: PageGraphics, tagged?: TextContent): PageLayout {
  const runs = collectRuns(content, view);
  if (page === 6 && digest === sampleDigest) return annotated(runs, translations);
  const window = box(0, 0, view.width, view.height);
  const lines = readLines(runs);
  const previous = automatic(lines, view, page);
  const registered = (regions as unknown as Record<number, Region[]>)[page];
  const sourceOnly: Passage[] = [];
  let passages: Passage[];
  if (digest !== sampleDigest || !registered) {
    // Marked and unmarked text streams can split words at different points.
    // Match them in page coordinates, including contiguous cells sharing one run.
    const taggedRows = Map.groupBy(tagged ? collectRuns(tagged, view) : [], run => Math.round(run.baseY));
    const proseRuns = taggedRows.size ? runs.filter(run => !taggedRows.get(Math.round(run.baseY))?.some(art =>
      overlapsHorizontally(art.box, run.box))) : runs;
    passages = automatic(proseRuns === runs ? lines : readLines(proseRuns), view, page, graphics ?? { forms: [], horizontalRules: [] });
    // Imported caches contain only an ID and a translation. Reuse a legacy ID
    // only for its original text; old table/equation entries can then be ignored.
    const byStart = new Map(previous.map(p => [p.indices[0], p]));
    for (const p of passages) {
      const old = byStart.get(p.indices[0]);
      p.id = old?.text === p.text ? old.id : `p${page}-r${p.indices[0]}-${p.indices.at(-1)}`;
    }
  } else passages = registered.map(([id, role, bounds, fontSize, ranges, text, picture], index) => {
    const indices: number[] = [];
    for (let i = 0; i < ranges.length; i += 2) {
      for (let r = ranges[i]; r <= ranges[i + 1]; r++) indices.push(r);
    }
    const zh = typeof navigator !== 'undefined' && /^zh(?:-|$)/i.test(navigator.language || '');
    const label = role === 'caption' ? text.split('.')[0] : role === 'heading' ? text : zh ? `第 ${page} 页 · 第 ${index + 1} 段` : `Page ${page} · Paragraph ${index + 1}`;
    return { id, role, box: box(...bounds), fontSize, indices, text, label, translation: translations[id],
      illustration: picture && box(...picture) };
  });
  const aliases = new Map<string, string[]>();
  const owners = new Map(passages.flatMap(p => p.indices.map(index => [index, p.id] as const)));
  for (const old of previous) {
    const overlap = new Map<string, number>();
    for (const index of old.indices) {
      const id = owners.get(index);
      if (id) overlap.set(id, (overlap.get(id) ?? 0) + 1);
    }
    if (overlap.size) aliases.set(old.id, [...overlap].sort((a, b) => b[1] - a[1]).map(([id]) => id));
    else if (digest !== sampleDigest) sourceOnly.push(old);
  }
  return { window, passages, sourceOnly, registered: digest === sampleDigest && Boolean(registered), aliases };
}

type Bounds = [x: number, y: number, width: number, height: number];
type Region = [id: string, role: PassageRole, bounds: Bounds, fontSize: number, runRanges: number[], text: string, picture?: Bounds];
