import { readerLabel as t } from '../ui.js';

export const RESEARCH_VIEWS = [
  { id: 'deep-search', en: 'Deep Search', zh: '深度检索', dense: false },
  { id: 'citation-map', en: 'Citation Map', zh: '引文脉络', dense: true },
  { id: 'citations', en: 'Citations', zh: '引用分析', dense: false },
  { id: 'review-table', en: 'Review Table', zh: '文献筛选与提取', dense: true },
  { id: 'field-trends', en: 'Field Trends', zh: '研究趋势', dense: true },
  { id: 'library-chat', en: 'Library Chat', zh: '文献库对话', dense: false }
] as const;

export type ResearchViewId = typeof RESEARCH_VIEWS[number]['id'];

export function researchViewMeta(id: ResearchViewId) {
  return RESEARCH_VIEWS.find(view => view.id === id) ?? RESEARCH_VIEWS[0];
}

export function researchViewName(id: ResearchViewId): string {
  const view = researchViewMeta(id);
  return t(view.en, view.zh);
}

export const researchText = {
  workspace: () => t('Research Workspace', '科研工作台'),
  readMode: () => t('Read', '精读'),
  researchMode: () => t('Research', '科研'),
  modeSwitch: () => t('Workspace mode', '工作模式'),
  expandWithKey: () => t('Research Workspace (Ctrl/Cmd+Shift+R)', '科研工作台 (Ctrl/Cmd+Shift+R)'),
  collapse: () => t('Back to Reader', '返回精读'),
  expandRail: () => t('Expand navigation rail', '展开导航栏'),
  collapseRail: () => t('Collapse navigation rail', '折叠导航栏'),
  viewsNav: () => t('Research views', '科研视图'),
  returnTo: (viewName: string) => t(`Back to ${viewName}`, `返回${viewName}`),
  dismissReturn: () => t('Stay in reader', '留在精读模式'),
  askAi: () => t('Ask AI', '问 AI'),
  savePaper: () => t('Save', '入库'),
  paperActions: () => t('Paper actions', '论文操作'),
  infoLabel: () => t('More information', '功能说明'),
  saveTopic: () => t('Save', '保存'),
  all: () => t('All', '全部'),
  open: () => t('Open', '打开'),
  pageBadge: (page: number) => t(`p. ${page}`, `第 ${page} 页`),
  importPaper: () => t('Import', '导入'),
  importSelected: () => t('Import selected', '批量导入'),
  arxivFormat: () => t('arXiv import format', 'arXiv 导入格式'),
  arxivHtmlDefault: () => t('HTML (default)', 'HTML（默认）'),
  arxivHtmlFallback: () => t('arXiv HTML unavailable; imported PDF instead.', '该 arXiv 论文暂无 HTML 版本，已自动导入 PDF。'),
  importedHtml: () => t('Imported full-text HTML into library.', '已导入全文 HTML 至资料库。'),
  importedPdf: () => t('Imported PDF into library.', '已导入 PDF 至资料库。'),
  savedAbstractFallback: () => t('No public full text found — saved abstract. You can attach a PDF anytime.', '未找到公开全文，已保存摘要；可随时手动关联 PDF。'),
  savedAbstract: () => t('Saved abstract into library.', '已保存摘要至资料库。'),
  attachPdfAction: () => t('Attach PDF', '附加 PDF')
};
