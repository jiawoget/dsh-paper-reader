export interface PdfOutlineEntry {
  title: string;
  page: number;
  /** One denotes a top-level section. */
  level: number;
  /** Fraction of the displayed page height, measured down from its top edge. */
  top?: number;
}

export interface PdfOutlineLine {
  text: string;
  top: number;
  prominent?: boolean;
}

export interface PdfOutlinePage {
  /** One-based physical page number in the original PDF. */
  page: number;
  lines: PdfOutlineLine[];
}

export const maxOutlineLinesPerPage = 12;
export const maxOutlineLineLength = 180;
