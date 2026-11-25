import type { DocMetadata } from '../shared/types.js';
import { ServiceError } from './service-types.js';

const YEAR_RE = /(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/, STRICT_YEAR_RE = /^(1[5-9]\d{2}|20\d{2}|21\d{2})$/, DOI_RE = /^10\.\d{4,9}\/\S+$/i;
const META_KEYS = ['paperTitle', 'authors', 'venue', 'year', 'doi', 'publisher', 'abstract'] as const;
function bad(msg: string): never { throw new ServiceError(400, msg); }
function optionalText(value: unknown, max: number, multiline = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = multiline ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim() : value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}
function optionalDoi(value: unknown): string | undefined {
  const raw = optionalText(value, 256)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
  return raw && DOI_RE.test(raw) ? raw : undefined;
}
export function sanitizeDocMeta(input: Record<string, unknown>): DocMetadata {
  const out: DocMetadata = {};
  const entries: [keyof DocMetadata, string | undefined][] = [
    ['paperTitle', optionalText(input.paperTitle, 500)], ['authors', optionalText(input.authors, 2000)], ['venue', optionalText(input.venue, 500)],
    ['year', optionalText(input.year, 32)?.match(YEAR_RE)?.[1]], ['doi', optionalDoi(input.doi)], ['publisher', optionalText(input.publisher, 500)], ['abstract', optionalText(input.abstract, 8000, true)]
  ];
  for (const [k, v] of entries) if (v) out[k] = v;
  return out;
}
export function missingDocMeta(existing: Record<string, unknown>, incoming?: DocMetadata): Partial<DocMetadata> {
  const patch: Partial<DocMetadata> = {};
  if (incoming) for (const k of META_KEYS) if (!existing[k] && incoming[k]) patch[k] = incoming[k];
  return patch;
}
export function applyMetaPatch(saved: Record<string, unknown>, input: Record<string, unknown>): void {
  const assign = (key: string, val: string | undefined) => { if (val) saved[key] = val; else delete saved[key]; };
  for (const key of ['paperTitle', 'venue'] as const) if (input[key] !== undefined) {
    if (typeof input[key] !== 'string') bad('Invalid ' + key + ' value.');
    assign(key, optionalText(input[key], 500));
  }
  if (input.authors !== undefined) {
    if (Array.isArray(input.authors)) {
      if (input.authors.length > 200 || !input.authors.every(a => typeof a === 'string')) bad('Invalid authors format.');
      assign('authors', input.authors.map(a => optionalText(a, 250)).filter(Boolean).join('; ').slice(0, 2000) || undefined);
    } else if (typeof input.authors === 'string') assign('authors', optionalText(input.authors, 2000));
    else bad('Invalid authors format.');
  }
  if (input.year !== undefined) {
    if (typeof input.year !== 'string') bad('Enter a valid 4-digit year.');
    const trimmed = input.year.trim();
    if (trimmed && !STRICT_YEAR_RE.test(trimmed)) bad('Enter a valid 4-digit year.');
    assign('year', trimmed || undefined);
  }
  if (input.doi !== undefined) {
    if (typeof input.doi !== 'string') bad('Enter a valid DOI.');
    const trimmed = input.doi.trim(), doi = trimmed ? optionalDoi(trimmed) : undefined;
    if (trimmed && !doi) bad('Enter a valid DOI.');
    assign('doi', doi);
  }
}
