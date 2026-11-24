import { build, context, type BuildOptions } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(project, 'dist');
const watching = process.argv.includes('--watch');
const defaults: BuildOptions = { absWorkingDir: project, bundle: true, logLevel: 'warning', target: 'es2022', legalComments: 'eof' };
const browser: BuildOptions = { ...defaults, platform: 'browser', minify: true };
const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')) as { version: string };

async function copyStatic(): Promise<void> {
  await mkdir(out, { recursive: true });
  await Promise.all([
    cp(path.join(project, 'public'), path.join(out, 'web'), { recursive: true }),
    cp(path.join(project, 'extension'), path.join(out, 'extension'), { recursive: true }),
  ]);
  const manifestPath = path.join(out, 'extension/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

await copyStatic();
const mathAssets = path.join(project, 'node_modules/katex/dist');
const mathOutput = path.join(out, 'web/katex');
await Promise.all([
  cp(path.join(mathAssets, 'katex.min.css'), path.join(mathOutput, 'katex.min.css')),
  cp(path.join(mathAssets, 'fonts'), path.join(mathOutput, 'fonts'), {
    recursive: true, filter: file => path.extname(file) === '' || file.endsWith('.woff2')
  })
]);

const targets: BuildOptions[] = [
  { ...defaults, entryPoints: ['src/server/index.ts', 'src/server/local-translation-worker.ts', 'scripts/install-translation-model.ts'], entryNames: '[name]', outdir: 'dist/server', platform: 'node', format: 'esm', packages: 'external', target: 'node24' },
  { ...browser, entryPoints: ['src/client/dsh.ts'], outfile: 'dist/client.js', format: 'iife' },
  { ...browser, entryPoints: ['src/reader/app.ts'], outfile: 'dist/web/app.js', format: 'esm',
    plugins: [{ name: 'local-pdfjs', setup(build) { build.onResolve({ filter: /^pdfjs-dist(?:\/build\/pdf\.mjs)?$/ }, () => ({ path: '/api/paper-reader/vendor/pdf.mjs', external: true })); } }] },
  { ...browser, entryPoints: ['src/extension/background.ts', 'src/extension/content.ts', 'src/extension/popup.ts'], outdir: 'dist/extension', format: 'iife' },
];

if (watching) {
  const contexts = await Promise.all(targets.map(options => context(options)));
  await Promise.all(contexts.map(ctx => ctx.watch()));
  for (const dir of ['public', 'extension']) {
    watch(path.join(project, dir), { recursive: true }, () => { void copyStatic().catch(console.error); });
  }
  console.log('Watching DSH Paper Reader sources and static assets…');
} else {
  await Promise.all(targets.map(options => build(options)));
  console.log('Built the DSH plugin, reading panel and unpacked browser extension.');
}
