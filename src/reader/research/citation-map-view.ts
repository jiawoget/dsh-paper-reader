import type { DocumentInfo, GraphDirection, GraphExploreResult, GraphNode, GraphPaper } from '../../shared/types.js';
import { api, el, message, readerLabel as t, safeWeb, toast } from '../ui.js';
import { CitationMapSvg, type AuthorLabelMode, type GraphViewMode } from './citation-map-svg.js';
import type { ResearchShellContext, ResearchViewModule } from './state.js';

interface TrailStep { label: string; direction: GraphDirection; seedIds: string[]; result: GraphExploreResult; selectedId: string | null }
interface SavedState {
  trail: TrailStep[]; selectedId: string | null; mode: GraphViewMode; authorMode: AuthorLabelMode;
  graphCollapsed: boolean; mobilePane: 'list' | 'graph'; listScrollTop: number; seedDocId: string; seedQuery: string;
}

const CAP = 40, DIRS: readonly GraphDirection[] = ['earlier', 'later', 'similar'];
const DIR_TEXT: Record<GraphDirection, string> = { earlier: 'Earlier', later: 'Later', similar: 'Similar' };
const SRC_NAME: Record<string, string> = { openalex: 'OpenAlex', s2: 'Semantic Scholar', europepmc: 'Europe PMC', arxiv: 'arXiv' };
const isDir = (v?: string): v is GraphDirection => v === 'earlier' || v === 'later' || v === 'similar';
const isAbort = (err: unknown) => err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && /abort|cancel/i.test(err.message);
const shortTitle = (s: string) => s.length > 26 ? s.slice(0, 25) + '…' : s;
const seedKey = (p: GraphPaper) => p.openAlexId || p.doi || (p.arxivId ? `arXiv:${p.arxivId}` : p.s2Id || p.id);
const mkBtn = (cls: string, text: string, onClick: () => void): HTMLButtonElement => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; };

export function createCitationMapView(): ResearchViewModule {
  let mounted = false, restored = false, reqSeq = 0, ctrl: AbortController | null = null, shell: ResearchShellContext | undefined;
  let docs: DocumentInfo[] = [], trail: TrailStep[] = [], selectedId: string | null = null, lastDegraded: string[] = [];
  let mode: GraphViewMode = 'network', authorMode: AuthorLabelMode = 'first', graphCollapsed = false, mobilePane: 'list' | 'graph' = 'list', seedDocId = '', seedQuery = '';
  let svg: CitationMapSvg | undefined, splitEl: HTMLElement | undefined, crumbsEl: HTMLElement | undefined, degradedEl: HTMLElement | undefined;
  let statusEl: HTMLElement | undefined, listEl: HTMLElement | undefined, detailEl: HTMLElement | undefined, capEl: HTMLElement | undefined;
  let seedSelect: HTMLSelectElement | undefined, seedInput: HTMLInputElement | undefined, restoreGraphBtn: HTMLButtonElement | undefined;
  let mobileListBtn: HTMLButtonElement | undefined, mobileGraphBtn: HTMLButtonElement | undefined, syncToolbar: (() => void) | undefined;
  const rowEls = new Map<string, HTMLElement>(), rowActions = new Map<string, HTMLElement>(), savingIds = new Set<string>();

  const currentStep = () => trail.at(-1), currentNodes = () => currentStep()?.result.nodes ?? [];
  const abortPending = () => { ctrl?.abort(); ctrl = null; };
  const beginRequest = () => { abortPending(); ctrl = new AbortController(); return { seq: ++reqSeq, signal: ctrl.signal }; };
  const syncHover = (id: string | null) => { for (const [nid, row] of rowEls) row.classList.toggle('is-highlighted', nid === id); svg?.setHighlighted(id); };
  const syncLayoutFlags = () => {
    if (!splitEl) return;
    splitEl.dataset.graphCollapsed = String(graphCollapsed); splitEl.dataset.mobilePane = mobilePane; splitEl.dataset.detailOpen = String(Boolean(selectedId));
    if (restoreGraphBtn) { restoreGraphBtn.hidden = !graphCollapsed; restoreGraphBtn.setAttribute('aria-expanded', String(!graphCollapsed)); }
    mobileListBtn?.setAttribute('aria-pressed', String(mobilePane === 'list')); mobileGraphBtn?.setAttribute('aria-pressed', String(mobilePane === 'graph'));
  };
  const renderDegraded = (sources: string[]) => {
    lastDegraded = sources; if (!degradedEl) return; degradedEl.hidden = !sources.length;
    if (sources.length) degradedEl.textContent = t(`Partial data: ${[...new Set(sources)].map(s => SRC_NAME[s] ?? s).join(', ')} unavailable, using fallback sources.`, `数据源降级：${[...new Set(sources)].map(s => SRC_NAME[s] ?? s).join(', ')} 暂不可用，已切换备用源。`);
  };
  const renderActionSlot = (slot: HTMLElement, node: GraphNode, inDetail: boolean) => {
    slot.replaceChildren(); const busy = savingIds.has(node.id);
    if (node.inLibrary) {
      const openBtn = mkBtn('btn cm-open-btn', inDetail ? t('Open in Reader', '在精读中打开') : t('Open', '打开'), () => { if (node.docId) void shell?.inspectInReader({ docId: node.docId, page: 1 }).catch(e => toast(message(e))); });
      openBtn.disabled = busy || !node.docId; slot.append(el('span', 'cm-lib-badge', t('✓ In Library', '✓ 已在库')), openBtn); return;
    }
    const saveAbs = mkBtn('btn cm-save-abs', t('+ Save Abstract only', '+ 仅摘要入库'), () => { void savePaperInPlace(node, 'abstract'); });
    saveAbs.disabled = busy; slot.append(saveAbs);
    if (node.oaPdfUrl) { const savePdf = mkBtn('btn primary cm-save-pdf', t('+ Import OA PDF', '+ 拉取 OA PDF'), () => { void savePaperInPlace(node, 'oa-pdf'); }); savePdf.disabled = busy; slot.append(savePdf); }
  };
  const updatePaperStatusInPlace = (nodeId: string, inLibrary: boolean, docId?: string) => {
    for (const step of trail) {
      for (const n of step.result.nodes) if (n.id === nodeId) { n.inLibrary = inLibrary; n.docId = inLibrary ? docId : undefined; }
      for (const s of step.result.seeds) if (s.id === nodeId) { s.inLibrary = inLibrary; s.docId = inLibrary ? docId : undefined; }
    }
    svg?.updateNodeInLibrary(nodeId, docId, inLibrary);
    const activeNode = currentNodes().find(n => n.id === nodeId), slot = rowActions.get(nodeId);
    if (activeNode && slot) renderActionSlot(slot, activeNode, false);
    if (selectedId === nodeId && activeNode) { const foot = detailEl?.querySelector<HTMLElement>('.cm-detail-foot'); if (foot) renderActionSlot(foot, activeNode, true); }
  };
  const savePaperInPlace = async (node: GraphNode, saveMode: 'abstract' | 'oa-pdf') => {
    if (savingIds.has(node.id)) return;
    const prevInLib = Boolean(node.inLibrary), prevDocId = node.docId;
    savingIds.add(node.id); updatePaperStatusInPlace(node.id, true, prevDocId);
    try {
      const topic = shell?.activeTopic(), res = await api('graph.savePaper', { paper: node, mode: saveMode, ...(topic ? { topicTag: topic } : {}) });
      savingIds.delete(node.id); if (!mounted) return;
      updatePaperStatusInPlace(node.id, true, res.doc.id); shell?.notifyDocumentMutated(res.doc.id, false);
      toast(saveMode === 'oa-pdf' ? t('Imported OA PDF into library.', '已拉取 OA PDF 入库。') : t('Saved Abstract only into library.', '已仅摘要入库。'));
    } catch (err) { savingIds.delete(node.id); if (!mounted) return; updatePaperStatusInPlace(node.id, prevInLib, prevDocId); toast(message(err)); }
  };
  const renderDetail = () => {
    if (!detailEl) return;
    const node = selectedId ? currentNodes().find(n => n.id === selectedId) : undefined;
    if (!node) { selectedId = null; detailEl.hidden = true; detailEl.replaceChildren(); svg?.setSelected(null); syncLayoutFlags(); return; }
    detailEl.hidden = false; detailEl.replaceChildren(); svg?.setSelected(node.id); syncLayoutFlags();
    const head = el('div', 'cm-detail-head'), body = el('div', 'cm-detail-body'), foot = el('div', 'cm-detail-foot');
    head.append(mkBtn('btn cm-back-btn', '← ' + t('Back to list', '返回列表'), () => { selectedId = null; if (currentStep()) currentStep()!.selectedId = null; renderDetail(); }));
    const meta = [node.authors.slice(0, 6).join(', ') + (node.authors.length > 6 ? ' et al.' : ''), node.year ? String(node.year) : '', node.venue ?? '', node.citationCount !== undefined ? t(`${node.citationCount} citations`, `${node.citationCount} 次被引`) : ''].filter(Boolean).join(' · ');
    body.append(el('h2', 'cm-detail-title', node.title), el('p', 'cm-detail-meta', meta));
    const href = safeWeb(node.url || (node.doi ? `https://doi.org/${node.doi}` : undefined));
    if (href) { const link = el('a', 'external cm-detail-link', node.doi ? `DOI: ${node.doi} ↗` : t('Open source link ↗', '打开原文链接 ↗')); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link); }
    const dirRow = el('div', 'cm-detail-dirs');
    for (const dir of DIRS) { const b = mkBtn('btn', DIR_TEXT[dir], () => { void explorePaper(node, dir, false); }); b.dataset.dir = dir; dirRow.append(b); }
    body.append(dirRow, el('p', 'cm-detail-abstract', node.abstract || t('No abstract available.', '暂无摘要。')));
    renderActionSlot(foot, node, true); detailEl.append(head, body, foot);
  };
  const renderCrumbs = () => {
    if (!crumbsEl) return; crumbsEl.replaceChildren();
    if (!trail.length) { crumbsEl.append(el('span', 'cm-crumb-empty', t('Pick a library paper or enter a DOI / arXiv ID / title to map citations.', '选择本地文献或输入 DOI / arXiv ID / 标题以展开引文脉络。'))); return; }
    trail.forEach((step, idx) => {
      if (idx > 0) crumbsEl!.append(el('span', 'cm-crumb-sep', '›'));
      const b = mkBtn('cm-crumb', step.label, () => { if (idx === trail.length - 1) return; abortPending(); trail = trail.slice(0, idx + 1); selectedId = trail.at(-1)?.selectedId ?? null; renderStep(); });
      b.dataset.step = String(idx); if (idx === trail.length - 1) b.setAttribute('aria-current', 'step'); crumbsEl!.append(b);
    });
  };
  const renderStep = () => {
    const step = currentStep(); renderCrumbs(); rowEls.clear(); rowActions.clear();
    if (!listEl || !capEl || !statusEl) return; listEl.replaceChildren();
    if (!step) { capEl.textContent = t(`Cap ${CAP}`, `上限 ${CAP}`); svg?.render([], [], mode, authorMode, null); renderDegraded([]); renderDetail(); return; }
    const { nodes, edges, degraded } = step.result;
    capEl.textContent = t(`${nodes.length} / ${CAP}`, `${nodes.length} / ${CAP} 篇`);
    statusEl.textContent = nodes.length ? '' : t('No connected papers found for this direction.', '该方向暂未找到关联文献。');
    renderDegraded(degraded);
    for (const node of nodes) {
      const item = el('article', `cm-row${node.isSeed ? ' is-seed' : ''}`); item.dataset.nodeId = node.id;
      const titleBtn = mkBtn('cm-row-title', node.title, () => { selectedId = node.id; step.selectedId = node.id; renderDetail(); });
      const byline = [node.firstAuthor || node.authors[0] || '', node.year ? String(node.year) : '', node.venue ?? '', node.citationCount !== undefined ? t(`${node.citationCount} cit.`, `${node.citationCount} 引`) : ''].filter(Boolean).join(' · ');
      const act = el('div', 'cm-row-actions'); renderActionSlot(act, node, false);
      item.addEventListener('mouseenter', () => syncHover(node.id)); item.addEventListener('mouseleave', () => syncHover(null));
      item.addEventListener('focusin', () => syncHover(node.id));
      item.addEventListener('focusout', e => { if (!(e.relatedTarget instanceof Node) || !item.contains(e.relatedTarget)) syncHover(null); });
      item.append(titleBtn, el('p', 'cm-row-meta', byline), act); listEl.append(item); rowEls.set(node.id, item); rowActions.set(node.id, act);
    }
    svg?.render(nodes, edges, mode, authorMode, selectedId); renderDetail();
  };
  const explorePaper = async (paper: GraphPaper, direction: GraphDirection, resetTrail: boolean) => {
    const { seq, signal } = beginRequest();
    if (statusEl) statusEl.textContent = t(`Loading ${DIR_TEXT[direction]}…`, `正在加载 ${DIR_TEXT[direction]}…`);
    try {
      const seed = seedKey(paper), result = await api('graph.explore', { seeds: [seed], direction, limit: CAP }, false, signal);
      if (!mounted || seq !== reqSeq) return;
      const next: TrailStep = { label: `${shortTitle(paper.title)} · ${DIR_TEXT[direction]}`, direction, seedIds: [seed], result, selectedId: null };
      trail = resetTrail ? [next] : [...trail, next]; selectedId = null; renderStep();
    } catch (err) { if (mounted && seq === reqSeq && !isAbort(err)) { if (statusEl) statusEl.textContent = message(err); toast(message(err)); } }
  };
  const exploreSeed = async (direction: GraphDirection, explicitDocId?: string, explicitQuery?: string) => {
    const query = (explicitQuery ?? seedInput?.value ?? '').trim(), docId = explicitDocId ?? (query ? '' : (seedSelect?.value || shell?.activeDocId() || ''));
    if (!query && !docId) { toast(t('Pick a paper or enter a DOI / arXiv ID / title.', '请选择文献或输入 DOI / arXiv ID / 标题。')); return; }
    const { seq, signal } = beginRequest();
    if (statusEl) statusEl.textContent = t('Resolving seed paper…', '正在解析种子文献…');
    try {
      const resolved = await api('graph.resolve', query ? { query } : { docId }, false, signal);
      if (!mounted || seq !== reqSeq) return;
      if (resolved.degraded.length) renderDegraded(resolved.degraded);
      if (!resolved.paper) {
        const fallbackTitle = query || docs.find(d => d.id === docId)?.paperTitle || docs.find(d => d.id === docId)?.title || '';
        statusEl?.replaceChildren(el('span', '', t('No external graph record matched this local paper. ', '暂未匹配到该本地文献的外部图谱记录。')), mkBtn('text-btn', t('Match by title / DOI', '按标题 / DOI 匹配'), () => { if (seedInput) { seedInput.value = fallbackTitle; seedQuery = fallbackTitle; seedInput.focus(); seedInput.select(); } }));
        return;
      }
      await explorePaper(resolved.paper, direction, true);
    } catch (err) { if (mounted && seq === reqSeq && !isAbort(err)) { if (statusEl) statusEl.textContent = message(err); toast(message(err)); } }
  };

  return {
    id: 'citation-map',
    mount(host, ctx) {
      mounted = true; restored = false; shell = ctx;
      const startCtx = ctx.openContext(); seedDocId = startCtx?.seedDocId || ctx.activeDocId(); seedQuery = startCtx?.query || '';
      const view = el('section', 'cm-view'), bar = el('form', 'cm-bar'), dirGroup = el('div', 'cm-dir-group');
      view.setAttribute('aria-label', t('Citation Map', '引文脉络'));
      seedSelect = el('select', 'cm-seed-select'); seedSelect.ariaLabel = t('Library seed paper', '本地种子文献');
      seedSelect.addEventListener('change', () => { seedDocId = seedSelect!.value; });
      seedInput = el('input', 'search cm-seed-input'); seedInput.type = 'search'; seedInput.value = seedQuery;
      seedInput.ariaLabel = t('Seed DOI, arXiv ID, or title', '输入种子 DOI、arXiv ID 或标题');
      seedInput.placeholder = t('DOI, arXiv ID, or title…', '输入 DOI、arXiv ID 或标题…');
      seedInput.addEventListener('input', () => { seedQuery = seedInput!.value; });
      for (const dir of DIRS) { const b = mkBtn(`btn${dir === 'later' ? ' primary' : ''}`, DIR_TEXT[dir], () => { void exploreSeed(dir); }); b.dataset.dir = dir; dirGroup.append(b); }
      capEl = el('span', 'cm-cap', t(`Cap ${CAP}`, `上限 ${CAP}`));
      restoreGraphBtn = mkBtn('btn cm-show-graph', t('Show Graph', '显示图谱'), () => { graphCollapsed = false; syncLayoutFlags(); });
      bar.addEventListener('submit', e => { e.preventDefault(); void exploreSeed('later'); });
      bar.append(seedSelect, seedInput, dirGroup, capEl, restoreGraphBtn);
      crumbsEl = el('nav', 'cm-breadcrumbs'); crumbsEl.setAttribute('aria-label', t('Citation trail', '探索轨迹'));
      degradedEl = el('div', 'cm-degraded'); degradedEl.setAttribute('role', 'status'); degradedEl.hidden = true;
      const mobileTabs = el('div', 'cm-mobile-tabs');
      mobileListBtn = mkBtn('btn cm-mobile-tab', t('List', '列表'), () => { mobilePane = 'list'; syncLayoutFlags(); });
      mobileGraphBtn = mkBtn('btn cm-mobile-tab', t('Graph', '图谱'), () => { mobilePane = 'graph'; syncLayoutFlags(); });
      mobileTabs.append(mobileListBtn, mobileGraphBtn);
      splitEl = el('div', 'cm-split'); const left = el('div', 'cm-left'), graphPane = el('div', 'cm-graph-pane'), graphBar = el('div', 'cm-graph-bar');
      statusEl = el('div', 'cm-status'); statusEl.setAttribute('role', 'status'); listEl = el('div', 'cm-list'); left.append(statusEl, listEl);
      detailEl = el('aside', 'cm-detail'); detailEl.hidden = true; detailEl.setAttribute('aria-label', t('Paper details', '论文详情'));
      const netBtn = mkBtn('btn', t('Network', '关系图'), () => { if (mode !== 'network') { mode = 'network'; syncToolbar?.(); renderStep(); } });
      const timeBtn = mkBtn('btn', t('Timeline', '时间轴'), () => { if (mode !== 'timeline') { mode = 'timeline'; syncToolbar?.(); renderStep(); } });
      const firstBtn = mkBtn('btn', t('First Author', '第一作者'), () => { authorMode = 'first'; syncToolbar?.(); svg?.setAuthorMode('first'); });
      const lastBtn = mkBtn('btn', t('Last Author', '末位作者'), () => { authorMode = 'last'; syncToolbar?.(); svg?.setAuthorMode('last'); });
      const hideBtn = mkBtn('btn cm-hide-graph', t('Hide Graph', '隐藏图谱'), () => { graphCollapsed = true; syncLayoutFlags(); });
      hideBtn.setAttribute('aria-expanded', 'true');
      syncToolbar = () => {
        netBtn.setAttribute('aria-pressed', String(mode === 'network')); timeBtn.setAttribute('aria-pressed', String(mode === 'timeline'));
        firstBtn.setAttribute('aria-pressed', String(authorMode === 'first')); lastBtn.setAttribute('aria-pressed', String(authorMode === 'last'));
      };
      graphBar.append(netBtn, timeBtn, firstBtn, lastBtn, hideBtn);
      svg = new CitationMapSvg({
        onHover: id => { for (const [nid, row] of rowEls) row.classList.toggle('is-highlighted', nid === id); },
        onSelect: id => { selectedId = id; if (currentStep()) currentStep()!.selectedId = id; renderDetail(); }
      });
      graphPane.append(graphBar, svg.root); splitEl.append(left, detailEl, graphPane);
      const topWrap = el('div', 'cm-top'); topWrap.append(bar, crumbsEl, degradedEl, mobileTabs);
      view.append(topWrap, splitEl); host.append(view); syncToolbar(); syncLayoutFlags(); renderStep();
      void api('library.list', {}).then(({ docs: listed }) => {
        if (!mounted || !seedSelect) return; docs = listed;
        seedSelect.replaceChildren(...listed.map(d => new Option(shortTitle(d.paperTitle || d.title), d.id)));
        if (listed.some(d => d.id === seedDocId)) seedSelect.value = seedDocId;
      }).catch(() => undefined);
      if (startCtx?.seedDocId || startCtx?.query) {
        void Promise.resolve().then(() => Promise.resolve()).then(() => { if (mounted && !restored) void exploreSeed(isDir(startCtx.filter) ? startCtx.filter : 'later', startCtx.seedDocId, startCtx.query); });
      }
    },
    unmount() { mounted = false; abortPending(); rowEls.clear(); rowActions.clear(); savingIds.clear(); svg = undefined; },
    saveState: (): SavedState => ({ trail, selectedId, mode, authorMode, graphCollapsed, mobilePane, listScrollTop: listEl?.scrollTop ?? 0, seedDocId, seedQuery }),
    restoreState(raw) {
      if (!raw || typeof raw !== 'object') return;
      const s = raw as SavedState; restored = true; abortPending();
      trail = Array.isArray(s.trail) ? s.trail : []; selectedId = s.selectedId ?? null;
      mode = s.mode === 'timeline' ? 'timeline' : 'network'; authorMode = s.authorMode === 'last' ? 'last' : 'first';
      graphCollapsed = Boolean(s.graphCollapsed); mobilePane = s.mobilePane === 'graph' ? 'graph' : 'list';
      seedDocId = s.seedDocId ?? seedDocId; seedQuery = s.seedQuery ?? '';
      if (seedInput) seedInput.value = seedQuery; if (seedSelect && seedDocId) seedSelect.value = seedDocId;
      syncToolbar?.(); syncLayoutFlags(); renderStep();
      if (listEl) listEl.scrollTop = s.listScrollTop ?? 0; if (lastDegraded.length) renderDegraded(lastDegraded);
    },
    handleEscape() { if (!selectedId) return false; selectedId = null; if (currentStep()) currentStep()!.selectedId = null; renderDetail(); return true; },
    onDocumentMutated(docId) { for (const step of trail) for (const n of step.result.nodes) if (n.docId === docId) updatePaperStatusInPlace(n.id, Boolean(n.inLibrary), n.docId); }
  };
}
