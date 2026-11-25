interface ArticleRegion {
  side: 'source' | 'translation' | 'both';
  start: string;
  end: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Horizontal coordinates span the selected side. Each vertical coordinate belongs to its own row. */
export function readArticleLocation(location: string): ArticleRegion | undefined {
  if (location.length > 128) return;
  const match = /^(source|translation|both)-p-([1-9]\d*)-p-([1-9]\d*)-(\d+)-(\d+)-(\d+)-(\d+)$/u.exec(location);
  if (!match) return;
  const [start, end, left, top, right, bottom] = match.slice(2).map(Number);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end ||
      left >= right || right > 10_000 || top > 10_000 || bottom > 10_000 || (start === end && top >= bottom)) return;
  return { side: match[1] as ArticleRegion['side'], start: 'p-' + start, end: 'p-' + end, left, top, right, bottom };
}

export function readArticleRegion(anchor: string): ArticleRegion | undefined {
  const match = /^article-(.{1,128})-[0-9a-f]{32}$/u.exec(anchor);
  return match ? readArticleLocation(match[1]) : undefined;
}
