import { parse } from 'parse5';
import { openStaxLocation } from '../shared/openstax.js';
import { extractArticle } from '../shared/web-article.js';
import type { OpenDocument } from '../shared/types.js';
import { htmlTree } from './article-dom.js';
import { fail, type Library } from './library.js';
import { publicResource } from './public-resource.js';

export function parseWebArticle(html: string, url: string) {
  return extractArticle(parse(html, { scriptingEnabled: false }), htmlTree, url, '').article;
}

export async function openWebArticle(library: Library, raw: unknown): Promise<OpenDocument> {
  const book = openStaxLocation(raw);
  if (book) return library.openBook(book);
  const { url, bytes, type, charset } = await publicResource(raw, 'document');
  if (bytes.subarray(0, 1024).includes('%PDF-')) {
    let filename = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    try { filename = decodeURIComponent(filename); } catch { /* Keep the original path if its escaping is incomplete. */ }
    if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';
    return { doc: await library.importPdf(filename, bytes, url.href) };
  }
  if (type === 'application/pdf' || bytes.length > 5 * 1024 * 1024) fail('This link did not return a readable HTML article or PDF.', 415);
  const sniff = bytes.subarray(0, 4096).toString('latin1');
  if (!type.includes('html') && !/<(?:!doctype\s+html|html|head|body|article|main)\b/i.test(sniff)) fail('This link did not return a readable HTML article or PDF.', 415);
  const encoding = charset || /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] || 'utf-8';
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(encoding); } catch { decoder = new TextDecoder(); }
  return library.importWebDocument(parseWebArticle(decoder.decode(bytes), url.href));
}
