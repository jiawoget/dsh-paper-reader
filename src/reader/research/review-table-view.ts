import { computeScreeningStatus, type ExtractionCell, type ReviewBatchResult, type ReviewDecision, type ReviewExportFormat, type ReviewExtractMode, type ReviewPresetId, type ReviewTable } from '../../shared/review-types.js';
import type { DocumentInfo } from '../../shared/types.js';
import { api, apiStream, downloadFile, el, message, readerLabel as t, toast } from '../ui.js';
import { isAbortError, mkBtn } from './paper-intake.js';
import { cellBadgeInfo, coverageLabel, decisionLabel, ReviewColumnPicker, reviewColLabel, ReviewTableInspector, slugColumnId } from './review-table-inspector.js';
import type { ResearchOpenContext, ResearchShellContext, ResearchViewModule } from './state.js';

type ReviewStep = 'screening' | 'extraction';
interface SavedReviewState { step: ReviewStep; selected: { docId: string; colId: string } | null; inspectorOpen: boolean; activeScreenDocId: string; scrollTop: number; scrollLeft: number }
const cellKey = (docId: string, colId: string) => `${docId}\0${colId}`;
const srcBadge = (doc: DocumentInfo) => el('span', `rt-src-badge ${doc.kind === 'abstract' ? 'is-abstract' : 'is-pdf'}`, coverageLabel(doc.kind));
const miniBadge = (b: ReturnType<typeof cellBadgeInfo>) => { const s = el('span', `rt-cell-badge is-${b.kind}`, b.short); s.title = b.full; return s; };
const paperHeading = (doc: DocumentInfo, tag: 'span' | 'strong') => { const m = [doc.authors, doc.year].filter(Boolean).join(' · '); return [el(tag, 'rt-paper-title', doc.paperTitle || doc.title), ...(m ? [el('span', 'rt-paper-meta', m)] : [])]; };

export function createReviewTableView(): ResearchViewModule {
  let lastOpenCtx: ResearchOpenContext | undefined, mounted = false, mountSeq = 0, running = false, step: ReviewStep = 'extraction';
  let shell: ResearchShellContext | undefined, table: ReviewTable | null = null, docs: DocumentInfo[] = [];
  let cells = new Map<string, ExtractionCell>(), selected: { docId: string; colId: string } | null = null;
  let activeScreenDocId = '', statusMsg = '', abortCtrl: AbortController | null = null;
  let splitEl: HTMLElement | null = null, topEl: HTMLElement | null = null, subBarEl: HTMLElement | null = null, bodyEl: HTMLElement | null = null;
  let presetSel: HTMLSelectElement | null = null, progressEl: HTMLElement | null = null, stopBtn: HTMLButtonElement | null = null, toolsToggleEl: HTMLButtonElement | null = null;
  let stepBtns = new Map<ReviewStep, HTMLButtonElement>(), actionBtns: HTMLButtonElement[] = [];
  let inspector: ReviewTableInspector | null = null, colPicker: ReviewColumnPicker | null = null;

  const visibleDocs = () => { const tag = shell?.activeTopic(), f = tag ? docs.filter(d => d.meta?.tags?.includes(tag)) : docs; return f.length ? f : docs; };
  const docCells = (docId: string) => { const m = new Map<string, ExtractionCell>(); for (const c of cells.values()) if (c.docId === docId) m.set(c.colId, c); return m; };
  const mergeCells = (list: readonly ExtractionCell[]) => { for (const c of list) cells.set(cellKey(c.docId, c.colId), c); };
  const setStatus = (text: string) => { statusMsg = text; if (progressEl) progressEl.textContent = text; };
  const setBody = (...nodes: Node[]) => { bodyEl?.replaceChildren(...(progressEl ? [progressEl] : []), ...nodes); };
  const hasCol = (colId: string) => colId === '__screen__' || Boolean(table && (colId.startsWith('screen:') ? table.criteria.some(c => `screen:${c.id}` === colId) : table.columns.some(c => c.id === colId)));
  const syncRunning = () => {
    if (stopBtn) stopBtn.hidden = !running; if (presetSel) presetSel.disabled = running; for (const b of actionBtns) b.disabled = running;
    for (const host of [subBarEl, bodyEl]) for (const b of host?.querySelectorAll<HTMLButtonElement>('.rt-add-col-btn, .rt-add-col-m, .rt-col-del, .rt-cell-retry, .rt-crit-req, .rt-crit-del, .rt-crit-add, .rt-strict-btn') ?? []) b.disabled = running;
    inspector?.setBusy(running);
  };
  const syncSplitAttr = () => { if (splitEl) splitEl.dataset.inspectorOpen = String(Boolean(inspector?.isOpen())); };
  const colLabelFor = (colId: string) => colId === '__screen__' ? { label: t('Overall Screening', '综合筛选结论'), isScreening: true }
    : colId.startsWith('screen:') ? { label: table?.criteria.find(c => `screen:${c.id}` === colId)?.label ?? colId.slice(7), isScreening: true }
    : { label: (col => col ? reviewColLabel(col) : colId)(table?.columns.find(c => c.id === colId)), isScreening: false };
  const syncGridSelection = () => {
    if (!bodyEl) return;
    let hasFocus = false;
    for (const btn of bodyEl.querySelectorAll<HTMLButtonElement>('.rt-cell')) {
      const active = Boolean(selected && btn.dataset.docId === selected.docId && btn.dataset.colId === selected.colId);
      btn.classList.toggle('is-selected', active); btn.setAttribute('aria-selected', String(active)); btn.tabIndex = active ? 0 : -1; if (active) hasFocus = true;
    }
    if (!hasFocus) { const first = bodyEl.querySelector<HTMLButtonElement>('.rt-cell'); if (first) first.tabIndex = 0; }
  };
  const openInspector = (docId: string, colId: string) => {
    const doc = docs.find(d => d.id === docId); if (!doc || !inspector) return;
    selected = { docId, colId }; const meta = colLabelFor(colId);
    inspector.show({ doc, colId, colLabel: meta.label, isScreening: meta.isScreening, cell: cells.get(cellKey(docId, colId)) });
    syncSplitAttr(); syncGridSelection();
  };
  const syncInspector = () => { if (inspector?.isOpen() && selected) { if (!docs.some(d => d.id === selected!.docId) || !hasCol(selected.colId)) { inspector.close(); selected = null; } else openInspector(selected.docId, selected.colId); } };
  const partitionDocs = (list: readonly DocumentInfo[]) => {
    const included: { doc: DocumentInfo; status: ReturnType<typeof computeScreeningStatus> }[] = [], excluded: typeof included = [];
    for (const doc of list) { const status = computeScreeningStatus(table?.criteria ?? [], docCells(doc.id), Boolean(table?.strictCriterion), table?.threshold ?? 0.6); (status.included ? included : excluded).push({ doc, status }); }
    return { included, excluded };
  };
  const reloadCells = async () => { if (!table) return; const seq = mountSeq, got = await api('review.get', { tableId: table.id }); if (mounted && seq === mountSeq) { table = got.table; cells = new Map(got.cells.map(c => [cellKey(c.docId, c.colId), c])); } };

  async function loadData(keepStatus = false): Promise<void> {
    const seq = mountSeq, [libRes, revRes] = await Promise.all([api('library.list', {}), api('review.get', table ? { tableId: table.id } : {})]);
    if (!mounted || seq !== mountSeq) return;
    docs = libRes.docs; table = revRes.table; cells = new Map(revRes.cells.map(c => [cellKey(c.docId, c.colId), c]));
    if (!keepStatus) setStatus(''); renderAll(); syncInspector();
  }
  async function saveTablePatch(patch: Partial<Pick<ReviewTable, 'preset' | 'columns' | 'criteria' | 'strictCriterion' | 'threshold'>>, reload = false): Promise<boolean> {
    if (!table || running) return false; const seq = mountSeq;
    try {
      table = (await api('review.saveTable', { id: table.id, ...patch })).table; if (!mounted || seq !== mountSeq) return false;
      if (reload) { await reloadCells(); if (!mounted || seq !== mountSeq) return false; }
      renderAll(); syncInspector(); return true;
    } catch (e) { if (mounted && seq === mountSeq) toast(message(e)); return false; }
  }
  async function setManualCell(docId: string, colId: string, value: string, reasoning?: string): Promise<void> {
    if (!table) return; const seq = mountSeq, res = await api('review.setCell', { tableId: table.id, docId, colId, value, ...(reasoning !== undefined ? { reasoning } : {}) });
    if (!mounted || seq !== mountSeq) return;
    cells.set(cellKey(docId, colId), res.cell); if (colId.startsWith('screen:')) await reloadCells(); if (mounted && seq === mountSeq) { renderBody(); syncInspector(); }
  }
  async function runBatch(kind: 'screen' | 'extract', mode: ReviewExtractMode = 'all', extra: { docId?: string; colId?: string; docIds?: string[]; force?: boolean } = {}): Promise<void> {
    if (!table || running) return;
    const list = extra.docIds ?? visibleDocs().map(d => d.id);
    if (!list.length) { toast(t('No papers in library to process.', '文献库中暂无可处理的文献。')); return; }
    if (kind === 'screen' && !table.criteria.length) { if (topEl) { topEl.dataset.toolsOpen = 'true'; toolsToggleEl?.setAttribute('aria-expanded', 'true'); } toast(t('Add at least one screening criterion first.', '请先添加至少一条筛选条件。')); return; }
    const seq = mountSeq, ctrl = new AbortController(); running = true; abortCtrl = ctrl; colPicker?.close(); syncRunning();
    setStatus(kind === 'screen' ? t(`Screening 0 / ${list.length} papers…`, `正在筛选 0 / ${list.length} 篇…`) : t('Extracting…', '正在提取…'));
    const onDelta = (raw: string) => {
      if (!mounted || seq !== mountSeq || abortCtrl !== ctrl) return;
      try {
        const d = JSON.parse(raw) as { processedDocs?: number; totalDocs?: number; cells?: ExtractionCell[] };
        if (Array.isArray(d.cells)) mergeCells(d.cells);
        if (typeof d.processedDocs === 'number' && typeof d.totalDocs === 'number') setStatus(kind === 'screen' ? t(`Screened ${d.processedDocs} / ${d.totalDocs} papers…`, `已筛选 ${d.processedDocs} / ${d.totalDocs} 篇…`) : t(`Extracted ${d.processedDocs} / ${d.totalDocs} papers…`, `已提取 ${d.processedDocs} / ${d.totalDocs} 篇…`));
        renderBody(); syncInspector();
      } catch {}
    };
    try {
      const res: ReviewBatchResult = kind === 'screen'
        ? await apiStream('review.screen', { tableId: table.id, docIds: list, ...(extra.force ? { force: true } : {}) }, onDelta, ctrl.signal)
        : await apiStream('review.extract', { tableId: table.id, mode, ...(extra.docId ? { docId: extra.docId } : { docIds: list }), ...(extra.colId ? { colId: extra.colId } : {}), ...(extra.force ? { force: true } : {}) }, onDelta, ctrl.signal);
      if (!mounted || seq !== mountSeq || abortCtrl !== ctrl) return;
      mergeCells(res.cells);
      setStatus(res.processedDocs === 0 && res.skippedDocs > 0 ? t('All target cells already extracted.', '目标单元格已全部完成。') : res.failedDocs ? t(`Done: ${res.processedDocs} ok, ${res.failedDocs} failed.`, `完成：${res.processedDocs} 篇成功，${res.failedDocs} 篇失败。`) : t(`Completed ${res.processedDocs} paper(s).`, `已完成 ${res.processedDocs} 篇文献处理。`));
      renderBody(); syncInspector();
    } catch (err) {
      if (!mounted || seq !== mountSeq || abortCtrl !== ctrl) return;
      if (isAbortError(err)) { setStatus(t('Stopped — completed results kept.', '已停止，已保留已完成结果。')); void reloadCells().then(() => { if (mounted && seq === mountSeq) { renderBody(); syncInspector(); } }).catch(() => undefined); }
      else { setStatus(message(err)); toast(message(err)); }
    } finally { if (abortCtrl === ctrl) { abortCtrl = null; running = false; if (mounted) syncRunning(); } }
  }
  async function saveAndNext(): Promise<void> {
    if (!table) return;
    const seq = mountSeq, p = partitionDocs(visibleDocs()), ordered = [...p.included, ...p.excluded]; if (!ordered.length) return;
    const cur = ordered.find(x => x.doc.id === activeScreenDocId) ?? ordered.find(x => !x.status.manualOverride) ?? ordered[0];
    if (!cur.status.manualOverride) await setManualCell(cur.doc.id, '__screen__', cur.status.decision); if (!mounted || seq !== mountSeq) return;
    const r = partitionDocs(visibleDocs()), all = [...r.included, ...r.excluded], idx = all.findIndex(x => x.doc.id === cur.doc.id);
    const next = [...all.slice(idx + 1), ...all.slice(0, Math.max(0, idx))].find(x => x.doc.id !== cur.doc.id && !x.status.manualOverride);
    if (!next) { activeScreenDocId = ''; renderBody(); toast(t('All papers reviewed.', '已审阅全部文献。')); return; }
    activeScreenDocId = next.doc.id; renderBody();
    const row = bodyEl?.querySelector<HTMLElement>(`.rt-srow[data-doc-id="${CSS.escape(next.doc.id)}"]`);
    row?.scrollIntoView({ block: 'nearest' }); row?.querySelector<HTMLButtonElement>('.rt-dec-btn')?.focus({ preventScroll: true });
  }

  function renderSubBar(): void {
    if (!subBarEl || !table) return;
    subBarEl.replaceChildren(); actionBtns = [];
    stopBtn = mkBtn('btn rt-stop-btn', t('Stop', '停止'), () => abortCtrl?.abort()); stopBtn.hidden = !running;
    if (step === 'screening') {
      const topRow = el('div', 'rt-screen-row'), chips = el('div', 'rt-crit-list'), addForm = el('form', 'rt-crit-form'), critIn = el('input', 'search rt-crit-in'), addBtn = el('button', 'btn rt-crit-add', t('+ Add Criterion', '+ 添加条件'));
      for (const cr of table.criteria) {
        const chip = el('span', 'rt-crit-chip'), reqBtn = mkBtn('rt-crit-req', cr.required ? t('Required', '必选') : t('Optional', '可选'), () => { void saveTablePatch({ criteria: table!.criteria.map(c => c.id === cr.id ? { ...c, required: !c.required } : c) }); });
        reqBtn.setAttribute('aria-pressed', String(Boolean(cr.required)));
        const delBtn = mkBtn('rt-crit-del', '×', () => { void saveTablePatch({ criteria: table!.criteria.filter(c => c.id !== cr.id) }); }); delBtn.ariaLabel = t(`Remove criterion ${cr.label}`, `移除条件 ${cr.label}`);
        chip.append(el('span', 'rt-crit-lbl', cr.label), reqBtn, delBtn); chips.append(chip);
      }
      critIn.type = 'text'; critIn.maxLength = 160; critIn.placeholder = t('Add screening criterion…', '输入筛选条件…'); critIn.ariaLabel = t('New screening criterion', '新建筛选条件'); addBtn.type = 'submit';
      addForm.append(critIn, addBtn);
      addForm.addEventListener('submit', e => { e.preventDefault(); const lbl = critIn.value.trim(); if (!lbl || !table || running) return; critIn.value = ''; void saveTablePatch({ criteria: [...table.criteria, { id: slugColumnId(lbl, new Set(table.criteria.map(c => c.id))), label: lbl }] }); });
      topRow.append(chips, addForm);
      const ctrlRow = el('div', 'rt-screen-ctrls'), strictBtn = mkBtn('btn rt-strict-btn', t('Strict Criterion', '严格条件'), () => { void saveTablePatch({ strictCriterion: !table!.strictCriterion }); });
      strictBtn.setAttribute('aria-pressed', String(table.strictCriterion));
      const thWrap = el('label', 'rt-th-wrap'), thSlider = el('input', 'rt-threshold'), thVal = el('span', 'rt-th-val', `${Math.round(table.threshold * 100)}%`);
      Object.assign(thSlider, { type: 'range', min: '10', max: '100', step: '5', value: String(Math.round(table.threshold * 100)), ariaLabel: t('Inclusion threshold', '纳入阈值') });
      thSlider.addEventListener('input', () => { if (!table) return; table.threshold = Number(thSlider.value) / 100; thVal.textContent = `${thSlider.value}%`; renderBody(); });
      thSlider.addEventListener('change', () => { if (table) void saveTablePatch({ threshold: table.threshold }); });
      thWrap.append(el('span', 'rt-th-lbl', t('Threshold', '阈值')), thSlider, thVal);
      const runBtn = mkBtn('btn primary rt-screen-run', t('Screen all', '开始筛选'), () => { void runBatch('screen'); }), nextBtn = mkBtn('btn rt-save-next', t('Save & next', '保存并下一篇'), () => { void saveAndNext().catch(e => toast(message(e))); });
      actionBtns.push(runBtn, nextBtn); ctrlRow.append(strictBtn, thWrap, runBtn, stopBtn, nextBtn); subBarEl.append(topRow, ctrlRow);
    } else {
      const row = el('div', 'rt-extract-bar'), pilotBtn = mkBtn('btn primary rt-pilot-btn', t('Pilot (3 papers)', 'Pilot 试跑 3 篇'), () => { void runBatch('extract', 'pilot'); });
      const allBtn = mkBtn('btn rt-run-all-btn', t('Run all', '全量提取'), () => { void runBatch('extract', 'all'); }), addColM = mkBtn('btn rt-add-col-m', t('+ Add Column', '+ 添加列'), () => colPicker?.open(table!.columns.map(c => c.id)));
      actionBtns.push(pilotBtn, allBtn); row.append(pilotBtn, allBtn, stopBtn, addColM); subBarEl.append(row);
    }
    syncRunning();
  }

  function renderScreening(): void {
    if (!bodyEl || !table) return;
    const list = visibleDocs();
    if (!list.length) { setBody(el('p', 'rt-empty', t('Import papers into your library to start screening.', '请先向文献库导入论文以开始筛选。'))); return; }
    const { included, excluded } = partitionDocs(list), wrap = el('div', 'rt-screen-wrap');
    if (!activeScreenDocId || !list.some(d => d.id === activeScreenDocId)) activeScreenDocId = [...included, ...excluded].find(x => !x.status.manualOverride)?.doc.id ?? list[0].id;
    const buildPart = (part: 'included' | 'excluded', title: string, items: typeof included) => {
      const sec = el('section', 'rt-part'); sec.dataset.part = part; sec.append(el('h3', 'rt-part-head', `${title} (${items.length})`));
      if (!items.length) { sec.append(el('p', 'rt-part-empty', t('None', '暂无'))); return sec; }
      for (const { doc, status } of items) {
        const row = el('article', 'rt-srow'), head = el('div', 'rt-srow-head'), info = el('div', 'rt-srow-info'), badges = el('div', 'rt-srow-badges'), decs = el('div', 'rt-dec-group');
        row.dataset.docId = doc.id; row.classList.toggle('is-active', doc.id === activeScreenDocId);
        badges.append(srcBadge(doc), el('span', `rt-dec-pill is-${status.decision}`, `${decisionLabel(status.decision)}${status.manualOverride ? ' ✎' : table!.criteria.length ? ` · ${Math.round(status.score * 100)}%` : ''}`));
        info.append(...paperHeading(doc, 'strong'), badges); decs.setAttribute('role', 'group'); decs.ariaLabel = t('Screening decision', '筛选结论');
        for (const d of ['yes', 'maybe', 'no'] as const) {
          const b = mkBtn(`btn rt-dec-btn is-${d}`, decisionLabel(d), () => { activeScreenDocId = doc.id; void setManualCell(doc.id, '__screen__', d).catch(e => toast(message(e))); });
          b.dataset.decision = d; b.setAttribute('aria-pressed', String(status.decision === d)); decs.append(b);
        }
        head.append(info, decs); row.append(head);
        if (table!.criteria.length) {
          const crRow = el('div', 'rt-scrit-cells');
          for (const cr of table!.criteria) {
            const colId = `screen:${cr.id}`, c = cells.get(cellKey(doc.id, colId)), bInfo = cellBadgeInfo(c), btn = mkBtn('btn rt-scrit-cell', '', () => { activeScreenDocId = doc.id; openInspector(doc.id, colId); });
            btn.dataset.docId = doc.id; btn.dataset.colId = colId;
            btn.append(el('span', 'rt-scrit-name', cr.label), el('span', 'rt-scrit-val', c?.value ? decisionLabel(c.value as ReviewDecision) : '—'), ...(bInfo.short ? [miniBadge(bInfo)] : []));
            crRow.append(btn);
          }
          row.append(crRow);
        }
        sec.append(row);
      }
      return sec;
    };
    wrap.append(buildPart('included', t('Included', '纳入'), included), buildPart('excluded', t('Excluded', '排除'), excluded)); setBody(wrap);
  }

  function renderExtraction(): void {
    if (!bodyEl || !table) return;
    const list = visibleDocs(), cols = table.columns;
    if (!list.length) { setBody(el('p', 'rt-empty', t('Import papers into your library to extract structured columns.', '请先向文献库导入论文以提取结构化表格。'))); return; }
    const tableWrap = el('div', 'rt-table-wrap'), grid = el('table', 'rt-grid'), thead = el('thead'), hr = el('tr'), tbody = el('tbody'), cards = el('div', 'rt-mobile-cards');
    grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', t('Extraction Matrix', '文献提取矩阵')); hr.setAttribute('role', 'row');
    const paperTh = el('th', 'rt-col-paper', t('Paper', '文献')); paperTh.setAttribute('role', 'columnheader'); hr.append(paperTh);
    for (const col of cols) {
      const th = el('th', 'rt-col-dyn'), inner = el('div', 'rt-col-head'), colLbl = reviewColLabel(col); th.setAttribute('role', 'columnheader'); inner.append(el('span', 'rt-col-label', colLbl));
      if (cols.length > 1) { const del = mkBtn('rt-col-del', '×', () => { void saveTablePatch({ columns: cols.filter(c => c.id !== col.id) }, true); }); del.ariaLabel = t(`Remove column ${colLbl}`, `移除列 ${colLbl}`); inner.append(del); }
      th.append(inner); hr.append(th);
    }
    const addTh = el('th', 'rt-col-add'); addTh.setAttribute('role', 'columnheader'); addTh.append(mkBtn('btn rt-add-col-btn', t('+ Add Column', '+ 添加列'), () => colPicker?.open(cols.map(c => c.id)))); hr.append(addTh); thead.append(hr);
    for (let r = 0; r < list.length; r++) {
      const doc = list[r], tr = el('tr'), pCell = el('th', 'rt-paper-cell'), card = el('article', 'rt-mcard'), cHead = el('div', 'rt-mcard-head');
      tr.setAttribute('role', 'row'); tr.dataset.docId = card.dataset.docId = doc.id; pCell.scope = 'row'; pCell.setAttribute('role', 'rowheader');
      pCell.append(...paperHeading(doc, 'span'), srcBadge(doc)); tr.append(pCell); cHead.append(...paperHeading(doc, 'strong'), srcBadge(doc)); card.append(cHead);
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c], cell = cells.get(cellKey(doc.id, col.id)), badge = cellBadgeInfo(cell), valText = cell?.status === 'error' ? t('Failed', '失败') : (cell?.value || '—');
        const td = el('td', 'rt-cell-td'), btn = mkBtn('rt-cell', '', () => openInspector(doc.id, col.id));
        td.setAttribute('role', 'gridcell'); btn.dataset.row = String(r); btn.dataset.col = String(c); btn.dataset.docId = doc.id; btn.dataset.colId = col.id;
        btn.append(el('span', 'rt-cell-val', valText), ...(badge.short ? [miniBadge(badge)] : [])); td.append(btn);
        if (cell?.status === 'error') td.append(mkBtn('btn rt-cell-retry', t('Retry', '重试'), () => { void runBatch('extract', 'cell', { docId: doc.id, colId: col.id, force: true }); }));
        tr.append(td);
        const mRow = mkBtn('rt-mcard-row', '', () => openInspector(doc.id, col.id)); mRow.dataset.docId = doc.id; mRow.dataset.colId = col.id;
        mRow.append(el('span', 'rt-mcard-k', reviewColLabel(col)), el('span', 'rt-mcard-v', valText), ...(badge.short ? [miniBadge(badge)] : [])); card.append(mRow);
      }
      tr.append(el('td', 'rt-cell-filler')); tbody.append(tr); cards.append(card);
    }
    grid.addEventListener('keydown', e => {
      const dirs: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      const delta = dirs[e.key], target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.rt-cell'); if (!delta || !target) return;
      const next = grid.querySelector<HTMLButtonElement>(`.rt-cell[data-row="${Number(target.dataset.row) + delta[0]}"][data-col="${Number(target.dataset.col) + delta[1]}"]`); if (!next) return;
      e.preventDefault(); next.focus({ preventScroll: true }); selected = { docId: next.dataset.docId!, colId: next.dataset.colId! }; syncGridSelection();
      if (inspector?.isOpen()) openInspector(selected.docId, selected.colId);
    });
    grid.append(thead, tbody); tableWrap.append(grid); setBody(tableWrap, cards); syncGridSelection();
  }

  const renderBody = () => { if (step === 'screening') renderScreening(); else renderExtraction(); syncRunning(); };
  const renderAll = () => { for (const [k, b] of stepBtns) b.setAttribute('aria-pressed', String(k === step)); if (presetSel && table) presetSel.value = table.preset; renderSubBar(); renderBody(); syncSplitAttr(); };
  return {
    id: 'review-table',
    async mount(host, ctx) {
      mounted = true; const seq = ++mountSeq; shell = ctx; stepBtns = new Map();
      const root = el('section', 'rt-view'), top = el('header', 'rt-top'), head = el('div', 'rt-head'), steps = el('div', 'rt-steps'), tools = el('div', 'rt-head-tools');
      topEl = top; steps.setAttribute('role', 'group'); steps.ariaLabel = t('Review steps', '筛选与提取步骤');
      for (const [id, en, zh] of [['screening', '1. Screening', '1. Screening 筛选'], ['extraction', '2. Extraction', '2. Extraction 提取']] as const) {
        const b = mkBtn('btn rt-step-btn', t(en, zh), () => { if (step !== id) { step = id; inspector?.close(); renderAll(); } }); b.dataset.step = id; stepBtns.set(id, b); steps.append(b);
      }
      const toolsToggle = mkBtn('btn rt-tools-toggle', t('Tools', '工具'), () => { const open = top.dataset.toolsOpen === 'true'; top.dataset.toolsOpen = String(!open); toolsToggle.setAttribute('aria-expanded', String(!open)); });
      toolsToggleEl = toolsToggle; toolsToggle.setAttribute('aria-expanded', 'false');
      presetSel = el('select', 'rt-select rt-preset-select'); presetSel.ariaLabel = t('Review preset', '预设模板');
      presetSel.append(new Option('CS / AI', 'cs_ai'), new Option(t('Medicine / Pharmacy PICO', '医学 / 药学 PICO'), 'pico'));
      presetSel.addEventListener('change', () => { void saveTablePatch({ preset: presetSel!.value as ReviewPresetId }, true); });
      const doExport = (fmt: ReviewExportFormat) => { if (!table) return; void api('review.export', { tableId: table.id, format: fmt, docIds: visibleDocs().map(d => d.id) }).then(r => { downloadFile(r.filename, r.content, r.mime); toast(t(`Exported ${r.filename}`, `已导出 ${r.filename}`)); }).catch(e => toast(message(e))); };
      tools.append(presetSel, mkBtn('btn rt-export-csv', 'CSV', () => doExport('csv')), mkBtn('btn rt-export-md', 'Markdown', () => doExport('markdown')));
      head.append(steps, toolsToggle, tools); subBarEl = el('div', 'rt-subbar'); top.append(head, subBarEl);
      splitEl = el('div', 'rt-split'); splitEl.dataset.inspectorOpen = 'false';
      const mainPane = el('div', 'rt-main-pane'); bodyEl = el('div', 'rt-body-scroll'); progressEl = el('div', 'rt-progress', statusMsg); progressEl.setAttribute('role', 'status'); mainPane.append(bodyEl);
      inspector = new ReviewTableInspector({
        onClose: syncSplitAttr, onRetry: (docId, colId) => runBatch('extract', 'cell', { docId, colId, force: true }),
        onSaveOverride: async (docId, colId, val, reason) => { try { await setManualCell(docId, colId, val, reason); toast(t('Saved manual override.', '已保存人工覆写。')); } catch (e) { toast(message(e)); } },
        onJump: (docId, page, quote) => { void shell?.inspectInReader({ docId, page, ...(quote ? { quote } : {}) }).catch(e => toast(message(e))); }
      });
      colPicker = new ReviewColumnPicker(col => table ? saveTablePatch({ columns: [...table.columns, col] }) : Promise.resolve(false));
      splitEl.append(mainPane, inspector.backdrop, inspector.root); root.append(top, splitEl, colPicker.backdrop, colPicker.root); host.replaceChildren(root);
      try { await loadData(); } catch (e) { if (mounted && seq === mountSeq) { setStatus(message(e)); toast(message(e)); } }
      const openCtx = ctx.openContext();
      if (mounted && seq === mountSeq && openCtx?.docId && openCtx !== lastOpenCtx) { lastOpenCtx = openCtx; step = 'extraction'; renderAll(); void runBatch('extract', 'reextract', { docId: openCtx.docId, docIds: [openCtx.docId] }); }
    },
    unmount() { mounted = false; ++mountSeq; abortCtrl?.abort(); abortCtrl = null; running = false; inspector = null; colPicker = null; splitEl = topEl = subBarEl = bodyEl = presetSel = progressEl = stopBtn = toolsToggleEl = null; },
    saveState(): SavedReviewState { return { step, selected: selected ? { ...selected } : null, inspectorOpen: Boolean(inspector?.isOpen()), activeScreenDocId, scrollTop: bodyEl?.scrollTop ?? 0, scrollLeft: bodyEl?.querySelector('.rt-table-wrap')?.scrollLeft ?? 0 }; },
    restoreState(raw) {
      const s = raw as SavedReviewState | undefined; if (!s || !mounted) return;
      step = s.step ?? 'extraction'; selected = s.selected ? { ...s.selected } : null; activeScreenDocId = s.activeScreenDocId ?? ''; renderAll();
      if (s.inspectorOpen && selected && hasCol(selected.colId)) openInspector(selected.docId, selected.colId);
      if (bodyEl) { bodyEl.scrollTop = s.scrollTop ?? 0; const tw = bodyEl.querySelector('.rt-table-wrap'); if (tw) tw.scrollLeft = s.scrollLeft ?? 0; }
    },
    handleEscape() { return colPicker?.isOpen() ? (colPicker.close(), true) : inspector?.isOpen() ? (inspector.close(), true) : false; },
    onDocumentMutated(docId, deleted) { if (!mounted) return; if (deleted && selected?.docId === docId) { inspector?.close(); selected = null; } void loadData(true).catch(() => undefined); }
  };
}
