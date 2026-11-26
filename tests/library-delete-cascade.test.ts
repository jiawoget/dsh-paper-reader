import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Library } from '../src/server/library.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { createServices } from '../src/server/services.js';

function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return Number(row.n);
}

test('library.delete cascades all 10 document-scoped SQLite tables and disk files while isolating other documents and global state', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-delete-cascade-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new ReaderStore(root);
  const library = new Library(root, undefined, id => store.deleteDocument(id));

  // Import Doc A (to delete) and Doc B (control)
  const docA = await library.importPdf('Alpha.pdf', Buffer.from('%PDF-1.7\nalpha document payload'), 'https://example.org/alpha.pdf');
  const docB = await library.importPdf('Beta.pdf', Buffer.from('%PDF-1.7\nbeta document payload'), 'https://example.org/beta.pdf');

  // Create OpenStax Book C on disk with 2 chapters + book-sections + article-images + translations
  const bookC = 'book-' + 'c'.repeat(64);
  const docsDir = path.join(root, 'documents');
  await mkdir(path.join(docsDir, 'book-sections', bookC), { recursive: true });
  await writeFile(path.join(docsDir, bookC + '.json'), JSON.stringify({
    id: bookC,
    title: 'Sample OpenStax Book',
    kind: 'web',
    url: 'https://openstax.org/books/sample/pages/1-1-intro',
    book: {
      slug: 'sample',
      sections: [
        { slug: '1-1-intro', title: '1.1 Intro', chapterId: 'ch-1', chapterTitle: 'Chapter 1', url: 'https://openstax.org/books/sample/pages/1-1-intro' },
        { slug: '2-1-next', title: '2.1 Next', chapterId: 'ch-2', chapterTitle: 'Chapter 2', url: 'https://openstax.org/books/sample/pages/2-1-next' }
      ]
    }
  }));
  await writeFile(path.join(docsDir, 'book-sections', bookC, 'sec1.json'), JSON.stringify({ paragraphs: ['Chapter 1 body'] }));
  await mkdir(path.join(root, 'article-images', bookC, '1'), { recursive: true });
  await writeFile(path.join(root, 'article-images', bookC, '1', 'fig.png'), Buffer.from([137, 80, 78, 71]));
  await mkdir(path.join(root, 'translations', docA.id, 'ja'), { recursive: true });
  await writeFile(path.join(root, 'translations', docA.id, '1.json'), JSON.stringify({ p1: '中文译文' }));
  await writeFile(path.join(root, 'translations', docA.id, 'ja', '1.json'), JSON.stringify({ p1: '日本語訳' }));
  await mkdir(path.join(root, 'translations', docB.id, 'ja'), { recursive: true });
  await writeFile(path.join(root, 'translations', docB.id, '1.json'), JSON.stringify({ p1: '保留中文' }));
  await writeFile(path.join(root, 'translations', docB.id, 'ja', '1.json'), JSON.stringify({ p1: '保留日本語' }));
  await mkdir(path.join(root, 'translations', bookC), { recursive: true });
  await writeFile(path.join(root, 'translations', bookC, '1.json'), JSON.stringify({ p1: '书籍译文' }));

  // Ensure SQLite schema is initialized
  store.configure({ targetLanguage: 'Japanese' });
  store.zoteroAuthorization('srv-1', 'secret-key');

  const now = new Date().toISOString();
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'));
  t.after(() => db.close());

  const populateDoc = (id: string, chapterKeys: string[] = []) => {
    const baseUrl = `http://127.0.0.1:29812/api/paper-reader/app/index.html?doc=${id}&page=1`;
    db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`note-${id}`, 'note', `id-note-${id}`, id, 'Title', 1, 'p1', baseUrl, 'A note', 'Page 1', 'quote', '', '', now, now);
    db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`word-${id}`, 'word', `id-word-${id}`, id, 'Title', 1, 'p1', baseUrl, 'term', 'Page 1', '', 'meaning', 'ctx', now, now);
    db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`hist-${id}`, 'history', `id-hist-${id}`, id, 'Title', 1, 'p1', baseUrl, 'lookup', 'Page 1', '', 'meaning', 'ctx', now, now);

    // Active annotation + soft-deleted tombstone (content IS NULL)
    db.prepare('INSERT INTO annotations VALUES(?,?,?,?,?)')
      .run(`ann-live-${id}`, id, JSON.stringify({ kind: 'highlight', color: 'yellow', page: 1 }), now, now);
    db.prepare('INSERT INTO annotations VALUES(?,?,?,?,?)')
      .run(`ann-dead-${id}`, id, null, now, now);

    db.prepare('INSERT INTO chat_exchanges VALUES(?,?,?,?)')
      .run(`chat-paper-${id}`, id, 'paper', JSON.stringify({ question: 'Q?', answer: 'A.' }));
    db.prepare('INSERT INTO chat_exchanges VALUES(?,?,?,?)')
      .run(`chat-sel-${id}`, id, 'selection-' + '1'.repeat(64), JSON.stringify({ question: 'Sel?', answer: 'Ans.' }));

    for (const key of [id, ...chapterKeys.map(ch => id + '\u001f' + ch)]) {
      db.prepare('INSERT INTO notebook_documents VALUES(?,?,?,?)').run(key, 'Title', baseUrl, '# Notes');
      db.prepare('INSERT INTO notebook_vaults VALUES(?,?,?,?)').run('/tmp/vault', key, key + '.md', '# Notes');
      db.prepare('INSERT INTO notebooks VALUES(?,?,?)').run('/tmp/vault', key, key + '.md');
    }

    db.prepare('INSERT INTO book_positions VALUES(?,?,?)')
      .run(id, Date.now(), JSON.stringify({ page: 1, anchor: 'p-1', fraction: 0.2, side: 'source', updated: 1 }));
    db.prepare('INSERT INTO pdf_outlines VALUES(?,?)')
      .run(id, JSON.stringify([{ title: 'Intro', page: 1, level: 1 }]));
    db.prepare('INSERT INTO article_captures VALUES(?,?,?,?,?,?)')
      .run(id, 1, 'region-1', new Uint8Array([137, 80, 78, 71]), 'region text', 'Figure 1');
    db.prepare('INSERT INTO citations VALUES(?,?,?)')
      .run('/users/1', 'document/' + id, 'ITEM' + id.slice(4, 8).toUpperCase());
    db.prepare('INSERT INTO doc_meta VALUES(?,?,?,?,?,?,?,?)')
      .run(id, 'reading', 1, '["ml"]', Date.now(), 2, 10, 0.4);
  };

  populateDoc(docA.id);
  populateDoc(docB.id);
  populateDoc(bookC, ['ch-1', 'ch-2']);
  // Also populate a row for pagedattention + global Zotero dedup citation + zotero_sources
  populateDoc('pagedattention');
  db.prepare('INSERT INTO citations VALUES(?,?,?)').run('/users/1', 'doi/10.1234/shared', 'SHARED01');
  db.prepare('INSERT INTO zotero_sources VALUES(?,?,?,?)').run('/users/1', 'SHARED01', 'https://example.org/shared', 'https://zotero.org/shared');

  // Delete Doc A and Book C
  assert.deepEqual(await library.delete(docA.id), { id: docA.id, deleted: true });
  assert.deepEqual(await library.delete(bookC), { id: bookC, deleted: true });

  // Verify 0 remaining rows across all 10 tables for Doc A and Book C (including \u001f chapters & tombstones)
  for (const deletedId of [docA.id, bookC]) {
    const prefix = deletedId + '\u001f';
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', deletedId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', deletedId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM chat_exchanges WHERE docId=?', deletedId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=? OR substr(docId,1,?)=?', deletedId, prefix.length, prefix), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_vaults WHERE docId=? OR substr(docId,1,?)=?', deletedId, prefix.length, prefix), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebooks WHERE docId=? OR substr(docId,1,?)=?', deletedId, prefix.length, prefix), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM book_positions WHERE docId=?', deletedId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM pdf_outlines WHERE docId=?', deletedId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM article_captures WHERE docId=?', deletedId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM citations WHERE identity=?', 'document/' + deletedId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM doc_meta WHERE docId=?', deletedId), 0);
  }

  // Verify disk files removed for Doc A & Book C
  assert.equal(existsSync(path.join(docsDir, docA.id + '.json')), false);
  assert.equal(existsSync(path.join(docsDir, docA.id + '.pdf')), false);
  assert.equal(existsSync(path.join(docsDir, docA.id + '.source-url')), false);
  assert.equal(existsSync(path.join(root, 'translations', docA.id)), false);
  assert.equal(existsSync(path.join(docsDir, bookC + '.json')), false);
  assert.equal(existsSync(path.join(docsDir, 'book-sections', bookC)), false);
  assert.equal(existsSync(path.join(root, 'article-images', bookC)), false);
  assert.equal(existsSync(path.join(root, 'translations', bookC)), false);

  // Verify Doc B retains 100% of its rows & disk files
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', docB.id), 3);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', docB.id), 2);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM chat_exchanges WHERE docId=?', docB.id), 2);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=?', docB.id), 1);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_vaults WHERE docId=?', docB.id), 1);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebooks WHERE docId=?', docB.id), 1);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM book_positions WHERE docId=?', docB.id), 1);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM pdf_outlines WHERE docId=?', docB.id), 1);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM article_captures WHERE docId=?', docB.id), 1);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM citations WHERE identity=?', 'document/' + docB.id), 1);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM doc_meta WHERE docId=?', docB.id), 1);
  assert.equal(existsSync(path.join(docsDir, docB.id + '.pdf')), true);
  assert.equal(existsSync(path.join(root, 'translations', docB.id, 'ja', '1.json')), true);

  // Verify global tables, pagedattention, and non-document citations are untouched
  assert.equal(store.settings().targetLanguage, 'Japanese');
  assert.equal(store.zoteroAuthorization('srv-1'), 'secret-key');
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM citations WHERE identity=?', 'doi/10.1234/shared'), 1);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM zotero_sources WHERE itemKey=?', 'SHARED01'), 1);

  // Direct store.deleteDocument('pagedattention') must be a safe no-op
  store.deleteDocument('pagedattention');
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM entries WHERE docId=?', 'pagedattention'), 3);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM annotations WHERE docId=?', 'pagedattention'), 2);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM doc_meta WHERE docId=?', 'pagedattention'), 1);
});

test('library.delete enforces boundary status codes (400 sample, 404 traversal/malformed, 200 nonexistent)', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-delete-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new ReaderStore(root);
  const library = new Library(root, undefined, id => store.deleteDocument(id));

  await assert.rejects(
    library.delete('pagedattention'),
    (error: unknown) => error instanceof Error && 'status' in error && (error as { status: number }).status === 400
  );
  for (const invalid of ['../etc/passwd', 'pdf-123', '', 42, null]) {
    await assert.rejects(
      library.delete(invalid),
      (error: unknown) => error instanceof Error && 'status' in error && (error as { status: number }).status === 404
    );
  }
  const missingId = 'pdf-' + 'a'.repeat(64);
  assert.deepEqual(await library.delete(missingId), { id: missingId, deleted: false });
});

test('book.progress.save, notebook.get, and notebook.write reject deleted stored library documents with 404 and zero resurrection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-delete-resurrect-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new ReaderStore(root);
  const library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root });

  const pdfDoc = await library.importPdf('Resurrect-Guard.pdf', Buffer.from('%PDF-1.7\nguard payload'));
  const pdfUrl = `http://127.0.0.1:29812/api/paper-reader/app/index.html?doc=${pdfDoc.id}&page=1`;
  const pdfNb = await act('notebook.get', { docId: pdfDoc.id, title: pdfDoc.title, page: 1, sourceUrl: pdfUrl });
  await act('notebook.write', { docId: pdfDoc.id, title: pdfDoc.title, page: 1, sourceUrl: pdfUrl, expectedRevision: pdfNb.revision, markdown: '# Initial PDF' });

  const bookId = 'book-' + 'd'.repeat(64);
  await mkdir(path.join(root, 'documents'), { recursive: true });
  await writeFile(path.join(root, 'documents', bookId + '.json'), JSON.stringify({
    id: bookId,
    title: 'Resurrect Guard Book',
    kind: 'web',
    url: 'https://openstax.org/books/guard/pages/1-1-intro',
    book: {
      slug: 'guard',
      sections: [
        { slug: '1-1-intro', title: '1.1 Intro', chapterId: 'ch-1', chapterTitle: 'Chapter 1', url: 'https://openstax.org/books/guard/pages/1-1-intro' }
      ]
    }
  }));
  const bookUrl = `http://127.0.0.1:29812/api/paper-reader/app/index.html?doc=${bookId}&page=1`;
  const bookNb = await act('notebook.get', { docId: bookId, title: 'Resurrect Guard Book', page: 1, sourceUrl: bookUrl });
  await act('notebook.write', { docId: bookId, title: 'Resurrect Guard Book', page: 1, sourceUrl: bookUrl, expectedRevision: bookNb.revision, markdown: '# Initial Book' });
  await act('book.progress.save', { docId: bookId, place: { page: 1, anchor: 'p-1', fraction: 0.25, side: 'source', updated: 100 } });
  await act('library.progress.save', { docId: pdfDoc.id, lastPage: 2, pageCount: 5, scrollFraction: 0.3 });
  await act('library.triage', { docId: pdfDoc.id, starred: true, tags: ['guard'] });

  assert.deepEqual(await library.delete(pdfDoc.id), { id: pdfDoc.id, deleted: true });
  assert.deepEqual(await library.delete(bookId), { id: bookId, deleted: true });

  await assert.rejects(act('library.progress.save', { docId: pdfDoc.id, lastPage: 1 }), { status: 404 });
  await assert.rejects(act('library.triage', { docId: pdfDoc.id, starred: false }), { status: 404 });

  await assert.rejects(
    act('book.progress.save', { docId: bookId, place: { page: 1, anchor: 'p-2', fraction: 0.5, side: 'source', updated: 200 } }),
    (error: unknown) => error instanceof Error && 'status' in error && (error as { status: number }).status === 404
  );
  for (const [docId, title, sourceUrl, expectedRevision] of [
    [pdfDoc.id, pdfDoc.title, pdfUrl, pdfNb.revision],
    [bookId, 'Resurrect Guard Book', bookUrl, bookNb.revision]
  ] as const) {
    await assert.rejects(
      act('notebook.get', { docId, title, page: 1, sourceUrl }),
      (error: unknown) => error instanceof Error && 'status' in error && (error as { status: number }).status === 404
    );
    await assert.rejects(
      act('notebook.write', { docId, title, page: 1, sourceUrl, expectedRevision, markdown: '# Resurrected' }),
      (error: unknown) => error instanceof Error && 'status' in error && (error as { status: number }).status === 404
    );
  }

  const db = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const bookPrefix = bookId + '\u001f';
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM book_positions WHERE docId=?', bookId), 0);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=?', pdfDoc.id), 0);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM notebook_documents WHERE docId=? OR substr(docId,1,?)=?', bookId, bookPrefix.length, bookPrefix), 0);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM doc_meta WHERE docId=?', pdfDoc.id), 0);
});

test('concurrent library.delete vs library.progress.save and library.triage never resurrects doc_meta', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-delete-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const act = createServices({ root });
  const ids: string[] = [];
  for (let i = 0; i < 15; i++) {
    const { doc } = await act('web.import', { url: `https://example.org/race-${i}`, title: `Race ${i}`, paragraphs: [`Paragraph ${i}`] });
    await act('library.progress.save', { docId: doc.id, lastPage: 1, scrollFraction: 0.25 });
    ids.push(doc.id);
    await Promise.allSettled([
      act('library.delete', { id: doc.id }),
      act('library.progress.save', { docId: doc.id, lastPage: 1, scrollFraction: 0.85 }),
      act('library.triage', { docId: doc.id, starred: true, status: 'done', tags: ['race'] })
    ]);
  }
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true });
  t.after(() => db.close());
  for (const id of ids) assert.equal(countRows(db, 'SELECT COUNT(*) AS n FROM doc_meta WHERE docId=?', id), 0);
});
