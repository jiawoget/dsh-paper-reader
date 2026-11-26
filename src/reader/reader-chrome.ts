import { byId, el, icon, message, readerLabel as label, syncTheme, toast, type Glyph } from './ui.js';

interface ReaderChromeHooks {
  getPage: () => number; onJumpPage: (page: number) => Promise<void>; onStepPage: (step: -1 | 1) => Promise<void>;
  onToggleSidebar: (tab: 'contents' | 'notes') => void; onCapture: () => void; onOpenLibrary: () => Promise<void>; onCloseMenu: () => void;
}
export const openLibraryLabel = () => label('Open library', '打开资料库');

export function initReaderChrome(hooks: ReaderChromeHooks): (id: string, fn: () => unknown) => void {
  document.documentElement.lang = /^zh(?:-|$)/i.test(navigator.language) ? 'zh-CN' : 'en';
  syncTheme();
  const click = (id: string, fn: () => unknown) => byId(id).addEventListener('click', () => { void Promise.resolve().then(fn).catch(error => toast(message(error))); });
  const glyphs: Record<string, Glyph> = { library: 'library', prev: 'back', next: 'next', more: 'more', mobileRail: 'book', closeRail: 'close', closeDialog: 'close', closeShortcuts: 'close' };
  for (const [id, name] of Object.entries(glyphs)) byId(id).append(icon(name));
  for (const [sel, en, zh] of [['.workspace', 'Reading area', '阅读区'], ['.toolbar', 'Reading tools', '阅读工具'], ['.reader-mode-switch', 'Reading mode', '阅读模式']] as const)
    document.querySelector<HTMLElement>(sel)!.ariaLabel = label(en, zh);
  for (const [id, en, zh, withTitle] of [
    ['menu', 'Reader actions', '更多菜单'], ['pageJump', 'Go to page', '跳转到页码'], ['paperScroll', 'Document pages', '文档页面'],
    ['pageSplit', 'Resize original and translation', '调整原文与译文宽度', true], ['selectionDock', 'Passage workspace', '选段工具区'],
    ['notesSplit', 'Resize notes', '调整笔记宽度', true], ['rail', 'Reading notes', '阅读笔记'], ['notebookPose', 'Notes position', '笔记位置', true],
    ['card', 'Selection card', '选区卡片'], ['closeShortcuts', 'Close keyboard shortcuts', '关闭快捷键帮助', true],
    ['closeDialog', 'Close dialog', '关闭窗口'], ['closeRail', 'Close notes', '关闭笔记', true],
    ['prev', 'Previous page', '上一页'], ['next', 'Next page', '下一页'], ['pageCount', 'Go to page', '跳转到页码', true], ['more', 'More actions', '更多操作']
  ] as const) { const node = byId(id); node.ariaLabel = label(en, zh); if (withTitle) node.title = node.ariaLabel; }
  for (const [id, en, zh] of [
    ['loading', 'Opening document…', '正在打开文档…'], ['shortcutsTitle', 'Keyboard shortcuts', '快捷键'], ['contentsTab', 'Contents', '目录'],
    ['notebookHandle', 'Notes', '笔记'], ['annotationsTab', 'Marks', '标记'], ['notesTab', 'Notes', '笔记'], ['refsTab', 'Reference', '文献']
  ] as const) byId(id).textContent = label(en, zh);
  byId('pageJump').querySelector('label')!.textContent = label('Page number', '页码');
  byId('pageJump').querySelector('button[type="submit"]')!.textContent = label('Go', '跳转');
  byId('library').append(el('span', '', label('Library', '资料库')));
  byId('library').ariaLabel = byId('library').title = openLibraryLabel();
  const contents = byId('contentsToggle');
  contents.replaceChildren(icon('contents'), el('span', '', label('Contents', '目录')));
  contents.ariaLabel = label('Contents', '目录');
  byId('contentsTab').parentElement!.ariaLabel = label('Reading sidebar', '阅读侧边栏');
  click('contentsToggle', () => hooks.onToggleSidebar('contents')); click('mobileRail', () => hooks.onToggleSidebar('notes'));
  for (const [id, step, name] of [['previousSection', -1, label('Previous section', '上一节')], ['nextSection', 1, label('Next section', '下一节')]] as const) {
    const control = byId(id); control.ariaLabel = control.title = name; control.append(icon(step < 0 ? 'back' : 'next'));
    click(id, () => hooks.onStepPage(step));
  }
  byId('mobileRail').append(el('span', '', label('Notes', '笔记')));
  byId('captureRegion').append(icon('capture'), el('span', 'capture-label')); click('captureRegion', () => hooks.onCapture());
  byId('originalMode').querySelector('.mode-full')!.textContent = label('Original', '原文');
  byId('originalMode').querySelector('.mode-compact')!.textContent = label('Orig', '原文');
  byId('parallel').querySelector('.mode-wide')!.textContent = label('Bilingual', '双语对照');
  byId('parallel').querySelector('.mode-narrow')!.textContent = label('Translation', '译文');
  byId('parallel').querySelector('.mode-compact')!.textContent = label('Trans', '译文');
  const display = byId<HTMLSelectElement>('highlightDisplay');
  display.ariaLabel = label('Highlight display', '高亮显示');
  display.closest('label')!.querySelector('span')!.textContent = label('Highlights', '高亮');
  display.options[0].text = label('In Notes', '随笔记显示'); display.options[1].text = label('In Marks only', '仅在标记中显示');
  byId('parallel').prepend(icon('columns', 14));
  const [sourceHead, targetHead] = document.querySelectorAll<HTMLElement>('.headings b');
  if (sourceHead) sourceHead.textContent = label('Original', '原文');
  if (targetHead) targetHead.textContent = label('Translation', '译文');
  click('library', () => hooks.onOpenLibrary()); click('prev', () => hooks.onStepPage(-1)); click('next', () => hooks.onStepPage(1));
  const jump = byId<HTMLFormElement>('pageJump'), input = byId<HTMLInputElement>('pageNumber');
  jump.addEventListener('beforetoggle', event => { if (event.newState === 'open') input.value = String(hooks.getPage()); });
  jump.addEventListener('toggle', () => {
    if (!jump.matches(':popover-open')) return;
    const anchor = byId('pageCount').getBoundingClientRect(), below = anchor.bottom + 6 + jump.offsetHeight <= innerHeight - 8;
    jump.style.top = Math.max(8, Math.min(innerHeight - jump.offsetHeight - 8, below ? anchor.bottom + 6 : anchor.top - jump.offsetHeight - 6)) + 'px';
    jump.style.left = Math.max(8, Math.min(anchor.left, innerWidth - jump.offsetWidth - 8)) + 'px';
    input.select();
  });
  jump.addEventListener('submit', event => { event.preventDefault(); jump.hidePopover(); void hooks.onJumpPage(input.valueAsNumber).catch(error => toast(message(error))); });
  window.addEventListener('resize', () => { if (jump.matches(':popover-open')) jump.hidePopover(); if (!byId('menu').hidden) hooks.onCloseMenu(); });
  return click;
}
