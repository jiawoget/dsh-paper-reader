import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import type { JournalNote, NotebookSnapshot, SourceRecord } from '../shared/types.js';
import type { PaperAnnotation } from '../shared/annotations.js';
import type { ReaderPort } from './panels.js';
import { editedMarkdown, foldedHeader, foldedSources, markdownColors, refreshSources } from './notebook-editor.js';
import { markdownPassageLabel, notebookBodyEnd, passageDefinitions, passageLinks } from './passage-links.js';
import { api, button, el, icon, message, readerLabel as label, sourceUrl, toast } from './ui.js';

type MakeChip = (app: ReaderPort, note: JournalNote, quote?: string) => HTMLButtonElement;
interface Draft { revision: string; original: string; text: string }
export interface NotebookInsertion {
  mounted(): boolean;
  persist(): Promise<void>;
  undo(): Promise<void>;
  reveal(): void;
}
interface ExcerptRange { from: number; to: number; text: string }
const quotedAnswer = (text: string) => text.trim().split(/\r\n?|\n/u).map(line => line ? '> ' + line : '>').join('\n') + '\n>\n> AI · ';
const editors = new WeakMap<ReaderPort, NotebookEditor>();
const pendingDrafts = new Map<string, Draft>();
const draftKey = (id: string) => 'reader.markdown-draft.' + id;
const currentChapter = (app: ReaderPort) => app.doc.book?.sections[app.page - 1]?.chapterId;

function paragraphGap(left: string, right: string): string {
  if (!left || !right) return '';
  const breaks = (left.match(/\n{1,2}$/u)?.[0].length ?? 0) + (right.match(/^\n{1,2}/u)?.[0].length ?? 0);
  return '\n'.repeat(Math.max(0, 2 - breaks));
}

function remembered(id: string): Draft | undefined {
  const live = pendingDrafts.get(id);
  if (live) return live;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null');
    if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' &&
        'revision' in value && typeof value.revision === 'string' && 'original' in value && typeof value.original === 'string') {
      return {text: value.text, revision: value.revision, original: value.original};
    }
  } catch { /* Memory still protects drafts when browser storage is unavailable. */ }
}

function wrapSelection(view: EditorView, mark: string): boolean {
  const state = view.state;
  const changes = state.changeByRange(range => {
    const remove = range.from >= mark.length && state.sliceDoc(range.from - mark.length, range.from) === mark &&
      state.sliceDoc(range.to, range.to + mark.length) === mark;
    const selected = state.sliceDoc(range.from, range.to);
    const shift = remove ? -mark.length : mark.length;
    return {changes: {from: remove ? range.from - mark.length : range.from, to: remove ? range.to + mark.length : range.to,
      insert: remove ? selected : mark + selected + mark}, range: EditorSelection.range(range.anchor + shift, range.head + shift)};
  });
  view.dispatch({...changes, userEvent: 'input.format'});
  view.focus();
  return true;
}

class NotebookEditor {
  readonly root = el('section', 'reader-notebook');
  readonly docId: string;
  readonly chapterId?: string;
  private readonly draftId: string;
  private readonly page: number;
  private readonly title: string;
  private readonly mode = new Compartment();
  private readonly selection = new Compartment();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly onMotionChange = () => {
    if (this.disposed) return;
    this.view.dispatch({effects: this.selection.reconfigure(this.selectionExtension())});
    this.syncCursorAnimation();
  };
  private readonly view: EditorView;
  private readonly status = el('span', 'notebook-status');
  private readonly locationButton: HTMLButtonElement;
  private readonly fileLink = el('a', 'notebook-open');
  private readonly toggle: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly issue = el('div', 'notebook-issue');
  private readonly guide = el('details', 'notebook-guide');
  private book: NotebookSnapshot;
  private draft: Draft;
  private sourceMode = false;
  private highlights: readonly PaperAnnotation[] = [];
  private saving = false;
  private activeWrite?: Promise<void>;
  private excerpts = new Set<ExcerptRange>();
  private disposed = false;
  private hasCaret = false;
  private reviewed = '';
  private failure = '';
  private timer?: ReturnType<typeof setTimeout>;
  private readonly poll: ReturnType<typeof setInterval>;
  private readonly rememberOnExit = () => this.remember();

  constructor(private readonly app: ReaderPort, book: NotebookSnapshot, private readonly chip: MakeChip, connect: () => void) {
    this.book = book;
    this.docId = book.docId;
    this.chapterId = book.chapterId;
    this.page = app.page;
    this.draftId = this.chapterId ? this.docId + '/' + encodeURIComponent(this.chapterId) : this.docId;
    this.title = app.doc.title;
    this.draft = remembered(this.draftId) ?? {revision: book.revision, original: book.markdown, text: book.markdown};
    if (this.draft.text === book.markdown || this.draft.original === book.markdown) {
      this.draft = {...this.draft, revision: book.revision, original: book.markdown};
    }
    this.sourceMode = book.localConflict !== undefined;

    const tools = el('div', 'notebook-toolbar');
    const bold = button('B', () => wrapSelection(this.view, '**'), 'notebook-format notebook-bold');
    bold.setAttribute('aria-label', label('Bold', '加粗')); bold.title = label('Bold (Ctrl+B)', '加粗 (Ctrl+B)');
    const italic = button('I', () => wrapSelection(this.view, '*'), 'notebook-format notebook-italic');
    italic.setAttribute('aria-label', label('Italic', '斜体')); italic.title = label('Italic (Ctrl+I)', '斜体 (Ctrl+I)');
    this.toggle = button('Markdown', () => {
      this.sourceMode = !this.sourceMode;
      const state = this.view.state, head = state.selection.main.head;
      const cursor = this.visibleCursor(state.doc.toString(), head);
      this.view.dispatch({effects: this.mode.reconfigure(this.displayMode()), ...(cursor !== head && {selection: {anchor: cursor}})});
      this.updateControls();
    }, 'notebook-format notebook-source-mode');
    this.toggle.title = label('Show Markdown source', '显示 Markdown 源码');
    const refresh = button('', () => this.app.refresh(), 'notebook-format', 'refresh');
    refresh.setAttribute('aria-label', label('Refresh notes', '刷新笔记')); refresh.title = label('Refresh notes', '刷新笔记');
    this.saveButton = el('button', 'notebook-save', label('Save', '保存'));
    this.saveButton.type = 'button';
    this.saveButton.onclick = () => void this.save();
    this.saveButton.title = label('Save notes (Ctrl+S)', '保存笔记 (Ctrl+S)');
    tools.append(bold, italic, this.toggle, refresh, this.saveButton);
    const mount = el('div', 'notebook-writing-area');
    const footer = el('footer', 'notebook-footer');
    this.locationButton = button('', connect, 'notebook-location', 'folder');
    this.status.setAttribute('role', 'status');
    const location = el('div', 'notebook-file');
    this.fileLink.ariaLabel = this.fileLink.title = label('Open in Obsidian', '在 Obsidian 中打开');
    this.fileLink.append(icon('popout', 13));
    this.fileLink.onclick = event => {
      if (!this.book.uri || !this.book.desktopOpenAvailable) return;
      event.preventDefault();
      void api('notebook.open', { docId: this.docId, page: this.page, expectedUri: this.book.uri }).catch(error => toast(message(error)));
    };
    location.append(this.locationButton, this.fileLink);
    footer.append(location, this.status);
    if (book.chapterTitle) {
      const chapter = el('header', 'notebook-chapter');
      chapter.append(el('span', '', label('Chapter notes', '章节笔记')), el('strong', '', book.chapterTitle));
      this.root.append(chapter);
    }
    this.root.append(tools, this.issue, mount, this.guide, footer);
    this.guide.append(el('summary', '', label('Reading guide','阅读提示')), el('div', 'notebook-guide-content'));
    this.guide.ontoggle = () => { if (this.guide.open && this.root.isConnected) this.renderGuide?.(this.guide.lastElementChild as HTMLElement); };
    this.view = new EditorView({state: this.state(this.draft.text), parent: mount});
    this.syncCursorAnimation();
    this.reducedMotion.addEventListener('change', this.onMotionChange);
    this.poll = setInterval(() => {
      if (this.book.path && this.root.isConnected && !document.hidden && !this.saving) void this.app.refresh().catch(() => undefined);
    }, 5000);
    window.addEventListener('pagehide', this.rememberOnExit);
    this.updateControls();
    if (this.dirty) this.schedule();
  }

  private get dirty(): boolean { return this.draft.text !== this.draft.original; }
  belongsTo(docId: string, chapterId?: string): boolean { return this.docId === docId && this.chapterId === chapterId; }
  private get current(): boolean { return !this.disposed && this.belongsTo(this.app.doc.id, currentChapter(this.app)); }
  private get conflict(): boolean {
    return this.book.localConflict !== undefined || this.dirty && this.draft.revision !== this.book.revision;
  }

  private displayMode() {
    return this.sourceMode ? [] : foldedSources({
      note: id => this.book.notes.find(note => note.id === id),
      chip: note => this.chip(this.app, note, note.quote),
      openPassage: url => this.app.openNotebookSource(url),
      highlights: () => this.highlights,
      editHighlight: (id, trigger) => this.app.editNotebookHighlight(id, trigger),
      article: this.app.doc.kind === 'web', chapterTitle: this.book.chapterTitle
    });
  }

  private selectionExtension() {
    return drawSelection({cursorBlinkRate: this.reducedMotion.matches ? 0 : 1200});
  }

  private syncCursorAnimation(): void {
    const layer = this.view.scrollDOM.querySelector<HTMLElement>('.cm-cursorLayer');
    if (layer) layer.style.animationName = this.reducedMotion.matches ? 'none' : '';
  }

  private visibleCursor(text: string, cursor: number): number {
    if (this.sourceMode || !this.book.chapterTitle) return cursor;
    const header = foldedHeader(text, this.book.chapterTitle);
    return header?.from === 0 ? Math.max(cursor, header.to) : cursor;
  }

  private state(text: string, cursor = 0): EditorState {
    const normalized = text.replace(/\r\n?/g, '\n');
    return EditorState.create({doc: text, selection: {anchor: Math.min(this.visibleCursor(normalized, cursor), normalized.length)}, extensions: [
      history(), markdown(), markdownColors, this.mode.of(this.displayMode()), EditorView.lineWrapping, this.selection.of(this.selectionExtension()), highlightActiveLine(),
      EditorView.contentAttributes.of({'aria-label': label('Notes Markdown', '笔记 Markdown'), 'aria-multiline': 'true', spellcheck: 'true'}),
      EditorView.domEventHandlers({ focus: () => { this.hasCaret = true; } }),
      keymap.of([
        {key: 'Mod-s', run: () => { void this.save(); return true; }},
        {key: 'Mod-b', run: view => wrapSelection(view, '**')}, {key: 'Mod-i', run: view => wrapSelection(view, '*')},
        ...historyKeymap, ...defaultKeymap
      ]),
      EditorView.updateListener.of(update => {
        if (this.reducedMotion.matches && update.selectionSet) this.syncCursorAnimation();
        if (!update.docChanged) return;
        for (const range of this.excerpts) {
          range.from = update.changes.mapPos(range.from, 1);
          range.to = update.changes.mapPos(range.to, -1);
        }
        this.draft.text = editedMarkdown(this.draft.text, update.startState.doc, update.changes);
        this.failure = '';
        this.remember();
        this.updateControls();
        this.schedule();
      })
    ]});
  }

  insertPassage(source: SourceRecord, selected: string): void {
    const state = this.view.state, markdown = state.doc.toString();
    const definitions = passageDefinitions(markdown);
    const existing = definitions.find(definition => definition.url.href === source.sourceUrl);
    let id = existing?.id;
    while (!id || (!existing && definitions.some(definition => definition.id === id))) {
      id = 'p' + source.page + '-' + crypto.randomUUID().slice(0, 8);
    }
    // Escape Markdown syntax in the visible label, including GFM's table-cell separator.
    const location = this.app.doc.book?.sections[source.page - 1]?.title ??
      (this.app.doc.kind === 'web' ? source.label || label('Article', '文章') : source.page);
    const link = '[' + markdownPassageLabel(location, selected) + '][' + id + ']';
    const last = state.doc.length;
    const fallback = notebookBodyEnd(markdown, definitions);
    const { from, to } = this.hasCaret ? state.selection.main : { from: fallback, to: fallback };
    const prefix = !this.hasCaret && from && markdown[from - 1] !== '\n' ? '\n\n' : '';
    const insertion = prefix + link;
    const changes = [{ from, to, insert: insertion }];
    if (!existing) {
      const before = from === last || to === last ? insertion : markdown;
      const gap = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const definition = gap + '[' + id + ']: <' + source.sourceUrl + '>\n';
      if (to === last) changes[0].insert += definition;
      else changes.push({ from: last, to: last, insert: definition });
    }
    this.view.dispatch({ changes, selection: { anchor: from + insertion.length }, annotations: isolateHistory.of('full'),
      userEvent: 'input.paste', scrollIntoView: true });
    this.view.focus();
  }

  savedAnswer(id: string, answer: string, originalUrl?: string): NotebookInsertion | undefined {
    const text = this.view.state.doc.toString(), prefix = quotedAnswer(answer);
    if (!text.includes(prefix)) return;
    const original = originalUrl && URL.parse(originalUrl);
    for (const link of passageLinks(text, [])) {
      const storedId = link.url.searchParams.get('reply') || link.url.searchParams.get('discussion');
      const same = storedId ? storedId === id : original && link.url.pathname === original.pathname && link.url.search === original.search;
      let from = link.from - prefix.length, to = link.to;
      if (!same || from < 0 || !text.startsWith(prefix, from)) continue;
      if (from && (text[from - 1] !== '\n' || text.slice(text.lastIndexOf('\n', from - 2) + 1, from - 1).startsWith('>'))) continue;
      // Undo can survive reload without guessing which of the surrounding blank lines the reader wrote.
      const breaks = /^([0-2])([0-2])$/u.exec(link.url.searchParams.get('noteBreaks') ?? '');
      if (breaks) {
        const before = Number(breaks[1]), after = Number(breaks[2]);
        if (text.slice(from - before, from) === '\n'.repeat(before)) from -= before;
        if (text.slice(to, to + after) === '\n'.repeat(after)) to += after;
      }
      return this.trackAnswer({from, to, text:text.slice(from,to)});
    }
  }

  insertAnswer(source: Pick<SourceRecord,'docId'|'sourceUrl'>, citation: string, answer: string): NotebookInsertion {
    const url = new URL(source.sourceUrl), page = Number(url.searchParams.get('page'));
    const sourceChapter = this.app.doc.book?.sections[page - 1]?.chapterId;
    if (source.docId !== this.docId || !this.current || (sourceChapter && sourceChapter !== this.chapterId) || this.app.notebookError || this.conflict) {
      throw Error(this.app.notebookError || label('Open Notes and review the current notes before inserting.', '请先打开「笔记」并核对当前内容后再插入。'));
    }
    const state = this.view.state, markdown = state.doc.toString();
    const definitions = passageDefinitions(markdown);
    const end = notebookBodyEnd(markdown, definitions);
    const at = this.hasCaret ? state.selection.main.head : end;
    const left = markdown.slice(0, at), right = markdown.slice(at);
    const quote = quotedAnswer(answer);
    const before = paragraphGap(left, quote), after = paragraphGap(')', right);
    url.searchParams.set('noteBreaks', String(before.length) + String(after.length));
    const link = '[' + citation + '](<' + url.href + '>)';
    const inserted = before + quote + link + after;
    const range = { from: at, to: at + inserted.length, text: inserted };
    this.view.dispatch({ changes: { from: at, insert: inserted }, selection: { anchor: range.to },
      annotations: isolateHistory.of('full'), userEvent: 'input.paste' });
    if (this.view.state.sliceDoc(range.from, range.to) !== inserted) throw Error(label('Choose a writing position in Notes and try again.', '请在「笔记」中选择插入位置后重试。'));
    return this.trackAnswer(range);
  }

  private trackAnswer(range: ExcerptRange): NotebookInsertion {
    this.excerpts.add(range);
    let removed = false;
    const current = () => this.current && this.excerpts.has(range) && range.from <= range.to;
    return {
      mounted: () => this.current,
      persist: () => this.flush(),
      undo: async () => {
        if (!removed) {
          if (!current() || this.view.state.sliceDoc(range.from, range.to) !== range.text) {
            throw Error(label('This excerpt was edited. Open Notes to review it.', '该摘录已被修改，请打开「笔记」查看。'));
          }
          this.removeExcerpt(range);
          removed = true;
        }
        await this.flush();
      },
      reveal: () => {
        if (!this.current) throw Error(label('Reopen Notes to view the excerpt.', '请重新打开「笔记」以查看此摘录。'));
        this.app.showNotebook();
        if (!current()) return;
        const start = Math.min(range.to, range.from + range.text.indexOf('>'));
        this.view.dispatch({ effects: EditorView.scrollIntoView(start, { y: 'center' }) });
        this.view.scrollDOM.tabIndex = -1;
        this.view.scrollDOM.focus({ preventScroll: true });
      }
    };
  }

  private removeExcerpt(range: ExcerptRange): void {
    this.excerpts.delete(range);
    const following = Array.from(this.excerpts).find(other => other.from === range.to);
    const preceding = Array.from(this.excerpts).find(other => other.to === range.from);
    const doc = this.view.state.doc;
    const gap = following || preceding ? paragraphGap(doc.sliceString(Math.max(0, range.from - 2), range.from),
      doc.sliceString(range.to, Math.min(doc.length, range.to + 2))) : '';
    this.view.dispatch({ changes: { from: range.from, to: range.to, insert: gap }, annotations: isolateHistory.of('full'), userEvent: 'delete' });
    // The surviving quotation now owns the separating newline(s), so undoing it restores the original prose.
    if (following) { following.from -= gap.length; following.text = gap + following.text; }
    else if (preceding) { preceding.to += gap.length; preceding.text += gap; }
  }

  private async flush(): Promise<void> {
    if (this.activeWrite) await this.activeWrite;
    if (!this.current) throw Error(label('Reopen Notes to save your edits.', '请重新打开「笔记」以保存修改。'));
    if (this.dirty) await this.save();
    if (this.app.notebookError || this.conflict || this.failure) {
      throw Error(this.app.notebookError || this.failure || label('Review the conflicting versions in Notes.', '请在「笔记」中核对冲突版本。'));
    }
  }

  private remember(): void {
    if (this.dirty) pendingDrafts.set(this.draftId, this.draft);
    else pendingDrafts.delete(this.draftId);
    try {
      if (this.dirty) sessionStorage.setItem(draftKey(this.draftId), JSON.stringify(this.draft));
      else sessionStorage.removeItem(draftKey(this.draftId));
    } catch { /* Large drafts stay in memory until the file is saved. */ }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.dirty && !this.conflict && !this.failure && !this.app.notebookError && !this.saving && !this.disposed) {
      this.timer = setTimeout(() => void this.save(), 1100);
    }
  }

  private save(): Promise<void> {
    return this.activeWrite ??= this.write().finally(() => { this.activeWrite = undefined; });
  }

  async saveBeforeLeaving(): Promise<void> {
    clearTimeout(this.timer);
    if (this.activeWrite) await this.activeWrite;
    if (this.dirty && !this.conflict && !this.app.notebookError) await this.save();
    this.remember();
  }

  private async write(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving || this.app.notebookError || this.disposed ||
        (!this.dirty && this.book.localConflict === undefined) || (this.conflict && this.reviewed !== this.book.revision)) return;
    this.saving = true;
    this.failure = '';
    this.updateControls();
    const markdown = this.draft.text;
    try {
      const saved = await api('notebook.write', {docId: this.docId, title: this.title, page: this.page, sourceUrl: sourceUrl(this.docId, this.page),
        markdown, expectedRevision: this.conflict ? this.reviewed : this.draft.revision});
      this.book = saved;
      this.draft = {revision: saved.revision, original: saved.markdown, text: this.draft.text};
      this.reviewed = '';
      if (!this.disposed) this.view.dispatch({effects: refreshSources.of()});
      this.remember();
    } catch (error) { this.failure = message(error); }
    finally { this.saving = false; }
    if (!this.current) return;
    await this.app.refresh().catch(error => { this.failure ||= message(error); });
    this.updateControls();
    this.schedule();
  }

  private loadFile(text: string): void {
    const previous = this.view.state.doc.toString(), next = text.replace(/\r\n?/gu, '\n');
    let start = 0, oldEnd = previous.length, newEnd = next.length;
    while (start < oldEnd && start < newEnd && previous[start] === next[start]) start++;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
    for (const range of this.excerpts) {
      if (range.to <= start) continue;
      if (range.from >= oldEnd) { range.from += newEnd - oldEnd; range.to += newEnd - oldEnd; }
      else this.excerpts.delete(range);
    }
    const previousCursor = this.view.state.selection.main.head;
    const cursor = previousCursor < start ? previousCursor : previousCursor >= oldEnd
      ? previousCursor + newEnd - oldEnd : Math.min(previousCursor, newEnd);
    const scrollTop = this.view.scrollDOM.scrollTop;
    this.view.setState(this.state(text, cursor));
    this.syncCursorAnimation();
    this.view.scrollDOM.scrollTop = scrollTop;
  }

  sync(book: NotebookSnapshot): void {
    if (!this.saving && book.revision === this.book.revision) this.book = book;
    else if (!this.saving) {
      this.book = book;
      this.reviewed = '';
      if (!this.dirty || this.draft.text === book.markdown) {
        const changed = this.draft.text !== book.markdown;
        this.draft = {revision: book.revision, original: book.markdown, text: book.markdown};
        if (changed) this.loadFile(book.markdown);
        this.failure = '';
      } else if (book.markdown === this.draft.original) {
        this.draft.revision = book.revision;
      }
      this.remember();
      this.schedule();
    }
  }

  private renderGuide?: (container: HTMLElement) => void;
  setHighlights(items: readonly PaperAnnotation[]): void {
    if (items.length === this.highlights.length && items.every((item, index) =>
      item.id === this.highlights[index].id && item.updatedAt === this.highlights[index].updatedAt)) return;
    this.highlights = items;
    this.view.dispatch({ effects: refreshSources.of() });
  }
  attach(parent: HTMLElement, guide?: (parent: HTMLElement) => void): void {
    if (this.root.parentElement !== parent) { parent.replaceChildren(this.root); this.view.requestMeasure(); }
    this.renderGuide = guide ? node => { node.replaceChildren(); guide(node); } : undefined;
    this.guide.hidden = !guide;
    if (this.guide.open) this.renderGuide?.(this.guide.lastElementChild as HTMLElement);
    this.view.dispatch({effects: refreshSources.of()});
    this.updateControls();
  }

  private updateControls(): void {
    const conflict = this.conflict;
    this.toggle.setAttribute('aria-pressed', String(this.sourceMode));
    const location = this.book.path || this.book.vaultPending ? label('Obsidian vault','Obsidian 笔记库') : label('Connect Obsidian','连接 Obsidian');
    this.locationButton.replaceChildren(icon('folder', 13), location);
    this.locationButton.title = this.book.path || (this.book.vaultPending ? label('Obsidian vault settings', 'Obsidian 笔记库设置') : label('Connect these notes to an Obsidian vault', '将笔记连接到 Obsidian 笔记库'));
    this.locationButton.setAttribute('aria-label', location);
    this.fileLink.hidden = !this.chapterId || !this.book.uri || Boolean(this.app.notebookError);
    if (!this.fileLink.hidden && this.book.uri) this.fileLink.href = this.book.uri;
    else this.fileLink.removeAttribute('href');
    this.saveButton.textContent = conflict && this.reviewed ? label('Save merged draft','保存合并的草稿') : label('Save','保存');
    this.saveButton.disabled = this.saving || !!this.app.notebookError || (!this.dirty && this.book.localConflict === undefined) ||
      (conflict && this.reviewed !== this.book.revision);
    this.status.textContent = this.app.notebookError ? label('File unavailable','无法读取文件') : this.saving ? label('Saving…','保存中…') : conflict ? label('Review changes','核对修改') :
      this.failure ? label('Save failed','保存失败') : this.dirty ? label('Unsaved changes','尚未保存') : this.book.path ? label('Saved to vault','已存入笔记库') :
        this.book.vaultPending ? label('First edit saves to vault', '写下笔记时存入笔记库') : label('Saved locally','已保存到本机');
    this.status.dataset.saved = String(!this.app.notebookError && !this.saving && !conflict && !this.failure && !this.dirty);
    const issueKey = JSON.stringify([this.app.notebookError, this.failure, conflict && this.book.revision, this.reviewed]);
    if (this.issue.dataset.key === issueKey) return;
    this.issue.dataset.key = issueKey;
    this.issue.replaceChildren();
    if (conflict) {
      this.issue.append(el('p', '', this.book.localConflict !== undefined ?
        label('The vault and reader have different copies. Compare both before saving.', 'Obsidian 笔记库与阅读器中的副本不一致，请先对比再保存。') :
        label('The file changed while you were writing. Your draft is here.', '编辑期间文件已发生变化，当前草稿仍保留在此。')));
      if (this.reviewed !== this.book.revision) {
        this.issue.append(button(label('Compare latest', '对比最新版本'), () => {
          this.reviewed = this.book.revision;
          this.updateControls();
        }, 'text-btn'));
      } else {
        const details = el('details', 'notebook-comparison');
        details.open = true;
        details.append(el('summary', '', label('Latest saved Markdown', '最新保存的 Markdown')), el('pre', 'notebook-latest', this.book.markdown));
        this.issue.append(details);
        if (this.book.localConflict !== undefined) {
          const local = el('details', 'notebook-comparison');
          local.append(el('summary', '', label('Last reader copy', '阅读器上次副本')), el('pre', 'notebook-latest', this.book.localConflict));
          this.issue.append(local);
        }
        this.issue.append(el('p', '', label('Combine the text you want to keep in the editor, then save the merged draft.', '请在编辑器中合并要保留的内容，然后保存合并草稿。')));
        if (this.book.localConflict === undefined) this.issue.append(button(label('Use saved file', '改用已保存文件'), () => {
          this.draft = {revision: this.book.revision, original: this.book.markdown, text: this.book.markdown};
          this.reviewed = this.failure = '';
          this.loadFile(this.book.markdown);
          this.remember();
          this.updateControls();
        }, 'text-btn'));
      }
    }
    if (this.app.notebookError || this.failure && !conflict) this.issue.append(el('p', '', this.app.notebookError || this.failure));
    this.issue.hidden = !this.issue.childNodes.length;
  }

  destroy(remember = true): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    window.removeEventListener('pagehide', this.rememberOnExit);
    this.reducedMotion.removeEventListener('change', this.onMotionChange);
    if (remember) this.remember();
    this.view.destroy();
    this.root.remove();
  }
}

export function discardNotebook(app: ReaderPort, docId: string): void {
  const editor = editors.get(app);
  if (editor && editor.docId === docId) {
    editor.destroy(false);
    editors.delete(app);
  }
  const prefix = docId + '/';
  for (const key of [...pendingDrafts.keys()]) {
    if (key === docId || key.startsWith(prefix)) pendingDrafts.delete(key);
  }
  try {
    const exact = draftKey(docId);
    const keyPrefix = exact + '/';
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && (key === exact || key.startsWith(keyPrefix))) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch { /* sessionStorage may be unavailable. */ }
}

export async function leaveNotebook(app: ReaderPort, docId: string, chapterId?: string): Promise<void> {
  const editor = editors.get(app);
  if (editor && !editor.belongsTo(docId, chapterId)) await editor.saveBeforeLeaving();
}

export async function goToNoteChapter(app: ReaderPort, source: Pick<SourceRecord, 'docId' | 'sourceUrl'> & { page?: number }): Promise<void> {
  if (app.doc.id !== source.docId || !app.doc.book) return;
  const page = source.page ?? Number(URL.parse(source.sourceUrl)?.searchParams.get('page'));
  const target = app.doc.book.sections[page - 1];
  if (target && currentChapter(app) !== target.chapterId) await app.navigate(source.docId, page);
}

export async function insertNotebookPassage(app: ReaderPort, source: SourceRecord, selected: string): Promise<void> {
  await goToNoteChapter(app, source);
  app.showNotebook();
  if (!app.notebook) await app.refresh();
  const editor = editors.get(app);
  if (!editor?.belongsTo(source.docId, app.doc.book?.sections[source.page - 1]?.chapterId)) throw Error(label('Open the source document’s notes to insert its passage link.', '请先打开来源文档的笔记再插入出处链接。'));
  editor.insertPassage(source, selected);
}

export function notebookEditor(app: ReaderPort, chip: MakeChip, connect: () => void): NotebookEditor | undefined {
  let editor = editors.get(app);
  const chapterId = currentChapter(app);
  if (editor && !editor.belongsTo(app.doc.id, chapterId)) {
    editor.destroy();
    editors.delete(app);
    editor = undefined;
  }
  const book = app.notebook;
  if (!book || book.docId !== app.doc.id || book.chapterId !== chapterId) return;
  if (!editor) {
    editor = new NotebookEditor(app, book, chip, connect);
    editors.set(app, editor);
  } else editor.sync(book);
  editor.setHighlights(app.notebookHighlights());
  return editor;
}

export function refreshNotebookHighlights(app: ReaderPort): void {
  const editor = editors.get(app);
  if (editor?.belongsTo(app.doc.id, currentChapter(app))) editor.setHighlights(app.notebookHighlights());
}
