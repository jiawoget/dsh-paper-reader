import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DocumentInfo } from '../src/shared/types.js';
import { exportBulkRefs, parseBulkRefs, type BulkRefEntry } from '../src/shared/citation-bulk.js';
import { Library } from '../src/server/library.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { createServices } from '../src/server/services.js';

test('parseBulkRefs parses BibTeX with nested braces, quotes, LaTeX escapes, and multiple entries', () => {
  const bib = `@inproceedings{kwon2023paged,
    title = {{PagedAttention}: {LLM} Serving \\& Memory},
    author = "M{\\"u}ller, J{\\'e}r{\\^o}me and Kwon, Woosuk and others",
    booktitle = {Proceedings of {SOSP}}, year = {2023}, doi = {10.1145/3600006.3613165},
    url = {https://arxiv.org/abs/2309.06180}, abstract = {Virtual memory paging for {KV} cache.}
  }
  @comment{ignored entry}
  @article{wilding2021semaglutide,
    title = "Once-Weekly Semaglutide", author = {Wilding, John and Batterham, Rachel},
    journal = {NEJM}, year = 2021, doi = "10.1056/NEJMoa2032183", abstract = "Body weight reduction."
  }`;
  const parsed: BulkRefEntry[] = parseBulkRefs(bib);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'PagedAttention: LLM Serving & Memory');
  assert.equal(parsed[0].authors, 'Müller, Jérôme; Kwon, Woosuk');
  assert.equal(parsed[0].venue, 'Proceedings of SOSP');
  assert.equal(parsed[0].year, '2023');
  assert.equal(parsed[0].doi, '10.1145/3600006.3613165');
  assert.equal(parsed[0].url, 'https://arxiv.org/abs/2309.06180');
  assert.equal(parsed[0].abstract, 'Virtual memory paging for KV cache.');
  assert.equal(parsed[1].venue, 'NEJM');
  assert.equal(parsed[1].year, '2021');
});

test('parseBulkRefs parses multi-record RIS and RFC 4180 CSV with quotes, commas, and newlines', () => {
  const ris = [
    'TY  - JOUR', 'TI  - Semaglutide Clinical Trial', 'AU  - Wilding, John', 'A1  - Batterham, Rachel',
    'PY  - 2021/03/18', 'JF  - NEJM', 'DO  - 10.1056/NEJMoa2032183', 'UR  - https://www.nejm.org/doi/10.1056/NEJMoa2032183',
    'AB  - First line of abstract', 'second line continued', 'ER  - ',
    'TY  - CONF', 'T1  - FlashAttention', 'AU  - Dao, Tri', 'Y1  - 2022', 'T2  - NeurIPS', 'N2  - IO-aware attention.', 'ER  - '
  ].join('\n');
  const risParsed = parseBulkRefs(ris);
  assert.equal(risParsed.length, 2);
  assert.equal(risParsed[0].authors, 'Wilding, John; Batterham, Rachel');
  assert.equal(risParsed[0].year, '2021');
  assert.match(risParsed[0].abstract ?? '', /First line of abstract second line continued/);
  assert.equal(risParsed[1].title, 'FlashAttention');
  assert.equal(risParsed[1].venue, 'NeurIPS');

  const csv = [
    'Title,Authors,Year,Venue,DOI,URL,Abstract,Tags',
    '"Attention, ""All"" You Need","Vaswani; Shazeer",2017,"NeurIPS, 2017",10.48550/arXiv.1706.03762,https://arxiv.org/abs/1706.03762,"Line 1\nLine 2","transformers; foundational"'
  ].join('\n');
  const csvParsed = parseBulkRefs(csv, 'csv');
  assert.equal(csvParsed.length, 1);
  assert.equal(csvParsed[0].title, 'Attention, "All" You Need');
  assert.equal(csvParsed[0].venue, 'NeurIPS, 2017');
  assert.equal(csvParsed[0].abstract, 'Line 1\nLine 2');
  assert.deepEqual(csvParsed[0].tags, ['transformers', 'foundational']);
});

test('exportBulkRefs round-trips BibTeX/RIS/CSV and neutralizes CSV formula injection', () => {
  const docs: DocumentInfo[] = [
    {
      id: 'abs-1', kind: 'abstract', title: 'PagedAttention', paperTitle: 'PagedAttention',
      authors: 'Kwon, Woosuk; Li, Zhuohan', year: '2023', venue: 'SOSP', doi: '10.1145/3600006.3613165',
      url: 'https://arxiv.org/abs/2309.06180', abstract: 'Efficient KV cache.',
      meta: { status: 'reading', starred: true, tags: ['llm', 'serving'] }
    },
    {
      id: 'abs-2', kind: 'abstract', title: '=CMD() Injection', authors: '+Alice', venue: '-Conf',
      abstract: '@SUM(A1:A2)', meta: { status: 'unread', starred: false, tags: ['\tformula', '\rlead'] }
    }
  ];
  const bibRt = parseBulkRefs(exportBulkRefs([docs[0]], 'bibtex'), 'bibtex');
  assert.equal(bibRt[0].title, 'PagedAttention');
  assert.equal(bibRt[0].doi, '10.1145/3600006.3613165');
  assert.equal(bibRt[0].abstract, 'Efficient KV cache.');
  const risRt = parseBulkRefs(exportBulkRefs([docs[0]], 'ris'), 'ris');
  assert.equal(risRt[0].venue, 'SOSP');
  assert.equal(risRt[0].doi, '10.1145/3600006.3613165');

  const csvOut = exportBulkRefs(docs, 'csv');
  assert.ok(csvOut.includes("'=CMD() Injection,'+Alice,,'-Conf,,,'@SUM(A1:A2),"));
  const csvRt = parseBulkRefs(csvOut, 'csv');
  assert.deepEqual(csvRt[0].tags, ['llm', 'serving']);
  assert.equal(csvRt[1].title, "'=CMD() Injection");
});

test('library.importRefs and library.exportRefs deduplicate, tag, index FTS5, and export', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-bulk-refs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root);
  const library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root, library, store });
  const bib = `@article{a1, title={Clinical GLP-1 Outcomes}, author={Smith, A.}, journal={NEJM}, year={2024}, doi={10.1056/test1}, abstract={Weight loss trial with semaglutide.}}
@article{a2, title={Sparse Attention Scaling}, author={Lee, B.}, booktitle={ICML}, year={2025}, doi={10.1145/test2}, abstract={Subquadratic attention kernel.}}`;
  const first = await act('library.importRefs', { text: bib, tag: 'survey-2025' });
  assert.equal(first.created, 2);
  assert.equal(first.existing, 0);
  assert.equal(first.skipped, 0);
  assert.ok(first.docs.every(d => d.kind === 'abstract' && d.meta?.tags.includes('survey-2025')));
  const second = await act('library.importRefs', { text: bib, tag: 'batch-2' });
  assert.equal(second.created, 0);
  assert.equal(second.existing, 2);
  assert.deepEqual(second.docs[0].meta?.tags, ['survey-2025', 'batch-2']);

  const ftsHits = (await act('pages.search', { query: 'semaglutide' })).hits;
  assert.ok(ftsHits.some(h => h.docId === first.docs[0].id && h.docKind === 'abstract'));
  const expCsv = await act('library.exportRefs', { docIds: [first.docs[0].id], format: 'csv' });
  assert.equal(expCsv.count, 1);
  assert.equal(expCsv.filename, 'paper-reader-library.csv');
  assert.match(expCsv.content, /Weight loss trial with semaglutide/);
  assert.match(expCsv.content, /survey-2025; batch-2/);
  const expBib = await act('library.exportRefs', { format: 'bibtex' });
  assert.equal(expBib.count, 3);
  assert.match(expBib.content, /10\.1056\/test1/);
});
