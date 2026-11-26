import { connectFloat, type FloatBounds, type FloatController } from './desk-gestures.js';
import { screenshotFigureLabel } from './pdf/region-geometry.js';
import { el, icon, message, readerLabel as label, toast } from './ui.js';

const MAX_PINS = 3;
interface PinnedFigure { docId: string; page: number; anchor: string; image: string; label: string; isWeb?: boolean }
interface PinEntry { key: string; card: HTMLElement; img: HTMLImageElement; float: FloatController; events: AbortController; expand(): void }

export class FigurePins {
  private readonly layer = el('div', 'figure-pin-layer');
  private readonly cards: PinEntry[] = [];
  private topZ = 1;

  constructor(private readonly workspace: HTMLElement, private readonly onJump: (docId: string, page: number, anchor: string) => Promise<void>) {
    this.layer.hidden = true;
    this.layer.setAttribute('aria-label', label('Pinned figures', '钉选图表'));
    this.workspace.append(this.layer);
    new ResizeObserver(() => { for (const entry of this.cards) entry.float.clamp(); }).observe(this.layer);
  }

  pin(input: PinnedFigure): void {
    const key = [input.docId, input.page, input.anchor].join('\u0000');
    const existing = this.cards.find(item => item.key === key);
    if (existing) {
      existing.img.src = input.image; existing.expand(); this.raise(existing); existing.float.clamp();
      toast(label('Pinned figure updated.', '已更新钉选图表。'));
      return;
    }
    const replaced = this.cards.length >= MAX_PINS;
    if (replaced) this.remove(this.cards[0]);
    const events = new AbortController(), { signal } = events;
    const card = el('section', 'figure-pin-card');
    const figure = screenshotFigureLabel(input.label);
    const place = input.isWeb ? label('Article', '文章') : label('p. ' + input.page, '第 ' + input.page + ' 页');
    const caption = figure ? figure + ' · ' + place : place;
    card.ariaLabel = figure ? caption : label('Pinned figure', '钉选图表') + ' · ' + place;
    const head = el('header', 'figure-pin-head');
    head.tabIndex = 0;
    head.title = label('Drag pinned figure or use arrow keys', '拖动钉选图表或用方向键移动');
    const jump = el('button', 'figure-pin-jump text-btn');
    jump.type = 'button'; jump.append(el('span', '', caption), icon('arrow', 11));
    jump.ariaLabel = jump.title = caption + ' · ' + label('Jump to source', '跳回原处');
    jump.addEventListener('click', () => { void this.onJump(input.docId, input.page, input.anchor).catch(e => toast(message(e))); }, { signal });
    const body = el('div', 'figure-pin-body'), img = el('img');
    img.src = input.image; img.alt = card.ariaLabel; img.draggable = false;
    body.append(img);
    const zoomBtn = el('button', 'figure-pin-zoom icon-btn'), collapseBtn = el('button', 'figure-pin-collapse icon-btn'), closeBtn = el('button', 'figure-pin-close icon-btn');
    zoomBtn.type = collapseBtn.type = closeBtn.type = 'button';
    zoomBtn.append(icon('search', 14));
    closeBtn.ariaLabel = closeBtn.title = label('Close pinned figure', '关闭钉选图表');
    closeBtn.append(icon('close', 14));
    let collapsed = false, zoomed = false;
    const syncButtons = () => {
      card.dataset.collapsed = String(collapsed); card.dataset.zoomed = String(zoomed); body.hidden = collapsed;
      zoomBtn.setAttribute('aria-pressed', String(zoomed));
      zoomBtn.ariaLabel = zoomBtn.title = zoomed ? label('Reset zoom', '还原大小') : label('Zoom in', '放大');
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
      collapseBtn.ariaLabel = collapseBtn.title = collapsed ? label('Expand', '展开') : label('Collapse', '收起');
      collapseBtn.replaceChildren(icon(collapsed ? 'restore' : 'minimize', 14));
    };
    syncButtons();
    head.append(jump, zoomBtn, collapseBtn, closeBtn);
    card.append(head, body);
    const entry: PinEntry = {
      key, card, img, events,
      expand: () => { if (collapsed) { collapsed = false; syncButtons(); } },
      float: connectFloat({ handle: head, panel: card, bounds: () => this.bounds(), onFocus: () => this.raise(entry), signal })
    };
    card.addEventListener('pointerdown', () => this.raise(entry), { signal });
    zoomBtn.addEventListener('click', () => { zoomed = !zoomed; if (zoomed) collapsed = false; syncButtons(); this.raise(entry); entry.float.clamp(); }, { signal });
    collapseBtn.addEventListener('click', () => { collapsed = !collapsed; syncButtons(); this.raise(entry); entry.float.clamp(); }, { signal });
    closeBtn.addEventListener('click', () => this.remove(entry), { signal });
    img.addEventListener('load', () => entry.float.clamp(), { once: true, signal });
    this.cards.push(entry); this.layer.hidden = false; this.layer.append(card); this.raise(entry);
    const b = this.bounds(), offset = (this.cards.length - 1) * 24;
    entry.float.place(b.maxX - card.offsetWidth - offset, b.minY + offset);
    toast(replaced
      ? label('Maximum 3 pinned figures reached. Replaced the oldest card.', '最多可钉选 3 张图表，已替换最早的一张。')
      : label('Pinned to floating card.', '已钉选为浮动参考卡。'));
  }

  clear(): void { while (this.cards.length) this.remove(this.cards[0]); }
  private raise(entry: PinEntry): void { entry.card.style.zIndex = String(++this.topZ); }
  private remove(entry: PinEntry): void {
    entry.events.abort(); entry.card.remove();
    const index = this.cards.indexOf(entry);
    if (index >= 0) this.cards.splice(index, 1);
    if (!this.cards.length) this.layer.hidden = true;
  }
  private bounds(): FloatBounds {
    const topbar = this.workspace.querySelector<HTMLElement>('.topbar');
    const mobileBar = this.workspace.querySelector<HTMLElement>('#mobileBar');
    const minY = (topbar?.offsetHeight ?? 0) + 8;
    const bottomInset = (mobileBar && !mobileBar.hidden ? mobileBar.offsetHeight : 0) + 8;
    return { minX: 8, minY, maxX: Math.max(8, this.layer.clientWidth - 8), maxY: Math.max(minY, this.layer.clientHeight - bottomInset) };
  }
}
