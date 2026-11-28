import { build, context, transform, type BuildOptions } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(project, 'dist');
const webOut = path.join(out, 'web');
const watching = process.argv.includes('--watch');
const defaults: BuildOptions = { absWorkingDir: project, bundle: true, logLevel: 'warning', target: 'es2022', legalComments: 'eof' };
const browser: BuildOptions = { ...defaults, platform: 'browser', minify: true };
const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')) as { version: string };
const mathAssets = path.join(project, 'node_modules/katex/dist');
const shortHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

async function buildWebCssAndHtml(): Promise<void> {
  const html = await readFile(path.join(project, 'public/index.html'), 'utf8');
  const linkRe = /^[ \t]*<link rel="stylesheet" href="\.\/([^"]+)">[ \t]*\r?\n/gm;
  const sheets: string[] = [];
  for (const match of html.matchAll(linkRe)) sheets.push(match[1]);
  const parts = await Promise.all(sheets.map(async rel => {
    if (rel === 'katex/katex.min.css') {
      const katexCss = await readFile(path.join(mathAssets, 'katex.min.css'), 'utf8');
      return katexCss.replace(/url\(fonts\//g, 'url(./katex/fonts/');
    }
    return readFile(path.join(project, 'public', rel), 'utf8');
  }));
  const minified = await transform(parts.join('\n'), { loader: 'css', minify: true });
  await writeFile(path.join(webOut, 'reader.bundle.css'), minified.code, 'utf8');
  const cssHash = shortHash(minified.code);
  const appBytes = await readFile(path.join(webOut, 'app.js')).catch(() => undefined);
  const appQuery = appBytes ? `?v=${shortHash(appBytes)}` : '';
  const preloadTags = [
    '  <link rel="preload" href="./assets/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>',
    `  <link rel="modulepreload" href="./app.js${appQuery}">`,
    `  <link rel="stylesheet" href="./reader.bundle.css?v=${cssHash}">\n`
  ].join('\n');
  let placed = false;
  let rewritten = html.replace(linkRe, () => {
    if (placed) return '';
    placed = true;
    return preloadTags;
  });
  rewritten = rewritten.replace('<script type="module" src="./app.js"></script>', `<script type="module" src="./app.js${appQuery}"></script>`);
  await writeFile(path.join(webOut, 'index.html'), rewritten, 'utf8');
}

async function copyStatic(): Promise<void> {
  await mkdir(webOut, { recursive: true });
  await Promise.all([
    cp(path.join(project, 'public/assets'), path.join(webOut, 'assets'), { recursive: true }),
    cp(path.join(project, 'extension'), path.join(out, 'extension'), { recursive: true }),
    cp(path.join(mathAssets, 'fonts'), path.join(webOut, 'katex/fonts'), {
      recursive: true, filter: file => path.extname(file) === '' || file.endsWith('.woff2')
    })
  ]);
  for (const entry of await readdir(webOut)) {
    if (entry.endsWith('.css') && entry !== 'reader.bundle.css') await rm(path.join(webOut, entry), { force: true });
  }
  await rm(path.join(webOut, 'katex/katex.min.css'), { force: true });
  const manifestPath = path.join(out, 'extension/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

await rm(path.join(webOut, 'chunks'), { recursive: true, force: true });
await copyStatic();

const targets: BuildOptions[] = [
  { ...defaults, entryPoints: ['src/server/index.ts', 'src/server/local-translation-worker.ts', 'scripts/install-translation-model.ts'], entryNames: '[name]', outdir: 'dist/server', platform: 'node', format: 'esm', packages: 'external', target: 'node24' },
  { ...browser, entryPoints: ['src/client/dsh.ts'], outfile: 'dist/client.js', format: 'iife' },
  { ...browser, entryPoints: ['src/reader/app.ts'], outdir: 'dist/web', entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]', splitting: true, format: 'esm',
    plugins: [
      { name: 'local-pdfjs', setup(b) { b.onResolve({ filter: /^pdfjs-dist(?:\/build\/pdf\.mjs)?$/ }, () => ({ path: '/api/paper-reader/vendor/pdf.mjs', external: true })); } },
      { name: 'web-html-manifest', setup(b) { b.onEnd(async result => { if (!result.errors.length) await buildWebCssAndHtml(); }); } }
    ] },
  { ...browser, entryPoints: ['src/extension/background.ts', 'src/extension/content.ts', 'src/extension/popup.ts'], outdir: 'dist/extension', format: 'iife' },
];

if (watching) {
  const contexts = await Promise.all(targets.map(options => context(options)));
  await Promise.all(contexts.map(ctx => ctx.watch()));
  for (const dir of ['public', 'extension']) {
    watch(path.join(project, dir), { recursive: true }, () => { void copyStatic().then(buildWebCssAndHtml).catch(console.error); });
  }
  console.log('Watching DSH Paper Reader sources and static assets…');
} else {
  await Promise.all(targets.map(options => build(options)));
  console.log('Built the DSH plugin, reading panel and unpacked browser extension.');
}
