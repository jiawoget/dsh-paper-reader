import type { ReaderBlock } from '../../shared/types.js';

/** Coordinates are PDF.js viewport points at scale one, measured from the top-left. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PassageRole = 'paragraph' | 'heading' | 'caption';

export interface SentencePair { original: string; translated: string }

export interface Passage extends ReaderBlock {
  label: string;
  role: PassageRole;
  box: Box;
  fontSize: number;
  /** Indices into the unmarked PDF.js text layer. */
  indices: number[];
  illustration?: Box;
  sentencePairs?: SentencePair[];
}

export interface PageLayout {
  window: Box;
  passages: Passage[];
  /** Earlier versions allowed saved selections on blocks now recognized as artwork. */
  sourceOnly?: Passage[];
  registered?: boolean;
  /** Old extraction anchors may overlap several of the paper's printed paragraphs. */
  aliases?: Map<string, string[]>;
}

export interface PageGraphics {
  forms: Box[];
  horizontalRules: Box[];
}

export function box(x: number, y: number, width: number, height: number): Box {
  return { x, y, width, height };
}
