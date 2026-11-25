import { ANNOTATION_COLOR_META, type PaperAnnotation } from './annotations.js';
import { buildCitationMetadata, buildCiteKey } from './citation-export.js';
import { chapterPassageLabel, escapedComments, markdownHeading as heading } from './notebook-structure.js';
import type { DocumentInfo, JournalNote, WordRecord, ZoteroItem } from './types.js';

interface ReadingPackZotero {
  key?: string; title?: string; type?: string; creator?: string; date?: string;
  url?: string; doi?: string; webUrl?: string; link?: string; original?: string;
}
type ReadingPackNotes = string | readonly JournalNote[];
type ReadingPackWord = Pick<WordRecord, 'text' | 'meaning' | 'context' | 'page' | 'label' | 'sourceUrl'>;
interface HighlightsFormatOptions {
  sectionTitle?: (page: number) => string | undefined;
  formatLink?: (annotation: PaperAnnotation) => string;
  isWeb?: boolean;
}

const READER_ROUTE = /^\/api\/paper-reader\/app\/(?:index\.html)?$/;
const MARKER_LINE = /^<!-- paper-reader:(?:note|source|end) [\da-f-]+ -->\n?/gm;
const LEADING_HEADER = /^# [^\n]*\n\n\[Open in Paper Reader\]\(<[^>]+>\)\n*/;
const DEF_LINE = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s\n]+))[ \t]*$/;
const INLINE_LINK = /\[((?:\\.|[^\]\\\n])+)\]\((?:<([^>\n]+)>|([^)\s\n]+))\)/g;
const REF_LINK = /\[((?:\\.|[^\]\\\n])+)\]\[([^\]]+)\]/g;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost') || lower === '[::1]' || lower === '::1' ||
    lower === '0.0.0.0' || lower === '[::]' || /^127(?:\.\d{1,3}){3}$/.test(lower);
}

function safePublicUrl(raw?: string): string | undefined {
  const url = raw?.trim() ? URL.parse(raw.trim()) : null;
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined;
  if (url.username || url.password || isLoopbackHost(url.hostname) || READER_ROUTE.test(url.pathname)) return undefined;
  return url.href;
}

function safeZoteroUrl(raw?: string): string | undefined {
  const url = raw?.trim() ? URL.parse(raw.trim()) : null;
  if (!url || !['http:', 'https:', 'zotero:'].includes(url.protocol) || url.username || url.password) return undefined;
  if (url.protocol !== 'zotero:' && (isLoopbackHost(url.hostname) || READER_ROUTE.test(url.pathname))) return undefined;
  return url.href;
}

function isReaderLocalUrl(raw: string): URL | undefined {
  const url = URL.parse(raw.trim());
  return url && (READER_ROUTE.test(url.pathname) || isLoopbackHost(url.hostname)) ? url : undefined;
}

function toZoteroItem(zotero?: ReadingPackZotero | null): ZoteroItem | null {
  if (!zotero) return null;
  const url = safePublicUrl(zotero.url) ?? safePublicUrl(zotero.original);
  return {
    key: zotero.key ?? '', title: zotero.title ?? '', type: zotero.type ?? '',
    creator: zotero.creator ?? '', date: zotero.date ?? '', collections: [],
    ...(url ? { url } : {}), ...(zotero.doi ? { doi: zotero.doi } : {}), ...(zotero.webUrl ? { webUrl: zotero.webUrl } : {})
  };
}

const yamlInline = (text: string) => text.replace(/[\r\n\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').trim();
const yamlQuoted = (text: string) => '"' + yamlInline(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const blockquote = (text: string) => escapedComments(text.replace(/\r\n?/g, '\n').trim()).split('\n').map(line => (line ? '> ' + line : '>')).join('\n');

function isLiveAnnotation(item: PaperAnnotation | null | undefined): item is PaperAnnotation {
  if (!item || typeof item !== 'object') return false;
  if ('content' in item && item.content === null) return false;
  if (item.kind !== 'highlight' && item.kind !== 'pin') return false;
  if (typeof item.page !== 'number' || !Number.isFinite(item.page) || item.page < 1) return false;
  if (typeof item.id !== 'string' || typeof item.quote !== 'string' || typeof item.text !== 'string') return false;
  return !(item.kind === 'pin' && !item.text.trim() && !item.quote.trim());
}

function pdfPageLink(publicUrl: string | undefined, page: number): string | undefined {
  if (!publicUrl || !Number.isSafeInteger(page) || page < 1) return undefined;
  const parsed = URL.parse(publicUrl);
  if (!parsed || !(/\.pdf$/i.test(parsed.pathname) || /\/pdf\//.test(parsed.pathname))) return undefined;
  parsed.hash = 'page=' + page;
  return parsed.href;
}

function portableLabelLink(caption: string, url: URL, publicPdfUrl?: string): string {
  if (caption === 'Open in Paper Reader') return '';
  const target = pdfPageLink(publicPdfUrl, Number(url.searchParams.get('page')));
  return target ? `[${caption}](<${target}>)` : caption;
}

function cleanNotebookMarkdown(raw: string, publicPdfUrl?: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n').replace(MARKER_LINE, '').replace(LEADING_HEADER, '');
  const removedDefs = new Map<string, URL>();
  const kept: { text: string; fenced: boolean }[] = [];
  let fence = '';
  for (const line of normalized.split('\n')) {
    const border = FENCE_LINE.exec(line);
    if (border && !fence) { fence = border[1]; kept.push({ text: line, fenced: true }); continue; }
    if (fence) {
      kept.push({ text: line, fenced: true });
      if (border && border[1][0] === fence[0] && border[1].length >= fence.length && !border[2].trim()) fence = '';
      continue;
    }
    const def = DEF_LINE.exec(line), defUrl = def && isReaderLocalUrl(def[2] ?? def[3]);
    if (def && defUrl) { removedDefs.set(def[1].toLowerCase(), defUrl); continue; }
    kept.push({ text: line, fenced: false });
  }
  return kept.map(({ text, fenced }) => fenced ? text : text
    .replace(INLINE_LINK, (whole, caption: string, angle?: string, bare?: string) => {
      const local = isReaderLocalUrl(angle ?? bare ?? '');
      return local ? portableLabelLink(caption, local, publicPdfUrl) : whole;
    })
    .replace(REF_LINK, (whole, caption: string, refId: string) => {
      const local = removedDefs.get(refId.toLowerCase());
      return local ? portableLabelLink(caption, local, publicPdfUrl) : whole;
    })
  ).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function formatJournalNotes(doc: DocumentInfo, notes: readonly JournalNote[], publicPdfUrl?: string): string {
  const parts: string[] = [];
  for (const note of notes) {
    if (!note.text.trim() && !note.quote.trim()) continue;
    const section = doc.book?.sections[note.page - 1];
    const loc = section ? heading(chapterPassageLabel(section.title, note.label))
      : doc.kind === 'web' && !doc.book ? heading(note.label.trim() || 'Article')
      : 'Page ' + note.page + (note.label.trim() ? ' · ' + heading(note.label.trim()) : '');
    const href = doc.kind === 'pdf' ? pdfPageLink(publicPdfUrl, note.page) : undefined;
    parts.push(href ? `[${loc}](<${href}>)` : `**${loc}**`);
    if (note.quote.trim()) parts.push(blockquote(note.quote));
    if (note.text.trim()) parts.push(escapedComments(note.text.replace(/\r\n?/g, '\n').trim()));
  }
  return parts.length ? '## Notes\n\n' + parts.join('\n\n') : '';
}

function formatVocabularySection(vocabulary?: readonly ReadingPackWord[]): string {
  if (!vocabulary?.length) return '';
  const parts: string[] = ['## Vocabulary'];
  for (const word of vocabulary) {
    if (!word.text.trim()) continue;
    parts.push('### ' + heading(word.text.trim()));
    if (word.meaning.trim()) parts.push(escapedComments(word.meaning.replace(/\r\n?/g, '\n').trim()));
    if (word.context.trim()) parts.push(blockquote(word.context));
  }
  return parts.length > 1 ? parts.join('\n\n') : '';
}

export function formatYamlFrontmatter(doc: DocumentInfo, zotero?: ReadingPackZotero | null): string {
  const meta = buildCitationMetadata(doc, toZoteroItem(zotero));
  const lines: string[] = ['---', 'title: ' + yamlQuoted(meta.title)];
  const authors = (meta.authors ?? []).map(yamlInline).filter(Boolean);
  if (authors.length) { lines.push('authors:'); for (const author of authors) lines.push('  - ' + yamlQuoted(author)); }
  if (meta.year && /^\d{4}$/.test(meta.year)) lines.push('year: ' + meta.year);
  const venue = yamlInline(meta.venue ?? meta.publisher ?? '');
  if (venue) lines.push('venue: ' + yamlQuoted(venue));
  const doi = yamlInline(meta.doi ?? '');
  if (doi) lines.push('doi: ' + yamlQuoted(doi));
  const citekey = yamlInline(buildCiteKey(meta));
  if (citekey) lines.push('citekey: ' + (/^[a-z0-9_-]+$/i.test(citekey) ? citekey : yamlQuoted(citekey)));
  const publicUrl = safePublicUrl(meta.url) ?? safePublicUrl(doc.url) ?? safePublicUrl(zotero?.original);
  if (publicUrl) lines.push('url: ' + yamlQuoted(publicUrl));
  const zoteroUrl = safeZoteroUrl(zotero?.link) ?? safeZoteroUrl(zotero?.webUrl);
  if (zoteroUrl) lines.push('zotero: ' + yamlQuoted(zoteroUrl));
  lines.push('---');
  return lines.join('\n');
}

export function formatHighlightsSection(
  annotations: readonly (PaperAnnotation | null | undefined)[],
  options?: HighlightsFormatOptions
): string {
  const live = annotations.filter(isLiveAnnotation)
    .sort((a, b) => a.page - b.page || (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  if (!live.length) return '';
  const blocks: string[] = ['## Highlights & Page Notes'];
  let currentPage = 0;
  for (const ann of live) {
    if (!options?.isWeb && ann.page !== currentPage) {
      currentPage = ann.page;
      const section = options?.sectionTitle?.(ann.page)?.trim();
      blocks.push('### ' + (section ? heading(section) : 'Page ' + ann.page));
    }
    const meta = ANNOTATION_COLOR_META[ann.color] ?? ANNOTATION_COLOR_META.yellow;
    const badge = ann.kind === 'pin' ? '**Page note**' : `**${meta.en} · ${meta.meaningEn}**`;
    const label = ann.label.trim();
    const loc = options?.formatLink ? options.formatLink(ann)
      : label && !(ann.kind === 'pin' && (label === 'Page note' || label === '页边笔记')) ? heading(label) : '';
    blocks.push(loc ? `${badge} · ${loc}` : badge);
    if (ann.quote.trim()) blocks.push(blockquote(ann.quote));
    if (ann.text.trim()) blocks.push(escapedComments(ann.text.replace(/\r\n?/g, '\n').trim()));
  }
  return blocks.join('\n\n');
}

export function readingPackFilename(doc: DocumentInfo, zotero?: ReadingPackZotero | null): string {
  const key = buildCiteKey(buildCitationMetadata(doc, toZoteroItem(zotero))).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'reading-pack';
  return key + '.md';
}

export function formatReadingPackMarkdown(
  doc: DocumentInfo,
  notes: ReadingPackNotes,
  annotations: readonly (PaperAnnotation | null | undefined)[],
  vocabulary?: readonly ReadingPackWord[],
  zotero?: ReadingPackZotero | null
): string {
  const meta = buildCitationMetadata(doc, toZoteroItem(zotero));
  const publicUrl = safePublicUrl(meta.url) ?? safePublicUrl(doc.url) ?? safePublicUrl(zotero?.original);
  const notesSection = typeof notes === 'string'
    ? (() => { const cleaned = cleanNotebookMarkdown(notes, publicUrl); return !cleaned ? '' : /^## Notes(?:\n|$)/.test(cleaned) ? cleaned : '## Notes\n\n' + cleaned; })()
    : formatJournalNotes(doc, notes, publicUrl);
  const highlightsSection = formatHighlightsSection(annotations, {
    sectionTitle: doc.book ? page => doc.book?.sections[page - 1]?.title : undefined,
    isWeb: doc.kind === 'web' && !doc.book
  });
  return [formatYamlFrontmatter(doc, zotero), '# ' + heading(meta.title), notesSection, highlightsSection, formatVocabularySection(vocabulary)]
    .filter(Boolean).join('\n\n') + '\n';
}
