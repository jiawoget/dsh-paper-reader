import { build, type BuildOptions } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(project, 'dist');
const defaults: BuildOptions = { absWorkingDir: project, bundle: true, logLevel: 'warning', target: 'es2022', legalComments: 'eof' };
await mkdir(out, { recursive: true });
await Promise.all([
  cp(path.join(project, 'public'), path.join(out, 'web'), { recursive: true }),
  cp(path.join(project, 'extension'), path.join(out, 'extension'), { recursive: true }),
]);
const mathAssets = path.join(project, 'node_modules/katex/dist');
const mathOutput = path.join(out, 'web/katex');
await Promise.all([
  cp(path.join(mathAssets, 'katex.min.css'), path.join(mathOutput, 'katex.min.css')),
  cp(path.join(mathAssets, 'fonts'), path.join(mathOutput, 'fonts'), {
    recursive: true, filter: file => path.extname(file) === '' || file.endsWith('.woff2')
  })
]);
await Promise.all([
  build({ ...defaults, entryPoints: ['src/server/index.ts', 'src/server/local-translation-worker.ts'], outdir: 'dist/server', platform: 'node', format: 'esm', packages: 'external', target: 'node24' }),
  build({ ...defaults, entryPoints: ['src/client/dsh.ts'], outfile: 'dist/client.js', platform: 'browser', format: 'iife' }),
  build({ ...defaults, entryPoints: ['src/reader/app.ts'], outfile: 'dist/web/app.js', platform: 'browser', format: 'esm',
    plugins: [{ name: 'local-pdfjs', setup(build) { build.onResolve({ filter: /^pdfjs-dist(?:\/build\/pdf\.mjs)?$/ }, () => ({ path: '/api/paper-reader/vendor/pdf.mjs', external: true })); } }] }),
  build({ ...defaults, entryPoints: ['src/extension/background.ts','src/extension/content.ts','src/extension/popup.ts'], outdir: 'dist/extension', platform: 'browser', format: 'iife' }),
]);
console.log('Built the DSH plugin, reading panel and unpacked browser extension.');
