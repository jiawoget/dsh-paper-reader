import { DEFAULT_TARGET_LANGUAGE, TARGET_LANGUAGE_PRESETS, findTargetLanguagePreset, targetLanguageLabel, targetsSimplifiedChinese } from '../shared/languages.js';
import type { PageView, Settings } from '../shared/types.js';
import type { TranslationFocus } from './pdf/focus.js';
import { api, byId, el, icon, message, readerLabel as label, toast } from './ui.js';

export type ZoomSetting = 'fit-page' | number;
type PdfTheme = 'paper' | 'sepia' | 'dim' | 'dark';

const ZOOM_STEPS: readonly number[] = [0.75, 1, 1.25, 1.5, 2];
const THEME_KEY = 'reader.pdf.theme', CUSTOM_LANG = '__custom__';
const PDF_THEMES: readonly [PdfTheme, string, string][] = [
  ['paper', 'Paper', '纸张白'], ['sepia', 'Warm Sepia', '暖米黄'],
  ['dim', 'Low-Glare Dim', '柔和护眼'], ['dark', 'Smart Dark', '智能深色']
];

export function parseZoom(value: unknown): ZoomSetting {
  if (value === 'fit-page') return 'fit-page';
  const n = typeof value === 'number' ? value : Number(value);
  return ZOOM_STEPS.includes(n) ? n : 1;
}

interface PdfControlsHost {
  getZoom: () => ZoomSetting;
  setZoom: (value: ZoomSetting) => void;
  getTargetLanguage: () => string;
  onTargetLanguageSaved: () => Promise<void>;
  openLanguageSettings: () => void;
  onRetranslatePage: () => Promise<void>;
  onFocusChange: (mode: TranslationFocus) => void;
  closeMenu: (restoreFocus?: boolean) => void;
}

export async function runRetranslate(
  opts: { docId: string; page: number; isPdf: boolean; target: string; settings: Settings; view: PageView; blockIds?: string[]; isActive: () => boolean },
  onApply: (translations: Record<string, string>) => void,
  openSettings: () => void
): Promise<void> {
  const canLocal = Boolean(opts.settings.localTranslationAvailable && targetsSimplifiedChinese(opts.target));
  if (opts.settings.aiMode === 'unconfigured' && !canLocal) { openSettings(); return; }
  const wanted = opts.blockIds?.length ? new Set(opts.blockIds) : undefined;
  const blocks = opts.view.blocks.filter(b => b.text.trim() && (!wanted || wanted.has(b.id)));
  if (!blocks.length) return;
  const { translations } = await api('translation.page', { docId: opts.docId, page: opts.page, targetLanguage: opts.target, blocks: blocks.map(({ id, text }) => ({ id, text })), force: true });
  if (!opts.isActive()) return;
  opts.view.setTranslations?.(translations, true);
  onApply(translations);
}

export interface PdfControlsHandle {
  stepZoom(delta: -1 | 1): void;
  syncZoom(value: ZoomSetting): void;
  syncDocument(isPdf: boolean): void;
  syncTargetLanguage(target: string): void;
  syncFocus(effective: TranslationFocus, focusLabel: string, degraded: boolean, preferred: TranslationFocus): void;
  syncRetranslate(visible: boolean): void;
}

export function bindPdfControls(host: PdfControlsHost): PdfControlsHandle {
  const reader = byId('reader'), zoomSelect = byId<HTMLSelectElement>('zoom');
  const zoomOut = byId<HTMLButtonElement>('zoomOut'), zoomIn = byId<HTMLButtonElement>('zoomIn');
  const themeControl = byId('pdfThemeControl'), themeBtn = byId<HTMLButtonElement>('pdfThemeBtn'), themeMenu = byId('pdfThemeMenu');
  const langSelect = byId<HTMLSelectElement>('targetLang'), retranslateBtn = byId<HTMLButtonElement>('retranslatePage');
  const info = byId('translationInfo'), scope = byId<HTMLSelectElement>('translationMode');

  zoomSelect.ariaLabel = label('Zoom', '缩放');
  byId('zoomControl').querySelector('label')!.textContent = zoomSelect.ariaLabel;
  zoomSelect.options[0].text = label('Fit page', '适合整页');
  zoomSelect.options[2].text = label('Fit width', '适合宽度');
  zoomOut.ariaLabel = zoomOut.title = label('Decrease scale', '缩小');
  zoomIn.ariaLabel = zoomIn.title = label('Increase scale', '放大');
  zoomOut.replaceChildren(icon('minimize', 14));
  zoomIn.replaceChildren(icon('plus', 14));

  const syncZoom = (value: ZoomSetting) => {
    zoomSelect.value = String(value);
    zoomOut.disabled = value === ZOOM_STEPS[0];
    zoomIn.disabled = value === ZOOM_STEPS.at(-1);
  };
  const stepZoom = (delta: -1 | 1) => {
    const current = host.getZoom();
    const index = typeof current === 'number' ? ZOOM_STEPS.indexOf(current) : (delta > 0 ? 0 : 1);
    const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index < 0 ? 1 : index) + delta))];
    if (next !== current) { syncZoom(next); host.setZoom(next); }
  };
  zoomOut.addEventListener('click', () => stepZoom(-1));
  zoomIn.addEventListener('click', () => stepZoom(1));
  zoomSelect.addEventListener('change', () => {
    const next = parseZoom(zoomSelect.value);
    syncZoom(next); host.setZoom(next);
    if (byId('menu').contains(zoomSelect)) host.closeMenu(true);
  });

  let lastWheel = 0;
  byId('paperScroll').addEventListener('wheel', event => {
    if (!(event.ctrlKey || event.metaKey) || document.querySelector('dialog[open]') || reader.dataset.pageFormat === 'text') return;
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 130 || event.deltaY === 0) return;
    lastWheel = now;
    stepZoom(event.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  const savedTheme = localStorage.getItem(THEME_KEY);
  let pdfTheme: PdfTheme = PDF_THEMES.some(([id]) => id === savedTheme) ? savedTheme as PdfTheme : 'paper';
  const themeLabel = label('PDF paper theme', 'PDF 页面主题');
  themeBtn.ariaLabel = themeBtn.title = themeMenu.ariaLabel = themeLabel;
  const themeText = themeBtn.querySelector('.pdf-theme-label');
  if (themeText) themeText.textContent = themeLabel;
  const themeItems = new Map<PdfTheme, HTMLButtonElement>();
  const applyTheme = (next: PdfTheme, persist: boolean) => {
    pdfTheme = next; reader.dataset.pdfTheme = next;
    if (persist) localStorage.setItem(THEME_KEY, next);
    for (const [id, btn] of themeItems) btn.setAttribute('aria-checked', String(id === next));
  };
  themeMenu.replaceChildren();
  for (const [id, en, zh] of PDF_THEMES) {
    const item = el('button', 'pdf-theme-option'), swatch = el('span', 'pdf-theme-swatch');
    item.type = 'button'; item.setAttribute('role', 'menuitemradio'); item.dataset.themeOption = id; swatch.dataset.swatch = id;
    item.append(swatch, el('span', '', label(en, zh)));
    item.addEventListener('click', () => {
      applyTheme(id, true);
      if (themeMenu.matches(':popover-open')) themeMenu.hidePopover();
      if (byId('menu').contains(themeControl)) host.closeMenu(true);
      else themeBtn.focus({ preventScroll: true });
    });
    themeItems.set(id, item); themeMenu.append(item);
  }
  applyTheme(pdfTheme, false);
  themeMenu.addEventListener('toggle', () => {
    const open = themeMenu.matches(':popover-open');
    themeBtn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const anchor = themeBtn.getBoundingClientRect(), w = themeMenu.offsetWidth || 168, h = themeMenu.offsetHeight || 156;
    const below = anchor.bottom + 6 + h <= innerHeight - 8;
    themeMenu.style.top = Math.max(8, Math.min(innerHeight - h - 8, below ? anchor.bottom + 6 : anchor.top - h - 6)) + 'px';
    themeMenu.style.left = Math.max(8, Math.min(anchor.left, innerWidth - w - 8)) + 'px';
    themeItems.get(pdfTheme)?.focus({ preventScroll: true });
  });
  themeMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (themeMenu.matches(':popover-open')) themeMenu.hidePopover();
      themeBtn.focus({ preventScroll: true }); return;
    }
    const items = [...themeItems.values()], index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index <= 0 ? items.length - 1 : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); items[next].focus({ preventScroll: true }); }
  });
  window.addEventListener('resize', () => { if (themeMenu.matches(':popover-open')) themeMenu.hidePopover(); });

  langSelect.ariaLabel = langSelect.title = label('Translation language', '翻译目标语言');
  const syncTargetLanguage = (target: string) => {
    const current = target || DEFAULT_TARGET_LANGUAGE, preset = findTargetLanguagePreset(current);
    langSelect.replaceChildren();
    for (const item of TARGET_LANGUAGE_PRESETS) {
      const option = el('option', '', label(item.labelEn, item.labelZh)); option.value = item.id; langSelect.append(option);
    }
    if (!preset) {
      const customCurrent = el('option', '', targetLanguageLabel(current, /^zh(?:-|$)/i.test(navigator.language)));
      customCurrent.value = current; langSelect.append(customCurrent);
    }
    const customTrigger = el('option', '', label('Custom…', '自定义…')); customTrigger.value = CUSTOM_LANG; langSelect.append(customTrigger);
    langSelect.value = preset ? preset.id : current;
  };
  langSelect.addEventListener('change', async () => {
    const chosen = langSelect.value;
    if (chosen === CUSTOM_LANG) { syncTargetLanguage(host.getTargetLanguage()); host.openLanguageSettings(); return; }
    if (chosen === host.getTargetLanguage()) return;
    langSelect.disabled = true;
    try { await api('settings.save', { targetLanguage: chosen }); await host.onTargetLanguageSaved(); }
    catch (error) { syncTargetLanguage(host.getTargetLanguage()); toast(message(error)); }
    finally { langSelect.disabled = false; }
  });

  const retranslateLabel = label('Re-translate', '重新翻译');
  const retranslateText = el('span', 'retranslate-label', retranslateLabel);
  retranslateBtn.replaceChildren(icon('refresh', 14), retranslateText);
  retranslateBtn.ariaLabel = retranslateBtn.title = label('Re-translate page', '重新翻译本页');
  retranslateBtn.addEventListener('click', async () => {
    retranslateBtn.disabled = true; retranslateText.textContent = label('Re-translating…', '正在重译…');
    try { await host.onRetranslatePage(); }
    catch (error) { toast(message(error)); }
    finally { retranslateBtn.disabled = false; retranslateText.textContent = retranslateLabel; }
  });
  scope.ariaLabel = scope.title = label('Translation scope', '译文范围');
  scope.options[0].text = label('Full page', '整页译文');
  scope.options[1].text = label('Active column', '当前栏');
  scope.options[2].text = label('Active passage', '当前段');
  scope.addEventListener('change', () => host.onFocusChange(scope.value as TranslationFocus));

  syncZoom(host.getZoom()); syncTargetLanguage(host.getTargetLanguage());

  return {
    stepZoom, syncZoom, syncTargetLanguage,
    syncDocument(isPdf: boolean) {
      themeControl.hidden = !isPdf; zoomSelect.options[0].hidden = !isPdf;
      if (!isPdf) {
        if (zoomSelect.value === 'fit-page') zoomSelect.value = '1';
        info.hidden = true; info.textContent = ''; if (themeMenu.matches(':popover-open')) themeMenu.hidePopover();
      } else syncZoom(host.getZoom());
    },
    syncFocus(effective: TranslationFocus, focusLabel: string, degraded: boolean, preferred: TranslationFocus) {
      info.hidden = effective === 'page'; info.textContent = effective === 'page' ? '' : focusLabel;
      scope.value = degraded ? 'column' : preferred; scope.dataset.autoDegraded = String(degraded);
      scope.title = degraded ? label('Auto-switched to Active column for readability on a narrow pane.', '双语栏较窄，已自动切换为当前栏以保证字号清晰。') : label('Translation scope', '译文范围');
    },
    syncRetranslate(visible: boolean) { retranslateBtn.hidden = !visible; }
  };
}
