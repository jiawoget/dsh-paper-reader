import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LibraryChatPreset } from '../src/shared/research-types.js';
import { apply } from '../src/server/index.js';
import { Library } from '../src/server/library.js';
import { MAX_LIBRARY_CHAT_DOCS, resolveLibraryCitations } from '../src/server/library-chat.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { getDocPages, listPaperCards, replaceDocPages } from '../src/server/research-store.js';
import { createServices } from '../src/server/services.js';

const samplePdfPath = path.resolve('public/assets/pagedattention.pdf');
const hasStatus = (status: number) => (err: unknown) => err instanceof Error && 'status' in err && (err as { status: number }).status === status;
const makeLlmCtx = (handler: (sys: string, payload: Record<string, unknown>, signal?: AbortSignal) => AsyncIterable<{ type: string; text?: string; reason?: { kind: string } }>) => ({
  llm: {
    listProviders: () => [{ id: 'test-provider' }],
    listModels: async () => [{ id: 'test-model', name: 'Test Model', inputModalities: ['text'] }],
    stream: (req: { system: string; messages: { content: { text?: string }[] }[]; signal: AbortSignal }) =>
      handler(req.system, JSON.parse(req.messages[0]?.content[0]?.text || '{}') as Record<string, unknown>, req.signal)
  }
});

test('paper_cards caches hits, invalidates on Attach PDF upgrade, falls back on bad JSON, and cascades atomically on delete', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-paper-cards-')); t.after(() => rm(root, { recursive: true, force: true }));
  let llmCalls = 0, returnBadJson = false;
  const ctx = makeLlmCtx(async function* (_sys, payload) {
    llmCalls++;
    yield { type: 'text-delta', text: returnBadJson ? 'not json' : JSON.stringify({ problem: `P:${String(payload.title)}`, method: `M:${String(payload.sourceKind)}`, findings: 'F', limitations: payload.sourceKind === 'abstract' ? 'None (Abstract only).' : 'Overhead.', futureWork: 'Quantize.' }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root, ctx, library, store });
  const stub = await act('library.createAbstract', { title: 'Paywalled Semaglutide Trial', authors: 'Wilding et al.', year: '2021', doi: '10.1056/NEJMoa2032183', abstract: 'Semaglutide reduced body weight by 14.9% in adults with obesity. Gastrointestinal events were transient.' });
  const first = await act('library.cards', { docIds: ['pagedattention', stub.doc.id] });
  assert.equal(first.generatedCount, 2); assert.equal(llmCalls, 2);
  const stubCard = first.cards.find(c => c.docId === stub.doc.id)!;
  assert.equal(stubCard.sourceKind, 'abstract');
  assert.equal(store.withDb(false, db => listPaperCards(db, [stub.doc.id])[0])?.sourceHash, stubCard.sourceHash);
  assert.equal(store.withDb(false, db => listPaperCards(db)).length, 2);
  assert.equal((await act('library.cards', { docIds: ['pagedattention', stub.doc.id] })).generatedCount, 0); assert.equal(llmCalls, 2);
  const attached = await library.attachPdf(stub.doc.id, await readFile(samplePdfPath));
  store.withDb(true, db => replaceDocPages(db, attached.doc.id, attached.pages));
  returnBadJson = true;
  const upgraded = await act('library.cards', { docIds: [stub.doc.id] });
  assert.equal(upgraded.generatedCount, 1); assert.equal(llmCalls, 3); assert.equal(upgraded.cards[0].sourceKind, 'pdf');
  assert.notEqual(upgraded.cards[0].sourceHash, stubCard.sourceHash); assert.ok(upgraded.cards[0].problem.length > 10);
  await act('library.delete', { id: stub.doc.id });
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true }); t.after(() => db.close());
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM paper_cards WHERE doc_id=?').get(stub.doc.id) as { n: number }).n), 0);
  assert.equal(store.withDb(false, d => listPaperCards(d)).length, 1);
});

test('library.chat enforces 30-doc cap, tags Abstract only docs, resolves verified quotes, rejects fabricated pages, and validates inputs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-library-chat-')); t.after(() => rm(root, { recursive: true, force: true }));
  let lastChatPayload: Record<string, unknown> | undefined;
  const ctx = makeLlmCtx(async function* (sys, payload) {
    if (sys.includes('structured research paper card')) {
      yield { type: 'text-delta', text: JSON.stringify({ problem: 'P', method: 'M', findings: 'F', limitations: 'L', futureWork: 'FW' }) };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    lastChatPayload = payload;
    yield { type: 'text-delta', text: 'PagedAttention manages KV cache via block table (Kwon et al., 2023, p. 6; Kwon et al., 2023, p. 99). Semaglutide achieved 14.9% loss (Wilding et al., 2021, Abstract; Wilding et al., 2021, p. 2) (Abstract only). Out of scope (Ghost et al., 2020, p. 1).' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root, ctx, library, store });
  await act('pages.index', { docId: 'pagedattention', force: true });
  const stub = await act('library.createAbstract', { title: 'Semaglutide Trial', authors: 'Wilding et al.', year: '2021', doi: '10.1056/NEJMoa2032183', abstract: 'Once-weekly semaglutide reduced body weight by 14.9% in adults with obesity.' });
  const extraIds: string[] = [];
  for (let i = 0; i < 33; i++) extraIds.push((await act('library.createAbstract', { title: `Paper ${i}`, authors: `Author${i} et al.`, year: '2024', doi: `10.1000/test.${i}`, abstract: `Abstract body ${i}.` })).doc.id);
  const res = await act('library.chat', {
    docIds: ['pagedattention', stub.doc.id, ...extraIds], question: 'How does the block table work in KV cache management?',
    history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]
  });
  assert.equal(res.truncatedCount, 5); assert.equal(res.usedDocIds.length, MAX_LIBRARY_CHAT_DOCS); assert.equal(res.usedAbstractOnlyIds.length, MAX_LIBRARY_CHAT_DOCS - 1);
  const papers = (lastChatPayload?.papers ?? []) as Array<{ docId: string; citeFormat: string; abstractOnly: boolean; excerpts: Array<{ page?: number; locator?: string }> }>;
  assert.ok(papers.find(p => p.docId === 'pagedattention')!.excerpts.some(e => e.page === 6));
  const stubEntry = papers.find(p => p.docId === stub.doc.id)!;
  assert.equal(stubEntry.abstractOnly, true); assert.equal(stubEntry.citeFormat, '(Wilding et al., 2021, Abstract)');
  assert.match(stubEntry.excerpts[0]?.locator ?? '', /Abstract only/); assert.equal((lastChatPayload?.history as unknown[]).length, 2);
  assert.equal(res.citations.length, 2);
  const pdfCite = res.citations.find(c => c.docId === 'pagedattention')!, absCite = res.citations.find(c => c.docId === stub.doc.id)!;
  const page6Text = store.withDb(false, db => getDocPages(db, 'pagedattention')).find(p => p.page === 6)!.text.replace(/\s+/g, ' ').trim();
  assert.equal(pdfCite.page, 6); assert.ok(page6Text.includes(pdfCite.quote));
  assert.equal(absCite.kind, 'abstract'); assert.equal(absCite.page, undefined); assert.ok(absCite.quote.includes('14.9%'));
  for (const preset of ['compare_methods', 'innovation_gaps', 'limitations_open_problems', 'cross_paper_disagreements'] as LibraryChatPreset[]) {
    assert.ok((await act('library.chat', { docIds: ['pagedattention'], preset })).answer.length > 0);
  }
  assert.deepEqual(resolveLibraryCitations('(Kwon et al., 2023, p. 0; Kwon et al., 2023, p. 17; Kwon et al., 2023, p. 1)', [
    { doc: await library.get('pagedattention'), pages: store.withDb(false, db => getDocPages(db, 'pagedattention')) }
  ]).map(c => c.page), [1]);
  const u1 = await act('library.createAbstract', { title: 'Undated A', authors: 'Jones et al.', abstract: 'Alpha findings.' });
  const u2 = await act('library.createAbstract', { title: 'Undated B', authors: 'Jones et al.', abstract: 'Beta findings.' });
  assert.deepEqual(resolveLibraryCitations('(Jones et al., n.d., Abstract)', [{ doc: u1.doc, pages: [] }, { doc: u2.doc, pages: [] }]), []);
  assert.deepEqual(resolveLibraryCitations('(Jones et al., n.d., Abstract; Jones et al., n.d.-b, Abstract)', [{ doc: u1.doc, pages: [], year: 'n.d.-a' }, { doc: u2.doc, pages: [], year: 'n.d.-b' }]).map(c => c.docId), [u2.doc.id]);
  await act('library.chat', { docIds: [u1.doc.id, u2.doc.id], question: 'Compare undated?' });
  assert.deepEqual(((lastChatPayload?.papers ?? []) as Array<{ citeFormat: string }>).map(p => p.citeFormat), ['(Jones et al., n.d.-a, Abstract)', '(Jones et al., n.d.-b, Abstract)']);
  for (const bad of [{ docIds: [], question: 'Q' }, { docIds: ['pdf-' + '0'.repeat(64)], question: 'Q' }, { docIds: ['pagedattention'] }, { docIds: ['pagedattention'], preset: 'bogus' }, { docIds: ['pagedattention'], question: 'Q', history: 'bad' }]) {
    await assert.rejects(act('library.chat', bad), hasStatus(400));
  }
  await assert.rejects(act('library.cards', { docIds: ['pagedattention'], refresh: 'yes' }), hasStatus(400));
});

test('HTTP NDJSON streaming delivers incremental deltas and AbortSignal preserves partial output mid-stream', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-library-stream-')), prevHome = process.env.PAPER_READER_HOME;
  process.env.PAPER_READER_HOME = root;
  t.after(async () => { if (prevHome === undefined) delete process.env.PAPER_READER_HOME; else process.env.PAPER_READER_HOME = prevHome; await rm(root, { recursive: true, force: true }); });
  const ctx = makeLlmCtx(async function* (sys, payload, signal) {
    if (sys.includes('structured research paper card')) {
      yield { type: 'text-delta', text: JSON.stringify({ problem: 'P', method: 'M', findings: 'F', limitations: 'L', futureWork: 'FW' }) };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    yield { type: 'text-delta', text: 'First synthesis part ' };
    if (payload.question === 'abort-midstream') {
      if (signal?.aborted) throw new Error('aborted');
      await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    yield { type: 'text-delta', text: '(Kwon et al., 2023, p. 1).' }; yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const routes = new Map<string, (req: Request) => Promise<Response>>();
  apply({ connection: { fetch: { register: r => routes.set(r.path, r.fetch) } }, inject: (svcs, setup) => { if (svcs[0] === 'llm') setup({ llm: ctx.llm } as never); return () => {}; } });
  const res = await routes.get('/api/paper-reader/action')!(new Request('http://dsh.internal/api/paper-reader/action', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ op: 'library.chat', payload: { docIds: ['pagedattention'], question: 'Summarize PagedAttention.' } })
  }));
  assert.equal(res.status, 200);
  const frames = (await res.text()).trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  const final = frames.at(-1) as { answer: string; citations: Array<{ page?: number }>; usedDocIds: string[] };
  assert.deepEqual(frames.filter(f => typeof f.delta === 'string').map(f => String(f.delta)), ['First synthesis part ', '(Kwon et al., 2023, p. 1).']);
  assert.equal(final.answer, 'First synthesis part (Kwon et al., 2023, p. 1).');
  assert.equal(final.citations[0]?.page, 1); assert.deepEqual(final.usedDocIds, ['pagedattention']);
  const ac = new AbortController(), partial: string[] = [], svc = createServices({ root, ctx });
  await assert.rejects(svc('library.chat', { docIds: ['pagedattention'], question: 'abort-midstream' }, { signal: ac.signal, onDelta: d => { partial.push(d); ac.abort(); } }), hasStatus(499));
  assert.equal(partial.join(''), 'First synthesis part ');
});

test('library.cards stops sibling worker on error and skips concurrently deleted docs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-library-race-')); t.after(() => rm(root, { recursive: true, force: true }));
  let failMode = true, calls = 0, siblingAborted = false, delId = '';
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));
  const ctx = makeLlmCtx(async function* (_s, _p, signal) {
    if (failMode) { const n = ++calls; await new Promise(r => setTimeout(r, n === 1 ? 10 : 35)); if (n === 1) throw new Error('boom'); siblingAborted = Boolean(signal?.aborted); }
    else if (delId) { await act('library.delete', { id: delId }); delId = ''; }
    yield { type: 'text-delta', text: JSON.stringify({ problem: 'P', method: 'M', findings: 'F', limitations: 'L', futureWork: 'FW' }) }; yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const act = createServices({ root, ctx, library, store });
  const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => act('library.createAbstract', { title: `Batch ${i}`, authors: `Auth${i} et al.`, year: '2024', doi: `10.1000/b.${i}`, abstract: `Body ${i}.` }).then(r => r.doc.id)));
  await assert.rejects(act('library.cards', { docIds: ids }), hasStatus(502));
  await new Promise(r => setTimeout(r, 80));
  assert.equal(calls, 2); assert.equal(siblingAborted, true); assert.equal(store.withDb(false, db => listPaperCards(db, ids)).length, 0);
  failMode = false; delId = ids[0]; await act('library.cards', { docIds: [ids[0]] });
  assert.equal(store.withDb(false, db => listPaperCards(db, [ids[0]])).length, 0);
});
