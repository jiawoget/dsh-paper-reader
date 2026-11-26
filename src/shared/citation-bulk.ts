import type { DocumentInfo } from './types.js';
import { buildCitationMetadata, extractYear, formatBibTeX, formatRIS } from './citation-export.js';

export type BulkRefFormat = 'bibtex' | 'ris' | 'csv';
export interface BulkRefEntry {
  title: string; paperTitle?: string; authors?: string; venue?: string;
  year?: string; doi?: string; url?: string; publisher?: string; abstract?: string; tags?: string[];
}

const ACCENTS: Record<string, string> = {
  "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303',
  '=': '\u0304', '.': '\u0307', c: '\u0327', v: '\u030c', u: '\u0306', H: '\u030b', r: '\u030a', k: '\u0328'
};
const SPECIAL: Record<string, string> = {
  ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł'
};
const clean = (raw?: string) => raw?.replace(/\s+/g, ' ').trim() || undefined;
const splitTags = (raw?: string) => { const t = raw?.split(/[;,]/).map(s => s.trim()).filter(Boolean) ?? []; return t.length ? [...new Set(t)] : undefined; };
function makeEntry(r: Partial<BulkRefEntry>): BulkRefEntry | undefined {
  const title = clean(r.title);
  if (!title) return undefined;
  return {
    title, paperTitle: title, ...(r.authors && { authors: r.authors }), ...(r.venue && { venue: r.venue }),
    ...(r.publisher && { publisher: r.publisher }), ...(r.year && { year: r.year }), ...(r.doi && { doi: r.doi }),
    ...(r.url && { url: r.url }), ...(r.abstract && { abstract: r.abstract }), ...(r.tags?.length && { tags: [...new Set(r.tags)] })
  };
}
function unescapeLatex(raw: string): string {
  return raw
    .replace(/\\textbraceleft\{\}|\\\{/g, '\uE000').replace(/\\textbraceright\{\}|\\\}/g, '\uE001').replace(/\\textbackslash\{\}/g, '\uE002')
    .replace(/\\textasciitilde\{\}/g, '~').replace(/\\textasciicircum\{\}/g, '^').replace(/\\([%&#_$])/g, '$1')
    .replace(/\\(['`^"~=.])\{?([A-Za-z])\}?/g, (_, c: string, ch: string) => (ch + ACCENTS[c]).normalize('NFC'))
    .replace(/\\([cvuHrk])(?:\{([A-Za-z])\}|\s+([A-Za-z]))/g, (_, c: string, a: string, b: string) => ((a || b) + ACCENTS[c]).normalize('NFC'))
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L)(?:\{\}|(?![A-Za-z]))/g, (_, k: string) => SPECIAL[k] ?? k)
    .replace(/---/g, '\u2014').replace(/--/g, '\u2013').replace(/[{}]/g, '')
    .replace(/\uE000/g, '{').replace(/\uE001/g, '}').replace(/\uE002/g, '\\').replace(/\s+/g, ' ').trim();
}
function splitBibAuthors(raw: string): string | undefined {
  const parts: string[] = [];
  for (let i = 0, depth = 0, start = 0; i <= raw.length; i++) {
    if (i === raw.length) { parts.push(raw.slice(start)); break; }
    if (raw[i] === '{') depth++; else if (raw[i] === '}' && depth > 0) depth--;
    else if (depth === 0) { const m = /^\s+and\s+/i.exec(raw.slice(i)); if (m) { parts.push(raw.slice(start, i)); i += m[0].length - 1; start = i + 1; } }
  }
  const list = parts.map(unescapeLatex).filter(p => p && !/^others$/i.test(p));
  return list.length ? list.join('; ') : undefined;
}
function readBibValue(text: string, pos: number): [string, number] {
  const parts: string[] = [];
  let i = pos;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === '{' || text[i] === '"') {
      const quote = text[i] === '"', start = ++i;
      for (let depth = quote ? 0 : 1; i < text.length; i++) {
        if (text[i] === '\\' && i + 1 < text.length) { i++; continue; }
        if (quote && text[i] === '"' && depth === 0) break;
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { if (!quote && depth === 1) break; if (depth > 0) depth--; }
      }
      parts.push(text.slice(start, i)); if (i < text.length) i++;
    } else { const start = i; while (i < text.length && !/[,})\s#]/.test(text[i])) i++; parts.push(text.slice(start, i)); }
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '#') { i++; continue; }
    break;
  }
  return [parts.join(''), i];
}
function parseBibTeX(text: string): BulkRefEntry[] {
  const out: BulkRefEntry[] = [];
  for (let i = 0; (i = text.indexOf('@', i)) >= 0;) {
    let p = ++i; while (p < text.length && /[A-Za-z]/.test(text[p])) p++;
    const type = text.slice(i, p).toLowerCase(); while (p < text.length && /\s/.test(text[p])) p++;
    if (!type || (text[p] !== '{' && text[p] !== '(')) { i = p; continue; }
    const open = text[p], close = open === '{' ? '}' : ')', bodyStart = ++p;
    for (let depth = 1; p < text.length && depth > 0; p++) {
      if (text[p] === '\\' && p + 1 < text.length) { p++; continue; }
      if (text[p] === open) depth++; else if (text[p] === close) depth--;
    }
    i = p;
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    const body = text.slice(bodyStart, Math.max(bodyStart, p - 1)), comma = body.indexOf(',');
    if (comma < 0) continue;
    const f: Record<string, string> = {};
    for (let k = comma + 1; k < body.length;) {
      while (k < body.length && /[\s,]/.test(body[k])) k++;
      const s = k; while (k < body.length && /[A-Za-z0-9_-]/.test(body[k])) k++;
      const name = body.slice(s, k).toLowerCase(); while (k < body.length && /\s/.test(body[k])) k++;
      if (!name || body[k] !== '=') break;
      const [val, next] = readBibValue(body, k + 1); f[name] = val; k = next;
    }
    const eprint = clean(f.eprint), venueRaw = f.journal || f.booktitle || f.howpublished || f.institution || f.school;
    const entry = makeEntry({
      title: f.title ? unescapeLatex(f.title) : undefined, authors: f.author ? splitBibAuthors(f.author) : undefined,
      venue: venueRaw ? clean(unescapeLatex(venueRaw)) : undefined, publisher: f.publisher ? clean(unescapeLatex(f.publisher)) : undefined,
      year: extractYear(f.year, f.date), doi: f.doi ? clean(f.doi.replace(/\\([%&#_$])/g, '$1').replace(/[{}]/g, '')) : undefined,
      url: clean(f.url) ?? (eprint && /arxiv/i.test(f.archiveprefix ?? '') ? `https://arxiv.org/abs/${eprint}` : undefined),
      abstract: f.abstract ? clean(unescapeLatex(f.abstract)) : undefined, tags: splitTags(f.keywords || f.tags)
    });
    if (entry) out.push(entry);
  }
  return out;
}
function parseRIS(text: string): BulkRefEntry[] {
  const out: BulkRefEntry[] = [];
  let f: Record<string, string[]> = {}, last = '';
  const flush = () => {
    const arxiv = (f.N1 ?? []).map(n => /^arxiv:\s*(\S+)/i.exec(n)?.[1]).find(Boolean);
    const entry = makeEntry({
      title: (f.TI ?? f.T1)?.join(' '), authors: [...(f.AU ?? []), ...(f.A1 ?? [])].map(s => s.trim()).filter(Boolean).join('; ') || undefined,
      venue: clean((f.JF ?? f.JO ?? f.T2 ?? f.JA)?.[0]), publisher: clean(f.PB?.[0]), year: extractYear((f.PY ?? f.Y1 ?? f.DA)?.[0]),
      doi: clean(f.DO?.[0]), url: clean((f.UR ?? f.L1)?.[0]) ?? (arxiv ? `https://arxiv.org/abs/${arxiv}` : undefined),
      abstract: clean((f.AB ?? f.N2)?.join('\n')), tags: (f.KW ?? []).map(s => s.trim()).filter(Boolean)
    });
    if (entry) out.push(entry); f = {}; last = '';
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/.exec(line);
    if (m) {
      if (m[1] === 'TY') { if (Object.keys(f).length) flush(); f.TY = [m[2].trim()]; last = 'TY'; }
      else if (m[1] === 'ER') flush(); else { (f[m[1]] ??= []).push(m[2].trim()); last = m[1]; }
    } else if (last && line.trim() && ['TI', 'T1', 'AB', 'N2'].includes(last) && f[last]?.length) f[last][f[last].length - 1] += ' ' + line.trim();
  }
  if (Object.keys(f).length) flush();
  return out;
}
function parseCsv(text: string): BulkRefEntry[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') inQuotes = false; else cell += ch; }
    else if (ch === '"' && !cell) inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(c => c.trim())) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const hdr = new Map<string, number>();
  rows[0].forEach((h, idx) => { const k = h.toLowerCase().replace(/[^a-z0-9]+/g, ''); if (k && !hdr.has(k)) hdr.set(k, idx); });
  const col = (r: string[], ...keys: string[]) => keys.map(k => hdr.get(k)).filter((i): i is number => i !== undefined).map(i => r[i]?.trim()).find(Boolean);
  return rows.slice(1).map(r => makeEntry({
    title: col(r, 'title', 'papertitle', 'documenttitle'), authors: clean(col(r, 'authors', 'author', 'creators')),
    year: extractYear(col(r, 'year', 'publicationyear', 'date')), venue: clean(col(r, 'venue', 'journal', 'booktitle', 'publication', 'conference')),
    publisher: clean(col(r, 'publisher')), doi: clean(col(r, 'doi')), url: clean(col(r, 'url', 'link')),
    abstract: col(r, 'abstract', 'summary'), tags: splitTags(col(r, 'tags', 'keywords', 'collections'))
  })).filter((e): e is BulkRefEntry => Boolean(e));
}
export function parseBulkRefs(text: string, format: BulkRefFormat | 'auto' = 'auto'): BulkRefEntry[] {
  const trimmed = text.replace(/^\ufeff/, '').trim();
  if (!trimmed) return [];
  const resolved: BulkRefFormat = format !== 'auto' ? format
    : /^\s*@[a-z]+\s*[{(]/im.test(trimmed) ? 'bibtex' : /^\s*TY\s{1,2}-/m.test(trimmed) ? 'ris' : 'csv';
  return resolved === 'bibtex' ? parseBibTeX(trimmed) : resolved === 'ris' ? parseRIS(trimmed) : parseCsv(trimmed);
}
export const csvCell = (v: string) => { const s = /^(?:[\t\r\n]|\s*[=+\-@])/.test(v) ? "'" + v : v; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportBulkRefs(docs: readonly DocumentInfo[], format: BulkRefFormat): string {
  if (format === 'bibtex') return docs.map(d => formatBibTeX(buildCitationMetadata(d))).join('\n\n') + (docs.length ? '\n' : '');
  if (format === 'ris') return docs.map(d => formatRIS(buildCitationMetadata(d))).join('\n\n') + (docs.length ? '\n' : '');
  return ['title,authors,year,venue,doi,url,abstract,tags', ...docs.map(doc => {
    const m = buildCitationMetadata(doc);
    return [m.title, (m.authors ?? []).join('; '), m.year ?? '', m.venue ?? '', m.doi ?? '', m.url ?? '', m.abstract ?? '', (doc.meta?.tags ?? []).join('; ')].map(csvCell).join(',');
  })].join('\n') + '\n';
}
