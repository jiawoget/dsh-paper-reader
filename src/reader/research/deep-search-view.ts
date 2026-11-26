import type { DeepSearchCandidate, DeepSearchProgressEvent, DeepSearchQuestion, DeepSearchResult, DeepSearchRoundMetric, DeepSearchStage } from '../../shared/deep-search-types.js';
import type { GraphPaper } from '../../shared/types.js';
import { answerMarkdown } from '../answer-markdown.js';
import { api, apiStream, el, message, readerLabel as t, safeWeb, toast } from '../ui.js';
import { researchViewName } from './labels.js';
import { formatDegradedSources, isAbortError, mkBtn, renderPaperActions, saveGraphPaper } from './paper-intake.js';
import type { ResearchOpenContext, ResearchShellContext, ResearchViewModule } from './state.js';
import { WatchlistDrawer } from './watchlist-drawer.js';

type DeepSearchMode = 'scoping' | 'telemetry' | 'results';
interface SavedDeepSearchState { mode: DeepSearchMode; query: string; rounds: number; questions: DeepSearchQuestion[]; answers: Record<string, string>; result: DeepSearchResult | null; activeCat: string; selectedIds: string[]; expandedAbs: string[]; scrollTop: number }
interface TelemetryState { round: number; totalRounds: number; stage: DeepSearchStage; evaluated: number; matched: number; message: string; curve: DeepSearchRoundMetric[]; degraded: string[]; candidates: DeepSearchCandidate[] }

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; };
const EXAMPLES = [() => t('How do serving engines eliminate KV-cache memory fragmentation in autoregressive generation?', '大语言模型推理引擎如何消除自回归生成中的 KV 缓存显存碎片？'), () => t('Randomized trials of GLP-1 receptor agonists for weight loss and cardiovascular outcomes in non-diabetic adults', '司美格鲁肽等减重药物在非糖尿病成人心血管结局中的随机对照试验'), () => t('Speculative decoding methods for accelerating autoregressive language model inference', '加速自回归语言模型推理的投机解码方法')];
const STAGE_LABELS: Record<DeepSearchStage, () => string> = { decompose: () => t('Decomposing', '拆解问题'), recall: () => t('Recalling', '多源召回'), score: () => t('Scoring', '相关性评估'), expand: () => t('Expanding', '扩词与引文滚雪球'), overview: () => t('Synthesizing', '生成综述') };
const seedOf = (p: GraphPaper): string => p.openAlexId || p.doi || (p.arxivId ? `arXiv:${p.arxivId}` : p.s2Id || p.title);
const matchTier = (score: number): { tier: 'high' | 'mid' | 'low'; mark: string } => score >= 80 ? { tier: 'high', mark: '★' } : score >= 60 ? { tier: 'mid', mark: '●' } : { tier: 'low', mark: '○' };

function buildSaturationSvg(curve: readonly DeepSearchRoundMetric[], totalRounds: number, compact = false): SVGSVGElement {
  const w = 460, h = compact ? 112 : 148, pl = 40, pr = 22, pt = 18, pb = 28, iw = w - pl - pr, ih = h - pt - pb, maxR = Math.max(totalRounds, curve.length, 2), maxY = Math.max(4, ...curve.map(c => c.matched));
  const summary = curve.length ? curve.map(c => `R${c.round}: ${c.matched}`).join(', ') : t('Collecting Round 1', '正在收集第 1 轮');
  const svg = svgEl('svg', { class: `ds-curve-svg${compact ? ' is-compact' : ''}`, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': t(`Discovery saturation curve (${summary})`, `发现饱和度曲线（${summary}）`) });
  const xAt = (r: number) => pl + (r / maxR) * iw, yAt = (v: number) => pt + ih - (v / maxY) * ih;
  for (const frac of [0, 0.5, 1]) { const y = pt + ih * (1 - frac); svg.append(svgEl('line', { class: 'ds-svg-grid', x1: pl, y1: y, x2: w - pr, y2: y }), svgEl('text', { class: 'ds-svg-axis', x: pl - 6, y: y + 4, 'text-anchor': 'end' }, String(Math.round(maxY * frac)))); }
  svg.append(svgEl('line', { class: 'ds-svg-axis-line', x1: pl, y1: pt, x2: pl, y2: pt + ih }), svgEl('line', { class: 'ds-svg-axis-line', x1: pl, y1: pt + ih, x2: w - pr, y2: pt + ih }));
  for (let r = 0; r <= maxR; r++) svg.append(svgEl('text', { class: 'ds-svg-axis', x: xAt(r), y: h - 8, 'text-anchor': 'middle' }, `R${r}`));
  if (!curve.length) { svg.append(svgEl('text', { class: 'ds-svg-empty', x: pl + iw / 2, y: pt + ih / 2 + 4, 'text-anchor': 'middle' }, t('Evaluating Round 1 candidates…', '正在评估第 1 轮候选文献…'))); return svg; }
  const pts = [{ r: 0, m: 0, n: 0 }, ...curve.map(c => ({ r: c.round, m: c.matched, n: c.newMatches }))], poly = pts.map(p => `${xAt(p.r).toFixed(1)},${yAt(p.m).toFixed(1)}`).join(' ');
  svg.append(svgEl('polygon', { class: 'ds-svg-area', points: `${xAt(0).toFixed(1)},${(pt + ih).toFixed(1)} ${poly} ${xAt(pts.at(-1)!.r).toFixed(1)},${(pt + ih).toFixed(1)}` }), svgEl('polyline', { class: 'ds-svg-line', points: poly }));
  for (const p of pts.slice(1)) { const cx = xAt(p.r), cy = yAt(p.m); svg.append(svgEl('circle', { class: 'ds-svg-dot', cx, cy, r: 4.5 }), svgEl('text', { class: 'ds-svg-val', x: cx, y: Math.max(12, cy - 8), 'text-anchor': 'middle' }, `${p.m} (+${p.n})`)); }
  return svg;
}

function linkOverviewCitations(body: HTMLElement, maxRank: number, onJump: (rank: number) => void): void {
  const nodes: Text[] = [], walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes('[#') && n.parentElement && !n.parentElement.closest('code,pre,button,a')) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.textContent ?? '', frag = document.createDocumentFragment(); let last = 0, changed = false;
    for (const m of text.matchAll(/\[#(\d+)\]/g)) {
      const rank = Number(m[1]), idx = m.index ?? 0; if (rank < 1 || rank > maxRank) continue;
      changed = true; if (idx > last) frag.append(text.slice(last, idx));
      const b = mkBtn('ds-cite-ref', m[0], () => onJump(rank)); b.dataset.rank = String(rank); b.ariaLabel = t(`Jump to result #${rank}`, `定位到第 ${rank} 条结果`);
      frag.append(b); last = idx + m[0].length;
    }
    if (changed) { if (last < text.length) frag.append(text.slice(last)); node.replaceWith(frag); }
  }
}

export function createDeepSearchView(): ResearchViewModule {
  let mounted = false, lastOpenCtx: ResearchOpenContext | undefined, reqSeq = 0, ctrl: AbortController | null = null, shell: ResearchShellContext | undefined;
  let mode: DeepSearchMode = 'scoping', query = '', rounds = 2, clarifying = false, sendingReview = false, activeCat = '', unreadCount = 0;
  let questions: DeepSearchQuestion[] = [], answers: Record<string, string> = {}, result: DeepSearchResult | null = null;
  let tel: TelemetryState = { round: 1, totalRounds: 2, stage: 'decompose', evaluated: 0, matched: 0, message: '', curve: [], degraded: [], candidates: [] };
  const selectedIds = new Set<string>(), expandedAbs = new Set<string>(), savingIds = new Set<string>(), cardSlots = new Map<string, HTMLElement>();
  let bodyEl: HTMLElement | undefined, headActionsEl: HTMLElement | undefined, wlBadgeEl: HTMLElement | undefined, wlBtnEl: HTMLButtonElement | undefined, watchlist: WatchlistDrawer | undefined;

  const abortActive = () => { ++reqSeq; ctrl?.abort(); ctrl = null; clarifying = false; };
  const buildPartialResult = (): DeepSearchResult => {
    const cands = tel.candidates.slice(), cats = new Map<string, number>();
    for (const c of cands) if (c.category) cats.set(c.category, (cats.get(c.category) ?? 0) + 1);
    const overview = cands.length ? cands.slice(0, 5).map((c, i) => `- [#${i + 1}] **${c.title}** — ${c.rationale}`).join('\n') : t('No papers had finished scoring before stop.', '停止前尚未完成首批文献评分。');
    return { query, overview, categories: [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 8), candidates: cands, roundsCompleted: tel.curve.length || tel.round, totalEvaluated: tel.evaluated, saturationCurve: tel.curve.map(m => ({ ...m })), degraded: [...tel.degraded], aborted: true };
  };
  const syncWatchlistBadge = () => { if (!wlBadgeEl) return; wlBadgeEl.hidden = unreadCount <= 0; wlBadgeEl.textContent = String(unreadCount); };
  const renderHeaderActions = () => {
    if (!headActionsEl || !wlBtnEl) return;
    headActionsEl.replaceChildren();
    if (mode === 'results') headActionsEl.append(
      mkBtn('btn ds-edit-scope-btn', t('Edit scope', '修改范围'), () => { mode = 'scoping'; render(); }),
      mkBtn('btn ds-new-search-btn', t('New search', '新建检索'), () => { query = ''; questions = []; answers = {}; result = null; activeCat = ''; selectedIds.clear(); expandedAbs.clear(); mode = 'scoping'; render(); })
    );
    headActionsEl.append(wlBtnEl); syncWatchlistBadge();
  };
  const syncCandidateInLibrary = (paperId: string, inLib: boolean, docId?: string) => {
    if (!result) return;
    for (const c of result.candidates) if ((paperId && c.id === paperId) || (docId && c.docId === docId)) {
      c.inLibrary = inLib; c.docId = inLib ? docId : undefined;
      const slot = cardSlots.get(c.id); if (mounted && slot) renderCardSlot(slot, c);
    }
  };
  const renderCardSlot = (slot: HTMLElement, cand: DeepSearchCandidate) => renderPaperActions(slot, cand, { prefix: 'ds', busy: savingIds.has(cand.id), openLabel: t('Open in Reader', '打开精读'), onOpen: docId => { void shell?.inspectInReader({ docId, page: 1 }).catch(e => toast(message(e))); }, onSave: saveMode => { void saveCandidateInPlace(cand, saveMode); } });
  const saveCandidateInPlace = async (cand: DeepSearchCandidate, saveMode: 'abstract' | 'oa-pdf'): Promise<string | undefined> => {
    if (savingIds.has(cand.id)) return cand.docId;
    const prevIn = Boolean(cand.inLibrary), prevDoc = cand.docId; savingIds.add(cand.id); syncCandidateInLibrary(cand.id, true, prevDoc);
    try { const doc = await saveGraphPaper(cand, saveMode, shell); savingIds.delete(cand.id); syncCandidateInLibrary(cand.id, true, doc.id); watchlist?.syncPaperInLibrary(cand.id, true, doc.id); return doc.id; }
    catch (err) { savingIds.delete(cand.id); syncCandidateInLibrary(cand.id, prevIn, prevDoc); toast(message(err)); return undefined; }
  };
  const runClarify = async () => {
    const q = query.trim(); if (!q) { toast(t('Enter a research question first.', '请先输入研究问题。')); return; }
    abortActive(); const seq = reqSeq; ctrl = new AbortController(); clarifying = true; render();
    try { const res = await api('deepSearch.clarify', { query: q }, false, ctrl.signal); if (!mounted || seq !== reqSeq) return; questions = res.questions; answers = {}; clarifying = false; render(); }
    catch (err) { if (mounted && seq === reqSeq && !isAbortError(err)) { clarifying = false; render(); toast(message(err)); } }
    finally { if (seq === reqSeq) ctrl = null; }
  };
  const startSearch = async (skipAnswers = false) => {
    const q = query.trim(); if (!q) { toast(t('Enter a research question first.', '请先输入研究问题。')); return; }
    abortActive(); const seq = reqSeq; ctrl = new AbortController();
    tel = { round: 1, totalRounds: rounds, stage: 'decompose', evaluated: 0, matched: 0, message: t('Decomposing research question…', '正在拆解研究问题…'), curve: [], degraded: [], candidates: [] };
    mode = 'telemetry'; activeCat = ''; selectedIds.clear(); expandedAbs.clear(); render();
    const cleanAnswers: Record<string, string> = {};
    if (!skipAnswers) for (const [k, v] of Object.entries(answers)) if (v.trim()) cleanAnswers[k] = v.trim();
    try {
      const res = await apiStream('deepSearch.run', { query: q, ...(Object.keys(cleanAnswers).length ? { answers: cleanAnswers } : {}), rounds, maxResults: 25 }, raw => {
        if (!mounted || seq !== reqSeq) return;
        try {
          const ev = JSON.parse(raw) as DeepSearchProgressEvent; if (ev.type !== 'progress') return;
          tel = { round: ev.round, totalRounds: ev.totalRounds, stage: ev.stage, evaluated: ev.evaluatedCount, matched: ev.matchedCount, message: ev.message, curve: ev.saturationCurve ?? tel.curve, degraded: ev.degraded ?? tel.degraded, candidates: ev.candidates ?? tel.candidates };
          if (mode === 'telemetry') renderTelemetry();
        } catch {}
      }, ctrl.signal);
      if (!mounted || seq !== reqSeq) return;
      result = res; mode = 'results'; render();
    } catch (err) {
      if (!mounted || seq !== reqSeq) return;
      if (isAbortError(err)) { if (mode !== 'results') { result = buildPartialResult(); mode = 'results'; render(); } return; }
      mode = 'scoping'; render(); toast(message(err));
    } finally { if (seq === reqSeq) ctrl = null; }
  };
  const stopAndKeepPartial = () => { if (mode !== 'telemetry') return; const partial = buildPartialResult(); abortActive(); result = partial; mode = 'results'; render(); };
  const sendToReviewTable = async () => {
    if (!result || !shell || sendingReview) return;
    sendingReview = true; renderResults();
    try {
      const chosen = selectedIds.size ? result.candidates.filter(c => selectedIds.has(c.id)) : result.candidates.slice(0, 5), topic = shell.activeTopic();
      const docs = topic ? (await api('library.list', {}).catch(() => ({ docs: [] }))).docs : [], byId = new Map(docs.map(d => [d.id, d]));
      for (const c of chosen) {
        const docId = c.inLibrary ? c.docId : await saveCandidateInPlace(c, 'abstract');
        if (docId && c.inLibrary && topic) { const tags = byId.get(docId)?.meta?.tags ?? []; if (!tags.includes(topic)) await api('library.triage', { docId, tags: [...tags, topic] }).catch(() => undefined); }
      }
      if (mounted) shell.openView('review-table');
    } finally { sendingReview = false; }
  };
  const openInCitationMap = (target?: DeepSearchCandidate) => {
    if (!result || !shell) return;
    const pick = target ?? (selectedIds.size ? result.candidates.find(c => selectedIds.has(c.id)) : result.candidates[0]);
    if (pick) shell.openView('citation-map', pick.inLibrary && pick.docId ? { seedDocId: pick.docId } : { query: seedOf(pick) });
  };
  const jumpToRank = (rank: number) => {
    if (!bodyEl || !result || !result.candidates[rank - 1]) return;
    if (activeCat && result.candidates[rank - 1].category !== activeCat) { activeCat = ''; renderResults(); }
    const card = bodyEl.querySelector<HTMLElement>(`.ds-card[data-rank="${rank}"]`); if (!card) return;
    card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    card.classList.remove('is-focused'); void card.offsetWidth; card.classList.add('is-focused'); card.tabIndex = -1; card.focus({ preventScroll: true });
  };

  const renderScoping = () => {
    if (!bodyEl) return;
    const wrap = el('div', 'ds-scoping'), form = el('form', 'ds-scope-form'), area = el('textarea', 'ds-query-input'), ctrls = el('div', 'ds-scope-controls');
    wrap.append(el('p', 'ds-scope-lead', t('Describe your research question in natural language to uncover relevant papers beyond exact keywords.', '用自然语言描述研究问题，突破字面关键词限制，多轮深挖相关文献。')));
    Object.assign(area, { rows: 4, maxLength: 1000, value: query, ariaLabel: t('Research question', '研究问题'), placeholder: t('e.g., How do serving systems eliminate KV-cache memory fragmentation in autoregressive generation?', '例如：大语言模型推理系统如何消除自回归生成中的 KV 缓存显存碎片？') });
    const rWrap = el('label', 'ds-rounds-wrap'), rSel = el('select', 'ds-rounds-select'); rSel.ariaLabel = t('Search depth rounds', '深搜轮次');
    rSel.append(new Option(t('2 rounds (Standard)', '2 轮（标准）'), '2'), new Option(t('3 rounds (Thorough)', '3 轮（深入）'), '3'));
    rSel.value = String(rounds); rSel.addEventListener('change', () => { rounds = Number(rSel.value) === 3 ? 3 : 2; });
    rWrap.append(el('span', 'ds-rounds-lbl', t('Depth', '深度')), rSel);
    const clarifyBtn = el('button', 'btn primary ds-clarify-btn', t('Clarify', 'Clarify 澄清范围')); clarifyBtn.type = 'submit';
    const skipBtn = mkBtn('btn ds-skip-btn', t('Skip clarification', '跳过澄清直接搜'), () => { void startSearch(true); });
    const syncBtns = () => { clarifyBtn.disabled = !query.trim() || clarifying; skipBtn.disabled = !query.trim(); };
    area.addEventListener('input', () => { query = area.value; syncBtns(); }); syncBtns();
    form.addEventListener('submit', e => { e.preventDefault(); void runClarify(); });
    ctrls.append(rWrap, clarifyBtn, skipBtn); form.append(area, ctrls); wrap.append(form);
    if (!query.trim() && !questions.length && !clarifying) {
      const exBox = el('div', 'ds-examples'), exList = el('div', 'ds-example-list'); exBox.append(el('span', 'ds-examples-lbl', t('Try an example', '示例问题')));
      for (const fn of EXAMPLES) { const txt = fn(); exList.append(mkBtn('btn ds-example-chip', txt, () => { query = txt; area.value = txt; syncBtns(); area.focus(); })); }
      exBox.append(exList); wrap.append(exBox);
    }
    if (clarifying || questions.length) {
      const panel = el('section', 'ds-clarify-panel'); panel.setAttribute('aria-label', t('Clarifying questions', 'Clarify 澄清问题'));
      if (clarifying) panel.append(el('p', 'ds-clarify-loading', t('Generating 2–4 focused clarifying questions…', '正在生成 2–4 个聚焦澄清问题…')));
      else {
        panel.append(el('h2', 'ds-clarify-title', t('Refine search scope', '确认检索范围')));
        for (const q of questions) {
          const card = el('div', 'ds-q-card'), opts = el('div', 'ds-q-options'); card.append(el('p', 'ds-q-text', q.question));
          for (const opt of q.options) { const chip = mkBtn('btn ds-opt-chip', opt, () => { if (answers[q.id] === opt) delete answers[q.id]; else answers[q.id] = opt; renderScoping(); }); chip.setAttribute('aria-pressed', String(answers[q.id] === opt)); opts.append(chip); }
          card.append(opts); panel.append(card);
        }
        const refine = el('input', 'search ds-refine-input'), actRow = el('div', 'ds-clarify-actions');
        Object.assign(refine, { type: 'text', maxLength: 400, value: answers._extra ?? '', ariaLabel: t('Additional scope constraints', '补充检索要求'), placeholder: t('Optional extra constraints (e.g., exclude surveys, focus on recent benchmarks)…', '可选补充要求（如排除综述、聚焦最新评测）…') });
        refine.addEventListener('input', () => { if (refine.value.trim()) answers._extra = refine.value; else delete answers._extra; });
        actRow.append(mkBtn('btn primary ds-start-btn', t('Start Deep Search', '开始深度检索'), () => { void startSearch(false); }), mkBtn('btn ds-reset-q-btn', t('Edit question', '重新澄清'), () => { questions = []; answers = {}; renderScoping(); }));
        panel.append(refine, actRow);
      }
      wrap.append(panel);
    }
    bodyEl.replaceChildren(wrap);
  };

  const renderTelemetry = () => {
    if (!bodyEl) return;
    const wrap = el('div', 'ds-telemetry'), banner = el('div', 'ds-tel-banner'), kpis = el('div', 'ds-kpi-grid'), curveCard = el('section', 'ds-curve-card'), foot = el('div', 'ds-tel-actions');
    banner.append(el('span', 'ds-round-pill', t(`Round ${tel.round} / ${tel.totalRounds}`, `第 ${tel.round} / ${tel.totalRounds} 轮`)), el('p', 'ds-tel-query', query));
    const msg = el('div', 'ds-tel-msg', tel.message || STAGE_LABELS[tel.stage]()); msg.setAttribute('role', 'status');
    for (const [key, lbl, val] of [['evaluated', t('Papers evaluated', '已评估文献'), String(tel.evaluated)], ['matched', t('Matches found', '高相关命中'), String(tel.matched)], ['stage', t('Current stage', '当前阶段'), STAGE_LABELS[tel.stage]()]] as const) {
      const c = el('div', 'ds-kpi'); c.dataset.kpi = key; c.append(el('span', 'ds-kpi-lbl', lbl), el('strong', 'ds-kpi-val', val)); kpis.append(c);
    }
    curveCard.append(el('h2', 'ds-curve-title', t('Discovery & Saturation Curve', '发现与饱和度曲线')), buildSaturationSvg(tel.curve, tel.totalRounds));
    wrap.append(banner, msg, kpis, curveCard);
    if (tel.degraded.length) { const deg = el('div', 'ds-degraded', formatDegradedSources(tel.degraded)); deg.setAttribute('role', 'status'); wrap.append(deg); }
    foot.append(mkBtn('btn ds-stop-btn', t('Stop & keep partial results', '停止并保留已有结果'), stopAndKeepPartial)); wrap.append(foot); bodyEl.replaceChildren(wrap);
  };

  const renderResults = () => {
    if (!bodyEl || !result) return;
    const prevTop = bodyEl.scrollTop, res = result; cardSlots.clear(); const wrap = el('div', 'ds-results');
    if (res.aborted) {
      const pBar = el('div', 'ds-partial-banner'), btns = el('div', 'ds-partial-actions'); pBar.setAttribute('role', 'status');
      const txt = res.candidates.length ? t(`Stopped early — showing ${res.candidates.length} partial matches.`, `已提前停止——保留 ${res.candidates.length} 篇部分命中结果。`) : t('Stopped before any batch finished scoring.', '在首批文献完成评分前已停止。');
      btns.append(mkBtn('btn', t('Back to scope', '返回修改范围'), () => { mode = 'scoping'; render(); }), mkBtn('btn primary', t('Retry', '重试'), () => { void startSearch(false); }));
      pBar.append(el('span', '', txt), btns); wrap.append(pBar);
    }
    if (res.degraded.length) { const deg = el('div', 'ds-degraded', formatDegradedSources(res.degraded)); deg.setAttribute('role', 'status'); wrap.append(deg); }
    if (!res.candidates.length) {
      const empty = el('div', 'ds-empty');
      empty.append(el('h2', 'ds-empty-title', t('No matching papers found', '未找到匹配文献')), el('p', 'ds-empty-desc', t('Try broadening your question or removing restrictive criteria.', '可尝试放宽研究问题描述或减少限定条件。')), mkBtn('btn primary ds-broaden-btn', t('Broaden scope', '放宽检索范围'), () => { mode = 'scoping'; render(); }));
      wrap.append(empty); bodyEl.replaceChildren(wrap); return;
    }
    const ovCard = el('section', 'ds-overview-card'), ovHead = el('div', 'ds-ov-head'), ovMeta = el('div', 'ds-ov-meta'), ovBody = el('div', 'ds-overview-body');
    ovMeta.append(el('span', 'ds-sat-pill', t(`${res.roundsCompleted} rounds · ${res.totalEvaluated} evaluated · ${res.candidates.length} matches`, `${res.roundsCompleted} 轮 · 评估 ${res.totalEvaluated} 篇 · 命中 ${res.candidates.length} 篇`)), mkBtn('btn ds-watch-search-btn', t('+ Watch this search', '+ 追踪此检索'), () => { void watchlist?.watchQuery(res.query); }));
    ovHead.append(el('h2', 'ds-ov-title', t('Executive Overview', '综述概览')), ovMeta);
    ovBody.dir = 'auto'; ovBody.innerHTML = answerMarkdown(res.overview, 0); linkOverviewCitations(ovBody, res.candidates.length, jumpToRank);
    ovCard.append(ovHead, ovBody, ...(res.saturationCurve.length ? [buildSaturationSvg(res.saturationCurve, res.roundsCompleted, true)] : []));
    const catBar = el('div', 'ds-cat-bar'); catBar.setAttribute('role', 'group'); catBar.ariaLabel = t('Filter by category', '按主题分类筛选');
    const allChip = mkBtn('btn ds-cat-chip', t(`All (${res.candidates.length})`, `全部 (${res.candidates.length})`), () => { activeCat = ''; renderResults(); });
    allChip.dataset.cat = ''; allChip.setAttribute('aria-pressed', String(!activeCat)); catBar.append(allChip);
    for (const cat of res.categories) { const cnt = res.candidates.filter(c => c.category === cat).length; if (!cnt) continue; const chip = mkBtn('btn ds-cat-chip', `${cat} (${cnt})`, () => { activeCat = activeCat === cat ? '' : cat; renderResults(); }); chip.dataset.cat = cat; chip.setAttribute('aria-pressed', String(activeCat === cat)); catBar.append(chip); }
    const visible = res.candidates.map((cand, idx) => ({ cand, rank: idx + 1 })).filter(x => !activeCat || x.cand.category === activeCat);
    const batch = el('div', 'ds-batch-bar'), selAllLbl = el('label', 'ds-sel-wrap'), selAllIn = el('input', 'ds-sel-check');
    selAllIn.type = 'checkbox'; selAllIn.checked = visible.length > 0 && visible.every(x => selectedIds.has(x.cand.id)); selAllIn.indeterminate = !selAllIn.checked && visible.some(x => selectedIds.has(x.cand.id));
    selAllIn.addEventListener('change', () => { for (const x of visible) if (selAllIn.checked) selectedIds.add(x.cand.id); else selectedIds.delete(x.cand.id); renderResults(); });
    selAllLbl.append(selAllIn, el('span', 'ds-sel-count', t(`${selectedIds.size} selected`, `已选 ${selectedIds.size} 篇`)));
    const unsavedSel = res.candidates.filter(c => selectedIds.has(c.id) && !c.inLibrary);
    const batchSave = mkBtn('btn ds-batch-save-btn', t('Save selected Abstract only', '批量仅摘要入库'), () => { void (async () => { for (const c of unsavedSel) await saveCandidateInPlace(c, 'abstract'); renderResults(); })(); }); batchSave.disabled = !unsavedSel.length;
    const toRev = mkBtn('btn primary ds-to-review-btn', t('Send to Review Table', '送入文献筛选与提取'), () => { void sendToReviewTable(); }); toRev.disabled = sendingReview;
    batch.append(selAllLbl, batchSave, toRev, mkBtn('btn ds-to-map-btn', t('Open in Citation Map', '在引文脉络中查看'), () => openInCitationMap()));
    const list = el('div', 'ds-cards');
    for (const { cand, rank } of visible) {
      const card = el('article', 'ds-card'), top = el('div', 'ds-card-top'), chkLbl = el('label', 'ds-sel-wrap'), chk = el('input', 'ds-sel-check');
      card.dataset.rank = String(rank); card.dataset.paperId = cand.id;
      chk.type = 'checkbox'; chk.checked = selectedIds.has(cand.id); chk.ariaLabel = t(`Select result #${rank}`, `勾选第 ${rank} 条结果`);
      chk.addEventListener('change', () => { if (chk.checked) selectedIds.add(cand.id); else selectedIds.delete(cand.id); renderResults(); });
      chkLbl.append(chk, el('span', 'ds-rank-num', `#${rank}`));
      const { tier, mark } = matchTier(cand.matchScore), pill = el('span', 'ds-match-pill', `${mark} ${cand.matchScore}%`); pill.dataset.tier = tier;
      top.append(chkLbl, pill, ...(cand.category ? [el('span', 'ds-cat-tag', cand.category)] : []), el('span', 'ds-round-tag', t(`R${cand.foundRound}`, `第 ${cand.foundRound} 轮`)));
      const href = safeWeb(cand.url) ?? (cand.doi ? safeWeb('https://doi.org/' + encodeURIComponent(cand.doi)) : undefined);
      let titleNode: HTMLElement;
      if (cand.inLibrary && cand.docId) titleNode = mkBtn('ds-title-btn', cand.title, () => { void shell?.inspectInReader({ docId: cand.docId!, page: 1 }).catch(e => toast(message(e))); });
      else if (href) { const a = el('a', 'ds-title-link', cand.title); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.addEventListener('click', e => { if (cand.inLibrary && cand.docId) { e.preventDefault(); void shell?.inspectInReader({ docId: cand.docId, page: 1 }).catch(err => toast(message(err))); } }); titleNode = a; }
      else titleNode = el('h3', 'ds-title-text', cand.title);
      const auth = cand.authors.length > 4 ? `${cand.authors.slice(0, 4).join(', ')} et al.` : cand.authors.join(', ');
      const meta = [auth, cand.year ? String(cand.year) : '', cand.venue ?? '', cand.citationCount !== undefined ? t(`${cand.citationCount} citations`, `${cand.citationCount} 次被引`) : ''].filter(Boolean).join(' · ');
      card.append(top, titleNode, el('p', 'ds-rationale', cand.rationale), el('p', 'ds-card-meta', meta));
      if (cand.abstract) {
        const exp = expandedAbs.has(cand.id), absWrap = el('div', 'ds-abs-wrap'), absBtn = mkBtn('text-btn ds-abs-toggle', exp ? t('Hide abstract', '收起摘要') : t('Show abstract', '展开摘要'), () => { if (exp) expandedAbs.delete(cand.id); else expandedAbs.add(cand.id); renderResults(); });
        absBtn.setAttribute('aria-expanded', String(exp)); absWrap.append(absBtn, ...(exp ? [el('p', 'ds-abs-text', cand.abstract)] : [])); card.append(absWrap);
      }
      const actions = el('div', 'ds-card-actions'), slot = el('div', 'ds-intake-slot'); renderCardSlot(slot, cand); cardSlots.set(cand.id, slot);
      actions.append(slot, mkBtn('btn ds-card-map-btn', researchViewName('citation-map'), () => openInCitationMap(cand))); card.append(actions); list.append(card);
    }
    wrap.append(ovCard, catBar, batch, list); bodyEl.replaceChildren(wrap); bodyEl.scrollTop = prevTop;
  };

  const render = () => { renderHeaderActions(); if (mode === 'scoping') renderScoping(); else if (mode === 'telemetry') renderTelemetry(); else renderResults(); };
  return {
    id: 'deep-search',
    mount(host, ctx) {
      mounted = true; shell = ctx;
      const openCtx = ctx.openContext(), startQ = openCtx?.query?.trim();
      if (startQ && openCtx !== lastOpenCtx) { lastOpenCtx = openCtx; query = startQ; questions = []; answers = {}; mode = 'scoping'; }
      const view = el('section', 'ds-view'), top = el('header', 'ds-top'); view.setAttribute('aria-label', researchViewName('deep-search'));
      headActionsEl = el('div', 'ds-head-actions');
      wlBtnEl = mkBtn('btn ds-wl-btn', t('Watchlist', 'Watchlist'), () => { if (watchlist?.isOpen()) watchlist.close(); else watchlist?.open(); });
      wlBadgeEl = el('span', 'ds-wl-badge'); wlBadgeEl.hidden = true; wlBtnEl.append(wlBadgeEl); wlBtnEl.setAttribute('aria-expanded', 'false');
      top.append(el('h1', 'ds-title', researchViewName('deep-search')), headActionsEl); bodyEl = el('div', 'ds-body');
      watchlist = new WatchlistDrawer({ shell: () => shell, currentQuery: () => (mode === 'results' && result?.query) || query, onClose: () => wlBtnEl?.setAttribute('aria-expanded', 'false'), onUnreadChange: n => { unreadCount = n; syncWatchlistBadge(); }, onPaperSaved: (p, docId) => syncCandidateInLibrary(p.id, true, docId) });
      const origOpen = watchlist.open.bind(watchlist); watchlist.open = () => { origOpen(); wlBtnEl?.setAttribute('aria-expanded', 'true'); };
      view.append(top, bodyEl, watchlist.backdrop, watchlist.root); host.replaceChildren(view); render(); void watchlist.refresh();
    },
    unmount() { mounted = false; abortActive(); watchlist?.unmount(); watchlist = undefined; cardSlots.clear(); },
    saveState: (): SavedDeepSearchState => ({ mode: mode === 'telemetry' ? (tel.candidates.length ? 'results' : 'scoping') : mode, query, rounds, questions: questions.map(q => ({ ...q, options: [...q.options] })), answers: { ...answers }, result: mode === 'telemetry' && tel.candidates.length ? buildPartialResult() : result, activeCat, selectedIds: [...selectedIds], expandedAbs: [...expandedAbs], scrollTop: bodyEl?.scrollTop ?? 0 }),
    restoreState(raw) {
      if (!raw || typeof raw !== 'object') return;
      const s = raw as SavedDeepSearchState; abortActive();
      mode = s.mode === 'results' && s.result ? 'results' : 'scoping'; query = s.query ?? ''; rounds = s.rounds === 3 ? 3 : 2;
      questions = Array.isArray(s.questions) ? s.questions : []; answers = s.answers ? { ...s.answers } : {}; result = s.result ?? null; activeCat = s.activeCat ?? '';
      selectedIds.clear(); for (const id of s.selectedIds ?? []) selectedIds.add(id);
      expandedAbs.clear(); for (const id of s.expandedAbs ?? []) expandedAbs.add(id);
      render(); if (bodyEl) bodyEl.scrollTop = s.scrollTop ?? 0;
    },
    handleEscape: () => watchlist?.isOpen() ? (watchlist.close(), true) : false,
    onDocumentMutated(docId, deleted) { if (deleted) { syncCandidateInLibrary('', false, docId); watchlist?.syncPaperInLibrary('', false, docId); } }
  };
}
