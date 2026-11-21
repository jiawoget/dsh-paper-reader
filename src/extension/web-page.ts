import type { Operations } from '../shared/types.js';
import { extractArticle, type ArticleTree } from '../shared/web-article.js';

export type WebImport = Operations['web.import'][0];
export interface PickedText {
  range: Range;
  text: string;
  context: string;
  block: Element;
}
export interface Snapshot {
  article: WebImport;
  anchor: string;
  label: string;
}

const blockTags = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption,dt,dd,th,td,div,section,article,main,body';
const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

export function currentPick(): PickedText | null {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  const controls = 'input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[data-dsh-paper-reader]';
  if (!start || !end || start.closest(controls) || end.closest(controls)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const block = start.closest(blockTags) || start;
  const surrounding = tidy(block instanceof HTMLElement ? block.innerText : block.textContent || '');
  const index = Math.max(0, surrounding.indexOf(tidy(text)));
  const context = surrounding.slice(Math.max(0, index - 900), index + Math.min(text.length, 1800) + 900);
  return { range: range.cloneRange(), block, text, context: context || text };
}

const tree: ArticleTree<Node> = {
  tag: node => node instanceof Element ? node.localName : node.nodeName,
  attr: (node, name) => node instanceof Element ? node.getAttribute(name) : null,
  children: node => node.childNodes,
  text: node => node.textContent || '',
  contains: (parent, child) => parent.contains(child),
  invisible(node) {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    return style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden';
  }
};

export function snapshot(pick: PickedText | null): Snapshot {
  if (!document.body) throw new Error('The page content has not loaded yet.');
  const { article, index: selected } = extractArticle(document, tree, location.href, document.title, pick?.range.startContainer);
  let index = selected < 0 ? 0 : selected;
  if (pick && selected < 0) {
    index = article.paragraphs.findIndex(text => text === pick.context);
    if (index < 0) { index = article.paragraphs.length; article.paragraphs.push(pick.context); }
  }
  return { article, anchor: 'p-' + (index + 1), label: 'Paragraph ' + (index + 1) };
}
