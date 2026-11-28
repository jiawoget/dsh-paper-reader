import path from 'node:path';
import { cjkFriendly } from '@mdit/plugin-cjk-friendly';
import { katex } from '@mdit/plugin-katex';
import MarkdownIt from 'markdown-it';
import type { WebArticle } from '../shared/web-article.js';
import { parseWebArticle } from './web-article.js';

interface MarkdownFrontmatter { body: string; title?: string; authors?: string; year?: string; doi?: string }
interface HeadingRenderEnv { slugs?: Set<string> }

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false })
  .use(cjkFriendly)
  .use(katex, { delimiters: 'all', mathFence: true });

const escapeHtml = (value: string): string => markdown.utils.escapeHtml(value);
const renderMathBlock = (raw: string): string => {
  const tex = raw.trim();
  return tex ? `<div class="math"><math alttext="${escapeHtml(tex)}">${escapeHtml(tex)}</math></div>\n` : '';
};

function slugifyHeading(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s_-]+/gu, '').trim().replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

function uniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) { used.add(base); return base; }
  let suffix = 1;
  while (used.has(`${base}-${suffix}`)) suffix++;
  const candidate = `${base}-${suffix}`;
  used.add(candidate);
  return candidate;
}

markdown.core.ruler.push('heading_ids', state => {
  const used = (state.env as HeadingRenderEnv | undefined)?.slugs ?? new Set<string>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== 'heading_open' || tokens[i + 1].type !== 'inline') continue;
    const inline = tokens[i + 1];
    const plain = (inline.children ?? [])
      .map(c => (c.type === 'text' || c.type === 'code_inline' || c.type === 'math_inline' ? c.content : ''))
      .join('').trim() || inline.content.trim();
    tokens[i].attrSet('id', uniqueSlug(slugifyHeading(plain), used));
  }
});

markdown.renderer.rules.math_inline = (tokens, index) => {
  const tex = tokens[index].content.trim();
  return tex ? `<math alttext="${escapeHtml(tex)}">${escapeHtml(tex)}</math>` : '';
};
markdown.renderer.rules.math_block = (tokens, index) => renderMathBlock(tokens[index].content);

const defaultFence = markdown.renderer.rules.fence;
markdown.renderer.rules.fence = (tokens, index, options, env, self) =>
  tokens[index].info.trim().toLowerCase() === 'math'
    ? renderMathBlock(tokens[index].content)
    : defaultFence ? defaultFence(tokens, index, options, env, self) : self.renderToken(tokens, index, options);

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).replace(/\\(["'\\])/g, '$1').trim();
  }
  return trimmed;
}

function stripFrontmatter(raw: string): MarkdownFrontmatter {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { body: normalized };
  const closeMatch = /\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(normalized.slice(4));
  if (!closeMatch) return { body: normalized };
  const header = normalized.slice(4, 4 + closeMatch.index);
  const meta: MarkdownFrontmatter = { body: normalized.slice(4 + closeMatch.index + closeMatch[0].length) };
  for (const line of header.split('\n')) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].toLowerCase(), val = unquoteYaml(pair[2]);
    if (!val) continue;
    if (key === 'title' && !meta.title) meta.title = val.slice(0, 250);
    else if ((key === 'author' || key === 'authors') && !meta.authors) meta.authors = val.slice(0, 300);
    else if ((key === 'year' || key === 'date') && !meta.year) {
      const year = /(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/.exec(val)?.[1];
      if (year) meta.year = year;
    } else if (key === 'doi' && !meta.doi) {
      const doi = val.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
      if (/^10\.\d{4,9}\/\S+$/i.test(doi)) meta.doi = doi;
    }
  }
  return meta;
}

export function cleanFilenameTitle(filename: string | undefined): string {
  const stem = path.basename((filename || '').trim()).replace(/\.(?:markdown|md|html|htm|pdf)$/i, '');
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250) || 'Document';
}

export function parseMarkdownArticle(raw: string, filename?: string): WebArticle {
  const frontmatter = stripFrontmatter(raw);
  const rendered = markdown.render(frontmatter.body, { slugs: new Set<string>() } satisfies HeadingRenderEnv);
  const fallback = cleanFilenameTitle(filename);
  const parsed = parseWebArticle(`<!doctype html><html><body><article>${rendered}</article></body></html>`, '', fallback);
  const firstH1 = Object.entries(parsed.articleLayout ?? {}).find(([, block]) => block.kind === 'h1');
  const h1Title = firstH1 ? parsed.paragraphs[Number(firstH1[0].slice(2)) - 1] : '';
  return {
    ...parsed,
    url: '',
    title: frontmatter.title || h1Title || fallback,
    ...(frontmatter.authors ? { authors: frontmatter.authors } : {}),
    ...(frontmatter.year ? { year: frontmatter.year } : {}),
    ...(frontmatter.doi ? { doi: frontmatter.doi } : {})
  };
}
