import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { unchangedArticleBlock } from '../src/reader/article-content.js';
import { importLocalFile } from '../src/server/file-import.js';
import { apply } from '../src/server/index.js';
import { Library } from '../src/server/library.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { createServices } from '../src/server/services.js';
import { openZip } from '../src/server/zip-reader.js';

interface ZipEntry { name: string; data: Buffer | string; store?: boolean; fakeUncompressed?: number }
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [], cds: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8'), raw = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data, 'utf8');
    const method = item.store ? 0 : 8, payload = method === 0 ? raw : deflateRawSync(raw), uncompressed = item.fakeUncompressed ?? raw.length;
    const lfh = Buffer.alloc(30), cd = Buffer.alloc(46);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0x0800, 6); lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(payload.length, 18); lfh.writeUInt32LE(uncompressed, 22); lfh.writeUInt16LE(nameBuf.length, 26);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(payload.length, 20); cd.writeUInt32LE(uncompressed, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(lfh, nameBuf, payload); cds.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + payload.length;
  }
  const cdBuf = Buffer.concat(cds), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

function makeSamplePptx(): Buffer {
  const pres = '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>';
  const presRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>';
  const slide1 = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>FlashAttention &amp; Tiling</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Keep QKV blocks in SRAM</a:t></a:r></a:p><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Fuse softmax reduction</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="4" name="Figure 1" descr="SRAM diagram"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg1"/></p:blipFill></p:pic><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Stage</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>HBM IO</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Tiled</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>O(N)</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  const slide1Rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/><Relationship Id="rIdNote1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>';
  const notes1 = '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>SPEAKER_NOTES_TOKEN Emphasize HBM bandwidth bottleneck.</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>99</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>';
  const slide2 = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Evaluation Results</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>SLIDE_TWO_TOKEN Achieves 2.4x speedup on A100.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  const core = '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>FlashAttention Talk</dc:title><dc:creator>Tri Dao</dc:creator></cp:coreProperties>';
  return buildZip([
    { name: 'docProps/core.xml', data: core }, { name: 'ppt/presentation.xml', data: pres },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels }, { name: 'ppt/slides/slide1.xml', data: slide1 },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: slide1Rels }, { name: 'ppt/notesSlides/notesSlide1.xml', data: notes1 },
    { name: 'ppt/slides/slide2.xml', data: slide2 }, { name: 'ppt/media/image1.png', data: PNG_1X1, store: true }
  ]);
}

function makeDocx(bodyInner: string): Buffer {
  return buildZip([
    { name: 'word/document.xml', data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${bodyInner}</w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdPic1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/></Relationships>' },
    { name: 'word/media/chart.png', data: PNG_1X1 }
  ]);
}

test('PPTX import extracts ordered slides, bullets, tables, embedded PNG, speaker notes, FTS, and delete cleanup', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-pptx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root, library, store });

  const { doc } = await importLocalFile({ library, store }, { filename: 'talk_deck.pptx', bytes: makeSamplePptx() });
  assert.ok(doc.id.startsWith('book-') && doc.book?.sections.length === 2 && doc.title === 'FlashAttention Talk' && doc.authors === 'Tri Dao');
  assert.deepEqual(doc.book.sections.map(s => s.title), ['1. FlashAttention & Tiling', '2. Evaluation Results']);
  assert.equal(doc.paragraphs?.some(p => p === '99' || p === '1'), false);

  const entries = Object.entries(doc.articleLayout ?? {});
  assert.ok(entries.some(([, b]) => b.kind === 'list') && entries.some(([, b]) => b.kind === 'table' && b.cells?.[1]?.[0] === 'Tiled'));
  const notesEntry = entries.find(([, b]) => b.kind === 'notes'), imgEntry = entries.find(([, b]) => b.kind === 'image');
  assert.ok(notesEntry && doc.paragraphs?.[Number(notesEntry[0].slice(2)) - 1]?.includes('SPEAKER_NOTES_TOKEN'));
  assert.equal(unchangedArticleBlock('notes'), false);
  assert.ok(imgEntry && imgEntry[1].image?.alt === 'SRAM diagram');

  let downloadCalled = false;
  const served = await library.articleImage(doc.id, imgEntry[0], async () => { downloadCalled = true; return { type: 'image/png', bytes: Buffer.alloc(0) }; }, 1);
  assert.equal(downloadCalled, false);
  assert.equal(served.type, 'image/png');
  assert.deepEqual(served.bytes, PNG_1X1);

  const imgFile = path.join(root, 'article-images', doc.id, '1', imgEntry[0]);
  assert.equal(existsSync(imgFile), true);
  await rm(imgFile);
  await assert.rejects(library.articleImage(doc.id, imgEntry[0], async () => { downloadCalled = true; return { type: 'image/png', bytes: PNG_1X1 }; }, 1), { status: 404 });
  assert.equal(downloadCalled, false);

  assert.equal((await act('pages.search', { query: 'SPEAKER_NOTES_TOKEN', docIds: [doc.id] })).hits[0]?.page, 1);
  assert.equal((await act('pages.search', { query: 'SLIDE_TWO_TOKEN', docIds: [doc.id] })).hits[0]?.page, 2);
  assert.equal((await act('library.delete', { id: doc.id })).deleted, true);
  assert.equal(existsSync(path.join(root, 'article-images', doc.id)), false);
  assert.equal((await act('pages.search', { query: 'SLIDE_TWO_TOKEN', docIds: [doc.id] })).hits.length, 0);
});

test('DOCX import preserves headings, lists, tables, embedded PNG, and auto-shards long documents (>130 blocks)', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-docx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root, library, store });

  const shortBody = [
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Kernel Spec</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Design &amp; Memory</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>DOCX_SHORT_TOKEN Keep </w:t></w:r><w:del><w:r><w:t>DELETED_TEXT </w:t></w:r></w:del><w:r><w:t>tiles aligned&#x2014;always.</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Coalesced loads</w:t></w:r></w:p>',
    '<w:p><w:r><w:drawing><wp:docPr id="1" name="Chart" descr="Latency plot"/><a:blip r:embed="rIdPic1"/></w:drawing></w:r></w:p>',
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Throughput</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>980 tok/s</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  ].join('');
  const { doc: shortDoc } = await importLocalFile({ library, store }, { filename: 'spec.docx', bytes: makeDocx(shortBody) });
  assert.ok(shortDoc.id.startsWith('web-') && shortDoc.title === 'Kernel Spec');
  assert.equal(shortDoc.paragraphs?.some(p => p.includes('DELETED_TEXT')), false);
  assert.ok(shortDoc.paragraphs?.some(p => p.includes('tiles aligned\u2014always.')));
  const imgEntry = Object.entries(shortDoc.articleLayout ?? {}).find(([, b]) => b.kind === 'image');
  assert.ok(imgEntry && imgEntry[1].image?.alt === 'Latency plot');
  const pic = await library.articleImage(shortDoc.id, imgEntry[0], async () => { throw new Error('unexpected remote download'); });
  assert.equal(pic.type, 'image/png');
  assert.deepEqual(pic.bytes, PNG_1X1);
  assert.equal((await act('library.delete', { id: shortDoc.id })).deleted, true);
  assert.equal(existsSync(path.join(root, 'article-images', shortDoc.id)), false);

  const longParts = ['<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter 1 Overview</w:t></w:r></w:p>'];
  for (let i = 1; i <= 70; i++) longParts.push(`<w:p><w:r><w:t>Intro paragraph ${i} discussing distributed runtime scheduling.</w:t></w:r></w:p>`);
  longParts.push('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter 2 Benchmarks</w:t></w:r></w:p>');
  longParts.push('<w:p><w:r><w:t>DOCX_SHARD_TOKEN Second chapter benchmark analysis.</w:t></w:r></w:p>');
  longParts.push('<w:p><w:r><w:drawing><wp:docPr id="2" name="Bench" descr="Bench chart"/><a:blip r:embed="rIdPic1"/></w:drawing></w:r></w:p>');
  for (let i = 1; i <= 70; i++) longParts.push(`<w:p><w:r><w:t>Benchmark paragraph ${i} detailing latency quantiles.</w:t></w:r></w:p>`);
  const { doc: longDoc } = await importLocalFile({ library, store }, { filename: 'thesis.docx', bytes: makeDocx(longParts.join('')) });
  assert.ok(longDoc.id.startsWith('book-') && longDoc.book && longDoc.book.sections.length >= 2);
  const shardHit = (await act('pages.search', { query: 'DOCX_SHARD_TOKEN', docIds: [longDoc.id] })).hits[0];
  assert.ok(shardHit && shardHit.page >= 2);
  const secImg = Object.entries(library.cachedSection(longDoc, shardHit.page)?.articleLayout ?? {}).find(([, b]) => b.kind === 'image');
  assert.ok(secImg);
  assert.deepEqual((await library.articleImage(longDoc.id, secImg[0], async () => { throw new Error('unexpected'); }, shardHit.page)).bytes, PNG_1X1);
});

test('ZIP security guards reject bombs, path traversal, oversized/corrupt archives, and legacy .ppt returns bilingual 415', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-zip-sec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));

  assert.throws(() => openZip(buildZip([{ name: 'bomb.xml', data: Buffer.alloc(200_000, 0) }])), { status: 413 });
  assert.throws(() => openZip(buildZip([{ name: 'lying.xml', data: Buffer.alloc(200_000, 0), fakeUncompressed: 100 }])).read('lying.xml'), { status: 413 });
  for (const bad of ['../evil.xml', '/abs.xml', 'a\\b.xml']) assert.throws(() => openZip(buildZip([{ name: bad, data: 'x' }])), { status: 400 });
  assert.throws(() => openZip(buildZip([{ name: 'big.xml', data: 'x', fakeUncompressed: 17 * 1024 * 1024 }])), { status: 413 });
  assert.throws(() => openZip(Buffer.from('not a zip file at all')), { status: 400 });

  await assert.rejects(
    importLocalFile({ library, store }, { filename: 'legacy-deck.ppt', bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }),
    (err: unknown) => Boolean(err && typeof err === 'object' && (err as { status?: number }).status === 415 &&
      /\.pptx/.test(String((err as Error).message)) && /暂不支持旧版二进制/.test(String((err as Error).message)))
  );

  const prevHome = process.env.PAPER_READER_HOME;
  process.env.PAPER_READER_HOME = root;
  t.after(() => { if (prevHome === undefined) delete process.env.PAPER_READER_HOME; else process.env.PAPER_READER_HOME = prevHome; });
  const routes = new Map<string, (req: Request) => Promise<Response>>();
  apply({ connection: { fetch: { register(r: { path: string; fetch(req: Request): Promise<Response> }) { routes.set(r.path, r.fetch); } } }, inject: () => () => {} });
  const upload = routes.get('/api/paper-reader/import-file')!;
  const pptxResp = await upload(new Request('http://dsh.internal/api/paper-reader/import-file?filename=talk.pptx', {
    method: 'POST', headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }, body: new Uint8Array(makeSamplePptx())
  }));
  assert.equal(pptxResp.status, 200);
  const pptResp = await upload(new Request('http://dsh.internal/api/paper-reader/import-file?filename=old.ppt', {
    method: 'POST', headers: { 'content-type': 'application/vnd.ms-powerpoint' }, body: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])
  }));
  assert.equal(pptResp.status, 415);
});
