import type { DocumentInfo } from '../shared/types.js';
import type { PdfMetadata } from './pdf/metadata.js';
import { openPdf } from './pdf-view.js';
import { el, icon, message, readerLabel as label, responseJson } from './ui.js';

let importing = false;

async function importSinglePdf(file: File): Promise<DocumentInfo> {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) throw new Error(label('Choose a PDF file.', '请选择 PDF 文件。'));
  if (file.size > 80 * 1024 * 1024) throw new Error(label('Choose a PDF of up to 80 MB.', '请选择不超过 80 MB 的 PDF 文件。'));
  const check = await openPdf(new Uint8Array(await file.arrayBuffer()));
  let meta: PdfMetadata = {};
  try { meta = await check.metadata(); } finally { await check.destroy(); }
  const params = new URLSearchParams({ title: file.name });
  for (const [k, v] of Object.entries(meta)) if (typeof v === 'string' && v) params.set(k, v);
  const response = await fetch('../import-pdf?' + params.toString(), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/pdf' }, body: file });
  return (await responseJson<{ doc: DocumentInfo }>(response)).doc;
}

export async function importPdfFiles(files: readonly File[], onProgress?: (text: string) => void): Promise<{ imported: DocumentInfo[]; failed: { name: string; error: string }[]; summary: string }> {
  if (!files.length) return { imported: [], failed: [], summary: '' };
  if (importing) throw new Error(label('An import is already in progress.', '正在导入中，请稍候。'));
  importing = true;
  try {
    if (files.length === 1) return { imported: [await importSinglePdf(files[0])], failed: [], summary: '' };
    const imported: DocumentInfo[] = [], failed: { name: string; error: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      onProgress?.(label(`Importing ${i + 1}/${files.length}…`, `正在导入 ${i + 1}/${files.length}…`));
      try { imported.push(await importSinglePdf(files[i])); } catch (error) { failed.push({ name: files[i].name, error: message(error) }); }
    }
    const names = failed.slice(0, 2).map(f => f.name).join(', ') + (failed.length > 2 ? '…' : '');
    const summary = imported.length && failed.length
      ? label(`Imported ${imported.length} PDF${imported.length === 1 ? '' : 's'}; ${failed.length} skipped (${names}).`, `已导入 ${imported.length} 份 PDF，跳过 ${failed.length} 份（${names}）。`)
      : imported.length ? label(`Imported ${imported.length} PDFs.`, `已导入 ${imported.length} 份 PDF。`) : (failed[0]?.error || label('Choose a PDF file.', '请选择 PDF 文件。'));
    return { imported, failed, summary };
  } finally { importing = false; }
}

export function bindPdfDropTarget(target: HTMLElement, onFiles: (files: File[]) => void, opts?: { isBlocked?: () => boolean; signal?: AbortSignal }): void {
  const overlay = el('div', 'pdf-drop-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.append(icon('import', 26), el('span', '', label('Drop PDF files to import', '松开以导入 PDF 文件')));
  target.append(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files'));
  const clear = () => { depth = 0; delete target.dataset.pdfDrop; };
  const ev = opts?.signal ? { signal: opts.signal } : undefined;
  target.addEventListener('dragenter', e => { if (opts?.isBlocked?.() || !hasFiles(e)) return; e.preventDefault(); depth++; target.dataset.pdfDrop = 'active'; }, ev);
  target.addEventListener('dragover', e => { if (opts?.isBlocked?.() || !hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; target.dataset.pdfDrop = 'active'; }, ev);
  target.addEventListener('dragleave', () => { if (depth > 0 && --depth === 0) delete target.dataset.pdfDrop; }, ev);
  target.addEventListener('drop', e => { clear(); if (opts?.isBlocked?.() || !hasFiles(e)) return; e.preventDefault(); const list = Array.from(e.dataTransfer?.files ?? []); if (list.length) onFiles(list); }, ev);
  window.addEventListener('dragend', clear, ev); window.addEventListener('drop', clear, ev);
  opts?.signal?.addEventListener('abort', () => { clear(); overlay.remove(); }, { once: true });
}
