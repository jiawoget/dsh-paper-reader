import type { DocumentInfo } from '../shared/types.js';
import type { PdfDocument } from './pdf-view.js';
import { api, button, byId, el, icon, message, readerLabel as label, toast } from './ui.js';

export interface ContentsDestination {
  page: number;
  title: string;
  anchor?: string;
  top?: number;
}
interface Entry extends ContentsDestination { level: number }
interface Row { entry: Entry; button: HTMLButtonElement }

export function outlineAnchor(top = 0, title = ''): string {
  const name = title.replace(/\s+/gu, ' ').trim().slice(0, 180);
  return 'outline:' + Math.round(Math.max(0, Math.min(1, top)) * 100000) + (name ? ':' + name : '');
}
export function outlineLocation(anchor: string): {top: number; title: string} | undefined {
  const match = /^outline:(\d{1,6})(?::(.{1,180}))?$/u.exec(anchor);
  if (!match) return;
  const top = Number(match[1]) / 100000;
  return top <= 1 ? {top, title: match[2] ?? ''} : undefined;
}

export class ReaderContents {
  private readonly panel = byId('contentsPanel');
  private readonly paper = byId('paperScroll');
  private readonly translation = byId('translated');
  private doc?: DocumentInfo;
  private pdf?: PdfDocument;
  private page = 1;
  private entries: Row[] = [];
  private active?: Row;
  private picked?: { destination: ContentsDestination; scroll: number; translation: number };
  private job = new AbortController();
  private pdfStarted = false;
  private frame = 0;
  private visible = false;
  private choice = 0;

  constructor(private go: (target: ContentsDestination) => Promise<boolean>,
    private pdfTop: () => number, private settings: () => void) {
    const onScroll = () => this.schedule();
    this.paper.addEventListener('scroll', onScroll, {passive: true});
    this.translation.addEventListener('scroll', onScroll, {passive: true});
    new ResizeObserver(() => {
      const visible = this.panel.clientHeight > 0;
      if (visible && !this.visible) this.refresh(true);
      this.visible = visible;
    }).observe(this.panel);
    new ResizeObserver(onScroll).observe(byId('original'));
  }

  document(doc: DocumentInfo, page: number, pdf?: PdfDocument): void {
    const changed = doc.id !== this.doc?.id;
    if (changed) {
      this.job.abort();
      this.job = new AbortController();
      this.pdfStarted = false;
      this.entries = [];
      this.active = undefined;
      this.panel.replaceChildren();
      this.panel.scrollTop = 0;
    }
    if (changed || page !== this.page) this.picked = undefined;
    this.doc = doc; this.page = page; this.pdf = pdf;
    if (changed && doc.book) this.buildBook(doc);
    else if (changed && !pdf) this.buildArticle(doc);
    if (this.panel.clientHeight) this.refresh(changed);
    this.schedule();
  }

  private refresh(reveal: boolean): void {
    if (this.pdf && !this.pdfStarted) {
      this.pdfStarted = true;
      void this.loadPdf(this.pdf, this.job.signal);
    }
    this.track(reveal);
  }
  private schedule(): void {
    if (this.frame || !this.panel.clientHeight) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.track(false); });
  }
  remember(destination: ContentsDestination): void {
    this.picked = {destination, scroll: this.paper.scrollTop, translation: this.translation.scrollTop};
    this.track(true);
  }

  private row(entry: Entry, showPage = false): HTMLButtonElement {
    const node = el('button', 'toc-entry');
    node.type = 'button';
    node.append(el('span', 'toc-label', entry.title));
    if (showPage) {
      const number = el('span', 'toc-page', String(entry.page));
      number.setAttribute('aria-hidden', 'true');
      node.ariaDescription = label('Page ' + entry.page, '第 ' + entry.page + ' 页');
      node.append(number);
    }
    const row = {entry, button: node};
    node.addEventListener('click', () => {
      const choice = ++this.choice;
      void this.go(entry).then(reached => {
        if (!reached || choice !== this.choice || !node.isConnected) return;
        this.remember(entry);
      }).catch(error => toast(message(error)));
    });
    this.entries.push(row);
    return node;
  }

  private nav(name: string): HTMLElement {
    const nav = el('nav', 'toc-nav');
    nav.ariaLabel = name;
    return nav;
  }
  private buildBook(doc: DocumentInfo): void {
    const nav = this.nav(label('Book contents', '全书目录'));
    let chapter = '', list: HTMLUListElement | undefined;
    doc.book!.sections.forEach((section, i) => {
      if (!list || section.chapterId !== chapter) {
        const group = el('details', 'toc-chapter'), summary = el('summary');
        summary.append(icon('next', 14), el('span', '', section.chapterTitle));
        list = el('ul'); group.append(summary, list); nav.append(group);
        chapter = section.chapterId;
      }
      const item = el('li');
      item.append(this.row({title: section.title, page: i + 1, level: 1}));
      list.append(item);
    });
    this.panel.append(nav);
  }
  private buildArticle(doc: DocumentInfo): void {
    const entries: Entry[] = [];
    for (const [i, title] of (doc.paragraphs ?? []).entries()) {
      const anchor = 'p-' + (i + 1), kind = doc.articleLayout?.[anchor]?.kind ?? '';
      if (/^h[1-6]$/.test(kind) && title.trim() && title.trim() !== doc.title.trim())
        entries.push({title, page: 1, level: Number(kind.slice(1)), anchor});
    }
    if (entries.length) {
      const firstLevel = Math.min(...entries.map(entry => entry.level));
      entries.unshift({title: label('Start of article', '文章开头'), page: 1, level: firstLevel});
      this.tree(entries, false);
    }
    else {
      this.status(label('This article has no section headings.', '这篇文章没有小标题。'));
      this.panel.append(this.row({title: label('Start of article', '文章开头'), page: 1, level: 1}));
    }
  }

  private tree(entries: Entry[], pdf: boolean, generated = false): void {
    this.entries = []; this.active = undefined;
    const nav = this.nav(pdf ? label('PDF contents', 'PDF 目录') : label('Article contents', '文章目录'));
    const list = el('ul');
    nav.append(list);
    const parents: {level: number; item: HTMLLIElement; list?: HTMLUListElement}[] = [];
    for (const entry of entries) {
      while (parents.length && parents.at(-1)!.level >= entry.level) parents.pop();
      const parent = parents.at(-1);
      if (parent && !parent.list) {
        const children = el('ul'), title = parent.item.querySelector('.toc-label')!.textContent;
        const expanded = entries.length <= 45;
        const toggle = el('button', 'toc-fold'); toggle.type = 'button';
        toggle.ariaLabel = label('Subsections of ', '下级目录 · ') + title;
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.append(icon('next', 12));
        toggle.onclick = () => {
          children.hidden = !children.hidden;
          toggle.setAttribute('aria-expanded', String(!children.hidden));
        };
        children.hidden = !expanded;
        parent.item.firstElementChild!.prepend(toggle);
        parent.item.append(children);
        parent.list = children;
      }
      const item = el('li'), line = el('div', 'toc-line');
      line.append(this.row(entry, pdf)); item.append(line);
      (parent?.list ?? list).append(item);
      parents.push({level: entry.level, item});
    }
    this.panel.replaceChildren();
    if (generated) this.panel.append(el('p', 'toc-origin', label('AI-generated contents', 'AI 生成的目录')));
    this.panel.append(nav);
    this.track(true);
  }

  private status(text: string): HTMLElement {
    const status = el('p', 'toc-status', text);
    status.setAttribute('role', 'status');
    this.panel.replaceChildren(status);
    return status;
  }
  private async loadPdf(pdf: PdfDocument, signal: AbortSignal): Promise<void> {
    this.status(label('Reading PDF bookmarks…', '正在读取 PDF 书签…'));
    try {
      // Some readable PDFs have a damaged bookmark dictionary.
      const entries = await pdf.outline().catch(() => null);
      if (signal.aborted) return;
      if (entries?.length) { this.tree(entries, true); return; }
      const saved = await api('outline.get', {docId: this.doc!.id});
      if (signal.aborted) return;
      if (saved.entries.length) this.tree(saved.entries, true, true);
      else this.offerGeneration(pdf, undefined, entries === null);
    } catch (error) {
      if (signal.aborted) return;
      this.status(label('Could not open the contents. ', '目录未能打开。') + message(error));
      this.panel.append(button(label('Try again', '重试'), () => this.loadPdf(pdf, signal)));
    }
  }
  private offerGeneration(pdf: PdfDocument, error?: string, brokenBookmarks = false): void {
    const noModel = /connect a .*model|model needs authorization|denied access|check .*api key|no .*model|model .*configured|model .*available|reader connections/i.test(error || '');
    let detail = brokenBookmarks ? label('The PDF bookmarks could not be read.', '这份 PDF 的书签无法读取。') : label('This PDF has no bookmarks.', '这份 PDF 没有书签。');
    if (error) {
      if (noModel) detail = label('Connect an AI model to generate contents.', '连接 AI 模型后即可生成目录。');
      else if (/invalid PDF contents|could not identify any sections/i.test(error))
        detail = label(error, '模型未能生成可定位到原文的目录。请重试。');
      else if (/too many pages for contents generation/i.test(error))
        detail = label('Split this PDF into smaller volumes to generate contents.', '这份 PDF 页数过多，请分卷后生成目录。');
      else detail = error;
    }
    this.status(detail);
    if (noModel) this.panel.append(button(label('Connect a model', '连接模型'), this.settings, 'text-btn'));
    const action = button(error ? label('Try again', '重试') : label('Generate contents with AI', '用 AI 生成目录'),
      () => this.generate(pdf, this.job.signal), 'btn');
    action.id = 'generateOutline'; this.panel.append(action);
  }
  private async generate(pdf: PdfDocument, signal: AbortSignal): Promise<void> {
    const docId = this.doc!.id;
    const status = this.status(label('Reading the PDF…', '正在读取 PDF…'));
    try {
      const pages = await pdf.outlinePages((done, total) => {
        if (!signal.aborted) status.textContent = label('Reading pages ', '正在读取页码 ') + done + ' / ' + total;
      }, signal);
      if (signal.aborted) return;
      if (!pages.some(page => page.lines.length)) {
        this.status(label('This PDF has no readable text. Run OCR on the file, then open the searchable copy.', '这份 PDF 没有可读取的文字。请先用 OCR 识别文字，再打开识别后的文件。'));
        return;
      }
      status.textContent = label('Generating contents…', '正在生成目录…');
      const result = await api('outline.generate', {docId, pageCount: pdf.pages, pages});
      if (!signal.aborted) this.tree(result.entries, true, true);
    } catch (error) {
      if (!signal.aborted) this.offerGeneration(pdf, message(error));
    }
  }

  private track(reveal: boolean): void {
    if (!this.entries.length || !this.panel.clientHeight) return;
    if (this.picked && Math.abs(this.paper.scrollTop - this.picked.scroll) <= 2 &&
        Math.abs(this.translation.scrollTop - this.picked.translation) <= 2) {
      const destination = this.picked.destination;
      const match = this.entries.find(({entry}) => entry === destination || entry.page === destination.page &&
        (!destination.title || entry.title.slice(0, 180) === destination.title) &&
        Math.abs((entry.top ?? 0) - (destination.top ?? 0)) < .000011);
      if (match) { this.mark(match, reveal); return; }
    }
    this.picked = undefined;
    let current: Row | undefined;
    if (this.doc?.book) current = this.entries[this.page - 1];
    else if (this.pdf) {
      const top = this.pdfTop() + .002;
      for (const row of this.entries) {
        const e = row.entry, best = current?.entry;
        if (e.page > this.page || (e.page === this.page && (e.top ?? 0) > top)) continue;
        if (!best || e.page > best.page || (e.page === best.page && (e.page < this.page || (e.top ?? 0) >= (best.top ?? 0)))) current = row;
      }
    } else {
      const host = byId('original').offsetWidth ? byId('original') : this.translation;
      const line = this.paper.getBoundingClientRect().top + 48;
      for (const row of this.entries) {
        const heading = row.entry.anchor && host.querySelector<HTMLElement>('[data-anchor="' + row.entry.anchor + '"]');
        if (heading && heading.getBoundingClientRect().top > line) break;
        current = row;
      }
    }
    this.mark(current, reveal);
  }
  private mark(row: Row | undefined, reveal: boolean): void {
    if (!reveal && this.active === row) return;
    this.active?.button.removeAttribute('aria-current');
    this.active = row;
    if (!row) return;
    row.button.setAttribute('aria-current', 'location');
    const chapter = row.button.closest('details');
    if (chapter) chapter.open = true;
    for (let list = row.button.closest('ul'); list; list = list.parentElement?.closest('ul') ?? null) {
      if (list.hidden) {
        list.hidden = false;
        list.parentElement?.querySelector('.toc-fold')?.setAttribute('aria-expanded', 'true');
      }
    }
    const panel = this.panel.getBoundingClientRect(), item = row.button.getBoundingClientRect();
    if (item.top < panel.top) this.panel.scrollTop += item.top - panel.top - 8;
    else if (item.bottom > panel.bottom) this.panel.scrollTop += item.bottom - panel.bottom + 8;
  }
}
