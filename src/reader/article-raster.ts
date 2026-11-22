import { regionCanvas, regionPng } from './region-png.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
// Resolved values preserve article zoom, line breaking, table layout and inline formatting in the SVG image.
const articleStyles = ('display box-sizing width height min-width max-width min-height max-height margin padding border-top border-right border-bottom border-left border-radius ' +
  'background-color color font-family font-size font-style font-weight font-variant font-kerning line-height letter-spacing word-spacing ' +
  'text-align text-indent text-decoration text-underline-offset text-transform white-space text-wrap-style overflow-wrap word-break ' +
  'vertical-align direction unicode-bidi list-style-type list-style-position tab-size border-collapse border-spacing table-layout ' +
  'overflow-x overflow-y visibility').split(' ');

function intersection(a: DOMRect, b: DOMRect): DOMRect | undefined {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  if (right > left && bottom > top) return new DOMRect(left, top, right - left, bottom - top);
}

function contains(outer: DOMRect, inner: DOMRect): boolean {
  return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
}

function overflowClip(area: DOMRect, element: Element, style: CSSStyleDeclaration): DOMRect | undefined {
  const clipX = style.overflowX !== 'visible', clipY = style.overflowY !== 'visible';
  if (!clipX && !clipY) return area;
  const rect = element.getBoundingClientRect();
  return intersection(area, new DOMRect(clipX ? rect.left + element.clientLeft : area.left,
    clipY ? rect.top + element.clientTop : area.top, clipX ? element.clientWidth : area.width, clipY ? element.clientHeight : area.height));
}

/** Subdivide at the crop edges so a tall paragraph needs only a few range measurements per visible line. */
function textInside(node: Text, clip: DOMRect, range: Range): string {
  let result = '', previous = 0;
  function visit(start: number, end: number): void {
    range.setStart(node, start); range.setEnd(node, end);
    const rect = range.getBoundingClientRect();
    if (!intersection(clip, rect)) return;
    if (!contains(clip, rect)) {
      let middle = start + Math.floor((end - start) / 2);
      if (middle > start && /[\uDC00-\uDFFF]/.test(node.data[middle])) middle++;
      if (middle > start && middle < end) { visit(start, middle); visit(middle, end); return; }
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) return;
    }
    if (previous !== start && result) result += ' ';
    result += node.substringData(start, end - start);
    previous = end;
  }
  if (node.length) visit(0, node.length);
  return result;
}

function position(element: HTMLElement, rect: DOMRect, origin: DOMRect): void {
  Object.assign(element.style, { position: 'absolute', boxSizing: 'border-box', margin: '0',
    left: rect.left - origin.left + 'px', top: rect.top - origin.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px' });
}

interface Figure { image: HTMLImageElement; rect: DOMRect; clip: DOMRect }

/** The reader lays out each illustration at its intrinsic aspect ratio. Reuse its already-decoded, same-origin pixels. */
function copyBlock(source: Element, clip: DOMRect | undefined, range: Range, text: string[], figures: Figure[]): Element {
  const owner = source.ownerDocument, style = owner.defaultView!.getComputedStyle(source);
  const image = source.localName === 'img' ? source as HTMLImageElement : undefined;
  // Cloning an IMG with src can start another request even in a detached document.
  const copy = image ? owner.createElement('span') : source.cloneNode(false) as HTMLElement | MathMLElement;
  for (const property of articleStyles) copy.style.setProperty(property, style.getPropertyValue(property));
  const visible = clip && style.visibility === 'visible' && style.display !== 'none' ? overflowClip(clip, source, style) : undefined;
  if (image) {
    const rect = image.getBoundingClientRect(), inside = visible && intersection(visible, rect);
    if (inside) figures.push({ image, rect, clip: inside });
    return copy;
  }
  const formula = source.getAttribute('data-article-text');
  const fullFormula = visible && formula && contains(visible, source.getBoundingClientRect());
  if (fullFormula) text.push(formula!);
  // Preserve a scrolled code block or table's internal offset in the detached layout.
  let contents: Element = copy;
  if (source.scrollLeft || source.scrollTop) {
    contents = owner.createElement('div');
    (contents as HTMLElement).style.transform = `translate(${-source.scrollLeft}px, ${-source.scrollTop}px)`;
    copy.append(contents);
  }
  const textClip = fullFormula || source.localName === 'annotation' ? undefined : visible;
  for (const child of source.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) contents.append(copyBlock(child as Element, textClip, range, text, figures));
    else if (child.nodeType === Node.TEXT_NODE) {
      contents.append(child.cloneNode());
      if (textClip) text.push(textInside(child as Text, textClip, range));
    }
  }
  return copy;
}

function decode(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    image.decode().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function captureArticleArea(root: HTMLElement, area: DOMRect, signal: AbortSignal): Promise<{ image: string; regionText: string }> {
  signal.throwIfAborted();
  if (![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width <= 0 || area.height <= 0) {
    throw new Error('Choose an area of the article to capture.');
  }
  const owner = root.ownerDocument, view = owner.defaultView!;
  const { canvas } = regionCanvas(owner, area.width, area.height);
  const layer = owner.createElement('div');
  layer.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:white';
  for (let ancestor: HTMLElement | null = root; ancestor; ancestor = ancestor.parentElement) {
    const color = view.getComputedStyle(ancestor).backgroundColor;
    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { layer.style.backgroundColor = color; break; }
  }
  const range = owner.createRange(), paragraphs: string[] = [], figures: Figure[] = [];
  for (const sheet of root.querySelectorAll<HTMLElement>('.web-reading-sheet')) {
    const bounds = sheet.getBoundingClientRect();
    let clip = intersection(area, bounds);
    for (let parent = sheet.parentElement; parent && clip; parent = parent.parentElement) {
      clip = overflowClip(clip, parent, view.getComputedStyle(parent));
    }
    if (!clip) continue;
    const frame = owner.createElement('div');
    position(frame, clip, area);
    frame.style.overflow = 'hidden';
    layer.append(frame);
    const paper = owner.createElement('div'), style = view.getComputedStyle(sheet);
    position(paper, bounds, clip);
    Object.assign(paper.style, { backgroundColor: style.backgroundColor, border: style.border, borderRadius: style.borderRadius });
    frame.append(paper);
    for (const block of sheet.querySelectorAll<HTMLElement>(':scope > .web-reading-row > :first-child, :scope > .web-reading-source, :scope > .web-reading-empty')) {
      const box = block.getBoundingClientRect();
      if (!intersection(clip, box)) continue;
      const text: string[] = [];
      const copy = copyBlock(block, clip, range, text, figures) as HTMLElement;
      position(copy, box, clip);
      frame.append(copy);
      const paragraph = text.join('').replace(/\s+/gu, ' ').trim();
      if (paragraph) paragraphs.push(paragraph);
    }
  }
  // Keep the SVG viewport and backing bitmap bounded to the crop even for a very long book chapter.
  const svg = owner.createElementNS(svgNamespace, 'svg'), object = owner.createElementNS(svgNamespace, 'foreignObject');
  svg.setAttribute('width', String(canvas.width)); svg.setAttribute('height', String(canvas.height));
  svg.setAttribute('viewBox', `0 0 ${area.width} ${area.height}`); svg.setAttribute('preserveAspectRatio', 'none');
  object.setAttribute('width', String(area.width)); object.setAttribute('height', String(area.height));
  object.append(layer); svg.append(object);
  const snapshot = owner.createElement('img');
  snapshot.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await Promise.all([decode(snapshot, signal), ...figures.filter(({ image }) => !image.complete || !image.naturalWidth)
    .map(({ image }) => decode(image, signal))]);
  signal.throwIfAborted();
  const context = canvas.getContext('2d')!;
  context.drawImage(snapshot, 0, 0);
  context.scale(canvas.width / area.width, canvas.height / area.height);
  context.translate(-area.left, -area.top);
  for (const { image, rect, clip } of figures) {
    context.save();
    context.beginPath(); context.rect(clip.left, clip.top, clip.width, clip.height); context.clip();
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    context.restore();
  }
  return { image: regionPng(canvas), regionText: paragraphs.join('\n\n').slice(0, 100_000) };
}
