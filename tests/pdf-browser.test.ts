import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { AnnotationLayer } from '../src/reader/annotation-layer.js';
import type { PdfDocument, PdfRenderOptions, PageView, SelectionHit } from '../src/reader/pdf-view.js';

interface Harness {
  pdf: PdfDocument;
  view: PageView;
  hits: SelectionHit[];
  options: PdfRenderOptions;
  layer?: AnnotationLayer;
  markOpens?: number;
}
declare global { interface Window { pdfTests: Harness } }

const root = fileURLToPath(new URL('../', import.meta.url));
const browserCandidates = [
  process.env.PAPER_READER_TEST_BROWSER, chromium.executablePath(),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'
].filter((p): p is string => Boolean(p));

async function browserPath(): Promise<string | undefined> {
  for (const candidate of browserCandidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next installation. */ }
  }
}

test('a real browser renders, selects and restores text and figures on their original paper coordinates', async ctx => {
  const executablePath = await browserPath();
  if (!executablePath) { ctx.skip('No installed Chromium browser was found.'); return; }
  const compiled = await build({ stdin: { contents: ['pdf-view', 'article-view', 'annotation-layer']
    .map(name => 'export * from "./src/reader/' + name + '.ts";').join('\n'), resolveDir: root },
    bundle: true, write: false, format: 'esm',
    plugins: [{ name: 'test-pdfjs', setup(b) { b.onResolve({ filter: /^pdfjs-dist$/ },
      () => ({ path: '/api/paper-reader/vendor/pdf.mjs', external: true })); } }] });
  const html = '<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/annotations.css"><style>*{box-sizing:border-box}body{margin:0;background:#eef2f5}.pages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:12px} .pages>div{border-radius:6px}</style><div class="pages"><div id="english"></div><div id="chinese"></div></div>';
  const routes = new Map([
    ['/style.css', [join(root, 'public/pdf-view.css'), 'text/css']],
    ['/annotations.css', [join(root, 'public/annotation-layer.css'), 'text/css']],
    ['/api/paper-reader/app/assets/pagedattention.pdf', [join(root, 'public/assets/pagedattention.pdf'), 'application/pdf']],
    ['/api/paper-reader/app/assets/pagedattention-page-6.zh-CN.json', [join(root, 'public/assets/pagedattention-page-6.zh-CN.json'), 'application/json']],
    ...['pdf.mjs', 'pdf.worker.mjs', 'pdf.renderer.mjs'].map(name => ['/api/paper-reader/vendor/' + name,
      [join(root, 'node_modules/pdfjs-dist/build', name), 'text/javascript']] as [string, string[]])
  ]);
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end(html); return; }
    if (path === '/view.js') { res.writeHead(200, { 'content-type': 'text/javascript' }).end(compiled.outputFiles[0].contents); return; }
    const entry = routes.get(path);
    if (!entry) { res.writeHead(404).end(); return; }
    try { res.writeHead(200, { 'content-type': entry[1] }).end(await readFile(entry[0])); }
    catch { res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await chromium.launch({ executablePath, headless: true });
  ctx.after(() => browser.close());
  const tab = await browser.newPage({ viewport: { width: 980, height: 720 } });
  await tab.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port);
  const basic = await tab.evaluate(async () => {
    const file = '/view.js';
    const { openPdf, bundledPdfUrl } = await import(file) as typeof import('../src/reader/pdf-view.js');
    const bytes = new Uint8Array(await (await fetch(bundledPdfUrl)).arrayBuffer());
    const pdf = await openPdf(bytes);
    const hits: SelectionHit[] = [];
    const options: PdfRenderOptions = { page: 6, sourceEl: document.getElementById('english')!,
      translationEl: document.getElementById('chinese')!, onSelect: hits.push.bind(hits) };
    const view = await pdf.render(options);
    window.pdfTests = { pdf, view, hits, options };
    const rect = view.sourceRect!('block-tables')!;
    return { pages: pdf.pages, length: bytes.byteLength, count: view.blocks.length,
      image: view.figureImage!('figure-6')?.slice(0, 22), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  });
  assert.equal(basic.pages, 16);
  assert.equal(basic.length, 1_459_631);
  assert.ok(basic.count >= 10 && basic.w > 20 && basic.h > 4);
  assert.equal(basic.image, 'data:image/png;base64,');
  await ctx.test('PDF contents jump to the same printed heading through crop, zoom, reflow and translated passage mode', async () => {
    const outline = await browser.newPage({ viewport: { width: 820, height: 420 } });
    try {
      await outline.goto(tab.url());
      const result = await outline.evaluate(async () => {
        const file = '/view.js';
        const { openPdf, bundledPdfUrl } = await import(file) as typeof import('../src/reader/pdf-view.js');
        const pdf = await openPdf(new Uint8Array(await (await fetch(bundledPdfUrl)).arrayBuffer()));
        try {
          const scroller = document.createElement('div'), grid = document.querySelector<HTMLElement>('.pages')!;
          scroller.id = 'paperScroll'; scroller.style.cssText = 'height:140px;overflow:auto';
          grid.before(scroller); scroller.append(grid);
          const sourceEl = document.getElementById('english')!, translationEl = document.getElementById('chinese')!;
          const view = await pdf.render({ page: 6, sourceEl, translationEl });
          const entry = (await pdf.outline()).find(item => item.title.startsWith('4.4 Application'))!;
          view.setZoom(1.5);
          view.goToOutline(entry.top!, entry.title);
          const original = view.outlineTop();
          view.setTextView(true);
          view.goToOutline(entry.top!, entry.title);
          const top = scroller.getBoundingClientRect().top;
          const heading = sourceEl.querySelector('[data-passage-id="section-4-4"]')!.getBoundingClientRect();
          const reflow = view.outlineTop();
          view.setTextView(false);
          sourceEl.style.display = 'none';
          view.setFocusMode('passage'); view.goToOutline(entry.top!, entry.title);
          return { target: entry.top!, original, reflow, heading: heading.top - top,
            active: translationEl.querySelector<HTMLElement>('.pdf-sheet')!.dataset.activeBlock };
        } finally { await pdf.destroy(); }
      });
      assert.ok(Math.abs(result.target - result.original) < .002);
      assert.ok(result.heading >= -12 && result.heading <= 18, 'Reflow scrolled the selected heading into view');
      assert.ok(Math.abs(result.target - result.reflow) < .025);
      assert.equal(result.active, 'section-4-4');
    } finally { await outline.close(); }
  });
  await ctx.test('saved ink appears over original PDF glyphs and remains selectable', async () => {
    const clipped = await tab.evaluate(async () => {
      const file = '/view.js', { AnnotationLayer } = await import(file) as typeof import('../src/reader/annotation-layer.js');
      const h = window.pdfTests;
      h.markOpens = 0; h.layer = new AnnotationLayer(() => { h.markOpens!++; }, () => {});
      const mark = { id: 'visual', docId: 'paper', title: 'Paper', page: 6, anchor: 'block-tables',
        quote: 'block tables', kind: 'highlight' as const, color: 'yellow' as const, label: 'Block tables', text: '',
        sourceUrl: location.href, createdAt: '', updatedAt: '' };
      h.layer.render([mark], h.view); h.layer.locate(mark);
      const r = h.layer.trigger(mark.id)!.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    const clip = { x: Math.ceil(clipped.x), y: Math.ceil(clipped.y), width: Math.floor(clipped.width) - 2, height: Math.floor(clipped.height) - 2 };
    const screenshot = await tab.screenshot();
    const yellow = await tab.evaluate(async ({ data, clip }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = clip.width; canvas.height = clip.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, -clip.x, -clip.y);
      const pixels = ctx.getImageData(0, 0, clip.width, clip.height).data;
      let yellow = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > pixels[i + 2] + 40 && pixels[i + 1] > pixels[i + 2] + 24) yellow++;
      return yellow;
    }, { data: screenshot.toString('base64'), clip });
    assert.ok(yellow > clip.width * clip.height * .25, 'The PDF itself should show the saved yellow highlight.');
    const y = clipped.y + clipped.height / 2;
    await tab.mouse.click(clipped.x + clipped.width / 2, y);
    assert.equal(await tab.evaluate(() => window.pdfTests.markOpens), 1);
    await tab.mouse.move(clipped.x + .5, y); await tab.mouse.down();
    await tab.mouse.move(clipped.x + clipped.width - .5, y, { steps: 10 }); await tab.mouse.up();
    const selected = await tab.evaluate(() => {
      const text = document.getSelection()?.toString();
      document.getSelection()?.removeAllRanges();
      window.pdfTests.layer?.destroy();
      window.scrollTo(0, 0);
      return { text, opens: window.pdfTests.markOpens };
    });
    assert.match(selected.text ?? '', /block table/i);
    assert.equal(selected.opens, 1);
  });
  await ctx.test('saved highlights and grouped page pins survive page zoom and text reflow', async () => {
    const result = await tab.evaluate(async () => {
      const file = '/view.js', { AnnotationLayer } = await import(file) as typeof import('../src/reader/annotation-layer.js');
      const { view } = window.pdfTests;
      const pdfView = view as import('../src/reader/pdf-view.js').PdfPageView;
      let opened = '', placed = { x: 0, y: 0 };
      const layer = new AnnotationLayer(id => { opened = id; }, point => { placed = point; });
      const base = { docId: 'sample', title: 'Sample', page: 6, color: 'yellow' as const, text: '',
        createdAt: '', updatedAt: '', sourceUrl: location.href, anchor: 'block-tables', label: 'Block table' };
      const mark = { ...base, id: 'mark', kind: 'highlight' as const, quote: 'mapping between logical and physical KV blocks' };
      const pin = { ...base, id: 'pin', kind: 'pin' as const, quote: '', point: { x: .25, y: .34 }, text: 'First note' };
      const pins = [pin, { ...pin, id: 'pin2', text: 'Second note' }];
      layer.render([mark, ...pins], view);
      const english = document.getElementById('english')!;
      const located = layer.locate(mark);
      const native = document.activeElement?.classList.contains('annotation-highlight');
      const paired = Boolean(document.querySelector('#chinese .annotation-highlight'));
      const cluster = english.querySelector<HTMLButtonElement>('.annotation-pin')!;
      cluster.click();
      const chooser = document.querySelector('.annotation-chooser')!;
      const choice = Array.from(chooser.querySelectorAll('button')).find(button => button.textContent?.includes('Second note'))!;
      choice.click();
      pdfView.setZoom(1.5);
      await new Promise(requestAnimationFrame);
      const samePin = layer.locate(pin);
      const r = document.activeElement!.getBoundingClientRect(), sheet = english.querySelector('.pdf-sheet')!.getBoundingClientRect();
      const anchored = Math.abs((r.x + r.width / 2 - sheet.x) / sheet.width - pin.point.x) < .002;
      layer.place(true);
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      pdfView.setTextView(true);
      const reflow = layer.locate(mark) && Boolean(document.activeElement?.closest('.pdf-reading-text'));
      const hiddenPin = layer.locate(pin);
      pdfView.setZoom(1);
      pdfView.setTextView(false);
      pdfView.setFocusMode('passage');
      pdfView.locate('two-requests');
      english.hidden = true;
      const translationOnly = layer.locate(mark) && Boolean(document.activeElement?.closest('#chinese'));
      english.hidden = false; pdfView.setFocusMode('page');
      layer.destroy();
      return { located, native, paired, opened, samePin, anchored, placed: placed.x > 0 && placed.y > 0, reflow, hiddenPin, translationOnly };
    });
    assert.deepEqual(result, { located: true, native: true, paired: true, opened: 'pin2',
      samePin: true, anchored: true, placed: true, reflow: true, hiddenPin: false, translationOnly: true });
  });
  await ctx.test('article marks restore repeated and cross-paragraph selections on the initiating side', async () => {
    const article = await browser.newPage();
    try {
      await article.goto(tab.url());
      const result = await article.evaluate(async () => {
        const file = '/view.js';
        const { AnnotationLayer, renderArticle } = await import(file) as typeof import('../src/reader/annotation-layer.js') &
          typeof import('../src/reader/article-view.js');
        const original = document.querySelector<HTMLElement>('#english')!, translation = document.querySelector<HTMLElement>('#chinese')!;
        const first = 'Paper A and paper B use the same term twice: term.', second = 'More details follow.';
        const chinese = '方法一和方法二使用同一个词。';
        const view = renderArticle({ doc: { id: 'web', title: 'Web', kind: 'web', paragraphs: [first, second] },
          sourceEl: original, translationEl: translation, onSelect() {} });
        const layer = new AnnotationLayer(() => {}, () => {});
        const base = { docId: 'web', title: 'Web', page: 1, text: '', createdAt: '', updatedAt: '',
          anchor: 'p-1', kind: 'highlight' as const, label: 'Paragraph 1' };
        const start = first.lastIndexOf('term');
        const specs = [
          { color: 'yellow', quote: 'term', from: start, anchor: 'p-1', to: start + 4, tail: 'term', target: '' },
          { color: 'green', quote: first.slice(start) + '\n\nMore', from: start, anchor: 'p-2', to: 4, tail: 'More', target: '' },
          { color: 'purple', quote: first, from: chinese.lastIndexOf('方法'), anchor: 'p-1', to: chinese.lastIndexOf('方法') + 2, tail: '方法', target: '方法' }
        ] as const;
        const marks = specs.map(({ color, quote, from, anchor, to, tail, target }) => {
          const url = new URL(location.href);
          for (const [key, value] of Object.entries({ rangeStart: String(from), rangeEnd: String(to), endAnchor: anchor,
            rangeTail: tail, quote, ...(target ? { targetQuote: target, targetOffset: String(from) } : {}) })) url.searchParams.set(key, value);
          return { ...base, sourceUrl: url.href, id: color, color, quote };
        });
        layer.render(marks, view);
        const repeated = Array.from(CSS.highlights.get('paper-annotation-yellow') ?? []).map(r => [r.toString(), r.startOffset]);
        const across = Array.from(CSS.highlights.get('paper-annotation-green') ?? []).map(r => r.toString());
        view.setTranslations!({ 'p-1': chinese, 'p-2': '更多细节。' });
        await new Promise(requestAnimationFrame);
        const translated = Array.from(CSS.highlights.get('paper-annotation-purple') ?? [])
          .filter(r => translation.contains(r.startContainer)).map(r => [r.toString(), r.startOffset]);
        const focus = layer.locate(marks[2]) && translation.contains(document.activeElement);
        layer.render([], view);
        const cleared = !CSS.highlights.has('paper-annotation-green') && !document.querySelector('.annotation-highlight');
        view.dispose!();
        return { repeated, start, across, translated, translatedStart: chinese.lastIndexOf('方法'), focus, cleared };
      });
      assert.deepEqual(result.repeated, [['term', result.start]]);
      assert.deepEqual(result.across, ['term.', 'More']);
      assert.deepEqual(result.translated, [['方法', result.translatedStart]]);
      assert.ok(result.focus && result.cleared);
    } finally { await article.close(); }
  });
  if (process.env.PAPER_READER_PDF_SNAPSHOT) await tab.screenshot({ path: process.env.PAPER_READER_PDF_SNAPSHOT });
  await tab.mouse.move(basic.x, basic.y + basic.h / 2);
  await tab.mouse.down();
  await tab.mouse.move(basic.x + basic.w, basic.y + basic.h / 2, { steps: 12 });
  await tab.mouse.up();
  await tab.waitForFunction(() => window.pdfTests.hits.some(h => h.id === 'block-tables' && h.text.includes('block tables')));
  await tab.evaluate(() => document.getSelection()?.removeAllRanges());
  await tab.locator('#chinese .pdf-translated-text[data-block-id="two-requests"]').click();
  const translationHit = await tab.evaluate(() => {
    const { view, hits } = window.pdfTests;
    const hit = hits.at(-1)!;
    const ok = view.locate(hit.id, hit.sourceQuote);
    return { id: hit.id, text: hit.text, english: hit.sourceQuote, side: hit.side, ok,
      highlighted: document.querySelectorAll('#english .pdf-quote-mark').length };
  });
  assert.equal(translationHit.id, 'two-requests');
  assert.equal(translationHit.side, 'translation');
  assert.match(translationHit.text, /\p{Script=Han}/u);
  assert.match(translationHit.english ?? '', /dynamically assigns new physical blocks/);
  assert.ok(translationHit.ok && translationHit.highlighted > 0);
  const sentenceHit = await tab.evaluate(async () => {
    const translated = document.querySelector<HTMLElement>('#chinese .pdf-translated-text[data-block-id="block-tables"]')!;
    const node = translated.firstChild as Text;
    const termStart = node.textContent!.indexOf('KV', node.textContent!.indexOf('\u3002', node.textContent!.indexOf('\u3002') + 1) + 1);
    const range = document.createRange();
    range.setStart(node, termStart);
    range.setEnd(node, termStart + 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    translated.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise(requestAnimationFrame);
    const hit = window.pdfTests.hits.at(-1)!;
    selection.removeAllRanges();
    return hit.sourceQuote;
  });
  assert.equal(sentenceHit, 'The KV block manager also maintains block tables—the mapping between logical and physical KV blocks of each request.');
  const pinned = await tab.evaluate(() => {
    const view = window.pdfTests.view;
    view.locate('block-tables', 'block tables');
    const marker = document.querySelector('#english .pdf-quote-mark');
    view.highlight('block-tables', true, 'block tables');
    const sameMarker = marker === document.querySelector('#english .pdf-quote-mark');
    view.highlight('block-tables', false);
    const persisted = Boolean(document.querySelector('#english .pdf-quote-mark'));
    view.highlight('two-requests', true, 'two sequences');
    view.highlight('two-requests', false);
    return {sameMarker, persisted, survivedAnotherHover: Boolean(marker?.isConnected)};
  });
  assert.deepEqual(pinned, {sameMarker: true, persisted: true, survivedAnotherHover: true});
  await tab.locator('#chinese .pdf-figure[data-block-id="figure-6"]').click();
  assert.ok(await tab.evaluate(() => window.pdfTests.hits.at(-1)?.image?.startsWith('data:image/png;base64,')));
  const race = await tab.evaluate(async () => {
    const h = window.pdfTests;
    const old = h.pdf.render({ ...h.options, page: 5 }).then(() => false, e => e?.name === 'AbortError');
    h.view = await h.pdf.render({ ...h.options, zoom: 1.6 });
    const areas = [...document.querySelectorAll('.pdf-sheet')].map(el => el.getBoundingClientRect());
    const hasClip = [...document.querySelectorAll<HTMLElement>('#chinese .pdf-translated-text')].some(el => el.scrollHeight > el.clientHeight + 2);
    return { aborted: await old, separated: areas[0].right <= areas[1].left, wide: areas[0].width > 600, hasClip };
  });
  assert.deepEqual(race, { aborted: true, separated: true, wide: true, hasClip: false });
  const pageFour = await tab.evaluate(async () => {
    const h = window.pdfTests;
    h.view = await h.pdf.render({ ...h.options, page: 4 });
    const original = document.querySelector<HTMLCanvasElement>('#english .pdf-raster')!;
    const translated = document.querySelector<HTMLCanvasElement>('#chinese .pdf-raster')!;
    const scale = original.width / 612;
    const a = original.getContext('2d')!.getImageData(55 * scale, 222 * scale, 230 * scale, 85 * scale).data;
    const b = translated.getContext('2d')!.getImageData(55 * scale, 222 * scale, 230 * scale, 85 * scale).data;
    return { copiedProse: a.every((v, i) => b[i] === v), nativeLayers: document.querySelectorAll('#chinese .pdf-native-text').length,
      heading: h.view.blocks.find(p => p.id === 'section-3')?.translation, figure: Boolean(h.view.figureImage?.('figure-3')) };
  });
  assert.equal(pageFour.copiedProse, false, 'A translation page must never paint a copy of the original prose under its translation.');
  assert.equal(pageFour.nativeLayers, 0);
  assert.match(pageFour.heading ?? '', /\p{Script=Han}/u);
  assert.equal(pageFour.figure, true);
  const legacy = await tab.evaluate(() => {
    const view = window.pdfTests.view;
    const found = view.locate('p4-b3', 'Complex decoding algorithms.');
    const top = document.querySelector('#english .pdf-quote-mark')?.getBoundingClientRect().top ?? -1;
    const rect = view.sourceRect!('p4-r17')!;
    return { found, withinParagraph: Math.abs(top - rect.top) < 4, foundHeading: view.locate('p4-b2') };
  });
  assert.deepEqual(legacy, {found: true, withinParagraph: true, foundHeading: true});
  const unfit: string[] = [];
  for (let page = 1; page <= basic.pages; page++) {
    const problems = await tab.evaluate(async number => {
      const h = window.pdfTests;
      h.view = await h.pdf.render({...h.options, page: number});
      return Array.from(document.querySelectorAll<HTMLElement>('#chinese .pdf-translated-text')).filter(node =>
        node.hidden || !node.textContent?.trim() || node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2)
        .map(node => ({ id: node.dataset.blockId, height: node.scrollHeight, available: node.clientHeight }));
    }, page);
    if (problems.length) unfit.push('Page ' + page + ' ' + JSON.stringify(problems));
  }
  assert.deepEqual(unfit, [], 'All curated passages fit their original paper coordinates.');
  const imported = await tab.evaluate(async () => {
    const file = '/view.js';
    const { openPdf, bundledPdfUrl } = await import(file) as typeof import('../src/reader/pdf-view.js');
    const original = new Uint8Array(await (await fetch(bundledPdfUrl)).arrayBuffer());
    const bytes = new Uint8Array(original.length + 1);
    bytes.set(original); bytes[original.length] = 10;
    const h = window.pdfTests;
    h.view = await h.pdf.render({...h.options, page: 4});
    const heading = h.view.blocks.find(b => b.id === 'section-3')!;
    await h.pdf.destroy();
    h.pdf = await openPdf(bytes);
    h.view = await h.pdf.render({...h.options, page: 4});
    const status = document.querySelector<HTMLElement>('#chinese .pdf-translation-state')!;
    const body = document.querySelector<HTMLCanvasElement>('#chinese .pdf-raster')!;
    const scale = body.width / 612;
    const drawn = body.getContext('2d')!.getImageData(65 * scale, 223 * scale, 210 * scale, 82 * scale).data;
    const pending = { state: status.dataset.state, noInk: drawn.every(pixel => pixel === 255),
      sourceOnly: h.view.blocks.every(b => !b.translation) };
    const prose = h.view.blocks.find(b => b.text.startsWith('Although'))!;
    h.view.setTranslations!({[prose.id]: prose.text});
    const rejectedEcho = !prose.translation;
    const key = h.view.blocks.find(b => b.text === heading.text)!.id;
    h.view.setTranslations!({[key]: heading.translation!});
    return {...pending, rejectedEcho, revealed: h.view.blocks.filter(b => b.translation).map(b => b.id), key,
      pendingVisible: !status.hidden, sourceLayerCount: document.querySelectorAll('#chinese .pdf-native-text').length};
  });
  assert.deepEqual(imported, {state: 'pending', noInk: true, sourceOnly: true, rejectedEcho: true, revealed: [imported.key],
    key: imported.key, pendingVisible: true, sourceLayerCount: 0});
  const specimen = await browser.newPage();
  await specimen.setContent('<style>@page{size:letter;margin:48pt}body{margin:0;font:12pt Georgia}'
    + 'table{border-collapse:collapse}td,th{border-block:1px solid;padding:4px 24px}figure{margin:0}p{margin:20px 0}</style>'
    + '<figure><svg width="240" height="78"><rect x="5" y="5" width="225" height="65" fill="none" stroke="black"/>'
    + '<text x="30" y="44">Channel gain</text></svg><figcaption>Figure 1. The signal passes through an amplifier.</figcaption></figure>'
    + '<p>Table 1. Measurements taken in the laboratory.</p><table><tr><th>Sensor</th><th>Reading</th></tr>'
    + '<tr><td>Copper</td><td>28</td></tr><tr><td>Silver</td><td>34</td></tr></table>'
    + '<p style="text-align:center">y = W(x) + b</p><p>The experiment confirms the predicted result.</p><p>We use x + y.</p>'
    + '<table style="margin-top:30px"><tr><th style="border:0">Sample</th><th style="border:0">Batch</th></tr>'
    + '<tr><td style="border:0">Zinc oxide</td><td style="border:0">B12</td></tr></table>');
  const specimenBytes = await specimen.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true });
  await specimen.close();
  const labels = await tab.evaluate(async data => {
    const file = '/view.js';
    const { openPdf } = await import(file) as typeof import('../src/reader/pdf-view.js');
    const h = window.pdfTests;
    await h.pdf.destroy();
    h.pdf = await openPdf(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
    h.view = await h.pdf.render({ ...h.options, page: 1 });
    h.view.setTranslations!(Object.fromEntries(h.view.blocks.map(block => [block.id, '\u8bd1\u6587'])));
    const [source, target] = [...document.querySelectorAll<HTMLCanvasElement>('.pdf-raster')];
    const originalRect = source.getBoundingClientRect();
    const words = ['Channel gain', 'Copper', 'Reading', 'y = W(x) + b', 'Zinc oxide'];
    const samples = words.map(word => {
      const span = [...document.querySelectorAll<HTMLElement>('#english .pdf-native-text span')].find(node => node.textContent === word);
      if (!span) throw new Error('Missing printed text: ' + word);
      const rect = span.getBoundingClientRect();
      const [a, b] = [source, target].map(canvas => canvas.getContext('2d')!.getImageData(
        (rect.x - originalRect.x) * canvas.width / originalRect.width, (rect.y - originalRect.y) * canvas.height / originalRect.height,
        rect.width * canvas.width / originalRect.width, rect.height * canvas.height / originalRect.height).data);
      return { word, ink: a.some((value, i) => i % 4 === 0 && value < 128), identical: a.every((value, i) => value === b[i]),
        translationRequested: h.view.blocks.some(block => block.id === span.dataset.blockId) };
    });
    const translated = h.view.blocks.filter(block => block.translation && document.querySelector<HTMLElement>(
      '#chinese .pdf-translated-text[data-block-id="' + block.id + '"]')?.getClientRects().length);
    return { samples, text: translated.map(block => block.text).join(' ') };
  }, specimenBytes.toString('base64'));
  for (const sample of labels.samples) {
    assert.ok(sample.ink && sample.identical, 'The imported ' + sample.word + ' glyphs must remain at their original positions.');
    assert.equal(sample.translationRequested, false, sample.word + ' belongs to the printed illustration, table or formula.');
  }
  for (const phrase of ['signal passes', 'Measurements taken', 'experiment confirms', 'We use x + y.']) {
    assert.ok(labels.text.includes(phrase), phrase + ' must receive a translation.');
  }
  const imagePage = await browser.newPage();
  await imagePage.setContent('<svg width="300" height="200"><rect x="0" y="0" width="300" height="200" fill="#537783"/></svg>');
  const imageOnly = await imagePage.pdf({ format: 'Letter', printBackground: true });
  await imagePage.close();
  const scanned = await tab.evaluate(async data => {
    const file = '/view.js';
    const { openPdf } = await import(file) as typeof import('../src/reader/pdf-view.js');
    const h = window.pdfTests;
    await h.pdf.destroy();
    h.pdf = await openPdf(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
    h.view = await h.pdf.render({...h.options, page: 1});
    const status = document.querySelector<HTMLElement>('#chinese .pdf-translation-state')!;
    return { blocks: h.view.blocks.length, state: status.dataset.state, description: status.textContent };
  }, imageOnly.toString('base64'));
  assert.equal(scanned.blocks, 0); assert.equal(scanned.state, 'scanned'); assert.match(scanned.description ?? '', /OCR/);
  await tab.evaluate(() => window.pdfTests.pdf.destroy());
});
