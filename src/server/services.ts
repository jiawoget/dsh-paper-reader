import type { ResourceReader } from './academic-intake.js';
import { PaperNotebooks } from './notebook.js';
import { installedObsidian, type ObsidianLauncher } from './obsidian-desktop.js';
import { publicResource } from './public-resource.js';
import { ReaderModel, type StreamOptions } from './reader-model.js';
import { PaperDiscussions } from './paper-discussion.js';
import { PdfOutlines } from './pdf-outline.js';
import { ReaderStore } from './reader-store.js';
import { hostAttachments } from './region-image.js';
import { inputObject, mergeSettings, readQuestionModel, readTargetLanguage, ServiceError, single, type Input, type ServiceResults } from './service-types.js';
import { openWebArticle } from './web-article.js';
import { ZoteroLibrary } from './zotero.js';
import { Library } from './library.js';

export interface ServiceOptions {
  root: string; ctx?: unknown; fetchImpl?: typeof fetch; openObsidian?: ObsidianLauncher;
  library?: Library; store?: ReaderStore; readResource?: ResourceReader;
}
type Operation = keyof ServiceResults;
type Result = ServiceResults[Operation];
type Handlers = { [K in Operation]: (input: Input, options?: StreamOptions) => ServiceResults[K] | Promise<ServiceResults[K]> };
interface ServiceAction {
  <K extends Operation>(operation: K, payload?: unknown, options?: StreamOptions): Promise<ServiceResults[K]>;
  (operation: string, payload?: unknown, options?: StreamOptions): Promise<Result>;
}

export function createServices({ root, ctx, fetchImpl = globalThis.fetch, openObsidian = installedObsidian(), library, store, readResource = publicResource }: ServiceOptions): ServiceAction {
  const database = store ?? new ReaderStore(root);
  const documents = library ?? new Library(root, readResource, id => database.deleteDocument(id));
  const notebooks = new PaperNotebooks(database, documents, openObsidian);
  const model = new ReaderModel(ctx, fetchImpl);
  const discussions = new PaperDiscussions(database, model);
  const outlines = new PdfOutlines(documents, database, model);
  const zotero = () => new ZoteroLibrary(database.settings(), fetchImpl, database);
  const withDoc = async <T>(id: unknown, write: () => T): Promise<T> => {
    await documents.get(id);
    if (!documents.hasSync(id)) throw new ServiceError(404, 'Document not found.');
    return write();
  };
  const handlers = {
    'library.list': async () => {
      const docs = await documents.list(), metas = database.listDocMeta();
      return { docs: docs.map(doc => { const meta = metas.get(doc.id); return meta ? { ...doc, meta } : doc; }) };
    },
    'library.get': async input => {
      const doc = await documents.get(input.id), meta = database.listDocMeta(doc.id).get(doc.id);
      return { doc: meta ? { ...doc, meta } : doc };
    },
    'library.rename': async input => ({ doc: await documents.rename(input.id, input.title) }),
    'library.updateMeta': async input => ({ doc: await documents.updateMeta(input) }),
    'library.delete': input => documents.delete(input.id),
    'library.progress.save': input => withDoc(input.docId, () => ({ meta: database.saveDocProgress(input) })),
    'library.triage': input => withDoc(input.docId, () => ({ meta: database.updateDocTriage(input) })),
    'library.search': async input => {
      const query = single(input.query, 'search query', 256);
      return { hits: query ? database.searchLibrary(query, await documents.list()) : [] };
    },
    'web.import': input => documents.importWebDocument(input),
    'web.open': input => openWebArticle(documents, input.url, readResource),
    'book.section': async input => ({ doc: await documents.bookSection(input.docId, input.page) }),
    'translation.get': async input => ({ translations: await documents.translations(input.docId, input.page, input.targetLanguage === undefined ? database.settings().targetLanguage : readTargetLanguage(input.targetLanguage)) }),
    'translation.page': async input => {
      if (input.force !== undefined && typeof input.force !== 'boolean') throw new ServiceError(400, 'Invalid force option.');
      const targetLanguage = input.targetLanguage === undefined ? database.settings().targetLanguage : readTargetLanguage(input.targetLanguage);
      return { translations: await documents.translate(input.docId, input.page, input.blocks, async (blocks, documentKind) => (await model.blocks(database.settings(), { blocks, documentKind, targetLanguage })).translations, targetLanguage, input.force === true) };
    },
    'article.capture.save': input => database.saveArticleCapture(input, hostAttachments(ctx)),
    'article.capture.get': input => database.articleCapture(input),
    'outline.get': input => outlines.get(input),
    'outline.generate': input => outlines.generate(input),
    'book.progress.get': input => ({place:database.bookPosition(input.docId)}),
    'book.progress.save': input => withDoc(input.docId, () => ({ place: database.saveBookPosition(input.docId, input.place) })),
    state: async () => {
      const { settings, ...entries } = database.state();
      return { ...entries, settings: await model.publicSettings(settings) };
    },
    'ai.selectModel': async input => {
      if (input.questionModel === undefined) throw new ServiceError(400, 'Choose a question model.');
      const selection = readQuestionModel(input.questionModel);
      if (selection) await model.selectedRoute(selection);
      return { questionModel: database.configure({ questionModel: selection ?? null }).questionModel };
    },
    'settings.save': async input => ({ settings: await model.publicSettings(database.configure({ ...input, questionModel: undefined })) }),
    'ai.models': async () => ({ ...await model.catalog(), selected: database.settings().questionModel }),
    'annotation.list': input => ({ annotations: database.listAnnotations(input) }),
    'annotation.save': input => ({ annotation: database.saveAnnotation(input) }),
    'annotation.delete': input => ({ deleted: database.deleteAnnotation(input) }),
    'note.save': input => notebooks.saveNote(input),
    'note.delete': input => notebooks.deleteNote(input),
    'notebook.get': input => notebooks.read(input),
    'notebook.write': input => notebooks.write(input),
    'notebook.open': input => notebooks.openOnDesktop(input),
    'vocab.save': input => ({ word: database.save('word', input) }),
    'vocab.delete': input => database.remove('word', input),
    'history.add': input => ({ entry: database.save('history', input) }),
    ai: (input, options) => discussions.passage(input, options),
    'chat.history': input => discussions.history(input),
    'chat.delete': input => discussions.delete(input),
    'chat.ask': (input, options) => discussions.ask(input, options),
    'chat.searchTerms': input => model.searchTerms(database.settings(), input),
    'ai.blocks': input => model.blocks(database.settings(), input),
    'obsidian.export': input => notebooks.export(input),
    'zotero.collections': input => zotero().collections(input),
    'zotero.browse': input => zotero().browse(input),
    'zotero.open': input => zotero().open(input, documents),
    'zotero.status': input => {
      const { zoteroMode, zoteroLibraryType, zoteroLibraryId, zoteroApiKey, clearZoteroKey } = input;
      const settings = mergeSettings(database.settings(), { zoteroMode, zoteroLibraryType, zoteroLibraryId, zoteroApiKey, clearZoteroKey });
      if (zoteroMode === 'web' && !settings.zoteroLibraryId) {
        return { mode: 'web', connected: false, access: 'none', detail: 'Enter a Zotero library ID for this Web connection.' };
      }
      return new ZoteroLibrary(settings, fetchImpl, database).status();
    },
    'zotero.link': input => zotero().link(input),
    'zotero.get': input => zotero().get(input),
    'zotero.search': input => zotero().search(input),
    'zotero.save': input => zotero().save(input)
  } satisfies Handlers;
  function supported(action: string): action is Operation { return Object.hasOwn(handlers, action); }
  function run<K extends Operation>(operation: K, payload?: unknown, options?: StreamOptions): Promise<ServiceResults[K]>;
  function run(operation: string, payload?: unknown, options?: StreamOptions): Promise<Result>;
  async function run(operation: string, payload: unknown = {}, options?: StreamOptions): Promise<Result> {
    if (!supported(operation)) throw new ServiceError(404, 'Unknown Paper Reader operation.');
    return handlers[operation](inputObject(payload), options);
  }
  return run;
}
