import type { Operations } from '../shared/types.js';

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
  columns:'M3 4h18v16H3zM12 4v16', more:'M4 12h.1M12 12h.1M20 12h.1',
  book:'M3 5q5-2 9 1 4-3 9-1v14q-5-2-9 1-4-3-9-1zM12 6v14',
  note:'M5 3h10l4 4v14H5zM14 3v5h5M8 13h8M8 17h6', edit:'M4 20h4l13-13-4-4L4 16zM14 6l4 4',
  star:'m12 3 2.7 5.7 6.3.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.3-.9z',
  arrow:'M6 18 18 6M7 6h11v11', plus:'M12 4v16M4 12h16', check:'m4 12 5 5L20 6',
  settings:'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M9 15v6', import:'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5',
  clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 6v6l4 2', globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18z',
  folder:'M3 6h7l2 2h9v12H3z', popout:'M13 3h8v8M21 3 10 14M9 6H4v14h15v-5'
} as const;
export type Glyph = keyof typeof paths;
export function icon(name: Glyph, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns,'svg');
  for (const [key,val] of Object.entries({width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':name === 'more'?3.5:1.65,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':true})) svg.setAttribute(key,String(val));
  const line=document.createElementNS(ns,'path'); line.setAttribute('d',paths[name]); svg.append(line); return svg;
}
export const message = (error:unknown) => error instanceof Error ? error.message : 'The request failed.';
export function webPageError(error: unknown): string {
  const detail = message(error);
  const code = detail.match(/website returned HTTP (\d+)/);
  if (code) return readerLabel(detail, '网站返回 HTTP ' + code[1] + '。可以打开原网页，再用浏览器扩展阅读。');
  if (/public webpage address|resolve to a public website/.test(detail)) return readerLabel(detail, '这个地址需要从浏览器打开。请在原网页上使用阅读器扩展。');
  if (/not be reached|No visible article text|did not return a readable|does not return an HTML/.test(detail))
    return readerLabel(detail, '未能读取正文。请打开原网页，再用浏览器扩展阅读。');
  if (/too large|too long/.test(detail)) return readerLabel(detail, '这篇文章超过了阅读器可以打开的大小。');
  return detail;
}
let timer: ReturnType<typeof setTimeout> | undefined;
export function toast(text:string, action?:{label:string; run:()=>unknown}):void {
  const node=byId('toast');
  const dialog=byId<HTMLDialogElement>('dialog');
  (dialog.open ? dialog : document.body).append(node);
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
    throw new Error(error || (response.status===401 ? 'Open the signed-in DSH tab in this browser first.' : 'Request failed (HTTP '+response.status+').'));
  }
  return body as T;
}
export async function api<K extends keyof Operations>(op:K, payload:Operations[K][0], keepalive=false):Promise<Operations[K][1]> {
  return responseJson(await fetch('../action',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive,headers:{'content-type':'application/json'},body:JSON.stringify({op,payload})}));
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
