import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { localOrigin, readerAddress } from '../src/extension/protocol.js';

test('users can choose their local DSH port without redirecting selections to a remote host', () => {
  assert.equal(localOrigin(), 'http://127.0.0.1:29812');
  assert.equal(localOrigin(' http://localhost:10101/ '), 'http://localhost:10101');
  for (const input of ['https://outside.example/', 'http://localhost.example/', 'http://localhost@outside.example/', 'http://user:secret@127.0.0.1', 'file:///C:/reader', 'http://localhost/some/route']) {
    assert.throws(() => localOrigin(input));
  }
});

test('opening a saved web quote preserves its document and paragraph using an authenticated asset route', () => {
  const url = new URL(readerAddress('http://localhost:10101', 'web #12', 'p-6'));
  assert.equal(url.origin, 'http://localhost:10101');
  assert.equal(url.pathname, '/api/paper-reader/app/index.html');
  assert.deepEqual([...url.searchParams], [['doc', 'web #12'], ['page', '1'], ['anchor', 'p-6']]);
});

test('the unpacked extension grants permanent access only to local DSH hosts', async () => {
  const data = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(data.manifest_version, 3);
  assert.deepEqual(data.permissions.sort(), ['activeTab', 'contextMenus', 'scripting', 'storage'].sort());
  assert.equal(data.content_scripts, undefined);
  assert.ok(data.host_permissions.length > 0);
  for (const match of data.host_permissions) assert.match(match, /^(?:https?|\*):\/\/(localhost|127\.0\.0\.1|\[::1\])\/\*$/);
});
