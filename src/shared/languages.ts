export const DEFAULT_TARGET_LANGUAGE = 'Simplified Chinese';
export const TARGET_LANGUAGE_MAX_LENGTH = 64;

interface TargetLanguagePreset {
  readonly id: string;
  readonly labelEn: string;
  readonly labelZh: string;
  readonly bcp47: string;
  /** Empty string '' maps to legacy translations/<docId>/<page>.json. */
  readonly slug: string;
}

export const TARGET_LANGUAGE_PRESETS: readonly TargetLanguagePreset[] = [
  { id: 'Simplified Chinese', labelEn: 'Simplified Chinese', labelZh: '简体中文', bcp47: 'zh-CN', slug: '' },
  { id: 'Traditional Chinese', labelEn: 'Traditional Chinese', labelZh: '繁体中文', bcp47: 'zh-TW', slug: 'zh-tw' },
  { id: 'English', labelEn: 'English', labelZh: '英语', bcp47: 'en', slug: 'en' },
  { id: 'Japanese', labelEn: 'Japanese', labelZh: '日语', bcp47: 'ja', slug: 'ja' },
  { id: 'Korean', labelEn: 'Korean', labelZh: '韩语', bcp47: 'ko', slug: 'ko' },
  { id: 'French', labelEn: 'French', labelZh: '法语', bcp47: 'fr', slug: 'fr' },
  { id: 'German', labelEn: 'German', labelZh: '德语', bcp47: 'de', slug: 'de' },
  { id: 'Spanish', labelEn: 'Spanish', labelZh: '西班牙语', bcp47: 'es', slug: 'es' }
];

const simplifiedChinesePattern = /^(?:simplified chinese|chinese(?:\s*\(simplified\))?|zh(?:[-_](?:cn|hans)(?:[-_]cn)?)?)$/i;
const traditionalChinesePattern = /^(?:traditional chinese|chinese(?:\s*\(traditional\))?|zh[-_](?:tw|hk|mo|hant)(?:[-_](?:tw|hk|mo))?)$/i;
const controlChars = /[\u0000-\u001f\u007f]/;

export function targetsSimplifiedChinese(language: string): boolean {
  return simplifiedChinesePattern.test(language.trim());
}

export function findTargetLanguagePreset(language: string): TargetLanguagePreset | undefined {
  const trimmed = language.trim();
  if (!trimmed) return undefined;
  if (targetsSimplifiedChinese(trimmed)) return TARGET_LANGUAGE_PRESETS[0];
  if (traditionalChinesePattern.test(trimmed)) return TARGET_LANGUAGE_PRESETS[1];
  const lower = trimmed.toLowerCase();
  return TARGET_LANGUAGE_PRESETS.find(preset => preset.id.toLowerCase() === lower);
}

/** Returns BCP-47 tag for curated presets; undefined for custom languages (caller omits `lang` attribute). */
export function targetLanguageBcp47(language: string): string | undefined {
  return findTargetLanguagePreset(language)?.bcp47;
}

/** Localized display name for curated presets; trimmed raw string for custom languages. */
export function targetLanguageLabel(language: string, zh: boolean): string {
  const preset = findTargetLanguagePreset(language);
  if (!preset) return language.trim() || DEFAULT_TARGET_LANGUAGE;
  return zh ? preset.labelZh : preset.labelEn;
}

/**
 * Pure validator shared by backend (HTTP 400) and frontend form validation.
 * Checks control characters on the raw string before trimming so trailing '\n', '\r', '\t', or '\0' are rejected.
 */
export function parseTargetLanguage(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'Target language must be a non-empty string.' };
  if (controlChars.test(value)) return { ok: false, error: 'Target language contains invalid control characters.' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'Enter a target language.' };
  if (trimmed.length > TARGET_LANGUAGE_MAX_LENGTH || value.length > 256) {
    return { ok: false, error: 'Target language must be at most 64 characters.' };
  }
  return { ok: true, value: trimmed };
}
