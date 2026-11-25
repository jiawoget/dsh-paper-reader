import { showCard, WebSource, type WebCardDraft } from './card.js';
import { currentPick, type PickedText } from './web-page.js';
import { errorText, extLabel as t } from './protocol.js';
import type { Envelope, TabCommand } from './protocol.js';

interface PageWorld extends Window { dshPaperReaderReady?: boolean }
const world = window as PageWorld;

// Reinjecting after the service worker wakes must not install duplicate listeners.
if (!world.dshPaperReaderReady) {
  world.dshPaperReaderReady = true;
  let enabled = false;
  let card: ReturnType<typeof showCard> | undefined;
  let scheduled = 0;
  const drafts = new WeakMap<Node, {pick: PickedText; draft: WebCardDraft}[]>();

  function samePick(a: PickedText, b: PickedText): boolean {
    return a.text === b.text && a.context === b.context && a.range.startContainer === b.range.startContainer &&
      a.range.startOffset === b.range.startOffset && a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset;
  }

  function dismiss(): void {
    const pick = card?.source.pick;
    if (pick && card) {
      const node = pick.range.startContainer, kept = (drafts.get(node) ?? []).filter(entry => !samePick(entry.pick, pick));
      const draft = card.draft();
      if (draft) kept.push({pick, draft});
      if (kept.length) drafts.set(node, kept);
      else drafts.delete(node);
    }
    card?.dispose();
    card = undefined;
  }

  function select(): typeof card {
    const pick = currentPick();
    if (!pick) return;
    const previous = card?.source.pick;
    if (card?.busy || previous && samePick(previous, pick)) return card;
    dismiss();
    const restored = drafts.get(pick.range.startContainer)?.find(entry => samePick(entry.pick, pick));
    card = showCard(pick, dismiss, restored?.draft);
    return card;
  }

  function schedule(): void {
    cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(() => { if (enabled) select(); });
  }

  document.addEventListener('pointerdown', event => {
    if (event.isTrusted && card && !card.busy && !card.editing && !event.composedPath().includes(card.host)) dismiss();
  }, true);
  document.addEventListener('pointerup', event => {
    if (enabled && event.isTrusted && event.button === 0 && (!card || !event.composedPath().includes(card.host))) schedule();
  }, true);
  document.addEventListener('keyup', event => {
    if (!event.isTrusted || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { dismiss(); return; }
    if (enabled && (!card || !event.composedPath().includes(card.host)) && (event.shiftKey || event.key === 'Shift')) schedule();
  }, true);

  async function handle(command: TabCommand): Promise<{ enabled: boolean }> {
    if (command === 'enable') { enabled = true; select(); }
    if (command === 'disable') { enabled = false; cancelAnimationFrame(scheduled); dismiss(); }
    if (command === 'translate') {
      const open = select();
      if (!open) throw new Error(t('Select a word or sentence on the page to translate.', '请先在网页中选中要翻译的词句。'));
      await open.translate();
    }
    if (command === 'capture') {
      const pick = currentPick();
      const previous = card?.source.pick;
      const same = previous && pick && previous.range.startContainer === pick.range.startContainer &&
        previous.range.startOffset === pick.range.startOffset && previous.text === pick.text;
      await (same && card ? card.source : new WebSource(pick)).open();
    }
    return { enabled };
  }

  chrome.runtime.onMessage.addListener((message: { channel?: string; command: TabCommand }, sender, respond: (result: Envelope<unknown>) => void) => {
    if (message.channel !== 'paper-reader-page' || sender.id !== chrome.runtime.id) return;
    void handle(message.command).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: errorText(error) }));
    return true;
  });
}
