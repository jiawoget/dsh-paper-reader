import { LIBRARY_PAGE_SIZE, slicePage } from '../shared/library-relevance.js';
import { openStaxLocation } from '../shared/openstax.js';
import { collectLibraryTags, mergeTags, normalizeTag } from '../shared/tags.js';
import type { DocStatus, DocumentInfo, LibrarySearchHit, LibrarySearchKind, TopicRecord } from '../shared/types.js';
import { abstractOnlyLabel } from './abstract-view.js';
import { localBookPlace } from './book-position.js';
import { LibraryBulkController } from './library-bulk.js';
import { researchText } from './research/labels.js';
import { PaperFloatBar } from './research/paper-float-bar.js';
import { broadcastDocTags, closeTagPopover, isTagPopoverOpen, mountTagPicker } from './tag-picker.js';
import { api, button, byId, el, icon, message, readerLabel as t, toast, type ReaderPort } from './ui.js';

const nextStatus: Record<DocStatus, DocStatus> = { unread: 'reading', reading: 'done', done: 'unread' };
const statusText = (s: DocStatus) => s === 'done' ? t('Done', '已读') : s === 'reading' ? t('Reading', '在读') : t('Unread', '未读');
const kindText = (k: LibrarySearchKind) => k === 'note' ? t('Note', '笔记') : k === 'mark' ? t('Mark', '标记') : t('Doc', '文档');

function clearDocumentStorage(docId: string): void {
  for (const key of ['reader.page.' + docId, 'reader.tab.' + docId, 'reader.pdf-pages.' + docId, 'reader.book-position.' + docId]) localStorage.removeItem(key);
  if (localStorage.getItem('reader.last-document') === docId) localStorage.removeItem('reader.last-document');
  const focusPrefix = 'reader.focus.' + docId + '.', zoteroSuffix = ':' + docId;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(focusPrefix) || (key.startsWith('reader.zotero.') && key.endsWith(zoteroSuffix))) localStorage.removeItem(key);
  }
  try {
    const mdExact = 'reader.markdown-draft.' + docId, annExact = 'reader.annotation-drafts.' + docId;
    const qPrefix = 'reader.question-draft.' + encodeURIComponent(docId) + '/', snPrefix = 'reader.selection-note-draft.[' + JSON.stringify(docId) + ',';
    for (const key of Object.keys(sessionStorage)) {
      if (key === mdExact || key.startsWith(mdExact + '/') || key === annExact || key.startsWith(qPrefix) || key.startsWith(snPrefix)) sessionStorage.removeItem(key);
    }
  } catch {}
}

function makeSelect(ariaLabel: string, options: [string, string][]): HTMLSelectElement {
  const select = el('select'); select.ariaLabel = ariaLabel;
  for (const [value, text] of options) { const opt = el('option', '', text); opt.value = value; select.append(opt); }
  return select;
}

export function renderDeviceLibrary(app: ReaderPort, panel: HTMLElement, read: (doc: DocumentInfo) => Promise<void>, closeDialog: () => void): () => void {
  const search = el('input', 'search'); search.type = 'search';
  search.ariaLabel = search.placeholder = t('Search library, notes, and marks…', '搜索文档、笔记与标记…');
  const statusSelect = makeSelect(t('Filter by status', '按状态筛选'), [
    ['all', t('All status', '全部状态')], ['unread', t('Unread', '未读')], ['reading', t('Reading', '在读')], ['done', t('Done', '已读')], ['starred', t('Starred', '星标')]
  ]);
  const typeSelect = makeSelect(t('Filter by type', '按类型筛选'), [
    ['all', t('All types', '全部类型')], ['pdf', 'PDF'], ['abstract', abstractOnlyLabel()], ['web', t('Web', '网页')], ['book', t('Book', '书籍')]
  ]);
  const tagSelect = makeSelect(researchText.triageTagLabel(), [['', researchText.triageTagAll()]]);
  tagSelect.className = 'library-tag-filter';
  const sortSelect = makeSelect(t('Sort documents', '排序方式'), [
    ['recent', t('Recently read', '最近阅读')], ['added', t('Recently added', '最近添加')], ['title', t('Title', '标题')]
  ]);
  const controls = el('div', 'library-triage-controls'); controls.append(statusSelect, typeSelect, tagSelect, sortSelect);
  const status = el('p', 'library-status', t('Loading documents…', '正在读取文档…')); status.setAttribute('role', 'status');
  const list = el('div', 'library-results'), matches = el('section', 'library-search-matches'); matches.hidden = true;
  let pageLimit = LIBRARY_PAGE_SIZE, allDocs: DocumentInfo[] = [], allTopics: TopicRecord[] = [];
  let rerender: (() => void) | null = null;
  let syncTags: (() => void) | null = null;
  const applyBulkTag = async (docIds: string[], tag: string, mode: 'add' | 'remove') => {
    const clean = normalizeTag(tag);
    if (!clean) return;
    const res = await api('library.bulkTriage', mode === 'add' ? { docIds, addTags: [clean] } : { docIds, removeTags: [clean] });
    const idSet = new Set(docIds);
    for (const doc of allDocs) {
      if (!idSet.has(doc.id)) continue;
      const prev = doc.meta ?? { status: 'unread', starred: false, tags: [] };
      const nextMeta = { ...prev, tags: mergeTags(prev.tags, mode === 'add' ? { add: [clean] } : { remove: [clean] }) };
      doc.meta = nextMeta;
      if (app.doc.id === doc.id) app.doc.meta = nextMeta;
      broadcastDocTags(doc.id, nextMeta);
    }
    syncTags?.(); rerender?.();
    if (docIds[0]) app.notifyDocumentMutated?.(docIds[0]);
    toast(mode === 'add' ? researchText.libraryBulkTagged(res.updated, clean) : researchText.libraryBulkUntagged(res.updated, clean));
  };
  const bulk = new LibraryBulkController({
    onShowMore: () => { pageLimit += LIBRARY_PAGE_SIZE; rerender?.(); },
    onSelectionChange: () => floatBar.hide(),
    onAddTag: (docIds, tag) => applyBulkTag(docIds, tag, 'add'),
    onRemoveTag: (docIds, tag) => applyBulkTag(docIds, tag, 'remove'),
    getTagStats: () => collectLibraryTags(allDocs, allTopics),
    getSelectedTagCounts: docIds => { const ids = new Set(docIds); return collectLibraryTags(allDocs.filter(d => ids.has(d.id))); },
    onOpenReview: () => { closeDialog(); app.openResearchWorkspace?.('review-table'); },
    onDelete: async docIds => {
      const res = await api('library.bulkDelete', { docIds });
      const deletedSet = new Set(res.deletedIds), wasActive = deletedSet.has(app.doc.id);
      for (const id of res.deletedIds) { app.discardDocument?.(id); clearDocumentStorage(id); }
      allDocs = allDocs.filter(doc => !deletedSet.has(doc.id));
      bulk.clear();
      if (wasActive) await app.navigate('pagedattention');
      else if (res.deletedIds.length) await app.refresh();
      syncTags?.(); rerender?.();
      toast(researchText.libraryBulkDeleted(res.deletedIds.length, res.skippedIds.length));
    }
  });
  bulk.bindList(list);
  panel.append(search, controls, bulk.stripEl, bulk.bulkEl, status, list, bulk.pagerEl, matches);
  const floatBar = new PaperFloatBar(panel, {
    onRead: async target => { if (target.doc) await read(target.doc); },
    onAskAi: async target => { if (target.doc) { await read(target.doc); app.openPaperChat?.(); } },
    onCitations: target => { if (target.doc) { closeDialog(); app.openResearchWorkspace?.('citations', { docId: target.doc.id }); } },
    onCitationMap: target => { if (target.doc) { closeDialog(); app.openResearchWorkspace?.('citation-map', { seedDocId: target.doc.id }); } }
  }, { placement: 'outside', isSuppressed: () => bulk.hasSelection() || isTagPopoverOpen() });

  let searchTimer = 0, searchSeq = 0;
  let pendingCounts: Record<string, number> = {};
  void api('doc.resources.list', {}).then(res => {
    if (!panel.closest('dialog[open]') || !res.pendingCounts) return;
    pendingCounts = res.pendingCounts;
    if (Object.keys(pendingCounts).length) rerender?.();
  }).catch(() => undefined);
  function renderHits(hits: LibrarySearchHit[]): void {
    matches.replaceChildren(el('h3', 'library-matches-title', t('Matches across library', '跨库匹配结果')));
    matches.hidden = false;
    if (!hits.length) { matches.append(el('p', 'library-status', t('No matching notes or marks.', '没有找到匹配的笔记或标记。'))); return; }
    for (const hit of hits) {
      const row = button('', async () => {
        await app.navigate(hit.docId, hit.page, hit.anchor || '', hit.quote || '');
        if (hit.kind === 'note') app.showNotebook();
        closeDialog();
      }, 'doc-row library-search-hit');
      const badge = el('span', 'library-hit-kind', kindText(hit.kind)); badge.dataset.kind = hit.kind;
      const text = el('span', 'library-row-text');
      text.append(el('strong', '', hit.docTitle + (hit.page ? ' · ' + t('p. ' + hit.page, '第 ' + hit.page + ' 页') : '')), el('small', '', hit.snippet));
      row.append(badge, text); matches.append(row);
    }
  }
  function scheduleSearch(): void {
    window.clearTimeout(searchTimer);
    const query = search.value.trim();
    if (query.length < 2) { ++searchSeq; matches.hidden = true; matches.replaceChildren(); return; }
    const seq = ++searchSeq;
    matches.hidden = false; matches.replaceChildren(el('p', 'library-status', t('Searching library…', '正在检索资料库…')));
    searchTimer = window.setTimeout(() => {
      void api('library.search', { query }).then(
        ({ hits }) => { if (seq === searchSeq && panel.closest('dialog[open]')) renderHits(hits); },
        error => { if (seq === searchSeq && panel.closest('dialog[open]')) matches.replaceChildren(el('p', 'library-status', message(error))); }
      );
    }, 180);
  }

  void Promise.all([api('library.list', {}), api('topics.list', {}).catch(() => ({ topics: [] }))]).then(([{ docs }, { topics }]) => {
    if (!panel.closest('dialog[open]')) return;
    allDocs = docs; allTopics = topics;
    const editions = new Map<string, DocumentInfo[]>(), order = new Map(allDocs.map((d, i) => [d.id, i]));
    for (const doc of [...allDocs].reverse()) {
      const key = doc.title.toLocaleLowerCase(), group = editions.get(key);
      if (group) group.push(doc); else editions.set(key, [doc]);
    }
    let editingId = '', confirmingId = '', focusDeleteId = '';

    function syncTagOptions(): void {
      const prev = tagSelect.value, stats = collectLibraryTags(allDocs, allTopics);
      const sorted = [...stats].sort((a, b) => (a.label ?? a.tag).localeCompare(b.label ?? b.tag));
      tagSelect.replaceChildren(
        new Option(researchText.triageTagAll(), ''),
        ...sorted.map(s => new Option(s.label ?? s.tag, s.tag))
      );
      const match = sorted.find(s => s.tag.toLocaleLowerCase() === prev.toLocaleLowerCase());
      tagSelect.value = match ? match.tag : '';
    }
    syncTags = syncTagOptions;
    syncTagOptions();

    function render(): void {
      const query = search.value.trim().toLocaleLowerCase(), sFilter = statusSelect.value, tFilter = typeSelect.value, tagFilter = tagSelect.value.toLocaleLowerCase(), sortBy = sortSelect.value;
      const shown = allDocs.filter(doc => {
        if (query && ![doc.title, doc.paperTitle, doc.authors, doc.url, ...(doc.meta?.tags ?? [])].some(f => f?.toLocaleLowerCase().includes(query))) return false;
        const docStatus: DocStatus = doc.meta?.status ?? 'unread';
        if (sFilter === 'starred' ? !doc.meta?.starred : sFilter !== 'all' && docStatus !== sFilter) return false;
        if (tagFilter && !(doc.meta?.tags ?? []).some(tag => tag.toLocaleLowerCase() === tagFilter)) return false;
        return tFilter === 'all' || (doc.book ? 'book' : doc.kind) === tFilter;
      });
      shown.sort((a, b) => sortBy === 'title' ? a.title.localeCompare(b.title)
        : sortBy === 'added' ? ((Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0)) || ((order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        : ((b.meta?.lastOpenedAt ?? 0) - (a.meta?.lastOpenedAt ?? 0)) || ((order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)));
      const page = slicePage(shown, pageLimit);
      floatBar.hide();
      list.replaceChildren();
      status.textContent = shown.length ? '' : t('No matching documents.', '没有找到符合条件的文档。');

      for (const doc of page.items) {
        if (editingId === doc.id) {
          const form = el('form', 'library-rename'), input = el('input', 'search');
          input.value = doc.title; input.maxLength = 250; input.required = true;
          input.ariaLabel = input.placeholder = t('Document title', '文档标题');
          const save = el('button', 'btn primary', t('Save', '保存')); save.type = 'submit';
          const cancel = button(t('Cancel', '取消'), () => { editingId = ''; render(); });
          form.onsubmit = async event => {
            event.preventDefault(); save.disabled = true;
            try {
              const title = input.value.trim(); if (!title) { save.disabled = false; return; }
              const { doc: updated } = await api('library.rename', { id: doc.id, title });
              doc.title = updated.title; if (app.doc.id === doc.id) { app.doc.title = updated.title; byId('docTitle').textContent = updated.title; }
              editingId = ''; render();
            } catch (error) { toast(message(error)); save.disabled = false; }
          };
          form.append(input, save, cancel); list.append(form); input.focus(); input.select(); continue;
        }
        const group = editions.get(doc.title.toLocaleLowerCase()) ?? [doc], details: string[] = [];
        if (doc.book) {
          const place = localBookPlace(doc.id), section = place && doc.book.sections[place.page - 1], count = doc.book.sections.length;
          details.push(section ? t('Continue at ', '续读 · ') + section.title
            : openStaxLocation(doc.url) ? t('OpenStax book', 'OpenStax 图书')
            : t(count + (count === 1 ? ' section' : ' sections'), count + ' 节'));
        } else if (doc.kind === 'pdf') {
          const total = doc.meta?.pageCount || Number(localStorage.getItem('reader.pdf-pages.' + doc.id)) || 0;
          if (doc.meta?.lastPage && doc.meta.lastPage > 1 && total > 1) details.push(t('p. ' + doc.meta.lastPage + ' / ' + total, '第 ' + doc.meta.lastPage + ' / ' + total + ' 页'));
          else details.push(total > 0 ? t(total + (total === 1 ? ' page' : ' pages'), total + ' 页') : 'PDF');
        } else if (doc.kind === 'abstract') {
          const venueYear = [doc.venue, doc.year && !doc.venue?.includes(doc.year) ? doc.year : undefined].filter(Boolean).join(' · ');
          if (venueYear) details.push(venueYear);
        } else {
          details.push(doc.url ? new URL(doc.url).hostname : researchText.localDocument());
          if (doc.meta?.scrollFraction && doc.meta.scrollFraction > 0) details.push(Math.round(doc.meta.scrollFraction * 100) + '%');
        }
        if (doc.authors) details.push(doc.authors);
        if (group.length > 1) details.push(t('Copy ' + (group.indexOf(doc) + 1), '第 ' + (group.indexOf(doc) + 1) + ' 份'));

        const row = button('', () => read(doc), 'doc-row library-document'), text = el('span', 'library-row-text');
        const heading = el('span', 'library-row-heading');
        heading.append(el('strong', '', doc.title));
        if (doc.kind === 'abstract') heading.append(el('span', 'library-kind-badge', abstractOnlyLabel()));
        const pending = pendingCounts[doc.id] ?? 0;
        if (pending > 0) {
          const badge = el('span', 'library-res-dot', String(pending));
          badge.ariaLabel = badge.title = researchText.resourcePendingBadge(pending);
          heading.append(badge);
        }
        text.append(heading, el('small', '', details.join(' · ')));
        row.append(icon(doc.book ? 'book' : doc.kind === 'pdf' || doc.kind === 'abstract' || !doc.url ? 'note' : 'globe', 18), text);
        if (doc.id === app.doc.id) { row.setAttribute('aria-current', 'true'); row.append(el('small', 'library-current', t('Open', '正在阅读'))); }
        const main = el('div', 'library-doc-main'), rowTags = el('div', 'library-row-tags');
        mountTagPicker(rowTags, {
          doc, compact: true, getTaxonomy: () => collectLibraryTags(allDocs, allTopics),
          aiConfigured: app.state.settings.aiMode !== 'unconfigured',
          onMetaUpdated: meta => {
            doc.meta = meta; if (app.doc.id === doc.id) app.doc.meta = meta;
            syncTagOptions(); app.notifyDocumentMutated?.(doc.id);
            if (tagSelect.value) render();
          }
        });
        main.append(row, rowTags);

        const wrap = el('div', 'library-device-item'), actions = el('div', 'library-item-actions'), check = bulk.makeCheckbox(doc.id);
        wrap.dataset.docId = doc.id;
        if (confirmingId === doc.id) {
          const delBtn = button(t('Delete', '确认删除'), async () => {
            const wasActive = app.doc.id === doc.id;
            await api('library.delete', { id: doc.id }); app.discardDocument?.(doc.id); clearDocumentStorage(doc.id);
            const idx = allDocs.indexOf(doc); if (idx >= 0) allDocs.splice(idx, 1);
            bulk.remove(doc.id); confirmingId = '';
            if (wasActive) await app.navigate('pagedattention'); else await app.refresh();
            syncTagOptions(); render(); toast(t('Document removed from this device.', '已从本机删除文档。'));
          }, 'btn library-delete-confirm');
          delBtn.ariaLabel = delBtn.title = t('Confirm delete', '确认删除');
          const cancelBtn = button(t('Cancel', '取消'), () => { confirmingId = ''; focusDeleteId = doc.id; render(); });
          actions.append(delBtn, cancelBtn); wrap.append(check, main, actions); list.append(wrap); cancelBtn.focus({ preventScroll: true }); continue;
        }
        const starred = Boolean(doc.meta?.starred), curStatus: DocStatus = doc.meta?.status ?? 'unread';
        const starBtn = button('', async () => { doc.meta = (await api('library.triage', { docId: doc.id, starred: !starred })).meta; render(); }, 'icon-btn library-star', 'star');
        starBtn.setAttribute('aria-pressed', String(starred)); starBtn.ariaLabel = starBtn.title = starred ? t('Remove star', '取消星标') : t('Star document', '标星文档');
        const statusBtn = button(statusText(curStatus), async () => { doc.meta = (await api('library.triage', { docId: doc.id, status: nextStatus[curStatus] })).meta; render(); }, 'btn library-status-btn');
        statusBtn.dataset.status = curStatus; statusBtn.ariaLabel = statusBtn.title = t('Reading status: ' + statusText(curStatus), '阅读状态：' + statusText(curStatus));
        actions.append(starBtn, statusBtn);
        if (doc.id !== 'pagedattention') {
          const renameBtn = button('', () => { confirmingId = ''; editingId = doc.id; render(); }, 'icon-btn', 'edit');
          renameBtn.ariaLabel = renameBtn.title = t('Rename document', '重命名文档');
          const delBtn = button('', () => { confirmingId = doc.id; render(); }, 'icon-btn', 'trash');
          delBtn.ariaLabel = delBtn.title = t('Delete document', '删除文档');
          actions.append(renameBtn, delBtn); wrap.append(check, main, actions); list.append(wrap);
          if (focusDeleteId === doc.id) { focusDeleteId = ''; delBtn.focus({ preventScroll: true }); }
        } else { wrap.append(check, main, actions); list.append(wrap); }
        floatBar.attach(wrap, { doc, inLibrary: true });
      }
      bulk.updateView(new Set(allDocs.map(d => d.id)), page.items.map(d => d.id), shown.map(d => d.id), allDocs.length, page.hasMore);
    }
    rerender = render;
    search.addEventListener('input', () => { pageLimit = LIBRARY_PAGE_SIZE; render(); scheduleSearch(); });
    for (const select of [statusSelect, typeSelect, tagSelect, sortSelect]) select.addEventListener('change', () => { pageLimit = LIBRARY_PAGE_SIZE; render(); });
    render();
  }).catch(error => { status.textContent = message(error); });
  return () => { closeTagPopover(); floatBar.destroy(); };
}
