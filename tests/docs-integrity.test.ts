import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
interface PackageJson { scripts?: Record<string, string>; bin?: Record<string, string> | string; }
interface PackageLock { packages?: Record<string, { hasInstallScript?: boolean; dev?: boolean }>; }

function stripFencedCode(md: string): string {
  let fenceChar: '`' | '~' | null = null, fenceLen = 0;
  return md.split(/\r?\n/).map(line => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceChar === null) {
      if (match) { fenceChar = match[1][0] as '`' | '~'; fenceLen = match[1].length; return ''; }
      return line;
    }
    const close = (fenceChar === '`' ? /^\s*(`{3,})\s*$/ : /^\s*(~{3,})\s*$/).exec(line);
    if (close && close[1].length >= fenceLen) { fenceChar = null; fenceLen = 0; }
    return '';
  }).join('\n');
}

function githubHeadingSlug(rawHeading: string): string {
  return rawHeading
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(
      /`([^`]+)`|(\*\*)(.*?)\2|(?<![\p{L}\p{N}_])(__)(.*?)\4(?![\p{L}\p{N}_])|(\*)(.*?)\6|(?<![\p{L}\p{N}_])(_)(.*?)\8(?![\p{L}\p{N}_])/gu,
      (_, code, _b, bold, _ub, ubold, _i, ital, _ui, uital) => code ?? bold ?? ubold ?? ital ?? uital ?? ''
    )
    .replace(/<[^>]+>/g, '')
    .trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
}

function extractHeadingSlugs(md: string): Set<string> {
  const slugs = new Set<string>(), counts = new Map<string, number>();
  for (const line of stripFencedCode(md).split(/\r?\n/)) {
    const match = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    const base = match ? githubHeadingSlug(match[1]) : '';
    if (!base) continue;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

function findBrokenRelativeLinks(md: string, docRelPath: string, root: string, cache = new Map<string, Set<string>>()): string[] {
  const violations: string[] = [], docAbs = path.resolve(root, docRelPath), curSlugs = extractHeadingSlugs(md);
  cache.set(docAbs, curSlugs);
  stripFencedCode(md).split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let raw = m[1].trim();
      raw = raw.startsWith('<') && raw.includes('>') ? raw.slice(1, raw.indexOf('>')).trim() : raw.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim();
      if (!raw) { violations.push(`${docRelPath}:${i + 1} empty link target`); continue; }
      if (/^(?:https?:|mailto:|tel:)/i.test(raw)) continue;
      const [beforeHash, rawAnchor = ''] = raw.split('#', 2);
      let filePart = beforeHash.split('?', 1)[0], anchorPart = rawAnchor;
      try { filePart = decodeURIComponent(filePart); anchorPart = decodeURIComponent(anchorPart); }
      catch { violations.push(`${docRelPath}:${i + 1} malformed percent-encoding in "${raw}"`); continue; }
      if (!filePart) {
        if (!anchorPart || !curSlugs.has(anchorPart.toLowerCase())) violations.push(`${docRelPath}:${i + 1} broken anchor "#${anchorPart}"`);
        continue;
      }
      const resolved = path.resolve(path.dirname(docAbs), filePart);
      if (!existsSync(resolved)) { violations.push(`${docRelPath}:${i + 1} missing target "${filePart}"`); continue; }
      if (anchorPart && resolved.endsWith('.md')) {
        const targetSlugs = cache.get(resolved) ?? extractHeadingSlugs(readFileSync(resolved, 'utf8'));
        cache.set(resolved, targetSlugs);
        if (!targetSlugs.has(anchorPart.toLowerCase())) violations.push(`${docRelPath}:${i + 1} broken anchor "${filePart}#${anchorPart}"`);
      }
    }
  });
  return violations;
}

function extractRequiredAllowBuildPackages(lockJson: PackageLock): Set<string> {
  const required = new Set<string>();
  for (const [pkgPath, meta] of Object.entries(lockJson.packages ?? {})) {
    if (!meta.hasInstallScript || meta.dev) continue;
    const idx = pkgPath.lastIndexOf('node_modules/');
    if (idx !== -1) required.add(pkgPath.slice(idx + 13));
  }
  return required;
}

function findInvalidCliCommands(md: string, pkgJson: PackageJson, lockJson: PackageLock): string[] {
  const violations: string[] = [], scripts = pkgJson.scripts ?? {};
  const bins = typeof pkgJson.bin === 'string' ? new Set([pkgJson.bin]) : new Set(Object.keys(pkgJson.bin ?? {}));
  const required = extractRequiredAllowBuildPackages(lockJson);
  for (const m of md.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) if (!(m[1] in scripts)) violations.push(`unknown npm script "npm run ${m[1]}"`);
  for (const m of md.matchAll(/\bdsh\s+plugin\b[^\n]*?\bexec\s+([A-Za-z0-9._-]+)/g)) if (!bins.has(m[1])) violations.push(`unknown dsh plugin exec binary "${m[1]}"`);
  for (const m of md.matchAll(/--allow-build=([@A-Za-z0-9._/-]+)/g)) if (!required.has(m[1])) violations.push(`stale or unknown --allow-build=${m[1]}`);
  for (const line of md.split(/\r?\n/)) {
    if (!/\bdsh\s+plugin\b/.test(line)) continue;
    const declared = new Set<string>();
    for (const m of line.matchAll(/--allow-build(?:=|\s+)((?!-)[@A-Za-z0-9._/-]+)/g)) {
      declared.add(m[1]);
      if (!required.has(m[1]) && !m[0].includes('=')) violations.push(`stale or unknown --allow-build ${m[1]}`);
    }
    if (/\badd\b/.test(line)) for (const pkg of required) if (!declared.has(pkg)) violations.push(`dsh plugin add line missing --allow-build=${pkg}`);
  }
  return violations;
}

function findEnvironmentLeaks(md: string): string[] {
  return [
    ...[...md.matchAll(/(?::|port[\s=]+)3080\b/gi)].map(m => `hardcoded port 3080 ("${m[0]}")`),
    ...[...md.matchAll(/(?:^|[\s(`"'=:]|file:\/\/)(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/gi)].map(m => `private local path ("${m[0].trim()}")`)
  ];
}

const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
const lockJson = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as PackageLock;
const docs = ['README.md', '交付说明.md'].map(relPath => ({ relPath, content: readFileSync(path.join(repoRoot, relPath), 'utf8') }));

describe('documentation integrity (README.md and 交付说明.md)', () => {
  test('relative links, anchors, bidirectional cross-links, npm scripts, and install flags resolve', () => {
    const cache = new Map<string, Set<string>>();
    for (const doc of docs) {
      assert.deepEqual(findBrokenRelativeLinks(doc.content, doc.relPath, repoRoot, cache), [], `${doc.relPath} broken links`);
      assert.deepEqual(findInvalidCliCommands(doc.content, pkgJson, lockJson), [], `${doc.relPath} invalid CLI commands`);
    }
    assert.match(docs[0].content, /\((?:\.\/)?交付说明\.md(?:#[^)]+)?\)/, 'README.md should link to 交付说明.md');
    assert.match(docs[1].content, /\((?:\.\/)?README\.md(?:#[^)]+)?\)/, '交付说明.md should link to README.md');
  });
  test('zero hardcoded conflicting ports or private local paths', () => {
    for (const doc of docs) assert.deepEqual(findEnvironmentLeaks(doc.content), [], `${doc.relPath} environment leaks`);
  });
});
