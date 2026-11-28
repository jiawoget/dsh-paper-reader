import type { SourceRecord } from '../shared/types.js';
import type { ReaderPort } from './ui.js';
import type { NotebookInsertion } from './notebook.js';

type NotebookModule = typeof import('./notebook.js');

export type { NotebookInsertion };
export type NotebookDraftHost = Pick<ReaderPort, 'doc' | 'page' | 'notebook'>;
interface StoredNotebookDraft { revision: string; original: string; text: string }

export const notebookDraftKey = (id: string): string => 'reader.markdown-draft.' + id;
export const notebookChapter = (app: Pick<ReaderPort, 'doc' | 'page'>): string | undefined => app.doc.book?.sections[app.page - 1]?.chapterId;
export const notebookDraftId = (app: Pick<ReaderPort, 'doc' | 'page'>, chapterId = notebookChapter(app)): string =>
  chapterId ? app.doc.id + '/' + encodeURIComponent(chapterId) : app.doc.id;

export function readStoredNotebookDraft(id: string): StoredNotebookDraft | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(notebookDraftKey(id)) || 'null');
    if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' &&
        'revision' in value && typeof value.revision === 'string' && 'original' in value && typeof value.original === 'string') {
      return { text: value.text, revision: value.revision, original: value.original };
    }
  } catch {}
}

export function clearStoredNotebookDrafts(docId: string): void {
  try {
    const exact = notebookDraftKey(docId);
    const keyPrefix = exact + '/';
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && (key === exact || key.startsWith(keyPrefix))) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {}
}

let loaded: NotebookModule | undefined;
let pending: Promise<NotebookModule> | undefined;

export function loadNotebook(): Promise<NotebookModule> {
  if (loaded) return Promise.resolve(loaded);
  return (pending ??= import('./notebook.js').then(mod => {
    loaded = mod;
    return mod;
  }, err => {
    pending = undefined;
    throw err;
  }));
}

export function loadedNotebook(): NotebookModule | undefined {
  return loaded;
}

export function discardNotebook(app: NotebookDraftHost, docId: string): void {
  if (loaded) loaded.discardNotebook(app, docId);
  else clearStoredNotebookDrafts(docId);
}

export async function leaveNotebook(app: ReaderPort, docId: string, chapterId?: string): Promise<void> {
  if (loaded) await loaded.leaveNotebook(app, docId, chapterId);
}

export async function goToNoteChapter(app: ReaderPort, source: Pick<SourceRecord, 'docId' | 'sourceUrl'> & { page?: number }): Promise<void> {
  const mod = await loadNotebook();
  return mod.goToNoteChapter(app, source);
}

export async function insertNotebookPassage(app: ReaderPort, source: SourceRecord, selected: string): Promise<void> {
  const mod = await loadNotebook();
  return mod.insertNotebookPassage(app, source, selected);
}

export function refreshNotebookHighlights(app: ReaderPort): void {
  loaded?.refreshNotebookHighlights(app);
}

export function currentNotebookMarkdown(app: NotebookDraftHost): string | undefined {
  if (loaded) return loaded.currentNotebookMarkdown(app);
  const chapterId = notebookChapter(app);
  return readStoredNotebookDraft(notebookDraftId(app, chapterId))?.text ??
    (app.notebook?.docId === app.doc.id && app.notebook.chapterId === chapterId ? app.notebook.markdown : undefined);
}

export async function flushNotebook(
  app: NotebookDraftHost,
  saveDraft: (draft: StoredNotebookDraft, chapterId?: string) => Promise<void>
): Promise<void> {
  if (loaded) { await loaded.flushNotebook(app, saveDraft); return; }
  const chapterId = notebookChapter(app), id = notebookDraftId(app, chapterId), draft = readStoredNotebookDraft(id);
  if (draft && draft.text !== draft.original) {
    await saveDraft(draft, chapterId);
    try { sessionStorage.removeItem(notebookDraftKey(id)); } catch {}
  }
}
