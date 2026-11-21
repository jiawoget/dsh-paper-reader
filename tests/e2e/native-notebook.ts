import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright-core';

// Only this disposable profile exposes a random loopback test port. Neither the
// running user's app nor its vault registry, settings or workspace are consulted.
export async function withNativeNotebook(scratch: string, vault: string, file: string,
  run: (page?: Page) => Promise<void>): Promise<void> {
  const exe = process.env.OBSIDIAN_PATH ?? (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe'));
  if (process.platform !== 'win32' || !exe || !existsSync(exe)) { await run(); return; }
  const roaming = path.join(scratch, 'native-profile'), profile = path.join(roaming, 'obsidian');
  await Promise.all([mkdir(profile, {recursive: true}), mkdir(path.join(vault, '.obsidian'), {recursive: true})]);
  await writeFile(path.join(profile, 'obsidian.json'), JSON.stringify({vaults: {a0b0c0d0e0f01122: {path: vault, ts: Date.now(), open: true}}}));
  const child = spawn(exe, ['--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    'obsidian://open?path=' + encodeURIComponent(file)], {env: {...process.env, APPDATA: roaming}, stdio: 'ignore', windowsHide: true});
  let browser: Browser | undefined;
  try {
    const deadline = Date.now() + 15_000;
    let port = '';
    while (!port && Date.now() < deadline && child.exitCode === null) {
      port = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').then(data => data.split('\n')[0].trim(), () => '');
      if (!port) await setTimeout(150);
    }
    assert.match(port, /^\d+$/, 'The isolated Obsidian renderer did not start.');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {timeout: 5000});
    const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].waitForEvent('page');
    await page.locator('.workspace-leaf.mod-active .markdown-source-view .cm-content').waitFor({timeout: 20_000});
    assert.ok((await page.title()).includes(path.basename(vault)), 'Only the test vault may be edited.');
    await run(page);
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill(); await exit;
    }
  }
}
