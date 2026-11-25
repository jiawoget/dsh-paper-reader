import type { OpenDocument } from '../shared/types.js';
import { bibliography, citationGroups, type BibliographyEntry, type CitationGroup } from './bibliography.js';
import { dedupeCitePdfLinks } from './pdf/links.js';
import type { PdfDocument } from './pdf-view.js';
import { api, copyText, el, readerLabel as t, safeWeb, toast, webPageError } from './ui.js';

const prose = '.selection-prose, .selection-excerpt blockquote, .selection-counterpart p, .selection-main .meaning, .selection-main .selection-context';
const pdfText = '.pdf-native-text, .pdf-translated-text';
interface Target { node: HTMLElement; group: CitationGroup; ranges?: Range[] }
type RunIndex = WeakMap<Element, { range: Range; target: Target }[]>;
interface CitationActions {
  jumpToPage(page: number): void | Promise<void>;
  openDocument(opened: OpenDocument): Promise<void>;
}

function compactAuthors(authors?: string): string | undefined {
  if (!authors) return;
  const parts = authors.split(/\s*,\s*|\s+and\s+|\s*&\s*/iu).map(s => s.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[0] + ' et al.' : authors;
}

function entryOpenUrl(record: BibliographyEntry): string | undefined {
  return safeWeb(record.arxivId ? 'https://arxiv.org/pdf/' + record.arxivId + '.pdf'
    : record.url ?? (record.doi ? 'https://doi.org/' + record.doi : undefined));
}

export function installCitationPreviews(currentPaper: () => PdfDocument | undefined, actions?: CitationActions): void {
  const popup = el('aside', 'citation-preview');
  popup.id = 'paper-citation-preview';
  popup.setAttribute('role', 'dialog');
  popup.ariaLabel = t('Reference details', '参考文献详情');
  popup.hidden = true;
  document.body.append(popup);
  const anchors = new WeakMap<Element, Target>();
  let runs: RunIndex = new WeakMap();
  let pdfTargets = new Set<Target>(), active: Target | undefined, pinned: Target | undefined, hovered: Target | undefined, focused: Target | undefined;
  let pointer: { x: number; y: number } | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  let activePaper: PdfDocument | undefined;
  let frame = 0;

  const cancelClose = () => { if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; } };
  const dismiss = (restoreFocus = false) => {
    cancelClose(); const prev = active;
    pinned = hovered = focused = pointer = undefined; show();
    if (restoreFocus && prev && popup.contains(document.activeElement) && prev.node.isConnected) prev.node.focus({ preventScroll: true });
  };
  const scheduleClose = () => { cancelClose(); closeTimer = setTimeout(() => { closeTimer = undefined; hovered = undefined; show(pinned ?? focused); }, 160); };
  function positionPopup(): void {
    if (!active) return;
    const rect = active.ranges?.[0].getBoundingClientRect() ?? active.node.getBoundingClientRect();
    const { width, height } = popup.getBoundingClientRect();
    popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px';
    const above = rect.top - height - 7;
    popup.style.top = Math.max(8, rect.bottom + height + 8 > innerHeight && above >= 8 ? above : Math.min(rect.bottom + 6, innerHeight - height - 8)) + 'px';
  }
  function renderEntry(number: number, record?: BibliographyEntry): HTMLLIElement {
    const row = el('li'), body = el('div', 'citation-body');
    row.append(el('span', 'citation-index', '[' + number + ']'), body);
    body.append(el('span', record?.title ? 'citation-title' : 'citation-entry',
      record?.title ?? record?.entry ?? t('No matching bibliography entry.', '未找到对应的参考文献条目。')));
    if (!record) return row;
    const meta = [compactAuthors(record.authors), record.year].filter(Boolean).join(' · ');
    if (meta) body.append(el('div', 'citation-meta', meta));
    const bar = el('div', 'citation-actions');
    if (record.page && actions) {
      const jump = el('button', 'btn', t('Jump to References (p. ' + record.page + ')', '跳至参考文献 (第 ' + record.page + ' 页)'));
      jump.type = 'button'; jump.onclick = () => { dismiss(); void Promise.resolve(actions.jumpToPage(record.page!)).catch(e => toast(webPageError(e))); };
      bar.append(jump);
    }
    const copyBtn = el('button', 'btn', t('Copy', '复制')); copyBtn.type = 'button';
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    copyBtn.onclick = async () => {
      if (await copyText(record.entry)) {
        copyBtn.textContent = t('Copied', '已复制'); clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = t('Copy', '复制'); }, 1500);
      } else toast(t('Copy was blocked by this browser.', '浏览器阻止了复制。'));
    };
    bar.append(copyBtn);
    const openUrl = entryOpenUrl(record);
    if (openUrl && actions) {
      const openBtn = el('button', 'btn', t('Open / Import', '打开 / 导入')); openBtn.type = 'button';
      openBtn.onclick = async () => {
        openBtn.disabled = true; openBtn.textContent = t('Opening…', '正在打开…');
        try { await actions.openDocument(await api('web.open', { url: openUrl })); dismiss(); }
        catch (error) {
          openBtn.disabled = false; openBtn.textContent = t('Open / Import', '打开 / 导入');
          toast(webPageError(error), { label: t('Open in browser', '在浏览器中打开'), run: () => window.open(openUrl, '_blank', 'noopener') });
        }
      };
      bar.append(openBtn);
    }
    body.append(bar);
    return row;
  }
  function show(target?: Target): void {
    const paper = currentPaper();
    if (target === active && activePaper === paper) return;
    if (active) { active.node.removeAttribute('aria-expanded'); active.node.classList.remove('citation-active'); }
    active = target;
    activePaper = paper;
    if (!target || !paper || !target.node.isConnected) { active = undefined; popup.hidden = true; return; }
    target.node.setAttribute('aria-expanded', 'true');
    target.node.classList.add('citation-active');
    const heading = el('header', '', target.group.numbers.length === 1 ? t('Reference', '参考文献') : t('References', '参考文献'));
    popup.replaceChildren(heading, el('p', 'citation-lookup', t('Looking up the bibliography…', '正在查找参考文献…')));
    popup.hidden = false;
    positionPopup();
    void bibliography(paper).then(index => {
      if (active !== target || paper !== currentPaper() || !target.node.isConnected) return;
      const list = el('ul');
      for (const number of target.group.numbers) list.append(renderEntry(number, index.get(number)));
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
      const hitW = Math.max(first.width, 24), hitH = Math.max(first.height, 24);
      Object.assign(key.style, {
        left: (first.left + (first.width - hitW) / 2 - box.left) / scale + 'px',
        top: (first.top + (first.height - hitH) / 2 - box.top) / scale + 'px',
        width: hitW / scale + 'px', height: hitH / scale + 'px'
      });
      key.style.setProperty('--cite-w', first.width / scale + 'px');
      key.style.setProperty('--cite-h', first.height / scale + 'px');
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
    for (const plane of document.querySelectorAll('.pdf-coordinate-plane')) dedupeCitePdfLinks(plane);
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
    if (active && (!active.node.isConnected || currentPaper() !== activePaper)) dismiss();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributeFilter: ['data-focus', 'data-active-block'] });
  const sizes = new ResizeObserver(schedulePdf);
  for (const pane of document.querySelectorAll('#original, #translated')) sizes.observe(pane);
  function targetUnder(under: Element | null | undefined): Target | undefined {
    let hit = under ? anchors.get(under.closest('.paper-citation, .pdf-citation-focus') ?? under) : undefined;
    const run = under?.closest('.pdf-translated-text, .pdf-native-text [data-block-id]');
    if (!hit && run && pointer) {
      const { x, y } = pointer;
      hit = runs.get(run)?.find(({ range }) => Array.from(range.getClientRects()).some(box =>
        x >= box.left && x <= box.right && y >= box.top && y <= box.bottom))?.target;
    }
    return hit;
  }
  function refreshPreview(under = pointer && document.elementFromPoint(pointer.x, pointer.y), immediate = true): void {
    if (focused && !focused.node.isConnected) focused = undefined;
    if (pinned && !pinned.node.isConnected) pinned = undefined;
    if (under && popup.contains(under)) { cancelClose(); return; }
    const hit = targetUnder(under);
    if (hit) { cancelClose(); hovered = hit; show(pinned ?? hovered ?? focused); return; }
    if (!immediate && hovered && !pinned && !focused) { scheduleClose(); return; }
    cancelClose(); hovered = undefined; show(pinned ?? focused);
  }
  popup.addEventListener('pointerenter', cancelClose);
  popup.addEventListener('pointerleave', () => { if (!pinned && !focused) scheduleClose(); });
  document.addEventListener('pointermove', event => {
    pointer = event.buttons ? undefined : { x: event.clientX, y: event.clientY };
    refreshPreview(pointer && event.target instanceof Element ? event.target : null, false);
  });
  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) { pointer = undefined; if (!pinned && !focused) scheduleClose(); }
  });
  document.addEventListener('pointerdown', event => {
    if (!active || !(event.target instanceof Element)) return;
    const trigger = event.target.closest('.paper-citation, .pdf-citation-focus');
    if (!popup.contains(event.target) && (!trigger || !anchors.has(trigger))) dismiss();
  });
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !(window.getSelection()?.isCollapsed ?? true)) return;
    const trigger = event.target.closest('.paper-citation, .pdf-citation-focus');
    const target = trigger ? anchors.get(trigger) : undefined;
    if (!target) return;
    event.stopPropagation();
    cancelClose();
    pinned = pinned === target ? undefined : target;
    show(pinned ?? hovered ?? focused);
  });
  document.addEventListener('focusin', event => {
    if (event.target instanceof Node && popup.contains(event.target)) { cancelClose(); return; }
    focused = event.target instanceof Element ? anchors.get(event.target) : undefined;
    if (focused) { cancelClose(); pointer = undefined; hovered = undefined; }
    show(pinned ?? focused ?? hovered);
  });
  document.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && popup.contains(event.relatedTarget)) return;
    if (focused?.node === event.target || (event.target instanceof Node && popup.contains(event.target))) {
      focused = undefined; show(pinned ?? hovered);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); event.stopImmediatePropagation();
      dismiss(true);
    } else if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && anchors.has(event.target)) {
      event.preventDefault(); const target = anchors.get(event.target); pinned = focused = target; show(target);
    } else if (event.key === 'Tab' && active && !popup.hidden) {
      const firstBtn = popup.querySelector<HTMLButtonElement>('button:not(:disabled)');
      if (!event.shiftKey && event.target === active.node && firstBtn) { event.preventDefault(); firstBtn.focus(); }
      else if (event.shiftKey && event.target === firstBtn) { event.preventDefault(); active.node.focus({ preventScroll: true }); }
    }
  }, true);
  document.addEventListener('scroll', event => {
    if (!popup.contains(event.target as Node)) {
      refreshPreview(pointer && document.elementFromPoint(pointer.x, pointer.y), true);
      if (active) positionPopup();
    }
  }, true);
  schedulePdf();
}
