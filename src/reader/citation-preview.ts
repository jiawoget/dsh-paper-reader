import { bibliography, citationGroups, type CitationGroup } from './bibliography.js';
import type { PdfDocument } from './pdf-view.js';
import { el, readerLabel as t } from './ui.js';

const prose = '.selection-prose, .selection-excerpt blockquote, .selection-counterpart p, .selection-main .meaning, .selection-main .selection-context';
const pdfText = '.pdf-native-text, .pdf-translated-text';
interface Target { node: HTMLElement; group: CitationGroup; ranges?: Range[] }
type RunIndex = WeakMap<Element, { range: Range; target: Target }[]>;

/** PDF selection and source navigation depend on their original, unsplit text nodes.
 * Give each printed group a keyboard target beside the text layer and hit-test its actual glyphs. */
export function installCitationPreviews(currentPaper: () => PdfDocument | undefined): void {
  const popup = el('aside', 'citation-preview');
  popup.id = 'paper-citation-preview';
  popup.setAttribute('role', 'tooltip');
  popup.hidden = true;
  document.body.append(popup);
  const anchors = new WeakMap<Element, Target>();
  let runs: RunIndex = new WeakMap();
  let pdfTargets = new Set<Target>(), active: Target | undefined, hovered: Target | undefined, focused: Target | undefined;
  let pointer: { x: number; y: number } | undefined;
  let activePaper: PdfDocument | undefined;
  let frame = 0;

  function positionPopup(): void {
    if (!active) return;
    const rect = active.ranges?.[0].getBoundingClientRect() ?? active.node.getBoundingClientRect();
    const { width, height } = popup.getBoundingClientRect();
    popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px';
    const above = rect.top - height - 7;
    const top = rect.bottom + height + 8 > innerHeight && above >= 4 ? above : Math.min(rect.bottom + 6, innerHeight - height - 6);
    popup.style.top = Math.max(4, top) + 'px';
  }
  function show(target?: Target): void {
    const paper = currentPaper();
    if (target === active && activePaper === paper) return;
    if (active) { active.node.removeAttribute('aria-describedby'); active.node.classList.remove('citation-active'); }
    active = target;
    activePaper = paper;
    if (!target || !paper || !target.node.isConnected) { active = undefined; popup.hidden = true; return; }
    target.node.setAttribute('aria-describedby', popup.id);
    target.node.classList.add('citation-active');
    const heading = el('header', '', target.group.numbers.length === 1 ? t('Reference', '参考文献') : t('References', '参考文献'));
    popup.replaceChildren(heading, el('p', 'citation-lookup', t('Looking up the bibliography…', '正在查找参考文献…')));
    popup.hidden = false;
    positionPopup();
    void bibliography(paper).then(index => {
      if (active !== target || paper !== currentPaper() || !target.node.isConnected) return;
      const list = el('ul');
      for (const number of target.group.numbers) {
        const record = index.get(number), row = el('li');
        row.append(el('span', 'citation-index', '[' + number + ']'),
          el('span', record?.title ? '' : 'citation-entry', record?.title ?? record?.entry ?? t('No matching bibliography entry.', '未找到对应的参考文献条目。')));
        list.append(row);
      }
      popup.replaceChildren(heading, list);
      positionPopup();
    }).catch(() => {
      if (active === target) { popup.replaceChildren(heading, el('p', '', t('Could not read the bibliography.', '无法读取参考文献列表。'))); positionPopup(); }
    });
  }
  function label(group: CitationGroup): string { return (group.numbers.length === 1 ? t('Reference ', '参考文献 ') : t('References ', '参考文献 ')) + group.numbers.join(', '); }
  function markProse(root: Element): void {
    if (!currentPaper()) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node; (node = walker.nextNode());) {
      if (node instanceof Text && !node.parentElement?.closest('a,button,pre,code,math,.katex,.paper-citation,[contenteditable=true]')) nodes.push(node);
    }
    for (const node of nodes) {
      const groups = citationGroups(node.data);
      if (!groups.length) continue;
      const replacement = document.createDocumentFragment();
      let from = 0;
      for (const group of groups) {
        const mark = el('span', 'paper-citation', group.text);
        mark.tabIndex = 0;
        mark.setAttribute('role', 'button');
        mark.ariaLabel = label(group);
        anchors.set(mark, { node: mark, group });
        replacement.append(node.data.slice(from, group.from), mark);
        from = group.to;
      }
      replacement.append(node.data.slice(from));
      node.replaceWith(replacement);
    }
  }
  function markPdf(elements: HTMLElement[], previousRuns: RunIndex): void {
    const parts: { node: Text; from: number; to: number }[] = [];
    let text = '';
    for (const element of elements) {
      const node = element.firstChild;
      if (!(node instanceof Text)) continue;
      parts.push({ node, from: text.length, to: text.length + node.length });
      text += node.data;
    }
    for (const group of citationGroups(text)) {
      const ranges: Range[] = [];
      for (const part of parts) {
        if (part.to <= group.from || part.from >= group.to) continue;
        const range = document.createRange();
        range.setStart(part.node, Math.max(0, group.from - part.from));
        range.setEnd(part.node, Math.min(part.node.length, group.to - part.from));
        if (!range.collapsed) ranges.push(range);
      }
      const first = ranges[0]?.getBoundingClientRect();
      const plane = elements[0]?.closest<HTMLElement>('.pdf-coordinate-plane, .pdf-sheet, #original, #translated');
      if (!plane || !first?.width || !first.height) continue;
      const box = plane.getBoundingClientRect(), scale = box.width / plane.offsetWidth;
      if (!scale) continue;
      // Keep the same keyboard target when typesetting or resizing moves its glyphs.
      const start = ranges[0];
      let target = previousRuns.get(start.startContainer.parentElement!)?.find(({ range, target }) =>
        range.startContainer === start.startContainer && range.startOffset === start.startOffset && target.group.text === group.text)?.target;
      if (!target) {
        const button = el('button', 'pdf-citation-focus');
        button.type = 'button';
        button.ariaLabel = label(group);
        target = { node: button, group };
        anchors.set(button, target);
        plane.append(button);
      }
      target.ranges = ranges;
      const key = target.node;
      Object.assign(key.style, { left: (first.left - box.left) / scale + 'px', top: (first.top - box.top) / scale + 'px',
        width: first.width / scale + 'px', height: first.height / scale + 'px' });
      pdfTargets.add(target);
      for (const range of ranges) {
        const owner = range.startContainer.parentElement!;
        const entries = runs.get(owner) ?? [];
        entries.push({ range, target });
        runs.set(owner, entries);
      }
    }
  }
  function scanPdf(): void {
    frame = 0;
    const previousTargets = pdfTargets, previousRuns = runs;
    pdfTargets = new Set();
    runs = new WeakMap();
    if (currentPaper()) {
      for (const layer of document.querySelectorAll('.pdf-native-text')) {
        const groups = new Map<string, HTMLElement[]>();
        for (const element of layer.querySelectorAll<HTMLElement>('[data-block-id]')) {
          const id = element.dataset.blockId!;
          const parts = groups.get(id) ?? [];
          parts.push(element);
          groups.set(id, parts);
        }
        for (const parts of groups.values()) markPdf(parts, previousRuns);
      }
      for (const element of document.querySelectorAll<HTMLElement>('.pdf-translated-text:not([hidden])')) markPdf([element], previousRuns);
    }
    for (const target of previousTargets) if (!pdfTargets.has(target)) target.node.remove();
    refreshPreview();
    if (active) positionPopup();
  }
  const schedulePdf = () => { if (!frame) frame = requestAnimationFrame(scanPdf); };
  const observer = new MutationObserver(changes => {
    const pending = new Set<Element>();
    for (const change of changes) {
      if (change.type === 'attributes') { schedulePdf(); continue; }
      const parent = change.target instanceof Element ? change.target : change.target.parentElement;
      const enclosing = parent?.closest(prose);
      if (enclosing) pending.add(enclosing);
      if (parent?.closest(pdfText)) schedulePdf();
      for (const node of change.addedNodes) {
        if (!(node instanceof Element) || node === popup || node.classList.contains('pdf-citation-focus')) continue;
        if (node.matches(prose)) pending.add(node);
        for (const root of node.querySelectorAll(prose)) pending.add(root);
        if (node.matches(pdfText) || node.querySelector(pdfText)) schedulePdf();
      }
    }
    for (const root of pending) markProse(root);
    if (active && (!active.node.isConnected || currentPaper() !== activePaper)) { hovered = focused = undefined; show(); }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributeFilter: ['data-focus', 'data-active-block'] });
  const sizes = new ResizeObserver(schedulePdf);
  for (const pane of document.querySelectorAll('#original, #translated')) sizes.observe(pane);
  function refreshPreview(under = pointer && document.elementFromPoint(pointer.x, pointer.y)): void {
    if (focused && !focused.node.isConnected) focused = undefined;
    if (!under || !popup.contains(under)) {
      hovered = under ? anchors.get(under.closest('.paper-citation, .pdf-citation-focus') ?? under) : undefined;
      const run = under?.closest('.pdf-translated-text, .pdf-native-text [data-block-id]');
      if (!hovered && run && pointer) {
        const { x, y } = pointer;
        hovered = runs.get(run)?.find(({ range }) => Array.from(range.getClientRects()).some(box =>
          x >= box.left && x <= box.right && y >= box.top && y <= box.bottom))?.target;
      }
    }
    show(hovered ?? focused);
  }
  document.addEventListener('pointermove', event => {
    pointer = event.buttons ? undefined : { x: event.clientX, y: event.clientY };
    refreshPreview(pointer && event.target instanceof Element ? event.target : null);
  });
  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) { pointer = undefined; refreshPreview(); }
  });
  document.addEventListener('focusin', event => {
    focused = event.target instanceof Element ? anchors.get(event.target) : undefined;
    if (focused) { pointer = undefined; hovered = undefined; }
    show(focused ?? hovered);
  });
  document.addEventListener('focusout', event => {
    if (focused?.node === event.target) { focused = undefined; show(hovered); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); event.stopImmediatePropagation();
      pointer = hovered = focused = undefined; show();
    } else if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && anchors.has(event.target)) {
      event.preventDefault(); focused = anchors.get(event.target); show(focused);
    }
  }, true);
  document.addEventListener('scroll', event => {
    if (!popup.contains(event.target as Node)) {
      refreshPreview();
      if (active) positionPopup();
    }
  }, true);
  schedulePdf();
}
