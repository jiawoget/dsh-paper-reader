import type { ChatExchange, ChatRequest, ChatSource, DocumentInfo, WordRecord } from '../shared/types.js';
import { selectedAnswer } from './answer-markdown.js';
import { AnswerNotebookAction } from './answer-notebook.js';
import {
  bindChatComposer, createChatLog, createClearChatControl, createSendStopPair, createStreamSlot,
  renderAnswerRow, renderChatNotice, renderQuestionRow, renderStoppedReply, settleStreamFailure
} from './chat-stream.js';
import { screenshotFigureLabel } from './pdf/region-geometry.js';
import { isScreenshotAnchor, materialKey } from './selection-context.js';
import { paperQuestions, type DiscussionRef } from './discussion-drafts.js';
import { needsEnglishSearch, paperEvidence, readPaper } from './paper-evidence.js';
import { sourceChip } from './notes-panel.js';
import { settingsDialog } from './settings-dialog.js';
import { questionConnected, questionModelButton } from './question-model.js';
import type { PdfDocument } from './pdf-view.js';
import { api, apiStream, button, el, icon, message, readerLabel as label, toast, type ReaderPort } from './ui.js';

interface Conversation {
  draft: string; exchanges: ChatExchange[]; loaded: boolean; version: number;
  source?: ChatSource; pending?: ChatRequest; retry?: ChatRequest; issue?: string;
  stopped?: { request: ChatRequest; answer: string };
  controller?: AbortController; streamText?: string;
}

export class PaperChat {
  readonly root = el('section', 'paper-chat');
  private readonly toggle = el('button', 'paper-chat-toggle');
  private readonly detail = el('span', 'paper-chat-summary');
  private readonly content = el('div', 'paper-chat-content');
  private readonly log = createChatLog('paper-chat-log', label('Paper chat history','全文问答记录'), p => { void this.app.navigate(this.app.doc.id, p).catch(e => toast(message(e))); });
  private readonly stream = createStreamSlot(this.log, () => this.app.pageCount);
  private readonly notice = el('div', 'paper-chat-notice');
  private readonly drafts = el('details', 'paper-chat-drafts');
  private readonly attachment = el('div', 'paper-chat-attachment');
  private readonly modelPicker: ReturnType<typeof questionModelButton>;
  private readonly clearChat: ReturnType<typeof createClearChatControl>;
  private readonly scope = el('span');
  private readonly sourceLocation = el('span');
  private readonly sourceQuote = el('q');
  private readonly useSelection = button(label('Use selected passage','带入选段'), () => this.setSource(this.selectionCandidate), 'text-btn');
  private readonly removeSelection = button('', () => this.setSource(undefined), 'icon-btn');
  private readonly input = el('textarea');
  private readonly sendStop: ReturnType<typeof createSendStopPair>;
  private readonly grip = el('div', 'paper-chat-grip');
  private readonly conversations = new Map<string, Conversation>();
  private readonly noteActions = new Map<string, AnswerNotebookAction>();
  private excerptAction?: AnswerNotebookAction;
  private notebookRevision?: string;
  private doc?: DocumentInfo;
  private pdf?: PdfDocument;
  private pages?: ReturnType<typeof readPaper>;
  private selectionCandidate?: ChatSource;
  private expanded = localStorage.getItem('reader.paper-chat.open') === 'true';
  private logVersion = '';
  private ratio = Number(localStorage.getItem('reader.paper-chat.ratio')) || 0.36;

  constructor(private app: ReaderPort) {
    this.modelPicker = questionModelButton(app);
    this.clearChat = createClearChatControl(() => this.clearPaperChat());
    this.sendStop = createSendStopPair(() => { this.current()?.controller?.abort(); });
    this.root.ariaLabel = label('Paper chat','全文问答');
    this.toggle.type = 'button';
    this.toggle.ariaLabel = label('Paper chat','全文问答');
    this.toggle.setAttribute('aria-controls', 'paper-chat-content');
    this.content.id = 'paper-chat-content';
    this.toggle.append(icon('chat', 16), el('strong', '', this.toggle.ariaLabel), this.detail, icon('next', 14));
    this.toggle.onclick = () => {
      this.setOpen(!this.expanded);
      if (this.expanded && this.doc) { void this.reload(this.doc.id); this.input.focus({ preventScroll: true }); }
    };
    document.addEventListener('selectionchange', () => {
      if (!this.expanded || document.activeElement?.closest('.answer-notebook')) return;
      const selected = selectedAnswer(this.log), action = selected && this.noteActions.get(selected.body.dataset.exchangeId!);
      if (action !== this.excerptAction) this.excerptAction?.select();
      action?.select(selected?.text);
      this.excerptAction = action;
    });
    this.scope.id = 'paper-chat-scope'; this.scope.setAttribute('role', 'status'); this.sourceQuote.dir = 'auto';
    this.removeSelection.ariaLabel = this.removeSelection.title = label('Remove selected passage','移除选段');
    this.removeSelection.append(icon('close', 12));
    this.attachment.append(this.scope, this.sourceLocation, this.sourceQuote, this.removeSelection, this.useSelection, this.clearChat.root, this.modelPicker.button);
    this.input.ariaLabel = label('Message about this paper','对这篇文章提问');
    this.input.setAttribute('aria-describedby', this.scope.id);
    this.input.placeholder = label('Ask about this paper…','对这篇文章提问…');
    this.input.rows = 1; this.input.maxLength = 16_000;
    const form = el('form', 'paper-chat-form'), row = el('div', 'paper-chat-input'), history = el('div', 'paper-chat-transcript');
    row.append(this.input, this.sendStop.send, this.sendStop.stop);
    form.append(this.attachment, row);
    history.append(this.log);
    this.content.append(this.drafts, history, this.notice, form);
    window.addEventListener('reader-question-drafts', event => {
      if (this.expanded && (event as CustomEvent<string>).detail === this.doc?.id) this.renderDrafts();
    });
    this.input.oninput = () => { const state = this.current(); if (state) { state.draft = this.input.value; this.controls(state); } };
    bindChatComposer(this.input, form, () => !this.sendStop.send.disabled);
    form.onsubmit = event => { event.preventDefault(); if (!this.sendStop.send.disabled) void this.send(); };
    this.resize();
    this.root.append(this.grip, this.toggle, this.content);
    this.render();
  }
  private setOpen(open: boolean): void {
    this.expanded = open;
    localStorage.setItem('reader.paper-chat.open', String(open));
    this.render();
  }
  document(doc: DocumentInfo, pdf?: PdfDocument): void {
    this.stream.cancel(); this.clearChat.reset(); this.noteActions.clear();
    this.excerptAction = this.notebookRevision = this.pages = this.selectionCandidate = undefined;
    this.doc = doc; this.pdf = pdf; this.logVersion = '';
    this.root.ariaLabel = this.toggle.ariaLabel = doc.book ? label('Section chat','本节问答') : label('Paper chat','全文问答');
    this.toggle.querySelector('strong')!.textContent = this.toggle.ariaLabel;
    this.input.ariaLabel = doc.book ? label('Message about this section','对这一节提问') : label('Message about this paper','对这篇文章提问');
    this.input.placeholder = doc.book ? label('Ask about this section…','对这一节提问…') : label('Ask about this paper…','对这篇文章提问…');
    if (!this.conversations.has(doc.id)) this.conversations.set(doc.id, { draft: '', exchanges: [], loaded: false, version: 0 });
    this.render();
    if (this.expanded) void this.reload(doc.id);
  }
  selected(source?: ChatSource): void {
    if (source && source.docId !== this.doc?.id) return;
    this.selectionCandidate = source;
    const state = this.current();
    if (source && state?.source?.sourceUrl === source.sourceUrl && !state.pending) state.source = source;
    this.render();
  }
  private setSource(source?: ChatSource): void {
    const state = this.current();
    if (!state) return;
    state.source = source; this.render(); this.input.focus({ preventScroll: true });
  }
  async reload(docId: string): Promise<void> {
    const state = this.conversations.get(docId);
    if (!state) return;
    const version = ++state.version;
    try {
      const { exchanges } = await api('chat.history', { docId });
      if (version !== state.version) return;
      state.exchanges = exchanges; state.loaded = true;
      if (!state.retry) state.issue = undefined;
    } catch (error) { if (version === state.version) state.issue = message(error); }
    if (docId === this.doc?.id) this.render();
  }
  private current(): Conversation | undefined { return this.doc && this.conversations.get(this.doc.id); }
  get readingPosition(): number | undefined { return this.expanded ? this.log.scrollTop : undefined; }
  restorePosition(scroll: number): void { this.setOpen(true); this.log.scrollTop = scroll; }
  private async resume(ref: DiscussionRef, requestId?: string): Promise<void> {
    await this.app.resumeDiscussion(ref, requestId);
    this.setOpen(false);
  }
  private renderDrafts(): void {
    const saved = this.doc ? paperQuestions(this.doc.id) : [];
    this.drafts.hidden = !saved.length;
    this.drafts.replaceChildren();
    if (!saved.length) return;
    this.drafts.append(el('summary', '', label('Unsent questions', '未发送的追问') + ' (' + saved.length + ')'));
    for (const entry of saved) {
      const question = (entry.drafts.find(([key]) => key === entry.active) ?? entry.drafts[0])[1].text;
      this.drafts.append(button(this.location(entry.source) + ' · ' + question, () => this.resume(entry), 'text-btn'));
    }
  }
  async revealExchange(id: string): Promise<void> {
    const doc = this.doc, state = this.current();
    if (!doc || !state) return;
    await this.reload(doc.id);
    if (this.doc !== doc) return;
    const exchange = state.exchanges.find(turn => turn.requestId === id);
    if (!exchange) throw Error(state.issue || label('This discussion is unavailable in this paper.', '本篇论文中找不到这条问答。'));
    if (exchange.source && exchange.thread !== 'paper') { await this.resume({ source: exchange.source, thread: exchange.thread }, id); return; }
    this.setOpen(true);
    const answer = this.log.querySelector<HTMLElement>('.paper-answer[data-exchange-id="' + CSS.escape(id) + '"]');
    if (!answer) throw Error(label('This discussion is unavailable in this paper.', '本篇论文中找不到这条问答。'));
    answer.scrollIntoView({ block: 'nearest' }); answer.focus({ preventScroll: true });
  }
  private controls(state: Conversation): void {
    this.sendStop.sync(Boolean(state.pending), Boolean(state.draft.trim() && questionConnected(this.app.state.settings)));
  }
  render(): void {
    const state = this.current();
    this.root.dataset.open = String(this.expanded);
    this.toggle.disabled = !this.doc;
    this.toggle.setAttribute('aria-expanded', String(this.expanded));
    this.content.hidden = !this.expanded;
    this.grip.hidden = !this.expanded;
    this.detail.textContent = state?.source ? label('Selection · ','选段 · ') + this.location(state.source) : state?.exchanges.length
      ? state.exchanges.length + label(state.exchanges.length === 1 ? ' exchange' : ' exchanges',' 轮问答') : '';
    if (!this.expanded || !state) return;
    this.modelPicker.refresh();
    this.clearChat.sync(Boolean(state.exchanges.some(e => e.thread === 'paper') || state.stopped), Boolean(state.pending));
    this.renderDrafts();
    if (this.input.value !== state.draft) this.input.value = state.draft;
    this.controls(state);
    this.renderLog(state);
    if (this.notebookRevision !== this.app.notebook?.revision) {
      this.notebookRevision = this.app.notebook?.revision;
      for (const action of this.noteActions.values()) action.refresh();
    }
    const source = state.source;
    const scope = source ? label('Selected passage','当前选段') : this.doc?.book ? label('Current section','当前小节') : label('Whole paper','全文');
    if (this.scope.textContent !== scope) this.scope.textContent = scope;
    this.sourceLocation.hidden = this.sourceQuote.hidden = this.removeSelection.hidden = !source;
    this.useSelection.hidden = Boolean(source || !this.selectionCandidate);
    this.sourceLocation.textContent = source ? this.location(source) : '';
    this.sourceQuote.textContent = this.sourceQuote.title = source?.selected ?? '';
    renderChatNotice(this.notice, {
      disconnected: !questionConnected(this.app.state.settings),
      disconnectedText: label('Connect a model to chat about this paper.','请连接模型以使用全文问答。'),
      error: state.issue,
      onRetry: state.issue ? () => state.retry ? this.send(state.retry) : this.reload(this.doc!.id) : undefined,
      onConnect: () => settingsDialog(this.app)
    });
  }
  private location(source: ChatSource): string {
    return this.doc?.kind === 'web' ? source.label || label('Article','文章') : label('p. ' + source.page,'第 ' + source.page + ' 页');
  }
  private renderLog(state: Conversation): void {
    const archive = this.app.state.history.filter(record => record.docId === this.doc?.id && record.meaning.trim() &&
      !state.exchanges.some(turn => turn.source?.anchor === record.anchor && turn.answer === record.meaning));
    const version = [this.doc?.id, state.loaded, state.exchanges.map(e => e.requestId).join(','), archive.length,
      state.pending?.requestId, state.stopped?.request.requestId, state.stopped?.answer.length].join('|');
    if (version === this.logVersion) return;
    const scroll = this.log.scrollTop, atBottom = this.log.scrollHeight - this.log.clientHeight - scroll < 24;
    this.logVersion = version;
    this.stream.cancel();
    this.log.replaceChildren();
    if (archive.length) this.legacyLookups(archive);
    if (!state.exchanges.length && !state.pending && !state.stopped)
      this.log.append(el('p', 'paper-chat-empty', state.loaded ? label('Ask a question about this paper.','向本文提问。') : label('Loading chat…','正在加载问答记录…')));
    const materials = new Map<string, Set<string>>();
    for (const {thread, source} of state.exchanges) {
      if (!source || thread === 'paper') continue;
      (materials.get(thread) ?? materials.set(thread, new Set()).get(thread)!).add(materialKey(source));
    }
    for (const exchange of state.exchanges) {
      this.question(exchange, exchange.thread !== 'paper');
      const coverage = exchange.coverage;
      const evidence = coverage?.partial ? el('small', 'paper-chat-evidence', this.doc?.book
        ? label('Based on a section of this book.','依据书中小节作答。')
        : label('Based on excerpts from ' + coverage.pagesUsed + ' of ' + coverage.pageCount + ' pages.','依据全篇 ' + coverage.pageCount + ' 页中的 ' + coverage.pagesUsed + ' 页摘录作答。')) : undefined;
      let note = this.noteActions.get(exchange.requestId);
      if (!note) {
        const url = new URL('index.html', location.href);
        url.searchParams.set('doc', exchange.docId); url.searchParams.set('discussion', exchange.requestId);
        const origin = exchange.thread !== 'paper' && exchange.source ? exchange.source : { docId: exchange.docId, sourceUrl: url.href };
        this.noteActions.set(exchange.requestId, note = new AnswerNotebookAction(this.app, origin, exchange.answer, exchange.requestId, 'archive'));
      }
      const actions: HTMLElement[] = [note.root];
      if (exchange.thread !== 'paper' && exchange.source) {
        const source = exchange.source;
        const caption = materials.get(exchange.thread)!.size > 1 ? label('Continue this discussion', '继续这次讨论') :
          isScreenshotAnchor(source.anchor) ? label('Continue with this screenshot', '继续问这张截图') : label('Continue with this passage', '继续问这段原文');
        actions.push(button(caption, () => this.resume({ source, thread: exchange.thread }), 'text-btn resume-discussion'));
      }
      this.log.append(renderAnswerRow({
        rowClass: 'paper-chat-reply', speakerClass: 'paper-chat-speaker', speakerText: 'AI',
        bodyClass: 'paper-answer selection-prose', actionsClass: 'paper-reply-actions', content: exchange.answer, maxPage: this.app.pageCount,
        dataset: { exchangeId: exchange.requestId }, beforeActions: evidence, actions,
        onDelete: () => this.deleteExchange(exchange.requestId)
      }));
    }
    if (state.stopped && !state.pending) {
      const stopped = state.stopped;
      this.question(stopped.request, false);
      this.log.append(renderStoppedReply({
        rowClass: 'paper-chat-reply', speakerClass: 'paper-chat-speaker', speakerText: 'AI', answer: stopped.answer, maxPage: this.app.pageCount,
        onRetry: () => this.send({ ...stopped.request, requestId: crypto.randomUUID() }),
        onDelete: () => { state.stopped = undefined; this.render(); }
      }));
    }
    if (state.pending) {
      this.question(state.pending, false);
      this.log.append(this.stream.mount({ rowClass: 'paper-chat-reply', speakerClass: 'paper-chat-speaker', speakerText: 'AI', waitingText: label('Reading the paper…', '正在阅读论文…'), streamText: state.streamText }));
    }
    this.log.scrollTop = atBottom ? this.log.scrollHeight : scroll;
  }
  private async deleteExchange(requestId: string): Promise<void> {
    const doc = this.doc, state = this.current();
    if (!doc || !state) return;
    const removed = state.exchanges.find(turn => turn.requestId === requestId);
    await api('chat.delete', { docId: doc.id, requestId });
    state.exchanges = state.exchanges.filter(turn => turn.requestId !== requestId);
    this.noteActions.delete(requestId); this.logVersion = '';
    if (removed && removed.thread !== 'paper') this.app.exchangeDeleted?.(removed.thread, requestId);
    if (this.doc === doc) this.render();
  }
  private async clearPaperChat(): Promise<void> {
    const doc = this.doc, state = this.current();
    if (!doc || !state) return;
    await api('chat.delete', { docId: doc.id, thread: 'paper' });
    for (const turn of state.exchanges) if (turn.thread === 'paper') this.noteActions.delete(turn.requestId);
    state.exchanges = state.exchanges.filter(turn => turn.thread !== 'paper');
    state.stopped = state.retry = state.issue = undefined; this.logVersion = '';
    if (this.doc === doc) this.render();
    void this.reload(doc.id);
  }
  private question(turn: ChatRequest, passageThread: boolean): void {
    let chip: HTMLElement | undefined;
    if (turn.source) {
      const source = turn.source;
      const kind = isScreenshotAnchor(source.anchor) ? screenshotFigureLabel(source.label) ?? label('Screenshot','截图') : passageThread ? label('Selection chat','选段讨论') : label('Selected passage','所选原文');
      const sourceUrl = new URL(source.sourceUrl);
      if (passageThread) sourceUrl.searchParams.set('reply',turn.requestId);
      chip = sourceChip(this.app, { ...source, sourceUrl:sourceUrl.href, label: kind,
        context: source.side === 'translation' ? source.selected : undefined }, source.original);
      chip.title = source.selected;
    }
    this.log.append(renderQuestionRow({
      rowClass: 'paper-chat-question', speakerClass: 'paper-chat-speaker', headerClass: 'paper-chat-origin',
      quoteClass: 'paper-chat-quote', text: turn.question, quote: turn.answerQuote, source: chip
    }));
  }
  private legacyLookups(records: WordRecord[]): void {
    const previous = el('details', 'paper-chat-lookups');
    previous.append(el('summary', '', label('Previous lookups (' + records.length + ')','历史查询（' + records.length + '）')));
    previous.addEventListener('toggle', () => {
      if (!previous.open || previous.children.length > 1) return;
      for (const record of records) {
        const entry = el('div');
        entry.append(sourceChip(this.app, record, record.text), el('strong', '', record.text), el('p', '', record.meaning));
        previous.append(entry);
      }
    });
    this.log.append(previous);
  }
  private async send(retry?: ChatRequest): Promise<void> {
    const state = this.current(), doc = this.doc;
    if (!doc || !state || state.pending || !questionConnected(this.app.state.settings)) return;
    const questionModel = this.app.state.settings.questionModel ?? null;
    const question = state.draft.trim();
    const same = state.retry?.question === question && state.retry.source === state.source;
    const request = retry ?? (same ? state.retry : undefined) ?? { docId: doc.id, requestId: crypto.randomUUID(), question, source: state.source };
    if (!request.question) return;
    const clearedDraft = !retry && state.draft.trim() === request.question ? state.draft : undefined;
    if (clearedDraft !== undefined) { state.draft = ''; this.input.value = ''; }
    const controller = state.controller = new AbortController();
    state.streamText = ''; state.stopped = state.issue = state.retry = undefined; state.pending = request;
    this.clearChat.reset(); this.render();
    try {
      const pages = await (this.pages ??= readPaper(doc, this.pdf).catch(error => { if (doc === this.doc) this.pages = undefined; throw error; }));
      const expansion = needsEnglishSearch(pages, request.question)
        ? await api('chat.searchTerms', { question: request.question, questionModel }).then(reply => reply.text, () => '') : '';
      const query = [request.question, expansion, request.source?.selected, request.source?.original, ...state.exchanges.slice(-2).map(turn => turn.question)].join(' ');
      const section = doc.sectionPage && doc.book?.sections[doc.sectionPage-1];
      const paper = paperEvidence(section ? doc.title + ' · ' + section.title : doc.paperTitle || doc.title, pages, query);
      if (doc.book) { paper.partial = true; paper.pageCount = doc.book.sections.length; }
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { text } = await apiStream('chat.ask', { ...request, paper, questionModel }, delta => {
        state.streamText = (state.streamText ?? '') + delta;
        if (this.doc === doc) this.stream.push(state.streamText);
      }, controller.signal);
      if (this.doc === doc) this.stream.finish();
      if (!state.exchanges.some(turn => turn.requestId === request.requestId))
        state.exchanges.push({ ...request, thread: 'paper', answer: text, createdAt: new Date().toISOString() });
      if (state.source === request.source) state.source = undefined;
      await this.reload(doc.id);
    } catch (error) {
      if (this.doc === doc) this.stream.finish();
      settleStreamFailure({
        aborted: controller.signal.aborted, streamText: state.streamText,
        restoreDraft: () => { if (clearedDraft !== undefined && !state.draft) state.draft = clearedDraft; },
        onStopped: answer => { state.stopped = { request, answer }; },
        onError: () => { state.issue = message(error); state.retry = request; }
      });
    } finally {
      state.controller = state.streamText = state.pending = undefined;
      if (this.doc === doc) this.render();
    }
  }
  private resize(): void {
    const grip = this.grip;
    grip.tabIndex = 0; grip.setAttribute('role', 'separator');
    grip.ariaLabel = label('Resize paper chat','调整全文问答高度'); grip.setAttribute('aria-orientation', 'horizontal');
    grip.setAttribute('aria-valuemin', '20'); grip.setAttribute('aria-valuemax', '72');
    const apply = (value: number, persist: boolean) => {
      this.ratio = Math.min(0.72, Math.max(0.2, value));
      const percent = Math.round(this.ratio * 100);
      this.root.style.setProperty('--chat-height', percent + 'dvh');
      grip.setAttribute('aria-valuenow', String(percent));
      if (persist) localStorage.setItem('reader.paper-chat.ratio', String(this.ratio));
    };
    apply(this.ratio, false);
    window.addEventListener('reader-layout-reset', () => apply(0.36, true));
    grip.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); grip.setPointerCapture(event.pointerId);
      const origin = event.clientY, height = this.root.getBoundingClientRect().height;
      grip.onpointermove = next => apply((height + origin - next.clientY) / window.innerHeight, false);
      grip.onlostpointercapture = () => { grip.onpointermove = null; apply(this.ratio, true); };
    };
    grip.onkeydown = event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); apply(this.ratio + (event.key === 'ArrowUp' ? 0.04 : -0.04), true);
      }
    };
  }
}
