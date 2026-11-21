import assert from 'node:assert/strict';
import test from 'node:test';
import { pagePoint, regionAnchor, readRegion, regionBox } from '../src/reader/pdf/region-geometry.js';
import * as geometry from '../src/reader/pdf/region-geometry.js';
import { sampleAreas } from '../src/reader/pdf/sample.js';

test('a cropped detail names its figure, while a rectangle across figures keeps a neutral page label', () => {
  assert.equal(geometry.figureAtRegion({ x: 82, y: 80, width: 95, height: 70 }, sampleAreas), 'Figure 6');
  assert.equal(geometry.figureAtRegion({ x: 55, y: 70, width: 475, height: 115 }, sampleAreas), undefined);
  assert.equal(geometry.figureAtRegion({ x: 82, y: 315, width: 80, height: 18 }, sampleAreas), undefined);
});

test('a screenshot citation uses only an identified figure or table number', () => {
  const labels = ['第 6 页截图 · 图 7', 'Page 8 screenshot · Table 12b', 'Page 2 screenshot · Fig. 3a',
    '第 3 页截图 · 表 4', 'Page 6 screenshot', '第 6 页截图', 'Page 4 screenshot · see Figure 2', 'Figure 2 is compared to Figure 3'];
  assert.deepEqual(labels.map(label => geometry.screenshotFigureLabel(label)), ['图 7', 'Table 12b', 'Fig. 3a', '表 4',
    undefined, undefined, undefined, undefined]);
});

test('a reverse drag over a zoomed and clipped page reopens on the same PDF coordinates', () => {
  const plane = { x: -180, y: -420, width: 1200, height: 1600 };
  const a = pagePoint(420, 380, plane);
  const b = pagePoint(60, -20, plane);
  const id = regionAnchor(a, b);
  assert.equal(id, 'region-2000-2500-5000-5000');
  assert.deepEqual(regionBox(readRegion(id!)!, { x: 0, y: 0, width: 600, height: 800 }),
    { x: 120, y: 200, width: 180, height: 200 });
});

test('empty, malformed and off-page saved captures cannot resolve to a different area', () => {
  assert.equal(regionAnchor({ x: 10, y: 20 }, { x: 10, y: 100 }), undefined);
  assert.deepEqual(pagePoint(-5, 5000, { x: 0, y: 0, width: 400, height: 600 }), { x: 0, y: 10000 });
  for (const value of ['region-0-0-0-30', 'region-10-4-8-30', 'region-0-1-10001-10000', 'region-0-1-400-500x', 'fig-6']) {
    assert.equal(readRegion(value), undefined);
  }
});
