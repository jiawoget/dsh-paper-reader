import {
  collectLibraryTags, filterTagStats, isInternalTag, MAX_DOC_TAGS, MAX_TAG_LEN, mergeTags,
  normalizeTag, suggestOfflineTags, type TagStat
} from '../shared/tags.js';
import type { DocMeta, DocumentInfo } from '../shared/types.js';
import { researchIcon } from './research/icons.js';
import { researchText } from './research/labels.js';
import { api, el, message, toast } from './ui.js';

interface TagPickerOptions {
  doc: DocumentInfo; getTaxonomy?: () => TagStat[]; aiConfigured?: boolean;
  heading?: string; compact?: boolean; onMetaUpdated?: (meta: DocMeta) => void;
}
interface ActivePopover {
  root: HTMLElement; trigger: HTMLButtonElement; docId: string;
  ac: AbortController; aiCtrl?: AbortController; refresh: () => void;
}

let mountSeq = 0;
let activePopover: ActivePopover | null = null;
const tagListeners = new Set<(docId: string, meta: DocMeta) => void>();

export const isTagPopoverOpen = (): boolean => activePopover !== null;
export function broadcastDocTags(docId: string, meta: DocMeta): void { for (const fn of [...tagListeners]) fn(docId, meta); }

export function closeTagPopover(restoreFocus = false): void {
  const cur = activePopover;
  if (!cur) return;
  activePopover = null; cur.aiCtrl?.abort(); cur.ac.abort(); cur.root.remove();
  cur.trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus && cur.trigger.isConnected) cur.trigger.focus({ preventScroll: true });
}

const visibleTags = (doc: DocumentInfo): string[] => (doc.meta?.tags ?? []).filter(t => t && !isInternalTag(t));

function positionPopover(pop: HTMLElement, trigger: HTMLButtonElement, dialog: HTMLDialogElement | null): void {
  const tr = trigger.getBoundingClientRect();
  if (!tr.width && !tr.height) { closeTagPopover(false); return; }
  const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
  const box = dialog ? dialog.getBoundingClientRect() : { left: 0, top: 0, right: vw, bottom: vh, width: vw, height: vh };
  const margin = 12, maxW = Math.min(320, Math.max(220, Math.floor(box.width - margin * 2)));
  pop.style.width = `${maxW}px`;
  const pr = pop.getBoundingClientRect(), pw = Math.min(pr.width || maxW, maxW), ph = pr.height || 200;
  const left = Math.max(box.left + margin, Math.min(tr.left, box.right - pw - margin));
  const minTop = Math.max(8, box.top + 8), maxBottom = Math.min(vh - 8, box.bottom - 8);
  const spaceBelow = maxBottom - tr.bottom - 6, spaceAbove = tr.top - minTop - 6;
  const flipUp = spaceBelow < Math.min(ph, 220) && spaceAbove > spaceBelow;
  const top = flipUp ? Math.max(minTop, tr.top - Math.min(ph, spaceAbove) - 6) : Math.max(minTop, Math.min(tr.bottom + 6, maxBottom - 120));
  const maxH = Math.max(120, Math.min(360, Math.floor(flipUp ? tr.top - top - 6 : maxBottom - top)));
  pop.style.left = `${Math.round(left)}px`; pop.style.top = `${Math.round(top)}px`; pop.style.maxHeight = `${maxH}px`;
}

export function mountTagPicker(container: HTMLElement, opts: TagPickerOptions): void {
  const token = String(++mountSeq), doc = opts.doc;
  container.dataset.tpSeq = token;
  const alive = () => container.isConnected && container.dataset.tpSeq === token;
  const root = el('section', opts.compact ? 'tp-root tp-compact' : 'tp-root'), inline = el('div', 'tp-inline');
  root.setAttribute('aria-label', researchText.tagsHeading());
  if (opts.heading) root.append(el('h3', 'tp-head', opts.heading));
  root.append(inline); container.replaceChildren(root);

  let busy = false;
  const trigger = el('button', 'tp-trigger');
  trigger.type = 'button'; trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.ariaLabel = researchText.tagManageLabel();
  trigger.append(researchIcon('tag', 14), el('span', '', researchText.tagAddBtn()));

  const commitTags = async (patch: { add?: string[]; remove?: string[] }): Promise<boolean> => {
    if (busy) return false;
    const current = doc.meta?.tags ?? [], next = mergeTags(current, patch);
    if (patch.add?.length && next.length === current.length && current.length >= MAX_DOC_TAGS) { toast(researchText.tagLimitReached()); return false; }
    busy = true;
    try {
      const { meta } = await api('library.triage', { docId: doc.id, tags: next });
      doc.meta = meta; broadcastDocTags(doc.id, meta); opts.onMetaUpdated?.(meta); return true;
    } catch (error) { toast(message(error)); return false; } finally { busy = false; }
  };

  const renderStrip = (): void => {
    inline.replaceChildren();
    for (const tag of visibleTags(doc)) {
      const chip = el('span', 'tp-chip library-tag'), del = el('button', 'tp-chip-del', '×');
      chip.dataset.tag = tag; del.type = 'button'; del.ariaLabel = del.title = researchText.tagRemoveLabel(tag);
      del.addEventListener('click', e => { e.stopPropagation(); void commitTags({ remove: [tag] }); });
      chip.append(el('span', 'tp-chip-text', tag), del); inline.append(chip);
    }
    inline.append(trigger);
  };

  const listener = (docId: string, meta: DocMeta) => {
    if (!alive()) { tagListeners.delete(listener); return; }
    if (docId !== doc.id) return;
    doc.meta = meta; renderStrip();
    if (activePopover?.docId === doc.id) activePopover.refresh();
  };
  tagListeners.add(listener); renderStrip();

  const openPopover = (): void => {
    if (activePopover?.trigger === trigger) { closeTagPopover(true); return; }
    closeTagPopover(false);
    const dialog = trigger.closest<HTMLDialogElement>('dialog[open]'), host = dialog ?? document.body;
    const ac = new AbortController(), { signal } = ac, pop = el('div', 'tp-popover');
    pop.setAttribute('role', 'dialog'); pop.ariaLabel = researchText.tagManageLabel();
    const head = el('div', 'tp-pop-head'), input = el('input', 'tp-input');
    input.type = 'search'; input.maxLength = MAX_TAG_LEN;
    input.placeholder = input.ariaLabel = researchText.tagSearchPlaceholder();
    head.append(input);

    let localTax: TagStat[] = opts.getTaxonomy ? opts.getTaxonomy() : collectLibraryTags([doc]);
    let aiSugs: string[] | null = null, aiLoading = false;
    const getTax = (): TagStat[] => opts.getTaxonomy ? opts.getTaxonomy() : localTax;
    const stopClick = (btn: HTMLButtonElement, fn: () => unknown) => btn.addEventListener('click', e => { e.stopPropagation(); void fn(); });

    if (opts.aiConfigured) {
      const aiBtn = el('button', 'btn tp-ai-btn'); aiBtn.type = 'button';
      aiBtn.append(researchIcon('ask-ai', 14), el('span', '', researchText.tagAiSuggest()));
      stopClick(aiBtn, async () => {
        if (aiLoading || activePopover?.root !== pop) return;
        aiLoading = true; aiBtn.disabled = true; aiBtn.lastElementChild!.textContent = researchText.tagAiSuggesting();
        const ctrl = new AbortController(); activePopover.aiCtrl = ctrl;
        try {
          const res = await api('library.suggestTags', { docId: doc.id }, false, ctrl.signal);
          if (activePopover?.root === pop) { aiSugs = res.tags; renderBody(); }
        } catch (error) { if (!ctrl.signal.aborted && activePopover?.root === pop) toast(message(error)); }
        finally { aiLoading = false; if (activePopover?.root === pop) { aiBtn.disabled = false; aiBtn.lastElementChild!.textContent = researchText.tagAiSuggest(); } }
      });
      head.append(aiBtn);
    }

    const createSlot = el('div', 'tp-create-slot'), sugSec = el('div', 'tp-sec tp-sug-sec'), listSec = el('div', 'tp-sec tp-list-sec');
    pop.append(head, createSlot, sugSec, listSec);

    const toggleTag = async (tag: string, forceAdd = false): Promise<void> => {
      const clean = normalizeTag(tag);
      if (!clean || isInternalTag(clean)) return;
      const key = clean.toLocaleLowerCase(), has = visibleTags(doc).some(t => t.toLocaleLowerCase() === key);
      if ((forceAdd && has) || !await commitTags(has ? { remove: [clean] } : { add: [clean] })) return;
      if (!opts.getTaxonomy) {
        const idx = localTax.findIndex(s => s.tag.toLocaleLowerCase() === key);
        if (idx >= 0) { const n = Math.max(0, localTax[idx].count + (has ? -1 : 1)); if (!n && !localTax[idx].label) localTax.splice(idx, 1); else localTax[idx] = { ...localTax[idx], count: n }; }
        else if (!has) localTax.push({ tag: clean, count: 1 });
        localTax.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      }
      if (activePopover?.root === pop) renderBody();
    };
    const commitFromInput = (tag: string, forceAdd: boolean) => void toggleTag(tag, forceAdd).then(() => { input.value = ''; renderBody(); input.focus({ preventScroll: true }); });

    const renderBody = (): void => {
      const query = input.value, currentKeys = new Set(visibleTags(doc).map(t => t.toLocaleLowerCase()));
      const tax = getTax(), filtered = filterTagStats(tax, query, 24);
      createSlot.replaceChildren(); createSlot.hidden = !filtered.createTag;
      if (filtered.createTag) {
        const toCreate = filtered.createTag, btn = el('button', 'tp-create-btn'); btn.type = 'button';
        btn.append(researchIcon('plus', 14), el('span', '', researchText.tagCreate(toCreate)));
        stopClick(btn, () => commitFromInput(toCreate, true)); createSlot.append(btn);
      }
      const rawSug = query.trim() ? [] : (aiSugs ?? suggestOfflineTags(doc, tax, 4)).filter(s => !currentKeys.has(s.toLocaleLowerCase()));
      sugSec.replaceChildren(); sugSec.hidden = !rawSug.length;
      if (rawSug.length) {
        const chips = el('div', 'tp-chips');
        for (const tag of rawSug) { const btn = el('button', 'tp-sug-chip', `+ ${tag}`); btn.type = 'button'; stopClick(btn, () => toggleTag(tag, true)); chips.append(btn); }
        sugSec.append(el('span', 'tp-sec-lbl', researchText.tagSuggestedHeading()), chips);
      }
      listSec.replaceChildren(el('span', 'tp-sec-lbl', researchText.tagLibraryHeading()));
      if (filtered.items.length) {
        const chips = el('div', 'tp-chips');
        for (const stat of filtered.items) {
          const btn = el('button', 'tp-opt'); btn.type = 'button'; btn.dataset.tag = stat.tag;
          btn.setAttribute('aria-pressed', String(currentKeys.has(stat.tag.toLocaleLowerCase())));
          btn.append(el('span', '', stat.tag), ...(stat.count > 0 ? [el('span', 'tp-opt-cnt', String(stat.count))] : []));
          stopClick(btn, () => toggleTag(stat.tag)); chips.append(btn);
        }
        listSec.append(chips);
        if (filtered.hiddenCount > 0) listSec.append(el('p', 'tp-hint', researchText.tagMoreHidden(filtered.hiddenCount)));
      } else if (!filtered.createTag) listSec.append(el('p', 'tp-hint', researchText.tagNoMatches()));
      positionPopover(pop, trigger, dialog);
    };

    input.addEventListener('input', renderBody);
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault(); const q = normalizeTag(input.value);
      if (!q || isInternalTag(q)) return;
      const exact = getTax().find(s => s.tag.toLocaleLowerCase() === q.toLocaleLowerCase());
      commitFromInput(exact ? exact.tag : q, true);
    });
    const reposition = () => { if (activePopover?.root === pop) positionPopover(pop, trigger, dialog); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeTagPopover(true); } }, { capture: true, signal });
    document.addEventListener('pointerdown', e => { if (e.target instanceof Node && !pop.contains(e.target) && !trigger.contains(e.target)) closeTagPopover(false); }, { capture: true, signal });
    document.addEventListener('scroll', e => { if (e.target instanceof Node && !pop.contains(e.target)) reposition(); }, { capture: true, passive: true, signal });
    window.addEventListener('resize', reposition, { passive: true, signal });

    activePopover = { root: pop, trigger, docId: doc.id, ac, refresh: renderBody };
    trigger.setAttribute('aria-expanded', 'true'); host.append(pop); renderBody(); input.focus({ preventScroll: true });
    if (!opts.getTaxonomy) {
      void Promise.all([api('library.list', {}), api('topics.list', {}).catch(() => ({ topics: [] }))]).then(([{ docs }, { topics }]) => {
        if (activePopover?.root !== pop) return;
        const fresh = docs.find(d => d.id === doc.id);
        if (fresh?.meta) { doc.meta = fresh.meta; renderStrip(); }
        localTax = collectLibraryTags(docs, topics); renderBody();
      }).catch(() => undefined);
    }
  };
  trigger.addEventListener('click', e => { e.stopPropagation(); openPopover(); });
}
