export interface GlossaryEntry {
  readonly term: string;
  readonly translation?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseGlossary(raw?: string): GlossaryEntry[] {
  if (!raw) return [];
  const entries = new Map<string, GlossaryEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const spaced = trimmed.match(/\s+[=＝]\s+/);
    const sep = spaced?.index !== undefined ? spaced.index : trimmed.search(/[=＝]/);
    const sepLen = spaced?.index !== undefined ? spaced[0].length : 1;
    const term = (sep === -1 ? trimmed : trimmed.slice(0, sep)).trim();
    if (!term) continue;
    const translation = sep === -1 ? '' : trimmed.slice(sep + sepLen).trim();
    const key = term.normalize('NFKC').toLowerCase();
    entries.set(key, translation ? { term, translation } : { term });
  }
  return [...entries.values()];
}

export function matchGlossary(text: string, entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  if (!text || !entries.length) return [];
  const normText = text.normalize('NFKC');
  return entries.filter(entry => {
    const normTerm = entry.term.normalize('NFKC');
    const escaped = escapeRegex(normTerm).replace(/\s+/g, '\\s+');
    const prefix = /^[A-Za-z0-9_]/.test(normTerm) ? '(?<![A-Za-z0-9_])' : '';
    const suffix = /[A-Za-z0-9_]$/.test(normTerm) ? '(?![A-Za-z0-9_])' : '';
    return new RegExp(prefix + escaped + suffix, 'iu').test(normText);
  });
}

export function formatGlossaryPrompt(raw: string | undefined, text: string): string {
  const matched = matchGlossary(text, parseGlossary(raw));
  if (!matched.length) return '';
  return 'Follow this glossary for matching terms: '
    + matched.map(entry => entry.translation ? `${entry.term} => ${entry.translation}` : `${entry.term} (keep unchanged)`).join('; ')
    + '.';
}
