import type { SourceRecord } from './types.js';

export type AnnotationColor = 'yellow' | 'green' | 'purple';
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
