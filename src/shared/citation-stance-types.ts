import type { QuestionModel } from './types.js';

export type CitationStance = 'supporting' | 'extending' | 'contrasting' | 'mentioning' | 'unclassified';
export type CitationSection = 'Introduction' | 'Methods' | 'Results' | 'Discussion' | 'Unknown';
export type CitationDirection = 'cited_by' | 'references';
export type CitationSource = 'local' | 's2' | 'europepmc' | 'openalex';
export const VALID_CITATION_STANCES: readonly CitationStance[] = ['supporting', 'extending', 'contrasting', 'mentioning', 'unclassified'];
export const VALID_CITATION_SECTIONS: readonly CitationSection[] = ['Introduction', 'Methods', 'Results', 'Discussion', 'Unknown'];

export interface CitationStatement {
  targetKey: string; direction: CitationDirection; citingKey: string; docId?: string; source: CitationSource;
  citingDocId?: string; citingPage?: number; citingTitle: string; citingAuthors: string[]; citingYear?: number;
  citingDoi?: string; citingArxiv?: string; citingUrl?: string; section: CitationSection; context: string;
  stance: CitationStance; rationale: string; isInfluential: boolean; isSelfCitation: boolean;
  manualOverride: boolean; updatedAt: string;
}
export interface CitationTallies {
  citingPapers: number; citationStatements: number; supporting: number; extending: number;
  contrasting: number; mentioning: number; unclassified: number; localBackCitations: number;
}
export interface CitationTargetInfo {
  targetKey: string; docId?: string; title: string; authors: string[]; year?: number;
  doi?: string; arxivId?: string; pmid?: string; sciteUrl: string;
}
export interface CitationReport {
  target: CitationTargetInfo; direction: CitationDirection; tallies: CitationTallies;
  statements: CitationStatement[]; sciteUrl: string; degraded: string[]; fromCache: boolean; offline: boolean;
}
export interface CitationAnalyzeInput {
  docId?: string; query?: string; doi?: string; arxivId?: string; direction?: CitationDirection;
  forceRefresh?: boolean; limit?: number; questionModel?: QuestionModel | null;
}
export interface CitationSummaryInput { docId?: string; query?: string; doi?: string; arxivId?: string; title?: string; direction?: CitationDirection }
export interface CitationSummary { targetKey: string; tallies: CitationTallies; sciteUrl: string; hasCachedExternal: boolean }
export interface CitationReclassifyInput { targetKey: string; direction: CitationDirection; citingKey: string; stance: CitationStance; rationale?: string }
export interface CitationReclassifyResult { statement: CitationStatement; tallies: CitationTallies }
