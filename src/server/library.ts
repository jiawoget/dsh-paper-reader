import { createHash, randomUUID } from 'node:crypto';
import { mkdir, link, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bookSlug, openStaxLocation, openStaxUrl, type OpenStaxLocation } from '../shared/openstax.js';
import type { DocumentInfo, OpenDocument, ReaderBlock } from '../shared/types.js';
import type { WebArticle } from '../shared/web-article.js';
import { hasDecoderRepetition, translationQualityError } from '../shared/translation-quality.js';
import { readArticleLayout } from './article-layout.js';
import { parseOpenStaxPage, publishedEntry, type ReadBookResource } from './openstax.js';
import { publicResource } from './public-resource.js';

export const PDF_LIMIT = 80 * 1024 * 1024;
const sampleDigest = '55b3b324d779a67c59dac2519445e3b07c14e6ff5c656fadb47a3d7b5997469e';
export const sample: DocumentInfo = {
  id: 'pagedattention', kind: 'pdf', title: 'PagedAttention.pdf', authors: 'Kwon et al.', venue: 'SOSP 2023',
  paperTitle: 'Efficient Memory Management for Large Language Model Serving with PagedAttention',
  url: 'https://arxiv.org/abs/2309.06180', doi: '10.1145/3600006.3613165', defaultPage: 6
};
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function isRecord(value: unknown): value is Record<string,unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
function isFsError(error: unknown, code: string): boolean { return isRecord(error) && error.code === code; }
const validDocId = (id: unknown): id is string => typeof id === 'string' && (id === sample.id || /^(pdf|web|book)-[a-f0-9]{64}$/.test(id));

async function writeOnce(file: string, bytes: Buffer | string): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    try { await link(temporary, file); } catch (error) { if (!isFsError(error, 'EEXIST')) throw error; }
  } finally { await rm(temporary, { force: true }); }
}

type Translate = (blocks: ReaderBlock[], documentKind: DocumentInfo['kind']) => Promise<Record<string,string>>;
type ArticleImage = { type: string; bytes: Buffer };
const pictureType = /^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)$/;
export class Library {
  private readonly directory: string;
  private readonly translationDir: string;
  private readonly imageDir: string;
  private readonly imageJobs = new Map<string, Promise<ArticleImage>>();
  private readonly jobs = new Map<string, Promise<Record<string,string>>>();
  private readonly bookJobs = new Map<string, Promise<DocumentInfo>>();
  constructor(root: string, private readonly readBook: ReadBookResource = publicResource) {
    this.directory = path.join(root, 'documents');
    this.translationDir = path.join(root, 'translations');
    this.imageDir = path.join(root, 'article-images');
  }
  private async store(doc: DocumentInfo): Promise<DocumentInfo> {
    await mkdir(this.directory, { recursive: true });
    await writeOnce(path.join(this.directory, doc.id + '.json'), JSON.stringify(doc));
    return this.get(doc.id);
  }
  async get(id: unknown): Promise<DocumentInfo> {
    if (!validDocId(id)) fail('Invalid document ID.', 404);
    if (id === sample.id) return sample;
    try {
      const value: unknown = JSON.parse(await readFile(path.join(this.directory, id + '.json'), 'utf8'));
      if (!isRecord(value) || value.id !== id || typeof value.title !== 'string' || !['pdf','web'].includes(String(value.kind))) fail('The document index is damaged.', 500);
      if (id.startsWith('book-')) {
        if (value.kind !== 'web' || !isRecord(value.book) || !bookSlug(value.book.slug) || !Array.isArray(value.book.sections) || !value.book.sections.length ||
          !value.book.sections.every((section: unknown) => isRecord(section) && bookSlug(section.slug) && typeof section.title === 'string' &&
            typeof section.chapterId === 'string' && typeof section.chapterTitle === 'string' && typeof section.url === 'string')) fail('The saved book contents are damaged.', 500);
        return value as unknown as DocumentInfo;
      }
      if (value.kind === 'web' && (!Array.isArray(value.paragraphs) || !value.paragraphs.every((p:unknown) => typeof p === 'string'))) fail('The saved article is damaged.', 500);
      const doc = value as unknown as DocumentInfo;
      if (doc.kind === 'pdf' && !doc.url) {
        try { doc.url = await readFile(path.join(this.directory, id + '.source-url'), 'utf8'); }
        catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
      }
      if (doc.kind === 'web') {
        try { doc.articleLayout = JSON.parse(await readFile(path.join(this.directory, id + '.layout.json'), 'utf8')); }
        catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
      }
      return doc;
    } catch (error) {
      if (isFsError(error, 'ENOENT')) fail('This document has not been imported.', 404);
      throw error;
    }
  }
  async list(): Promise<DocumentInfo[]> {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(file => /^(pdf|web|book)-[a-f0-9]{64}\.json$/.test(file));
    const docs = await Promise.all(names.map(name => this.get(name.slice(0,-5))));
    return [sample, ...docs.sort((a,b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).map(({ paragraphs, articleLayout, ...meta }) => meta)];
  }
  async rename(id: unknown, title: unknown): Promise<DocumentInfo> {
    if (id === sample.id) fail('The bundled sample paper cannot be renamed.');
    const nextTitle = typeof title === 'string' ? title.trim().slice(0, 250) : '';
    if (!nextTitle) fail('A document title is required.');
    const doc = await this.get(id);
    const file = path.join(this.directory, doc.id + '.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    saved.title = nextTitle;
    const tmp = file + '.' + randomUUID() + '.tmp';
    try { await writeFile(tmp, JSON.stringify(saved)); await rename(tmp, file); }
    finally { await rm(tmp, { force: true }); }
    return this.get(doc.id);
  }
  async delete(id: unknown): Promise<{ id: string; deleted: boolean }> {
    if (id === sample.id) fail('The bundled sample paper cannot be deleted.');
    if (!validDocId(id)) fail('Invalid document ID.', 404);
    const file = path.join(this.directory, id + '.json');
    const existed = existsSync(file);
    await Promise.all([
      rm(file, { force: true }),
      rm(path.join(this.directory, id + '.pdf'), { force: true }),
      rm(path.join(this.directory, id + '.source-url'), { force: true }),
      rm(path.join(this.directory, id + '.layout.json'), { force: true }),
      rm(path.join(this.directory, 'book-sections', id), { recursive: true, force: true }),
      rm(path.join(this.translationDir, id), { recursive: true, force: true }),
      rm(path.join(this.imageDir, id), { recursive: true, force: true })
    ]);
    return { id, deleted: existed };
  }
  private bookJob(key: string, start: () => Promise<DocumentInfo>): Promise<DocumentInfo> {
    const pending = this.bookJobs.get(key);
    if (pending) return pending;
    const job = start().finally(() => this.bookJobs.delete(key));
    this.bookJobs.set(key, job);
    return job;
  }
  private sectionFile(id: string, slug: string): string {
    return path.join(this.directory, 'book-sections', id, hash(slug) + '.json');
  }
  /** Export uses only already-imported material, even when the publisher is offline. */
  cachedSection(doc: DocumentInfo, page: number): Pick<DocumentInfo, 'paragraphs' | 'articleLayout'> | undefined {
    const section = doc.book?.sections[page - 1];
    if (!section) return;
    try { return JSON.parse(readFileSync(this.sectionFile(doc.id, section.slug), 'utf8')); }
    catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  }
  pdfFile(doc: DocumentInfo): string {
    if (doc.kind !== 'pdf' || !validDocId(doc.id)) fail('This document has no saved PDF.');
    if (doc.id !== sample.id) return path.join(this.directory, doc.id + '.pdf');
    const bundled = fileURLToPath(new URL('../web/assets/pagedattention.pdf', import.meta.url));
    return existsSync(bundled) ? bundled : fileURLToPath(new URL('../../public/assets/pagedattention.pdf', import.meta.url));
  }
  private async saveSection(file: string, article: WebArticle): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeOnce(file, JSON.stringify({ paragraphs: article.paragraphs, articleLayout: article.articleLayout }));
  }
  async openBook(location: OpenStaxLocation): Promise<OpenDocument> {
    const url = openStaxUrl(location.book), id = 'book-' + hash(url);
    const doc = await this.bookJob(id, async () => {
      try { return await this.get(id); }
      catch (error) { if (!isRecord(error) || error.status !== 404) throw error; }
      const section = location.section ?? await publishedEntry(location.book, this.readBook);
      const source = await this.readBook(openStaxUrl(location.book, section), 'document');
      const { article, catalog } = parseOpenStaxPage(source.bytes.toString('utf8'), location.book, section, true, location.section ? undefined : section);
      if (!catalog || !catalog.book.sections.some(item => item.slug === section)) fail('This section is missing from the OpenStax table of contents.', 502);
      // Publish the catalog only after the requested section is on disk.
      await this.saveSection(this.sectionFile(id, section), article);
      return this.store({ ...catalog, kind: 'web', id, url, venue: 'OpenStax', createdAt: new Date().toISOString() });
    });
    if (!location.section) return { doc };
    const page = (doc.book?.sections.findIndex(item => item.slug === location.section) ?? -1) + 1;
    if (!page) fail('This section is not in the saved OpenStax table of contents.', 404);
    const loaded = await this.readSection(doc, page);
    const fragment = location.fragment;
    const anchor = fragment && Object.entries(loaded.articleLayout ?? {}).find(([, block]) => block.ids?.includes(fragment))?.[0];
    return { doc: loaded, page, ...(anchor ? { anchor } : {}) };
  }
  async bookSection(id: unknown, page: unknown): Promise<DocumentInfo> {
    return this.readSection(await this.get(id), page);
  }
  private async readSection(doc: DocumentInfo, page: unknown, cachedOnly = false): Promise<DocumentInfo> {
    const book = doc.book;
    if (!book || typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > book.sections.length) fail('Unknown book section.', 404);
    const section = book.sections[page - 1], file = this.sectionFile(doc.id, section.slug);
    const read = async (): Promise<DocumentInfo> => {
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isRecord(saved) || !Array.isArray(saved.paragraphs) || !saved.paragraphs.every((p: unknown) => typeof p === 'string') ||
        !isRecord(saved.articleLayout)) fail('The saved book section is damaged.', 500);
      return { ...doc, sectionPage: page, url: section.url, paragraphs: saved.paragraphs, articleLayout: saved.articleLayout as DocumentInfo['articleLayout'] };
    };
    if (cachedOnly) {
      try { return await read(); }
      catch (error) { if (isFsError(error, 'ENOENT')) fail('This section has not been opened yet.', 404); throw error; }
    }
    return this.bookJob(file, async () => {
      try { return await read(); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
      const source = await this.readBook(openStaxUrl(book.slug, section.slug), 'document');
      const { article } = parseOpenStaxPage(source.bytes.toString('utf8'), book.slug, section.slug, false);
      await this.saveSection(file, article);
      return read();
    });
  }
  async importWeb(input: unknown): Promise<DocumentInfo> {
    return (await this.importWebDocument(input)).doc;
  }
  async importWebDocument(input: unknown): Promise<OpenDocument> {
    if (!isRecord(input) || typeof input.url !== 'string' || !URL.canParse(input.url)) fail('A valid article URL is required.');
    const book = openStaxLocation(input.url);
    if (book) return this.openBook(book);
    const url = new URL(input.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Only HTTP and HTTPS articles are supported.');
    url.hash = '';
    const raw = input.paragraphs;
    if (!Array.isArray(raw) || raw.length > 4000 || !raw.every((p: unknown): p is string => typeof p === 'string')) fail('Invalid article paragraphs.');
    const structured = input.articleLayout !== undefined;
    const paragraphs = structured ? raw : raw.map(p => p.trim()).filter(Boolean);
    if (structured && paragraphs.some(p => !p.trim())) fail('Invalid article paragraphs.');
    if (!paragraphs.length || paragraphs.join('').length > 1_000_000) fail('The article is empty or too long.');
    const id = 'web-' + hash(JSON.stringify([url.href, paragraphs]));
    if (structured) {
      const layout = readArticleLayout(input.articleLayout, paragraphs);
      await mkdir(this.directory, { recursive: true });
      await writeOnce(path.join(this.directory, id + '.layout.json'), JSON.stringify(layout));
    }
    return { doc: await this.store({ kind:'web', id, url:url.href,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0,250) : url.hostname,
      createdAt:new Date().toISOString(), defaultPage:1, paragraphs }) };
  }
  async importPdf(title: string, bytes: Buffer, url?: string): Promise<DocumentInfo> {
    if (bytes.length > PDF_LIMIT || !bytes.subarray(0,1024).includes('%PDF-')) fail('Choose a valid PDF of up to 80 MB.');
    const digest = hash(bytes);
    if (digest === sampleDigest) return sample;
    const id = 'pdf-' + digest;
    await mkdir(this.directory, { recursive: true });
    await writeOnce(path.join(this.directory, id + '.pdf'), bytes);
    const doc = await this.store({ id, kind:'pdf', title:title.trim().slice(0,250) || 'Document.pdf', url, createdAt:new Date().toISOString(), defaultPage:1 });
    if (!doc.url && url) {
      // A local upload and its published PDF share one byte identity. Keep
      // the first subsequently discovered address without replacing metadata.
      await writeOnce(path.join(this.directory, id + '.source-url'), url);
      return this.get(id);
    }
    return doc;
  }
  async bytes(id: unknown): Promise<Buffer> {
    const doc = await this.get(id);
    if (doc.kind !== 'pdf') fail('This document is a web article.');
    return readFile(this.pdfFile(doc));
  }
  async articleImage(id: unknown, anchor: unknown, download: (url: string) => Promise<ArticleImage>, page?: number): Promise<ArticleImage> {
    if (!validDocId(id) || !/^(?:web|book)-/.test(id) || typeof anchor !== 'string' || !/^p-[1-9]\d{0,3}$/.test(anchor)) fail('Unknown article illustration.', 404);
    const book = id.startsWith('book-');
    if (book && (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1)) fail('A book illustration needs its section number.', 404);
    const directory = book ? path.join(this.imageDir, id, String(page)) : path.join(this.imageDir, id);
    const file = path.join(directory, anchor);
    const read = async (): Promise<ArticleImage> => {
      const saved = await readFile(file);
      const end = saved.indexOf(10), type = end > 0 && end < 40 ? saved.toString('ascii', 0, end) : '';
      if (!pictureType.test(type)) fail('The saved illustration is damaged.', 500);
      return { type, bytes: saved.subarray(end + 1) };
    };
    try { return await read(); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    const pending = this.imageJobs.get(file);
    if (pending) return pending;
    const job = (async () => {
      const metadata = await this.get(id);
      const doc = book ? await this.readSection(metadata, page, true) : metadata;
      const url = doc.articleLayout?.[anchor]?.image?.url;
      if (!url) fail('This illustration is not part of the saved article.', 404);
      const picture = await download(url);
      if (!pictureType.test(picture.type) || !picture.bytes.length) fail('The website did not return an illustration.', 415);
      await mkdir(directory, { recursive: true });
      // The MIME and image become visible together. A second reader can only see the complete original.
      await writeOnce(file, Buffer.concat([Buffer.from(picture.type + '\n', 'ascii'), picture.bytes]));
      return read();
    })();
    this.imageJobs.set(file, job);
    try { return await job; } finally { this.imageJobs.delete(file); }
  }
  private pageFile(id: unknown, page: unknown): string {
    if (!validDocId(id) || typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 100000) fail('Invalid document or page number.');
    return path.join(this.translationDir, id, page + '.json');
  }
  async translations(id: unknown, page: unknown): Promise<Record<string,string>> {
    const file = this.pageFile(id,page);
    try {
      const data: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isRecord(data) || !Object.values(data).every(v => typeof v === 'string')) fail('The translation cache is damaged.', 500);
      const translations = data as Record<string,string>;
      if (typeof id === 'string' && /^(?:web|book)-/.test(id)) return translations;
      return Object.fromEntries(Object.entries(translations).filter(([, text]) => !hasDecoderRepetition(text)));
    } catch (error) { if (isFsError(error, 'ENOENT')) return {}; throw error; }
  }
  async translate(id: unknown, page: unknown, input: unknown, translate: Translate): Promise<Record<string,string>> {
    const doc = await this.get(id);
    const file = this.pageFile(id,page);
    if (!Array.isArray(input) || !input.length || input.length > 4000) fail('No translatable paragraphs or page too long.');
    const seen = new Set<string>();
    const blocks = input.map((b:unknown): ReaderBlock => {
      if (!isRecord(b) || typeof b.id !== 'string' || !/^[\w.:-]{1,120}$/.test(b.id) || ['__proto__','prototype','constructor'].includes(b.id) || seen.has(b.id) || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 24000) fail('Invalid paragraph format.');
      seen.add(b.id);
      return {id:b.id,text:b.text};
    });
    const previous = this.jobs.get(file);
    const job = (async () => {
      if (previous) await previous.catch(() => undefined);
      const result = await this.translations(id, page);
      const pending = blocks.filter(b => !result[b.id]?.trim() || (doc.kind === 'pdf' && translationQualityError(b.text, result[b.id])));
      await mkdir(path.dirname(file), { recursive: true });
      for (let i = 0; i < pending.length; i += 8) {
        const batch = pending.slice(i,i+8);
        const translated = await translate(batch, doc.kind);
        for (const {id:key,text} of batch) {
          if (!translated[key]?.trim()) fail('The model omitted a paragraph. Retry to resume the translation.', 502);
          const problem = doc.kind === 'pdf' && translationQualityError(text, translated[key]);
          if (problem) fail(problem, 502);
          result[key] = translated[key];
        }
        const tmp = file + '.' + randomUUID() + '.tmp';
        try { await writeFile(tmp, JSON.stringify(result)); await rename(tmp, file); }
        finally { await rm(tmp, { force:true }); }
      }
      return result;
    })();
    this.jobs.set(file, job);
    try { return await job; } finally { if (this.jobs.get(file) === job) this.jobs.delete(file); }
  }
}
