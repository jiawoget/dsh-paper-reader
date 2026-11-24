import type { ChatExchange, ChatRequest, ChatSource, DocumentInfo, WordRecord } from '../shared/types.js';
import { answerMarkdown, selectedAnswer } from './answer-markdown.js';
import { AnswerNotebookAction } from './answer-notebook.js';
import { screenshotFigureLabel } from './pdf/region-geometry.js';
import { isScreenshotAnchor, materialKey } from './selection-context.js';
import { paperQuestions, type DiscussionRef } from './discussion-drafts.js';
import { needsEnglishSearch, paperEvidence, readPaper } from './paper-evidence.js';
import { settingsDialog, sourceChip, type ReaderPort } from './panels.js';
import { questionConnected, questionModelButton } from './question-model.js';
import type { PdfDocument } from './pdf-view.js';
import { api, apiStream, button, el, icon, message, readerLabel as label } from './ui.js';

interface Conversation {
  draft: string; exchanges: ChatExchange[]; loaded: boolean; version: number;
  source?: ChatSource; pending?: ChatRequest; retry?: ChatRequest; issue?: string;
  controller?: AbortController; streamText?: string;
}

export class PaperChat {
  readonly root = el('section', 'paper-chat');
  private readonly toggle = el('button', 'paper-chat-toggle');
  private readonly detail = el('span', 'paper-chat-summary');
  private readonly content = el('div', 'paper-chat-content');
  private readonly log = el('div', 'paper-chat-log');
  private readonly notice = el('div', 'paper-chat-notice');
  private readonly drafts = el('details', 'paper-chat-drafts');
  private readonly attachment = el('div', 'paper-chat-attachment');
  private readonly modelPicker: ReturnType<typeof questionModelButton>;
  private readonly scope = el('span');
  private readonly sourceLocation = el('span');
  private readonly sourceQuote = el('q');
  private readonly useSelection = button(label('Use selected passage','带入选段'), () => this.setSource(this.selectionCandidate), 'text-btn');
  private readonly removeSelection = button('', () => this.setSource(undefined), 'icon-btn');
  private readonly input = el('textarea');
  private readonly submit = el('button', 'btn primary', label('Send','发送'));
  private readonly stop = el('button', 'btn', label('Stop','停止'));
  private pendingNode?: HTMLElement;
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
    this.root.ariaLabel = label('Paper chat','全文问答');
    this.toggle.type = 'button';
    this.toggle.ariaLabel = label('Paper chat','全文问答');
    this.toggle.setAttribute('aria-controls', 'paper-chat-content');
    this.content.id = 'paper-chat-content';
    this.toggle.append(icon('chat', 16), el('strong', '', this.toggle.ariaLabel), this.detail, icon('next', 14));
    this.toggle.onclick = () => {
      this.expanded = !this.expanded;
      localStorage.setItem('reader.paper-chat.open', String(this.expanded));
      this.render();
      if (this.expanded && this.doc) { void this.reload(this.doc.id); this.input.focus({ preventScroll: true }); }
    };
    this.log.setAttribute('role', 'log');
    this.log.ariaLabel = label('Paper chat history','全文问答记录');
    this.log.setAttribute('aria-live', 'polite');
    this.log.tabIndex = 0;
    document.addEventListener('selectionchange', () => {
      if (!this.expanded || document.activeElement?.closest('.answer-notebook')) return;
      const selected = selectedAnswer(this.log);
      const action = selected && this.noteActions.get(selected.body.dataset.exchangeId!);
      if (action !== this.excerptAction) this.excerptAction?.select();
      action?.select(selected?.text);
      this.excerptAction = action;
    });
    this.scope.id = 'paper-chat-scope';
    this.scope.setAttribute('role', 'status');
    this.sourceQuote.dir = 'auto';
    this.removeSelection.ariaLabel = this.removeSelection.title = label('Remove selected passage','移除选段');
    this.removeSelection.append(icon('close', 12));
    this.attachment.append(this.scope, this.sourceLocation, this.sourceQuote, this.removeSelection, this.useSelection, this.modelPicker.button);
    this.input.ariaLabel = label('Message about this paper','对这篇文章提问');
    this.input.setAttribute('aria-describedby', this.scope.id);
    this.input.placeholder = label('Ask about this paper…','对这篇文章提问…');
    this.input.rows = 1;
    this.input.maxLength = 16_000;
    this.submit.type = 'submit';
    this.stop.type = 'button';
    this.stop.hidden = true;
    this.stop.onclick = () => { this.current()?.controller?.abort(); };
    const form = el('form', 'paper-chat-form');
    const row = el('div', 'paper-chat-input');
    row.append(this.input, this.submit, this.stop);
    form.append(this.attachment, row);
    const history = el('div', 'paper-chat-transcript');
    history.append(this.log);
    this.content.append(this.drafts, history, this.notice, form);
    window.addEventListener('reader-question-drafts', event => {
      if (this.expanded && (event as CustomEvent<string>).detail === this.doc?.id) this.renderDrafts();
    });
    this.input.oninput = () => {
      const state = this.current();
      if (state) { state.draft = this.input.value; this.controls(state); }
    };
    this.input.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.submit.disabled) form.requestSubmit();
      }
    };
    form.onsubmit = event => { event.preventDefault(); if (!this.submit.disabled) void this.send(); };
    this.resize();
    this.root.append(this.grip, this.toggle, this.content);
    this.render();
  }
  document(doc: DocumentInfo, pdf?: PdfDocument): void {
    this.noteActions.clear();
    this.excerptAction = undefined;
    this.notebookRevision = undefined;
    this.doc = doc; this.pdf = pdf; this.pages = undefined; this.logVersion = '';
    this.toggle.ariaLabel = doc.book ? label('Section chat','本节问答') : label('Paper chat','全文问答');
    this.root.ariaLabel = this.toggle.ariaLabel;
    this.toggle.querySelector('strong')!.textContent = this.toggle.ariaLabel;
    this.input.ariaLabel = doc.book ? label('Message about this section','对这一节提问') : label('Message about this paper','对这篇文章提问');
    this.input.placeholder = doc.book ? label('Ask about this section…','对这一节提问…') : label('Ask about this paper…','对这篇文章提问…');
    this.selectionCandidate = undefined;
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
    state.source = source;
    this.render();
    this.input.focus({ preventScroll: true });
  }
  async reload(docId: string): Promise<void> {
    const state = this.conversations.get(docId);
    if (!state) return;
    const version = ++state.version;
    try {
      const { exchanges } = await api('chat.history', { docId });
      if (version !== state.version) return;
      state.exchanges = exchanges;
      state.loaded = true;
      if (!state.retry) state.issue = undefined;
    } catch (error) { if (version === state.version) state.issue = message(error); }
    if (docId === this.doc?.id) this.render();
  }
  private current(): Conversation | undefined { return this.doc && this.conversations.get(this.doc.id); }

  get readingPosition(): number | undefined { return this.expanded ? this.log.scrollTop : undefined; }
  restorePosition(scroll: number): void {
    this.expanded = true;
    localStorage.setItem('reader.paper-chat.open', 'true');
    this.render();
    this.log.scrollTop = scroll;
  }

  private async resume(ref: DiscussionRef, requestId?: string): Promise<void> {
    await this.app.resumeDiscussion(ref, requestId);
    this.expanded = false;
    localStorage.setItem('reader.paper-chat.open', 'false');
    this.render();
  }

  private renderDrafts(): void {
    const saved = this.doc ? paperQuestions(this.doc.id) : [];
    this.drafts.hidden = !saved.length;
    this.drafts.replaceChildren();
    if (!saved.length) return;
    this.drafts.append(el('summary', '', label('Unsent questions', '未发送的追问') + ' (' + saved.length + ')'));
    for (const entry of saved) {
      const question = (entry.drafts.find(([key]) => key === entry.active) ?? entry.drafts[0])[1].text;
      const caption = this.location(entry.source) + ' · ' + question;
      this.drafts.append(button(caption, () => this.resume(entry), 'text-btn'));
    }
  }

  async revealExchange(id: string): Promise<void> {
    const doc = this.doc, state = this.current();
    if (!doc || !state) return;
    await this.reload(doc.id);
    if (this.doc !== doc) return;
    const exchange = state.exchanges.find(turn => turn.requestId === id);
    if (!exchange) throw Error(state.issue || label('This discussion is unavailable in this paper.', '本篇论文中找不到这条问答。'));
    if (exchange.source && exchange.thread !== 'paper') {
      await this.resume({ source: exchange.source, thread: exchange.thread }, id);
      return;
    }
    this.expanded = true;
    localStorage.setItem('reader.paper-chat.open', 'true');
    this.render();
    const answer = this.log.querySelector<HTMLElement>('.paper-answer[data-exchange-id="' + CSS.escape(id) + '"]');
    if (!answer) throw Error(label('This discussion is unavailable in this paper.', '本篇论文中找不到这条问答。'));
    answer.scrollIntoView({ block: 'nearest' });
    answer.focus({ preventScroll: true });
  }
  private controls(state: Conversation): void {
    this.submit.disabled = Boolean(state.pending || !state.draft.trim() || !questionConnected(this.app.state.settings));
    this.stop.hidden = !state.pending;
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
    this.notice.replaceChildren();
    const disconnected = !questionConnected(this.app.state.settings);
    this.notice.hidden = !state.issue && !disconnected;
    if (!this.notice.hidden) {
      this.notice.setAttribute('role', state.issue ? 'alert' : 'status');
      this.notice.append(el('span', '', state.issue || label('Connect a model to chat about this paper.','请连接模型以使用全文问答。')));
      if (state.issue) this.notice.append(button(label('Retry','重试'), () => state.retry ? this.send(state.retry) : this.reload(this.doc!.id), 'text-btn'));
      this.notice.append(button(label('Connections','连接设置'), () => settingsDialog(this.app), 'text-btn'));
    }
  }
  private location(source: ChatSource): string {
    return this.doc?.kind === 'web' ? source.label || label('Article','文章') : label('p. ' + source.page,'第 ' + source.page + ' 页');
  }
  private renderLog(state: Conversation): void {
    const archive = this.app.state.history.filter(record => record.docId === this.doc?.id && record.meaning.trim() &&
      !state.exchanges.some(turn => turn.source?.anchor === record.anchor && turn.answer === record.meaning));
    const version = [this.doc?.id, state.loaded, state.exchanges.at(-1)?.requestId, archive.length, state.pending?.requestId].join('|');
    if (version === this.logVersion) return;
    const scroll = this.log.scrollTop, atBottom = this.log.scrollHeight - this.log.clientHeight - scroll < 24;
    this.logVersion = version;
    this.log.replaceChildren();
    if (archive.length) this.legacyLookups(archive);
    if (!state.exchanges.length && !state.pending) this.log.append(el('p', 'paper-chat-empty', state.loaded ? label('Ask a question about this paper.','向本文提问。') : label('Loading chat…','正在加载问答记录…')));
    const materials = new Map<string, Set<string>>();
    for (const {thread, source} of state.exchanges) {
      if (!source || thread === 'paper') continue;
      const sources = materials.get(thread) ?? new Set<string>();
      sources.add(materialKey(source));
      materials.set(thread, sources);
    }
    for (const exchange of state.exchanges) {
      this.question(exchange, exchange.thread !== 'paper');
      const row = el('div', 'paper-chat-reply'), answer = el('div', 'paper-answer selection-prose');
      answer.dir = 'auto';
      answer.dataset.exchangeId = exchange.requestId;
      answer.tabIndex = -1;
      answer.innerHTML = answerMarkdown(exchange.answer);
      row.append(el('span', 'paper-chat-speaker', 'AI'), answer);
      const coverage = exchange.coverage;
      if (coverage?.partial) row.append(el('small', 'paper-chat-evidence', this.doc?.book ? label('Based on a section of this book.','依据书中小节作答。') : label('Based on excerpts from ' + coverage.pagesUsed + ' of ' + coverage.pageCount + ' pages.','依据全篇 ' + coverage.pageCount + ' 页中的 ' + coverage.pagesUsed + ' 页摘录作答。')));
      let note = this.noteActions.get(exchange.requestId);
      if (!note) {
        const url = new URL('index.html', location.href);
        url.searchParams.set('doc', exchange.docId);
        url.searchParams.set('discussion', exchange.requestId);
        const origin = exchange.thread !== 'paper' && exchange.source ? exchange.source : { docId: exchange.docId, sourceUrl: url.href };
        note = new AnswerNotebookAction(this.app, origin, exchange.answer, exchange.requestId, 'archive');
        this.noteActions.set(exchange.requestId, note);
      }
      const actions = el('div', 'paper-reply-actions');
      actions.append(note.root);
      if (exchange.thread !== 'paper' && exchange.source) {
        const source = exchange.source;
        const caption = materials.get(exchange.thread)!.size > 1 ? label('Continue this discussion', '继续这次讨论') :
          isScreenshotAnchor(exchange.source.anchor) ? label('Continue with this screenshot', '继续问这张截图') :
          label('Continue with this passage', '继续问这段原文');
        actions.append(button(caption, () => this.resume({source, thread: exchange.thread}), 'text-btn resume-discussion'));
      }
      row.append(actions);
      this.log.append(row);
    }
    this.pendingNode = undefined;
    if (state.pending) {
      this.question(state.pending, false);
      const wait = el('p', 'paper-chat-empty', state.streamText || label('Reading the paper…', '正在阅读论文…'));
      wait.dir = 'auto';
      this.pendingNode = wait;
      this.log.append(wait);
    }
    this.log.scrollTop = atBottom ? this.log.scrollHeight : scroll;
  }
  private question(turn: ChatRequest, passageThread: boolean): void {
    const row = el('div', 'paper-chat-question'), header = el('div', 'paper-chat-origin');
    header.append(el('span', 'paper-chat-speaker', label('You','我')));
    if (turn.source) {
      const source = turn.source;
      const kind = isScreenshotAnchor(source.anchor) ? screenshotFigureLabel(source.label) ?? label('Screenshot','截图') : passageThread ? label('Selection chat','选段讨论') : label('Selected passage','所选原文');
      const sourceUrl = new URL(source.sourceUrl);
      if (passageThread) sourceUrl.searchParams.set('reply',turn.requestId);
      const chip = sourceChip(this.app, { ...source, sourceUrl:sourceUrl.href, label: kind,
        context: source.side === 'translation' ? source.selected : undefined }, source.original);
      chip.title = source.selected;
      header.append(chip);
    }
    row.append(header);
    if (turn.answerQuote) row.append(el('blockquote', 'paper-chat-quote', turn.answerQuote));
    const question = el('p', '', turn.question); question.dir = 'auto';
    row.append(question); this.log.append(row);
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
    const controller = state.controller = new AbortController();
    state.streamText = '';
    state.pending = request; state.issue = undefined; state.retry = undefined;
    this.render();
    try {
      const pages = await (this.pages ??= readPaper(doc, this.pdf).catch(error => {
        if (doc === this.doc) this.pages = undefined;
        throw error;
      }));
      const expansion = needsEnglishSearch(pages, request.question)
        ? await api('chat.searchTerms', { question: request.question, questionModel }).then(reply => reply.text, () => '') : '';
      const query = [request.question, expansion, request.source?.selected, request.source?.original, ...state.exchanges.slice(-2).map(turn => turn.question)].join(' ');
      const section = doc.sectionPage && doc.book?.sections[doc.sectionPage-1];
      const paper = paperEvidence(section ? doc.title + ' · ' + section.title : doc.paperTitle || doc.title, pages, query);
      if (doc.book) { paper.partial = true; paper.pageCount = doc.book.sections.length; }
      const { text } = await apiStream('chat.ask', { ...request, paper, questionModel }, delta => {
        state.streamText = (state.streamText ?? '') + delta;
        if (this.doc === doc && this.pendingNode) {
          const atBottom = this.log.scrollHeight - this.log.clientHeight - this.log.scrollTop < 32;
          this.pendingNode.textContent = state.streamText;
          if (atBottom) this.log.scrollTop = this.log.scrollHeight;
        }
      }, controller.signal);
      if (!state.exchanges.some(turn => turn.requestId === request.requestId)) {
        state.exchanges.push({ ...request, thread: 'paper', answer: text, createdAt: new Date().toISOString() });
      }
      if (state.draft.trim() === request.question) state.draft = '';
      if (state.source === request.source) state.source = undefined;
      await this.reload(doc.id);
    } catch (error) {
      if (!controller.signal.aborted) { state.issue = message(error); state.retry = request; }
    } finally {
      state.controller = undefined;
      state.streamText = undefined;
      state.pending = undefined;
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
