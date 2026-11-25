import type { AnnotationColor } from '../shared/annotations.js';
import { ANNOTATION_COLORS, highlightColorLabel, highlightDotAriaLabel } from './annotation-colors.js';
import type { DiscussionRef } from './discussion-drafts.js';
import { insertNotebookPassage } from './notebook.js';
import { SelectionChat, type ChatState } from './selection-chat.js';
import { chatSource, selectionKey, type SelectionContext } from './selection-context.js';
import { SelectionNotes, type NoteState } from './selection-notes.js';
import { button, el, icon, readerLabel as label, type Glyph, type ReaderPort } from './ui.js';

interface CardActionsOptions {
  chat: SelectionChat;
  notesAction: HTMLButtonElement;
  includeNotes: boolean;
  onHighlight?: (color: AnnotationColor) => unknown;
  onSaveWord?: () => unknown;
  onInsertLink: () => unknown;
  onLocate: () => unknown;
  onToggleLanguage: () => unknown;
  onContinueDiscussion?: () => unknown;
}

interface CardActionsHandle {
  actions: HTMLElement;
  menu: HTMLElement;
  syncLanguage(narrow: boolean, comparing: boolean, hasWorkspace: boolean): void;
  reposition(): void;
  closeMenu(restoreFocus?: boolean): boolean;
}

export function excerpt(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= limit) return normalized;
  const prefix = characters.slice(0, limit).join('');
  const wordEnd = prefix.lastIndexOf(' ');
  return (wordEnd > limit * 0.7 ? prefix.slice(0, wordEnd) : prefix).trimEnd() + '…';
}

export function passagePreview(selection: string): HTMLElement {
  const section = el('div', 'selection-excerpt');
  const short = excerpt(selection, 100);
  const quotation = el('blockquote', '', short);
  quotation.id = 'selection-passage';
  quotation.dir = 'auto';
  section.append(quotation);
  if (short === selection) return section;
  const more = el('button', 'selection-disclosure');
  more.type = 'button';
  more.setAttribute('aria-controls', quotation.id);
  more.append(icon('next', 14));
  const expand = (open: boolean) => {
    quotation.textContent = open ? selection : short;
    more.setAttribute('aria-expanded', String(open));
    more.ariaLabel = more.title = open ? label('Show less', '收起') : label('Show full passage', '展开全文');
  };
  expand(false);
  more.onclick = () => expand(more.getAttribute('aria-expanded') !== 'true');
  section.append(more);
  return section;
}

export function buildCardActions(opts: CardActionsOptions): CardActionsHandle {
  const actions = el('div', 'card-actions');
  if (opts.onHighlight) {
    const group = el('div', 'selection-highlight-group');
    group.setAttribute('role', 'group');
    group.ariaLabel = label('Highlight', '高亮');
    group.append(button(label('Highlight', '高亮'), () => opts.onHighlight!('yellow'), 'btn selection-highlight', 'edit'));
    for (const color of ANNOTATION_COLORS) {
      const dot = button('', () => opts.onHighlight!(color), 'highlight-dot');
      dot.dataset.color = color;
      dot.ariaLabel = highlightDotAriaLabel(color);
      dot.title = highlightColorLabel(color);
      group.append(dot);
    }
    actions.append(group);
  }
  if (opts.onContinueDiscussion) {
    const chatGroup = el('div', 'selection-chat-group');
    chatGroup.setAttribute('role', 'group');
    chatGroup.ariaLabel = label('Ask AI', '提问');
    const follow = button(label('Ask in this discussion', '接着问'), opts.onContinueDiscussion, 'btn primary');
    opts.chat.action.classList.remove('primary');
    opts.chat.action.textContent = label('Ask separately', '单独提问');
    chatGroup.append(follow, opts.chat.action);
    actions.append(chatGroup);
  } else {
    actions.append(opts.chat.action);
  }
  if (opts.includeNotes) actions.append(opts.notesAction);

  const menu = el('nav', 'selection-more-menu');
  menu.id = 'selectionMoreMenu';
  menu.popover = 'auto';
  menu.ariaLabel = label('More selection actions', '更多选区操作');

  const more = el('button', 'btn selection-more');
  more.type = 'button';
  more.setAttribute('aria-haspopup', 'true');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-controls', menu.id);
  more.popoverTargetElement = menu;
  more.popoverTargetAction = 'toggle';
  const chevron = icon('next', 12);
  chevron.classList.add('selection-more-chevron');
  more.append(el('span', '', label('More', '更多')), chevron);
  actions.append(more);

  const closeMenu = (restoreFocus = false): boolean => {
    if (!menu.matches(':popover-open')) return false;
    menu.hidePopover();
    if (restoreFocus && more.isConnected) more.focus({ preventScroll: true });
    return true;
  };
  const reposition = (opening = false): void => {
    if (!opening && !menu.matches(':popover-open')) return;
    const trigger = more.getBoundingClientRect();
    if (!trigger.width && !trigger.height) { if (!opening) closeMenu(false); return; }
    const width = menu.offsetWidth || 184;
    const height = menu.offsetHeight || 160;
    const spaceBelow = innerHeight - trigger.bottom - 12;
    const spaceAbove = trigger.top - 12;
    const top = spaceBelow >= height || spaceBelow >= spaceAbove
      ? Math.min(trigger.bottom + 4, innerHeight - height - 8)
      : trigger.top - height - 4;
    menu.style.left = Math.max(8, Math.min(trigger.right - width, innerWidth - width - 8)) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
  };
  const item = (text: string, run: () => unknown, glyph: Glyph, extra = '') =>
    button(text, () => { closeMenu(false); return run(); }, 'selection-more-item' + (extra ? ' ' + extra : ''), glyph);

  if (opts.onSaveWord) menu.append(item(label('Save word', '收藏词语'), opts.onSaveWord, 'star'));
  const link = item(label('Insert passage link', '引用到笔记'), opts.onInsertLink, 'arrow');
  link.title = label('Insert this passage at the cursor in Notes', '在笔记光标处插入原文出处');
  menu.append(link, item(label('Locate', '定位选段'), opts.onLocate, 'pin'));
  const language = item('', opts.onToggleLanguage, 'columns', 'selection-language');
  const languageCaption = el('span');
  language.append(languageCaption);
  menu.append(language);

  menu.addEventListener('beforetoggle', event => { if (event.newState === 'open') reposition(true); });
  menu.addEventListener('toggle', () => {
    const open = menu.matches(':popover-open');
    more.setAttribute('aria-expanded', String(open));
    if (open) {
      reposition();
      menu.querySelector<HTMLButtonElement>('button:not([hidden])')?.focus({ preventScroll: true });
    }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not([hidden])'));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index <= 0 ? items.length - 1 : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next].focus({ preventScroll: true });
  });

  const syncLanguage = (narrow: boolean, comparing: boolean, hasWorkspace: boolean): void => {
    language.hidden = (!narrow && comparing) || hasWorkspace;
    const destination = narrow
      ? (comparing ? label('Show original', '查看原文') : label('Show translation', '查看译文'))
      : label('Open bilingual view', '打开双语对照');
    if (languageCaption.textContent !== destination) languageCaption.textContent = destination;
  };

  return { actions, menu, syncLanguage, reposition, closeMenu };
}

export class SelectionWorkspace {
  private readonly discussions = new Map<string, ChatState>();
  private readonly notesBySelection = new Map<string, NoteState>();
  private active?: { thread: string; selection: string; notes: SelectionNotes; chat: SelectionChat };
  private recent?: DiscussionRef;
  constructor(private app: ReaderPort) {}

  get currentQuestion(): DiscussionRef | undefined {
    const ref = this.recent;
    const state = ref && this.discussions.get(ref.thread);
    return ref?.source.docId === this.app.doc.id && state && (state.turns.length || state.pending || state.failure || state.stopped)
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
    actions.append(chat.action);
    if (item.hit.regionText === undefined) actions.append(notes.action);
    this.active = { thread, selection, notes, chat };
    return {
      actions,
      notesAction: notes.action,
      notes: notes.root,
      writeNote: () => notes.show(),
      insertLink: () => insertNotebookPassage(this.app, item.source, item.selection),
      chat,
      meaning: () => state.meanings?.[selection + item.hit.side]
    };
  }
  refresh(): void { this.active?.notes.refresh(); this.active?.chat.refresh(); }
  exchangeDeleted(thread: string, requestId: string): void {
    const state = this.discussions.get(thread);
    if (!state) return;
    const index = state.turns.findIndex(turn => turn.role === 'assistant' && turn.requestId === requestId);
    if (index >= 0) {
      const start = index > 0 && state.turns[index - 1].role === 'user' ? index - 1 : index;
      state.turns.splice(start, index - start + 1);
      state.answerActions?.clear();
    }
    if (this.active?.thread === thread) this.active.chat.resetLog();
    else if (!state.turns.length && !state.pending && !state.failure && !state.stopped && ![...state.drafts.values()].some(draft => draft.text))
      this.discussions.delete(thread);
  }
  close(): void {
    if (!this.active) return;
    const { thread, selection, chat, notes } = this.active;
    notes.destroy();
    chat.destroy();
    if (!this.notesBySelection.get(selection)?.draft) this.notesBySelection.delete(selection);
    const state = this.discussions.get(thread)!;
    if (!state.turns.length && !state.pending && !state.failure && !state.stopped && ![...state.drafts.values()].some(draft => draft.text))
      this.discussions.delete(thread);
    this.active = undefined;
  }
}
