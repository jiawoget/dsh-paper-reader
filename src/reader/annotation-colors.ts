import { ANNOTATION_COLORS, ANNOTATION_COLOR_META, type AnnotationColor, type PaperAnnotation } from '../shared/annotations.js';
import { button, el, readerLabel as label } from './ui.js';

export { ANNOTATION_COLORS };

export interface AnnotationFilter {
  kind: PaperAnnotation['kind'] | 'all';
  color: AnnotationColor | 'all';
  query: string;
}

export interface MarksFilterControls {
  nodes: HTMLElement[];
  search: HTMLInputElement;
  sync(filter: AnnotationFilter): void;
  reset(): void;
}

function colorName(color: AnnotationColor): string {
  const meta = ANNOTATION_COLOR_META[color];
  return label(meta.en, meta.zh);
}

export function colorMeaning(color: AnnotationColor): string {
  const meta = ANNOTATION_COLOR_META[color];
  return label(meta.meaningEn, meta.meaningZh);
}

export function highlightName(color: AnnotationColor): string {
  return colorName(color) + label(' highlight', '高亮');
}

export function highlightColorLabel(color: AnnotationColor): string {
  return colorName(color) + ' · ' + colorMeaning(color);
}

export function highlightDotAriaLabel(color: AnnotationColor): string {
  return highlightName(color) + ' · ' + colorMeaning(color);
}

export function filterAnnotations(
  items: readonly PaperAnnotation[],
  filter: AnnotationFilter,
  quoteOf: (note: PaperAnnotation) => string
): PaperAnnotation[] {
  const needle = filter.query.trim().toLowerCase();
  return items
    .filter(note => {
      if (filter.kind !== 'all' && note.kind !== filter.kind) return false;
      if (filter.kind !== 'pin' && filter.color !== 'all' && (note.kind !== 'highlight' || note.color !== filter.color)) return false;
      if (!needle) return true;
      return [quoteOf(note), note.quote, note.text, note.label].some(part => part.toLowerCase().includes(needle));
    })
    .sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function buildMarksFilters(
  onKind: (kind: AnnotationFilter['kind']) => void,
  onColor: (color: AnnotationFilter['color']) => void,
  onQuery: (query: string) => void
): MarksFilterControls {
  const kindButtons = new Map<AnnotationFilter['kind'], HTMLButtonElement>();
  const colorButtons = new Map<AnnotationFilter['color'], HTMLButtonElement>();
  const categories = el('div', 'annotation-filters');
  categories.setAttribute('role', 'group');
  categories.ariaLabel = label('Filter marks', '筛选标记');
  for (const [value, caption] of [['all', label('All', '全部')], ['highlight', label('Highlights', '高亮')], ['pin', label('Page notes', '页边笔记')]] as const) {
    const choice = button(caption, () => onKind(value), 'annotation-filter');
    choice.dataset.filter = value;
    kindButtons.set(value, choice);
    categories.append(choice);
  }
  const colorFilters = el('div', 'annotation-color-filters');
  colorFilters.setAttribute('role', 'group');
  colorFilters.ariaLabel = label('Filter by color', '按颜色筛选');
  const allColors = button(label('All colors', '全部颜色'), () => onColor('all'), 'annotation-color-filter');
  allColors.dataset.colorFilter = 'all';
  colorButtons.set('all', allColors);
  colorFilters.append(allColors);
  for (const color of ANNOTATION_COLORS) {
    const choice = button(colorMeaning(color), () => onColor(color), 'annotation-color-filter');
    choice.dataset.color = choice.dataset.colorFilter = color;
    choice.ariaLabel = choice.title = highlightColorLabel(color);
    colorButtons.set(color, choice);
    colorFilters.append(choice);
  }
  const search = el('input', 'search annotation-search');
  search.type = 'search';
  search.ariaLabel = label('Filter marks by keyword', '按关键词筛选标记');
  search.placeholder = label('Filter marks…', '按引文或备注筛选…');
  search.oninput = () => onQuery(search.value);
  return {
    nodes: [el('h2', '', label('Marks', '标记')), categories, colorFilters, search],
    search,
    sync(filter) {
      for (const [value, btn] of kindButtons) btn.setAttribute('aria-pressed', String(filter.kind === value));
      for (const [value, btn] of colorButtons) btn.setAttribute('aria-pressed', String(filter.color === value));
      colorFilters.hidden = filter.kind === 'pin';
    },
    reset() {
      search.value = '';
    }
  };
}

export function hasActiveMarksFilter(filter: AnnotationFilter): boolean {
  return (filter.kind !== 'pin' && filter.color !== 'all') || filter.query.trim().length > 0;
}

export function buildEmptyMarksNotice(
  hasAny: boolean,
  filter: AnnotationFilter,
  onClear: () => void
): HTMLElement {
  if (hasAny && hasActiveMarksFilter(filter)) {
    const empty = el('div', 'annotation-empty');
    empty.append(
      el('p', 'hint', label('No marks match the current filter.', '没有符合当前筛选条件的标记。')),
      button(label('Clear filters', '清除筛选'), onClear, 'text-btn')
    );
    return empty;
  }
  return el('p', 'hint', filter.kind === 'all'
    ? label('Your highlights and page notes appear here.', '这里会显示高亮和页边笔记。')
    : filter.kind === 'pin'
      ? label('No page notes for this paper.', '本篇暂无页边笔记。')
      : label('No highlights for this paper.', '本篇暂无高亮。'));
}

export function buildColorPalette(
  current: AnnotationColor,
  onSelect: (color: AnnotationColor) => void
): HTMLElement {
  const palette = el('fieldset', 'annotation-palette');
  palette.append(el('legend', '', label('Highlight color', '高亮颜色')));
  const buttons: HTMLButtonElement[] = [];
  for (const color of ANNOTATION_COLORS) {
    const choice = button(colorName(color), () => {
      onSelect(color);
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.color === color));
    }, 'annotation-swatch');
    const role = el('span', 'annotation-swatch-role', ' · ' + colorMeaning(color));
    role.setAttribute('aria-hidden', 'true');
    choice.append(role);
    choice.dataset.color = color;
    choice.title = highlightColorLabel(color);
    choice.setAttribute('aria-description', colorMeaning(color));
    choice.setAttribute('aria-pressed', String(current === color));
    buttons.push(choice);
    palette.append(choice);
  }
  return palette;
}
