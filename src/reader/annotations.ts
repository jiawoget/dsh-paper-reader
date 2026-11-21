import type { AnnotationColor, PaperAnnotation } from '../shared/annotations.js';
import type { BookInfo, SourceRecord } from '../shared/types.js';
import { readTranslatedLocator } from '../shared/source-link.js';
import { api, button, byId, el, icon, message, readerLabel as label, sourceUrl, toast } from './ui.js';

type Point = NonNullable<PaperAnnotation['point']>;
type Kind = PaperAnnotation['kind'];
const colors: AnnotationColor[] = ['yellow', 'green', 'purple'];
const storageKey = (docId: string) => 'reader.annotation-drafts.' + docId;
const colorName = (color: AnnotationColor) => label(color[0].toUpperCase() + color.slice(1), {yellow:'黄色', green:'绿色', purple:'紫色'}[color]);
export const highlightName = (color: AnnotationColor) => colorName(color) + label(' highlight', '高亮');
export function readPagePoint(anchor: string): Point | undefined {
  const match = /^point-(\d{1,7})-(\d{1,7})$/u.exec(anchor);
  if (match && +match[1] <= 1e6 && +match[2] <= 1e6) return { x: +match[1] / 1e6, y: +match[2] / 1e6 };
}
export function visibleQuote(note: PaperAnnotation): string {
  const url = URL.parse(note.sourceUrl);
  return (url && readTranslatedLocator(url)?.text) || note.quote;
}
function figureAtPoint(sheet:HTMLElement, point:Point): HTMLElement | undefined {
  const box=sheet.getBoundingClientRect(), x=box.left+point.x*box.width, y=box.top+point.y*box.height;
  return Array.from(sheet.querySelectorAll<HTMLElement>('.pdf-figure')).find(figure=>{
    const area=figure.getBoundingClientRect();
    return x>=area.left && x<=area.right && y>=area.top && y<=area.bottom;
  });
}
interface Controls {
  showIndex(): void;
  locate(note: PaperAnnotation): Promise<void>;
  cite(note: PaperAnnotation, excerpt: string): Promise<void>;
  repaintPage(): void;
  trigger(id: string): HTMLElement | undefined;
  refresh(): Promise<void>;
}
interface Editor {
  note: PaperAnnotation;
  root: HTMLElement;
  text: HTMLTextAreaElement;
  problem: HTMLElement;
  save: HTMLButtonElement;
  colorButtons: HTMLButtonElement[];
  saving: boolean;
}

export class AnnotationWorkspace {
  readonly root = el('section', 'annotation-workspace');
  readonly popover = el('section', 'annotation-popover');
  private readonly index = el('div', 'annotation-index');
  private docId = '';
  private book?: BookInfo;
  private records = new Map<string, PaperAnnotation>();
  private drafts = new Map<string, PaperAnnotation>();
  private editor?: Editor;
  private inRail = false;
  private filter: Kind | 'all' = 'all';
  private problem = '';
  private lastTrigger?: HTMLElement;
  private returnFromInline?: () => void;
  revision = 0;

  constructor(private readonly controls: Controls) {
    this.root.ariaLabel = 'Annotations for this paper';
    this.root.append(this.index);
    this.popover.hidden = true;
    this.popover.ariaLabel = 'Page note';
    this.popover.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.closeEditor(true); }
    });
    document.addEventListener('pointerdown', event => {
      const node = event.target;
      if (!this.popover.hidden && node instanceof Node && !this.popover.contains(node) &&
        !(this.lastTrigger?.contains(node))) this.closeEditor(false);
    }, true);
    byId('reader').append(this.popover);
    byId('paperScroll').addEventListener('scroll', () => this.position(), { passive: true });
    new ResizeObserver(() => this.position()).observe(byId('original'));
    window.addEventListener('resize', () => requestAnimationFrame(() => {
      if (!this.popover.hidden && byId('reader').dataset.notebookPose === 'sheet' && this.editor) this.dockEditor();
      else this.position();
    }));
  }
  switchDocument(id: string, book?: BookInfo): void {
    this.book=book;
    if (this.docId === id) return;
    this.closeEditor(false); this.docId = id; this.records.clear(); this.drafts.clear();
    this.problem = ''; this.filter = 'all'; this.revision++;
    try {
      const data: unknown = JSON.parse(sessionStorage.getItem(storageKey(id)) || '[]');
      if (Array.isArray(data)) for (const item of data) {
        if (item && item.docId === id && typeof item.id === 'string' && typeof item.text === 'string' &&
          typeof item.sourceUrl === 'string' && colors.includes(item.color) &&
          (item.kind === 'highlight' || item.kind === 'pin' && readPagePoint(item.anchor))) this.drafts.set(item.id, item);
      }
    } catch { /* Keep the notebook available if browser storage has been cleared. */ }
    this.renderIndex();
  }
  accept(items: PaperAnnotation[] | undefined, error = ''): void {
    this.problem = error;
    if (items) this.records = new Map(items.map(item => [item.id, item]));
    this.renderIndex(); this.controls.repaintPage();
  }
  private remember(): void {
    try {
      if (this.drafts.size) sessionStorage.setItem(storageKey(this.docId), JSON.stringify([...this.drafts.values()]));
      else sessionStorage.removeItem(storageKey(this.docId));
    } catch { /* The live editor still owns its draft. */ }
  }
  private all(): PaperAnnotation[] {
    return [...new Map([...this.records, ...this.drafts]).values()];
  }
  onPage(page: number): PaperAnnotation[] { return this.all().filter(item => item.page === page); }
  savedHighlights(): PaperAnnotation[] {
    return Array.from(this.records.values()).filter(item => item.kind === 'highlight')
      .sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  pinAt(page: number, anchor: string): PaperAnnotation | undefined {
    return this.onPage(page).find(item => item.kind === 'pin' && item.anchor === anchor);
  }
  attach(parent: HTMLElement): void { if (this.root.parentElement !== parent) parent.replaceChildren(this.root); }
  showList(): void { this.closeEditor(false); this.controls.showIndex(); }
  private renderIndex(): void {
    const focused = this.index.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : undefined;
    const categories = el('div', 'annotation-filters'); categories.ariaLabel = label('Filter annotations','筛选批注');
    for (const [value, caption] of [['all',label('All','全部')],['highlight',label('Highlights','高亮')],['pin',label('Page notes','页边笔记')]] as const) {
      const choice = button(caption, () => {this.filter = value; this.renderIndex();}, 'annotation-filter');
      choice.dataset.filter = value;
      choice.setAttribute('aria-pressed', String(this.filter === value)); categories.append(choice);
    }
    const list = el('div','annotation-groups');
    const items = this.all().filter(n => this.filter === 'all' || n.kind === this.filter)
      .sort((a,b) => a.page-b.page || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    let page = 0;
    for (const note of items) {
      if (page !== note.page && !note.docId.startsWith('web-')) {
        page = note.page;
        list.append(el('h3','annotation-page-title',this.book?.sections[page-1]?.title || label('Page ' + page,'第 ' + page + ' 页')));
      }
      const row = button('', () => this.open(note.id, row, true), 'annotation-entry');
      row.dataset.id = note.id;
      const type = el('span', 'annotation-meta');
      type.append(icon(note.kind === 'pin' ? 'pin' : 'edit', 14), note.kind === 'pin' ? label('Page note','页边笔记') : highlightName(note.color));
      if(note.kind==='pin' && note.label!=='Page note')type.append(' · '+note.label);
      if (this.drafts.has(note.id)) type.append(label(' · Draft',' · 草稿'));
      if (note.kind === 'highlight') type.dataset.color = note.color;
      const excerpt = el('strong','', note.text.trim() || visibleQuote(note) || note.label);
      excerpt.dir = 'auto'; row.append(type, excerpt);
      if (note.text && note.quote) {const quote = el('span','annotation-excerpt',visibleQuote(note)); quote.dir='auto'; row.append(quote);}
      list.append(row);
    }
    if (!items.length) list.append(el('p','hint',this.filter === 'all' ? label('Your highlights and page notes appear here.','这里会显示高亮和页边笔记。') :
      this.filter === 'pin' ? label('No page notes for this paper.','本篇暂无页边笔记。') : label('No highlights for this paper.','本篇暂无高亮。')));
    this.index.replaceChildren(el('h2','',label('Annotations','批注索引')), categories);
    if (this.problem) {
      const failure = el('p','annotation-error',this.problem + ' ');
      failure.append(button('Retry', () => this.controls.refresh(), 'text-btn')); this.index.append(failure);
    }
    this.index.append(list);
    if (focused?.id) this.index.querySelector<HTMLElement>('[data-id="'+CSS.escape(focused.id)+'"]')?.focus({preventScroll:true});
    else if (focused?.filter) this.index.querySelector<HTMLElement>('[data-filter="'+CSS.escape(focused.filter)+'"]')?.focus({preventScroll:true});
  }
  async highlight(source: SourceRecord, quote: string): Promise<void> {
    const existing = this.all().find(n => n.kind === 'highlight' && n.sourceUrl === source.sourceUrl && n.quote === quote);
    if (existing) { this.open(existing.id, undefined, true); return; }
    const note: PaperAnnotation = {...source, id:crypto.randomUUID(),kind:'highlight',color:'yellow',quote,text:'',createdAt:'',updatedAt:''};
    this.drafts.set(note.id,note); this.remember(); this.revision++;
    try {
      const saved = await this.write(note);
      if (this.docId === saved.docId) toast(label('Highlight saved.', '已保存高亮。'), {label:label('Undo','撤销'),run:()=>this.remove(saved,false)});
    } catch (error) {
      if (this.docId === note.docId) { this.renderIndex(); this.controls.repaintPage(); this.open(note.id,undefined,true); this.showProblem(message(error)); }
      throw error;
    }
  }
  addPin(doc: {id:string;title:string}, page: number, point: Point): void {
    const anchor = 'point-' + Math.round(point.x * 1e6) + '-' + Math.round(point.y * 1e6);
    const sheet=byId('original').querySelector<HTMLElement>('.pdf-sheet');
    const label=(sheet && figureAtPoint(sheet,point)?.ariaLabel) || 'Page note';
    const note: PaperAnnotation = {id:crypto.randomUUID(),docId:doc.id,title:doc.title,page,anchor,label,
      sourceUrl:sourceUrl(doc.id,page,anchor),kind:'pin',color:'purple',quote:'',text:'',point,createdAt:'',updatedAt:''};
    this.drafts.set(note.id,note); this.remember(); this.revision++;
    this.controls.repaintPage(); this.renderIndex();
    this.open(note.id, this.controls.trigger(note.id), false);
  }
  open(id: string, trigger?: HTMLElement, rail = false): void {
    const note = this.drafts.get(id) ?? this.records.get(id); if (!note) return;
    this.closeEditor(false); this.lastTrigger = trigger;
    this.inRail = rail || note.kind === 'highlight' || byId('reader').dataset.notebookPose === 'sheet';
    if (this.inRail) this.controls.showIndex();
    const editor = this.buildEditor({...note});
    this.editor = editor;
    if (this.inRail) {this.root.replaceChildren(editor.root);}
    else {this.popover.replaceChildren(editor.root); this.popover.hidden = false; this.position();}
    editor.text.focus({preventScroll:true});
  }
  openInline(id: string, trigger: HTMLElement, back: () => void): void {
    this.open(id, trigger, true);
    if (this.editor?.note.id === id) this.returnFromInline = back;
  }
  private dockEditor(): void {
    const e = this.editor; if (!e) return;
    const start = e.text.selectionStart, end = e.text.selectionEnd;
    this.inRail = true; this.controls.showIndex(); this.popover.hidden = true;
    this.root.replaceChildren(e.root); e.text.focus({preventScroll:true}); e.text.setSelectionRange(start,end);
  }
  private position(): void {
    if (this.popover.hidden || !this.editor) return;
    const paper = byId('paperScroll').getBoundingClientRect();
    const trigger = this.controls.trigger(this.editor.note.id) ?? this.lastTrigger;
    const target = trigger?.isConnected ? trigger.getBoundingClientRect() : undefined;
    if (target && (target.bottom < paper.top || target.top > paper.bottom)) { this.closeEditor(false); return; }
    this.popover.style.maxHeight=Math.max(60,paper.height-8)+'px';
    const width = this.popover.offsetWidth, height = this.popover.offsetHeight;
    let left = target && target.right+width+10 <= paper.right ? target.right+8 : (target?.left ?? paper.right)-width-8;
    let top = target?.top ?? paper.top+12;
    const sheet=trigger?.closest<HTMLElement>('.pdf-sheet');
    if(sheet && target){
      const bounds=sheet.getBoundingClientRect();
      const leftGutter=bounds.left-paper.left>=width+14, rightGutter=paper.right-bounds.right>=width+14;
      if(leftGutter && (!rightGutter || target.left < (bounds.left+bounds.right)/2))left=bounds.left-width-8;
      else if(rightGutter)left=bounds.right+8;
      else if(this.editor.note.point){
        const figure=figureAtPoint(sheet,this.editor.note.point)?.getBoundingClientRect();
        if(figure && figure.bottom+height+8 <= paper.bottom)top=figure.bottom+8;
        else if(figure && figure.top-height-8 >= paper.top)top=figure.top-height-8;
      }
    }
    this.popover.style.left = Math.max(paper.left+5,Math.min(paper.right-width-5,left))+'px';
    this.popover.style.top = Math.max(paper.top+4,Math.min(paper.bottom-height-4,top))+'px';
  }
  closePageEditor(): void { if (!this.popover.hidden) this.closeEditor(false); }
  private closeEditor(focus: boolean): void {
    const e=this.editor; if(!e)return;
    const back = this.returnFromInline;
    this.returnFromInline = undefined;
    this.editor=undefined; this.popover.hidden=true; this.popover.replaceChildren();
    this.root.replaceChildren(this.index); this.renderIndex();
    if (focus && back) back();
    else if(focus) {
      const trigger = this.inRail ? this.index.querySelector<HTMLElement>('[data-id="'+CSS.escape(e.note.id)+'"]') :
        this.controls.trigger(e.note.id);
      (trigger ?? (this.lastTrigger?.isConnected ? this.lastTrigger : byId('paperScroll'))).focus({preventScroll:true});
    }
    this.lastTrigger=undefined;
  }
  private buildEditor(note: PaperAnnotation): Editor {
    const root=el('section','annotation-editor'), header=el('header','annotation-heading');
    const kind=note.kind==='pin'?'Page note':'Highlight';
    const close=button('',()=>this.closeEditor(true),'icon-btn','close'); close.ariaLabel=close.title=label('Close annotation','关闭批注');
    header.append(el('h2','',label(kind,note.kind==='pin'?'页边笔记':'高亮')),close);
    const place=this.book?label('Section','小节'):note.docId.startsWith('web-')?label('Article','文章'):label('Page '+note.page,'第 '+note.page+' 页');
    const location=button(place+(note.label && note.label!==kind?' · '+note.label:''),()=>this.controls.locate(note),'source-chip','arrow');
    root.append(header,location);
    if(note.quote){const quote=el('blockquote','annotation-quote',visibleQuote(note));quote.dir='auto';root.append(quote);}
    const field=el('label','field');const text=el('textarea','annotation-text');text.rows=3;text.dir='auto';
    text.value=note.text;field.append(el('span','',label('Comment','批注内容')),text);root.append(field);
    const problem=el('div','annotation-error');problem.setAttribute('role','alert');
    const save=button(label('Save','保存'),()=>this.saveEditor(editor),'btn primary','check');
    const editor:Editor={note,root,text,problem,save,colorButtons:[],saving:false};
    const remember=()=>{ this.drafts.set(note.id,{...note});this.remember(); };
    text.oninput=()=>{note.text=text.value;remember();};
    text.onkeydown=event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();save.click();}};
    if(note.kind==='highlight') {
      const palette=el('fieldset','annotation-palette');palette.append(el('legend','',label('Highlight color','高亮颜色')));
      for(const color of colors) {
        const choice=button(colorName(color),()=>{note.color=color;remember();this.controls.repaintPage();
          for(const b of editor.colorButtons)b.setAttribute('aria-pressed',String(b.dataset.color===color));},'annotation-swatch');
        choice.dataset.color=color;choice.setAttribute('aria-pressed',String(note.color===color));editor.colorButtons.push(choice);palette.append(choice);
      }
      root.append(palette);
    }
    const end=el('div','annotation-editor-actions');
    const cite=button(label('Cite in notebook','引用到笔记'),async()=>{
      const saved=await this.saveEditor(editor,false);
      if(!saved || this.editor!==editor)return;
      this.closeEditor(false);
      await this.controls.cite(saved,visibleQuote(saved)||saved.text||'Page note');
    },'btn','arrow');
    end.append(save,cite);
    const extras=el('div','annotation-extras');
    if(!this.inRail) extras.append(button(label('Open in notebook','在笔记本中打开'),()=>this.dockEditor(),'text-btn','book'));
    extras.append(button(label('Remove','移除'),()=>{
      problem.replaceChildren(el('p','',label('Remove this mark? Citations in your notebook will still open its source.','移除此批注？笔记中的引用仍可回到出处。')),
        button(label('Remove mark','移除批注'),()=>this.remove(note,true),'btn'),button(label('Keep mark','保留批注'),()=>problem.replaceChildren(),'text-btn'));
    },'text-btn'));
    root.append(problem,end,extras);return editor;
  }
  private showProblem(reason:string):void {if(this.editor)this.editor.problem.textContent=reason;}
  private async write(note:PaperAnnotation):Promise<PaperAnnotation> {
    const {createdAt:_,updatedAt,...input}=note;
    const {annotation}=await api('annotation.save',{...input,expectedUpdatedAt:updatedAt||undefined});
    const reconcile=(drafts:Map<string,PaperAnnotation>)=>{
      const draft=drafts.get(note.id);
      if(!draft || draft.updatedAt!==updatedAt)return;
      if(draft.text===note.text && draft.color===note.color)drafts.delete(note.id);
      else drafts.set(note.id,{...draft,createdAt:annotation.createdAt,updatedAt:annotation.updatedAt});
    };
    if(this.docId===note.docId){
      this.revision++;this.records.set(note.id,annotation);reconcile(this.drafts);
      const active=this.editor?.note;
      if(active?.id===note.id && active.updatedAt===updatedAt)active.updatedAt=annotation.updatedAt;
      this.remember();this.renderIndex();this.controls.repaintPage();
    }else{
      try {
        const key=storageKey(note.docId);
        const items:PaperAnnotation[]=JSON.parse(sessionStorage.getItem(key)||'[]');
        const drafts=new Map(items.map(draft=>[draft.id,draft]));
        reconcile(drafts);
        if(drafts.size)sessionStorage.setItem(key,JSON.stringify([...drafts.values()]));
        else sessionStorage.removeItem(key);
      }catch{/* A draft retained by the browser can be reconciled when reopened. */}
    }
    return annotation;
  }
  private async saveEditor(e:Editor, close=true):Promise<PaperAnnotation|undefined> {
    if(e.saving)return;
    e.saving=true;e.root.inert=true;
    try {
      const saved=await this.write({...e.note});
      if(e===this.editor){e.note.updatedAt=saved.updatedAt;e.note.createdAt=saved.createdAt;if(close)this.closeEditor(true);}
      if(close)toast(label('Annotation saved.', '批注已保存。'));return saved;
    } catch(error) {
      if(this.editor!==e)return;
      e.problem.textContent=message(error)+' Your draft is kept.';
      try {await this.controls.refresh();}catch{/* Save remains available for a later retry. */}
      const latest=this.records.get(e.note.id);
      if(this.editor===e && latest && latest.updatedAt!==e.note.updatedAt){
        e.problem.append(el('blockquote','',latest.text||'Saved highlight'),button('Use saved version',()=>{
          this.drafts.delete(latest.id);this.remember();this.controls.repaintPage();this.open(latest.id,this.lastTrigger,this.inRail);
        },'text-btn'),button('Keep my draft',()=>{e.note.updatedAt=latest.updatedAt;this.drafts.set(e.note.id,{...e.note});
          this.remember();e.problem.textContent='Review your draft and save again.';},'text-btn'));
      }else if(this.editor===e && !latest && e.note.updatedAt && !this.problem){
        e.problem.append(button('Restore as a new mark',()=>{e.note.updatedAt='';this.drafts.set(e.note.id,{...e.note});this.remember();e.problem.textContent='Save to restore this mark.';},'text-btn'));
      }
    } finally {e.saving=false;e.root.inert=false;}
  }
  private async remove(note:PaperAnnotation,undo:boolean):Promise<void> {
    if(note.updatedAt) await api('annotation.delete',{docId:note.docId,id:note.id,expectedUpdatedAt:note.updatedAt});
    if(this.docId!==note.docId)return;
    this.revision++;this.drafts.delete(note.id);this.records.delete(note.id);this.remember();
    if(this.editor?.note.id===note.id)this.closeEditor(!!this.returnFromInline);
    this.renderIndex();this.controls.repaintPage();
    if(undo)toast('Mark removed.',{label:'Undo',run:()=>this.write({...note,updatedAt:''})});
  }
}
