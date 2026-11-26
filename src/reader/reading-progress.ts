import { api, byId } from './ui.js';

export function trackReadingProgress(opts: { docId: string; page: number; pageCount?: number; restoreFraction?: number }): (save?: boolean) => void {
  const paper = byId('paperScroll'), original = byId('original'), events = new AbortController();
  let restoring = Boolean(opts.restoreFraction && opts.restoreFraction > 0), alignedTop = 0, disposed = false, pending = 0, lastSaved = '';
  const fraction = () => {
    const max = paper.scrollHeight - paper.clientHeight;
    return max > 4 ? Math.round(Math.max(0, Math.min(1, paper.scrollTop / max)) * 10000) / 10000 : 0;
  };
  const flush = (override?: number) => {
    if (disposed) return;
    window.clearTimeout(pending);
    const scrollFraction = override ?? (restoring && opts.restoreFraction ? opts.restoreFraction : fraction());
    const key = `${opts.page}:${opts.pageCount ?? 0}:${scrollFraction}`;
    if (key === lastSaved) return;
    lastSaved = key;
    void api('library.progress.save', {
      docId: opts.docId, lastPage: opts.page, ...(opts.pageCount && opts.pageCount > 0 && { pageCount: opts.pageCount }), scrollFraction
    }, true).catch(() => { if (!disposed && lastSaved === key) lastSaved = ''; });
  };
  const applyRestore = () => {
    if (!restoring || !opts.restoreFraction) return;
    const max = paper.scrollHeight - paper.clientHeight;
    if (max <= 4) return;
    paper.scrollTop = Math.round(opts.restoreFraction * max);
    alignedTop = paper.scrollTop;
  };
  const resize = new ResizeObserver(applyRestore);
  const stopRestore = () => { restoring = false; resize.disconnect(); };
  const listen = { signal: events.signal, passive: true };
  paper.addEventListener('scroll', () => {
    if (disposed || (restoring && Math.abs(paper.scrollTop - alignedTop) <= 2)) return;
    stopRestore();
    window.clearTimeout(pending);
    pending = window.setTimeout(() => flush(), 320);
  }, listen);
  paper.addEventListener('scrollend', () => { if (!restoring) flush(); }, listen);
  for (const name of ['wheel', 'pointerdown', 'touchstart', 'keydown']) paper.addEventListener(name, stopRestore, listen);
  window.addEventListener('pagehide', () => flush(), listen);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); }, listen);
  if (restoring) { applyRestore(); resize.observe(original); flush(opts.restoreFraction); }
  else flush();
  const settled = window.setTimeout(stopRestore, 800);
  return (save = true) => {
    window.clearTimeout(pending); window.clearTimeout(settled);
    if (save) flush();
    disposed = true; events.abort(); resize.disconnect();
  };
}
