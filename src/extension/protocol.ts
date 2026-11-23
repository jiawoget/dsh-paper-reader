import type { Operations } from '../shared/types.js';

const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const defaultOrigin = 'http://127.0.0.1:29812';

export function localOrigin(value: string = defaultOrigin): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('Enter the full address of your local DSH, such as ' + defaultOrigin); }
  if (!allowedHosts.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter an HTTP or HTTPS origin on localhost, 127.0.0.1, or [::1].');
  }
  return url.origin;
}

export async function getOrigin(): Promise<string> {
  const stored = await chrome.storage.local.get('serviceOrigin');
  return localOrigin(typeof stored.serviceOrigin === 'string' ? stored.serviceOrigin : undefined);
}

export function readerAddress(origin: string, doc: string, anchor: string, page: number | null = 1): string {
  const url = new URL('/api/paper-reader/app/index.html', localOrigin(origin));
  url.searchParams.set('doc',doc);
  if (page !== null) url.searchParams.set('page',String(page));
  if (anchor) url.searchParams.set('anchor',anchor);
  return url.href;
}

export const extensionActions = ['ai', 'ai.models', 'ai.selectModel', 'history.add', 'web.import', 'web.open', 'vocab.save', 'note.save'] as const;
export type ExtensionAction = typeof extensionActions[number];
export type TabCommand = 'status' | 'enable' | 'disable' | 'translate' | 'capture';
type ActionRequest = { [K in ExtensionAction]: { type: 'action'; op: K; payload: Operations[K][0] } }[ExtensionAction];
export type WorkerRequest = ActionRequest | { type: 'tab'; tabId: number; command: TabCommand }
  | { type: 'reader'; doc: string; anchor: string; page?: number | null };
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export async function askWorker<T>(message: WorkerRequest): Promise<T> {
  const reply: Envelope<T> | undefined = await chrome.runtime.sendMessage(message);
  if (!reply) throw new Error('The extension did not respond. Reopen its menu and try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

export function action<K extends ExtensionAction>(op: K, payload: Operations[K][0]): Promise<Operations[K][1]> {
  return askWorker<Operations[K][1]>({ type: 'action', op, payload } as ActionRequest);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
