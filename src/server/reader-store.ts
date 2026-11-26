import { createHash, randomInt, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { annotationSchema, listAnnotations, saveAnnotation, deleteAnnotation } from './annotations.js';
import { readArticleLocation, readArticleRegion } from '../shared/article-region.js';
import { bookPlace, type BookPlace } from '../shared/book-place.js';
import type { PdfOutlineEntry } from '../shared/pdf-outline.js';
import type { PaperAnnotation } from '../shared/annotations.js';
import type { ChatExchange } from '../shared/types.js';
import { readSelectionRange, readTranslatedLocator } from '../shared/source-link.js';
import { readRegionImage } from './region-image.js';
import {
  address, initialSettings, isObject, mergeSettings, pageNumber, ServiceError, single, stringValue,
  type Entries, type Entry, type EntryKind, type Input, type PrivateSettings
} from './service-types.js';

type Row = Record<string, SQLOutputValue>;
const setupSql = [
  'CREATE TABLE IF NOT EXISTS prefs(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL) STRICT',
  `CREATE TABLE IF NOT EXISTS entries(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, identity TEXT NOT NULL, docId TEXT NOT NULL,
    title TEXT NOT NULL, page INTEGER NOT NULL, anchor TEXT NOT NULL, sourceUrl TEXT NOT NULL,
    text TEXT NOT NULL, label TEXT NOT NULL, quote TEXT NOT NULL, meaning TEXT NOT NULL,
    context TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    UNIQUE(kind, identity)
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS entries_doc ON entries(docId,kind)',
  'CREATE TABLE IF NOT EXISTS citations(library TEXT NOT NULL, identity TEXT NOT NULL, itemKey TEXT NOT NULL, PRIMARY KEY(library,identity)) STRICT',
  'CREATE TABLE IF NOT EXISTS notebooks(vault TEXT NOT NULL, docId TEXT NOT NULL, filename TEXT NOT NULL, PRIMARY KEY(vault,docId)) STRICT'
];
const upsertEntry = `
  INSERT INTO entries(
    id, kind, identity, docId, title, page, anchor, sourceUrl, text, label, quote, meaning, context, createdAt, updatedAt
  ) VALUES(
    $id, $kind, $identity, $docId, $title, $page, $anchor, $sourceUrl, $text, $label, $quote, $meaning, $context, $createdAt, $updatedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    identity=excluded.identity, docId=excluded.docId, title=excluded.title, page=excluded.page,
    anchor=excluded.anchor, sourceUrl=excluded.sourceUrl, text=excluded.text, label=excluded.label,
    quote=excluded.quote, meaning=excluded.meaning, context=excluded.context, updatedAt=excluded.updatedAt
`;
function readColumn(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new ServiceError(500, 'A stored reading record contains an invalid field.');
  return value;
}
function articleCaptureScope(input: Input): { docId: string; page: number } {
  const docId = input.docId;
  if (typeof docId !== 'string' || !/^(?:book|web)-[0-9a-f]{64}$/u.test(docId)) {
    throw new ServiceError(400, 'The screenshot needs a book or web article ID.');
  }
  return { docId, page: pageNumber(input.page) };
}
function decodeEntry(row: Row): Entry {
  return {
    id: readColumn(row, 'id'), docId: readColumn(row, 'docId'), title: readColumn(row, 'title'), page: pageNumber(row.page),
    anchor: readColumn(row, 'anchor'), sourceUrl: readColumn(row, 'sourceUrl'), text: readColumn(row, 'text'),
    label: readColumn(row, 'label'), quote: readColumn(row, 'quote'), meaning: readColumn(row, 'meaning'), context: readColumn(row, 'context'),
    createdAt: readColumn(row, 'createdAt'), updatedAt: readColumn(row, 'updatedAt')
  };
}
function settingsFor(db: DatabaseSync): PrivateSettings {
  const row = db.prepare('SELECT data FROM prefs WHERE id=1').get();
  if (!row) return { ...initialSettings };
  const json: unknown = JSON.parse(readColumn(row, 'data'));
  if (!isObject(json)) throw new ServiceError(500, 'The saved reader settings are invalid.');
  // Persisted values use the same field constraints as freshly submitted values.
  return mergeSettings({ ...initialSettings }, json);
}
function collect(rows: Iterable<Row>): Entries {
  const result: Entries = { notes: [], vocabulary: [], history: [] };
  for (const row of rows) {
    const group = row.kind === 'note' ? result.notes : row.kind === 'word' ? result.vocabulary : result.history;
    group.push(decodeEntry(row));
  }
  return result;
}
function identityFor(kind: EntryKind, entry: Entry): string {
  const content = kind === 'note' ? [entry.text, entry.quote, entry.label]
    : kind === 'word' ? [entry.text.toLowerCase().replace(/\s+/g, ' ')] : [entry.text, entry.meaning];
  const position = [entry.docId || entry.sourceUrl, entry.page, entry.anchor];
  if (kind === 'note' && entry.context) content.push(entry.context);
  return createHash('sha256').update(JSON.stringify([...position, ...content])).digest('hex');
}
function entryFor(kind: EntryKind, input: Input, prior?: Entry, allowEmpty = false): Entry {
  const next = { ...prior, ...input };
  const now = new Date(Math.max(Date.now(), prior ? Date.parse(prior.updatedAt) + 1 : 0)).toISOString();
  const docId = single(next.docId, 'document ID', 512, kind !== 'history');
  const page = pageNumber(next.page ?? 1);
  const anchor = single(next.anchor, 'passage anchor', 4096);
  let sourceUrl = address(next.sourceUrl);
  if (sourceUrl && docId) {
    const url = new URL(sourceUrl);
    if (/\/api\/paper-reader\/app\/(?:index\.html)?$/.test(url.pathname)) {
      url.pathname = '/api/paper-reader/app/index.html';
      url.searchParams.set('doc', docId);
      url.searchParams.set('page', String(page));
      if (anchor) url.searchParams.set('anchor', anchor);
      else url.searchParams.delete('anchor');
      sourceUrl = url.href;
    }
  }
  return {
    id: prior?.id ?? randomUUID(), docId, title: stringValue(next.title, 'document title', 2048), page, anchor, sourceUrl,
    text: stringValue(next.text, 'record text', 100_000, !allowEmpty, kind === 'note'), label: stringValue(next.label, 'label', 512),
    quote: stringValue(next.quote, 'quotation', 100_000, false, true), context: stringValue(next.context, 'context', 120_000, false, true),
    meaning: stringValue(next.meaning, 'definition', 100_000, false, true), createdAt: prior?.createdAt ?? now, updatedAt: now
  };
}

interface ZoteroSource { link: string; original: string }
interface NotebookInput { settings: PrivateSettings; entries: Entries; annotations: PaperAnnotation[]; filename: string | undefined; zotero?: ZoteroSource }
export interface NotebookChapter {
  id: string;
  title: string;
  bookSlug: string;
  firstPage: number;
  sections: ReadonlyMap<number, { title: string; url: string }>;
}
export interface StoredNotebook { docId: string; chapter?: NotebookChapter; title: string; sourceUrl: string; markdown: string }
interface VaultBinding { filename: string; baseline: string }

// Document IDs cannot contain control characters. Existing single-document keys stay valid.
export const notebookKey = (docId: string, chapter?: NotebookChapter) => chapter ? docId + '\u001f' + chapter.id : docId;

function checkVersion(input: Input, previous?: Entry): void {
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== previous?.updatedAt) {
    throw new ServiceError(409, 'This note changed. Review the latest text before saving your draft.');
  }
}

function storeEntry(db: DatabaseSync, kind: EntryKind, input: Input, importedId?: string, allowEmpty = false): Entry {
  let prior: Entry | undefined;
  let previousIdentity = '';
  if (input.id !== undefined) {
    const id = single(input.id, 'record ID', 128, true);
    const record = db.prepare('SELECT * FROM entries WHERE id=? AND kind=?').get(id, kind);
    if (!record) throw new ServiceError(404, 'This record was deleted. Refresh and try again.');
    prior = decodeEntry(record);
    previousIdentity = readColumn(record, 'identity');
  }
  checkVersion(input, prior);
  const value = entryFor(kind, input, prior, allowEmpty);
  if (kind === 'note' && input.createId !== undefined) {
    const id = single(input.createId, 'new note ID', 36, true);
    if (prior || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
      throw new ServiceError(400, 'A new note needs a valid creation ID.');
    }
    const row = db.prepare('SELECT * FROM entries WHERE id=?').get(id);
    if (row) {
      if (row.kind !== 'note' || row.docId !== value.docId || row.page !== value.page || row.anchor !== value.anchor) {
        throw new ServiceError(409, 'This note ID belongs to a different reading record.');
      }
      // The first request may have committed even when its response never reached the reader.
      return decodeEntry(row);
    }
    value.id = id;
  }
  if (importedId) {
    if (db.prepare('SELECT id FROM entries WHERE id=?').get(importedId)) {
      throw new ServiceError(409, 'A Markdown note ID already belongs to another reading record.');
    }
    value.id = importedId;
  }
  if (kind === 'note' && input.selectionNote === true && !prior) {
    const location = (href: string) => {
      const url = URL.parse(href);
      if (!url) return;
      const target = readTranslatedLocator(url);
      return { translated: Boolean(target), offset: readSelectionRange(url)?.start ?? target?.offset };
    };
    const position = location(value.sourceUrl);
    const candidates = db.prepare("SELECT sourceUrl FROM entries WHERE kind='note' AND docId=? AND page=? AND anchor=? AND quote=? AND (context=? OR context='')")
      .all(value.docId, value.page, value.anchor, value.quote, value.context);
    const existing = candidates.some(row => {
      const previous = location(readColumn(row, 'sourceUrl'));
      return position?.offset === undefined || previous?.offset === undefined ||
        (previous.translated === position.translated && previous.offset === position.offset);
    });
    if (existing) throw new ServiceError(409, 'Another editor saved a note for this selection. Reopen it to review the latest text.');
  }
  const separateNote = kind === 'note' && (input.insert === true || importedId || previousIdentity.startsWith('notebook/'));
  const identity = separateNote ? 'notebook/' + value.id : identityFor(kind, value);
  const duplicate = db.prepare('SELECT * FROM entries WHERE kind=? AND identity=?').get(kind, identity);
  if (duplicate) {
    const existing = decodeEntry(duplicate);
    if (prior && prior.id !== existing.id) throw new ServiceError(409, 'A record already contains that passage and text.');
    if (!prior) {
      value.id = existing.id;
      value.createdAt = existing.createdAt;
      value.meaning ||= existing.meaning;
      value.context ||= existing.context;
      value.sourceUrl ||= existing.sourceUrl;
      value.title ||= existing.title;
      value.label ||= existing.label;
    }
  }
  db.prepare(upsertEntry).run({ ...value, identity, kind });
  return value;
}

export class NotebookRecords {
  constructor(private readonly db: DatabaseSync) {}
  get vault(): string { return settingsFor(this.db).vaultPath; }
  zoteroSource(docId: string): ZoteroSource | undefined {
    const settings = settingsFor(this.db);
    const namespace = settings.zoteroMode === 'desktop' || !settings.zoteroLibraryId ? 'desktop/%/users/0' :
      '/' + (settings.zoteroLibraryType === 'group' ? 'groups' : 'users') + '/' + settings.zoteroLibraryId;
    const rows = this.db.prepare(`SELECT c.library,c.itemKey,COALESCE(s.original,'') AS original,COALESCE(s.webUrl,'') AS webUrl FROM citations c
      LEFT JOIN zotero_sources s ON c.library=s.library AND c.itemKey=s.itemKey WHERE c.identity=? AND c.library LIKE ?`).all('document/' + docId, namespace);
    if (rows.length !== 1) return;
    const { library, itemKey } = rows[0];
    if (typeof library !== 'string' || typeof itemKey !== 'string' || !/^[A-Z0-9]{8}$/.test(itemKey)) return;
    const link = library.startsWith('desktop/') ? 'zotero://select/library/items/' + itemKey :
      readColumn(rows[0], 'webUrl') || 'https://www.zotero.org' + library + '/items/' + itemKey;
    return { link, original: readColumn(rows[0], 'original') };
  }
  importChanges(run: () => void): void {
    this.db.exec('SAVEPOINT native_notes');
    try { run(); this.db.exec('RELEASE native_notes'); }
    catch (error) {
      this.db.exec('ROLLBACK TO native_notes');
      this.db.exec('RELEASE native_notes');
      throw error;
    }
  }
  note(id: string): Entry | undefined {
    const row = this.db.prepare("SELECT * FROM entries WHERE kind='note' AND id=?").get(id);
    return row && decodeEntry(row);
  }
  entries(kind: 'note' | 'word', docId: string, chapter?: NotebookChapter): Entry[] {
    const pages = chapter ? [...chapter.sections.keys()] : [];
    const scope = chapter ? ' AND page IN (' + pages.map(() => '?').join(',') + ')' : '';
    const order = kind === 'note' ? 'updatedAt DESC,rowid DESC' : 'page,createdAt,rowid';
    return this.db.prepare('SELECT * FROM entries WHERE kind=? AND docId=?' + scope + ' ORDER BY ' + order)
      .all(kind, docId, ...pages).map(decodeEntry);
  }
  annotations(docId: string, chapter?: NotebookChapter): PaperAnnotation[] { return listAnnotations(this.db, { docId }).filter(item => !chapter || chapter.sections.has(item.page)); }
  save(input: Input, importedId?: string, allowEmpty = false): Entry { return storeEntry(this.db, 'note', input, importedId, allowEmpty); }
  remove(input: Input): { id: string; deleted: boolean } {
    const id = single(input.id, 'note ID', 128, true);
    const previous = this.note(id);
    checkVersion(input, previous);
    return { id, deleted: Boolean(this.db.prepare("DELETE FROM entries WHERE kind='note' AND id=?").run(id).changes) };
  }
  document(docId: string, chapter?: NotebookChapter): StoredNotebook | undefined {
    const row = this.db.prepare('SELECT * FROM notebook_documents WHERE docId=?').get(notebookKey(docId, chapter));
    return row && { docId, chapter, title: readColumn(row, 'title'), sourceUrl: readColumn(row, 'sourceUrl'), markdown: readColumn(row, 'markdown') };
  }
  store(doc: StoredNotebook): void {
    this.db.prepare('INSERT OR REPLACE INTO notebook_documents VALUES(?,?,?,?)').run(notebookKey(doc.docId, doc.chapter), doc.title, doc.sourceUrl, doc.markdown);
  }
  binding(vault: string, docId: string, chapter?: NotebookChapter): VaultBinding | undefined {
    const row = this.db.prepare('SELECT * FROM notebook_vaults WHERE vault=? AND docId=?').get(vault, notebookKey(docId, chapter));
    return row && { filename: readColumn(row, 'filename'), baseline: readColumn(row, 'baseline') };
  }
  chapterFilenames(vault: string, docId: string): Set<string> {
    const prefix = docId + '\u001f';
    const rows = this.db.prepare('SELECT filename FROM notebook_vaults WHERE vault=? AND substr(docId,1,?)=?').all(vault, prefix.length, prefix);
    return new Set(rows.map(row => readColumn(row, 'filename').normalize('NFC').toLowerCase()));
  }
  bind(vault: string, doc: StoredNotebook, filename: string): void {
    this.db.prepare('INSERT OR REPLACE INTO notebook_vaults VALUES(?,?,?,?)').run(vault, notebookKey(doc.docId, doc.chapter), filename, doc.markdown);
  }
}
export class ReaderStore {
  readonly #root: string;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new ServiceError(500, 'Set an absolute data directory for the reader.');
    this.#root = path.resolve(root);
  }
  #transaction<T>(writer: boolean, run: (database: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(this.#root, { recursive: true, mode: 0o700 });
      const file = path.join(this.#root, 'reader.sqlite');
      try { closeSync(openSync(file, 'wx', 0o600)); }
      catch (error) { if (!isObject(error) || error.code !== 'EEXIST') throw error; }
      if (!lstatSync(file).isFile()) throw new ServiceError(500, 'The reader database must be a regular file.');
      db = new DatabaseSync(file, { timeout: 5000 });
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      // The added tables are independent of the v2 schema. Older open readers can keep using their notes and history.
      const hasExtensions = version === 2 && db.prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('chat_exchanges','zotero_authorizations','annotations','book_positions','pdf_outlines','article_captures','zotero_sources')"
      ).get()?.n === 7;
      if (version === 0 || version === 1 || version === 2 && !hasExtensions) {
        db.exec('BEGIN IMMEDIATE');
        if (version === 0) for (const sql of setupSql) db.exec(sql);
        db.exec('CREATE TABLE IF NOT EXISTS notebook_documents(docId TEXT PRIMARY KEY, title TEXT NOT NULL, sourceUrl TEXT NOT NULL, markdown TEXT NOT NULL) STRICT');
        db.exec('CREATE TABLE IF NOT EXISTS notebook_vaults(vault TEXT NOT NULL, docId TEXT NOT NULL, filename TEXT NOT NULL, baseline TEXT NOT NULL, PRIMARY KEY(vault,docId)) STRICT');
        db.exec('CREATE TABLE IF NOT EXISTS chat_exchanges(requestId TEXT PRIMARY KEY, docId TEXT NOT NULL, thread TEXT NOT NULL, exchange TEXT NOT NULL) STRICT');
        db.exec('CREATE INDEX IF NOT EXISTS chat_document ON chat_exchanges(docId,thread)');
        db.exec('CREATE TABLE IF NOT EXISTS zotero_authorizations(serverId TEXT PRIMARY KEY, apiKey TEXT NOT NULL) STRICT');
        db.exec('CREATE TABLE IF NOT EXISTS zotero_sources(library TEXT NOT NULL,itemKey TEXT NOT NULL,original TEXT NOT NULL,webUrl TEXT NOT NULL,PRIMARY KEY(library,itemKey)) STRICT');
        db.exec(annotationSchema);
        db.exec('CREATE TABLE IF NOT EXISTS book_positions(docId TEXT PRIMARY KEY, updated INTEGER NOT NULL, place TEXT NOT NULL) STRICT');
        db.exec('CREATE TABLE IF NOT EXISTS pdf_outlines(docId TEXT PRIMARY KEY, contents TEXT NOT NULL) STRICT');
        db.exec(`CREATE TABLE IF NOT EXISTS article_captures(
          docId TEXT NOT NULL, page INTEGER NOT NULL, anchor TEXT NOT NULL,
          image BLOB NOT NULL, regionText TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(docId,page,anchor)
        ) STRICT`);
        db.exec('PRAGMA user_version=2');
        db.exec('COMMIT');
      } else if (version !== 2) throw new ServiceError(500, 'This reader database version is unsupported.');
      db.exec(writer ? 'BEGIN IMMEDIATE' : 'BEGIN');
      const result = run(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db?.isTransaction) db.exec('ROLLBACK');
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(500, 'Local data could not be accessed. Check directory permissions and available disk space.');
    } finally {
      db?.close();
    }
  }
  withNotebook<T>(run: (records: NotebookRecords) => T): T {
    return this.#transaction(true, db => run(new NotebookRecords(db)));
  }
  async saveArticleCapture(input: Input, attachments?: Input): Promise<{ anchor: string }> {
    const { docId, page } = articleCaptureScope(input);
    const { location } = input;
    if (typeof location !== 'string' || !readArticleLocation(location)) throw new ServiceError(400, 'Invalid article screenshot location.');
    if (typeof input.regionText !== 'string') throw new ServiceError(400, 'Include the selected text or an empty string for an image-only screenshot.');
    const regionText = stringValue(input.regionText, 'text inside selected area', 100_000, false, true);
    const label = stringValue(input.label, 'screenshot label', 512, true, true);
    const { bytes } = await readRegionImage(input.image, attachments);
    const hash = createHash('sha256').update(JSON.stringify([docId, page, location, regionText, label])).update(bytes).digest('hex');
    const anchor = 'article-' + location + '-' + hash.slice(0, 32);
    return this.#transaction(true, db => {
      db.prepare(`INSERT INTO article_captures(docId,page,anchor,image,regionText,label) VALUES(?,?,?,?,?,?)
        ON CONFLICT(docId,page,anchor) DO NOTHING`).run(docId, page, anchor, bytes, regionText, label);
      return { anchor };
    });
  }
  articleCapture(input: Input): { image: string; regionText: string; label: string } {
    const { docId, page } = articleCaptureScope(input);
    const { anchor } = input;
    if (typeof anchor !== 'string' || !readArticleRegion(anchor)) throw new ServiceError(400, 'Invalid article screenshot anchor.');
    return this.#transaction(false, db => {
      const row = db.prepare('SELECT image,regionText,label FROM article_captures WHERE docId=? AND page=? AND anchor=?').get(docId, page, anchor);
      if (!row) throw new ServiceError(404, 'This screenshot was not found in the selected article or book section.');
      if (!(row.image instanceof Uint8Array)) throw new ServiceError(500, 'The saved screenshot is damaged.');
      return { image: 'data:image/png;base64,' + Buffer.from(row.image).toString('base64'),
        regionText: readColumn(row, 'regionText'), label: readColumn(row, 'label') };
    });
  }
  pdfOutline(docId: string, completed?: PdfOutlineEntry[]): PdfOutlineEntry[] {
    return this.#transaction(completed !== undefined, db => {
      if (completed) db.prepare('INSERT INTO pdf_outlines VALUES(?,?) ON CONFLICT(docId) DO NOTHING').run(docId, JSON.stringify(completed));
      const row = db.prepare('SELECT contents FROM pdf_outlines WHERE docId=?').get(docId);
      return row ? JSON.parse(readColumn(row, 'contents')) as PdfOutlineEntry[] : [];
    });
  }
  bookPosition(id: unknown): BookPlace | null {
    if (typeof id !== 'string' || !/^book-[a-f\d]{64}$/.test(id)) throw new ServiceError(400, 'Invalid book ID.');
    return this.#transaction(false, db => {
      const row = db.prepare('SELECT place FROM book_positions WHERE docId=?').get(id);
      return row ? bookPlace(JSON.parse(readColumn(row,'place'))) ?? null : null;
    });
  }
  saveBookPosition(id: unknown, value: unknown): BookPlace {
    const place = bookPlace(value);
    if (typeof id !== 'string' || !/^book-[a-f\d]{64}$/.test(id) || !place) throw new ServiceError(400, 'Invalid reading position.');
    return this.#transaction(true, db => {
      db.prepare('INSERT INTO book_positions(docId,updated,place) VALUES(?,?,?) ON CONFLICT(docId) DO UPDATE SET updated=excluded.updated,place=excluded.place WHERE excluded.updated>=book_positions.updated')
        .run(id, place.updated, JSON.stringify(place));
      const saved = db.prepare('SELECT place FROM book_positions WHERE docId=?').get(id)!;
      return JSON.parse(readColumn(saved, 'place')) as BookPlace;
    });
  }
  listAnnotations(input: Input) { return this.#transaction(false, db => listAnnotations(db, input)); }
  saveAnnotation(input: Input) { return this.#transaction(true, db => saveAnnotation(db, input)); }
  deleteAnnotation(input: Input) { return this.#transaction(true, db => deleteAnnotation(db, input)); }
  settings(): PrivateSettings { return this.#transaction(false, settingsFor); }
  chatHistory(docId: string, thread?: string): ChatExchange[] {
    return this.#transaction(false, db => {
      const rows = thread ? db.prepare('SELECT exchange FROM chat_exchanges WHERE docId=? AND thread=? ORDER BY rowid').all(docId, thread)
        : db.prepare('SELECT exchange FROM chat_exchanges WHERE docId=? ORDER BY rowid').all(docId);
      return rows.map(row => JSON.parse(readColumn(row, 'exchange')) as ChatExchange);
    });
  }
  chatExchange(requestId: string): ChatExchange | undefined {
    return this.#transaction(false, db => {
      const row = db.prepare('SELECT exchange FROM chat_exchanges WHERE requestId=?').get(requestId);
      return row && JSON.parse(readColumn(row, 'exchange')) as ChatExchange;
    });
  }
  saveExchange(exchange: ChatExchange): ChatExchange {
    return this.#transaction(true, db => {
      db.prepare('INSERT INTO chat_exchanges VALUES(?,?,?,?) ON CONFLICT(requestId) DO NOTHING')
        .run(exchange.requestId, exchange.docId, exchange.thread, JSON.stringify(exchange));
      const row = db.prepare('SELECT exchange FROM chat_exchanges WHERE requestId=?').get(exchange.requestId)!;
      return JSON.parse(readColumn(row, 'exchange')) as ChatExchange;
    });
  }
  deleteChat(docId: string, filter: { requestId?: string; thread?: string }): number {
    return this.#transaction(true, db => Number((filter.requestId && filter.thread
      ? db.prepare('DELETE FROM chat_exchanges WHERE docId=? AND requestId=? AND thread=?').run(docId, filter.requestId, filter.thread)
      : filter.requestId ? db.prepare('DELETE FROM chat_exchanges WHERE docId=? AND requestId=?').run(docId, filter.requestId)
      : db.prepare('DELETE FROM chat_exchanges WHERE docId=? AND thread=?').run(docId, filter.thread!)).changes));
  }
  zoteroAuthorization(serverId: string, update?: string): string {
    return this.#transaction(update !== undefined, db => {
      if (update !== undefined) {
        if (update) db.prepare('INSERT OR REPLACE INTO zotero_authorizations VALUES(?,?)').run(serverId, update);
        else db.prepare('DELETE FROM zotero_authorizations WHERE serverId=?').run(serverId);
        return update;
      }
      const row = db.prepare('SELECT apiKey FROM zotero_authorizations WHERE serverId=?').get(serverId);
      return row ? readColumn(row, 'apiKey') : '';
    });
  }
  configure(input: Input): PrivateSettings {
    return this.#transaction(true, db => {
      const next = mergeSettings(settingsFor(db), input);
      db.prepare('INSERT OR REPLACE INTO prefs VALUES(1,?)').run(JSON.stringify(next));
      return next;
    });
  }
  state(): Entries & { settings: PrivateSettings } {
    return this.#transaction(false, db => ({
      ...collect(db.prepare('SELECT * FROM entries ORDER BY updatedAt DESC,rowid DESC').iterate()),
      settings: settingsFor(db)
    }));
  }
  save(kind: EntryKind, input: Input): Entry {
    return this.#transaction(true, db => storeEntry(db, kind, input));
  }
  remove(kind: EntryKind, input: Input): { id: string; deleted: boolean } {
    const id = single(input.id, 'record ID', 128, true);
    return this.#transaction(true, db => {
      const result = db.prepare('DELETE FROM entries WHERE kind=? AND id=?').run(kind, id);
      return { id, deleted: Boolean(result.changes) };
    });
  }
  notebook<T extends { path: string }>(docId: string, write: (input: NotebookInput) => T): T {
    return this.#transaction(true, db => {
      const settings = settingsFor(db);
      if (!settings.vaultPath) throw new ServiceError(503, 'Set your Obsidian vault directory in Settings.');
      const row = db.prepare('SELECT filename FROM notebooks WHERE vault=? AND docId=?').get(settings.vaultPath, docId);
      const entries = collect(db.prepare('SELECT * FROM entries WHERE docId=? ORDER BY page,createdAt,rowid').iterate(docId));
      const result = write({ settings, entries, annotations: listAnnotations(db, { docId }), filename: row && readColumn(row, 'filename'), zotero: new NotebookRecords(db).zoteroSource(docId) });
      db.prepare('INSERT OR REPLACE INTO notebooks VALUES(?,?,?)').run(settings.vaultPath, docId, path.basename(result.path));
      return result;
    });
  }
  citation(library: string, identity: string, proposed?: string | null): string | undefined {
    return this.#transaction(proposed !== undefined, db => {
      const found = db.prepare('SELECT itemKey FROM citations WHERE library=? AND identity=?').get(library, identity);
      if (found) return readColumn(found, 'itemKey');
      if (proposed === undefined) return undefined;
      const alphabet = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';
      const key = proposed ?? Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
      db.prepare('INSERT INTO citations VALUES(?,?,?)').run(library, identity, key);
      return key;
    });
  }
  linkDocument(library: string, docId: string, itemKey: string, source?: { original: string; webUrl?: string }): void {
    this.#transaction(true, db => {
      db.prepare('INSERT INTO citations VALUES(?,?,?) ON CONFLICT(library,identity) DO UPDATE SET itemKey=excluded.itemKey')
        .run(library, 'document/' + docId, itemKey);
      if (source) db.prepare('INSERT OR REPLACE INTO zotero_sources VALUES(?,?,?,?)').run(library, itemKey, source.original, source.webUrl || '');
    });
  }
  documentsForItem(library: string, itemKey: string): string[] {
    return this.#transaction(false, db => db.prepare(
      "SELECT substr(identity,10) AS docId FROM citations WHERE library=? AND itemKey=? AND identity LIKE 'document/%' ORDER BY rowid DESC"
    ).all(library, itemKey).map(row => readColumn(row, 'docId')));
  }
  deleteDocument(docId: string): void {
    if (!docId || docId === 'pagedattention') return;
    const prefix = docId + '\u001f';
    this.#transaction(true, db => {
      db.prepare('DELETE FROM entries WHERE docId=?').run(docId);
      db.prepare('DELETE FROM annotations WHERE docId=?').run(docId);
      db.prepare('DELETE FROM chat_exchanges WHERE docId=?').run(docId);
      db.prepare('DELETE FROM notebook_documents WHERE docId=? OR substr(docId,1,?)=?').run(docId, prefix.length, prefix);
      db.prepare('DELETE FROM notebook_vaults WHERE docId=? OR substr(docId,1,?)=?').run(docId, prefix.length, prefix);
      db.prepare('DELETE FROM notebooks WHERE docId=? OR substr(docId,1,?)=?').run(docId, prefix.length, prefix);
      db.prepare('DELETE FROM book_positions WHERE docId=?').run(docId);
      db.prepare('DELETE FROM pdf_outlines WHERE docId=?').run(docId);
      db.prepare('DELETE FROM article_captures WHERE docId=?').run(docId);
      db.prepare('DELETE FROM citations WHERE identity=?').run('document/' + docId);
    });
  }
}
