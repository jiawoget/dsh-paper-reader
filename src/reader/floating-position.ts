import { byId } from './ui.js';

const inset = 8;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function passageGutters() {
  const paper = byId('paperScroll').getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = Math.max(paper.left, viewport?.offsetLeft ?? 0) + inset;
  const top = Math.max(paper.top, viewport?.offsetTop ?? 0) + inset;
  const right = Math.min(paper.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth)) - inset;
  const bottom = Math.min(paper.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight)) - inset;
  const original = byId('original').getBoundingClientRect();
  const gutterLeft = original.left - left - inset;
  const gutterRight = right - original.right - inset;
  return { original, top, bottom, gutterLeft, gutterRight };
}

export function hasPassageGutter(): boolean {
  const { gutterLeft, gutterRight } = passageGutters();
  return Math.max(gutterLeft, gutterRight) >= 226;
}

export function positionPassageCard(card: HTMLElement, selection: DOMRect): void {
  const { original, top, bottom, gutterLeft, gutterRight } = passageGutters();
  const width = Math.max(1, gutterLeft, gutterRight);
  card.style.setProperty('--window-max-width', width + 'px');
  card.style.setProperty('--window-max-height', Math.max(1, bottom - top) + 'px');
  const w = card.offsetWidth, h = card.offsetHeight;
  const leading = selection.left < original.left + original.width / 2;
  const useLeft = gutterLeft >= w && (leading || gutterRight < w);
  card.style.left = (useLeft ? original.left - w - inset : original.right + inset) + 'px';
  card.style.top = clamp(selection.top, top, bottom - h) + 'px';
}
