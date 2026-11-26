import type { PageView } from '../../shared/types.js';
import type { ReadingPosition } from '../jump-history.js';
import type { ResearchViewId } from './labels.js';

export type ReturnAnchor = ReadingPosition;
export interface ResearchOpenContext { docId?: string; topic?: string; filter?: string; query?: string; seedDocId?: string }
export interface InspectTarget { docId: string; page: number; anchor?: string; quote?: string; openNotes?: boolean }
export interface WorkspaceSnapshot { activeView: ResearchViewId; viewState?: unknown; scrollTop: number }

export interface ResearchShellContext {
  activeDocId: () => string; activeTopic: () => string; setActiveTopic: (tag: string) => void;
  openContext: () => ResearchOpenContext | undefined; openView: (view: ResearchViewId, ctx?: ResearchOpenContext) => void;
  inspectInReader: (target: InspectTarget) => Promise<void>; notifyDocumentMutated: (docId: string, deleted?: boolean) => void; refreshNotebook?: (docId: string) => void;
}

export interface ResearchViewModule {
  id: ResearchViewId; mount(host: HTMLElement, ctx: ResearchShellContext): void | Promise<void>;
  unmount?(): void; saveState?(): unknown; restoreState?(state: unknown): void;
  handleEscape?(): boolean; onDocumentMutated?(docId: string, deleted?: boolean): void;
}

export interface ResearchWorkspaceHost {
  activeDocId: () => string; prepareOpen: () => void; capturePosition: () => ReturnAnchor; restorePosition: (anchor: ReturnAnchor) => Promise<void>;
  inspectFromWorkspace: (target: InspectTarget, returnAnchor?: ReturnAnchor) => Promise<void>; focusAfterCollapse: () => void; refreshNotebook?: (docId: string) => void;
}

const norm = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

export function locateQuoteInView(view: PageView | undefined, quote: string): boolean {
  if (!view?.blocks.length) return false;
  const cleaned = quote.replace(/^[.…\s]+|[.…\s]+$/g, '').replace(/\s+/g, ' ').trim(), needle = norm(cleaned);
  if (!needle) return false;
  const direct = view.blocks.find(block => norm(block.text).includes(needle));
  if (direct) return view.locate(direct.id, cleaned) || view.locate(direct.id);
  const tokens = [...new Set(needle.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(tok => tok.length >= 3))];
  if (!tokens.length) return false;
  let best = view.blocks[0], bestScore = 0;
  for (const block of view.blocks) {
    const text = norm(block.text);
    const score = tokens.reduce((sum, tok) => sum + (text.includes(tok) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = block; }
  }
  if (!bestScore) return false;
  const phrase = cleaned.split(/[.;!?。；！？\n]/).map(s => s.trim()).find(s => s.length >= 8 && norm(best.text).includes(norm(s)));
  return (phrase ? view.locate(best.id, phrase) : false) || view.locate(best.id);
}
