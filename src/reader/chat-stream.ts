import { answerMarkdown } from './answer-markdown.js';
import { button, copyText, el, readerLabel as label, toast } from './ui.js';

interface StreamSlot {
  mount(opts: { rowClass: string; speakerClass: string; speakerText: string; waitingText: string; streamText?: string }): HTMLElement;
  push(text: string): void;
  finish(): void;
  cancel(): void;
}

export function createChatLog(css: string, ariaLabel: string, onJumpPage?: (page: number) => void): HTMLDivElement {
  const log = el('div', css);
  log.setAttribute('role', 'log'); log.ariaLabel = ariaLabel; log.setAttribute('aria-live', 'polite'); log.tabIndex = 0;
  if (onJumpPage) log.addEventListener('click', event => {
    const chip = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.page-cite-chip[data-page]') : null;
    const page = Number(chip?.dataset.page);
    if (chip && Number.isInteger(page) && page >= 1) onJumpPage(page);
  });
  return log;
}

export function createStreamSlot(log: HTMLElement, maxPage?: () => number, intervalMs = 80): StreamSlot {
  let target: HTMLElement | undefined, latest = '', rendered = '', lastRender = -intervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined, raf = 0;
  const paint = () => {
    raf = 0;
    if (!target || latest === rendered) return;
    const atBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 32;
    target.innerHTML = answerMarkdown(latest, maxPage?.() ?? 0); rendered = latest; lastRender = performance.now();
    if (atBottom) log.scrollTop = log.scrollHeight;
  };
  const stop = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  return {
    mount(opts) {
      stop();
      const row = el('div', opts.rowClass + ' is-streaming'), body = el('div', 'chat-stream-body');
      body.dir = 'auto'; target = body; latest = rendered = opts.streamText || ''; lastRender = -intervalMs;
      if (opts.streamText) body.innerHTML = answerMarkdown(opts.streamText, maxPage?.() ?? 0);
      else body.append(el('p', 'chat-stream-wait', opts.waitingText));
      row.append(el('span', opts.speakerClass, opts.speakerText), body);
      return row;
    },
    push(text) {
      latest = text;
      if (!target || raf || timer !== undefined) return;
      const wait = intervalMs - (performance.now() - lastRender);
      if (wait <= 0) raf = requestAnimationFrame(paint);
      else timer = setTimeout(() => { timer = undefined; raf = requestAnimationFrame(paint); }, wait);
    },
    finish() { stop(); paint(); target = undefined; },
    cancel() { stop(); target = undefined; }
  };
}

export function settleStreamFailure(opts: {
  aborted: boolean; streamText?: string;
  restoreDraft: () => void; onStopped: (answer: string) => void; onError: () => void;
}): void {
  if (opts.aborted) { if (opts.streamText?.trim()) opts.onStopped(opts.streamText); else opts.restoreDraft(); }
  else { if (!opts.streamText?.trim()) opts.restoreDraft(); opts.onError(); }
}

export function bindChatComposer(textarea: HTMLTextAreaElement, form: HTMLFormElement, canSubmit: () => boolean): void {
  textarea.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (canSubmit()) form.requestSubmit();
    }
  };
}

export function createSendStopPair(onStop: () => void) {
  const send = el('button', 'btn primary', label('Send', '发送')), stop = el('button', 'btn chat-stop', label('Stop', '停止'));
  send.type = 'submit'; stop.type = 'button'; stop.hidden = true; stop.onclick = onStop;
  return {
    send, stop,
    sync(pending: boolean, canSend: boolean) { send.hidden = pending; send.disabled = pending || !canSend; stop.hidden = !pending; }
  };
}

export function renderChatNotice(node: HTMLElement, opts: {
  disconnected: boolean; disconnectedText: string; error?: string; onRetry?: () => unknown; onConnect?: () => unknown;
}): void {
  node.replaceChildren();
  const showError = Boolean(opts.error);
  node.hidden = !showError && !opts.disconnected;
  if (node.hidden) return;
  node.setAttribute('role', showError ? 'alert' : 'status');
  node.append(el('span', '', showError ? opts.error! : opts.disconnectedText));
  if (showError && opts.onRetry) node.append(button(label('Retry', '重试'), opts.onRetry, 'text-btn'));
  if (opts.onConnect) node.append(button(label('Connections', '连接设置'), opts.onConnect, 'text-btn'));
}

function chatAnswerTools(opts: { text: string; onDelete?: () => unknown }): HTMLElement {
  const tools = el('div', 'chat-answer-tools');
  tools.addEventListener('mousedown', event => { if (event.target instanceof Element && event.target.closest('button')) event.preventDefault(); });
  tools.append(button(label('Copy', '复制'), async () => {
    toast(await copyText(opts.text) ? label('Copied to clipboard.', '已复制到剪贴板。') : label('Copy was blocked by this browser.', '浏览器阻止了复制。'));
  }, 'text-btn'));
  if (opts.onDelete) tools.append(button(label('Delete', '删除'), opts.onDelete, 'text-btn chat-delete-btn'));
  return tools;
}

export function renderQuestionRow(opts: {
  rowClass: string; speakerClass: string; headerClass?: string; quoteClass: string;
  text: string; quote?: string; source?: HTMLElement;
}): HTMLDivElement {
  const row = el('div', opts.rowClass), speaker = el('span', opts.speakerClass, label('You', '我'));
  if (opts.headerClass) {
    const header = el('div', opts.headerClass);
    header.append(speaker);
    if (opts.source) header.append(opts.source);
    row.append(header);
  } else row.append(speaker);
  if (opts.quote) row.append(el('blockquote', opts.quoteClass, opts.quote));
  if (!opts.headerClass && opts.source) row.append(opts.source);
  const body = el('p', '', opts.text); body.dir = 'auto'; row.append(body);
  return row;
}

export function renderAnswerRow(opts: {
  rowClass: string; speakerClass: string; speakerText: string; bodyClass: string;
  actionsClass: string; content: string; maxPage?: number; dataset: Record<string, string | undefined>;
  quote?: { css: string; text: string }; beforeActions?: HTMLElement; actions: HTMLElement[]; onDelete?: () => unknown;
}): HTMLDivElement {
  const row = el('div', opts.rowClass), body = el('div', opts.bodyClass), actions = el('div', opts.actionsClass);
  body.dir = 'auto'; body.tabIndex = -1;
  for (const [k, v] of Object.entries(opts.dataset)) if (v !== undefined) body.dataset[k] = v;
  body.innerHTML = answerMarkdown(opts.content, opts.maxPage);
  row.append(el('span', opts.speakerClass, opts.speakerText));
  if (opts.quote) row.append(el('blockquote', opts.quote.css, opts.quote.text));
  row.append(body);
  if (opts.beforeActions) row.append(opts.beforeActions);
  actions.append(...opts.actions, chatAnswerTools({ text: opts.content, onDelete: opts.onDelete }));
  row.append(actions);
  return row;
}

export function renderStoppedReply(opts: {
  rowClass: string; speakerClass: string; speakerText: string; answer: string; maxPage?: number; onRetry: () => unknown; onDelete: () => unknown;
}): HTMLElement {
  const row = el('div', opts.rowClass + ' is-stopped'), body = el('div', 'chat-stopped-body'), bar = el('div', 'chat-stopped-bar');
  body.dir = 'auto'; body.innerHTML = answerMarkdown(opts.answer, opts.maxPage);
  bar.setAttribute('role', 'status');
  bar.append(el('span', 'chat-stopped-label', label('Generation stopped', '已停止生成')),
    button(label('Retry', '重试'), opts.onRetry, 'text-btn'), chatAnswerTools({ text: opts.answer, onDelete: opts.onDelete }));
  row.append(el('span', opts.speakerClass, opts.speakerText), body, bar);
  return row;
}

export function createClearChatControl(onClear: () => Promise<void>) {
  const root = el('div', 'chat-clear-group');
  let confirming = false, busy = false, visible = false;
  const syncView = () => {
    root.hidden = !visible; clearBtn.hidden = confirming; confirmBtn.hidden = cancelBtn.hidden = !confirming;
    clearBtn.disabled = confirmBtn.disabled = cancelBtn.disabled = busy;
  };
  const clearBtn = button(label('Clear chat', '清空对话'), () => { confirming = true; syncView(); confirmBtn.focus({ preventScroll: true }); }, 'text-btn chat-clear-btn');
  const confirmBtn = button(label('Confirm clear', '确认清空'), async () => {
    busy = true; syncView();
    try { await onClear(); confirming = false; } finally { busy = false; syncView(); }
  }, 'text-btn chat-delete-btn');
  const cancelBtn = button(label('Cancel', '取消'), () => { confirming = false; syncView(); clearBtn.focus({ preventScroll: true }); }, 'text-btn');
  root.append(clearBtn, confirmBtn, cancelBtn); syncView();
  return {
    root,
    sync(show: boolean, pending = false) { visible = show; busy = pending; if (!show) confirming = false; syncView(); },
    reset() { confirming = false; syncView(); }
  };
}
