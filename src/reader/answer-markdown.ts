import { cjkFriendly } from '@mdit/plugin-cjk-friendly';
import { katex } from '@mdit/plugin-katex';
import { renderToString, type KatexOptions } from 'katex';
import MarkdownIt from 'markdown-it/browser';
import { readerLabel as label } from './ui.js';

const mathOptions: KatexOptions = { throwOnError: false, trust: false, maxSize: 20, maxExpand: 1000 };
const markdown = new MarkdownIt({ html: false }).use(cjkFriendly).use(katex, {
  ...mathOptions, delimiters: 'all', mathFence: true
});

// Models sometimes put display delimiters beside prose on the same line. The standard
// block parser handles standalone equations; this inline rule leaves code and escapes to Markdown.
markdown.inline.ruler.before('escape', 'display_math_in_prose', (state, silent) => {
  const opener = state.src.slice(state.pos, state.pos + 2);
  if (opener !== '\\[' && opener !== '$$') return false;
  const closer = opener === '$$' ? '$$' : '\\]';
  const start = state.pos + 2;
  let end = state.src.indexOf(closer, start);
  while (end >= start && end < state.posMax) {
    let slash = end;
    while (slash > start && state.src[slash - 1] === '\\') slash--;
    if ((end - slash) % 2 === 0) break;
    end = state.src.indexOf(closer, end + 1);
  }
  if (end <= start || end + 2 > state.posMax) return false;
  if (!silent) state.push('display_math_in_prose', 'math', 0).content = state.src.slice(start, end);
  state.pos = end + 2;
  return true;
});
markdown.renderer.rules.display_math_in_prose = (tokens, index) =>
  renderToString(tokens[index].content, { ...mathOptions, displayMode: true });

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

const citeParenRe = /([(\uFF08])(?:(pp?\.\s*|pp?\s+|pages?\s+)(\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,;]\s*(?:pp?\.\s*|pp?\s+)?\d+(?:\s*[-–—]\s*\d+)?)*)|(第\s*)(\d+(?:\s*[-–—~～至到]\s*\d+)?(?:\s*[,，、]\s*\d+(?:\s*[-–—~～至到]\s*\d+)?)*)(\s*页))([)\uFF09])/giu;

function parseCitePage(part: string, maxPage: number): number | undefined {
  const m = /^(?:pp?\.\s*|pp?\s+)?(\d+)(?:\s*[-–—~～至到]\s*(\d+))?$/iu.exec(part.trim());
  const start = m ? Number(m[1]) : 0, end = m?.[2] ? Number(m[2]) : start;
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= maxPage) return start;
}

markdown.core.ruler.after('inline', 'page_citations', state => {
  const maxPage = typeof state.env?.maxPage === 'number' ? Math.floor(state.env.maxPage) : 0;
  if (maxPage < 1) return;
  const emit = (out: typeof state.tokens, type: string, content: string, page?: number) => {
    if (!content) return;
    const tok = new state.Token(type, page ? 'button' : '', 0);
    tok.content = content;
    if (page) tok.meta = { page };
    out.push(tok);
  };
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children?.length) continue;
    let linkDepth = 0, changed = false;
    const next: typeof block.children = [];
    for (const token of block.children) {
      if (token.type === 'link_open') { linkDepth++; next.push(token); continue; }
      if (token.type === 'link_close') { linkDepth = Math.max(0, linkDepth - 1); next.push(token); continue; }
      if (token.type !== 'text' || linkDepth > 0) { next.push(token); continue; }
      let last = 0;
      citeParenRe.lastIndex = 0;
      for (const m of token.content.matchAll(citeParenRe)) {
        const index = m.index!, full = m[0], open = m[1], close = m[7];
        const prefix = m[2] ?? m[4] ?? '', items = m[3] ?? m[5] ?? '', suffix = m[6] ?? '';
        const segs = items.split(/(\s*[,;，、]\s*)/u), pages = segs.map((s, i) => i % 2 === 0 ? parseCitePage(s, maxPage) : undefined);
        if (!pages.some(Boolean)) continue;
        changed = true;
        emit(next, 'text', token.content.slice(last, index));
        if (segs.length === 1) emit(next, 'page_cite_chip', full, pages[0]);
        else {
          emit(next, 'text', open + prefix);
          segs.forEach((seg, i) => emit(next, pages[i] ? 'page_cite_chip' : 'text', seg, pages[i]));
          emit(next, 'text', suffix + close);
        }
        last = index + full.length;
      }
      if (last > 0) emit(next, 'text', token.content.slice(last)); else next.push(token);
    }
    if (changed) block.children = next;
  }
});

markdown.renderer.rules.page_cite_chip = (tokens, index) => {
  const page = Number(tokens[index].meta?.page);
  const aria = markdown.utils.escapeHtml(label('Jump to page ' + page, '跳转到第 ' + page + ' 页'));
  return `<button type="button" class="page-cite-chip" data-page="${page}" aria-label="${aria}">${markdown.utils.escapeHtml(tokens[index].content)}</button>`;
};

export const answerMarkdown = (text: string, maxPage = 0): string => markdown.render(text, { maxPage });

export function selectedAnswer(log: HTMLElement): { body: HTMLElement; text: string } | undefined {
  const selection = document.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const bodyAt = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.selection-prose');
  const body = bodyAt(range.startContainer);
  if (!body || body !== bodyAt(range.endContainer) || !log.contains(body)) return;
  const text = excerptFromAnswer(range);
  if (text) return { body, text };
}

/** KaTeX includes a visual tree and a screen-reader tree. Quote a touched equation exactly once. */
function excerptFromAnswer(selected: Range): string {
  const range = selected.cloneRange();
  function mathAt(node: Node): Element | null | undefined {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest('.katex-display') ?? element?.closest('.katex');
  }
  const startMath = mathAt(range.startContainer), endMath = mathAt(range.endContainer);
  if (startMath) range.setStartBefore(startMath);
  if (endMath) range.setEndAfter(endMath);
  const fragment = range.cloneContents();
  for (const formula of fragment.querySelectorAll('.katex')) {
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (tex) formula.replaceWith(formula.closest('.katex-display') ? '\n\n$$\n' + tex + '\n$$\n\n' : '$' + tex + '$');
  }
  for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of fragment.querySelectorAll('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,tr')) block.append('\n');
  return (fragment.textContent ?? '').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}
