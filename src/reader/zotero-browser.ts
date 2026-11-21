import type { Collection, OpenDocument, ZoteroItem } from '../shared/types.js';
import { api, button, el, icon, message, readerLabel as t, safeWeb, webPageError } from './ui.js';

export interface ZoteroBrowsePosition { collection: string; query: string; library?: string }

function collectionOptions(collections: Collection[]): HTMLOptionElement[] {
  const byKey = new Map(collections.map(collection => [collection.key, collection]));
  return collections.map(collection => {
    const path = [collection.name], visited = new Set([collection.key]);
    let parent = collection.parentCollection && byKey.get(collection.parentCollection);
    while (parent && !visited.has(parent.key)) {
      path.unshift(parent.name); visited.add(parent.key);
      parent = parent.parentCollection && byKey.get(parent.parentCollection);
    }
    const opt = el('option', '', path.join(' / '));
    opt.value = collection.key;
    return opt;
  }).sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true }));
}

function external(url: string, name: string): HTMLAnchorElement {
  const link = el('a', 'external', name);
  link.href = url;
  if (url.startsWith('https:') || url.startsWith('http:')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  return link;
}

function problem(error: unknown): string {
  const detail = message(error);
  if (/Open Zotero on this computer/i.test(detail)) return t('Open Zotero on this computer, then refresh the library.', '请在这台电脑上打开 Zotero，再刷新资料库。');
  if (/Allow other applications|enable the local API/i.test(detail)) return t('In Zotero Settings → Advanced, allow other applications to communicate with Zotero, then refresh.', '请在 Zotero 的「设置 → 高级」中允许其他应用与 Zotero 通信，再刷新资料库。');
  if (/requires a Zotero API key/i.test(detail)) return t('This library needs a Zotero key with read access. Add it in Connection settings.', '此资料库需要读取权限。请在「连接设置」中填写 Zotero 密钥。');
  if (/library changed|another library|library has changed/i.test(detail)) return t('The Zotero library has changed. Refresh to browse it.', 'Zotero 资料库已切换。请刷新后重新选择文献。');
  return detail;
}

export function browseZotero(panel: HTMLElement, position: ZoteroBrowsePosition, read: (opened: OpenDocument) => Promise<void>, settings: () => void): void {
  const search = el('input', 'search');
  search.type = 'search'; search.ariaLabel = t('Search Zotero', '搜索 Zotero');
  search.placeholder = t('Search title, author or year', '搜索标题、作者或年份');
  search.value = position.query;
  const scope = el('select');
  scope.ariaLabel = t('Collection', '分类');
  const all = el('option', '', t('All items', '全部条目')); all.value = '';
  scope.append(all);
  const filters = el('div', 'library-filters');
  filters.append(search, scope);
  const status = el('p', 'library-status');
  status.setAttribute('role', 'status');
  const result = el('div', 'library-results');
  const more = button(t('More items', '加载更多'), () => loadItems(next), 'btn library-more');
  more.hidden = true;
  const footer = el('div', 'library-footer');
  const detail = el('span', 'library-connection');
  const refresh = button(t('Refresh', '刷新'), () => start(true), 'text-btn');
  footer.append(detail, refresh, button(t('Connection settings', '连接设置'), settings, 'text-btn'));
  panel.append(filters, status, result, more, footer);
  const live = () => Boolean(panel.closest('dialog[open]'));
  let generation = 0, collectionRequest = 0, opening = 0, next: number | null = null;
  let mode: 'web' | 'desktop' | undefined;
  let collections: Collection[] = [], scopeError = '';
  let searchTimer: ReturnType<typeof setTimeout>;
  const seen = new Set<string>();

  function showLocation() {
    detail.replaceChildren();
    if (!mode) return;
    if (scopeError) { detail.textContent = scopeError; return; }
    const selected = collections.find(group => group.key === position.collection);
    const url = selected && (mode === 'desktop' ? 'zotero://select/library/collections/' + selected.key : safeWeb(selected.webUrl));
    if (url) detail.append(external(url, t('Open collection in Zotero', '在 Zotero 中打开分类')));
    else detail.textContent = mode === 'desktop' ? t('Zotero Desktop', '本机 Zotero') : t('Zotero Web Library', 'Zotero 网页资料库');
  }

  function showRow(item: ZoteroItem, library: string) {
    const row = el('div', 'zotero-item');
    const issue = el('div', 'library-item-status'); issue.setAttribute('role', 'status');
    const target = mode === 'desktop' ? 'zotero://select/library/items/' + encodeURIComponent(item.key) : safeWeb(item.webUrl);
    const title = item.title || item.doi || item.url || t('Untitled item', '无标题条目');
    const open = button('', async () => {
      const version = ++opening;
      const current = () => live() && row.isConnected && version === opening;
      for (const status of result.querySelectorAll('.library-item-status')) status.replaceChildren();
      issue.textContent = t('Opening…', '正在打开…');
      let original: string | undefined;
      try {
        const destination = await api('zotero.open', { key: item.key, library });
        if (!current()) return;
        if (destination.kind === 'unavailable') {
          issue.replaceChildren(document.createTextNode(t('No readable full text is available for this item. ', '这条文献没有可在此阅读的全文。 ')),
            external(destination.zoteroUrl, t('View item in Zotero', '在 Zotero 查看条目')));
          return;
        }
        if (destination.kind === 'document') { await read(destination); return; }
        original = safeWeb(destination.url);
        if (!original) throw Error(t('The item has no web address.', '这条文献没有网页地址。'));
        const opened = await api('web.open', { url: original });
        if (!current()) return;
        await api('zotero.link', { key: item.key, docId: opened.doc.id, library });
        if (current()) await read(opened);
      } catch (error) {
        if (!current()) return;
        issue.replaceChildren(document.createTextNode((original ? webPageError(error) : problem(error)) + ' '));
        if (original) issue.append(external(original, t('Open original page', '打开原网页')));
      }
    }, 'library-document');
    open.ariaLabel = title;
    const text = el('span', 'library-row-text');
    text.append(el('strong', '', title));
    const year = item.date?.match(/(?:^|\D)([12]\d{3})(?:\D|$)/)?.[1];
    const domain = safeWeb(item.url) ? new URL(item.url!).hostname : '';
    const metadata = [item.creator, year || item.date, domain].filter(Boolean);
    if (metadata.length) text.append(el('small', '', metadata.join(' · ')));
    open.append(icon(item.type === 'webpage' ? 'globe' : 'note', 18), text);
    row.append(open);
    if (target) {
      const link = external(target, '');
      link.className = 'library-zotero-link';
      link.title = t('Open in Zotero', '在 Zotero 中打开');
      link.ariaLabel = link.title + ' · ' + title;
      link.append(icon('popout', 16));
      row.append(link);
    }
    row.append(issue);
    result.append(row);
  }

  async function loadItems(start: number | null = 0) {
    if (start === null || !live()) return;
    const version = ++generation;
    const query = search.value.trim(), collection = position.collection;
    position.query = search.value;
    if (!start) { result.replaceChildren(); seen.clear(); ++opening; next = null; }
    more.hidden = true;
    status.textContent = t('Loading Zotero items…', '正在读取 Zotero 条目…');
    result.setAttribute('aria-busy', 'true');
    try {
      const page = await api('zotero.browse', { query, collection: collection || undefined, start, library: position.library });
      if (!live() || version !== generation) return;
      mode = page.mode; position.library = page.library;
      showLocation();
      for (const item of page.items) {
        if (seen.has(item.key)) continue;
        seen.add(item.key); showRow(item, page.library);
      }
      next = page.nextStart; more.hidden = next === null;
      status.textContent = seen.size || next !== null ? '' : query ? t('No matching items.', '没有找到符合条件的条目。')
        : collection ? t('This collection has no items.', '这个分类中还没有文献。') : t('Your Zotero library has no items.', '这个 Zotero 资料库中还没有文献。');
    } catch (error) {
      if (!live() || version !== generation) return;
      status.textContent = problem(error);
      if (start) more.hidden = false;
    } finally {
      if (live() && version === generation) result.setAttribute('aria-busy', 'false');
    }
  }
  async function loadCollections() {
    const version = ++collectionRequest;
    try {
      const data = await api('zotero.collections', { library: position.library });
      if (!live() || version !== collectionRequest || (position.library && data.library !== position.library)) return;
      collections = data.collections; scopeError = '';
      scope.replaceChildren(all, ...collectionOptions(collections));
      scope.value = position.collection;
      if (scope.selectedIndex < 0) {
        scope.value = ''; position.collection = '';
        await loadItems();
      }
      showLocation();
    } catch (error) {
      if (live() && version === collectionRequest) { scopeError = problem(error); showLocation(); }
    }
  }
  function start(reset: boolean) {
    clearTimeout(searchTimer);
    if (reset) { position.library = undefined; }
    void loadItems();
    void loadCollections();
  }
  function changingFilters() {
    clearTimeout(searchTimer);
    ++generation; ++opening;
    next = null; more.hidden = true; result.replaceChildren();
    status.textContent = t('Searching…', '正在搜索…');
  }
  search.addEventListener('input', () => {
    changingFilters();
    position.query = search.value;
    searchTimer = setTimeout(() => { void loadItems(); }, 180);
  });
  scope.addEventListener('change', () => {
    changingFilters(); position.collection = scope.value; showLocation(); void loadItems();
  });
  function returnedFromZotero() { if (live()) start(true); }
  panel.addEventListener('click', event => {
    const link = event.target instanceof Element && event.target.closest('a');
    if (link && (link.protocol === 'zotero:' || link.hostname === 'www.zotero.org')) {
      window.addEventListener('focus', returnedFromZotero, { once: true });
    }
  });
  start(false);
}
