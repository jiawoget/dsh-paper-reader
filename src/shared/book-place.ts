export interface BookPlace {
  page: number;
  anchor: string;
  fraction: number;
  side: 'source' | 'translation';
  updated: number;
}

export function bookPlace(value: unknown): BookPlace | undefined {
  if (!value || typeof value !== 'object') return;
  const p = value as Partial<BookPlace>;
  if (typeof p.page !== 'number' || !Number.isSafeInteger(p.page) || p.page < 1 || p.page > 100_000 ||
      typeof p.anchor !== 'string' || (p.anchor !== '' && !/^p-[1-9]\d{0,4}$/.test(p.anchor)) ||
      typeof p.fraction !== 'number' || !Number.isFinite(p.fraction) || p.fraction < 0 || p.fraction > 1 ||
      (p.side !== 'source' && p.side !== 'translation') || typeof p.updated !== 'number' ||
      !Number.isSafeInteger(p.updated) || p.updated <= 0) return;
  return { page: p.page, anchor: p.anchor, fraction: p.fraction, side: p.side, updated: p.updated };
}
