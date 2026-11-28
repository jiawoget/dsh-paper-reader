import { render as renderMath } from 'katex';
import { articleUrl, type ArticleBlock } from '../shared/web-article.js';
import { readerLabel as label } from './ui.js';

export function unchangedArticleBlock(kind?: ArticleBlock['kind']): boolean {
  return kind === 'image' || kind === 'pre' || kind === 'equation' || kind === 'table';
}
interface SourceActions {
  docId: string;
  bookPage?: number;
  anchor: string;
  sourceUrl?: string;
  onLink(anchor: HTMLAnchorElement, url: URL): void;
}
export function articleContent(owner: Document, format: ArticleBlock | undefined, text: string, actions: SourceActions): HTMLElement {
  const kind = format?.kind;
  const element = owner.createElement(kind && /^h[1-6]$/.test(kind) ? kind : kind === 'pre' ? 'pre' : kind === 'quote' ? 'blockquote' :
    kind === 'caption' ? 'figcaption' : kind === 'image' ? 'figure' : kind === 'table' ? 'div' : 'p');
  if (kind) element.dataset.kind = kind;
  if (kind === 'image' && format?.image) {
    const image = owner.createElement('img');
    image.alt = format.image.alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    const params = new URLSearchParams({ doc: actions.docId, anchor: actions.anchor });
    if (actions.bookPage) params.set('page', String(actions.bookPage));
    image.src = '/api/paper-reader/article-image?' + params;
    const url = articleUrl(actions.sourceUrl);
    image.addEventListener('error', () => {
      const fallback = owner.createElement(url ? 'a' : 'span');
      fallback.textContent = label('View illustration on original webpage', '去原网页查看插图');
      if (url && fallback instanceof HTMLAnchorElement) {
        const id = format.ids?.[0]; if (id) url.hash = id;
        fallback.href = url.href; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
      }
      image.replaceWith(fallback);
    }, { once: true });
    element.append(image);
  } else if (kind === 'table' && format?.cells) {
    const table = owner.createElement('table');
    const body = table.createTBody();
    for (const [r, row] of format.cells.entries()) {
      const tr = body.insertRow();
      for (const [c, value] of row.entries()) {
        // Keep the separators in the text model so a cell selection can be reopened exactly.
        tr.insertCell().textContent = value + (c + 1 < row.length ? '\t' : r + 1 < format.cells.length ? '\n' : '');
      }
    }
    element.append(table);
  } else {
    let start = 0;
    for (const span of format?.spans || []) {
      if (span.start > start) element.append(text.slice(start, span.start));
      const content = text.slice(span.start, span.end);
      const part = owner.createElement(span.kind === 'link' ? 'a' : span.kind === 'math' ? 'span' : span.kind);
      part.textContent = content;
      if (span.kind === 'math' && span.value) {
        try {
          // Native MathML keeps subscripts and fractions legible at either pane width.
          renderMath(span.value, part, { output: 'mathml', displayMode: kind === 'equation', throwOnError: true, trust: false, strict: 'ignore', maxSize: 12, maxExpand: 500 });
          const math = part.querySelector('math');
          if (math) { part.replaceChildren(math); part.dataset.articleText = content; }
        } catch { part.textContent = content; }
      } else if (part instanceof HTMLAnchorElement && span.value) {
        const url = span.value.startsWith('#') ? new URL(span.value, 'https://local.invalid/') : articleUrl(span.value);
        if (url) actions.onLink(part, url);
      }
      element.append(part);
      start = span.end;
    }
    if (start < text.length) element.append(text.slice(start));
  }
  return element;
}

interface WordRun { node: Node; start: number; end: number }
function runsIn(content: HTMLElement): WordRun[] {
  const runs: WordRun[] = [];
  let start = 0;
  function walk(node: Node): void {
    const length = node instanceof Text ? node.length :
      node instanceof HTMLElement && node.dataset.articleText !== undefined ? node.dataset.articleText.length : 0;
    if (length) { runs.push({ node, start, end: start + length }); start += length; }
    else for (const child of node.childNodes) walk(child);
  }
  walk(content);
  return runs;
}
function boundary(range: Range, run: WordRun, offset: number, edge: 'start' | 'end'): void {
  if (run.node instanceof Text) {
    if (edge === 'start') range.setStart(run.node, offset - run.start); else range.setEnd(run.node, offset - run.start);
  } else if (edge === 'start') range.setStartBefore(run.node); else range.setEndAfter(run.node);
}

export function rangeInArticle(content: HTMLElement, text: string, quote: string, offset?: number): Range | null {
  if (!quote) return null;
  const start = offset !== undefined && offset >= 0 && text.startsWith(quote, offset) ? offset : text.indexOf(quote);
  if (start < 0) return null;
  const runs = runsIn(content);
  const end = start + quote.length;
  const first = runs.find(run => run.end > start), last = runs.find(run => run.end >= end);
  if (!first || !last) return null;
  const range = content.ownerDocument.createRange();
  boundary(range, first, start, 'start'); boundary(range, last, end, 'end');
  return range;
}

export function selectedArticleText(selection: Range, content: HTMLElement, text: string): { range: Range; offset: number; text: string } | undefined {
  if (!selection.intersectsNode(content)) return;
  const matches = runsIn(content).filter(run => selection.intersectsNode(run.node));
  const first = matches[0], last = matches.at(-1);
  if (!first || !last) return;
  const start = first.node === selection.startContainer ? first.start + selection.startOffset : first.start;
  const end = last.node === selection.endContainer ? last.start + selection.endOffset : last.end;
  const value = text.slice(start, end);
  if (!value.trim()) return;
  const range = content.ownerDocument.createRange();
  boundary(range, first, start, 'start'); boundary(range, last, end, 'end');
  return { range, text: value, offset: start };
}
