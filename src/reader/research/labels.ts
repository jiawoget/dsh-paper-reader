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
  expand: () => t('Expand to Research Workspace', '展开科研工作台'),
  expandWithKey: () => t('Expand to Research Workspace (Ctrl/Cmd+Shift+R)', '展开科研工作台 (Ctrl/Cmd+Shift+R)'),
  collapse: () => t('Back to Reader', '收起回精读'),
  expandRail: () => t('Expand navigation rail', '展开导航栏'),
  collapseRail: () => t('Collapse navigation rail', '折叠导航栏'),
  viewsNav: () => t('Research views', '科研视图'),
  returnTo: (viewName: string) => t(`Back to Research Workspace (${viewName})`, `返回科研工作台（${viewName}）`),
  dismissReturn: () => t('Stay in reader', '留在精读模式'),
  topicLabel: () => t('Topic', '课题'),
  allTopics: () => t('All papers', '全部文献'),
  newTopic: () => t('New topic', '新建课题'),
  topicPlaceholder: () => t('Topic name…', '输入课题名称…'),
  saveTopic: () => t('Save', '保存'),
  searchLabel: () => t('Search local library full text', '检索本地文献库全文'),
  searchPlaceholder: () => t('Search across indexed papers…', '跨文献全文检索…'),
  searchAction: () => t('Search', '检索'),
  searching: () => t('Searching…', '正在检索…'),
  searchEmpty: () => t('No matching passages found.', '未找到匹配的原文段落。'),
  searchHint: () => t('Search indexed local papers or filter by topic, then jump directly to the highlighted page.', '按课题筛选或在已索引的本地文献中检索原文，点击结果即可跳转精读高亮。'),
  pageBadge: (page: number) => t(`p. ${page}`, `第 ${page} 页`)
};
