import { byId, el, readerLabel as label } from './ui.js';

interface ShortcutActions {
  isCapturing: () => boolean;
  isPlacingPin: () => boolean;
  isSearchOpen: () => boolean;
  openSearch: () => void;
  closeSearch: () => void;
  cancelCapture: () => void;
  closeMenu: () => void;
  dismissDrawer: () => boolean;
  dismissCard: () => void;
  canNextPage: () => boolean;
  canPrevPage: () => boolean;
  canNextSection: () => boolean;
  canPrevSection: () => boolean;
  canJumpBack: () => boolean;
  canJumpForward: () => boolean;
  jumpBack: () => void;
  jumpForward: () => void;
  toggleBilingual: () => void;
  toggleSidebar: (tab: 'contents' | 'notes' | 'marks' | 'reference') => void;
  stepZoom: (delta: -1 | 1) => void;
  isResearchWorkspaceOpen: () => boolean;
  toggleResearchWorkspace: () => void;
  handleWorkspaceEscape: () => boolean;
}

export function installShortcuts(actions: ShortcutActions): { open: () => void } {
  const hints: [string, string, string][] = [
    ['library', 'Open library (L)', '打开资料库 (L)'],
    ['pageCount', 'Go to page (G)', '跳转到页码 (G)'],
    ['parallel', 'Bilingual (B)', '双语对照 (B)'],
    ['contentsTab', 'Contents (C)', '目录 (C)'],
    ['notesTab', 'Notes (N)', '笔记 (N)'],
    ['annotationsTab', 'Marks (M)', '标记 (M)'],
    ['refsTab', 'Reference (R)', '文献 (R)']
  ];
  for (const [id, en, zh] of hints) byId(id).title = label(en, zh);
  const dialog = byId<HTMLDialogElement>('shortcutsDialog');
  let returnFocus: HTMLElement | undefined;
  byId('closeShortcuts').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const target = returnFocus; returnFocus = undefined;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });

  const open = () => {
    if (dialog.open) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const body = byId('shortcutsBody'); body.replaceChildren();
    const groups: [string, [string[], string][]][] = [
      [label('Reading', '阅读'), [
        [['←', '→'], label('Previous or next page / book section', '上一页或下一页 / 书籍上一节或下一节')],
        [['g'], label('Go to page', '跳转到页码')],
        [['Alt+←', 'Alt+→'], label('Jump back or forward in reading history', '在阅读跳转历史中后退或前进')],
        [['Ctrl/Cmd+F'], label('Find in document', '文档内搜索')],
        [['b'], label('Toggle original and bilingual view', '切换原文与双语对照')],
        [['s'], label('Ask with a screenshot', '截图问 AI')],
        [['+', '=', '-'], label('Zoom in or zoom out', '放大或缩小页面')],
        [['?'], label('Open keyboard shortcuts', '打开快捷键帮助')],
        [['Esc'], label('Cancel screenshot, close menu, card, or dialog', '取消截图，关闭菜单、卡片或弹窗')]
      ]],
      [label('Panels', '侧边栏与弹窗'), [
        [['l'], label('Open library', '打开资料库')],
        [['n'], label('Toggle Notes sidebar', '打开或收起笔记栏')],
        [['c'], label('Toggle Contents sidebar', '打开或收起目录栏')],
        [['m'], label('Toggle Marks sidebar', '打开或收起标记栏')],
        [['r'], label('Toggle Reference sidebar', '打开或收起文献栏')],
        [['Ctrl/Cmd+Shift+R'], label('Open or collapse Research Workspace', '展开或收起科研工作台')],
        [['←', '→', 'Home', 'End'], label('Switch tabs in sidebar, Library, Connections, or Vocabulary and history', '在侧栏、资料库、连接设置或生词与历史中切换标签页')]
      ]],
      [label('Notes editor', '笔记编辑器'), [
        [['Ctrl/Cmd+S'], label('Save notes', '保存笔记')],
        [['Ctrl/Cmd+B'], label('Bold text', '加粗文字')],
        [['Ctrl/Cmd+I'], label('Italic text', '斜体文字')],
        [['Ctrl/Cmd+Z', 'Ctrl/Cmd+Y'], label('Undo or redo', '撤销或重做')]
      ]],
      [label('Composers', '输入与问答'), [
        [['Enter', 'Shift+Enter'], label('Send Paper chat or selection message / new line', '发送全文问答或选段提问 / 换行')],
        [['Ctrl/Cmd+Enter'], label('Save selection note or mark', '保存选区笔记或标记')]
      ]]
    ];
    for (const [heading, rows] of groups) {
      const group = el('section', 'shortcuts-group'), table = el('table', 'shortcuts-table'), headRow = el('tr');
      const keyHead = el('th', '', label('Key', '按键')), actionHead = el('th', '', label('Action', '操作'));
      keyHead.scope = actionHead.scope = 'col'; headRow.append(keyHead, actionHead);
      const thead = el('thead'), tbody = el('tbody'); thead.append(headRow);
      for (const [keys, description] of rows) {
        const tr = el('tr'), keyCell = el('td');
        keys.forEach((key, index) => { if (index > 0) keyCell.append(' / '); keyCell.append(el('kbd', '', key)); });
        tr.append(keyCell, el('td', '', description)); tbody.append(tr);
      }
      table.append(thead, tbody); group.append(el('h3', '', heading), table); body.append(group);
    }
    dialog.showModal(); dialog.scrollTop = 0;
  };

  document.addEventListener('keydown', e => {
    if (document.querySelector(':popover-open') || e.isComposing || e.keyCode === 229) return;
    const openDialog = document.querySelector('dialog[open]');
    if (e.key === 'Escape' && !e.defaultPrevented && !openDialog) {
      if (actions.isResearchWorkspaceOpen()) { if (actions.handleWorkspaceEscape()) e.preventDefault(); return; }
      if (actions.isCapturing()) { e.preventDefault(); actions.cancelCapture(); return; }
      if (!byId('menu').hidden) { actions.closeMenu(); return; }
      if (actions.dismissDrawer()) return;
      if (!byId('card').hidden) { actions.dismissCard(); return; }
      if (actions.isSearchOpen()) { e.preventDefault(); actions.closeSearch(); return; }
    }
    if (!e.defaultPrevented && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r' && !openDialog) {
      e.preventDefault(); actions.toggleResearchWorkspace(); return;
    }
    if (actions.isResearchWorkspaceOpen()) return;
    if (!e.defaultPrevented && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && !openDialog) {
      if (byId('rail').hasAttribute('aria-modal')) return;
      if (e.target instanceof Element && e.target.closest('.cm-editor, dialog')) return;
      e.preventDefault(); actions.openSearch(); return;
    }
    if (!e.defaultPrevented && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !openDialog && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (actions.isCapturing() || actions.isPlacingPin() || !byId('menu').hidden || byId('rail').hasAttribute('aria-modal')) return;
      if (e.target instanceof Element && e.target.closest('input,textarea,select,dialog,#menu,[contenteditable]:not([contenteditable="false"]),.cm-editor')) return;
      e.preventDefault();
      if (e.key === 'ArrowLeft' && actions.canJumpBack()) actions.jumpBack();
      else if (e.key === 'ArrowRight' && actions.canJumpForward()) actions.jumpForward();
      return;
    }
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || openDialog) return;
    if (e.shiftKey && e.key !== '?' && e.key !== '+') return;
    if (actions.isCapturing() || actions.isPlacingPin() || !byId('menu').hidden || byId('rail').hasAttribute('aria-modal')) return;
    if (e.target instanceof Element && e.target.closest('#card,#selectionDock,.doc-search,.annotation-popover,input,textarea,select,dialog,#menu,.desk-split,.paper-chat-grip,[contenteditable]:not([contenteditable="false"]),.cm-editor')) return;
    if (e.key === '?') { e.preventDefault(); open(); return; }
    const caret = document.getSelection()?.focusNode;
    const inPdfText = Boolean(caret?.parentElement?.closest('.pdf-native-text,.pdf-reading-text'));
    if (e.key === 'ArrowRight' && !inPdfText) {
      if (actions.canNextPage()) { e.preventDefault(); byId('next').click(); }
      else if (actions.canNextSection()) { e.preventDefault(); byId('nextSection').click(); }
    }
    if (e.key === 'ArrowLeft' && !inPdfText) {
      if (actions.canPrevPage()) { e.preventDefault(); byId('prev').click(); }
      else if (actions.canPrevSection()) { e.preventDefault(); byId('previousSection').click(); }
    }
    const key = e.key.toLowerCase();
    if (key === 'b') { e.preventDefault(); actions.toggleBilingual(); }
    if (key === 'n') { e.preventDefault(); actions.toggleSidebar('notes'); }
    if (key === 'c') { e.preventDefault(); actions.toggleSidebar('contents'); }
    if (key === 'm') { e.preventDefault(); actions.toggleSidebar('marks'); }
    if (key === 'r') { e.preventDefault(); actions.toggleSidebar('reference'); }
    if (key === 'l') { e.preventDefault(); byId('library').click(); }
    if (key === 'g') {
      const pageBtn = byId<HTMLButtonElement>('pageCount');
      if (!pageBtn.disabled && !pageBtn.closest('[hidden]')) {
        e.preventDefault();
        byId<HTMLFormElement>('pageJump').showPopover();
        const input = byId<HTMLInputElement>('pageNumber');
        input.focus(); input.select();
      }
    }
    if (key === 's' && !byId('captureRegion').hidden) { e.preventDefault(); byId('captureRegion').click(); }
    if (e.key === '=' || e.key === '+' || e.key === '-') {
      e.preventDefault();
      actions.stepZoom(e.key === '-' ? -1 : 1);
    }
  });
  return { open };
}
