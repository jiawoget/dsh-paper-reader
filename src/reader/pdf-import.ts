import type { DocumentInfo } from '../shared/types.js';
import type { PdfMetadata } from './pdf/metadata.js';
import { loadPdfView } from './pdf-loader.js';
import { researchText } from './research/labels.js';
import { api, el, icon, message, readerLabel as label, responseJson } from './ui.js';

export const IMPORT_FILE_ACCEPT = '.pdf,.md,.markdown,.html,.htm,application/pdf,text/markdown,text/html';
const LOCAL_DOC_LIMIT = 32 * 1024 * 1024;
let importing = false;

export const isPdfFile = (file: File): boolean => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function detectImportKind(file: File): 'pdf' | 'md' | 'html' | undefined {
  if (isPdfFile(file)) return 'pdf';
  const name = file.name.toLowerCase(), type = file.type.toLowerCase();
  if (/\.(?:md|markdown)$/.test(name) || type === 'text/markdown' || type === 'text/x-markdown') return 'md';
  if (/\.(?:html|htm)$/.test(name) || type === 'text/html' || type === 'application/xhtml+xml') return 'html';
}

async function importSinglePdf(file: File): Promise<DocumentInfo> {
  if (!isPdfFile(file)) throw new Error(label('Choose a PDF file.', '请选择 PDF 文件。'));
  if (file.size > 80 * 1024 * 1024) throw new Error(label('Choose a PDF of up to 80 MB.', '请选择不超过 80 MB 的 PDF 文件。'));
  const [{ openPdf }, bytes] = await Promise.all([loadPdfView(), file.arrayBuffer()]);
  const check = await openPdf(new Uint8Array(bytes));
  let meta: PdfMetadata = {};
  try { meta = await check.metadata(); } finally { await check.destroy(); }
  const params = new URLSearchParams({ title: file.name });
  const overflow: Partial<Record<'paperTitle' | 'authors' | 'venue' | 'year' | 'doi', string>> = {};
  for (const k of ['url', 'doi', 'year', 'venue', 'paperTitle', 'authors'] as const) {
    const v = meta[k];
    if (v) { params.set(k, v); if (params.toString().length > 4096) { params.delete(k); if (k !== 'url') overflow[k] = v; } }
  }
  const response = await fetch('../import-pdf?' + params.toString(), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/pdf' }, body: file });
  const { doc } = await responseJson<{ doc: DocumentInfo }>(response);
  const patch: Partial<Record<'paperTitle' | 'authors' | 'venue' | 'year' | 'doi', string>> = {};
  for (const k of ['paperTitle', 'authors', 'venue', 'year', 'doi'] as const) if (overflow[k] && !doc[k]) patch[k] = overflow[k];
  return Object.keys(patch).length ? (await api('library.updateMeta', { id: doc.id, ...patch }).catch(() => undefined))?.doc ?? doc : doc;
}

async function importSingleTextFile(file: File, kind: 'md' | 'html'): Promise<DocumentInfo> {
  if (file.size > LOCAL_DOC_LIMIT) throw new Error(researchText.fileTooLarge32Mb());
  const params = new URLSearchParams({ filename: file.name });
  const contentType = kind === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8';
  const response = await fetch('../import-file?' + params.toString(), {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': contentType, 'x-filename': encodeURIComponent(file.name) },
    body: file
  });
  const { doc } = await responseJson<{ doc: DocumentInfo }>(response);
  return doc;
}

async function importSingleFile(file: File): Promise<DocumentInfo> {
  const kind = detectImportKind(file);
  if (!kind) throw new Error(researchText.chooseSupportedFile());
  return kind === 'pdf' ? importSinglePdf(file) : importSingleTextFile(file, kind);
}

export async function importPdfFiles(files: readonly File[], onProgress?: (text: string) => void): Promise<{ imported: DocumentInfo[]; failed: { name: string; error: string }[]; summary: string }> {
  if (!files.length) return { imported: [], failed: [], summary: '' };
  if (importing) throw new Error(label('An import is already in progress.', '正在导入中，请稍候。'));
  importing = true;
  try {
    if (files.length === 1) return { imported: [await importSingleFile(files[0])], failed: [], summary: '' };
    const imported: DocumentInfo[] = [], failed: { name: string; error: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      onProgress?.(label(`Importing ${i + 1}/${files.length}…`, `正在导入 ${i + 1}/${files.length}…`));
      try { imported.push(await importSingleFile(files[i])); } catch (error) { failed.push({ name: files[i].name, error: message(error) }); }
    }
    const names = failed.slice(0, 2).map(f => f.name).join(', ') + (failed.length > 2 ? '…' : '');
    const allPdf = imported.every(doc => doc.kind === 'pdf');
    const unitEn = allPdf ? (imported.length === 1 ? 'PDF' : 'PDFs') : (imported.length === 1 ? 'file' : 'files');
    const unitZh = allPdf ? 'PDF' : '份文档';
    const summary = imported.length && failed.length
      ? label(`Imported ${imported.length} ${unitEn}; ${failed.length} skipped (${names}).`, `已导入 ${imported.length} ${allPdf ? '份 ' : ''}${unitZh}，跳过 ${failed.length} 份（${names}）。`)
      : imported.length ? label(`Imported ${imported.length} ${unitEn}.`, `已导入 ${imported.length} ${allPdf ? '份 ' : ''}${unitZh}。`) : (failed[0]?.error || researchText.chooseSupportedFile());
    return { imported, failed, summary };
  } finally { importing = false; }
}

export function bindPdfDropTarget(target: HTMLElement, onFiles: (files: File[]) => void, opts?: { isBlocked?: () => boolean; signal?: AbortSignal }): void {
  const overlay = el('div', 'pdf-drop-overlay');
  overlay.setAttribute('aria-hidden', 'true'); overlay.append(icon('import', 26), el('span', '', researchText.dropFilesToImport()));
  target.append(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files'));
  const clear = () => { depth = 0; delete target.dataset.pdfDrop; };
  const ev = opts?.signal ? { signal: opts.signal } : undefined;
  target.addEventListener('dragenter', e => { if (opts?.isBlocked?.() || !hasFiles(e)) return; e.preventDefault(); depth++; target.dataset.pdfDrop = 'active'; }, ev);
  target.addEventListener('dragover', e => { if (opts?.isBlocked?.() || !hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; if (depth === 0) depth = 1; target.dataset.pdfDrop = 'active'; }, ev);
  target.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (depth === 0) delete target.dataset.pdfDrop; }, ev);
  target.addEventListener('drop', e => { clear(); if (e.defaultPrevented || opts?.isBlocked?.() || !hasFiles(e)) return; e.preventDefault(); const list = Array.from(e.dataTransfer?.files ?? []); if (list.length) onFiles(list); }, ev);
  window.addEventListener('dragend', clear, ev); window.addEventListener('drop', clear, ev);
  opts?.signal?.addEventListener('abort', () => { clear(); overlay.remove(); }, { once: true });
}
