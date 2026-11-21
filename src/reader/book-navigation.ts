import type { DocumentInfo } from '../shared/types.js';
import { button, byId, el, readerLabel as label } from './ui.js';

export function showSectionControls(doc: DocumentInfo, page: number): void {
  const previous = byId<HTMLButtonElement>('previousSection'), next = byId<HTMLButtonElement>('nextSection');
  const sections = doc.book?.sections;
  byId('articleNavigation').hidden = previous.hidden = next.hidden = !sections;
  if (!sections) return;
  previous.disabled = page <= 1;
  next.disabled = page >= sections.length;
}

export function sectionFooter(sheet: HTMLElement, doc: DocumentInfo, page: number, go: (page: number) => Promise<void>): void {
  if (!doc.book) return;
  const controls = el('nav', 'book-section-footer');
  controls.ariaLabel = label('Continue reading', '继续阅读');
  for (const step of [-1, 1]) {
    const section = doc.book.sections[page + step - 1];
    if (!section) continue;
    const caption = step < 0 ? label('Previous section', '上一节') : label('Next section', '下一节');
    const action = button('', () => go(page + step), step < 0 ? 'previous' : 'next');
    action.append(el('small', '', caption), el('span', '', section.title));
    controls.append(action);
  }
  sheet.append(controls);
}
