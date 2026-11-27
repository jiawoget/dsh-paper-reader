import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentInfo, GraphPaper } from '../src/shared/types.js';
import { infoTip, researchIcon } from '../src/reader/research/icons.js';
import { createWorkspaceFloatCallbacks, PaperFloatBar, type PaperFloatCallbacks, type PaperFloatTarget } from '../src/reader/research/paper-float-bar.js';
import type { InspectTarget, ResearchOpenContext, ResearchShellContext } from '../src/reader/research/state.js';

class FakeNode extends EventTarget {
  parentElement: FakeNode | null = null; readonly children: FakeNode[] = [];
  get isConnected(): boolean { for (let cur: FakeNode | null = this; cur; cur = cur.parentElement) if (cur === fakeDoc.body) return true; return false; }
  contains(node: FakeNode | null): boolean { for (let cur = node; cur; cur = cur.parentElement) if (cur === this) return true; return false; }
  append(...nodes: (FakeNode | string)[]): void { for (const n of nodes) if (typeof n !== 'string') { n.remove(); n.parentElement = this; this.children.push(n); } }
  remove(): void { if (!this.parentElement) return; const i = this.parentElement.children.indexOf(this); if (i >= 0) this.parentElement.children.splice(i, 1); this.parentElement = null; }
}

class FakeEl extends FakeNode {
  tagName: string; className = ''; hidden = false; disabled = false; type = ''; textContent = ''; ariaLabel = ''; title = '';
  offsetWidth = 240; offsetHeight = 36;
  readonly dataset: Record<string, string> = {}; readonly style: Record<string, string> = {}; readonly attrs = new Map<string, string>();
  rect = { left: 100, right: 500, top: 120, bottom: 200, width: 400, height: 80 };
  readonly classList = {
    add: (...cls: string[]) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); cls.forEach(c => s.add(c)); this.className = [...s].join(' '); },
    remove: (...cls: string[]) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); cls.forEach(c => s.delete(c)); this.className = [...s].join(' '); },
    contains: (c: string) => this.className.split(/\s+/).includes(c)
  };
  constructor(tag: string) { super(); this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  getBoundingClientRect() { return this.rect; }
  focus(): void { fakeDoc.activeElement = this; }
  matches(sel: string): boolean { return sel.includes('[data-paper-float="1"]') ? this.dataset.paperFloat === '1' : sel.split(',').map(s => s.trim().toLowerCase()).includes(this.tagName.toLowerCase()); }
  closest(sel: string): FakeEl | null { for (let cur: FakeNode | null = this; cur; cur = cur.parentElement) if (cur instanceof FakeEl && cur.matches(sel)) return cur; return null; }
  querySelector(sel: string): FakeEl | null { for (const c of this.children) if (c instanceof FakeEl) { if (c.matches(sel)) return c; const h = c.querySelector(sel); if (h) return h; } return null; }
}

const fakeDoc = Object.assign(new EventTarget(), { body: new FakeEl('body'), activeElement: null as FakeEl | null, createElement: (t: string) => new FakeEl(t), createElementNS: (_ns: string, t: string) => new FakeEl(t) });
const fakeWin = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800 });

function installFakeDom(): () => void {
  const prev = { document: globalThis.document, window: globalThis.window, Node: globalThis.Node, Element: globalThis.Element, innerWidth: (globalThis as Record<string, unknown>).innerWidth, innerHeight: (globalThis as Record<string, unknown>).innerHeight, navigator: globalThis.navigator };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
  Object.assign(globalThis, { document: fakeDoc, window: fakeWin, Node: FakeNode, Element: FakeEl, innerWidth: 1280, innerHeight: 800 });
  return () => { Object.defineProperty(globalThis, 'navigator', { value: prev.navigator, configurable: true }); Object.assign(globalThis, { document: prev.document, window: prev.window, Node: prev.Node, Element: prev.Element, innerWidth: prev.innerWidth, innerHeight: prev.innerHeight }); };
}

const samplePaper = (inLibrary = false): GraphPaper => ({
  id: 'W42', openAlexId: 'W42', title: 'FlashAttention', authors: ['Tri Dao'], firstAuthor: 'Tri Dao', lastAuthor: 'Tri Dao',
  year: 2022, doi: '10.48550/arXiv.2205.14135', source: 'openalex', inLibrary, ...(inLibrary ? { docId: 'doc-42' } : {})
});

test('researchIcon uses 24x24 REicon 1.5px stroke frame and infoTip creates accessible tooltip button', () => {
  const restore = installFakeDom();
  try {
    const svg = researchIcon('read');
    assert.deepEqual(['width', 'height', 'viewBox', 'stroke-width', 'aria-hidden'].map(k => svg.getAttribute(k)), ['24', '24', '0 0 24 24', '1.5', 'true']);
    assert.ok((svg.children[0]?.getAttribute('d') ?? '').length > 10);
    const tip = infoTip('Explains deep search', 'Deep Search');
    assert.equal(tip.dataset.tip, 'Explains deep search'); assert.match(tip.ariaLabel ?? '', /Deep Search/); assert.equal(tip.children.length, 1);
  } finally { restore(); }
});

test('PaperFloatBar stays hidden at rest, reveals 5 actions for external and 4 for saved papers, clamps bounds, and handles Escape/scroll', async () => {
  const restore = installFakeDom();
  try {
    const host = document.createElement('section'); document.body.append(host);
    const calls: string[] = [];
    const callbacks: PaperFloatCallbacks = {
      onRead: t => { calls.push('read:' + (t.doc?.id ?? t.paper?.id)); },
      onAskAi: t => { calls.push('ask:' + (t.doc?.id ?? t.paper?.id)); },
      onCitations: t => { calls.push('cit:' + (t.doc?.id ?? t.paper?.id)); },
      onCitationMap: t => { calls.push('map:' + (t.doc?.id ?? t.paper?.id)); },
      onSave: t => { calls.push('save:' + t.paper?.id); t.inLibrary = true; if (t.paper) t.paper.inLibrary = true; }
    };
    const bar = new PaperFloatBar(host, callbacks), barBtns = [...bar.root.children] as HTMLButtonElement[];
    assert.equal(bar.root.hidden, true); assert.equal(bar.root.classList.contains('is-visible'), false);

    const extCard = document.createElement('article');
    Object.assign(extCard, { rect: { left: 1120, right: 1278, top: 10, bottom: 80, width: 158, height: 70 } });
    host.append(extCard); bar.attach(extCard, { paper: samplePaper(false) });
    assert.equal(extCard.dataset.paperFloat, '1'); assert.equal(extCard.children.length, 0);

    bar.showFor(extCard); assert.equal(bar.root.hidden, false);
    assert.deepEqual(barBtns.filter(b => !b.hidden).map(b => b.dataset.action), ['read', 'ask-ai', 'citations', 'citation-map', 'save']);
    assert.ok(parseInt(bar.root.style.left, 10) >= 8 && parseInt(bar.root.style.left, 10) + bar.root.offsetWidth <= 1272 && parseInt(bar.root.style.top, 10) >= 8);

    const saveBtn = barBtns.find(b => b.dataset.action === 'save')!;
    saveBtn.dispatchEvent(new Event('click')); await Promise.resolve();
    assert.deepEqual(calls, ['save:W42']); assert.equal(saveBtn.hidden, true);

    const libRow = document.createElement('div'), doc: DocumentInfo = { id: 'doc-1', title: 'Attention', kind: 'pdf', defaultPage: 1 };
    host.append(libRow); bar.attach(libRow, { doc, inLibrary: true }); bar.showFor(libRow);
    assert.deepEqual(barBtns.filter(b => !b.hidden).map(b => b.dataset.action), ['read', 'ask-ai', 'citations', 'citation-map']);

    barBtns.find(b => b.dataset.action === 'ask-ai')!.dispatchEvent(new Event('click')); await Promise.resolve();
    assert.deepEqual(calls, ['save:W42', 'ask:doc-1']); assert.equal(bar.root.hidden, true);

    bar.showFor(libRow); host.dispatchEvent(new Event('scroll')); assert.equal(bar.root.hidden, true);
    bar.showFor(libRow); barBtns[0].focus(); host.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    assert.equal(bar.root.hidden, true); assert.strictEqual(document.activeElement, libRow);
    bar.destroy(); assert.equal(bar.root.parentElement, null);
  } finally { restore(); }
});

test('createWorkspaceFloatCallbacks routes Read, Ask AI, Citations, and Citation Map targets cleanly', async () => {
  const inspected: InspectTarget[] = [], opened: { view: string; ctx?: ResearchOpenContext }[] = [];
  const shell: ResearchShellContext = {
    activeDocId: () => 'doc-1', activeTopic: () => '', setActiveTopic: () => undefined, openContext: () => undefined,
    openView: (view, ctx) => { opened.push({ view, ctx }); }, inspectInReader: async target => { inspected.push(target); }, notifyDocumentMutated: () => undefined
  };
  const cb = createWorkspaceFloatCallbacks(() => shell);
  const localTarget: PaperFloatTarget = { doc: { id: 'doc-1', title: 'Local', kind: 'pdf', defaultPage: 1 }, inLibrary: true };
  const extTarget: PaperFloatTarget = { paper: samplePaper(false) };
  await cb.onRead(localTarget); await cb.onAskAi(localTarget);
  cb.onCitations(localTarget); cb.onCitations(extTarget); cb.onCitationMap(localTarget); cb.onCitationMap(extTarget);
  assert.deepEqual(inspected, [{ docId: 'doc-1', page: 1 }, { docId: 'doc-1', page: 1, openChat: true }]);
  assert.deepEqual(opened, [
    { view: 'citations', ctx: { docId: 'doc-1' } },
    { view: 'citations', ctx: { docId: undefined, doi: '10.48550/arXiv.2205.14135', arxivId: undefined, query: 'FlashAttention' } },
    { view: 'citation-map', ctx: { seedDocId: 'doc-1' } },
    { view: 'citation-map', ctx: { query: 'W42' } }
  ]);
});
