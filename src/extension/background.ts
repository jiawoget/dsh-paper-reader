import { errorText, extensionActions, getOrigin, readerAddress } from './protocol.js';
import type { Envelope, ExtensionAction, TabCommand, WorkerRequest } from './protocol.js';

// Chrome serializes this function when it runs in the chosen DSH tab's isolated world.
// Keep the request destination and request shape inside the function.
async function postToReader(origin: string, op: string, payload: unknown, fromTab: boolean): Promise<Envelope<unknown>> {
  if (fromTab && location.origin !== origin) return { ok: false, error: 'The DSH tab navigated away. Reopen your local DSH and try again.' };
  try {
    const response = await fetch(origin + '/api/paper-reader/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: fromTab ? 'same-origin' : 'include', redirect: 'error',
      body: JSON.stringify({ op, payload })
    });
    const json = response.headers.get('content-type')?.includes('json');
    const data: unknown = json ? await response.json() : null;
    const reason = data && typeof data === 'object' && 'error' in data ? data.error : null;
    if (response.status === 401 || response.status === 403) {
      // An authenticated reader can relay a provider credential failure as 403.
      if (op === 'ai' && typeof reason === 'string' && /\b(?:API key|model service)\b/i.test(reason)) return { ok: false, error: reason };
      return { ok: false, error: 'Choose Open DSH in the extension menu, sign in, and try again.' };
    }
    if (!json) return { ok: false, error: 'DSH did not return reader data. Check the local address, sign-in status, and reader patch.' };
    if (!response.ok || reason) return { ok: false, error: typeof reason === 'string' ? reason : 'DSH request failed (HTTP ' + response.status + ').' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Could not reach your local DSH. Start the service and check the address in Connection settings.' };
  }
}

async function serviceAction(op: ExtensionAction, payload: unknown): Promise<unknown> {
  if (!extensionActions.includes(op)) throw new Error('This operation is unavailable in the extension.');
  const origin = await getOrigin();
  const url = new URL(origin);
  const tabs = await chrome.tabs.query({ url: url.protocol + '//' + url.hostname + '/*' });
  const localTab = tabs.find(tab => tab.id !== undefined && tab.url && new URL(tab.url).origin === origin && !tab.discarded);
  let reply: Envelope<unknown> | null;
  if (localTab?.id !== undefined) {
    const result = await chrome.scripting.executeScript({
      target: { tabId: localTab.id }, world: 'ISOLATED', func: postToReader, args: [origin, op, payload, true]
    });
    reply = result[0]?.result || null;
  } else reply = await postToReader(origin, op, payload, false);
  if (!reply) throw new Error('The local DSH tab was closed. Reopen it and try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

async function commandTab(tabId: number, command: TabCommand, frameId = 0): Promise<unknown> {
  const message = { channel: 'paper-reader-page', command };
  if (command === 'status') {
    try {
      const reply: Envelope<unknown> = await chrome.tabs.sendMessage(tabId, message, { frameId });
      if (reply?.ok) return reply.data;
    } catch { /* A tab that has never been activated has no content script. */ }
    return { enabled: false };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] });
  } catch {
    throw new Error('Open the extension on a regular webpage. Browser settings, extension stores, and restricted frames cannot be read.');
  }
  const reply: Envelope<unknown> = await chrome.tabs.sendMessage(tabId, message, { frameId });
  if (!reply?.ok) throw new Error(reply?.error || 'The webpage did not respond. Refresh it and try again.');
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: 'DSH Paper Reader' });
  return reply.data;
}

async function handle(request: WorkerRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error('Unknown request source.');
  switch (request.type) {
    case 'tab':
      if (!sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) throw new Error('Use the extension menu to act on the current tab.');
      return commandTab(request.tabId, request.command);
    case 'action': return serviceAction(request.op, request.payload);
    case 'reader':
      if (!request.doc || (request.anchor && !/^p-[1-9]\d*$/.test(request.anchor)) ||
          (request.page != null && (!Number.isSafeInteger(request.page) || request.page < 1))) throw new Error('The excerpt is missing its article location.');
      await chrome.tabs.create({ url: readerAddress(await getOrigin(), request.doc, request.anchor, request.page) });
      return {};
    default: throw new Error('Unknown extension command.');
  }
}

chrome.runtime.onMessage.addListener((request: WorkerRequest, sender, respond: (value: Envelope<unknown>) => void) => {
  void handle(request, sender).then(data => respond({ ok: true, data }), err => respond({ ok: false, error: errorText(err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const documentUrlPatterns = ['http://*/*', 'https://*/*'];
    const chinese = /^zh(?:-|$)/i.test(chrome.i18n.getUILanguage());
    chrome.contextMenus.create({ id: 'translate-selection', title: chinese ? '用 DSH 翻译选区' : 'Translate selection with DSH', contexts: ['selection'], documentUrlPatterns });
    chrome.contextMenus.create({ id: 'read-this-page', title: chinese ? '在阅读器中打开' : 'Open in Paper Reader', contexts: ['page', 'selection'], documentUrlPatterns });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  const command = info.menuItemId === 'translate-selection' ? 'translate' : 'capture';
  void commandTab(tabId, command, info.frameId ?? 0).catch(async error => {
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: errorText(error) });
  });
});
