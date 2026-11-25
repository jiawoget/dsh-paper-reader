import type { RegionIntent, SelectionHit, SourceRecord } from '../shared/types.js';
import { DEFAULT_TARGET_LANGUAGE, targetLanguageBcp47 } from '../shared/languages.js';
import { quoteLocator, writeSelectionRange, writeTranslatedLocator } from '../shared/source-link.js';
import { hasPassageGutter, positionPassageCard } from './floating-position.js';
import type { PdfPageView } from './pdf-view.js';
import type { DiscussionRef } from './discussion-drafts.js';
import { discussionId } from './passage-links.js';
import { correspondingText, pairSelection } from './pdf/alignment.js';
import { selectionRange } from './saved-selection.js';
import { buildCardActions, excerpt, passagePreview, SelectionWorkspace } from './selection-workspace.js';
import { chatSource, conversationThread, materialKey, type SelectionContext } from './selection-context.js';
import { api, button, byId, el, icon, message, readerLabel, sourceUrl, toast, type ReaderPort } from './ui.js';

function isTerm(text: string): boolean {
  if (text.length > 56 || /[\r\n。！？；，、!?;:]|\.(?:\s|$)/u.test(text)) return false;
  const ideographs = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  return (ideographs?.length ?? 0) <= 8 && text.trim().split(/\s+/u).length <= 4;
}

type PassageTool = 'note' | 'chat';

export class SelectionCard {
  private events?: AbortController;
  private readonly workspace: SelectionWorkspace;
  private updatePreview?: () => void;
  private fit?: () => void;
  private closeMoreMenu?: (restoreFocus?: boolean) => boolean;
  private activeHit?: SelectionHit;
  private opener?: HTMLButtonElement;
  private readonly back = byId<HTMLButtonElement>('returnDiscussion');
  private returnAcrossPages?: () => Promise<void>;
  private generation = 0;

  constructor(private readonly app: ReaderPort) {
    this.workspace = new SelectionWorkspace(app);
    this.back.append(icon('chat', 14), readerLabel('Back to discussion', '返回讨论'));
    this.back.onclick = () => this.returnFromSource();
  }

  returnFromSource(): void {
    if (this.back.hidden) return;
    const reopen = this.returnAcrossPages;
    if (reopen) {
      this.returnAcrossPages = undefined;
      this.back.hidden = true;
      void reopen().catch(error => toast(message(error)));
      return;
    }
    if (!this.activeHit) return;
    this.back.hidden = true;
    const card = byId('card');
    card.hidden = false;
    byId('selectionDock').hidden = false;
    this.fit?.();
    card.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus({ preventScroll: true });
  }

  get currentQuestion(): DiscussionRef | undefined { return this.workspace.currentQuestion; }
  get discussionVisible(): boolean { return !byId('card').hidden && byId('card').dataset.workspace === 'chat'; }

  offerReturn(reopen: () => Promise<void>): void {
    this.returnAcrossPages = reopen;
    this.back.hidden = false;
  }

  discussionPosition(): () => void {
    const card = byId('card');
    const field = card.querySelector<HTMLTextAreaElement>('.chat-composer textarea');
    const start = field?.selectionStart ?? 0, end = field?.selectionEnd ?? start;
    const top = card.querySelector('.selection-chat-log')?.scrollTop ?? 0;
    return () => {
      const input = card.querySelector<HTMLTextAreaElement>('.chat-composer textarea');
      input?.focus({preventScroll: true});
      input?.setSelectionRange(start, end);
      card.querySelector('.selection-chat-log')?.scrollTo({ top });
    };
  }
  inspectSource(): boolean {
    const card = byId('card');
    if (!this.back.hidden) return Boolean(this.activeHit && !this.returnAcrossPages);
    if (!this.activeHit || card.hidden || card.dataset.workspace !== 'chat') return false;
    this.back.hidden = false;
    card.hidden = true;
    byId('selectionDock').hidden = true;
    return true;
  }

  get hasOpenTool(): boolean { return Boolean(this.activeHit && byId('card').dataset.workspace); }

  inspectMark(): void { if (!this.inspectSource()) this.close(); }

  refresh(): void {
    this.updatePreview?.();
    this.workspace.refresh();
  }

  exchangeDeleted(thread: string, requestId: string): void { this.workspace.exchangeDeleted(thread, requestId); }

  revealIn(pane: HTMLElement): void {
    const hit = this.activeHit;
    if (!hit || hit.regionText !== undefined || !this.back.hidden) return;
    const mark = Array.from(pane.querySelectorAll('.pdf-quote-mark, .reading-passage.is-selected, .pdf-anchor.is-active'))
      .find(node => node.getClientRects().length);
    const options = { block: 'nearest', inline: 'nearest', behavior: 'instant' } as const;
    mark?.scrollIntoView(options);
    const row = pane.querySelector('.web-reading-row[data-anchor="' + CSS.escape(hit.id) + '"]');
    if (row) {
      // The article can resize its paired rows after a pane becomes visible.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (this.activeHit === hit && row.getClientRects().length) {
          row.scrollIntoView(options);
          this.fit?.();
        }
      }));
    }
    this.fit?.();
  }

  dismiss(restoreFocus = false): void {
    if (this.closeMoreMenu?.(restoreFocus)) return;
    const card = byId('card');
    if (restoreFocus && card.dataset.workspace) {
      if (card.dataset.workspace === 'chat') card.querySelector<HTMLButtonElement>('.chat-heading .chat-close')?.click();
      else this.leaveTool();
      return;
    }
    this.close(true, restoreFocus);
  }

  close(clearNative = true, restoreFocus = false, next?: SelectionHit): void {
    this.generation++;
    this.returnAcrossPages = undefined;
    this.back.hidden = true;
    this.closeMoreMenu?.(false);
    this.closeMoreMenu = undefined;
    if (!this.events) { this.activeHit = undefined; return; }
    this.events.abort();
    this.events = undefined;
    const trigger = this.activeHit?.trigger;
    const leftRegion = this.activeHit?.regionText !== undefined && next?.regionText === undefined;
    this.activeHit = undefined;
    this.opener = undefined;
    this.updatePreview = this.fit = undefined;
    this.app.paperSelection?.();
    this.app.view?.select();
    this.workspace.close();
    if (clearNative) {
      const selection = window.getSelection();
      const insidePaper = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest('#original, #translated');
      if (selection && insidePaper(selection.anchorNode) && insidePaper(selection.focusNode)) selection.removeAllRanges();
    }
    const card = byId('card');
    card.hidden = true;
    card.replaceChildren();
    card.removeAttribute('style');
    delete card.dataset.docked;
    delete card.dataset.gutter;
    delete card.dataset.workspace;
    delete card.dataset.preview;
    byId('selectionDock').hidden = true;
    document.body.insertBefore(card, byId('dialog'));
    if (restoreFocus) (trigger?.getClientRects().length ? trigger : byId('paperScroll')).focus({ preventScroll: true });
    if (leftRegion) this.app.regionDiscussionClosed?.(restoreFocus);
  }

  private place(docked: boolean): void {
    const container = byId('selectionDock'), card = byId('card');
    if (docked === (card.parentElement === container)) return;
    const focused = card.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    card.removeAttribute('style');
    if (docked) {
      card.dataset.docked = 'true';
      delete card.dataset.gutter;
      container.hidden = false;
      container.append(card);
      const pane = byId(byId('reader').dataset.compactLanguage === 'translation' ? 'translated' : 'original');
      const active = this.activeHit;
      requestAnimationFrame(() => { if (this.activeHit === active) this.revealIn(pane); });
    } else {
      delete card.dataset.docked;
      document.body.insertBefore(card, byId('dialog'));
      container.hidden = true;
    }
    if (focused?.getClientRects().length) focused.focus({ preventScroll: true });
  }

  private leaveTool(): void {
    const card = byId('card');
    const trigger = card.dataset.workspace === 'chat' ? this.opener : card.querySelector<HTMLButtonElement>('.selection-note-action');
    delete card.dataset.workspace;
    this.fit?.();
    trigger?.focus({ preventScroll: true });
  }

  private sourceRecord(hit: SelectionHit): SourceRecord {
    const { doc } = this.app;
    return { docId: doc.id, title: doc.title, page: hit.page, anchor: hit.id, label: hit.label,
      sourceUrl: sourceUrl(doc.id, hit.page, hit.id) };
  }

  async openRegion(hit: SelectionHit, intent: RegionIntent, saved?: DiscussionRef, replyId?: string): Promise<void> {
    const previous = intent === 'continue' ? this.currentQuestion : undefined;
    if (intent === 'continue' && !previous) throw Error(readerLabel('Reopen your question and try again.', '请先打开刚才的问题，再加入截图。'));
    this.close(false, false, hit);
    const generation = this.generation;
    this.activeHit = hit;
    const selection = hit.text.trim() || hit.label;
    const item: SelectionContext = { source: this.sourceRecord(hit), hit, original: hit.sourceQuote || selection,
      selection, context: hit.regionText ?? '' };
    if (intent === 'reopen' && !saved) {
      const wanted = discussionId(new URL(location.href), 'reply');
      const { exchanges } = await api('chat.history', { docId: item.source.docId });
      const matches = exchanges.filter(turn => turn.thread !== 'paper' && turn.source?.page === hit.page && turn.source.anchor === hit.id);
      const turn = matches.find(entry => entry.requestId === wanted)
        ?? matches.findLast(entry => entry.thread === this.currentQuestion?.thread) ?? matches.at(-1);
      if (turn?.source) { saved = { source: turn.source, thread: turn.thread }; replyId = turn.requestId; }
    }
    const thread = saved?.thread ?? previous?.thread ?? await conversationThread(item);
    if (generation !== this.generation) return;
    const { chat, writeNote } = this.workspace.open(item, thread, () => this.close(true, true), previous);
    const card = byId('card');
    card.dataset.selection = 'region';
    card.dataset.workspace = 'chat';
    card.replaceChildren(chat.root);
    card.hidden = false;
    this.events = new AbortController();
    this.app.view?.select(hit);
    this.place(true);
    this.app.attachDiscussionPosition?.(chat.heading, this.events.signal);
    await chat.open(intent === 'explain' ? 'explain' : 'ask', intent !== 'note', replyId);
    if (intent === 'note') await writeNote();
  }

  async open(hit: SelectionHit, saved?: DiscussionRef, replyId?: string, previous?: DiscussionRef): Promise<void> {
    if (hit.regionText !== undefined) return this.openRegion(hit, 'ask', saved, replyId);
    this.close(false);
    const generation = this.generation;
    const { app } = this;
    const selection = hit.text.trim();
    if (!selection) return;
    this.activeHit = hit;
    const original = hit.sourceQuote || (hit.side === 'translation' ? hit.sourceText || hit.context : selection);
    const source = this.sourceRecord(hit);
    const url = new URL(source.sourceUrl);
    if (original) url.searchParams.set('quote', quoteLocator(original));
    const target = hit.side === 'translation' ? { text: selection, offset: hit.translatedOffset } : undefined;
    writeTranslatedLocator(url, target);
    const range = selectionRange(hit);
    writeSelectionRange(url, range);
    source.sourceUrl = saved?.source.sourceUrl ?? url.href;
    const block = (id = hit.id) => app.view?.blocks.find(item => item.id === id);
    const term = !hit.image && isTerm(selection);
    const parts = hit.segments ?? [];
    const translation = parts.length ? parts.map(part => part.translated).filter(Boolean).join('\n\n') : block()?.translation;
    const exactPair = parts.length ? parts.every(part => part.exactPair) : Boolean(block()?.translation && selection === block()?.text);
    const translatedContext = () => parts.length ? parts.map(part => block(part.id)?.translation).filter(Boolean).join('\n\n') : block()?.translation;
    const context = () => {
      const zh = translatedContext();
      return zh ? 'Original passage\n' + hit.context + '\n\nTranslated passage\n' + zh : hit.context;
    };
    const record = async (definition: string) => {
      await api('history.add', { ...source, text: selection, meaning: definition, context: context() });
      await app.refresh();
    };
    const item: SelectionContext = { source, hit, original, selection, context: context(), pairedTranslation: translation, exactPair, record, thread: saved?.thread };
    const thread = saved?.thread ?? await conversationThread(item);
    if (generation !== this.generation) return;
    app.paperSelection?.(chatSource(item));
    const workspace = this.workspace.open(item, thread, () => this.leaveTool(), previous);
    const ongoing = this.currentQuestion;
    const canContinue = !saved && ongoing && ongoing.thread !== thread && materialKey(ongoing.source) !== materialKey(chatSource(item));

    const card = byId('card');
    card.dataset.selection = term ? 'term' : 'passage';
    const main = el('section', 'selection-main');
    const header = el('header', 'word-head');
    const heading = el('div', 'selection-heading');
    const title = el('h2', '', term ? selection : hit.image ? excerpt(selection, 68) : readerLabel('Selected passage', '所选原文'));
    title.dir = 'auto';
    title.tabIndex = -1;
    const prefix = readerLabel('Page ' + hit.page + ' · ', '第 ' + hit.page + ' 页 · ');
    const pageLabel = app.doc.kind === 'web' || hit.label.startsWith(prefix) || hit.label.startsWith('Page ' + hit.page + ' · ') ? hit.label : prefix + hit.label;
    heading.append(title, el('div', 'selection-location', pageLabel));
    const dismiss = button('', () => this.dismiss(true), 'icon-btn');
    dismiss.ariaLabel = dismiss.title = readerLabel('Close selection', '关闭选区');
    dismiss.append(icon('close', 15));
    header.append(heading, dismiss);
    main.append(header);

    const body = el('div', 'selection-body');
    const reading = el('div', 'selection-reading-preview');
    const preview = term ? undefined : passagePreview(selection);
    if (preview) reading.append(preview);
    const counterpart = el('div', 'passage-counterpart');
    counterpart.setAttribute('aria-live', 'polite');
    reading.append(counterpart);
    body.append(reading);
    const contextual = () => term && !item.exactPair;
    let lastText: string | undefined, lastSourceMode: boolean | undefined;
    let lastStatus: PdfPageView['translationStatus'];
    const partTranslation = (part: (typeof parts)[number]) => {
      if (part.translated) return part.translated;
      const current = block(part.id);
      return current && (correspondingText(current, part.original, 'original', part.offset) || current.translation);
    };
    const counterpartText = () => {
      if (hit.side === 'translation') return original;
      return parts.length ? parts.map(partTranslation).filter(Boolean).join('\n\n') : block()?.translation;
    };
    this.updatePreview = () => {
      const sourceMode = byId('reader').dataset.readingMode === 'source' && hit.side === 'source' && !card.dataset.workspace;
      const text = counterpartText();
      const needsStatus = sourceMode && !hit.image && hit.side === 'source' &&
        (!text || parts.some(part => !partTranslation(part)));
      const status = needsStatus ? (app.view as PdfPageView | undefined)?.translationStatus : undefined;
      const updatedContext = context();
      if (item.context !== updatedContext) {
        item.context = updatedContext;
        app.paperSelection?.(chatSource(item));
      }
      if (preview) preview.hidden = sourceMode && !hit.image;
      if (!term && !hit.image) title.textContent = sourceMode ? readerLabel('Passage translation','选段译文') :
        hit.side === 'translation' ? readerLabel('Selected translation','所选译文') : readerLabel('Selected passage','所选原文');
      if (text === lastText && sourceMode === lastSourceMode && status === lastStatus) return;
      lastText = text;
      lastSourceMode = sourceMode;
      lastStatus = status;
      if (hit.side === 'source') {
        item.pairedTranslation = text || undefined;
        item.exactPair = parts.length ? parts.every(part => {
          if (part.exactPair) return true;
          const current = block(part.id);
          return current && pairSelection(current, part.original, 'original', part.offset).exactPair;
        }) : Boolean(block()?.translation && selection === block()?.text);
      }
      const isContext = contextual();
      const restoreFocus = counterpart.contains(document.activeElement);
      counterpart.replaceChildren();
      if (term && text === selection) {
        counterpart.append(el('p', 'selection-context', readerLabel('This term is unchanged in the other language.', '该术语在译文中保持原样。')));
      } else if (text) {
        const sameBlock = hit.side === 'translation' ? original === hit.sourceText : text === block()?.translation;
        const label = isContext
          ? readerLabel((hit.side === 'translation' ? 'Original' : 'Translated') + (sameBlock ? ' paragraph context' : ' sentence context'),
            (hit.side === 'translation' ? '原文' : '译文') + (sameBlock ? '段落' : '句子'))
          : hit.side === 'translation' ? readerLabel('Original passage','对应原文')
          : item.exactPair ? readerLabel('Passage translation','选段译文') : readerLabel('Translated paragraph context','所在段落的译文');
        const content = el('p', isContext ? 'selection-context' : 'meaning', sourceMode && !term ? excerpt(text, 260) : text);
        content.dir = 'auto';
        if (hit.side === 'source') {
          const lang = targetLanguageBcp47(app.state.settings.targetLanguage || DEFAULT_TARGET_LANGUAGE);
          if (lang) content.lang = lang;
        }
        if (sourceMode || (term && !isContext)) {
          if ((sourceMode && !item.exactPair) || (term && !isContext)) counterpart.append(el('span', 'tag', label));
          counterpart.append(content);
        } else {
          const details = el('details', 'selection-counterpart');
          details.append(el('summary', '', label), content);
          counterpart.append(details);
        }
      }
      if (needsStatus) {
        const fallback = app.doc.kind === 'web' ? readerLabel('This paragraph has no saved translation yet.','此段还没有译文。') :
          text ? readerLabel('Translation is unavailable for part of this selection.','部分选段暂无译文。') : readerLabel('Translation for this passage is unavailable.','此段暂无译文。');
        counterpart.append(el('p', 'selection-context', status?.message || fallback));
        if (status?.actions.length) {
          const recovery = el('div', 'selection-recovery');
          for (const action of status.actions) recovery.append(button(action.label, action.run, 'text-btn'));
          counterpart.append(recovery);
        }
      }
      if (restoreFocus) title.focus({ preventScroll: true });
    };
    const controls = buildCardActions({
      chat: workspace.chat,
      notesAction: workspace.notesAction,
      includeNotes: item.hit.regionText === undefined,
      onHighlight: app.saveHighlight && !hit.image ? async color => {
        await app.saveHighlight!(source, original, color);
        if (this.activeHit === hit) this.close(true, true);
      } : undefined,
      onSaveWord: term ? async () => {
        await api('vocab.save', { ...source, text: selection, meaning: workspace.meaning() ?? (contextual() ? '' : counterpartText() ?? ''), context: item.context });
        await app.refresh();
        toast(readerLabel('Saved to vocabulary.', '已添加到生词本。'));
      } : undefined,
      onRetranslate: !hit.image && app.retranslateBlocks ? async () => {
        const ids = parts.length ? [...new Set(parts.map(part => part.id))] : [hit.id];
        await app.retranslateBlocks!(ids);
        for (const part of parts) { part.translated = undefined; part.exactPair = false; }
        if (this.activeHit === hit) { this.updatePreview?.(); app.view?.select(hit); }
      } : undefined,
      onInsertLink: () => workspace.insertLink(),
      onLocate: () => app.navigate(source.docId, source.page, hit.id, original, target, range),
      onToggleLanguage: () => {
        const side = byId('reader').dataset.compactLanguage === 'translation' ? 'source' : 'translation';
        app.showReadingSide?.(side);
      },
      onContinueDiscussion: canContinue ? () => this.open(hit, { source: chatSource(item), thread: ongoing.thread }, undefined, ongoing) : undefined
    });
    this.closeMoreMenu = controls.closeMenu;
    body.append(controls.actions);
    main.append(body);

    const chat = workspace.chat.root;
    const notesAction = workspace.notesAction;
    const chatAction = workspace.chat.action;
    workspace.notes.id = 'passage-notes';
    notesAction.setAttribute('aria-controls', workspace.notes.id);
    chatAction.setAttribute('aria-controls', chat.id);
    card.replaceChildren(main, workspace.notes, chat, controls.menu);
    card.hidden = false;
    this.events = new AbortController();
    const signal = this.events.signal;
    app.attachDiscussionPosition?.(workspace.chat.heading, signal);
    card.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tool = target.closest('.selection-note-action') ? 'note' : target.closest('.selection-chat-action') ? 'chat' : undefined;
      if (tool) {
        if (tool === 'chat') this.opener = target.closest('button') ?? undefined;
        card.dataset.workspace = tool;
        this.fit?.();
      }
    }, { capture: true, signal });
    card.addEventListener('edit-selection-note', () => {
      card.dataset.workspace = 'note';
      this.fit?.();
    }, { signal });

    app.view?.select(hit);
    const paper = byId('paperScroll'), scroll = { x: paper.scrollLeft, y: paper.scrollTop };
    const visiblePane = () => byId(byId('reader').dataset.compactLanguage === 'translation' ? 'translated' : 'original');
    const finalRange = hit.segments?.at(-1)?.ranges.at(-1);
    const anchor = () => {
      const targetPane = visiblePane();
      const native = Array.from(finalRange?.getClientRects() ?? []).at(-1);
      if (native?.height && !targetPane.hidden) return native;
      const fallback = targetPane.querySelector('.pdf-quote-mark, .web-reading-row[data-anchor="' + CSS.escape(hit.id) + '"]');
      return fallback?.getBoundingClientRect()
        ?? new DOMRect(hit.rect.x + scroll.x - paper.scrollLeft, hit.rect.y + scroll.y - paper.scrollTop, hit.rect.width, hit.rect.height);
    };
    this.fit = () => {
      if (!this.back.hidden) return;
      this.updatePreview?.();
      const reader = byId('reader');
      const comparing = reader.dataset.readingMode === 'bilingual';
      card.dataset.preview = comparing ? 'comparison' : 'translation';
      const docked = Boolean(card.dataset.workspace || comparing || reader.dataset.pageFormat === 'text' || !hasPassageGutter());
      this.place(docked);
      notesAction.setAttribute('aria-expanded', String(card.dataset.workspace === 'note'));
      chatAction.setAttribute('aria-expanded', String(card.dataset.workspace === 'chat'));
      controls.syncLanguage(reader.dataset.notebookPose === 'sheet', comparing, Boolean(card.dataset.workspace));
      dismiss.ariaLabel = dismiss.title = card.dataset.workspace ? readerLabel('Close passage workspace','收起选段工具') : readerLabel('Close selection','关闭选区');
      if (!docked) positionPassageCard(card, anchor());
      controls.reposition();
    };
    this.fit();
    if (hit.trigger) title.focus({ preventScroll: true });
    const resize = new ResizeObserver(entries => {
      if (card.dataset.docked && entries.some(entry => entry.target === paper)) this.revealIn(visiblePane());
      else this.fit?.();
    });
    resize.observe(card); resize.observe(main); resize.observe(paper);
    paper.addEventListener('scroll', () => this.fit?.(), { signal, passive: true });
    window.addEventListener('resize', () => this.fit?.(), { signal });
    window.visualViewport?.addEventListener('resize', () => this.fit?.(), { signal });
    signal.addEventListener('abort', () => resize.disconnect(), { once: true });
    const lookup = counterpartText();
    if (saved) {
      this.opener = chatAction;
      card.dataset.workspace = 'chat';
      this.fit();
      await workspace.chat.open('ask', true, replyId);
    } else if (lookup && lookup !== selection) void record(contextual() ? '' : lookup).catch(error => toast(message(error)));
  }
}
