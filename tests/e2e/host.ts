import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type FrameLocator, type Page } from 'playwright-core';

const project = fileURLToPath(new URL('../../', import.meta.url));

export interface HostFixture {
  origin: string;
  authenticatedUrl: string;
  scratch: string;
  artifacts: string;
  executable: string;
}

function installed(description: string, candidates: (string | undefined)[]): string {
  const target = candidates.find((file): file is string => Boolean(file && existsSync(file)));
  if (!target) throw new Error(description);
  return target;
}

function ready(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('The isolated DSH host did not start within 40 seconds.')), 40_000);
    const consume = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString('utf8')).slice(-16_384);
      const match = /dsh web: (https?:\/\/[^\s\x1b]+)\r?\n/.exec(buffer);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('DSH exited during startup with code ' + code + '.')); });
  });
}

export async function withHost<T>(callback: (host: HostFixture) => Promise<T>, environment: NodeJS.ProcessEnv = {},
  options: { installedModelProfile?: boolean; modelFixture?: boolean } = {}): Promise<T> {
  const native = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'node-v26.13.1-win-x64');
  const dsh = installed('Set DSH_ENTRY to the installed DSH lib/bin.js.', [process.env.DSH_ENTRY,
    path.join(path.dirname(process.execPath), 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    native && path.join(native, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js']);
  const executable = installed('Set CHROME_PATH to the installed Chromium executable.', [process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', chromium.executablePath()]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-e2e-'));
  const artifacts = path.join(project, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const processEnv: NodeJS.ProcessEnv = { ...process.env, ...environment, PAPER_READER_HOME: path.join(scratch, 'reader') };
  if (!options.installedModelProfile) processEnv.DSH_HOME = path.join(scratch, 'dsh');
  const overlays = ['--patch', path.join(project, 'paper-reader.patch.yml')];
  if (options.modelFixture) {
    const patch = path.join(scratch, 'model-fixture.yml');
    const plugin = path.join(project, 'tests/e2e/question-model-fixture.mjs');
    await writeFile(patch, JSON.stringify([{ insert: [{ id: 'reader-model-fixture', name: plugin }] }]));
    overlays.push('--patch', patch);
  }
  const child = spawn(process.execPath, [dsh, 'web', ...overlays,
    '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: project, env: processEnv, windowsHide: true });
  try {
    const authenticatedUrl = await ready(child);
    return await callback({ origin: new URL(authenticatedUrl).origin, authenticatedUrl, scratch, artifacts, executable });
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
}

/** Accept the installed host's first-run screens using the same controls a reader uses. */
export async function openReader(page: Page, authenticatedUrl: string): Promise<FrameLocator> {
  try { await page.goto(authenticatedUrl, { waitUntil: 'domcontentloaded' }); }
  catch { throw new Error('The browser could not navigate to the isolated DSH host.'); }
  const sidebar = page.getByRole('button', { name: 'Paper Reader', exact: true });
  const noticeAction = page.getByRole('button', { name: /^(Continue|Configure later|Skip(?: for now)?|Get started|Open app|Got it)$/i });
  const pane = page.frameLocator('iframe[title="Paper Reader"]');
  // The sidebar is drawn before the host has loaded its persisted first-run state.
  await page.getByRole('heading', { name: 'Preview Notice', exact: true }).waitFor({ timeout: 3200 }).catch(() => undefined);
  const deadline = Date.now() + 35_000;
  let mounted = false;
  while (Date.now() < deadline) {
    const signIn = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Get started', exact: true }) });
    const closeLogin = signIn.getByRole('button', { name: 'Close', exact: true });
    if (await closeLogin.isVisible()) {
      await closeLogin.click();
      continue;
    }
    const current = noticeAction.last();
    if (await current.isVisible() && await current.isEnabled()) {
      await current.click({ timeout: 2200 }).catch(() => undefined);
      continue;
    }
    if (mounted) {
      const usable = await pane.getByRole('button', { name: /^(Open library|打开资料库)$/ }).click({ trial: true, timeout: 600 }).then(() => true, () => false);
      if (usable) return pane;
    } else if (await sidebar.isVisible()) {
      const opened = await sidebar.click({ timeout: 550 }).then(() => true, () => false);
      if (opened) {
        await pane.locator('[data-pdf-side="source"], .web-reading-sheet[data-side="source"]').first().waitFor({ timeout: 25_000 });
        mounted = true;
        continue;
      }
    }
    await page.waitForTimeout(100);
  }
  const labels = await page.getByRole('button').allTextContents();
  throw new Error('The DSH onboarding screens did not reach the reader. Visible controls: ' + labels.join(' | ').slice(0, 480));
}
