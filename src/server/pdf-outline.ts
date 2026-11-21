import { maxOutlineLineLength, maxOutlineLinesPerPage, type PdfOutlineEntry, type PdfOutlineLine } from '../shared/pdf-outline.js';
import type { DocumentInfo } from '../shared/types.js';
import { Library } from './library.js';
import { ReaderModel } from './reader-model.js';
import { ReaderStore } from './reader-store.js';
import { isObject, pageNumber, ServiceError, stringValue, type Input } from './service-types.js';

interface SourcePage { page: number; lines: (PdfOutlineLine & { id: string })[] }
interface OutlineResult { entries: PdfOutlineEntry[] }
const batchBytes = 22_000;
const batchPages = 64;

function readPages(input: Input): SourcePage[] {
  const count = pageNumber(input.pageCount);
  if (!Array.isArray(input.pages) || input.pages.length !== count || count > 100_000) {
    throw new ServiceError(400, 'The contents request needs text positions from every PDF page.');
  }
  return input.pages.map((page: unknown, index: number) => {
    const number = index + 1;
    if (!isObject(page) || page.page !== number || !Array.isArray(page.lines) || page.lines.length > maxOutlineLinesPerPage) {
      throw new ServiceError(400, 'Check the order and size of the PDF page excerpts.');
    }
    const lines = page.lines.map((line: unknown, offset: number) => {
      if (!isObject(line) || typeof line.top !== 'number' || !Number.isFinite(line.top) || line.top < 0 || line.top > 1 ||
          (line.prominent !== undefined && typeof line.prominent !== 'boolean')) {
        throw new ServiceError(400, 'A PDF excerpt has an invalid position or format.');
      }
      const text = stringValue(line.text, 'PDF excerpt', maxOutlineLineLength, true).replace(/\s+/gu, ' ');
      return { id: `p${number}-l${offset + 1}`, text, top: line.top, ...(line.prominent ? { prominent: true } : {}) };
    });
    return { page: number, lines };
  });
}

function* batches(pages: SourcePage[]): Generator<SourcePage[]> {
  let batch: SourcePage[] = [], bytes = 0;
  for (const page of pages) {
    if (!page.lines.length) continue;
    const size = Buffer.byteLength(JSON.stringify(page)) + 1;
    if (batch.length && (bytes + size > batchBytes || batch.length === batchPages)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(page);
    bytes += size;
  }
  if (batch.length) yield batch;
}

function selectedEntries(raw: string, batch: SourcePage[]): PdfOutlineEntry[] {
  const invalid = () => new ServiceError(502, 'The model returned invalid PDF contents. Try generating the contents again.');
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch { throw invalid(); }
  if (!isObject(value) || !Array.isArray(value.entries) || value.entries.length > batch.length * maxOutlineLinesPerPage) throw invalid();
  const picks = new Map<string, { level: number; title?: string }>();
  for (const pick of value.entries) {
    if (!isObject(pick) || typeof pick.id !== 'string' || picks.has(pick.id) || typeof pick.level !== 'number' ||
        !Number.isInteger(pick.level) || pick.level < 1 || pick.level > 6) throw invalid();
    const { title } = pick;
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > maxOutlineLineLength || /[\u0000-\u001f\u007f]/u.test(title))) throw invalid();
    picks.set(pick.id, { level: pick.level, title: title?.trim() });
  }
  // Traverse the original reading order, including pages with multiple columns. Coordinates always come from the PDF.
  const entries: PdfOutlineEntry[] = [];
  for (const { page, lines } of batch) {
    for (const line of lines) {
      const pick = picks.get(line.id);
      if (!pick) continue;
      const title = line.prominent ? line.text : pick.title ?? line.text;
      entries.push({ page, top: line.top, title, level: pick.level });
      picks.delete(line.id);
    }
  }
  if (picks.size) throw invalid();
  return entries;
}

export class PdfOutlines {
  private readonly pending = new Map<string, Promise<OutlineResult>>();
  constructor(private readonly documents: Library, private readonly store: ReaderStore, private readonly model: ReaderModel) {}

  private async pdf(id: unknown): Promise<DocumentInfo> {
    const doc = await this.documents.get(id);
    if (doc.kind !== 'pdf') throw new ServiceError(415, 'AI contents are available for PDF documents.');
    return doc;
  }
  async get(input: Input): Promise<OutlineResult> {
    const doc = await this.pdf(input.docId);
    return { entries: this.store.pdfOutline(doc.id) };
  }
  async generate(input: Input): Promise<OutlineResult> {
    const doc = await this.pdf(input.docId);
    const entries = this.store.pdfOutline(doc.id);
    if (entries.length) return { entries };
    const pending = this.pending.get(doc.id);
    if (pending) return pending;
    const job = this.create(doc, input).finally(() => this.pending.delete(doc.id));
    this.pending.set(doc.id, job);
    return job;
  }
  private async create(doc: DocumentInfo, input: Input): Promise<OutlineResult> {
    const pages = readPages(input);
    if (!pages.some(page => page.lines.length)) {
      throw new ServiceError(422, 'This PDF has no searchable text. Run OCR and import the searchable PDF to generate its contents.');
    }
    const entries: PdfOutlineEntry[] = [];
    const settings = this.store.settings();
    for (const batch of batches(pages)) {
      const raw = await this.model.outline(settings, {
        title: doc.paperTitle || doc.title, pageCount: pages.length, previousSections: entries.slice(-4), pages: batch
      });
      for (const entry of selectedEntries(raw, batch)) {
        entry.level = Math.min(entry.level, (entries.at(-1)?.level ?? 0) + 1);
        entries.push(entry);
      }
    }
    if (!entries.length) throw new ServiceError(502, 'The model could not identify any sections in this PDF. Try generating the contents again.');
    return { entries: this.store.pdfOutline(doc.id, entries) };
  }
}
