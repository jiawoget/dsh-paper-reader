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
