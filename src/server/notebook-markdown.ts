import { chapterPassageLabel, markdownHeading as heading, notebookBlocks, type Block } from '../shared/notebook-structure.js';
import type { NotebookSnapshot } from '../shared/types.js';
import { source, sourceText } from './obsidian.js';
import type { NotebookRecords, StoredNotebook } from './reader-store.js';
import { address, ServiceError, type Entry, type Input } from './service-types.js';

export function blocks(markdown: string): Block[] {
  try { return notebookBlocks(markdown); }
  catch (error) { throw new ServiceError(409, (error as Error).message); }
}

function formatNote(note: Entry, doc: Omit<StoredNotebook, 'markdown'>): string {
  const section = doc.chapter?.sections.get(note.page);
  const reference = [sourceText(note, doc.sourceUrl, note.quote, section?.title)];
  if (section) reference.push('[OpenStax · ' + heading(section.title) + '](<' + section.url + '>)');
  const quoted = (text: string) => text.split(/\r?\n/).map(line => '> ' + line).join('\n');
  if (note.quote) reference.push(quoted(note.quote));
  if (note.context && note.context !== note.quote) reference.push('**Selected text**', quoted(note.context));
  return ['<!-- paper-reader:note ' + note.id + ' -->', note.text, '<!-- paper-reader:source ' + note.id + ' -->',
    ...reference, '<!-- paper-reader:end ' + note.id + ' -->'].join('\n\n');
}

export function initialMarkdown(doc: Omit<StoredNotebook, 'markdown'>, notes: Entry[]): string {
  return ['# ' + heading(doc.chapter?.title ?? doc.title.replace(/\.pdf$/i, '')),
    '[Open in Paper Reader](<' + source(doc.sourceUrl, doc.docId, doc.chapter?.firstPage ?? 1, '') + '>)',
    ...notes.map(note => formatNote(note, doc))].join('\n\n') + '\n';
}

export function putNote(markdown: string, note: Entry, doc: StoredNotebook, beforeId?: string): string {
  const parsed = blocks(markdown);
  const current = parsed.find(block => block.id === note.id);
  if (current) return markdown.slice(0, current.bodyStart) + note.text + markdown.slice(current.bodyEnd);
  const before = beforeId && parsed.find(block => block.id === beforeId);
  if (beforeId && !before) throw new ServiceError(409, 'The note at this insertion point moved or was deleted. Choose a new position.');
  const at = before ? before.start : markdown.length;
  const prefix = markdown.slice(0, at);
  const spacing = !prefix || /\n\s*\n$/.test(prefix) ? '' : prefix.endsWith('\n') ? '\n' : '\n\n';
  return prefix + spacing + formatNote(note, doc) + (before ? '\n\n' : '\n') + markdown.slice(at);
}

export function withoutNote(markdown: string, id: string): string {
  const block = blocks(markdown).find(item => item.id === id);
  if (!block) return markdown;
  const tail = markdown.slice(block.end).replace(/^(?:\r?\n){1,2}/, '');
  return markdown.slice(0, block.start) + tail;
}

function sourceFields(doc: StoredNotebook, block: Block, previous?: Entry): Input {
  const match = block.reference.match(/^\[((?:\\.|[^\]\\\r\n])+)\]\(<([^>\r\n]+)>\)/m);
  const caption = match?.[1].replace(/\\(.)/g, '$1') ?? '';
  const legacy = /^Page \d+(?: · (.*))?$/.exec(caption);
  if (!match || !legacy && (!doc.chapter || caption.startsWith('OpenStax · '))) {
    return previous ? { ...previous } : { docId: doc.docId, title: doc.title, page: doc.chapter?.firstPage ?? 1, sourceUrl: doc.sourceUrl };
  }
  const link = new URL(address(match[2], true));
  if (link.searchParams.get('doc') !== doc.docId || link.pathname !== '/api/paper-reader/app/index.html') {
    throw new ServiceError(409, 'A source link belongs to a different document. Check the link in the Markdown file.');
  }
  const page = Number(link.searchParams.get('page'));
  const section = doc.chapter?.sections.get(page);
  if (doc.chapter && !section) throw new ServiceError(409, 'A linked note belongs to another chapter. Check its passage link.');
  let label = legacy?.[1] ?? '';
  if (!legacy && section) {
    const prefix = section.title + ' · ';
    if (previous && chapterPassageLabel(section.title, previous.label) === caption) label = previous.label;
    else if (caption !== section.title) label = caption.startsWith(prefix) ? caption.slice(prefix.length) : caption;
  }
  const [original, selected] = block.reference.split(/\r?\n\r?\n\*\*Selected text\*\*\r?\n\r?\n/);
  const unquote = (text: string) => text.split(/\r?\n/).filter(line => line.startsWith('>')).map(line => line.replace(/^> ?/, '')).join('\n');
  const quote = unquote(original);
  return { docId: doc.docId, title: doc.title, page, anchor: link.searchParams.get('anchor') || '',
    sourceUrl: link.href, label, quote, context: selected ? unquote(selected) : quote };
}

export function reconcileNotes(records: NotebookRecords, doc: StoredNotebook, previous: string, next: string): void {
  if (previous === next) return;
  const old = new Map(blocks(previous).map(block => [block.id, block]));
  for (const block of blocks(next)) {
    const prior = records.note(block.id);
    if (prior && prior.docId !== doc.docId) throw new ServiceError(409, 'A note ID already belongs to another document.');
    if (prior && doc.chapter && !doc.chapter.sections.has(prior.page)) throw new ServiceError(409, 'A note ID already belongs to another chapter.');
    const oldBlock = old.get(block.id);
    old.delete(block.id);
    const text = next.slice(block.bodyStart, block.bodyEnd);
    if (prior && prior.text === text && oldBlock?.reference === block.reference) continue;
    const fields = !prior || oldBlock?.reference !== block.reference ? sourceFields(doc, block, prior) : {};
    records.save({ ...fields, id: prior?.id, text, insert: true }, prior ? undefined : block.id, true);
  }
  for (const id of old.keys()) records.remove({id});
}

export function contentFor(markdown: string, entries: Entry[]): Pick<NotebookSnapshot, 'notes' | 'parts'> {
  const indexed = new Map(entries.map(note => [note.id, note]));
  const notes: Entry[] = [];
  const parts: NotebookSnapshot['parts'] = [];
  let position = 0;
  const addFreeText = (end: number) => {
    let free = markdown.slice(position, end);
    if (position === 0) free = free.replace(/^# [^\r\n]*\r?\n\r?\n\[Open in Paper Reader\]\(<[^>]+>\)\r?\n?/, '');
    if (free.trim()) parts.push({markdown:free});
  };
  for (const block of blocks(markdown)) {
    addFreeText(block.start);
    const note = indexed.get(block.id);
    if (note) { notes.push(note); parts.push({ noteId: block.id }); }
    position = block.end;
  }
  addFreeText(markdown.length);
  return { notes, parts };
}
