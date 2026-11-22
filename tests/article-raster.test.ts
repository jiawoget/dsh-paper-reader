import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { readRegionImage } from '../src/server/region-image.js';

const executablePath = [process.env.PAPER_READER_TEST_BROWSER, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(candidate => candidate && existsSync(candidate));

test('article screenshots keep the selected figure pixels and text at their live browser coordinates', {
  skip: executablePath ? false : 'Set PAPER_READER_TEST_BROWSER to run the Chromium integration tests.'
}, async t => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/reader/article-raster.ts', import.meta.url))],
    bundle: true, format: 'esm', write: false });
  const css = await readFile(new URL('../public/article-view.css', import.meta.url), 'utf8');
  const illustration = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60">' +
    '<rect width="90" height="60" fill="#2850d4"/><rect x="90" width="90" height="60" fill="#209742"/></svg>';
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 470, height: 300 } });
  const sheet = (side: string, caption: string) => `<article class="web-reading-sheet" data-side="${side}">
    <div class="web-reading-row" data-anchor="p-1"><figure><img src="/image" alt="Two halves"></figure></div>
    <div class="web-reading-row" data-anchor="p-2"><figcaption>${caption}</figcaption></div>
    <div class="web-reading-row" data-anchor="p-3"><p>Below the crop</p></div></article>`;
  const html = `<!doctype html><meta charset="utf-8"><style>${css}
    body{margin:0}.pages{display:grid;grid-template-columns:180px 180px;gap:12px;width:372px;background:#e3e9f2}
    .web-reading-sheet{padding:0;border:0;border-radius:0}
    .web-reading-sheet .web-reading-row{max-width:none;margin:0;padding:0}
    .web-reading-sheet figure img{display:block;margin:0}
    figcaption{font:18px/30px Georgia,serif;white-space:nowrap}
    </style><main class="pages">${sheet('source','<span style="display:inline-block;width:100px">Private</span><em>Source</em>')}
    ${sheet('translation','<strong>译文</strong><span style="margin-left:100px">Hidden</span>')}</main>`;
  await page.route('http://reader.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('http://reader.test/raster.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  let requests = 0;
  await page.route('http://reader.test/image', route => {
    requests++;
    return route.fulfill({ contentType: 'image/svg+xml', body: illustration,
      headers: { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } });
  });
  await page.goto('http://reader.test/');
  await page.evaluate(() => Promise.all(Array.from(document.images, img => img.decode())));
  const before = requests, clip = { x: 98, y: 20, width: 172, height: 67 };
  const original = await page.screenshot({ clip });
  const captured = await page.evaluate(async rect => {
    const moduleUrl = '/raster.js';
    const { captureArticleArea } = await import(moduleUrl) as typeof import('../src/reader/article-raster.js');
    const root = document.querySelector<HTMLElement>('.pages')!;
    const overlay = document.createElement('div');
    overlay.className = 'annotation-layer';
    overlay.textContent = 'Capture controls';
    overlay.style.cssText = 'position:fixed;inset:0;background:magenta;z-index:20';
    root.querySelector('article')!.append(overlay);
    return captureArticleArea(root, new DOMRect(rect.x, rect.y, rect.width, rect.height), new AbortController().signal);
  }, clip);
  assert.deepEqual(captured.regionText.split(/\s+/u), ['Source', '译文']);
  assert.equal(requests, before, 'A crop should reuse the image that the article already displays.');
  const { bytes } = await readRegionImage(captured.image);
  const expected = await sharp(original).removeAlpha().raw().toBuffer();
  const pixels = await sharp(bytes).resize(clip.width, clip.height).removeAlpha().raw().toBuffer();
  for (const [x, expectedColor] of [[8, [32, 151, 66]], [130, [40, 80, 212]]] as const) {
    const start = (12 * clip.width + x) * 3;
    assert.deepEqual(Array.from(pixels.subarray(start, start + 3)), [...expectedColor]);
  }
  const captionStart = 40 * clip.width * 3;
  let difference = 0, ink = 0;
  for (let i = captionStart; i < expected.length; i++) {
    difference += Math.abs(expected[i] - pixels[i]);
    if (pixels[i] < 120) ink++;
  }
  assert.ok(ink > 180, 'Both text captions should be painted below the figures.');
  assert.ok(difference / (expected.length - captionStart) < 9, 'The caption pixels should match the clean article at the selected coordinates.');

  await t.test('horizontally scrolled tables and native MathML retain their visible content', async () => {
    const bounds = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.pages')!;
      root.style.cssText = 'display:block;width:180px';
      root.innerHTML = `<article class="web-reading-sheet">
        <div class="web-reading-row" data-kind="table"><div data-kind="table" style="width:180px;scrollbar-width:none">
        <table style="width:540px;table-layout:fixed;border-collapse:separate;border-spacing:0"><tbody><tr>
        <td>Concealed one</td><td style="border-bottom:4px solid #e85c12">Visible cell</td><td>Concealed three</td>
        </tr></tbody></table></div></div><div class="web-reading-row"><p>Ratio <span data-article-text="p/q"><math>
        <semantics><mfrac><mi>p</mi><mi>q</mi></mfrac><annotation encoding="application/x-tex">hidden TeX</annotation></semantics>
        </math></span></p></div></article>`;
      root.querySelector('div[data-kind=table] > div')!.scrollLeft = 180;
      const box = root.getBoundingClientRect();
      return { x: 0, y: 0, width: 180, height: Math.ceil(box.height) };
    });
    const actual = await page.screenshot({ clip: bounds });
    const crop = await page.evaluate(async bounds => {
      const url = '/raster.js';
      const api = await import(url) as typeof import('../src/reader/article-raster.js');
      return api.captureArticleArea(document.querySelector('.pages')!,
        new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height), new AbortController().signal);
    }, bounds);
    assert.equal(crop.regionText, 'Visible cell\n\nRatio p/q');
    const captured = await sharp((await readRegionImage(crop.image)).bytes).resize(bounds.width, bounds.height).removeAlpha().raw().toBuffer();
    const native = await sharp(actual).removeAlpha().raw().toBuffer();
    const line = native.findIndex((value, i) => i % 3 === 0 && value === 232 && native[i + 1] === 92 && native[i + 2] === 18);
    assert.ok(line >= 0 && Math.abs(captured[line] - 232) < 20 && Math.abs(captured[line + 2] - 18) < 35, 'The selected cell should retain its bottom rule.');
    let difference = 0;
    for (let i = 0; i < captured.length; i++) difference += Math.abs(captured[i] - native[i]);
    assert.ok(difference / captured.length < 8, 'The scrolled table and fraction should match their native layout.');
  });

  await t.test('a canceled reader discards its pending capture', async () => {
    assert.equal(await page.evaluate(async () => {
      const url = '/raster.js';
      const api = await import(url) as typeof import('../src/reader/article-raster.js');
      const cancel = new AbortController();
      const pending = api.captureArticleArea(document.querySelector('.pages')!, new DOMRect(0, 0, 100, 50), cancel.signal);
      cancel.abort();
      try { await pending; } catch (error) { return (error as DOMException).name; }
    }), 'AbortError');
  });

  await t.test('a crop across part of each text line includes only the words under the rectangle', async () => {
    const text = await page.evaluate(async () => {
      const url = '/raster.js';
      const api = await import(url) as typeof import('../src/reader/article-raster.js');
      const root = document.querySelector<HTMLElement>('.pages')!;
      root.style.width = '450px';
      root.innerHTML = '<article class="web-reading-sheet"><div class="web-reading-row"><pre style="margin:0;padding:0;font:18px/25px monospace">outside INCLUDED hidden\noutside REPEATED hidden\noutside below</pre></div></article>';
      const run = root.querySelector('pre')!.firstChild!, range = document.createRange();
      range.setStart(run, 8); range.setEnd(run, 16);
      const first = range.getBoundingClientRect();
      range.setStart(run, 32); range.setEnd(run, 40);
      const second = range.getBoundingClientRect();
      return (await api.captureArticleArea(root, new DOMRect(first.left, first.top, first.width, second.bottom - first.top),
        new AbortController().signal)).regionText;
    });
    assert.equal(text, 'INCLUDED REPEATED');
  });

  await t.test('detailed photo crops stay within the model validation limits', async () => {
    await page.setViewportSize({ width: 1400, height: 820 });
    const crop = await page.evaluate(async () => {
      const url = '/raster.js';
      const api = await import(url) as typeof import('../src/reader/article-raster.js');
      const root = document.querySelector<HTMLElement>('.pages')!;
      root.style.width = '1200px';
      root.innerHTML = '<article class="web-reading-sheet"><div class="web-reading-row"><figure><img></figure></div></article>';
      const photo = document.createElement('canvas');
      photo.width = 1200; photo.height = 700;
      const ctx = photo.getContext('2d')!, pixels = ctx.createImageData(photo.width, photo.height);
      let random = 107;
      for (let i = 0; i < pixels.data.length; i += 4) {
        random = (Math.imul(1664525, random) + 1013904223) >>> 0;
        pixels.data[i] = random >>> 24; pixels.data[i + 1] = random >>> 16 & 255;
        pixels.data[i + 2] = random >>> 8 & 255; pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      const image = root.querySelector('img')!;
      image.style.cssText = 'width:1200px;height:700px;max-width:none;max-height:none;max-block-size:none;max-inline-size:none';
      image.src = photo.toDataURL(); await image.decode();
      return api.captureArticleArea(root, image.getBoundingClientRect(), new AbortController().signal);
    });
    assert.equal(crop.regionText, '');
    const { bytes } = await readRegionImage(crop.image);
    const { width, height } = await sharp(bytes).metadata();
    assert.ok(width && height && width < 1600 && height < 1600, 'Detailed crops should shrink to the encoded attachment limit.');
  });
});
