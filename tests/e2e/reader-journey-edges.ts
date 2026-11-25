import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import sharp from 'sharp';
import { cardMoreAction } from './helpers/reader.js';
import { withHost } from './host.js';

const twin = 'Edition.pdf';
const scan = 'Scan.pdf';
const visionAnswer = 'A red stripe appears on a blue field.';
const oversizedBytes = 80 * 1024 * 1024 + 1;

async function fixtureFiles(context: BrowserContext) {
  const printer = await context.newPage();
  try {
    const style = '<style>@page{size:6in 9in;margin:.4in}body{font:16px Arial}section+section{break-before:page}</style>';
    const make = async (html: string) => {
      await printer.setContent(style + html);
      return printer.pdf({preferCSSPageSize: true, printBackground: true});
    };
    const first = await make('<section><h1>First edition</h1><p>A distinct source for reading.</p>' +
      '<div style="height:3.2in"></div><p>Compare our missing source [7] with our published source [1].</p></section>' +
      '<section><h1>References</h1><p>[1] R. Example. “A named reference”. 2025.</p></section>');
    const second = await make('<section><h1>Second edition</h1><p>Different bytes, same filename.</p></section>');
    const pixels = await printer.evaluate(() => {
      const graphic = document.createElement('canvas');
      graphic.width = 600; graphic.height = 780;
      const ink = graphic.getContext('2d')!;
      ink.fillStyle = 'rgb(7, 92, 175)'; ink.fillRect(0, 0, 600, 780);
      ink.fillStyle = 'rgb(230, 15, 12)'; ink.fillRect(180, 0, 60, 780);
      return graphic.toDataURL('image/png');
    });
    await printer.setContent('<style>@page{size:600px 780px;margin:0}*{margin:0}img{display:block;width:600px;height:780px}</style><img alt="" src="' + pixels + '">');
    await printer.locator('img').evaluate(node => (node as HTMLImageElement).decode());
    const raster = await printer.pdf({preferCSSPageSize: true, printBackground: true});
    return { first, second, raster };
  } finally { await printer.close(); }
}

async function openLibrary(page: Page) {
  await page.getByRole('button', {name: 'Open library', exact: true}).click();
  await page.getByRole('tab', {name: 'On this device'}).click();
  await page.locator('#dialog[open] .doc-row').first().waitFor();
}

async function choose(page: Page, file: string | {name: string; buffer: Buffer}) {
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', {name: 'Open a PDF', exact: true}).click();
  await (await choosing).setFiles(typeof file === 'string' ? file : {...file, mimeType: 'application/pdf'});
}

async function loaded(page: Page) {
  await page.locator('#dialog').waitFor({state: 'hidden'});
  await page.locator('#original canvas.pdf-raster').first().waitFor();
  await page.locator('#loading').waitFor({state: 'hidden'});
}

async function imports(page: Page, files: Awaited<ReturnType<typeof fixtureFiles>>, scratch: string) {
  const oversized = path.join(scratch, 'Oversized.pdf');
  const handle = await open(oversized, 'w');
  try { await handle.write(files.first); await handle.truncate(oversizedBytes); } finally { await handle.close(); }
  let posts = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/import-pdf')) posts++; });
  await openLibrary(page);
  await choose(page, {name:'Broken.pdf', buffer:Buffer.from('Broken research paper')});
  await page.locator('#toast').filter({hasText:/Invalid PDF/i}).waitFor();
  const invalid = await page.locator('#toast').innerText();
  await choose(page, oversized);
  await page.locator('#toast').filter({hasText:'Choose a PDF of up to 80 MB.'}).waitFor();
  assert.equal(posts, 0);
  assert.equal(await page.locator('#pageCount').innerText(), '6 / 16');
  assert.equal(await page.locator('#dialog[open] .doc-row').count(), 1);

  await choose(page, {name:twin, buffer:files.first}); await loaded(page);
  const idA = new URL(page.url()).searchParams.get('doc');
  await page.locator('#original .pdf-native-text').getByText('First edition', {exact:true}).waitFor();
  await openLibrary(page); await choose(page, {name:twin, buffer:files.second}); await loaded(page);
  const idB = new URL(page.url()).searchParams.get('doc');
  assert.ok(idA && idB && idA !== idB);
  await page.locator('#original .pdf-native-text').getByText('Second edition', {exact:true}).waitFor();
  await openLibrary(page);
  const rows = page.locator('#dialog .doc-row').filter({hasText:twin});
  assert.equal(await rows.count(), 2);
  for (const [id, heading] of [[idA, 'First edition'], [idB, 'Second edition'], [idA, 'First edition']]) {
    if (!await page.locator('#dialog').isVisible()) await openLibrary(page);
    await rows.filter({hasNotText:'Open'}).click();
    await loaded(page);
    assert.equal(new URL(page.url()).searchParams.get('doc'), id);
    await page.locator('#original .pdf-native-text').getByText(heading, {exact:true}).waitFor();
  }
  assert.equal(posts, 2);
  console.log('PASS J13 - picker showed "' + invalid + '" and "Choose a PDF of up to 80 MB." for ' + oversizedBytes +
    ' bytes. Rejected uploads: 0. Same picker accepted the replacement. Both Edition.pdf entries reopened their own text and document IDs.');
}

async function citation(page: Page) {
  const original = page.locator('#original');
  const match = original.getByRole('button', {name:'Reference 1', exact:true}).first();
  await match.focus(); await match.press('Enter');
  const tip = page.locator('.citation-preview');
  await tip.getByText(/A named reference/).waitFor();
  await match.press('Escape'); await tip.waitFor({state:'hidden'});
  const missing = original.getByRole('button', {name:'Reference 7', exact:true}).first();
  await missing.scrollIntoViewIfNeeded();
  await page.locator('#paperScroll').evaluate(node => { node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, 90); });
  const position = () => page.locator('#paperScroll').evaluate(node => [node.scrollLeft, node.scrollTop]);
  const before = await position();
  assert.ok(before[1] > 0, 'Start reading partway down the page.');
  const url = page.url();
  await missing.focus();
  assert.deepEqual(await position(), before);
  await missing.press('Enter');
  await tip.getByText('No matching bibliography entry.').waitFor();
  await missing.press('Escape');
  await tip.waitFor({state:'hidden'});
  assert.equal(page.url(), url);
  assert.deepEqual(await position(), before);
  assert.equal(await missing.evaluate(node => document.activeElement === node), true);
  console.log('PASS J17 - [1] resolved. [7] showed "No matching bibliography entry." Escape retained page 1, the citation focus and scroll ' + before.join(',') + '.');
}

interface ImageObservation { bytes: Buffer; question: string; regionText: string }
interface ModelPart { type: string; text?: string; image_url?: {url: string} }
async function visionFixture() {
  const observations: ImageObservation[] = [];
  const model = { images: false, otherCalls: 0 };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {messages: {role: string; content: string | ModelPart[]}[]};
      const content = body.messages.find(turn => turn.role === 'user')?.content;
      const png = Array.isArray(content) ? content.find(part => part.type === 'image_url')?.image_url?.url : undefined;
      if (!Array.isArray(content) || !png?.startsWith('data:image/png;base64,')) {
        model.otherCalls++;
        res.writeHead(422).end(); return;
      }
      const payload = JSON.parse(content.find(part => part.type === 'text')!.text!) as {question:string;regionText:string};
      observations.push({bytes:Buffer.from(png.split(',')[1], 'base64'), ...payload});
      res.setHeader('content-type','application/json');
      if (!model.images) {
        res.writeHead(400).end(JSON.stringify({error:{code:'unsupported_image_input', message:'Model does not support images.'}})); return;
      }
      res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:visionAnswer}}]}));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return {url:'http://127.0.0.1:' + address.port + '/v1', observations, model,
    close: () => new Promise<void>(resolve => {server.close(() => resolve()); server.closeAllConnections();})};
}

async function scanPage(page: Page, raster: Buffer, model: Awaited<ReturnType<typeof visionFixture>>) {
  await openLibrary(page); await choose(page, {name:scan, buffer:raster}); await loaded(page);
  assert.equal(await page.locator('#original .pdf-native-text').innerText(), '');
  await page.locator('#parallel').click();
  await page.getByText(/This page has no selectable text/).waitFor();
  await page.locator('#originalMode').click();
  const whole = page.locator('.paper-chat'), wholeToggle = whole.getByRole('button',{name:'Paper chat',exact:true});
  await wholeToggle.click();
  const wholeInput = whole.getByRole('textbox');
  await wholeInput.fill('What does this paper say?'); await wholeInput.press('Enter');
  await whole.getByText(/This document has no searchable text.*OCR/).waitFor();
  assert.equal(model.model.otherCalls + model.observations.length, 0);
  assert.equal(await whole.locator('.paper-answer').count(), 0);
  await wholeToggle.click();
  await page.locator('#captureRegion').click(); await page.locator('.pdf-capture-surface').waitFor();
  const box = await page.locator('#original canvas.pdf-raster').boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .36, {steps:10}); await page.mouse.up();
  await page.locator('.pdf-capture-actions').getByRole('button',{name:'Ask',exact:true}).click();
  const passage = page.locator('#card .selection-chat'), question = 'What colors are visible inside this crop?';
  const field = passage.getByRole('textbox');
  await field.fill(question); await field.press('Enter');
  const problem = passage.getByRole('alert');
  await problem.getByText(/no extractable text|框内没有可提取的文字/).waitFor();
  assert.equal(await passage.locator('.selection-answer').count(), 0);
  model.model.images = true; await problem.getByRole('button',{name:'Retry',exact:true}).click();
  await passage.locator('.selection-answer').getByText(visionAnswer,{exact:true}).waitFor();
  assert.equal(await passage.locator('.selection-answer').count(), 1);
  assert.equal(model.observations.length, 2); assert.equal(model.model.otherCalls, 0);
  const [first, second] = model.observations;
  assert.deepEqual(first.bytes, second.bytes); assert.equal(second.regionText, ''); assert.equal(second.question, question);
  const {data, info} = await sharp(second.bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  let red = 0, blue = 0;
  for (let i=0; i < data.length; i+=info.channels) {
    if (data[i] > 190 && data[i+1] < 55 && data[i+2] < 55) red++;
    if (data[i] < 40 && data[i+1] > 60 && data[i+2] > 140) blue++;
  }
  const pixels = info.width * info.height;
  assert.ok(red / pixels > .12 && blue / pixels > .45, 'The chosen area must actually contain both fixture colors.');
  console.log('PASS J14 - scanned PDF had zero selectable text. Translation and whole-paper chat gave OCR instructions, with zero model calls. ' +
    'An image-rejecting endpoint gave a no-text/vision prompt. Retry sent the identical ' + info.width + 'x' + info.height +
    ' PNG with empty regionText. Pixels were ' + Math.round(100*red/pixels) + '% red and ' + Math.round(100*blue/pixels) + '% blue. The fixed visual reply appeared once.');
}

async function vocabulary(page: Page) {
  await openLibrary(page);
  const twins = page.locator('#dialog .doc-row').filter({hasText:twin});
  const names=await twins.allTextContents();
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  assert.ok(names.some(name => name.includes('1 page')));
  assert.ok(names.some(name => name.includes('2 pages')));
  console.log('PASS J13 - the local library distinguishes editions by page count before opening either file.');
  await page.locator('#dialog .doc-row').filter({hasText:'PagedAttention.pdf'}).click(); await loaded(page);
  await page.locator('#original .pdf-native-text [data-block-id]').filter({hasText:/^block tables$/i}).first().click();
  await cardMoreAction(page.locator('#card'), 'Save word');
  await page.getByText('Saved to vocabulary.',{exact:true}).waitFor();
  await page.locator('#more').click(); await page.getByRole('button',{name:'Vocabulary and history',exact:true}).click();
  const modal=page.locator('#dialog'), query=modal.getByRole('searchbox');
  await query.fill('a missing test word'); await modal.getByText('No matching entries.').waitFor();
  await query.fill('block tables');
  const row=modal.locator('.list-row').filter({hasText:/block tables/i});
  assert.equal(await row.count(), 1);
  await row.getByRole('button',{name:'Remove',exact:true}).click(); await modal.getByText('No matching entries.').waitFor();
  await modal.getByRole('tab',{name:'History',exact:true}).click(); await query.fill('block tables');
  assert.equal(await row.count(), 1); await row.getByRole('button',{name:'PagedAttention.pdf',exact:true}).click();
  await loaded(page);
  await page.locator('#original .pdf-quote-mark').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('anchor'), 'block-tables');
  assert.equal(new URL(page.url()).searchParams.get('page'), '6');
  console.log('PASS J18 - saved and filtered "block tables", removed its vocabulary entry, then found exactly one history row. Its source reopened the marked passage on page 6.');
}

async function batchAndDrop(page: Page, files: Awaited<ReturnType<typeof fixtureFiles>>) {
  let posts = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/import-pdf')) posts++; });
  await openLibrary(page);
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a PDF', exact: true }).click();
  await (await choosing).setFiles([
    { name: 'BatchA.pdf', mimeType: 'application/pdf', buffer: files.first },
    { name: 'skip.txt', mimeType: 'text/plain', buffer: Buffer.from('not a pdf') },
    { name: 'BatchB.pdf', mimeType: 'application/pdf', buffer: files.second }
  ]);
  await loaded(page);
  await page.locator('#toast').filter({ hasText: /Imported 2 PDFs; 1 skipped \(skip\.txt\)\./ }).waitFor();
  assert.equal(posts, 2);
  await page.evaluate(bytes => {
    const dt = new DataTransfer(), target = document.getElementById('reader')!;
    dt.items.add(new File([new Uint8Array(bytes)], 'DropC.pdf', { type: 'application/pdf' }));
    dt.items.add(new File(['bad'], 'drop.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, Array.from(files.first));
  await page.locator('#toast').filter({ hasText: /Imported 1 PDF; 1 skipped \(drop\.txt\)\./ }).waitFor();
  assert.equal(posts, 3);
}

await withHost(async host => {
  const browser = await chromium.launch({executablePath:host.executable});
  try {
    console.log('Isolated DSH and Chrome ' + browser.version() + ', Node ' + process.version + ', 1440x900, en-US.');
    const model = await visionFixture();
    try {
      const context = await browser.newContext({locale:'en-US',viewport:{width:1440,height:900}});
      const files = await fixtureFiles(context), page = await context.newPage();
      page.setDefaultTimeout(12_000);
      await page.goto(host.authenticatedUrl);
      const configured = await context.request.post(host.origin + '/api/paper-reader/action', {data:{op:'settings.save',payload:{baseUrl:model.url,model:'local-test-image'}}});
      assert.ok(configured.ok());
      await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6');
      await loaded(page);
      await imports(page, files, host.scratch);
      await citation(page);
      await scanPage(page, files.raster, model);
      await vocabulary(page);
      await batchAndDrop(page, files);
    } finally { await model.close(); }
  } finally { await browser.close(); }
});
