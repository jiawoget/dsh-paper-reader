import { DEFAULT_TARGET_LANGUAGE, targetLanguageBcp47 } from '../shared/languages.js';
import type { DocumentInfo, PageView, ReaderBlock, ReadingSide, SelectionHit } from '../shared/types.js';
import { button, el, icon, message, readerLabel as label, responseJson, safeWeb } from './ui.js';
import { researchText } from './research/labels.js';

interface AbstractViewOptions {
  doc: DocumentInfo; sourceEl: HTMLElement; translationEl: HTMLElement; translations?: Record<string, string>;
  targetLanguage?: string; onSelect: (hit: SelectionHit) => void; onAttach: (file: File) => Promise<void>;
}
const PDF_LIMIT = 80 * 1024 * 1024;
export const abstractOnlyLabel = () => label('Abstract only', '仅摘要');

export async function attachPdfToAbstract(docId: string, file: File): Promise<{ doc: DocumentInfo; pages: number }> {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) throw new Error(label('Choose a PDF file.', '请选择 PDF 文件。'));
  if (!file.size || file.size > PDF_LIMIT) throw new Error(label('Choose a PDF of up to 80 MB.', '请选择不超过 80 MB 的 PDF 文件。'));
  return responseJson<{ doc: DocumentInfo; pages: number }>(await fetch('../attach-pdf?id=' + encodeURIComponent(docId), {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/pdf' }, body: file
  }));
}

const externalLink = (href: string, text: string) => Object.assign(el('a', 'external', text), { href, target: '_blank', rel: 'noopener noreferrer' });

export function renderAbstractView({
  doc, sourceEl, translationEl, translations = {}, targetLanguage = DEFAULT_TARGET_LANGUAGE, onSelect, onAttach
}: AbstractViewOptions): PageView {
  const events = new AbortController(), ev = { signal: events.signal }, titleText = doc.paperTitle || doc.title;
  const paragraphs = (doc.abstract ?? '').split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
  const blocks: ReaderBlock[] = [
    { id: 'abs-title', text: titleText, label: label('Title', '标题') },
    ...paragraphs.map((text, i) => ({ id: 'abs-p-' + (i + 1), text, label: label('Abstract', '摘要') }))
  ];
  const rows = new Map<string, { block: ReaderBlock; source: HTMLElement; translation: HTMLElement }>();
  const sourceSheet = el('article', 'abstract-reader'), transSheet = el('article', 'abstract-reader abstract-reader-translation');
  sourceSheet.dataset.side = 'source'; sourceSheet.setAttribute('aria-label', label('Abstract only view', '仅摘要视图'));
  transSheet.dataset.side = 'translation'; transSheet.setAttribute('aria-label', label('Abstract translation', '摘要译文'));
  const bcp47 = targetLanguageBcp47(targetLanguage); if (bcp47) transSheet.lang = bcp47;
  transSheet.dir = 'auto';

  const header = el('header', 'abstract-header'), badgeRow = el('div', 'abstract-badge-row');
  badgeRow.append(el('span', 'abstract-badge', abstractOnlyLabel()));
  const titleEl = el('h1', 'abstract-title abstract-block', titleText), transTitle = el('h1', 'abstract-title abstract-block');
  titleEl.dataset.anchor = transTitle.dataset.anchor = 'abs-title';
  rows.set('abs-title', { block: blocks[0], source: titleEl, translation: transTitle });
  const metaParts = [doc.authors, doc.venue, doc.year && !doc.venue?.includes(doc.year) ? doc.year : undefined].filter(Boolean);
  header.append(badgeRow, titleEl, ...(metaParts.length ? [el('p', 'abstract-byline', metaParts.join(' · '))] : []));
  const links = el('div', 'abstract-links');
  const cleanDoi = doc.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
  if (cleanDoi) links.append(externalLink('https://doi.org/' + encodeURIComponent(cleanDoi).replace(/%2F/gi, '/'), 'DOI: ' + cleanDoi + ' ↗'));
  const webHref = safeWeb(doc.url);
  if (webHref && (!cleanDoi || !webHref.toLowerCase().includes(cleanDoi.toLowerCase()))) links.append(externalLink(webHref, label('Publisher page ↗', '出版商页面 ↗')));
  if (links.childElementCount) header.append(links);
  sourceSheet.append(header); transSheet.append(transTitle);

  const body = el('section', 'abstract-body'), transBody = el('section', 'abstract-body');
  body.append(el('h2', 'abstract-section-title', label('Abstract', '摘要')));
  transBody.append(el('h2', 'abstract-section-title', label('Abstract', '摘要')));
  if (paragraphs.length) {
    for (let i = 0; i < paragraphs.length; i++) {
      const block = blocks[i + 1], p = el('p', 'abstract-paragraph abstract-block', block.text), tp = el('p', 'abstract-paragraph abstract-block');
      p.dataset.anchor = tp.dataset.anchor = block.id;
      rows.set(block.id, { block, source: p, translation: tp }); body.append(p); transBody.append(tp);
    }
  } else body.append(el('p', 'abstract-empty', label('No abstract text was imported for this record.', '此文献条目暂无摘要文本。')));
  sourceSheet.append(body); transSheet.append(transBody);

  const zone = el('section', 'abstract-attach-zone'), fileInput = el('input'), errorEl = el('p', 'abstract-attach-error');
  zone.setAttribute('aria-label', label('Attach PDF', '附加 PDF'));
  fileInput.type = 'file'; fileInput.accept = 'application/pdf,.pdf'; fileInput.hidden = true;
  errorEl.setAttribute('role', 'alert'); errorEl.hidden = true;
  let busy = false, depth = 0;
  const attachBtn = button(label('Attach PDF', '附加 PDF'), () => { if (!busy) fileInput.click(); }, 'btn primary', 'import');
  const submitFile = async (file: File) => {
    if (busy) return;
    busy = true; attachBtn.disabled = true; errorEl.hidden = true; errorEl.textContent = '';
    try { await onAttach(file); }
    catch (error) { if (!events.signal.aborted) { errorEl.textContent = message(error); errorEl.hidden = false; } }
    finally { busy = false; attachBtn.disabled = false; fileInput.value = ''; }
  };
  fileInput.addEventListener('change', () => { const picked = fileInput.files?.[0]; if (picked) void submitFile(picked); }, ev);
  const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files'));
  const clearZone = () => { depth = 0; delete zone.dataset.drop; };
  zone.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.dataset.drop = 'active'; }, ev);
  zone.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; zone.dataset.drop = 'active'; }, ev);
  zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) delete zone.dataset.drop; }, ev);
  zone.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); clearZone();
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    if (files.length > 1) { errorEl.textContent = label('Drop a single PDF file to attach.', '请拖入单个 PDF 文件。'); errorEl.hidden = false; return; }
    void submitFile(files[0]);
  }, ev);
  window.addEventListener('dragend', clearZone, ev);
  zone.append(
    icon('import', 22), el('strong', 'abstract-attach-title', label('Attach PDF for full-text reading', '附加 PDF 以阅读与检索全文')),
    el('p', 'abstract-attach-hint', label('Drop a PDF here (up to 80 MB) or choose a file. Tags, notes, and metadata are preserved.', '拖入 PDF（最大 80 MB）或点击选择文件。标签、笔记与元数据将完整保留。')),
    attachBtn, fileInput, errorEl
  );
  sourceSheet.append(zone); sourceEl.replaceChildren(sourceSheet); translationEl.replaceChildren(transSheet);

  let pending = new Set<string>();
  const setTranslations = (values: Record<string, string>, overwrite = false) => {
    for (const [id, row] of rows) {
      const supplied = values[id]?.trim() || undefined;
      if (supplied) pending.delete(id);
      row.block.translation = overwrite ? (supplied ?? row.block.translation) : (row.block.translation || supplied);
      const busy = !row.block.translation && pending.has(id);
      row.translation.textContent = row.block.translation || (busy ? researchText.translatingRow() : label('Awaiting translation', '待翻译'));
      row.translation.classList.toggle('is-untranslated', !row.block.translation);
      row.translation.classList.toggle('is-translating', busy);
    }
  };
  setTranslations(translations);
  const wireSelection = (sheet: HTMLElement, side: ReadingSide) => sheet.addEventListener('pointerup', () => requestAnimationFrame(() => {
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const text = sel.toString().trim(), range = sel.getRangeAt(0);
    if (!text || !sheet.contains(range.startContainer) || !sheet.contains(range.endContainer)) return;
    const node = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const id = node?.closest<HTMLElement>('[data-anchor]')?.dataset.anchor, entry = id ? rows.get(id) : undefined;
    if (!entry || (side === 'translation' && !entry.block.translation)) return;
    const idx = entry.block.text.indexOf(text);
    onSelect({
      id: entry.block.id, text, context: entry.block.text, page: 1, rect: range.getBoundingClientRect(), side,
      label: entry.block.label ?? label('Abstract', '摘要'), sourceQuote: side === 'source' ? text : entry.block.text,
      sourceText: entry.block.text, sourceOffset: side === 'source' && idx >= 0 ? idx : undefined
    });
  }), ev);
  wireSelection(sourceSheet, 'source'); wireSelection(transSheet, 'translation');

  let activeId = '';
  const toggleFlag = (id: string, cls: string, on: boolean) => { const r = rows.get(id); if (r) { r.source.classList.toggle(cls, on); r.translation.classList.toggle(cls, on); } };
  return {
    blocks, setTranslations, setPendingBlocks(ids) { pending = new Set(ids); setTranslations({}); },
    select(hit) { if (activeId) toggleFlag(activeId, 'is-highlighted', false); activeId = hit?.id ?? ''; if (activeId) toggleFlag(activeId, 'is-highlighted', true); },
    highlight(id, on = true) { if (on && activeId && activeId !== id) toggleFlag(activeId, 'is-highlighted', false); toggleFlag(id, 'is-highlighted', on); activeId = on ? id : ''; },
    locate(id) { const row = rows.get(id); if (!row) return false; for (const [k] of rows) toggleFlag(k, 'is-located', k === id); row.source.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); return true; },
    sourceRect(id) { return rows.get(id)?.source.getBoundingClientRect() ?? null; },
    dispose() { events.abort(); }
  };
}
