import { cjkFriendly } from '@mdit/plugin-cjk-friendly';
import { katex } from '@mdit/plugin-katex';
import { renderToString, type KatexOptions } from 'katex';
import MarkdownIt from 'markdown-it/browser';

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

export const answerMarkdown = (text: string): string => markdown.render(text);

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
export function excerptFromAnswer(selected: Range): string {
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
