import path from 'node:path';
import type { DocMetadata, DocumentInfo, OpenDocument } from '../shared/types.js';
import { decodeHtml, isPdfBytes } from './academic-intake.js';
import { importLocalArticle } from './book-import.js';
import { fail, PDF_LIMIT, type Library } from './library.js';
import { cleanFilenameTitle, parseMarkdownArticle } from './markdown-article.js';
import { extractDocumentPages } from './pdf-text.js';
import { HTML_LIMIT } from './public-resource.js';
import type { ReaderStore } from './reader-store.js';
import { replaceDocPages } from './research-store.js';
import { parseWebArticle } from './web-article.js';

interface LocalImportDeps { library: Library; store: ReaderStore }
interface LocalFileInput { filename: string; bytes: Buffer; contentType?: string; url?: string; meta?: DocMetadata }
interface FormatHandler {
  limit: number;
  run: (deps: LocalImportDeps, input: LocalFileInput, filename: string) => Promise<{ opened: OpenDocument; pdfBytes?: Buffer }>;
}

const UNSUPPORTED_MESSAGE = 'Unsupported file type. Choose a PDF, Markdown (.md), or HTML (.html) file.';
const hasBinaryPrefix = (bytes: Buffer): boolean => bytes.subarray(0, 4096).includes(0) || isPdfBytes(bytes);

const mdHandler: FormatHandler = {
  limit: HTML_LIMIT,
  async run({ library }, input, filename) {
    if (hasBinaryPrefix(input.bytes)) fail('This file does not contain readable Markdown text.', 415);
    const article = parseMarkdownArticle(new TextDecoder('utf-8').decode(input.bytes), filename);
    return { opened: await importLocalArticle(library, article) };
  }
};

const htmlHandler: FormatHandler = {
  limit: HTML_LIMIT,
  async run({ library }, input, filename) {
    if (hasBinaryPrefix(input.bytes)) fail('This file does not contain readable HTML.', 415);
    const article = parseWebArticle(decodeHtml(input.bytes, 'text/html'), '', cleanFilenameTitle(filename));
    return { opened: await importLocalArticle(library, article) };
  }
};

const FORMAT_HANDLERS: Record<string, FormatHandler> = {
  '.pdf': {
    limit: PDF_LIMIT,
    async run({ library }, input, filename) {
      const doc = await library.importPdf(filename || 'Document.pdf', input.bytes, input.url, input.meta);
      return { opened: { doc }, pdfBytes: input.bytes };
    }
  },
  '.md': mdHandler,
  '.markdown': mdHandler,
  '.html': htmlHandler,
  '.htm': htmlHandler
};

export function resolveImportFilename(headers: Headers, params: URLSearchParams): string {
  const raw = (headers.get('x-filename') || '').trim();
  if (raw) { try { return decodeURIComponent(raw); } catch { return raw; } }
  return (params.get('filename') || params.get('title') || '').trim();
}

function resolveExtension(filename: string, contentType?: string): string {
  const ext = path.extname(filename.trim()).toLowerCase();
  if (ext) return ext;
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  return mime === 'application/pdf' ? '.pdf' : mime === 'text/markdown' || mime === 'text/x-markdown' ? '.md' : mime === 'text/html' || mime === 'application/xhtml+xml' ? '.html' : '';
}

function getHandler(filename: string, contentType?: string): { ext: string; handler: FormatHandler } {
  const ext = resolveExtension(filename, contentType);
  const handler = Object.hasOwn(FORMAT_HANDLERS, ext) ? FORMAT_HANDLERS[ext] : undefined;
  if (!handler) fail(UNSUPPORTED_MESSAGE, 415);
  return { ext, handler };
}

export function fileImportLimit(filename: string, contentType?: string): number {
  return getHandler(filename, contentType).handler.limit;
}

async function indexImported(deps: LocalImportDeps, doc: DocumentInfo, pdfBytes?: Buffer): Promise<void> {
  try {
    const pages = await extractDocumentPages(doc, pdfBytes, doc.book ? page => deps.library.cachedSection(doc, page) : undefined);
    if (pages.length && deps.library.hasSync(doc.id)) deps.store.withDb(true, db => replaceDocPages(db, doc.id, pages));
  } catch {}
}

export async function importLocalFile(deps: LocalImportDeps, input: LocalFileInput): Promise<OpenDocument> {
  const filename = path.basename(input.filename.trim());
  const { ext, handler } = getHandler(filename, input.contentType);
  if (input.bytes.length > handler.limit) fail(ext === '.pdf' ? 'Choose a PDF of up to 80 MB.' : 'Choose a file of up to 32 MB.', 413);
  if (!input.bytes.length) fail('The file is empty.', 400);
  const { opened, pdfBytes } = await handler.run(deps, input, filename || `Document${ext}`);
  await indexImported(deps, opened.doc, pdfBytes);
  return opened;
}
