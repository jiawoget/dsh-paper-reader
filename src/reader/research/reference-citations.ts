import type { CitationStance, CitationSummary } from '../../shared/citation-stance-types.js';
import type { DocumentInfo } from '../../shared/types.js';
import { api, el, readerLabel as t, safeWeb, type ReaderPort } from '../ui.js';
import { researchViewName } from './labels.js';
import { mkBtn } from './paper-intake.js';

export const STANCE_ITEMS: readonly { key: CitationStance; icon: string; en: string; zh: string }[] = [
  { key: 'supporting', icon: '✓', en: 'Supporting', zh: '支持' },
  { key: 'extending', icon: '↗', en: 'Extending', zh: '拓展' },
  { key: 'contrasting', icon: '⊘', en: 'Contrasting', zh: '反驳' },
  { key: 'mentioning', icon: '💬', en: 'Mentioning', zh: '提及' },
  { key: 'unclassified', icon: '○', en: 'Unclassified', zh: '无语境' }
];

export const stanceText = (stance: CitationStance): string => {
  const m = STANCE_ITEMS.find(x => x.key === stance) ?? STANCE_ITEMS[4];
  return t(m.en, m.zh);
};

export const stanceBadge = (stance: CitationStance): string => {
  const m = STANCE_ITEMS.find(x => x.key === stance) ?? STANCE_ITEMS[4];
  return `${m.icon} ${t(m.en, m.zh)}`;
};

let summarySeq = 0;

export function mountReferenceCitations(app: ReaderPort, doc: DocumentInfo, parent: HTMLElement): void {
  if (!app.openResearchWorkspace) return;
  const openCitations = (stance?: CitationStance) => app.openResearchWorkspace?.('citations', { docId: doc.id, ...(stance ? { stance } : {}) });
  const section = el('section', 'ref-cit-box');
  section.setAttribute('aria-label', researchViewName('citations'));
  const head = el('div', 'ref-cit-head'), heading = el('h3', '', researchViewName('citations'));
  const localTag = el('span', 'ref-cit-local'); localTag.hidden = true;
  head.append(heading, localTag);
  const body = el('div', 'ref-cit-body');
  const actions = el('div', 'ref-cit-actions');
  const allBtn = mkBtn('btn ref-cit-all', t('⤢ All citations', '⤢ 查看全部引用分析'), () => openCitations());
  const sciteLink = el('a', 'btn ref-cit-scite', 'Scite ↗');
  sciteLink.target = '_blank'; sciteLink.rel = 'noopener noreferrer';
  sciteLink.ariaLabel = t('Open Scite report', '打开 Scite 报告');
  sciteLink.hidden = true;
  actions.append(allBtn, sciteLink);
  body.append(el('p', 'ref-cit-loading', t('Checking citations…', '正在检查引用…')));
  section.append(head, body, actions);
  parent.append(section);

  const renderSummary = (summary: CitationSummary) => {
    const { tallies } = summary;
    localTag.hidden = tallies.localBackCitations <= 0;
    if (!localTag.hidden) localTag.textContent = t(`★ ${tallies.localBackCitations} local`, `★ ${tallies.localBackCitations} 本地反引`);
    const href = safeWeb(summary.sciteUrl);
    sciteLink.hidden = !href;
    if (href) sciteLink.href = href;
    const row = el('div', 'ref-cit-tallies');
    const totalBtn = mkBtn('ref-cit-pill', t(`Total ${tallies.citationStatements}`, `总计 ${tallies.citationStatements}`), () => openCitations());
    totalBtn.dataset.stance = 'all';
    totalBtn.ariaLabel = totalBtn.title = t(`All citation statements: ${tallies.citationStatements}`, `全部引用语句：${tallies.citationStatements}`);
    row.append(totalBtn);
    for (const item of STANCE_ITEMS) {
      if (item.key === 'unclassified') continue;
      const count = tallies[item.key], label = `${item.icon} ${t(item.en, item.zh)} ${count}`;
      const btn = mkBtn(`ref-cit-pill${count === 0 ? ' is-zero' : ''}`, label, () => openCitations(count > 0 ? item.key : undefined));
      btn.dataset.stance = item.key;
      btn.ariaLabel = btn.title = count === 0 ? t(`${item.en}: 0 — show all citations`, `${item.zh}：0 — 查看全部引用`) : t(`${item.en}: ${count}`, `${item.zh}：${count}`);
      row.append(btn);
    }
    body.replaceChildren(row);
  };

  const seq = ++summarySeq;
  void api('citations.summary', { docId: doc.id }).then(summary => {
    if (seq !== summarySeq || !section.isConnected || app.doc.id !== doc.id) return;
    renderSummary(summary);
  }).catch(() => {
    if (seq !== summarySeq || !section.isConnected || app.doc.id !== doc.id) return;
    body.replaceChildren();
  });
}
