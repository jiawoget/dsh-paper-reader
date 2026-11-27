import { el } from '../ui.js';
import { researchText, type ResearchViewId } from './labels.js';

export type ResearchIconName =
  | 'expand' | 'collapse' | 'railToggle' | 'close'
  | 'read' | 'research' | 'ask-ai' | 'save' | 'saved' | 'info' | 'back' | 'external'
  | ResearchViewId;

const RESEARCH_ICON_PATHS: Record<ResearchIconName, string> = {
  expand: 'M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6',
  collapse: 'M4 14h6v6M20 10h-6V4M14 10l6-6M4 20l6-6',
  railToggle: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1M9 5v14',
  close: 'M6 6l12 12M18 6L6 18',
  read: 'M4 6.5C6.5 5 9.5 5.5 12 7c2.5-1.5 5.5-2 8-.5V18c-2.5-1.5-5.5-1-8 .5-2.5-1.5-5.5-2-8-.5zM12 7v11.5',
  research: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m3.6 5.4-2.1 5.1-5.1 2.1 2.1-5.1z',
  'ask-ai': 'M12 4.5l1.6 4.4 4.4 1.6-4.4 1.6L12 16.5l-1.6-4.4L6 10.5l4.4-1.6zM17.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  save: 'M6 4.5h12a1 1 0 0 1 1 1V20l-7-4-7 4V5.5a1 1 0 0 1 1-1M12 8.5v5M9.5 11h5',
  saved: 'M6 4.5h12a1 1 0 0 1 1 1V20l-7-4-7 4V5.5a1 1 0 0 1 1-1M9.2 11.2l1.8 1.8 3.8-3.8',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v5M12 8h.01',
  back: 'M19 12H5m6-6-6 6 6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6',
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

export function infoTip(text: string, label?: string): HTMLButtonElement {
  const btn = el('button', 'icon-btn re-info-btn');
  btn.type = 'button';
  btn.dataset.tip = text;
  btn.ariaLabel = label ? `${label}: ${text}` : `${researchText.infoLabel()}: ${text}`;
  btn.append(researchIcon('info', 20));
  return btn;
}
