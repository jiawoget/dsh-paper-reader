import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractArxivId } from '../shared/citation-export.js';
import type { CreateAbstractInput, DocPageRecord, DocumentInfo } from '../shared/types.js';
import { articleUrl } from '../shared/web-article.js';
import { missingDocMeta, sanitizeDocMeta } from './library-meta.js';
import { extractPdfPages } from './pdf-text.js';
import { isObject, ServiceError } from './service-types.js';

function bad(message: string, status = 400): never { throw new ServiceError(status, message); }

async function atomicWrite(file: string, content: Buffer | string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { flag: 'wx' });
  try { await rename(tmp, file); } finally { await rm(tmp, { force: true }); }
}

export function abstractDocId(input: CreateAbstractInput): string {
  const meta = sanitizeDocMeta({ ...input });
  const doi = meta.doi?.toLowerCase();
  const arxiv = extractArxivId(input.url, meta.doi)?.toLowerCase();
  const normTitle = (meta.paperTitle || input.title).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const key = doi ? 'doi:' + doi : arxiv ? 'arxiv:' + arxiv : 'title:' + normTitle + '|' + (meta.year ?? '');
  return 'abs-' + createHash('sha256').update(key).digest('hex');
}

export async function createAbstractRecord(dir: string, input: unknown): Promise<DocumentInfo> {
  if (!isObject(input)) bad('Invalid abstract record payload.');
  const rawTitle = typeof input.title === 'string' && input.title.trim() ? input.title.trim()
    : typeof input.paperTitle === 'string' ? input.paperTitle.trim() : '';
  const title = rawTitle.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250);
  if (!title) bad('A document title is required.');
  const cleanMeta = sanitizeDocMeta(input);
  const safeUrl = typeof input.url === 'string' ? articleUrl(input.url)?.href : undefined;
  const id = abstractDocId({ title, ...(safeUrl ? { url: safeUrl } : {}), ...cleanMeta });
  const file = path.join(dir, id + '.json');
  await mkdir(dir, { recursive: true });
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    let changed = false;
    if (!saved.url && safeUrl) { saved.url = safeUrl; changed = true; }
    for (const [k, v] of Object.entries(missingDocMeta(saved, cleanMeta))) { saved[k] = v; changed = true; }
    if (changed) await atomicWrite(file, JSON.stringify(saved));
    const kind = saved.kind === 'pdf' || saved.kind === 'web' || saved.kind === 'abstract' ? saved.kind : 'abstract';
    return {
      id, kind, title: typeof saved.title === 'string' ? saved.title : title,
      ...(typeof saved.url === 'string' ? { url: saved.url } : {}), ...sanitizeDocMeta(saved),
      ...(typeof saved.createdAt === 'string' ? { createdAt: saved.createdAt } : {}),
      defaultPage: typeof saved.defaultPage === 'number' ? saved.defaultPage : 1
    };
  }
  const doc: DocumentInfo = {
    id, kind: 'abstract', title, ...(safeUrl ? { url: safeUrl } : {}),
    ...cleanMeta, createdAt: new Date().toISOString(), defaultPage: 1
  };
  await atomicWrite(file, JSON.stringify(doc));
  return doc;
}

export async function attachPdfToRecord(dir: string, doc: DocumentInfo, bytes: Buffer, limit: number): Promise<{ doc: DocumentInfo; pages: DocPageRecord[] }> {
  if (doc.kind !== 'abstract') bad('Only abstract-only records can attach a PDF.');
  if (!bytes.length || bytes.length > limit || !bytes.subarray(0, 1024).includes('%PDF-')) bad('Choose a valid PDF of up to 80 MB.');
  let pages: DocPageRecord[];
  try { pages = await extractPdfPages(bytes); } catch { bad('The uploaded PDF is damaged or unreadable.'); }
  if (!pages.length) bad('The uploaded PDF has no readable pages.');
  const jsonFile = path.join(dir, doc.id + '.json'), pdfFile = path.join(dir, doc.id + '.pdf');
  if (!existsSync(jsonFile)) bad('This document has not been imported.', 404);
  const saved = JSON.parse(await readFile(jsonFile, 'utf8')) as Record<string, unknown>;
  await atomicWrite(pdfFile, bytes);
  saved.kind = 'pdf';
  await atomicWrite(jsonFile, JSON.stringify(saved));
  return { doc: { ...doc, kind: 'pdf' }, pages };
}
