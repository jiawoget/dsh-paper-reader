import type { ChatSource } from '../shared/types.js';

export interface AnswerQuote { turn: number; text: string }
export interface MessageDraft { text: string; quote?: AnswerQuote }
export interface DiscussionRef { source: ChatSource; thread: string }
export interface SavedQuestions extends DiscussionRef {
  active: string;
  drafts: [string, MessageDraft][];
  updated: number;
}

const prefix = (docId: string) => 'reader.question-draft.' + encodeURIComponent(docId) + '/';

export function readQuestions(docId: string, thread: string): SavedQuestions | undefined {
  try {
    const raw = sessionStorage.getItem(prefix(docId) + thread);
    if (!raw) return;
    const saved = JSON.parse(raw) as SavedQuestions;
    if (saved?.thread !== thread || !/^selection-[a-f\d]{64}$/u.test(thread) || saved.source?.docId !== docId ||
      !Array.isArray(saved.drafts) || !saved.drafts.length || typeof saved.active !== 'string' ||
      !Number.isInteger(saved.source.page) || saved.source.page < 1 || !['source','translation'].includes(saved.source.side) ||
      [saved.source.selected,saved.source.original,saved.source.context,saved.source.anchor,saved.source.label,saved.source.title].some(s => typeof s !== 'string') ||
      !URL.canParse(saved.source.sourceUrl)) return;
    if (saved.drafts.every(pair => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1]?.text === 'string' &&
      (!pair[1].quote || Number.isInteger(pair[1].quote.turn) && typeof pair[1].quote.text === 'string'))) return saved;
  } catch { /* A live conversation also keeps its drafts in memory. */ }
}

export function saveQuestions(ref: DiscussionRef, active: string, drafts: Map<string, MessageDraft>): void {
  try {
    const key = prefix(ref.source.docId) + ref.thread;
    const pending = [...drafts].filter(([, draft]) => draft.text.trim());
    if (pending.length) sessionStorage.setItem(key, JSON.stringify({ ...ref, active, drafts: pending, updated: Date.now() }));
    else sessionStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('reader-question-drafts', { detail: ref.source.docId }));
  } catch { /* Storage can be unavailable. The current session still works. */ }
}

export function paperQuestions(docId: string): SavedQuestions[] {
  const found: SavedQuestions[] = [], start = prefix(docId);
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(start)) continue;
      const saved = readQuestions(docId, key.slice(start.length));
      if (saved?.drafts.length) found.push(saved);
    }
  } catch { /* No stored drafts in this tab. */ }
  return found.sort((a, b) => b.updated - a.updated);
}
