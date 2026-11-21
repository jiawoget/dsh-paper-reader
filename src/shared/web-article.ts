import { openStaxLocation } from './openstax.js';

export type ArticleKind = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'pre' | 'quote' | 'list' | 'caption' | 'image' | 'equation' | 'table' | 'byline';
export interface ArticleSpan {
  start: number;
  end: number;
  kind: 'link' | 'code' | 'math' | 'em' | 'strong';
  value?: string;
}
export interface ArticleBlock {
  kind: ArticleKind;
  ids?: string[];
  spans?: ArticleSpan[];
  image?: { url: string; alt: string };
  cells?: string[][];
}
export type ArticleLayout = Record<string, ArticleBlock>;
export interface WebArticle { url: string; title: string; paragraphs: string[]; articleLayout?: ArticleLayout }

export function articleUrl(value: string | undefined, base?: string): URL | undefined {
  if (!value || value.length > 8192) return;
  const url = URL.parse(value, base);
  if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url;
}

/** The live DOM and the inert server parser use the same walk, so both give a quote the same paragraph ID. */
export interface ArticleTree<N> {
  tag(node: N): string;
  attr(node: N, key: string): string | null;
  children(node: N): Iterable<N>;
  text(node: N): string;
  invisible?(node: N): boolean;
  contains?(parent: N, child: N): boolean;
}

const excludedTags = new Set('nav aside footer form button input textarea select script style noscript template svg canvas iframe dialog'.split(' '));
const blocks = new Set('body article main section header div p h1 h2 h3 h4 h5 h6 pre li dt dd figcaption blockquote tr'.split(' '));
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function extractArticle<N>(root: N, tree: ArticleTree<N>, address: string, fallbackTitle: string, picked?: N): { article: WebArticle; index: number } {
  const { tag, attr, children } = tree;
  const bookSection = Boolean(openStaxLocation(address)?.section);
  const classes = (node: N) => (attr(node, 'class') || '').toLowerCase().split(/\s+/);
  function excluded(node: N): boolean {
    const name = tag(node), role = attr(node, 'role');
    // OpenStax places the figure itself inside its zoom button.
    const imageButton = bookSection && name === 'button' && classes(node).includes('image-button-wrapper');
    return excludedTags.has(name) && !imageButton || role === 'navigation' || role === 'dialog' || role === 'banner' || role === 'contentinfo' ||
      attr(node, 'hidden') !== null || attr(node, 'inert') !== null || attr(node, 'aria-hidden') === 'true' ||
      attr(node, 'data-dsh-paper-reader') !== null || (attr(node, 'contenteditable') !== null && attr(node, 'contenteditable') !== 'false') ||
      classes(node).some(c => /^(?:ltx_author_notes|ltx_note_outer|ltx_page_footer|sr-only|visually-hidden|screen-reader-text|share-buttons|social-share)$/.test(c)) ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attr(node, 'style') || '') || Boolean(tree.invisible?.(node));
  }
  // Prefer the publisher's article over site navigation and related-post lists.
  let articleRoot = root, rank = 0, documentBase: string | undefined, pageTitle = fallbackTitle;
  const researchBlog = articleUrl(address)?.hostname === 'research.google';
  let storyHeader: N | undefined, storySummary: N | undefined, storyBody: N | undefined;
  const coverImages = new Set<N>(), figureDescriptions = new Set<string>();
  function find(node: N, depth: number, storyPart?: 'header' | 'body'): void {
    if (depth > 150 || tag(node) === '#text') return;
    const name = tag(node);
    if (name === 'base' && !documentBase) documentBase = articleUrl(attr(node, 'href') || '', address)?.href;
    if (name === 'title' && !pageTitle) pageTitle = clean(tree.text(node));
    if (excluded(node)) return;
    if (researchBlog) {
      const names = classes(node);
      if (names.includes('basic-hero') && names.includes('bhoig')) { storyHeader = node; storyPart = 'header'; }
      if (names.includes('blog-summary')) storySummary = node;
      if (names.includes('blog-detail-wrapper')) { storyBody = node; storyPart = 'body'; }
      if (name === 'img' && storyPart === 'header') coverImages.add(node);
      if (name === 'img' && storyPart === 'body' && attr(node, 'alt')) figureDescriptions.add(attr(node, 'alt')!);
    }
    const candidate = bookSection && attr(node, 'id') === 'main-content' ? 7 :
      bookSection && attr(node, 'data-book-content') === 'true' ? 6 :
      name === 'article' ? 5 : attr(node, 'itemprop') === 'articleBody' || classes(node).includes('article') ? 4 :
      name === 'main' || attr(node, 'role') === 'main' ? 3 : name === 'body' ? 1 : 0;
    if (candidate > rank) { rank = candidate; articleRoot = node; }
    for (const child of children(node)) find(child, depth + 1, storyPart);
  }
  find(root, 0);
  const base = documentBase || address;
  const paragraphs: string[] = [];
  const layout: ArticleLayout = {};
  let ids: string[] = [], parts: { text: string; span?: Pick<ArticleSpan, 'kind' | 'value'> }[] = [];
  let containsPick = false, pickedIndex = -1, title = '';
  let current: ArticleKind = 'p', total = 0;
  function add(text: string, info: ArticleBlock, spans: ArticleSpan[] = []): void {
    if (!text) return;
    total += text.length;
    if (total > 1_000_000 || paragraphs.length >= 4000 || text.length > 24_000) throw new Error('This article is too long to open in the reader.');
    const index = paragraphs.length;
    if (containsPick) pickedIndex = index;
    paragraphs.push(text);
    if (ids.length) info.ids = [...new Set(ids)].slice(0, 80);
    if (spans.length) info.spans = spans;
    if (info.kind !== 'p' || info.ids || info.spans) layout['p-' + (index + 1)] = info;
    if (info.kind === 'h1' && !title) title = text;
    ids = []; containsPick = false;
  }
  function flush(): void {
    let value = '', space = false;
    const spans: ArticleSpan[] = [];
    for (const part of parts) {
      const trimmed = clean(part.text);
      if (!trimmed) { if (part.text) space = true; continue; }
      if (value && (space || /^\s/.test(part.text))) value += ' ';
      const start = value.length;
      value += trimmed;
      if (part.span) spans.push({ ...part.span, start, end: value.length });
      space = /\s$/.test(part.text);
    }
    add(value, { kind: current }, spans);
    parts = [];
  }
  function plain(node: N, depth = 0): string {
    const name = tag(node);
    if (depth > 150) return '';
    if (name === '#text') return tree.text(node);
    if (name === 'annotation' || name === 'annotation-xml' || excluded(node)) return '';
    if (name === 'br') return '\n';
    return Array.from(children(node), child => plain(child, depth + 1)).join('');
  }
  function visit(node: N, kind: ArticleKind, inline: Pick<ArticleSpan, 'kind' | 'value'> | undefined, depth: number): void {
    if (depth > 150) return;
    const name = tag(node);
    if (name === '#text') { if (node === picked) containsPick = true; parts.push({ text: tree.text(node), span: inline }); return; }
    if (excluded(node)) return;
    const found = classes(node);
    if (coverImages.has(node) && figureDescriptions.has(attr(node, 'alt') || '')) return;
    // Some blogs inject a paragraph sign into each heading after load for copying permalinks.
    if (name === 'a' && /^h[1-6]$/.test(kind) && attr(node, 'href')?.startsWith('#') && /^[#¶§🔗]+$/u.test(clean(plain(node)))) return;
    // A linked masthead beside a second h1, as on The Go Blog, belongs to the publication.
    if (name === 'h1' && found.includes('small') && Array.from(children(node)).some(child => tag(child) === 'a')) return;
    const block = blocks.has(name);
    const graphic = name === 'img' || name === 'object' && (attr(node, 'type') || '').startsWith('image/');
    if (block || graphic || name === 'table') flush();
    const id = attr(node, 'id');
    if (id && id.length <= 256) ids.push(id);
    if (node === picked) containsPick = true;
    if (picked !== undefined && (name === 'pre' || name === 'table' || name === 'math') && tree.contains?.(node, picked)) {
      // Ordinary tables and code are each saved as one block. Equation tables keep one anchor per row.
      if (name !== 'table' || !found.some(c => /ltx_eqn|ltx_equation/.test(c))) containsPick = true;
    }
    if (name === 'br') { parts.push({ text: ' ' }); return; }
    if (graphic) {
      const src = articleUrl(attr(node, 'data-src') || attr(node, name === 'object' ? 'data' : 'src') || '', base);
      if (src && attr(node, 'role') !== 'presentation' && !['0','1'].includes(attr(node, 'width') || '') && !['0','1'].includes(attr(node, 'height') || '')) {
        const alt = clean(attr(node, 'alt') || '').slice(0, 1024);
        add(alt || 'Illustration', { kind: 'image', image: { url: src.href, alt } });
      }
      return;
    }
    if (name === 'pre') {
      const code = plain(node).replace(/^\n|\n$/g, '').trimEnd();
      if (code.trim()) add(code, { kind: 'pre' });
      return;
    }
    if (name === 'math') {
      const tex = attr(node, 'alttext')?.trim();
      parts.push({ text: clean(plain(node)) || tex || '', span: tex && tex.length <= 4096 ? { kind: 'math', value: tex } : inline });
      return;
    }
    if (name === 'table' && !found.some(c => /ltx_eqn|ltx_equation/.test(c))) {
      const cells: string[][] = [];
      function rows(row: N): void {
        if (tag(row) === 'tr') {
          const values = Array.from(children(row)).filter(cell => ['th', 'td'].includes(tag(cell))).map(cell => clean(plain(cell)));
          if (values.length) cells.push(values);
        } else if (['tbody', 'thead', 'tfoot', 'table'].includes(tag(row))) for (const child of children(row)) rows(child);
      }
      rows(node);
      if (cells.length) add(cells.map(row => row.join('\t')).join('\n'), { kind: 'table', cells });
      return;
    }
    let next = kind;
    if (/^h[1-6]$/.test(name)) next = name as ArticleKind;
    else if (name === 'figcaption' || (researchBlog && name === 'div' && found.includes('caption'))) next = 'caption';
    else if (name === 'blockquote') next = 'quote';
    else if (name === 'li') next = 'list';
    else if (found.includes('ltx_equation') || found.includes('ltx_eqn_row')) next = 'equation';
    else if (found.includes('ltx_authors') || found.includes('author')) next = 'byline';
    if (name === 'a') {
      const link = articleUrl(attr(node, 'href') || '', base);
      if (link) inline = { kind: 'link', value: link.href };
    } else if (!inline && ['code', 'em', 'strong', 'b', 'i'].includes(name)) {
      inline = { kind: name === 'b' || name === 'strong' ? 'strong' : name === 'code' ? 'code' : 'em' };
    }
    const previous = current;
    if (block) current = next;
    for (const child of children(node)) visit(child, next, inline, depth + 1);
    if (block) { flush(); current = previous; }
  }
  if (storyHeader && storyBody) {
    visit(storyHeader, 'p', undefined, 0);
    if (storySummary) visit(storySummary, 'p', undefined, 0);
    visit(storyBody, 'p', undefined, 0);
  } else visit(articleRoot, 'p', undefined, 0);
  flush();
  if (!paragraphs.length) throw new Error('No visible article text was found on this page. Open the original webpage and use the browser extension.');
  return { article: { url: address, title: title || pageTitle || new URL(address).hostname, paragraphs, articleLayout: layout }, index: pickedIndex };
}
