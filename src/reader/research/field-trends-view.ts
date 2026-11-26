import {
  filterTrendTopics, sortTrendTopics,
  type TrendCell, type TrendMetric, type TrendQueryResult, type TrendSort, type TrendSource, type TrendTopicRow, type TrendWindow
} from '../../shared/research-types.js';
import { api, el, message, readerLabel as t, toast } from '../ui.js';
import { FieldTrendsDrilldown, type DrilldownSavedState } from './field-trends-drilldown.js';
import { formatCachedAt, formatDegradedSources, isAbortError, mkBtn } from './paper-intake.js';
import type { ResearchShellContext, ResearchViewModule } from './state.js';

interface SavedTrendsState {
  query: string; source: TrendSource; windowYears: TrendWindow; metric: TrendMetric; sort: TrendSort; blindSpotsOnly: boolean;
  rawResult: TrendQueryResult | null; drilldown: DrilldownSavedState | null; scrollTop: number; scrollLeft: number;
}

const STARTERS = ['LLM inference', 'GLP-1'] as const;
const METRICS: readonly [TrendMetric, () => string][] = [['volume', () => t('Volume', '发文量')], ['growth', () => t('Growth', '增速')], ['citations', () => t('Citations', '引文热度')]];
const WINDOWS: readonly TrendWindow[] = [3, 5, 8];
const fmtCompact = (n: number) => n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
const fmtGrowthSub = (r: TrendTopicRow) => { const p = Math.round(r.growth * 100); return r.lowBase ? t('Low base (n < 10)', '低基数 (n < 10)') : `${p > 0 ? '+' : ''}${p === 0 ? 0 : p}% · ${fmtCompact(r.totalVolume)}`; };

function formatCellValue(cell: TrendCell, metric: TrendMetric): string {
  if (metric === 'volume') return fmtCompact(cell.volume);
  if (metric === 'citations') return cell.citationHeat <= 0 ? '0' : cell.citationHeat >= 1000 ? `${(cell.citationHeat / 1000).toFixed(1)}k` : cell.citationHeat < 10 ? cell.citationHeat.toFixed(1) : String(Math.round(cell.citationHeat));
  if (cell.isYtd) return 'YTD*';
  if (cell.yoyGrowth === null) return '—';
  const pct = Math.round(cell.yoyGrowth * 100), s = pct > 999 ? '>+999%' : pct > 0 ? `+${pct}%` : pct === 0 ? '0%' : `${pct}%`;
  return cell.lowBase ? `${s}°` : s;
}

function cellHeatLevel(cell: TrendCell, metric: TrendMetric, maxVal: number): string {
  if (metric === 'growth') {
    if (cell.isYtd || cell.yoyGrowth === null || cell.lowBase) return '0';
    const pct = Math.round(cell.yoyGrowth * 100);
    return pct < 0 ? 'neg' : pct >= 100 ? '4' : pct >= 40 ? '3' : pct >= 15 ? '2' : pct > 0 ? '1' : '0';
  }
  const val = metric === 'volume' ? cell.volume : cell.citationHeat;
  if (val <= 0 || maxVal <= 0) return '0';
  const ratio = val / maxVal;
  return ratio >= 0.75 ? '4' : ratio >= 0.45 ? '3' : ratio >= 0.2 ? '2' : '1';
}

export function createFieldTrendsView(): ResearchViewModule {
  let mounted = false, restored = false, reqSeq = 0, saveVer = 0, ctrl: AbortController | null = null, shell: ResearchShellContext | undefined;
  let query = '', source: TrendSource = 'openalex', windowYears: TrendWindow = 5, metric: TrendMetric = 'volume', sort: TrendSort = 'fastest_growing', blindSpotsOnly = false;
  let rawResult: TrendQueryResult | null = null, loading = false, errorText = '', filtersOpen = false;
  let topEl: HTMLElement | undefined, splitEl: HTMLElement | undefined, metaEl: HTMLElement | undefined, matrixScroll: HTMLElement | undefined;
  let queryInput: HTMLInputElement | undefined, submitBtn: HTMLButtonElement | undefined, filtersBtn: HTMLButtonElement | undefined;
  let sourceSelect: HTMLSelectElement | undefined, sortSelect: HTMLSelectElement | undefined, blindBtn: HTMLButtonElement | undefined;
  let drilldown: FieldTrendsDrilldown | undefined;
  const metricBtns = new Map<TrendMetric, HTMLButtonElement>(), winBtns = new Map<TrendWindow, HTMLButtonElement>(), libCells = new Map<string, HTMLElement>(), savingIds = new Set<string>();

  const abortPending = () => { ++reqSeq; ctrl?.abort(); ctrl = null; loading = false; };
  const activeKey = () => { const cur = drilldown?.activeTarget(); return cur ? `${cur.topicId}:${cur.year}` : ''; };
  const syncControls = () => {
    if (topEl) topEl.dataset.filtersOpen = String(filtersOpen);
    filtersBtn?.setAttribute('aria-expanded', String(filtersOpen));
    if (sourceSelect) sourceSelect.value = source;
    if (sortSelect) sortSelect.value = sort;
    for (const [m, b] of metricBtns) b.setAttribute('aria-pressed', String(m === metric));
    for (const [w, b] of winBtns) b.setAttribute('aria-pressed', String(w === windowYears));
    blindBtn?.setAttribute('aria-pressed', String(blindSpotsOnly));
    if (splitEl) splitEl.dataset.drillOpen = String(Boolean(drilldown?.isOpen()));
  };
  const syncSelectedCells = () => {
    const key = activeKey();
    for (const b of matrixScroll?.querySelectorAll<HTMLButtonElement>('.ft-cell') ?? []) b.setAttribute('aria-pressed', String(`${b.dataset.topicId}:${b.dataset.year}` === key));
  };
  const renderCoverageCell = (td: HTMLElement, row: TrendTopicRow) => {
    td.replaceChildren();
    if (row.localCount > 0) {
      const last = row.cells.at(-1);
      const btn = mkBtn('ft-lib-btn', `★ ${row.localCount}`, () => {
        if (!rawResult || !last) return;
        drilldown?.open({ query: rawResult.query, topicId: row.topicId, topicName: row.topicName, year: last.year, isYtd: last.isYtd, source: rawResult.source }, 'library');
        syncControls(); syncSelectedCells();
      });
      btn.ariaLabel = t(`Open ${row.localCount} library papers for ${row.topicName}`, `查看「${row.topicName}」在本地库中的 ${row.localCount} 篇文献`);
      td.append(btn);
    } else { const dash = el('span', 'ft-lib-empty', '—'); dash.title = t('Not in your library yet', '本地库暂无该方向文献'); td.append(dash); }
  };
  const renderMetaBar = (count: number) => {
    if (!metaEl) return; metaEl.replaceChildren();
    if (!rawResult || loading || errorText) { metaEl.hidden = true; return; }
    metaEl.hidden = false;
    const pills = el('div', 'ft-meta-pills'), span = rawResult.years.length ? `${rawResult.years[0]}–${rawResult.ytdYear}*` : '';
    pills.append(el('span', 'ft-pill', t(`${count} topics · ${span}`, `${count} 个子方向 · ${span}`)));
    if (rawResult.fromCache) pills.append(el('span', 'ft-pill is-cache', formatCachedAt(rawResult.cachedAt)));
    if (rawResult.degraded.length) pills.append(el('span', 'ft-pill is-warn', formatDegradedSources(rawResult.degraded)));
    metaEl.append(pills, el('span', 'ft-footnote', t('* YTD partial year · Low-base n < 10 dimmed', '* 当年为截至目前数据 (YTD) · 低基数 n < 10 增速淡显')));
  };
  const handleGridKey = (event: KeyboardEvent) => {
    const tgt = event.target;
    if (!(tgt instanceof HTMLButtonElement) || !tgt.classList.contains('ft-cell')) return;
    const r = Number(tgt.dataset.row), c = Number(tgt.dataset.col);
    const dirs: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    let next: HTMLButtonElement | null = null;
    if (event.key === 'Home') next = matrixScroll?.querySelector<HTMLButtonElement>(`.ft-cell[data-row="${r}"][data-col="0"]`) ?? null;
    else if (event.key === 'End') { const all = matrixScroll?.querySelectorAll<HTMLButtonElement>(`.ft-cell[data-row="${r}"]`); next = all?.length ? all[all.length - 1] : null; }
    else if (dirs[event.key]) { const [dr, dc] = dirs[event.key]; next = matrixScroll?.querySelector<HTMLButtonElement>(`.ft-cell[data-row="${r + dr}"][data-col="${c + dc}"]`) ?? null; }
    else return;
    event.preventDefault(); next?.focus();
  };
  const renderMatrix = () => {
    if (!matrixScroll) return;
    const prevTop = matrixScroll.scrollTop, prevLeft = matrixScroll.scrollLeft;
    libCells.clear(); matrixScroll.replaceChildren(); syncControls();
    if (loading) { renderMetaBar(0); matrixScroll.append(el('div', 'ft-empty', t('Analyzing field trends…', '正在聚合研究趋势…'))); return; }
    if (errorText) { renderMetaBar(0); const box = el('div', 'ft-empty'); box.append(el('p', '', errorText), mkBtn('btn primary', t('Retry', '重试'), () => { void runQuery(query); })); matrixScroll.append(box); return; }
    if (!rawResult) {
      renderMetaBar(0); const box = el('div', 'ft-idle'), chips = el('div', 'ft-starters');
      for (const topic of STARTERS) chips.append(mkBtn('btn ft-starter-chip', topic, () => { query = topic; if (queryInput) queryInput.value = topic; void runQuery(topic); }));
      box.append(el('h2', 'ft-idle-title', t('Scan subtopic momentum across years', '跨年份扫描细分研究方向热度')), el('p', 'ft-idle-desc', t('Compare publication volume, 2-year growth, citation heat, and local library blind spots.', '一键切换发文量、增速、引文热度与本地文献库覆盖盲区。')), chips);
      matrixScroll.append(box); return;
    }
    const rows = filterTrendTopics(sortTrendTopics(rawResult.topics, sort, metric), blindSpotsOnly); renderMetaBar(rows.length);
    if (!rows.length) {
      const box = el('div', 'ft-empty');
      box.append(el('p', '', blindSpotsOnly && rawResult.topics.length ? t('All matching topics already have papers in your library.', '当前匹配的子方向均已有本地文献覆盖。') : t('No subtopics matched this query and time window.', '该查询和时间窗下未聚合到子方向数据。')));
      if (blindSpotsOnly && rawResult.topics.length) box.append(mkBtn('btn', t('Show all topics', '显示全部子方向'), () => { blindSpotsOnly = false; renderMatrix(); }));
      matrixScroll.append(box); return;
    }
    let maxVal = 0; for (const row of rows) for (const c of row.cells) maxVal = Math.max(maxVal, metric === 'volume' ? c.volume : c.citationHeat);
    const table = el('table', 'ft-table'), thead = el('thead'), headRow = el('tr'), tbody = el('tbody');
    table.setAttribute('role', 'grid'); table.setAttribute('aria-label', t('Field trends heatmap', '研究趋势热力图'));
    const thTopic = el('th', 'ft-col-topic', t('Subtopic', '研究子方向')), thLib = el('th', 'ft-col-lib', t('My Library', '本地库'));
    thTopic.scope = thLib.scope = 'col'; headRow.append(thTopic, thLib);
    for (const y of rawResult.years) {
      const isYtd = y === rawResult.ytdYear, th = el('th', `ft-col-year${isYtd ? ' is-ytd' : ''}`, isYtd ? `${y}* YTD` : String(y));
      th.scope = 'col'; if (isYtd) th.title = t('Partial year-to-date count', '当年截至目前的不完整统计'); headRow.append(th);
    }
    thead.append(headRow); tbody.addEventListener('keydown', handleGridKey);
    const selKey = activeKey();
    rows.forEach((row, rIdx) => {
      const tr = el('tr'), th = el('th', 'ft-row-topic'), tdLib = el('td', 'ft-row-lib');
      th.scope = 'row'; th.append(el('div', 'ft-topic-name', row.topicName), el('div', `ft-topic-sub${row.lowBase ? ' is-low-base' : ''}`, fmtGrowthSub(row)));
      renderCoverageCell(tdLib, row); libCells.set(row.topicId, tdLib); tr.append(th, tdLib);
      row.cells.forEach((cell, cIdx) => {
        const td = el('td', 'ft-row-cell'), text = formatCellValue(cell, metric), btn = el('button', 'ft-cell', text);
        btn.type = 'button'; Object.assign(btn.dataset, { topicId: row.topicId, year: String(cell.year), row: String(rIdx), col: String(cIdx), heat: cellHeatLevel(cell, metric, maxVal), lowBase: String(metric === 'growth' && cell.lowBase), ytd: String(cell.isYtd) });
        btn.setAttribute('aria-pressed', String(`${row.topicId}:${cell.year}` === selKey));
        btn.ariaLabel = btn.title = `${row.topicName}, ${cell.isYtd ? `${cell.year}* YTD` : cell.year}: ${text} (${cell.volume}${cell.lowBase ? ', n < 10' : ''})`;
        btn.addEventListener('click', () => { if (!rawResult) return; drilldown?.open({ query: rawResult.query, topicId: row.topicId, topicName: row.topicName, year: cell.year, isYtd: cell.isYtd, source: rawResult.source }, 'representative'); syncControls(); syncSelectedCells(); });
        td.append(btn); tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(thead, tbody); matrixScroll.append(table); matrixScroll.scrollTop = prevTop; matrixScroll.scrollLeft = prevLeft;
  };
  const runQuery = async (nextQuery: string) => {
    const q = nextQuery.trim(); query = q; abortPending();
    if (!q) { rawResult = null; errorText = ''; if (submitBtn) submitBtn.disabled = false; drilldown?.close(); renderMatrix(); return; }
    const seq = reqSeq; ctrl = new AbortController(); loading = true; errorText = '';
    if (filtersOpen) filtersOpen = false; if (submitBtn) submitBtn.disabled = true; drilldown?.close(); renderMatrix();
    try {
      const res = await api('trends.query', { query: q, source, windowYears, metric, sort, blindSpotsOnly: false }, false, ctrl.signal);
      if (!mounted || seq !== reqSeq) return;
      rawResult = res; loading = false; renderMatrix();
    } catch (err) {
      if (!mounted || seq !== reqSeq || isAbortError(err)) return;
      loading = false; errorText = message(err); renderMatrix(); toast(errorText);
    } finally { if (seq === reqSeq && submitBtn) submitBtn.disabled = false; }
  };
  const updateRowCoverage = (topicId: string, delta: number, confirmedDocId?: string) => {
    ++saveVer;
    const row = rawResult?.topics.find(r => r.topicId === topicId); if (!row) return;
    if (confirmedDocId) {
      if (row.localDocIds.includes(confirmedDocId)) row.localCount = Math.max(row.localDocIds.length, row.localCount - 1);
      else row.localDocIds.push(confirmedDocId);
    } else row.localCount = Math.max(0, row.localCount + delta);
    const td = libCells.get(topicId); if (mounted && td) renderCoverageCell(td, row);
  };
  const dropMissingDocs = (isMissing: (docId: string) => boolean) => {
    if (!rawResult) return;
    for (const row of rawResult.topics) {
      const kept = row.localDocIds.filter(id => !isMissing(id)), dropped = row.localDocIds.length - kept.length;
      if (!dropped) continue;
      row.localDocIds = kept; row.localCount = Math.max(0, row.localCount - dropped);
      const td = libCells.get(row.topicId); if (mounted && td) renderCoverageCell(td, row);
    }
  };
  const reconcileLibrary = () => {
    const cur = rawResult, ver = saveVer; if (!cur) return;
    void api('library.list', {}).then(({ docs }) => {
      if (!mounted || rawResult !== cur || ver !== saveVer) return;
      const live = new Set(docs.map(d => d.id));
      dropMissingDocs(id => !live.has(id));
      drilldown?.reconcileMissing((did, pid) => !live.has(did) && !savingIds.has(pid));
    }).catch(() => undefined);
  };

  return {
    id: 'field-trends',
    mount(host, ctx) {
      mounted = true; restored = false; shell = ctx;
      const startQ = ctx.openContext()?.query?.trim(); if (startQ) query = startQ;
      const view = el('section', 'ft-view'); view.setAttribute('aria-label', t('Field Trends', '研究趋势'));
      topEl = el('div', 'ft-top'); const form = el('form', 'ft-search-row');
      queryInput = el('input', 'search ft-query-input'); queryInput.type = 'search'; queryInput.value = query;
      queryInput.ariaLabel = t('Research field query', '研究领域查询'); queryInput.placeholder = t('Field or topic, e.g. LLM inference, GLP-1…', '输入研究领域或主题关键词…');
      queryInput.addEventListener('input', () => { query = queryInput!.value; });
      submitBtn = el('button', 'btn primary ft-submit-btn', t('Analyze', '分析')); submitBtn.type = 'submit';
      filtersBtn = mkBtn('btn ft-filters-toggle', t('Filters', '筛选'), () => { filtersOpen = !filtersOpen; syncControls(); });
      form.addEventListener('submit', e => { e.preventDefault(); void runQuery(queryInput?.value ?? ''); }); form.append(queryInput, submitBtn, filtersBtn);
      const filters = el('div', 'ft-filters');
      sourceSelect = el('select', 'ft-select ft-source'); sourceSelect.ariaLabel = t('Data source', '数据源');
      sourceSelect.append(new Option('OpenAlex', 'openalex'), new Option('Europe PMC', 'europepmc'), new Option(t('All', '全部'), 'all'));
      sourceSelect.addEventListener('change', () => { source = sourceSelect!.value as TrendSource; if (query.trim()) void runQuery(query); else syncControls(); });
      const metricGroup = el('div', 'ft-seg'); metricGroup.setAttribute('role', 'group'); metricGroup.setAttribute('aria-label', t('Heatmap metric', '热力图指标')); metricBtns.clear();
      for (const [m, fn] of METRICS) { const b = mkBtn('btn ft-seg-btn', fn(), () => { if (metric !== m) { metric = m; renderMatrix(); } }); b.dataset.metric = m; metricBtns.set(m, b); metricGroup.append(b); }
      sortSelect = el('select', 'ft-select ft-sort'); sortSelect.ariaLabel = t('Sort topics', '子方向排序');
      sortSelect.append(new Option(t('Fastest Growing', '最快增长'), 'fastest_growing'), new Option(t('Hottest', '最热'), 'hottest'), new Option(t('Blind Spots First', '盲区优先'), 'blind_spots_first'));
      sortSelect.addEventListener('change', () => { sort = sortSelect!.value as TrendSort; renderMatrix(); });
      const winGroup = el('div', 'ft-seg'); winGroup.setAttribute('role', 'group'); winGroup.setAttribute('aria-label', t('Time window', '时间窗口')); winBtns.clear();
      for (const w of WINDOWS) { const b = mkBtn('btn ft-seg-btn', `${w}Y`, () => { if (windowYears !== w) { windowYears = w; if (query.trim()) void runQuery(query); else syncControls(); } }); b.dataset.window = String(w); winBtns.set(w, b); winGroup.append(b); }
      blindBtn = mkBtn('btn ft-blind-btn', t('Blind spots only', '仅看盲区'), () => { blindSpotsOnly = !blindSpotsOnly; renderMatrix(); });
      filters.append(sourceSelect, metricGroup, sortSelect, winGroup, blindBtn);
      metaEl = el('div', 'ft-meta-bar'); metaEl.hidden = true; topEl.append(form, filters, metaEl);
      splitEl = el('div', 'ft-split'); const pane = el('div', 'ft-matrix-pane'); matrixScroll = el('div', 'ft-matrix-scroll'); pane.append(matrixScroll);
      drilldown = new FieldTrendsDrilldown({ shell: () => shell, savingIds, onClose: () => { syncControls(); syncSelectedCells(); }, onCoverageDelta: (id, d) => updateRowCoverage(id, d), onCoverageConfirmed: (id, docId) => updateRowCoverage(id, 0, docId), onPaperSynced: (id, inLib, docId) => drilldown?.syncPaper(id, inLib, docId) });
      splitEl.append(pane, drilldown.backdrop, drilldown.root); view.append(topEl, splitEl); host.append(view); renderMatrix();
      void Promise.resolve().then(() => Promise.resolve()).then(() => { if (!mounted) return; if (startQ && !restored) void runQuery(startQ); else if (rawResult) reconcileLibrary(); });
    },
    unmount() { mounted = false; abortPending(); drilldown?.unmount(); drilldown = undefined; libCells.clear(); metricBtns.clear(); winBtns.clear(); },
    saveState: (): SavedTrendsState => ({ query, source, windowYears, metric, sort, blindSpotsOnly, rawResult, drilldown: drilldown?.saveState() ?? null, scrollTop: matrixScroll?.scrollTop ?? 0, scrollLeft: matrixScroll?.scrollLeft ?? 0 }),
    restoreState(raw) {
      if (!raw || typeof raw !== 'object') return;
      const s = raw as SavedTrendsState; restored = true; abortPending(); errorText = '';
      query = s.query ?? ''; source = s.source ?? 'openalex'; windowYears = s.windowYears ?? 5; metric = s.metric ?? 'volume'; sort = s.sort ?? 'fastest_growing'; blindSpotsOnly = Boolean(s.blindSpotsOnly); rawResult = s.rawResult ?? null;
      if (queryInput) queryInput.value = query; drilldown?.restoreState(s.drilldown); renderMatrix();
      if (matrixScroll) { matrixScroll.scrollTop = s.scrollTop ?? 0; matrixScroll.scrollLeft = s.scrollLeft ?? 0; } syncSelectedCells();
    },
    handleEscape() {
      if (!drilldown?.isOpen()) return false;
      const prev = drilldown.activeTarget(); drilldown.close();
      if (prev && matrixScroll) matrixScroll.querySelector<HTMLButtonElement>(`.ft-cell[data-topic-id="${CSS.escape(prev.topicId)}"][data-year="${prev.year}"]`)?.focus({ preventScroll: true });
      return true;
    },
    onDocumentMutated(docId, deleted) {
      if (!deleted || !rawResult) return;
      dropMissingDocs(id => id === docId); drilldown?.reconcileMissing(id => id === docId);
    }
  };
}
