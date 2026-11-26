import { errorText, extensionActions, getOrigin, isDirectPaperUrl, readerAddress } from './protocol.js';
import type { Envelope, ExtensionAction, TabCommand, WorkerRequest } from './protocol.js';
import type { OpenDocument } from '../shared/types.js';

const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();

function clearBadgeTimer(tabId: number): void {
  const prior = badgeTimers.get(tabId);
  if (prior !== undefined) { clearTimeout(prior); badgeTimers.delete(tabId); }
}

async function flashSavedBadge(tabId: number): Promise<void> {
  clearBadgeTimer(tabId);
  await chrome.action?.setBadgeBackgroundColor?.({ tabId, color: '#1f7a4c' }).catch(() => {});
  await chrome.action?.setBadgeText?.({ tabId, text: '✓' }).catch(() => {});
  await chrome.action?.setTitle?.({ tabId, title: bgLabel('Saved to Paper Reader library', '已保存到文库') }).catch(() => {});
  badgeTimers.set(tabId, setTimeout(() => {
    badgeTimers.delete(tabId);
    void chrome.action?.setBadgeText?.({ tabId, text: '' }).catch(() => {});
    void chrome.action?.setTitle?.({ tabId, title: 'DSH Paper Reader' }).catch(() => {});
  }, 3000));
}

function bgLabel(english: string, chinese: string): string {
  const locale = (typeof navigator !== 'undefined' && navigator.language) || chrome.i18n?.getUILanguage?.() || '';
  return /^zh(?:-|$)/i.test(locale) ? chinese : english;
}

// Chrome serializes this function when it runs in the chosen DSH tab's isolated world.
// Keep the request destination and request shape inside the function.
async function postToReader(origin: string, op: string, payload: unknown, fromTab: boolean, chinese: boolean): Promise<Envelope<unknown>> {
  const t = (en: string, zh: string) => chinese ? zh : en;
  if (fromTab && location.origin !== origin) return { ok: false, error: t('The DSH tab navigated away. Reopen your local DSH and try again.', 'DSH 标签页已跳转，请重新打开本机 DSH 后重试。') };
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
      return { ok: false, error: t('Choose Open DSH in the extension menu, sign in, and try again.', '请在扩展菜单中点击「打开 DSH」，登录后重试。') };
    }
    if (!json) return { ok: false, error: t('DSH did not return reader data. Check the local address, sign-in status, and reader patch.', 'DSH 未返回阅读器数据。请检查本机地址、登录状态与插件配置。') };
    if (!response.ok || reason) return { ok: false, error: typeof reason === 'string' ? reason : t('DSH request failed (HTTP ' + response.status + ').', 'DSH 请求失败（HTTP ' + response.status + '）。') };
    return { ok: true, data };
  } catch {
    return { ok: false, error: t('Could not reach your local DSH. Start the service and check the address in Connection settings.', '无法连接本机 DSH。请启动服务并在连接设置中检查地址。') };
  }
}

async function serviceAction(op: ExtensionAction, payload: unknown): Promise<unknown> {
  if (!extensionActions.includes(op)) throw new Error(bgLabel('This operation is unavailable in the extension.', '扩展中不支持此操作。'));
  const origin = await getOrigin();
  const chinese = /^zh(?:-|$)/i.test((typeof navigator !== 'undefined' && navigator.language) || chrome.i18n?.getUILanguage?.() || '');
  const url = new URL(origin);
  const tabs = await chrome.tabs.query({ url: url.protocol + '//' + url.hostname + '/*' });
  const localTab = tabs.find(tab => tab.id !== undefined && tab.url && new URL(tab.url).origin === origin && !tab.discarded);
  let reply: Envelope<unknown> | null;
  if (localTab?.id !== undefined) {
    const result = await chrome.scripting.executeScript({
      target: { tabId: localTab.id }, world: 'ISOLATED', func: postToReader, args: [origin, op, payload, true, chinese]
    });
    reply = result[0]?.result || null;
  } else reply = await postToReader(origin, op, payload, false, chinese);
  if (!reply) throw new Error(bgLabel('The local DSH tab was closed. Reopen it and try again.', '本机 DSH 标签页已关闭，请重新打开后重试。'));
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

async function commandTab(tabId: number, command: TabCommand, frameId = 0, tabUrl?: string): Promise<unknown> {
  const message = { channel: 'paper-reader-page', command };
  if (command === 'status') {
    try {
      const reply: Envelope<unknown> = await chrome.tabs.sendMessage(tabId, message, { frameId });
      if (reply?.ok) return reply.data;
    } catch {}
    return { enabled: false };
  }
  if (command === 'capture' || command === 'save') {
    const url = tabUrl ?? (await chrome.tabs.get?.(tabId).catch(() => undefined))?.url;
    if (isDirectPaperUrl(url)) {
      const opened = await serviceAction('web.open', { url }) as OpenDocument;
      if (!opened?.doc?.id) throw new Error(bgLabel('Could not import this document.', '无法导入该文档。'));
      if (command === 'capture') {
        await chrome.tabs.create({ url: readerAddress(await getOrigin(), opened.doc.id, opened.anchor || '', opened.page ?? null) });
        clearBadgeTimer(tabId);
        await chrome.action?.setBadgeText?.({ tabId, text: '' }).catch(() => {});
        await chrome.action?.setTitle?.({ tabId, title: 'DSH Paper Reader' }).catch(() => {});
      } else await flashSavedBadge(tabId);
      return { enabled: false, saved: true };
    }
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] });
  } catch {
    throw new Error(bgLabel('Open the extension on a regular webpage. Browser settings, extension stores, and restricted frames cannot be read.', '请在普通网页上打开扩展。浏览器设置页、扩展商店和受限页面无法读取。'));
  }
  const reply: Envelope<unknown> = await chrome.tabs.sendMessage(tabId, message, { frameId });
  if (!reply?.ok) throw new Error(reply?.error || bgLabel('The webpage did not respond. Refresh it and try again.', '当前网页没有响应，请刷新后重试。'));
  if (command === 'save') await flashSavedBadge(tabId);
  else {
    clearBadgeTimer(tabId);
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'DSH Paper Reader' });
  }
  return reply.data;
}

async function handle(request: WorkerRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error(bgLabel('Unknown request source.', '未知请求来源。'));
  switch (request.type) {
    case 'tab':
      if (!sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) throw new Error(bgLabel('Use the extension menu to act on the current tab.', '请通过扩展菜单操作当前标签页。'));
      return commandTab(request.tabId, request.command, 0, request.tabUrl);
    case 'action': return serviceAction(request.op, request.payload);
    case 'reader':
      if (!request.doc || (request.anchor && !/^p-[1-9]\d*$/.test(request.anchor)) ||
          (request.page != null && (!Number.isSafeInteger(request.page) || request.page < 1))) throw new Error(bgLabel('The excerpt is missing its article location.', '摘录缺少原文位置。'));
      await chrome.tabs.create({ url: readerAddress(await getOrigin(), request.doc, request.anchor, request.page) });
      return {};
    default: throw new Error(bgLabel('Unknown extension command.', '未知扩展指令。'));
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
  void commandTab(tabId, command, info.frameId ?? 0, tab.url ?? info.pageUrl).catch(async error => {
    clearBadgeTimer(tabId);
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: errorText(error) });
  });
});
