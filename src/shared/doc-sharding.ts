import { bookSlug } from './openstax.js';
import type { BookSection } from './types.js';
import { articleUrl, type ArticleBlock, type ArticleLayout, type WebArticle } from './web-article.js';

interface ShardOptions {
  maxBlocks?: number; maxChars?: number; chunkBlocks?: number; chunkChars?: number;
  targetIndex?: number;
  sectionUrl?: (slug: string, firstAnchor?: string) => string;
}
interface ShardedSection extends BookSection { paragraphs: string[]; articleLayout: ArticleLayout }
export interface ShardedBook {
  slug: string; sections: ShardedSection[]; bookSections: BookSection[]; anchorPages: Record<string, number>;
  target?: { page: number; anchor: string };
}
interface IndexedBlock { text: string; block?: ArticleBlock; sourceIndex: number }
interface RawGroup { title: string; chapterId: string; chapterTitle: string; items: IndexedBlock[] }

const DEFAULT_MAX_BLOCKS = 120, DEFAULT_MAX_CHARS = 80_000, DEFAULT_CHUNK_BLOCKS = 80, DEFAULT_CHUNK_CHARS = 60_000;
const MAX_ANCHOR_ENTRIES = 20_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const cleanHeading = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 160);
const sumChars = (items: readonly { length: number }[]): number => items.reduce((sum, x) => sum + x.length, 0);
const itemsChars = (items: readonly IndexedBlock[]): number => items.reduce((sum, x) => sum + x.text.length, 0);

function toSlug(raw: string, fallback: string): string {
  const cleaned = [...raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^[_-]+|[_-]+$/g, '')].slice(0, 80).join('');
  return bookSlug(cleaned) ? cleaned : fallback;
}

export function shouldShardArticle(article: Pick<WebArticle, 'paragraphs'>, opts?: Pick<ShardOptions, 'maxBlocks' | 'maxChars'>): boolean {
  return article.paragraphs.length > (opts?.maxBlocks ?? DEFAULT_MAX_BLOCKS)
    || sumChars(article.paragraphs) > (opts?.maxChars ?? DEFAULT_MAX_CHARS);
}

function splitByH3(group: RawGroup): RawGroup[] {
  const sub: RawGroup[] = [];
  let cur: RawGroup | undefined, curHeadingOnly = false;
  for (const item of group.items) {
    const kind = item.block?.kind;
    if (kind === 'h3') {
      const heading = cleanHeading(item.text) || group.title;
      if (cur && curHeadingOnly) { cur.title = heading; cur.items.push(item); curHeadingOnly = false; }
      else {
        if (cur?.items.length) sub.push(cur);
        cur = { title: heading, chapterId: group.chapterId, chapterTitle: group.chapterTitle, items: [item] };
        curHeadingOnly = false;
      }
      continue;
    }
    const isH12 = kind === 'h1' || kind === 'h2';
    if (!cur) { cur = { title: group.title, chapterId: group.chapterId, chapterTitle: group.chapterTitle, items: [item] }; curHeadingOnly = isH12; }
    else { cur.items.push(item); if (!isH12) curHeadingOnly = false; }
  }
  if (cur?.items.length) sub.push(cur);
  return sub;
}

function chunkGroup(group: RawGroup, maxBlocks: number, maxChars: number): RawGroup[] {
  const parts: RawGroup[] = [];
  let slice: IndexedBlock[] = [], chars = 0;
  const flush = () => {
    if (!slice.length) return;
    const partIndex = parts.length + 1;
    const title = partIndex === 1 ? group.title : `${group.title} (${partIndex})`;
    parts.push({ title, chapterId: group.chapterId, chapterTitle: group.chapterTitle, items: slice });
    slice = []; chars = 0;
  };
  for (const item of group.items) {
    if (slice.length && (slice.length >= maxBlocks || chars + item.text.length > maxChars)) flush();
    slice.push(item); chars += item.text.length;
  }
  flush();
  return parts;
}

function boundGroups(groups: RawGroup[], maxBlocks: number, maxChars: number, chunkBlocks: number, chunkChars: number): RawGroup[] {
  const bounded: RawGroup[] = [], targetBlocks = Math.min(chunkBlocks, maxBlocks), targetChars = Math.min(chunkChars, maxChars);
  for (const group of groups) {
    if (group.items.length <= maxBlocks && itemsChars(group.items) <= maxChars) { bounded.push(group); continue; }
    const subGroups = group.items.some((item, idx) => idx > 0 && item.block?.kind === 'h3') ? splitByH3(group) : [group];
    for (const sub of subGroups) {
      if (sub.items.length <= maxBlocks && itemsChars(sub.items) <= maxChars) bounded.push(sub);
      else bounded.push(...chunkGroup(sub, targetBlocks, targetChars));
    }
  }
  return bounded;
}

export function shardArticle(article: WebArticle, opts?: ShardOptions): ShardedBook {
  const maxBlocks = Math.max(1, opts?.maxBlocks ?? DEFAULT_MAX_BLOCKS), maxChars = Math.max(1_000, opts?.maxChars ?? DEFAULT_MAX_CHARS);
  const chunkBlocks = Math.max(1, opts?.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS), chunkChars = Math.max(1_000, opts?.chunkChars ?? DEFAULT_CHUNK_CHARS);
  const items: IndexedBlock[] = article.paragraphs.map((text, idx) => ({ text, block: article.articleLayout?.['p-' + (idx + 1)], sourceIndex: idx }));
  const docTitle = cleanHeading(article.title) || 'Document';
  let chapterSeq = 0, chapterTitle = docTitle, chapterId = toSlug('ch-0-' + docTitle, 'ch-0');
  const groups: RawGroup[] = [];
  let current: RawGroup | undefined, currentOnlyH1 = false;
  for (const item of items) {
    const kind = item.block?.kind;
    if (kind === 'h1' || kind === 'h2') {
      const heading = cleanHeading(item.text) || (kind === 'h1' ? docTitle : chapterTitle);
      if (kind === 'h1') { chapterSeq++; chapterTitle = heading; chapterId = toSlug(`ch-${chapterSeq}-${heading}`, `ch-${chapterSeq}`); }
      if (current && currentOnlyH1) {
        current.title = heading; current.chapterId = chapterId; current.chapterTitle = chapterTitle; current.items.push(item);
        currentOnlyH1 = kind === 'h1';
      } else {
        if (current?.items.length) groups.push(current);
        current = { title: heading, chapterId, chapterTitle, items: [item] };
        currentOnlyH1 = kind === 'h1';
      }
    } else if (!current) { current = { title: chapterTitle, chapterId, chapterTitle, items: [item] }; currentOnlyH1 = false; }
    else { current.items.push(item); currentOnlyH1 = false; }
  }
  if (current?.items.length) groups.push(current);
  if (groups.length > 1 && groups[0].chapterId.startsWith('ch-0')) {
    const nextChapter = groups.find(g => g.chapterId !== groups[0].chapterId);
    if (nextChapter && groups[0].chapterTitle.toLowerCase() === nextChapter.chapterTitle.toLowerCase()) {
      const label = nextChapter.chapterTitle.toLowerCase() === 'overview' ? 'Preface' : 'Overview';
      const oldId = groups[0].chapterId, newId = 'ch-0-' + label.toLowerCase();
      for (const g of groups) {
        if (g.chapterId !== oldId) break;
        if (g.title.toLowerCase() === nextChapter.chapterTitle.toLowerCase()) g.title = label;
        g.chapterTitle = label; g.chapterId = newId;
      }
    }
  }

  const bounded = boundGroups(groups, maxBlocks, maxChars, chunkBlocks, chunkChars);
  const parsedUrl = articleUrl(article.url), baseUrl = parsedUrl ? parsedUrl.origin + parsedUrl.pathname + parsedUrl.search : '';
  const bookSlugValue = toSlug(docTitle || parsedUrl?.hostname || 'doc', 'doc');
  const sections: ShardedSection[] = [], bookSections: BookSection[] = [], anchorPages: Record<string, number> = {};
  let anchorCount = 0, target: { page: number; anchor: string } | undefined;
  for (let i = 0; i < bounded.length; i++) {
    const group = bounded[i], page = i + 1;
    const paragraphs: string[] = [], articleLayout: ArticleLayout = {};
    let firstAnchor = '';
    for (let j = 0; j < group.items.length; j++) {
      const { text, block, sourceIndex } = group.items[j], key = 'p-' + (j + 1);
      if (sourceIndex === opts?.targetIndex) target = { page, anchor: key };
      paragraphs.push(text);
      if (!block) continue;
      articleLayout[key] = block;
      if (Array.isArray(block.ids)) {
        for (const id of block.ids) {
          if (typeof id !== 'string') continue;
          if (!firstAnchor) firstAnchor = id;
          if (id && !FORBIDDEN_KEYS.has(id) && !Object.hasOwn(anchorPages, id) && anchorCount < MAX_ANCHOR_ENTRIES) {
            anchorPages[id] = page; anchorCount++;
          }
        }
      }
    }
    const slug = toSlug(`s${page}-${group.title}`, `s${page}`);
    const url = opts?.sectionUrl ? opts.sectionUrl(slug, firstAnchor || undefined)
      : baseUrl ? (firstAnchor ? `${baseUrl}#${encodeURIComponent(firstAnchor)}` : baseUrl) : '';
    const meta: BookSection = { slug, title: group.title, chapterId: group.chapterId, chapterTitle: group.chapterTitle, url };
    bookSections.push(meta);
    sections.push({ ...meta, paragraphs, articleLayout });
  }
  return { slug: bookSlugValue, sections, bookSections, anchorPages, ...(target ? { target } : {}) };
}
