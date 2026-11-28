import { openStaxLocation } from './openstax.js';

type ArticleKind = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'pre' | 'quote' | 'list' | 'caption' | 'image' | 'equation' | 'table' | 'byline';
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
export interface WebArticle {
  url: string;
  title: string;
  paragraphs: string[];
  articleLayout?: ArticleLayout;
  paperTitle?: string;
  authors?: string;
  venue?: string;
  year?: string;
  doi?: string;
  publisher?: string;
  abstract?: string;
  pdfUrl?: string;
}

export function articleUrl(value: string | undefined, base?: string): URL | undefined {
  if (!value || value.length > 8192) return;
  const url = base ? URL.parse(value, base) : URL.parse(value);
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
const excludedRoles = new Set(['navigation', 'dialog', 'banner', 'contentinfo', 'search', 'complementary']);
const excludedIds = new Set(['searchbox', 'rtd-search-form', 'side-nav', 'nav-tree', 'msearchbox']);
const excludedClassRe = /^(?:ltx_author_notes|ltx_note_outer|ltx_page_footer|sr-only|visually-hidden|screen-reader-text|share-buttons|social-share|sphinxsidebar|wy-nav-side|wy-nav-top|wy-breadcrumbs|rst-versions|bd-sidebar|bd-toc|headerlink|toctree-wrapper|prev-next-area|navpath)$/;
const blocks = new Set('body article main section header div p h1 h2 h3 h4 h5 h6 pre li dt dd figcaption blockquote tr'.split(' '));
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

function splitLines(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let buf = '';
  const flush = () => { if (buf) { chunks.push(buf); buf = ''; } };
  for (const line of text.split('\n')) {
    if (line.length > limit) { flush(); for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit)); continue; }
    const next = buf ? buf + '\n' + line : line;
    if (next.length > limit) { flush(); buf = line; } else buf = next;
  }
  flush();
  return chunks;
}

function splitTableRows(cells: string[][], limit: number): string[][][] {
  const groups: string[][][] = [];
  const maxCols = Math.max(1, Math.floor(limit / 2));
  let cur: string[][] = [], curLen = 0;
  for (const rawRow of cells) {
    let row = rawRow.length > maxCols ? rawRow.slice(0, maxCols) : rawRow;
    if (!row.some(Boolean)) continue;
    let rowText = row.join('\t');
    if (rowText.length > limit) {
      const cap = Math.max(1, Math.floor((limit - row.length + 1) / Math.max(1, row.length)));
      row = row.map(c => c.slice(0, cap)); rowText = row.join('\t');
    }
    if (cur.length && curLen + rowText.length + 1 > limit) { groups.push(cur); cur = []; curLen = 0; }
    cur.push(row); curLen += rowText.length + (cur.length > 1 ? 1 : 0);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function extractArticle<N>(
  root: N, tree: ArticleTree<N>, address: string, fallbackTitle: string, picked?: N,
  limits?: { maxBlocks?: number; maxChars?: number; maxBlockChars?: number }
): { article: WebArticle; index: number } {
  const { tag, attr, children } = tree;
  const maxBlocks = limits?.maxBlocks ?? 4000, maxChars = limits?.maxChars ?? 1_000_000, maxBlockChars = limits?.maxBlockChars ?? 24_000;
  const bookSection = Boolean(openStaxLocation(address)?.section);
  const classes = (node: N) => (attr(node, 'class') || '').toLowerCase().split(/\s+/);
  function excluded(node: N): boolean {
    const name = tag(node), role = (attr(node, 'role') || '').toLowerCase(), id = (attr(node, 'id') || '').toLowerCase();
    // OpenStax places the figure itself inside its zoom button.
    const imageButton = bookSection && name === 'button' && classes(node).includes('image-button-wrapper');
    return excludedTags.has(name) && !imageButton || excludedRoles.has(role) || excludedIds.has(id) ||
      attr(node, 'hidden') !== null || attr(node, 'inert') !== null || attr(node, 'aria-hidden') === 'true' ||
      attr(node, 'data-dsh-paper-reader') !== null || (attr(node, 'contenteditable') !== null && attr(node, 'contenteditable') !== 'false') ||
      classes(node).some(c => excludedClassRe.test(c)) ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attr(node, 'style') || '') || Boolean(tree.invisible?.(node));
  }
  // Prefer the publisher's article over site navigation and related-post lists.
  let articleRoot = root, rank = 0, documentBase: string | undefined, pageTitle = fallbackTitle;
  const researchBlog = articleUrl(address)?.hostname === 'research.google';
  let storyHeader: N | undefined, storySummary: N | undefined, storyBody: N | undefined;
  const coverImages = new Set<N>(), figureDescriptions = new Set<string>();
  const metaSingle = new Map<string, string>();
  const metaLists = new Map<string, string[]>();
  const metaAuthorKeys = new Set(['citation_author', 'dc.creator', 'dcterms.creator']);
  const metaAbstractKeys = new Set(['citation_abstract', 'dcterms.abstract', 'dc.description', 'description', 'og:description']);
  const metaDoiKeys = new Set(['citation_doi', 'dc.identifier']);
  const metaDateKeys = new Set(['citation_publication_date', 'citation_date', 'citation_online_date', 'dc.date', 'dcterms.issued', 'article:published_time']);
  function collectMeta(node: N): void {
    const rawKey = attr(node, 'name') || attr(node, 'property');
    const rawContent = attr(node, 'content');
    if (!rawKey || !rawContent) return;
    const key = rawKey.trim().toLowerCase();
    if (!key) return;
    const value = metaAbstractKeys.has(key)
      ? rawContent.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim()
      : clean(rawContent);
    if (!value) return;
    if (metaAuthorKeys.has(key)) {
      const list = metaLists.get(key) ?? [];
      if (!list.some(entry => entry.toLowerCase() === value.toLowerCase())) list.push(value);
      metaLists.set(key, list);
      return;
    }
    if (metaSingle.has(key)) return;
    if (metaDoiKeys.has(key)) {
      const doi = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
      if (/^10\.\d{4,9}\/\S+$/i.test(doi)) metaSingle.set(key, doi);
      return;
    }
    if (metaDateKeys.has(key)) {
      const year = value.match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/)?.[1];
      if (year) metaSingle.set(key, year);
      return;
    }
    metaSingle.set(key, value);
  }
  function firstMeta(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = metaSingle.get(key);
      if (value) return value;
    }
    return undefined;
  }
  function find(node: N, depth: number, storyPart?: 'header' | 'body'): void {
    if (depth > 150 || tag(node) === '#text') return;
    const name = tag(node);
    if (name === 'base' && !documentBase) documentBase = articleUrl(attr(node, 'href') || '', address)?.href;
    if (name === 'title' && !pageTitle) pageTitle = clean(tree.text(node));
    if (name === 'meta') { collectMeta(node); return; }
    if (name === 'head') {
      for (const child of children(node)) {
        const childName = tag(child);
        if (childName === 'base' || childName === 'title' || childName === 'meta') find(child, depth + 1, storyPart);
      }
      return;
    }
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
  let containsPick = false, pickedIndex = -1, h1Count = 0, title = '';
  let current: ArticleKind = 'p', total = 0;
  function add(text: string, info: ArticleBlock, spans: ArticleSpan[] = []): void {
    if (!text.trim()) return;
    total += text.length;
    if (total > maxChars || paragraphs.length >= maxBlocks || text.length > maxBlockChars) throw new Error('This article is too long to open in the reader.');
    const index = paragraphs.length;
    if (containsPick) pickedIndex = index;
    paragraphs.push(text);
    if (ids.length) info.ids = [...new Set(ids)].slice(0, 80);
    if (spans.length) info.spans = spans;
    if (info.kind !== 'p' || info.ids || info.spans) layout['p-' + (index + 1)] = info;
    if (info.kind === 'h1') { h1Count++; if (!title) title = text; }
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
    const id = attr(node, 'id'), anchorName = name === 'a' ? attr(node, 'name') : null;
    if (id && id.length <= 256) ids.push(id);
    if (anchorName && anchorName.length <= 256 && anchorName !== id) ids.push(anchorName);
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
      if (code.trim()) {
        const limit = Math.min(maxBlockChars, 20_000);
        if (code.length <= limit) add(code, { kind: 'pre' });
        else for (const chunk of splitLines(code, limit)) if (chunk.trim()) add(chunk, { kind: 'pre' });
      }
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
          if (values.some(Boolean)) cells.push(values);
        } else if (['tbody', 'thead', 'tfoot', 'table'].includes(tag(row))) for (const child of children(row)) rows(child);
      }
      rows(node);
      if (cells.length) {
        const limit = Math.min(maxBlockChars, 20_000);
        for (const group of splitTableRows(cells, limit)) {
          const text = group.map(row => row.join('\t')).join('\n');
          if (text.trim()) add(text, { kind: 'table', cells: group });
        }
      }
      return;
    }
    let next = kind;
    if (/^h[1-6]$/.test(name)) next = name as ArticleKind;
    else if (name === 'figcaption' || (researchBlog && name === 'div' && found.includes('caption'))) next = 'caption';
    else if (name === 'blockquote') next = 'quote';
    else if (name === 'li') next = 'list';
    else if (found.includes('ltx_equation') || found.includes('ltx_eqn_row') || ((name === 'div' || name === 'p') && found.includes('math'))) next = 'equation';
    else if (found.includes('ltx_authors') || found.includes('author')) next = 'byline';
    if (name === 'a') {
      const href = attr(node, 'href') || '';
      const localAnchor = href.startsWith('#') && href.length > 1 && href.length <= 256;
      const link = !address && localAnchor ? undefined : articleUrl(href, base);
      if (link) inline = { kind: 'link', value: link.href };
      else if (localAnchor) inline = { kind: 'link', value: href };
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
  if (!paragraphs.length) throw new Error(address ? 'No visible article text was found on this page. Open the original webpage and use the browser extension.' : 'No readable text was found in this document.');
  const paperTitle = firstMeta('citation_title', 'dc.title');
  const authorList = metaLists.get('citation_author') ?? metaLists.get('dc.creator') ?? metaLists.get('dcterms.creator');
  const authors = authorList?.length ? authorList.join('; ') : firstMeta('author');
  const venue = firstMeta('citation_journal_title', 'citation_conference_title', 'citation_inbook_title', 'citation_book_title', 'citation_technical_report_institution');
  const year = firstMeta('citation_publication_date', 'citation_date', 'citation_online_date', 'dc.date', 'dcterms.issued', 'article:published_time');
  const doi = firstMeta('citation_doi', 'dc.identifier');
  const publisher = firstMeta('citation_publisher', 'dc.publisher', 'dcterms.publisher');
  const abstract = firstMeta('citation_abstract', 'dcterms.abstract', 'dc.description', 'description', 'og:description');
  const pdfUrl = articleUrl(firstMeta('citation_pdf_url'), base)?.href;
  const titleTail = title && pageTitle.toLowerCase().startsWith(title.toLowerCase())
    ? pageTitle.slice(title.length).match(/^(?:\s*:\s+|\s+-\s+|\s*[—–|]\s*)(.+)$/)?.[1]?.trim() : '';
  const resolvedTitle = h1Count > 1 && !paperTitle && pageTitle ? (titleTail || pageTitle) : (title || paperTitle || pageTitle || articleUrl(address)?.hostname || 'Document');
  return {
    article: {
      url: address,
      title: resolvedTitle,
      paragraphs,
      articleLayout: layout,
      ...(paperTitle ? { paperTitle } : {}),
      ...(authors ? { authors } : {}),
      ...(venue ? { venue } : {}),
      ...(year ? { year } : {}),
      ...(doi ? { doi } : {}),
      ...(publisher ? { publisher } : {}),
      ...(abstract ? { abstract } : {}),
      ...(pdfUrl ? { pdfUrl } : {})
    },
    index: pickedIndex
  };
}
