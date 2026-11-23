import { createHash } from 'node:crypto';
import { readerRoute } from './vault-sources.js';

interface Citation { raw: string; label?: string; definition?: string; url: URL; from: number; to: number }
const key = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const firstLabel = /^\[((?:\\.|[^\]\\\r\n])+)\]/u;
function readerUrl(raw: string, docId: string): URL | undefined {
  const url = URL.parse(raw);
  if (url && ['http:', 'https:'].includes(url.protocol) && readerRoute.test(url.pathname) && url.searchParams.get('doc') === docId) return url;
}

// Only rewrite reader-generated link syntax. Examples in code, third-party
// links, headings, and free writing must survive a trip through the vault.
function citations(markdown: string, docId: string): Citation[] {
  const lines: { text: string; start: number }[] = [];
  let fence = '';
  for (const line of markdown.matchAll(/[^\r\n]+/g)) {
    const border = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line[0]);
    if (border && !fence) { fence = border[1]; continue; }
    if (fence) {
      if (border && border[1][0] === fence[0] && border[1].length >= fence.length && !border[2].trim()) fence = '';
      continue;
    }
    lines.push({ text: line[0], start: line.index });
  }
  const definitions = new Map<string, URL>();
  const referenced = new Set<string>();
  const found: Citation[] = [];
  for (const { text, start } of lines) {
    const definition = /^ {0,3}\[(p\d+-[\da-f]{8})\]:[ \t]*(?:<([^>]+)>|(https?:\/\/\S+))[ \t]*$/iu.exec(text);
    const url = definition && readerUrl(definition[2] ?? definition[3], docId);
    if (definition && url) {
      definitions.set(definition[1].toLowerCase(), url);
      found.push({ raw: text, definition: definition[1].toLowerCase(), url, from: start, to: start + text.length });
    }
  }
  for (const { text, start } of lines) {
    const tokens = /`+|\[((?:\\.|[^\[\]\\\r\n])+)\](?:\[(p\d+-[\da-f]{8})\]|\(<(https?:\/\/[^>]+)>\))/giu;
    for (let match; (match = tokens.exec(text));) {
      if (!match[1]) {
        const close = text.indexOf(match[0], tokens.lastIndex);
        if (close >= 0) tokens.lastIndex = close + match[0].length;
        continue;
      }
      const url = match[2] ? definitions.get(match[2].toLowerCase()) : readerUrl(match[3], docId);
      if (url && match[2]) referenced.add(match[2].toLowerCase());
      if (url) found.push({ raw: match[0], label: match[1], url, from: start + match.index, to: start + tokens.lastIndex });
    }
  }
  for (const cite of found) if (cite.definition && !referenced.has(cite.definition)) cite.label = 'Cited passage';
  return found.sort((a, b) => a.from - b.from);
}

/** Exact reader ranges stay in the database. Vault markers identify only
 * corresponding edits and contain neither URLs nor quotes. */
export function vaultMarkdown(markdown: string, docId: string, render: (label: string, url: URL) => string, live = true): string {
  let at = 0, out = '';
  for (const cite of citations(markdown, docId)) {
    const shown = cite.label ? render(cite.label, cite.url) : '';
    const marker = live ? '<!--cite:' + key(cite.raw) + ':' + key(shown.replace(firstLabel, '[]')) + '-->' : '';
    out += markdown.slice(at, cite.from) + shown + marker;
    at = cite.to;
  }
  return out + markdown.slice(at);
}

export function readerMarkdown(external: string, baseline: string, docId: string): string {
  if (!external.includes('<!--cite:')) return external;
  const originals = new Map(citations(baseline, docId).map(cite => [key(cite.raw), cite]));
  let at = 0, out = '';
  for (const marker of external.matchAll(/<!--cite:([\da-f]{16}):([\da-f]{16})-->/g)) {
    const before = external.slice(at, marker.index);
    const cite = originals.get(marker[1]);
    const linked = /\[((?:\\.|[^\[\]\\\r\n])+)\]\(<[^>\r\n]+>\)(?: · \[(?:Library copy|Zotero)\]\(<[^>\r\n]+>\))*$/u.exec(before);
    const shown = linked?.[0] ?? (cite?.label && before.endsWith(cite.label) ? cite.label : '');
    const label = linked?.[1];
    const renamedHeader = cite?.label === 'Open in Paper Reader' && label && !['Original source', 'Library copy', 'Zotero'].includes(label);
    if (!cite || renamedHeader || (cite.definition && label && label !== cite.label) || key(shown.replace(firstLabel, '[]')) !== marker[2]) out += before;
    else {
      const raw = label && cite.label && !cite.definition && cite.label !== 'Open in Paper Reader' && label !== cite.label
        ? cite.raw.replace(firstLabel, () => '[' + label + ']') : cite.raw;
      out += before.slice(0, before.length - shown.length) + raw;
    }
    at = marker.index + marker[0].length;
  }
  return out + external.slice(at);
}
