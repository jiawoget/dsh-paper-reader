import type { Operations, SourceRecord } from '../shared/types.js';
import { action, askWorker, errorText, getOrigin, readerAddress } from './protocol.js';
import { openStaxLocation } from '../shared/openstax.js';
import { cardStyle } from './card-style.js';
import { questionModelForm } from '../shared/question-model-form.js';
import { snapshot } from './web-page.js';
import type { PickedText, Snapshot } from './web-page.js';

export class WebSource {
  private captured?: Snapshot;
  private importing?: Promise<SourceRecord>;
  private bookSource?: SourceRecord;
  private bookPage?: number | null;
  private docId = '';
  private readonly url = location.href;
  constructor(readonly pick: PickedText | null) {}

  private get page(): Snapshot {
    if (this.captured) return this.captured;
    if (this.url !== location.href || (this.pick && !this.pick.range.startContainer.isConnected)) {
      throw new Error('The article has changed. Select the passage again to save its location.');
    }
    return this.captured = snapshot(this.pick);
  }

  record(): SourceRecord {
    if (this.bookSource) return this.bookSource;
    const { article, anchor, label } = this.page;
    return { docId: this.docId, title: article.title, sourceUrl: article.url, anchor, label, page: 1 };
  }

  async collect(): Promise<SourceRecord> {
    this.importing ??= this.importSource().catch(error => { this.importing = undefined; throw error; });
    return this.importing;
  }
  private async importSource(): Promise<SourceRecord> {
    if (openStaxLocation(this.url)) {
      const {doc, page, anchor: fragment} = await action('web.open', {url:this.url});
      if (!doc.book) throw Error('This book section could not be opened.');
      this.bookPage = page ?? null;
      const number = page || doc.defaultPage || 1;
      let anchor = fragment || '';
      if (this.pick) {
        const text = this.pick.text.trim().replace(/\s+/g,' ');
        const context = this.pick.context.trim().replace(/\s+/g,' ');
        const matches = (doc.paragraphs ?? []).map((p,i) => ({p:p.replace(/\s+/g,' '),id:'p-'+(i+1)})).filter(({p}) => p.includes(text));
        const ids = new Set<string>();
        for (let node:Element|null=this.pick.block;node;node=node.parentElement) if(node.id)ids.add(node.id);
        const structural = matches.filter(m => doc.articleLayout?.[m.id]?.ids?.some(id=>ids.has(id)));
        const exact = matches.filter(m => m.p === context);
        const best = structural.length === 1 ? structural : exact.length === 1 ? exact : matches;
        if(best.length!==1)throw Error('Open this section in the reader and select the passage there to save its exact location.');
        anchor=best[0].id;
      }
      const local = new URL(readerAddress(await getOrigin(),doc.id,anchor,this.bookPage));
      if(this.pick)local.searchParams.set('quote',this.pick.text.slice(0,1024));
      return this.bookSource={docId:doc.id,title:doc.title,page:number,anchor,label:doc.book.sections[number-1].title,sourceUrl:local.href};
    }
    return action('web.import', this.page.article).then(({ doc }) => {
      if (!doc?.id) throw new Error('DSH did not return an article ID. Try again.');
      this.docId=doc.id;
      return this.record();
    });
  }

  async open(): Promise<void> {
    const source = await this.collect();
    await askWorker({ type: 'reader', doc: source.docId, anchor: source.anchor, page:this.bookPage });
  }
}

const layout = `
<section class="card" role="dialog" aria-label="DSH selection card" lang="en">
  <div class="head"><h2></h2><button type="button" class="close" data-do="close" aria-label="Close card">×</button></div>
  <div class="modes"><button type="button" data-do="translate">Translate</button><button type="button" data-do="explain">Explain in context</button><button type="button" data-do="followup">Ask</button></div>
  <p class="question" hidden></p>
  <p class="answer hint" aria-live="polite">Choose a lookup to use your DSH model.</p>
  <details class="model-picker" hidden><summary>Question model</summary></details>
  <form class="editor" hidden><label><span></span><textarea rows="2"></textarea></label>
    <div class="editor-actions"><button type="button" data-do="cancel">Cancel</button><button type="submit" class="primary" data-do="submit">Send</button></div>
  </form>
  <div class="foot"><button type="button" data-do="open">Read ↗</button><button type="button" data-do="vocab">☆ Save word</button><button type="button" class="primary" data-do="note">Add to notes</button></div>
  <p class="status" role="status"></p>
</section>`;

type Mode = Operations['ai'][0]['mode'];
type Conversation = NonNullable<Operations['ai'][0]['history']>;
type EditorMode = 'followup' | 'note';
export interface WebCardDraft {
  mode: EditorMode;
  fields: Record<EditorMode, string>;
  turns: Conversation;
  meaning: string;
  lastQuestion: string;
}

export function showCard(pick: PickedText, close: () => void, restored?: WebCardDraft) {
  const source = new WebSource(pick);
  const host = document.createElement('div');
  host.dataset.dshPaperReader = '';
  const setHost = (name: string, value: string) => host.style.setProperty(name, value, 'important');
  for (const [name, value] of Object.entries({ all: 'initial', position: 'fixed', display: 'block', 'z-index': '2147483647', width: 'min(306px, calc(100vw - 16px))' })) setHost(name, value);
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cardStyle);
  shadow.adoptedStyleSheets = [sheet];
  const template = document.createElement('template');
  template.innerHTML = layout;
  shadow.append(template.content.cloneNode(true));
  const panel = shadow.querySelector<HTMLElement>('.card')!;
  const answer = shadow.querySelector<HTMLParagraphElement>('.answer')!;
  const submitted = shadow.querySelector<HTMLParagraphElement>('.question')!;
  const status = shadow.querySelector<HTMLParagraphElement>('.status')!;
  const editor = shadow.querySelector<HTMLFormElement>('form')!;
  const modelPicker = shadow.querySelector<HTMLDetailsElement>('.model-picker')!;
  const textarea = shadow.querySelector<HTMLTextAreaElement>('textarea')!;
  const button = (id: string) => shadow.querySelector<HTMLButtonElement>('[data-do="' + id + '"]')!;
  const turns: Conversation = restored?.turns.slice() ?? [];
  const fields = restored ? { ...restored.fields } : { followup: '', note: '' };
  const events = new AbortController();
  let formMode: EditorMode = restored?.mode ?? 'note';
  let meaning = restored?.meaning ?? '';
  let busy = false;
  let savedWord = false;
  let savedNote = false;
  shadow.querySelector('h2')!.textContent = pick.text;
  modelPicker.ontoggle = () => {
    modelPicker.querySelector('form')?.remove();
    if (!modelPicker.open) return;
    modelPicker.append(questionModelForm({ label: english => english, load: () => action('ai.models', {}),
      save: questionModel => run(async () => {
        await action('ai.selectModel', { questionModel });
        modelPicker.open = false;
        modelPicker.querySelector('summary')!.textContent = ['Question model', questionModel?.model, questionModel?.reasoningEffort].filter(Boolean).join(' · ');
      })
    }));
  };

  function position(): void {
    if (!pick.range.startContainer.isConnected) { close(); return; }
    const rects = Array.from(pick.range.getClientRects()).filter(r => r.width && r.height);
    const rect = rects.at(-1) || pick.range.getBoundingClientRect();
    const line = rects.filter(r => r.top < rect.bottom && r.bottom > rect.top);
    const left = line.length ? Math.min(...line.map(r => r.left)) : rect.left;
    const bottom = window.innerHeight - 8;
    setHost('visibility', rect.bottom < 0 || rect.top > window.innerHeight ? 'hidden' : 'visible');
    setHost('left', Math.max(8, Math.min(left, window.innerWidth - host.offsetWidth - 8)) + 'px');
    const fitsBelow = rect.bottom + 8 + host.offsetHeight <= bottom;
    const top = fitsBelow ? rect.bottom + 8 : rect.top - host.offsetHeight - 8;
    setHost('top', Math.max(8, Math.min(top, bottom - host.offsetHeight)) + 'px');
  }

  function controls(): void {
    for (const input of shadow.querySelectorAll<HTMLButtonElement>('button[data-do]')) {
      const id = input.dataset.do;
      input.disabled = id !== 'close' && (busy || (id === 'vocab' && savedWord) || (id === 'note' && savedNote));
    }
    textarea.disabled = busy;
  }

  async function run(operation: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    controls();
    status.textContent = '';
    try { await operation(); }
    catch (error) { status.textContent = errorText(error); }
    finally { busy = false; controls(); }
  }

  function toggleMode(mode: Mode): void {
    for (const item of shadow.querySelectorAll<HTMLButtonElement>('.modes button')) item.setAttribute('aria-pressed', String(item.dataset.do === mode));
  }

  async function lookup(mode: Mode, question?: string): Promise<void> {
    modelPicker.hidden = true;
    modelPicker.open = false;
    toggleMode(mode);
    submitted.hidden = !question;
    submitted.textContent = question || '';
    answer.className = 'answer hint';
    answer.textContent = 'Looking up…';
    let reply: string;
    try {
      const result = await action('ai', { mode, text: pick.text, context: pick.context, ...(question ? { question, history: turns.slice(-8) } : {}) });
      reply = result?.text?.trim();
      if (!reply) throw new Error('The model returned an empty answer. Try again.');
    } catch (error) {
      answer.className = 'answer error';
      answer.textContent = errorText(error);
      modelPicker.hidden = mode !== 'followup';
      return;
    }
    answer.className = 'answer';
    answer.textContent = reply;
    turns.push({ role: 'user', content: question || (mode === 'explain' ? 'Explain the selection in context.' : 'Translate the selection.') }, { role: 'assistant', content: reply });
    if (mode === 'followup') fields.followup = '';
    editor.hidden = true;
    if (mode !== 'followup') {
      if (mode === 'translate' || !meaning) meaning = reply;
      try { await action('history.add', { ...source.record(), text: pick.text, meaning: reply, context: pick.context }); }
      catch (error) { status.textContent = 'Could not save lookup history. ' + errorText(error); }
    }
  }

  function edit(mode: EditorMode): void {
    modelPicker.hidden = mode !== 'followup';
    modelPicker.open = false;
    formMode = mode;
    editor.hidden = false;
    editor.querySelector('label span')!.textContent = mode === 'note' ? 'Note' : 'Ask about this passage';
    textarea.value = fields[mode];
    textarea.placeholder = mode === 'note' ? 'Optional. Leave blank to save the meaning or quote.' : 'What does this word refer to here?';
    textarea.required = mode === 'followup';
    button('submit').textContent = mode === 'note' ? 'Save note' : 'Send';
    if (mode === 'followup') toggleMode(mode);
    position();
    textarea.focus({ preventScroll: true });
  }
  textarea.oninput = () => { fields[formMode] = textarea.value; };

  panel.addEventListener('pointerdown', event => {
    if ((event.target as Element).closest('button')) event.preventDefault();
  });
  panel.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const id = (event.target as Element).closest<HTMLButtonElement>('button')?.dataset.do;
    if (id === 'close') { close(); return; }
    if (busy) return;
    if (id === 'translate' || id === 'explain') {
      editor.hidden = true;
      void run(() => lookup(id));
    } else if (id === 'note' || id === 'followup') edit(id);
    else if (id === 'cancel') { fields[formMode] = ''; editor.hidden = modelPicker.hidden = true; modelPicker.open = false; }
    else if (id === 'open') void run(() => source.open());
    else if (id === 'vocab') void run(async () => {
      const saved = await source.collect();
      await action('vocab.save', { ...saved, text: pick.text, meaning, context: pick.context });
      savedWord = true;
      button('vocab').textContent = 'Word saved';
      status.textContent = 'Saved to your vocabulary.';
    });
  });
  editor.addEventListener('submit', event => {
    event.preventDefault();
    if (!event.isTrusted || busy) return;
    const value = textarea.value.trim();
    if (formMode === 'followup') {
      if (value) void run(() => lookup('followup', value));
      return;
    }
    void run(async () => {
      const saved = await source.collect();
      await action('note.save', { ...saved, text: value || meaning || pick.text, quote: pick.text });
      editor.hidden = true;
      fields.note = '';
      savedNote = true;
      button('note').textContent = 'Note added';
      status.textContent = 'Added to this article’s notes.';
    });
  });
  document.documentElement.appendChild(host);
  const size = new ResizeObserver(position);
  size.observe(panel);
  window.addEventListener('resize', position, { signal: events.signal });
  document.addEventListener('scroll', position, { capture: true, passive: true, signal: events.signal });
  position();
  if (restored) {
    const previous = turns.findLast(turn => turn.role === 'assistant');
    if (previous) { answer.className = 'answer'; answer.textContent = previous.content; }
    if (restored.lastQuestion) { submitted.hidden = false; submitted.textContent = restored.lastQuestion; }
    edit(restored.mode);
  }
  return {
    host, source,
    get busy() { return busy; },
    get editing() { return !editor.hidden && Boolean(textarea.value.trim()); },
    draft(): WebCardDraft | undefined {
      if (!fields.followup.trim() && !fields.note.trim()) return;
      return { mode: fields[formMode].trim() ? formMode : formMode === 'note' ? 'followup' : 'note',
        fields: { ...fields }, turns: turns.slice(-8), meaning, lastQuestion: submitted.hidden ? '' : submitted.textContent ?? '' };
    },
    translate: () => run(() => lookup('translate')),
    dispose() { size.disconnect(); events.abort(); host.remove(); }
  };
}
