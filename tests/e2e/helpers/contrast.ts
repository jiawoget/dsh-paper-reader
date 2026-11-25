import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import { inCardShadow } from '../extension-controls.js';

type Rgba = [number, number, number, number];

export interface ColorMetrics {
  fg: string; bg: string; fgLum: number; bgLum: number;
  ratio: number; fontSize: number; colorScheme: string;
}
export interface BorderMetrics extends ColorMetrics { borderWidth: number; }
export interface RawElementSample {
  fg: string; layers: string[]; darkRoot: boolean; fontSize: number; colorScheme: string;
}
export interface RawBorderSample extends RawElementSample {
  parentLayers: string[]; borderTopColor: string; borderTopWidth: number;
}
export interface ShadowCardMetrics extends ColorMetrics {
  borderTopWidth: number; borderColor: string; borderRatio: number; boxShadow: string;
  lang: string | null; ariaLabel: string | null; closeAria: string | null;
  translate: string | null; note: string | null; hint: string | null;
}

export function parseCssColor(raw: string): Rgba {
  if (!raw || raw === 'transparent') return [0, 0, 0, 0];
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(raw);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] !== undefined ? Number(srgb[4]) : 1];
  const rgba = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)/.exec(raw);
  if (!rgba) return [0, 0, 0, 1];
  const a = rgba[4] === undefined ? 1 : rgba[4].endsWith('%') ? parseFloat(rgba[4]) / 100 : Number(rgba[4]);
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), a];
}

export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3], outA = a + bottom[3] * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  return [0, 1, 2].map(i => (top[i] * a + bottom[i] * bottom[3] * (1 - a)) / outA).concat(outA) as Rgba;
}

export function relLum(rgb: Rgba): number {
  const chan = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
}

export function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function resolveBg(layers: string[], darkRoot: boolean, darkBase: Rgba = [19, 22, 31, 1]): Rgba {
  let acc: Rgba = darkRoot ? darkBase : [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = parseCssColor(layers[i]);
    if (layer[3] > 0) acc = composite(layer, acc);
  }
  return acc;
}

export function computeElementMetrics(sample: RawElementSample, darkBase?: Rgba): ColorMetrics {
  const bg = resolveBg(sample.layers, sample.darkRoot, darkBase);
  const fgRaw = parseCssColor(sample.fg);
  const fg = fgRaw[3] < 1 ? composite(fgRaw, bg) : fgRaw;
  const fgLum = relLum(fg), bgLum = relLum(bg);
  return {
    fg: sample.fg, bg: `rgb(${Math.round(bg[0])}, ${Math.round(bg[1])}, ${Math.round(bg[2])})`,
    fgLum, bgLum, ratio: contrastRatio(fgLum, bgLum), fontSize: sample.fontSize, colorScheme: sample.colorScheme
  };
}

export function computeBorderMetrics(sample: RawBorderSample, darkBase?: Rgba): BorderMetrics {
  const bg = resolveBg(sample.layers, sample.darkRoot, darkBase);
  const parentBg = resolveBg(sample.parentLayers, sample.darkRoot, darkBase);
  const borderRaw = parseCssColor(sample.borderTopColor);
  const onBg = borderRaw[3] < 1 ? composite(borderRaw, bg) : borderRaw;
  const onParent = borderRaw[3] < 1 ? composite(borderRaw, parentBg) : borderRaw;
  const ratio = Math.min(contrastRatio(relLum(onBg), relLum(bg)), contrastRatio(relLum(onParent), relLum(parentBg)));
  return {
    fg: sample.borderTopColor, bg: `rgb(${Math.round(bg[0])}, ${Math.round(bg[1])}, ${Math.round(bg[2])})`,
    fgLum: relLum(onBg), bgLum: relLum(bg), ratio, borderWidth: sample.borderTopWidth,
    fontSize: sample.fontSize, colorScheme: sample.colorScheme
  };
}

export async function measureLocator(locator: Locator, fgProp = 'color', pseudo?: string): Promise<ColorMetrics> {
  const sample = await locator.evaluate((el, arg) => {
    const layers: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) layers.push(getComputedStyle(cur).backgroundColor);
    const style = getComputedStyle(el, arg.pseudo || null);
    const darkRoot = document.documentElement.dataset.theme === 'dark' || getComputedStyle(document.documentElement).colorScheme.includes('dark');
    const prop = arg.fgProp as 'color' | 'backgroundColor' | 'outlineColor';
    return { fg: style[prop] || style.color, layers, darkRoot, fontSize: parseFloat(style.fontSize) || 0, colorScheme: style.colorScheme };
  }, { fgProp, pseudo });
  return computeElementMetrics(sample);
}

export async function assertContrast(locator: Locator, name: string, minRatio = 4.5, fgProp = 'color', pseudo?: string): Promise<ColorMetrics> {
  const m = await measureLocator(locator, fgProp, pseudo);
  assert.ok(m.ratio >= minRatio, `${name}: expected contrast >= ${minRatio}:1, got ${m.ratio.toFixed(2)}:1 (fg=${m.fg} lum=${m.fgLum.toFixed(3)}, bg=${m.bg} lum=${m.bgLum.toFixed(3)})`);
  return m;
}

export async function assertBorderContrast(locator: Locator, name: string, minRatio = 3.0): Promise<BorderMetrics> {
  const sample = await locator.evaluate(el => {
    const layers: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) layers.push(getComputedStyle(cur).backgroundColor);
    const parentLayers = el.parentElement ? layers.slice(1) : layers;
    const style = getComputedStyle(el);
    const darkRoot = document.documentElement.dataset.theme === 'dark' || getComputedStyle(document.documentElement).colorScheme.includes('dark');
    return {
      fg: style.color, layers, parentLayers, darkRoot,
      borderTopColor: style.borderTopColor, borderTopWidth: parseFloat(style.borderTopWidth) || 0,
      fontSize: parseFloat(style.fontSize) || 0, colorScheme: style.colorScheme
    };
  });
  const m = computeBorderMetrics(sample);
  assert.ok(m.borderWidth >= 1, `${name}: expected visible >= 1px border, got ${m.borderWidth}px`);
  assert.ok(m.ratio >= minRatio, `${name}: expected border contrast >= ${minRatio}:1 (WCAG SC 1.4.11), got ${m.ratio.toFixed(2)}:1 (border=${m.fg}, bg=${m.bg})`);
  return m;
}

export async function assertBorderContrastBothThemes(page: Page, locator: Locator, name: string, minRatio = 3.0): Promise<void> {
  await assertBorderContrast(locator, `${name} (dark)`, minRatio);
  await page.emulateMedia({ colorScheme: 'light' });
  try { await assertBorderContrast(locator, `${name} (light)`, minRatio); }
  finally { await page.emulateMedia({ colorScheme: 'dark' }); }
}

export async function assertDarkSurface(locator: Locator, name: string, maxBgLum = 0.08): Promise<ColorMetrics> {
  const m = await measureLocator(locator);
  assert.ok(m.bgLum <= maxBgLum, `${name}: expected dark surface lum <= ${maxBgLum}, got ${m.bgLum.toFixed(4)} (${m.bg})`);
  return m;
}

export async function assertDarkAndContrast(locator: Locator, label: string, maxBgLum = 0.12, minRatio = 4.5): Promise<ColorMetrics> {
  const m = await assertDarkSurface(locator, label, maxBgLum);
  assert.ok(m.ratio >= minRatio, `${label}: expected contrast >= ${minRatio}:1, got ${m.ratio.toFixed(2)}:1 (fg=${m.fg}, bg=${m.bg})`);
  return m;
}

export async function inspectShadowCardMetrics(page: Page, selector = '.card'): Promise<ShadowCardMetrics | null> {
  type RawShadow = RawBorderSample & Pick<ShadowCardMetrics, 'boxShadow' | 'lang' | 'ariaLabel' | 'closeAria' | 'translate' | 'note' | 'hint'>;
  const raw = await inCardShadow<RawShadow>(page, function(this: ShadowRoot, query: string) {
    const el = this.querySelector<HTMLElement>(query), cardEl = this.querySelector<HTMLElement>('.card');
    if (!el) return null;
    const layers: string[] = [];
    for (let c: Element | null = el; c?.nodeType === 1; c = c.parentElement) layers.push(getComputedStyle(c).backgroundColor);
    const style = getComputedStyle(el);
    return {
      fg: style.color, layers, parentLayers: el.parentElement ? layers.slice(1) : layers,
      darkRoot: cardEl ? getComputedStyle(cardEl).colorScheme.includes('dark') : false,
      borderTopColor: style.borderTopColor, borderTopWidth: parseFloat(style.borderTopWidth) || 0,
      fontSize: parseFloat(style.fontSize) || 0, colorScheme: style.colorScheme, boxShadow: style.boxShadow,
      lang: cardEl?.getAttribute('lang') ?? null, ariaLabel: cardEl?.getAttribute('aria-label') ?? null,
      closeAria: this.querySelector('[data-do="close"]')?.getAttribute('aria-label') ?? null,
      translate: this.querySelector('[data-do="translate"]')?.textContent ?? null,
      note: this.querySelector('[data-do="note"]')?.textContent ?? null,
      hint: this.querySelector('.answer')?.textContent ?? null
    };
  }.toString(), [selector]);
  if (!raw) return null;
  const darkBase: Rgba = [29, 32, 43, 1];
  return {
    ...computeElementMetrics(raw, darkBase),
    borderTopWidth: raw.borderTopWidth, borderColor: raw.borderTopColor, borderRatio: computeBorderMetrics(raw, darkBase).ratio,
    boxShadow: raw.boxShadow, lang: raw.lang, ariaLabel: raw.ariaLabel, closeAria: raw.closeAria,
    translate: raw.translate, note: raw.note, hint: raw.hint
  };
}
