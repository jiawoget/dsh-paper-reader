import { csvCell } from './citation-bulk.js';
import type { DocMeta, DocPageRecord, DocumentInfo, QuestionModel } from './types.js';

export type ReviewPresetId = 'general' | 'cs_ai' | 'pico' | 'custom';
export const REVIEW_PRESET_IDS: readonly ReviewPresetId[] = ['general', 'cs_ai', 'pico', 'custom'];
export type ReviewColumnType = 'text' | 'boolean' | 'number' | 'list';
export type ReviewDecision = 'yes' | 'no' | 'maybe';
export type ReviewExtractMode = 'pilot' | 'all' | 'cell' | 'reextract';
export type ReviewExportFormat = 'csv' | 'markdown';
export interface ReviewColumn { id: string; name: string; prompt: string; type: ReviewColumnType }
export interface ScreeningCriterion { id: string; label: string; required?: boolean }
export interface ExtractionCell {
  tableId: string; docId: string; colId: string; value: string; quote: string; page: number | null;
  reasoning: string; verified: boolean; manualOverride: boolean; sourceKind: 'pdf' | 'abstract'; status: 'done' | 'error'; updatedAt: number;
}
export interface ReviewTable {
  id: string; name: string; preset: ReviewPresetId; criteria: ScreeningCriterion[];
  columns: ReviewColumn[]; strictCriterion: boolean; threshold: number; updatedAt: number;
}
export interface ReviewGetInput { tableId?: string }
export interface ReviewGetResult { table: ReviewTable; cells: ExtractionCell[]; tables: ReviewTable[] }
export interface ReviewSaveTableInput {
  id?: string; name?: string; preset?: ReviewPresetId; columns?: ReviewColumn[];
  criteria?: ScreeningCriterion[]; strictCriterion?: boolean; threshold?: number;
}
export interface ReviewSaveTableResult { table: ReviewTable }
export interface ReviewScreenInput { tableId?: string; docIds: string[]; force?: boolean; questionModel?: QuestionModel | null }
export interface ReviewExtractInput {
  tableId?: string; docIds?: string[]; mode?: ReviewExtractMode; docId?: string; colId?: string; force?: boolean; questionModel?: QuestionModel | null;
}
export interface ReviewBatchResult { tableId: string; cells: ExtractionCell[]; processedDocs: number; skippedDocs: number; failedDocs: number; aborted: boolean }
export interface ReviewSetCellInput { tableId?: string; docId: string; colId: string; value: string; quote?: string; page?: number | null; reasoning?: string }
export interface ReviewSetCellResult { cell: ExtractionCell; meta?: DocMeta }
export interface ReviewExportInput { tableId?: string; format: ReviewExportFormat; docIds?: string[] }
export interface ReviewExportResult { filename: string; mime: string; content: string }

const col = (id: string, name: string, prompt: string, type: ReviewColumnType = 'text'): ReviewColumn => ({ id, name, prompt, type });
const GENERAL_COLUMNS: readonly ReviewColumn[] = [
  col('research_question', 'Research Question', 'Core research question, hypothesis, or problem addressed.'),
  col('method', 'Method', 'Methodology, experimental design, model, or analytical approach.'),
  col('key_findings', 'Key Findings', 'Headline quantitative or qualitative findings and evidence.'),
  col('limitations', 'Limitations', 'Stated limitations, failure modes, or scope boundaries.')
];
export const REVIEW_PRESETS: Readonly<Record<ReviewPresetId, { name: string; columns: readonly ReviewColumn[] }>> = {
  general: { name: 'General Research', columns: GENERAL_COLUMNS },
  cs_ai: { name: 'CS / AI Review', columns: [
    col('method', 'Method', 'Core algorithm, architecture, or system design proposed.'),
    col('datasets', 'Datasets', 'Benchmarks, datasets, or workloads evaluated.', 'list'),
    col('key_metrics', 'Key Metrics', 'Primary quantitative evaluation metrics reported.', 'list'),
    col('main_result', 'Main Result', 'Headline quantitative improvement or experimental finding.'),
    col('limitations', 'Limitations', 'Stated limitations, failure modes, or scope boundaries.')
  ] },
  pico: { name: 'Clinical PICO', columns: [
    col('population', 'Population', 'Study participants, condition, sample size, and eligibility.'),
    col('intervention', 'Intervention', 'Active drug, dosage, regimen, or clinical intervention.'),
    col('comparator', 'Comparator', 'Control arm, placebo, or standard-of-care comparator.'),
    col('outcome', 'Outcome', 'Primary clinical outcome and effect size.'),
    col('study_design', 'Study Design', 'Trial design, blinding, randomization, and duration.')
  ] },
  custom: { name: 'Custom Review', columns: GENERAL_COLUMNS }
};
export const SUGGESTED_REVIEW_COLUMNS: readonly ReviewColumn[] = [
  col('sample_size', 'Sample Size', 'Total number of participants or evaluated samples.', 'number'),
  col('code_repo', 'Code / Repo', 'Public code repository or artifact availability.'),
  col('primary_endpoint', 'Primary Endpoint', 'Pre-specified primary clinical or experimental endpoint.'),
  col('adverse_events', 'Adverse Events', 'Reported safety profile and major adverse events.')
];

const dehyphen = (text: string): string => text.normalize('NFKC').replace(/\u00ad/g, '').replace(/([A-Za-z])-\s+([A-Za-z])/g, '$1$2');
const normWords = (text: string): string => dehyphen(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const normCompact = (text: string): string => dehyphen(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const matchesQuote = (haystack: string, quote: string): boolean => {
  const needle = normWords(quote), compact = normCompact(quote);
  return quote.replace(/\s+/g, '').length >= 8 && compact.length >= 8 && (normWords(haystack).includes(needle) || (compact.length >= 10 && normCompact(haystack).includes(compact)));
};
export function verifyQuote(input: { quote: string; page?: number | null; sourceKind: 'pdf' | 'abstract'; pages?: readonly DocPageRecord[]; abstract?: string }): { verified: boolean; page: number | null } {
  const quote = input.quote.trim();
  if (input.sourceKind === 'abstract') return { verified: Boolean(quote && matchesQuote(input.abstract || input.pages?.[0]?.text || '', quote)), page: null };
  const pages = input.pages ?? [], pageMap = new Map(pages.map(p => [p.page, p.text]));
  const claimed = typeof input.page === 'number' && Number.isSafeInteger(input.page) && pageMap.has(input.page) ? input.page : null;
  if (!quote) return { verified: false, page: claimed };
  if (claimed !== null && matchesQuote(pageMap.get(claimed) ?? '', quote)) return { verified: true, page: claimed };
  for (const p of pages) if (matchesQuote(p.text, quote)) return { verified: true, page: p.page };
  return { verified: false, page: claimed };
}

const asDecision = (raw: string): ReviewDecision | undefined => { const v = raw.trim().toLowerCase(); return v === 'yes' || v === 'no' || v === 'maybe' ? v : undefined; };
export function computeScreeningStatus(
  criteria: readonly ScreeningCriterion[], cells: ReadonlyMap<string, ExtractionCell> | readonly ExtractionCell[], strictCriterion: boolean, threshold: number
): { decision: ReviewDecision; score: number; manualOverride: boolean; included: boolean } {
  const map = cells instanceof Map ? cells : new Map((cells as readonly ExtractionCell[]).map(c => [c.colId, c]));
  const evaluated = criteria.map(c => asDecision(map.get(`screen:${c.id}`)?.value ?? '')).filter((d): d is ReviewDecision => Boolean(d));
  const score = evaluated.length ? evaluated.reduce((s, d) => s + (d === 'yes' ? 1 : d === 'maybe' ? 0.5 : 0), 0) / evaluated.length : 0;
  const sum = map.get('__screen__'), sumVal = sum ? asDecision(sum.value) : undefined;
  if (sum?.manualOverride && sumVal) return { decision: sumVal, score, manualOverride: true, included: sumVal !== 'no' };
  if (!evaluated.length) { const fb = sumVal ?? 'maybe'; return { decision: fb, score: 0, manualOverride: false, included: fb !== 'no' }; }
  const t = Math.max(0.1, Math.min(1, Number.isFinite(threshold) ? threshold : 0.6));
  const reqNo = criteria.some(c => c.required && asDecision(map.get(`screen:${c.id}`)?.value ?? '') === 'no');
  const decision: ReviewDecision = (strictCriterion && evaluated.includes('no')) || reqNo || evaluated.every(d => d === 'no') ? 'no'
    : score >= t ? 'yes' : evaluated.includes('maybe') && score >= t * 0.5 ? 'maybe' : 'no';
  return { decision, score, manualOverride: false, included: decision !== 'no' };
}

export function indexCellsByDoc(cells: readonly ExtractionCell[]): Map<string, Map<string, ExtractionCell>> {
  const byDoc = new Map<string, Map<string, ExtractionCell>>();
  for (const c of cells) { const m = byDoc.get(c.docId) ?? new Map<string, ExtractionCell>(); m.set(c.colId, c); byDoc.set(c.docId, m); }
  return byDoc;
}
function buildExportRows(table: ReviewTable, docs: readonly DocumentInfo[], cells: readonly ExtractionCell[]): string[][] {
  const byDoc = indexCellsByDoc(cells);
  return [
    ['Paper', 'Authors', 'Year', 'Source', 'Screening', ...table.columns.map(c => c.name)],
    ...docs.map(doc => {
      const m = byDoc.get(doc.id) ?? new Map<string, ExtractionCell>();
      const hasScr = m.has('__screen__') || table.criteria.some(c => m.has(`screen:${c.id}`));
      const screen = hasScr ? computeScreeningStatus(table.criteria, m, table.strictCriterion, table.threshold).decision : '';
      return [doc.paperTitle || doc.title, doc.authors ?? '', doc.year ?? '', doc.kind === 'abstract' ? 'Abstract only' : 'Full text', screen, ...table.columns.map(c => m.get(c.id)?.value ?? '')];
    })
  ];
}
export function exportReviewCsv(table: ReviewTable, docs: readonly DocumentInfo[], cells: readonly ExtractionCell[]): string {
  return buildExportRows(table, docs, cells).map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}
const mdCell = (v: string): string => v.replace(/\r?\n|\r/g, ' ').replace(/(?<!\\)\|/g, '\\|').replace(/\s+/g, ' ').trim();
export function exportReviewMarkdown(table: ReviewTable, docs: readonly DocumentInfo[], cells: readonly ExtractionCell[]): string {
  const [header, ...rows] = buildExportRows(table, docs, cells), line = (cols: string[]) => '| ' + cols.map(mdCell).join(' | ') + ' |';
  return [line(header), '| ' + header.map(() => '---').join(' | ') + ' |', ...rows.map(line)].join('\n') + '\n';
}
