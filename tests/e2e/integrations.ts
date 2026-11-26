import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { NotebookSnapshot } from '../../src/shared/types.js';
import { withNativeNotebook } from './native-notebook.js';
import { markdownLinks, vaultSource, visibleMarkdown } from './vault-links.js';
import { chromium, type BrowserContext, type FrameLocator, type Locator, type Page, type Route } from 'playwright-core';
import { openReader, withHost, type HostFixture } from './host.js';
import { modelFixture, zoteroFixture } from './integration-fixtures.js';

interface ReaderSession { host: HostFixture; context: BrowserContext; page: Page; pane: FrameLocator }
async function reader(host: HostFixture, run: (session: ReaderSession) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: process.env.PAPER_READER_HEADED !== '1', executablePath: host.executable });
  try {
    const context = await browser.newContext({ viewport: { width: 1620, height: 1060 }, locale: 'en-US', deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const pane = await openReader(page, host.authenticatedUrl).catch(async error => {
      const reports = await Promise.all(page.frames().map(async frame => ({
        route: frame.url().startsWith('http') ? new URL(frame.url()).pathname : 'frame',
        text: (await frame.locator('body').innerText({ timeout: 1800 }).catch(() => '')).slice(0, 420).replace(/https?:\/\/\S+/g, '[URL]')
      })));
      throw new Error('The DSH reader did not mount. ' + JSON.stringify(reports), { cause: error });
    });
    await pane.getByRole('button', { name: 'Bilingual', exact: true }).click();
    await pane.getByRole('button', { name: 'Show notes' }).click();
    await run({ host, context, page, pane });
  } finally { await browser.close(); }
}

async function reloadReader({ page, pane }: ReaderSession): Promise<void> {
  const frame = page.frames().find(value => value.url().includes('/api/paper-reader/app/index.html'));
  assert.ok(frame);
  await frame.goto(frame.url(), { waitUntil: 'domcontentloaded' });
  await pane.locator('#original [data-pdf-side="source"]').first().waitFor();
}

async function connections(session: ReaderSession, fixture: Awaited<ReturnType<typeof modelFixture>>): Promise<void> {
  const { host, page, pane } = session;
  await openConnections(pane);
  await pane.getByLabel('API base URL').fill(fixture.origin + '/v1');
  await pane.getByLabel('Model', { exact: true }).fill(fixture.model);
  await pane.getByLabel('API key', { exact: true }).fill(fixture.key);
  await saveConnections(pane);
  await reloadReader(session);
  await pane.locator('#translated .pdf-translated-text[data-block-id="two-requests"]').click();
  const card = pane.locator('#card');
  await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const question = card.getByRole('textbox', { name: 'Message about this selection' });
  await question.fill('How does the request grow its KV cache?');
  await question.press('Enter');
  await card.getByRole('log').getByText(fixture.answer, { exact: true }).waitFor();
  assert.equal(fixture.completed(), 1);
  await openConnections(pane);
  assert.equal(await pane.getByLabel('API base URL').inputValue(), fixture.origin + '/v1');
  assert.equal(await pane.getByLabel('Model', { exact: true }).inputValue(), fixture.model);
  const savedKey = pane.getByLabel('API key', { exact: true });
  assert.equal(await savedKey.inputValue(), '');
  assert.equal(await savedKey.getAttribute('placeholder'), 'Key saved');
  assert.ok(!(await pane.getByRole('dialog').innerText()).includes(fixture.key));
  await pane.getByRole('heading', { name: 'Language model' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(host.artifacts, '09-connections.png') });
  await pane.getByLabel('Remove saved model key').check();
  await saveConnections(pane);
  await openConnections(pane);
  assert.ok(!(await pane.getByLabel('Remove saved model key').isVisible()));
  console.log('PASS 09: model settings survived a reader reload, the actual DSH API completed a request to a credential-checking loopback model fixture, and explicit removal cleared the saved key.');
}

async function zotero(session: ReaderSession, fixture: Awaited<ReturnType<typeof zoteroFixture>>): Promise<void> {
  const { host, page, pane } = session;
  const vault = path.join(host.scratch, 'Zotero-linked reading');
  await mkdir(vault);
  await pane.getByRole('tab', { name: 'Reference' }).click();
  await pane.locator('.zotero-connection[data-connected="false"] [role="status"]').waitFor();
  assert.equal((await pane.locator('#railBody .list-row').innerText()).trim(), '');
  await pane.getByRole('button', { name: 'Connection settings' }).click();
  const settings = pane.getByRole('dialog');
  await settings.getByRole('tab', { name: 'Obsidian', exact: true }).click();
  await settings.getByLabel('Obsidian vault folder').fill(vault);
  await settings.getByRole('tab', { name: 'Zotero', exact: true }).click();
  await settings.getByRole('combobox', { name: /Zotero connection/ }).selectOption('web');
  await settings.getByLabel('Library type').selectOption('group');
  await settings.getByLabel('Zotero library ID').fill(fixture.libraryId);
  await settings.getByLabel('Zotero API key').fill(fixture.credential);
  await saveConnections(pane);
  await pane.getByRole('searchbox', { name: 'Search Zotero' }).fill('PagedAttention');
  await pane.getByRole('button', { name: 'Find item' }).click();
  await pane.getByRole('button', { name: fixture.title }).click();
  assert.ok(fixture.counts().searches > 0, 'A test save requires an observed loopback search first.');
  assert.ok(await pane.getByLabel('Systems papers').isChecked());
  assert.ok(await pane.getByLabel('Systems papers').isDisabled());
  await pane.getByLabel('Attention mechanisms').check();
  await pane.getByRole('button', { name: 'Update Zotero item' }).click();
  await pane.getByRole('button', { name: 'Manage collections' }).waitFor();
  assert.deepEqual(fixture.collections(), ['SYSTEMS2', 'ATTENTN2']);
  await reloadReader(session);
  await pane.getByRole('tab', { name: 'Reference' }).click();
  const reopen = pane.getByRole('button', { name: 'Manage collections' });
  await reopen.click();
  assert.ok(await pane.getByLabel('Attention mechanisms').isChecked());
  assert.ok(await pane.getByLabel('Systems papers').isChecked());
  assert.equal(await pane.getByRole('link', { name: 'Open in Zotero' }).getAttribute('href'), fixture.alternate);
  await pane.getByRole('button', { name: 'Update Zotero item' }).click();
  await reopen.click();
  await pane.getByLabel('Distributed inference').waitFor();
  assert.ok(await pane.getByLabel('Systems papers').isChecked());
  assert.ok(await pane.getByLabel('Attention mechanisms').isChecked());
  assert.equal(fixture.counts().updates, 1);
  assert.equal(fixture.counts().creates, 0);
  const notebook = { docId: 'pagedattention', title: 'PagedAttention.pdf', page: 6,
    sourceUrl: host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6' };
  const endpoint = host.origin + '/api/paper-reader/action';
  const note = await session.context.request.post(endpoint, { data: { op: 'note.save', payload: { ...notebook,
    anchor: 'block-tables', label: 'Block tables', quote: 'block tables', text: 'Compare the allocation scheme.', insert: true } } });
  assert.ok(note.ok());
  const exported = await session.context.request.post(endpoint, { data: { op: 'obsidian.export', payload: notebook } });
  assert.ok(exported.ok());
  const file: string = (await exported.json()).path;
  assert.equal(path.dirname(file), path.join(vault, 'Paper Reader'));
  const markdown = visibleMarkdown(await readFile(file, 'utf8'));
  const links = markdownLinks(markdown);
  const citation = links.findIndex(link => link.label === 'Page 6 · Block tables');
  assert.ok(citation >= 0 && markdown.includes('Compare the allocation scheme.'));
  assert.equal(links[citation].target, 'https://arxiv.org/abs/2309.06180');
  const copy = vaultSource(vault, file, links[citation + 1].target);
  assert.equal(copy.fragment, 'page=6');
  assert.ok((await readFile(copy.file)).subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.deepEqual(links[citation + 2], { label: 'Zotero', target: fixture.alternate });
  await page.mouse.move(4, 4);
  await page.screenshot({ path: path.join(host.artifacts, '07-zotero.png') });
  const seed = await session.context.request.post(host.origin + '/api/paper-reader/action', { data: {
    op: 'web.import', payload: { title: 'Allocator companion (fixture)', url: 'https://example.com/allocator-test', paragraphs: ['Allocation proceeds in blocks.'] }
  } });
  assert.ok(seed.ok());
  await pane.getByRole('button', { name: 'Open library' }).click();
  await pane.getByRole('tab', { name: 'On this device' }).click();
  await pane.getByRole('dialog').getByRole('button', { name: /Allocator companion/ }).click();
  await pane.getByRole('tab', { name: 'Reference' }).click();
  await pane.getByRole('button', { name: 'Add to library' }).click();
  await pane.getByLabel('Attention mechanisms').check();
  await pane.getByRole('button', { name: 'Save to Zotero' }).click();
  await pane.getByRole('button', { name: 'Manage collections' }).click();
  assert.ok(await pane.getByLabel('Attention mechanisms').isChecked());
  assert.equal(fixture.counts().creates, 1);
  console.log('LIMITED 07: DSH search, additive filing, durable links, repeat save and creation of a second item passed against a loopback Zotero Web API fixture. A live account remains unverified.');
}
async function openConnections(pane: FrameLocator): Promise<void> {
  await pane.getByRole('button', { name: 'More actions' }).click();
  await pane.getByRole('button', { name: 'Connections', exact: true }).click();
  await pane.getByRole('dialog').getByRole('heading', { name: 'Connections' }).waitFor();
}
async function saveConnections(pane: FrameLocator): Promise<void> {
  await pane.getByRole('button', { name: 'Save connections' }).click();
  await pane.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function obsidian({host, page, pane, context}: ReaderSession): Promise<void> {
  const vault = path.join(host.scratch, 'Research Notebook');
  await mkdir(vault);
  const reviews = path.join(host.artifacts, 'reviews', 'floating-workspace');
  await mkdir(reviews, {recursive: true});
  const endpoint = host.origin + '/api/paper-reader/action';
  const docId = 'pagedattention';
  const args = {docId, title: 'PagedAttention.pdf', sourceUrl: host.origin + '/api/paper-reader/app/index.html?doc=pagedattention&page=6'};
  const source = {...args, page: 6, label: 'Left column', anchor: 'block-tables', quote: 'block tables'};
  const notebook = async () => {
    const res = await context.request.post(endpoint, {data: {op: 'notebook.get', payload: args}});
    assert.ok(res.ok()); return await res.json() as NotebookSnapshot;
  };
  const ids: string[] = [];
  for (const text of ['First reading', 'A second observation', 'Temporary note']) {
    const res = await context.request.post(endpoint, {data: {op: 'note.save', payload: {...source, text, insert: true}}});
    assert.ok(res.ok()); ids.push((await res.json()).note.id);
  }
  const close = pane.getByRole('button', {name: 'Close selection', exact: true});
  if (await close.isVisible()) await close.click();
  await pane.getByRole('button', {name: 'Refresh notes'}).click();
  const editor = pane.getByRole('textbox', {name: 'Notes Markdown', exact: true});
  const lines = editor.locator('.cm-line');
  const first = editor.locator('[data-note-id="' + ids[0] + '"].cm-line');
  const sibling = editor.locator('[data-note-id="' + ids[1] + '"].cm-line');
  await first.getByText('First reading', {exact: true}).or(first.filter({hasText: 'First reading'})).first().waitFor();
  assert.ok(!(await editor.innerText()).includes('paper-reader:'), 'Managed comments must stay off the writing surface.');
  const replaceLine = async (line: Locator, text: string) => {
    await line.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
    await page.keyboard.insertText(text);
  };
  const annotation = 'Map each logical block to its physical cache location.';
  await replaceLine(first, annotation);
  await replaceLine(sibling, 'Compare paging with contiguous allocation.');
  const temp = editor.locator('.notebook-source[data-note-id="' + ids[2] + '"]');
  await temp.getByRole('button', {name: 'Delete linked note'}).click();
  await editor.press('Control+z');
  await temp.waitFor();
  await editor.press('Control+y');
  await temp.waitFor({state: 'detached'});
  const gap = sibling.locator('xpath=preceding-sibling::*[1]');
  await gap.click({position: {x: 4, y: 5}});
  await page.keyboard.insertText('Track block reuse between requests.');
  const append = async (text: string) => {
    await editor.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(text);
  };
  await append('\n## Reading journal\n\n- Check memory use as the batch grows.');
  await editor.press('Control+s');
  await pane.getByText('Saved locally', {exact: true}).waitFor();
  const local = await notebook();
  assert.deepEqual(local.notes.map(note => [note.id, note.text]), [
    [ids[0], annotation], [ids[1], 'Compare paging with contiguous allocation.']
  ]);
  assert.ok(local.markdown.includes('## Reading journal'));
  assert.ok(local.markdown.indexOf('Track block reuse') > local.markdown.indexOf('paper-reader:end ' + ids[0]) &&
    local.markdown.indexOf('Track block reuse') < local.markdown.indexOf('paper-reader:note ' + ids[1]), 'Free prose stays between the selected notes.');
  assert.equal(await pane.getByRole('button', { name: 'Export to Obsidian', exact: true }).isVisible(), false);
  await pane.getByRole('button', {name: 'Connect Obsidian'}).click();
  await pane.getByLabel('Obsidian vault folder').fill(vault);
  await saveConnections(pane);
  await pane.getByText('Saved to vault', {exact: true}).waitFor();
  assert.equal(await pane.getByRole('button', { name: 'Export to Obsidian', exact: true }).isVisible(), true);
  const liveMark = await context.request.post(endpoint, { data: { op: 'annotation.save', payload: {
    ...source, id: randomUUID(), kind: 'highlight', color: 'green', text: 'Keep in Reading Pack'
  } } });
  assert.ok(liveMark.ok());
  const deadMarkRes = await context.request.post(endpoint, { data: { op: 'annotation.save', payload: {
    ...source, id: randomUUID(), kind: 'highlight', color: 'purple', quote: 'Removed mark quote', text: 'Should not export'
  } } });
  assert.ok(deadMarkRes.ok());
  const deadMark = (await deadMarkRes.json()).annotation;
  assert.ok((await context.request.post(endpoint, { data: { op: 'annotation.delete', payload: { docId, id: deadMark.id, expectedUpdatedAt: deadMark.updatedAt } } })).ok());
  const exportResPromise = page.waitForResponse(res => res.url().endsWith('/api/paper-reader/action') && res.request().postDataJSON()?.op === 'obsidian.export');
  await pane.getByRole('button', { name: 'Export to Obsidian', exact: true }).click();
  const exportJson = await (await exportResPromise).json() as { path: string; annotations: number };
  await pane.locator('#toast').getByText('Exported to Obsidian.', { exact: true }).waitFor();
  assert.equal(exportJson.annotations, 1);
  const packDisk = await readFile(exportJson.path, 'utf8');
  assert.ok(packDisk.startsWith('---\n') && packDisk.includes('## Highlights & Page Notes') && packDisk.includes('Keep in Reading Pack'));
  assert.doesNotMatch(packDisk, /Removed mark quote|Should not export|localhost|127\.0\.0\.1|\/api\/paper-reader\/app\//);
  await appendFile(exportJson.path, '\n## Manual vault note\nPreserved across export.\n');
  await pane.getByRole('button', { name: 'Export to Obsidian', exact: true }).click();
  await pane.locator('#toast').getByText('Exported to Obsidian.', { exact: true }).waitFor();
  assert.ok((await readFile(exportJson.path, 'utf8')).includes('Preserved across export.'));
  const connected = await notebook();
  const file = connected.path;
  assert.ok(file && path.dirname(file) === path.join(vault, 'Paper Reader'));
  const initialDisk = await readFile(file, 'utf8');
  assert.equal(connected.markdown, local.markdown);
  const rendered = visibleMarkdown(initialDisk);
  for (const line of [annotation, 'Compare paging with contiguous allocation.', 'Track block reuse between requests.', '## Reading journal']) {
    assert.ok(rendered.includes(line));
  }
  const citations = markdownLinks(rendered);
  const cited = citations.findIndex(link => link.label === 'Page 6 · Left column');
  assert.ok(cited >= 0);
  assert.equal(citations[cited].target, 'https://arxiv.org/abs/2309.06180');
  assert.equal(citations[cited + 1].label, 'Library copy');
  const copy = vaultSource(vault, file, citations[cited + 1].target);
  assert.equal(copy.fragment, 'page=6');
  assert.deepEqual(await readFile(copy.file), await readFile(new URL('../../public/assets/pagedattention.pdf', import.meta.url)));
  const link = markdownLinks(connected.markdown).map(cite => new URL(cite.target))
    .find(url => url.searchParams.get('anchor') === 'block-tables');
  assert.ok(link);
  assert.equal(link.searchParams.get('page'), '6');
  assert.equal(link.searchParams.get('quote'), 'block tables');
  await pane.getByRole('button', {name: 'Markdown', exact: true}).click();
  await lines.filter({hasText: '<!-- paper-reader:note ' + ids[1]}).waitFor();
  await pane.getByRole('button', {name: 'Markdown', exact: true}).click();
  await sibling.waitFor();

  const nativeText = 'Record throughput alongside memory use.';
  const browserText = 'Compare peak allocation.';
  await withNativeNotebook(host.scratch, vault, file, async native => {
    const nativeEditor = native?.locator('.workspace-leaf.mod-active .markdown-source-view .cm-content');
    if (nativeEditor) await nativeEditor.getByText('Compare paging with contiguous allocation.', {exact: true}).waitFor();
    const release = Promise.withResolvers<void>();
    const intercepted = Promise.withResolvers<void>();
    const passed = Promise.withResolvers<void>();
    const hold = async (route: Route) => {
      if (route.request().postDataJSON()?.op === 'notebook.write') {
        intercepted.resolve(); await release.promise;
        try { await route.continue(); } finally { passed.resolve(); }
        return;
      }
      await route.continue();
    };
    await page.route(endpoint, hold);
    try {
      await append('\n- ' + browserText);
      await editor.press('Control+s');
      await intercepted.promise;
      if (nativeEditor && native) {
        await nativeEditor.focus();
        await native.keyboard.press('Control+End');
        await native.keyboard.press('Enter');
        await native.keyboard.press('Enter');
        await native.keyboard.insertText(nativeText);
        await nativeEditor.press('Control+s');
      } else await appendFile(file, '\n\n' + nativeText + '\n');
      await waitForTextOnDisk(file, nativeText);
    } finally { release.resolve(); await passed.promise; await page.unroute(endpoint, hold); }
    await pane.getByRole('button', {name: 'Compare latest'}).click();
    await pane.locator('.notebook-latest').getByText(nativeText, {exact: false}).or(pane.locator('.notebook-latest').filter({hasText: nativeText})).first().waitFor();
    assert.ok((await editor.innerText()).includes(browserText), 'The browser draft must survive a competing write.');
    assert.ok(!(await readFile(file, 'utf8')).includes(browserText), 'The stale browser request must leave the external file intact.');
    await append('\n\n' + nativeText);
    await pane.getByRole('button', {name: 'Save merged draft'}).click();
    await pane.getByText('Saved to vault', {exact: true}).waitFor();
    let disk = await waitForTextOnDisk(file, browserText);
    assert.ok(disk.includes(nativeText) && disk.includes(annotation));
    if (nativeEditor && native) {
      await nativeEditor.getByText(browserText, {exact: false}).first().waitFor();
      await nativeEditor.getByText(nativeText, {exact: false}).last().scrollIntoViewIfNeeded();
      await native.locator('.notice-container .notice').first().waitFor({state:'hidden', timeout:5000}).catch(() => undefined);
      await native.screenshot({path: path.join(reviews, 'obsidian-vault-roundtrip.png')});
    }
    // A change at the cursor can be formatted and undone without losing a sibling's source or metadata.
    await append('\n\n');
    await editor.press('Control+b'); await page.keyboard.insertText('Retained evidence');
    await editor.press('Control+s');
    await pane.getByText('Saved to vault', {exact: true}).waitFor();
    disk = await waitForTextOnDisk(file, '**Retained evidence**');
    assert.ok(disk.includes('<!-- paper-reader:source ' + ids[1] + ' -->'));
    assert.deepEqual(markdownLinks(visibleMarkdown(disk)), citations);
    assert.deepEqual((await notebook()).notes.map(note => note.id), ids.slice(0, 2));
    await writeFile(path.join(reviews, 'vault-roundtrip.md'), disk);
    if (native) console.log('PASS actual Obsidian: the isolated installed app read Chrome edits, wrote a competing edit and received the resolved notebook.');
  });
  const reopened = await context.newPage();
  await reopened.goto(link.href);
  await reopened.locator('#original .pdf-quote-mark').first().waitFor();
  await reopened.locator('.cm-line').getByText(annotation, {exact: true}).or(reopened.locator('.cm-line').filter({hasText: annotation})).first().waitFor();
  await reopened.reload();
  await reopened.locator('#original .pdf-quote-mark').first().waitFor();
  await reopened.getByRole('textbox', {name: 'Notes Markdown'}).getByText('Retained evidence', {exact: false}).first().waitFor();
  await reopened.close();
  await pane.getByRole('button', {name: 'Next page'}).click();
  await pane.locator('[aria-label="Original, page 7"]').waitFor();
  await editor.locator('.source-chip[data-note-id="' + ids[0] + '"]').click();
  await pane.locator('#original .pdf-quote-mark').first().waitFor();
  const target = new URL(await pane.locator('body').evaluate(() => location.href));
  assert.equal(target.searchParams.get('anchor'), 'block-tables');
  assert.equal(target.searchParams.get('page'), '6');
  assert.equal(target.searchParams.get('quote'), 'block tables');
  await pane.locator('#toast').waitFor({state: 'hidden'});
  await lines.filter({hasText: browserText}).last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await editor.locator('xpath=ancestor::div[contains(@class, \'cm-editor\')]').locator('.cm-selectionBackground').first().waitFor();
  await page.screenshot({path: path.join(reviews, 'chrome-markdown-editor.png')});
  console.log('PASS 06: editing and deleting linked notes in CodeMirror, local and vault autosave, exact source links, native external edits, conflict comparison and reload.');
}

async function waitForTextOnDisk(file: string, text: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let value = '';
  while (Date.now() < deadline) {
    value = await readFile(file, 'utf8');
    if (value.includes(text)) return value;
    await delay(120);
  }
  throw new Error('The notebook editor did not write the expected text to disk: ' + text);
}

const selected = process.argv.slice(2);
if (!selected.length || selected.includes('06')) await withHost(host => reader(host, obsidian));
if (!selected.length || selected.includes('07')) {
  const fixture = await zoteroFixture();
  try {
    const preload = new URL('./integration-zotero-preload.ts', import.meta.url).href;
    await withHost(host => reader(host, session => zotero(session, fixture)), {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' '),
      READER_TEST_ZOTERO_ORIGIN: fixture.origin
    });
  } finally { await fixture.close(); }
}
if (!selected.length || selected.includes('09')) {
  const fixture = await modelFixture();
  try { await withHost(host => reader(host, session => connections(session, fixture))); }
  finally { await fixture.close(); }
}
