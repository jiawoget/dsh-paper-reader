import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { DocumentInfo, NotebookSnapshot } from '../shared/types.js';
import type { Library } from './library.js';
import type { ObsidianLauncher } from './obsidian-desktop.js';
import { blocks, contentFor, initialMarkdown, putNote, reconcileNotes, withoutNote } from './notebook-markdown.js';
import { exportChapterVocabulary, exportNotebook, fileContent, filenameFor, filenameStem, vaultFolder, writeMarkdown } from './obsidian.js';
import { notebookKey, ReaderStore, type NotebookChapter, type NotebookRecords, type StoredNotebook } from './reader-store.js';
import { address, pageNumber, ServiceError, single, stringValue, type Entry, type Input } from './service-types.js';

interface OpenNotebook {
  local: StoredNotebook;
  markdown: string;
  vault: string;
  stored: boolean;
  file?: string;
  observed?: string;
  baseline?: string;
  conflict: boolean;
  warning?: string;
}

function vaultAccess<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(503, 'Cannot access the Obsidian notebook. Check the vault path and file permissions in Connections.');
  }
}

function load(records: NotebookRecords, local: StoredNotebook, stored = true): OpenNotebook {
  const vault = records.vault;
  const book: OpenNotebook = { local, markdown: local.markdown, stored, vault, conflict: false };
  if (!vault) return book;
  return vaultAccess(() => {
    const folder = vaultFolder(vault, local.chapter?.bookSlug);
    const binding = records.binding(vault, local.docId, local.chapter);
    let name: string;
    if (binding) {
      name = binding.filename;
      if (name !== path.basename(name) || !name.endsWith('.md')) throw new ServiceError(500, 'The saved notebook filename is invalid.');
    } else {
      // Live notebooks have their own name so existing exports and manually written files stay intact.
      const stem = local.chapter ? filenameStem(local.chapter.title) : filenameFor(local.title.replace(/\.pdf$/i, ''), local.docId).slice(0, -3) + ' - Notebook';
      const reserved = local.chapter && records.chapterFilenames(vault, local.docId);
      name = stem + '.md';
      for (let n = 2; reserved?.has(name.normalize('NFC').toLowerCase()) || lstatSync(path.join(folder, name), { throwIfNoEntry: false }); n++) {
        name = stem + ' (' + n + ').md';
      }
    }
    book.file = path.join(folder, name);
    // A new binding may only create a new file, even if another app writes between choosing its name and saving.
    book.observed = binding ? fileContent(book.file) : undefined;
    book.baseline = binding?.baseline;
    if (binding && book.observed === undefined) {
      throw new ServiceError(409, 'The notebook file was moved or deleted. Restore it at ' + book.file + ', or disconnect this vault to use the local copy.');
    }
    if (binding && book.observed !== undefined && book.observed !== binding.baseline) {
      book.markdown = book.observed;
      book.conflict = local.markdown !== binding.baseline && local.markdown !== book.observed;
      if (!book.conflict) {
        try { records.importChanges(() => reconcileNotes(records, local, local.markdown, book.markdown)); }
        catch (error) {
          if (!(error instanceof ServiceError) || error.status >= 500) throw error;
          book.conflict = true;
          book.warning = error.message + ' Choose Compare latest in Notes to see the last saved copy.';
        }
      }
    }
    return book;
  });
}

function revision(book: OpenNotebook): string {
  return createHash('sha256').update(notebookKey(book.local.docId, book.local.chapter)).update('\0').update(book.file || '').update('\0')
    .update(book.markdown).update('\0').update(book.conflict ? book.local.markdown : '').digest('hex');
}

const nativeUri = (file: string) => 'obsidian://open?path=' + encodeURIComponent(file);

function snapshot(records: NotebookRecords, book: OpenNotebook, desktopOpenAvailable: boolean): NotebookSnapshot {
  const { chapter, docId } = book.local;
  const file = book.observed === undefined ? undefined : book.file;
  return { docId: book.local.docId, markdown: book.markdown, revision: revision(book),
    ...(chapter && { chapterId: chapter.id, chapterTitle: chapter.title, vaultPending: Boolean(book.vault && !file) }),
    ...contentFor(book.conflict ? book.local.markdown : book.markdown, records.entries('note', docId, chapter)),
    path: file ?? null, uri: file ? nativeUri(file) : null, desktopOpenAvailable,
    localConflict: book.conflict ? book.local.markdown : undefined, warning: book.warning };
}

function persist(records: NotebookRecords, book: OpenNotebook): void {
  if (book.conflict) throw new ServiceError(409, 'The local notebook and vault both changed. Choose Compare latest in Notes to merge the two versions.');
  const doc = { ...book.local, markdown: book.markdown };
  if (book.file) {
    const file = book.file;
    vaultAccess(() => {
      if (vaultFolder(book.vault, doc.chapter?.bookSlug, true) !== path.dirname(file)) throw new ServiceError(409, 'The notebook location changed. Refresh before saving.');
      writeMarkdown(file, book.observed, book.markdown);
    });
    if (book.baseline !== book.markdown) records.bind(book.vault, doc, path.basename(book.file));
    book.observed = book.markdown;
  }
  if (book.local.markdown !== book.markdown || !book.stored) records.store(doc);
}

function chapterFor(metadata: DocumentInfo | undefined, input: Input): NotebookChapter | undefined {
  if (!metadata?.book) return;
  const { book } = metadata;
  const linkPage = typeof input.sourceUrl === 'string' && URL.parse(input.sourceUrl)?.searchParams.get('page');
  const page = pageNumber(input.page ?? (linkPage ? Number(linkPage) : 1));
  const section = book.sections[page - 1];
  if (!section) throw new ServiceError(400, 'Choose a section in this book to open its chapter notebook.');
  const sections = new Map<number, typeof section>();
  for (const [index, sibling] of book.sections.entries()) {
    if (sibling.chapterId === section.chapterId) sections.set(index + 1, sibling);
  }
  return { id: section.chapterId, title: section.chapterTitle, bookSlug: book.slug, firstPage: sections.keys().next().value!, sections };
}

function requestDocument(records: NotebookRecords, input: Input, metadata?: DocumentInfo): OpenNotebook {
  const docId = single(input.docId, 'document ID', 512, true);
  const chapter = chapterFor(metadata, input);
  const stored = records.document(docId, chapter);
  if (stored) return load(records, stored);
  const title = metadata?.title ?? stringValue(input.title, 'document title', 2048, true);
  const sourceUrl = address(input.sourceUrl, true);
  if (!/^\/api\/paper-reader\/app\/(?:index\.html)?$/.test(new URL(sourceUrl).pathname)) {
    throw new ServiceError(400, 'Open the paper in Paper Reader to create a notebook with working source links.');
  }
  const doc = { docId, title, sourceUrl, chapter };
  return load(records, { ...doc, markdown: initialMarkdown(doc, records.entries('note', docId, chapter)) }, false);
}

export class PaperNotebooks {
  constructor(private readonly database: ReaderStore, private readonly library: Library, private readonly launch?: ObsidianLauncher) {}

  private async metadata(id: unknown): Promise<DocumentInfo | undefined> {
    if (typeof id !== 'string' || !/^book-[a-f0-9]{64}$/.test(id)) return;
    const doc = await this.library.get(id);
    if (!doc.book) throw new ServiceError(500, 'The saved book has no chapter list.');
    return doc;
  }

  private noteMetadata(input: Input): Promise<DocumentInfo | undefined> {
    const docId = input.docId ?? (input.id && this.database.withNotebook(records => records.note(single(input.id, 'note ID', 128, true))?.docId));
    return this.metadata(docId);
  }

  async read(input: Input): Promise<NotebookSnapshot> {
    const metadata = await this.metadata(input.docId);
    return this.database.withNotebook(records => {
      const book = requestDocument(records, input, metadata);
      const { docId, chapter } = book.local;
      if (!book.conflict && (!chapter || book.stored || records.entries('note', docId, chapter).length)) persist(records, book);
      return snapshot(records, book, Boolean(this.launch));
    });
  }

  async write(input: Input): Promise<NotebookSnapshot> {
    const markdown = stringValue(input.markdown, 'notebook Markdown', 4_000_000, false, true);
    if (typeof input.markdown !== 'string') throw new ServiceError(400, 'The full Markdown text is required.');
    const metadata = await this.metadata(input.docId);
    return this.database.withNotebook(records => {
      const book = requestDocument(records, input, metadata);
      if (input.expectedRevision !== revision(book)) throw new ServiceError(409, 'The notebook changed. Compare the latest Markdown with your draft before saving.');
      blocks(markdown);
      reconcileNotes(records, book.local, book.conflict ? book.local.markdown : book.markdown, markdown);
      book.conflict = false;
      book.warning = undefined;
      book.markdown = markdown;
      persist(records, book);
      return snapshot(records, book, Boolean(this.launch));
    });
  }

  async openOnDesktop(input: Input): Promise<{uri:string}> {
    const docId=single(input.docId,'document ID',512,true);
    if(!this.launch)throw new ServiceError(503,'Open this link in the Obsidian desktop app.');
    const chapter = chapterFor(await this.metadata(docId), input);
    const uri=this.database.withNotebook(records=>{
      const doc=records.document(docId,chapter);
      if(!doc || !records.vault || !records.binding(records.vault,docId,chapter))throw new ServiceError(409,'Save this notebook to a vault before opening it.');
      const book=load(records,doc);
      if(!book.file || nativeUri(book.file)!==input.expectedUri)throw new ServiceError(409,'The notebook location changed. Refresh the notebook before opening it.');
      if(!book.conflict)persist(records,book);
      return nativeUri(book.file);
    });
    await this.launch(uri);
    return {uri};
  }

  async export(input: Input): Promise<{path: string; notes: number; words: number}> {
    const metadata = await this.metadata(input.docId);
    if (!metadata) return exportNotebook(this.database, input);
    return this.database.withNotebook(records => {
      const book = requestDocument(records, input, metadata);
      if (!book.file) throw new ServiceError(503, 'Set your Obsidian vault directory in Settings.');
      const { chapter, docId, sourceUrl } = book.local;
      const words = records.entries('word', docId, chapter);
      book.markdown = exportChapterVocabulary(book.markdown, notebookKey(docId, chapter), sourceUrl, words, chapter);
      persist(records, book);
      return { path: book.file, notes: records.entries('note', docId, chapter).length, words: words.length };
    });
  }

  async saveNote(input: Input): Promise<{ note: Entry }> {
    const metadata = await this.noteMetadata(input);
    return this.database.withNotebook(records => {
      const previous = input.id === undefined ? undefined : records.note(single(input.id, 'record ID', 128, true));
      if (previous && input.docId !== undefined && input.docId !== previous.docId) throw new ServiceError(400, 'A note belongs to its original document.');
      const docId = previous?.docId ?? (typeof input.docId === 'string' ? input.docId : '');
      const chapter = chapterFor(metadata, { ...input, page: previous?.page ?? input.page });
      if (chapter && previous && input.page !== undefined && input.page !== previous.page) throw new ServiceError(409, 'Edit this note in its original section.');
      const local = records.document(docId, chapter);
      if (!local && !chapter) return {note:records.save(input)};
      const book = local ? load(records, local) : requestDocument(records, { ...previous, ...input, docId }, metadata);
      if (book.conflict) throw new ServiceError(409, book.warning || 'Choose Compare latest in Notes to merge the local and vault versions.');
      // Older clients omit a version. Even then, a freshly imported native edit
      // must be surfaced before the client can replace or remove that note.
      const note = records.save({...input, ...(metadata && {title: metadata.title}), expectedUpdatedAt:input.expectedUpdatedAt ?? previous?.updatedAt});
      book.markdown = putNote(book.markdown, note, book.local, single(input.beforeId, 'insertion point', 128));
      blocks(book.markdown);
      persist(records, book);
      return {note};
    });
  }

  async deleteNote(input: Input): Promise<{ id: string; deleted: boolean }> {
    const metadata = await this.noteMetadata(input);
    return this.database.withNotebook(records => {
      const previous = records.note(single(input.id, 'note ID', 128, true));
      if (previous && input.docId !== undefined && input.docId !== previous.docId) throw new ServiceError(400, 'A note belongs to its original document.');
      const local = previous && records.document(previous.docId, chapterFor(metadata, { page: previous.page }));
      if (!local) return records.remove(input);
      const book = load(records, local);
      if (book.conflict) throw new ServiceError(409, book.warning || 'Choose Compare latest in Notes to merge the local and vault versions.');
      const result = records.remove({...input,expectedUpdatedAt:input.expectedUpdatedAt ?? previous.updatedAt});
      book.markdown = withoutNote(book.markdown, result.id);
      persist(records, book);
      return result;
    });
  }
}
