import type { ChatSource, DocumentInfo, NotebookSnapshot, OpenDocument, Operations, PageView, ReaderState, SourceRecord } from '../shared/types.js';
import type { AnnotationColor, PaperAnnotation } from '../shared/annotations.js';
import type { SavedSelectionRange, TranslatedLocator } from '../shared/source-link.js';
import type { DiscussionRef } from './discussion-drafts.js';

export interface ReaderPort {
  doc: DocumentInfo;
  page: number;
  readonly pageCount: number;
  state: ReaderState;
  view?: PageView;
  navigate(id: string, page?: number, anchor?: string, quote?: string, target?: TranslatedLocator, range?: SavedSelectionRange): Promise<void>;
  openDocument(opened: OpenDocument): Promise<void>;
  importFile(file: File): Promise<void>;
  discardDocument?(docId: string): void;
  refresh(): Promise<void>;
  repaintNotes(): void;
  showNotebook(): void;
  openNotebookSource(url: URL): Promise<void>;
  addDiscussionScreenshot(): void;
  discussionScreenshot(source: ChatSource): Promise<string>;
  resumeDiscussion(ref: DiscussionRef, requestId?: string): Promise<void>;
  notebookHighlights(): readonly PaperAnnotation[];
  editNotebookHighlight(id: string, trigger: HTMLElement): void;
  attachDiscussionPosition?(header: HTMLElement, signal: AbortSignal): void;
  saveHighlight?(source: SourceRecord, quote: string, color?: AnnotationColor): Promise<void>;
  paperSelection?(source?: ChatSource): void;
  showReadingSide?(side: 'source' | 'translation'): void;
  discussionChanged?(docId: string): void;
  exchangeDeleted?(thread: string, requestId: string): void;
  regionDiscussionClosed?(explicit: boolean): void;
  notebook?: NotebookSnapshot;
  notebookError?: string;
}

export function readerLabel(english: string, chinese: string): string {
  return /^zh(?:-|$)/i.test(navigator.language) ? chinese : english;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing reader control: ' + id);
  return element as T;
}
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = '', value?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = css;
  if (value !== undefined) node.textContent = value;
  return node;
}
const paths = {
  contents:'M4 6h1m4 0h11M4 12h1m4 0h11M4 18h1m4 0h11',
  pin:'m8 4 8 0-1 6 3 3v1H6v-1l3-3zM12 14v7', minimize:'M5 12h14', restore:'M5 7h14v11H5z',
  chat:'M4 4h16v12H9l-5 4zM8 8h8M8 12h5',
  capture:'M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 12h8m-4-4v8',
  library:'M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v6H3zM14 15h7v6h-7z',
  back:'m14 6-6 6 6 6', next:'m10 6 6 6-6 6', close:'m6 6 12 12M18 6 6 18',
  arrowLeft:'M19 12H5m6-6-6 6 6 6', arrowRight:'M5 12h14m-6-6 6 6-6 6',
  columns:'M3 4h18v16H3zM12 4v16', more:'M4 12h.1M12 12h.1M20 12h.1',
  book:'M3 5q5-2 9 1 4-3 9-1v14q-5-2-9 1-4-3-9-1zM12 6v14',
  note:'M5 3h10l4 4v14H5zM14 3v5h5M8 13h8M8 17h6', edit:'M4 20h4l13-13-4-4L4 16zM14 6l4 4',
  star:'m12 3 2.7 5.7 6.3.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.3-.9z',
  arrow:'M6 18 18 6M7 6h11v11', plus:'M12 4v16M4 12h16', check:'m4 12 5 5L20 6',
  settings:'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M9 15v6', import:'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5',
  clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 6v6l4 2', refresh:'M20 12a8 8 0 1 1-2.3-5.6L20 9m0-5v5h-5', globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18z',
  folder:'M3 6h7l2 2h9v12H3z', popout:'M13 3h8v8M21 3 10 14M9 6H4v14h15v-5',
  keyboard:'M3 6h18v12H3zM7 10h.1M11 10h.1M15 10h.1M17 10h.1M7 14h10',
  trash:'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'
} as const;
export type Glyph = keyof typeof paths;
export function icon(name: Glyph, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns,'svg');
  for (const [key,val] of Object.entries({width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':name === 'more'?3.5:1.65,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':true})) svg.setAttribute(key,String(val));
  const line=document.createElementNS(ns,'path'); line.setAttribute('d',paths[name]); svg.append(line); return svg;
}
const localizedErrors: Record<string, string> = {
  'Enter a target language.': '请输入翻译目标语言。',
  'Target language must be a non-empty string.': '请输入有效的翻译目标语言。',
  'Target language must be at most 64 characters.': '翻译目标语言最多 64 个字符。',
  'Target language contains invalid control characters.': '翻译目标语言包含无效控制字符。'
};
export const message = (error: unknown) => {
  if (!(error instanceof Error)) return readerLabel('The request failed.', '请求失败。');
  return Object.hasOwn(localizedErrors, error.message)
    ? readerLabel(error.message, localizedErrors[error.message])
    : error.message;
};
export function webPageError(error: unknown): string {
  const detail = message(error);
  const code = detail.match(/website returned HTTP (\d+)/);
  if (code) return readerLabel(detail, '网站返回 HTTP ' + code[1] + '。可以打开原网页，再用浏览器扩展阅读。');
  if (/valid http or https|Invalid URL/i.test(detail))
    return readerLabel(detail, '请输入有效的 http 或 https 网页地址。');
  if (/public webpage address|resolve to a public website/.test(detail)) return readerLabel(detail, '这个地址需要从浏览器打开。请在原网页上使用阅读器扩展。');
  if (/not be reached|No visible article text|did not return a readable|does not return an HTML/.test(detail))
    return readerLabel(detail, '未能读取正文。请打开原网页，再用浏览器扩展阅读。');
  if (/too large|too long/.test(detail)) return readerLabel(detail, '这篇文章超过了阅读器可以打开的大小。');
  return detail;
}
export function zoteroStatusText(detail: string): string {
  const exact: Record<string, string> = {
    'Desktop library connected · filing authorized': '已连接本机 Zotero · 已授权写入',
    'Desktop library connected · confirm changes in Zotero': '已连接本机 Zotero · 写入时需在 Zotero 确认',
    'Desktop library connected · read and link items': '已连接本机 Zotero · 仅读取与关联',
    'Public web library connected · read and link items': '已连接公开网页资料库 · 仅读取与关联',
    'Web library connected · read and write': '已连接网页资料库 · 可读取和写入',
    'Web library connected · read only': '已连接网页资料库 · 仅只读',
    'Web library connected · filing permission checked on save': '已连接网页资料库 · 保存时校验写入权限',
    'Enter a Zotero library ID for this Web connection.': '请填写网页资料库的 Zotero 资料库 ID。',
    'Could not connect to Zotero.': '无法连接 Zotero。'
  };
  if (Object.hasOwn(exact, detail)) return readerLabel(detail, exact[detail]);
  if (/Open Zotero on this computer/i.test(detail)) return readerLabel(detail, '请在这台电脑上打开 Zotero，再重新测试连接。');
  if (/Allow other applications|enable the local API/i.test(detail)) return readerLabel(detail, '请在 Zotero 的「设置 → 高级」中启用本机 API 并允许其他应用通信，再重试。');
  if (/requires a Zotero API key/i.test(detail)) return readerLabel(detail, '此资料库需要具有读取权限的 Zotero API 密钥。请在连接设置中填写。');
  if (/Enter a Zotero library ID/i.test(detail)) return readerLabel(detail, '请在连接设置中填写 Zotero 资料库 ID，或切换为本机 Zotero。');
  if (/library changed|another library|library has changed/i.test(detail)) return readerLabel(detail, '当前打开的 Zotero 资料库已切换。请测试连接后重新查找条目。');
  if (/Add a Zotero API key with write access/i.test(detail)) return readerLabel(detail, '请在连接设置中填写具有写入权限的 Zotero API 密钥以保存条目。');
  if (/declined the change/i.test(detail)) return readerLabel(detail, 'Zotero 拒绝了本次修改。准备好授权后再点击保存。');
  return detail;
}
let timer: ReturnType<typeof setTimeout> | undefined;
export function toast(text:string, action?:{label:string; run:()=>unknown}):void {
  const node=byId('toast');
  const openDialog=document.querySelector<HTMLDialogElement>('dialog[open]');
  (openDialog ?? document.body).append(node);
  clearTimeout(timer); node.textContent=text; node.hidden=false;
  if(action) node.append(button(action.label,async()=>{node.hidden=true;await action.run();},'toast-action'));
  timer=setTimeout(()=>{node.hidden=true;},action?10000:5500);
}
export function button(label:string, fn:()=>unknown, css='btn', glyph?:Glyph):HTMLButtonElement {
  const node=el('button',css);
  node.type='button';
  if(glyph) node.append(icon(glyph,14));
  node.append(label);
  node.addEventListener('click',async()=>{
    node.disabled=true;
    try { await fn(); } catch(error){toast(message(error));} finally{node.disabled=false;}
  });
  return node;
}

/** Chromium can omit the click on the next tap after dragging a PDF crop. */
export function activateAfterTouchDrag(control: HTMLButtonElement): void {
  let press: Touch | undefined;
  control.addEventListener('touchstart', event => {
    press = event.touches.length === 1 ? event.touches[0] : undefined;
  }, { passive: true });
  control.addEventListener('touchcancel', () => { press = undefined; }, { passive: true });
  control.addEventListener('touchend', event => {
    const start = press, end = event.changedTouches[0];
    press = undefined;
    if (control.disabled || !start || !end || end.identifier !== start.identifier || event.touches.length ||
      Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY) > 10) return;
    const tap = document.elementFromPoint(end.clientX, end.clientY);
    if (!tap || !control.contains(tap)) return;
    event.preventDefault();
    control.click();
  }, { passive: false });
}
export async function responseJson<T>(response:Response):Promise<T> {
  const body:unknown=await response.json().catch(()=>null);
  if(!response.ok || body === null) {
    const error = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : undefined;
    throw new Error(error || (response.status===401 ? readerLabel('Open the signed-in DSH tab in this browser first.', '请先在此浏览器中打开已登录的 DSH 标签页。') : readerLabel('Request failed (HTTP '+response.status+').', '请求失败（HTTP '+response.status+'）。')));
  }
  return body as T;
}
export async function api<K extends keyof Operations>(op:K, payload:Operations[K][0], keepalive=false):Promise<Operations[K][1]> {
  return responseJson(await fetch('../action',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive,headers:{'content-type':'application/json'},body:JSON.stringify({op,payload})}));
}
export async function apiStream<K extends 'ai'|'chat.ask'>(op:K, payload:Operations[K][0], onDelta:(delta:string)=>void, signal?:AbortSignal):Promise<Operations[K][1]> {
  const response = await fetch('../action', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
    body: JSON.stringify({ op, payload })
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson') || !response.body) {
    return responseJson(response);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', finalText: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const frame = JSON.parse(line) as { delta?: string; text?: string; error?: string };
          if (typeof frame.error === 'string') throw new Error(frame.error);
          if (typeof frame.delta === 'string') onDelta(frame.delta);
          if (typeof frame.text === 'string') finalText = frame.text;
        }
        newline = buffer.indexOf('\n');
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  if (finalText !== undefined) return { text: finalText };
  throw new Error(readerLabel('The response ended unexpectedly.', '响应意外中断。'));
}
export function sourceUrl(id:string,page:number,anchor=''):string {
  const address=new URL('index.html',location.href);
  address.searchParams.set('doc',id); address.searchParams.set('page',String(page));
  if(anchor) address.searchParams.set('anchor',anchor);
  return address.href;
}
export function safeWeb(value:string|undefined):string|undefined {
  if(!value || !URL.canParse(value)) return;
  const url=new URL(value);
  if(['http:','https:'].includes(url.protocol)) return url.href;
}
export function modal(title:string):HTMLElement {
  byId('dialogTitle').textContent=title;
  const panel=byId('dialogBody'); panel.replaceChildren();
  const dialog=byId<HTMLDialogElement>('dialog');
  if(!dialog.open) dialog.showModal();
  return panel;
}
export function inputField(label:string,value='',type='text',placeholder='') {
  const row=el('label','field'); const input=el('input');
  input.type=type;input.value=value;input.placeholder=placeholder;input.autocomplete='off';
  row.append(el('span','',label),input); return {row,input};
}
export async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function bindTablist<T extends string>(
  tablist: HTMLElement,
  tabs: readonly { key: T; button: HTMLButtonElement; panel?: HTMLElement }[],
  initial: T,
  onSelect?: (key: T) => void
): (key: T, focus?: boolean) => void {
  let current = initial;
  tablist.setAttribute('role', 'tablist');
  const select = (key: T, focus = false) => {
    current = key;
    for (const item of tabs) {
      const active = item.key === key;
      item.button.setAttribute('aria-selected', String(active));
      item.button.tabIndex = active ? 0 : -1;
      if (item.panel) {
        item.panel.hidden = !active;
        if (active) item.panel.setAttribute('aria-labelledby', item.button.id);
      }
    }
    onSelect?.(key);
    if (focus) tabs.find(item => item.key === key)?.button.focus({ preventScroll: true });
  };
  for (const item of tabs) {
    item.button.type = 'button';
    item.button.setAttribute('role', 'tab');
    if (item.panel) item.button.setAttribute('aria-controls', item.panel.id);
    item.button.addEventListener('click', () => select(item.key));
  }
  tablist.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex(item => item.key === current);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    select(tabs[next].key, true);
  });
  select(initial, false);
  return select;
}
