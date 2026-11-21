import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { withHost } from './host.js';

const local = 'http://127.0.0.1:23119/api';
const installed = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Zotero', 'zotero.exe');
const run = promisify(execFile);
function inUse(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(23119, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
async function disposableOwner(profile: string): Promise<number> {
  // Zotero's launcher may exit and hand the window to a second process. Verify the actual listener.
  const check = [
    '$owner = (Get-NetTCPConnection -State Listen -LocalPort 23119 -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess',
    'if ($owner) { $target = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $owner)',
    'if ($target.Name -eq "zotero.exe" -and $target.CommandLine -and $target.CommandLine.IndexOf($env:READER_TEST_DISPOSABLE_PROFILE,[StringComparison]::OrdinalIgnoreCase) -ge 0) { Write-Output $owner } }'
  ].join('\n');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], {
    windowsHide: true, env: { ...process.env, READER_TEST_DISPOSABLE_PROFILE: profile }
  });
  const processId = Number(stdout.trim());
  if (!Number.isSafeInteger(processId) || processId <= 1) throw Error('Zotero is not running from the disposable test profile.');
  return processId;
}
async function desktop(): Promise<void> {
  const write = process.env.PAPER_READER_LIVE_ZOTERO_DESKTOP === '1';
  if (process.platform !== 'win32' || !existsSync(installed)) { console.log('SKIP desktop Zotero requires an installed Windows Zotero client.'); return; }
  if (await inUse()) { console.log('SKIP desktop Zotero because another program owns port 23119. Its library was left untouched.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-zotero-e2e-')), profile = path.join(root, 'profile'), library = path.join(root, 'library');
  await Promise.all([mkdir(profile), mkdir(library)]);
  await writeFile(path.join(profile, 'user.js'), [
    'user_pref("extensions.zotero.dataDir", ' + JSON.stringify(library) + ');',
    'user_pref("extensions.zotero.useDataDir", true);', 'user_pref("extensions.zotero.httpServer.localAPI.enabled", true);',
    'user_pref("extensions.zotero.sync.autoSync", false);', 'user_pref("extensions.zotero.firstRun", false);',
    'user_pref("extensions.zotero.firstRun2", false);', 'user_pref("intl.locale.requested", "en-US");'
  ].join('\n'));
  const child = spawn(installed, ['-no-remote', '-profile', profile], { windowsHide: true, stdio: 'ignore' });
  let owner: number | undefined;
  try {
    let response: Response | undefined;
    for (let n = 0; n < 150 && !response?.ok; n++) {
      await delay(350);
      response = await fetch(local + '/').catch(() => undefined);
    }
    if (!response?.ok) throw Error('The disposable Zotero profile did not open.');
    owner = await disposableOwner(profile);
    assert.ok(existsSync(path.join(library, 'zotero.sqlite')));
    const instance = response.headers.get('Zotero-Server-ID');
    if (!instance) { console.log('SKIP native write acceptance requires Zotero 10 or newer.'); return; }
    const headers = { 'Content-Type': 'application/json', 'Zotero-Server-ID': instance, 'Zotero-API-Version': '3' };
    const empty = await (await fetch(local + '/users/0/items/top', { headers })).json();
    assert.deepEqual(empty, [], 'The test needs a new empty disposable library.');
    // Import a fixture through Zotero's citation importer. Only a user-requested product write asks for API authorization.
    const rdf = '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
      'xmlns:bib="http://purl.org/net/biblio#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:z="http://www.zotero.org/namespaces/export#"><bib:Book rdf:about="#fixture"><z:itemType>book</z:itemType>' +
      '<dc:title>Reading desk methods</dc:title></bib:Book><z:Collection rdf:about="#collection"><dc:title>Reading desk tests</dc:title>' +
      '<dcterms:hasPart rdf:resource="#fixture"/></z:Collection></rdf:RDF>';
    const seed = await fetch('http://127.0.0.1:23119/connector/import?session=' + randomUUID(), {
      method: 'POST', headers: { 'Content-Type': 'application/rdf+xml' }, body: rdf
    });
    assert.equal(seed.status, 201, 'The disposable library must import its RDF fixture.');
    const collections: {key: string; data: {name: string}}[] = await (await fetch(local + '/users/0/collections', { headers })).json();
    const collection = collections.find(c => c.data.name === 'Reading desk tests');
    assert.ok(collection, 'Zotero must import the fixture collection.');

    const paperTitle = 'Memory allocation while reading';
    const sessionID = randomUUID();
    const connector = 'http://127.0.0.1:23119/connector/';
    const source = 'https://example.org/reading-fixture';
    const citation = await fetch(connector + 'saveItems', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionID, uri: source, items: [{
        id: 'reader-fixture', itemType: 'journalArticle', title: paperTitle, date: '2023',
        creators: [{ firstName: 'Alex', lastName: 'Reader', creatorType: 'author' }], attachments: [], url: source
      }] })
    });
    assert.equal(citation.status, 201, 'The temporary Zotero library must contain the parent paper.');
    const bytes = Buffer.concat([await readFile(new URL('../../public/assets/pagedattention.pdf', import.meta.url)), Buffer.from('\n% native Zotero attachment\n')]);
    const pdf = await fetch(connector + 'saveAttachment', {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Metadata': JSON.stringify({
        sessionID, parentItemID: 'reader-fixture', title: 'Full text PDF', url: source + '.pdf'
      }) }, body: bytes
    });
    assert.equal(pdf.status, 201, 'The PDF must be stored by Zotero itself.');
    const targets: { targets: { id: string; name: string }[] } = await (await fetch(connector + 'getSelectedCollection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })).json();
    const target = targets.targets.find(option => option.name === 'Reading desk tests');
    assert.ok(target);
    const filed = await fetch(connector + 'updateSession', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionID, target: target.id })
    });
    assert.equal(filed.status, 200, 'Zotero Connector must file the sample in the temporary collection.');
    const contents: { data: { title: string } }[] = await (await fetch(local + '/users/0/collections/' + collection.key + '/items/top', { headers })).json();
    assert.ok(contents.some(item => item.data.title === paperTitle), 'Native collection contains the seeded paper.');
    const expected = 'pdf-' + createHash('sha256').update(bytes).digest('hex');

    await withHost(async host => {
      const browser = await chromium.launch({ executablePath: host.executable });
      try {
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1480, height: 940 } }), page = await context.newPage();
        await page.goto(host.authenticatedUrl);
        await page.goto(host.origin + '/api/paper-reader/app/index.html?doc=pagedattention');
        await page.locator('[data-pdf-side="source"] canvas').first().waitFor();
        await page.locator('#loading').waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: 'Open library' }).click();
        const libraryDialog = page.getByRole('dialog');
        const row = libraryDialog.getByRole('button', { name: paperTitle, exact: true });
        await row.waitFor();
        assert.equal(await libraryDialog.getByRole('tab', { name: 'Zotero', exact: true }).getAttribute('aria-selected'), 'true');
        const collectionFilter = libraryDialog.getByRole('combobox', { name: 'Collection' });
        await collectionFilter.selectOption(collection.key);
        await row.waitFor();
        const evidence = path.join(host.artifacts, 'reviews', 'web-zotero');
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: path.join(evidence, 'zotero-desktop-library.png'), animations: 'disabled' });
        await row.click();
        await page.waitForURL(url => url.searchParams.get('doc') === expected);
        await page.locator('[data-pdf-side="source"] canvas').first().waitFor();
        const readerPdf = await context.request.get(host.origin + '/api/paper-reader/pdf?id=' + expected);
        assert.deepEqual(await readerPdf.body(), bytes, 'The reader must render the exact attachment returned by desktop Zotero.');
        await page.screenshot({ path: path.join(evidence, 'zotero-desktop-pdf.png'), animations: 'disabled' });
        console.log('Verified default Zotero library, collection filtering and native PDF attachment bytes in the reader.');
        let doc = 'pagedattention';
        if (!write) {
          const imported = await context.request.post(host.origin + '/api/paper-reader/action', { data: {
            op: 'web.import', payload: { title: 'Reading desk methods', url: 'https://example.org/reading-desk-test', paragraphs: ['Reader connection test.'] }
          } });
          doc = (await imported.json()).doc.id;
        }
        const address = host.origin + '/api/paper-reader/app/index.html?doc=' + doc;
        await page.goto(address);
        await page.getByRole('button', { name: 'Show notebook' }).click();
        const ref = page.getByRole('tab', { name: 'Reference' });
        await ref.click();
        await page.getByRole('button', { name: 'Connection settings' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Zotero connection').selectOption('desktop');
        await dialog.getByRole('button', { name: 'Test Zotero connection' }).click();
        await dialog.getByText('Desktop library connected · confirm changes in Zotero').waitFor();
        await dialog.getByRole('button', { name: 'Save connections' }).click();
        await dialog.waitFor({ state: 'hidden' });
        if (write) {
          await page.getByRole('button', { name: 'Add to library' }).click();
          await page.getByLabel('Reading desk tests').check();
          console.log('Submitting the single native Paper Reader write for approval in the disposable Reading desk tests library.');
          await page.getByRole('button', { name: 'Save to Zotero' }).click();
          await page.getByRole('button', { name: 'Manage collections' }).waitFor({ timeout: 125_000 });
        }
        const query = write ? 'PagedAttention' : 'Reading desk methods';
        const endpoint = local + '/users/0/items/top?q=' + encodeURIComponent(query);
        const direct = await (await fetch(endpoint, { headers })).json();
        assert.equal(direct.length, 1);
        if (write) {
          assert.deepEqual(direct[0].data.collections, [collection.key]);
          assert.equal(direct[0].data.DOI, '10.1145/3600006.3613165');
        }
        await page.getByRole('searchbox', { name: 'Search Zotero' }).fill(query);
        await page.getByRole('button', { name: 'Find item' }).click();
        await page.getByRole('button', { name: direct[0].data.title, exact: true }).click();
        await page.getByRole('button', { name: 'Link this item' }).click();
        await page.reload();
        await ref.click();
        await page.getByRole('button', { name: 'Test connection', exact: true }).click();
        await page.getByRole('button', { name: 'Manage collections' }).click();
        assert.equal(await page.getByLabel('Reading desk tests').isChecked(), direct[0].data.collections.includes(collection.key));
        assert.equal(await page.getByRole('link', { name: 'Open in Zotero' }).getAttribute('href'), 'zotero://select/library/items/' + direct[0].key);
        if (write) {
          await page.getByRole('button', { name: 'Update Zotero item' }).click();
          await page.getByRole('button', { name: 'Manage collections' }).click();
        }
        assert.equal((await (await fetch(endpoint, { headers })).json()).length, 1);
        const card = page.getByRole('button', { name: 'Close selection' });
        if (await card.isVisible()) await card.click();
        const destination = path.join(host.artifacts, 'reviews', 'reading-desk');
        await mkdir(destination, { recursive: true });
        if (write) await page.screenshot({ path: path.join(destination, 'zotero-desktop.png'), animations: 'disabled' });
        console.log('Verified native Zotero ' + response!.headers.get('X-Zotero-Version') +
          (write ? ' write authorization, item creation, collection filing,' : '') + ' connection test, search, link and restoration using an isolated library.');
      } finally { await browser.close(); }
    });
  } finally {
    if (owner) { if (await disposableOwner(profile) === owner) process.kill(owner); }
    else if (child.exitCode === null) child.kill();
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('reader-zotero-e2e-'))
      await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}
await desktop();
