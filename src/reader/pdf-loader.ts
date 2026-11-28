export const bundledPdfUrl = '/api/paper-reader/app/assets/pagedattention.pdf';

let pending: Promise<typeof import('./pdf-view.js')> | undefined;

export function loadPdfView(): Promise<typeof import('./pdf-view.js')> {
  return (pending ??= import('./pdf-view.js').catch(err => {
    pending = undefined;
    throw err;
  }));
}
