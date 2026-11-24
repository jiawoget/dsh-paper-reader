import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

type DocLang = 'en' | 'zh';

interface PackageJson {
  scripts?: Record<string, string>;
  bin?: Record<string, string> | string;
}

interface PackageLock {
  packages?: Record<string, { hasInstallScript?: boolean; dev?: boolean }>;
}

const EN_BANNED_SLOP_WORDS = [
  'delve', 'delves', 'delving', 'delved',
  'foster', 'fosters', 'fostering', 'fostered',
  'leverage', 'leverages', 'leveraging', 'leveraged',
  'utilize', 'utilizes', 'utilizing', 'utilized',
  'facilitate', 'facilitates', 'facilitating', 'facilitated',
  'empower', 'empowers', 'empowering', 'empowered',
  'streamline', 'streamlines', 'streamlining', 'streamlined',
  'elevate', 'elevates', 'elevating', 'elevated',
  'harness', 'harnesses', 'harnessing', 'harnessed',
  'robust', 'cutting-edge', 'paradigm shift', 'game changer', 'this is huge',
  'this changes everything', 'tapestry', 'realm', 'beacon', 'multifaceted',
  'meticulous', 'intricate', 'paramount', 'transformative', 'embark',
  'supercharge', 'ever-evolving',
  'seamless', 'seamlessly', 'effortless', 'effortlessly', 'holistic', 'synergy',
  'revolutionize', 'groundbreaking', 'next-generation', 'comprehensive'
];

const EN_BANNED_SLOP_PHRASES = [
  "it's worth noting", "it's important to note", 'at the end of the day',
  "in today's world", 'in the age of', 'in the world of', "let's dive in",
  "here's the thing", 'let me be clear', 'stands as a testament',
  'marks a pivotal moment', 'plays a vital role', 'in conclusion',
  'ultimately,', 'overall,'
];

const ZH_BANNED_SLOP_PHRASES = [
  '赋能', '一站式', '无缝', '全方位', '深度融合', '全面提升', '重塑', '颠覆',
  '极致体验', '丝滑', '助力', '生态体系', '痛点', '抓手', '值得注意',
  '总而言之', '综上所述', '不难发现', '归根结底'
];

const ZH_ALLOWED_PROSE_WORDS = new Set([
  'dsh', 'deepseek', 'harness', 'paper', 'reader', 'pdf', 'url', 'web',
  'chrome', 'edge', 'obsidian', 'zotero', 'openstax', 'bibtex', 'ris', 'bib',
  'doi', 'arxiv', 'markdown', 'html', 'api', 'http', 'https', 'ocr', 'node',
  'npm', 'zip', 'github', 'opus', 'sha', 'ascii', 'latex', 'typescript',
  'sqlite', 'cpu', 'llm', 'ctrl', 'cmd', 'shift', 'alt', 'esc', 'enter',
  'home', 'end', 'pagedattention', 'english', 'readme', 'sosp', 'kwon'
]);

function stripFencedCode(md: string): string {
  const lines = md.split(/\r?\n/);
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  return lines.map(line => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceChar === null) {
      if (match) {
        fenceChar = match[1]![0] as '`' | '~';
        fenceLen = match[1]!.length;
        return '';
      }
      return line;
    }
    const closeRe = fenceChar === '`' ? /^\s*(`{3,})\s*$/ : /^\s*(~{3,})\s*$/;
    const close = closeRe.exec(line);
    if (close && close[1]!.length >= fenceLen) {
      fenceChar = null;
      fenceLen = 0;
    }
    return '';
  }).join('\n');
}

function isTechnicalInlineCode(raw: string): boolean {
  const s = raw.trim();
  if (!s) return true;
  if (/^(?:npm|npx|dsh|node|git|tsx|curl|cd)\s+/i.test(s)) return true;
  if (/^paper-reader-[a-z0-9-]+$/i.test(s)) return true;
  if (/^--[a-z0-9-]+(?:[=\s]\S+)?$/i.test(s)) return true;
  if (/^(?:https?:\/\/|localhost:\d+|127\.0\.0\.1:\d+)/i.test(s)) return true;
  if (/^\$?[A-Z][A-Z0-9_]{2,}(?:=\S+)?$/.test(s)) return true;
  if (/^(?:github|node):[^\s]+$/i.test(s)) return true;
  if (/^[a-z0-9@._-]+(?:[-:][a-z0-9._-]+)+$/i.test(s) && !s.includes(' ')) return true;
  if (/^[a-z][a-z0-9]+js$/i.test(s)) return true;
  if (/^(?:\.\.?\/|~\/|\$[A-Z0-9_]+\/|<[^>\n]+>\/)/.test(s)) return true;
  if (s.includes('/') && !/\s\/|\/\s/.test(s) && /^(?:[\w.* -]+\/)+[\w.* -]*$/.test(s)) return true;
  if (/^\.[a-z0-9]{1,8}$/i.test(s)) return true;
  if (/^[\w.*-]+\.(?:md|ts|js|mjs|cjs|json|ya?ml|css|html|pdf|bib|ris|txt|sh)$/i.test(s)) return true;
  if (/^[.#][a-zA-Z_-][\w-]*$/.test(s)) return true;
  if (/^[a-zA-Z0-9_.*-]*\[[^\]]+\]$/.test(s)) return true;
  if (/^<[^>\n]+>$/.test(s)) return true;
  if (/^[a-z0-9_-]+(?:_\*|\.\*)$/i.test(s)) return true;
  if (/^[a-z-]+:\s*[a-z0-9-]+$/i.test(s)) return true;
  if (/^(?:Node\.js\s+)?[><=~^]*\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?$/i.test(s)) return true;
  if (/^[0-9a-f]{7,40}$/i.test(s)) return true;
  if (/^(?:[A-Za-z0-9?+=-]|[←→↑↓]|Esc|Enter|Tab|Space|Home|End|PageUp|PageDown|Backspace|Delete|(?:(?:Ctrl|Cmd|Shift|Alt|Meta)(?:\/(?:Ctrl|Cmd|Shift|Alt|Meta))*\+)+(?:[A-Za-z0-9?+=-]|Enter|Esc|Tab|Space|[←→↑↓]))$/.test(s)) {
    return true;
  }
  return false;
}

function stripTechnicalInlineCodeAndUrls(md: string): string {
  return md
    .replace(/`([^`\n]+)`/g, (_match, inner: string) => (isTechnicalInlineCode(inner) ? ' ' : inner))
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');
}

function githubHeadingSlug(rawHeading: string): string {
  const plain = rawHeading
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase();
  return plain
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
}

function extractHeadingSlugs(md: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of stripFencedCode(md).split(/\r?\n/)) {
    const match = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = githubHeadingSlug(match[1]!);
    if (!base) continue;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

function findBrokenRelativeLinks(
  md: string,
  docRelPath: string,
  root: string,
  headingCache: Map<string, Set<string>> = new Map()
): string[] {
  const violations: string[] = [];
  const docAbsPath = path.resolve(root, docRelPath);
  const currentSlugs = extractHeadingSlugs(md);
  headingCache.set(docAbsPath, currentSlugs);

  const lines = stripFencedCode(md).split(/\r?\n/);
  const linkRe = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const match of line.matchAll(linkRe)) {
      let rawTarget = match[1]!.trim();
      if (rawTarget.startsWith('<') && rawTarget.includes('>')) {
        rawTarget = rawTarget.slice(1, rawTarget.indexOf('>')).trim();
      } else {
        rawTarget = rawTarget.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim();
      }
      if (!rawTarget) {
        violations.push(`${docRelPath}:${i + 1} empty link target`);
        continue;
      }
      if (/^(?:https?:|mailto:|tel:)/i.test(rawTarget)) continue;

      const hashIndex = rawTarget.indexOf('#');
      const rawWithoutHash = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
      const queryIndex = rawWithoutHash.indexOf('?');
      const rawFile = queryIndex === -1 ? rawWithoutHash : rawWithoutHash.slice(0, queryIndex);
      const rawAnchor = hashIndex === -1 ? '' : rawTarget.slice(hashIndex + 1);

      let filePart = rawFile;
      let anchorPart = rawAnchor;
      try {
        filePart = decodeURIComponent(rawFile);
        anchorPart = decodeURIComponent(rawAnchor);
      } catch {
        violations.push(`${docRelPath}:${i + 1} malformed percent-encoding in "${rawTarget}"`);
        continue;
      }

      if (!filePart) {
        if (!anchorPart || !currentSlugs.has(anchorPart.toLowerCase())) {
          violations.push(`${docRelPath}:${i + 1} broken anchor "#${anchorPart}"`);
        }
        continue;
      }

      const resolved = path.resolve(path.dirname(docAbsPath), filePart);
      if (!existsSync(resolved)) {
        violations.push(`${docRelPath}:${i + 1} missing target "${filePart}"`);
        continue;
      }
      if (anchorPart && resolved.endsWith('.md')) {
        let targetSlugs = headingCache.get(resolved);
        if (!targetSlugs) {
          targetSlugs = extractHeadingSlugs(readFileSync(resolved, 'utf8'));
          headingCache.set(resolved, targetSlugs);
        }
        if (!targetSlugs.has(anchorPart.toLowerCase())) {
          violations.push(`${docRelPath}:${i + 1} broken anchor "${filePart}#${anchorPart}"`);
        }
      }
    }
  }
  return violations;
}

function extractRequiredAllowBuildPackages(lockJson: PackageLock): Set<string> {
  const required = new Set<string>();
  for (const [pkgPath, meta] of Object.entries(lockJson.packages ?? {})) {
    if (!meta.hasInstallScript || meta.dev) continue;
    const marker = 'node_modules/';
    const idx = pkgPath.lastIndexOf(marker);
    if (idx === -1) continue;
    required.add(pkgPath.slice(idx + marker.length));
  }
  return required;
}

function findInvalidCliCommands(md: string, pkgJson: PackageJson, lockJson: PackageLock): string[] {
  const violations: string[] = [];
  const scripts = pkgJson.scripts ?? {};
  const bins = typeof pkgJson.bin === 'string' ? new Set([pkgJson.bin]) : new Set(Object.keys(pkgJson.bin ?? {}));
  const requiredAllowBuild = extractRequiredAllowBuildPackages(lockJson);

  for (const match of md.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
    const script = match[1]!;
    if (!(script in scripts)) {
      violations.push(`unknown npm script "npm run ${script}"`);
    }
  }

  for (const match of md.matchAll(/\bdsh\s+plugin\b[^\n]*?\bexec\s+([A-Za-z0-9._-]+)/g)) {
    const bin = match[1]!;
    if (!bins.has(bin)) {
      violations.push(`unknown dsh plugin exec binary "${bin}"`);
    }
  }

  for (const match of md.matchAll(/--allow-build=([@A-Za-z0-9._/-]+)/g)) {
    const pkg = match[1]!;
    if (!requiredAllowBuild.has(pkg)) {
      violations.push(`stale or unknown --allow-build=${pkg}`);
    }
  }

  const allowBuildArgRe = /--allow-build(?:=|\s+)((?!-)[@A-Za-z0-9._/-]+)/g;
  for (const line of md.split(/\r?\n/)) {
    if (!/\bdsh\s+plugin\b/.test(line)) continue;
    const declared = new Set<string>();
    for (const m of line.matchAll(allowBuildArgRe)) {
      const pkg = m[1]!;
      declared.add(pkg);
      if (!requiredAllowBuild.has(pkg) && !m[0].includes('=')) {
        violations.push(`stale or unknown --allow-build ${pkg}`);
      }
    }
    if (!/\badd\b/.test(line)) continue;
    for (const pkg of requiredAllowBuild) {
      if (!declared.has(pkg)) {
        violations.push(`dsh plugin add line missing --allow-build=${pkg}`);
      }
    }
  }

  return violations;
}

function checkStructure(md: string): { h2Count: number; maxConsecutiveBullets: number } {
  const lines = stripFencedCode(md).split(/\r?\n/);
  let h2Count = 0;
  let maxBullets = 0;
  let currentBullets = 0;
  let inList = false;

  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      h2Count++;
      inList = false;
      currentBullets = 0;
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      inList = true;
      currentBullets++;
      if (currentBullets > maxBullets) maxBullets = currentBullets;
      continue;
    }
    if (inList && (line.trim() === '' || /^\s{2,}\S/.test(line))) {
      continue;
    }
    inList = false;
    currentBullets = 0;
  }

  return { h2Count, maxConsecutiveBullets: maxBullets };
}

function checkTerminology(md: string, lang: DocLang): { missing: string[]; banned: string[] } {
  const prose = stripTechnicalInlineCodeAndUrls(stripFencedCode(md));
  const missing: string[] = [];
  const banned: string[] = [];

  if (lang === 'en') {
    const required: [string, RegExp][] = [
      ['Marks', /\bMarks\b/],
      ['Paper chat', /\bPaper chat\b/],
      ['Section chat', /\bSection chat\b/],
      ['Notes', /\bNotes\b/],
      ['Obsidian vault', /\bObsidian vault\b/]
    ];
    for (const [label, re] of required) {
      if (!re.test(prose)) missing.push(label);
    }
    const bannedPatterns: RegExp[] = [
      /\b(?:Annotations?|Paper conversation|Paper discussion|Reading discussion|Reading notebook|Notebook|Add to notebook|Refresh notebook)\b/gi,
      /\bHighlights\s+(?:tab|panel|sidebar)\b/gi,
      /^#{1,6}\s+.*\bannotate\b/gim
    ];
    for (const re of bannedPatterns) {
      for (const m of prose.matchAll(re)) banned.push(m[0]);
    }
  } else {
    const required = ['标记', '全文问答', '本节问答', '笔记', 'Obsidian 笔记库'];
    for (const term of required) {
      if (!prose.includes(term)) missing.push(term);
    }
    const bannedRe = /(?:阅读笔记本|笔记本|批注索引|批注|Obsidian\s*仓库|已存入仓库|存入仓库|刷新笔记本|加入笔记本)/g;
    for (const m of prose.matchAll(bannedRe)) banned.push(m[0]);
  }

  return { missing, banned };
}

function findUntranslatedZhUiTerms(md: string): string[] {
  const prose = stripTechnicalInlineCodeAndUrls(stripFencedCode(md));
  const violations: string[] = [];

  const bannedUiRe = /\b(?:Connection settings|Local DSH address|Library|Contents|Reference|Paper chat|Section chat|Marks|Notes|Keyboard shortcuts|More actions|Vocabulary and history|Reset reading layout|Original|Bilingual|Enable selection cards|Open in Paper Reader|Open web page|Open book|On this device|Add to Notes|Refresh notes|Ask with a screenshot|Write note|Compare latest|In Marks only|In Notes)\b/gi;
  for (const m of prose.matchAll(bannedUiRe)) {
    violations.push(`untranslated UI label "${m[0]}"`);
  }

  for (const m of prose.matchAll(/\b[A-Za-z]{3,}\b/g)) {
    const word = m[0];
    if (!ZH_ALLOWED_PROSE_WORDS.has(word.toLowerCase())) {
      violations.push(`non-allowlisted English prose word "${word}"`);
    }
  }

  return violations;
}

function findMissingFeatures(md: string, lang: DocLang): string[] {
  const missing: string[] = [];
  const checks: [string, () => boolean][] = lang === 'en'
    ? [
        ['target-language', () => /translation language|target language/i.test(md) && /custom/i.test(md)],
        ['citation-export', () => /\bBibTeX\b/.test(md) && /\bRIS\b/.test(md) && /\.bib\b/.test(md) && /\.ris\b/.test(md)],
        ['dark-theme', () => /dark mode|dark theme/i.test(md) && /prefers-color-scheme/.test(md)],
        ['keyboard-shortcuts', () => /keyboard shortcuts/i.test(md) && md.includes('?')],
        ['bilingual-ui', () => /\bEnglish\b/.test(md) && /\bChinese\b/.test(md) && /locale/i.test(md)],
        ['zotero', () => /\bZotero\b/.test(md)],
        ['obsidian-vault', () => /\bObsidian vault\b/.test(md)],
        ['openstax', () => /\bOpenStax\b/.test(md)],
        ['browser-extension', () => /\bextension\b/i.test(md) && /\bChrome\b/.test(md) && /\bEdge\b/.test(md)],
        ['offline-mt', () => /paper-reader-install-model/.test(md) && (/OPUS-MT/i.test(md) || /offline/i.test(md))]
      ]
    : [
        ['target-language', () => /(?:翻译目标语言|目标语言)/.test(md) && md.includes('自定义')],
        ['citation-export', () => /\bBibTeX\b/.test(md) && /\bRIS\b/.test(md) && /\.bib\b/.test(md) && /\.ris\b/.test(md)],
        ['dark-theme', () => /(?:暗色|深色)/.test(md) && /prefers-color-scheme/.test(md)],
        ['keyboard-shortcuts', () => md.includes('快捷键') && md.includes('?')],
        ['bilingual-ui', () => md.includes('中英文') || (md.includes('中文') && md.includes('英文'))],
        ['zotero', () => /\bZotero\b/.test(md)],
        ['obsidian-vault', () => md.includes('Obsidian 笔记库')],
        ['openstax', () => /\bOpenStax\b/.test(md)],
        ['browser-extension', () => md.includes('扩展') && /\bChrome\b/.test(md) && /\bEdge\b/.test(md)],
        ['offline-mt', () => /paper-reader-install-model/.test(md) && (/OPUS-MT/i.test(md) || md.includes('离线'))]
      ];

  for (const [id, ok] of checks) {
    if (!ok()) missing.push(id);
  }
  return missing;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAiSlopViolations(md: string, lang: DocLang): string[] {
  const prose = stripTechnicalInlineCodeAndUrls(stripFencedCode(md));
  const violations: string[] = [];

  if (lang === 'en') {
    const slopScanText = prose.replace(/\bDeepSeek Harness\b/g, 'DSH');
    for (const word of EN_BANNED_SLOP_WORDS) {
      const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
      if (re.test(slopScanText)) violations.push(`banned EN word "${word}"`);
    }
    for (const phrase of EN_BANNED_SLOP_PHRASES) {
      const re = new RegExp(escapeRegExp(phrase), 'i');
      if (re.test(slopScanText)) violations.push(`banned EN phrase "${phrase}"`);
    }
  } else {
    for (const phrase of ZH_BANNED_SLOP_PHRASES) {
      if (prose.includes(phrase)) violations.push(`banned ZH cliche "${phrase}"`);
    }
  }

  const lines = prose.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*#{1,6}\s+.*\p{Extended_Pictographic}/u.test(line)) {
      violations.push(`heading emoji on line ${i + 1}`);
    }
    const boldMatches = line.match(/\*\*[^*\n]+\*\*/g);
    if (boldMatches && boldMatches.length >= 4) {
      violations.push(`dense bolding (${boldMatches.length} spans) on line ${i + 1}`);
    }
  }

  const emDashCount = (prose.match(/—/g) ?? []).length;
  if (emDashCount > 2) {
    violations.push(`too many em dashes (${emDashCount} > 2)`);
  }

  return violations;
}

function findEnvironmentLeaks(md: string): string[] {
  const violations: string[] = [];
  for (const m of md.matchAll(/(?::|port[\s=]+)3080\b/gi)) {
    violations.push(`hardcoded port 3080 ("${m[0]}")`);
  }
  for (const m of md.matchAll(/(?:^|[\s(`"'])(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/gi)) {
    violations.push(`private local path ("${m[0].trim()}")`);
  }
  return violations;
}

function findNonTechnicalInlineCode(md: string): string[] {
  const violations: string[] = [];
  const lines = stripFencedCode(md).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const inner = m[1]!;
      if (!isTechnicalInlineCode(inner)) {
        violations.push(`line ${i + 1}: non-technical inline code \`${inner}\``);
      }
    }
  }
  return violations;
}

const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
const lockJson = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as PackageLock;
const docs: { relPath: string; lang: DocLang; content: string }[] = [
  { relPath: 'README.md', lang: 'en', content: readFileSync(path.join(repoRoot, 'README.md'), 'utf8') },
  { relPath: '交付说明.md', lang: 'zh', content: readFileSync(path.join(repoRoot, '交付说明.md'), 'utf8') }
];

describe('F10 documentation integrity (README.md and 交付说明.md)', () => {
  test('T1-F10-01: workflow-grouped H2 sections and no flat >10-bullet walls', () => {
    for (const doc of docs) {
      const { h2Count, maxConsecutiveBullets } = checkStructure(doc.content);
      assert.ok(h2Count >= 4, `${doc.relPath} expected >= 4 H2 sections, found ${h2Count}`);
      assert.ok(
        maxConsecutiveBullets <= 10,
        `${doc.relPath} expected <= 10 consecutive bullets, found ${maxConsecutiveBullets}`
      );
    }
  });

  test('T1-F10-02 & T2-F10-03: canonical terminology and zero untranslated ZH UI labels', () => {
    for (const doc of docs) {
      const { missing, banned } = checkTerminology(doc.content, doc.lang);
      assert.deepEqual(missing, [], `${doc.relPath} missing canonical terms`);
      assert.deepEqual(banned, [], `${doc.relPath} contains banned drift terms`);
      if (doc.lang === 'zh') {
        assert.deepEqual(findUntranslatedZhUiTerms(doc.content), [], `${doc.relPath} untranslated EN labels`);
      }
    }
  });

  test('T1-F10-03, T2-F10-01 & T2-F10-02: relative links, anchors, npm scripts, and install flags resolve', () => {
    const headingCache = new Map<string, Set<string>>();
    for (const doc of docs) {
      assert.deepEqual(
        findBrokenRelativeLinks(doc.content, doc.relPath, repoRoot, headingCache),
        [],
        `${doc.relPath} has broken relative links or anchors`
      );
      assert.deepEqual(
        findInvalidCliCommands(doc.content, pkgJson, lockJson),
        [],
        `${doc.relPath} has invalid CLI scripts or --allow-build flags`
      );
    }
    assert.ok(docs[0]!.content.includes('(交付说明.md)'), 'README.md should link to 交付说明.md');
    assert.ok(docs[1]!.content.includes('(README.md)'), '交付说明.md should link to README.md');
  });

  test('T1-F10-04: complete final feature coverage in both docs', () => {
    for (const doc of docs) {
      assert.deepEqual(
        findMissingFeatures(doc.content, doc.lang),
        [],
        `${doc.relPath} missing feature coverage`
      );
    }
  });

  test('T1-F10-05 & T2-F10-04: zero AI-slop cliches, formatting slop, or non-technical UI backticks', () => {
    for (const doc of docs) {
      assert.deepEqual(
        findAiSlopViolations(doc.content, doc.lang),
        [],
        `${doc.relPath} contains AI-slop or formatting violations`
      );
      assert.deepEqual(
        findNonTechnicalInlineCode(doc.content),
        [],
        `${doc.relPath} wraps ordinary UI labels in inline code backticks`
      );
    }
  });

  test('T2-F10-05: zero hardcoded conflicting ports or private paths', () => {
    for (const doc of docs) {
      assert.deepEqual(
        findEnvironmentLeaks(doc.content),
        [],
        `${doc.relPath} contains environment leaks`
      );
    }
  });
});

describe('docs-integrity detectors catch injected negative cases', () => {
  test('link & anchor detector catches missing files, bad ASCII/CJK anchors, and accepts valid CJK, query strings, & duplicate slugs', () => {
    const validMd = [
      '# Title',
      '## DSH Web 命令行安装',
      '## Notes',
      '## Notes',
      '[ok cjk](#dsh-web-命令行安装)',
      '[ok dup](#notes-1)',
      '[ok query](README.md?raw=1)',
      '```md',
      '[ignored in code](does/not/exist.md)',
      '```'
    ].join('\n');
    assert.deepEqual(findBrokenRelativeLinks(validMd, 'README.md', repoRoot), []);

    const brokenMd = [
      '## Intro',
      '[missing](docs/does-not-exist.md)',
      '[bad ascii](#no-such-heading)',
      '[bad cjk](#不存在的标题)'
    ].join('\n');
    const failures = findBrokenRelativeLinks(brokenMd, 'README.md', repoRoot);
    assert.equal(failures.length, 3);
    assert.ok(failures.some(f => f.includes('docs/does-not-exist.md')));
    assert.ok(failures.some(f => f.includes('#no-such-heading')));
    assert.ok(failures.some(f => f.includes('#不存在的标题')));
  });

  test('CLI command detector catches unknown npm scripts, unknown exec bins, and stale --allow-build flags', () => {
    const badCli = [
      '```sh',
      'npm run does-not-exist',
      'dsh plugin --profile web exec nonexistent-bin',
      'dsh plugin --profile web add github:jiawoget/dsh-paper-reader --allow-build=onnxruntime-node --allow-build=protobufjs --allow-build=sharp',
      'dsh plugin --profile web add github:jiawoget/dsh-paper-reader --allow-build onnxruntime-node --allow-build protobufjs --allow-build sharp',
      'dsh plugin --profile web add github:jiawoget/dsh-paper-reader --allow-build=onnxruntime-node',
      '```'
    ].join('\n');
    const failures = findInvalidCliCommands(badCli, pkgJson, lockJson);
    assert.ok(failures.some(f => f.includes('does-not-exist')));
    assert.ok(failures.some(f => f.includes('nonexistent-bin')));
    assert.ok(failures.some(f => f.includes('--allow-build=sharp')));
    assert.ok(failures.some(f => f.includes('--allow-build sharp')));
    assert.ok(failures.some(f => f.includes('missing --allow-build=protobufjs')));
  });

  test('structure detector catches both tight and loose 11-bullet walls', () => {
    const tight = Array.from({ length: 11 }, (_, i) => `- item ${i + 1}`).join('\n');
    const loose = Array.from({ length: 11 }, (_, i) => `- item ${i + 1}`).join('\n\n');
    assert.equal(checkStructure(tight).maxConsecutiveBullets, 11);
    assert.equal(checkStructure(loose).maxConsecutiveBullets, 11);
  });

  test('terminology & ZH UI detectors catch both plain and backtick-wrapped drift while allowing genuine code spans', () => {
    const enBad = '## Read and annotate\nUse Notebook, Annotations, Paper conversation, Add to notebook, and Refresh notebook.';
    const enRes = checkTerminology(enBad, 'en');
    assert.ok(enRes.banned.length >= 6);
    assert.ok(enRes.missing.includes('Marks'));

    const enBacktickBad = 'Use `Add to notebook`, `Paper conversation`, `Reading notebook`, and `Annotations`.';
    const enBacktickRes = checkTerminology(enBacktickBad, 'en');
    assert.ok(enBacktickRes.banned.some(v => /Add to notebook/i.test(v)));
    assert.ok(enBacktickRes.banned.some(v => /Paper conversation/i.test(v)));
    assert.ok(enBacktickRes.banned.some(v => /Reading notebook/i.test(v)));
    assert.ok(enBacktickRes.banned.some(v => /Annotations/i.test(v)));
    assert.equal(findNonTechnicalInlineCode(enBacktickBad).length, 4);

    const enCodeSafe = 'Marks, Paper chat, Section chat, Notes, Obsidian vault. Run `npm run test:annotations` and `npm run test:notebook-scenarios`.';
    assert.deepEqual(checkTerminology(enCodeSafe, 'en'), { missing: [], banned: [] });
    assert.deepEqual(findNonTechnicalInlineCode(enCodeSafe), []);

    const zhBad = '使用阅读笔记本、批注与 Obsidian 仓库，展开 Connection settings 打开 Library。';
    const zhTerm = checkTerminology(zhBad, 'zh');
    assert.ok(zhTerm.banned.length >= 3);
    const zhUi = findUntranslatedZhUiTerms(zhBad);
    assert.ok(zhUi.some(v => v.includes('Connection settings')));
    assert.ok(zhUi.some(v => v.includes('Library')));

    const zhBacktickBad = '打开 `Connection settings` 并使用 `阅读笔记本`。';
    const zhBacktickTerm = checkTerminology(zhBacktickBad, 'zh');
    assert.ok(zhBacktickTerm.banned.includes('阅读笔记本'));
    const zhBacktickUi = findUntranslatedZhUiTerms(zhBacktickBad);
    assert.ok(zhBacktickUi.some(v => v.includes('Connection settings')));
    assert.equal(findNonTechnicalInlineCode(zhBacktickBad).length, 2);

    const zhClean = '解压仓库 ZIP 并选择 `dist/extension`，支持 BibTeX、RIS、标记、全文问答、本节问答、笔记与 Obsidian 笔记库。';
    assert.deepEqual(checkTerminology(zhClean, 'zh'), { missing: [], banned: [] });
    assert.deepEqual(findUntranslatedZhUiTerms(zhClean), []);
    assert.deepEqual(findNonTechnicalInlineCode(zhClean), []);
  });

  test('feature coverage detector reports omitted capabilities', () => {
    const incompleteEn = 'Paper Reader opens PDFs in Zotero.';
    const missingEn = findMissingFeatures(incompleteEn, 'en');
    assert.ok(missingEn.includes('citation-export'));
    assert.ok(missingEn.includes('dark-theme'));
    assert.ok(missingEn.includes('target-language'));

    const incompleteZh = '支持打开 PDF 与 Zotero。';
    const missingZh = findMissingFeatures(incompleteZh, 'zh');
    assert.ok(missingZh.includes('citation-export'));
    assert.ok(missingZh.includes('dark-theme'));
    assert.ok(missingZh.includes('obsidian-vault'));
  });

  test('AI-slop detector catches EN/ZH cliches, inflected verbs, heading emoji, em-dash clusters, and dense bolding', () => {
    const badEn = [
      '## 🚀 Quickstart',
      'Delving into a seamless workflow by leveraging and harnessing AI while streamlining reading — one — two — three.',
      '- Click **One**, **Two**, **Three**, and **Four**.'
    ].join('\n');
    const enViolations = findAiSlopViolations(badEn, 'en');
    assert.ok(enViolations.some(v => v.includes('delving')));
    assert.ok(enViolations.some(v => v.includes('leveraging')));
    assert.ok(enViolations.some(v => v.includes('harnessing')));
    assert.ok(enViolations.some(v => v.includes('streamlining')));
    assert.ok(enViolations.some(v => v.includes('seamless')));
    assert.ok(enViolations.some(v => v.includes('heading emoji')));
    assert.ok(enViolations.some(v => v.includes('em dashes')));
    assert.ok(enViolations.some(v => v.includes('dense bolding')));

    assert.deepEqual(findAiSlopViolations('Paper Reader runs inside DeepSeek Harness Web.', 'en'), []);

    const badZh = '一站式赋能科研阅读，带来丝滑体验。';
    const zhViolations = findAiSlopViolations(badZh, 'zh');
    assert.ok(zhViolations.some(v => v.includes('赋能')));
    assert.ok(zhViolations.some(v => v.includes('一站式')));
    assert.ok(zhViolations.some(v => v.includes('丝滑')));
  });

  test('environment leak detector catches port 3080 variants and private paths in raw text and code blocks', () => {
    const leaky = [
      '```sh',
      'curl http://127.0.0.1:3080',
      'dsh web --port=3080',
      'cd /home/alice/repo',
      '```',
      'Vault at /Users/bob/vault or C:\\Users\\bob\\notes.'
    ].join('\n');
    const leaks = findEnvironmentLeaks(leaky);
    assert.ok(leaks.some(v => v.includes(':3080')));
    assert.ok(leaks.some(v => v.includes('port=3080')));
    assert.ok(leaks.some(v => v.includes('/home/')));
    assert.ok(leaks.some(v => v.includes('/Users/')));
    assert.ok(leaks.some(v => v.includes('C:\\Users\\')));
  });
});
