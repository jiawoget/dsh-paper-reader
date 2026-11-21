import type { SavedSelectionRange, TranslatedLocator } from './source-link.js';
import type { BookPlace } from './book-place.js';
import type { PdfOutlineEntry, PdfOutlinePage } from './pdf-outline.js';
import type { AnnotationSaveInput, PaperAnnotation } from './annotations.js';
import type { ArticleLayout, WebArticle } from './web-article.js';

export type ReadingSide = 'source' | 'translation';

export interface BookSection {
  slug: string;
  title: string;
  chapterId: string;
  chapterTitle: string;
  url: string;
}
export interface BookInfo { slug: string; sections: BookSection[] }
export interface DocumentInfo {
  id: string;
  kind: 'pdf' | 'web';
  title: string;
  url?: string;
  paperTitle?: string;
  authors?: string;
  venue?: string;
  doi?: string;
  paragraphs?: string[];
  articleLayout?: ArticleLayout;
  book?: BookInfo;
  /** One-based contents index when this response includes a book section's text. */
  sectionPage?: number;
  defaultPage?: number;
  createdAt?: string;
}
export interface OpenDocument { doc: DocumentInfo; page?: number; anchor?: string }

export interface SelectionHit {
  id: string;
  text: string;
  context: string;
  page: number;
  rect: DOMRect;
  side: ReadingSide;
  label: string;
  sourceQuote?: string;
  sourceText?: string;
  sourceOffset?: number;
  translatedOffset?: number;
  segments?: SelectionSegment[];
  image?: string;
  /** Text inside a reader-drawn PDF screenshot. An empty string denotes an image-only crop. */
  regionText?: string;
  /** A single pointer click that normally previews a figure, term or translated paragraph. */
  previewClick?: boolean;
  rangeOrder?: SavedSelectionRange['order'];
  /** Focus returns here for a passage opened with an explicit control. */
  trigger?: HTMLElement;
}
export interface SelectionSegment {
  id: string;
  offset?: number;
  original: string;
  translated?: string;
  exactPair: boolean;
  /** Ranges clipped to the selected text nodes, in reading order on the initiating side. */
  ranges: Range[];
}
export interface ReaderBlock { id: string; text: string; label?: string; translation?: string }
export interface PageView {
  blocks: ReaderBlock[];
  select(hit?: SelectionHit): void;
  highlight(id: string, on?: boolean, quote?: string, target?: TranslatedLocator): void;
  locate(id: string, quote?: string, target?: TranslatedLocator, range?: SavedSelectionRange): boolean;
  figureImage?(id: string): string | null;
  sourceRect?(id: string): DOMRect | null;
  setTranslations?(map: Record<string, string>): void;
  dispose?(): void;
}

export interface SourceRecord {
  docId: string; title: string; page: number; anchor: string; label: string; sourceUrl: string;
}
export interface JournalNote extends SourceRecord { id: string; text: string; quote: string; context?: string; createdAt: string; updatedAt: string }
export interface NotebookRequest { docId: string; title: string; sourceUrl: string; page?: number }
export interface NotebookSnapshot {
  docId: string; markdown: string; revision: string; notes: JournalNote[];
  chapterId?: string; chapterTitle?: string; vaultPending?: boolean;
  parts: ({ noteId: string } | { markdown: string })[];
  path: string | null; uri: string | null;
  localConflict?: string;
  warning?: string;
  desktopOpenAvailable: boolean;
}
export interface WordRecord extends SourceRecord { id: string; text: string; meaning: string; context: string; createdAt: string; updatedAt?: string }
export interface ChatSource extends SourceRecord { selected: string; original: string; context: string; side: ReadingSide }
export interface ChatRequest {
  docId: string; requestId: string; question: string; source?: ChatSource; answerQuote?: string; answerTurn?: number;
}
export interface ChatExchange extends ChatRequest {
  thread: string; answer: string; createdAt: string; coverage?: { pageCount: number; pagesUsed: number; partial: boolean };
}
export interface PaperEvidence { title: string; pageCount: number; partial: boolean; excerpts: { page: number; text: string }[] }
export interface ZoteroStatus {
  connected: boolean; mode: 'web' | 'desktop'; access: 'none' | 'read' | 'confirm' | 'write' | 'unknown'; detail: string;
}
export interface Settings {
  baseUrl: string; model: string; hasApiKey: boolean; aiMode: 'api' | 'dsh' | 'unconfigured';
  localTranslationAvailable?: boolean;
  hostProvider?: string; hostModel?: string; vaultPath: string; zoteroLibraryType: 'user' | 'group';
  zoteroLibraryId: string; hasZoteroKey: boolean; zoteroMode?: 'web' | 'desktop';
}
export interface ReaderState { notes: JournalNote[]; vocabulary: WordRecord[]; history: WordRecord[]; settings: Settings }
export interface ZoteroItem {
  key: string; title: string; type: string; creator: string; date: string; collections: string[];
  url?: string; doi?: string; webUrl?: string;
}
export interface Collection { key: string; name: string; parentCollection: string | null; webUrl?: string }
export type ZoteroOpenResult =
  | { kind: 'document'; doc: DocumentInfo }
  | { kind: 'article'; url: string }
  | { kind: 'unavailable'; zoteroUrl: string };
export const maxPreviousMaterials = 7;
export interface Operations {
  'outline.get': [{ docId: string }, { entries: PdfOutlineEntry[] }];
  'outline.generate': [{ docId: string; pageCount: number; pages: PdfOutlinePage[] }, { entries: PdfOutlineEntry[] }];
  'book.progress.get': [{docId: string}, {place: BookPlace | null}];
  'book.progress.save': [{docId: string; place: BookPlace}, {place: BookPlace}];
  'state': [Record<string, never>, ReaderState];
  'library.list': [Record<string, never>, { docs: DocumentInfo[] }];
  'library.get': [{ id: string }, { doc: DocumentInfo }];
  'web.import': [WebArticle, OpenDocument];
  'web.open': [{ url: string }, OpenDocument];
  'book.section': [{ docId: string; page: number }, { doc: DocumentInfo }];
  'translation.get': [{ docId: string; page: number }, { translations: Record<string,string> }];
  'translation.page': [{ docId: string; page: number; blocks: ReaderBlock[] }, { translations: Record<string,string> }];
  'ai': [{ mode: 'translate' | 'explain' | 'followup'; text: string; context: string; image?: string; regionText?: string;
    readerNotes?: string[]; previousMaterial?: { label: string; text: string; image?: string; readerNotes?: string[] }[];
    targetLanguage?: string; question?: string; answerQuote?: string;
    history?: {role: 'assistant'|'user'; content: string}[]; record?: ChatRequest & { thread: string } }, { text: string }];
  'chat.history': [{ docId: string; thread?: string }, { exchanges: ChatExchange[] }];
  'chat.ask': [ChatRequest & { paper: PaperEvidence }, { text: string }];
  'chat.searchTerms': [{question: string}, { text: string }];
  'annotation.list': [{ docId: string }, { annotations: PaperAnnotation[] }];
  'annotation.save': [AnnotationSaveInput, { annotation: PaperAnnotation }];
  'annotation.delete': [{ docId: string; id: string; expectedUpdatedAt: string }, { deleted: boolean }];
  'note.save': [SourceRecord & { id?: string; createId?: string; quote: string; text: string; context?: string; beforeId?: string; expectedUpdatedAt?: string; selectionNote?: boolean; insert?: boolean }, { note: JournalNote }];
  'note.delete': [{ id: string; expectedUpdatedAt?: string }, { id: string; deleted: boolean }];
  'notebook.get': [NotebookRequest, NotebookSnapshot];
  'notebook.write': [NotebookRequest & { markdown: string; expectedRevision: string }, NotebookSnapshot];
  'notebook.open': [{ docId:string; page?:number; expectedUri:string }, { uri:string }];
  'vocab.save': [SourceRecord & { text: string; meaning: string; context: string }, { word: WordRecord }];
  'vocab.delete': [{ id: string }, unknown];
  'history.add': [SourceRecord & { text: string; meaning: string; context?: string }, unknown];
  'settings.save': [Partial<Pick<Settings,'baseUrl'|'model'|'vaultPath'|'zoteroMode'|'zoteroLibraryType'|'zoteroLibraryId'>> & { apiKey?: string; zoteroApiKey?: string; clearApiKey?: boolean; clearZoteroKey?: boolean }, { settings: Settings }];
  'obsidian.export': [NotebookRequest, { path: string }];
  'zotero.collections': [{library?: string}, { collections: Collection[]; library: string }];
  'zotero.browse': [{query?: string; collection?: string; start?: number; library?: string},
    { items: ZoteroItem[]; nextStart: number | null; library: string; mode: 'web'|'desktop' }];
  'zotero.open': [{key: string; library: string}, ZoteroOpenResult];
  'zotero.status': [Partial<Pick<Settings,'zoteroMode'|'zoteroLibraryType'|'zoteroLibraryId'>> & { zoteroApiKey?: string; clearZoteroKey?: boolean }, ZoteroStatus];
  'zotero.link': [{docId: string; key: string; library?: string}, { item: ZoteroItem }];
  'zotero.get': [{docId: string; key?: string}, { item: ZoteroItem | null }];
  'zotero.search': [{query: string}, { items: ZoteroItem[] }];
  'zotero.save': [{ docId?: string; key?: string; title: string; url?: string; doi?: string; collections: string[] }, { key: string }];
}
