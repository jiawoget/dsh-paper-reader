import type { DocumentInfo, GraphPaper } from '../../shared/types.js';
import { api, el, readerLabel as t, toast } from '../ui.js';
import type { ResearchShellContext } from './state.js';

const SRC_NAME: Record<string, string> = { openalex: 'OpenAlex', s2: 'Semantic Scholar', europepmc: 'Europe PMC', arxiv: 'arXiv' };
export const isAbortError = (err: unknown): boolean => err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && /abort|cancel/i.test(err.message);
export const mkBtn = (cls: string, text: string, onClick: () => void): HTMLButtonElement => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; };
export const formatDegradedSources = (sources: readonly string[]): string => !sources.length ? '' : t(
  `Partial data: ${[...new Set(sources)].map(s => SRC_NAME[s] ?? s).join(', ')} unavailable, using fallback sources.`,
  `数据源降级：${[...new Set(sources)].map(s => SRC_NAME[s] ?? s).join(', ')} 暂不可用，已切换备用源。`
);

export function renderPaperActions(
  slot: HTMLElement, paper: GraphPaper,
  opts: { prefix: string; busy: boolean; openLabel: string; onOpen: (docId: string) => void; onSave: (mode: 'abstract' | 'oa-pdf') => void }
): void {
  slot.replaceChildren();
  if (paper.inLibrary) {
    const openBtn = mkBtn(`btn ${opts.prefix}-open-btn`, opts.openLabel, () => { if (paper.docId) opts.onOpen(paper.docId); });
    openBtn.disabled = opts.busy || !paper.docId;
    slot.append(el('span', `${opts.prefix}-lib-badge`, t('✓ In Library', '✓ 已在库')), openBtn);
    return;
  }
  const saveAbs = mkBtn(`btn ${opts.prefix}-save-abs`, t('+ Save Abstract only', '+ 仅摘要入库'), () => opts.onSave('abstract'));
  saveAbs.disabled = opts.busy; slot.append(saveAbs);
  if (paper.oaPdfUrl) { const b = mkBtn(`btn primary ${opts.prefix}-save-pdf`, t('+ Import OA PDF', '+ 拉取 OA PDF'), () => opts.onSave('oa-pdf')); b.disabled = opts.busy; slot.append(b); }
}

export async function saveGraphPaper(paper: GraphPaper, saveMode: 'abstract' | 'oa-pdf', shell?: ResearchShellContext): Promise<DocumentInfo> {
  const topic = shell?.activeTopic(), res = await api('graph.savePaper', { paper, mode: saveMode, ...(topic ? { topicTag: topic } : {}) });
  shell?.notifyDocumentMutated(res.doc.id, false);
  toast(saveMode === 'oa-pdf' ? t('Imported OA PDF into library.', '已拉取 OA PDF 入库。') : t('Saved Abstract only into library.', '已仅摘要入库。'));
  return res.doc;
}
