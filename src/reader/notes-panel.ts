import type { SourceRecord } from '../shared/types.js';
import { chapterPassageLabel } from '../shared/notebook-structure.js';
import { readSelectionRange, readTranslatedLocator } from '../shared/source-link.js';
import { notebookEditor } from './notebook.js';
import { settingsDialog } from './settings-dialog.js';
import { button, el, icon, readerLabel as label, type ReaderPort } from './ui.js';

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

export function paperNotebook(app: ReaderPort) {
  return notebookEditor(app, sourceChip, () => settingsDialog(app, true));
}

export function notesPanel(app: ReaderPort, parent: HTMLElement): void {
  const editor = paperNotebook(app);
  if (editor) editor.attach(parent, app.doc.id === 'pagedattention' ? node => guide(app, node) : undefined);
  else parent.replaceChildren(el('p', 'hint', app.notebookError || label('Opening notes…', '正在打开笔记…')),
    button(label('Obsidian vault settings', 'Obsidian 笔记库设置'), () => settingsDialog(app, true), 'text-btn'));
}
