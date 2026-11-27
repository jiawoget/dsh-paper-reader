import type { WatchlistEntry, WatchlistItem } from '../../shared/deep-search-types.js';
import type { GraphPaper } from '../../shared/types.js';
import { api, el, message, readerLabel as t, toast } from '../ui.js';
import { researchIcon } from './icons.js';
import { researchText } from './labels.js';
import { formatDegradedSources, mkBtn, renderPaperActions, saveGraphPaper } from './paper-intake.js';
import type { ResearchShellContext } from './state.js';

interface WatchlistCallbacks {
  shell: () => ResearchShellContext | undefined; currentQuery: () => string;
  onClose: () => void; onUnreadChange: (count: number) => void; onPaperSaved?: (paper: GraphPaper, docId: string) => void;
}

export class WatchlistDrawer {
  readonly backdrop = el('div', 'wl-backdrop'); readonly root = el('aside', 'wl-drawer');
  private readonly checkAllBtn = el('button', 'btn wl-check-all', t('Check all', '全部检查'));
  private readonly watchCurBtn = el('button', 'btn wl-watch-cur', t('+ Watch current query', '+ 追踪当前检索'));
  private readonly addInput = el('input', 'search wl-add-input');
  private readonly addSubmit = el('button', 'btn primary wl-add-btn', researchText.saveTopic());
  private readonly statusEl = el('div', 'wl-status'); private readonly listEl = el('div', 'wl-list');
  private entries: WatchlistEntry[] = []; private readonly expanded = new Set<string>();
  private readonly savingIds = new Set<string>(); private readonly itemSlots = new Map<string, HTMLElement>();
  private busy = false; private mounted = true; private ver = 0; private prevFocus: HTMLElement | null = null;

  constructor(private readonly cb: WatchlistCallbacks) {
    this.backdrop.hidden = this.root.hidden = true; this.backdrop.addEventListener('click', () => this.close());
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-label', t('Watchlist', 'Watchlist 追踪'));
    this.root.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); this.close(); } });
    const head = el('div', 'wl-head'), headRight = el('div', 'wl-head-actions'), closeBtn = el('button', 'icon-btn wl-close');
    closeBtn.type = 'button'; closeBtn.ariaLabel = closeBtn.title = t('Close Watchlist', '关闭 Watchlist');
    closeBtn.append(researchIcon('close', 16)); closeBtn.addEventListener('click', () => this.close());
    this.checkAllBtn.type = 'button'; this.checkAllBtn.addEventListener('click', () => { void this.check(); });
    headRight.append(this.checkAllBtn, closeBtn); head.append(el('h2', 'wl-title', t('Watchlist', 'Watchlist 追踪')), headRight);
    const form = el('form', 'wl-add-form'), body = el('div', 'wl-body');
    Object.assign(this.addInput, { type: 'text', maxLength: 500, required: true, ariaLabel: t('Topic query to watch', '要追踪的主题检索词'), placeholder: t('Topic or search query to watch…', '输入要追踪的主题或检索问题…') });
    this.addSubmit.type = 'submit'; form.append(this.addInput, this.addSubmit);
    form.addEventListener('submit', e => { e.preventDefault(); const q = this.addInput.value.trim(); if (q) void this.watchQuery(q, true); });
    this.watchCurBtn.type = 'button'; this.watchCurBtn.hidden = true;
    this.watchCurBtn.addEventListener('click', () => { const q = this.cb.currentQuery().trim(); if (q) void this.watchQuery(q, false); });
    this.statusEl.setAttribute('role', 'status'); body.append(this.watchCurBtn, form, this.statusEl, this.listEl); this.root.append(head, body);
  }

  isOpen(): boolean { return !this.root.hidden; }
  unmount(): void { this.mounted = false; this.itemSlots.clear(); }
  open(): void { if (this.isOpen()) return; this.prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; this.backdrop.hidden = this.root.hidden = false; this.render(); this.addInput.focus({ preventScroll: true }); void this.refresh(); }
  close(): void { if (!this.isOpen()) return; this.backdrop.hidden = this.root.hidden = true; if (this.prevFocus?.isConnected) this.prevFocus.focus({ preventScroll: true }); this.prevFocus = null; this.cb.onClose(); }
  async refresh(): Promise<void> {
    if (this.busy) return; const v = ++this.ver;
    try { const { entries } = await api('watchlist.list', {}); if (!this.mounted || v !== this.ver) return; this.entries = entries; this.emitUnread(); if (this.isOpen()) this.render(); }
    catch (err) { if (this.mounted && v === this.ver && this.isOpen()) this.statusEl.textContent = message(err); }
  }
  async watchQuery(rawQuery: string, clearInput = false): Promise<void> {
    const query = rawQuery.trim(); if (!query || this.busy) return;
    if (this.entries.some(e => e.kind === 'topic' && e.query.trim().toLowerCase() === query.toLowerCase())) { toast(t('Already in Watchlist.', '该检索已在 Watchlist 中。')); return; }
    await this.runAction(async () => {
      const { entry } = await api('watchlist.save', { kind: 'topic', label: query.slice(0, 120), query }); if (!this.mounted) return;
      this.entries = [entry, ...this.entries.filter(e => e.id !== entry.id)]; if (clearInput) this.addInput.value = '';
      this.emitUnread(); this.statusEl.textContent = t('Saved to Watchlist (zero-token tracking).', '已加入 Watchlist（零 Token 增量追踪）。'); toast(t('Added to Watchlist.', '已加入 Watchlist。'));
    });
  }
  syncPaperInLibrary(paperId: string, inLib: boolean, docId?: string): void {
    for (const e of this.entries) for (const item of e.unread) if ((paperId && item.paper.id === paperId) || (docId && item.paper.docId === docId)) {
      item.paper.inLibrary = inLib; item.paper.docId = inLib ? docId : undefined;
      const slot = this.itemSlots.get(`${e.id}:${item.key}`); if (this.mounted && slot) this.renderItemSlot(slot, item);
    }
  }

  private emitUnread(): void { this.cb.onUnreadChange(this.entries.reduce((sum, e) => sum + e.unread.length, 0)); }
  private setBusy(next: boolean): void { this.busy = next; this.addSubmit.disabled = this.watchCurBtn.disabled = next; this.checkAllBtn.disabled = next || !this.entries.length; }
  private async runAction(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return; ++this.ver; this.setBusy(true);
    try { await fn(); } catch (err) { if (this.mounted) { this.statusEl.textContent = message(err); toast(message(err)); } }
    finally { if (this.mounted) { this.setBusy(false); this.render(); } }
  }
  private check(id?: string): Promise<void> {
    this.statusEl.textContent = t('Checking for new papers (zero tokens)…', '正在零 Token 增量检查新文献…');
    return this.runAction(async () => {
      const res = await api('watchlist.check', id ? { id } : {}); if (!this.mounted) return;
      this.entries = res.entries; for (const e of this.entries) if (e.unread.length && (!id || e.id === id)) this.expanded.add(e.id);
      this.emitUnread();
      const deg = formatDegradedSources(res.degraded), msg = res.newItemsCount > 0 ? t(`Found ${res.newItemsCount} new paper(s).`, `发现 ${res.newItemsCount} 篇新文献。`) : t('Up to date: no new papers since cursor.', '已是最新，游标后暂无新文献。');
      this.statusEl.textContent = deg ? `${msg} ${deg}` : msg;
    });
  }
  private renderItemSlot(slot: HTMLElement, item: WatchlistItem): void {
    const p = item.paper;
    renderPaperActions(slot, p, { prefix: 'wl', busy: this.savingIds.has(p.id), openLabel: t('Open in Reader', '打开精读'), onOpen: docId => { void this.cb.shell()?.inspectInReader({ docId, page: 1 }).catch(e => toast(message(e))); }, onSave: mode => { void this.saveItemPaper(item, mode); } });
  }
  private async saveItemPaper(item: WatchlistItem, mode: 'abstract' | 'oa-pdf'): Promise<void> {
    const p = item.paper; if (this.savingIds.has(p.id)) return;
    const prevIn = Boolean(p.inLibrary), prevDoc = p.docId; this.savingIds.add(p.id); this.syncPaperInLibrary(p.id, true, prevDoc);
    try { const doc = await saveGraphPaper(p, mode, this.cb.shell()); this.savingIds.delete(p.id); this.syncPaperInLibrary(p.id, true, doc.id); this.cb.onPaperSaved?.(p, doc.id); }
    catch (err) { this.savingIds.delete(p.id); this.syncPaperInLibrary(p.id, prevIn, prevDoc); toast(message(err)); }
  }
  render(): void {
    const curQ = this.cb.currentQuery().trim();
    this.watchCurBtn.hidden = !curQ || this.entries.some(e => e.kind === 'topic' && e.query.trim().toLowerCase() === curQ.toLowerCase());
    this.checkAllBtn.disabled = this.busy || !this.entries.length; this.itemSlots.clear(); this.listEl.replaceChildren();
    if (!this.entries.length) { this.listEl.append(el('p', 'wl-empty', t('No watchlists saved yet. Save a search query to track new papers with zero tokens.', '暂无追踪项。保存检索主题即可零 Token 增量追踪新文献。'))); return; }
    for (const e of this.entries) {
      const card = el('article', 'wl-entry'), top = el('div', 'wl-entry-top'), actions = el('div', 'wl-entry-actions'); card.dataset.entryId = e.id;
      top.append(el('span', 'wl-kind-pill', e.kind === 'paper' ? t('Paper', '文献') : t('Topic', '主题')), el('strong', 'wl-entry-label', e.label), ...(e.unread.length ? [el('span', 'wl-unread-badge', String(e.unread.length))] : []));
      const meta = el('p', 'wl-entry-meta', t(`Cursor ${e.cursorDate}`, `游标 ${e.cursorDate}`) + (e.lastCheckedAt ? t(` · Checked ${e.lastCheckedAt.slice(0, 10)}`, ` · 已检 ${e.lastCheckedAt.slice(0, 10)}`) : ''));
      const chkBtn = mkBtn('btn wl-check-one', t('Check', '检查'), () => { void this.check(e.id); }); chkBtn.disabled = this.busy; actions.append(chkBtn);
      if (e.unread.length) {
        const exp = this.expanded.has(e.id), togBtn = mkBtn('btn wl-toggle-unread', exp ? t('Hide new', '收起新文献') : t(`${e.unread.length} new`, `${e.unread.length} 篇新文献`), () => { if (exp) this.expanded.delete(e.id); else this.expanded.add(e.id); this.render(); this.listEl.querySelector<HTMLElement>(`.wl-entry[data-entry-id="${CSS.escape(e.id)}"] .wl-toggle-unread`)?.focus({ preventScroll: true }); });
        togBtn.setAttribute('aria-expanded', String(exp));
        const rdBtn = mkBtn('btn wl-mark-read', t('Mark read', '标为已读'), () => { void this.runAction(async () => { const { entry } = await api('watchlist.markRead', { id: e.id }); if (!this.mounted) return; this.entries = this.entries.map(x => x.id === e.id ? entry : x); this.expanded.delete(e.id); this.emitUnread(); }); });
        rdBtn.disabled = this.busy; actions.append(togBtn, rdBtn);
      }
      const delBtn = mkBtn('text-btn wl-del-btn', t('Remove entry', '删除'), () => { void this.runAction(async () => { await api('watchlist.delete', { id: e.id }); if (!this.mounted) return; this.entries = this.entries.filter(x => x.id !== e.id); this.expanded.delete(e.id); this.emitUnread(); }); });
      delBtn.disabled = this.busy; actions.append(delBtn); card.append(top, meta, actions);
      if (e.unread.length && this.expanded.has(e.id)) {
        const list = el('div', 'wl-unread-list');
        for (const item of e.unread) {
          const row = el('div', 'wl-item'), slot = el('div', 'wl-item-actions'), sub = [item.paper.firstAuthor, item.paper.year ? String(item.paper.year) : '', item.paper.venue ?? ''].filter(Boolean).join(' · ');
          row.append(el('div', 'wl-item-title', item.paper.title), ...(sub ? [el('div', 'wl-item-meta', sub)] : []), slot);
          this.renderItemSlot(slot, item); this.itemSlots.set(`${e.id}:${item.key}`, slot); list.append(row);
          this.cb.shell()?.paperFloatBar?.attach(row, { paper: item.paper, onSaved: doc => { this.syncPaperInLibrary(item.paper.id, true, doc.id); this.cb.onPaperSaved?.(item.paper, doc.id); } });
        }
        card.append(list);
      }
      this.listEl.append(card);
    }
  }
}
