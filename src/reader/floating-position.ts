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
  const w = card.offsetWidth;
  const leading = selection.left < original.left + original.width / 2;
  const current = card.dataset.gutter;
  const useLeft = current === 'left' && gutterLeft >= 200 ? true
    : current === 'right' && gutterRight >= 200 ? false
    : gutterLeft >= w && (leading || gutterRight < w);
  const gutterWidth = Math.max(1, useLeft ? gutterLeft : gutterRight);
  card.style.setProperty('--window-max-width', gutterWidth + 'px');
  card.style.setProperty('--window-max-height', Math.max(1, bottom - top) + 'px');
  const h = card.offsetHeight;
  card.dataset.gutter = useLeft ? 'left' : 'right';
  if (useLeft) {
    card.style.left = 'auto';
    card.style.right = Math.max(inset, document.documentElement.clientWidth - (original.left - inset)) + 'px';
  } else {
    card.style.right = 'auto';
    card.style.left = (original.right + inset) + 'px';
  }
  card.style.top = clamp(selection.top, top, bottom - h) + 'px';
}
