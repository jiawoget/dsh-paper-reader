import { articleUrl, type ArticleBlock, type ArticleLayout, type ArticleSpan } from '../shared/web-article.js';
import { fail, isRecord } from './library.js';

export function readArticleLayout(raw: unknown, paragraphs: string[]): ArticleLayout {
  if (!isRecord(raw)) fail('Invalid article layout.');
  const result: ArticleLayout = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!/^p-[1-9]\d{0,3}$/.test(id) || !isRecord(value)) fail('Invalid article block.');
    const text = paragraphs[Number(id.slice(2)) - 1];
    if (!text || typeof value.kind !== 'string' || !/^(p|h[1-6]|pre|quote|list|caption|image|equation|table|byline)$/.test(value.kind)) fail('Invalid article block.');
    const block: ArticleBlock = { kind: value.kind as ArticleBlock['kind'] };
    if (value.ids !== undefined) {
      if (!Array.isArray(value.ids) || value.ids.length > 80 || !value.ids.every(id => typeof id === 'string' && id.length <= 256)) fail('Invalid article anchors.');
      block.ids = value.ids;
    }
    if (value.spans !== undefined) {
      if (!Array.isArray(value.spans) || value.spans.length > 4000) fail('Invalid article formatting.');
      let previous = 0;
      block.spans = value.spans.map((span): ArticleSpan => {
        if (!isRecord(span) || typeof span.kind !== 'string' || !['link','code','math','em','strong'].includes(span.kind) ||
            typeof span.start !== 'number' || !Number.isSafeInteger(span.start) || span.start < previous ||
            typeof span.end !== 'number' || !Number.isSafeInteger(span.end) || span.end <= span.start || span.end > text.length) fail('Invalid article text range.');
        previous = span.end;
        const result: ArticleSpan = { start: span.start, end: span.end, kind: span.kind as ArticleSpan['kind'] };
        if (span.kind === 'math') {
          if (typeof span.value !== 'string' || span.value.length > 4096) fail('Invalid article formula.');
          result.value = span.value;
        }
        if (span.kind === 'link') {
          if (typeof span.value === 'string' && span.value.startsWith('#') && span.value.length > 1 && span.value.length <= 256) {
            result.value = span.value;
          } else {
            const link = typeof span.value === 'string' ? articleUrl(span.value) : undefined;
            if (!link) fail('Invalid article link.');
            result.value = link.href;
          }
        }
        return result;
      });
    }
    if (block.kind === 'image') {
      const image = value.image;
      if (!isRecord(image) || typeof image.url !== 'string' || !articleUrl(image.url) || typeof image.alt !== 'string' || image.alt.length > 1024) fail('Invalid article illustration.');
      block.image = { url: image.url, alt: image.alt };
    }
    if (block.kind === 'table') {
      const cells = value.cells;
      if (!Array.isArray(cells) || !cells.length || !cells.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string')) ||
        cells.map(row => row.join('\t')).join('\n').trim() !== text.trim()) fail('Invalid article table.');
      block.cells = cells;
    }
    result[id] = block;
  }
  return result;
}
