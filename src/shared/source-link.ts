export function quoteLocator(text: string): string {
  return text.slice(0, 240).replace(/[\uD800-\uDBFF]$/u, '');
}

export interface TranslatedLocator { text: string; offset?: number }

/** Offsets refer to the initiating side's text in the first and last blocks. */
export interface SavedSelectionRange { start: number; endAnchor: string; end: number; tail: string; order?: 'reflow' }

export function readSelectionRange(url: URL): SavedSelectionRange | undefined {
  const start = url.searchParams.get('rangeStart'), end = url.searchParams.get('rangeEnd');
  const endAnchor = url.searchParams.get('endAnchor'), tail = url.searchParams.get('rangeTail');
  if (!start || !end || !/^\d{1,8}$/u.test(start) || !/^\d{1,8}$/u.test(end) || !Number(end) ||
    !endAnchor || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(endAnchor) || !tail || tail.length > 80) return;
  return { start: Number(start), end: Number(end), endAnchor, tail,
    ...(url.searchParams.get('rangeOrder') === 'reflow' && { order: 'reflow' as const }) };
}

export function writeSelectionRange(url: URL, range?: SavedSelectionRange): void {
  if (range) {
    url.searchParams.set('rangeStart', String(range.start));
    url.searchParams.set('endAnchor', range.endAnchor);
    url.searchParams.set('rangeEnd', String(range.end));
    url.searchParams.set('rangeTail', range.tail);
    if (range.order) url.searchParams.set('rangeOrder', range.order);
    else url.searchParams.delete('rangeOrder');
  } else {
    for (const key of ['rangeStart', 'endAnchor', 'rangeEnd', 'rangeTail', 'rangeOrder']) url.searchParams.delete(key);
  }
}

export function readTranslatedLocator(url: URL): TranslatedLocator | undefined {
  const text = url.searchParams.get('targetQuote');
  if (!text) return;
  const raw = url.searchParams.get('targetOffset');
  const offset = raw && /^\d+$/u.test(raw) ? Number(raw) : undefined;
  return Number.isSafeInteger(offset) ? { text, offset } : { text };
}

export function writeTranslatedLocator(url: URL, locator?: TranslatedLocator): void {
  if (locator?.text) url.searchParams.set('targetQuote', quoteLocator(locator.text));
  else url.searchParams.delete('targetQuote');
  if (locator?.offset !== undefined && Number.isSafeInteger(locator.offset) && locator.offset >= 0) {
    url.searchParams.set('targetOffset', String(locator.offset));
  } else url.searchParams.delete('targetOffset');
}
