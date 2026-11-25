import type { DocumentInfo, ZoteroItem } from './types.js';

export interface CitationMetadata {
  title: string;
  authors?: string[];
  venue?: string;
  year?: string;
  doi?: string;
  url?: string;
  arxivId?: string;
  publisher?: string;
  abstract?: string;
  kind?: 'pdf' | 'web' | 'book';
  zoteroType?: string;
  id?: string;
}

const ARXIV_NEW = '\\d{4}\\.\\d{4,5}';
const ARXIV_OLD = '[a-z-]+(?:\\.[a-z]{2})?\\/\\d{7}';
const ARXIV_ID_SOURCE = `(?:${ARXIV_NEW}|${ARXIV_OLD})`;
const ARXIV_PATH_RE = new RegExp(`^\\/(?:abs|pdf|html|e-print|format)\\/(${ARXIV_ID_SOURCE})(?:v\\d+)?(?:\\.pdf)?\\/?$`, 'i');
const ARXIV_DOI_RE = new RegExp(`^(?:https?:\\/\\/(?:dx\\.)?doi\\.org\\/|doi:\\s*)?10\\.48550\\/arxiv\\.(${ARXIV_ID_SOURCE})(?:v\\d+)?\\/?$`, 'i');
const ARXIV_BARE_RE = new RegExp(`^(?:arxiv:\\s*)?(${ARXIV_ID_SOURCE})(?:v\\d+)?$`, 'i');
const YEAR_RE = /(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/;
const NAME_SUFFIX_RE = /^(?:jr\.?|sr\.?|ii|iii|iv|v|ph\.?d\.?|m\.?d\.?)$/i;
const NOBILIARY_PARTICLE_RE = /^(?:van|von|de|del|della|di|da|du|la|le|der|den|ter|ten|dos|das)\b/i;
const CONFERENCE_VENUE_RE = /\b(?:sosp|osdi|nsdi|sigcomm|sigmod|vldb|icml|neurips|nips|iclr|cvpr|iccv|eccv|acl|emnlp|naacl|aaai|ijcai|chi|uist|pldi|popl|icse|fse|ase|ccs|ndss|usenix|eurosys|asplos|isca|micro|hpca|sc|kdd|www|icde|pods|stoc|focs|soda|crypto|eurocrypt|proc(?:eedings)?|conf(?:erence)?|symp(?:osium)?|workshop|colloquium|congress)\b/i;
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'on', 'in', 'for', 'to', 'and', 'or', 'with',
  'by', 'from', 'at', 'as', 'into', 'about', 'via', 'using', 'towards', 'toward'
]);

const LATIN_FOLD: Record<string, string> = {
  'ß': 'ss', 'ø': 'o', 'Ø': 'o', 'ł': 'l', 'Ł': 'l',
  'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe',
  'ð': 'd', 'Ð': 'd', 'þ': 'th', 'Þ': 'th', 'đ': 'd', 'Đ': 'd'
};

const BIBTEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\textbraceleft{}',
  '}': '\\textbraceright{}',
  '%': '\\%',
  '&': '\\&',
  '#': '\\#',
  '_': '\\_',
  '$': '\\$',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}'
};

const ZOTERO_BIBTEX_TYPES: Record<string, string> = {
  journalarticle: 'article',
  magazinearticle: 'article',
  newspaperarticle: 'article',
  conferencepaper: 'inproceedings',
  book: 'book',
  booksection: 'incollection',
  thesis: 'phdthesis',
  report: 'techreport',
  preprint: 'misc',
  webpage: 'misc',
  blogpost: 'misc',
  document: 'misc',
  manuscript: 'misc'
};

const ZOTERO_RIS_TYPES: Record<string, string> = {
  journalarticle: 'JOUR',
  conferencepaper: 'CONF',
  book: 'BOOK',
  booksection: 'CHAP',
  thesis: 'THES',
  report: 'RPRT',
  magazinearticle: 'MGZN',
  newspaperarticle: 'NEWS',
  webpage: 'ELEC',
  blogpost: 'ELEC',
  preprint: 'GEN',
  document: 'GEN',
  manuscript: 'GEN'
};

function nonEmpty(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && normalizeInline(trimmed) ? trimmed : undefined;
}

function cleanDoi(value?: string | null): string | undefined {
  const raw = nonEmpty(value);
  if (!raw) return undefined;
  const stripped = raw
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
  return stripped || undefined;
}

function stripPdfExtension(value?: string | null): string | undefined {
  const raw = nonEmpty(value);
  if (!raw) return undefined;
  const stripped = raw.replace(/\.pdf$/i, '').trim();
  return stripped || raw;
}

function foldAscii(value: string): string {
  return value
    .replace(/[ßøØłŁæÆœŒðÐþÞđĐ]/g, ch => LATIN_FOLD[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function fnv1aHex(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function normalizeInline(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeBibTeX(value: string): string {
  return normalizeInline(value).replace(/[\\{}%&#_$~^]/g, ch => BIBTEX_ESCAPES[ch] ?? ch);
}

function sanitizeBibTeXUrl(value: string): string {
  return value
    .replace(/[\r\n\t\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, '')
    .trim()
    .replace(/\\/g, '%5C')
    .replace(/\{/g, '%7B')
    .replace(/\}/g, '%7D');
}

function sanitizeBibTeXIdentifier(value: string): string {
  return value
    .replace(/[\r\n\t\u0000-\u001f\u007f\u0085\u2028\u2029{}\\]+/g, '')
    .trim();
}

function splitCommaAuthors(segment: string): string[] {
  if (!segment.includes(',')) return [segment];
  const parts = segment.split(/\s*,\s*/).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return parts;
  if (parts.some(part => NAME_SUFFIX_RE.test(part))) return [segment];
  if (NOBILIARY_PARTICLE_RE.test(parts[0])) return [segment];
  const allMultiWord = parts.every(part => part.split(/\s+/).length >= 2);
  return allMultiWord ? parts : [segment];
}

export function parseAuthors(raw?: string): string[] {
  const cleaned = nonEmpty(raw)?.replace(/\s+/g, ' ');
  if (!cleaned) return [];

  let source = cleaned;
  let trailingEtAl = false;
  if (/,\s*et\s+al\.?$/i.test(source)) {
    source = source.replace(/,\s*et\s+al\.?$/i, '').trim();
    trailingEtAl = true;
  }

  let segments: string[];
  if (source.includes(';')) {
    segments = source.split(/\s*;\s*/);
  } else if (source.includes('、')) {
    segments = source.split(/\s*、\s*/);
  } else {
    segments = source
      .split(/\s*,\s+and\s+|\s+and\s+|\s*,\s*&\s+|\s+&\s+/i)
      .flatMap(segment => splitCommaAuthors(segment.trim()));
  }

  const authors: string[] = [];
  for (const part of segments) {
    const trimmed = part.trim().replace(/^,+|,+$/g, '').trim();
    if (!trimmed) continue;
    if (/^et\s+al\.?$/i.test(trimmed)) {
      if (authors.length && !/\bet\s+al\.?$/i.test(authors[authors.length - 1])) {
        authors[authors.length - 1] += ' et al.';
      }
      continue;
    }
    authors.push(trimmed);
  }

  if (trailingEtAl && authors.length && !/\bet\s+al\.?$/i.test(authors[authors.length - 1])) {
    authors[authors.length - 1] += ' et al.';
  }
  return authors;
}

export function extractArxivId(url?: string, doi?: string): string | undefined {
  const rawUrl = nonEmpty(url);
  if (rawUrl) {
    const parsed = URL.parse(rawUrl);
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      if (/(?:^|\.)arxiv\.org$/i.test(parsed.hostname)) {
        const match = ARXIV_PATH_RE.exec(parsed.pathname);
        if (match) return match[1].toLowerCase();
      }
      if (/^(?:dx\.)?doi\.org$/i.test(parsed.hostname)) {
        const doiPath = parsed.pathname.slice(1);
        if (doiPath.startsWith('10.')) {
          const match = ARXIV_DOI_RE.exec(doiPath);
          if (match) return match[1].toLowerCase();
        }
      }
    } else if (!parsed || parsed.protocol === 'arxiv:' || parsed.protocol === 'doi:') {
      const bare = ARXIV_BARE_RE.exec(rawUrl);
      if (bare) return bare[1].toLowerCase();
      const doiInUrl = ARXIV_DOI_RE.exec(rawUrl);
      if (doiInUrl) return doiInUrl[1].toLowerCase();
    }
  }

  const rawDoi = nonEmpty(doi);
  if (rawDoi) {
    const match = ARXIV_DOI_RE.exec(rawDoi);
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

export function extractYear(date?: string, venue?: string, createdAt?: string): string | undefined {
  for (const candidate of [date, venue, createdAt]) {
    const text = nonEmpty(candidate);
    if (!text) continue;
    const match = YEAR_RE.exec(text);
    if (match) return match[1];
  }
  return undefined;
}

export function buildCitationMetadata(doc: DocumentInfo, zotero?: ZoteroItem | null): CitationMetadata {
  const isBook = Boolean(doc.book);
  const title = nonEmpty(zotero?.title) ?? nonEmpty(doc.paperTitle) ?? stripPdfExtension(doc.title) ?? 'Untitled';
  const zoteroAuthors = parseAuthors(zotero?.creator);
  const authors = zoteroAuthors.length ? zoteroAuthors : parseAuthors(doc.authors);
  const venue = isBook ? undefined : nonEmpty(doc.venue);
  const publisher = nonEmpty(doc.publisher) ?? (isBook ? nonEmpty(doc.venue) : undefined);
  const year = extractYear(zotero?.date) ?? extractYear(doc.year, doc.venue);
  const doi = cleanDoi(zotero?.doi) ?? cleanDoi(doc.doi);
  const url = nonEmpty(zotero?.url) ?? nonEmpty(doc.url);
  const arxivId = extractArxivId(url, doi) ?? extractArxivId(doc.url, doc.doi);
  const abstract = nonEmpty(doc.abstract);
  const zoteroType = nonEmpty(zotero?.type);
  const id = nonEmpty(doc.id);

  return {
    title,
    ...(authors.length ? { authors } : {}),
    ...(venue ? { venue } : {}),
    ...(year ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(url ? { url } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(publisher ? { publisher } : {}),
    ...(abstract ? { abstract } : {}),
    kind: isBook ? 'book' : doc.kind,
    ...(zoteroType ? { zoteroType } : {}),
    ...(id ? { id } : {})
  };
}

export function buildCiteKey(meta: CitationMetadata): string {
  const firstAuthor = nonEmpty(meta.authors?.[0]);
  let authorPart = '';
  if (firstAuthor) {
    const withoutEtAl = firstAuthor.replace(/\s+et\s+al\.?$/i, '').trim();
    const surname = withoutEtAl.includes(',')
      ? withoutEtAl.split(',')[0].trim()
      : (withoutEtAl.split(/\s+/).at(-1) ?? '');
    authorPart = foldAscii(surname).replace(/[^a-z0-9]+/g, '').slice(0, 24);
  }

  const yearPart = extractYear(meta.year) ?? '';
  const foldedTitle = foldAscii(stripPdfExtension(meta.title) ?? '');
  const titleTokens = foldedTitle.match(/[a-z0-9]+/g) ?? [];
  const titleWord = titleTokens.find(token => !TITLE_STOPWORDS.has(token)) ?? titleTokens[0] ?? '';
  const titlePart = titleWord.slice(0, 24);

  if (authorPart || titlePart) {
    return `${authorPart}${yearPart}${titlePart}`;
  }

  const seed = [meta.id ?? '', meta.title ?? '', (meta.authors ?? []).join(';'), yearPart].join('|');
  return `ref${yearPart}${fnv1aHex(seed)}`;
}

function resolveBibTeXType(meta: CitationMetadata): string {
  const zoteroKey = nonEmpty(meta.zoteroType)?.toLowerCase();
  if (zoteroKey && Object.hasOwn(ZOTERO_BIBTEX_TYPES, zoteroKey)) return ZOTERO_BIBTEX_TYPES[zoteroKey];
  if (meta.kind === 'book') return 'book';
  const venue = nonEmpty(meta.venue);
  if (venue) return CONFERENCE_VENUE_RE.test(venue) ? 'inproceedings' : 'article';
  return 'misc';
}

function formatBibTeXAuthors(authors?: string[]): string | undefined {
  if (!authors?.length) return undefined;
  const formatted = authors
    .map(author => normalizeInline(author ?? ''))
    .filter(Boolean)
    .map(author => {
      if (/\s+et\s+al\.?$/i.test(author)) {
        const base = author.replace(/\s+et\s+al\.?$/i, '').trim();
        return base ? `${escapeBibTeX(base)} and others` : 'others';
      }
      return escapeBibTeX(author);
    })
    .filter(Boolean);
  return formatted.length ? formatted.join(' and ') : undefined;
}

export function formatBibTeX(meta: CitationMetadata): string {
  const type = resolveBibTeXType(meta);
  const key = buildCiteKey(meta);
  const title = escapeBibTeX(meta.title ?? '') || 'Untitled';
  const fields: [string, string][] = [['title', title]];

  const author = formatBibTeXAuthors(meta.authors);
  if (author) fields.push(['author', author]);

  const venue = meta.venue ? escapeBibTeX(meta.venue) : '';
  if (venue) {
    const fieldName =
      type === 'inproceedings' || type === 'incollection' ? 'booktitle' :
      type === 'article' ? 'journal' :
      type === 'techreport' ? 'institution' :
      type === 'phdthesis' ? 'school' : 'howpublished';
    fields.push([fieldName, venue]);
  }

  const publisher = meta.publisher ? escapeBibTeX(meta.publisher) : '';
  if (publisher) fields.push(['publisher', publisher]);

  const year = extractYear(meta.year);
  if (year) fields.push(['year', year]);

  const doi = cleanDoi(meta.doi);
  if (doi) {
    const safeDoi = sanitizeBibTeXIdentifier(doi);
    if (safeDoi) fields.push(['doi', safeDoi]);
  }

  const url = nonEmpty(meta.url);
  if (url) {
    const safeUrl = sanitizeBibTeXUrl(url);
    if (safeUrl) fields.push(['url', safeUrl]);
  }

  const arxivId = nonEmpty(meta.arxivId) ?? extractArxivId(meta.url, meta.doi);
  if (arxivId) {
    const safeArxiv = sanitizeBibTeXIdentifier(arxivId);
    if (safeArxiv) {
      fields.push(['eprint', safeArxiv]);
      fields.push(['archivePrefix', 'arXiv']);
    }
  }

  const abstract = meta.abstract ? escapeBibTeX(meta.abstract) : '';
  if (abstract) fields.push(['abstract', abstract]);

  const body = fields.map(([name, value]) => `  ${name} = {${value}}`).join(',\n');
  return `@${type}{${key},\n${body}\n}`;
}

function resolveRISType(meta: CitationMetadata): string {
  const zoteroKey = nonEmpty(meta.zoteroType)?.toLowerCase();
  if (zoteroKey && Object.hasOwn(ZOTERO_RIS_TYPES, zoteroKey)) return ZOTERO_RIS_TYPES[zoteroKey];
  if (meta.kind === 'book') return 'BOOK';
  const venue = nonEmpty(meta.venue);
  if (venue) return CONFERENCE_VENUE_RE.test(venue) ? 'CONF' : 'JOUR';
  if (meta.kind === 'web' && nonEmpty(meta.url)) return 'ELEC';
  return 'GEN';
}

export function formatRIS(meta: CitationMetadata): string {
  const type = resolveRISType(meta);
  const lines: string[] = [
    `TY  - ${type}`,
    `TI  - ${normalizeInline(meta.title ?? '') || 'Untitled'}`
  ];

  for (const author of meta.authors ?? []) {
    const value = normalizeInline(author);
    if (value) lines.push(`AU  - ${value}`);
  }

  const year = extractYear(meta.year);
  if (year) lines.push(`PY  - ${year}`);

  const venue = nonEmpty(meta.venue);
  if (venue) {
    const cleanVenue = normalizeInline(venue);
    if (cleanVenue) lines.push(`${type === 'JOUR' ? 'JO' : 'T2'}  - ${cleanVenue}`);
  }

  const publisher = nonEmpty(meta.publisher);
  if (publisher) {
    const cleanPublisher = normalizeInline(publisher);
    if (cleanPublisher) lines.push(`PB  - ${cleanPublisher}`);
  }

  const doi = cleanDoi(meta.doi);
  if (doi) {
    const cleanDoiValue = normalizeInline(doi);
    if (cleanDoiValue) lines.push(`DO  - ${cleanDoiValue}`);
  }

  const url = nonEmpty(meta.url);
  if (url) {
    const cleanUrl = normalizeInline(url);
    if (cleanUrl) lines.push(`UR  - ${cleanUrl}`);
  }

  const arxivId = nonEmpty(meta.arxivId) ?? extractArxivId(meta.url, meta.doi);
  if (arxivId) {
    const cleanArxiv = normalizeInline(arxivId);
    if (cleanArxiv) lines.push(`N1  - arXiv:${cleanArxiv}`);
  }

  const abstract = nonEmpty(meta.abstract);
  if (abstract) {
    const cleanAbstract = normalizeInline(abstract);
    if (cleanAbstract) lines.push(`AB  - ${cleanAbstract}`);
  }

  lines.push('ER  - ');
  return lines.join('\n');
}
