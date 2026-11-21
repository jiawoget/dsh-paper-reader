export interface OpenStaxLocation {
  book: string;
  section?: string;
  fragment?: string;
}

export function bookSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,239}$/u.test(value);
}

export function openStaxUrl(book: string, section?: string): string {
  return 'https://openstax.org/books/' + encodeURIComponent(book) + '/pages/' + (section ? encodeURIComponent(section) : '');
}

export function openStaxLocation(raw: unknown): OpenStaxLocation | undefined {
  const url = typeof raw === 'string' && raw.length <= 8192 ? URL.parse(raw) : null;
  if (!url || !['https:', 'http:'].includes(url.protocol) || !['openstax.org', 'www.openstax.org'].includes(url.hostname) ||
    url.username || url.password || url.port) return;
  const match = /^\/books\/([^/]+)(?:\/pages(?:\/([^/]+))?)?\/?$/.exec(url.pathname) ??
    /^\/details\/books\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return;
  let book: string, section: string | undefined;
  try {
    book = decodeURIComponent(match[1]);
    section = match[2] ? decodeURIComponent(match[2]) : undefined;
  } catch { return; }
  if (!bookSlug(book) || section && !bookSlug(section)) return;
  let fragment = url.hash.slice(1);
  try { fragment = decodeURIComponent(fragment); } catch { /* Preserve a literal publisher fragment. */ }
  return { book, section, fragment: fragment || undefined };
}
