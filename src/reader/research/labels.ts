import type { DocResourceKind } from '../../shared/doc-resources.js';
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
  attachPdfAction: () => t('Attach PDF', '附加 PDF'),
  chartView: () => t('Chart', '趋势图'),
  matrixView: () => t('Matrix', '热力表'),
  myLibrary: () => t('My Library', '我的文库'),
  blindSpot: () => t('Blind spot', '盲区'),
  trendsGuide: () => t(
    'Compare publication volume, YoY growth, citation heat, and library blind spots across years. Dashed tail marks partial YTD data; n < 10 low-base growth is muted.',
    '跨年份对比发文量、同比增速、引文热度与本地文库盲区；末端虚线表示当年截至目前 (YTD) 数据，低基数 (n < 10) 增速淡显。'
  ),
  ytdGrowthNote: () => t('Partial YTD year (YoY N/A)', '当年为截至目前 (YTD) 数据，暂无同比增速'),
  lowBaseTag: () => t('Low base (n < 10)', '低基数 (n < 10)'),
  resetSeries: () => t('Reset series', '显示全部曲线'),
  screeningStep: () => t('1. Screening', '1. 文献筛选'),
  extractionStep: () => t('2. Extraction', '2. 数据提取'),
  screeningTip: () => t(
    'Define inclusion criteria and screen papers as Yes, Maybe, or No before extraction.',
    '设置纳入标准并将文献初筛为纳入、待定或排除，再进入数据提取。'
  ),
  extractionTip: () => t(
    'Extract structured evidence across papers with verifiable quotes, or click any paper title for a quick summary.',
    '按列提取多篇文献的结构化信息与可核验原文引句，点击任意论文标题可查看右侧概览。'
  ),
  exportLabel: () => t('Export', '导出'),
  exportMenu: () => t('Export format', '选择导出格式'),
  exportMd: () => t('Markdown (.md)', 'Markdown (.md)'),
  exportCsv: () => t('CSV (.csv)', 'CSV (.csv)'),
  templates: () => t('Templates', '列模板'),
  presetGeneral: () => t('General', '通用研究'),
  presetCsAi: () => t('CS / AI', 'CS / AI'),
  presetPico: () => t('Clinical PICO', '临床 PICO'),
  presetCustom: () => t('Custom', '自定义'),
  paperSummary: () => t('Paper Summary', '论文概览'),
  openInReader: () => t('Open in Reader', '在阅读器中打开'),
  abstractHeading: () => t('Abstract', '摘要'),
  tagsHeading: () => t('Tags', '标签'),
  noAbstract: () => t('No abstract recorded for this paper.', '该文献暂无摘要信息。'),
  paperQuickActions: () => t('Quick actions', '快捷操作'),
  selectPaper: () => t('Select paper', '勾选文献'),
  stop: () => t('Stop', '停止'),
  translatingRow: () => t('Translating…', '正在翻译…'),
  translatingProgress: (done: number, total: number) => t(`Translating ${done} / ${total}…`, `正在翻译 ${done} / ${total}…`),
  pausedProgress: (done: number, total: number) => t(`Paused (${done} / ${total})`, `已暂停（${done} / ${total}）`),
  resumeTranslation: () => t('Resume', '继续翻译'),
  translationGuidanceLocalOnly: (lang: string) => t(`Offline translation supports Simplified Chinese only. Connect a model for ${lang}.`, `离线翻译仅支持简体中文，请在连接设置中配置模型以翻译为${lang}。`),
  translationGuidanceConnect: (lang: string) => t(`Connect a model in Connections to translate into ${lang}.`, `请在连接设置中配置模型以翻译为${lang}。`),
  openFile: () => t('Open file', '打开文件'),
  openFileHint: () => t('Open PDF, PPTX, DOCX, Markdown, or HTML file', '打开 PDF、PPTX、DOCX、Markdown 或 HTML 文件'),
  dropFilesToImport: () => t('Drop PDF, PPTX, DOCX, Markdown, or HTML files to import', '松开以导入 PDF、PPTX、DOCX、Markdown 或 HTML 文件'),
  chooseSupportedFile: () => t('Choose a PDF, PPTX, DOCX, Markdown, or HTML file.', '请选择 PDF、PPTX、DOCX、Markdown 或 HTML 文件。'),
  fileTooLarge32Mb: () => t('Choose a file of up to 32 MB.', '请选择不超过 32 MB 的文件。'),
  localDocument: () => t('Local document', '本地文档'),
  speakerNotes: () => t('Speaker notes', '演讲者备注'),
  legacyPptUnsupported: () => t('Legacy binary .ppt files are not supported directly. Save or export as .pptx or PDF, then import again.', '暂不支持旧版二进制 .ppt 格式，请另存或导出为 .pptx 或 PDF 后再导入。'),
  resourcesHeading: () => t('Resources', '关联资源'),
  findLinks: () => t('Find links', '查找链接'),
  findingLinks: () => t('Finding…', '查找中…'),
  addLink: () => t('+ Add link', '+ 添加链接'),
  resourceUrlMode: () => t('URL', '网页链接'),
  resourceDocMode: () => t('Library doc', '本地文档'),
  resourceModeGroup: () => t('Link type', '链接方式'),
  resourceUrlLabel: () => t('Resource URL', '资源链接'),
  resourceTitleLabel: () => t('Title (optional)', '标题（可选）'),
  resourceKindLabel: () => t('Type', '类型'),
  resourceDocLabel: () => t('Companion document', '关联本地文档'),
  resourceDocPlaceholder: () => t('Select a library document…', '选择资料库文档…'),
  resourceNoOtherDocs: () => t('No other library documents available.', '资料库中暂无其他文档。'),
  resourceAddSubmit: () => t('Link', '关联'),
  resourceCancel: () => t('Cancel', '取消'),
  resourceAccept: () => t('Accept', '采纳'),
  resourceDismiss: () => t('Dismiss', '忽略'),
  resourceRemove: () => t('Remove link', '移除链接'),
  resourceLinkedFrom: () => t('Linked from', '关联文献'),
  resourceSuggested: () => t('Suggestions', '待确认推荐'),
  resourcePendingBadge: (n: number) => t(`${n} suggested`, `${n} 条推荐`),
  resourceFoundToast: (n: number) => n > 0 ? t(`Found ${n} new link${n === 1 ? '' : 's'}.`, `发现 ${n} 条新链接。`) : t('No new links found.', '未发现新链接。'),
  resourceInvalidUrl: () => t('Enter a valid http or https URL.', '请输入有效的 http 或 https 链接。'),
  resourceNeedTarget: () => t('Provide a URL or choose a library document.', '请输入链接或选择一个本地文档。'),
  resourceKind: (kind: DocResourceKind) =>
    kind === 'code' ? t('Code', '代码')
    : kind === 'talk' ? t('Talk', '报告视频')
    : kind === 'slides' ? t('Slides', '幻灯片')
    : kind === 'project' ? t('Project', '项目主页')
    : kind === 'dataset' ? t('Dataset', '数据集')
    : t('Other', '其他')
};
