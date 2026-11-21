import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { readPdfOutline, readOutlinePages } from '../src/reader/pdf/outline.js';

function viewport(rotated = false) {
  return {
    width: rotated ? 600 : 400, height: rotated ? 400 : 600, viewBox: [25, 30, 425, 630],
    transform: rotated ? [0, 1, 1, 0, -30, -25] : [1, 0, 0, -1, -25, 630],
    convertToViewportPoint: (x: number, y: number) => rotated ? [y - 30, x - 25] : [x - 25, 630 - y]
  };
}

test('embedded bookmarks resolve names, references and rotated crop boxes, retaining children of damaged bookmarks', async () => {
  const ref = { num: 17, gen: 0 }, pagesRead: number[] = [];
  const pdf = {
    numPages: 3,
    async getOutline() {
      return [
        { title: ' Chapter  1 ', dest: 'chapter', items: [
          { title: 'Missing target', dest: 'missing', items: [
            { title: 'A deeper topic', dest: [ref, { name: 'FitH' }, 450], items: [] }
          ] },
          { title: 'Same page again', dest: [ref, { name: 'FitR' }, 50, 80, 300, 270], items: [] }
        ] },
        { title: 'External material', url: 'https://example.com/book.pdf', dest: 'elsewhere', items: [
          { title: 'Rotated diagram', dest: [1, { name: 'XYZ' }, 225, 350, null], items: [] }
        ] },
        { title: 'Page only', dest: [2, { name: 'Fit' }], items: [] },
        { title: 'Out of bounds', dest: [3, { name: 'Fit' }], items: [] },
        { title: 'Broken bookmark', dest: [0, { name: 'Unknown' }], items: [] }
      ];
    },
    async getPageIndex(value: typeof ref) { assert.deepEqual(value, ref); return 0; },
    async getDestination(name: string) {
      if (name === 'missing') throw Error('Damaged name');
      assert.equal(name, 'chapter');
      return [ref, { name: 'XYZ' }, null, 570, null];
    },
    async getPage(number: number) { pagesRead.push(number); return { getViewport: () => viewport(number === 2) }; }
  } as unknown as PDFDocumentProxy;
  assert.deepEqual(await readPdfOutline(pdf), [
    { title: 'Chapter 1', page: 1, level: 1, top: .1 },
    { title: 'A deeper topic', page: 1, level: 2, top: .3 },
    { title: 'Same page again', page: 1, level: 2, top: .6 },
    { title: 'Rotated diagram', page: 2, level: 1, top: .5 },
    { title: 'Page only', page: 3, level: 1 }
  ]);
  assert.deepEqual(pagesRead, [1, 2]);
});

function printed(text: string, y: number, size = 10, x = 50): TextItem {
  return { str: text, dir: 'ltr', transform: [size, 0, 0, size, x, y], width: text.length * size / 2,
    height: size, fontName: 'body', hasEOL: true };
}
function testPage(items: TextContent['items'], heading?: string): PDFPageProxy {
  return {
    getViewport: () => viewport(),
    getTextContent: async () => ({ lang: null, styles: { body: { ascent: .8, descent: -.2, vertical: false, fontFamily: 'serif' } }, items }),
    getStructTree: async () => heading ? { role: 'Root', children: [{ role: 'H2', children: [{ type: 'content', id: heading }] }] } : null
  } as unknown as PDFPageProxy;
}

test('generated contents evidence keeps tagged, numbered and large headings in reading order, alongside image-only pages', async () => {
  const pages = [
    testPage([
      ...Array.from({length: 18}, (_, i) => printed('A body line with some context for the chapter.', 600 - i * 13)),
      { type: 'beginMarkedContentProps', id: 'p1-heading' }, printed('Winding paths', 355), printed('through the mountains', 342),
      { type: 'endMarkedContent', id: '' }, printed('第二章 山川与河流', 320),
      { ...printed('2.1', 275), hasEOL: false }, printed('Inference', 275, 10, 70),
      printed('Limitations', 460, 17, 270), printed('3'.repeat(240), 100)
    ], 'p1-heading'),
    testPage([])
  ];
  const pdf = { numPages: 2, getPage: async (number: number) => pages[number - 1] };
  const progress: number[] = [];
  const result = await readOutlinePages(pdf, (done, total) => { assert.equal(total, 2); progress.push(done); });
  assert.deepEqual(result.map(page => page.page), [1, 2]);
  assert.deepEqual(result[1].lines, []);
  assert.deepEqual(progress, [0, 1, 2]);
  assert.ok(result[0].lines.length <= 12);
  assert.ok(result[0].lines.every(line => line.text.length <= 180 && line.top >= 0 && line.top <= 1));
  assert.deepEqual(result[0].lines.filter(line => line.prominent).map(line => line.text),
    ['Winding paths through the mountains', '第二章 山川与河流', '2.1 Inference', 'Limitations']);
  const section = result[0].lines.find(line => line.text === '2.1 Inference')!;
  assert.ok(Math.abs(section.top - (630 - 275 - 8) / 600) < .0001);
});

test('stopping the evidence scan prevents any further PDF page reads', async () => {
  const controller = new AbortController(), reads: number[] = [];
  const pdf = { numPages: 100, async getPage(number: number) { reads.push(number); return testPage([]); } };
  await assert.rejects(readOutlinePages(pdf, done => { if (done === 2) controller.abort(); }, controller.signal),
    { name: 'AbortError' });
  assert.deepEqual(reads, [1, 2]);
});

test('long books retain evidence from every page within the UTF-8 request budget', async () => {
  const page = testPage(Array.from({ length: 12 }, (_, i) =>
    printed('第' + (i + 1) + '章 ' + '章节标题与正文'.repeat(22), 610 - i * 35)));
  const pdf = { numPages: 1200, getPage: async () => page };
  const result = await readOutlinePages(pdf);
  assert.equal(result.length, pdf.numPages);
  assert.ok(result.every((entry, index) => entry.page === index + 1 && entry.lines.some(line => line.prominent)));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4 * 1024 * 1024);
});

test('PDF.js extracts the bundled paper’s nested, same-page destinations and printed headings', async () => {
  const data = Uint8Array.from(await readFile(new URL('../public/assets/pagedattention.pdf', import.meta.url)));
  const task = getDocument({ data, standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/') });
  try {
    const pdf = await task.promise;
    const entries = await readPdfOutline(pdf);
    const decoding = entries.find(entry => entry.title.startsWith('4.3 Decoding'));
    const application = entries.find(entry => entry.title.startsWith('4.4 Application'));
    assert.equal(decoding?.page, 6);
    assert.equal(decoding?.level, 2);
    assert.equal(application?.page, 6);
    assert.notEqual(decoding?.top, application?.top);
    const evidence = await readOutlinePages(pdf);
    assert.deepEqual(evidence.map(page => page.page), Array.from({length: pdf.numPages}, (_, i) => i + 1));
    assert.ok(evidence[5].lines.some(line => line.text.startsWith('4.3 Decoding') && line.prominent));
    assert.ok(evidence[5].lines.some(line => line.text.startsWith('4.4 Application') && line.prominent));
    assert.ok(evidence[13].lines.some(line => line.text === 'References' && line.prominent));
    assert.ok(!evidence[13].lines.some(line => line.prominent && /^(?:limited GPU memory|2022\.)/.test(line.text)));
    assert.ok(!evidence[2].lines.some(line => line.prominent && /[\u{1D400}-\u{1D7FF}]/u.test(line.text)));
  } finally { await task.destroy(); }
});
