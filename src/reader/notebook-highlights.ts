import { WidgetType } from '@codemirror/view';
import type { PaperAnnotation } from '../shared/annotations.js';
import { readSelectionRange, readTranslatedLocator } from '../shared/source-link.js';
import { highlightName } from './annotation-colors.js';
import { visibleQuote } from './annotations.js';
import { button, el, readerLabel as label } from './ui.js';

export interface NotebookCitation { url: URL; at: number }

function passageKey(url: URL): string {
  const q = url.searchParams;
  return JSON.stringify([q.get('doc'), q.get('page'), q.get('anchor')]);
}

function overlap(a: URL, b: URL): boolean {
  const translatedA = readTranslatedLocator(a), translatedB = readTranslatedLocator(b);
  const rangeA = readSelectionRange(a), rangeB = readSelectionRange(b);
  if (Boolean(translatedA) === Boolean(translatedB) && rangeA && rangeB) {
    const anchor = a.searchParams.get('anchor');
    return rangeA.start < (rangeB.endAnchor === anchor ? rangeB.end : Infinity) &&
      rangeB.start < (rangeA.endAnchor === anchor ? rangeA.end : Infinity);
  }
  if (translatedA?.offset !== undefined && translatedB?.offset !== undefined) {
    return translatedA.offset < translatedB.offset + translatedB.text.length &&
      translatedB.offset < translatedA.offset + translatedA.text.length;
  }
  const quoteA = translatedA && translatedB ? translatedA.text : a.searchParams.get('quote');
  const quoteB = translatedA && translatedB ? translatedB.text : b.searchParams.get('quote');
  return !quoteA || !quoteB || quoteA.includes(quoteB) || quoteB.includes(quoteA);
}

/** An annotation has one place in the view even if the same passage is cited several times. */
export function positionHighlights(marks: readonly PaperAnnotation[], citations: NotebookCitation[], end: number) {
  const byPassage = new Map<string, NotebookCitation[]>();
  for (const citation of citations.toSorted((a, b) => a.at - b.at)) {
    const key = passageKey(citation.url);
    const entries = byPassage.get(key);
    if (entries) entries.push(citation);
    else byPassage.set(key, [citation]);
  }
  return marks.map(mark => {
    const url = new URL(mark.sourceUrl);
    const entries = byPassage.get(passageKey(url)) ?? [];
    const match = entries.find(entry => entry.url.search === url.search) ?? entries.find(entry => overlap(entry.url, url));
    return { mark, at: match?.at ?? end, matched: !!match };
  });
}

export class NotebookHighlight extends WidgetType {
  constructor(private mark: PaperAnnotation, private article: boolean, private locate: (url: URL) => Promise<void>,
    private edit: (id: string, trigger: HTMLElement) => void) { super(); }
  eq(other: NotebookHighlight): boolean {
    return this.mark.id === other.mark.id && this.mark.updatedAt === other.mark.updatedAt;
  }
  toDOM(): HTMLElement {
    const mark = this.mark, url = new URL(mark.sourceUrl);
    const group = el('div', 'notebook-highlight');
    group.dataset.annotationId = mark.id;
    group.dataset.color = mark.color;
    group.contentEditable = 'false';
    group.setAttribute('role', 'group');
    group.ariaLabel = highlightName(mark.color);
    const quote = el('blockquote');
    quote.dir = 'auto';
    quote.append(el('mark', '', visibleQuote(mark)));
    group.append(quote);
    if (mark.text) { const comment = el('p', '', mark.text); comment.dir = 'auto'; group.append(comment); }
    const actions = el('div', 'notebook-highlight-actions');
    const source = this.article ? label('Source paragraph', '原文段落') : label('p. ' + mark.page, '第 ' + mark.page + ' 页');
    const back = button(source, () => this.locate(url), 'text-btn', 'arrow');
    back.ariaLabel = back.title = label('View source', '查看出处') + ' · ' + source;
    const edit = button(label('Edit', '编辑'), () => this.edit(mark.id, edit), 'text-btn');
    edit.ariaLabel = label('Edit highlight', '编辑高亮');
    actions.append(back, edit);
    group.append(actions);
    return group;
  }
}
