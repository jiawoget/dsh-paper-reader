import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { answerMarkdown } from '../src/reader/answer-markdown.js';
import { bibliography, parseBibliography } from '../src/reader/bibliography.js';
import { JumpHistory, type ReadingPosition } from '../src/reader/jump-history.js';
import { viewportBox } from '../src/reader/pdf/links.js';
import { destinationTop, resolvePdfDestination } from '../src/reader/pdf/outline.js';
import { safeWeb } from '../src/reader/ui.js';

const pos = (page: number, top = 0, extra?: Partial<ReadingPosition>): ReadingPosition =>
  ({ doc: 'd1', page, mode: 'source', text: false, top, left: 0, translationTop: 0, translationLeft: 0, ...extra });

test('JumpHistory tracks back/forward, strips historyTop, deduplicates, bounds to 50, and clears', () => {
  let changes = 0;
  const h = new JumpHistory(() => { changes++; });
  assert.equal(h.canBack(), false); assert.equal(h.canForward(), false);
  assert.equal(h.back(pos(1)), undefined); assert.equal(h.forward(pos(1)), undefined);
  h.push(pos(1, 100, { historyTop: 42 })); h.push(pos(1, 103));
  assert.equal(changes, 1);
  h.push(pos(2, 50)); assert.equal(h.canBack(), true);
  const b1 = h.back(pos(3, 10));
  assert.equal(b1?.page, 2); assert.equal(b1?.top, 50); assert.equal(h.canForward(), true);
  const b2 = h.back(pos(2, 50));
  assert.equal(b2?.page, 1); assert.equal(b2?.historyTop, undefined); assert.equal(h.canBack(), false);
  assert.equal(h.forward(pos(1, 100))?.page, 2);
  h.push(pos(4, 0)); assert.equal(h.canForward(), false);
  for (let i = 10; i < 70; i++) h.push(pos(i, 0));
  let steps = 0;
  while (h.canBack()) { h.back(pos(99)); steps++; }
  assert.equal(steps, 50);
  h.clear(); assert.equal(h.canBack(), false); assert.equal(h.canForward(), false);
});

test('answerMarkdown decorates closed EN/ZH page citations safely and ignores math/code/links/partials', () => {
  const html = answerMarkdown('See (p. 6), (pp. 6–8), (p. 3, 12), (pages 2-4), (第 5 页), （第 7–9 页）, (第 4、10 页).', 16);
  for (const page of [6, 3, 12, 2, 5, 7, 4, 10]) assert.match(html, new RegExp(`class="page-cite-chip" data-page="${page}"`));
  assert.equal(answerMarkdown('See (p. 6) and (第 6 页).', 0).includes('page-cite-chip'), false);
  assert.equal(answerMarkdown('Out of range (p. 0), (p. 17), (pp. 10-4), (pp. 10-20), (p = 0.05).', 16).includes('page-cite-chip'), false);
  assert.equal(answerMarkdown('Partial stream (p. 6 and (第 6 and （第 6 页', 16).includes('page-cite-chip'), false);
  assert.equal(answerMarkdown('`(p. 6)`\n\n```\n(p. 6)\n```\n\n$x (p. 6)$ $$y (p. 6)$$ [link (p. 6)](https://example.org)', 16).includes('page-cite-chip'), false);
});

test('parseBibliography extracts page, authors, year, arxivId, doi, url, and wrapped URLs', async () => {
  const refs = parseBibliography([
    ['References',
      '[1] A. Author, B. Author, and C. Author. 2023. "Demo Paper." arXiv:2301.12345 [cs.CL].',
      '[2] D. Doe. 2022. Another Paper. https://lmsys.', 'org/blog/demo/'],
    ['[3] E. Eve. 2021. DOI Paper. https://doi.org/10.48550/arXiv.2210.12924']
  ], 14);
  assert.equal(refs.get(1)?.page, 14); assert.equal(refs.get(1)?.year, '2023');
  assert.equal(refs.get(1)?.arxivId, '2301.12345'); assert.ok(refs.get(1)?.authors?.includes('A. Author'));
  assert.equal(refs.get(2)?.url, 'https://lmsys.org/blog/demo/');
  assert.equal(refs.get(3)?.page, 15); assert.equal(refs.get(3)?.doi, '10.48550/arXiv.2210.12924'); assert.equal(refs.get(3)?.arxivId, '2210.12924');

  const bytes = await readFile(new URL('../public/assets/pagedattention.pdf', import.meta.url));
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const pdf = await task.promise;
    const real = await bibliography({ pages: pdf.numPages, textContent: async n => (await pdf.getPage(n)).getTextContent() });
    assert.equal(real.get(1)?.page, 14); assert.equal(real.get(1)?.arxivId, '2207.00032');
    assert.equal(real.get(8)?.url, 'https://lmsys.org/blog/2023-03-30-vicuna/');
    assert.equal(real.get(37)?.page, 15); assert.equal(real.get(37)?.arxivId, '2303.08774');
    assert.equal(real.get(48)?.arxivId, '2210.12924'); assert.equal(real.get(50)?.url, 'https://github.com/tatsu-lab/stanford_alpaca');
    const sub45 = await resolvePdfDestination(pdf, 'subsection.4.5');
    assert.equal(sub45?.page, 8); assert.ok(typeof sub45?.top === 'number' && sub45.top > 0 && sub45.top < 1);
    assert.equal((await resolvePdfDestination(pdf, 'figure.caption.3'))?.page, 2);
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
    assert.ok(destinationTop(vp, [0, { name: 'XYZ' }, 54, 400, null])! > 0.4);
    const box = viewportBox(vp, [100, 100, 250, 112]);
    assert.deepEqual(box && { x: Math.round(box.x), w: Math.round(box.width), h: Math.round(box.height) }, { x: 100, w: 150, h: 12 });
    assert.equal(viewportBox(vp, [100, 100, 100.2, 100.2]), undefined);
  } finally { await task.destroy(); }
});

test('safeWeb allows only http and https URLs', () => {
  assert.equal(safeWeb('https://arxiv.org/pdf/2303.08774.pdf'), 'https://arxiv.org/pdf/2303.08774.pdf');
  assert.equal(safeWeb('javascript:alert(1)'), undefined);
  assert.equal(safeWeb('data:text/html,hi'), undefined);
  assert.equal(safeWeb('file:///etc/passwd'), undefined);
});
