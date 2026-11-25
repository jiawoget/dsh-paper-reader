import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const RATCHET_SLACK = 10, CSS_MAX_LINE_CHARS = 240, CSS_OVERLAP_CAP = 0, DUP_WINDOW = 8, TEST_DUP_CAP = 7, I18N_REPEAT_CAP = 8;

const SRC_RATCHET: Record<string, number> = {
  'src/reader/app.ts': 933, 'src/reader/pdf-view.ts': 679, 'src/reader/notebook.ts': 585,
  'src/reader/selection-chat.ts': 534, 'src/reader/selection-card.ts': 508, 'src/server/reader-store.ts': 480,
  'src/shared/citation-export.ts': 437, 'src/reader/paper-chat.ts': 413,
  'src/reader/article-view.ts': 395, 'src/reader/annotation-layer.ts': 377, 'src/server/library.ts': 362,
  'src/reader/reading-desk.ts': 358, 'src/server/reader-model.ts': 351
};

const TEST_RATCHET: Record<string, number> = {
  'tests/e2e/dark-theme-a11y.ts': 1010, 'tests/e2e/tier4-real-world.ts': 846, 'tests/e2e/shortcuts-i18n.ts': 702,
  'tests/e2e/reader-selection.ts': 684, 'tests/e2e/notebook-scenarios.ts': 622,
  'tests/e2e/book-reading.ts': 602, 'tests/e2e/discussion-continuity.ts': 553
};

const CSS_RATCHET: Record<string, number> = { 'public/reading-desk.css': 954 };
const CSS_LONG_LINE_CAP: Record<string, number> = { 'public/annotations.css': 1 };
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(?<![:\\])\/\/[^\n]*/g, '');
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCss(css: string): { selectors: Set<string>; rules: { selector: string; body: string }[] } {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ''), selectors = new Set<string>(), rules: { selector: string; body: string }[] = [];
  const stack: { selector: string; isAt: boolean; body: string }[] = [];
  let buf = '';
  for (const ch of clean) {
    const top = stack.at(-1);
    if (ch === '{') {
      const header = buf.trim();
      buf = '';
      const isAt = header.startsWith('@');
      if (!isAt && (!top || stack.every(f => f.isAt))) {
        for (const part of splitTopLevelCommas(header)) {
          const norm = part.replace(/\s+/g, ' ').trim();
          if (norm) selectors.add(norm);
        }
      }
      stack.push({ selector: isAt ? '' : header, isAt, body: '' });
    } else if (ch === '}') {
      const popped = stack.pop();
      if (popped) {
        if (!popped.isAt) rules.push({ selector: popped.selector, body: popped.body + buf });
        else if (buf.trim()) rules.push({ selector: '', body: buf });
      }
      buf = '';
    } else if (ch === ';' && (!top || top.isAt)) {
      if (/!\s*important\b/i.test(buf)) rules.push({ selector: '', body: buf });
      buf = '';
    } else if (top && !top.isAt) {
      top.body += ch;
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) rules.push({ selector: '', body: buf });
  for (const frame of stack) if (frame.body.trim()) rules.push({ selector: frame.isAt ? '' : frame.selector, body: frame.body });
  return { selectors, rules };
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
  const impRe = /!\s*important\b/gi, pdfSheetRe = /(?:^|[\s>+~,(])\.pdf-sheet(?![\w-])/;
  const parsedByRel = new Map<string, ReturnType<typeof parseCss>>();
  for (const rel of cssFiles) {
    const text = readFileSync(path.join(root, rel), 'utf8'), lines = text.split(/\r?\n/);
    const longLines = lines.map((l, i) => ({ idx: i + 1, len: l.length })).filter(x => x.len > CSS_MAX_LINE_CHARS);
    const maxLong = CSS_LONG_LINE_CAP[rel] ?? 0;
    if (longLines.length > maxLong) failures.push(`css-line-length: ${rel} has ${longLines.length} lines > ${CSS_MAX_LINE_CHARS} chars (allowed ${maxLong}; first L${longLines[0].idx}=${longLines[0].len})`);
    const parsed = parseCss(text);
    parsedByRel.set(rel, parsed);
    let totalImp = 0, badImp = 0;
    for (const rule of parsed.rules) {
      const hits = rule.body.match(impRe)?.length ?? 0;
      if (!hits) continue;
      totalImp += hits;
      const parts = splitTopLevelCommas(rule.selector).map(s => s.trim()).filter(Boolean);
      const allowed =
        rel === 'public/reader.css' ? parts.length > 0 && parts.every(p => p.includes('[hidden]')) :
        rel === 'public/pdf-view.css' ? parts.length > 0 && parts.every(p => pdfSheetRe.test(p)) :
        false;
      if (!allowed) badImp += hits;
    }
    const maxImp = rel === 'public/reader.css' ? 1 : rel === 'public/pdf-view.css' ? 9 : 0;
    if (badImp > 0 || totalImp > maxImp) failures.push(`css-important: ${rel} has ${totalImp} !important (${badImp} outside allowed selector, max ${maxImp})`);
  }
  const readerParsed = parsedByRel.get('public/reader.css'), deskParsed = parsedByRel.get('public/reading-desk.css');
  if (readerParsed && deskParsed) {
    const overlap = [...readerParsed.selectors].filter(sel => deskParsed.selectors.has(sel));
    if (overlap.length > CSS_OVERLAP_CAP) failures.push(`css-overlap: public/reader.css vs public/reading-desk.css share ${overlap.length} selectors (cap ${CSS_OVERLAP_CAP})`);
  }
}

function checkBannedPatterns(root: string, allFiles: string[], testFiles: string[], failures: string[]): void {
  const newFuncRe = new RegExp('\\bnew\\s+' + 'Function\\s*\\(');
  const evalRe = new RegExp('(?:^|[^.\\w$])' + 'eval\\s*\\(|\\(\\s*0\\s*,\\s*' + 'eval\\s*\\)\\s*\\(');
  const globalBans: [string, RegExp][] = [
    ['eslint' + '-disable', new RegExp('eslint' + '-disable')],
    ['@ts' + '-ignore', new RegExp('@ts' + '-ignore')],
    ['@ts' + '-expect-error', new RegExp('@ts' + '-expect-error')]
  ];
  const asUnknownRe = new RegExp('\\bas\\s+' + 'unknown\\s+as\\b', 'g');
  for (const rel of testFiles) {
    const stripped = stripComments(readFileSync(path.join(root, rel), 'utf8'));
    const nf = newFuncRe.exec(stripped);
    if (nf) failures.push(`banned: ${rel}:${stripped.slice(0, nf.index).split('\n').length} contains new Function(`);
    const ev = evalRe.exec(stripped);
    if (ev) failures.push(`banned: ${rel}:${stripped.slice(0, ev.index).split('\n').length} contains eval(`);
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

function extractExports(stripped: string): string[] {
  const names = new Set<string>();
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
  const contents = new Map(allRefFiles.map(rel => [rel, stripComments(readFileSync(path.join(root, rel), 'utf8'))]));
  const dead: string[] = [];
  for (const rel of srcFiles) {
    if (EXPORT_ENTRYPOINT_ALLOW.has(rel)) continue;
    for (const name of extractExports(contents.get(rel) ?? '')) {
      const re = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`);
      let used = false;
      for (const [other, content] of contents) if (other !== rel && re.test(content)) { used = true; break; }
      if (!used) dead.push(`${rel}:${name}`);
    }
  }
  if (dead.length > 0) failures.push(`dead-exports: ${dead.length} unused src/ exports (${dead.slice(0, 10).join(', ')})`);
}

function checkRepeatedI18n(root: string, srcFiles: string[], failures: string[]): void {
  const pairFiles = new Map<string, Set<string>>();
  for (const rel of srcFiles) {
    const text = stripComments(readFileSync(path.join(root, rel), 'utf8'));
    const names = new Set(['readerLabel', 'extLabel', 'label']);
    for (const m of text.matchAll(/\b(?:readerLabel|extLabel)\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    const callRe = new RegExp(`(?<![.\\w$])(?:${[...names].map(escapeRe).join('|')})\\(\\s*(['"])([^'"]+)\\1\\s*,\\s*(['"])([^'"]+)\\3\\s*\\)`, 'g');
    for (const m of text.matchAll(callRe)) {
      const key = `${m[2]} / ${m[4]}`;
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
