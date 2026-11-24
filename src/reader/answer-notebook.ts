import type { ChatSource } from '../shared/types.js';
import { goToNoteChapter, type NotebookInsertion } from './notebook.js';
import { paperNotebook, type ReaderPort } from './panels.js';
import { screenshotFigureLabel } from './pdf/region-geometry.js';
import { isScreenshotAnchor } from './selection-context.js';
import { markdownPassageLabel } from './passage-links.js';
import { button, el, message, readerLabel as label } from './ui.js';

interface SaveState {
  entries: Map<string, NotebookInsertion>;
  views: Map<'discussion'|'archive', AnswerNotebookAction>;
  last?: string;
  busy: boolean;
  error: string;
  retry?: { text: string; entry?: NotebookInsertion };
  undoFailed: boolean;
}
const answers = new WeakMap<ReaderPort, Map<string, SaveState>>();

export class AnswerNotebookAction {
  readonly root = el('div', 'answer-notebook');
  private readonly add = el('button', 'text-btn');
  private readonly feedback = el('span', 'answer-notebook-status');
  private readonly undo = button(label('Undo', '撤销'), () => this.remove(), 'text-btn');
  private readonly view = button(label('View', '查看'), () => this.entry()?.reveal(), 'text-btn');
  private excerpt?: string;
  private state: SaveState;

  constructor(private app: ReaderPort, private source: ChatSource | Pick<ChatSource,'docId'|'sourceUrl'>, private answer: string,
    private requestId: string, surface: 'discussion'|'archive') {
    const book = answers.get(app) ?? new Map<string, SaveState>();
    answers.set(app, book);
    this.state = book.get(requestId) ?? { entries: new Map(), views: new Map(), busy: false, error: '', undoFailed: false };
    book.set(requestId, this.state);
    this.state.views.set(surface, this);
    this.add.type = 'button';
    this.add.onclick = () => void this.save();
    this.feedback.setAttribute('role', 'status');
    this.root.addEventListener('mousedown', event => {
      if (event.target instanceof Element && event.target.closest('button')) event.preventDefault();
    });
    this.root.append(this.add, this.feedback, this.undo, this.view);
    this.restoreSaved(); this.render();
  }

  private get text(): string { return this.excerpt || this.answer; }
  private entry(): NotebookInsertion | undefined { return this.state.entries.get(this.text) ?? this.state.entries.get(this.state.last ?? ''); }
  private restoreSaved(): void {
    for (const [text, entry] of this.state.entries) if (!entry.mounted()) this.state.entries.delete(text);
    if (this.state.entries.has(this.text) || !this.app.notebook?.markdown.includes(this.requestId)) return;
    const saved = paperNotebook(this.app)?.savedAnswer(this.requestId, this.text);
    if (saved) this.state.entries.set(this.text, saved);
  }
  private updateViews(): void { for (const view of this.state.views.values()) view.render(); }
  select(text?: string): void {
    if (text === this.excerpt) return;
    this.excerpt = text;
    this.restoreSaved(); this.render();
  }
  refresh(): void { this.restoreSaved(); this.render(); }
  private render(): void {
    const { entries, error, busy, undoFailed } = this.state, entry = this.entry();
    this.add.hidden = entries.has(this.text) && !error || undoFailed;
    this.add.disabled = this.undo.disabled = busy;
    this.add.textContent = error && !undoFailed ? label('Retry', '重试') :
      this.excerpt ? label('Save selection', '记下选句') : label('Add to Notes', '记入笔记');
    this.feedback.textContent = busy ? label('Saving…', '保存中…') : error ||
      (entry ? label('Added', '已记入') : '');
    this.feedback.hidden = !this.feedback.textContent;
    this.undo.hidden = this.view.hidden = !entry;
  }
  private async save(): Promise<void> {
    const state = this.state;
    if (state.busy) return;
    state.busy = true;
    const attempt = state.retry ?? { text: this.text };
    state.error = '';
    this.updateViews();
    try {
      if (!attempt.entry) {
        await goToNoteChapter(this.app, this.source);
        const editor = paperNotebook(this.app);
        if (!editor) throw Error(label('Open Notes and try again.', '请打开本篇笔记后重试。'));
        let citation = label('Paper chat', '全文问答');
        if ('selected' in this.source) {
          const caption = isScreenshotAnchor(this.source.anchor)
            ? screenshotFigureLabel(this.source.label) ?? label('Screenshot', '截图选区') : this.source.selected;
          const place = this.app.doc.book?.sections[this.source.page - 1]?.title ??
            (this.app.doc.kind === 'web' ? this.source.label || label('Article', '文章') : this.source.page);
          citation = markdownPassageLabel(place, caption);
        }
        const url = new URL(this.source.sourceUrl);
        if (!url.searchParams.has('discussion')) url.searchParams.set('reply', this.requestId);
        attempt.entry = state.entries.get(attempt.text) ?? editor.savedAnswer(this.requestId, attempt.text, this.source.sourceUrl) ??
          editor.insertAnswer({docId:this.source.docId,sourceUrl:url.href}, citation, attempt.text);
        state.entries.set(attempt.text, attempt.entry);
        state.last = attempt.text;
      }
      await attempt.entry.persist();
      state.retry = undefined;
    } catch (error) { state.retry = attempt; state.error = message(error); }
    finally { state.busy = false; this.updateViews(); }
  }
  private async remove(): Promise<void> {
    const state = this.state, entry = this.entry();
    if (!entry || state.busy) return;
    state.busy = true;
    this.updateViews();
    try {
      await entry.undo();
      for (const [text, saved] of state.entries) if (saved === entry) state.entries.delete(text);
      state.last = [...state.entries.keys()].at(-1);
      state.retry = undefined; state.error = ''; state.undoFailed = false;
    } catch (error) { state.error = message(error); state.undoFailed = true; }
    finally { state.busy = false; this.updateViews(); }
  }
}
