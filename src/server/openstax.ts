import { parse, parseFragment, type DefaultTreeAdapterTypes as Dom } from 'parse5';
import { bookSlug, openStaxLocation, openStaxUrl } from '../shared/openstax.js';
import type { BookInfo, BookSection } from '../shared/types.js';
import { articleUrl, extractArticle, type ArticleSpan, type WebArticle } from '../shared/web-article.js';
import { htmlTree } from './article-dom.js';
import { fail, isRecord } from './library.js';
import type { PublicResource } from './public-resource.js';

export type ReadBookResource = (url: string, kind: 'document' | 'json') => Promise<Pick<PublicResource, 'bytes'>>;
type BookCatalog = { book: BookInfo; title: string; authors?: string; defaultPage: number };

export async function publishedEntry(book: string, read: ReadBookResource): Promise<string> {
  const { bytes } = await read('https://openstax.org/apps/cms/api/books/' + encodeURIComponent(book) + '/', 'json');
  const data: unknown = JSON.parse(bytes.toString('utf8'));
  const target = isRecord(data) && openStaxLocation(data.webview_rex_link);
  if (!target || target.book !== book || !target.section) fail('OpenStax has no online reading entry for this book.', 502);
  return target.section;
}

function find(node: Dom.Node, test: (node: Dom.Node) => boolean): Dom.Node | undefined {
  if (test(node)) return node;
  for (const child of htmlTree.children(node)) {
    const found = find(child, test);
    if (found) return found;
  }
}

function titleText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return htmlTree.text(parseFragment(value)).replace(/\s+/g, ' ').trim();
}

function contentsOf(tree: unknown, book: string): BookSection[] {
  if (!isRecord(tree) || !Array.isArray(tree.contents)) fail('OpenStax did not publish a table of contents for this book.', 502);
  const sections: BookSection[] = [], seen = new Set<string>();
  type Chapter = Pick<BookSection, 'chapterId' | 'chapterTitle'>;
  function visit(item: unknown, chapter?: Chapter): void {
    if (!isRecord(item)) return;
    const slug = item.slug, title = titleText(item.title);
    if (Array.isArray(item.contents)) {
      if (title && (!chapter || item.toc_type === 'chapter')) {
        const id = bookSlug(slug) ? slug : typeof item.id === 'string' ? item.id.split('@')[0] : '';
        if (id) chapter = { chapterId: id, chapterTitle: title };
      }
      for (const child of item.contents) visit(child, chapter);
    } else if (bookSlug(slug) && title && !seen.has(slug)) {
      seen.add(slug);
      sections.push({ slug, title, ...(chapter ?? { chapterId: slug, chapterTitle: title }), url: openStaxUrl(book, slug) });
    }
  }
  for (const node of tree.contents) visit(node);
  if (!sections.length) fail('The OpenStax table of contents is empty.', 502);
  return sections;
}

function addAttribution(article: WebArticle, book: Record<string, unknown>, title: string, entry: string): void {
  let text = 'OpenStax · ' + title + '. Access for free at ';
  const spans: ArticleSpan[] = [{ kind: 'link', start: text.length, end: text.length + entry.length, value: entry }];
  text += entry;
  if (isRecord(book.license) && typeof book.license.url === 'string' && typeof book.license.name === 'string') {
    const license = articleUrl(book.license.url);
    if (license) {
      text += ' · ';
      spans.push({ kind: 'link', start: text.length, end: text.length + book.license.name.length, value: license.href });
      text += book.license.name;
    }
  }
  article.paragraphs.push(text);
  (article.articleLayout ??= {})['p-' + article.paragraphs.length] = { kind: 'byline', spans };
}

/** REX publishes its ordered book tree and just the selected section in each server-rendered page. */
export function parseOpenStaxPage(html: string, slug: string, section: string, withCatalog: boolean, defaultSection?: string):
  { article: WebArticle; catalog?: BookCatalog } {
  const dom = parse(html, { scriptingEnabled: false });
  const stateScript = find(dom, node => node.nodeName === 'script' && /^\s*window\.__PRELOADED_STATE__\s*=/.test(htmlTree.text(node)));
  if (!stateScript) fail('This page did not contain the OpenStax reader data.', 502);
  const json = htmlTree.text(stateScript).replace(/^\s*window\.__PRELOADED_STATE__\s*=\s*/, '').trim().replace(/;$/, '');
  const state: unknown = JSON.parse(json);
  const content = isRecord(state) && state.content;
  if (!isRecord(content) || !isRecord(content.book) || content.book.slug !== slug || !isRecord(content.params) ||
    !isRecord(content.params.page) || content.params.page.slug !== section ||
    !find(dom, node => htmlTree.attr(node, 'data-book-content') === 'true')) fail('OpenStax did not return the requested book section.', 502);
  const book = content.book, url = openStaxUrl(slug, section), title = titleText(book.title);
  if (!title) fail('The OpenStax book title is missing.', 502);
  const { article } = extractArticle(dom, htmlTree, url, title);
  const attribution = find(dom, node => htmlTree.attr(node, 'data-analytics-region') === 'attribution' ||
    htmlTree.attr(node, 'data-testid') === 'attribution-details');
  const source = attribution && find(attribution, node => {
    const target = node.nodeName === 'a' && openStaxLocation(htmlTree.attr(node, 'href'));
    return Boolean(target && target.book === slug && target.section);
  });
  const entry = source ? htmlTree.attr(source, 'href')! : openStaxUrl(slug, defaultSection ?? section);
  addAttribution(article, book, title, entry);
  if (!withCatalog) return { article };
  const sections = contentsOf(book.tree, slug);
  const firstSlug = defaultSection ?? openStaxLocation(entry)?.section;
  const first = sections.findIndex(item => item.slug === firstSlug);
  const names = Array.isArray(book.authors) ? book.authors.filter(isRecord).map(author => author.value).filter(isRecord) : [];
  const primary = names.filter(author => author.senior_author === true);
  const authors = (primary.length ? primary : names).map(author => author.name).filter(name => typeof name === 'string').join(', ');
  return { article, catalog: { book: { slug, sections }, title, authors: authors || undefined, defaultPage: first < 0 ? 1 : first + 1 } };
}
