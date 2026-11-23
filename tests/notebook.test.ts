import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServices } from '../src/server/services.js';
import { Library } from '../src/server/library.js';

const paper = { docId: 'paper', title: 'Cache allocation.pdf',
  sourceUrl: 'http://localhost:29812/api/paper-reader/app/index.html?doc=paper&page=6' };
const passage = { ...paper, page: 6, label: 'Left column', anchor: 'cache-map', quote: 'cache & blocks', context: 'cache & blocks' };

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'paper-notebook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'Research & notes');
  await mkdir(vaultPath);
  return { root, vaultPath, act: createServices({ root }) };
}

test('the notebook preserves old reader notes and inline insertion order across edits and restart', async t => {
  const { act, root } = await setup(t);
  const first = (await act('note.save', { ...passage, text: 'Existing note' })).note;
  const local = await act('notebook.get', paper);
  assert.equal(local.uri, null);
  assert.equal(local.notes[0]?.id, first.id);
  const last = (await act('note.save', { ...passage, text: 'Last' })).note;
  const middle = (await act('note.save', { ...passage, text: '- One\n  - Two\n', beforeId: last.id })).note;
  await act('note.save', { id: first.id, text: 'Edited first', expectedUpdatedAt: first.updatedAt });
  const reopened = await createServices({root})('notebook.get', paper);
  assert.deepEqual(reopened.notes.map(n => n.text), ['Edited first', '- One\n  - Two\n', 'Last']);
  await act('note.delete', { id: middle.id, expectedUpdatedAt: middle.updatedAt });
  assert.deepEqual((await act('notebook.get', paper)).notes.map(n => n.id), [first.id, last.id]);
});

test('two editors share one vault Markdown file, free text, source links and note versions', async t => {
  const { act, vaultPath } = await setup(t);
  const {note} = await act('note.save', { ...passage, text: 'Draft from reader' });
  await act('settings.save', {vaultPath});
  const initial = await act('notebook.get', paper);
  assert.ok(initial.path && initial.uri);
  assert.equal(new URL(initial.uri).searchParams.get('path'), initial.path);
  assert.equal(new URL(initial.uri).hostname, 'open');
  const markdown = await readFile(initial.path, 'utf8');
  assert.ok(markdown.includes('Draft from reader'));
  assert.doesNotMatch(markdown, /localhost/);
  const href = initial.markdown.match(/\[Page 6 · Left column\]\(<([^>]+)>\)/)?.[1];
  assert.ok(href);
  assert.deepEqual(Object.fromEntries(new URL(href).searchParams), { doc: 'paper', page: '6', anchor: 'cache-map', quote: 'cache & blocks' });
  const external = markdown.replace('Draft from reader', 'Edited in Obsidian') + '\n## Comparisons\n\n- An external thought\n';
  await writeFile(initial.path, external);
  await assert.rejects(act('note.save', { id: note.id, expectedUpdatedAt: note.updatedAt, text: 'Stale overwrite' }), {status:409});
  await assert.rejects(act('note.save', { id: note.id, text: 'Older client draft' }), {status:409});
  await assert.rejects(act('note.delete', { id: note.id }), {status:409});
  await assert.rejects(act('notebook.write', {...paper, markdown: 'Stale file', expectedRevision:initial.revision}), {status:409});
  assert.equal(await readFile(initial.path, 'utf8'), external);
  const refreshed = await act('notebook.get', paper);
  assert.equal(refreshed.notes[0]?.text, 'Edited in Obsidian');
  assert.ok(refreshed.markdown.includes('An external thought') && refreshed.markdown.includes(href));
  const edited = await act('note.save', {id:note.id, text:'A merged observation', expectedUpdatedAt:refreshed.notes[0]?.updatedAt});
  const file = await readFile(initial.path, 'utf8');
  assert.ok(file.includes('A merged observation') && file.includes('An external thought'));
  const latest = await act('notebook.get', paper);
  const changed = latest.markdown.replace('An external thought', 'A comparison from the reader');
  await act('notebook.write', {...paper, expectedRevision:latest.revision, markdown:changed});
  assert.equal(await readFile(initial.path, 'utf8'), file.replace('An external thought', 'A comparison from the reader'));
  await act('note.delete', {id:note.id, expectedUpdatedAt:edited.note.updatedAt});
  const afterDeletion = await readFile(initial.path, 'utf8');
  assert.ok(afterDeletion.includes('A comparison from the reader'));
  assert.deepEqual((await act('state')).notes, []);
  await rename(initial.path, initial.path + '.moved');
  await assert.rejects(act('notebook.get', paper), {status:409});
  assert.equal(await readFile(initial.path + '.moved', 'utf8'), afterDeletion);
  await assert.rejects(readFile(initial.path), {code:'ENOENT'});
});

test('an incomplete native edit can be recovered in the reader without replacing the file or its local notes', async t => {
  const {act, vaultPath} = await setup(t);
  const {note} = await act('note.save', {...passage, text:'Original research note'});
  await act('settings.save',{vaultPath});
  const book = await act('notebook.get',paper);
  assert.ok(book.path);
  const edit = (text: string) => text.replace('Original research note','Revised in the native editor') + '\nOther writing.\n';
  const repaired = edit(book.markdown), onDisk = edit(await readFile(book.path,'utf8'));
  const broken = onDisk.replace(/^<!-- paper-reader:end [^\n]+$/m,'');
  await writeFile(book.path,broken);
  const recovery = await act('notebook.get',paper);
  assert.equal(recovery.uri,book.uri);
  assert.equal(recovery.markdown,repaired.replace(/^<!-- paper-reader:end [^\n]+$/m,''));
  assert.equal(recovery.localConflict,book.markdown);
  assert.ok(recovery.warning);
  assert.deepEqual(recovery.notes.map(n=>n.id),[note.id]);
  await assert.rejects(act('note.save',{id:note.id,text:'Unrelated overwrite'}),{status:409});
  assert.equal(await readFile(book.path,'utf8'),broken);
  const resolved=await act('notebook.write',{...paper,expectedRevision:recovery.revision,markdown:repaired});
  assert.equal(resolved.warning,undefined);
  assert.equal(resolved.notes[0]?.text,'Revised in the native editor');
  assert.equal(await readFile(book.path,'utf8'),onDisk);
});

test('native reordering and native deletion are respected while unrelated paragraphs stay exactly in place', async t => {
  const {act,vaultPath}=await setup(t);
  await act('settings.save',{vaultPath});
  await act('notebook.get',paper);
  const {note:first}=await act('note.save',{...passage,text:'First'});
  const {note:second}=await act('note.save',{...passage,text:'Second'});
  const book=await act('notebook.get',paper);
  assert.ok(book.path);
  const disk=await readFile(book.path,'utf8');
  const [one,two]=[...disk.matchAll(/<!-- paper-reader:note ([\da-f-]+) -->[\s\S]*?<!-- paper-reader:end \1 -->/g)].map(match=>match[0]);
  assert.ok(one && two);
  const reordered=disk.slice(0,disk.indexOf(one))+two+'\n\n## Margin\n\n'+one+'\n';
  await writeFile(book.path,reordered);
  const refreshed=await act('notebook.get',paper);
  assert.deepEqual(refreshed.notes.map(n=>n.id),[second.id,first.id]);
  assert.ok('markdown' in refreshed.parts[1] && refreshed.parts[1].markdown.includes('## Margin'));
  await writeFile(book.path,reordered.replace(one,''));
  assert.deepEqual((await act('notebook.get',paper)).notes.map(n=>n.id),[second.id]);
  assert.deepEqual((await act('state')).notes.map(n=>n.id),[second.id]);
  assert.equal(await readFile(book.path,'utf8'),reordered.replace(one,''));
});

test('a second selection editor cannot silently replace or duplicate a saved annotation', async t => {
  const { act } = await setup(t);
  await act('notebook.get', paper);
  const {note} = await act('note.save', {...passage, selectionNote:true, text:'First draft'});
  await assert.rejects(act('note.save', {...passage, selectionNote:true, text:'Second draft'}), {status:409});
  await act('note.save', {id:note.id, expectedUpdatedAt:note.updatedAt, text:'Edited draft'});
  await assert.rejects(act('note.delete', {id:note.id, expectedUpdatedAt:note.updatedAt}), {status:409});
  await act('note.save', {...passage, selectionNote:true, context:'a different picked translation', text:'A second term'});
  assert.equal((await act('notebook.get', paper)).notes.length, 2);
});

test('retrying a new answer note keeps its ID, subsequent edits, and independent notes for the same passage', async t => {
  const { act } = await setup(t);
  await act('notebook.get', paper);
  const create = { ...passage, text: 'A shortcut carries the input.', insert: true,
    createId: 'd71327f0-8bd2-4213-860c-af4d999a157a' };
  const first = (await act('note.save', create)).note;
  await act('note.save', { id: first.id, text: 'Reviewed shortcut explanation.', expectedUpdatedAt: first.updatedAt });
  const retry = (await act('note.save', create)).note;
  assert.equal(retry.id, first.id);
  assert.equal(retry.text, 'Reviewed shortcut explanation.');
  await act('note.save', { ...create, createId: 'd71327f0-8bd2-4213-860c-af4d999a157b' });
  assert.deepEqual((await act('notebook.get', paper)).notes.map(note => note.text),
    ['Reviewed shortcut explanation.', 'A shortcut carries the input.']);
});

test('independent occurrences of a translated term can each acquire a first note', async t => {
  const { act } = await setup(t);
  await act('notebook.get', paper);
  const first = { ...passage, selectionNote: true, text: 'First mention', context: 'blocs',
    sourceUrl: passage.sourceUrl + '&targetQuote=blocs&targetOffset=8' };
  await act('note.save', first);
  const later = { ...first, text: 'Second mention', sourceUrl: passage.sourceUrl + '&targetQuote=blocs&targetOffset=43' };
  await act('note.save', later);
  await assert.rejects(act('note.save', later), {status:409});
  assert.equal((await act('notebook.get', paper)).notes.length, 2);
});

test('two occurrences of an English term keep independent notes with identical bodies', async t => {
  const { act } = await setup(t);
  await act('notebook.get', paper);
  const first = { ...passage, selectionNote: true, insert: true, text: 'Check this term.', quote: 'blocks', context: 'blocks',
    sourceUrl: passage.sourceUrl + '&rangeStart=8&endAnchor=cache-map&rangeEnd=14&rangeTail=blocks' };
  const later = { ...first, sourceUrl: passage.sourceUrl + '&rangeStart=43&endAnchor=cache-map&rangeEnd=49&rangeTail=blocks' };
  await act('note.save', first);
  await act('note.save', later);
  await assert.rejects(act('note.save', later), {status:409});
  assert.equal((await act('notebook.get', paper)).notes.length, 2);
});

test('a paired-language source keeps both the selected phrase and the exact original backlink in Markdown', async t => {
  const {act,vaultPath}=await setup(t);
  await act('settings.save',{vaultPath});
  await act('notebook.get',paper);
  const originalUrl = new URL(passage.sourceUrl);
  originalUrl.searchParams.set('targetQuote','块表');
  originalUrl.searchParams.set('targetOffset','12');
  const {note}=await act('note.save',{...passage,sourceUrl:originalUrl.href,context:'块表',text:'My note'});
  const book=await act('notebook.get',paper);
  assert.ok(book.path);
  const disk=await readFile(book.path,'utf8');
  assert.ok(disk.includes('块表'));
  assert.ok(disk.includes('cache & blocks'));
  assert.doesNotMatch(disk, /targetQuote|targetOffset|localhost/);
  const backlink = new URL(book.markdown.match(/\[Page 6 · Left column\]\(<([^>]+)>\)/)![1]);
  assert.equal(backlink.searchParams.get('quote'),'cache & blocks');
  assert.equal(backlink.searchParams.get('targetQuote'),'块表');
  assert.equal(backlink.searchParams.get('targetOffset'),'12');
  await writeFile(book.path,disk.replace('块表','逻辑块'));
  const updated=await act('notebook.get',paper);
  assert.equal(updated.notes[0]?.id,note.id);
  assert.equal(updated.notes[0]?.quote,'cache & blocks');
  assert.equal(updated.notes[0]?.context,'逻辑块');
});

test('the explicit desktop action launches only the bound notebook URI and never launches during a read or save', async t => {
  const {root,vaultPath}=await setup(t);
  const launches:string[]=[];
  const act=createServices({root,openObsidian:async uri=>{launches.push(uri);}});
  await act('settings.save',{vaultPath});
  const book=await act('notebook.get',paper);
  assert.ok(book.uri && book.desktopOpenAvailable);
  await act('note.save',{...passage,text:'Local annotation'});
  assert.deepEqual(launches,[]);
  await assert.rejects(act('notebook.open',{docId:paper.docId,expectedUri:'obsidian://open?path=other'}),{status:409});
  await act('notebook.open',{docId:paper.docId,expectedUri:book.uri,path:'unrelated-file.md'});
  assert.deepEqual(launches,[book.uri]);
  await act('settings.save',{vaultPath:''});
  await assert.rejects(act('notebook.open',{docId:paper.docId,expectedUri:book.uri}),{status:409});
  assert.deepEqual(launches,[book.uri]);
});

async function textbook(t: TestContext) {
  const { root, vaultPath } = await setup(t);
  const slug = 'principles-finance', url = 'https://openstax.org/books/' + slug + '/pages/';
  const docId = 'book-' + createHash('sha256').update(url).digest('hex');
  const sections = [
    ['preface', 'Preface', 'preface', 'Preface'],
    ['1-1-finance', '1.1 Finance', 'ch-1', '1 Introduction to Finance'],
    ['1-2-markets', '1.2 Markets', 'ch-1', '1 Introduction to Finance'],
    ['2-1-planning', '2.1 Planning', 'ch-2', '2 Financial Planning']
  ].map(([slug, title, chapterId, chapterTitle]) => ({ slug, title, chapterId, chapterTitle, url: url + slug }));
  const title = 'Principles of Finance';
  await mkdir(path.join(root, 'documents'));
  await writeFile(path.join(root, 'documents', docId + '.json'), JSON.stringify({ id: docId, kind: 'web', title, url, book: { slug, sections } }));
  const launches: string[] = [];
  const act = createServices({ root, openObsidian: async uri => { launches.push(uri); } });
  await act('settings.save', { vaultPath });
  const at = (page: number) => ({ docId, page, title, sourceUrl: 'http://localhost:29812/api/paper-reader/app/index.html?doc=' + docId + '&page=' + page });
  const entry = (page: number, text: string) => ({ ...at(page), anchor: 'p-3', label: 'Paragraph 3', quote: 'A quoted phrase', text });
  return { root, act, at, entry, launches, sections, vaultPath };
}

test('sections share one lazy vault notebook per publisher chapter with exact passage and publisher links', async t => {
  const { act, at, entry, launches, sections, vaultPath } = await textbook(t);
  const blank = await act('notebook.get', at(2));
  assert.equal(blank.path, null);
  assert.equal(blank.chapterTitle, sections[1].chapterTitle);
  assert.equal((await act('notebook.get', at(3))).revision, blank.revision);
  assert.equal((await act('notebook.get', at(4))).path, null);
  assert.deepEqual(await readdir(vaultPath), []);

  const first = await act('note.save', entry(2, 'My first section'));
  const second = await act('note.save', { ...entry(3, 'My second section'), label: sections[2].title + ' · Local markets' });
  const a = await act('notebook.get', at(3));
  assert.ok(a.path && a.uri);
  assert.equal(path.dirname(a.path), path.join(vaultPath, 'Paper Reader', 'principles-finance'));
  assert.match(path.basename(a.path), /Introduction to Finance/);
  const disk = await readFile(a.path, 'utf8');
  assert.match(disk, /\[1\.1 Finance · Paragraph 3\]\(</);
  assert.match(disk, /\[1\.2 Markets · Local markets\]\(</);
  assert.doesNotMatch(disk, /\[Page \d|1\.2 Markets · 1\.2 Markets/);
  assert.doesNotMatch(disk,/localhost|Open in Paper Reader/);
  const urls = [...a.markdown.matchAll(/\]\(<([^>]+)>\)/g)].map(m => new URL(m[1]));
  assert.deepEqual(urls.filter(u => u.searchParams.has('anchor')).map(u => [u.searchParams.get('doc'), u.searchParams.get('page'), u.searchParams.get('anchor')]),
    [[at(2).docId, '2', 'p-3'], [at(2).docId, '3', 'p-3']]);
  assert.equal(urls[0].searchParams.get('page'), '2');
  assert.ok(disk.includes(sections[1].url) && disk.includes(sections[2].url));
  assert.deepEqual(a.notes.map(n => n.id), [first.note.id, second.note.id]);
  assert.equal((await act('notebook.get', at(2))).path, a.path);

  const chapterTwo = await act('notebook.get', at(4));
  const written = await act('notebook.write', { ...at(4), expectedRevision: chapterTwo.revision, markdown: chapterTwo.markdown + '\nMy second chapter.\n' });
  assert.ok(written.path && written.uri);
  assert.notEqual(written.path, a.path);
  assert.deepEqual(written.notes, []);
  assert.doesNotMatch(written.markdown, /My first section/);
  assert.equal(await readFile(a.path, 'utf8'), disk);
  await assert.rejects(act('notebook.open', { ...at(4), expectedUri: a.uri }), { status: 409 });
  await act('notebook.open', { ...at(3), expectedUri: a.uri });
  assert.deepEqual(launches, [a.uri]);
});

test('chapter exports keep user Markdown, scoped vocabulary, and native conflicts in the same file', async t => {
  const { root, act, at, entry } = await textbook(t);
  const { note } = await act('note.save', entry(3, 'Saved before visiting Notes'));
  const a = await act('notebook.get', at(2));
  assert.ok(a.path);
  const handwritten = (await readFile(a.path,'utf8')).replace(note.text, 'Edited in Obsidian') + '\n## 私人想法\n\nKeep this text exactly.\n';
  await writeFile(a.path, handwritten);
  await assert.rejects(act('notebook.write', { ...at(3), markdown: a.markdown, expectedRevision: a.revision }), {status: 409});
  await assert.rejects(act('note.save', { id: note.id, text: 'Old record', expectedUpdatedAt: note.updatedAt }), {status: 409});
  await act('vocab.save', { ...entry(3, 'Equity'), meaning: 'Owner capital', context: '' });
  await act('vocab.save', { ...entry(4, 'Liquidity'), meaning: 'Ready cash', context: '' });
  const exported = await act('obsidian.export', { ...at(3), title: '../../fake path', chapterId: '../bogus' });
  assert.equal(exported.path, a.path);
  assert.equal(exported.words, 1);
  assert.equal(exported.notes, 1);
  const updated = await readFile(a.path, 'utf8');
  assert.ok(updated.includes(handwritten) && updated.includes('Owner capital'));
  assert.doesNotMatch(updated, /\[Page \d/);
  assert.doesNotMatch(updated, /Ready cash/);
  await act('obsidian.export', at(2));
  assert.equal(await readFile(a.path, 'utf8'), updated);
  const restarted = createServices({ root });
  const latest = await restarted('notebook.get', at(2));
  assert.equal(latest.path, a.path);
  assert.equal(latest.notes[0].text, 'Edited in Obsidian');
  const chapterTwo = await restarted('notebook.get', at(4));
  await assert.rejects(restarted('notebook.write', { ...at(4), expectedRevision: chapterTwo.revision, markdown: latest.markdown }), {status: 409});
  const escaped = latest.markdown.replace('&page=3&anchor=', '&page=4&anchor=');
  await assert.rejects(restarted('notebook.write', { ...at(2), expectedRevision: latest.revision, markdown: escaped }), {status: 409});
  await restarted('note.delete', { id: note.id, expectedUpdatedAt: latest.notes[0].updatedAt });
  const deleted = await readFile(a.path, 'utf8');
  assert.match(deleted, /Keep this text exactly/);
  assert.doesNotMatch(deleted, /Edited in Obsidian/);
});

test('chapter backlinks edited in Obsidian accept subsection titles and legacy page labels', async t => {
  const { act, at, entry } = await textbook(t);
  await act('note.save', entry(3, 'Compare these markets'));
  const a = await act('notebook.get', at(2));
  assert.ok(a.path);
  assert.match(a.markdown, /\[1\.2 Markets · Paragraph 3\]/);
  const legacy = a.markdown.replace('[1.2 Markets · Paragraph 3]', '[Page 3 · An old section label]');
  await writeFile(a.path, legacy);
  const imported = await act('notebook.get', at(3));
  assert.equal(imported.notes[0].label, 'An old section label');
  const named = legacy.replace('[Page 3 · An old section label]', '[1.2 Markets · New subsection heading]');
  await writeFile(a.path, named);
  const latest = await act('notebook.get', at(2));
  assert.equal(latest.notes[0].page, 3);
  assert.equal(latest.notes[0].anchor, 'p-3');
  assert.equal(latest.notes[0].label, 'New subsection heading');
  assert.equal(latest.markdown, named);
});

test('a new chapter leaves handwritten files and the reserved name of a moved chapter intact', async t => {
  const { root, act, at, entry, sections, vaultPath } = await textbook(t);
  const catalog = path.join(root, 'documents', at(1).docId + '.json');
  const metadata = JSON.parse(await readFile(catalog, 'utf8'));
  metadata.book.sections[3].chapterTitle = sections[1].chapterTitle;
  await writeFile(catalog, JSON.stringify(metadata));
  const folder = path.join(vaultPath, 'Paper Reader', 'principles-finance');
  await mkdir(folder, { recursive: true });
  const manual = path.join(folder, sections[1].chapterTitle + '.md');
  await writeFile(manual, 'My independent handwritten file.');

  await act('note.save', entry(2, 'First chapter'));
  const a = await act('notebook.get', at(2));
  assert.ok(a.path && a.path !== manual);
  await rename(a.path, a.path + '.moved');
  await act('note.save', entry(4, 'Later chapter with the same display title'));
  const b = await act('notebook.get', at(4));
  assert.ok(b.path && b.path !== a.path);
  await assert.rejects(act('notebook.get', at(2)), { status: 409 });
  assert.equal(await readFile(manual, 'utf8'), 'My independent handwritten file.');
  assert.match(await readFile(a.path + '.moved', 'utf8'), /First chapter/);
});

test('a vault copy resolves an old inline book citation to the publisher and the saved section, while reader edits keep its exact locator', async t => {
  const { root, at, act, sections } = await textbook(t);
  const { docId, sourceUrl } = at(3);
  const folder = path.join(root, 'documents', 'book-sections', docId);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, createHash('sha256').update(sections[2].slug).digest('hex') + '.json'),
    JSON.stringify({ paragraphs: ['Opening', 'Capital markets'], articleLayout: { 'p-2': { kind: 'p', ids: ['market-capital'] } } }));
  const book = await act('notebook.get', at(3));
  const exact = sourceUrl + '&anchor=p-2&quote=Capital&rangeStart=0&endAnchor=p-2&rangeEnd=7&rangeTail=Capital';
  const old = book.markdown + '\nHere is [my quotation][p3-dc7fc55d].\n\n[p3-dc7fc55d]: <' + exact + '>\n\nKeep this paragraph.\n';
  const saved = await act('notebook.write', { ...at(3), markdown: old, expectedRevision: book.revision });
  const disk = await readFile(saved.path!, 'utf8');
  assert.doesNotMatch(disk, /127\.0\.0\.1|localhost|Open in Paper Reader|p3-dc7fc55d|rangeStart/);
  assert.ok(disk.includes('[my quotation](<' + sections[2].url + '#market-capital>)'));
  const relative = disk.match(/\[Library copy\]\(<([^>]+\.md)#\^p-2>\)/)?.[1];
  assert.ok(relative);
  assert.match(await readFile(path.resolve(path.dirname(saved.path!), decodeURIComponent(relative)), 'utf8'), /Capital markets \^p-2/);
  await writeFile(saved.path!, disk.replace('Keep this paragraph.', 'My native edit.'));
  const reopened = await createServices({root})('notebook.get', at(3));
  assert.ok(reopened.markdown.includes(exact) && reopened.markdown.includes('My native edit.'));
  assert.equal(await readFile(saved.path!, 'utf8'), disk.replace('Keep this paragraph.', 'My native edit.'));
});

test('PDF exports include free writing and an independently openable vault PDF at the cited page', async t => {
  const { root, act, vaultPath } = await setup(t);
  const bytes = Buffer.from('%PDF-1.7 test paper');
  const doc = await new Library(root).importPdf('Collected papers.pdf', bytes);
  const request = { docId: doc.id, title: doc.title, sourceUrl: paper.sourceUrl.replace('doc=paper', 'doc=' + doc.id) };
  await act('settings.save', { vaultPath });
  const book = await act('notebook.get', request);
  const exact = request.sourceUrl + '&anchor=p6-b1&quote=proof';
  await act('notebook.write', { ...request, expectedRevision: book.revision, markdown: book.markdown + '\nProof: [p. 6 · proof](<' + exact + '>)\n' });
  const exported = await act('obsidian.export', request);
  const disk = await readFile(exported.path, 'utf8');
  assert.match(disk, /Proof:/);
  assert.doesNotMatch(disk, /localhost|Open in Paper Reader/);
  const relative = disk.match(/\[p\. 6 · proof\]\(<([^>]+\.pdf)#page=6>\)/)?.[1];
  assert.ok(relative);
  assert.deepEqual(await readFile(path.resolve(path.dirname(exported.path), decodeURIComponent(relative))), bytes);
});

test('a standalone legacy reference amid free writing retains a usable citation even after its inline label was deleted', async t => {
  const { root, act, vaultPath } = await setup(t);
  const doc = await new Library(root).importWeb({ url:'https://example.org/read', title:'An article', paragraphs:['Read this.'] });
  const request = { docId:doc.id, title:doc.title, sourceUrl:paper.sourceUrl.replace('doc=paper','doc=' + doc.id) };
  await act('settings.save', { vaultPath });
  const book = await act('notebook.get', request);
  const definition = '[p1-0123abcd]: <' + request.sourceUrl + '&anchor=p-1&quote=Read+this.>';
  const markdown = 'A thought\n' + definition + '\nAnother thought.\n';
  const saved = await act('notebook.write', {...request,expectedRevision:book.revision,markdown});
  const disk = await readFile(saved.path!, 'utf8');
  assert.match(disk,/https:\/\/example\.org\/read#:~:text=Read%20this\./);
  assert.match(disk,/\.md#\^p-1/);
  assert.doesNotMatch(disk,/p1-0123abcd|localhost/);
  assert.equal((await act('notebook.get',request)).markdown, markdown);
});

test('edits to a publisher URL in the vault retain the author’s link and note without a false conflict', async t => {
  const { at, act, entry, sections } = await textbook(t);
  const { note } = await act('note.save', entry(3, 'My observation'));
  const book = await act('notebook.get', at(3));
  const disk = await readFile(book.path!, 'utf8');
  const edited = disk.replace(sections[2].url + '#:~:text=A%20quoted%20phrase', 'https://example.org/updated');
  assert.notEqual(edited,disk);
  await writeFile(book.path!, edited);
  const latest = await act('notebook.get', at(3));
  assert.equal(latest.warning, undefined);
  assert.equal(latest.notes[0].id,note.id);
  assert.match(await readFile(book.path!, 'utf8'), /https:\/\/example\.org\/updated/);
});
