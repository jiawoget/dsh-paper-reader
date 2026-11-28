import type { SavedSelectionRange, TranslatedLocator } from './source-link.js';
import type { BookPlace } from './book-place.js';
import type { PdfOutlineEntry, PdfOutlinePage } from './pdf-outline.js';
import type { AnnotationColor, AnnotationSaveInput, PaperAnnotation } from './annotations.js';
import type { ArticleLayout, WebArticle } from './web-article.js';
import type { BulkRefFormat } from './citation-bulk.js';
import type {
  LibraryChatInput, LibraryChatResult, PaperCardsInput, PaperCardsResult,
  TrendPapersInput, TrendPapersResult, TrendQueryInput, TrendQueryResult
} from './research-types.js';
import type {
  ReviewBatchResult, ReviewExportInput, ReviewExportResult, ReviewExtractInput, ReviewGetInput, ReviewGetResult,
  ReviewSaveTableInput, ReviewSaveTableResult, ReviewScreenInput, ReviewSetCellInput, ReviewSetCellResult
} from './review-types.js';
import type {
  DeepSearchClarifyInput, DeepSearchClarifyResult, DeepSearchResult, DeepSearchRunInput,
  WatchlistCheckResult, WatchlistEntry, WatchlistSaveInput
} from './deep-search-types.js';
import type {
  CitationAnalyzeInput, CitationReclassifyInput, CitationReclassifyResult,
  CitationReport, CitationSummary, CitationSummaryInput
} from './citation-stance-types.js';
import type { DocResource, DocResourceKind, DocResourcesDiscoverResult, DocResourcesListResult } from './doc-resources.js';

export type ReadingSide = 'source' | 'translation';

export interface BookSection {
  slug: string;
  title: string;
  chapterId: string;
  chapterTitle: string;
  url: string;
}
export interface BookInfo { slug: string; sections: BookSection[]; anchorPages?: Record<string, number> }
export interface DocMetadata {
  paperTitle?: string; authors?: string; venue?: string; year?: string; doi?: string; publisher?: string; abstract?: string;
}
export type DocStatus = 'unread' | 'reading' | 'done';
export interface DocMeta {
  status: DocStatus; starred: boolean; tags: string[];
  lastOpenedAt?: number; lastPage?: number; pageCount?: number; scrollFraction?: number;
}
export type LibrarySearchKind = 'doc' | 'note' | 'mark';
export interface LibrarySearchHit {
  docId: string; docTitle: string; docKind: 'pdf' | 'web' | 'book' | 'abstract'; kind: LibrarySearchKind; snippet: string;
  page?: number; anchor?: string; quote?: string; id?: string; color?: AnnotationColor; updatedAt?: string;
}
export interface DocPageRecord { page: number; text: string }
export interface DocPageHit {
  docId: string; docTitle: string; docKind: DocumentInfo['kind']; page: number; snippet: string; score: number;
}
export interface TopicRecord {
  id: string; name: string; tag: string; zoteroCollection: string; description: string; createdAt: string; updatedAt: string;
}
export interface CreateAbstractInput extends DocMetadata { title: string; url?: string }
export type GraphDirection = 'earlier' | 'later' | 'similar';
export type GraphSource = 'openalex' | 's2' | 'europepmc' | 'arxiv';
export interface GraphPaper {
  id: string; title: string; authors: string[]; firstAuthor: string; lastAuthor: string;
  year?: number; venue?: string; doi?: string; arxivId?: string; pmid?: string;
  openAlexId?: string; s2Id?: string; abstract?: string; citationCount?: number;
  oaPdfUrl?: string; url?: string; topic?: string; source: GraphSource; inLibrary?: boolean; docId?: string; score?: number;
}
export interface GraphNode extends GraphPaper { isSeed?: boolean; direction?: GraphDirection | 'seed'; coCitations?: number }
export interface GraphEdge { source: string; target: string; kind: 'cites' | 'related'; weight?: number }
export interface PositionedGraphNode extends GraphNode { x: number; y: number; radius: number; clusterId?: string }
export interface GraphExploreResult { seeds: GraphPaper[]; nodes: GraphNode[]; edges: GraphEdge[]; degraded: string[]; fromCache: boolean }
export interface DocumentInfo extends DocMetadata {
  id: string;
  kind: 'pdf' | 'web' | 'abstract';
  title: string;
  url?: string;
  paragraphs?: string[];
  articleLayout?: ArticleLayout;
  book?: BookInfo;
  /** One-based contents index when this response includes a book section's text. */
  sectionPage?: number;
  defaultPage?: number;
  createdAt?: string;
  meta?: DocMeta;
}
export type ArxivFormat = 'html' | 'pdf';
export type SavePaperMode = 'auto' | 'abstract' | 'oa-pdf';
export interface SaveGraphPaperResult {
  doc: DocumentInfo; upgraded?: boolean; mode: 'abstract' | 'oa-pdf' | 'oa-html';
  arxivFallback?: 'html-to-pdf'; fallback?: 'abstract_only'; attachPdfSuggested?: boolean;
}
export interface OpenDocument { doc: DocumentInfo; page?: number; anchor?: string; arxivFallback?: 'html-to-pdf' }

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
  /** Text inside a reader-drawn screenshot. An empty string denotes an image-only crop. */
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
export type RegionIntent = 'ask' | 'explain' | 'note' | 'continue' | 'reopen' | 'pin' | 'copy' | 'save' | 'cancel';
export type RegionAction = (hit: SelectionHit, intent: RegionIntent) => void | Promise<void>;
export interface PageView {
  blocks: ReaderBlock[];
  select(hit?: SelectionHit): void;
  highlight(id: string, on?: boolean, quote?: string, target?: TranslatedLocator): void;
  locate(id: string, quote?: string, target?: TranslatedLocator, range?: SavedSelectionRange): boolean;
  figureImage?(id: string): string | null;
  sourceRect?(id: string): DOMRect | null;
  beginRegion?(attach?: boolean): void;
  cancelRegion?(): void;
  reopenRegion?(id: string, receive?: RegionAction): Promise<void>;
  setTranslations?(map: Record<string, string>, overwrite?: boolean): void;
  setPendingBlocks?(ids: ReadonlySet<string>): void;
  dispose?(): void;
}

export interface SourceRecord {
  docId: string; title: string; page: number; anchor: string; label: string; sourceUrl: string;
}
export interface JournalNote extends SourceRecord { id: string; text: string; quote: string; context?: string; createdAt: string; updatedAt: string }
interface NotebookRequest { docId: string; title: string; sourceUrl: string; page?: number }
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
export interface QuestionModel { provider: string; model: string; reasoningEffort?: string }
export interface QuestionCatalog {
  selected?: QuestionModel;
  groups: { id: string; name: string; models: {
    id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string }
  }[] }[];
  failures: { id: string; name: string }[];
}
export interface ZoteroStatus {
  connected: boolean; mode: 'web' | 'desktop'; access: 'none' | 'read' | 'confirm' | 'write' | 'unknown'; detail: string;
}
export interface Settings {
  baseUrl: string; model: string; hasApiKey: boolean; aiMode: 'api' | 'dsh' | 'unconfigured';
  targetLanguage: string;
  glossary?: string;
  customPrompts?: string;
  localTranslationAvailable?: boolean;
  questionModel?: QuestionModel;
  hostProvider?: string; hostModel?: string; vaultPath: string; zoteroLibraryType: 'user' | 'group';
  zoteroLibraryId: string; hasZoteroKey: boolean; zoteroMode?: 'web' | 'desktop';
  openAlexEmail?: string; hasOpenAlexApiKey?: boolean; hasSemanticScholarApiKey?: boolean; hasNcbiApiKey?: boolean; arxivFormat?: ArxivFormat;
}
export interface ReaderState { notes: JournalNote[]; vocabulary: WordRecord[]; history: WordRecord[]; settings: Settings }
export interface ZoteroItem {
  key: string; title: string; type: string; creator: string; date: string; collections: string[];
  url?: string; doi?: string; webUrl?: string;
}
export interface Collection { key: string; name: string; parentCollection: string | null; webUrl?: string }
type ZoteroOpenResult =
  | { kind: 'document'; doc: DocumentInfo }
  | { kind: 'article'; url: string }
  | { kind: 'unavailable'; zoteroUrl: string };
export const maxPreviousMaterials = 7;
export interface Operations {
  'ai.models': [Record<string, never>, QuestionCatalog];
  'ai.selectModel': [{ questionModel: QuestionModel | null }, { questionModel?: QuestionModel }];
  'outline.get': [{ docId: string }, { entries: PdfOutlineEntry[] }];
  'outline.generate': [{ docId: string; pageCount: number; pages: PdfOutlinePage[] }, { entries: PdfOutlineEntry[] }];
  'book.progress.get': [{docId: string}, {place: BookPlace | null}];
  'book.progress.save': [{docId: string; place: BookPlace}, {place: BookPlace}];
  'state': [Record<string, never>, ReaderState];
  'library.list': [Record<string, never>, { docs: DocumentInfo[] }];
  'library.get': [{ id: string }, { doc: DocumentInfo }];
  'library.rename': [{ id: string; title: string }, { doc: DocumentInfo }];
  'library.updateMeta': [{ id: string; paperTitle?: string; authors?: string | string[]; venue?: string; year?: string; doi?: string }, { doc: DocumentInfo }];
  'library.delete': [{ id: string }, { id: string; deleted: boolean }];
  'library.createAbstract': [CreateAbstractInput, { doc: DocumentInfo }];
  'library.importRefs': [{ text: string; format?: BulkRefFormat | 'auto'; tag?: string }, { created: number; existing: number; skipped: number; docs: DocumentInfo[] }];
  'library.exportRefs': [{ docIds?: string[]; format: BulkRefFormat }, { format: BulkRefFormat; filename: string; content: string; count: number }];
  'library.progress.save': [{ docId: string; lastPage?: number; pageCount?: number; scrollFraction?: number }, { meta: DocMeta }];
  'library.triage': [{ docId: string; status?: DocStatus; starred?: boolean; tags?: string[] }, { meta: DocMeta }];
  'library.search': [{ query: string }, { hits: LibrarySearchHit[] }];
  'pages.index': [{ docId?: string; force?: boolean }, { indexed: number; pages: number }];
  'pages.search': [{ query: string; docIds?: string[]; limit?: number }, { hits: DocPageHit[] }];
  'topics.list': [Record<string, never>, { topics: TopicRecord[] }];
  'topics.save': [{ id?: string; name: string; tag?: string; zoteroCollection?: string; description?: string }, { topic: TopicRecord }];
  'topics.delete': [{ id: string }, { id: string; deleted: boolean }];
  'graph.resolve': [{ query?: string; docId?: string }, { paper: GraphPaper | null; degraded: string[]; fromCache: boolean }];
  'graph.search': [{ query: string; limit?: number }, { papers: GraphPaper[]; degraded: string[] }];
  'graph.explore': [{ seeds: string[]; direction: GraphDirection; negativeSeeds?: string[]; limit?: number }, GraphExploreResult];
  'graph.savePaper': [{ paper: GraphPaper; mode?: SavePaperMode; arxivFormat?: ArxivFormat; topicTag?: string }, SaveGraphPaperResult];
  'trends.query': [TrendQueryInput, TrendQueryResult];
  'trends.papers': [TrendPapersInput, TrendPapersResult];
  'library.cards': [PaperCardsInput, PaperCardsResult];
  'library.chat': [LibraryChatInput, LibraryChatResult];
  'review.get': [ReviewGetInput, ReviewGetResult];
  'review.saveTable': [ReviewSaveTableInput, ReviewSaveTableResult];
  'review.screen': [ReviewScreenInput, ReviewBatchResult];
  'review.extract': [ReviewExtractInput, ReviewBatchResult];
  'review.setCell': [ReviewSetCellInput, ReviewSetCellResult];
  'review.export': [ReviewExportInput, ReviewExportResult];
  'deepSearch.clarify': [DeepSearchClarifyInput, DeepSearchClarifyResult];
  'deepSearch.run': [DeepSearchRunInput, DeepSearchResult];
  'watchlist.list': [Record<string, never>, { entries: WatchlistEntry[] }];
  'watchlist.save': [WatchlistSaveInput, { entry: WatchlistEntry }];
  'watchlist.delete': [{ id: string }, { id: string; deleted: boolean }];
  'watchlist.check': [{ id?: string }, WatchlistCheckResult];
  'watchlist.markRead': [{ id: string; keys?: string[] }, { entry: WatchlistEntry }];
  'citations.analyze': [CitationAnalyzeInput, CitationReport];
  'citations.summary': [CitationSummaryInput, CitationSummary];
  'citations.reclassify': [CitationReclassifyInput, CitationReclassifyResult];
  'doc.resources.list': [{ docId?: string; includeDismissed?: boolean }, DocResourcesListResult];
  'doc.resources.add': [{ docId: string; url?: string; targetDocId?: string; kind?: DocResourceKind; title?: string }, { resource: DocResource }];
  'doc.resources.remove': [{ id: string }, { removed: boolean }];
  'doc.resources.update': [{ id: string; status: 'linked' | 'dismissed' }, { resource: DocResource }];
  'doc.resources.discover': [{ docId: string }, DocResourcesDiscoverResult];
  'web.import': [WebArticle & { anchor?: string }, OpenDocument];
  'web.open': [{ url: string; arxivFormat?: ArxivFormat }, OpenDocument];
  'book.section': [{ docId: string; page: number }, { doc: DocumentInfo }];
  'book.pages': [{ docId: string }, { pages: DocPageRecord[] }];
  'article.capture.save': [{ docId: string; page: number; location: string; image: string; regionText: string; label: string }, { anchor: string }];
  'article.capture.get': [{ docId: string; page: number; anchor: string }, { image: string; regionText: string; label: string }];
  'translation.get': [{ docId: string; page: number; targetLanguage?: string }, { translations: Record<string,string> }];
  'translation.page': [{ docId: string; page: number; blocks: ReaderBlock[]; targetLanguage?: string; force?: boolean }, { translations: Record<string,string> }];
  'ai': [{ mode: 'translate' | 'explain' | 'followup'; text: string; context: string; image?: string; regionText?: string;
    readerNotes?: string[]; previousMaterial?: { label: string; text: string; image?: string; readerNotes?: string[] }[];
    targetLanguage?: string; question?: string; answerQuote?: string; questionModel?: QuestionModel | null;
    history?: {role: 'assistant'|'user'; content: string}[]; record?: ChatRequest & { thread: string } }, { text: string }];
  'chat.history': [{ docId: string; thread?: string }, { exchanges: ChatExchange[] }];
  'chat.delete': [{ docId: string; requestId?: string; thread?: string }, { deleted: number }];
  'chat.ask': [ChatRequest & { paper: PaperEvidence; questionModel?: QuestionModel | null }, { text: string }];
  'chat.searchTerms': [{question: string; questionModel?: QuestionModel | null}, { text: string }];
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
  'settings.save': [Partial<Pick<Settings,'baseUrl'|'model'|'targetLanguage'|'glossary'|'customPrompts'|'vaultPath'|'zoteroMode'|'zoteroLibraryType'|'zoteroLibraryId'|'openAlexEmail'|'arxivFormat'>> & {
    apiKey?: string; zoteroApiKey?: string; clearApiKey?: boolean; clearZoteroKey?: boolean;
    openAlexApiKey?: string; clearOpenAlexApiKey?: boolean; semanticScholarApiKey?: string; clearSemanticScholarApiKey?: boolean;
    ncbiApiKey?: string; clearNcbiApiKey?: boolean;
  }, { settings: Settings }];
  'obsidian.export': [NotebookRequest, { path: string; notes?: number; words?: number; annotations?: number }];
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
