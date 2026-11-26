import type { SourceRecord } from './types.js';

export type AnnotationColor = 'yellow' | 'green' | 'purple';
export const ANNOTATION_COLORS: readonly AnnotationColor[] = ['yellow', 'green', 'purple'];
export const ANNOTATION_COLOR_META: Readonly<Record<AnnotationColor, { en: string; zh: string; meaningEn: string; meaningZh: string }>> = {
  yellow: { en: 'Yellow', zh: '黄色', meaningEn: 'Key point', meaningZh: '要点' },
  green: { en: 'Green', zh: '绿色', meaningEn: 'Method', meaningZh: '方法' },
  purple: { en: 'Purple', zh: '紫色', meaningEn: 'Question', meaningZh: '疑问' }
};
export interface PaperAnnotation extends SourceRecord {
  id: string;
  kind: 'highlight' | 'pin';
  color: AnnotationColor;
  quote: string;
  text: string;
  /** Position on the original PDF page, with its top-left at (0, 0). */
  point?: { x: number; y: number };
  createdAt: string;
  updatedAt: string;
}

/** A new or restored annotation uses its client-generated UUID. Edits send the revision being edited. */
export type AnnotationSaveInput = Omit<PaperAnnotation, 'createdAt' | 'updatedAt'> & { expectedUpdatedAt?: string };
