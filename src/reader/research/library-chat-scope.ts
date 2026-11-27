import type { DocumentInfo } from '../../shared/types.js';
import { abstractOnlyLabel } from '../abstract-view.js';
import { el, icon, readerLabel as t } from '../ui.js';
import { researchIcon } from './icons.js';
import { mkBtn } from './paper-intake.js';

export interface ScopeSavedState {
  selectedIds: string[]; filter: string; open: boolean;
  collapsedSections: string[]; collapsedGroups: string[]; scrollTop: number;
}
interface ScopeGroup { id: string; label: string; docs: DocumentInfo[] }
interface ScopeSection { id: string; label: string; groups: ScopeGroup[] }

const docTitle = (d: DocumentInfo) => d.paperTitle || d.title;
const docSub = (d: DocumentInfo) => [d.authors?.split(/[,;]/)[0]?.trim() || '', d.year || ''].filter(Boolean).join(' · ');

function buildSections(docs: readonly DocumentInfo[]): ScopeSection[] {
  const byTag = new Map<string, DocumentInfo[]>(), untagged: DocumentInfo[] = [];
  for (const d of docs) {
    const tags = d.meta?.tags?.filter(Boolean) ?? [];
    if (!tags.length) untagged.push(d);
    else for (const tag of tags) { const list = byTag.get(tag) ?? []; list.push(d); byTag.set(tag, list); }
  }
  const tagGroups: ScopeGroup[] = [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([tag, list]) => ({ id: `tag:${tag}`, label: tag, docs: list }));
  if (untagged.length) tagGroups.push({ id: 'tag:__untagged__', label: t('Untagged', '未分类'), docs: untagged });
  const push = (arr: ScopeGroup[], id: string, label: string, list: DocumentInfo[]) => { if (list.length) arr.push({ id, label, docs: list }); };
  const comp: ScopeGroup[] = [], stat: ScopeGroup[] = [];
  push(comp, 'kind:full', t('Full text PDF', '全文 PDF'), docs.filter(d => d.kind !== 'abstract'));
  push(comp, 'kind:abstract', abstractOnlyLabel(), docs.filter(d => d.kind === 'abstract'));
  push(stat, 'status:starred', t('Starred', '星标'), docs.filter(d => Boolean(d.meta?.starred)));
  push(stat, 'status:read', t('Read', '已读'), docs.filter(d => d.meta?.status === 'done' || d.meta?.status === 'reading'));
  push(stat, 'status:unread', t('Unread', '未读'), docs.filter(d => !d.meta?.status || d.meta.status === 'unread'));
  return [
    { id: 'tags', label: t('Collection / Tag', '课题 / 标签'), groups: tagGroups },
    { id: 'completeness', label: t('Text Completeness', '文本完整度'), groups: comp },
    { id: 'status', label: t('Reading Status', '阅读状态'), groups: stat }
  ];
}

export class LibraryChatScope {
  readonly root = el('aside', 'lc-scope-pane');
  readonly backdrop = el('div', 'lc-scope-backdrop');
  private readonly badge = el('span', 'lc-scope-badge');
  private readonly search = el('input', 'search lc-scope-search');
  private readonly body = el('div', 'lc-scope-body');
  private docs: DocumentInfo[] = [];
  private selected = new Set<string>();
  private collapsedSections = new Set<string>();
  private collapsedGroups = new Set<string>();
  private initialized = false; private filter = ''; private open = innerWidth > 1080; private restoredScroll?: number;
  private groupRefs: { ids: string[]; input: HTMLInputElement; count: HTMLElement }[] = [];
  private docInputs = new Map<string, HTMLInputElement[]>();

  constructor(private readonly opts: { onChange: () => void; onClose: () => void; onAttachRow?: (row: HTMLElement, doc: DocumentInfo) => void }) {
    this.root.ariaLabel = t('Paper Scope', '文献范围'); this.backdrop.hidden = true;
    const close = () => { this.setOpen(false); this.opts.onClose(); };
    this.backdrop.addEventListener('click', close);
    const head = el('div', 'lc-scope-head'), titleWrap = el('div', 'lc-scope-title-wrap'), closeBtn = el('button', 'icon-btn lc-scope-close');
    titleWrap.append(el('h2', 'lc-scope-title', t('Paper Scope', '文献范围')), this.badge);
    closeBtn.type = 'button'; closeBtn.ariaLabel = closeBtn.title = t('Close paper scope', '关闭文献范围');
    closeBtn.append(researchIcon('close', 16)); closeBtn.addEventListener('click', close);
    head.append(titleWrap, closeBtn);
    this.search.type = 'search'; this.search.placeholder = t('Search papers…', '筛选文献…');
    this.search.ariaLabel = t('Filter papers by title, author, or tag', '按标题、作者或标签筛选文献');
    this.search.addEventListener('input', () => { this.filter = this.search.value; this.render(); });
    const tools = el('div', 'lc-scope-tools'), bulk = el('div', 'lc-scope-bulk');
    bulk.append(mkBtn('text-btn lc-bulk-btn', t('Select all', '全选'), () => this.selectFiltered(true)), mkBtn('text-btn lc-bulk-btn', t('Deselect all', '取消全选'), () => this.selectFiltered(false)));
    tools.append(this.search, bulk); this.root.append(head, tools, this.body);
    this.root.addEventListener('keydown', e => { if (e.key === 'Escape' && this.open && innerWidth <= 1080) { e.stopPropagation(); close(); } });
    this.syncVisibility();
  }

  isOpen(): boolean { return this.open; }
  setOpen(next: boolean): void { this.open = next; this.syncVisibility(); }
  getAllDocs(): DocumentInfo[] { return this.docs; }
  getSelectedDocs(): DocumentInfo[] { return this.docs.filter(d => this.selected.has(d.id)); }

  setDocs(docs: DocumentInfo[], initTopic?: string): void {
    this.docs = docs;
    const valid = new Set(docs.map(d => d.id));
    if (!this.initialized) {
      this.initialized = true;
      const scoped = initTopic ? docs.filter(d => d.meta?.tags?.includes(initTopic)) : [];
      for (const d of (scoped.length ? scoped : docs)) this.selected.add(d.id);
    } else for (const id of [...this.selected]) if (!valid.has(id)) this.selected.delete(id);
    this.render(); this.flushScroll(); this.opts.onChange();
  }

  removeDoc(docId: string): void { this.docs = this.docs.filter(d => d.id !== docId); this.selected.delete(docId); this.render(); this.opts.onChange(); }

  saveState(): ScopeSavedState {
    return { selectedIds: [...this.selected], filter: this.filter, open: this.open, collapsedSections: [...this.collapsedSections], collapsedGroups: [...this.collapsedGroups], scrollTop: this.body.scrollTop };
  }

  restoreState(s: ScopeSavedState): void {
    this.initialized = true; this.selected = new Set(s.selectedIds ?? []); this.filter = s.filter ?? '';
    this.search.value = this.filter; this.open = Boolean(s.open);
    this.collapsedSections = new Set(s.collapsedSections ?? []); this.collapsedGroups = new Set(s.collapsedGroups ?? []);
    this.restoredScroll = s.scrollTop ?? 0; this.syncVisibility(); this.render(); this.flushScroll();
  }

  private flushScroll(): void { if (this.restoredScroll !== undefined && this.docs.length) { this.body.scrollTop = this.restoredScroll; this.restoredScroll = undefined; } }

  private filteredDocs(): DocumentInfo[] {
    const q = this.filter.trim().toLowerCase();
    return q ? this.docs.filter(d => `${docTitle(d)} ${d.authors ?? ''} ${d.year ?? ''} ${(d.meta?.tags ?? []).join(' ')}`.toLowerCase().includes(q)) : this.docs;
  }

  private selectFiltered(on: boolean): void {
    for (const d of this.filteredDocs()) { if (on) this.selected.add(d.id); else this.selected.delete(d.id); }
    this.syncChecks(); this.opts.onChange();
  }

  private syncVisibility(): void { this.root.hidden = !this.open; this.backdrop.hidden = !this.open; }

  private syncChecks(): void {
    this.badge.textContent = `${this.selected.size} / ${this.docs.length}`;
    for (const [id, inputs] of this.docInputs) { const on = this.selected.has(id); for (const input of inputs) input.checked = on; }
    for (const g of this.groupRefs) {
      const sel = g.ids.filter(id => this.selected.has(id)).length;
      g.input.checked = sel > 0 && sel === g.ids.length; g.input.indeterminate = sel > 0 && sel < g.ids.length;
      g.count.textContent = `${sel} / ${g.ids.length}`;
    }
  }

  private render(): void {
    const prevTop = this.body.scrollTop; this.body.replaceChildren(); this.groupRefs = []; this.docInputs.clear();
    const matched = this.filteredDocs();
    if (!this.docs.length || !matched.length) {
      this.body.append(el('p', 'lc-scope-empty', this.docs.length ? t('No papers match this filter.', '没有符合筛选条件的文献。') : t('No papers in your local library yet.', '本地文献库暂无文献。')));
      this.syncChecks(); return;
    }
    const toggleSet = (set: Set<string>, id: string) => { if (set.has(id)) set.delete(id); else set.add(id); this.render(); };
    for (const sec of buildSections(matched)) {
      if (!sec.groups.length) continue;
      const box = el('section', 'lc-cat'), collapsed = this.collapsedSections.has(sec.id), toggle = el('button', 'lc-cat-toggle');
      toggle.type = 'button'; toggle.dataset.sectionId = sec.id; toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.append(icon(collapsed ? 'next' : 'down', 14), el('span', 'lc-cat-name', sec.label));
      toggle.addEventListener('click', () => toggleSet(this.collapsedSections, sec.id)); box.append(toggle);
      if (!collapsed) {
        const list = el('div', 'lc-cat-groups');
        for (const group of sec.groups) {
          const gWrap = el('div', 'lc-group'), gCollapsed = this.collapsedGroups.has(group.id), gHead = el('div', 'lc-group-head');
          const gLabel = el('label', 'lc-group-check'), gCheck = el('input', 'lc-check'), ids = group.docs.map(d => d.id), gCount = el('span', 'lc-group-count'), foldBtn = el('button', 'icon-btn lc-group-fold');
          gCheck.type = 'checkbox'; gCheck.dataset.groupId = group.id;
          gCheck.addEventListener('change', () => { const allSel = ids.every(id => this.selected.has(id)); for (const id of ids) { if (allSel) this.selected.delete(id); else this.selected.add(id); } this.syncChecks(); this.opts.onChange(); });
          gLabel.append(gCheck, el('span', 'lc-group-name', group.label), gCount);
          foldBtn.type = 'button'; foldBtn.setAttribute('aria-expanded', String(!gCollapsed)); foldBtn.ariaLabel = t('Toggle group', '展开或折叠分组');
          foldBtn.append(icon(gCollapsed ? 'next' : 'down', 14)); foldBtn.addEventListener('click', () => toggleSet(this.collapsedGroups, group.id));
          gHead.append(gLabel, foldBtn); gWrap.append(gHead); this.groupRefs.push({ ids, input: gCheck, count: gCount });
          if (!gCollapsed) {
            const dList = el('div', 'lc-group-docs');
            for (const doc of group.docs) {
              const row = el('label', 'lc-doc-row'), cb = el('input', 'lc-check'), info = el('span', 'lc-doc-info'), meta = el('span', 'lc-doc-meta');
              cb.type = 'checkbox'; cb.dataset.docId = doc.id;
              cb.addEventListener('change', () => { if (cb.checked) this.selected.add(doc.id); else this.selected.delete(doc.id); this.syncChecks(); this.opts.onChange(); });
              const bucket = this.docInputs.get(doc.id) ?? []; bucket.push(cb); this.docInputs.set(doc.id, bucket);
              const sub = docSub(doc); if (sub) meta.append(el('span', 'lc-doc-sub', sub));
              if (doc.kind === 'abstract') meta.append(el('span', 'abstract-badge lc-doc-abs', abstractOnlyLabel()));
              info.append(el('span', 'lc-doc-title', docTitle(doc))); if (meta.childNodes.length) info.append(meta);
              row.append(cb, info); dList.append(row);
              this.opts.onAttachRow?.(row, doc);
            }
            gWrap.append(dList);
          }
          list.append(gWrap);
        }
        box.append(list);
      }
      this.body.append(box);
    }
    this.syncChecks(); this.body.scrollTop = prevTop;
  }
}
