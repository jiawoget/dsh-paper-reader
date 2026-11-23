import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, linkSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { readArticleRegion } from '../shared/article-region.js';
import { markdownHeading } from '../shared/notebook-structure.js';
import { quoteLocator } from '../shared/source-link.js';
import type { DocumentInfo } from '../shared/types.js';
import type { Library } from './library.js';
import { filenameStem, vaultFolder, writeMarkdown } from './obsidian.js';
import { isObject, ServiceError } from './service-types.js';

export const readerRoute = /^\/api\/paper-reader\/app\/(?:index\.html)?$/;
function publicSource(value?: string): URL | undefined {
  const url = value && URL.parse(value);
  if (url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !readerRoute.test(url.pathname)) return url;
}
interface Targets { original?: string; copy?: string; zotero?: string }

function publishPdf(original: string, file: string): void {
  const temp = path.join(path.dirname(file), '.source-' + randomUUID() + '.tmp');
  copyFileSync(original, temp, constants.COPYFILE_EXCL);
  try {
    try { linkSync(temp, file); }
    catch (error) {
      if (!isObject(error) || !['EPERM','ENOSYS','ENOTSUP','EXDEV','EMLINK'].includes(String(error.code))) throw error;
      copyFileSync(temp, file, constants.COPYFILE_EXCL);
    }
  } finally { unlinkSync(temp); }
}

// Source copies belong to the vault. They can move with it and are never
// overwritten when a reader revisits a notebook.
export class VaultSources {
  private pages = new Map<number, Pick<DocumentInfo, 'paragraphs' | 'articleLayout'> | undefined>();
  constructor(private library: Library, readonly doc: DocumentInfo | undefined, private fallback?: string) {}

  useSavedSources(addresses: string[]): void {
    if (!publicSource(this.fallback)) this.fallback = addresses.find(value => publicSource(value));
  }

  targets(reader: URL, vault: string, folder: string, zotero?: string): Targets {
    const doc = this.doc;
    const page = Number(reader.searchParams.get('page')) || 1;
    const section = doc?.book?.sections[page - 1];
    const url = publicSource(section?.url ?? doc?.url) ?? publicSource(this.fallback) ??
      (doc?.doi && /^10\.\d{4,9}\/\S+$/.test(doc.doi) ? publicSource('https://doi.org/' + doc.doi) : undefined);
    const rawAnchor = reader.searchParams.get('anchor') || '';
    const anchor = readArticleRegion(rawAnchor)?.start ?? rawAnchor;
    const quote = reader.searchParams.get('quote');
    let copy: string | undefined;
    if (doc && (!doc.book || section)) {
      if (!this.pages.has(page)) this.pages.set(page, section ? this.library.cachedSection(doc, page) : doc);
      const material = this.pages.get(page);
      const publisherId = material?.articleLayout?.[anchor]?.ids?.[0];
      if (url && doc.kind === 'web') {
        if (publisherId) url.hash = encodeURIComponent(publisherId);
        else if (quote && anchor && !readArticleRegion(rawAnchor)) url.hash = ':~:text=' + encodeURIComponent(quoteLocator(quote)).replaceAll('-', '%2D');
      }
      if (url && doc.kind === 'pdf' && (/\.pdf$/i.test(url.pathname) || /\/pdf\//.test(url.pathname))) url.hash = 'page=' + page;
      if (doc.kind === 'pdf' || material?.paragraphs?.length) {
        const id = createHash('sha256').update(doc.id + '/' + (section?.slug ?? '')).digest('hex').slice(0, 12);
        const title = section?.title ?? doc.title.replace(/\.pdf$/i, '');
        const name = filenameStem(title, 64) + ' - ' + id + (doc.kind === 'pdf' ? '.pdf' : '.md');
        const file = path.join(vaultFolder(vault, 'Sources', true), name);
        const existing = lstatSync(file, {throwIfNoEntry:false});
        if (existing && !existing.isFile()) throw new ServiceError(409, 'The library copy in the vault must be a regular file.');
        if (!existing) {
          if (doc.kind === 'pdf') publishPdf(this.library.pdfFile(doc), file);
          else {
            const paragraphs = material!.paragraphs!.map((text, i) =>
              text.trim().replace(/([\\`*_{}\[\]()<>#+!|~$-])/g, '\\$1') + ' ^p-' + (i + 1));
            const original = publicSource(section?.url ?? doc.url);
            writeMarkdown(file, undefined, ['# ' + markdownHeading(title), ...(original ? ['[Original source](<' + original.href + '>)'] : []), ...paragraphs].join('\n\n') + '\n');
          }
        }
        copy = path.relative(folder, file).split(path.sep).map(encodeURIComponent).join('/');
        if (doc.kind === 'pdf') copy += '#page=' + page;
        else if (/^p-[1-9]\d*$/.test(anchor) && material?.paragraphs?.[Number(anchor.slice(2)) - 1]) copy += '#^' + anchor;
      }
    }
    return { original: url?.href, copy, zotero };
  }
}

export function portableCitation(label: string, targets: Targets): string {
  const links: string[] = [];
  const primary = targets.original ?? targets.copy ?? targets.zotero;
  const caption = label === 'Open in Paper Reader' ? (targets.original ? 'Original source' : targets.copy ? 'Library copy' : 'Zotero') : label;
  if (primary) links.push('[' + caption + '](<' + primary + '>)');
  else if (label !== 'Open in Paper Reader') links.push(label);
  if (targets.copy && targets.copy !== primary) links.push('[Library copy](<' + targets.copy + '>)');
  if (targets.zotero && targets.zotero !== primary) links.push('[Zotero](<' + targets.zotero + '>)');
  return links.join(' · ');
}
