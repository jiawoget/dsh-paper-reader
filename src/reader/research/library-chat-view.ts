import type { LibraryChatMessage, LibraryChatPreset, LibraryCitationRef } from '../../shared/research-types.js';
import { abstractOnlyLabel } from '../abstract-view.js';
import { answerMarkdown } from '../answer-markdown.js';
import { bindChatComposer, copyAnswerButton, createSendStopPair, createStreamSlot } from '../chat-stream.js';
import { api, apiStream, el, icon, message, readerLabel as t, sourceUrl, toast, undoLabel } from '../ui.js';
import { infoTip } from './icons.js';
import { researchText } from './labels.js';
import { LibraryChatScope, type ScopeSavedState } from './library-chat-scope.js';
import { isAbortError, mkBtn } from './paper-intake.js';
import type { ResearchShellContext, ResearchViewModule } from './state.js';

interface SavedNoteRef { noteId: string; updatedAt: string; docId: string; page: number }
interface ChatTurn {
  id: string; question: string; preset?: LibraryChatPreset; answer: string; citations: LibraryCitationRef[];
  usedDocIds: string[]; usedAbstractOnlyIds: string[]; truncatedCount: number; stopped?: boolean; savedNote?: SavedNoteRef;
}
interface SavedLibraryChatState { turns: ChatTurn[]; draft: string; logScrollTop: number; scope: ScopeSavedState }

const MAX_SCOPE = 30;
const PRESETS: readonly { id: LibraryChatPreset; label: () => string }[] = [
  { id: 'compare_methods', label: () => t('Compare methods', '对比研究方法') },
  { id: 'innovation_gaps', label: () => t('Innovation gaps', '挖掘创新空白') },
  { id: 'limitations_open_problems', label: () => t('Limitations & Open Problems', '局限与开放问题') },
  { id: 'cross_paper_disagreements', label: () => t('Cross-paper disagreements', '识别跨篇分歧') }
];

function matchCitation(item: string, refs: readonly LibraryCitationRef[]): LibraryCitationRef | undefined {
  const low = item.toLowerCase();
  for (const ref of refs) {
    const surname = ref.authorLabel.replace(/\bet\s+al\.?/i, '').trim().toLowerCase();
    if (!surname || !low.includes(surname) || !low.includes(ref.year.toLowerCase())) continue;
    if (ref.kind === 'abstract') { if (/\babstract\b/i.test(item)) return ref; continue; }
    if (ref.page !== undefined && /\b(?:pp?\.?|pages?)\b/i.test(item) && new RegExp(`(?:^|[\\s,;p.\\-])${ref.page}(?:$|[^\\d])`).test(item)) return ref;
  }
}

function makeCiteButton(turnId: string, ref: LibraryCitationRef, text: string): HTMLButtonElement {
  const btn = el('button', 'lc-cite', text);
  btn.type = 'button'; Object.assign(btn.dataset, { turnId, citeKey: ref.key, kind: ref.kind });
  btn.ariaLabel = `${ref.title}, ${ref.kind === 'abstract' ? abstractOnlyLabel() : researchText.pageBadge(ref.page ?? 1)}`;
  return btn;
}

function enrichCitations(body: HTMLElement, turnId: string, citations: readonly LibraryCitationRef[]): LibraryCitationRef[] {
  if (!citations.length) return [];
  const matched = new Set<string>(), nodes: Text[] = [], walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes('(') && n.parentElement && !n.parentElement.closest('code,pre,button,a,.katex')) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.textContent ?? '', frag = document.createDocumentFragment();
    let last = 0, changed = false;
    for (const m of text.matchAll(/\(([^()]{4,260})\)/g)) {
      const idx = m.index ?? 0, parts = m[1].split(/(\s*;\s*)/), hits = parts.map((p, i) => i % 2 === 0 ? matchCitation(p.trim(), citations) : undefined);
      if (!hits.some(Boolean)) continue;
      changed = true; if (idx > last) frag.append(text.slice(last, idx));
      if (parts.length === 1 && hits[0]) { matched.add(hits[0].key); frag.append(makeCiteButton(turnId, hits[0], m[0])); }
      else { frag.append('('); parts.forEach((p, i) => { const h = hits[i]; if (h) { matched.add(h.key); frag.append(makeCiteButton(turnId, h, p)); } else frag.append(p); }); frag.append(')'); }
      last = idx + m[0].length;
    }
    if (changed) { if (last < text.length) frag.append(text.slice(last)); node.replaceWith(frag); }
  }
  return citations.filter(c => !matched.has(c.key));
}

export function createLibraryChatView(): ResearchViewModule {
  let mounted = false, restored = false, reqSeq = 0, loadSeq = 0, pending = false, errorText = '', prevWidth = innerWidth;
  let ctrl: AbortController | null = null, events: AbortController | null = null, hideTimer: ReturnType<typeof setTimeout> | undefined;
  let shell: ResearchShellContext | undefined, scope: LibraryChatScope | undefined, viewEl: HTMLElement | undefined, logEl: HTMLElement | undefined, popoverEl: HTMLElement | undefined;
  let scopePillBtn: HTMLButtonElement | undefined, scopeToggleBtn: HTMLButtonElement | undefined, clearBtn: HTMLButtonElement | undefined;
  let capBannerEl: HTMLElement | undefined, errorBannerEl: HTMLElement | undefined, emptyScopeEl: HTMLElement | undefined;
  let inputEl: HTMLTextAreaElement | undefined, sendStop: ReturnType<typeof createSendStopPair> | undefined, streamSlot: ReturnType<typeof createStreamSlot> | undefined;
  let modelPicker: ReturnType<NonNullable<ResearchShellContext['createModelPicker']>> | undefined;
  let turns: ChatTurn[] = [], draft = '', streamText = '', activeQuestion = '';
  const savingTurns = new Set<string>();

  const cancelHide = () => { if (hideTimer !== undefined) { clearTimeout(hideTimer); hideTimer = undefined; } };
  const hidePopover = () => { cancelHide(); if (popoverEl) popoverEl.hidden = true; };
  const scheduleHide = () => { cancelHide(); hideTimer = setTimeout(() => { hideTimer = undefined; if (popoverEl) popoverEl.hidden = true; }, 140); };
  const abortStream = () => { ++reqSeq; ctrl?.abort(); ctrl = null; pending = false; streamSlot?.cancel(); };
  const canSubmit = () => !pending && Boolean(scope?.getSelectedDocs().length) && Boolean(inputEl?.value.trim());
  const findCitation = (turnId?: string, key?: string) => turns.find(x => x.id === turnId)?.citations.find(c => c.key === key);

  const showPopover = (btn: HTMLButtonElement) => {
    const ref = findCitation(btn.dataset.turnId, btn.dataset.citeKey); if (!ref || !popoverEl) return;
    cancelHide(); popoverEl.replaceChildren();
    const head = el('div', 'lc-pop-head');
    head.append(el('strong', 'lc-pop-title', ref.title), ref.kind === 'abstract' ? el('span', 'abstract-badge', abstractOnlyLabel()) : el('span', 'lc-pop-page', researchText.pageBadge(ref.page ?? 1)));
    popoverEl.append(head, el('blockquote', 'lc-pop-quote', ref.quote), el('div', 'lc-pop-hint', t('Click to open in Reader', '点击跳转原文精读')));
    popoverEl.hidden = false;
    const r = btn.getBoundingClientRect(), pw = popoverEl.offsetWidth, ph = popoverEl.offsetHeight;
    popoverEl.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pw - 8))}px`;
    popoverEl.style.top = `${r.top >= ph + 12 ? r.top - ph - 8 : Math.max(8, Math.min(r.bottom + 8, innerHeight - ph - 8))}px`;
  };

  const syncHeader = () => {
    const all = scope?.getAllDocs() ?? [], sel = scope?.getSelectedDocs() ?? [], absCount = sel.filter(d => d.kind === 'abstract').length, isOpen = Boolean(scope?.isOpen());
    if (viewEl) viewEl.dataset.scopeOpen = String(isOpen);
    scopeToggleBtn?.setAttribute('aria-expanded', String(isOpen));
    if (scopePillBtn) {
      scopePillBtn.textContent = t(`${sel.length} / ${all.length} papers`, `已选 ${sel.length} / ${all.length} 篇`) + (absCount ? t(` (${absCount} Abstract only)`, `（含 ${absCount} 篇仅摘要）`) : '');
      scopePillBtn.setAttribute('aria-expanded', String(isOpen));
    }
    if (capBannerEl) {
      capBannerEl.hidden = sel.length <= MAX_SCOPE;
      if (!capBannerEl.hidden) capBannerEl.textContent = t(`${sel.length} papers selected — analyzing the first ${MAX_SCOPE} papers. Narrow the scope panel to prioritize specific papers.`, `已选 ${sel.length} 篇文献——将优先分析前 ${MAX_SCOPE} 篇，可在右侧范围面板进一步筛选。`);
    }
    if (emptyScopeEl) emptyScopeEl.hidden = sel.length > 0 || !all.length;
    if (clearBtn) clearBtn.hidden = !turns.length || pending;
    for (const chip of logEl?.querySelectorAll<HTMLButtonElement>('.lc-preset-chip') ?? []) chip.disabled = pending || !sel.length;
    sendStop?.sync(pending, canSubmit());
  };

  const dropSavedNotes = (drop: (docId: string) => boolean) => {
    const stale = turns.filter(x => x.savedNote && drop(x.savedNote.docId));
    if (stale.length) { for (const x of stale) x.savedNote = undefined; if (mounted) renderLog(); }
  };
  const undoNote = async (turn: ChatTurn) => {
    const live = turns.find(x => x.id === turn.id), saved = (live ?? turn).savedNote; if (!saved || savingTurns.has(turn.id)) return;
    savingTurns.add(turn.id); renderLog();
    try { await api('note.delete', { id: saved.noteId, expectedUpdatedAt: saved.updatedAt }); turn.savedNote = undefined; if (live) live.savedNote = undefined; shell?.refreshNotebook?.(saved.docId); toast(t('Removed saved note.', '已撤销存入笔记。')); }
    catch (err) { toast(message(err)); } finally { savingTurns.delete(turn.id); if (mounted) renderLog(); }
  };
  const saveToNotes = async (turn: ChatTurn) => {
    if (savingTurns.has(turn.id) || turn.savedNote) return;
    const byId = new Map((scope?.getAllDocs() ?? []).map(d => [d.id, d])), firstCite = turn.citations.find(c => byId.has(c.docId));
    const target = (firstCite ? byId.get(firstCite.docId) : undefined) ?? turn.usedDocIds.map(id => byId.get(id)).find(Boolean) ?? scope?.getSelectedDocs()[0];
    if (!target) { toast(t('No target paper available to save this note.', '未找到可存入笔记的目标文献。')); return; }
    const page = firstCite?.page ?? 1; savingTurns.add(turn.id); renderLog();
    try {
      const { note } = await api('note.save', { docId: target.id, title: target.paperTitle || target.title, page, anchor: '', label: t('Library Chat', '文献库对话'), sourceUrl: sourceUrl(target.id, page), quote: turn.question.slice(0, 220), text: turn.answer });
      turn.savedNote = { noteId: note.id, updatedAt: note.updatedAt, docId: target.id, page }; shell?.refreshNotebook?.(target.id);
      toast(t('Saved to Notes.', '已存入笔记。'), [{ label: t('View', '查看'), run: () => shell?.inspectInReader({ docId: target.id, page, openNotes: true }) }, { label: undoLabel(), run: () => undoNote(turn) }]);
    } catch (err) { toast(message(err)); } finally { savingTurns.delete(turn.id); if (mounted) renderLog(); }
  };

  const renderTurn = (turn: ChatTurn): DocumentFragment => {
    const frag = document.createDocumentFragment(), uRow = el('div', 'lc-turn is-user'), aRow = el('div', `lc-turn is-assistant${turn.stopped ? ' is-stopped' : ''}`);
    uRow.append(el('span', 'lc-speaker', t('You', '我')), el('p', 'lc-user-text', turn.question));
    const aHead = el('div', 'lc-turn-head'), body = el('div', 'lc-answer-body');
    aHead.append(el('span', 'lc-speaker', t('Library Chat', '文献库对话')));
    if (turn.usedAbstractOnlyIds.length) aHead.append(el('span', 'abstract-badge', t(`${turn.usedAbstractOnlyIds.length} Abstract only`, `含 ${turn.usedAbstractOnlyIds.length} 篇仅摘要`)));
    body.dir = 'auto'; body.innerHTML = answerMarkdown(turn.answer, 0);
    const unmatched = enrichCitations(body, turn.id, turn.citations);
    aRow.append(aHead, body);
    if (unmatched.length) {
      const strip = el('div', 'lc-sources-strip');
      for (const ref of unmatched) strip.append(makeCiteButton(turn.id, ref, `(${ref.authorLabel}, ${ref.year}, ${ref.kind === 'abstract' ? abstractOnlyLabel() : researchText.pageBadge(ref.page ?? 1)})`));
      aRow.append(strip);
    }
    if (turn.stopped) { const cue = el('div', 'lc-stopped-bar', t('Stopped · partial response', '已停止 · 保留已生成内容')); cue.setAttribute('role', 'status'); aRow.append(cue); }
    const actions = el('div', 'lc-turn-actions'), busy = savingTurns.has(turn.id);
    const saveBtn = mkBtn(`btn lc-save-note${turn.savedNote ? ' is-saved' : ''}`, turn.savedNote ? t('✓ Saved', '✓ 已存入') : t('Save to Notes', '存入笔记'), () => { void saveToNotes(turn); });
    saveBtn.disabled = busy || Boolean(turn.savedNote); if (turn.savedNote) saveBtn.dataset.saved = 'true';
    actions.append(saveBtn);
    if (turn.savedNote) { const u = mkBtn('text-btn lc-undo-note', undoLabel(), () => { void undoNote(turn); }); u.disabled = busy; actions.append(u); }
    const copyBtn = copyAnswerButton(turn.answer); copyBtn.classList.add('lc-copy-btn'); actions.append(copyBtn);
    if (turn.stopped) actions.append(mkBtn('text-btn lc-retry-btn', t('Retry', '重试'), () => { void runChat(turn.question, turn.preset); }));
    aRow.append(actions); frag.append(uRow, aRow); return frag;
  };

  const renderLog = () => {
    if (!logEl) return;
    const prevTop = logEl.scrollTop; hidePopover(); logEl.replaceChildren();
    if (!turns.length && !pending) {
      const box = el('div', 'lc-welcome'), chips = el('div', 'lc-presets');
      for (const p of PRESETS) { const b = mkBtn('btn lc-preset-chip', p.label(), () => { void runChat(p.label(), p.id); }); b.dataset.preset = p.id; chips.append(b); }
      const wHead = el('div', 'lc-welcome-head');
      wHead.append(el('h2', 'lc-welcome-title', t('Ask across your local library', '跨文献库综合提问')), infoTip(t('Compare methods, surface limitations, spot disagreements, and inspect verifiable inline citations across selected papers.', '基于本地文献卡片与全文索引综合分析研究方法、局限与跨篇分歧，每条引文均可悬停核验并直跳原文。')));
      box.append(wHead, chips);
      logEl.append(box);
    } else {
      for (const turn of turns) logEl.append(renderTurn(turn));
      if (pending && streamSlot) {
        const uRow = el('div', 'lc-turn is-user'); uRow.append(el('span', 'lc-speaker', t('You', '我')), el('p', 'lc-user-text', activeQuestion));
        logEl.append(uRow, streamSlot.mount({ rowClass: 'lc-turn is-assistant', speakerClass: 'lc-speaker', speakerText: t('Library Chat', '文献库对话'), waitingText: t('Synthesizing across selected papers…', '正在综合分析已选文献…'), streamText }));
      }
    }
    if (errorBannerEl) { errorBannerEl.hidden = !errorText; errorBannerEl.textContent = errorText; }
    syncHeader(); if (!pending) logEl.scrollTop = prevTop;
  };

  const runChat = async (questionText: string, preset?: LibraryChatPreset) => {
    const q = questionText.trim(), sel = scope?.getSelectedDocs() ?? []; if (pending || !q || !sel.length) return;
    const usedIds = sel.slice(0, MAX_SCOPE).map(d => d.id), absIds = sel.slice(0, MAX_SCOPE).filter(d => d.kind === 'abstract').map(d => d.id);
    const history: LibraryChatMessage[] = turns.slice(-5).flatMap(x => [{ role: 'user' as const, content: x.question }, { role: 'assistant' as const, content: x.answer }]);
    const seq = ++reqSeq; ctrl = new AbortController(); pending = true; errorText = ''; streamText = ''; activeQuestion = q;
    if (!preset && inputEl) { inputEl.value = ''; draft = ''; }
    renderLog(); if (logEl) logEl.scrollTop = logEl.scrollHeight;
    try {
      const res = await apiStream('library.chat', { docIds: sel.map(d => d.id), ...(preset ? { preset } : { question: q }), history, questionModel: shell?.currentQuestionModel?.() ?? null }, delta => { if (mounted && seq === reqSeq) { streamText += delta; streamSlot?.push(streamText); } }, ctrl.signal);
      if (!mounted || seq !== reqSeq) return;
      streamSlot?.finish(); pending = false; ctrl = null;
      turns.push({ id: crypto.randomUUID(), question: q, preset, answer: res.answer, citations: res.citations ?? [], usedDocIds: res.usedDocIds ?? usedIds, usedAbstractOnlyIds: res.usedAbstractOnlyIds ?? absIds, truncatedCount: res.truncatedCount ?? 0 });
    } catch (err) {
      if (!mounted || seq !== reqSeq) return;
      const aborted = isAbortError(err) || Boolean(ctrl?.signal.aborted); streamSlot?.finish(); pending = false; ctrl = null;
      if (streamText.trim()) turns.push({ id: crypto.randomUUID(), question: q, preset, answer: streamText, citations: [], usedDocIds: usedIds, usedAbstractOnlyIds: absIds, truncatedCount: Math.max(0, sel.length - MAX_SCOPE), stopped: true });
      else if (!preset && inputEl && !inputEl.value) { inputEl.value = q; draft = q; }
      if (!aborted) { errorText = message(err); toast(errorText); }
    }
    renderLog(); if (logEl) logEl.scrollTop = logEl.scrollHeight;
  };

  const loadLibrary = async (initTopic?: string) => {
    const seq = ++loadSeq;
    try { const { docs } = await api('library.list', {}); if (mounted && seq === loadSeq) { const valid = new Set(docs.map(d => d.id)); scope?.setDocs(docs, initTopic); dropSavedNotes(id => !valid.has(id)); } }
    catch (err) { if (mounted && seq === loadSeq) toast(message(err)); }
  };

  return {
    id: 'library-chat',
    mount(host, ctx) {
      mounted = true; restored = false; shell = ctx; prevWidth = innerWidth; events = new AbortController();
      viewEl = el('section', 'lc-view'); viewEl.ariaLabel = t('Library Chat', '文献库对话');
      const chatPane = el('div', 'lc-chat-pane'), head = el('header', 'lc-head'), headRight = el('div', 'lc-head-actions'), toggleScope = () => { scope?.setOpen(!scope.isOpen()); syncHeader(); };
      scopePillBtn = mkBtn('btn lc-scope-pill', '', toggleScope); scopePillBtn.ariaLabel = t('Selected paper scope', '已选文献范围');
      clearBtn = mkBtn('text-btn lc-clear-btn', t('Clear', '清空'), () => { turns = []; errorText = ''; renderLog(); }); clearBtn.hidden = true;
      scopeToggleBtn = mkBtn('btn lc-scope-toggle', t('Scope', '文献范围'), toggleScope);
      headRight.append(clearBtn, scopeToggleBtn); head.append(el('h1', 'lc-title', t('Library Chat', '文献库对话')), scopePillBtn, headRight);
      capBannerEl = el('div', 'lc-cap-banner'); capBannerEl.setAttribute('role', 'status'); capBannerEl.hidden = true;
      errorBannerEl = el('div', 'lc-error-banner'); errorBannerEl.setAttribute('role', 'alert'); errorBannerEl.hidden = true;
      logEl = el('div', 'lc-log'); logEl.setAttribute('role', 'log'); logEl.setAttribute('aria-live', 'polite'); logEl.tabIndex = 0;
      streamSlot = createStreamSlot(logEl, () => 0); popoverEl = el('div', 'lc-popover'); popoverEl.setAttribute('role', 'tooltip'); popoverEl.hidden = true; logEl.addEventListener('scroll', hidePopover, { passive: true });
      const citeOf = (tEl: EventTarget | null) => tEl instanceof Element ? tEl.closest<HTMLButtonElement>('.lc-cite') : null;
      for (const ev of ['mouseover', 'focusin'] as const) logEl.addEventListener(ev, e => { const b = citeOf(e.target); if (b) showPopover(b); });
      for (const ev of ['mouseout', 'focusout'] as const) logEl.addEventListener(ev, e => { if (citeOf(e.target)) scheduleHide(); });
      logEl.addEventListener('click', e => { const b = citeOf(e.target), ref = b ? findCitation(b.dataset.turnId, b.dataset.citeKey) : undefined; if (ref) { hidePopover(); void shell?.inspectInReader({ docId: ref.docId, page: ref.page ?? 1, quote: ref.quote }).catch(err => toast(message(err))); } });
      emptyScopeEl = el('div', 'lc-empty-scope'); emptyScopeEl.hidden = true;
      emptyScopeEl.append(el('span', '', t('Select at least one paper in Paper Scope to ask questions.', '请先在文献范围中勾选至少 1 篇文献再提问。')), mkBtn('text-btn', t('Open Scope', '打开范围'), () => { scope?.setOpen(true); syncHeader(); }));
      const form = el('form', 'lc-composer'), row = el('div', 'lc-composer-row');
      inputEl = el('textarea', 'lc-input'); inputEl.rows = 2; inputEl.maxLength = 16_000; inputEl.value = draft;
      inputEl.ariaLabel = t('Ask across selected papers', '向已选文献提问'); inputEl.placeholder = t('Ask across selected papers… (Enter to send, Shift+Enter for newline)', '针对已选文献提问…（Enter 发送，Shift+Enter 换行）');
      inputEl.addEventListener('input', () => { draft = inputEl!.value; sendStop?.sync(pending, canSubmit()); });
      sendStop = createSendStopPair(() => { ctrl?.abort(); }); sendStop.stop.prepend(icon('close', 14));
      bindChatComposer(inputEl, form, canSubmit); form.addEventListener('submit', e => { e.preventDefault(); if (canSubmit()) void runChat(inputEl!.value); });
      row.append(inputEl, sendStop.send, sendStop.stop);
      modelPicker = ctx.createModelPicker?.();
      if (modelPicker) { const bar = el('div', 'lc-composer-bar'); bar.append(modelPicker.button); form.append(emptyScopeEl, bar, row); }
      else form.append(emptyScopeEl, row);
      chatPane.append(head, capBannerEl, errorBannerEl, logEl, form);
      scope = new LibraryChatScope({
        onChange: syncHeader, onClose: () => { syncHeader(); scopeToggleBtn?.focus({ preventScroll: true }); },
        onOpenDoc: docId => { void shell?.inspectInReader({ docId, page: 1 }).catch(err => toast(message(err))); },
        onAttachRow: (rowEl, doc) => shell?.paperFloatBar?.attach(rowEl, { doc, inLibrary: true })
      });
      viewEl.append(chatPane, scope.backdrop, scope.root, popoverEl); host.append(viewEl); renderLog();
      window.addEventListener('resize', () => { if (!mounted || !scope) return; if (prevWidth > 1080 && innerWidth <= 1080 && scope.isOpen()) { scope.setOpen(false); syncHeader(); } else if (prevWidth <= 1080 && innerWidth > 1080 && !scope.isOpen()) { scope.setOpen(true); syncHeader(); } prevWidth = innerWidth; }, { signal: events.signal });
      const topic = ctx.openContext()?.topic || ctx.activeTopic() || undefined;
      void Promise.resolve().then(() => Promise.resolve()).then(() => { if (mounted) void loadLibrary(restored ? undefined : topic); });
    },
    unmount() { mounted = false; events?.abort(); events = null; abortStream(); hidePopover(); modelPicker?.destroy(); modelPicker = undefined; scope = undefined; streamSlot = undefined; },
    saveState: (): SavedLibraryChatState => ({
      turns: turns.map(x => ({ ...x })), draft: inputEl?.value ?? draft, logScrollTop: logEl?.scrollTop ?? 0,
      scope: scope?.saveState() ?? { selectedIds: [], filter: '', open: true, collapsedSections: [], collapsedGroups: [], scrollTop: 0 }
    }),
    restoreState(raw) {
      if (!raw || typeof raw !== 'object') return;
      const s = raw as SavedLibraryChatState; restored = true; abortStream(); errorText = '';
      turns = Array.isArray(s.turns) ? s.turns.map(x => ({ ...x })) : []; draft = s.draft ?? '';
      if (inputEl) inputEl.value = draft; if (s.scope) scope?.restoreState(s.scope);
      renderLog(); if (logEl) logEl.scrollTop = s.logScrollTop ?? 0;
    },
    handleEscape() {
      if (popoverEl && !popoverEl.hidden) { hidePopover(); return true; }
      if (scope?.isOpen() && innerWidth <= 1080) { scope.setOpen(false); syncHeader(); scopeToggleBtn?.focus({ preventScroll: true }); return true; }
      return false;
    },
    onDocumentMutated(docId, deleted) { if (deleted) { scope?.removeDoc(docId); dropSavedNotes(id => id === docId); } if (mounted) void loadLibrary(); }
  };
}
