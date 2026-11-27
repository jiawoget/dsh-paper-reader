import { extractArxivId } from '../../shared/citation-export.js';
import type { ArxivFormat, DocumentInfo, GraphPaper, SavePaperMode } from '../../shared/types.js';
import { api, el, readerLabel as t, toast } from '../ui.js';
import { researchIcon } from './icons.js';
import { researchText } from './labels.js';
import type { ResearchShellContext } from './state.js';

const SRC_NAME: Record<string, string> = { openalex: 'OpenAlex', s2: 'Semantic Scholar', europepmc: 'Europe PMC', arxiv: 'arXiv' };
export const isAbortError = (err: unknown): boolean => err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && /abort|cancel/i.test(err.message);
export const mkBtn = (cls: string, text: string, onClick: () => void): HTMLButtonElement => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; };
export const formatDegradedSources = (sources: readonly string[]): string => !sources.length ? '' : t(
  `Partial data: ${[...new Set(sources)].map(s => SRC_NAME[s] ?? s).join(', ')} unavailable, using fallback sources.`,
  `数据源降级：${[...new Set(sources)].map(s => SRC_NAME[s] ?? s).join(', ')} 暂不可用，已切换备用源。`
);
export const formatCachedAt = (ts?: number): string => { const tm = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; return tm ? t(`Cached · ${tm}`, `已缓存 · ${tm}`) : t('Cached', '已缓存'); };

let activeDegraded: { wrap: HTMLElement; close: (refocus?: boolean) => void } | null = null;
const boundDegradedDocs = new WeakSet<object>();

export const dismissDegradedPopover = (refocus = true): boolean => {
  const cur = activeDegraded; activeDegraded = null;
  if (!cur?.wrap.isConnected) return false;
  cur.close(refocus); return true;
};

export function createDegradedInfoButton(sources: readonly string[], onOpenAcademicSettings?: () => void): HTMLElement {
  const uniq = [...new Set(sources)];
  if (typeof document !== 'undefined' && !boundDegradedDocs.has(document)) {
    boundDegradedDocs.add(document);
    document.addEventListener('pointerdown', e => {
      if (activeDegraded && !(e.target instanceof Node && activeDegraded.wrap.contains(e.target))) activeDegraded.close();
    });
  }
  const wrap = el('span', 'ds-degraded-wrap');
  const btn = el('button', 'icon-btn ds-degraded-info');
  btn.type = 'button'; btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-haspopup', 'dialog');
  btn.ariaLabel = btn.title = t('Data source status', '数据源状态说明');
  btn.append(researchIcon('info', 20));
  const pop = el('div', 'ds-degraded-pop'); pop.setAttribute('role', 'dialog'); pop.hidden = true;
  const hasS2 = uniq.includes('s2'), others = uniq.filter(s => s !== 's2').map(s => SRC_NAME[s] ?? s);
  const note = hasS2
    ? t(
      `Semantic Scholar's keyless public pool hit a 429 rate limit; fallback sources are active.${others.length ? ` Also degraded: ${others.join(', ')}.` : ''} Add a free personal API key for higher limits.`,
      `Semantic Scholar 免密钥公共池触发 429 限流，已启用备用数据源。${others.length ? `其余降级源：${others.join('、')}。` : ''}填入免费个人 API 密钥可提高速率上限。`
    )
    : formatDegradedSources(uniq);
  pop.append(el('p', 'ds-degraded-text', note));
  let pinned = false;
  const close = (refocus = false) => {
    pinned = false; pop.hidden = true; btn.setAttribute('aria-expanded', 'false');
    if (activeDegraded?.wrap === wrap) activeDegraded = null;
    if (refocus && btn.isConnected) btn.focus({ preventScroll: true });
  };
  const open = (pin = false) => {
    if (activeDegraded && activeDegraded.wrap !== wrap) activeDegraded.close();
    if (pin) pinned = true;
    const r = btn.getBoundingClientRect(), vw = typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1024;
    const popW = Math.min(300, vw - 24), overflow = r.left + popW - (vw - 12);
    pop.style.setProperty('--pop-shift', overflow > 0 ? `${Math.round(-Math.min(overflow, Math.max(0, r.left - 12)))}px` : '0px');
    pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
    activeDegraded = { wrap, close };
  };
  if (onOpenAcademicSettings) {
    pop.append(mkBtn('btn ds-degraded-settings', t('Settings → Academic APIs', '设置 → 学术图谱 API'), () => { close(); onOpenAcademicSettings(); }));
  }
  btn.addEventListener('click', e => { e.stopPropagation(); if (pinned && !pop.hidden) close(); else open(true); });
  wrap.addEventListener('pointerenter', () => { if (!pinned) open(false); });
  wrap.addEventListener('pointerleave', () => { if (!pinned) close(); });
  wrap.addEventListener('focusin', () => { if (pop.hidden) open(false); });
  wrap.addEventListener('focusout', e => { if (!pinned && (!(e.relatedTarget instanceof Node) || !wrap.contains(e.relatedTarget))) close(); });
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { e.preventDefault(); e.stopPropagation(); close(true); } });
  wrap.append(btn, pop);
  return wrap;
}

const abstractOnlyDocIds = new Set<string>();
export const clearAbstractOnly = (docId: string): void => { abstractOnlyDocIds.delete(docId); };
const isArxivPaper = (paper: GraphPaper): boolean => Boolean(paper.arxivId || extractArxivId(paper.url, paper.doi) || extractArxivId(paper.oaPdfUrl));

export function createArxivFormatToggle(
  initial: ArxivFormat = 'html',
  onChange?: (fmt: ArxivFormat) => void
): { root: HTMLElement; value: () => ArxivFormat; set: (fmt: ArxivFormat) => void } {
  let cur: ArxivFormat = initial;
  const root = el('div', 'arxiv-fmt-seg');
  root.setAttribute('role', 'group');
  root.ariaLabel = researchText.arxivFormat();
  const btns: Record<ArxivFormat, HTMLButtonElement> = {
    html: el('button', 'arxiv-fmt-btn', 'HTML'),
    pdf: el('button', 'arxiv-fmt-btn', 'PDF')
  };
  const sync = () => {
    for (const k of ['html', 'pdf'] as const) btns[k].setAttribute('aria-pressed', String(cur === k));
  };
  for (const k of ['html', 'pdf'] as const) {
    btns[k].type = 'button'; btns[k].dataset.format = k;
    btns[k].addEventListener('click', () => { if (cur !== k) { cur = k; sync(); onChange?.(cur); } });
    root.append(btns[k]);
  }
  sync();
  return { root, value: () => cur, set: fmt => { cur = fmt; sync(); } };
}

export function renderPaperActions(
  slot: HTMLElement, paper: GraphPaper,
  opts: { prefix: string; busy: boolean; openLabel: string; arxivFormat?: ArxivFormat; onOpen: (docId: string) => void; onSave: (arxivFormat?: ArxivFormat) => void }
): void {
  slot.replaceChildren();
  if (paper.inLibrary) {
    const openBtn = mkBtn(`btn ${opts.prefix}-open-btn`, opts.openLabel, () => { if (paper.docId) opts.onOpen(paper.docId); });
    openBtn.disabled = opts.busy || !paper.docId;
    slot.append(el('span', `${opts.prefix}-lib-badge`, t('✓ In Library', '✓ 已在库')), openBtn);
    if (paper.docId && abstractOnlyDocIds.has(paper.docId)) {
      const attachBtn = mkBtn(`btn ${opts.prefix}-attach-btn`, researchText.attachPdfAction(), () => { if (paper.docId) opts.onOpen(paper.docId); });
      attachBtn.disabled = opts.busy;
      slot.append(attachBtn);
    }
    return;
  }
  const toggle = isArxivPaper(paper) ? createArxivFormatToggle(opts.arxivFormat ?? 'html') : undefined;
  if (toggle) {
    for (const b of toggle.root.querySelectorAll<HTMLButtonElement>('button')) b.disabled = opts.busy;
    slot.append(toggle.root);
  }
  const importBtn = mkBtn(`btn primary ${opts.prefix}-import-btn`, researchText.importPaper(), () => opts.onSave(toggle?.value()));
  importBtn.disabled = opts.busy;
  slot.append(importBtn);
}

export async function saveGraphPaper(
  paper: GraphPaper,
  opts?: { mode?: SavePaperMode; arxivFormat?: ArxivFormat },
  shell?: ResearchShellContext
): Promise<DocumentInfo> {
  const topic = shell?.activeTopic(), mode = opts?.mode ?? 'auto';
  const arxivFormat = opts?.arxivFormat ?? (isArxivPaper(paper) ? shell?.arxivFormat?.() : undefined);
  const res = await api('graph.savePaper', { paper, mode, ...(arxivFormat ? { arxivFormat } : {}), ...(topic ? { topicTag: topic } : {}) });
  if (res.doc.kind === 'abstract') abstractOnlyDocIds.add(res.doc.id); else abstractOnlyDocIds.delete(res.doc.id);
  shell?.notifyDocumentMutated(res.doc.id, false);
  if (res.arxivFallback === 'html-to-pdf') toast(researchText.arxivHtmlFallback());
  else if (res.attachPdfSuggested) toast(researchText.savedAbstractFallback(), shell ? { label: researchText.attachPdfAction(), run: () => shell.inspectInReader({ docId: res.doc.id, page: 1 }) } : undefined);
  else if (res.mode === 'oa-html') toast(researchText.importedHtml());
  else if (res.mode === 'oa-pdf') toast(researchText.importedPdf());
  else toast(researchText.savedAbstract());
  return res.doc;
}
