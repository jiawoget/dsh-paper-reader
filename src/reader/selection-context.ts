import { readSelectionRange, readTranslatedLocator } from '../shared/source-link.js';
import { readArticleRegion } from '../shared/article-region.js';
import type { ChatSource, JournalNote, SelectionHit, SourceRecord } from '../shared/types.js';
import { readRegion } from './pdf/region-geometry.js';

export interface SelectionContext {
  source: SourceRecord;
  hit: SelectionHit;
  original: string;
  selection: string;
  context: string;
  pairedTranslation?: string;
  exactPair?: boolean;
  thread?: string;
  record?: (meaning: string) => Promise<void>;
}

export function chatSource(item: SelectionContext): ChatSource {
  return { ...item.source, selected: item.selection, original: item.original, context: item.context, side: item.hit.side };
}

export function isScreenshotAnchor(anchor: string): boolean {
  return Boolean(readRegion(anchor) || readArticleRegion(anchor));
}

export function materialKey(source: ChatSource): string {
  const location = [source.docId, source.page, source.anchor];
  if (isScreenshotAnchor(source.anchor)) return JSON.stringify(location);
  const url = new URL(source.sourceUrl);
  return JSON.stringify([...location, source.original, readSelectionRange(url), readTranslatedLocator(url)]);
}

export function previousDiscussionSources(sources: readonly ChatSource[], current: ChatSource): ChatSource[] {
  const others = new Map<string, ChatSource>();
  const currentKey = materialKey(current);
  for (const source of sources) {
    const key = materialKey(source);
    if (source.docId === current.docId && key !== currentKey) others.set(key, source);
  }
  return [...others.values()];
}

export async function conversationThread(item: SelectionContext): Promise<string> {
  if (item.thread) return item.thread;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(selectionKey(item)));
  return 'selection-' + Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

const normalized = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

type NoteSelection = Pick<SelectionContext, 'source' | 'original' | 'selection' | 'exactPair' | 'pairedTranslation'> & {
  hit: Pick<SelectionHit, 'side' | 'regionText' | 'context' | 'sourceText' | 'sourceOffset' | 'translatedOffset'>;
};

function repeatedOriginal(item: NoteSelection): boolean {
  const text = normalized(item.hit.sourceText ?? item.hit.context), quote = normalized(item.original);
  const first = text.indexOf(quote);
  return first >= 0 && text.indexOf(quote, first + 1) >= 0;
}

export function selectionKey(item: SelectionContext): string {
  const { source, original, selection, hit, exactPair } = item;
  const position: (number | string | undefined)[] = [source.docId, source.page, source.anchor];
  if (hit.regionText !== undefined) return JSON.stringify(position);
  position.push(normalized(original));
  const repeated = repeatedOriginal(item);
  if (hit.side === 'translation' && (!exactPair || (repeated && hit.sourceOffset === undefined))) {
    position.push('translation', normalized(selection), hit.translatedOffset);
  } else if (repeated) position.push('source', hit.sourceOffset);
  return JSON.stringify(position);
}

export function readerNoteTexts(notes: JournalNote[]): string[] | undefined {
  const texts = notes.map(note => note.text).filter(text => text.trim());
  return texts.length ? texts : undefined;
}

export function notesForRecordedSource(notes: JournalNote[], source: ChatSource): JournalNote[] {
  const url = URL.parse(source.sourceUrl);
  const range = url && readSelectionRange(url);
  const target = url && readTranslatedLocator(url);
  return notesForSelection(notes, { source, original: source.original, selection: source.selected, hit: {
    side: source.side, context: source.context,
    regionText: isScreenshotAnchor(source.anchor) ? source.context : undefined,
    sourceOffset: source.side === 'source' ? range?.start : undefined,
    translatedOffset: target?.offset ?? (source.side === 'translation' ? range?.start : undefined)
  } });
}

export function notesForSelection(notes: JournalNote[], item: NoteSelection): JournalNote[] {
  const { source, original, selection, hit, pairedTranslation, exactPair } = item;
  const quote = normalized(original);
  const repeated = repeatedOriginal(item);
  return notes.filter(note => {
    if (note.docId !== source.docId || note.page !== source.page || note.anchor !== source.anchor) return false;
    if (hit.regionText !== undefined) return true;
    const savedQuote = normalized(note.quote);
    const picked = normalized(note.context ?? '');
    const url = URL.parse(note.sourceUrl);
    const target = url ? readTranslatedLocator(url) : undefined;
    const start = url ? readSelectionRange(url)?.start : undefined;
    const fromSource = !target && (!picked || picked === savedQuote);
    if (hit.side === 'source') {
      if (fromSource) return savedQuote === quote && (start === undefined || hit.sourceOffset === undefined || start === hit.sourceOffset);
      return Boolean(!repeated && exactPair && pairedTranslation && picked === normalized(pairedTranslation) && savedQuote.includes(quote));
    }
    const targetOffset = target?.offset ?? start;
    if (savedQuote !== quote) {
      // Older readers saved the whole English paragraph before sentence alignment existed.
      return !fromSource && picked === normalized(selection) && targetOffset !== undefined && targetOffset === hit.translatedOffset &&
        (savedQuote.includes(quote) || savedQuote === normalized(hit.sourceText ?? hit.context));
    }
    if (fromSource) return !repeated && (Boolean(exactPair) || picked === normalized(selection));
    if (picked !== normalized(selection)) return false;
    // Earlier reader versions did not store an offset. Their matching text is still recoverable.
    return targetOffset === undefined || hit.translatedOffset === undefined || targetOffset === hit.translatedOffset;
  });
}
