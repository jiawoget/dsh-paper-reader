import { spawn } from 'node:child_process';

const DEFAULT_SUITES = [
  'test:extension', 'test:extension-journeys', 'test:browser', 'test:integrations',
  'test:reader-selection', 'test:passage-links', 'test:reading-layout', 'test:reading-modes',
  'test:annotations', 'test:selection-note-draft', 'test:selection-note-discussion',
  'test:discussion-excerpt', 'test:notebook-scenarios', 'test:region-discussion',
  'test:article-capture', 'test:discussion-continuity', 'test:discussion-recovery',
  'test:reading-a-question', 'test:reader-journey-edges', 'test:paper-chat',
  'test:zotero-desktop', 'test:web-zotero', 'test:book-reading', 'test:sidebar-contents',
  'test:target-language', 'test:citation-export', 'test:dark-theme-a11y',
  'test:shortcuts-i18n', 'test:collections-delete-hygiene', 'test:tier3-cross-feature',
  'test:tier4-real-world', 'test:research-workspace', 'test:research-citations'
];

interface SuiteResult {
  suite: string;
  ok: boolean;
  ms: number;
  output: string;
}

function runSuite(suite: string): Promise<SuiteResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', suite], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true
    });
    let output = '';
    const append = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-32_768); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', error => resolve({ suite, ok: false, ms: Date.now() - started, output: String(error) }));
    child.once('close', code => resolve({ suite, ok: code === 0, ms: Date.now() - started, output }));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let concurrency = Number(process.env.E2E_CONCURRENCY || 4);
  const selected: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--concurrency' || args[i] === '-c') && args[i + 1]) concurrency = Number(args[++i]);
    else if (args[i] !== '--') selected.push(args[i]);
  }
  const suites = selected.length > 0 ? selected : DEFAULT_SUITES;
  const limit = Math.max(1, Math.min(8, Number.isFinite(concurrency) ? Math.floor(concurrency) : 4));
  const started = Date.now();
  let next = 0;
  const failures: SuiteResult[] = [];
  const worker = async () => {
    while (next < suites.length) {
      const suite = suites[next++];
      const result = await runSuite(suite);
      const sec = (result.ms / 1000).toFixed(1);
      console.log(`${result.ok ? 'PASS' : 'FAIL'} ${suite} (${sec}s)`);
      if (!result.ok) failures.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, suites.length) }, worker));
  const totalSec = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length > 0) {
    for (const fail of failures) {
      console.error(`\n--- ${fail.suite} ---\n${fail.output.trim()}`);
    }
    console.error(`\nE2E FAILED: ${suites.length - failures.length}/${suites.length} passed (${failures.length} failed) in ${totalSec}s [concurrency=${limit}]`);
    process.exit(1);
  }
  console.log(`E2E PASS: ${suites.length}/${suites.length} passed in ${totalSec}s [concurrency=${limit}]`);
}

main();
