import { downloadFile, readerLabel as label, toast } from './ui.js';

/** Size both readers' captures for the image attachment service. */
export function regionCanvas(owner: Document, width: number, height: number) {
  const scale = Math.min(3, 1600 / Math.max(width, height));
  const canvas = owner.createElement('canvas');
  canvas.width = Math.max(1, Math.min(1600, Math.ceil(width * scale)));
  canvas.height = Math.max(1, Math.min(1600, Math.ceil(height * scale)));
  return { canvas, scale };
}

export function regionPng(canvas: HTMLCanvasElement): string {
  let image = canvas;
  let data = image.toDataURL('image/png');
  while (data.length > 2 * 1024 * 1024) {
    const next = canvas.ownerDocument.createElement('canvas');
    next.width = Math.max(1, Math.floor(image.width * 0.75));
    next.height = Math.max(1, Math.floor(image.height * 0.75));
    next.getContext('2d')!.drawImage(image, 0, 0, next.width, next.height);
    image = next;
    data = image.toDataURL('image/png');
  }
  return data;
}

export function pngDataUrlToBlob(dataUrl: string): Blob {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('Expected a PNG data URL.');
  const raw = atob(dataUrl.slice(prefix.length));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

export function regionPngFilename(docTitle: string, page: number): string {
  const stem = docTitle.replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'paper';
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  return stem + '-p' + safePage + '-region.png';
}

export async function copyRegionPng(dataUrl: string): Promise<boolean> {
  const blob = pngDataUrlToBlob(dataUrl);
  if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(label('PNG copied to clipboard.', 'PNG 已复制到剪贴板。'));
      return true;
    } catch {}
  }
  toast(label('Clipboard image copy is unavailable. Use Save PNG instead.', '当前浏览器不支持复制图片，请改用「保存 PNG」。'));
  return false;
}

export function saveRegionPng(dataUrl: string, docTitle: string, page: number): string {
  const filename = regionPngFilename(docTitle, page);
  downloadFile(filename, pngDataUrlToBlob(dataUrl));
  toast(label('Saved ' + filename + '.', '已保存 ' + filename + '。'));
  return filename;
}
