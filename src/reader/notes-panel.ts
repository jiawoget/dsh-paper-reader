import type { SourceRecord } from '../shared/types.js';
import { chapterPassageLabel } from '../shared/notebook-structure.js';
import { formatReadingPackMarkdown, readingPackFilename } from '../shared/reading-pack.js';
import { readSelectionRange, readTranslatedLocator } from '../shared/source-link.js';
import { currentNotebookMarkdown, flushNotebook, notebookEditor } from './notebook.js';
import { settingsDialog } from './settings-dialog.js';
import { api, button, copyText, downloadFile, el, icon, readerLabel as label, sourceUrl, toast, type ReaderPort } from './ui.js';

export function sourceChip(app: ReaderPort, source: Pick<SourceRecord, 'docId' | 'page' | 'anchor' | 'label'> & { sourceUrl?: string; context?: string }, quote = ''): HTMLButtonElement {
  const url = source.sourceUrl && URL.canParse(source.sourceUrl) ? new URL(source.sourceUrl) : undefined;
  const savedTarget = url && readTranslatedLocator(url);
  const legacyTarget = source.context && source.context !== quote && /\p{Script=Han}/u.test(source.context) ? { text: source.context } : undefined;
  const target = savedTarget && source.context?.startsWith(savedTarget.text) ? { ...savedTarget, text: source.context } : savedTarget ?? legacyTarget;
  const section = app.doc.id === source.docId && app.doc.book?.sections[source.page - 1];
  const location = section ? chapterPassageLabel(section.title, source.label) :
    (app.doc.kind === 'web' ? label('Article', '文章') : label('p. ' + source.page, '第 ' + source.page + ' 页')) + (source.label ? ' · ' + source.label : '');
  const chip = button(location, () => url?.searchParams.has('reply') ? app.openNotebookSource(url)
    : app.navigate(source.docId, source.page, source.anchor, quote, target, url && readSelectionRange(url)), 'source-chip');
  chip.append(icon('arrow', 10));
  chip.onmouseenter = () => { if (app.doc.id === source.docId && app.page === source.page) app.view?.highlight(source.anchor, true, quote, target); };
  chip.onmouseleave = () => { if (app.doc.id === source.docId && app.page === source.page) app.view?.highlight(source.anchor, false); };
  return chip;
}

const figureCache = new Map<string, string>();
function guide(app: ReaderPort, parent: HTMLElement): void {
  const link = (anchor: string, caption: string, quote = '') => sourceChip(app, { docId: 'pagedattention', page: 6, anchor, label: caption }, quote);
  const one = el('section', 'sample-section');
  one.append(el('h3', '', label('From page 6', '第 6 页要点')),
    el('p', '', label('Trace a request from its logical blocks to the physical KV cache. The mapping lets a sequence grow without reserving contiguous memory.', '顺着请求查看逻辑块如何映射到物理 KV 缓存。通过这种映射，序列无需预先占用连续显存即可动态增长。')),
    el('blockquote', 'quote', '“the mapping between logical and physical KV blocks of each request”'),
    link('block-tables', label('Left column', '左栏'), 'block tables'));
  const two = el('section', 'sample-section');
  two.append(el('h3', '', label('What does a block table store?', '块表里存了什么？')),
    el('p', '', label('A request keeps a table of physical block locations. The next token can use a free slot in its last block.', '每个请求都会维护一张物理块位置表，新生成的 token 可以直接写入最后一个块中的空位。')));
  const image = app.page === 6 ? app.view?.figureImage?.('figure-6') : undefined;
  if (image) figureCache.set('figure-6', image);
  const src = figureCache.get('figure-6');
  if (src) {
    const thumb = button('', () => app.navigate('pagedattention', 6, 'figure-6'), 'thumb'), img = el('img');
    img.src = src; img.alt = label('Figure 6. Block table translation in vLLM.', '图 6：vLLM 中的块表映射示意图。');
    thumb.setAttribute('aria-label', label('Locate Figure 6', '定位到图 6')); thumb.append(img); two.append(thumb);
  }
  two.append(link('figure-6', label('Figure 6', '图 6')));
  const three = el('section', 'sample-section'), check = el('input');
  check.type = 'checkbox'; check.checked = localStorage.getItem('reader.reviewed-figure-6') === 'yes';
  check.onchange = () => localStorage.setItem('reader.reviewed-figure-6', check.checked ? 'yes' : 'no');
  const checkLabel = el('label', 'check-row'); checkLabel.append(check, label('Revisit the mapping in Figure 6.', '回看图 6 中的块表映射。'));
  three.append(el('h3', '', label('To revisit', '待回顾')), checkLabel); parent.append(one, two, three);
}

const packBars = new WeakMap<ReaderPort, Partial<Record<'notes' | 'marks', { root: HTMLElement; obsidian: HTMLButtonElement }>>>();

async function fetchLinkedZotero(app: ReaderPort, docId: string) {
  if (app.state.settings.zoteroMode !== 'desktop' && !app.state.settings.zoteroLibraryId) return null;
  const lookup = async () => {
    const status = await api('zotero.status', {});
    if (!status.connected) return null;
    const { item } = await api('zotero.get', { docId });
    if (!item) return null;
    const link = status.mode === 'desktop' ? 'zotero://select/library/items/' + encodeURIComponent(item.key) : item.webUrl;
    return link ? { ...item, link } : item;
  };
  return Promise.race([lookup().catch(() => null), new Promise<null>(resolve => window.setTimeout(() => resolve(null), 800))]);
}

async function buildReadingPack(app: ReaderPort): Promise<{ content: string; filename: string } | undefined> {
  const doc = app.doc, markdown = currentNotebookMarkdown(app);
  const notes = markdown !== undefined ? markdown : app.state.notes.filter(note => note.docId === doc.id);
  const marks = app.documentMarks(), vocabulary = app.state.vocabulary.filter(word => word.docId === doc.id);
  const zotero = await fetchLinkedZotero(app, doc.id);
  if (app.doc.id !== doc.id) return undefined;
  return { content: formatReadingPackMarkdown(doc, notes, marks, vocabulary, zotero), filename: readingPackFilename(doc, zotero) };
}

export function readingPackBar(app: ReaderPort, slot: 'notes' | 'marks'): HTMLElement {
  let slots = packBars.get(app);
  if (!slots) { slots = {}; packBars.set(app, slots); }
  let entry = slots[slot];
  if (!entry) {
    const root = el('div', 'reading-pack-bar');
    root.setAttribute('role', 'group');
    root.ariaLabel = label('Export Markdown', '导出 Markdown');
    const copy = button(label('Copy Markdown', '复制 Markdown'), async () => {
      const pack = await buildReadingPack(app);
      if (!pack) return;
      toast((await copyText(pack.content))
        ? label('Markdown copied to clipboard.', 'Markdown 已复制到剪贴板。')
        : label('Clipboard access was blocked. Use Download instead.', '剪贴板权限受限，请改用下载按钮。'));
    }, 'btn reading-pack-btn');
    const download = button(label('Download .md', '下载 .md'), async () => {
      const pack = await buildReadingPack(app);
      if (!pack) return;
      downloadFile(pack.filename, pack.content, 'text/markdown;charset=utf-8');
      toast(label(`Downloaded ${pack.filename}.`, `已下载 ${pack.filename}。`));
    }, 'btn reading-pack-btn');
    const obsidian = button(label('Export to Obsidian', '导出到 Obsidian'), async () => {
      await flushNotebook(app);
      await api('obsidian.export', { docId: app.doc.id, title: app.doc.title, page: app.page, sourceUrl: sourceUrl(app.doc.id, app.page) });
      await app.refresh();
      toast(label('Exported to Obsidian.', '已导出到 Obsidian。'));
    }, 'btn reading-pack-btn reading-pack-obsidian');
    root.append(copy, download, obsidian);
    entry = { root, obsidian };
    slots[slot] = entry;
  }
  entry.obsidian.hidden = !app.state.settings.vaultPath;
  return entry.root;
}

export function paperNotebook(app: ReaderPort) {
  return notebookEditor(app, sourceChip, () => settingsDialog(app, true));
}

export function notesPanel(app: ReaderPort, parent: HTMLElement): void {
  const editor = paperNotebook(app);
  const bar = readingPackBar(app, 'notes');
  if (editor) editor.attach(parent, app.doc.id === 'pagedattention' ? node => guide(app, node) : undefined, bar);
  else parent.replaceChildren(el('p', 'hint', app.notebookError || label('Opening notes…', '正在打开笔记…')),
    button(label('Obsidian vault settings', 'Obsidian 笔记库设置'), () => settingsDialog(app, true), 'text-btn'), bar);
}
