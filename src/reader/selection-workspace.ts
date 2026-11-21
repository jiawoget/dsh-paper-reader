import type { ReaderPort } from './panels.js';
import { insertNotebookPassage } from './notebook.js';
import { SelectionChat, type ChatState } from './selection-chat.js';
import { chatSource, selectionKey, type SelectionContext } from './selection-context.js';
import type { DiscussionRef } from './discussion-drafts.js';
import { SelectionNotes, type NoteState } from './selection-notes.js';
import { button, byId, el, readerLabel as label } from './ui.js';

export class SelectionWorkspace {
  private readonly discussions = new Map<string, ChatState>();
  private readonly notesBySelection = new Map<string, NoteState>();
  private active?: { thread: string; selection: string; notes: SelectionNotes; chat: SelectionChat };
  private recent?: DiscussionRef;
  constructor(private app: ReaderPort) {}

  get currentQuestion(): DiscussionRef | undefined {
    const ref = this.recent;
    const state = ref && this.discussions.get(ref.thread);
    return ref?.source.docId === this.app.doc.id && state && (state.turns.length || state.pending || state.failure)
      ? ref : undefined;
  }

  open(item: SelectionContext, thread: string, closeChat: () => void, previous?: DiscussionRef) {
    this.close();
    const selection = selectionKey(item);
    const state: ChatState = this.discussions.get(thread) ?? {
      turns: [], activeDraft: 'paper', drafts: new Map([['paper', { text: '' }]])
    };
    this.discussions.set(thread, state);
    const noteState = this.notesBySelection.get(selection) ?? {};
    this.notesBySelection.set(selection, noteState);
    const notes = new SelectionNotes(this.app, item, noteState, () => {
      if (this.active?.selection === selection) {
        this.active.notes.render();
        this.active.chat.renderQuote();
      }
    });
    const chat = new SelectionChat(this.app, item, thread, state, notes, () => {
      if (this.active?.thread === thread) this.active.chat.render();
    }, closeChat, () => { this.recent = { source: chatSource(item), thread }; }, previous);
    const actions = el('div', 'card-actions');
    const link = button(label('Insert passage link','引用到笔记'), () => insertNotebookPassage(this.app, item.source, item.selection), 'btn', 'arrow');
    link.title = label('Insert this passage at the cursor in your notebook','在笔记光标处插入原文出处');
    actions.append(chat.explain, chat.action);
    if (item.hit.regionText === undefined) actions.append(notes.action);
    actions.append(link);
    this.active = { thread, selection, notes, chat };
    byId('card').dataset.chatOpen = 'false';
    return { actions, notes: notes.root, writeNote: () => notes.show(), chat, meaning: () => state.meanings?.[selection + item.hit.side] };
  }
  refresh(): void { this.active?.notes.refresh(); this.active?.chat.refresh(); }
  close(): void {
    if (!this.active) return;
    const { thread, selection, chat, notes } = this.active;
    notes.destroy();
    chat.destroy();
    if (!this.notesBySelection.get(selection)?.draft) this.notesBySelection.delete(selection);
    const state = this.discussions.get(thread)!;
    if (!state.turns.length && !state.pending && !state.failure && ![...state.drafts.values()].some(draft => draft.text))
      this.discussions.delete(thread);
    this.active = undefined;
  }
}
