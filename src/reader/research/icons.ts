import type { ResearchViewId } from './labels.js';

type ResearchIconName = 'expand' | 'collapse' | 'railToggle' | 'close' | ResearchViewId;

const RESEARCH_ICON_PATHS: Record<ResearchIconName, string> = {
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  collapse: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  railToggle: 'M3 5h18v14H3zM9 5v14',
  close: 'M6 6l12 12M18 6L6 18',
  'deep-search': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14m9 16-4.35-4.35M11 8v6M8 11h6',
  'citation-map': 'M6 6a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5m12 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M12 15a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M8.3 9.5l2.5 5.6m4.9-5.6-2.5 5.6M8.5 8.5h7',
  citations: 'M5 10h4v6H5zm0 0c0-3 1.5-5 4-6m6 6h4v6h-4zm0 0c0-3 1.5-5 4-6',
  'review-table': 'M3 5h18v14H3zM3 10h18M9 5v14M15 5v14',
  'field-trends': 'M4 19h16M6 15l4-4 3 3 5-7M15 7h3v3',
  'library-chat': 'M4 5h16v11H9l-5 4zM8 9h8M8 12.5h5'
};

export function researchIcon(name: ResearchIconName, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
  })) svg.setAttribute(k, String(v));
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', RESEARCH_ICON_PATHS[name]);
  svg.append(path);
  return svg;
}
