import { parseAcademicInput } from '../../shared/academic-intake.js';
import { extractArxivId } from '../../shared/citation-export.js';
import type { CitationAnalyzeInput, CitationDirection, CitationReport, CitationStatement, CitationTargetInfo } from '../../shared/citation-stance-types.js';
import type { DocumentInfo, GraphPaper, GraphSource } from '../../shared/types.js';
import { api, el } from '../ui.js';
import { researchIcon } from './icons.js';
import { researchText } from './labels.js';
import { isAbortError, mkBtn } from './paper-intake.js';
import { PaperPicker, type PaperPickerExternalItem } from './paper-picker.js';

export const CITATIONS_RECENT_KEY = 'reader.citations.recent';
const RECENT_CAP = 8;

export interface CitationsTarget { docId: string; doi: string; arxivId: string; query: string }
export interface RecentCitationEntry {
  key: string; title: string; year?: number;
  docId?: string; doi?: string; arxivId?: string; query?: string;
}
interface CitationsWorkbenchOptions {
  docs: () => readonly DocumentInfo[]; target: () => CitationsTarget; currentTitle: () => string;
  currentReadingDocId: () => string; onSelectTarget: (target: CitationsTarget, hint?: { title?: string; year?: number }) => void;
}

const cleanDoi = (v?: string): string => (v ?? '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
const normTitle = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const emptyCitationTarget = (docId = ''): CitationsTarget => ({ docId, doi: '', arxivId: '', query: '' });
export const hasCitationTarget = (t: CitationsTarget): boolean => Boolean(t.docId || t.doi || t.arxivId || t.query);
export const citationAnalyzePayload = (t: CitationsTarget, direction: CitationDirection, forceRefresh: boolean): CitationAnalyzeInput =>
  t.docId ? { docId: t.docId, direction, ...(forceRefresh ? { forceRefresh: true } : {}) }
    : hasCitationTarget(t) ? { ...(t.doi ? { doi: t.doi } : {}), ...(t.arxivId ? { arxivId: t.arxivId } : {}), ...(t.query ? { query: t.query } : {}), direction, ...(forceRefresh ? { forceRefresh: true } : {}) } : {};
export const citationTargetTitle = (t: CitationsTarget, report: CitationReport | null, docs: readonly DocumentInfo[], hint = ''): string => {
  const doc = t.docId ? docs.find(d => d.id === t.docId) : undefined;
  return report?.target.title || doc?.paperTitle || doc?.title || hint || t.query || t.doi || (t.arxivId ? `arXiv:${t.arxivId}` : '');
};
export function statementToGraphPaper(s: CitationStatement, docs: readonly DocumentInfo[], savedMap: ReadonlyMap<string, string>): GraphPaper {
  const saved = savedMap.get(s.citingKey), doi = s.citingDoi?.toLowerCase(), ax = s.citingArxiv?.toLowerCase(), nt = normTitle(s.citingTitle);
  const localId = (s.citingDocId && docs.some(d => d.id === s.citingDocId) ? s.citingDocId : undefined)
    ?? (saved && docs.some(d => d.id === saved) ? saved : undefined)
    ?? docs.find(d => (doi && d.doi?.toLowerCase().includes(doi)) || (ax && (d.url?.toLowerCase().includes(ax) || d.doi?.toLowerCase().includes(ax))) || (nt.length >= 16 && normTitle(d.paperTitle || d.title) === nt))?.id;
  const src: GraphSource = s.source === 's2' ? 's2' : s.source === 'europepmc' ? 'europepmc' : 'openalex';
  return {
    id: s.citingKey, title: s.citingTitle, authors: s.citingAuthors, firstAuthor: s.citingAuthors[0] ?? '', lastAuthor: s.citingAuthors.at(-1) ?? '',
    ...(s.citingYear ? { year: s.citingYear } : {}), ...(s.citingDoi ? { doi: s.citingDoi } : {}), ...(s.citingArxiv ? { arxivId: s.citingArxiv } : {}),
    ...(s.citingUrl ? { url: s.citingUrl } : {}), ...(s.citingArxiv ? { oaPdfUrl: `https://arxiv.org/pdf/${s.citingArxiv}.pdf` } : {}),
    source: src, inLibrary: Boolean(localId), ...(localId ? { docId: localId } : {})
  };
}

const isBareCitationId = (s: string, doi?: string, arxivId?: string): boolean => {
  const t = s.trim(), low = t.toLowerCase();
  return !t || (Boolean(doi) && low === doi!.toLowerCase()) || (Boolean(arxivId) && low === `arxiv:${arxivId!.toLowerCase()}`) || /^10\.\d{4,9}\/\S+$|^arxiv:\S+$|^pmid:?\s*\d+$|^w\d+$/i.test(t);
};

export function canonicalCitationTargetKey(t: { docId?: string; doi?: string; arxivId?: string; query?: string }): string {
  const docId = t.docId?.trim(), doi = cleanDoi(t.doi).toLowerCase(), arxivId = (t.arxivId?.trim() || extractArxivId(doi) || '').toLowerCase(), query = t.query?.trim().toLowerCase();
  if (docId) return 'doc:' + docId;
  if (doi && !/^10\.48550\/arxiv\./i.test(doi)) return 'doi:' + doi;
  if (arxivId) return 'arxiv:' + arxivId;
  return doi ? 'doi:' + doi : query ? 'q:' + query : '';
}

const sameCitationIdentity = (
  a: { key?: string; docId?: string; doi?: string; arxivId?: string },
  b: { key?: string; docId?: string; doi?: string; arxivId?: string }
): boolean => {
  const axA = (a.arxivId?.trim() || extractArxivId(a.doi) || '').toLowerCase(), axB = (b.arxivId?.trim() || extractArxivId(b.doi) || '').toLowerCase();
  return Boolean(
    (a.key && b.key && a.key === b.key) || (a.docId && b.docId && a.docId === b.docId)
    || (a.doi && b.doi && cleanDoi(a.doi).toLowerCase() === cleanDoi(b.doi).toLowerCase())
    || (axA && axB && axA === axB)
  );
};

export function upsertRecentCitations(
  list: readonly RecentCitationEntry[], input: Omit<RecentCitationEntry, 'key'> & { key?: string }, max = RECENT_CAP
): RecentCitationEntry[] {
  const rawTitle = input.title.trim(), docId = input.docId?.trim() || undefined, doi = cleanDoi(input.doi) || undefined;
  const arxivId = input.arxivId?.trim().toLowerCase() || extractArxivId(doi)?.toLowerCase() || undefined;
  const query = !docId && !doi && !arxivId ? (input.query?.trim() || rawTitle) : undefined;
  const key = input.key?.trim() || canonicalCitationTargetKey({ docId, doi, arxivId, query });
  if (!rawTitle || !key) return [...list];
  const prev = list.find(item => sameCitationIdentity(item, { key, docId, doi, arxivId }));
  const title = prev && !isBareCitationId(prev.title, doi, arxivId) && isBareCitationId(rawTitle, doi, arxivId) ? prev.title : rawTitle;
  const inYear = typeof input.year === 'number' && Number.isFinite(input.year) && input.year > 1800 ? Math.round(input.year) : undefined;
  const year = inYear ?? prev?.year;
  const next: RecentCitationEntry = { key, title: title.slice(0, 220), ...(year ? { year } : {}), ...(docId ? { docId } : {}), ...(doi ? { doi } : {}), ...(arxivId ? { arxivId } : {}), ...(query ? { query } : {}) };
  return [next, ...list.filter(item => !sameCitationIdentity(item, next))].slice(0, Math.max(1, max));
}

export function parseRecentCitations(raw: string | null): RecentCitationEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    let out: RecentCitationEntry[] = [];
    for (const row of [...parsed].reverse()) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.title !== 'string' || !r.title.trim()) continue;
      out = upsertRecentCitations(out, {
        key: typeof r.key === 'string' ? r.key : undefined, title: r.title, year: typeof r.year === 'number' ? r.year : undefined,
        docId: typeof r.docId === 'string' ? r.docId : undefined, doi: typeof r.doi === 'string' ? r.doi : undefined,
        arxivId: typeof r.arxivId === 'string' ? r.arxivId : undefined, query: typeof r.query === 'string' ? r.query : undefined
      });
    }
    return out;
  } catch { return []; }
}

export function parseDirectCitationTarget(raw: string, docs: readonly DocumentInfo[]): CitationsTarget | null {
  const text = raw.trim();
  if (!text) return null;
  const parsed = parseAcademicInput(text), pmid = /^pmid:?\s*(\d+)$/i.exec(text)?.[1], oaId = /^(?:https?:\/\/openalex\.org\/)?(W\d+)\/?$/i.exec(text)?.[1]?.toUpperCase();
  if (parsed?.kind === 'arxiv') {
    const id = parsed.id.toLowerCase(), hit = docs.find(d => extractArxivId(d.url, d.doi)?.toLowerCase() === id);
    return { docId: hit?.id ?? '', doi: '', arxivId: id, query: '' };
  }
  if (parsed?.kind === 'doi') {
    const doi = parsed.doi, low = doi.toLowerCase(), hit = docs.find(d => cleanDoi(d.doi).toLowerCase() === low);
    return { docId: hit?.id ?? '', doi, arxivId: '', query: '' };
  }
  return pmid || oaId ? { docId: '', doi: '', arxivId: '', query: pmid ? `PMID:${pmid}` : oaId! } : null;
}

const loadRecent = (): RecentCitationEntry[] => { try { return parseRecentCitations(typeof localStorage !== 'undefined' ? localStorage.getItem(CITATIONS_RECENT_KEY) : null); } catch { return []; } };
const saveRecent = (list: readonly RecentCitationEntry[]): void => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(CITATIONS_RECENT_KEY, JSON.stringify(list)); } catch {} };
const externalMeta = (p: GraphPaper): string => [
  p.inLibrary ? researchText.inLibraryNode() : '', p.authors.length > 1 ? `${p.authors[0]} et al.` : (p.authors[0] ?? ''),
  p.year ? String(p.year) : '', typeof p.citationCount === 'number' && p.citationCount > 0 ? researchText.citedCount(p.citationCount) : '',
  p.venue ?? '', p.doi ? `DOI: ${p.doi}` : (p.arxivId ? `arXiv:${p.arxivId}` : '')
].filter(Boolean).join(' · ');

export class CitationsWorkbench {
  readonly pickerWrap: HTMLElement;
  readonly recentStrip: HTMLElement;
  private readonly triggerBtn: HTMLButtonElement;
  private readonly triggerTitle: HTMLElement;
  private readonly recentList: HTMLElement;
  private readonly picker: PaperPicker;
  private readonly outsideClick: (e: Event) => void;
  private openState = false;
  private recent: RecentCitationEntry[] = loadRecent();

  constructor(private readonly opts: CitationsWorkbenchOptions) {
    this.pickerWrap = el('div', 'cit-wb-wrap');
    this.triggerBtn = mkBtn('btn cit-wb-trigger', '', () => { if (this.openState) this.close(false); else this.open(); });
    this.triggerBtn.ariaLabel = researchText.citationsSearchLabel();
    this.triggerBtn.setAttribute('aria-haspopup', 'dialog'); this.triggerBtn.setAttribute('aria-expanded', 'false');
    this.triggerTitle = el('span', 'cit-wb-title', researchText.citationsPickPaper());
    const caret = el('span', 'cit-wb-caret', '▾'); caret.setAttribute('aria-hidden', 'true');
    this.triggerBtn.append(researchIcon('search', 16), this.triggerTitle, caret);
    this.picker = new PaperPicker({
      docs: opts.docs, selectedDocId: () => opts.target().docId, currentReadingDocId: opts.currentReadingDocId,
      ariaLabel: researchText.citationsSearchLabel(), searchAriaLabel: researchText.citationsSearchLabel(),
      placeholder: researchText.citationsSearchPlaceholder(),
      pickerClass: 'pp-picker cit-wb-picker', searchClass: 'pp-search cit-wb-search', listClass: 'pp-list cit-wb-list', optionClass: 'pp-opt',
      onSelectDoc: d => { this.close(false); this.opts.onSelectTarget(emptyCitationTarget(d.id), { title: d.paperTitle || d.title }); },
      onSelectExternal: item => this.selectExternal(item),
      onSubmitRaw: (q, hasOptions) => {
        const direct = parseDirectCitationTarget(q, this.opts.docs());
        if (direct) { this.close(false); this.opts.onSelectTarget(direct); return true; }
        if (!hasOptions && q.length >= 3) { this.close(false); this.opts.onSelectTarget({ docId: '', doi: '', arxivId: '', query: q }, { title: q }); return true; }
        return false;
      },
      externalSearch: async (query, signal) => {
        try {
          const res = await api('graph.search', { query, limit: 8 }, false, signal);
          const items = res.papers.map(p => ({ id: p.id, title: p.title, meta: externalMeta(p), paper: p }));
          return { items, ...(!items.length && res.degraded.length ? { note: researchText.pickerExternalDegraded() } : {}) };
        } catch (err) {
          if (signal.aborted || isAbortError(err)) throw err;
          return { items: [], note: researchText.pickerExternalDegraded() };
        }
      },
      onClose: refocus => this.close(refocus)
    });
    this.pickerWrap.append(this.triggerBtn, this.picker.root);
    this.outsideClick = e => { if (this.openState && !(e.target instanceof Node && this.pickerWrap.contains(e.target))) this.close(false); };
    document.addEventListener('pointerdown', this.outsideClick);
    this.recentStrip = el('nav', 'cit-recent-strip');
    this.recentStrip.setAttribute('aria-label', researchText.citationsRecentLabel());
    this.recentList = el('div', 'cit-recent-list');
    this.recentStrip.append(el('span', 'cit-recent-label', researchText.citationsRecent()), this.recentList);
    this.sync();
  }

  private selectExternal(item: PaperPickerExternalItem): void {
    const p = item.paper; this.close(false);
    if (!p) { this.opts.onSelectTarget({ docId: '', doi: '', arxivId: '', query: item.title }, { title: item.title }); return; }
    const docId = p.inLibrary && p.docId ? p.docId : '', doi = p.doi ?? '', arxivId = p.arxivId ?? '';
    this.opts.onSelectTarget({ docId, doi, arxivId, query: !docId && !doi && !arxivId ? p.title : '' }, { title: p.title, year: p.year });
  }
  isOpen(): boolean { return this.openState; }
  open(): void { this.openState = true; this.picker.open(); this.triggerBtn.setAttribute('aria-expanded', 'true'); }
  close(refocus = false): void {
    if (!this.openState) return;
    this.openState = false; this.picker.close(); this.triggerBtn.setAttribute('aria-expanded', 'false');
    if (refocus && this.triggerBtn.isConnected) this.triggerBtn.focus({ preventScroll: true });
  }
  refresh(): void { this.picker.refresh(); this.sync(); }
  recordAnalyzed(info: CitationTargetInfo): void {
    const query = !info.docId && !info.doi && !info.arxivId && info.pmid ? `PMID:${info.pmid}` : undefined;
    this.recent = upsertRecentCitations(this.recent, { title: info.title, year: info.year, docId: info.docId, doi: info.doi, arxivId: info.arxivId, ...(query ? { query } : {}) });
    saveRecent(this.recent); this.sync();
  }
  onDocDeleted(docId: string): void {
    let changed = false; const next: RecentCitationEntry[] = [];
    for (const item of this.recent) {
      if (item.docId !== docId) { next.push(item); continue; }
      changed = true;
      const key = item.doi || item.arxivId ? canonicalCitationTargetKey({ doi: item.doi, arxivId: item.arxivId }) : '';
      if (key) next.push({ key, title: item.title, ...(item.year ? { year: item.year } : {}), ...(item.doi ? { doi: item.doi } : {}), ...(item.arxivId ? { arxivId: item.arxivId } : {}) });
    }
    if (changed) { this.recent = next; saveRecent(this.recent); }
    this.refresh();
  }
  sync(): void {
    const label = this.opts.currentTitle().trim() || researchText.citationsPickPaper();
    this.triggerTitle.textContent = label; this.triggerTitle.title = label; this.renderRecent();
  }
  private renderRecent(): void {
    this.recentList.replaceChildren(); this.recentStrip.hidden = this.recent.length === 0;
    if (!this.recent.length) return;
    const cur = this.opts.target(), curId = { ...cur, key: canonicalCitationTargetKey(cur) };
    for (const entry of this.recent) {
      const chip = mkBtn('btn cit-recent-chip', '', () => {
        this.close(false);
        this.opts.onSelectTarget({ docId: entry.docId ?? '', doi: entry.doi ?? '', arxivId: entry.arxivId ?? '', query: entry.query ?? '' }, { title: entry.title, year: entry.year });
      });
      chip.dataset.recentKey = entry.key; chip.setAttribute('aria-pressed', String(sameCitationIdentity(entry, curId)));
      chip.title = entry.year ? `${entry.title} (${entry.year})` : entry.title;
      chip.append(el('span', 'cit-recent-title', entry.title), ...(entry.year ? [el('span', 'cit-recent-year', String(entry.year))] : []));
      this.recentList.append(chip);
    }
  }
  dispose(): void { this.openState = false; this.picker.dispose(); document.removeEventListener('pointerdown', this.outsideClick); }
}
