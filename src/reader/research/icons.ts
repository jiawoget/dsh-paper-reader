import { el } from '../ui.js';
import { researchText, type ResearchViewId } from './labels.js';

export type ResearchIconName =
  | 'railToggle' | 'close'
  | 'read' | 'research' | 'ask-ai' | 'save' | 'info'
  | 'code' | 'talk' | 'slides' | 'dataset' | 'link'
  | ResearchViewId;

const RESEARCH_ICON_PATHS: Record<ResearchIconName, string> = {
  railToggle: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1M9 5v14',
  close: 'M6 6l12 12M18 6L6 18',
  read: 'M4 6.5C6.5 5 9.5 5.5 12 7c2.5-1.5 5.5-2 8-.5V18c-2.5-1.5-5.5-1-8 .5-2.5-1.5-5.5-2-8-.5zM12 7v11.5',
  research: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m3.6 5.4-2.1 5.1-5.1 2.1 2.1-5.1z',
  'ask-ai': 'M12 4.5l1.6 4.4 4.4 1.6-4.4 1.6L12 16.5l-1.6-4.4L6 10.5l4.4-1.6zM17.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  save: 'M6 4.5h12a1 1 0 0 1 1 1V20l-7-4-7 4V5.5a1 1 0 0 1 1-1M12 8.5v5M9.5 11h5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v5M12 8h.01',
  code: 'M8.5 8L4 12l4.5 4M15.5 8L20 12l-4.5 4M13.5 6.5l-3 11',
  talk: 'M4.5 6.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1M10.5 9.5l4.5 2.5-4.5 2.5z',
  slides: 'M4 5.5h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1M12 15.5v4M8.5 19.5h7M7.5 9.5h5M7.5 12.5h9',
  dataset: 'M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3m0 0v10c0 1.7 3.1 3 7 3s7-1.3 7-3V7M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  link: 'M10 14a4 4 0 0 1 0-5.7l2.1-2.1a4 4 0 0 1 5.7 5.7l-1.2 1.2M14 10a4 4 0 0 1 0 5.7l-2.1 2.1a4 4 0 0 1-5.7-5.7l1.2-1.2',
  'deep-search': 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13m8.5 15-3.9-3.9M11 8v6M8 11h6',
  'citation-map': 'M6.5 6a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4m11 0a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4M12 15a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4M8.4 9.6l2.5 5.6m4.7-5.6-2.5 5.6M8.7 8.2h6.6',
  citations: 'M5.5 10.5h4v5.5h-4zm0 0c0-2.8 1.4-4.5 3.8-5.5m5.2 5.5h4v5.5h-4zm0 0c0-2.8 1.4-4.5 3.8-5.5',
  'review-table': 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1M3 10h18M9 5v14M15 5v14',
  'field-trends': 'M4 19h16M6 15l4-4 3 3 5-7M15 7h3v3',
  'library-chat': 'M4 5h16v11H9l-5 4zM8 9h8M8 12.5h5'
};

export function researchIcon(name: ResearchIconName, size = 24): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
  })) svg.setAttribute(k, String(v));
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', RESEARCH_ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

let openTip: HTMLButtonElement | null = null;
const boundTipDocs = new WeakSet<object>();

const closeOpenTip = (): void => {
  if (!openTip) return;
  openTip.classList.remove('is-open'); openTip.setAttribute('aria-expanded', 'false'); openTip = null;
};

export function dismissInfoTip(): boolean {
  const active = document.activeElement;
  const focused = typeof HTMLButtonElement !== 'undefined' && active instanceof HTMLButtonElement && active.matches('.re-info-btn:focus-visible:not(.is-dismissed)') ? active : null;
  const target = openTip ?? focused ?? document.querySelector?.<HTMLButtonElement>('.re-info-btn:hover:not(.is-dismissed)') ?? null;
  if (!target) return false;
  const hadOpen = openTip; closeOpenTip(); target.classList.add('is-dismissed');
  if (hadOpen) hadOpen.focus({ preventScroll: true });
  return true;
}

const syncTipShift = (btn: HTMLButtonElement): void => {
  const r = btn.getBoundingClientRect(), vw = typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1024;
  if (!r.width && !r.height) return;
  const overflow = r.left + Math.min(320, vw - 32) - (vw - 16);
  btn.style.setProperty('--tip-shift', overflow > 0 ? `${Math.round(-Math.min(overflow, Math.max(0, r.left - 16)))}px` : '0px');
};

export function infoTip(text: string, label?: string): HTMLButtonElement {
  if (typeof document !== 'undefined' && !boundTipDocs.has(document)) {
    boundTipDocs.add(document);
    document.addEventListener('pointerdown', e => { if (openTip && !(e.target instanceof Node && openTip.contains(e.target))) closeOpenTip(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && dismissInfoTip()) { e.preventDefault(); e.stopPropagation(); } });
  }
  const btn = el('button', 'icon-btn re-info-btn');
  btn.type = 'button'; btn.dataset.tip = text; btn.setAttribute('aria-expanded', 'false');
  btn.ariaLabel = label ? `${label}: ${text}` : `${researchText.infoLabel()}: ${text}`;
  btn.append(researchIcon('info', 20));
  btn.addEventListener('pointerenter', () => { btn.classList.remove('is-dismissed'); syncTipShift(btn); });
  btn.addEventListener('pointerleave', () => { if (!btn.matches(':focus-visible')) btn.classList.remove('is-dismissed'); });
  btn.addEventListener('focus', () => syncTipShift(btn));
  btn.addEventListener('blur', () => { if (!btn.matches(':hover')) btn.classList.remove('is-dismissed'); });
  btn.addEventListener('click', e => {
    e.stopPropagation(); const opening = openTip !== btn; closeOpenTip();
    if (!opening) { btn.classList.add('is-dismissed'); return; }
    btn.classList.remove('is-dismissed'); syncTipShift(btn); openTip = btn; btn.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true');
  });
  return btn;
}
