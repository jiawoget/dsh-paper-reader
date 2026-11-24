import type { JournalNote, SourceRecord } from '../shared/types.js';
import { answerMarkdown } from './answer-markdown.js';
import type { ReaderPort } from './panels.js';
import { notesForSelection, selectionKey, type SelectionContext } from './selection-context.js';
import { api, button, el, icon, message, readerLabel, toast } from './ui.js';

type NoteOrigin = Pick<SelectionContext, 'source' | 'original' | 'selection'>;
interface NoteDraft {
  base?: JournalNote;
  origin: NoteOrigin;
  text: string;
  start: number;
  end: number;
  createId: string;
  additional: boolean;
  saving?: Promise<void>;
  error?: string;
  conflict?: { latest?: JournalNote };
}
export interface NoteState {
  draft?: NoteDraft;
  opened?: boolean;
  lastSaved?: string;
}
interface DraftControls {
  draft: NoteDraft;
  editor: HTMLTextAreaElement;
  caption: HTMLElement;
  submit: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

function matchesSource(stored: SourceRecord | undefined, source: SourceRecord): boolean {
  return Boolean(stored && stored.docId === source.docId && stored.page === source.page && stored.anchor === source.anchor &&
    typeof stored.title === 'string' && typeof stored.label === 'string' && typeof stored.sourceUrl === 'string');
}

export class SelectionNotes {
  readonly root = el('section', 'selection-notes');
  readonly action = button('', () => this.show(), 'btn selection-note-action');
  private readonly draftKey: string;
  private version = '';
  private readonly savedList = el('div', 'selection-note-list');
  private readonly composer = el('div', 'selection-note-editor');
  private readonly problem = el('div', 'selection-problem');
  private readonly events = new AbortController();
  private editing?: DraftControls;

  constructor(private app: ReaderPort, private item: SelectionContext, private state: NoteState,
    private changed: () => void) {
    this.draftKey = 'reader.selection-note-draft.' + selectionKey(item);
    this.action.title = readerLabel('Write directly in Notes', '直接写入本篇笔记');
    this.state.draft ??= this.restoreDraft();
    this.root.ariaLabel = readerLabel('Notes for this selection', '当前选区笔记');
    this.root.tabIndex = -1;
    this.root.append(this.savedList, this.composer);
    this.problem.setAttribute('role', 'alert');
    // Capture before the browser moves focus or repurposes its selection to start a drag in the answer.
    document.addEventListener('pointerdown', event => {
      if (event.target !== this.editing?.editor) this.captureCaret();
    }, { capture: true, signal: this.events.signal });
    window.addEventListener('pagehide', () => this.captureCaret(), { signal: this.events.signal });
    this.render();
  }
  private restoreDraft(): NoteDraft | undefined {
    try {
      const saved = sessionStorage.getItem(this.draftKey);
      if (!saved) return;
      const { origin, base, text, start, end, createId, additional } = JSON.parse(saved) as Partial<NoteDraft>;
      if (!origin || !matchesSource(origin.source, this.item.source) || typeof origin.original !== 'string' ||
        typeof origin.selection !== 'string' || typeof text !== 'string' || typeof createId !== 'string' ||
        typeof additional !== 'boolean' || typeof start !== 'number' || typeof end !== 'number' ||
        !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return;
      if (base !== undefined && (!matchesSource(base, origin.source) || typeof base.id !== 'string' ||
        typeof base.text !== 'string' || typeof base.quote !== 'string' || typeof base.createdAt !== 'string' ||
        typeof base.updatedAt !== 'string')) return;
      return { origin, base, text, start, end, createId, additional };
    } catch { /* Ignore inaccessible storage or an unreadable draft. */ }
  }
  private persistDraft(): void {
    const draft = this.state.draft;
    try {
      if (!draft) {
        sessionStorage.removeItem(this.draftKey);
        return;
      }
      // Retry with the original link and note revision after reload. In-flight saves belong to the live editor.
      const { origin, base, text, start, end, createId, additional } = draft;
      sessionStorage.setItem(this.draftKey, JSON.stringify({ origin, base, text, start, end, createId, additional }));
    } catch { /* The live workspace retains the draft when storage is unavailable. */ }
  }
  private clearDraft(): void {
    this.state.draft = undefined;
    this.persistDraft();
  }
  private captureCaret(field: Element | null = document.activeElement): void {
    const controls = this.editing;
    if (!controls || field !== controls.editor || !controls.editor.isConnected || this.state.draft !== controls.draft) return;
    const anchor = document.getSelection()?.anchorNode;
    // Chromium can still report the textarea as focused while the document's range already belongs to an answer.
    if (anchor && !anchor.contains(controls.editor) && !controls.editor.contains(anchor)) return;
    const { selectionStart, selectionEnd } = controls.editor;
    if (controls.draft.start === selectionStart && controls.draft.end === selectionEnd) return;
    controls.draft.start = selectionStart;
    controls.draft.end = selectionEnd;
    this.persistDraft();
  }
  destroy(): void { this.captureCaret(); this.events.abort(); }
  private saved(): JournalNote[] {
    return notesForSelection(this.app.state.notes, this.item);
  }
  private focusNote(): void { (this.editing?.editor ?? this.root).focus({ preventScroll: true }); }
  async show(): Promise<void> {
    this.state.opened = true;
    if (this.root.hidden) {
      try { await this.app.refresh(); } catch (error) { toast(message(error)); }
      if (!this.action.isConnected) return;
    }
    if (!this.state.draft && !this.saved().length) {
      this.begin();
      return;
    }
    this.render();
    this.focusNote();
  }
  private begin(base?: JournalNote): void {
    if (this.state.draft) return;
    const { source, original, selection } = this.item;
    const text = base?.text ?? '';
    this.state.draft = { base, origin: { source, original, selection }, text, start: text.length, end: text.length,
      createId: crypto.randomUUID(), additional: this.saved().length > 0 };
    this.persistDraft();
    this.state.lastSaved = undefined;
    this.render();
    this.focusNote();
  }
  private remember(note: JournalNote): void {
    this.app.state.notes = [note, ...this.app.state.notes.filter(item => item.id !== note.id)];
    this.state.lastSaved = note.id;
  }
  private async synchronize(): Promise<void> {
    try { await this.app.refresh(); } catch (error) { toast(message(error)); }
  }
  private newNote(text: string, createId: string, first = false, item: NoteOrigin = this.item): Promise<{ note: JournalNote }> {
    const { source, original, selection } = item;
    return api('note.save', { ...source, text, quote: original, context: selection, createId, insert: true, selectionNote: first });
  }
  private async save(draft: NoteDraft): Promise<void> {
    if (draft.saving || draft.conflict) return;
    const saved = Promise.withResolvers<void>();
    draft.saving = saved.promise;
    draft.error = undefined;
    this.changed();
    try {
      const text = draft.text.trim() ? draft.text : draft.origin.selection;
      const { note } = draft.base ? await api('note.save', { ...draft.base, text, expectedUpdatedAt: draft.base.updatedAt })
        : await this.newNote(text, draft.createId, !draft.additional, draft.origin);
      this.remember(note);
      this.clearDraft();
      this.changed();
      await this.synchronize();
    } catch (error) {
      draft.error = message(error);
      await this.synchronize();
      const latest = draft.base ? this.app.state.notes.find(note => note.id === draft.base!.id) : this.saved()[0];
      if (draft.base ? latest?.updatedAt !== draft.base.updatedAt : latest && !draft.additional) draft.conflict = { latest };
    } finally {
      draft.saving = undefined;
      saved.resolve();
      this.changed();
    }
  }
  async waitForSave(): Promise<void> {
    const draft = this.state.draft;
    if (!draft) return;
    await draft.saving;
    if (draft.error) throw Error(readerLabel('Save the note and retry the question.', '请先保存这条笔记，再重试提问。'));
  }
  get saving(): boolean { return Boolean(this.state.draft?.saving); }
  get acceptsExcerpt(): boolean { return Boolean(this.state.draft || this.state.opened); }
  insertExcerpt(text: string): void {
    if (this.saving) return;
    if (!this.state.draft) this.begin();
    const editor = this.editing?.editor, draft = this.state.draft;
    if (!editor || !draft) return;
    const { start, end } = draft;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(start, end);
    // Chromium's native editing command keeps the replacement in the same undo history as typing.
    if (!document.execCommand('insertText', false, text)) {
      editor.setRangeText(text, start, end, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  refresh(): void {
    if (this.saved().map(note => note.id + note.updatedAt).join() !== this.version) this.render();
  }
  render(): void {
    const saved = this.saved(), draft = this.state.draft;
    this.version = saved.map(note => note.id + note.updatedAt).join();
    this.root.hidden = !saved.length && !draft;
    this.action.replaceChildren(icon('edit', 14), saved.length ? readerLabel('Notes (' + saved.length + ')', '笔记（' + saved.length + '）') : readerLabel('Write note', '记笔记'));
    this.savedList.replaceChildren();
    if (saved.length) {
      const header = el('div', 'saved-note-heading');
      header.append(icon('check', 14), el('h3', '', saved.length === 1 ? readerLabel('Saved note', '已保存的笔记') : readerLabel('Saved notes', '已保存的笔记')));
      this.savedList.append(header);
      for (const note of saved) {
        const row = el('article', 'selection-saved-note');
        row.dataset.noteId = note.id;
        const body = el('div', 'selection-prose');
        body.dir = 'auto';
        body.innerHTML = answerMarkdown(note.text);
        const edit = button(readerLabel('Edit', '编辑'), () => this.begin(note), 'text-btn', 'edit');
        edit.disabled = Boolean(draft);
        row.append(body, edit);
        this.savedList.append(row);
      }
    }
    if (draft) { this.renderEditor(draft); return; }
    this.editing = undefined;
    this.composer.replaceChildren();
    if (saved.length) {
      const footer = el('div', 'selection-note-footer');
      const status = el('span', 'selection-status', saved.some(note => note.id === this.state.lastSaved) ? readerLabel('Note saved.', '笔记已保存。') : '');
      status.setAttribute('role', 'status');
      footer.append(status, button(readerLabel('Add another note', '再记一条'), () => this.begin(), 'text-btn', 'plus'));
      this.composer.append(footer);
    }
  }
  private createEditor(draft: NoteDraft): DraftControls {
    const field = el('label', 'selection-note-field'), editor = el('textarea');
    const caption = el('span');
    field.append(caption, editor);
    editor.ariaLabel = readerLabel('Your note', '笔记内容');
    editor.placeholder = readerLabel('Write a thought or save the paper quotation.', '记录想法，或直接保存所选引文。');
    editor.rows = 3;
    editor.value = draft.text;
    const submit = button('', () => this.save(draft), 'btn primary');
    const remember = () => { if (this.editing?.editor === editor) this.captureCaret(); };
    editor.onselect = editor.onkeyup = editor.onpointerup = remember;
    editor.addEventListener('selectionchange', remember);
    editor.onblur = () => this.captureCaret(editor);
    editor.oninput = () => {
      draft.text = editor.value;
      draft.start = editor.selectionStart;
      draft.end = editor.selectionEnd;
      this.persistDraft();
      submit.textContent = draft.text.trim() ? readerLabel('Save note', '保存笔记') : readerLabel('Save quote', '保存引文');
    };
    editor.onkeydown = event => {
      if (event.key === 'Tab') remember();
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit.click(); }
    };
    const footer = el('div', 'selection-note-footer');
    const cancel = button(readerLabel('Cancel', '取消'), () => { this.clearDraft(); this.render(); }, 'text-btn');
    footer.append(cancel, submit);
    this.composer.replaceChildren(field, this.problem, footer);
    editor.setSelectionRange(draft.start, draft.end);
    return { draft, editor, caption, submit, cancel };
  }
  private renderEditor(draft: NoteDraft): void {
    // Saved notes can change during a gesture. Keep the live editor, its focus, IME composition, and native undo history.
    if (this.editing?.draft !== draft) this.editing = this.createEditor(draft);
    const { editor, caption, submit, cancel } = this.editing;
    caption.textContent = draft.base ? readerLabel('Edit note', '编辑笔记') : readerLabel('Write in Notes', '写入本篇笔记');
    editor.disabled = cancel.disabled = Boolean(draft.saving);
    submit.textContent = draft.saving ? readerLabel('Saving…', '保存中…') : draft.text.trim() ? readerLabel('Save note', '保存笔记') : readerLabel('Save quote', '保存引文');
    submit.disabled = Boolean(draft.saving || draft.conflict);
    this.problem.replaceChildren();
    this.problem.hidden = !draft.error;
    if (draft.error) {
      const alert = this.problem;
      alert.textContent = draft.error;
      if (draft.conflict) {
        const { latest } = draft.conflict;
        if (latest) alert.append(el('blockquote', '', latest.text), button(readerLabel('Use saved note', '采用已保存版本'), () => {
          this.clearDraft();
          this.render();
        }, 'text-btn'));
        alert.append(button(latest ? readerLabel('Keep my draft', '保留我的草稿') : readerLabel('Keep as a new note', '另存为新笔记'), () => {
          draft.base = latest;
          draft.additional = true;
          draft.error = draft.conflict = undefined;
          this.persistDraft();
          this.render();
          this.focusNote();
        }, 'text-btn'));
      }
    }
  }
}
