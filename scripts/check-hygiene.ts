import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const RATCHET_SLACK = 10, CSS_MAX_LINE_CHARS = 240, CSS_OVERLAP_CAP = 28, DUP_WINDOW = 8, TEST_DUP_CAP = 8, I18N_REPEAT_CAP = 5;

const SRC_RATCHET: Record<string, number> = {
  'src/reader/app.ts': 1000, 'src/reader/pdf-view.ts': 679, 'src/reader/notebook.ts': 585,
  'src/reader/selection-chat.ts': 534, 'src/reader/selection-card.ts': 508, 'src/server/reader-store.ts': 480,
  'src/reader/panels.ts': 469, 'src/shared/citation-export.ts': 437, 'src/reader/paper-chat.ts': 413,
  'src/reader/article-view.ts': 395, 'src/reader/annotation-layer.ts': 377, 'src/server/library.ts': 362,
  'src/reader/reading-desk.ts': 358, 'src/server/reader-model.ts': 351
};

const TEST_RATCHET: Record<string, number> = {
  'tests/e2e/dark-theme-a11y.ts': 1040, 'tests/e2e/tier4-real-world.ts': 867, 'tests/e2e/shortcuts-i18n.ts': 710,
  'tests/e2e/reader-selection.ts': 684, 'tests/e2e/notebook-scenarios.ts': 622,
  'tests/e2e/book-reading.ts': 602, 'tests/e2e/discussion-continuity.ts': 553
};

const CSS_RATCHET: Record<string, number> = { 'public/reading-desk.css': 1127 };
const CSS_LONG_LINE_CAP: Record<string, number> = { 'public/reader.css': 6, 'public/annotations.css': 1 };
const AS_UNKNOWN_RATCHET: Record<string, number> = {
  'src/server/library.ts': 2, 'src/reader/pdf/extract.ts': 1, 'tests/pdf-outline-extraction.test.ts': 2
};
const EXPORT_ENTRYPOINT_ALLOW = new Set(['src/server/index.ts', 'src/client/dsh.ts']);

function walk(root: string, dir: string, ext: string, out: string[] = []): string[] {
  const full = path.join(root, dir);
  if (!existsSync(full)) return out;
  for (const name of readdirSync(full).sort()) {
    const rel = path.posix.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) walk(root, rel, ext, out);
    else if (name.endsWith(ext)) out.push(rel);
  }
  return out;
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function extractCssSelectors(css: string): Set<string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ''), selectors = new Set<string>(), atStack: boolean[] = [];
  let buf = '', depth = 0;
  for (const ch of clean) {
    if (ch === '{') {
      const header = buf.trim();
      buf = '';
      const isAt = header.startsWith('@');
      if (!isAt && (depth === 0 || atStack.every(Boolean))) {
        for (const part of header.split(',')) {
          const norm = part.replace(/\s+/g, ' ').trim();
          if (norm) selectors.add(norm);
        }
      }
      atStack.push(isAt);
      depth++;
    } else if (ch === '}') {
      buf = ''; depth = Math.max(0, depth - 1); atStack.pop();
    } else if (ch === ';' && (depth === 0 || atStack.at(-1))) {
      buf = '';
    } else buf += ch;
  }
  return selectors;
}

function checkFileSizes(root: string, srcFiles: string[], testFiles: string[], scriptFiles: string[], cssFiles: string[], failures: string[]): void {
  const check = (files: string[], ceiling: number, ratchet: Record<string, number>) => {
    for (const rel of files) {
      const count = lineCount(readFileSync(path.join(root, rel), 'utf8'));
      const base = ratchet[rel], limit = base !== undefined ? base + RATCHET_SLACK : ceiling;
      if (count > limit) failures.push(`size: ${rel} has ${count} lines (limit ${limit})`);
    }
  };
  check(srcFiles, 350, SRC_RATCHET);
  check(testFiles, 500, TEST_RATCHET);
  check(scriptFiles, 350, {});
  for (const rel of cssFiles) {
    const base = CSS_RATCHET[rel];
    if (base === undefined) continue;
    const count = lineCount(readFileSync(path.join(root, rel), 'utf8'));
    if (count > base + RATCHET_SLACK) failures.push(`size: ${rel} has ${count} lines (limit ${base + RATCHET_SLACK})`);
  }
}

function checkCss(root: string, cssFiles: string[], failures: string[]): void {
  for (const rel of cssFiles) {
    const text = readFileSync(path.join(root, rel), 'utf8'), lines = text.split(/\r?\n/);
    const longLines = lines.map((l, i) => ({ idx: i + 1, len: l.length })).filter(x => x.len > CSS_MAX_LINE_CHARS);
    const maxLong = CSS_LONG_LINE_CAP[rel] ?? 0;
    if (longLines.length > maxLong) failures.push(`css-line-length: ${rel} has ${longLines.length} lines > ${CSS_MAX_LINE_CHARS} chars (allowed ${maxLong}; first L${longLines[0].idx}=${longLines[0].len})`);
    const imp = lines.map((l, i) => ({ idx: i + 1, text: l })).filter(x => x.text.includes('!important'));
    if (rel === 'public/reader.css') {
      if (imp.length > 1 || imp.some(m => !m.text.includes('[hidden]'))) failures.push(`css-important: ${rel} has disallowed !important (${imp.length})`);
    } else if (rel === 'public/pdf-view.css') {
      if (imp.length > 9 || !text.includes('.pdf-sheet')) failures.push(`css-important: ${rel} has ${imp.length} !important (max 9 inside .pdf-sheet)`);
    } else if (imp.length > 0) failures.push(`css-important: ${rel} has ${imp.length} !important (first L${imp[0].idx})`);
  }
  const readerPath = path.join(root, 'public/reader.css'), deskPath = path.join(root, 'public/reading-desk.css');
  if (existsSync(readerPath) && existsSync(deskPath)) {
    const a = extractCssSelectors(readFileSync(readerPath, 'utf8'));
    const b = extractCssSelectors(readFileSync(deskPath, 'utf8'));
    const overlap = [...a].filter(sel => b.has(sel));
    if (overlap.length > CSS_OVERLAP_CAP) failures.push(`css-overlap: public/reader.css vs public/reading-desk.css share ${overlap.length} selectors (cap ${CSS_OVERLAP_CAP})`);
  }
}

function checkBannedPatterns(root: string, allFiles: string[], testFiles: string[], failures: string[]): void {
  const newFuncRe = new RegExp('new ' + 'Function\\('), evalRe = new RegExp('\\beval' + '\\(');
  const globalBans: [string, RegExp][] = [
    ['eslint' + '-disable', new RegExp('eslint' + '-disable')],
    ['@ts' + '-ignore', new RegExp('@ts' + '-ignore')],
    ['@ts' + '-expect-error', new RegExp('@ts' + '-expect-error')]
  ];
  const asUnknownRe = new RegExp('\\bas ' + 'unknown as\\b', 'g');
  for (const rel of testFiles) {
    readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (newFuncRe.test(line)) failures.push(`banned: ${rel}:${i + 1} contains new Function(`);
      if (evalRe.test(line)) failures.push(`banned: ${rel}:${i + 1} contains eval(`);
    });
  }
  for (const rel of allFiles) {
    const text = readFileSync(path.join(root, rel), 'utf8'), lines = text.split(/\r?\n/);
    for (const [label, re] of globalBans) {
      const hit = lines.findIndex(l => re.test(l));
      if (hit !== -1) failures.push(`banned: ${rel}:${hit + 1} contains ${label}`);
    }
    const hits = text.match(asUnknownRe)?.length ?? 0, cap = AS_UNKNOWN_RATCHET[rel] ?? 0;
    if (hits > cap) failures.push(`banned: ${rel} has ${hits} as-unknown-as casts (cap ${cap})`);
  }
}

function normalizeForDup(text: string): string[] {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
    .map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 0 && !l.startsWith('import ') && !/^[{}[\]();,]+$/.test(l));
}

function countCrossFileDupWindows(root: string, files: string[]): { count: number; samples: string[] } {
  const seen = new Map<string, string>(), matched = new Set<string>(), samples: string[] = [];
  for (const rel of files) {
    const lines = normalizeForDup(readFileSync(path.join(root, rel), 'utf8')), local = new Set<string>();
    for (let i = 0; i <= lines.length - DUP_WINDOW; i++) {
      const key = lines.slice(i, i + DUP_WINDOW).join('\n');
      if (local.has(key)) continue;
      local.add(key);
      const first = seen.get(key);
      if (!first) seen.set(key, rel);
      else if (first !== rel && !matched.has(key)) {
        matched.add(key);
        if (samples.length < 5) samples.push(`${first} <-> ${rel}: ${lines[i].slice(0, 60)}`);
      }
    }
  }
  return { count: matched.size, samples };
}

function checkDuplication(root: string, srcFiles: string[], testFiles: string[], failures: string[]): void {
  const srcDup = countCrossFileDupWindows(root, srcFiles);
  if (srcDup.count > 0) failures.push(`duplication: src/ has ${srcDup.count} cross-file ${DUP_WINDOW}-line duplicate windows (${srcDup.samples.join('; ')})`);
  const testDup = countCrossFileDupWindows(root, testFiles);
  if (testDup.count > TEST_DUP_CAP) failures.push(`duplication: tests/ has ${testDup.count} cross-file ${DUP_WINDOW}-line duplicate windows (cap ${TEST_DUP_CAP}; ${testDup.samples.join('; ')})`);
}

function extractExports(text: string): string[] {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), names = new Set<string>();
  for (const m of stripped.matchAll(/^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of stripped.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const cleaned = part.replace(/^\s*type\s+/, '').trim();
      if (!cleaned) continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(cleaned);
      names.add(asMatch ? asMatch[1] : cleaned);
    }
  }
  return [...names];
}

function checkDeadExports(root: string, srcFiles: string[], allRefFiles: string[], failures: string[]): void {
  const contents = new Map(allRefFiles.map(rel => [rel, readFileSync(path.join(root, rel), 'utf8')]));
  const dead: string[] = [];
  for (const rel of srcFiles) {
    if (EXPORT_ENTRYPOINT_ALLOW.has(rel)) continue;
    for (const name of extractExports(contents.get(rel) ?? '')) {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      let used = false;
      for (const [other, content] of contents) if (other !== rel && re.test(content)) { used = true; break; }
      if (!used) dead.push(`${rel}:${name}`);
    }
  }
  if (dead.length > 0) failures.push(`dead-exports: ${dead.length} unused src/ exports (${dead.slice(0, 10).join(', ')})`);
}

function checkRepeatedI18n(root: string, srcFiles: string[], failures: string[]): void {
  const pairFiles = new Map<string, Set<string>>();
  const re = /\b(?:readerLabel|extLabel|label)\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
  for (const rel of srcFiles) {
    for (const m of readFileSync(path.join(root, rel), 'utf8').matchAll(re)) {
      const key = `${m[1]} / ${m[2]}`;
      const set = pairFiles.get(key) ?? new Set<string>();
      set.add(rel);
      pairFiles.set(key, set);
    }
  }
  const repeated = [...pairFiles.entries()].filter(([, files]) => files.size >= 3);
  if (repeated.length > I18N_REPEAT_CAP) {
    failures.push(`i18n-repeats: ${repeated.length} (en, zh) pairs repeated across >=3 src/ files (cap ${I18N_REPEAT_CAP}): ${repeated.map(([k, f]) => `${k} (${f.size})`).join(', ')}`);
  }
}

function runDiffReport(root: string, ref: string, strict: boolean, failures: string[]): void {
  const out = execFileSync('git', ['diff', '--numstat', ref, '--', '.', ':!dist', ':!package-lock.json'], { cwd: root, encoding: 'utf8' });
  let prodAdd = 0, prodDel = 0, testAdd = 0, testDel = 0;
  for (const line of out.split(/\r?\n/)) {
    const [aStr, dStr, file] = line.split('\t');
    if (!file || aStr === '-' || dStr === '-') continue;
    const a = Number(aStr), d = Number(dStr);
    if (file.startsWith('tests/') || file.endsWith('.test.ts')) { testAdd += a; testDel += d; }
    else { prodAdd += a; prodDel += d; }
  }
  const totalAdd = prodAdd + testAdd, totalDel = prodDel + testDel, net = totalAdd - totalDel;
  const ratio = prodAdd > 0 ? (testAdd / prodAdd).toFixed(2) : testAdd > 0 ? 'inf' : '0.00';
  console.log(`Diff vs ${ref} (excl. dist/lock): +${totalAdd} / -${totalDel} (net ${net >= 0 ? '+' : ''}${net})`);
  console.log(`Prod: +${prodAdd}/-${prodDel} | Test: +${testAdd}/-${testDel} | Test:Prod added ratio: ${ratio}:1`);
  if (strict && prodAdd > 0 && testAdd / prodAdd > 2.5) failures.push(`diff-budget: test-to-prod added ratio ${ratio}:1 exceeds 2.5:1`);
}

function main(): void {
  const args = process.argv.slice(2);
  let root = process.cwd(), diffRef = '', strictDiff = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[++i]);
    else if (args[i] === '--diff' && args[i + 1]) diffRef = args[++i];
    else if (args[i] === '--strict-diff') strictDiff = true;
  }
  const srcFiles = walk(root, 'src', '.ts'), testFiles = walk(root, 'tests', '.ts');
  const scriptFiles = walk(root, 'scripts', '.ts'), cssFiles = walk(root, 'public', '.css');
  const allTsFiles = [...srcFiles, ...testFiles, ...scriptFiles];
  const allRefFiles = [...allTsFiles, ...walk(root, 'tests', '.mjs')];
  const failures: string[] = [];
  checkFileSizes(root, srcFiles, testFiles, scriptFiles, cssFiles, failures);
  checkCss(root, cssFiles, failures);
  checkBannedPatterns(root, allTsFiles, testFiles, failures);
  checkDuplication(root, srcFiles, testFiles, failures);
  checkDeadExports(root, srcFiles, allRefFiles, failures);
  checkRepeatedI18n(root, srcFiles, failures);
  if (diffRef) runDiffReport(root, diffRef, strictDiff, failures);
  if (failures.length > 0) {
    console.error(`HYGIENE CHECK FAILED (${failures.length} violations):`);
    for (const f of failures) console.error(' - ' + f);
    process.exit(1);
  }
  console.log(`PASS hygiene check (${srcFiles.length} src, ${testFiles.length} tests, ${scriptFiles.length} scripts, ${cssFiles.length} css).`);
}

main();
