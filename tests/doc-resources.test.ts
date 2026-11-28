import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyResourceKind, extractInPaperResources, normalizeResourceUrl, sanitizeResourceUrl } from '../src/shared/doc-resources.js';
import type { ResourceReader } from '../src/server/academic-intake.js';
import { importShardedBook } from '../src/server/book-import.js';
import { scheduleResourceDiscovery } from '../src/server/doc-resources-discover.js';
import { Library } from '../src/server/library.js';
import { ReaderStore } from '../src/server/reader-store.js';
import { hasResearchSchema } from '../src/server/research-store.js';
import { createServices } from '../src/server/services.js';

const jsonRes = (url: string, body: unknown) => ({ url: new URL(url), type: 'application/json', bytes: Buffer.from(JSON.stringify(body)) });

test('URL sanitizer, domain classifier, and in-paper resource extractor handle valid and malicious inputs', () => {
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:void(0)', 'data:text/html,<script>x</script>', 'file:///etc/passwd', 'vbscript:msgbox(1)', 'https://user:pass@github.com/org/repo', 'https://github.com/a\nb', 'not-a-url', '   ']) {
    assert.equal(sanitizeResourceUrl(bad), null, `should reject ${bad}`);
  }
  assert.equal(sanitizeResourceUrl(' https://github.com/vllm-project/vllm '), 'https://github.com/vllm-project/vllm');
  assert.equal(normalizeResourceUrl('https://GITHUB.COM/Org/Repo.GIT/#top'), 'https://github.com/org/repo');
  assert.equal(normalizeResourceUrl('https://HuggingFace.co/Datasets/Org/Bench/'), 'https://huggingface.co/datasets/org/bench');
  assert.notEqual(normalizeResourceUrl('https://youtu.be/AbCd'), normalizeResourceUrl('https://youtu.be/abcd'));
  assert.notEqual(normalizeResourceUrl('https://www.bilibili.com/video/BV1Ab'), normalizeResourceUrl('https://www.bilibili.com/video/bv1ab'));
  const cases: [string, string][] = [
    ['https://github.com/vllm-project/vllm', 'code'], ['https://gitlab.com/org/proj', 'code'], ['https://codeberg.org/org/proj', 'code'],
    ['https://www.youtube.com/watch?v=abc123', 'talk'], ['https://youtu.be/abc123', 'talk'], ['https://www.bilibili.com/video/BV1abc', 'talk'],
    ['https://slideslive.com/38991234', 'talk'], ['https://huggingface.co/datasets/org/bench', 'dataset'], ['https://kaggle.com/datasets/org/data', 'dataset'],
    ['https://zenodo.org/records/12345', 'dataset'], ['https://example.edu/files/icml-deck.pptx', 'slides'], ['https://speakerdeck.com/author/talk', 'slides'],
    ['https://my-lab.github.io/paper/', 'project'], ['https://example.edu/blog/release', 'project'],
    ['https://example.org/misc', 'other'], ['https://huggingface.co/papers/2309.06180', 'other']
  ];
  for (const [url, expected] of cases) assert.equal(classifyResourceKind(url), expected, url);

  const text = [
    'Paper at https://arxiv.org/abs/2309.06180 and https://example.edu/self. Ignore https://github.com/ and https://github.com/topics/llm.',
    'Code: https://github.com/vllm-project/vllm. Weights: (https://huggingface.co/org/vllm-7b), talk: https://youtu.be/xyz99,',
    'slides: https://speakerdeck.com/vllm/sosp23, site: https://vllm-lab.github.io/.'
  ].join(' ');
  assert.deepEqual(extractInPaperResources(text, 'https://example.edu/self').map(f => [f.kind, f.url]), [
    ['code', 'https://github.com/vllm-project/vllm'], ['dataset', 'https://huggingface.co/org/vllm-7b'],
    ['talk', 'https://youtu.be/xyz99'], ['slides', 'https://speakerdeck.com/vllm/sosp23'], ['project', 'https://vllm-lab.github.io/']
  ]);
});

test('SQLite migration, RPC CRUD, XSS rejection, companion backlinks, and delete cascade hygiene', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-doc-resources-crud-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));
  const act = createServices({ root, library, store });

  const paper = (await act('library.createAbstract', { title: 'PagedAttention Paper', doi: '10.1145/3600006.3613165' })).doc;
  const slides = (await act('web.import', { title: 'SOSP23 Talk Deck.pptx', url: 'https://example.org/deck', paragraphs: ['Slide 1'] })).doc;
  const notes = (await act('web.import', { title: 'Companion Notes', url: 'https://example.org/notes', paragraphs: ['Notes body'] })).doc;

  const checkDb = new DatabaseSync(path.join(root, 'reader.sqlite'));
  assert.equal(hasResearchSchema(checkDb), true);
  checkDb.exec('DROP TABLE doc_resources');
  assert.equal(hasResearchSchema(checkDb), false);
  checkDb.close();
  assert.deepEqual(await act('doc.resources.list', { docId: paper.id }), { resources: [], backlinks: [] });

  for (const badUrl of ['javascript:alert(1)', 'data:text/html,<svg>', 'file:///etc/passwd']) {
    await assert.rejects(act('doc.resources.add', { docId: paper.id, url: badUrl }), { status: 400 });
  }
  await assert.rejects(act('doc.resources.add', { docId: paper.id, targetDocId: paper.id }), { status: 400 });
  await assert.rejects(act('doc.resources.add', { docId: paper.id, targetDocId: 'missing-doc' }), { status: 404 });

  const repo = (await act('doc.resources.add', { docId: paper.id, url: 'https://github.com/vllm-project/vllm' })).resource;
  assert.deepEqual([repo.kind, repo.status, repo.title], ['code', 'linked', 'vllm-project/vllm']);
  const localLink = (await act('doc.resources.add', { docId: paper.id, targetDocId: slides.id })).resource;
  assert.deepEqual([localLink.kind, localLink.targetDocId], ['slides', slides.id]);
  const hybridLink = (await act('doc.resources.add', { docId: paper.id, url: 'https://vllm-lab.github.io/', targetDocId: notes.id, title: 'Notes + Site' })).resource;

  const slidesView = await act('doc.resources.list', { docId: slides.id });
  assert.equal(slidesView.backlinks.length, 1);
  assert.equal(slidesView.backlinks[0].sourceDocId, paper.id);

  await act('library.delete', { id: slides.id });
  await act('library.delete', { id: notes.id });
  const afterCompanionDel = await act('doc.resources.list', { docId: paper.id });
  assert.equal(afterCompanionDel.resources.some(r => r.id === localLink.id), false);
  const keptHybrid = afterCompanionDel.resources.find(r => r.id === hybridLink.id);
  assert.ok(keptHybrid && keptHybrid.url === 'https://vllm-lab.github.io/' && keptHybrid.targetDocId === undefined);

  assert.deepEqual(await act('doc.resources.remove', { id: repo.id }), { removed: true });
  assert.deepEqual(await act('doc.resources.remove', { id: repo.id }), { removed: false });

  await act('library.delete', { id: paper.id });
  const db = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true });
  t.after(() => db.close());
  for (const id of [paper.id, slides.id, notes.id]) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM doc_resources WHERE doc_id=? OR target_doc_id=?').get(id, id) as { n: number };
    assert.equal(Number(row.n), 0);
  }
});

test('doc.resources.discover combines in-paper + HF + GitHub + OpenAlex, respects dismissed/linked, and degrades gracefully', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-doc-resources-disc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReaderStore(root), library = new Library(root, undefined, id => store.deleteDocument(id));

  let failApis = false, variant = false;
  const readResource: ResourceReader = async raw => {
    const url = String(raw);
    if (failApis) throw Object.assign(new Error('HTTP 429 rate limited'), { status: 502 });
    if (url.includes('huggingface.co/api/papers/2309.06180')) return jsonRes(url, { githubRepo: variant ? 'https://github.com/vLLM-Project/vLLM/' : 'https://github.com/vllm-project/vllm', projectPage: 'https://vllm.ai/blog/paged' });
    if (url.includes('api.github.com/search/repositories')) {
      return jsonRes(url, {
        items: [
          { full_name: 'random/unrelated-cat', name: 'unrelated-cat', description: 'Cute photos', html_url: 'https://github.com/random/unrelated-cat' },
          { full_name: 'bad/xss-repo', name: 'xss-repo', description: 'Matches 2309.06180', html_url: 'javascript:alert(1)' },
          { full_name: 'vllm-project/vllm', name: 'vllm', description: 'Duplicate for 2309.06180', html_url: 'https://github.com/vLLM-Project/vLLM.git' },
          { full_name: 'org/pagedattention-bench', name: 'pagedattention-bench', description: 'Benchmarks for 2309.06180', html_url: variant ? 'https://github.com/Org/PagedAttention-Bench.git#readme' : 'https://github.com/org/pagedattention-bench' }
        ]
      });
    }
    if (url.includes('api.openalex.org/works/')) return jsonRes(url, { best_oa_location: { landing_page_url: 'https://oa-lab.github.io/demo' } });
    throw Object.assign(new Error('HTTP 404'), { status: 502 });
  };
  const act = createServices({ root, library, store, readResource });
  const paper = (await act('library.createAbstract', {
    title: 'Efficient Memory Management for LLM Serving with PagedAttention', url: 'https://arxiv.org/abs/2309.06180',
    abstract: 'Watch the talk at https://youtu.be/paged23 and see https://huggingface.co/datasets/vllm/traces.'
  })).doc;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await act('doc.resources.list', { docId: paper.id })).resources.length, 0);

  const first = await act('doc.resources.discover', { docId: paper.id });
  assert.equal(first.discovered, 5);
  assert.deepEqual(first.degraded, []);
  assert.equal(first.resources.some(r => r.url === 'https://github.com/random/unrelated-cat'), false);
  const urls = new Set(first.resources.map(r => r.url));
  for (const expected of ['https://github.com/vllm-project/vllm', 'https://vllm.ai/blog/paged', 'https://github.com/org/pagedattention-bench', 'https://youtu.be/paged23', 'https://huggingface.co/datasets/vllm/traces']) {
    assert.ok(urls.has(expected), expected);
  }
  assert.equal((await act('doc.resources.list', {})).pendingCounts?.[paper.id], 5);

  const hfRepo = first.resources.find(r => r.url === 'https://github.com/vllm-project/vllm')!;
  const ghBench = first.resources.find(r => r.url === 'https://github.com/org/pagedattention-bench')!;
  assert.equal((await act('doc.resources.update', { id: hfRepo.id, status: 'linked' })).resource.status, 'linked');
  assert.equal((await act('doc.resources.update', { id: ghBench.id, status: 'dismissed' })).resource.status, 'dismissed');

  variant = true;
  const second = await act('doc.resources.discover', { docId: paper.id });
  assert.equal(second.discovered, 0);
  assert.equal(second.resources.find(r => r.id === hfRepo.id)?.status, 'linked');
  assert.equal(second.resources.some(r => r.id === ghBench.id), false);
  assert.equal((await act('doc.resources.list', { docId: paper.id, includeDismissed: true })).resources.find(r => r.id === ghBench.id)?.status, 'dismissed');

  const resurrected = (await act('doc.resources.add', { docId: paper.id, url: 'https://GITHUB.COM/Org/PagedAttention-Bench.git/' })).resource;
  assert.deepEqual([resurrected.id, resurrected.status], [ghBench.id, 'linked']);

  const oaPaper = (await act('library.createAbstract', { title: 'Unique OA Demo Study', doi: '10.1000/oa-demo' })).doc;
  const oaDisc = await act('doc.resources.discover', { docId: oaPaper.id });
  assert.ok(oaDisc.resources.some(r => r.url === 'https://oa-lab.github.io/demo' && r.source === 'openalex'));

  failApis = true;
  const fallbackDoc = (await act('library.createAbstract', { title: 'Offline Resilient Paper', doi: '10.1000/offline-paper' })).doc;
  const degradedRes = await act('doc.resources.discover', { docId: fallbackDoc.id });
  assert.deepEqual(degradedRes.degraded, ['github', 'openalex']);
  assert.equal(degradedRes.discovered, 0);

  const mkSec = (i: number, text: string) => ({ slug: `sec-${i}`, title: `Section ${i}`, chapterId: `c${i}`, chapterTitle: `Section ${i}`, url: `https://example.org/book#s${i}`, paragraphs: [text], articleLayout: {} });
  const secs = [mkSec(1, 'Front matter only.'), mkSec(2, 'Official code at https://github.com/deepseek-ai/DeepSeek-V2.'), mkSec(3, 'Deck at https://speakerdeck.com/deepseek/v2-deck'), mkSec(4, 'Late ref https://github.com/late/ignored-ref')];
  const shardedDoc = (await importShardedBook(library, { title: 'DeepSeek-V2 Sharded', abstract: 'Abstract with no links.', sharded: { slug: 'deepseek-v2', sections: secs, bookSections: secs.map(({ paragraphs: _p, articleLayout: _l, ...s }) => s), anchorPages: {} } })).doc;
  await act('pages.index', { docId: shardedDoc.id });
  const shardedUrls = new Set((await act('doc.resources.discover', { docId: shardedDoc.id })).resources.map(r => r.url));
  assert.equal(shardedUrls.has('https://github.com/deepseek-ai/DeepSeek-V2'), true);
  assert.equal(shardedUrls.has('https://speakerdeck.com/deepseek/v2-deck'), true);
  assert.equal(shardedUrls.has('https://github.com/late/ignored-ref'), false);

  let releaseSlow!: () => void;
  const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
  const autoAct = createServices({ root, library, store, autoDiscover: true, readResource: async u => { await slowGate; return jsonRes(String(u), { githubRepo: 'https://github.com/org/race-repo' }); } });
  const raceDoc = (await autoAct('library.createAbstract', { title: 'Race Delete Paper', url: 'https://arxiv.org/abs/2402.00001' })).doc;
  await autoAct('library.delete', { id: raceDoc.id });
  releaseSlow();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await autoAct('doc.resources.list', { docId: raceDoc.id, includeDismissed: true })).resources.length, 0);

  const ephemeralRoot = await mkdtemp(path.join(tmpdir(), 'reader-doc-resources-bg-'));
  const bgStore = new ReaderStore(ephemeralRoot), bgLib = new Library(ephemeralRoot, undefined, id => bgStore.deleteDocument(id));
  const bgDoc = await bgLib.createAbstract({ title: 'Fast Teardown Paper', url: 'https://arxiv.org/abs/2401.00001' });
  await rm(ephemeralRoot, { recursive: true, force: true });
  scheduleResourceDiscovery({ root: ephemeralRoot, library: bgLib, store: bgStore, readResource }, bgDoc, true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(existsSync(ephemeralRoot), false);
});
