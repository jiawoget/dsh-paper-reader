import { parseAcademicInput } from '../shared/academic-intake.js';
import type { BulkRefFormat } from '../shared/citation-bulk.js';
import type { OpenDocument } from '../shared/types.js';
import { openStaxLocation } from '../shared/openstax.js';
import { renderDeviceLibrary } from './library-triage.js';
import { bindPdfDropTarget } from './pdf-import.js';
import { researchIcon } from './research/icons.js';
import { researchText } from './research/labels.js';
import { createArxivFormatToggle } from './research/paper-intake.js';
import { settingsDialog } from './settings-dialog.js';
import { api, bindTablist, button, byId, downloadFile, el, message, modal, readerLabel as t, safeWeb, toast, webPageError, type ReaderPort } from './ui.js';
import { browseZotero, type ZoteroBrowsePosition } from './zotero-browser.js';

let lastSource: 'zotero' | 'device' | undefined;
let connection = '';
let position: ZoteroBrowsePosition = { query: '', collection: '' };

function webLink(url: string, name: string): HTMLAnchorElement {
  const link = el('a', 'external', name);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

export async function libraryDialog(app: ReaderPort, initialSource?: 'zotero' | 'device'): Promise<void> {
  const settings = app.state.settings;
  const current = [settings.zoteroMode, settings.zoteroLibraryType, settings.zoteroLibraryId].join('/');
  if (current !== connection) { position = { query: '', collection: '' }; lastSource = undefined; connection = current; }
  const zoteroReady = Boolean(settings.zoteroLibraryId) || localStorage.getItem('reader.zotero-connected') === '1';
  const startSource: 'zotero' | 'device' = initialSource ?? lastSource ?? (zoteroReady ? 'zotero' : 'device');
  const dialog = byId<HTMLDialogElement>('dialog');
  const body = modal(t('Library', '资料库'));
  const root = el('section', 'reader-library');
  body.append(root);
  const active = () => Boolean(root.closest('dialog[open]'));
  async function read(opened: OpenDocument) {
    if (!active()) return;
    await app.openDocument(opened);
    if (active()) dialog.close();
  }
  const file = el('input');
  file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.multiple = true; file.hidden = true;
  const pdf = button(t('Open a PDF', '打开 PDF'), () => file.click(), 'btn', 'note'), importStatus = el('p', 'library-status');
  importStatus.setAttribute('role', 'status');
  async function handlePdfFiles(files: readonly File[]) {
    if (!files.length) return;
    pdf.disabled = true;
    try { if (await app.importFiles(files, text => { if (active()) importStatus.textContent = text; }) && active()) dialog.close(); }
    catch (error) { if (active()) toast(message(error)); }
    finally { pdf.disabled = false; importStatus.textContent = ''; file.value = ''; }
  }
  file.addEventListener('change', () => { void handlePdfFiles(Array.from(file.files ?? [])); });
  const dropController = new AbortController();
  let cleanupPanel: (() => void) | undefined;
  dialog.addEventListener('close', () => { dropController.abort(); cleanupPanel?.(); cleanupPanel = undefined; }, { once: true });
  bindPdfDropTarget(root, files => { void handlePdfFiles(files); }, { signal: dropController.signal });
  const imports = el('div', 'library-imports');
  const form = el('form', 'library-url');
  form.id = 'library-url-form'; form.hidden = true;
  const address = el('input', 'search'), field = el('label');
  address.id = 'library-url'; address.type = 'text'; address.inputMode = 'url'; address.spellcheck = false; address.autocomplete = 'off'; address.required = true;
  address.placeholder = t('https://…, 2309.06180, or 10.1145/…', 'https://…、arXiv 编号（2309.06180）或 DOI（10.1145/…）');
  field.htmlFor = address.id; field.textContent = t('Web address', '网页地址');
  const submit = el('button', 'btn primary', t('Read article', '阅读文章'));
  submit.type = 'submit';
  const urlRow = el('div', 'library-url-row');
  urlRow.append(address, submit);
  let arxivManual = false;
  const arxivFmtRow = el('div', 'library-arxiv-fmt');
  arxivFmtRow.hidden = true;
  const arxivFmtToggle = createArxivFormatToggle(app.state.settings.arxivFormat ?? 'html', () => { arxivManual = true; });
  arxivFmtRow.append(el('span', 'library-arxiv-lbl', researchText.arxivFormat()), arxivFmtToggle.root);
  const urlStatus = el('div', 'library-status');
  urlStatus.setAttribute('role', 'status');
  form.append(field, urlRow, arxivFmtRow, urlStatus);
  const openWeb = button(t('Open web page', '打开网页'), () => {
    form.hidden = !form.hidden;
    openWeb.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) address.focus();
  }, 'btn', 'globe');
  openWeb.setAttribute('aria-controls', form.id);
  openWeb.setAttribute('aria-expanded', 'false');
  let openRequest = 0;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const raw = address.value.trim(), parsed = parseAcademicInput(raw);
    if (!parsed) {
      urlStatus.textContent = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
        ? t('Enter an http or https web address.', '请输入以 http 或 https 开头的网页地址。')
        : t('Enter an http/https URL, arXiv ID, or DOI.', '请输入 http/https 网址、arXiv 编号或 DOI。');
      return;
    }
    const version = ++openRequest;
    submit.disabled = true;
    urlStatus.textContent = openStaxLocation(raw) ? t('Opening book…','正在打开书籍…') : parsed.kind !== 'url' ? t('Importing paper…', '正在导入论文…') : t('Opening web page…', '正在打开网页…');
    try {
      const opened = await api('web.open', { url: raw, ...(parsed.kind === 'arxiv' ? { arxivFormat: arxivFmtToggle.value() } : {}) });
      if (version === openRequest && !form.hidden) await read(opened);
    } catch (error) {
      if (version !== openRequest || !active()) return;
      const fallback = safeWeb(parsed.kind === 'arxiv' ? parsed.absUrl : parsed.url);
      urlStatus.replaceChildren(document.createTextNode(webPageError(error) + (fallback ? ' ' : '')), ...(fallback ? [webLink(fallback, t('Open original page', '打开原网页'))] : []));
    } finally { if (version === openRequest) submit.disabled = false; }
  });
  function syncArxivRow() {
    const raw = address.value.trim(), parsed = parseAcademicInput(raw);
    submit.textContent = openStaxLocation(raw) ? t('Open book', '打开书籍') : parsed && parsed.kind !== 'url' ? t('Import paper', '导入论文') : t('Read article', '阅读文章');
    const isArxiv = parsed?.kind === 'arxiv';
    arxivFmtRow.hidden = !isArxiv;
    if (!isArxiv) arxivManual = false;
    else if (!arxivManual) arxivFmtToggle.set(parsed.explicitFormat ?? app.state.settings.arxivFormat ?? 'html');
  }
  function clearRequest() { ++openRequest; submit.disabled = false; urlStatus.replaceChildren(); }
  address.addEventListener('input', () => { clearRequest(); syncArxivRow(); });
  openWeb.addEventListener('click', () => { clearRequest(); arxivManual = false; syncArxivRow(); });
  const openWorkspace = el('button', 'btn library-workspace-btn');
  openWorkspace.type = 'button';
  openWorkspace.append(researchIcon('research', 18), researchText.workspace());
  openWorkspace.addEventListener('click', () => { if (active()) dialog.close(); app.openResearchWorkspace?.(); });
  imports.append(openWorkspace, openWeb, pdf, file);
  const tabs = el('div', 'library-tabs');
  tabs.ariaLabel = t('Library source', '资料库来源');
  const toolbar = el('div', 'library-toolbar'); toolbar.append(tabs, imports);
  const refsFile = el('input');
  refsFile.type = 'file'; refsFile.accept = '.bib,.ris,.csv,text/csv,application/x-bibtex,application/x-research-info-systems'; refsFile.hidden = true;
  const importRefsBtn = button(t('Import .bib / .ris / .csv', '导入 .bib / .ris / .csv'), () => refsFile.click(), 'btn', 'import');
  const exportWrap = el('div', 'library-bulk-export');
  exportWrap.append(el('span', 'library-bulk-label', t('Export library', '导出资料库')));
  const exportMime: Record<BulkRefFormat, string> = { bibtex: 'application/x-bibtex;charset=utf-8', ris: 'application/x-research-info-systems;charset=utf-8', csv: 'text/csv;charset=utf-8' };
  for (const [fmt, labelText] of [['bibtex', 'BibTeX'], ['ris', 'RIS'], ['csv', 'CSV']] as const) {
    const expBtn = button(labelText, async () => {
      const res = await api('library.exportRefs', { format: fmt });
      downloadFile(res.filename, res.content, exportMime[fmt]);
      toast(t(`Exported ${res.count} items as ${labelText}.`, `已导出 ${res.count} 篇文献为 ${labelText}。`));
    }, 'btn');
    expBtn.ariaLabel = expBtn.title = t(`Export library as ${labelText}`, `导出资料库为 ${labelText}`);
    exportWrap.append(expBtn);
  }
  const bulkBar = el('div', 'library-bulk-bar'); bulkBar.append(importRefsBtn, refsFile, exportWrap);
  const holder = el('div'); root.append(toolbar, bulkBar, importStatus, form, holder);
  const zotero = el('button', 'library-tab', 'Zotero');
  zotero.id = 'library-tab-zotero';
  zotero.dataset.source = 'zotero';
  zotero.setAttribute('aria-controls', 'library-source');
  const device = el('button', 'library-tab', t('On this device', '本机文档'));
  device.id = 'library-tab-device';
  device.dataset.source = 'device';
  device.setAttribute('aria-controls', 'library-source');
  tabs.append(zotero, device);
  let shownSource: 'zotero' | 'device' | undefined;
  const selectSource = bindTablist(tabs, [
    { key: 'zotero', button: zotero },
    { key: 'device', button: device }
  ], startSource, source => {
    lastSource = source;
    if (shownSource === source) return;
    shownSource = source;
    const panel = el('section', 'library-source');
    panel.id = 'library-source';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'library-tab-' + source);
    cleanupPanel?.();
    cleanupPanel = undefined;
    holder.replaceChildren(panel);
    if (source === 'device') cleanupPanel = renderDeviceLibrary(app, panel, doc => read({ doc }), () => { if (active()) dialog.close(); });
    else browseZotero(
      panel,
      position,
      read,
      () => settingsDialog(app, 'zotero', () => { void libraryDialog(app, 'zotero'); }),
      () => localStorage.setItem('reader.zotero-connected', '1')
    );
  });
  refsFile.addEventListener('change', async () => {
    const picked = refsFile.files?.[0]; if (!picked) return;
    importRefsBtn.disabled = true;
    try {
      const ext = picked.name.toLowerCase();
      const format = ext.endsWith('.bib') ? 'bibtex' : ext.endsWith('.ris') ? 'ris' : ext.endsWith('.csv') ? 'csv' : 'auto';
      const res = await api('library.importRefs', { text: await picked.text(), format });
      if (!active()) return;
      toast(res.created || res.existing
        ? t(`Imported ${res.created} paper${res.created === 1 ? '' : 's'}${res.existing ? `, ${res.existing} already in library` : ''}.`, `已导入 ${res.created} 篇文献${res.existing ? `，${res.existing} 篇已在资料库中` : ''}。`)
        : t('No valid references found in this file.', '该文件中未找到有效引文条目。'));
      shownSource = undefined; selectSource('device');
    } catch (error) { if (active()) toast(message(error)); }
    finally { importRefsBtn.disabled = false; refsFile.value = ''; }
  });
  dialog.scrollTop = 0;
  (startSource === 'zotero' ? zotero : device).focus({ preventScroll: true });
}
