import type { QuestionCatalog, QuestionModel, Settings } from '../shared/types.js';
import { api, el, icon, message, readerLabel as label, type ReaderPort } from './ui.js';

const CATALOG_CACHE_KEY = 'reader.question-model.catalog';

export const questionConnected = (settings: Settings) => Boolean(settings.questionModel) || settings.aiMode !== 'unconfigured';

export function formatQuestionModelCaption(
  settings: Pick<Settings, 'aiMode' | 'hostProvider' | 'hostModel' | 'model' | 'questionModel'>,
  catalog?: QuestionCatalog
): { caption: string; providerName?: string } {
  const choice = settings.questionModel;
  if (choice) {
    const group = catalog?.groups.find(g => g.id === choice.provider);
    const entry = group?.models.find(m => m.id === choice.model);
    const effort = choice.reasoningEffort ? entry?.reasoning?.efforts.find(e => e.id === choice.reasoningEffort)?.name || choice.reasoningEffort : undefined;
    return { caption: [entry?.name || choice.model, effort].filter(Boolean).join(' · '), providerName: group?.name || choice.provider };
  }
  if (settings.aiMode === 'dsh' && settings.hostModel) {
    const group = settings.hostProvider ? catalog?.groups.find(g => g.id === settings.hostProvider) : undefined;
    const entry = (group?.models ?? catalog?.groups.flatMap(g => g.models))?.find(m => m.id === settings.hostModel);
    return { caption: entry?.name || settings.hostModel, providerName: group?.name || settings.hostProvider };
  }
  return { caption: settings.aiMode === 'api' && settings.model ? settings.model : '' };
}

interface TriggerHandle { app: ReaderPort; button: HTMLButtonElement; refresh(): void }
interface PopoverNodes {
  root: HTMLDivElement; list: HTMLDivElement; efforts: HTMLDivElement;
  effortRow: HTMLDivElement; status: HTMLParagraphElement; reload: HTMLButtonElement;
}

const triggers = new Set<TriggerHandle>();
let cachedCatalog: QuestionCatalog | undefined, catalogPrefetched = false, saving = false;
let catalogRequest: Promise<QuestionCatalog> | undefined, activeTrigger: TriggerHandle | undefined;
let popoverNodes: PopoverNodes | undefined, openEvents: AbortController | undefined, suppressToggle: TriggerHandle | undefined;

function readStoredCatalog(): QuestionCatalog | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const parsed = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) || 'null') as QuestionCatalog | null;
    return parsed && Array.isArray(parsed.groups) && Array.isArray(parsed.failures) ? parsed : undefined;
  } catch { return undefined; }
}

function fetchCatalog(): Promise<QuestionCatalog> {
  return catalogRequest ??= api('ai.models', {}).then(result => {
    catalogPrefetched = true; cachedCatalog = result;
    if (typeof localStorage !== 'undefined') try { localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(result)); } catch { undefined; }
    for (const handle of triggers) handle.refresh();
    return result;
  }).finally(() => { catalogRequest = undefined; });
}

function closePopover(restoreFocus: boolean): void {
  const target = activeTrigger?.button;
  if (popoverNodes?.root.matches(':popover-open')) popoverNodes.root.hidePopover();
  if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
}

function reposition(opening = false): void {
  if (!popoverNodes || !activeTrigger) return;
  const { root } = popoverNodes;
  if (!opening && !root.matches(':popover-open')) return;
  const rect = activeTrigger.button.getBoundingClientRect();
  if (!rect.width && !rect.height) { if (!opening) closePopover(false); return; }
  const width = root.offsetWidth || Math.min(296, innerWidth - 16), height = root.offsetHeight || 220;
  const spaceBelow = innerHeight - rect.bottom - 12, spaceAbove = rect.top - 12;
  const top = spaceBelow < height && spaceAbove > spaceBelow ? Math.max(8, rect.top - height - 6) : Math.max(8, Math.min(rect.bottom + 6, innerHeight - height - 8));
  root.style.left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)) + 'px';
  root.style.top = top + 'px';
}

function focusActiveOption(): void {
  (popoverNodes?.list.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)') ??
    popoverNodes?.list.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)'))?.focus({ preventScroll: true });
}

function renderPopoverContent(catalog?: QuestionCatalog, statusText?: string, showReload = false): void {
  if (!popoverNodes || !activeTrigger) return;
  const { app } = activeTrigger, { root, list, efforts, effortRow, status, reload } = popoverNodes;
  const active = document.activeElement, hadFocus = root.contains(active);
  const optIdx = active instanceof HTMLButtonElement ? Array.from(list.querySelectorAll<HTMLButtonElement>('[role="option"]')).indexOf(active) : -1;
  const pillIdx = active instanceof HTMLButtonElement ? Array.from(effortRow.querySelectorAll<HTMLButtonElement>('button')).indexOf(active) : -1;
  const selected = app.state.settings.questionModel;
  list.replaceChildren(); effortRow.replaceChildren();
  const applyChoice = async (next: QuestionModel | null, closeAfter: boolean) => {
    if (saving || !activeTrigger) return;
    saving = true; const owner = activeTrigger;
    renderPopoverContent(cachedCatalog, status.textContent || undefined, !reload.hidden);
    try {
      owner.app.state.settings.questionModel = (await api('ai.selectModel', { questionModel: next })).questionModel;
      saving = false;
      for (const handle of triggers) handle.refresh();
      if (closeAfter) closePopover(true);
      else { renderPopoverContent(cachedCatalog); reposition(); effortRow.querySelector<HTMLButtonElement>('[aria-pressed="true"], button')?.focus({ preventScroll: true }); }
      await owner.app.refresh();
    } catch (error) {
      saving = false;
      if (popoverNodes?.root.matches(':popover-open')) { renderPopoverContent(cachedCatalog, message(error), true); reposition(); }
    }
  };
  const makeOption = (captionText: string, active: boolean, onClick?: () => void, disabled = false) => {
    const opt = el('button', 'question-model-option'), check = icon('check', 13);
    opt.type = 'button'; opt.setAttribute('role', 'option'); opt.setAttribute('aria-selected', String(active)); opt.disabled = disabled || saving;
    check.classList.add('question-model-check'); opt.append(check, el('span', '', captionText));
    if (onClick) opt.onclick = onClick;
    return opt;
  };
  const defaultCaption = formatQuestionModelCaption({ ...app.state.settings, questionModel: undefined }, catalog).caption;
  list.append(makeOption(label('Reader default', '阅读器默认模型') + (defaultCaption ? ' · ' + defaultCaption : ''), !selected, () => { void applyChoice(null, true); }));
  let matchedSelected = !selected, optionCount = 0;
  for (const group of catalog?.groups ?? []) {
    if (!group.models.length) continue;
    list.append(el('div', 'question-model-group', group.name || group.id));
    for (const entry of group.models) {
      optionCount++;
      const isSelected = Boolean(selected && selected.provider === group.id && selected.model === entry.id);
      if (isSelected) matchedSelected = true;
      const hasEfforts = Boolean(entry.reasoning?.efforts.length);
      list.append(makeOption(entry.name || entry.id, isSelected, () => {
        const keepEffort = isSelected && selected?.reasoningEffort && entry.reasoning?.efforts.some(e => e.id === selected.reasoningEffort) ? selected.reasoningEffort : undefined;
        void applyChoice({ provider: group.id, model: entry.id, ...(keepEffort && { reasoningEffort: keepEffort }) }, !hasEfforts);
      }));
    }
  }
  if (selected && catalog && !matchedSelected) list.append(makeOption(selected.model + ' · ' + label('unavailable', '不可用'), true, undefined, true));
  const reasoning = selected ? catalog?.groups.find(g => g.id === selected.provider)?.models.find(m => m.id === selected.model)?.reasoning : undefined;
  const effortItems = reasoning?.efforts ?? [];
  efforts.hidden = !effortItems.length;
  let effortNote = '';
  if (effortItems.length && selected) {
    const currentEffort = selected.reasoningEffort, validEffort = !currentEffort || effortItems.some(e => e.id === currentEffort);
    if (!validEffort) effortNote = label('The saved effort is unavailable. Choose a new effort or use the model default.', '已保存的推理强度不可用，可重新选择或使用模型默认值。');
    const defaultEffort = reasoning?.defaultEffort ? effortItems.find(e => e.id === reasoning.defaultEffort)?.name || reasoning.defaultEffort : undefined;
    const addPill = (captionText: string, pressed: boolean, effortId?: string) => {
      const pill = el('button', 'question-model-effort', captionText);
      pill.type = 'button'; pill.setAttribute('aria-pressed', String(pressed)); pill.disabled = saving;
      pill.onclick = () => { void applyChoice({ provider: selected.provider, model: selected.model, ...(effortId && { reasoningEffort: effortId }) }, true); };
      effortRow.append(pill);
    };
    addPill(label('Model default', '模型默认') + (defaultEffort ? ' · ' + defaultEffort : ''), !currentEffort || !validEffort);
    for (const item of effortItems) addPill(item.name || item.id, currentEffort === item.id, item.id);
  }
  const failureNote = catalog?.failures.length
    ? label('Unavailable providers', '暂不可用的提供商') + ' · ' + catalog.failures.map(p => p.name || p.id).join(', ')
    : catalog && !optionCount ? label('DSH has no models available.', 'DSH 当前没有可用模型。') : '';
  status.textContent = statusText ?? (effortNote || failureNote);
  reload.hidden = !showReload && !(catalog && (!optionCount || catalog.failures.length > 0));
  if (hadFocus && !root.contains(document.activeElement)) {
    const target = (pillIdx >= 0 ? effortRow.querySelectorAll<HTMLButtonElement>('button')[pillIdx] : undefined)
      ?? (optIdx >= 0 ? list.querySelectorAll<HTMLButtonElement>('[role="option"]')[optIdx] : undefined);
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else if (saving) root.focus({ preventScroll: true });
    else focusActiveOption();
  }
}

async function loadIntoPopover(focusSelected = false): Promise<void> {
  if (!popoverNodes || !activeTrigger) return;
  const hadCatalog = Boolean(cachedCatalog), prev = hadCatalog ? JSON.stringify(cachedCatalog) : '';
  if (!hadCatalog) { renderPopoverContent(undefined, label('Loading DSH models…', '正在加载 DSH 模型…'), false); reposition(); }
  try {
    const catalog = await fetchCatalog();
    if (!popoverNodes.root.matches(':popover-open') || !activeTrigger) return;
    const hadFocus = popoverNodes.root.contains(document.activeElement);
    if (!hadCatalog || focusSelected || JSON.stringify(catalog) !== prev) { renderPopoverContent(catalog); reposition(); }
    if ((focusSelected || hadFocus) && !popoverNodes.root.contains(document.activeElement)) focusActiveOption();
  } catch (error) {
    if (!popoverNodes.root.matches(':popover-open')) return;
    renderPopoverContent(cachedCatalog, message(error) || label('Could not load the DSH model catalog.', '无法加载 DSH 模型列表。'), true); reposition();
  }
}

function ensurePopover(): PopoverNodes {
  if (popoverNodes) return popoverNodes;
  const root = el('div', 'question-model-popover'), head = el('div', 'question-model-head'), list = el('div', 'question-model-list');
  const efforts = el('div', 'question-model-efforts'), effortRow = el('div', 'question-model-effort-row'), status = el('p', 'question-model-status');
  const reload = el('button', 'text-btn question-model-reload', label('Reload models', '重新加载模型'));
  root.id = 'questionModelPopover'; root.popover = 'auto'; root.tabIndex = -1; root.setAttribute('role', 'dialog');
  root.ariaLabel = list.ariaLabel = label('Question model', '问答模型');
  head.append(el('strong', '', root.ariaLabel)); list.setAttribute('role', 'listbox');
  efforts.setAttribute('role', 'group'); efforts.ariaLabel = label('Reasoning effort', '推理强度'); efforts.hidden = true;
  efforts.append(el('span', 'question-model-efforts-label', efforts.ariaLabel), effortRow);
  status.setAttribute('role', 'status'); reload.type = 'button'; reload.hidden = true; reload.onclick = () => { void loadIntoPopover(true); };
  root.append(head, list, efforts, status, reload); document.body.append(root);
  root.addEventListener('beforetoggle', event => { if (event.newState === 'open') reposition(true); });
  root.addEventListener('toggle', () => {
    openEvents?.abort(); openEvents = undefined;
    if (root.matches(':popover-open') && activeTrigger) {
      activeTrigger.button.setAttribute('aria-expanded', 'true');
      const { signal } = openEvents = new AbortController();
      window.addEventListener('resize', () => reposition(), { signal });
      window.addEventListener('scroll', event => { if (event.target !== root) reposition(); }, { capture: true, signal });
      if (cachedCatalog) { renderPopoverContent(cachedCatalog); reposition(); focusActiveOption(); }
      void loadIntoPopover(!cachedCatalog);
    } else if (activeTrigger) { activeTrigger.button.setAttribute('aria-expanded', 'false'); activeTrigger = undefined; }
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePopover(true); return; }
    const items = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (!items.length || (index < 0 && document.activeElement !== root && document.activeElement !== list)) return;
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index <= 0 ? items.length - 1 : index - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); items[next].focus({ preventScroll: true });
  });
  return popoverNodes = { root, list, efforts, effortRow, status, reload };
}

export function questionModelButton(app: ReaderPort) {
  cachedCatalog ??= readStoredCatalog();
  const button = el('button', 'text-btn question-model-trigger'), caption = el('span', 'question-model-name'), chevron = icon('next', 12);
  chevron.classList.add('question-model-chevron');
  button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'questionModelPopover'); button.append(icon('settings', 13), caption, chevron);
  const refresh = () => {
    const resolved = formatQuestionModelCaption(app.state.settings, cachedCatalog), text = resolved.caption || label('Choose model', '选择模型');
    caption.textContent = text;
    button.ariaLabel = button.title = [label('Question model', '问答模型'), resolved.providerName, text].filter(Boolean).join(' · ');
    if (!catalogPrefetched && !catalogRequest && (app.state.settings.aiMode === 'dsh' || app.state.settings.questionModel)) void fetchCatalog().catch(() => undefined);
  };
  const handle: TriggerHandle = { app, button, refresh };
  triggers.add(handle);
  button.onpointerdown = () => { suppressToggle = activeTrigger === handle && popoverNodes?.root.matches(':popover-open') ? handle : undefined; };
  button.onkeydown = button.onpointercancel = () => { suppressToggle = undefined; };
  button.onclick = () => {
    if (suppressToggle === handle) { suppressToggle = undefined; return; }
    suppressToggle = undefined;
    const nodes = ensurePopover();
    if (nodes.root.matches(':popover-open')) {
      if (activeTrigger === handle) { nodes.root.hidePopover(); return; }
      activeTrigger?.button.setAttribute('aria-expanded', 'false'); activeTrigger = handle;
      button.setAttribute('aria-expanded', 'true'); renderPopoverContent(cachedCatalog); reposition(); focusActiveOption(); void loadIntoPopover(true);
      return;
    }
    if (activeTrigger && activeTrigger !== handle) activeTrigger.button.setAttribute('aria-expanded', 'false');
    activeTrigger = handle; nodes.root.showPopover();
  };
  refresh();
  return { button, refresh, destroy() { triggers.delete(handle); if (activeTrigger === handle) closePopover(false); } };
}
