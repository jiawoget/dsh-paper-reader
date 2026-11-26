import type { GraphPaper } from './types.js';

export type TrendMetric = 'volume' | 'growth' | 'citations';
export type TrendSort = 'fastest_growing' | 'hottest' | 'blind_spots_first';
export type TrendSource = 'openalex' | 'europepmc' | 'all';
export type TrendWindow = 3 | 5 | 8;
export type TrendPaperSort = 'representative' | 'newest' | 'library';

export interface TrendCell {
  year: number; volume: number; isYtd: boolean; yoyGrowth: number | null; lowBase: boolean; citations: number; citationHeat: number;
}
export interface TrendTopicRow {
  topicId: string; topicName: string; totalVolume: number; recent2yr: number; prior2yr: number;
  growth: number; lowBase: boolean; citationHeat: number; localCount: number; localDocIds: string[]; cells: TrendCell[];
}
export interface TrendQueryInput {
  query: string; source?: TrendSource; windowYears?: TrendWindow; metric?: TrendMetric; sort?: TrendSort; blindSpotsOnly?: boolean; topicLimit?: number;
}
export interface TrendQueryResult {
  query: string; source: TrendSource; windowYears: TrendWindow; years: number[]; ytdYear: number;
  metric: TrendMetric; sort: TrendSort; blindSpotsOnly: boolean; topics: TrendTopicRow[];
  degraded: string[]; fromCache: boolean; cachedAt?: number;
}
export interface TrendPapersInput {
  query: string; topicId: string; topicName?: string; year: number; source?: TrendSource; sort?: TrendPaperSort; limit?: number;
}
export interface TrendPaper extends GraphPaper {
  primaryTopicId?: string; primaryTopicName?: string; localDocId?: string;
}
export interface TrendPapersResult {
  query: string; topicId: string; topicName: string; year: number; source: TrendSource; sort: TrendPaperSort;
  papers: TrendPaper[]; degraded: string[]; fromCache: boolean; cachedAt?: number;
}

const readCount = (counts: ReadonlyMap<number, number> | Record<number, number>, year: number): number =>
  'get' in counts ? (counts.get(year) ?? 0) : (counts[year] ?? 0);

export function computeTrendGrowth(
  counts: ReadonlyMap<number, number> | Record<number, number>, ytdYear: number
): { recent2yr: number; prior2yr: number; growth: number; lowBase: boolean } {
  const recent2yr = readCount(counts, ytdYear - 2) + readCount(counts, ytdYear - 1);
  const prior2yr = readCount(counts, ytdYear - 4) + readCount(counts, ytdYear - 3);
  return { recent2yr, prior2yr, growth: (recent2yr - prior2yr) / Math.max(prior2yr, 1), lowBase: prior2yr < 10 };
}

export function computeCellYoyGrowth(
  volume: number, prevVolume: number | undefined, isYtd: boolean
): { yoyGrowth: number | null; lowBase: boolean } {
  if (isYtd || prevVolume === undefined) return { yoyGrowth: null, lowBase: (prevVolume ?? volume) < 10 };
  return { yoyGrowth: (volume - prevVolume) / Math.max(prevVolume, 1), lowBase: prevVolume < 10 };
}

export function computeCitationHeat(totalCitations: number, sampledWorks: number): number {
  if (!Number.isFinite(totalCitations) || !Number.isFinite(sampledWorks) || sampledWorks <= 0 || totalCitations <= 0) return 0;
  return Math.round((totalCitations / sampledWorks) * 10) / 10;
}

export function sortTrendTopics(rows: ReadonlyArray<TrendTopicRow>, sort: TrendSort, metric: TrendMetric = 'volume'): TrendTopicRow[] {
  const byGrowth = (a: TrendTopicRow, b: TrendTopicRow) => Number(a.lowBase) - Number(b.lowBase) || b.growth - a.growth || b.totalVolume - a.totalVolume || b.citationHeat - a.citationHeat;
  const byCites = (a: TrendTopicRow, b: TrendTopicRow) => b.citationHeat - a.citationHeat || b.totalVolume - a.totalVolume || b.growth - a.growth;
  const byVol = (a: TrendTopicRow, b: TrendTopicRow) => b.totalVolume - a.totalVolume || b.citationHeat - a.citationHeat || b.growth - a.growth;
  return [...rows].sort((a, b) => {
    if (sort === 'fastest_growing') return byGrowth(a, b) || a.topicId.localeCompare(b.topicId);
    if (sort === 'hottest') return (metric === 'citations' ? byCites(a, b) : byVol(a, b)) || a.topicId.localeCompare(b.topicId);
    const cov = a.localCount - b.localCount;
    if (cov !== 0) return cov;
    const secondary = metric === 'growth' ? byGrowth(a, b) : metric === 'citations' ? byCites(a, b) : byVol(a, b);
    return secondary || a.topicId.localeCompare(b.topicId);
  });
}

export function filterTrendTopics(rows: ReadonlyArray<TrendTopicRow>, blindSpotsOnly: boolean): TrendTopicRow[] {
  return blindSpotsOnly ? rows.filter(r => r.localCount === 0) : [...rows];
}
