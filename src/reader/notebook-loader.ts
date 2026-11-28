import type { SourceRecord } from '../shared/types.js';
import type { ReaderPort } from './ui.js';
import type { NotebookInsertion } from './notebook.js';

type NotebookModule = typeof import('./notebook.js');

export type { NotebookInsertion };

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

export function discardNotebook(app: ReaderPort, docId: string): void {
  loaded?.discardNotebook(app, docId);
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

export function currentNotebookMarkdown(app: ReaderPort): string | undefined {
  return loaded?.currentNotebookMarkdown(app);
}

export async function flushNotebook(
  app: ReaderPort,
  saveDraft: (draft: { revision: string; original: string; text: string }, chapterId?: string) => Promise<void>
): Promise<void> {
  if (loaded) await loaded.flushNotebook(app, saveDraft);
}
