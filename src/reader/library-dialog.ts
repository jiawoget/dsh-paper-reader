import type { DocumentInfo, OpenDocument } from '../shared/types.js';
import { localBookPlace } from './book-position.js';
import { openStaxLocation } from '../shared/openstax.js';
import { settingsDialog } from './settings-dialog.js';
import { api, bindTablist, button, byId, el, icon, message, modal, readerLabel as t, safeWeb, toast, webPageError, type ReaderPort } from './ui.js';
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

function clearDocumentStorage(docId: string): void {
  const exactLocal = [
    'reader.page.' + docId,
    'reader.tab.' + docId,
    'reader.pdf-pages.' + docId,
    'reader.book-position.' + docId
  ];
  for (const key of exactLocal) localStorage.removeItem(key);
  if (localStorage.getItem('reader.last-document') === docId) localStorage.removeItem('reader.last-document');
  const focusPrefix = 'reader.focus.' + docId + '.';
  const zoteroSuffix = ':' + docId;
  const localKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith(focusPrefix) || (key.startsWith('reader.zotero.') && key.endsWith(zoteroSuffix)))) {
      localKeys.push(key);
    }
  }
  for (const key of localKeys) localStorage.removeItem(key);
  try {
    const sessionKeys: string[] = [];
    const mdExact = 'reader.markdown-draft.' + docId;
    const mdPrefix = mdExact + '/';
    const annExact = 'reader.annotation-drafts.' + docId;
    const qPrefix = 'reader.question-draft.' + encodeURIComponent(docId) + '/';
    const snPrefix = 'reader.selection-note-draft.[' + JSON.stringify(docId) + ',';
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && (key === mdExact || key.startsWith(mdPrefix) || key === annExact || key.startsWith(qPrefix) || key.startsWith(snPrefix))) {
        sessionKeys.push(key);
      }
    }
    for (const key of sessionKeys) sessionStorage.removeItem(key);
  } catch { /* sessionStorage may be unavailable. */ }
}

function deviceDocuments(app: ReaderPort, panel: HTMLElement, read: (doc: DocumentInfo) => Promise<void>): void {
  const search = el('input', 'search');
  search.type = 'search';
  search.ariaLabel = search.placeholder = t('Search saved documents', '搜索本机文档');
  const list = el('div', 'library-results');
  const status = el('p', 'library-status', t('Loading documents…', '正在读取文档…'));
  status.setAttribute('role', 'status');
  panel.append(search, status, list);
  void api('library.list', {}).then(({ docs }) => {
    if (!panel.closest('dialog[open]')) return;
    const editions = new Map<string, DocumentInfo[]>();
    for (const doc of [...docs].reverse()) {
      const key = doc.title.toLocaleLowerCase();
      const group = editions.get(key);
      if (group) group.push(doc);
      else editions.set(key, [doc]);
    }
    let editingId = '';
    let confirmingId = '';
    let focusDeleteId = '';
    function render() {
      const query = search.value.trim().toLocaleLowerCase();
      const shown = docs.filter(doc => [doc.title, doc.authors, doc.url].some(field => field?.toLocaleLowerCase().includes(query)));
      list.replaceChildren();
      status.textContent = shown.length ? '' : t('No matching documents.', '没有找到符合条件的文档。');
      for (const doc of shown) {
        const group = editions.get(doc.title.toLocaleLowerCase()) ?? [doc];
        const details: string[] = [];
        if (doc.book) {
          const place = localBookPlace(doc.id);
          const section = place && doc.book.sections[place.page - 1];
          details.push(section ? t('Continue at ', '续读 · ') + section.title : t('OpenStax book', 'OpenStax 图书'));
        } else if (doc.kind === 'pdf') {
          const pages = Number(localStorage.getItem('reader.pdf-pages.' + doc.id));
          details.push(pages > 0 ? t(pages + (pages === 1 ? ' page' : ' pages'), pages + ' 页') : 'PDF');
        } else if (doc.url) details.push(new URL(doc.url).hostname);
        if (doc.authors) details.push(doc.authors);
        if (group.length > 1) {
          const number = group.indexOf(doc) + 1;
          details.push(t('Copy ' + number, '第 ' + number + ' 份'));
        }
        if (editingId === doc.id) {
          const form = el('form', 'library-rename');
          const input = el('input', 'search');
          input.value = doc.title; input.maxLength = 250; input.required = true;
          input.ariaLabel = t('Document title', '文档标题');
          const save = el('button', 'btn primary', t('Save', '保存')); save.type = 'submit';
          const cancel = button(t('Cancel', '取消'), () => { editingId = ''; render(); });
          form.onsubmit = async event => {
            event.preventDefault();
            const title = input.value.trim();
            if (!title) return;
            save.disabled = true;
            try {
              const { doc: updated } = await api('library.rename', { id: doc.id, title });
              doc.title = updated.title;
              if (app.doc.id === doc.id) { app.doc.title = updated.title; byId('docTitle').textContent = updated.title; }
              editingId = '';
              render();
            } catch (error) { toast(message(error)); save.disabled = false; }
          };
          form.append(input, save, cancel);
          list.append(form);
          input.focus(); input.select();
          continue;
        }
        const row = button('', () => read(doc), 'doc-row library-document');
        const text = el('span', 'library-row-text');
        text.append(el('strong', '', doc.title), el('small', '', details.join(' · ')));
        row.append(icon(doc.book ? 'book' : doc.kind === 'pdf' ? 'note' : 'globe', 18), text);
        if (doc.id === app.doc.id) {
          row.setAttribute('aria-current', 'true');
          row.append(el('small', 'library-current', t('Open', '正在阅读')));
        }
        if (doc.id === 'pagedattention') { list.append(row); continue; }
        const wrap = el('div', 'library-device-item');
        const actions = el('div', 'library-item-actions');
        const confirming = confirmingId === doc.id;
        const delBtn = button(confirming ? t('Delete', '确认删除') : '', async () => {
          if (confirmingId !== doc.id) { confirmingId = doc.id; render(); return; }
          const wasActive = app.doc.id === doc.id;
          await api('library.delete', { id: doc.id });
          app.discardDocument?.(doc.id);
          clearDocumentStorage(doc.id);
          const index = docs.indexOf(doc);
          if (index >= 0) docs.splice(index, 1);
          confirmingId = '';
          if (wasActive) await app.navigate('pagedattention');
          else await app.refresh();
          render();
          toast(t('Document removed from this device.', '已从本机删除文档。'));
        }, confirming ? 'btn library-delete-confirm' : 'icon-btn', confirming ? undefined : 'trash');
        delBtn.ariaLabel = delBtn.title = confirming
          ? t('Confirm delete', '确认删除')
          : t('Delete document', '删除文档');
        if (confirming) {
          const cancelBtn = button(t('Cancel', '取消'), () => { confirmingId = ''; focusDeleteId = doc.id; render(); });
          actions.append(delBtn, cancelBtn);
          wrap.append(row, actions);
          list.append(wrap);
          cancelBtn.focus({ preventScroll: true });
        } else {
          const renameBtn = button('', () => { confirmingId = ''; editingId = doc.id; render(); }, 'icon-btn', 'edit');
          renameBtn.ariaLabel = renameBtn.title = t('Rename document', '重命名文档');
          actions.append(renameBtn, delBtn);
          wrap.append(row, actions);
          list.append(wrap);
          if (focusDeleteId === doc.id) {
            focusDeleteId = '';
            delBtn.focus({ preventScroll: true });
          }
        }
      }
    }
    search.addEventListener('input', render);
    render();
  }).catch(error => { status.textContent = message(error); });
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
  file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.hidden = true;
  const pdf = button(t('Open a PDF', '打开 PDF'), () => file.click(), 'btn', 'note');
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    if (!picked) return;
    pdf.disabled = true;
    try { await app.importFile(picked); if (active()) dialog.close(); }
    catch (error) { if (active()) toast(message(error)); }
    finally { pdf.disabled = false; file.value = ''; }
  });
  const imports = el('div', 'library-imports');
  const form = el('form', 'library-url');
  form.id = 'library-url-form'; form.hidden = true;
  const address = el('input', 'search'), field = el('label');
  address.id = 'library-url'; address.type = 'url'; address.required = true; address.placeholder = 'https://…';
  field.htmlFor = address.id; field.textContent = t('Web address', '网页地址');
  const submit = el('button', 'btn primary', t('Read article', '阅读文章'));
  submit.type = 'submit';
  const urlRow = el('div', 'library-url-row');
  urlRow.append(address, submit);
  const urlStatus = el('div', 'library-status');
  urlStatus.setAttribute('role', 'status');
  form.append(field, urlRow, urlStatus);
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
    const url = safeWeb(address.value.trim());
    if (!url) { urlStatus.textContent = t('Enter an http or https web address.', '请输入以 http 或 https 开头的网页地址。'); return; }
    const version = ++openRequest;
    submit.disabled = true;
    urlStatus.textContent = openStaxLocation(url) ? t('Opening book…','正在打开书籍…') : t('Opening web page…', '正在打开网页…');
    try {
      const opened = await api('web.open', { url });
      if (version === openRequest && !form.hidden) await read(opened);
    } catch (error) {
      if (version !== openRequest || !active()) return;
      urlStatus.replaceChildren(document.createTextNode(webPageError(error) + ' '), webLink(url, t('Open original page', '打开原网页')));
    } finally { if (version === openRequest) submit.disabled = false; }
  });
  function clearRequest() { ++openRequest; submit.disabled = false; urlStatus.replaceChildren(); }
  address.addEventListener('input', () => {
    clearRequest();
    submit.textContent = openStaxLocation(address.value.trim()) ? t('Open book', '打开书籍') : t('Read article', '阅读文章');
  });
  openWeb.addEventListener('click', clearRequest);
  imports.append(openWeb, pdf, file);
  const tabs = el('div', 'library-tabs');
  tabs.ariaLabel = t('Library source', '资料库来源');
  const toolbar = el('div', 'library-toolbar');
  toolbar.append(tabs, imports);
  const holder = el('div');
  root.append(toolbar, form, holder);
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
  bindTablist(tabs, [
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
    holder.replaceChildren(panel);
    if (source === 'device') deviceDocuments(app, panel, doc => read({ doc }));
    else browseZotero(
      panel,
      position,
      read,
      () => settingsDialog(app, 'zotero', () => { void libraryDialog(app, 'zotero'); }),
      () => localStorage.setItem('reader.zotero-connected', '1')
    );
  });
  dialog.scrollTop = 0;
  (startSource === 'zotero' ? zotero : device).focus({ preventScroll: true });
}
