import type { CitationCluster } from '../../shared/graph-clusters.js';
import type { ArxivFormat, DocumentInfo, GraphDirection, GraphExploreResult, GraphNode, GraphPaper } from '../../shared/types.js';
import { api, el, message, readerLabel as t, safeWeb, toast } from '../ui.js';
import { CitationMapSvg, type AuthorLabelMode, type GraphViewMode } from './citation-map-svg.js';
import { researchText, researchViewName } from './labels.js';
import { formatDegradedSources, isAbortError, mkBtn, renderPaperActions, saveGraphPaper } from './paper-intake.js';
import { PaperPicker } from './paper-picker.js';
import type { ResearchShellContext, ResearchViewModule } from './state.js';

interface TrailStep { label: string; direction: GraphDirection; seedIds: string[]; result: GraphExploreResult; selectedId: string | null }
interface SavedState {
  trail: TrailStep[]; selectedId: string | null; mode: GraphViewMode; authorMode: AuthorLabelMode;
  graphCollapsed: boolean; mobilePane: 'list' | 'graph'; listScrollTop: number; seedDocId: string; seedQuery: string;
}

const CAP = 40, DIRS: readonly GraphDirection[] = ['earlier', 'later', 'similar'];
const DIR_TEXT: Record<GraphDirection, string> = { earlier: 'Earlier', later: 'Later', similar: 'Similar' };
const isDir = (v?: string): v is GraphDirection => v === 'earlier' || v === 'later' || v === 'similar';
const shortTitle = (s: string) => s.length > 26 ? s.slice(0, 25) + '…' : s;
const seedKey = (p: GraphPaper) => p.openAlexId || p.doi || (p.arxivId ? `arXiv:${p.arxivId}` : p.s2Id || p.id);

export function createCitationMapView(): ResearchViewModule {
  let mounted = false, restored = false, reqSeq = 0, ctrl: AbortController | null = null, shell: ResearchShellContext | undefined;
  let docs: DocumentInfo[] = [], trail: TrailStep[] = [], selectedId: string | null = null, mobileSearchOpen = false, seedPickerOpen = false;
  let mode: GraphViewMode = 'network', authorMode: AuthorLabelMode = 'first', graphCollapsed = false, mobilePane: 'list' | 'graph' = 'list', seedDocId = '', seedQuery = '';
  let clusters: CitationCluster[] = [], clusterFilter: string | null = null;
  let svg: CitationMapSvg | undefined, topEl: HTMLElement | undefined, splitEl: HTMLElement | undefined, crumbsEl: HTMLElement | undefined, degradedEl: HTMLElement | undefined;
  let statusEl: HTMLElement | undefined, listEl: HTMLElement | undefined, detailEl: HTMLElement | undefined, detailBackdrop: HTMLElement | undefined, capEl: HTMLElement | undefined;
  let seedWrap: HTMLElement | undefined, seedPillTitle: HTMLElement | undefined, seedChangeBtn: HTMLButtonElement | undefined, seedPicker: PaperPicker | undefined, clusterBarEl: HTMLElement | undefined;
  let seedInput: HTMLInputElement | undefined, restoreGraphBtn: HTMLButtonElement | undefined;
  let mobileListBtn: HTMLButtonElement | undefined, mobileGraphBtn: HTMLButtonElement | undefined, mobileSearchBtn: HTMLButtonElement | undefined, dirBtns: HTMLButtonElement[] = [], syncToolbar: (() => void) | undefined;
  let outsideClickHandler: ((e: Event) => void) | undefined;
  const rowEls = new Map<string, HTMLElement>(), rowActions = new Map<string, HTMLElement>(), savingIds = new Set<string>();

  const currentStep = () => trail.at(-1), currentNodes = () => currentStep()?.result.nodes ?? [];
  const abortPending = () => { ++reqSeq; ctrl?.abort(); ctrl = null; };
  const beginRequest = () => { abortPending(); ctrl = new AbortController(); return { seq: reqSeq, signal: ctrl.signal }; };
  const syncHover = (id: string | null) => { for (const [nid, row] of rowEls) row.classList.toggle('is-highlighted', nid === id); svg?.setHighlighted(id); };
  const closeSeedPicker = (refocus = false) => {
    if (!seedPickerOpen) return;
    seedPickerOpen = false;
    seedPicker?.close();
    seedChangeBtn?.setAttribute('aria-expanded', 'false');
    if (refocus && seedChangeBtn?.isConnected) seedChangeBtn.focus({ preventScroll: true });
  };
  const syncSeedPill = () => {
    if (!seedPillTitle) return;
    const activeSeed = currentStep()?.result.seeds[0], doc = docs.find(x => x.id === seedDocId);
    const full = activeSeed?.title || doc?.paperTitle || doc?.title || seedQuery || t('Pick library paper', '选择本地文献');
    seedPillTitle.textContent = shortTitle(full); seedPillTitle.title = full;
    seedChangeBtn?.setAttribute('aria-expanded', String(seedPickerOpen));
  };
  const openSeedPicker = () => { seedPickerOpen = true; seedPicker?.open(); syncSeedPill(); };
  const applyClusterFilter = (nextId: string | null) => {
    clusterFilter = nextId;
    if (selectedId) closeDetail();
    svg?.setClusterFilter(nextId);
    const allowed = nextId ? new Set(clusters.find(c => c.id === nextId)?.nodeIds ?? []) : null;
    for (const [nid, row] of rowEls) row.hidden = Boolean(allowed && !allowed.has(nid));
    if (clusterBarEl) {
      for (const b of clusterBarEl.querySelectorAll<HTMLButtonElement>('.cm-cluster-chip')) {
        const cid = b.dataset.clusterId;
        b.setAttribute('aria-pressed', String(cid === 'all' ? !clusterFilter : cid === clusterFilter));
      }
    }
  };
  const renderClusterBar = () => {
    if (!clusterBarEl) return;
    clusterBarEl.replaceChildren();
    const show = mode === 'network' && clusters.length >= 2;
    clusterBarEl.hidden = !show;
    if (!show) return;
    const allChip = mkBtn('btn cm-cluster-chip', '', () => applyClusterFilter(null));
    allChip.dataset.clusterId = 'all'; allChip.setAttribute('aria-pressed', String(!clusterFilter));
    allChip.append(el('span', 'cm-cluster-name', researchText.all()), el('span', 'cm-cluster-count', String(currentNodes().length)));
    clusterBarEl.append(allChip);
    for (const c of clusters) {
      const chip = mkBtn('btn cm-cluster-chip', '', () => applyClusterFilter(clusterFilter === c.id ? null : c.id));
      chip.dataset.clusterId = c.id; chip.dataset.color = String(c.colorIndex);
      chip.setAttribute('aria-pressed', String(clusterFilter === c.id));
      const dot = el('i', 'cm-cluster-dot'); dot.dataset.color = String(c.colorIndex);
      chip.append(dot, el('span', 'cm-cluster-name', c.label), el('span', 'cm-cluster-count', String(c.count)));
      clusterBarEl.append(chip);
    }
  };
  const closeDetail = () => { selectedId = null; if (currentStep()) currentStep()!.selectedId = null; renderDetail(); };
  const reconcileMissing = (isMissing: (docId: string, id: string) => boolean) => {
    const ids = new Set<string>();
    for (const step of trail) for (const item of [...step.result.nodes, ...step.result.seeds]) if (item.docId && isMissing(item.docId, item.id)) ids.add(item.id);
    for (const id of ids) updatePaperStatusInPlace(id, false, undefined);
  };
  const syncLayoutFlags = () => {
    if (topEl) topEl.dataset.searchOpen = String(mobileSearchOpen);
    mobileSearchBtn?.setAttribute('aria-expanded', String(mobileSearchOpen));
    const curDir = currentStep()?.direction;
    for (const b of dirBtns) b.setAttribute('aria-pressed', String(b.dataset.dir === curDir));
    syncToolbar?.();
    if (!splitEl) return;
    splitEl.dataset.graphCollapsed = String(graphCollapsed); splitEl.dataset.mobilePane = mobilePane; splitEl.dataset.detailOpen = String(Boolean(selectedId));
    if (restoreGraphBtn) { restoreGraphBtn.hidden = !graphCollapsed; restoreGraphBtn.setAttribute('aria-expanded', String(!graphCollapsed)); }
    mobileListBtn?.setAttribute('aria-pressed', String(mobilePane === 'list')); mobileGraphBtn?.setAttribute('aria-pressed', String(mobilePane === 'graph'));
  };
  const renderDegraded = (sources: string[]) => {
    if (!degradedEl) return; degradedEl.hidden = !sources.length;
    if (sources.length) degradedEl.textContent = formatDegradedSources(sources);
  };
  const renderActionSlot = (slot: HTMLElement, node: GraphNode, inDetail: boolean) => renderPaperActions(slot, node, {
    prefix: 'cm', busy: savingIds.has(node.id), openLabel: inDetail ? t('Open in Reader', '在精读中打开') : researchText.open(),
    arxivFormat: shell?.arxivFormat?.(),
    onOpen: docId => { void shell?.inspectInReader({ docId, page: 1 }).catch(e => toast(message(e))); },
    onSave: arxivFormat => { void savePaperInPlace(node, arxivFormat); }
  });
  const updatePaperStatusInPlace = (nodeId: string, inLibrary: boolean, docId?: string) => {
    for (const step of trail) {
      for (const n of step.result.nodes) if (n.id === nodeId) { n.inLibrary = inLibrary; n.docId = inLibrary ? docId : undefined; }
      for (const s of step.result.seeds) if (s.id === nodeId) { s.inLibrary = inLibrary; s.docId = inLibrary ? docId : undefined; }
    }
    if (!mounted) return;
    svg?.updateNodeInLibrary(nodeId, docId, inLibrary);
    const activeNode = currentNodes().find(n => n.id === nodeId), slot = rowActions.get(nodeId);
    if (activeNode && slot) renderActionSlot(slot, activeNode, false);
    if (selectedId === nodeId && activeNode) { const foot = detailEl?.querySelector<HTMLElement>('.cm-detail-foot'); if (foot) renderActionSlot(foot, activeNode, true); }
  };
  const rememberDoc = (doc: DocumentInfo) => {
    docs = docs.some(d => d.id === doc.id) ? docs.map(d => d.id === doc.id ? doc : d) : [doc, ...docs];
    if (!seedDocId) seedDocId = doc.id;
    if (mounted) { syncSeedPill(); seedPicker?.refresh(); }
  };
  const refreshDocs = () => {
    void api('library.list', {}).then(({ docs: listed }) => {
      docs = listed; const liveIds = new Set(listed.map(d => d.id)); reconcileMissing((did, id) => !liveIds.has(did) && !savingIds.has(id));
      if (!mounted) return;
      if (!listed.some(d => d.id === seedDocId) && listed[0]) seedDocId = listed[0].id;
      syncSeedPill(); seedPicker?.refresh();
    }).catch(() => undefined);
  };
  const savePaperInPlace = async (node: GraphNode, arxivFormat?: ArxivFormat) => {
    if (savingIds.has(node.id)) return;
    const prevInLib = Boolean(node.inLibrary), prevDocId = node.docId;
    savingIds.add(node.id); updatePaperStatusInPlace(node.id, true, prevDocId);
    try {
      const doc = await saveGraphPaper(node, { mode: 'auto', arxivFormat }, shell);
      savingIds.delete(node.id); rememberDoc(doc); updatePaperStatusInPlace(node.id, true, doc.id);
    } catch (err) { savingIds.delete(node.id); updatePaperStatusInPlace(node.id, prevInLib, prevDocId); toast(message(err)); }
  };
  const renderDetail = () => {
    if (!detailEl) return;
    const node = selectedId ? currentNodes().find(n => n.id === selectedId) : undefined;
    if (detailBackdrop) detailBackdrop.hidden = !node;
    if (!node) { selectedId = null; detailEl.hidden = true; detailEl.replaceChildren(); svg?.setSelected(null); syncLayoutFlags(); return; }
    detailEl.hidden = false; detailEl.replaceChildren(); svg?.setSelected(node.id); syncLayoutFlags();
    const head = el('div', 'cm-detail-head'), body = el('div', 'cm-detail-body'), foot = el('div', 'cm-detail-foot');
    const backText = mobilePane === 'graph' && matchMedia('(max-width: 700px)').matches ? t('Back to graph', '返回图谱') : t('Back to list', '返回列表');
    head.append(mkBtn('btn cm-back-btn', '← ' + backText, closeDetail));
    const meta = [node.authors.slice(0, 6).join(', ') + (node.authors.length > 6 ? ' et al.' : ''), node.year ? String(node.year) : '', node.venue ?? '', node.citationCount !== undefined ? t(`${node.citationCount} citations`, `${node.citationCount} 次被引`) : ''].filter(Boolean).join(' · ');
    body.append(el('h2', 'cm-detail-title', node.title), el('p', 'cm-detail-meta', meta));
    const href = safeWeb(node.url) ?? (node.doi ? safeWeb('https://doi.org/' + encodeURIComponent(node.doi)) : undefined);
    if (href) { const link = el('a', 'external cm-detail-link', node.doi ? `DOI: ${node.doi} ↗` : t('Open source link ↗', '打开原文链接 ↗')); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link); }
    const dirRow = el('div', 'cm-detail-dirs');
    for (const dir of DIRS) { const b = mkBtn('btn', DIR_TEXT[dir], () => { void explorePaper(node, dir, false); }); b.dataset.dir = dir; dirRow.append(b); }
    dirRow.append(mkBtn('btn cm-to-cit', researchViewName('citations'), () => shell?.openView('citations', { docId: node.docId, doi: node.doi, arxivId: node.arxivId, query: node.title })));
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
    crumbsEl.scrollLeft = crumbsEl.scrollWidth;
  };
  const renderStep = () => {
    const step = currentStep(); renderCrumbs(); syncSeedPill(); rowEls.clear(); rowActions.clear(); clusterFilter = null;
    if (!listEl || !capEl || !statusEl) return; listEl.replaceChildren();
    if (!step) {
      capEl.textContent = t(`Cap ${CAP}`, `上限 ${CAP}`); clusters = svg?.render([], [], mode, authorMode, null) ?? [];
      renderClusterBar(); renderDegraded([]); renderDetail(); return;
    }
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
      shell?.paperFloatBar?.attach(item, { paper: node, onSaved: doc => { rememberDoc(doc); updatePaperStatusInPlace(node.id, true, doc.id); } });
    }
    clusters = svg?.render(nodes, edges, mode, authorMode, selectedId) ?? [];
    renderClusterBar(); renderDetail();
  };
  const explorePaper = async (paper: GraphPaper, direction: GraphDirection, resetTrail: boolean) => {
    const { seq, signal } = beginRequest();
    if (statusEl) statusEl.textContent = t(`Loading ${DIR_TEXT[direction]}…`, `正在加载 ${DIR_TEXT[direction]}…`);
    try {
      const seed = seedKey(paper), result = await api('graph.explore', { seeds: [seed], direction, limit: CAP }, false, signal);
      if (!mounted || seq !== reqSeq) return;
      const next: TrailStep = { label: `${shortTitle(paper.title)} · ${DIR_TEXT[direction]}`, direction, seedIds: [seed], result, selectedId: null };
      trail = resetTrail ? [next] : [...trail, next]; selectedId = null; renderStep();
    } catch (err) { if (mounted && seq === reqSeq && !isAbortError(err)) { if (statusEl) statusEl.textContent = message(err); toast(message(err)); } }
  };
  const exploreSeed = async (direction: GraphDirection, explicitDocId?: string, explicitQuery?: string) => {
    const query = (explicitQuery ?? seedInput?.value ?? '').trim(), docId = explicitDocId ?? (query ? '' : (seedDocId || shell?.activeDocId() || ''));
    if (!query && !docId) { toast(t('Pick a paper or enter a DOI / arXiv ID / title.', '请选择文献或输入 DOI / arXiv ID / 标题。')); return; }
    if (mobileSearchOpen) { mobileSearchOpen = false; syncLayoutFlags(); }
    const { seq, signal } = beginRequest();
    if (statusEl) statusEl.textContent = t('Resolving seed paper…', '正在解析种子文献…');
    try {
      const resolved = await api('graph.resolve', query ? { query } : { docId }, false, signal);
      if (!mounted || seq !== reqSeq) return;
      if (resolved.degraded.length) renderDegraded(resolved.degraded);
      if (!resolved.paper) {
        const fallbackTitle = query || docs.find(d => d.id === docId)?.paperTitle || docs.find(d => d.id === docId)?.title || '';
        statusEl?.replaceChildren(el('span', '', t('No external graph record matched this local paper. ', '暂未匹配到该本地文献的外部图谱记录。')), mkBtn('text-btn', t('Match by title / DOI', '按标题 / DOI 匹配'), () => { if (seedInput) { mobileSearchOpen = true; syncLayoutFlags(); seedInput.value = fallbackTitle; seedQuery = fallbackTitle; seedInput.focus(); seedInput.select(); } }));
        return;
      }
      await explorePaper(resolved.paper, direction, true);
    } catch (err) { if (mounted && seq === reqSeq && !isAbortError(err)) { if (statusEl) statusEl.textContent = message(err); toast(message(err)); } }
  };

  return {
    id: 'citation-map',
    mount(host, ctx) {
      mounted = true; restored = false; seedPickerOpen = false; shell = ctx;
      const startCtx = ctx.openContext(); seedDocId = startCtx?.seedDocId || ctx.activeDocId(); seedQuery = startCtx?.query || '';
      const view = el('section', 'cm-view'), bar = el('form', 'cm-bar'), dirGroup = el('div', 'cm-dir-group');
      view.setAttribute('aria-label', t('Citation Map', '引文脉络'));
      seedWrap = el('div', 'cm-seed-wrap');
      const pill = el('div', 'cm-seed-pill');
      seedPillTitle = el('span', 'cm-seed-title');
      seedChangeBtn = mkBtn('btn cm-seed-change', t('Change', '切换'), () => { if (seedPickerOpen) closeSeedPicker(false); else openSeedPicker(); });
      seedChangeBtn.ariaLabel = t('Change library seed paper', '切换本地种子文献');
      seedChangeBtn.setAttribute('aria-haspopup', 'dialog'); seedChangeBtn.setAttribute('aria-expanded', 'false');
      pill.append(seedPillTitle, seedChangeBtn);
      seedPicker = new PaperPicker({
        docs: () => docs, selectedDocId: () => seedDocId, currentReadingDocId: () => shell?.activeDocId() || '',
        ariaLabel: t('Choose library seed paper', '选择本地种子文献'),
        pickerClass: 'cm-seed-picker', searchClass: 'cm-seed-search', listClass: 'cm-seed-list', optionClass: 'cm-seed-opt',
        onSelectDoc: d => {
          seedDocId = d.id; seedQuery = ''; if (seedInput) seedInput.value = '';
          closeSeedPicker(false); syncSeedPill();
          void exploreSeed(currentStep()?.direction ?? 'later', d.id, '');
        },
        onClose: refocus => closeSeedPicker(refocus)
      });
      seedWrap.append(pill, seedPicker.root);
      outsideClickHandler = e => { if (seedPickerOpen && seedWrap && !(e.target instanceof Node && seedWrap.contains(e.target))) closeSeedPicker(false); };
      document.addEventListener('pointerdown', outsideClickHandler);
      seedInput = el('input', 'search cm-seed-input'); seedInput.type = 'search'; seedInput.value = seedQuery;
      seedInput.ariaLabel = t('Seed DOI, arXiv ID, or title', '输入种子 DOI、arXiv ID 或标题'); seedInput.placeholder = t('DOI, arXiv ID, or title…', '输入 DOI、arXiv ID 或标题…');
      seedInput.addEventListener('input', () => { seedQuery = seedInput!.value; });
      dirBtns = DIRS.map(dir => { const b = mkBtn('btn', DIR_TEXT[dir], () => { void exploreSeed(dir); }); b.dataset.dir = dir; dirGroup.append(b); return b; });
      capEl = el('span', 'cm-cap', t(`Cap ${CAP}`, `上限 ${CAP}`));
      restoreGraphBtn = mkBtn('btn cm-show-graph', t('Show Graph', '显示图谱'), () => { graphCollapsed = false; syncLayoutFlags(); });
      bar.addEventListener('submit', e => { e.preventDefault(); void exploreSeed('later'); }); bar.append(seedWrap, seedInput, dirGroup, capEl, restoreGraphBtn);
      crumbsEl = el('nav', 'cm-breadcrumbs'); crumbsEl.setAttribute('aria-label', t('Citation trail', '探索轨迹'));
      degradedEl = el('div', 'cm-degraded'); degradedEl.setAttribute('role', 'status'); degradedEl.hidden = true;
      const mobileTabs = el('div', 'cm-mobile-tabs');
      mobileListBtn = mkBtn('btn cm-mobile-tab', t('List', '列表'), () => { mobilePane = 'list'; syncLayoutFlags(); });
      mobileGraphBtn = mkBtn('btn cm-mobile-tab', t('Graph', '图谱'), () => { mobilePane = 'graph'; syncLayoutFlags(); });
      mobileSearchBtn = mkBtn('btn cm-mobile-search', t('Seeds', '种子'), () => { mobileSearchOpen = !mobileSearchOpen; syncLayoutFlags(); if (mobileSearchOpen) seedInput?.focus(); });
      mobileSearchBtn.ariaLabel = t('Search or change seed paper', '检索或切换种子文献'); mobileTabs.append(mobileListBtn, mobileGraphBtn, mobileSearchBtn);
      splitEl = el('div', 'cm-split'); const left = el('div', 'cm-left'), graphPane = el('div', 'cm-graph-pane'), graphBar = el('div', 'cm-graph-bar');
      statusEl = el('div', 'cm-status'); statusEl.setAttribute('role', 'status'); listEl = el('div', 'cm-list'); left.append(statusEl, listEl);
      detailBackdrop = el('div', 'cm-detail-backdrop'); detailBackdrop.hidden = true; detailBackdrop.addEventListener('click', closeDetail);
      detailEl = el('aside', 'cm-detail'); detailEl.hidden = true; detailEl.setAttribute('aria-label', t('Paper details', '论文详情'));
      const netBtn = mkBtn('btn', t('Network', '关系图'), () => { if (mode !== 'network') { mode = 'network'; renderStep(); } });
      const timeBtn = mkBtn('btn', t('Timeline', '时间轴'), () => { if (mode !== 'timeline') { mode = 'timeline'; renderStep(); } });
      const firstBtn = mkBtn('btn', t('First Author', '第一作者'), () => { authorMode = 'first'; syncLayoutFlags(); svg?.setAuthorMode('first'); });
      const lastBtn = mkBtn('btn', t('Last Author', '末位作者'), () => { authorMode = 'last'; syncLayoutFlags(); svg?.setAuthorMode('last'); });
      const hideBtn = mkBtn('btn cm-hide-graph', t('Hide Graph', '隐藏图谱'), () => { graphCollapsed = true; syncLayoutFlags(); }); hideBtn.setAttribute('aria-expanded', 'true');
      const zoomGroup = el('div', 'cm-zoom-group');
      const zOut = mkBtn('btn cm-zoom-btn', '−', () => svg?.zoomOut()); zOut.ariaLabel = researchText.zoomOut(); zOut.title = researchText.zoomOut(); zOut.dataset.zoomAct = 'out';
      const zFit = mkBtn('btn cm-zoom-btn cm-zoom-fit', researchText.fitGraph(), () => svg?.fitView()); zFit.ariaLabel = researchText.fitGraphLabel(); zFit.dataset.zoomAct = 'fit';
      const zIn = mkBtn('btn cm-zoom-btn', '+', () => svg?.zoomIn()); zIn.ariaLabel = researchText.zoomIn(); zIn.title = researchText.zoomIn(); zIn.dataset.zoomAct = 'in';
      zoomGroup.append(zOut, zFit, zIn);
      clusterBarEl = el('div', 'cm-cluster-bar'); clusterBarEl.setAttribute('role', 'group');
      clusterBarEl.setAttribute('aria-label', researchText.clustersLabel()); clusterBarEl.hidden = true;
      syncToolbar = () => {
        netBtn.setAttribute('aria-pressed', String(mode === 'network')); timeBtn.setAttribute('aria-pressed', String(mode === 'timeline'));
        firstBtn.setAttribute('aria-pressed', String(authorMode === 'first')); lastBtn.setAttribute('aria-pressed', String(authorMode === 'last'));
      };
      graphBar.append(netBtn, timeBtn, firstBtn, lastBtn, zoomGroup, hideBtn);
      svg = new CitationMapSvg({ onHover: id => { for (const [nid, row] of rowEls) row.classList.toggle('is-highlighted', nid === id); }, onSelect: id => { selectedId = id; if (currentStep()) currentStep()!.selectedId = id; renderDetail(); } });
      graphPane.append(graphBar, clusterBarEl, svg.root); splitEl.append(left, detailBackdrop, detailEl, graphPane);
      topEl = el('div', 'cm-top'); topEl.append(bar, crumbsEl, degradedEl, mobileTabs); view.append(topEl, splitEl); host.append(view); renderStep();
      refreshDocs();
      const explicitSeed = Boolean(startCtx?.seedDocId || startCtx?.query);
      if (explicitSeed || seedDocId) void Promise.resolve().then(() => Promise.resolve()).then(() => {
        if (mounted && !restored && (explicitSeed || !trail.length)) {
          void exploreSeed(isDir(startCtx?.filter) ? startCtx.filter : 'later', startCtx?.seedDocId || (!startCtx?.query ? seedDocId : undefined), startCtx?.query);
        }
      });
    },
    unmount() {
      mounted = false; seedPickerOpen = false; abortPending(); rowEls.clear(); rowActions.clear(); svg = undefined; seedPicker?.dispose(); seedPicker = undefined;
      if (outsideClickHandler) { document.removeEventListener('pointerdown', outsideClickHandler); outsideClickHandler = undefined; }
    },
    saveState: (): SavedState => ({ trail, selectedId, mode, authorMode, graphCollapsed, mobilePane, listScrollTop: listEl?.scrollTop ?? 0, seedDocId, seedQuery }),
    restoreState(raw) {
      if (!raw || typeof raw !== 'object') return;
      const s = raw as SavedState; restored = true; abortPending();
      trail = Array.isArray(s.trail) ? s.trail : []; selectedId = s.selectedId ?? null;
      mode = s.mode === 'timeline' ? 'timeline' : 'network'; authorMode = s.authorMode === 'last' ? 'last' : 'first';
      graphCollapsed = Boolean(s.graphCollapsed); mobilePane = s.mobilePane === 'graph' ? 'graph' : 'list';
      seedDocId = s.seedDocId ?? seedDocId; seedQuery = s.seedQuery ?? '';
      if (seedInput) seedInput.value = seedQuery; syncSeedPill();
      renderStep(); if (listEl) listEl.scrollTop = s.listScrollTop ?? 0;
    },
    handleEscape() { if (seedPickerOpen) { closeSeedPicker(true); return true; } if (!selectedId) return false; closeDetail(); return true; },
    onDocumentMutated(docId, deleted) {
      if (!deleted) { refreshDocs(); return; }
      docs = docs.filter(d => d.id !== docId); if (seedDocId === docId) seedDocId = docs[0]?.id ?? '';
      syncSeedPill(); seedPicker?.refresh();
      reconcileMissing(did => did === docId);
    }
  };
}
