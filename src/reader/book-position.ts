import { bookPlace, type BookPlace } from '../shared/book-place.js';
import { writeSelectionRange, writeTranslatedLocator } from '../shared/source-link.js';
import { api, byId } from './ui.js';

const key = (doc: string) => 'reader.book-position.' + doc;
export function localBookPlace(doc: string): BookPlace | undefined {
  try { return bookPlace(JSON.parse(localStorage.getItem(key(doc)) || 'null')); }
  catch { return; }
}
export async function savedBookPlace(doc: string): Promise<BookPlace | undefined> {
  const local = localBookPlace(doc);
  const remote = await api('book.progress.get', { docId: doc }).then(r => r.place, () => null);
  return remote && (!local || remote.updated >= local.updated) ? remote : local;
}

/** The first paragraph at the reading line remains meaningful after zooming or resizing the window. */
export function trackBookPlace(docId: string, page: number, resume?: BookPlace): (save?: boolean) => void {
  const paper = byId('paperScroll'), translation = byId('translated');
  const events = new AbortController();
  const rows = {
    source: [...byId('original').querySelectorAll<HTMLElement>('.web-reading-row')],
    translation: [...translation.querySelectorAll<HTMLElement>('.web-reading-row')]
  };
  let side: BookPlace['side'] = resume?.side || 'source';
  let last = resume, dirty = false, pending = 0, alignedTop = 0;
  let aligning = Boolean(resume?.anchor), userMoved = false;

  function surface() {
    if (!rows[side][0]?.getClientRects().length) side = side === 'source' ? 'translation' : 'source';
    const separate = side === 'translation' && /auto|scroll/.test(getComputedStyle(translation).overflowY) &&
      translation.scrollHeight > translation.clientHeight;
    const scroller = separate ? translation : paper;
    const line = scroller.getBoundingClientRect().top + Math.min(48, scroller.clientHeight / 8);
    return {scroller, line, blocks:rows[side]};
  }
  function capture() {
    const {scroller, line, blocks} = surface();
    if (!blocks.length || !blocks[0].isConnected || !blocks[0].getClientRects().length) return;
    let anchor = '', fraction = 0;
    if (scroller.scrollTop > 2) {
      let lo = 0, hi = blocks.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (blocks[mid].getBoundingClientRect().bottom <= line) lo = mid + 1; else hi = mid;
      }
      const block = blocks[lo], rect = block.getBoundingClientRect();
      anchor = block.dataset.anchor!;
      fraction = Math.round(Math.max(0, Math.min(1, (line - rect.top) / Math.max(1, rect.height))) * 10000) / 10000;
    }
    if (last?.anchor === anchor && last.fraction === fraction && last.side === side) return;
    last = { page, anchor, fraction, side, updated: Math.max(Date.now(), (last?.updated || 0) + 1) };
    dirty = true;
    try { localStorage.setItem(key(docId), JSON.stringify(last)); } catch { /* The host still stores this position. */ }
  }
  function flush() {
    window.clearTimeout(pending);
    if (!aligning) capture();
    if (!last || !dirty) return;
    const place = last;
    dirty = false;
    void api('book.progress.save', { docId, place }, true).catch(() => { if (last === place) dirty = true; });
  }
  function align() {
    if (!aligning || !resume) return;
    const {scroller, line, blocks} = surface();
    const row = blocks.find(node => node.dataset.anchor === resume.anchor);
    if (row) {
      const rect = row.getBoundingClientRect();
      scroller.scrollTop += rect.top + rect.height * resume.fraction - line;
    }
    alignedTop = scroller.scrollTop;
  }
  const resize = new ResizeObserver(align);
  function stopAligning() { aligning = false; resize.disconnect(); }
  function scroll(event: Event) {
    if (aligning && Math.abs(surface().scroller.scrollTop - alignedTop) <= 1) return;
    stopAligning();
    side = event.currentTarget === translation || !rows.source[0]?.getClientRects().length ? 'translation' : 'source';
    if (userMoved && new URL(location.href).searchParams.has('anchor')) {
      const url=new URL(location.href);
      for (const name of ['anchor','quote','reply','discussion']) url.searchParams.delete(name);
      writeSelectionRange(url); writeTranslatedLocator(url);
      history.replaceState(null,'',url);
    }
    const previous = last;
    capture();
    if (!dirty) return;
    // A reader can close the window immediately after jumping to a new paragraph.
    if (last?.anchor !== previous?.anchor) flush();
    else { window.clearTimeout(pending); pending = window.setTimeout(flush, 200); }
  }
  const options = { signal: events.signal, passive: true };
  paper.addEventListener('scroll', scroll, options); translation.addEventListener('scroll', scroll, options);
  paper.addEventListener('scrollend', flush, options); translation.addEventListener('scrollend', flush, options);
  for (const event of ['wheel','pointerdown','touchstart','keydown']) paper.addEventListener(event, () => { userMoved=true; stopAligning(); }, options);
  window.addEventListener('pagehide', flush, options);
  window.addEventListener('online', flush, options);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); }, options);
  if (aligning) { align(); resize.observe(byId('original')); resize.observe(translation); }
  else flush();
  const settled = window.setTimeout(stopAligning, 3000);
  return (save = true) => { if (save) flush(); events.abort(); resize.disconnect(); window.clearTimeout(settled); };
}
