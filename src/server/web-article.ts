import { parse } from 'parse5';
import { parseAcademicInput } from '../shared/academic-intake.js';
import { openStaxLocation } from '../shared/openstax.js';
import { extractArticle } from '../shared/web-article.js';
import type { OpenDocument } from '../shared/types.js';
import { decodeHtml, isPdfBytes, pdfFilename, resolveAcademicIntake, type AcademicIntakeOptions, type ResourceReader } from './academic-intake.js';
import { htmlTree } from './article-dom.js';
import type { Library } from './library.js';
import { publicResource } from './public-resource.js';

export function parseWebArticle(html: string, url: string) {
  return extractArticle(parse(html, { scriptingEnabled: false }), htmlTree, url, '').article;
}

export async function openWebArticle(library: Library, raw: unknown, readResource: ResourceReader = publicResource, options?: AcademicIntakeOptions): Promise<OpenDocument> {
  const book = openStaxLocation(raw);
  if (book) return library.openBook(book);
  const target = parseAcademicInput(raw);
  if (target && target.kind !== 'url') return resolveAcademicIntake(library, target, readResource, parseWebArticle, options);
  const { url, bytes, type, charset } = await readResource(target ? target.url : raw, 'document');
  if (isPdfBytes(bytes)) return { doc: await library.importPdf(pdfFilename(url), bytes, url.href) };
  return library.importWebDocument(parseWebArticle(decodeHtml(bytes, type, charset), url.href));
}
