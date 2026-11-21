import { type ChangeSet, EditorState, StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { markdownHeading, notebookBlocks } from '../shared/notebook-structure.js';
import type { JournalNote } from '../shared/types.js';
import type { PaperAnnotation } from '../shared/annotations.js';
import { NotebookHighlight, positionHighlights, type NotebookCitation } from './notebook-highlights.js';
import { passageDefinitions, passageLinks, type PassageLink } from './passage-links.js';
import { el, icon, message, readerLabel as label, toast } from './ui.js';

export const refreshSources = StateEffect.define<void>();
export const markdownColors = syntaxHighlighting(HighlightStyle.define([
  {tag: tags.heading1, class: 'md-title'},
  {tag: [tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: 'md-heading'},
  {tag: tags.strong, class: 'md-strong'}, {tag: tags.emphasis, class: 'md-em'},
  {tag: [tags.link, tags.url], class: 'md-link'}, {tag: tags.monospace, class: 'md-code'},
  {tag: [tags.processingInstruction, tags.meta, tags.comment], class: 'md-markup'},
  {tag: tags.quote, class: 'md-quote'}
]));

// CodeMirror positions use one unit per line ending. Splice the original string so
// that changing a sentence doesn't rewrite line endings elsewhere in an existing file.
export function editedMarkdown(original: string, oldDoc: Text, changes: ChangeSet): string {
  const starts = [0];
  for (const match of original.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  const separator = original.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const offset = (position: number) => {
    const line = oldDoc.lineAt(position);
    return starts[line.number - 1] + position - line.from;
  };
  let cursor = 0;
  const chunks: string[] = [];
  changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    chunks.push(original.slice(cursor, offset(from)), inserted.sliceString(0, inserted.length, separator));
    cursor = offset(to);
  });
  return chunks.join('') + original.slice(cursor);
}

interface SourceControls {
  note(id: string): JournalNote | undefined;
  chip(note: JournalNote): HTMLButtonElement;
  openPassage(url: URL): Promise<void>;
  highlights(): readonly PaperAnnotation[];
  editHighlight(id: string, trigger: HTMLElement): void;
  article: boolean;
  chapterTitle?: string;
}

export function foldedHeader(text: string, chapterTitle?: string): {from: number; to: number} | undefined {
  const header = /^# ([^\n]*)\n\n(\[Open in Paper Reader\]\(<(https?:\/\/[^>\n]+)>\)\n?)/.exec(text);
  if (!header) return;
  const chapter = chapterTitle && header[1] === markdownHeading(chapterTitle) &&
    URL.parse(header[3])?.pathname === '/api/paper-reader/app/index.html';
  return { from: chapter ? 0 : header[0].length - header[2].length - 1, to: header[0].length };
}

class PassageWidget extends WidgetType {
  constructor(private link: PassageLink, private controls: SourceControls) { super(); }
  eq(other: PassageWidget): boolean { return this.link.url.href === other.link.url.href && this.link.label === other.link.label; }
  private anchor(url: URL, caption: string, css: string): HTMLAnchorElement {
    const anchor = el('a', css, caption);
    anchor.href = url.href;
    anchor.contentEditable = 'false';
    anchor.onclick = event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
      event.preventDefault();
      void this.controls.openPassage(url).catch(error => toast(message(error)));
    };
    return anchor;
  }
  toDOM(): HTMLElement {
    const { url, label: caption, replyId } = this.link;
    const source = this.anchor(url, caption, 'notebook-passage-link');
    source.title = url.searchParams.get('targetQuote') || url.searchParams.get('quote') || caption;
    if (!replyId) return source;

    const discussion = new URL('index.html', location.href);
    discussion.searchParams.set('doc', url.searchParams.get('doc')!);
    discussion.searchParams.set('discussion', replyId);
    const view = this.anchor(discussion, label('View discussion', '查看讨论'), 'notebook-discussion-link');
    view.ariaDescription = caption;
    const citations = el('span');
    citations.contentEditable = 'false';
    citations.append(source, ' ', view);
    return citations;
  }
}

class SourceWidget extends WidgetType {
  constructor(private readonly note: JournalNote, private readonly controls: SourceControls) { super(); }
  eq(other: SourceWidget): boolean { return other.note.id === this.note.id && other.note.updatedAt === this.note.updatedAt; }
  toDOM(view: EditorView): HTMLElement {
    const note = this.note;
    const root = el('div', 'notebook-source');
    root.dataset.noteId = note.id;
    const row = el('div', 'notebook-source-row');
    const link = this.controls.chip(note);
    link.dataset.noteId = note.id;
    row.append(link);
    const excerpt = el('div', 'notebook-excerpt');
    excerpt.hidden = true;
    if (note.quote || note.context) {
      const show = el('button', 'notebook-quote-toggle', 'Quote');
      show.type = 'button';
      show.setAttribute('aria-label', 'Show quoted passage');
      show.setAttribute('aria-expanded', 'false');
      show.onclick = () => {
        excerpt.hidden = !excerpt.hidden;
        show.setAttribute('aria-expanded', String(!excerpt.hidden));
        view.requestMeasure();
      };
      if (note.quote) excerpt.append(el('blockquote', 'quote', note.quote));
      if (note.context && note.context !== note.quote) excerpt.append(el('p', 'notebook-selection', note.context));
      row.append(show);
    }
    const remove = el('button', 'notebook-remove');
    remove.type = 'button';
    remove.title = 'Delete linked note';
    remove.setAttribute('aria-label', 'Delete linked note');
    remove.append(icon('close', 12));
    remove.onclick = () => {
      const contents = view.state.doc.toString();
      const block = notebookBlocks(contents).find(block => block.id === note.id);
      if (!block) return;
      const to = block.end + (contents.slice(block.end).match(/^\n{1,2}/)?.[0].length ?? 0);
      view.dispatch({changes: {from: block.start, to}, selection: {anchor: block.start}, userEvent: 'delete'});
      view.focus();
    };
    row.append(remove);
    root.append(row, excerpt);
    return root;
  }
}

// The delimiters belong to Paper Reader's existing file format. Only complete,
// recognized note blocks are folded. Source mode always exposes the full file.
export function foldedSources(controls: SourceControls): Extension {
  const decorate = (state: EditorState): DecorationSet => {
    const doc = state.doc;
    const text = doc.toString();
    const ranges: Range<Decoration>[] = [];
    const citations: NotebookCitation[] = [];
    const definitions = passageDefinitions(text);
    const inCode = (at: number) => {
      for (let node = syntaxTree(state).resolveInner(at + 1); node; node = node.parent!) {
        if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) return true;
      }
      return false;
    };
    const visibleDefinitions = definitions.filter(definition => !inCode(definition.from));
    for (const definition of visibleDefinitions) {
      ranges.push(Decoration.replace({}).range(definition.from, definition.to));
    }
    for (const link of passageLinks(text, visibleDefinitions)) {
      if (inCode(link.from)) continue;
      ranges.push(Decoration.replace({widget: new PassageWidget(link, controls)}).range(link.from, link.to));
      citations.push({ url: link.url, at: doc.lineAt(link.from).to });
    }
    const header = foldedHeader(text, controls.chapterTitle);
    if (header) ranges.push(Decoration.replace({}).range(header.from, header.to));
    try {
      for (const block of notebookBlocks(text)) {
        const note = controls.note(block.id);
        if (!note) continue;
        const url = URL.parse(note.sourceUrl);
        if (url) citations.push({ url, at: block.start });
        ranges.push(Decoration.replace({inclusive: false}).range(block.start, block.bodyStart));
        ranges.push(Decoration.line({attributes: {'data-note-id': block.id}}).range(doc.lineAt(block.start).from));
        const first = doc.lineAt(block.bodyStart).number, last = doc.lineAt(block.bodyEnd).number;
        for (let number = first; number <= last; number++) {
          ranges.push(Decoration.line({attributes: {'data-note-id': block.id}}).range(doc.line(number).from));
        }
        ranges.push(Decoration.replace({widget: new SourceWidget(note, controls), block: true, inclusive: false})
          .range(block.bodyEnd, block.end + (text[block.end] === '\n' ? 1 : 0)));
      }
    } catch { /* A native editor may have saved an incomplete block. Keep all of its text editable. */ }
    for (const { mark, at, matched } of positionHighlights(controls.highlights(), citations, doc.length)) {
      const widget = new NotebookHighlight(mark, controls.article, controls.openPassage, controls.editHighlight);
      ranges.push(Decoration.widget({ widget, block: true, side: matched && at === doc.lineAt(at).from ? -1 : 1 }).range(at));
    }
    return Decoration.set(ranges, true);
  };
  const field = StateField.define<DecorationSet>({
    create: decorate,
    update: (value, tr) => tr.docChanged || tr.effects.some(effect => effect.is(refreshSources)) ? decorate(tr.state) : value,
    provide: f => [EditorView.decorations.from(f), EditorView.atomicRanges.of(view => view.state.field(f))]
  });
  return [field, EditorState.transactionFilter.of(tr => {
    if (!tr.docChanged || tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;
    const before = tr.startState.doc.toString();
    let oldBlocks: ReturnType<typeof notebookBlocks>;
    try { oldBlocks = notebookBlocks(before); } catch { return tr; }
    // Removing just a linked note's visible text removes its complete record.
    if (tr.changes.empty === false) {
      let only: {from: number; to: number; empty: boolean} | undefined;
      let count = 0;
      tr.changes.iterChanges((from, to, _a, _b, inserted) => { count++; only = {from, to, empty: !inserted.length}; });
      if (count === 1 && only?.empty) {
        const {from, to} = only;
        const block = oldBlocks.find(b => from === b.bodyStart && to === b.bodyEnd);
        if (block) return {changes: {from: block.start, to: block.end}, selection: {anchor: block.start}, userEvent: 'delete'};
      }
    }
    try { notebookBlocks(tr.newDoc.toString()); }
    catch {
      queueMicrotask(() => toast('Edit the note text or use Delete linked note beside its source link.'));
      return [];
    }
    return tr;
  })];
}
