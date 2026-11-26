import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractPdfPages } from '../src/server/pdf-text.js';
import { ensureResearchSchema, getDocPages, replaceDocPages, searchDocPagesFts } from '../src/server/research-store.js';

const pages = await extractPdfPages(await readFile(path.resolve('public/assets/pagedattention.pdf')));
assert.equal(pages.length, 16, `expected 16 pages, got ${pages.length}`);

const db = new DatabaseSync(':memory:');
try {
  ensureResearchSchema(db);
  replaceDocPages(db, 'pagedattention', pages);
  assert.equal(getDocPages(db, 'pagedattention').length, 16);
  const blockHits = searchDocPagesFts(db, '"block table"');
  assert.ok(blockHits.some(h => h.docId === 'pagedattention' && h.page === 6), 'missing "block table" hit on page 6');
  const kvHits = searchDocPagesFts(db, 'KV cache');
  assert.ok(kvHits.some(h => h.docId === 'pagedattention' && h.page === 1), 'missing "KV cache" hit on page 1');
  console.log(`PASS PR-1 ground-truth: pagedattention.pdf (${pages.length} pages) | "block table" -> p.${blockHits[0].page} (${blockHits.length} hits) | "KV cache" -> p.${kvHits[0].page} (${kvHits.length} hits)`);
} finally {
  db.close();
}
