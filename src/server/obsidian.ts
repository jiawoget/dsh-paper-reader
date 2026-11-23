import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, copyFileSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { chapterPassageLabel, escapedComments, markdownHeading as heading } from '../shared/notebook-structure.js';
import { quoteLocator, readSelectionRange, readTranslatedLocator, writeSelectionRange, writeTranslatedLocator } from '../shared/source-link.js';
import { ReaderStore, type NotebookChapter } from './reader-store.js';
import { address, isObject, ServiceError, single, stringValue, type Entries, type Entry, type Input } from './service-types.js';
import { vaultMarkdown } from './vault-markdown.js';
import { portableCitation, type VaultSources } from './vault-sources.js';

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function filenameStem(title: string, max = 75): string {
  let name = title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+/g, '').slice(0, max).replace(/[ .]+$/g, '');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name)) name = '_' + name;
  return name || 'Paper';
}
export function filenameFor(title: string, docId: string): string {
  return filenameStem(title) + ' - ' + hash(docId).slice(0, 12) + '.md';
}

export function vaultFolder(vaultPath: string, bookSlug?: string, create = false): string {
  let folder = realpathSync(vaultPath);
  if (!statSync(folder).isDirectory()) throw new ServiceError(400, 'Choose an existing Obsidian vault directory.');
  const segments = ['Paper Reader'];
  if (bookSlug) {
    const name = filenameStem(bookSlug, 160);
    segments.push(name === bookSlug ? name : name + ' - ' + hash(bookSlug).slice(0, 12));
  }
  for (const part of segments) {
    folder = path.join(folder, part);
    if (create) mkdirSync(folder, { recursive: true, mode: 0o700 });
    const info = lstatSync(folder, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || path.relative(folder, realpathSync(folder)) !== '')) {
      throw new ServiceError(409, 'The notebook folder must be inside the selected vault.');
    }
  }
  return folder;
}
export function source(base: string, docId: string, page: number, anchor: string, quote = ''): string {
  const url = new URL(base);
  url.pathname = '/api/paper-reader/app/index.html';
  url.search = '';
  url.hash = '';
  url.searchParams.set('doc', docId);
  url.searchParams.set('page', String(page));
  if (anchor) url.searchParams.set('anchor', anchor);
  if (quote.trim()) url.searchParams.set('quote', quoteLocator(quote));
  return url.href;
}
export function sourceText(entry: Entry, fallback: string, quote = '', section?: string): string {
  const saved = entry.sourceUrl ? new URL(entry.sourceUrl) : undefined;
  const link = new URL(source(fallback || entry.sourceUrl, entry.docId, entry.page, entry.anchor, quote || saved?.searchParams.get('quote') || ''));
  if (saved) {
    writeTranslatedLocator(link, readTranslatedLocator(saved));
    writeSelectionRange(link, readSelectionRange(saved));
  }
  const label = section ? chapterPassageLabel(section, entry.label) : 'Page ' + entry.page + (entry.label ? ' · ' + entry.label : '');
  return '[' + heading(label) + '](<' + link.href + '>)';
}
function vocabulary(base: string, words: Entry[], chapter?: NotebookChapter): string[] {
  const rows = ['## Vocabulary'];
  for (const word of words) {
    rows.push('', '### ' + heading(word.text), '', sourceText(word, base, '', chapter?.sections.get(word.page)?.title));
    if (word.meaning) rows.push('', escapedComments(word.meaning));
    if (word.context) rows.push('', ...escapedComments(word.context).split(/\r?\n/).map(line => '> ' + line));
  }
  return rows;
}
function markdown(title: string, docId: string, base: string, entries: Entries): string {
  const rows = ['# ' + heading(title), '', '[Open in Paper Reader](<' + source(base, docId, 1, '') + '>)'];
  if (entries.notes.length) rows.push('', '## Notes');
  for (const note of entries.notes) {
    rows.push('', sourceText(note, base, note.quote), '');
    if (note.quote) rows.push(...escapedComments(note.quote).split(/\r?\n/).map(line => '> ' + line), '');
    rows.push(escapedComments(note.text));
  }
  if (entries.vocabulary.length) rows.push('', ...vocabulary(base, entries.vocabulary));
  return rows.join('\n');
}
function mergeMarkdown(previous: string, content: string, docId: string): string {
  const prefix = '<!-- Paper Reader ' + hash(docId).slice(0, 20);
  const close = prefix + ' end -->';
  const generated = prefix + ' begin ' + hash(content) + ' -->\n' + content + '\n' + close;
  const start = previous.indexOf(prefix + ' begin ');
  const end = previous.indexOf(close);
  if (start < 0 && end < 0) {
    const outside = previous && !previous.endsWith('\n\n') ? previous + (previous.endsWith('\n') ? '\n' : '\n\n') : previous;
    return outside + generated + '\n';
  }
  const headerEnd = previous.indexOf('-->', start);
  if (start < 0 || end < start || headerEnd < start || headerEnd >= end || previous.indexOf(close, end + close.length) !== -1) {
    throw new ServiceError(409, 'The generated block markers were edited in Obsidian. Restore the markers or rename the file before exporting.');
  }
  // Keep the untouched prefix/suffix verbatim. If the user edited the managed content, keep that version too.
  const embeddedHash = previous.slice(start + (prefix + ' begin ').length, headerEnd).trim();
  const inner = previous.slice(headerEnd + 3, end).replace(/^\r?\n|\r?\n$/g, '');
  const retained = hash(inner.replace(/\r\n/g, '\n')) === embeddedHash ? '' : '\n\n## Edits retained from Obsidian\n\n' + inner;
  return previous.slice(0, start) + generated + retained + previous.slice(end + close.length);
}
export function exportChapterVocabulary(previous: string, key: string, base: string, words: Entry[], chapter?: NotebookChapter): string {
  const id = key + '/vocabulary';
  if (!words.length && !previous.includes('<!-- Paper Reader ' + hash(id).slice(0, 20))) return previous;
  return mergeMarkdown(previous, vocabulary(base, words, chapter).join('\n'), id);
}
export function fileContent(file: string): string | undefined {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new ServiceError(409, 'The vault destination must be a regular Markdown file smaller than 16 MB.');
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export function writeMarkdown(file: string, observed: string | undefined, next: string): void {
  if (observed === next) return;
  const temp = path.join(path.dirname(file), '.paper-reader-' + randomUUID() + '.tmp');
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, next, 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (fileContent(file) !== observed) throw new ServiceError(409, 'The file changed in Obsidian. Refresh the notebook and review your draft.');
    if (observed === undefined) {
      // Publishing a new note must never replace a file created by another writer.
      try { linkSync(temp, file); }
      catch (error) {
        if (isObject(error) && error.code === 'EEXIST') throw new ServiceError(409, 'Another file was created here. Refresh the notebook.');
        if (!isObject(error) || !['EPERM','ENOSYS','ENOTSUP','EXDEV','EMLINK'].includes(String(error.code))) throw error;
        // Some removable and network volumes do not support hard links.
        copyFileSync(temp, file, constants.COPYFILE_EXCL);
      }
    } else renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (!isObject(error) || error.code !== 'ENOENT') throw error; }
  }
}
export function exportNotebook(store: ReaderStore, input: Input, sources: VaultSources, notebook?: string): { path: string; notes: number; words: number } {
  const docId = single(input.docId, 'document ID', 512, true);
  const title = stringValue(input.title, 'paper title', 2048, true);
  const supplied = address(input.sourceUrl);
  return store.notebook(docId, ({ settings, entries, filename, zotero }) => {
    const candidates = [supplied, ...entries.notes.map(row => row.sourceUrl), ...entries.vocabulary.map(row => row.sourceUrl)];
    sources.useSavedSources([zotero?.original ?? '', ...candidates]);
    const base = candidates.find(url => url && /^\/api\/paper-reader\/app\/(?:index\.html)?$/.test(new URL(url).pathname))
      ?? (supplied || 'http://localhost/');
    try {
      const folder = vaultFolder(settings.vaultPath, undefined, true);
      const name = filename ?? filenameFor(title, docId);
      if (name !== path.basename(name) || !name.endsWith('.md')) throw new ServiceError(500, 'The stored note filename is invalid.');
      const file = path.join(folder, name);
      const observed = fileContent(file);
      const content = notebook === undefined ? markdown(title, docId, base, entries) :
        notebook.replace(/^<!-- paper-reader:(?:note|source|end) [\da-f-]+ -->\r?\n?/gm, '').trimEnd() +
          (entries.vocabulary.length ? '\n\n' + vocabulary(base, entries.vocabulary).join('\n') : '');
      const render = (label: string, url: URL) => portableCitation(label, sources.targets(url, settings.vaultPath, folder, zotero?.link));
      const generated = vaultMarkdown(content, docId, render, false);
      // Older exports can include a manually edited managed block. Its edits
      // survive merging, and its existing reader citations become portable too.
      writeMarkdown(file, observed, vaultMarkdown(mergeMarkdown(observed ?? '', generated, docId), docId, render, false));
      return { path: file, notes: entries.notes.length, words: entries.vocabulary.length };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(503, 'Cannot write to the configured Obsidian vault. Check its path and write permissions.');
    }
  });
}
