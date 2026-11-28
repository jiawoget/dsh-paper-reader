import type { DocumentInfo, ZoteroItem } from '../shared/types.js';
import { buildCitationMetadata, buildCiteKey, formatBibTeX, formatRIS } from '../shared/citation-export.js';
import { mountDocResourcesPanel } from './doc-resources-panel.js';
import { researchText, researchViewName } from './research/labels.js';
import { mountReferenceCitations } from './research/reference-citations.js';
import { settingsDialog } from './settings-dialog.js';
import { mountTagPicker } from './tag-picker.js';
import { api, bindTablist, button, byId, copyText, downloadFile, el, icon, inputField, message, readerLabel as label, safeWeb, toast, zoteroStatusText, type ReaderPort } from './ui.js';

export function referencePanel(app: ReaderPort, parent: HTMLElement): void {
  const doc = app.doc;
  type MetaDraft = Partial<Pick<DocumentInfo, 'paperTitle' | 'authors' | 'venue' | 'year' | 'doi'>>;
  let draft: MetaDraft | null = null;
  const currentTitle = () => doc.paperTitle || doc.title;
  const effectiveDoc = (): DocumentInfo => draft ? { ...doc, ...draft } : doc;
  const trail = el('div', 'trail');
  trail.append(icon('folder', 13), label('Library / Reference', '资料库 / 文献'));
  const head = el('div', 'ref-meta-head'), heading = el('h1', '', currentTitle()), bylineEl = el('p', 'ref-byline');
  head.append(heading);
  const syncHeader = () => {
    heading.textContent = currentTitle();
    const text = [doc.authors, doc.venue, doc.year && !doc.venue?.includes(doc.year) ? doc.year : undefined].filter(Boolean).join(' · ');
    bylineEl.textContent = text; bylineEl.hidden = !text;
    if (!doc.book && app.doc.id === doc.id) byId('docMeta').textContent = doc.authors ? [doc.authors, doc.venue].filter(Boolean).join(' · ') : doc.kind === 'web' && doc.url ? new URL(doc.url).hostname : '';
  };
  let editBtn: HTMLButtonElement | undefined, metaForm: HTMLFormElement | undefined;
  let syncPreview = () => {};
  if (doc.id !== 'pagedattention') {
    const fTitle = inputField(label('Paper title', '论文标题'), doc.paperTitle ?? '');
    const fAuthors = inputField(label('Authors', '作者'), doc.authors ?? '', 'text', label('Semicolon-separated', '多位作者用分号分隔'));
    const fVenue = inputField(label('Venue / Journal', '期刊 / 会议'), doc.venue ?? '');
    const fYear = inputField(label('Year', '年份'), doc.year ?? '', 'text', '2024'), fDoi = inputField('DOI', doc.doi ?? '', 'text', '10.1145/…');
    const grid = el('div', 'ref-meta-grid'); grid.append(fYear.row, fDoi.row);
    const errEl = el('p', 'ref-meta-error'); errEl.setAttribute('role', 'alert'); errEl.hidden = true;
    const saveBtn = el('button', 'btn primary', label('Save metadata', '保存元数据')); saveBtn.type = 'submit';
    const closeEdit = (restoreFocus = false) => {
      if (!metaForm || metaForm.hidden) return;
      metaForm.hidden = true; draft = null; errEl.hidden = true; errEl.textContent = '';
      editBtn?.setAttribute('aria-expanded', 'false'); syncPreview();
      if (restoreFocus) editBtn?.focus({ preventScroll: true });
    };
    const actions = el('div', 'ref-meta-actions'); actions.append(saveBtn, button(label('Cancel', '取消'), () => closeEdit(true), 'btn'));
    metaForm = el('form', 'ref-meta-form'); metaForm.hidden = true;
    metaForm.append(fTitle.row, fAuthors.row, fVenue.row, grid, errEl, actions);
    editBtn = button(label('Edit metadata', '编辑元数据'), () => {
      if (!metaForm) return;
      if (!metaForm.hidden) { closeEdit(); return; }
      fTitle.input.value = doc.paperTitle ?? ''; fAuthors.input.value = doc.authors ?? ''; fVenue.input.value = doc.venue ?? '';
      fYear.input.value = doc.year ?? ''; fDoi.input.value = doc.doi ?? ''; errEl.hidden = true; errEl.textContent = '';
      metaForm.hidden = false; editBtn?.setAttribute('aria-expanded', 'true'); fTitle.input.focus();
    }, 'text-btn', 'edit');
    editBtn.setAttribute('aria-expanded', 'false'); head.append(editBtn);
    metaForm.addEventListener('input', () => {
      draft = { paperTitle: fTitle.input.value.trim() || undefined, authors: fAuthors.input.value.trim() || undefined, venue: fVenue.input.value.trim() || undefined, year: fYear.input.value.trim() || undefined, doi: fDoi.input.value.trim() || undefined };
      syncPreview();
    });
    metaForm.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEdit(true); } });
    metaForm.addEventListener('submit', async e => {
      e.preventDefault(); saveBtn.disabled = true; errEl.hidden = true; errEl.textContent = '';
      try {
        const { doc: updated } = await api('library.updateMeta', { id: doc.id, paperTitle: fTitle.input.value, authors: fAuthors.input.value, venue: fVenue.input.value, year: fYear.input.value, doi: fDoi.input.value });
        doc.paperTitle = updated.paperTitle; doc.authors = updated.authors; doc.venue = updated.venue; doc.year = updated.year; doc.doi = updated.doi;
        draft = null; metaForm!.hidden = true; editBtn?.setAttribute('aria-expanded', 'false');
        syncHeader(); syncPreview(); toast(label('Metadata updated.', '元数据已更新。'));
      } catch (error) { errEl.textContent = message(error); errEl.hidden = false; }
      finally { saveBtn.disabled = false; }
    });
  }
  syncHeader();
  parent.append(trail, head, bylineEl, ...(metaForm ? [metaForm] : []));
  const web = safeWeb(doc.url);
  if (web) {
    const link = el('a', 'external', (doc.doi || doc.kind === 'pdf') ? label('Original paper ↗', '原始论文 ↗') : label('Original article ↗', '原始文章 ↗'));
    link.href = web; link.target = '_blank'; link.rel = 'noopener'; parent.append(link);
  }
  const tagsHost = el('div', 'ref-tags-host');
  parent.append(tagsHost);
  mountTagPicker(tagsHost, {
    doc, heading: researchText.tagsHeading(),
    aiConfigured: app.state.settings.aiMode !== 'unconfigured',
    onMetaUpdated: meta => { doc.meta = meta; app.notifyDocumentMutated?.(doc.id); }
  });
  const resourcesHost = el('div', 'ref-res-host');
  parent.append(resourcesHost);
  mountDocResourcesPanel(resourcesHost, { docId: doc.id, onOpenDoc: id => { void app.navigate(id); } });
  if (app.openResearchWorkspace) {
    const graphSection = el('section', 'ref-graph-triggers');
    graphSection.setAttribute('aria-label', researchViewName('citation-map'));
    const graphRow = el('div', 'ref-graph-actions');
    for (const [dir, text] of [['earlier', 'Earlier'], ['later', 'Later'], ['similar', 'Similar']] as const) {
      const trigger = button(text, () => app.openResearchWorkspace?.('citation-map', { seedDocId: doc.id, filter: dir }), 'btn');
      trigger.dataset.graphDir = dir;
      graphRow.append(trigger);
    }
    graphSection.append(el('h3', '', researchViewName('citation-map')), graphRow);
    parent.append(graphSection);
    mountReferenceCitations(app, doc, parent);
  }
  const desktop = app.state.settings.zoteroMode === 'desktop';
  const legacyKey = 'reader.zotero.' + app.state.settings.zoteroLibraryType + ':' + app.state.settings.zoteroLibraryId + ':' + doc.id;
  const configured = desktop || Boolean(app.state.settings.zoteroLibraryId);
  let linkedZotero: ZoteroItem | null = null, zoteroSettled = !configured, zoteroPending: Promise<void> | undefined;

  const exportSection = el('section', 'citation-export');
  exportSection.setAttribute('aria-label', label('Export citation', '导出引文'));
  const exportActions = el('div', 'citation-export-actions'), exportStatus = el('p', 'citation-export-status');
  exportStatus.setAttribute('role', 'status'); exportStatus.setAttribute('aria-live', 'polite');

  const buildCitationPayload = (format: 'bibtex' | 'ris') => {
    const meta = buildCitationMetadata(effectiveDoc(), linkedZotero);
    const content = format === 'bibtex' ? formatBibTeX(meta) : formatRIS(meta);
    const key = buildCiteKey(meta).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'reference';
    return { content, filename: `${key}.${format === 'bibtex' ? 'bib' : 'ris'}` };
  };
  const previewDetails = el('details', 'citation-preview-box'), previewBody = el('div', 'citation-preview-body'), previewTabs = el('div', 'citation-preview-tabs');
  const bibTab = el('button', 'citation-preview-tab', 'BibTeX'), risTab = el('button', 'citation-preview-tab', 'RIS');
  const previewPre = el('pre', 'citation-preview-code'), previewCode = el('code');
  previewBody.hidden = true; previewTabs.append(bibTab, risTab); previewPre.append(previewCode); previewBody.append(previewTabs, previewPre);
  previewDetails.append(el('summary', 'citation-preview-toggle', label('Preview BibTeX / RIS', '预览 BibTeX / RIS')), previewBody);
  let previewFormat: 'bibtex' | 'ris' = 'bibtex';
  syncPreview = () => { if (previewDetails.open) previewCode.textContent = buildCitationPayload(previewFormat).content; };
  bindTablist(previewTabs, [{ key: 'bibtex', button: bibTab }, { key: 'ris', button: risTab }], 'bibtex', key => { previewFormat = key; syncPreview(); });
  previewDetails.addEventListener('toggle', () => { previewBody.hidden = !previewDetails.open; if (previewDetails.open) syncPreview(); });
  const waitForZotero = async () => {
    if (!zoteroSettled && zoteroPending) await Promise.race([zoteroPending.catch(() => undefined), new Promise<void>(resolve => window.setTimeout(resolve, 1500))]);
  };
  const copyCitation = async (format: 'bibtex' | 'ris') => {
    if (!zoteroSettled) await waitForZotero();
    if (!exportSection.isConnected || app.doc.id !== doc.id) return;
    const copied = await copyText(buildCitationPayload(format).content);
    if (!exportSection.isConnected || app.doc.id !== doc.id) return;
    const feedback = copied
      ? (format === 'bibtex' ? label('BibTeX copied to clipboard.', 'BibTeX 已复制到剪贴板。') : label('RIS copied to clipboard.', 'RIS 已复制到剪贴板。'))
      : label('Clipboard access was blocked. Use Download instead.', '剪贴板权限受限，请改用下载按钮。');
    exportStatus.textContent = feedback; toast(feedback);
  };
  const downloadCitation = async (format: 'bibtex' | 'ris') => {
    if (!zoteroSettled) await waitForZotero();
    if (!exportSection.isConnected || app.doc.id !== doc.id) return;
    const { content, filename } = buildCitationPayload(format);
    downloadFile(filename, content, format === 'bibtex' ? 'application/x-bibtex;charset=utf-8' : 'application/x-research-info-systems;charset=utf-8');
    const feedback = label(`Downloaded ${filename}.`, `已下载 ${filename}。`);
    exportStatus.textContent = feedback; toast(feedback);
  };
  exportActions.append(
    button(label('Copy BibTeX', '复制 BibTeX'), () => copyCitation('bibtex'), 'btn'),
    button(label('Download .bib', '下载 .bib'), () => downloadCitation('bibtex'), 'btn'),
    button(label('Copy RIS', '复制 RIS'), () => copyCitation('ris'), 'btn'),
    button(label('Download .ris', '下载 .ris'), () => downloadCitation('ris'), 'btn')
  );
  exportSection.append(el('h3', '', label('Export citation', '导出引文')), exportActions, exportStatus, previewDetails);
  parent.append(exportSection, el('hr', 'rule'), el('h3', '', 'Zotero'));

  const connection = el('section', 'zotero-connection'), status = el('p'), connectionActions = el('div', 'row');
  connection.ariaLabel = label('Zotero connection', 'Zotero 连接'); status.setAttribute('role', 'status');
  connection.append(status, connectionActions); parent.append(connection);
  const settings = button(label('Connection settings', '连接设置'), () => settingsDialog(app, 'zotero'), 'btn', 'settings');
  let readOnly = !desktop && !app.state.settings.hasZoteroKey;

  const showRestoreError = (error: unknown) => {
    linkedZotero = null; zoteroSettled = true;
    const detail = zoteroStatusText(message(error));
    if (summary.isConnected && detail !== status.textContent) summary.replaceChildren(el('p', 'hint', detail));
  };
  const test = async (autoRestore = false): Promise<boolean> => {
    status.textContent = label('Checking library access…', '正在检查资料库连接…');
    try {
      const result = await api('zotero.status', {});
      if (!connection.isConnected) return false;
      connection.dataset.connected = String(result.connected); status.textContent = zoteroStatusText(result.detail);
      readOnly = result.access === 'read';
      if (configured) addItem.disabled = readOnly || !result.connected;
      if (autoRestore && result.connected && configured && !linkedZotero && !summary.hasChildNodes()) {
        zoteroSettled = false;
        zoteroPending = restore().catch(showRestoreError);
      }
      return result.connected;
    } catch (error) {
      if (connection.isConnected) {
        connection.dataset.connected = 'false'; status.textContent = zoteroStatusText(message(error));
        if (configured) addItem.disabled = true;
      }
      return false;
    }
  };

  connectionActions.append(button(label('Test connection', '测试连接'), () => test(true), 'btn'), settings);
  if (!configured) {
    status.textContent = label('Connect a Zotero library to find references and manage their collections.', '连接 Zotero 资料库后，可查找文献条目并管理所属分类。');
    connectionActions.prepend(button(label('Connect desktop', '连接本机 Zotero'), async () => {
      await api('settings.save', { zoteroMode: 'desktop' }); await app.refresh(); app.repaintNotes();
    }, 'btn'));
    return;
  }

  const summary = el('div', 'list-row'); parent.append(summary);
  const query = el('input', 'search'); query.type = 'search'; query.value = doc.title.replace(/\.pdf$/i, '');
  query.setAttribute('aria-label', label('Search Zotero', '搜索 Zotero'));
  const found = el('div'), editor = el('div');

  async function restore(): Promise<void> {
    const oldKey = desktop ? null : localStorage.getItem(legacyKey);
    const result = await api('zotero.get', { docId: doc.id, key: oldKey || undefined });
    if (!summary.isConnected || app.doc.id !== doc.id) return;
    const item = result.item; linkedZotero = item; zoteroSettled = true; syncPreview();
    summary.replaceChildren(); addItem.hidden = Boolean(item);
    if (!item) { summary.append(el('p', 'hint', label('Find an existing item or save this document to a collection.', '查找已有条目，或将当前文档保存到 Zotero 分类。'))); return; }
    const titleLine = el('p'); titleLine.append(el('strong', '', item.title));
    const actions = el('div', 'row');
    summary.append(el('div', 'section-title', label('Linked reference', '已关联文献')), titleLine, actions);
    actions.append(button(label('Manage collections', '管理分类'), () => choose(item), 'text-btn', 'folder'));
    if (desktop || item.webUrl) {
      const link = el('a', 'external', label('Open in Zotero ↗', '在 Zotero 中打开 ↗'));
      link.href = desktop ? 'zotero://select/library/items/' + encodeURIComponent(item.key) : item.webUrl!;
      link.target = '_blank'; link.rel = 'noopener'; actions.append(link);
    }
    if (oldKey) localStorage.removeItem(legacyKey);
  }

  async function choose(item?: ZoteroItem): Promise<void> {
    const { collections } = await api('zotero.collections', {});
    if (!editor.isConnected || app.doc.id !== doc.id) return;
    const checked = new Set(item?.collections || []);
    editor.replaceChildren(el('div', 'section-title', item ? label('Collections for ' + item.title, '所属分类 · ' + item.title) : label('Choose collections', '选择分类')));
    if (item) {
      editor.append(button(label('Link this item', '关联此条目'), async () => {
        const { item: linked } = await api('zotero.link', { docId: doc.id, key: item.key });
        linkedZotero = linked; zoteroSettled = true; editor.replaceChildren(); found.replaceChildren();
        await restore(); toast(label('Linked to this paper.', '已关联到本文档。'));
      }, 'btn', 'note'));
    }
    for (const c of collections) {
      const l = el('label', 'check-row'), box = el('input');
      box.type = 'checkbox'; box.checked = checked.has(c.key); box.disabled = box.checked || readOnly;
      box.onchange = () => { if (box.checked) checked.add(c.key); else checked.delete(c.key); };
      l.append(box, c.name); editor.append(l);
    }
    if (readOnly) { editor.append(el('p', 'hint', label('This connection can read and link items. Enable write access to change collections.', '当前连接仅支持读取与关联。如需修改分类，请开启写入权限。'))); return; }
    if (!collections.length) editor.append(el('p', 'hint', label('Saving without a collection adds the item to your library.', '不选择分类时，条目会直接保存到资料库根目录。')));
    const progress = el('p', 'hint'); progress.setAttribute('role', 'status');
    editor.append(button(item ? label('Update Zotero item', '更新 Zotero 条目') : label('Save to Zotero', '保存到 Zotero'), async () => {
      progress.textContent = desktop ? label('Saving… Check Zotero for an approval dialog.', '正在保存…请在 Zotero 中确认授权弹窗。') : label('Saving…', '正在保存…');
      try {
        await api('zotero.save', { docId: doc.id, key: item?.key, title: currentTitle(), url: doc.url, doi: doc.doi, collections: [...checked] });
        found.replaceChildren(); editor.replaceChildren(); await restore(); await test(false);
        toast(label('Saved to your Zotero library.', '已保存到 Zotero 资料库。'));
      } catch (error) { progress.textContent = zoteroStatusText(message(error)); }
    }, 'btn primary', 'check'), progress);
  }

  const addItem = button(label('Add to library', '添加到资料库'), () => choose(), 'btn', 'plus');
  addItem.disabled = readOnly;
  parent.append(query, button(label('Find item', '查找条目'), async () => {
    const { items } = await api('zotero.search', { query: query.value });
    found.replaceChildren();
    if (!items.length) found.append(el('p', 'hint', label('No matching items.', '没有找到匹配的条目。')));
    for (const item of items) found.append(button(item.title, () => choose(item), 'doc-row', 'note'));
  }, 'btn', 'book'), addItem, found, editor);

  zoteroPending = test(false).then(connected => {
    if (!connection.isConnected) return;
    if (!connected) { linkedZotero = null; zoteroSettled = true; summary.replaceChildren(); return; }
    return restore().catch(showRestoreError);
  });
}
