import path from 'node:path';
import { DEFAULT_TARGET_LANGUAGE, parseTargetLanguage } from '../shared/languages.js';
import type { ChatExchange, Collection, JournalNote, NotebookSnapshot, Operations, QuestionModel, Settings, ZoteroStatus, ZoteroItem as ReaderZoteroItem } from '../shared/types.js';

export class ServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Input = Record<string, unknown>;
export function isObject(value: unknown): value is Input {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function inputObject(value: unknown): Input {
  if (!isObject(value)) throw new ServiceError(400, 'Request parameters must be an object.');
  return value;
}
export function stringValue(value: unknown, name: string, limit: number, required = false, preserveWhitespace = false): string {
  if (value === undefined || value === null) {
    if (!required) return '';
  }
  if (typeof value !== 'string' || value.includes('\0') || value.length > limit || (required && !value.trim())) {
    throw new ServiceError(400, 'Check the ' + name + ' length and format.');
  }
  return preserveWhitespace ? value : value.trim();
}
export function single(value: unknown, name: string, limit: number, required = false): string {
  const result = stringValue(value, name, limit, required);
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new ServiceError(400, name + ' contains invalid characters.');
  return result;
}
export function address(value: unknown, required = false): string {
  const raw = single(value, 'URL', 8192, required);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Return the field's validation error. */ }
  throw new ServiceError(400, 'Enter a valid HTTP(S) URL without embedded credentials.');
}
export function onLoopback(url: URL): boolean {
  return url.hostname === '[::1]' || url.hostname === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
}
function modelBase(value: unknown): string {
  const url = new URL(address(value, true));
  if ((url.protocol === 'http:' && !onLoopback(url)) || url.search || url.hash) {
    throw new ServiceError(400, 'Use HTTPS or loopback HTTP for the model endpoint and remove its query and fragment.');
  }
  return url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}
export function pageNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ServiceError(400, 'The page number must be a positive integer.');
  return value;
}
export function readTargetLanguage(value: unknown): string {
  const parsed = parseTargetLanguage(value);
  if (!parsed.ok) throw new ServiceError(400, parsed.error);
  return parsed.value;
}
function readMultilinePref(value: unknown, name: string, error: string): string {
  const raw = stringValue(value, name, 8_000, false, true);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) throw new ServiceError(400, error);
  return raw.replace(/\r\n?/g, '\n');
}

export interface PrivateSettings {
  questionModel?: QuestionModel;
  model: string;
  baseUrl: string;
  apiKey: string;
  targetLanguage: string;
  glossary: string;
  customPrompts: string;
  vaultPath: string;
  zoteroLibraryId: string;
  zoteroLibraryType: 'user' | 'group';
  zoteroApiKey: string;
  zoteroMode?: 'web' | 'desktop';
  openAlexEmail?: string;
  openAlexApiKey?: string;
  semanticScholarApiKey?: string;
  ncbiApiKey?: string;
}
export const initialSettings: Readonly<PrivateSettings> = {
  baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '',
  targetLanguage: DEFAULT_TARGET_LANGUAGE, glossary: '', customPrompts: '', vaultPath: '',
  zoteroLibraryId: '', zoteroLibraryType: 'user', zoteroApiKey: '',
  openAlexEmail: '', openAlexApiKey: '', semanticScholarApiKey: '', ncbiApiKey: ''
};
export function zoteroModeFor(settings: PrivateSettings): 'desktop' | 'web' {
  return !settings.zoteroLibraryId || settings.zoteroMode === 'desktop' ? 'desktop' : 'web';
}
export interface PublicSettings extends Settings {
  hostProvider: string;
  hostModel: string;
}
function updatedSecret(current: string, submitted: unknown, clear: unknown): string {
  if (clear === true) return '';
  if (submitted === undefined || submitted === '') return current;
  if (typeof submitted !== 'string' || submitted.length > 4096 || !/^[\x21-\x7e]+$/.test(submitted)) {
    throw new ServiceError(400, 'API keys must be a single line of printable characters.');
  }
  return submitted;
}
export function mergeSettings(current: PrivateSettings, input: Input): PrivateSettings {
  const baseUrl = input.baseUrl === undefined ? current.baseUrl : modelBase(input.baseUrl === '' ? initialSettings.baseUrl : input.baseUrl);
  const model = single(input.model ?? current.model, 'model name', 250, true);
  const vault = single(input.vaultPath ?? current.vaultPath, 'Obsidian vault directory', 4096);
  if (vault && (!path.isAbsolute(vault) || path.resolve(vault) === path.parse(path.resolve(vault)).root)) {
    throw new ServiceError(400, 'Enter the absolute directory of your Obsidian vault.');
  }
  const type = input.zoteroLibraryType ?? current.zoteroLibraryType;
  if (type !== 'user' && type !== 'group') throw new ServiceError(400, 'Choose a user or group Zotero library.');
  const id = single(input.zoteroLibraryId ?? current.zoteroLibraryId, 'Zotero library ID', 24);
  const zoteroMode = input.zoteroMode ?? current.zoteroMode ?? 'web';
  if (zoteroMode !== 'web' && zoteroMode !== 'desktop') throw new ServiceError(400, 'Choose a Zotero connection.');
  if (id && !/^[1-9]\d*$/.test(id)) throw new ServiceError(400, 'The Zotero library ID must be a positive integer.');
  const sameOrigin = new URL(current.baseUrl).origin === new URL(baseUrl).origin;
  const targetLanguage = input.targetLanguage === undefined ? current.targetLanguage : readTargetLanguage(input.targetLanguage);
  const glossary = input.glossary === undefined ? current.glossary : readMultilinePref(input.glossary, 'glossary', 'Glossary contains invalid control characters.');
  const customPrompts = input.customPrompts === undefined ? current.customPrompts : readMultilinePref(input.customPrompts, 'custom prompts', 'Custom prompts contain invalid control characters.');
  const openAlexEmail = single(input.openAlexEmail ?? current.openAlexEmail ?? '', 'OpenAlex email', 254);
  if (openAlexEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(openAlexEmail)) throw new ServiceError(400, 'Enter a valid email address for OpenAlex polite pool.');
  return {
    questionModel: input.questionModel === undefined ? current.questionModel : readQuestionModel(input.questionModel),
    model, baseUrl, apiKey: updatedSecret(sameOrigin ? current.apiKey : '', input.apiKey, input.clearApiKey),
    targetLanguage, glossary, customPrompts,
    vaultPath: vault ? path.resolve(vault) : '', zoteroLibraryType: type, zoteroLibraryId: id, zoteroMode,
    zoteroApiKey: updatedSecret(current.zoteroApiKey, input.zoteroApiKey ?? input.zoteroKey, input.clearZoteroKey),
    openAlexEmail,
    openAlexApiKey: updatedSecret(current.openAlexApiKey ?? '', input.openAlexApiKey, input.clearOpenAlexApiKey),
    semanticScholarApiKey: updatedSecret(current.semanticScholarApiKey ?? '', input.semanticScholarApiKey, input.clearSemanticScholarApiKey),
    ncbiApiKey: updatedSecret(current.ncbiApiKey ?? '', input.ncbiApiKey, input.clearNcbiApiKey)
  };
}

export function readQuestionModel(value: unknown): QuestionModel | undefined {
  if (value === undefined || value === null) return;
  const data = inputObject(value);
  const provider = single(data.provider, 'DSH provider', 1024, true);
  const model = single(data.model, 'DSH model', 1024, true);
  return { provider, model, ...(data.reasoningEffort !== undefined && {
    reasoningEffort: single(data.reasoningEffort, 'reasoning effort', 1024, true)
  }) };
}

export type EntryKind = 'note' | 'word' | 'history';
export interface Entry extends JournalNote { meaning: string; context: string }
export interface Entries { notes: Entry[]; vocabulary: Entry[]; history: Entry[] }
export interface ZoteroCollection extends Collection { parentCollection: string | null }
export interface ZoteroItem extends ReaderZoteroItem {
  doi: string; url: string; type: string; creator: string; date: string;
}
export interface ServiceResults {
  'ai.models': Operations['ai.models'][1];
  'ai.selectModel': Operations['ai.selectModel'][1];
  'article.capture.save': Operations['article.capture.save'][1];
  'article.capture.get': Operations['article.capture.get'][1];
  'outline.get': Operations['outline.get'][1];
  'outline.generate': Operations['outline.generate'][1];
  'book.progress.get': Operations['book.progress.get'][1];
  'book.progress.save': Operations['book.progress.save'][1];
  'annotation.list': Operations['annotation.list'][1];
  'annotation.save': Operations['annotation.save'][1];
  'annotation.delete': Operations['annotation.delete'][1];
  state: Entries & { settings: PublicSettings };
  'library.list': Operations['library.list'][1];
  'library.get': Operations['library.get'][1];
  'library.rename': Operations['library.rename'][1];
  'library.updateMeta': Operations['library.updateMeta'][1];
  'library.delete': Operations['library.delete'][1];
  'library.createAbstract': Operations['library.createAbstract'][1];
  'library.importRefs': Operations['library.importRefs'][1];
  'library.exportRefs': Operations['library.exportRefs'][1];
  'library.progress.save': Operations['library.progress.save'][1];
  'library.triage': Operations['library.triage'][1];
  'library.search': Operations['library.search'][1];
  'pages.index': Operations['pages.index'][1];
  'pages.search': Operations['pages.search'][1];
  'topics.list': Operations['topics.list'][1];
  'topics.save': Operations['topics.save'][1];
  'topics.delete': Operations['topics.delete'][1];
  'graph.resolve': Operations['graph.resolve'][1];
  'graph.explore': Operations['graph.explore'][1];
  'graph.savePaper': Operations['graph.savePaper'][1];
  'trends.query': Operations['trends.query'][1];
  'trends.papers': Operations['trends.papers'][1];
  'library.cards': Operations['library.cards'][1];
  'library.chat': Operations['library.chat'][1];
  'web.import': Operations['web.import'][1];
  'web.open': Operations['web.open'][1];
  'book.section': Operations['book.section'][1];
  'translation.get': Operations['translation.get'][1];
  'translation.page': Operations['translation.page'][1];
  'settings.save': { settings: PublicSettings };
  'note.save': { note: Entry };
  'note.delete': { id: string; deleted: boolean };
  'notebook.get': NotebookSnapshot;
  'notebook.write': NotebookSnapshot;
  'notebook.open': { uri:string };
  'vocab.save': { word: Entry };
  'vocab.delete': { id: string; deleted: boolean };
  'history.add': { entry: Entry };
  ai: { text: string };
  'chat.ask': { text: string };
  'chat.searchTerms': { text: string };
  'chat.history': { exchanges: ChatExchange[] };
  'chat.delete': Operations['chat.delete'][1];
  'ai.blocks': { translations: Record<string, string>; provider?: 'local' };
  'obsidian.export': { path: string; notes: number; words: number; annotations: number };
  'zotero.collections': Operations['zotero.collections'][1];
  'zotero.browse': Operations['zotero.browse'][1];
  'zotero.open': Operations['zotero.open'][1];
  'zotero.status': ZoteroStatus;
  'zotero.link': { item: ZoteroItem };
  'zotero.get': { item: ZoteroItem | null };
  'zotero.search': { items: ZoteroItem[]; total: number; hasMore: boolean };
  'zotero.save': { key: string; collections: string[]; created: boolean };
}
