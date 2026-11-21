import { box, type Box, type PassageRole } from './model.js';

// Positions refer to the authors' 612 × 792 pt v1 page. The inset matches the
// supplied reference while retaining the figures, captions and printed page number.
export const sampleDigest = '55b3b324d779a67c59dac2519445e3b07c14e6ff5c656fadb47a3d7b5997469e';
export const sampleWindow = box(38, 53, 536, 688);

export interface AnnotatedArea {
  id: string;
  label: string;
  role: PassageRole;
  box: Box;
  illustration?: Box;
}

export const sampleAreas: readonly AnnotatedArea[] = [
  {
    id: 'figure-6', label: 'Figure 6', role: 'caption', box: box(54, 194, 240, 17),
    illustration: box(54, 70, 240, 118),
  },
  {
    id: 'block-tables', label: 'Left column · Block tables', role: 'paragraph', box: box(53.5, 217, 241, 122),
  },
  {
    id: 'section-4-3', label: 'Section 4.3', role: 'heading', box: box(54, 342, 240, 16),
  },
  {
    id: 'decoding-steps', label: 'Section 4.3 · Decoding one sequence', role: 'paragraph', box: box(53.5, 359, 241, 299),
  },
  {
    id: 'iteration-input', label: 'Section 4.3 · Batching', role: 'paragraph', box: box(53.5, 659, 241, 61),
  },
  {
    id: 'figure-7', label: 'Figure 7', role: 'caption', box: box(317.5, 176, 241, 26),
    illustration: box(317.5, 70, 241, 100),
  },
  {
    id: 'iteration-compute', label: 'Section 4.3 · Parallel cache access', role: 'paragraph', box: box(317.5, 214, 241, 132),
  },
  {
    id: 'two-requests', label: 'Section 4.3 · Memory for two requests', role: 'paragraph', box: box(317.5, 346.5, 241, 204),
  },
  {
    id: 'section-4-4', label: 'Section 4.4', role: 'heading', box: box(317.5, 553.5, 241, 16),
  },
  {
    id: 'other-decoding', label: 'Section 4.4 · Decoding scenarios', role: 'paragraph', box: box(317.5, 570.5, 241, 97),
  },
  {
    id: 'parallel-sampling', label: 'Section 4.4 · Parallel sampling', role: 'paragraph', box: box(317.5, 670, 241, 50),
  }
];
