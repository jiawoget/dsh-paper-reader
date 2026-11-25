import type { ReadingMode } from './reading-desk.js';
import { button, byId, icon, readerLabel as label } from './ui.js';

export interface ReadingPosition {
  doc: string; page: number; mode: ReadingMode; text: boolean;
  top: number; left: number; translationTop: number; translationLeft: number; historyTop?: number;
}

const HISTORY_LIMIT = 50;
const stripChat = ({ doc, page, mode, text, top, left, translationTop, translationLeft }: ReadingPosition): ReadingPosition =>
  ({ doc, page, mode, text, top, left, translationTop, translationLeft });
const samePosition = (a: ReadingPosition, b: ReadingPosition) =>
  a.doc === b.doc && a.page === b.page && a.mode === b.mode && a.text === b.text
  && Math.abs(a.top - b.top) <= 4 && Math.abs(a.translationTop - b.translationTop) <= 4;

export class JumpHistory {
  private readonly backStack: ReadingPosition[] = [];
  private readonly forwardStack: ReadingPosition[] = [];
  constructor(private readonly onChange?: () => void) {}

  push(position: ReadingPosition): void {
    const clean = stripChat(position), prev = this.backStack.at(-1);
    if (prev && samePosition(prev, clean)) return;
    this.backStack.push(clean);
    if (this.backStack.length > HISTORY_LIMIT) this.backStack.shift();
    this.forwardStack.length = 0;
    this.onChange?.();
  }
  back(current: ReadingPosition): ReadingPosition | undefined {
    const target = this.backStack.pop();
    if (!target) return;
    this.forwardStack.push(stripChat(current));
    if (this.forwardStack.length > HISTORY_LIMIT) this.forwardStack.shift();
    this.onChange?.();
    return target;
  }
  forward(current: ReadingPosition): ReadingPosition | undefined {
    const target = this.forwardStack.pop();
    if (!target) return;
    this.backStack.push(stripChat(current));
    if (this.backStack.length > HISTORY_LIMIT) this.backStack.shift();
    this.onChange?.();
    return target;
  }
  canBack(): boolean { return this.backStack.length > 0; }
  canForward(): boolean { return this.forwardStack.length > 0; }
  clear(): void {
    if (!this.backStack.length && !this.forwardStack.length) return;
    this.backStack.length = this.forwardStack.length = 0;
    this.onChange?.();
  }
}

export function bindJumpHistoryControls(opts: {
  history: JumpHistory; isMobileBar: () => boolean; closeMenu: (restoreFocus?: boolean) => void;
  onBack: () => unknown; onForward: () => unknown;
}): { sync: () => void; menuButtons: [HTMLButtonElement, HTMLButtonElement] } {
  const group = document.querySelector<HTMLElement>('.jump-history');
  const backBtn = byId<HTMLButtonElement>('jumpBack'), forwardBtn = byId<HTMLButtonElement>('jumpForward');
  const backName = label('Jump back', '返回上一位置'), forwardName = label('Jump forward', '前进到下一位置');
  if (group) group.ariaLabel = label('Jump history', '跳转历史');
  backBtn.append(icon('arrowLeft')); forwardBtn.append(icon('arrowRight'));
  backBtn.ariaLabel = backName; backBtn.title = label('Jump back (Alt+←)', '返回上一位置 (Alt+←)');
  forwardBtn.ariaLabel = forwardName; forwardBtn.title = label('Jump forward (Alt+→)', '前进到下一位置 (Alt+→)');
  backBtn.addEventListener('click', () => { void opts.onBack(); });
  forwardBtn.addEventListener('click', () => { void opts.onForward(); });
  const menuBack = button(backName, () => { opts.closeMenu(true); return opts.onBack(); }, '', 'arrowLeft');
  const menuForward = button(forwardName, () => { opts.closeMenu(true); return opts.onForward(); }, '', 'arrowRight');
  const sync = () => {
    const mobile = opts.isMobileBar();
    backBtn.disabled = menuBack.disabled = !opts.history.canBack();
    forwardBtn.disabled = menuForward.disabled = !opts.history.canForward();
    menuBack.hidden = menuForward.hidden = !mobile;
  };
  sync();
  return { sync, menuButtons: [menuBack, menuForward] };
}
