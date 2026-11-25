import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaperAnnotation } from '../src/shared/annotations.js';
import { formatHighlightsSection, formatReadingPackMarkdown, formatYamlFrontmatter, readingPackFilename } from '../src/shared/reading-pack.js';
import type { DocumentInfo, JournalNote } from '../src/shared/types.js';

const readerBase = 'http://127.0.0.1:29812/api/paper-reader/app/index.html?doc=pdf-1';
const makeAnn = (over: Partial<PaperAnnotation>): PaperAnnotation => ({
  id: 'a1', docId: 'pdf-1', title: 'Paper', page: 1, anchor: 'b1', label: 'Intro',
  sourceUrl: readerBase + '&page=1&anchor=b1', kind: 'highlight', color: 'yellow',
  quote: 'Key claim', text: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over
});

test('YAML frontmatter escapes adversarial scalars, supports CJK, and blocks local or credential URLs', () => {
  const adversarial: DocumentInfo = {
    id: 'pdf-1', kind: 'pdf', title: 'ignored.pdf',
    paperTitle: 'Title: "quoted" \\ path\n---\ninjected: true',
    authors: '- Leading Dash; 张三; #comment &anchor',
    venue: 'true', year: '2025', doi: 'https://doi.org/10.1000/test:1',
    url: 'https://user:pass@example.org/secret.pdf'
  };
  const fm = formatYamlFrontmatter(adversarial, { link: 'zotero://select/library/items/ABCD1234', original: 'http://127.0.0.1:3080/api/paper-reader/app/index.html?doc=x' });
  assert.ok(fm.startsWith('---\n') && fm.endsWith('\n---'));
  assert.equal((fm.match(/^---$/gm) ?? []).length, 2);
  assert.ok(fm.includes('title: "Title: \\"quoted\\" \\\\ path --- injected: true"'));
  assert.ok(fm.includes('  - "- Leading Dash"\n  - "张三"\n  - "#comment &anchor"'));
  assert.ok(fm.includes('year: 2025'));
  assert.ok(fm.includes('venue: "true"'));
  assert.ok(fm.includes('doi: "10.1000/test:1"'));
  assert.ok(fm.includes('zotero: "zotero://select/library/items/ABCD1234"'));
  assert.doesNotMatch(fm, /\burl:|127\.0\.0\.1|localhost|user:pass|\/api\/paper-reader\/app\//);

  const localUrlDoc: DocumentInfo = { id: 'pdf-2', kind: 'pdf', title: 'Local', url: 'http://[::1]:3080/paper.pdf' };
  assert.doesNotMatch(formatYamlFrontmatter(localUrlDoc), /\burl:/);
  for (const bad of ['http://[::ffff:127.0.0.1]:3080/a.pdf', 'http://localhost.:3080/a.pdf', 'https://example.org/api/paper-reader/app?doc=x']) {
    assert.doesNotMatch(formatYamlFrontmatter({ id: 'pdf-2b', kind: 'pdf', title: 'True', url: bad }), /\burl:/);
  }
  const c1 = formatYamlFrontmatter({ id: 'pdf-2c', kind: 'pdf', title: 'True', paperTitle: 'C1\u0080\u0084\u009fEnd' });
  assert.ok(c1.includes('title: "C1 End"') && c1.includes('citekey: "c1"'));
  assert.ok(formatYamlFrontmatter({ id: 'pdf-2d', kind: 'pdf', title: 'True' }).includes('citekey: "true"'));
  assert.ok(formatYamlFrontmatter({ id: 'pdf-2e', kind: 'pdf', title: '12345' }).includes('citekey: "12345"'));
  assert.equal(readingPackFilename({ id: 'pdf-3', kind: 'pdf', title: 'PagedAttention.pdf', authors: 'Kwon, Woosuk', year: '2023' }), 'kwon2023pagedattention.md');
  assert.equal(readingPackFilename({ id: 'pdf-4', kind: 'pdf', title: '中文标题', authors: '李四', year: '2024' }).endsWith('.md'), true);
  assert.equal(readingPackFilename({ id: 'pdf-5', kind: 'pdf', title: 'CON' }), 'paper-con.md');
});

test('formatHighlightsSection filters tombstones/drafts, escapes HTML comments, and groups by page or book section', () => {
  const tombstone: PaperAnnotation & { content: null } = { ...makeAnn({ id: 'dead', quote: 'Deleted text' }), content: null };
  const emptyPin = makeAnn({ id: 'draft-pin', kind: 'pin', quote: '', text: '   ' });
  const badPage = makeAnn({ id: 'bad', page: 0 }), floatPage = makeAnn({ id: 'flt', page: 1.5, quote: 'Float page' });
  const list: (PaperAnnotation | null | undefined)[] = [
    null, undefined, tombstone, emptyPin, badPage, floatPage,
    makeAnn({ id: 'p6-pin', page: 6, kind: 'pin', color: 'purple', label: 'Figure 6', quote: '', text: 'Check <!-- hidden --> flow' }),
    makeAnn({ id: 'p2-g', page: 2, color: 'green', label: 'Method', quote: 'Line 1\n\nLine 2 --> end', text: 'Core algorithm' }),
    makeAnn({ id: 'p6-y', page: 6, color: 'yellow', label: 'Sec 3', quote: 'Block table', createdAt: '2026-01-01T00:00:00.000Z' }),
    makeAnn({ id: 'p6-p', page: 6, color: 'purple', label: 'Sec 3', quote: 'Open question', createdAt: '2026-01-02T00:00:00.000Z' })
  ];
  const pdfSection = formatHighlightsSection(list);
  assert.ok(pdfSection.indexOf('### Page 2') < pdfSection.indexOf('### Page 6'));
  assert.ok(pdfSection.includes('**Green · Method** · Method'));
  assert.ok(pdfSection.includes('> Line 1\n>\n> Line 2 --&gt; end'));
  assert.ok(pdfSection.includes('**Yellow · Key point** · Sec 3'));
  assert.ok(pdfSection.includes('**Purple · Question** · Sec 3'));
  assert.ok(pdfSection.includes('**Page note** · Figure 6'));
  assert.ok(pdfSection.includes('Check &lt;!-- hidden --&gt; flow'));
  assert.doesNotMatch(pdfSection, /Deleted text|draft-pin|bad|Float page/);

  const bookSection = formatHighlightsSection([makeAnn({ id: 'b1', page: 3, label: 'Paragraph 2' })], {
    sectionTitle: page => (page === 3 ? '1.2 Markets' : undefined)
  });
  assert.ok(bookSection.includes('### 1.2 Markets'));
  assert.doesNotMatch(bookSection, /### Page \d+/);

  const webSection = formatHighlightsSection([makeAnn({ id: 'w1', page: 1, label: 'Lead' })], { isWeb: true });
  assert.doesNotMatch(webSection, /### Page/);
  assert.equal(formatHighlightsSection([null, emptyPin]), '');
});

test('formatReadingPackMarkdown cleans notebook boilerplate/local links, supports JournalNote[], books, web, and vocabulary', () => {
  const doc: DocumentInfo = {
    id: 'pdf-1', kind: 'pdf', title: 'PagedAttention.pdf', paperTitle: 'Efficient Memory Management for LLM Serving',
    authors: 'Kwon, Woosuk; Li, Zhuohan', venue: 'SOSP', year: '2023', url: 'https://arxiv.org/pdf/2309.06180.pdf'
  };
  const liveNotebook = [
    '# PagedAttention', '', `[Open in Paper Reader](<${readerBase}&page=1>)`, '',
    '<!-- paper-reader:note 11111111-1111-4111-8111-111111111111 -->',
    'My note with [p. 6 · KV cache][p6-1234abcd] and [vLLM](https://vllm.ai).',
    '<!-- paper-reader:source 11111111-1111-4111-8111-111111111111 -->',
    `[Page 6 · Left column](<${readerBase}&page=6&anchor=b1>)`,
    '<!-- paper-reader:end 11111111-1111-4111-8111-111111111111 -->', '',
    '```md', '[kept inside fence](http://localhost:3080/demo)', '```', '',
    '```inline``` code then [Page 4](http://127.0.0.1:3080/api/paper-reader/app?doc=pdf-1&page=4 "t") and <http://127.0.0.1:3080/api/paper-reader/app?doc=pdf-1&page=5>',
    '<!-- Paper Reader 0123456789abcdef0123 begin ' + 'a'.repeat(64) + ' -->', '## Highlights & Page Notes', 'Duplicate block content', '<!-- Paper Reader 0123456789abcdef0123 end -->', '',
    `[p6-1234abcd]: <${readerBase}&page=6&anchor=b1>`
  ].join('\n');
  const pack = formatReadingPackMarkdown(doc, liveNotebook,
    [makeAnn({ id: 'h1', page: 6, color: 'green', quote: 'Logical blocks', text: 'Maps to physical cache' })],
    [{ text: 'KV cache', meaning: 'Key-value tensors', context: 'Stored per block', page: 6, label: 'Sec 3', sourceUrl: readerBase }],
    { key: 'ABCD1234', title: '', type: 'conferencePaper', creator: '', date: '', webUrl: 'https://www.zotero.org/groups/1/items/ABCD1234' });
  assert.ok(pack.includes('citekey: "kwon2023efficient"'));
  assert.ok(pack.includes('url: "https://arxiv.org/pdf/2309.06180.pdf"'));
  assert.ok(pack.includes('zotero: "https://www.zotero.org/groups/1/items/ABCD1234"'));
  assert.ok(pack.includes('## Notes\n\nMy note with [p. 6 · KV cache](<https://arxiv.org/pdf/2309.06180.pdf#page=6>) and [vLLM](https://vllm.ai).'));
  assert.ok(pack.includes('[kept inside fence](http://localhost:3080/demo)'));
  assert.ok(pack.includes('```inline``` code then [Page 4](<https://arxiv.org/pdf/2309.06180.pdf#page=4>) and <https://arxiv.org/pdf/2309.06180.pdf#page=5>'));
  assert.equal((pack.match(/^## Highlights & Page Notes$/gm) ?? []).length, 1);
  assert.ok(pack.includes('## Highlights & Page Notes\n\n### Page 6'));
  assert.ok(pack.includes('## Vocabulary\n\n### KV cache'));
  assert.doesNotMatch(pack, /paper-reader:|Paper Reader|Duplicate block|127\.0\.0\.1|\/api\/paper-reader\/app|Open in Paper Reader|p6-1234abcd/);

  const emptyBoilerplate = `# PagedAttention\n\n[Open in Paper Reader](<${readerBase}&page=1>)\n`;
  assert.doesNotMatch(formatReadingPackMarkdown(doc, emptyBoilerplate, []), /## Notes/);

  const journalNotes: JournalNote[] = [{
    id: 'n1', docId: 'web-1', title: 'Article', page: 1, anchor: 'p-1', label: 'Intro',
    sourceUrl: readerBase, quote: 'Quoted line', text: 'Journal thought', createdAt: '', updatedAt: ''
  }];
  const webPack = formatReadingPackMarkdown({ id: 'web-1', kind: 'web', title: 'Web Essay', url: 'https://example.org/essay' }, journalNotes, []);
  assert.ok(webPack.includes('## Notes\n\n**Intro**\n\n> Quoted line\n\nJournal thought'));
});
