import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

const ZH_ENGLISH_ALLOWLIST = new Set([
  'bibtex', 'ris', 'bib', 'doi', 'arxiv', 'obsidian', 'zotero', 'dsh', 'pdf', 'url', 'markdown',
  'openstax', 'html', 'api', 'http', 'https', 'ocr', 'ctrl', 'cmd', 'shift', 'alt', 'esc',
  'enter', 'home', 'end', 'pagedattention', 'sosp', 'kwon', 'paper', 'reader', 'vllm', 'token',
  'efficient', 'management', 'large', 'language', 'model', 'serving', 'with',
  'woosuk', 'et', 'al', 'key', 'value', 'kv'
]);

const BANNED_EN_RE = /\b(?:Annotations|Paper conversation|Paper discussion|Reading notebook|Notebook)\b/i;
const BANNED_ZH_RE = /(?:阅读笔记本|笔记本|批注索引|批注|Obsidian\s*仓库|已存入仓库|存入仓库)/;

const BASE_EXCLUDED = [
  '.pdf-sheet', '.pdf-reading-text p', '.pdf-reading-text h2', '.meaning', '#card blockquote',
  '.web-reading-sheet', '.cm-content', '.quote', '.selection-excerpt blockquote', '.selection-heading h2',
  '#docTitle', '#docMeta', '#railBody h1', '.list-row strong', '.toc-entry', '.toc-fold',
  '.paper-answer', '.selection-answer', '.library-row-text strong', '.library-row-text small',
  '.doc-row strong', '.doc-row small', '#sourceInfo'
].join(', ');

export async function collectChromeStrings(page: Page, extraExcluded = ''): Promise<{ text: string; source: string }[]> {
  const excluded = extraExcluded ? `${BASE_EXCLUDED}, ${extraExcluded}` : BASE_EXCLUDED;
  return page.evaluate(sel => {
    const items: { text: string; source: string }[] = [];
    const seen = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest(sel)) continue;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'SVG' || el.closest('svg')) continue;
      const hidden = el.closest('[hidden]') && !el.closest('dialog[open]');
      const idTag = el.id ? '#' + el.id : el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : el.tagName.toLowerCase();
      const candidates: [string | null | undefined, string][] = [
        [el.getAttribute('aria-label'), `${idTag}[aria-label]`],
        [el.getAttribute('title'), `${idTag}[title]`],
        [el.getAttribute('placeholder'), `${idTag}[placeholder]`]
      ];
      if (!hidden) {
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) candidates.push([child.textContent, `${idTag}:text`]);
        }
      }
      for (const [raw, source] of candidates) {
        const value = (raw ?? '').replace(/\s+/gu, ' ').trim();
        if (!value) continue;
        const key = source + '|' + value;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ text: value, source });
        }
      }
    }
    return items;
  }, excluded);
}

export function assertNoZhEnglishLeaks(
  items: { text: string; source: string }[],
  contextLabel: string,
  extraAllowlist: readonly string[] = []
): void {
  const allow = extraAllowlist.length ? new Set([...ZH_ENGLISH_ALLOWLIST, ...extraAllowlist]) : ZH_ENGLISH_ALLOWLIST;
  const leaks: string[] = [];
  for (const item of items) {
    assert.equal(item.text.match(BANNED_ZH_RE), null, `[${contextLabel}] Banned ZH drift term in ${item.source}: ${JSON.stringify(item.text)}`);
    const bad = (item.text.match(/[A-Za-z]{3,}/g) ?? []).filter(word => !allow.has(word.toLowerCase()));
    if (bad.length) leaks.push(`${item.source}: "${item.text}" -> [${bad.join(', ')}]`);
  }
  assert.deepEqual(leaks, [], `[${contextLabel}] Untranslated English leaks in zh-CN:\n${leaks.join('\n')}`);
}

export function assertNoEnBannedTerms(items: { text: string; source: string }[], contextLabel: string): void {
  const violations = items.filter(item => BANNED_EN_RE.test(item.text)).map(item => `${item.source}: "${item.text}"`);
  assert.deepEqual(violations, [], `[${contextLabel}] Banned EN drift terms:\n${violations.join('\n')}`);
}
