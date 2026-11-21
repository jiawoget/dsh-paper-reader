import { el, readerLabel } from '../ui.js';
import type { Passage } from './model.js';

/** The text view uses the same passage IDs as the original PDF. */
export function pageText(passages: Passage[], choose?: (passage: Passage, trigger: HTMLButtonElement) => void) {
  const root = el('section', 'pdf-reading-text');
  root.ariaLabel = 'Page text';
  root.hidden = true;
  const entries = new Map<string, { row: HTMLElement; text: HTMLElement }>();
  for (const passage of passages) {
    if (!passage.text.trim()) continue;
    const heading = passage.role === 'heading';
    const row = el('div', 'reading-passage');
    row.dataset.passageId = passage.id;
    row.dataset.role = passage.role;
    const text = el(heading ? 'h2' : 'p', '', passage.text);
    text.dir = 'auto';
    row.append(text);
    if (choose && !heading) {
      const caption = readerLabel('Use passage', '选中此段');
      const trigger = el('button', 'passage-pick', caption);
      trigger.type = 'button';
      trigger.ariaLabel = caption + ' · ' + passage.label;
      trigger.onclick = () => choose(passage, trigger);
      row.append(trigger);
    }
    root.append(row);
    entries.set(passage.id, { row, text });
  }
  return { root, entries };
}
