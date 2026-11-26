import type { CitationAnalyzeInput, CitationDirection, CitationReport, CitationStance, CitationStatement } from '../../shared/citation-stance-types.js';
import type { DocumentInfo, GraphPaper, GraphSource } from '../../shared/types.js';
import { api, el, message, readerLabel as t, safeWeb, toast } from '../ui.js';
import { researchText, researchViewName } from './labels.js';
import { formatDegradedSources, isAbortError, mkBtn, renderPaperActions, saveGraphPaper } from './paper-intake.js';
import { STANCE_ITEMS, stanceBadge, stanceText } from './reference-citations.js';
import type { ResearchShellContext, ResearchViewModule } from './state.js';

type SourceFilter = 'all' | 'local' | 'external';
type YearFilter = 'all' | '2y' | '5y';
type SortMode = 'local' | 'newest' | 'influential' | 'contrasting';
interface CitTarget { docId: string; doi: string; arxivId: string; query: string }
interface CitFilters { section: string; source: SourceFilter; excludeSelf: boolean; yearRange: YearFilter; search: string; sort: SortMode }
interface SavedCitationsState {
  report: CitationReport | null; otherCount: number | null; direction: CitationDirection;
  target: CitTarget; filters: CitFilters; stances: CitationStance[]; expanded: string[]; listScrollTop: number;
}

const SECTIONS = ['Introduction', 'Methods', 'Results', 'Discussion', 'Unknown'] as const, SNIPPET_CAP = 220;
const STANCE_PRIO: Record<CitationStance, number> = { contrasting: 0, extending: 1, supporting: 2, mentioning: 3, unclassified: 4 };
const SOURCE_LABEL: Record<CitationStatement['source'], () => string> = { local: () => t('★ Local', '★ 本地反引'), s2: () => 'Semantic Scholar', europepmc: () => 'Europe PMC', openalex: () => 'OpenAlex' };
const isStance = (v?: string): v is CitationStance => STANCE_ITEMS.some(x => x.key === v);
const shortLabel = (s: string) => s.length > 44 ? s.slice(0, 43) + '…' : s;
const normTitle = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const formatAuthors = (a: readonly string[]) => a.length > 4 ? `${a.slice(0, 4).join(', ')} et al.` : a.join(', ');
const emptyTallies = () => ({ citingPapers: 0, citationStatements: 0, supporting: 0, extending: 0, contrasting: 0, mentioning: 0, unclassified: 0, localBackCitations: 0 });
const defaultFilters = (): CitFilters => ({ section: '', source: 'all', excludeSelf: false, yearRange: 'all', search: '', sort: 'local' });
const mkSelect = (cls: string, opts: readonly (readonly [string, string])[], onChange: (v: string) => void): HTMLSelectElement => { const s = el('select', cls); for (const [v, txt] of opts) s.append(new Option(txt, v)); s.addEventListener('change', () => onChange(s.value)); return s; };

export function createCitationsView(): ResearchViewModule {
  let mounted = false, restored = false, reqSeq = 0, ctrl: AbortController | null = null, shell: ResearchShellContext | undefined;
  let docs: DocumentInfo[] = [], report: CitationReport | null = null, otherCount: number | null = null;
  let direction: CitationDirection = 'cited_by', mobileFiltersOpen = false;
  let target: CitTarget = { docId: '', doi: '', arxivId: '', query: '' }, filters: CitFilters = defaultFilters();
  const stanceFilter = new Set<CitationStance>(), expandedKeys = new Set<string>(), savedMap = new Map<string, string>(), savingKeys = new Set<string>();
  const tallyBtns = new Map<CitationStance, { btn: HTMLButtonElement; count: HTMLElement }>(), facetChecks = new Map<CitationStance, { input: HTMLInputElement; count: HTMLElement }>();
  let viewEl: HTMLElement | undefined, titleEl: HTMLElement | undefined, bylineEl: HTMLElement | undefined, docSelect: HTMLSelectElement | undefined;
  let refreshBtn: HTMLButtonElement | undefined, sciteLink: HTMLAnchorElement | undefined, mobileFiltersBtn: HTMLButtonElement | undefined;
  let papersUnitEl: HTMLElement | undefined, stmtsUnitEl: HTMLElement | undefined, citedByBtn: HTMLButtonElement | undefined, refsBtn: HTMLButtonElement | undefined;
  let bannerEl: HTMLElement | undefined, distBarEl: HTMLElement | undefined, facetsBackdrop: HTMLElement | undefined;
  let sectionSelect: HTMLSelectElement | undefined, sourceSelect: HTMLSelectElement | undefined, selfCheck: HTMLInputElement | undefined, yearSelect: HTMLSelectElement | undefined;
  let clearBtn: HTMLButtonElement | undefined, searchInput: HTMLInputElement | undefined, sortSelect: HTMLSelectElement | undefined;
  let matchCountEl: HTMLElement | undefined, statusEl: HTMLElement | undefined, listEl: HTMLElement | undefined;

  const abortPending = () => { ++reqSeq; ctrl?.abort(); ctrl = null; };
  const beginRequest = () => { abortPending(); ctrl = new AbortController(); return { seq: reqSeq, signal: ctrl.signal }; };
  const activeFacetCount = () => stanceFilter.size + (filters.section ? 1 : 0) + (filters.source !== 'all' ? 1 : 0) + (filters.excludeSelf ? 1 : 0) + (filters.yearRange !== 'all' ? 1 : 0);
  const hasFilters = () => activeFacetCount() > 0 || Boolean(filters.search.trim());
  const matchLocalDoc = (s: CitationStatement): string | undefined => {
    if (s.citingDocId && docs.some(d => d.id === s.citingDocId)) return s.citingDocId;
    const saved = savedMap.get(s.citingKey); if (saved && docs.some(d => d.id === saved)) return saved;
    const doi = s.citingDoi?.toLowerCase(), ax = s.citingArxiv?.toLowerCase(), nt = normTitle(s.citingTitle);
    return docs.find(d => (doi && d.doi?.toLowerCase().includes(doi)) || (ax && (d.url?.toLowerCase().includes(ax) || d.doi?.toLowerCase().includes(ax))) || (nt.length >= 16 && normTitle(d.paperTitle || d.title) === nt))?.id;
  };
  const toGraphPaper = (s: CitationStatement): GraphPaper => {
    const localId = matchLocalDoc(s), src: GraphSource = s.source === 's2' ? 's2' : s.source === 'europepmc' ? 'europepmc' : 'openalex';
    return {
      id: s.citingKey, title: s.citingTitle, authors: s.citingAuthors, firstAuthor: s.citingAuthors[0] ?? '', lastAuthor: s.citingAuthors.at(-1) ?? '',
      ...(s.citingYear ? { year: s.citingYear } : {}), ...(s.citingDoi ? { doi: s.citingDoi } : {}), ...(s.citingArxiv ? { arxivId: s.citingArxiv } : {}),
      ...(s.citingUrl ? { url: s.citingUrl } : {}), ...(s.citingArxiv ? { oaPdfUrl: `https://arxiv.org/pdf/${s.citingArxiv}.pdf` } : {}),
      source: src, inLibrary: Boolean(localId), ...(localId ? { docId: localId } : {})
    };
  };
  const matchesFilters = (s: CitationStatement): boolean => {
    if ((stanceFilter.size > 0 && !stanceFilter.has(s.stance)) || (filters.section && s.section !== filters.section)) return false;
    if ((filters.source === 'local' && s.source !== 'local') || (filters.source === 'external' && s.source === 'local') || (filters.excludeSelf && s.isSelfCitation)) return false;
    const nowY = new Date().getFullYear();
    if ((filters.yearRange === '2y' && (!s.citingYear || s.citingYear < nowY - 1)) || (filters.yearRange === '5y' && (!s.citingYear || s.citingYear < nowY - 4))) return false;
    const q = filters.search.trim().toLowerCase();
    return !q || `${s.citingTitle} ${s.citingAuthors.join(' ')} ${s.context} ${s.rationale}`.toLowerCase().includes(q);
  };
  const sortStatements = (items: CitationStatement[]): CitationStatement[] => [...items].sort((a, b) => {
    const loc = (a.source === 'local' ? 0 : 1) - (b.source === 'local' ? 0 : 1), yr = (b.citingYear ?? 0) - (a.citingYear ?? 0);
    if (filters.sort === 'newest') return yr || loc;
    if (filters.sort === 'influential') return (b.isInfluential ? 1 : 0) - (a.isInfluential ? 1 : 0) || yr;
    if (filters.sort === 'contrasting') return STANCE_PRIO[a.stance] - STANCE_PRIO[b.stance] || yr;
    return loc || yr;
  });

  const syncMobileFilters = () => {
    if (viewEl) viewEl.dataset.filtersOpen = String(mobileFiltersOpen);
    if (facetsBackdrop) facetsBackdrop.hidden = !mobileFiltersOpen;
    if (!mobileFiltersBtn) return;
    const n = activeFacetCount(); mobileFiltersBtn.textContent = n > 0 ? t(`Filters (${n})`, `筛选 (${n})`) : t('Filters', '筛选');
    mobileFiltersBtn.setAttribute('aria-expanded', String(mobileFiltersOpen));
  };
  const syncFilterControls = () => {
    for (const item of STANCE_ITEMS) { const on = stanceFilter.has(item.key); tallyBtns.get(item.key)?.btn.setAttribute('aria-pressed', String(on)); const fc = facetChecks.get(item.key); if (fc) fc.input.checked = on; }
    if (sectionSelect) sectionSelect.value = filters.section; if (sourceSelect) sourceSelect.value = filters.source;
    if (selfCheck) selfCheck.checked = filters.excludeSelf; if (yearSelect) yearSelect.value = filters.yearRange;
    if (clearBtn) clearBtn.hidden = !hasFilters(); syncMobileFilters();
  };
  const syncHeader = () => {
    const tgt = report?.target, doc = target.docId ? docs.find(d => d.id === target.docId) : undefined;
    if (titleEl) titleEl.textContent = tgt?.title || doc?.paperTitle || doc?.title || target.query || target.doi || (target.arxivId ? `arXiv:${target.arxivId}` : '') || researchViewName('citations');
    const meta = [tgt?.authors.length ? formatAuthors(tgt.authors) : (doc?.authors ?? ''), tgt?.year ? String(tgt.year) : (doc?.year ?? ''), tgt?.doi ? `DOI: ${tgt.doi}` : (tgt?.arxivId ? `arXiv:${tgt.arxivId}` : '')].filter(Boolean).join(' · ');
    if (bylineEl) { bylineEl.textContent = meta; bylineEl.hidden = !meta; }
    if (sciteLink) { const href = safeWeb(report?.sciteUrl); sciteLink.hidden = !href; if (href) sciteLink.href = href; }
    if (!bannerEl) return;
    if (report?.offline) { bannerEl.hidden = false; bannerEl.dataset.kind = 'offline'; bannerEl.textContent = t('Offline mode — showing local library back-citations only. External sources are unavailable.', '离线模式 — 当前展示本地文献库反向引用，外部引文数据源暂不可用。'); return; }
    const msg = report?.degraded.length ? [formatDegradedSources(report.degraded.filter(d => d !== 'llm')), report.degraded.includes('llm') ? t('AI stance classification unavailable; showing existing stances and raw contexts.', '立场分类服务暂不可用，当前保留已有分类与原文语境。') : ''].filter(Boolean).join(' ') : '';
    bannerEl.hidden = !msg; bannerEl.dataset.kind = msg ? 'degraded' : ''; bannerEl.textContent = msg;
  };
  const syncTallies = () => {
    const tl = report?.tallies ?? emptyTallies();
    if (papersUnitEl) papersUnitEl.textContent = direction === 'references' ? t(`Referenced Papers (${tl.citingPapers})`, `引文文献 (${tl.citingPapers})`) : t(`Citing Papers (${tl.citingPapers})`, `施引论文 (${tl.citingPapers})`);
    if (stmtsUnitEl) stmtsUnitEl.textContent = t(`Citation Statements (${tl.citationStatements})`, `引文语句 (${tl.citationStatements})`);
    const citedN = direction === 'cited_by' ? (report ? tl.citationStatements : null) : otherCount, refN = direction === 'references' ? (report ? tl.citationStatements : null) : otherCount;
    if (citedByBtn) { citedByBtn.textContent = citedN !== null ? t(`Cited by (${citedN})`, `被引 (${citedN})`) : t('Cited by', '被引'); citedByBtn.setAttribute('aria-pressed', String(direction === 'cited_by')); }
    if (refsBtn) { refsBtn.textContent = refN !== null ? t(`References (${refN})`, `参考文献 (${refN})`) : t('References', '参考文献'); refsBtn.setAttribute('aria-pressed', String(direction === 'references')); }
    for (const item of STANCE_ITEMS) { const n = String(tl[item.key]); const tb = tallyBtns.get(item.key), fc = facetChecks.get(item.key); if (tb) tb.count.textContent = n; if (fc) fc.count.textContent = n; }
    if (!distBarEl) return;
    distBarEl.replaceChildren();
    distBarEl.setAttribute('aria-label', t(`Stance distribution: ${STANCE_ITEMS.map(i => `${i.en} ${tl[i.key]}`).join(', ')}`, `引用立场分布：${STANCE_ITEMS.map(i => `${i.zh} ${tl[i.key]}`).join('，')}`));
    for (const item of STANCE_ITEMS) {
      const n = tl[item.key]; if (!n || !tl.citationStatements) continue;
      const seg = el('span', 'cit-dist-seg'); seg.dataset.stance = item.key; seg.style.flex = `${n} 0 0`;
      seg.title = `${stanceText(item.key)}: ${n} (${Math.round(n / tl.citationStatements * 100)}%)`; distBarEl.append(seg);
    }
  };
  const renderExternalActions = (slot: HTMLElement, stmt: CitationStatement) => {
    const paper = toGraphPaper(stmt);
    renderPaperActions(slot, paper, {
      prefix: 'cit', busy: savingKeys.has(stmt.citingKey), openLabel: researchText.open(),
      onOpen: docId => { void shell?.inspectInReader({ docId, page: 1 }).catch(e => toast(message(e))); },
      onSave: saveMode => {
        if (savingKeys.has(stmt.citingKey)) return;
        savingKeys.add(stmt.citingKey); renderExternalActions(slot, stmt);
        void saveGraphPaper(paper, saveMode, shell).then(doc => {
          savingKeys.delete(stmt.citingKey); savedMap.set(stmt.citingKey, doc.id);
          if (!docs.some(d => d.id === doc.id)) docs = [doc, ...docs];
          if (mounted) renderExternalActions(slot, stmt);
        }).catch(err => { savingKeys.delete(stmt.citingKey); if (mounted) renderExternalActions(slot, stmt); toast(message(err)); });
      }
    });
  };
  const buildCard = (stmt: CitationStatement): HTMLElement => {
    const card = el('article', 'cit-card'); card.dataset.citingKey = stmt.citingKey; card.dataset.stance = stmt.stance; card.dataset.source = stmt.source;
    const head = el('div', 'cit-card-head'), meta = el('div', 'cit-card-meta'), by = [formatAuthors(stmt.citingAuthors), stmt.citingYear ? String(stmt.citingYear) : ''].filter(Boolean).join(' · ');
    if (by) meta.append(el('span', 'cit-meta-text', by));
    meta.append(el('span', `cit-pill${stmt.source === 'local' ? ' is-local' : ''}`, SOURCE_LABEL[stmt.source]()));
    if (stmt.section !== 'Unknown') meta.append(el('span', 'cit-pill is-sec', stmt.section));
    if (stmt.isSelfCitation) meta.append(el('span', 'cit-pill is-self', t('Self-citation', '自引')));
    if (stmt.isInfluential) meta.append(el('span', 'cit-pill is-infl', t('Influential', '高影响')));
    head.append(el('h3', 'cit-card-title', stmt.citingTitle), meta);
    const stanceRow = el('div', 'cit-card-stance'), badge = el('span', 'cit-stance-badge', stanceBadge(stmt.stance)); badge.dataset.stance = stmt.stance;
    const manualTag = el('span', 'cit-manual-tag', t('✎ Manual', '✎ 已人工确认')), rationale = el('span', 'cit-rationale', stmt.rationale);
    manualTag.hidden = !stmt.manualOverride; rationale.hidden = !stmt.rationale; stanceRow.append(badge, manualTag, rationale);
    const ctxBox = el('div', 'cit-card-ctx'), cleanCtx = stmt.context.trim();
    if (!cleanCtx) ctxBox.append(el('p', 'cit-no-ctx', t('No context available — upstream source did not provide a citing snippet.', '暂无原文语境 — 上游数据源未提供引用原句。')));
    else {
      const long = cleanCtx.length > SNIPPET_CAP, isExp = expandedKeys.has(stmt.citingKey), clip = () => cleanCtx.slice(0, SNIPPET_CAP).trimEnd() + '…';
      const ctxP = el('p', 'cit-ctx-text', long && !isExp ? clip() : cleanCtx); ctxBox.append(ctxP);
      if (long) {
        const expBtn = mkBtn('text-btn cit-expand-btn', isExp ? t('Show less', '收起上下文') : t('Show more context', '展开更多上下文'), () => {
          const next = !expandedKeys.has(stmt.citingKey); if (next) expandedKeys.add(stmt.citingKey); else expandedKeys.delete(stmt.citingKey);
          ctxP.textContent = next ? cleanCtx : clip(); expBtn.textContent = next ? t('Show less', '收起上下文') : t('Show more context', '展开更多上下文'); expBtn.setAttribute('aria-expanded', String(next));
        });
        expBtn.setAttribute('aria-expanded', String(isExp)); ctxBox.append(expBtn);
      }
    }
    const actions = el('div', 'cit-card-actions'), jumpDocId = stmt.source === 'local' ? (stmt.direction === 'references' ? (stmt.docId || report?.target.docId) : stmt.citingDocId) : undefined;
    if (jumpDocId && stmt.citingPage) actions.append(mkBtn('btn primary cit-jump-btn', t(`Jump to p. ${stmt.citingPage} ↗`, `跳转至第 ${stmt.citingPage} 页 ↗`), () => { void shell?.inspectInReader({ docId: jumpDocId, page: stmt.citingPage!, quote: cleanCtx.slice(0, 120) }).catch(err => toast(message(err))); }));
    const reclass = mkSelect('cit-reclass-select', STANCE_ITEMS.map(i => [i.key, `${i.icon} ${t(i.en, i.zh)}`] as const), async nextVal => {
      const prev = stmt.stance, next = nextVal as CitationStance; if (next === prev) return;
      reclass.disabled = true;
      try {
        const res = await api('citations.reclassify', { targetKey: stmt.targetKey, direction: stmt.direction, citingKey: stmt.citingKey, stance: next });
        if (!mounted || !report) return;
        const idx = report.statements.findIndex(x => x.citingKey === stmt.citingKey); if (idx >= 0) report.statements[idx] = res.statement;
        stmt = res.statement; report.tallies = res.tallies; syncTallies();
        if (!matchesFilters(stmt)) { const scroll = listEl?.scrollTop ?? 0; renderList(); if (listEl) listEl.scrollTop = scroll; }
        else { card.dataset.stance = badge.dataset.stance = stmt.stance; badge.textContent = stanceBadge(stmt.stance); manualTag.hidden = !stmt.manualOverride; rationale.textContent = stmt.rationale; rationale.hidden = !stmt.rationale; }
      } catch (err) { reclass.value = prev; toast(message(err)); }
      finally { reclass.disabled = false; if (mounted && reclass.isConnected) reclass.focus({ preventScroll: true }); }
    });
    reclass.ariaLabel = t('Reclassify citation stance', '重新分类引用立场'); reclass.dataset.citingKey = stmt.citingKey; reclass.value = stmt.stance;
    actions.append(reclass);
    if (stmt.source !== 'local') { const slot = el('span', 'cit-save-slot'); renderExternalActions(slot, stmt); actions.append(slot); }
    else if (stmt.citingUrl && safeWeb(stmt.citingUrl)) { const ext = el('a', 'external cit-ext-link', t('Source ↗', '来源 ↗')); ext.href = safeWeb(stmt.citingUrl)!; ext.target = '_blank'; ext.rel = 'noopener noreferrer'; actions.append(ext); }
    card.append(head, stanceRow, ctxBox, actions);
    return card;
  };
  const renderList = () => {
    if (!listEl || !matchCountEl) return;
    listEl.replaceChildren();
    if (!report) { matchCountEl.textContent = ''; return; }
    const filtered = sortStatements(report.statements.filter(matchesFilters));
    matchCountEl.textContent = t(`Showing ${filtered.length} / ${report.statements.length}`, `显示 ${filtered.length} / ${report.statements.length} 条`);
    if (!filtered.length) { listEl.append(el('p', 'cit-empty', report.statements.length ? t('No citation statements match the active filters.', '没有符合当前筛选条件的引用语句。') : t('No citations found for this paper yet.', '暂未找到该文献的引用记录。'))); return; }
    for (const s of filtered) listEl.append(buildCard(s));
  };
  const renderAll = () => { syncHeader(); syncTallies(); syncFilterControls(); renderList(); };
  const resetFilters = () => { stanceFilter.clear(); filters = { ...defaultFilters(), sort: filters.sort }; if (searchInput) searchInput.value = ''; syncFilterControls(); renderList(); };
  const toggleStance = (s: CitationStance) => { if (stanceFilter.has(s)) stanceFilter.delete(s); else stanceFilter.add(s); syncFilterControls(); renderList(); };
  const syncDocOptions = () => {
    if (!docSelect) return;
    docSelect.replaceChildren(...docs.map(d => { const full = d.paperTitle || d.title, o = new Option(shortLabel(full), d.id); o.title = full; return o; }));
    if (!target.docId && (target.doi || target.arxivId || target.query)) { docSelect.prepend(new Option(shortLabel(report?.target.title || target.query || target.doi || `arXiv:${target.arxivId}`), '')); docSelect.value = ''; }
    else if (docs.some(d => d.id === target.docId)) docSelect.value = target.docId;
  };
  const loadReport = async (forceRefresh = false) => {
    const payload: CitationAnalyzeInput = target.docId ? { docId: target.docId, direction, ...(forceRefresh ? { forceRefresh: true } : {}) }
      : (target.doi || target.arxivId || target.query) ? { ...(target.doi ? { doi: target.doi } : {}), ...(target.arxivId ? { arxivId: target.arxivId } : {}), ...(target.query ? { query: target.query } : {}), direction, ...(forceRefresh ? { forceRefresh: true } : {}) } : {};
    if (!payload.docId && !payload.doi && !payload.arxivId && !payload.query) { if (statusEl) statusEl.textContent = t('Select a library paper to analyze citations.', '请选择一篇本地文献以进行引用分析。'); return; }
    const { seq, signal } = beginRequest();
    if (refreshBtn) refreshBtn.disabled = true; if (statusEl) statusEl.textContent = t('Analyzing citations…', '正在分析引用立场…');
    try {
      const res = await api('citations.analyze', payload, false, signal);
      if (!mounted || seq !== reqSeq) return;
      report = res; if (res.target.docId && !target.docId) target.docId = res.target.docId;
      if (statusEl) statusEl.textContent = ''; syncDocOptions(); renderAll();
    } catch (err) { if (mounted && seq === reqSeq && !isAbortError(err)) { if (statusEl) statusEl.textContent = message(err); toast(message(err)); } }
    finally { if (mounted && seq === reqSeq && refreshBtn) refreshBtn.disabled = false; }
  };

  return {
    id: 'citations',
    mount(host, ctx) {
      mounted = true; restored = false; shell = ctx; mobileFiltersOpen = false; tallyBtns.clear(); facetChecks.clear();
      const startCtx = ctx.openContext();
      if (startCtx) {
        target = { docId: startCtx.docId ?? '', doi: startCtx.doi ?? '', arxivId: startCtx.arxivId ?? '', query: startCtx.query ?? '' };
        direction = startCtx.direction === 'references' ? 'references' : 'cited_by'; stanceFilter.clear();
        const initStance = startCtx.stance ?? startCtx.filter; if (isStance(initStance)) stanceFilter.add(initStance);
        otherCount = null; report = null;
      } else if (!target.docId && !target.doi && !target.arxivId && !target.query) target.docId = ctx.activeDocId();

      viewEl = el('section', 'cit-view'); viewEl.setAttribute('aria-label', researchViewName('citations'));
      const topEl = el('header', 'cit-top'), headRow = el('div', 'cit-head'), titleWrap = el('div', 'cit-title-wrap'), controls = el('div', 'cit-head-controls');
      titleEl = el('h1', 'cit-title', researchViewName('citations')); bylineEl = el('p', 'cit-byline'); bylineEl.hidden = true; titleWrap.append(titleEl, bylineEl);
      docSelect = el('select', 'cit-doc-select'); docSelect.ariaLabel = t('Select library paper', '选择库内文献');
      docSelect.addEventListener('change', () => { if (!docSelect!.value) return; target = { docId: docSelect!.value, doi: '', arxivId: '', query: '' }; otherCount = null; report = null; expandedKeys.clear(); void loadReport(false); });
      refreshBtn = mkBtn('btn cit-refresh-btn', t('Refresh', '刷新'), () => { void loadReport(true); });
      sciteLink = el('a', 'btn cit-scite-link', 'Scite ↗'); sciteLink.target = '_blank'; sciteLink.rel = 'noopener noreferrer'; sciteLink.ariaLabel = t('Open Scite report', '打开 Scite 报告'); sciteLink.hidden = true;
      mobileFiltersBtn = mkBtn('btn cit-filters-toggle', t('Filters', '筛选'), () => { mobileFiltersOpen = !mobileFiltersOpen; syncMobileFilters(); });
      controls.append(docSelect, refreshBtn, sciteLink, mobileFiltersBtn); headRow.append(titleWrap, controls);
      const subRow = el('div', 'cit-subbar'), unitsEl = el('div', 'cit-units'), dirTabs = el('div', 'cit-dir-tabs');
      papersUnitEl = el('span', 'cit-unit'); papersUnitEl.dataset.unit = 'papers'; stmtsUnitEl = el('span', 'cit-unit'); stmtsUnitEl.dataset.unit = 'statements'; unitsEl.append(papersUnitEl, stmtsUnitEl);
      const switchDir = (next: CitationDirection) => { if (direction === next) return; otherCount = report ? report.tallies.citationStatements : null; direction = next; report = null; expandedKeys.clear(); syncTallies(); renderList(); void loadReport(false); };
      citedByBtn = mkBtn('btn cit-dir-btn', t('Cited by', '被引'), () => switchDir('cited_by')); citedByBtn.dataset.dir = 'cited_by';
      refsBtn = mkBtn('btn cit-dir-btn', t('References', '参考文献'), () => switchDir('references')); refsBtn.dataset.dir = 'references';
      dirTabs.append(citedByBtn, refsBtn); subRow.append(unitsEl, dirTabs);
      bannerEl = el('div', 'cit-banner'); bannerEl.setAttribute('role', 'status'); bannerEl.hidden = true; topEl.append(headRow, subRow);

      const bodyEl = el('div', 'cit-body'), talliesWrap = el('div', 'cit-tallies-wrap'), talliesRow = el('div', 'cit-tallies');
      for (const item of STANCE_ITEMS) {
        const btn = mkBtn('cit-tally-btn', '', () => toggleStance(item.key)), cnt = el('strong', 'cit-tally-count', '0');
        btn.dataset.stance = item.key; btn.append(el('span', 'cit-tally-ico', item.icon), el('span', 'cit-tally-name', t(item.en, item.zh)), cnt);
        tallyBtns.set(item.key, { btn, count: cnt }); talliesRow.append(btn);
      }
      distBarEl = el('div', 'cit-dist-bar'); distBarEl.setAttribute('role', 'img'); talliesWrap.append(talliesRow, distBarEl);

      const splitEl = el('div', 'cit-split'), facetsEl = el('aside', 'cit-facets');
      const closeMobile = () => { mobileFiltersOpen = false; syncMobileFilters(); };
      facetsBackdrop = el('div', 'cit-facets-backdrop'); facetsBackdrop.hidden = true; facetsBackdrop.addEventListener('click', closeMobile);
      facetsEl.setAttribute('aria-label', t('Citation filters', '引用筛选'));
      facetsEl.addEventListener('keydown', e => { if (e.key === 'Escape' && mobileFiltersOpen) { e.preventDefault(); e.stopPropagation(); closeMobile(); mobileFiltersBtn?.focus({ preventScroll: true }); } });
      const fHead = el('div', 'cit-facets-head'), fClose = mkBtn('icon-btn cit-facets-close', '×', closeMobile);
      fClose.ariaLabel = t('Close filters', '关闭筛选'); fHead.append(el('strong', '', t('Filters', '筛选条件')), fClose);
      const typeGroup = el('div', 'cit-facet-group'); typeGroup.append(el('div', 'cit-facet-title', t('Citation Type', '引用立场')));
      for (const item of STANCE_ITEMS) {
        const row = el('label', 'cit-check-row'), cb = el('input', 'cit-check'), cnt = el('span', 'cit-facet-count', '0');
        cb.type = 'checkbox'; cb.dataset.stance = item.key; cb.addEventListener('change', () => toggleStance(item.key));
        row.append(cb, el('span', 'cit-check-label', `${item.icon} ${t(item.en, item.zh)}`), cnt); facetChecks.set(item.key, { input: cb, count: cnt }); typeGroup.append(row);
      }
      const mkFacet = (labelText: string, facet: string, opts: readonly (readonly [string, string])[], onChange: (v: string) => void) => {
        const grp = el('label', 'cit-facet-group'), sel = mkSelect('cit-facet-select', opts, v => { onChange(v); syncFilterControls(); renderList(); });
        sel.dataset.facet = facet; grp.append(el('span', 'cit-facet-title', labelText), sel); return { grp, sel };
      };
      const secF = mkFacet(t('Section', '章节'), 'section', [['', researchText.all()], ...SECTIONS.map(s => [s, s === 'Unknown' ? t('Unknown', '未知') : s] as const)], v => { filters.section = v; });
      const srcF = mkFacet(t('Source', '来源'), 'source', [['all', researchText.all()], ['local', t('★ Local Offline Back-Citations', '★ 本地离线反引')], ['external', t('External', '外部来源')]], v => { filters.source = v as SourceFilter; });
      const selfRow = el('label', 'cit-check-row cit-self-row'); selfCheck = el('input', 'cit-check'); selfCheck.type = 'checkbox'; selfCheck.dataset.facet = 'excludeSelf';
      selfCheck.addEventListener('change', () => { filters.excludeSelf = selfCheck!.checked; syncFilterControls(); renderList(); });
      selfRow.append(selfCheck, el('span', 'cit-check-label', t('Exclude self-citations', '排除自引')));
      const yrF = mkFacet(t('Year', '年份'), 'year', [['all', researchText.all()], ['2y', t('Last 2Y', '近 2 年')], ['5y', t('Last 5Y', '近 5 年')]], v => { filters.yearRange = v as YearFilter; });
      sectionSelect = secF.sel; sourceSelect = srcF.sel; yearSelect = yrF.sel;
      clearBtn = mkBtn('btn cit-clear-btn', t('Clear filters', '重置筛选'), resetFilters); clearBtn.hidden = true;
      facetsEl.append(fHead, typeGroup, secF.grp, srcF.grp, selfRow, yrF.grp, clearBtn);

      const feedPane = el('div', 'cit-feed-pane'), toolbar = el('div', 'cit-toolbar');
      searchInput = el('input', 'search cit-search-input'); searchInput.type = 'search'; searchInput.value = filters.search;
      searchInput.ariaLabel = t('Search citation snippets', '搜索引用片段'); searchInput.placeholder = t('Search snippets or titles…', '搜索引句内容或论文标题…');
      searchInput.addEventListener('input', () => { filters.search = searchInput!.value; syncFilterControls(); renderList(); });
      sortSelect = mkSelect('cit-sort-select', [['local', t('Local first', '本地反引优先')], ['newest', t('Newest', '最新优先')], ['influential', t('Influential', '高影响力优先')], ['contrasting', t('Contrasting first', '反驳优先')]], v => { filters.sort = v as SortMode; renderList(); });
      sortSelect.ariaLabel = t('Sort citations', '排序方式'); sortSelect.value = filters.sort;
      matchCountEl = el('span', 'cit-match-count'); toolbar.append(searchInput, sortSelect, matchCountEl);
      statusEl = el('p', 'cit-status'); statusEl.setAttribute('role', 'status'); listEl = el('div', 'cit-list');
      feedPane.append(toolbar, statusEl, listEl); splitEl.append(facetsBackdrop, facetsEl, feedPane);
      bodyEl.append(bannerEl, talliesWrap, splitEl); viewEl.append(topEl, bodyEl); host.append(viewEl); renderAll();
      void api('library.list', {}).then(({ docs: listed }) => { docs = listed; if (mounted) { syncDocOptions(); syncHeader(); } }).catch(() => undefined);
      void Promise.resolve().then(() => Promise.resolve()).then(() => { if (mounted && !restored) void loadReport(false); });
    },
    unmount() { mounted = false; abortPending(); tallyBtns.clear(); facetChecks.clear(); },
    saveState: (): SavedCitationsState => ({ report, otherCount, direction, target: { ...target }, filters: { ...filters }, stances: [...stanceFilter], expanded: [...expandedKeys], listScrollTop: listEl?.scrollTop ?? 0 }),
    restoreState(raw) {
      if (!raw || typeof raw !== 'object') return;
      const s = raw as SavedCitationsState; restored = true; abortPending();
      report = s.report ?? null; otherCount = s.otherCount ?? null; direction = s.direction === 'references' ? 'references' : 'cited_by';
      target = { docId: s.target?.docId ?? '', doi: s.target?.doi ?? '', arxivId: s.target?.arxivId ?? '', query: s.target?.query ?? '' };
      filters = { ...defaultFilters(), ...(s.filters ?? {}) };
      stanceFilter.clear(); for (const st of s.stances ?? []) if (isStance(st)) stanceFilter.add(st);
      expandedKeys.clear(); for (const k of s.expanded ?? []) expandedKeys.add(k);
      if (searchInput) searchInput.value = filters.search; if (sortSelect) sortSelect.value = filters.sort;
      syncDocOptions(); renderAll(); if (listEl) listEl.scrollTop = s.listScrollTop ?? 0;
    },
    handleEscape() { if (!mobileFiltersOpen) return false; mobileFiltersOpen = false; syncMobileFilters(); mobileFiltersBtn?.focus({ preventScroll: true }); return true; },
    onDocumentMutated(docId, deleted) {
      if (!deleted) return;
      docs = docs.filter(d => d.id !== docId); for (const [k, id] of savedMap) if (id === docId) savedMap.delete(k);
      if (target.docId === docId) { target = { docId: docs[0]?.id ?? '', doi: '', arxivId: '', query: '' }; report = null; otherCount = null; }
      syncDocOptions(); if (mounted) renderAll();
    }
  };
}
