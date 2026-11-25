import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCitationMetadata,
  buildCiteKey,
  extractArxivId,
  extractYear,
  formatBibTeX,
  formatRIS,
  parseAuthors,
  type CitationMetadata
} from '../src/shared/citation-export.js';
import type { DocumentInfo, ZoteroItem } from '../src/shared/types.js';
import { sample } from '../src/server/library.js';

function assertBalancedBraces(bibtex: string): void {
  let depth = 0;
  for (let i = 0; i < bibtex.length; i++) {
    const ch = bibtex[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      assert.ok(depth >= 0, `Unbalanced closing brace at index ${i} in:\n${bibtex}`);
    }
  }
  assert.equal(depth, 0, `Unbalanced braces (final depth=${depth}) in:\n${bibtex}`);
}

function assertLatexBalancedBraces(bibtex: string): void {
  let depth = 0;
  for (let i = 0; i < bibtex.length; i++) {
    const ch = bibtex[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      assert.ok(depth >= 0, `Unbalanced LaTeX closing brace at index ${i} in:\n${bibtex}`);
    }
  }
  assert.equal(depth, 0, `Unbalanced LaTeX braces (final depth=${depth}) in:\n${bibtex}`);
}

test('bundled pagedattention exports complete BibTeX and RIS with arXiv eprint and deterministic citekey', () => {
  const meta = buildCitationMetadata(sample);
  assert.equal(meta.title, sample.paperTitle);
  assert.deepEqual(meta.authors, ['Kwon et al.']);
  assert.equal(meta.venue, 'SOSP 2023');
  assert.equal(meta.year, '2023');
  assert.equal(meta.doi, '10.1145/3600006.3613165');
  assert.equal(meta.url, 'https://arxiv.org/abs/2309.06180');
  assert.equal(meta.arxivId, '2309.06180');
  assert.equal(buildCiteKey(meta), 'kwon2023efficient');

  const bib = formatBibTeX(meta);
  assertBalancedBraces(bib);
  assert.ok(bib.startsWith('@inproceedings{kwon2023efficient,\n'), bib);
  assert.ok(bib.includes('  title = {Efficient Memory Management for Large Language Model Serving with PagedAttention},'));
  assert.ok(bib.includes('  author = {Kwon and others},'));
  assert.ok(bib.includes('  booktitle = {SOSP 2023},'));
  assert.ok(bib.includes('  year = {2023},'));
  assert.ok(bib.includes('  doi = {10.1145/3600006.3613165},'));
  assert.ok(bib.includes('  url = {https://arxiv.org/abs/2309.06180},'));
  assert.ok(bib.includes('  eprint = {2309.06180},'));
  assert.ok(bib.includes('  archivePrefix = {arXiv}\n}'));
  assert.equal(bib.includes('undefined'), false);

  const ris = formatRIS(meta);
  const lines = ris.split('\n');
  assert.equal(lines[0], 'TY  - CONF');
  assert.ok(lines.includes('TI  - Efficient Memory Management for Large Language Model Serving with PagedAttention'));
  assert.ok(lines.includes('AU  - Kwon et al.'));
  assert.ok(lines.includes('PY  - 2023'));
  assert.ok(lines.includes('T2  - SOSP 2023'));
  assert.ok(lines.includes('DO  - 10.1145/3600006.3613165'));
  assert.ok(lines.includes('UR  - https://arxiv.org/abs/2309.06180'));
  assert.ok(lines.includes('N1  - arXiv:2309.06180'));
  assert.equal(lines.at(-1), 'ER  - ');
  assert.equal(ris.includes('undefined'), false);
});

test('T2-F3-01: sparse bare-filename PDF omits fabricated year and emits clean @misc and TY  - GEN with zero undefined', () => {
  const sparse: DocumentInfo = {
    id: 'pdf-' + 'a'.repeat(64),
    kind: 'pdf',
    title: 'notes.pdf',
    createdAt: '2026-11-24T15:00:00.000Z',
    defaultPage: 1
  };
  const meta = buildCitationMetadata(sparse);
  assert.equal(meta.title, 'notes');
  assert.equal(meta.year, undefined);
  assert.equal(meta.authors, undefined);
  assert.equal(buildCiteKey(meta), 'notes');

  const bib = formatBibTeX(meta);
  assertBalancedBraces(bib);
  assert.equal(bib, '@misc{notes,\n  title = {notes}\n}');
  assert.equal(bib.includes('undefined'), false);
  assert.equal(bib.includes('2026'), false);

  const ris = formatRIS(meta);
  assert.equal(ris, 'TY  - GEN\nTI  - notes\nER  - ');
  assert.equal(ris.includes('undefined'), false);
  assert.equal(ris.includes('2026'), false);
});

test('T2-F3-02: BibTeX escapes all 10 LaTeX special characters without double-escaping or breaking braces', () => {
  const meta: CitationMetadata = {
    title: '100% Fast & #1_Model $x^2 ~ y \\path {in} } , author = {Injected',
    authors: ['O_Reilly & Co.', 'A^B ~ C%D'],
    venue: 'Journal of #Testing & $Metrics_2025',
    year: '2025',
    doi: '10.1000/test_1%20&a=1{bad}',
    url: 'https://example.org/paper?a=1&b=2_3%20#top~x{y}',
    abstract: 'Symbols: \\ { } % & # _ $ ~ ^ and lone } brace.'
  };
  const bib = formatBibTeX(meta);
  assertBalancedBraces(bib);
  assert.ok(bib.includes('100\\% Fast \\& \\#1\\_Model \\$x\\textasciicircum{}2 \\textasciitilde{} y \\textbackslash{}path \\textbraceleft{}in\\textbraceright{} \\textbraceright{} , author = \\textbraceleft{}Injected'));
  // Ensure no double-escaping of \textbackslash{} into \textbackslash\textbraceleft{}\textbraceright{}
  assert.equal(bib.includes('\\textbackslash\\textbraceleft{}'), false);
  // Verbatim URL preserves &, _, %, #, ~ while percent-encoding { and }
  assert.ok(bib.includes('  url = {https://example.org/paper?a=1&b=2_3%20#top~x%7By%7D},'));
  // Verbatim DOI strips braces without escaping _ or %
  assert.ok(bib.includes('  doi = {10.1000/test_1%20&a=1bad},'));
  // Injected author field must not become a real BibTeX field line
  const fieldLines = bib.split('\n').slice(1, -1);
  assert.equal(fieldLines.filter(line => /^\s*author\s*=/.test(line)).length, 1);
});

test('T2-F3-03: RIS normalizes CRLF/LF/CR multiline fields and prevents ER  - or tag injection', () => {
  const meta: CitationMetadata = {
    title: 'Line one\r\nTI  - Fake Title\nER  - ',
    authors: ['Alice Smith\r\nAU  - Injected'],
    year: '2024',
    venue: 'Nature\nPB  - Fake',
    abstract: 'First paragraph.\r\n\r\nER  - \nTI  - Hijacked\rThird line.\u0007'
  };
  const ris = formatRIS(meta);
  const lines = ris.split('\n');
  for (const line of lines) {
    assert.match(line, /^[A-Z0-9]{2}  - /, `Invalid RIS line: ${JSON.stringify(line)}`);
  }
  assert.equal(lines.filter(line => line.startsWith('TY  - ')).length, 1);
  assert.equal(lines.filter(line => line.startsWith('TI  - ')).length, 1);
  assert.equal(lines.filter(line => line.startsWith('AU  - ')).length, 1);
  assert.equal(lines.filter(line => line === 'ER  - ').length, 1);
  assert.equal(lines.at(-1), 'ER  - ');
  assert.equal(ris.includes('\r'), false);
  assert.ok(lines.some(line => line.startsWith('AB  - First paragraph.') && line.includes('Third line.')));
});

test('T2-F3-04: extractArxivId parses all URL, DOI, old-style, and bare variants while rejecting non-arXiv inputs', () => {
  assert.equal(extractArxivId('https://arxiv.org/abs/2309.06180v2'), '2309.06180');
  assert.equal(extractArxivId('https://arxiv.org/pdf/2309.06180.pdf'), '2309.06180');
  assert.equal(extractArxivId('https://arxiv.org/pdf/2309.06180v3.pdf'), '2309.06180');
  assert.equal(extractArxivId('https://arxiv.org/html/2309.06180v1'), '2309.06180');
  assert.equal(extractArxivId('https://export.arxiv.org/abs/2309.06180'), '2309.06180');
  assert.equal(extractArxivId(undefined, '10.48550/arXiv.2401.12345'), '2401.12345');
  assert.equal(extractArxivId('https://doi.org/10.48550/arXiv.2401.12345v2'), '2401.12345');
  assert.equal(extractArxivId('https://arxiv.org/abs/hep-th/9901001v1'), 'hep-th/9901001');
  assert.equal(extractArxivId('hep-th/9901001'), 'hep-th/9901001');
  assert.equal(extractArxivId('arXiv:2309.06180v4'), '2309.06180');

  assert.equal(extractArxivId('https://example.org/abs/2309.06180'), undefined);
  assert.equal(extractArxivId('https://arxiv.org/search/?query=pagedattention'), undefined);
  assert.equal(extractArxivId('https://dl.acm.org/doi/10.1145/3600006.3613165', '10.1145/3600006.3613165'), undefined);
  assert.equal(extractArxivId(undefined, undefined), undefined);
});

test('T2-F3-05: parseAuthors handles et al., semicolons, Last/First, nobiliary particles, and CJK lists cleanly', () => {
  assert.deepEqual(parseAuthors('Kwon et al.'), ['Kwon et al.']);
  assert.deepEqual(parseAuthors('Kwon, et al.'), ['Kwon et al.']);
  assert.deepEqual(parseAuthors('Smith, Alice; Doe, Bob'), ['Smith, Alice', 'Doe, Bob']);
  assert.deepEqual(parseAuthors('Alice Smith and Bob Jones'), ['Alice Smith', 'Bob Jones']);
  assert.deepEqual(parseAuthors('Smith, Alice and Doe, Bob'), ['Smith, Alice', 'Doe, Bob']);
  assert.deepEqual(parseAuthors('Alice Smith, Bob Jones, and Carol Lee'), ['Alice Smith', 'Bob Jones', 'Carol Lee']);
  assert.deepEqual(parseAuthors('Smith, Alice'), ['Smith, Alice']);
  assert.deepEqual(parseAuthors('Smith, Alice M.'), ['Smith, Alice M.']);
  assert.deepEqual(parseAuthors('Smith, Alice, Jr.'), ['Smith, Alice, Jr.']);
  assert.deepEqual(parseAuthors('van der Waals, Johannes Diderik'), ['van der Waals, Johannes Diderik']);
  assert.deepEqual(parseAuthors('Julie Dahlquist, Rainford Knight'), ['Julie Dahlquist', 'Rainford Knight']);
  assert.deepEqual(parseAuthors('张三、李四、王五'), ['张三', '李四', '王五']);
  assert.deepEqual(parseAuthors('   '), []);
  assert.deepEqual(parseAuthors(undefined), []);
});

test('T2-F3-06: buildCiteKey folds diacritics and extended Latin and hashes pure CJK deterministically to ASCII [a-z0-9]+', () => {
  const umlaut = buildCiteKey({
    title: 'Über die Effizienz von Großsprachmodellen',
    authors: ['Müller, Hans'],
    year: '2024'
  });
  assert.match(umlaut, /^[a-z0-9]+$/);
  assert.equal(umlaut, 'muller2024uber');

  const nordic = buildCiteKey({
    title: 'The Æther and Œuvre',
    authors: ['Østergaard, Søren'],
    year: '2022'
  });
  assert.match(nordic, /^[a-z0-9]+$/);
  assert.equal(nordic, 'ostergaard2022aether');

  const cjkOne: CitationMetadata = { id: 'doc-1', title: '大语言模型推理优化研究', authors: ['张三', '李四'], year: '2025' };
  const cjkTwo: CitationMetadata = { id: 'doc-2', title: '分布式缓存调度算法', authors: ['王五'], year: '2025' };
  const keyOneA = buildCiteKey(cjkOne);
  const keyOneB = buildCiteKey(cjkOne);
  const keyTwo = buildCiteKey(cjkTwo);
  assert.match(keyOneA, /^ref2025[a-f0-9]{8}$/);
  assert.equal(keyOneA, keyOneB);
  assert.notEqual(keyOneA, keyTwo);
});

test('extractYear respects priority order date > venue > createdAt and ignores non-year numbers', () => {
  assert.equal(extractYear('2024-05-12', 'SOSP 2023', '2026-01-01T00:00:00Z'), '2024');
  assert.equal(extractYear('', 'NeurIPS 2022', '2026-01-01T00:00:00Z'), '2022');
  assert.equal(extractYear(undefined, undefined, '2025-11-24T12:00:00Z'), '2025');
  assert.equal(extractYear('n.d.', 'vol. 12345', 'invalid'), undefined);
});

test('entry types map accurately across OpenStax book, journal, conference, web, and Zotero itemTypes', () => {
  const bookDoc: DocumentInfo = {
    id: 'book-' + 'b'.repeat(64),
    kind: 'web',
    title: 'Principles of Finance',
    authors: 'Julie Dahlquist, Rainford Knight',
    venue: 'OpenStax',
    url: 'https://openstax.org/books/principles-finance/pages/1-1-finance',
    book: { slug: 'principles-finance', sections: [] }
  };
  const bookMeta = buildCitationMetadata(bookDoc);
  assert.equal(bookMeta.kind, 'book');
  assert.equal(bookMeta.publisher, 'OpenStax');
  assert.equal(bookMeta.venue, undefined);
  assert.deepEqual(bookMeta.authors, ['Julie Dahlquist', 'Rainford Knight']);
  assert.ok(formatBibTeX(bookMeta).startsWith('@book{dahlquistprinciples,\n'));
  assert.ok(formatBibTeX(bookMeta).includes('  publisher = {OpenStax},'));
  assert.ok(formatRIS(bookMeta).startsWith('TY  - BOOK\n'));
  assert.ok(formatRIS(bookMeta).includes('PB  - OpenStax'));

  const journalMeta: CitationMetadata = { title: 'Attention Patterns', authors: ['Ada Lovelace'], venue: 'Nature Machine Intelligence', year: '2024', kind: 'web' };
  assert.ok(formatBibTeX(journalMeta).startsWith('@article{'));
  assert.ok(formatBibTeX(journalMeta).includes('  journal = {Nature Machine Intelligence},'));
  assert.ok(formatRIS(journalMeta).startsWith('TY  - JOUR\n'));
  assert.ok(formatRIS(journalMeta).includes('JO  - Nature Machine Intelligence'));

  const webMeta: CitationMetadata = { title: 'Technical Blog Post', url: 'https://research.example.org/post', kind: 'web' };
  assert.ok(formatBibTeX(webMeta).startsWith('@misc{'));
  assert.ok(formatRIS(webMeta).startsWith('TY  - ELEC\n'));

  const zoteroCases: [string, string, string][] = [
    ['journalArticle', '@article{', 'TY  - JOUR'],
    ['conferencePaper', '@inproceedings{', 'TY  - CONF'],
    ['book', '@book{', 'TY  - BOOK'],
    ['bookSection', '@incollection{', 'TY  - CHAP'],
    ['thesis', '@phdthesis{', 'TY  - THES'],
    ['report', '@techreport{', 'TY  - RPRT'],
    ['webpage', '@misc{', 'TY  - ELEC']
  ];
  for (const [zoteroType, bibPrefix, risPrefix] of zoteroCases) {
    const m: CitationMetadata = { title: 'Sample Work', zoteroType };
    assert.ok(formatBibTeX(m).startsWith(bibPrefix), zoteroType);
    assert.ok(formatRIS(m).startsWith(risPrefix), zoteroType);
  }
});

test('T1-F3-06 & T2-F3-08: Zotero merge enriches sparse PDFs and preserves local doi/url when Zotero fields are empty strings', () => {
  const sparse: DocumentInfo = {
    id: 'pdf-' + 'c'.repeat(64),
    kind: 'pdf',
    title: 'notes.pdf',
    createdAt: '2026-11-24T15:00:00.000Z'
  };
  const richZotero: ZoteroItem = {
    key: 'RICHZOT1',
    title: 'Analytical Engine Memory Tables',
    type: 'journalArticle',
    creator: 'Ada Lovelace and Charles Babbage',
    date: '2024-05-10',
    collections: ['COL1'],
    doi: 'https://doi.org/10.1000/zotero.2024.42',
    url: 'https://journal.example.org/analytical-engine'
  };
  const enriched = buildCitationMetadata(sparse, richZotero);
  assert.equal(enriched.title, 'Analytical Engine Memory Tables');
  assert.deepEqual(enriched.authors, ['Ada Lovelace', 'Charles Babbage']);
  assert.equal(enriched.year, '2024');
  assert.equal(enriched.doi, '10.1000/zotero.2024.42');
  assert.equal(enriched.url, 'https://journal.example.org/analytical-engine');
  assert.ok(formatBibTeX(enriched).startsWith('@article{lovelace2024analytical,\n'));
  assert.ok(formatRIS(enriched).startsWith('TY  - JOUR\n'));

  const localRich: DocumentInfo = {
    id: 'web-' + 'd'.repeat(64),
    kind: 'web',
    title: 'Local Paper',
    authors: 'Local Author',
    venue: 'SOSP 2023',
    year: '2023',
    doi: '10.1000/local.doi',
    url: 'https://arxiv.org/abs/2309.06180'
  };
  const partialZotero: ZoteroItem = {
    key: 'PARTZOT2',
    title: 'Refined Zotero Title',
    type: 'journalArticle',
    creator: '   ',
    date: '',
    collections: [],
    doi: '',
    url: '   '
  };
  const merged = buildCitationMetadata(localRich, partialZotero);
  assert.equal(merged.title, 'Refined Zotero Title');
  assert.deepEqual(merged.authors, ['Local Author']);
  assert.equal(merged.year, '2023');
  assert.equal(merged.doi, '10.1000/local.doi');
  assert.equal(merged.url, 'https://arxiv.org/abs/2309.06180');
  assert.equal(merged.arxivId, '2309.06180');
});

test('regression: capitalized nobiliary particles and institutional ampersands are preserved by parseAuthors', () => {
  assert.deepEqual(parseAuthors('Van der Waals, Johannes Diderik'), ['Van der Waals, Johannes Diderik']);
  assert.deepEqual(parseAuthors('De la Cruz, Maria Elena'), ['De la Cruz, Maria Elena']);
  assert.deepEqual(parseAuthors('Von Neumann, John Louis'), ['Von Neumann, John Louis']);
  assert.deepEqual(parseAuthors('AT&T Research'), ['AT&T Research']);
  assert.deepEqual(parseAuthors('Smith, Alice & Doe, Bob'), ['Smith, Alice', 'Doe, Bob']);
  assert.deepEqual(parseAuthors('Alice Smith, & Bob Jones'), ['Alice Smith', 'Bob Jones']);
});

test('regression: BibTeX and RIS neutralize trailing backslashes and Unicode line separators in URL/DOI/eprint and text', () => {
  const bib = formatBibTeX({
    title: 'Test\u2028Title\u2029Line\u0085End',
    url: 'https://example.org/path\\\u2028a\u2029b\u0085c',
    doi: '10.1000/foo\\}\\}\u2028x\u2029y\u0085z',
    arxivId: '2309.06180\\\u2028\u2029\u0085',
    year: '2025'
  });
  assertBalancedBraces(bib);
  assertLatexBalancedBraces(bib);
  assert.equal(/[\u0085\u2028\u2029]/.test(bib), false, bib);
  assert.ok(bib.includes('  title = {Test Title Line End},'), bib);
  assert.ok(bib.includes('  doi = {10.1000/fooxyz},'), bib);
  assert.ok(bib.includes('  url = {https://example.org/path%5Cabc},'), bib);
  assert.ok(bib.includes('  eprint = {2309.06180},'), bib);

  const ris = formatRIS({
    title: 'Before\u0085ER  - \u2028AU  - Fake\u2029End',
    url: 'https://example.org/a\u0085b\u2028c\u2029d'
  });
  assert.equal(/[\u0085\u2028\u2029]/.test(ris), false, ris);
  const lines = ris.split('\n');
  assert.deepEqual(lines, [
    'TY  - GEN',
    'TI  - Before ER - AU - Fake End',
    'UR  - https://example.org/a b c d',
    'ER  - '
  ]);
});

test('regression: extractArxivId rejects non-HTTP schemes and spoofed DOI domains while keeping valid variants', () => {
  assert.equal(extractArxivId('ftp://evil.com/10.48550/arXiv.2401.12345', undefined), undefined);
  assert.equal(extractArxivId(undefined, 'https://evil.com/10.48550/arXiv.2401.12345'), undefined);
  assert.equal(extractArxivId('https://evil.com/10.48550/arXiv.2401.12345', undefined), undefined);
  assert.equal(extractArxivId('https://doi.org/https://doi.org/10.48550/arXiv.2401.12345', undefined), undefined);

  assert.equal(extractArxivId('https://dx.doi.org/10.48550/arXiv.2401.12345'), '2401.12345');
  assert.equal(extractArxivId(undefined, 'https://doi.org/10.48550/arXiv.2401.12345'), '2401.12345');
  assert.equal(extractArxivId(undefined, 'https://dx.doi.org/10.48550/arXiv.2401.12345v2'), '2401.12345');
  assert.equal(extractArxivId(undefined, 'doi:10.48550/arXiv.2401.12345'), '2401.12345');
  assert.equal(extractArxivId('doi:10.48550/arXiv.2401.12345'), '2401.12345');
  assert.equal(extractArxivId('10.48550/arXiv.2401.12345'), '2401.12345');
});

test('regression: control-character-only title falls back to Untitled and empty optional fields are omitted', () => {
  const ctrlOnly: CitationMetadata = {
    title: '\x00\x07\x1b',
    authors: ['\x07', '\u2028'],
    venue: '\x07',
    publisher: '\u2029',
    abstract: '\u0085'
  };
  const bib = formatBibTeX(ctrlOnly);
  assertBalancedBraces(bib);
  assert.match(bib, /^@misc\{ref[a-f0-9]{8},\n  title = \{Untitled\}\n\}$/);

  const ris = formatRIS(ctrlOnly);
  assert.equal(ris, 'TY  - GEN\nTI  - Untitled\nER  - ');

  const mixedAuthorsBib = formatBibTeX({ title: 'Valid Title', authors: ['\x07', 'Alice Smith'] });
  assert.ok(mixedAuthorsBib.includes('  author = {Alice Smith}\n}'), mixedAuthorsBib);
});

test('regression: Object.prototype property names in zoteroType fall back safely to @misc and TY  - GEN', () => {
  const protoNames = ['constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'];
  for (const zoteroType of protoNames) {
    const meta: CitationMetadata = { title: 'Test Paper', authors: ['Alice Smith'], year: '2025', zoteroType };
    const bib = formatBibTeX(meta);
    assertBalancedBraces(bib);
    assertLatexBalancedBraces(bib);
    assert.match(bib, /^@[a-z]+\{[a-z0-9]+,\n/, `Unexpected BibTeX header for zoteroType=${zoteroType}:\n${bib}`);
    assert.ok(bib.startsWith('@misc{'), `Expected @misc fallback for zoteroType=${zoteroType}, got:\n${bib}`);

    const ris = formatRIS(meta);
    const firstLine = ris.split('\n')[0];
    assert.match(firstLine, /^TY  - [A-Z]{3,4}$/, `Unexpected RIS TY line for zoteroType=${zoteroType}: ${firstLine}`);
    assert.equal(firstLine, 'TY  - GEN', `Expected TY  - GEN fallback for zoteroType=${zoteroType}, got: ${firstLine}`);
  }

  // End-to-end buildCitationMetadata path with untrusted Zotero itemType
  const doc: DocumentInfo = { id: 'pdf-' + 'e'.repeat(64), kind: 'pdf', title: 'paper.pdf' };
  const maliciousZotero: ZoteroItem = {
    key: 'MALZOT1',
    title: 'Malicious Zotero Item',
    type: 'constructor',
    creator: 'Alice Smith',
    date: '2025',
    collections: []
  };
  const merged = buildCitationMetadata(doc, maliciousZotero);
  const mergedBib = formatBibTeX(merged);
  assertBalancedBraces(mergedBib);
  assert.match(mergedBib, /^@misc\{smith2025malicious,\n/);
  const mergedRis = formatRIS(merged);
  assert.equal(mergedRis.split('\n')[0], 'TY  - GEN');
});
