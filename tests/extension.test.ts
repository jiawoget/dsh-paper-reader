import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { isDirectPaperUrl, localOrigin, readerAddress } from '../src/extension/protocol.js';

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

test('isDirectPaperUrl detects direct PDF and arXiv paper URLs while rejecting non-paper or unsafe URLs', () => {
  for (const ok of ['https://example.org/paper.pdf', 'http://127.0.0.1:8080/a/PAPER.PDF?download=1#page=2', 'https://arxiv.org/abs/2309.06180', 'https://arxiv.org/pdf/2309.06180v2', 'https://export.arxiv.org/pdf/hep-th/9901001.pdf']) {
    assert.equal(isDirectPaperUrl(ok), true, ok);
  }
  for (const bad of ['file:///tmp/a.pdf', 'https://user:pass@arxiv.org/abs/2309.06180', 'https://evil-arxiv.org/abs/2309.06180', 'https://arxiv.org/list/cs.AI/recent', 'https://example.org/view?file=a.pdf', '', null, 42]) {
    assert.equal(isDirectPaperUrl(bad), false, String(bad));
  }
});
