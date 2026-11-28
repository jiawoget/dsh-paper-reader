import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { shardArticle, type ShardedBook } from '../shared/doc-sharding.js';
import { bookSlug } from '../shared/openstax.js';
import type { BookInfo, DocMetadata, DocumentInfo, OpenDocument } from '../shared/types.js';
import { articleUrl, type ArticleLayout } from '../shared/web-article.js';
import { readArticleLayout } from './article-layout.js';
import { fail, hash, isRecord, writeOnce, type Library } from './library.js';
import { sanitizeDocMeta } from './library-meta.js';

interface ShardedBookInput extends DocMetadata {
  url?: string; title: string; sharded: ShardedBook; identityKey?: string; defaultPage?: number; fragment?: string;
}

const MAX_SHARDED_CHARS = 16_000_000;

function checkPreShardLayout(raw: unknown, count: number): ArticleLayout {
  if (!isRecord(raw)) fail('Invalid article layout.');
  for (const [key, value] of Object.entries(raw)) {
    if (!/^p-[1-9]\d{0,4}$/.test(key) || Number(key.slice(2)) > count || !isRecord(value) || typeof value.kind !== 'string') fail('Invalid article block.');
    if (value.ids !== undefined && (!Array.isArray(value.ids) || !value.ids.every(id => typeof id === 'string'))) fail('Invalid article anchors.');
  }
  return raw as ArticleLayout;
}

export async function importShardedBook(library: Library, input: ShardedBookInput): Promise<OpenDocument> {
  const { sharded } = input;
  if (!sharded.sections.length || !bookSlug(sharded.slug)) fail('Invalid sharded book contents.');
  const cleanTitle = input.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250) || 'Document';
  const parsedUrl = input.url ? articleUrl(input.url) : undefined;
  const safeUrl = parsedUrl ? parsedUrl.origin + parsedUrl.pathname + parsedUrl.search : undefined;
  const identity = input.identityKey ?? JSON.stringify([safeUrl ?? '', cleanTitle, sharded.sections.map(s => [s.slug, s.paragraphs])]);
  const id = 'book-' + hash(identity);
  const documentsDir = path.join(library.root, 'documents'), sectionsDir = path.join(documentsDir, 'book-sections', id);
  await mkdir(sectionsDir, { recursive: true });

  const prepared = sharded.sections.map(section => {
    if (!bookSlug(section.slug) || !section.paragraphs.length) fail('Invalid sharded book section.');
    return { slug: section.slug, paragraphs: section.paragraphs, articleLayout: readArticleLayout(section.articleLayout, section.paragraphs) };
  });
  for (const section of prepared) {
    await writeOnce(path.join(sectionsDir, hash(section.slug) + '.json'), JSON.stringify({ paragraphs: section.paragraphs, articleLayout: section.articleLayout }));
  }

  const book: BookInfo = {
    slug: sharded.slug, sections: sharded.bookSections,
    ...(Object.keys(sharded.anchorPages).length ? { anchorPages: sharded.anchorPages } : {})
  };
  const defaultPage = Math.max(1, Math.min(sharded.sections.length, input.defaultPage ?? 1));
  const catalog: DocumentInfo = {
    id, kind: 'web', title: cleanTitle, ...(safeUrl ? { url: safeUrl } : {}),
    ...sanitizeDocMeta({ ...input }), book, defaultPage, createdAt: new Date().toISOString()
  };
  await writeOnce(path.join(documentsDir, id + '.json'), JSON.stringify(catalog));

  const fragment = input.fragment;
  const page = sharded.target?.page ?? (fragment && Object.hasOwn(sharded.anchorPages, fragment) ? sharded.anchorPages[fragment] : defaultPage);
  const loaded = await library.bookSection(id, page);
  const anchor = sharded.target?.anchor ?? (fragment && Object.entries(loaded.articleLayout ?? {}).find(([, block]) => block.ids?.includes(fragment))?.[0]);
  return { doc: loaded, page, ...(anchor ? { anchor } : {}) };
}

export async function importShardedWebArticle(library: Library, input: Record<string, unknown>, url: URL, paragraphs: string[]): Promise<OpenDocument> {
  let chars = 0;
  for (const p of paragraphs) chars += p.length;
  if (!paragraphs.length || chars > MAX_SHARDED_CHARS) fail('The article is empty or too long.');
  const articleLayout = input.articleLayout === undefined ? undefined : checkPreShardLayout(input.articleLayout, paragraphs.length);
  let targetIndex: number | undefined;
  if (input.anchor !== undefined) {
    if (typeof input.anchor !== 'string' || !/^p-[1-9]\d{0,4}$/.test(input.anchor)) fail('Invalid article anchor.');
    const idx = Number(input.anchor.slice(2)) - 1;
    if (idx >= paragraphs.length) fail('Invalid article anchor.');
    targetIndex = idx;
  }
  let fragment = url.hash.slice(1);
  try { fragment = decodeURIComponent(fragment); } catch {}
  const baseHref = url.origin + url.pathname + url.search;
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 250) : url.hostname;
  const sharded = shardArticle({ url: baseHref, title, paragraphs, ...(articleLayout ? { articleLayout } : {}) }, targetIndex === undefined ? undefined : { targetIndex });
  return importShardedBook(library, { ...sanitizeDocMeta(input), url: baseHref, title, sharded, ...(fragment ? { fragment } : {}) });
}
