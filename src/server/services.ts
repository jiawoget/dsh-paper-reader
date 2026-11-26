import type { DocPageHit, DocumentInfo, GraphDirection } from '../shared/types.js';
import { exportBulkRefs, parseBulkRefs, type BulkRefFormat } from '../shared/citation-bulk.js';
import type { ResourceReader } from './academic-intake.js';
import { exploreCitationGraph, readGraphPaperInput, resolveAcademicPaper, saveGraphPaper } from './academic-graph.js';
import { queryFieldTrends, queryTrendPapers, readTrendPapersInput, readTrendQueryInput } from './field-trends.js';
import { PaperNotebooks } from './notebook.js';
import { installedObsidian, type ObsidianLauncher } from './obsidian-desktop.js';
import { publicResource } from './public-resource.js';
import { extractDocumentPages } from './pdf-text.js';
import { ReaderModel, type StreamOptions } from './reader-model.js';
import { PaperDiscussions } from './paper-discussion.js';
import { PdfOutlines } from './pdf-outline.js';
import { ReaderStore } from './reader-store.js';
import { deleteTopic, hasDocPages, listTopics, replaceDocPages, saveTopic, searchDocPagesFts } from './research-store.js';
import { hostAttachments } from './region-image.js';
import { inputObject, isObject, mergeSettings, readQuestionModel, readTargetLanguage, ServiceError, single, stringValue, type Input, type ServiceResults } from './service-types.js';
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
  const indexDoc = async (doc: DocumentInfo, force = false): Promise<number> => {
    if (!force && database.withDb(false, db => hasDocPages(db, doc.id))) return 0;
    const full = doc.kind === 'pdf' || doc.paragraphs || doc.abstract ? doc : await documents.get(doc.id);
    const pdfBytes = full.kind === 'pdf' ? await documents.bytes(full.id) : undefined;
    const pages = await extractDocumentPages(full, pdfBytes);
    if (!pages.length || !documents.hasSync(full.id)) return 0;
    return database.withDb(true, db => replaceDocPages(db, full.id, pages));
  };
  const listDocsWithMeta = async (): Promise<DocumentInfo[]> => {
    const docs = await documents.list(), metas = database.listDocMeta();
    return docs.map(doc => { const meta = metas.get(doc.id); return meta ? { ...doc, meta } : doc; });
  };
  const handlers = {
    'library.list': async () => ({ docs: await listDocsWithMeta() }),
    'library.get': async input => {
      const doc = await documents.get(input.id), meta = database.listDocMeta(doc.id).get(doc.id);
      return { doc: meta ? { ...doc, meta } : doc };
    },
    'library.rename': async input => ({ doc: await documents.rename(input.id, input.title) }),
    'library.updateMeta': async input => ({ doc: await documents.updateMeta(input) }),
    'library.delete': input => documents.delete(input.id),
    'library.createAbstract': async input => {
      const doc = await documents.createAbstract(input);
      await indexDoc(doc, doc.kind === 'abstract').catch(() => 0);
      return { doc };
    },
    'library.importRefs': async input => {
      const text = stringValue(input.text, 'references text', 4 * 1024 * 1024, true, true);
      const format = input.format === undefined ? 'auto' : input.format;
      if (format !== 'auto' && format !== 'bibtex' && format !== 'ris' && format !== 'csv') throw new ServiceError(400, 'Choose BibTeX, RIS, CSV, or auto.');
      const tag = single(input.tag, 'tag', 40), parsed = parseBulkRefs(text, format);
      if (parsed.length > 500) throw new ServiceError(400, 'Import at most 500 references at once.');
      const before = new Set((await documents.list()).map(d => d.id)), seen = new Set<string>(), docs: DocumentInfo[] = [];
      let created = 0, existing = 0, skipped = 0;
      for (const entry of parsed) {
        try {
          const doc = await documents.createAbstract(entry);
          if (before.has(doc.id) || seen.has(doc.id)) existing++; else created++;
          const extra = [...(entry.tags ?? []), ...(tag ? [tag] : [])];
          let meta = database.listDocMeta(doc.id).get(doc.id);
          if (extra.length) meta = database.updateDocTriage({ docId: doc.id, tags: [...new Set([...(meta?.tags ?? []), ...extra])].slice(0, 50) });
          await indexDoc(doc, doc.kind === 'abstract').catch(() => 0);
          if (!seen.has(doc.id)) { seen.add(doc.id); docs.push(meta ? { ...doc, meta } : doc); }
        } catch { skipped++; }
      }
      return { created, existing, skipped, docs };
    },
    'library.exportRefs': async input => {
      const format = input.format;
      if (format !== 'bibtex' && format !== 'ris' && format !== 'csv') throw new ServiceError(400, 'Choose BibTeX, RIS, or CSV.');
      const filter = input.docIds === undefined ? undefined : (() => {
        if (!Array.isArray(input.docIds) || input.docIds.length > 1000) throw new ServiceError(400, 'Invalid document filter.');
        return new Set(input.docIds.map(id => single(id, 'document ID', 512, true)));
      })();
      const listed = (await documents.list()).filter(d => !filter || filter.has(d.id)), metas = database.listDocMeta();
      const fullDocs = await Promise.all(listed.map(async d => {
        const full = d.id === 'pagedattention' ? d : await documents.get(d.id).catch(() => d), meta = metas.get(full.id);
        return meta ? { ...full, meta } : full;
      }));
      return { format: format as BulkRefFormat, filename: `paper-reader-library.${format === 'bibtex' ? 'bib' : format}`, content: exportBulkRefs(fullDocs, format), count: fullDocs.length };
    },
    'library.progress.save': input => withDoc(input.docId, () => ({ meta: database.saveDocProgress(input) })),
    'library.triage': input => withDoc(input.docId, () => ({ meta: database.updateDocTriage(input) })),
    'library.search': async input => {
      const query = single(input.query, 'search query', 256);
      return { hits: query ? database.searchLibrary(query, await documents.list()) : [] };
    },
    'pages.index': async input => {
      if (input.force !== undefined && typeof input.force !== 'boolean') throw new ServiceError(400, 'Invalid force option.');
      const force = input.force === true;
      if (input.docId !== undefined) {
        const pages = await indexDoc(await documents.get(input.docId), force);
        return { indexed: pages > 0 ? 1 : 0, pages };
      }
      let indexed = 0, pages = 0;
      for (const doc of await documents.list()) {
        const count = await indexDoc(doc, force).catch(() => 0);
        if (count > 0) { indexed++; pages += count; }
      }
      return { indexed, pages };
    },
    'pages.search': async input => {
      const query = single(input.query, 'search query', 500);
      if (!query) return { hits: [] };
      const docIds = input.docIds === undefined ? undefined : (() => {
        if (!Array.isArray(input.docIds) || input.docIds.length > 500) throw new ServiceError(400, 'Invalid document filter.');
        return input.docIds.map(id => single(id, 'document ID', 512, true));
      })();
      const limit = input.limit;
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)) {
        throw new ServiceError(400, 'Invalid search limit.');
      }
      const docs = await documents.list(), docMap = new Map(docs.map(d => [d.id, d]));
      for (const target of docIds ? docIds.map(id => docMap.get(id)).filter((d): d is DocumentInfo => Boolean(d)) : docs) await indexDoc(target, false).catch(() => 0);
      const hits: DocPageHit[] = [];
      for (const hit of database.withDb(false, db => searchDocPagesFts(db, query, { docIds, limit }))) {
        const doc = docMap.get(hit.docId);
        if (doc) hits.push({ ...hit, docTitle: doc.title, docKind: doc.kind });
      }
      return { hits };
    },
    'topics.list': () => ({ topics: database.withDb(false, listTopics) }),
    'topics.save': input => ({ topic: database.withDb(true, db => saveTopic(db, input)) }),
    'topics.delete': input => database.withDb(true, db => deleteTopic(db, input.id)),
    'graph.resolve': async (input, options) => {
      const doc = !single(input.query, 'query', 500) && input.docId !== undefined ? await documents.get(input.docId) : undefined;
      const query = single(input.query, 'query', 500) || (doc ? (doc.doi || doc.url || doc.paperTitle || doc.title) : '');
      if (!query) throw new ServiceError(400, 'Enter a DOI, arXiv ID, or paper title.');
      return resolveAcademicPaper(query, { withDb: (w, run) => database.withDb(w, run), settings: database.settings(), fetchFn: fetchImpl, docs: await documents.list(), signal: options?.signal });
    },
    'graph.explore': async (input, options) => {
      if (!Array.isArray(input.seeds) || !input.seeds.length || input.seeds.length > 10) throw new ServiceError(400, 'Provide 1 to 10 seed papers.');
      const direction = input.direction;
      if (direction !== 'earlier' && direction !== 'later' && direction !== 'similar') throw new ServiceError(400, 'Choose earlier, later, or similar.');
      if (input.negativeSeeds !== undefined && (!Array.isArray(input.negativeSeeds) || input.negativeSeeds.length > 10)) throw new ServiceError(400, 'Invalid negative seeds.');
      if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isFinite(input.limit))) throw new ServiceError(400, 'Invalid graph limit.');
      return exploreCitationGraph({
        seeds: input.seeds.map(s => single(s, 'seed paper', 500, true)), direction: direction as GraphDirection,
        negativeSeeds: input.negativeSeeds?.map(s => single(s, 'negative seed', 500, true)), limit: input.limit
      }, { withDb: (w, run) => database.withDb(w, run), settings: database.settings(), fetchFn: fetchImpl, docs: await documents.list(), signal: options?.signal });
    },
    'graph.savePaper': async input => {
      if (input.mode !== 'abstract' && input.mode !== 'oa-pdf') throw new ServiceError(400, 'Choose abstract or oa-pdf.');
      if (!isObject(input.paper)) throw new ServiceError(400, 'Invalid paper payload.');
      const topicTag = input.topicTag === undefined ? undefined : single(input.topicTag, 'topic tag', 40);
      return saveGraphPaper({ paper: readGraphPaperInput(input.paper), mode: input.mode, topicTag }, { library: documents, store: database, readResource, indexDoc });
    },
    'trends.query': async (input, options) => queryFieldTrends(readTrendQueryInput(input), {
      withDb: (w, run) => database.withDb(w, run), settings: database.settings(), fetchFn: fetchImpl, docs: await listDocsWithMeta(), signal: options?.signal
    }),
    'trends.papers': async (input, options) => queryTrendPapers(readTrendPapersInput(input), {
      withDb: (w, run) => database.withDb(w, run), settings: database.settings(), fetchFn: fetchImpl, docs: await listDocsWithMeta(), signal: options?.signal
    }),
    'web.import': async input => { const opened = await documents.importWebDocument(input); await indexDoc(opened.doc, true).catch(() => 0); return opened; },
    'web.open': async input => { const opened = await openWebArticle(documents, input.url, readResource); await indexDoc(opened.doc, true).catch(() => 0); return opened; },
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
