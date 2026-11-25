import type { ChatSource, Operations, ReadingSide } from '../shared/types.js';
import { maxPreviousMaterials } from '../shared/types.js';
import { DEFAULT_TARGET_LANGUAGE, targetLanguageBcp47, targetLanguageLabel, targetsSimplifiedChinese } from '../shared/languages.js';
import { answerMarkdown, selectedAnswer } from './answer-markdown.js';
import { AnswerNotebookAction } from './answer-notebook.js';
import { readQuestions, saveQuestions, type AnswerQuote, type MessageDraft } from './discussion-drafts.js';
import { compactReader } from './reading-desk.js';
import { settingsDialog } from './settings-dialog.js';
import { questionConnected, questionModelButton } from './question-model.js';
import { chatSource, isScreenshotAnchor, materialKey, notesForRecordedSource, notesForSelection, previousDiscussionSources, readerNoteTexts, selectionKey, type SelectionContext } from './selection-context.js';
import { screenshotFigureLabel } from './pdf/region-geometry.js';
import type { DiscussionRef } from './discussion-drafts.js';
import type { SelectionNotes } from './selection-notes.js';
import { activateAfterTouchDrag, api, apiStream, button, byId, el, icon, message, readerLabel as label, toast, type ReaderPort } from './ui.js';

interface Turn { role: 'user' | 'assistant'; content: string; quote?: AnswerQuote; source?: ChatSource; requestId?: string }
interface Request {
  item?: SelectionContext;
  savingNotes?: SelectionNotes;
  requestId?: string;
  mode: Operations['ai'][0]['mode'];
  prompt: string;
  draftKey?: string;
  quote?: AnswerQuote;
  payload?: Operations['ai'][0];
  side?: ReadingSide;
  controller?: AbortController;
  streamText?: string;
}
export interface ChatState {
  restored?: Promise<void>;
  turns: Turn[];
  drafts: Map<string, MessageDraft>;
  activeDraft: string;
  pending?: Request;
  failure?: { request: Request; error: string };
  meanings?: Record<string, string>;
  draftSource?: ChatSource;
  answerActions?: Map<number, AnswerNotebookAction>;
}
const quoteKey = (quote: AnswerQuote) => JSON.stringify([quote.turn, quote.text]);
const summary = (text: string) => {
  const words = text.replace(/\s+/gu, ' ').trim();
  return words.length > 46 ? words.slice(0, 45) + '…' : words;
};

export class SelectionChat {
  readonly root = el('aside', 'selection-chat');
  readonly heading = el('header', 'chat-heading');
  readonly action = button(label('Ask AI', '提问'), () => this.open('ask'), 'btn selection-chat-action');
  readonly explain = button(label('Explain', '解释'), () => this.open('explain'), 'btn selection-explain-action');
  private log = el('div', 'selection-chat-log');
  private quoteBar = el('div', 'answer-selection');
  private connection = el('div', 'chat-notice');
  private form = el('form', 'chat-composer');
  private starters = el('div', 'chat-starters');
  private events = new AbortController();
  private selected?: AnswerQuote;
  private draftExcerpt?: AnswerQuote;
  private readonly answerActions: Map<number, AnswerNotebookAction>;
  private dragging = false;
  private renderedTurns = 0;
  private pendingRow?: { request: Request; question: HTMLElement; wait: HTMLElement };
  private quoteVersion = '';
  private disconnected?: boolean;
  private readonly modelPicker: ReturnType<typeof questionModelButton>;
  private draftEdited = false;

  constructor(private app: ReaderPort, private item: SelectionContext, private thread: string, private state: ChatState,
    private notes: SelectionNotes, private changed: () => void, closeChat: () => void, private engage: () => void,
    private previous?: DiscussionRef) {
    this.answerActions = state.answerActions ??= new Map();
    this.modelPicker = questionModelButton(app);
    this.root.id = 'passage-chat';
    this.root.ariaLabel = label('Selection chat', '选段讨论');
    this.root.hidden = true;
    this.action.setAttribute('aria-expanded', 'false');
    const close = button('', () => { this.show(false); closeChat(); }, 'icon-btn chat-close');
    close.ariaLabel = label('Close chat', '收起讨论');
    close.append(icon('close', 14));
    this.heading.append(el('h3', '', label('Reading discussion', '阅读讨论')), this.modelPicker.button, close);
    this.log.setAttribute('role', 'log');
    this.log.ariaLabel = label('Selection chat history', '选段讨论记录');
    this.log.tabIndex = 0;
    this.log.setAttribute('aria-live', 'polite');
    this.quoteBar.setAttribute('role', 'group');
    this.quoteBar.ariaLabel = label('Selected answer text', '选中的回答文本');
    this.quoteBar.hidden = true;
    this.quoteBar.addEventListener('pointerdown', event => {
      if (event.target instanceof Element && event.target.closest('button')) event.preventDefault();
    });
    const content = el('div', 'chat-contents');
    this.root.append(this.heading, content);
    content.append(this.sourcePreview());
    if (item.hit.regionText !== undefined) {
      const personal = el('div', 'region-personal-note');
      personal.append(this.notes.action, this.notes.root);
      content.append(personal);
    } else {
      content.append(button(label('Write note', '记笔记'), () => {
        this.root.dispatchEvent(new Event('edit-selection-note', { bubbles: true }));
        return this.notes.show();
      }, 'text-btn chat-write-note'));
    }
    if (item.hit.regionText === undefined) {
      const target = this.app.state.settings.targetLanguage || DEFAULT_TARGET_LANGUAGE;
      const targetName = label(targetLanguageLabel(target, false), targetLanguageLabel(target, true));
      if (item.hit.side === 'translation') {
        if (targetLanguageBcp47(target) !== 'en') {
          this.starters.append(button(label('Translate to English', '翻译为英文'), () => this.ask({ mode: 'translate', prompt: label('Translate this selection into English.', '将此选段翻译为英文。') }), 'chat-starter'));
          content.append(this.starters);
        }
      } else if (!targetsSimplifiedChinese(target)) {
        this.starters.append(button(
          label('Translate to ' + targetName, '翻译为' + targetName),
          () => this.ask({ mode: 'translate', prompt: label('Translate this selection into ' + targetName + '.', '将此选段翻译为' + targetName + '。') }),
          'chat-starter'
        ));
        content.append(this.starters);
      }
    }
    content.append(this.log, this.quoteBar, this.connection, this.form);
    const signal = this.events.signal;
    this.log.addEventListener('pointerdown', () => { this.dragging = true; }, { signal });
    document.addEventListener('pointerup', () => {
      if (this.dragging) { this.dragging = false; this.capture(); }
    }, { signal });
    document.addEventListener('pointercancel', () => { this.dragging = false; }, { signal });
    document.addEventListener('selectionchange', () => { if (!this.dragging) this.capture(); }, { signal });
    this.log.addEventListener('keyup', () => this.capture(), { signal });
    this.form.addEventListener('focusin', () => this.clearSelection(), { signal });
  }
  private sourcePreview(): HTMLElement {
    const { hit, source, selection } = this.item;
    if (hit.regionText !== undefined && hit.image) {
      const preview = button('', () => this.app.openNotebookSource(new URL(source.sourceUrl)), 'discussion-region-source');
      const image = el('img');
      image.src = hit.image;
      image.alt = this.app.doc.kind === 'pdf' ? label('Selected PDF area', '框选的 PDF 区域') : label('Selected article area', '框选的阅读区域');
      const caption = el('span');
      caption.append(el('span', '', source.label), el('span', 'discussion-region-link', label('View in paper', '查看原处')));
      preview.append(image, caption);
      return preview;
    }
    const material = el('details', 'discussion-source');
    const sourceLabel = hit.side === 'translation' ? label('Translation', '译文') : label('Original', '原文');
    const place = this.app.doc.kind === 'web' ? source.label || label('Article', '文章') : label('Page ' + source.page, '第 ' + source.page + ' 页');
    const caption = el('summary', '', sourceLabel + ' · ' + place);
    const passage = el('blockquote', '', selection);
    passage.dir = 'auto';
    material.open = !matchMedia(compactReader).matches;
    material.append(caption, passage);
    return material;
  }
  open(intent: 'ask' | 'explain', remember = true, replyId?: string): void | Promise<void> {
    if (remember) {
      this.engage();
      this.state.draftSource = chatSource(this.item);
      if (this.state.restored && [...this.state.drafts.values()].some(draft => draft.text)) this.rememberDraft();
    }
    this.show(true, intent === 'ask');
    if (replyId) return this.focusAnswer(replyId);
    if (intent === 'explain') {
      const prompt = this.item.hit.regionText === undefined
        ? label('Explain this passage.', '解释这段原文。') : label('Explain this screenshot.', '解释这张截图。');
      return this.ask({ mode: 'explain', prompt });
    }
  }
  private async focusAnswer(id: string): Promise<void> {
    await this.restore();
    if (this.events.signal.aborted) return;
    this.render();
    const answer = this.log.querySelector<HTMLElement>('[data-reply-id="' + CSS.escape(id) + '"]');
    if (answer) {
      answer.focus({ preventScroll: true });
      const question = answer.closest('.chat-turn')?.previousElementSibling;
      if (question) this.log.scrollTop += question.getBoundingClientRect().top - this.log.getBoundingClientRect().top;
      else answer.scrollIntoView({ block: 'nearest' });
    }
  }
  private show(open: boolean, focusInput = true): void {
    this.root.hidden = !open;
    byId('card').dataset.chatOpen = String(open);
    this.action.setAttribute('aria-expanded', String(open));
    if (!open) return;
    this.render();
    void this.restore().then(() => this.render(), error => toast(message(error)));
    if (focusInput) this.focusComposer();
    else this.log.focus({ preventScroll: true });
  }
  destroy(): void {
    this.events.abort();
    this.root.hidden = true;
    this.clearSelection();
    this.quoteBar.remove();
  }
  private focusComposer(): void { this.form.querySelector('textarea')?.focus({ preventScroll: true }); }
  private restore(): Promise<void> {
    return this.state.restored ??= (async () => {
      const thread = this.thread;
      if (!this.draftEdited && !this.state.pending && ![...this.state.drafts.values()].some(draft => draft.text)) {
        const saved = readQuestions(this.item.source.docId, thread);
        if (saved) {
          for (const [key, draft] of saved.drafts) this.state.drafts.set(key, draft);
          this.state.activeDraft = saved.drafts.some(([key]) => key === saved.active) ? saved.active : saved.drafts[0][0];
        }
      }
      const { exchanges } = await api('chat.history', { docId: this.item.source.docId, thread });
      if (this.state.turns.length) return;
      for (const entry of exchanges) {
        const quote = entry.answerQuote ? { turn: entry.answerTurn ?? 0, text: entry.answerQuote } : undefined;
        this.state.turns.push({ role: 'user', content: entry.question, quote, source: entry.source }, { role: 'assistant', content: entry.answer, source: entry.source, requestId: entry.requestId });
      }
    })().catch(error => { this.state.restored = undefined; throw error; });
  }
  private draft(): MessageDraft { return this.state.drafts.get(this.state.activeDraft)!; }
  private rememberDraft(): void {
    this.draftEdited = true;
    saveQuestions({ thread: this.thread, source: this.state.draftSource ?? chatSource(this.item) }, this.state.activeDraft, this.state.drafts);
  }

  private clearSelection(): void {
    if (!this.selected) return;
    this.selected = undefined;
    this.renderQuote();
  }
  private capture(): void {
    if (this.root.hidden || !this.root.isConnected) return;
    if (byId('card').dataset.workspace === 'note' || document.activeElement?.closest('.answer-notebook')) return;
    const selected = selectedAnswer(this.log);
    if (!selected) {
      this.clearSelection();
      return;
    }
    const { body, text } = selected, turn = Number(body.dataset.turn);
    if (this.selected?.text === text && this.selected.turn === turn) return;
    this.selected = { turn, text };
    this.draftExcerpt = undefined;
    this.renderQuote();
  }
  private useQuote(quote: AnswerQuote): void {
    const key = quoteKey(quote);
    if (!this.state.drafts.has(key)) this.state.drafts.set(key, { quote, text: '' });
    this.state.activeDraft = key;
    this.selected = undefined;
    this.draftExcerpt = undefined;
    document.getSelection()?.removeAllRanges();
    this.renderQuote();
    this.renderComposer();
    this.focusComposer();
  }
  renderQuote(): void {
    const live = this.selected, quote = live ?? this.draftExcerpt;
    for (const [turn, actions] of this.answerActions) actions.select(turn === live?.turn ? live.text : undefined);
    const version = JSON.stringify([quote, this.notes.acceptsExcerpt, this.notes.saving]);
    if (version === this.quoteVersion) return;
    this.quoteVersion = version;
    this.quoteBar.hidden = !quote;
    this.quoteBar.ariaDescription = quote?.text ?? null;
    this.quoteBar.replaceChildren();
    if (!quote) return;
    if (this.notes.acceptsExcerpt) {
      const send = button(label('Insert into note', '插入手写草稿'), () => {
        this.draftExcerpt = quote;
        this.root.dispatchEvent(new Event('edit-selection-note', { bubbles: true }));
        this.notes.insertExcerpt(quote.text);
      }, 'text-btn');
      send.disabled = this.notes.saving;
      this.quoteBar.append(send);
    }
    this.quoteBar.append(button(label('Ask follow-up', '针对选句追问'), () => this.useQuote(quote), 'text-btn'));
    this.answerActions.get(quote.turn)?.root.append(this.quoteBar);
  }
  refresh(): void {
    if (this.root.hidden) return;
    this.modelPicker.refresh();
    if (this.disconnected !== !questionConnected(this.app.state.settings)) this.render();
  }
  render(): void {
    if (this.root.hidden) return;
    this.disconnected = !questionConnected(this.app.state.settings);
    this.modelPicker.refresh();
    const { pending, failure } = this.state;
    for (const starter of this.starters.querySelectorAll('button')) starter.disabled = Boolean(pending || this.disconnected);
    this.connection.replaceChildren();
    this.connection.hidden = !this.disconnected && !failure;
    const connect = () => {
      byId<HTMLDialogElement>('dialog').addEventListener('close', () => this.refresh(), { once: true, signal: this.events.signal });
      settingsDialog(this.app);
    };
    if (this.disconnected) {
      this.connection.setAttribute('role', 'status');
      this.connection.append(el('span', '', label('Connect a model to chat about this selection.', '连接模型后即可提问。')), button(label('Connections', '连接设置'), connect, 'text-btn'));
    } else if (failure) {
      this.connection.setAttribute('role', 'alert');
      this.connection.append(el('span', '', failure.error), button(label('Retry', '重试'), () => this.ask(failure.request), 'text-btn'));
      if (!failure.request.savingNotes) this.connection.append(button(label('Connections', '连接设置'), connect, 'text-btn'));
    }
    this.renderLog();
    this.renderComposer();
    this.renderQuote();
  }
  private renderLog(): void {
    const { turns, pending } = this.state;
    if (this.renderedTurns === turns.length && this.pendingRow?.request === pending) return;
    const atEnd = this.log.scrollHeight - this.log.clientHeight - this.log.scrollTop < 24;
    const rowFor = (turn: Turn, index: number) => {
      const row = el('div', 'chat-turn ' + turn.role);
      row.append(el('span', 'speaker', turn.role === 'user' ? label('You', '我') : label('AI', 'AI 回答')));
      if (turn.quote) row.append(el('blockquote', 'answer-quote', turn.quote.text));
      if (turn.role === 'assistant') {
        const body = el('div', 'selection-answer selection-prose');
        body.dataset.turn = String(index);
        body.dataset.replyId = turn.requestId;
        body.tabIndex = -1;
        body.dir = 'auto';
        body.innerHTML = answerMarkdown(turn.content);
        let actions = this.answerActions.get(index);
        if (!actions) {
          actions = new AnswerNotebookAction(this.app, turn.source ?? chatSource(this.item), turn.content, turn.requestId!, 'discussion');
          this.answerActions.set(index, actions);
        }
        row.append(body, actions.root);
      } else {
        if (turn.source && this.earlierSources().length) row.append(this.sourceLink(turn.source));
        const text = el('p', '', turn.content);
        text.dir = 'auto';
        row.append(text);
      }
      return row;
    };
    if (this.pendingRow && this.pendingRow.request !== pending) {
      if (turns[this.renderedTurns]?.role === 'user' && turns[this.renderedTurns].content === this.pendingRow.request.prompt) {
        this.renderedTurns++;
      } else this.pendingRow.question.remove();
      this.pendingRow.wait.remove();
      this.pendingRow = undefined;
    }
    while (this.renderedTurns < turns.length) {
      const index = this.renderedTurns++;
      this.log.insertBefore(rowFor(turns[index], index), this.pendingRow?.question ?? null);
    }
    if (pending && !this.pendingRow) {
      const question = rowFor({ role: 'user', content: pending.prompt, quote: pending.quote,
        source: pending.item && chatSource(pending.item) }, turns.length);
      const wait = el('p', 'chat-wait', pending.streamText || label('Waiting for a reply…', '正在回答…'));
      wait.dir = 'auto';
      this.log.append(question, wait);
      this.pendingRow = { request: pending, question, wait };
    } else if (pending && this.pendingRow && pending.streamText) {
      this.pendingRow.wait.textContent = pending.streamText;
    }
    if (atEnd && !this.selected) this.log.scrollTop = this.log.scrollHeight;
  }
  private earlierSources(current = chatSource(this.item)): ChatSource[] {
    const sources = this.state.turns.flatMap(turn => turn.role === 'assistant' && turn.source ? [turn.source] : []);
    return previousDiscussionSources(sources, current);
  }

  private sourceLink(source: ChatSource): HTMLButtonElement {
    let caption = summary(source.selected);
    if (isScreenshotAnchor(source.anchor)) {
      const ordered = new Map<string, ChatSource>();
      for (const turn of this.state.turns) if (turn.source) ordered.set(materialKey(turn.source), turn.source);
      const current = chatSource(this.item);
      ordered.set(materialKey(current), current);
      const name = screenshotFigureLabel(source.label);
      const matching = [...ordered.values()].filter(entry => isScreenshotAnchor(entry.anchor) && screenshotFigureLabel(entry.label) === name);
      const index = matching.findIndex(entry => materialKey(entry) === materialKey(source)) + 1;
      caption = name && matching.length === 1 ? name : (name ? name + ' · ' : '') + label('Crop ', '选区 ') + index;
    }
    const link = button(caption, () => {
      const url = new URL(source.sourceUrl);
      const turn = this.state.turns.findLast(entry => entry.requestId && entry.source && materialKey(entry.source) === materialKey(source));
      if (turn?.requestId) url.searchParams.set('reply', turn.requestId);
      return this.app.openNotebookSource(url);
    }, 'text-btn material-source');
    link.title = label('View in paper', '查看原处') + ' · ' + source.label;
    return link;
  }
  private renderComposer(): void {
    const old = this.form.querySelector('textarea');
    const cursor = old && document.activeElement === old && !this.selected ? [old.selectionStart, old.selectionEnd] : undefined;
    const { activeDraft, drafts } = this.state, draft = this.draft();
    this.form.replaceChildren();
    const choices = [...drafts].filter(([key, other]) => key === 'paper' || key === activeDraft || other.text.trim());
    if (choices.length > 1) {
      const switcher = el('select', 'chat-drafts');
      switcher.ariaLabel = label('Question drafts', '提问草稿');
      for (const [key, other] of choices) {
        const answerNumber = Math.floor((other.quote?.turn ?? 0) / 2) + 1;
        const title = other.quote ? label('Answer ' + answerNumber, '第 ' + answerNumber + ' 条回答') + ' · ' + summary(other.quote.text) : label('Paper selection', '当前选段');
        const option = el('option', '', title + (key !== activeDraft && other.text.trim() ? label(' (draft)', '（草稿）') : ''));
        option.value = key;
        switcher.append(option);
      }
      switcher.value = activeDraft;
      switcher.onchange = () => { this.state.activeDraft = switcher.value; this.renderComposer(); this.focusComposer(); };
      this.form.append(switcher);
    }
    if (draft.quote) this.form.append(el('blockquote', 'answer-quote', draft.quote.text));
    const current = chatSource(this.item), previous = this.earlierSources(current);
    const following = this.state.turns.length > 0 || Boolean(this.state.pending);
    const canAddScreenshot = this.app.view?.beginRegion && following;
    if (canAddScreenshot || previous.length) {
      const material = el('div', 'followup-material');
      const unasked = previous.length > 0 && !this.state.turns.some(turn => turn.source && materialKey(turn.source) === materialKey(current));
      if (previous.length) {
        material.append(el('span', '', label('Using', '参考')), ...[...previous, current].map(source => this.sourceLink(source)));
        const last = this.state.turns.at(-1)?.source;
        const returnTo = this.previous ?? (last && unasked ? {source: last, thread: this.thread} : undefined);
        if (returnTo && (!last || materialKey(last) !== materialKey(current))) {
          const remove = button('', () => this.app.resumeDiscussion(returnTo), 'material-remove');
          remove.ariaLabel = remove.title = label('Remove this material', '移除刚加入的材料');
          remove.append(icon('close', 13)); material.append(remove);
        }
      }
      if (canAddScreenshot) {
        const caption = unasked ? label('Replace with a screenshot', '重新框选') : label('Add a screenshot', '再截一张');
        material.append(button(caption, () => this.app.addDiscussionScreenshot(), 'text-btn add-discussion-material', 'capture'));
      }
      this.form.append(material);
    }
    const input = el('textarea'), row = el('div', 'chat-input-row');
    input.rows = 2;
    input.maxLength = 16_000;
    input.ariaLabel = label('Message about this selection', '针对此选段提问');
    input.placeholder = draft.quote ? label('Ask about the quoted answer…', '针对选中的回答提问…') : this.state.turns.length
      ? label('Ask a follow-up…', '继续追问…') : this.item.hit.regionText !== undefined
      ? label('Ask about this screenshot…', '想问这张截图什么？') : label('Ask about this selection…', '想问这段原文什么？');
    input.value = draft.text;
    const submit = el('button', 'btn primary', label('Send', '发送'));
    submit.type = 'submit';
    if (this.item.hit.regionText !== undefined) activateAfterTouchDrag(submit);
    const enabled = () => { submit.disabled = Boolean(this.disconnected || this.state.pending || !input.value.trim()); };
    enabled();
    input.oninput = () => { draft.text = input.value; this.rememberDraft(); enabled(); };
    input.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!submit.disabled) this.form.requestSubmit();
      }
    };
    this.form.onsubmit = event => {
      event.preventDefault();
      if (!submit.disabled) void this.ask({ mode: 'followup', prompt: input.value.trim(), draftKey: activeDraft, quote: draft.quote });
    };
    row.append(input, submit);
    if (this.state.pending) {
      const stop = button(label('Stop', '停止'), () => { this.state.pending?.controller?.abort(); }, 'btn');
      row.append(stop);
    }
    this.form.append(row);
    if (cursor) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(cursor[0], cursor[1]);
    }
  }
  private async ask(request: Request): Promise<void> {
    const { state } = this;
    if (state.pending || !questionConnected(this.app.state.settings)) return;
    const questionModel = this.app.state.settings.questionModel ?? null;
    const item = request.item ??= this.item;
    const draft = request.draftKey ? state.drafts.get(request.draftKey) : undefined;
    if (draft?.text.trim() === request.prompt) draft.text = '';
    state.pending = request;
    state.failure = undefined;
    this.changed();
    try {
      if (!request.payload && request.mode !== 'translate') {
        if (this.notes.saving) request.savingNotes ??= this.notes;
        await request.savingNotes?.waitForSave();
        request.savingNotes = undefined;
      }
      const savedNotes = request.mode === 'translate' ? [] : this.app.state.notes;
      await this.restore();
      const history = state.turns.slice(-16).map(turn => ({
        role: turn.role,
        content: (turn.quote ? 'Quoted AI answer\n' + turn.quote.text + '\n\n' + turn.content : turn.content).slice(0, 48_000)
      }));
      const place = this.app.doc.kind === 'web' ? item.source.label || 'Article' : 'Page ' + item.source.page;
      const context = [item.source.title + ' · ' + place, item.context];
      if (item.hit.side === 'translation' && !item.context.includes(item.original)) context.push('Original passage\n' + item.original);
      request.side ??= item.hit.side;
      request.requestId ??= crypto.randomUUID();
      const prior = this.earlierSources(chatSource(item));
      if (prior.length > maxPreviousMaterials) throw Error(label('Start a separate question to use more material.', '这次讨论的材料已满，可从选区单独提问。'));
      const previousMaterial = request.payload || !prior.length ? undefined : await Promise.all(prior.map(async source => ({
        label: source.label, text: isScreenshotAnchor(source.anchor) ? source.context : source.selected,
        readerNotes: readerNoteTexts(notesForRecordedSource(savedNotes, source)),
        image: isScreenshotAnchor(source.anchor) ? await this.app.discussionScreenshot(source) : undefined
      })));
      const target = this.app.state.settings.targetLanguage || DEFAULT_TARGET_LANGUAGE;
      request.payload ??= { mode: request.mode, text: item.selection, context: context.join('\n\n'),
        ...(item.hit.regionText !== undefined && { image: item.hit.image, regionText: item.hit.regionText }),
        previousMaterial, readerNotes: readerNoteTexts(notesForSelection(savedNotes, item)),
        question: request.mode === 'followup' ? request.prompt : undefined, answerQuote: request.quote?.text, history,
        targetLanguage: request.mode === 'translate' && item.hit.side === 'translation' ? 'English' : target,
        record: { docId: item.source.docId, requestId: request.requestId, thread: this.thread,
          question: request.prompt, source: chatSource(item), answerQuote: request.quote?.text, answerTurn: request.quote?.turn } };
      const controller = request.controller = new AbortController();
      request.streamText = '';
      const reply = await apiStream('ai', { ...request.payload, questionModel }, delta => {
        request.streamText = (request.streamText ?? '') + delta;
        if (this.pendingRow?.request === request) {
          const atBottom = this.log.scrollHeight - this.log.clientHeight - this.log.scrollTop < 32;
          this.pendingRow.wait.textContent = request.streamText;
          if (atBottom) this.log.scrollTop = this.log.scrollHeight;
        }
      }, controller.signal);
      this.app.discussionChanged?.(item.source.docId);
      state.turns.push({ role: 'user', content: request.prompt, quote: request.quote, source: request.payload.record?.source },
        { role: 'assistant', content: reply.text, source: request.payload.record?.source, requestId: request.requestId });
      if (request.mode !== 'followup') (state.meanings ??= {})[selectionKey(item) + request.side] = reply.text;
      if (request.draftKey && request.quote && !draft?.text && state.activeDraft === request.draftKey) {
        state.drafts.delete(request.draftKey);
        state.activeDraft = 'paper';
      }
      void item.record?.(reply.text).catch(error => toast(message(error)));
    } catch (error) {
      if (request.controller?.signal.aborted) {
        if (draft && !draft.text) draft.text = request.prompt;
      } else {
        state.failure = { request, error: message(error) };
        if (draft && !draft.text) draft.text = request.prompt;
      }
    } finally {
      request.controller = undefined;
      state.pending = undefined;
      this.rememberDraft();
      this.changed();
    }
  }
}
