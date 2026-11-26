import type { GraphPaper, GraphSource, QuestionModel } from './types.js';

export interface DeepSearchQuestion { id: string; question: string; options: string[] }
export interface DeepSearchClarifyInput { query: string; questionModel?: QuestionModel | null }
export interface DeepSearchClarifyResult { query: string; questions: DeepSearchQuestion[] }
export interface DeepSearchRunInput { query: string; answers?: Record<string, string>; rounds?: number; maxResults?: number; questionModel?: QuestionModel | null }
export interface DeepSearchRoundMetric { round: number; evaluated: number; matched: number; newMatches: number }
export interface DeepSearchCandidate extends GraphPaper { matchScore: number; rationale: string; category: string; foundRound: number }
export type DeepSearchStage = 'decompose' | 'recall' | 'score' | 'expand' | 'overview';
export interface DeepSearchProgressEvent {
  type: 'progress'; round: number; totalRounds: number; stage: DeepSearchStage; evaluatedCount: number;
  matchedCount: number; newMatches: number; saturationCurve: DeepSearchRoundMetric[]; degraded: string[]; message: string;
}
export interface DeepSearchResult {
  query: string; overview: string; categories: string[]; candidates: DeepSearchCandidate[]; roundsCompleted: number;
  totalEvaluated: number; saturationCurve: DeepSearchRoundMetric[]; degraded: string[]; aborted: boolean;
}
export type WatchlistKind = 'topic' | 'paper';
export interface WatchlistItem { key: string; paper: GraphPaper; foundAt: string; read?: boolean }
export interface WatchlistEntry {
  id: string; kind: WatchlistKind; label: string; query: string; docId?: string; workId?: string; sources: GraphSource[];
  cursorDate: string; seenKeys: string[]; unread: WatchlistItem[]; lastCheckedAt?: string; createdAt: string; updatedAt: string;
}
export interface WatchlistSaveInput {
  id?: string; kind: WatchlistKind; label?: string; query?: string; docId?: string; workId?: string; sources?: GraphSource[]; cursorDate?: string;
}
export interface WatchlistCheckResult { entries: WatchlistEntry[]; checkedCount: number; newItemsCount: number; degraded: string[] }
