import path from 'node:path';
import type { ShardedBook } from '../shared/doc-sharding.js';
import { bookSlug } from '../shared/openstax.js';
import type { BookSection } from '../shared/types.js';
import type { ArticleBlock, ArticleLayout, WebArticle } from '../shared/web-article.js';
import { fail, hash } from './library.js';
import { cleanFilenameTitle } from './markdown-article.js';
import { openZip, type ZipArchive } from './zip-reader.js';

export interface LocalMediaAsset { mime: string; bytes: Buffer }
interface RelTarget { target: string; type: string }
interface BlockCollector { paragraphs: string[]; layout: ArticleLayout; add(text: string, block: ArticleBlock): void }

const MAX_EXTRACTED_CHARS = 16_000_000, MAX_BLOCKS = 25_000, MAX_BLOCK_CHARS = 20_000, MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const SKIP_SLIDE_PH = new Set(['sldnum', 'ftr', 'dt', 'hdr', 'sldimg']);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cleanLine = (raw: string): string => raw.replace(/\s+/g, ' ').trim();
const tagRe = (tag: string, flags = 'g') => new RegExp(`<${tag}(?:\\s[^>]*)?(?<!\\/)>([\\s\\S]*?)<\\/${tag}>`, flags);

function decodeXml(raw: string): string {
  return raw.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (_, hex, dec, named) => {
    if (hex || dec) {
      const code = Number.parseInt(hex || dec, hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return named === 'amp' ? '&' : named === 'lt' ? '<' : named === 'gt' ? '>' : named === 'quot' ? '"' : "'";
  });
}

function xmlAttr(tag: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXml(m[1] ?? m[2] ?? '') : '';
}

function extractRuns(xml: string, prefix: 'a' | 'w', multiline = false): string {
  const re = new RegExp(`<${prefix}:(?:(t)(?:\\s[^>]*)?(?<!\\/)>([\\s\\S]*?)<\\/${prefix}:t>|(br|tab)\\b[^>]*>)`, 'g');
  let out = '';
  for (const m of xml.matchAll(re)) out += m[1] ? decodeXml(m[2] ?? '') : m[3] === 'br' ? '\n' : ' ';
  return multiline ? out.split('\n').map(l => l.replace(/[ \t\r]+/g, ' ').trim()).filter(Boolean).join('\n') : cleanLine(out);
}

function parseRels(xml: string | undefined, baseDir: string): Map<string, RelTarget> {
  const rels = new Map<string, RelTarget>();
  for (const m of (xml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    if (xmlAttr(tag, 'TargetMode').toLowerCase() === 'external') continue;
    const id = xmlAttr(tag, 'Id'), rawTarget = xmlAttr(tag, 'Target'), type = xmlAttr(tag, 'Type');
    const resolved = rawTarget.startsWith('/') ? rawTarget.replace(/^\/+/, '') : path.posix.normalize(path.posix.join(baseDir, rawTarget));
    if (id && rawTarget && resolved && !resolved.startsWith('..') && !resolved.startsWith('/')) rels.set(id, { target: resolved, type });
  }
  return rels;
}

function detectRasterMime(bytes: Buffer): { mime: string; ext: string } | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIG)) return { mime: 'image/png', ext: 'png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return { mime: 'image/gif', ext: 'gif' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
}

function makeMediaRegistry(archive: ZipArchive) {
  const media = new Map<string, LocalMediaAsset>(), urlByEntry = new Map<string, string>();
  return {
    media,
    addBlip(col: BlockCollector, rels: Map<string, RelTarget>, blipTag: string, rawAlt: string, fallbackAlt: string): void {
      const entryPath = rels.get(xmlAttr(blipTag, 'r:embed'))?.target;
      if (!entryPath) return;
      let url = urlByEntry.get(entryPath);
      if (!url) {
        const bytes = archive.read(entryPath);
        const detected = bytes?.length && bytes.length <= MAX_MEDIA_BYTES ? detectRasterMime(bytes) : undefined;
        if (!bytes || !detected) return;
        url = `local:${hash(bytes).slice(0, 16)}.${detected.ext}`;
        media.set(url, { mime: detected.mime, bytes });
        urlByEntry.set(entryPath, url);
      }
      const alt = cleanLine(rawAlt).slice(0, 1024);
      col.add(alt || fallbackAlt, { kind: 'image', image: { url, alt } });
    }
  };
}

function makeCollector(): BlockCollector {
  const paragraphs: string[] = [], layout: ArticleLayout = {};
  let totalChars = 0;
  function pushSingle(text: string, block: ArticleBlock): void {
    if (!text.trim()) return;
    totalChars += text.length;
    if (totalChars > MAX_EXTRACTED_CHARS || paragraphs.length >= MAX_BLOCKS) fail('This document is too long to open in the reader.', 413);
    paragraphs.push(text);
    if (block.kind !== 'p' || block.ids || block.image || block.cells) layout['p-' + paragraphs.length] = block;
  }
  return {
    paragraphs, layout,
    add(text, block) {
      if (text.length <= MAX_BLOCK_CHARS || block.kind === 'image' || block.kind === 'table') { pushSingle(text, block); return; }
      for (let i = 0; i < text.length; i += MAX_BLOCK_CHARS) { const piece = text.slice(i, i + MAX_BLOCK_CHARS).trim(); if (piece) pushSingle(piece, { kind: block.kind }); }
    }
  };
}

function extractXmlTable(collector: BlockCollector, xml: string, prefix: 'a' | 'w'): void {
  const trRe = tagRe(`${prefix}:tr`), tcRe = tagRe(`${prefix}:tc`), pRe = tagRe(`${prefix}:p`), delRe = tagRe('w:del');
  let chunk: string[][] = [], len = 0;
  const flush = () => { if (!chunk.length) return; const text = chunk.map(r => r.join('\t')).join('\n'); if (text.trim()) collector.add(text, { kind: 'table', cells: chunk }); chunk = []; len = 0; };
  for (const tr of xml.matchAll(trRe)) {
    let row = [...tr[1].matchAll(tcRe)].map(tc => [...(prefix === 'w' ? tc[1].replace(delRe, '') : tc[1]).matchAll(pRe)].map(p => extractRuns(p[1], prefix)).filter(Boolean).join(' '));
    if (!row.some(Boolean)) continue;
    let rowText = row.join('\t');
    if (rowText.length > MAX_BLOCK_CHARS) { const cap = Math.max(1, Math.floor((MAX_BLOCK_CHARS - row.length + 1) / Math.max(1, row.length))); row = row.map(c => c.slice(0, cap)); rowText = row.join('\t'); }
    if (chunk.length && len + rowText.length + 1 > MAX_BLOCK_CHARS) flush();
    chunk.push(row); len += rowText.length + (chunk.length > 1 ? 1 : 0);
  }
  flush();
}

function readCoreMeta(archive: ZipArchive): { title?: string; authors?: string } {
  const xml = archive.readText('docProps/core.xml') ?? '';
  const title = cleanLine(decodeXml(tagRe('dc:title', '').exec(xml)?.[1] ?? ''));
  const authors = cleanLine(decodeXml(tagRe('dc:creator', '').exec(xml)?.[1] ?? ''));
  return { ...(title ? { title: title.slice(0, 250) } : {}), ...(authors ? { authors: authors.slice(0, 300) } : {}) };
}

function toSafeSlug(raw: string, fallback: string): string {
  const cleaned = [...raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^[_-]+|[_-]+$/g, '')].slice(0, 80).join('');
  return bookSlug(cleaned) ? cleaned : fallback;
}

export function parsePptxBuffer(bytes: Buffer, filename?: string): { title: string; authors?: string; sharded: ShardedBook; media: Map<string, LocalMediaAsset> } {
  const archive = openZip(bytes);
  const presXml = archive.readText('ppt/presentation.xml'), presRels = parseRels(archive.readText('ppt/_rels/presentation.xml.rels'), 'ppt');
  const slidePaths: string[] = [];
  for (const m of (presXml ?? '').matchAll(/<p:sldId\b[^>]*>/g)) {
    const target = presRels.get(xmlAttr(m[0], 'r:id'))?.target;
    if (target && !slidePaths.includes(target)) slidePaths.push(target);
  }
  if (!slidePaths.length) slidePaths.push(...archive.names().filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/i.exec(b)?.[1] ?? 0)));
  if (!slidePaths.length) fail('No slides were found in this PowerPoint file.', 415);

  const core = readCoreMeta(archive), mediaReg = makeMediaRegistry(archive), apRe = tagRe('a:p'), spRe = tagRe('p:sp');
  const rawSlides: { title: string; paragraphs: string[]; articleLayout: ArticleLayout }[] = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const slidePath = slidePaths[i], xml = archive.readText(slidePath);
    if (!xml) continue;
    const rels = parseRels(archive.readText(path.posix.join(path.posix.dirname(slidePath), '_rels', path.posix.basename(slidePath) + '.rels')), path.posix.dirname(slidePath));
    const col = makeCollector(), bodyXml = tagRe('p:spTree', '').exec(xml)?.[1] ?? xml;
    let slideTitle = '';
    for (const m of bodyXml.matchAll(/<p:sp(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/p:sp>|<p:pic(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/p:pic>|<a:tbl(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/a:tbl>/g)) {
      const node = m[0];
      if (node.startsWith('<p:pic')) {
        const nvPr = /<p:cNvPr\b[^>]*>/.exec(node)?.[0] ?? '';
        mediaReg.addBlip(col, rels, /<a:blip\b[^>]*>/.exec(node)?.[0] ?? '', xmlAttr(nvPr, 'descr') || xmlAttr(nvPr, 'name'), 'Slide illustration');
        continue;
      }
      if (node.startsWith('<a:tbl')) { extractXmlTable(col, node, 'a'); continue; }
      const phTag = /<p:ph\b[^>]*>/.exec(node)?.[0] ?? '', phType = xmlAttr(phTag, 'type').toLowerCase();
      if (SKIP_SLIDE_PH.has(phType)) continue;
      const texts = [...node.matchAll(apRe)].map(p => ({ xml: p[1], text: extractRuns(p[1], 'a') })).filter(p => p.text);
      const isTitle = phType === 'title' || phType === 'ctrtitle', isBody = phType === 'body' || phType === 'obj' || (!phType && /idx="/.test(phTag));
      for (const { xml: pXml, text } of texts) {
        if (isTitle && !slideTitle) { slideTitle = text.slice(0, 160); col.add(text, { kind: 'h1' }); }
        else if (phType === 'subtitle') col.add(text, { kind: 'byline' });
        else col.add(text, { kind: !/<a:buNone\b/.test(pXml) && (/<a:buChar\b|<a:buAutoNum\b/.test(pXml) || (isBody && (texts.length > 1 || /\blvl="[1-9]/.test(pXml)))) ? 'list' : 'p' });
      }
    }
    const notesRel = [...rels.values()].find(r => r.type.endsWith('/notesSlide'));
    const notesXml = notesRel ? archive.readText(notesRel.target) : undefined;
    if (notesXml) {
      const noteParts: string[] = [];
      for (const sp of notesXml.matchAll(spRe)) {
        if (SKIP_SLIDE_PH.has(xmlAttr(/<p:ph\b[^>]*>/.exec(sp[1])?.[0] ?? '', 'type').toLowerCase())) continue;
        for (const p of sp[1].replace(/<a:fld\b[^>]*type="slidenum"[^>]*>[\s\S]*?<\/a:fld>/gi, '').matchAll(apRe)) { const text = extractRuns(p[1], 'a', true); if (text) noteParts.push(text); }
      }
      if (noteParts.length) col.add(noteParts.join('\n\n'), { kind: 'notes' });
    }
    if (!col.paragraphs.length) col.add(`Slide ${i + 1}`, { kind: 'h1' });
    if (!slideTitle && !['image', 'table', 'notes'].includes(col.layout['p-1']?.kind ?? '')) slideTitle = col.paragraphs[0].slice(0, 120);
    rawSlides.push({ title: slideTitle || `Slide ${i + 1}`, paragraphs: col.paragraphs, articleLayout: col.layout });
  }
  if (!rawSlides.length) fail('No readable slides were found in this PowerPoint file.', 415);

  const docTitle = core.title || (rawSlides[0].title !== 'Slide 1' ? rawSlides[0].title : cleanFilenameTitle(filename));
  const bookSections: BookSection[] = [];
  const sections = rawSlides.map((slide, idx) => {
    const page = idx + 1, title = slide.title === `Slide ${page}` ? slide.title : `${page}. ${slide.title}`.slice(0, 160);
    const meta: BookSection = { slug: `slide-${page}`, title, chapterId: 'slides', chapterTitle: docTitle, url: '' };
    bookSections.push(meta);
    return { ...meta, paragraphs: slide.paragraphs, articleLayout: slide.articleLayout };
  });
  return { title: docTitle, ...(core.authors ? { authors: core.authors } : {}), sharded: { slug: toSafeSlug(docTitle, 'slides'), sections, bookSections, anchorPages: {} }, media: mediaReg.media };
}

function* iterDocxBlocks(bodyXml: string): Generator<{ kind: 'p' | 'tbl'; xml: string }> {
  let tblDepth = 0, pDepth = 0, start = -1;
  for (const m of bodyXml.matchAll(/<(\/?)w:(tbl|p)(?=[\s/>])[^>]*>/g)) {
    const tag = m[0], close = m[1] === '/', name = m[2];
    if (!close && tag.endsWith('/>')) continue;
    if (!tblDepth && !pDepth) { if (!close) { start = m.index; if (name === 'tbl') tblDepth = 1; else pDepth = 1; } }
    else if (tblDepth && name === 'tbl') { tblDepth += close ? -1 : 1; if (!tblDepth) { yield { kind: 'tbl', xml: bodyXml.slice(start, m.index + tag.length) }; start = -1; } }
    else if (pDepth && name === 'p') { pDepth += close ? -1 : 1; if (!pDepth) { yield { kind: 'p', xml: bodyXml.slice(start, m.index + tag.length) }; start = -1; } }
  }
}

function docxParagraphKind(pXml: string): ArticleBlock['kind'] {
  const pPr = tagRe('w:pPr', '').exec(pXml)?.[1] ?? '';
  const style = xmlAttr(/<w:pStyle\b[^>]*>/.exec(pPr)?.[0] ?? '', 'w:val').trim();
  const headingMatch = /^(?:heading|标题)\s*([1-6])$/i.exec(style) ?? /^([1-6])$/.exec(style);
  if (headingMatch) return ('h' + headingMatch[1]) as ArticleBlock['kind'];
  if (/^title$/i.test(style)) return 'h1';
  if (/^subtitle$/i.test(style)) return 'byline';
  const outline = xmlAttr(/<w:outlineLvl\b[^>]*>/.exec(pPr)?.[0] ?? '', 'w:val');
  if (/^[0-5]$/.test(outline)) return ('h' + (Number(outline) + 1)) as ArticleBlock['kind'];
  return /quote|blocktext/i.test(style) ? 'quote' : /caption/i.test(style) ? 'caption' : /<w:numPr\b/.test(pPr) || /list/i.test(style) ? 'list' : 'p';
}

export function parseDocxBuffer(bytes: Buffer, filename?: string): { article: WebArticle; media: Map<string, LocalMediaAsset> } {
  const archive = openZip(bytes), docXml = archive.readText('word/document.xml');
  if (!docXml) fail('This file does not contain a valid Word document.', 415);
  const rels = parseRels(archive.readText('word/_rels/document.xml.rels'), 'word');
  const core = readCoreMeta(archive), mediaReg = makeMediaRegistry(archive), col = makeCollector();
  const bodyXml = tagRe('w:body', '').exec(docXml)?.[1] ?? docXml, delRe = tagRe('w:del');
  let firstTitle = '';
  for (const block of iterDocxBlocks(bodyXml)) {
    if (block.kind === 'tbl') { extractXmlTable(col, block.xml, 'w'); continue; }
    const cleaned = block.xml.replace(delRe, '');
    const docPrs = [...cleaned.matchAll(/<wp:docPr\b[^>]*>/g)].map(m => xmlAttr(m[0], 'descr') || xmlAttr(m[0], 'name'));
    let imgIdx = 0;
    for (const blip of cleaned.matchAll(/<a:blip\b[^>]*>/g)) mediaReg.addBlip(col, rels, blip[0], docPrs[imgIdx++] ?? '', 'Document illustration');
    const kind = docxParagraphKind(cleaned), text = extractRuns(cleaned, 'w', kind === 'p');
    if (!text) continue;
    if (kind === 'h1' && !firstTitle) firstTitle = text.slice(0, 250);
    col.add(text, { kind });
  }
  if (!col.paragraphs.length) fail('No readable text was found in this document.', 415);
  return { article: { url: '', title: core.title || firstTitle || cleanFilenameTitle(filename), paragraphs: col.paragraphs, articleLayout: col.layout, ...(core.authors ? { authors: core.authors } : {}) }, media: mediaReg.media };
}
