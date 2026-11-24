import type { DocumentInfo, OpenDocument } from '../shared/types.js';
import { localBookPlace } from './book-position.js';
import { openStaxLocation } from '../shared/openstax.js';
import { settingsDialog, type ReaderPort } from './panels.js';
import { api, button, byId, el, icon, message, modal, readerLabel as t, safeWeb, toast, webPageError } from './ui.js';
import { browseZotero, type ZoteroBrowsePosition } from './zotero-browser.js';

let lastSource: 'zotero' | 'device' = 'zotero';
let connection = '';
let position: ZoteroBrowsePosition = { query: '', collection: '' };

function webLink(url: string, name: string): HTMLAnchorElement {
  const link = el('a', 'external', name);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
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
        const renameBtn = button('', () => { confirmingId = ''; editingId = doc.id; render(); }, 'icon-btn', 'edit');
        renameBtn.ariaLabel = renameBtn.title = t('Rename ' + doc.title, '重命名 ' + doc.title);
        const delBtn = button(confirmingId === doc.id ? t('Delete', '确认删除') : '', async () => {
          if (confirmingId !== doc.id) { confirmingId = doc.id; render(); return; }
          await api('library.delete', { id: doc.id });
          const index = docs.indexOf(doc);
          if (index >= 0) docs.splice(index, 1);
          localStorage.removeItem('reader.pdf-pages.' + doc.id);
          confirmingId = '';
          if (app.doc.id === doc.id) await app.navigate('pagedattention');
          render();
          toast(t('Document removed from this device.', '已从本机删除文档。'));
        }, confirmingId === doc.id ? 'btn library-delete-confirm' : 'icon-btn', confirmingId === doc.id ? undefined : 'close');
        delBtn.ariaLabel = delBtn.title = confirmingId === doc.id
          ? t('Confirm delete ' + doc.title, '确认删除 ' + doc.title)
          : t('Delete ' + doc.title, '删除 ' + doc.title);
        actions.append(renameBtn, delBtn);
        wrap.append(row, actions);
        list.append(wrap);
      }
    }
    search.addEventListener('input', render);
    render();
  }).catch(error => { status.textContent = message(error); });
}

export async function libraryDialog(app: ReaderPort): Promise<void> {
  const settings = app.state.settings;
  const current = [settings.zoteroMode, settings.zoteroLibraryType, settings.zoteroLibraryId].join('/');
  if (current !== connection) { position = { query: '', collection: '' }; lastSource = 'zotero'; connection = current; }
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
  tabs.setAttribute('role', 'tablist');
  tabs.ariaLabel = t('Library source', '资料库来源');
  const toolbar = el('div', 'library-toolbar');
  toolbar.append(tabs, imports);
  const holder = el('div');
  root.append(toolbar, form, holder);
  function show(source: typeof lastSource) {
    lastSource = source;
    for (const tab of [zotero, device]) {
      const selected = tab.dataset.source === source;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    const panel = el('section', 'library-source');
    panel.id = 'library-source'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'library-tab-' + source);
    holder.replaceChildren(panel);
    if (source === 'device') deviceDocuments(app, panel, doc => read({doc}));
    else browseZotero(panel, position, read, () => settingsDialog(app, 'zotero', () => { void libraryDialog(app); }));
  }
  function sourceTab(source: typeof lastSource, name: string) {
    const tab = el('button', 'library-tab', name);
    tab.type = 'button';
    tab.addEventListener('click', () => { if (lastSource !== source) show(source); });
    tab.id = 'library-tab-' + source; tab.dataset.source = source; tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'library-source');
    return tab;
  }
  const zotero = sourceTab('zotero', 'Zotero'), device = sourceTab('device', t('On this device', '本机文档'));
  tabs.append(zotero, device);
  tabs.addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? zotero : event.key === 'End' ? device : lastSource === 'zotero' ? device : zotero;
    tab.click(); tab.focus();
  });
  show(lastSource);
  dialog.scrollTop = 0;
  (lastSource === 'zotero' ? zotero : device).focus({ preventScroll: true });
}
