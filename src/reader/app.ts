import type { AnnotationColor } from '../shared/annotations.js';
import type { DocumentInfo, NotebookSnapshot, OpenDocument, PageView, ReaderState, RegionIntent, SelectionHit, SourceRecord } from '../shared/types.js';
import { DEFAULT_TARGET_LANGUAGE, targetLanguageLabel, targetsSimplifiedChinese } from '../shared/languages.js';
import { readArticleRegion } from '../shared/article-region.js';
import { savedBookPlace, trackBookPlace } from './book-position.js';
import { showSectionControls } from './book-navigation.js';
import { outlineAnchor, outlineLocation, ReaderContents, type ContentsDestination } from './contents.js';
import { AnnotationWorkspace, readPagePoint } from './annotations.js';
import { AnnotationLayer } from './annotation-layer.js';
import { discardNotebook, insertNotebookPassage, leaveNotebook, refreshNotebookHighlights } from './notebook.js';
import { quoteLocator, readSelectionRange, readTranslatedLocator, writeSelectionRange, writeTranslatedLocator, type SavedSelectionRange, type TranslatedLocator } from '../shared/source-link.js';
import { renderArticle } from './article-view.js';
import { installCitationPreviews } from './citation-preview.js';
import { openPdf, bundledPdfUrl, type PdfDocument, type PdfPageView } from './pdf-view.js';
import { collectionsDialog } from './collections-dialog.js';
import { notesPanel, readingPackBar } from './notes-panel.js';
import { referencePanel } from './reference-panel.js';
import { settingsDialog } from './settings-dialog.js';
import { installShortcuts } from './shortcuts.js';
import { libraryDialog } from './library-dialog.js';
import { SelectionCard } from './selection-card.js';
import { PaperChat } from './paper-chat.js';
import type { ChatSource } from '../shared/types.js';
import { ReadingDesk, type ReadingMode } from './reading-desk.js';
import type { TranslationFocus } from './pdf/focus.js';
import { readRegion } from './pdf/region-geometry.js';
import { isScreenshotAnchor } from './selection-context.js';
import { discussionId } from './passage-links.js';
import type { DiscussionRef } from './discussion-drafts.js';
import { api, button, byId, el, icon, message, readerLabel as label, sourceUrl, syncTheme, toast, type Glyph, type ReaderPort } from './ui.js';
import { DocSearch } from './doc-search.js';
import { bindJumpHistoryControls, JumpHistory, type ReadingPosition } from './jump-history.js';
import { bindPdfControls, runRetranslate, type PdfControlsHandle, type ZoomSetting } from './pdf-controls.js';
import { bindPdfDropTarget, importPdfFiles } from './pdf-import.js';
import { FigurePins } from './figure-pin.js';
import { trackReadingProgress } from './reading-progress.js';
import { copyRegionPng, saveRegionPng } from './region-png.js';

const sidebarTabs = {contentsTab:'contents', notesTab:'notes', annotationsTab:'marks', refsTab:'reference'} as const;
type SidebarTab = typeof sidebarTabs[keyof typeof sidebarTabs];

function needsTranslation(anchor: string, target?: TranslatedLocator): boolean {
  const side = readArticleRegion(anchor)?.side;
  return Boolean(target) || side === 'translation' || side === 'both';
}

class Reader implements ReaderPort {
  doc:DocumentInfo={id:'pagedattention',title:'PagedAttention.pdf',kind:'pdf',defaultPage:6};
  page=6;
  state:ReaderState={notes:[],vocabulary:[],history:[],settings:{hasApiKey:false,aiMode:'unconfigured',model:'',baseUrl:'',targetLanguage:DEFAULT_TARGET_LANGUAGE,vaultPath:'',hasZoteroKey:false,zoteroLibraryId:'',zoteroLibraryType:'user'}};
  view?:PageView;
  notebook?:NotebookSnapshot;
  notebookError?:string;
  private pdf?:PdfDocument;
  private loadedId='';
  private leaveBookReading?: (save?: boolean) => void; private leaveProgress?: (save?: boolean) => void;
  private readonly card=new SelectionCard(this);
  private readonly chat=new PaperChat(this);
  private readonly desk=new ReadingDesk();
  private readonly pins=new FigurePins(byId('reader').querySelector<HTMLElement>('.workspace')!,(docId,page,anchor)=>this.navigate(docId,page,anchor));
  private readonly contents=new ReaderContents(
    destination => this.openContentsEntry(destination),
    () => this.pdfView?.outlineTop() ?? 0,
    () => settingsDialog(this)
  );
  private readonly marks = new AnnotationWorkspace({
    showIndex: () => { this.card.inspectMark(); this.tab='marks'; this.desk.showNotebook(); this.repaintNotes(); },
    locate: async note => {
      const url = new URL(note.sourceUrl);
      await this.navigate(note.docId,note.page,note.anchor,note.quote,readTranslatedLocator(url),readSelectionRange(url));
      if(note.docId===this.doc.id && note.page===this.page)this.markLayer.locate(note);
    },
    cite: (note, excerpt) => insertNotebookPassage(this,note,excerpt),
    repaintPage: () => { this.paintMarks(); refreshNotebookHighlights(this); this.syncHighlightPreference(); },
    trigger: id => this.markLayer.trigger(id),
    refresh: () => this.refresh()
  });
  private readonly markLayer = new AnnotationLayer(
    (id, trigger) => {this.card.inspectMark();this.marks.open(id,trigger);},
    point => {this.placingPin=false;this.updatePageFormat();this.marks.addPin(this.doc,this.page,point);},
    () => {this.placingPin=false;this.updatePageFormat();(byId('placePin').offsetParent?byId('placePin'):byId('more')).focus({preventScroll:true});}
  );
  private placingPin=false;
  private capturing=false;
  private beforeCapture?: ReadingPosition;
  private captureOrigin?: { suspended: boolean; returnTo?: ReadingPosition };
  private epoch=0;
  private navigating?:number;
  private stateEpoch=0;
  private readonly pdfTranslations = new Map<string, Promise<Record<string, string>>>();
  private translatingView?: PdfPageView;
  private readingText=false;
  private zoom: ZoomSetting = this.desk.zoom;
  private pdfControls?: PdfControlsHandle;
  private tab:SidebarTab='notes';
  private get parallel(): boolean { return this.desk.mode === 'bilingual'; }
  private get targetLanguage(): string { return this.state.settings.targetLanguage || DEFAULT_TARGET_LANGUAGE; }
  private get targetLanguageLabel(): string {
    const target = this.targetLanguage;
    return label(targetLanguageLabel(target, false), targetLanguageLabel(target, true));
  }
  private get pdfView(): PdfPageView | undefined {
    return this.view && 'setTextView' in this.view ? this.view as PdfPageView : undefined;
  }
  get pageCount(): number { return this.pdf?.pages || this.doc.book?.sections.length || 0; }
  private readonly translate=byId<HTMLButtonElement>('translate');
  private readonly jumpHistory=new JumpHistory(()=>this.jumpControls?.sync()); private jumpControls?: ReturnType<typeof bindJumpHistoryControls>;
  private readonly search=new DocSearch({
    doc:()=>this.doc, page:()=>this.page, targetLanguage:()=>this.targetLanguage, view:()=>this.view,
    isBilingual:()=>this.parallel, showSource:()=>this.setReadingMode('source'), showTranslation:()=>this.setReadingMode('bilingual'),
    navigateToPage:page=>this.navigate(this.doc.id,page), pushHistory:()=>this.jumpHistory.push(this.readingPosition(false)),
    focusBlock:id=>this.pdfView?.focusBlock?.(id)
  });
  private menuPin!: HTMLButtonElement; private menuRead!: HTMLButtonElement;

  async start():Promise<void>{
    installCitationPreviews(() => this.pdf, { jumpToPage: page => this.navigate(this.doc.id, page), openDocument: opened => this.openDocument(opened) });
    byId('selectionDock').after(this.chat.root);
    this.controls();
    const address=new URL(location.href),params=address.searchParams;
    const id=params.get('doc')||localStorage.getItem('reader.last-document')||'pagedattention';
    const page=Number(params.get('page'))||undefined;
    await this.navigate(id,page,params.get('anchor')||undefined,params.get('quote')||undefined,readTranslatedLocator(address),readSelectionRange(address),{restoreWithinPage:true});
    this.keepSourceReply(address);
    if(discussionId(address))await this.openNotebookSource(address).catch(error=>toast(message(error)));
    const checkNotebook=()=>{if(!document.hidden)void this.refresh().catch(error=>toast(message(error)));};
    window.addEventListener('focus',checkNotebook);
    document.addEventListener('visibilitychange',checkNotebook);
    window.addEventListener('popstate',()=>{
      const current=new URL(location.href),query=current.searchParams;
      if(discussionId(current)){void this.openNotebookSource(current).catch(error=>toast(message(error)));return;}
      void this.navigate(query.get('doc')||'pagedattention',Number(query.get('page'))||undefined,query.get('anchor')||undefined,query.get('quote')||undefined,readTranslatedLocator(current),readSelectionRange(current),{skipHistory:true}).then(()=>this.keepSourceReply(current)).catch(error=>toast(message(error)));
    });
  }
  async refresh():Promise<void>{
    const version=++this.stateEpoch;
    const doc=this.doc,page=this.page,chapterId=doc.book?.sections[page-1]?.chapterId;
    const markRevision=this.marks.revision;
    const [state,book,marks]=await Promise.all([api('state',{}),api('notebook.get',{
      docId:doc.id,title:doc.title,page,sourceUrl:sourceUrl(doc.id,page)
    }).then(value=>({value,error:''}),error=>({value:undefined,error:message(error)})),
      api('annotation.list',{docId:doc.id}).then(value=>({items:value.annotations,error:''}),error=>({items:undefined,error:message(error)}))]);
    if(version!==this.stateEpoch || doc.id!==this.doc.id || chapterId!==this.doc.book?.sections[this.page-1]?.chapterId)return;
    if(markRevision===this.marks.revision)this.marks.accept(marks.items,marks.error);
    const notebookChanged=this.notebookError!==book.error || this.notebook?.revision!==book.value?.revision
      || this.notebook?.desktopOpenAvailable!==book.value?.desktopOpenAvailable || this.notebook?.path!==book.value?.path
      || this.state.settings.vaultPath!==state.settings.vaultPath
      || book.value?.notes.some((note,index)=>note.updatedAt!==this.notebook?.notes[index]?.updatedAt);
    const previousTarget=this.state.settings.targetLanguage;
    this.state=state;
    this.notebookError=book.error;
    if(book.value){
      this.notebook=book.value;
      this.state.notes=[...book.value.notes,...state.notes.filter(note=>note.docId!==doc.id ||
        Boolean(chapterId && doc.book?.sections[note.page-1]?.chapterId!==chapterId))];
    }
    if(((this.tab==='notes'||this.tab==='marks') && notebookChanged)||(this.tab!=='contents' && !byId('railBody').hasChildNodes()))this.repaintNotes();
    this.card.refresh();
    this.chat.render();
    this.pdfControls?.syncTargetLanguage(this.targetLanguage);
    const targetChanged=Boolean(previousTarget && state.settings.targetLanguage && previousTarget!==state.settings.targetLanguage);
    if(targetChanged && this.view && !this.navigating){
      this.translatingView=undefined;
      await this.render(++this.epoch);
    }
  }
  paperSelection(source?: ChatSource):void { this.chat.selected(source); }
  documentMarks() { return this.marks.all(); }
  notebookHighlights() {
    if(this.desk.highlightDisplay!=='inline')return [];
    const marks=this.marks.savedHighlights(),book=this.doc.book;
    const chapterId=book?.sections[this.page-1]?.chapterId;
    return book ? marks.filter(mark=>book.sections[mark.page-1]?.chapterId===chapterId) : marks;
  }
  editNotebookHighlight(id: string, trigger: HTMLElement): void {
    this.marks.openInline(id, trigger, () => {
      this.showNotebook();
      const edit = byId('railBody').querySelector<HTMLElement>('.notebook-highlight[data-annotation-id="' + CSS.escape(id) + '"] button:last-child');
      (edit ?? byId('notesTab')).focus({ preventScroll: true });
    });
  }
  attachDiscussionPosition(header: HTMLElement, signal: AbortSignal): void { this.desk.attachDiscussion(header, signal); }
  showNotebook():void {
    this.tab='notes';
    this.repaintNotes();
    this.desk.showNotebook();
  }
  private async openContentsEntry(destination:ContentsDestination):Promise<boolean> {
    const id=this.doc.id, page=destination.page, wasDrawer=this.desk.isNarrow && this.desk.notebookOpen;
    const isPdf=Boolean(this.pdf);
    const anchor = isPdf ? outlineAnchor(destination.top,destination.title) : destination.anchor ?? '';
    await this.navigate(id,page,anchor,'',undefined,undefined,{fromContents:true});
    if(this.doc.id!==id || this.page!==page || !this.view)return false;
    if(wasDrawer)this.desk.dismissDrawer();
    if(isPdf)this.pdfView?.goToOutline(destination.top ?? 0,destination.title);
    else if(destination.anchor) {
      const area=byId('paperScroll');
      const pane=byId(this.desk.visibleLanguage==='original'?'original':'translated');
      const row=pane.querySelector<HTMLElement>('[data-anchor="'+CSS.escape(destination.anchor)+'"]');
      if(row)area.scrollTop+=row.getBoundingClientRect().top-area.getBoundingClientRect().top-16;
    } else byId('paperScroll').scrollTop=0;
    if(wasDrawer)byId('paperScroll').focus({preventScroll:true});
    return true;
  }
  async openNotebookSource(url: URL): Promise<void> {
    const query = url.searchParams, doc = query.get('doc')!, page = Number(query.get('page'));
    const exchange = discussionId(url);
    if(exchange){
      if(this.doc.id!==doc || !this.view)await this.navigate(doc);
      if(this.doc.id!==doc)return;
      this.card.close();this.desk.dismissDrawer();
      await this.chat.revealExchange(exchange);
      const local = new URL(sourceUrl(doc,this.page));
      local.searchParams.set('discussion',exchange);
      history.replaceState(null,'',local);
      return;
    }
    const anchor = query.get('anchor') ?? '', quote = query.get('quote') ?? '';
    const target = readTranslatedLocator(url), range = readSelectionRange(url);
    if (this.view && !this.navigating && this.doc.id === doc && this.page === page && this.card.inspectSource()) {
      this.jumpHistory.push(this.readingPosition(false));
      this.desk.showNotebook(false);
      if (needsTranslation(anchor, target)) this.setReadingMode('bilingual');
      else if (this.desk.isNarrow) this.setReadingMode('source');
      if (readRegion(anchor)) { this.readingText=false; this.updatePageFormat(); }
      this.locateAnchor(this.view, anchor, quote, target, range);
      this.remember(anchor, quote, target, range);
      this.keepSourceReply(url);
      byId('paperScroll').focus({ preventScroll: true });
      return;
    }
    const reading = this.readingPosition(), previousReturn = this.beforeCapture;
    const question = this.card.discussionVisible && doc === this.doc.id ? this.card.currentQuestion : undefined;
    const place = question && this.card.discussionPosition();
    await this.navigate(doc, page, anchor, quote, target, range);
    this.keepSourceReply(url);
    if (question && place && this.doc.id === doc && this.page === page) {
      this.card.offerReturn(async () => {
        await this.resumeDiscussion(question);
        if (this.doc.id !== reading.doc || this.page !== reading.page) return;
        await this.restoreReading(reading);
        this.beforeCapture = previousReturn;
        place();
      });
      byId('paperScroll').focus({ preventScroll: true });
    }
  }
  async resumeDiscussion({source,thread}: DiscussionRef, replyId?: string): Promise<void> {
    const url = new URL(source.sourceUrl), target = readTranslatedLocator(url), range = readSelectionRange(url);
    const initial = this.readingPosition();
    await this.navigate(source.docId,source.page,source.anchor,source.original,target,range);
    if(this.doc.id!==source.docId || this.page!==source.page || !this.view)return;
    if(isScreenshotAnchor(source.anchor)){
      if(!this.view.reopenRegion)throw Error(label('Open the original document to continue this discussion.', '请打开原文档继续讨论这张截图。'));
      await this.view.reopenRegion(source.anchor, hit => this.card.openRegion(hit,'ask',{source,thread},replyId));
      if (this.doc.id===source.docId && this.page===source.page) this.beforeCapture=initial;
      return;
    }
    const block=this.view.blocks.find(entry=>entry.id===source.anchor);
    const hit:SelectionHit={id:source.anchor,page:source.page,side:source.side,label:source.label,
      text:source.selected,context:source.context,sourceQuote:source.original,sourceText:block?.text ?? source.original,
      sourceOffset:source.side==='source'?range?.start:undefined, translatedOffset:target?.offset,
      rect:this.view.sourceRect?.(source.anchor) ?? byId('paperScroll').getBoundingClientRect()};
    await this.card.open(hit,{source,thread},replyId);
    this.view.locate(hit.id,source.original,target,range);
  }
  discardDocument(docId: string): void {
    discardNotebook(this, docId);
    if (this.doc.id === docId) {
      this.jumpHistory.clear(); this.pins.clear(); this.search.reset(); this.leaveBookReading?.(false); this.leaveProgress?.(false);
      this.leaveBookReading = undefined; this.leaveProgress = undefined;
      this.notebook = undefined;
      this.notebookError = undefined;
    }
  }
  saveHighlight(source:SourceRecord,quote:string,color?:AnnotationColor):Promise<void>{return this.marks.highlight(source,quote,color);}
  private paintMarks():void {this.markLayer.render(this.marks.onPage(this.page),this.view);}
  private locateAnchor(view:PageView,anchor:string,quote:string,target?:TranslatedLocator,range?:SavedSelectionRange):void{
    const destination=outlineLocation(anchor);
    if(destination && this.pdfView){
      this.pdfView.goToOutline(destination.top,destination.title);
      this.contents.remember({page:this.page,...destination});
      return;
    }
    const point=readPagePoint(anchor);
    if(point){
      const pin=this.marks.pinAt(this.page,anchor);
      if(!(pin && this.markLayer.locate(pin)) && !this.markLayer.locatePoint(point))toast(label('The page is open. The saved position could not be shown.','页面已打开，但未能定位到保存的位置。'));
    }else if(!view.locate(anchor,quote,target,range))toast(label('This source is unavailable on the saved page.','在保存的页面中找不到这段出处。'));
  }
  showReadingSide(side: 'source' | 'translation'):void {
    const mode=side==='source' ? 'source' : 'bilingual';
    this.setReadingMode(mode);
    byId(mode==='source'?'originalMode':'parallel').focus({preventScroll:true});
  }
  discussionChanged(docId: string):void { void this.chat.reload(docId); }
  exchangeDeleted(thread: string, requestId: string):void { this.card.exchangeDeleted(thread, requestId); }
  private syncHighlightPreference():void {
    byId<HTMLSelectElement>('highlightDisplay').closest('label')!.hidden = this.tab !== 'notes' || this.marks.savedHighlights().length === 0;
  }
  repaintNotes():void {
    const body=byId('railBody');
    const contents=this.tab==='contents';
    this.desk.setContents(contents);
    byId('contentsPanel').hidden=!contents;
    body.hidden=contents;
    const activeTabId=Object.entries(sidebarTabs).find(([,tab])=>tab===this.tab)?.[0] ?? 'notesTab';
    byId('notebookHandle').textContent=byId(activeTabId).textContent;
    byId('rail').ariaLabel=contents ? label('Contents','目录') : label('Reading notes','阅读笔记');
    byId('closeRail').ariaLabel=byId('closeRail').title=contents ? label('Close contents','关闭目录') : label('Close notes','关闭笔记');
    byId('notebookPose').ariaLabel=byId('notebookPose').title=contents ? label('Sidebar position','侧边栏位置') : label('Notes position','笔记位置');
    this.syncHighlightPreference();
    for (const [id, tab] of Object.entries(sidebarTabs)) {
      const button=byId(id), selected=this.tab===tab;
      button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
      if(selected && !contents)body.setAttribute('aria-labelledby',id);
    }
    if(contents)return;
    if(this.tab==='marks')this.marks.attach(body,readingPackBar(this,'marks'));
    else if(this.tab==='notes')notesPanel(this,body);
    else {body.replaceChildren();referencePanel(this,body);}
  }
  private keepSourceReply(source:URL):void {
    const reply=discussionId(source,'reply'), current=new URL(location.href);
    if (reply && ['doc','page','anchor'].every(key=>current.searchParams.get(key)===source.searchParams.get(key))) {
      current.searchParams.set('reply',reply);
      history.replaceState(null,'',current);
    }
  }
  private remember(anchor='',quote='',target?:TranslatedLocator,range?:SavedSelectionRange):void{
    const url=new URL(sourceUrl(this.doc.id,this.page,anchor));
    if(quote)url.searchParams.set('quote',quoteLocator(quote));
    writeTranslatedLocator(url,target);
    writeSelectionRange(url,range);
    history.replaceState(null,'',url);
    localStorage.setItem('reader.last-document',this.doc.id);
    localStorage.setItem('reader.page.'+this.doc.id,String(this.page));
  }
  openDocument(opened: OpenDocument): Promise<void> {
    return this.navigate(opened.doc.id,opened.page,opened.anchor,'',undefined,undefined,{opened:opened.doc});
  }
  async navigate(id:string,page?:number,anchor='',quote='',target?:TranslatedLocator,range?:SavedSelectionRange,
    options?:{opened?:DocumentInfo;restoreWithinPage?:boolean;fromContents?:boolean;skipHistory?:boolean}):Promise<void>{
    if(!options?.skipHistory && this.view && this.loadedId===id && ((page??this.page)!==this.page || Boolean(anchor) || Boolean(options?.fromContents && byId('paperScroll').scrollTop>4)))this.jumpHistory.push(this.readingPosition(false));
    this.cancelCapture(false); this.beforeCapture=undefined;
    this.cancelPin();this.marks.closePageEditor();
    const readingLink=Boolean(anchor && !options?.fromContents && !outlineLocation(anchor));
    if(readingLink)this.desk.dismissDrawer();
    this.card.close();
    if(readingLink || id!==this.loadedId) {
      this.readingText=false;
      this.updatePageFormat();
    }
    const translatedSource=needsTranslation(anchor,target);
    const revealTranslation=translatedSource && !this.parallel;
    if(revealTranslation)this.setReadingMode('bilingual');
    else if(readingLink && !translatedSource && this.desk.isNarrow)this.setReadingMode('source');
    if(!revealTranslation && this.view && !this.navigating && id===this.loadedId && (page??this.page)===this.page){
      if(anchor)this.locateAnchor(this.view,anchor,quote,target,range);
      else if(this.doc.book && page && options?.opened)byId('paperScroll').scrollTop=0;
      this.remember(anchor,quote,target,range);return;
    }
    const version=++this.epoch;
    this.navigating=version;
    byId('loading').textContent=label('Opening document…','正在打开文档…');byId('loading').hidden=false;
    try{
      const changed=id!==this.loadedId;
      const opened=options?.opened;
      let doc=opened && (opened.book?.sections.length || opened.paragraphs || opened.kind==='pdf') ? opened :
        changed ? (await api('library.get',{id})).doc : this.doc;
      if(version!==this.epoch)return;
      const place=doc.book && !anchor && (!page || options?.restoreWithinPage) ? await savedBookPlace(id) : undefined;
      if(version!==this.epoch)return;
      let pdf=changed?undefined:this.pdf;
      if(changed && doc.kind==='pdf'){
          const res=await fetch(doc.id==='pagedattention'?bundledPdfUrl:'../pdf?id='+encodeURIComponent(doc.id),{credentials:'same-origin'});
          if(!res.ok)throw new Error(label('Could not open this PDF (HTTP '+res.status+').','无法打开此 PDF（HTTP '+res.status+'）。'));
          pdf=await openPdf(new Uint8Array(await res.arrayBuffer()));
          if(version!==this.epoch){await pdf.destroy();return;}
          localStorage.setItem('reader.pdf-pages.'+id,String(pdf.pages));
      }
      const wanted=page || place?.page || doc.meta?.lastPage || Number(localStorage.getItem('reader.page.'+id))||doc.defaultPage||1;
      const number=Math.min(doc.book?.sections.length||pdf?.pages||1,Math.max(1,Number.isFinite(wanted)?Math.floor(wanted):1));
      if(doc.book && doc.sectionPage!==number) {
        doc=(await api('book.section',{docId:id,page:number})).doc;
        if(version!==this.epoch)return;
      }
      const chapter=doc.book?.sections[number-1]?.chapterId;
      if(changed || chapter!==this.doc.book?.sections[this.page-1]?.chapterId){
        await leaveNotebook(this,id,chapter);
        if(version!==this.epoch){if(changed && pdf && this.pdf!==pdf)await pdf.destroy();return;}
      }
      this.leaveBookReading?.(); this.leaveBookReading=undefined; this.leaveProgress?.(); this.leaveProgress=undefined;
      if(changed || doc.book && (number!==this.page || !this.view)){
        const newNotebook=changed || chapter!==this.doc.book?.sections[this.page-1]?.chapterId;
        this.view?.dispose?.();this.view=undefined;
        const previous=this.pdf;this.pdf=pdf;if(previous && previous!==pdf)void previous.destroy().catch(()=>undefined);
        this.doc=doc;this.loadedId=id;this.page=number;
        if(changed){
          this.jumpHistory.clear(); this.pins.clear(); const last=localStorage.getItem('reader.tab.'+doc.id);
          this.tab=Object.values(sidebarTabs).find(tab=>tab===last) ?? (doc.book?'contents':'notes');
        }
        this.desk.setDocument(Boolean(pdf),Boolean(doc.book));
        this.contents.document(doc,number,pdf);
        if(newNotebook){this.notebook=undefined;this.notebookError=undefined;}
        this.marks.switchDocument(id,doc.book);
        this.syncHighlightPreference();
        this.chat.document(doc,pdf);
        this.search.document(doc,pdf);
        await this.refresh();
        if(version!==this.epoch)return;
      }
      this.page=number;
      if(doc.book && anchor.startsWith('publisher:')){
        const fragment=anchor.slice('publisher:'.length);
        anchor=Object.entries(doc.articleLayout||{}).find(([,block])=>block.ids?.includes(fragment))?.[0]??'';
      }
      await this.render(version,anchor,quote,target,range);
      if(version===this.epoch){
        if(this.doc.book)this.leaveBookReading=trackBookPlace(id,number,place?.page===number?place:undefined);
        const savedScroll=!anchor && !quote && !target && !range && !this.doc.book && (this.doc.meta?.scrollFraction ?? 0)>0 && (this.doc.kind==='web' || !page || (options?.restoreWithinPage && this.doc.meta?.lastPage===number)) ? this.doc.meta?.scrollFraction : undefined;
        this.leaveProgress=trackReadingProgress({docId:id,page:number,pageCount:this.pdf?.pages||this.doc.book?.sections.length||1,restoreFraction:savedScroll});
      }
    }catch(error){
      if(version!==this.epoch)return;
      if(this.view && this.doc.book) {
        byId('loading').hidden=true;
      } else byId('loading').textContent=message(error);
      throw error;
    }finally{if(this.navigating===version)this.navigating=undefined;}
  }
  private async render(version:number,anchor='',quote='',target?:TranslatedLocator,range?:SavedSelectionRange):Promise<void>{
    const doc=this.doc,page=this.page;
    this.card.close();this.view?.dispose?.();this.view=undefined;
    const pdf=this.pdf;
    const targetLanguage=this.targetLanguage;
    const translations=pdf ? {} : (await api('translation.get',{docId:doc.id,page,targetLanguage})).translations;
    if(version!==this.epoch)return;
    document.title=doc.title+' · Paper Reader';byId('docTitle').textContent=doc.title;
    const section=doc.book?.sections[page-1];
    byId('docMeta').textContent=section ? section.title : doc.authors ? [doc.authors,doc.venue].filter(Boolean).join(' · ') : doc.kind==='web' && doc.url ? new URL(doc.url).hostname : '';
    byId('docMeta').title=section ? section.chapterTitle+' · '+section.title : '';
    byId('sourceInfo').textContent=doc.id==='pagedattention'?label('English','英文'):doc.book?label('Book section','书籍小节'):doc.kind==='web'?label('Web article','网页文章'):'PDF';
    byId('pageCount').closest<HTMLElement>('.page-navigation')!.hidden = !pdf;
    showSectionControls(doc,page);
    const pages=this.pdf?.pages||1, count=byId<HTMLButtonElement>('pageCount');
    count.textContent=page+' / '+pages;
    count.ariaLabel=label('Go to page, current page '+page+' of '+pages,'跳转到页码，当前第 '+page+' / '+pages+' 页');
    count.disabled=pages===1;
    byId<HTMLInputElement>('pageNumber').max=String(pages);
    byId('pageLimit').textContent=label('of '+pages,'/ '+pages);
    byId<HTMLButtonElement>('prev').disabled=page<=1;byId<HTMLButtonElement>('next').disabled=page>=pages;
    const sourceEl=byId('original'),translationEl=byId('translated');
    const focusKey='reader.focus.'+doc.id+'.'+page;
    this.pdfControls?.syncDocument(Boolean(pdf));
    this.pdfControls?.syncTargetLanguage(targetLanguage);
    const opening=new AbortController();
    let interacted=false;
    let capturedAnchor='';
    const markInteraction=()=>{interacted=true;};
    const onSelect=(selection:SelectionHit)=>{
      if(version!==this.epoch)return;
      if(selection.previewClick && this.card.hasOpenTool)return;
      if(!opening.signal.aborted)markInteraction();
      void this.card.open(selection).catch(error=>toast(message(error)));
      if(!this.parallel && this.pdfView)void this.translatePdf(this.pdfView,doc,page);
    };
    const onMounted=(view:PdfPageView)=>{
      if(version!==this.epoch)return;
      this.view=view;
      this.paintMarks(); this.search.syncPage();
      const events={signal:opening.signal};
      for(const event of ['pointerdown','keydown','wheel'])byId('reader').addEventListener(event,markInteraction,events);
      document.addEventListener('selectionchange',()=>{
        const node=document.getSelection()?.focusNode;
        if(node && (sourceEl.contains(node)||translationEl.contains(node)))markInteraction();
      },events);
      if(this.desk.focus!==options.focusMode)view.setFocusMode(this.desk.focus);
      if(this.zoom!==options.zoom)view.setZoom(this.zoom);
      this.updatePageFormat();
      this.translate.hidden=true;
      this.syncRetranslate();
      if(this.parallel)void this.translatePdf(view,doc,page);
    };
    const options={doc,page,sourceEl,translationEl,translations,targetLanguage,targetLanguageLabel:this.targetLanguageLabel,onSelect,onMounted,
      onLink:(dest:{page:number;top?:number})=>{void this.openContentsEntry({...dest,title:''}).catch(error=>toast(message(error)));},
      onNavigateAnchor:(anchor:string)=>this.navigate(doc.id,page,anchor),
      onBookSection:(number:number,fragment?:string)=>this.navigate(doc.id,number,fragment?'publisher:'+fragment:''),
      onAmbiguousQuote:()=>toast(label('This quote occurs more than once. Showing its paragraph.', '这段引文在段内出现多次，已定位到段落。')),
      canContinueRegion:(anchor:string)=>{
        const ref=this.card.currentQuestion;
        return Boolean(ref && (ref.source.page!==page ||
          (ref.source.anchor!==anchor && !ref.source.anchor.startsWith('article-'+anchor+'-'))));
      },
      onRegion:async (hit:SelectionHit,intent:RegionIntent)=>{
        if(version!==this.epoch)return;
        if(intent==='cancel'){this.cancelCapture(true);return;}
        const sourceAddress=new URL(location.href);
        this.capturing=false;this.updatePageFormat();
        if(intent==='pin'||intent==='copy'||intent==='save'){this.captureOrigin=this.beforeCapture=undefined;if(intent==='pin')this.pins.pin({docId:doc.id,page:hit.page,anchor:hit.id,image:hit.image!,label:hit.label,isWeb:doc.kind==='web'});else if(intent==='copy')await copyRegionPng(hit.image!);else saveRegionPng(hit.image!,doc.title,hit.page);return;}
        if(intent==='continue' && this.captureOrigin?.returnTo) this.beforeCapture=this.captureOrigin.returnTo;
        this.captureOrigin=undefined;
        await this.card.openRegion(hit,intent);
        if(version!==this.epoch)return;
        capturedAnchor=hit.id;
        this.remember(hit.id);
        if(intent==='reopen')this.keepSourceReply(sourceAddress);
      },
      onTranslationState:()=>{if(version===this.epoch)this.card.refresh();},zoom:this.zoom,translationVisible:this.parallel,
      minReadableFontSize:12,
      focusMode:this.desk.focus,focusId:localStorage.getItem(focusKey)||undefined,onFocus:(id:string,focusLabel:string,effective?:TranslationFocus,degraded?:boolean)=>{
        if(version!==this.epoch)return;
        if(id)localStorage.setItem(focusKey,id);
        const eff=effective ?? this.desk.focus;
        this.desk.setEffectiveFocus(eff);
        this.pdfControls?.syncFocus(eff,focusLabel,Boolean(degraded),this.desk.focus);
      }};
    let view: PageView;
    try { view=pdf?await pdf.render(options):renderArticle({...options,zoom:this.zoom==='fit-page'?1:this.zoom}); }
    catch (error) {
      if(version!==this.epoch)return;
      this.card.close();this.view=undefined;
      throw error;
    } finally { opening.abort(); }
    if(version!==this.epoch){view.dispose?.();return;}
    this.view=view;this.translate.disabled=false;
    this.contents.document(doc,page,pdf);
    this.updatePageFormat();
    this.paintMarks();
    this.translate.hidden=Boolean(pdf)||!view.blocks.some(b=>b.text && !b.translation && !translations[b.id]);
    this.syncRetranslate();
    this.translate.textContent = doc.book ? label('Translate section','翻译本节') : doc.kind === 'web' ? label('Translate article', '翻译文章') : label('Translate page', '翻译本页');
    byId('loading').hidden=true;
    this.repaintNotes();
    this.search.syncPage();
    if(interacted){this.remember(capturedAnchor);return;}
    byId('paperScroll').scrollTop=0;
    this.remember(anchor,quote,target,range);
    if(anchor)this.locateAnchor(view,anchor,quote,target,range);
  }
  private async translatePdf(view: PdfPageView, doc: DocumentInfo, page: number): Promise<void> {
    const version = this.epoch;
    const active = () => this.epoch === version && this.view === view;
    if (!active() || this.translatingView===view) return;
    if (!view.blocks.length) {
      view.setTranslationState('scanned', label('This page has no selectable text. Run OCR on the PDF, then import the searchable copy.','本页没有可选中文字。请先对 PDF 做 OCR，再导入可检索副本。'),
        [{label: label('Open library','打开资料库'), run: () => { void libraryDialog(this).catch(error => toast(message(error))); }}]);
      return;
    }
    if (view.blocks.every(block => block.translation)) {
      const cached = await api('translation.get', { docId: doc.id, page, targetLanguage: this.targetLanguage }).catch(() => ({ translations: {} as Record<string, string> }));
      if (active() && Object.keys(cached.translations).length) { view.setTranslations?.(cached.translations, true); this.search.recordTranslations(doc.id, page, cached.translations); this.card.refresh(); }
      this.syncRetranslate(); return;
    }
    const target = this.targetLanguage;
    const targetName = this.targetLanguageLabel;
    const retry = { label: label('Retry translation','重试翻译'), run: () => { void this.translatePdf(view, doc, page); } };
    const connections = { label: label('Connections','连接设置'), run: () => settingsDialog(this) };
    this.translatingView=view;
    view.setTranslationState('pending', label('Checking saved translations…','正在检查已保存的译文…'));
    try {
      const cached = await api('translation.get', {docId: doc.id, page, targetLanguage: target});
      if (!active()) return;
      view.setTranslations?.(cached.translations);
      this.search.recordTranslations(doc.id, page, cached.translations);
      this.card.refresh();
      const missing = view.blocks.filter(block => !block.translation);
      if (!missing.length) return;
      const canUseLocal = Boolean(this.state.settings.localTranslationAvailable) && targetsSimplifiedChinese(target);
      if (this.state.settings.aiMode === 'unconfigured' && !canUseLocal) {
        const guidance = this.state.settings.localTranslationAvailable && !targetsSimplifiedChinese(target)
          ? label(
              'The built-in offline translator only supports Simplified Chinese. Connect a translation model in Connections to translate into ' + targetName + '.',
              '内置离线翻译仅支持简体中文。请在连接设置中配置翻译模型以翻译为' + targetName + '。'
            )
          : label(
              'Connect a translation model to read this page in ' + targetName + '.',
              '请连接翻译模型以将本页翻译为' + targetName + '。'
            );
        view.setTranslationState('unavailable', guidance, [connections, retry]);
        return;
      }
      view.setTranslationState('loading', label('Translating this page into ' + targetName + '…', '正在将本页翻译为' + targetName + '…'));
      const key = doc.id + ':' + page + ':' + target;
      let request = this.pdfTranslations.get(key);
      if (!request) {
        request = api('translation.page', {docId: doc.id, page, targetLanguage: target, blocks: missing.map(({id, text}) => ({id, text}))})
          .then(result => result.translations);
        this.pdfTranslations.set(key, request);
        const clear = () => { if (this.pdfTranslations.get(key) === request) this.pdfTranslations.delete(key); };
        void request.then(clear, clear);
      }
      const translated = await request;
      if (!active()) return;
      view.setTranslations?.(translated);
      this.search.recordTranslations(doc.id, page, translated);
      this.card.refresh();
      if (view.blocks.some(block => !block.translation)) throw new Error(label('The model returned incomplete translations for this page.','模型返回的本页译文不完整。'));
    } catch (error) {
      if (active()) view.setTranslationState('error', message(error), [retry, connections]);
    } finally {
      if(this.translatingView===view)this.translatingView=undefined;
      if(active())this.syncRetranslate();
    }
  }
  private syncRetranslate():void { this.pdfControls?.syncRetranslate(Boolean(this.view && this.translate.hidden && this.view.blocks.some(b=>b.translation))); }
  async retranslateBlocks(blockIds?: string[]):Promise<void> {
    if(!this.view)return;
    const doc=this.doc,page=this.page,version=this.epoch,view=this.view;
    await runRetranslate({docId:doc.id,page,isPdf:Boolean(this.pdf),target:this.targetLanguage,settings:this.state.settings,view,blockIds,isActive:()=>version===this.epoch&&this.view===view},
      translations=>{this.search.recordTranslations(doc.id,page,translations);this.card.refresh();this.syncRetranslate();},()=>settingsDialog(this,'ai'));
  }
  async importFiles(files: readonly File[], onProgress?: (text: string) => void): Promise<boolean> {
    const { imported, summary } = await importPdfFiles(files, onProgress);
    if (imported.length) await this.navigate(imported.at(-1)!.id);
    if (summary) toast(summary); return imported.length > 0;
  }
  private async translatePage():Promise<void>{
    if(!this.view)return;
    if(this.state.settings.aiMode==='unconfigured'){settingsDialog(this);return;}
    const doc=this.doc,page=this.page,version=this.epoch;
    const blocks=this.view.blocks.filter(b=>b.text.trim() && !b.translation);
    if(!blocks.length)return;
    this.translate.disabled=true;this.translate.textContent=label('Translating…','正在翻译…');
    try{
      const {translations}=await api('translation.page',{docId:doc.id,page,targetLanguage:this.targetLanguage,blocks:blocks.map(({id,text})=>({id,text}))});
      if(version===this.epoch){this.view?.setTranslations?.(translations);this.search.recordTranslations(doc.id,page,translations);this.card.refresh();this.translate.hidden=true;this.syncRetranslate();}
    }catch(error){if(version===this.epoch)toast(message(error));}
    finally{if(version===this.epoch){this.translate.disabled=false;this.translate.textContent=doc.book ? label('Translate section','翻译本节') : doc.kind==='web' ? label('Translate article','翻译文章') : label('Translate page','翻译本页');}}
  }
  private updatePageFormat(): void {
    const view=this.pdfView;
    const available=Boolean(view?.canReadText && !this.parallel);
    const reading=available && this.readingText;
    byId('reader').dataset.pageFormat=reading?'text':'pdf'; byId('reader').dataset.placingPin=String(this.placingPin);
    const pinAvailable=Boolean(view);
    const inlinePin=this.parallel && !this.placingPin;
    const pin=byId('placePin'), pinHost=byId(inlinePin?'pinHeading':'pageFormat');
    if(pin.parentElement!==pinHost)pinHost.insertBefore(pin,inlinePin?null:byId('readText'));
    byId('pageFormat').hidden=!this.capturing && !available && (!pinAvailable || inlinePin);
    byId('readText').hidden=!available || this.capturing;
    pin.hidden=!pinAvailable || this.capturing;
    const capture=byId<HTMLButtonElement>('captureRegion');
    capture.hidden=!this.view?.beginRegion;
    capture.setAttribute('aria-pressed',String(this.capturing));
    const captureLabel=this.capturing ? label('Cancel screenshot','取消截图') : label('Ask with a screenshot','截图问 AI');
    capture.ariaLabel=captureLabel; capture.title=captureLabel+(this.capturing?' (Esc)':' (S)');
    capture.querySelector('.capture-label')!.textContent=this.capturing ? label('Cancel','取消') : label('Capture','截图');
    pin.textContent=this.placingPin?label('Cancel placement','取消放置'):
      reading || this.desk.visibleLanguage==='translation' ? label('Pin on PDF','在 PDF 原页标注') : label('Add page note','添加页边笔记');
    pin.setAttribute('aria-pressed',String(this.placingPin));
    byId('readText').textContent=reading?label('View PDF page','查看 PDF 原页'):label('Read text','读正文');
    byId('pageTextHint').textContent=this.capturing?label('Drag over the area, then choose Explain or Ask.','拖框选中图或文字，再点「解释」或「提问」。'):this.placingPin?label('Click the PDF, or use arrow keys and Enter.','点击原页放置，或用方向键定位后按回车。'):reading?label('Figures and equations are in the PDF.','图表和公式可在 PDF 原页查看。'):this.parallel?'':label('Select a passage to translate or highlight.','划选原文可查看译文或高亮。');
    byId('zoomControl').hidden=reading;
    byId('pdfThemeControl').hidden=!this.pdf || reading;
    view?.setTextView(reading); this.search.paintPage(); this.syncMenuActions();
  }
  private syncMenuActions(): void {
    const narrow=this.desk.isMobileBar, pin=byId('placePin'), read=byId('readText');
    this.menuPin.hidden=!narrow || pin.hidden; this.menuPin.lastChild!.textContent=pin.textContent;
    this.menuRead.hidden=!narrow || read.hidden; this.menuRead.lastChild!.textContent=read.textContent; this.jumpControls?.sync();
  }
  private setReadingMode(mode: ReadingMode):void {
    if(mode===this.desk.mode)return;
    this.cancelCapture(false);
    this.cancelPin();this.marks.closePageEditor();
    const paper=byId('paperScroll');
    const visiblePane=()=>byId(this.desk.visibleLanguage==='translation'?'translated':'original');
    const offset=paper.scrollTop/Math.max(1,visiblePane().scrollHeight);
    const format=byId('reader').dataset.pageFormat;
    this.desk.setMode(mode);
    this.updatePageFormat();
    if(this.pdfView) {
      const view=this.pdfView;
      if(mode==='bilingual')view.setFocusMode(this.desk.focus);
      view.setZoom(this.zoom);
      if(mode==='bilingual')void this.translatePdf(view,this.doc,this.page);
    }
    if(format===byId('reader').dataset.pageFormat)paper.scrollTop=offset*visiblePane().scrollHeight;
    this.search.paintPage(); this.card.revealIn(visiblePane());
  }
  private cancelPin():void {
    if(!this.placingPin)return;
    this.placingPin=false;this.markLayer.place(false);this.updatePageFormat();
  }
  addDiscussionScreenshot():void { this.beginCapture(true); }
  async discussionScreenshot(source:ChatSource):Promise<string> {
    if(this.doc.id===source.docId) {
      if(readArticleRegion(source.anchor)) {
        const { image }=await api('article.capture.get',{docId:source.docId,page:source.page,anchor:source.anchor});
        return image;
      }
      if(this.pdf)return this.pdf.cropRegion(source.page,source.anchor);
    }
    throw Error(label('Reopen this document to use its screenshot.', '请重新打开这份文档以使用原图。'));
  }
  private beginCapture(attach = false):void {
    if(this.capturing){this.cancelCapture(true);return;}
    const view=this.view;
    if(!view?.beginRegion)return;
    const initial=this.readingPosition();
    const returnTo=this.beforeCapture;
    this.cancelPin();this.marks.closePageEditor();this.desk.dismissDrawer();
    const suspended=this.card.discussionVisible && this.card.inspectSource();
    if(!suspended)this.card.close();
    this.captureOrigin={suspended, returnTo};
    if(this.pdfView && this.desk.visibleLanguage==='translation')this.setReadingMode('source');
    this.beforeCapture=initial;
    this.readingText=false;this.capturing=true;
    this.updatePageFormat();view.beginRegion(attach);
  }
  private cancelCapture(restore:boolean):void {
    if(!this.capturing)return;
    const origin=this.captureOrigin;
    this.captureOrigin=undefined;
    this.capturing=false;this.view?.cancelRegion?.();
    if(restore)this.regionDiscussionClosed(true);
    else this.beforeCapture=undefined;
    this.updatePageFormat();
    if(restore && origin?.suspended){
      this.beforeCapture=origin.returnTo;
      this.card.returnFromSource();
    }else if(restore)byId('captureRegion').focus({preventScroll:true});
  }
  private readingPosition(includeChat = true):ReadingPosition {
    const paper=byId('paperScroll'), translation=byId('translated');
    return {doc:this.doc.id, page:this.page, mode:this.desk.mode, text:this.readingText, top:paper.scrollTop, left:paper.scrollLeft,
      translationTop:translation.scrollTop, translationLeft:translation.scrollLeft, ...(includeChat && { historyTop:this.chat.readingPosition })};
  }
  private async jumpInHistory(dir:'back'|'forward'):Promise<void> { const next=this.jumpHistory[dir](this.readingPosition(false)); if(next)await this.restoreReading(next); }
  regionDiscussionClosed(explicit:boolean):void {
    const initial=this.beforeCapture;
    this.beforeCapture=undefined;
    if(!explicit || !initial || initial.doc!==this.doc.id)return;
    void this.restoreReading(initial).catch(error=>toast(message(error)));
  }
  private async restoreReading(initial:ReadingPosition):Promise<void> {
    if(initial.doc!==this.doc.id || initial.page!==this.page)await this.navigate(initial.doc,initial.page,'','',undefined,undefined,{skipHistory:true});
    if(initial.doc!==this.doc.id || initial.page!==this.page)return;
    this.setReadingMode(initial.mode);
    this.readingText=initial.text;this.updatePageFormat();
    if(initial.historyTop!==undefined)this.chat.restorePosition(initial.historyTop);
    byId('paperScroll').scrollTo({top:initial.top,left:initial.left,behavior:'instant'});
    byId('translated').scrollTo({top:initial.translationTop,left:initial.translationLeft,behavior:'instant'});
  }
  private controls():void{
    document.documentElement.lang=/^zh(?:-|$)/i.test(navigator.language)?'zh-CN':'en';
    syncTheme();
    const click=(id:string,fn:()=>unknown)=>byId(id).addEventListener('click',()=>{void Promise.resolve().then(fn).catch(error=>toast(message(error)));});
    const glyphs:Record<string,Glyph>={library:'library',prev:'back',next:'next',more:'more',mobileRail:'book',closeRail:'close',closeDialog:'close',closeShortcuts:'close'};
    for(const [id,name] of Object.entries(glyphs))byId(id).append(icon(name));
    document.querySelector<HTMLElement>('.workspace')!.ariaLabel=label('Reading area','阅读区');
    document.querySelector<HTMLElement>('.toolbar')!.ariaLabel=label('Reading tools','阅读工具');
    document.querySelector<HTMLElement>('.reader-mode-switch')!.ariaLabel=label('Reading mode','阅读模式');
    byId('menu').ariaLabel=label('Reader actions','更多菜单');
    byId('pageJump').ariaLabel=label('Go to page','跳转到页码');
    byId('pageJump').querySelector('label')!.textContent=label('Page number','页码');
    byId('pageJump').querySelector('button[type="submit"]')!.textContent=label('Go','跳转');
    byId('paperScroll').ariaLabel=label('Document pages','文档页面');
    byId('pageSplit').ariaLabel=byId('pageSplit').title=label('Resize original and translation','调整原文与译文宽度');
    byId('loading').textContent=label('Opening document…','正在打开文档…');
    byId('selectionDock').ariaLabel=label('Passage workspace','选段工具区');
    byId('notesSplit').ariaLabel=byId('notesSplit').title=label('Resize notes','调整笔记宽度');
    byId('rail').ariaLabel=label('Reading notes','阅读笔记');
    byId('notebookPose').ariaLabel=byId('notebookPose').title=label('Notes position','笔记位置');
    byId('card').ariaLabel=label('Selection card','选区卡片');
    byId('shortcutsTitle').textContent=label('Keyboard shortcuts','快捷键');
    byId('closeShortcuts').ariaLabel=byId('closeShortcuts').title=label('Close keyboard shortcuts','关闭快捷键帮助');
    byId('library').append(el('span','',label('Library','资料库')));
    byId('library').ariaLabel=byId('library').title=label('Open library','打开资料库');
    byId('closeDialog').ariaLabel=label('Close dialog','关闭窗口');
    const contents=byId('contentsToggle');
    contents.replaceChildren(icon('contents'),el('span','',label('Contents','目录')));
    contents.ariaLabel=label('Contents','目录');
    byId('contentsTab').textContent=label('Contents','目录');
    byId('contentsTab').parentElement!.ariaLabel=label('Reading sidebar','阅读侧边栏');
    click('contentsToggle',()=>this.toggleSidebar('contents'));
    click('mobileRail',()=>this.toggleSidebar('notes'));
    for (const [id,step,name] of [['previousSection',-1,label('Previous section','上一节')],['nextSection',1,label('Next section','下一节')]] as const){
      const control=byId(id); control.ariaLabel=control.title=name; control.append(icon(step<0?'back':'next'));
      click(id,()=>this.navigate(this.doc.id,this.page+step));
    }
    byId('mobileRail').append(el('span','',label('Notes','笔记')));
    byId('captureRegion').append(icon('capture'),el('span','capture-label'));
    click('captureRegion',()=>this.beginCapture());
    byId('originalMode').querySelector('.mode-full')!.textContent=label('Original','原文');byId('originalMode').querySelector('.mode-compact')!.textContent=label('Orig','原文');
    byId('parallel').querySelector('.mode-wide')!.textContent=label('Bilingual','双语对照');
    byId('parallel').querySelector('.mode-narrow')!.textContent=label('Translation','译文');byId('parallel').querySelector('.mode-compact')!.textContent=label('Trans','译文');
    byId('notebookHandle').textContent=label('Notes','笔记');
    byId('closeRail').ariaLabel=byId('closeRail').title=label('Close notes','关闭笔记');
    byId('annotationsTab').textContent=label('Marks','标记');
    byId('notesTab').textContent=label('Notes','笔记');
    byId('refsTab').textContent=label('Reference','文献');
    const display=byId<HTMLSelectElement>('highlightDisplay');
    display.ariaLabel=label('Highlight display','高亮显示');
    display.closest('label')!.querySelector('span')!.textContent=label('Highlights','高亮');
    display.options[0].text=label('In Notes','随笔记显示');
    display.options[1].text=label('In Marks only','仅在标记中显示');
    byId('parallel').prepend(icon('columns',14));
    byId('prev').ariaLabel=label('Previous page','上一页');
    byId('next').ariaLabel=label('Next page','下一页');
    byId('pageCount').ariaLabel=byId('pageCount').title=label('Go to page','跳转到页码');
    byId('more').ariaLabel=label('More actions','更多操作');
    const [sourceHead,targetHead]=document.querySelectorAll<HTMLElement>('.headings b');
    if(sourceHead)sourceHead.textContent=label('Original','原文');
    if(targetHead)targetHead.textContent=label('Translation','译文');
    click('library',()=>libraryDialog(this));click('prev',()=>this.navigate(this.doc.id,this.page-1));click('next',()=>this.navigate(this.doc.id,this.page+1));
    const jump=byId<HTMLFormElement>('pageJump'), input=byId<HTMLInputElement>('pageNumber');
    jump.addEventListener('beforetoggle',event=>{
      if(event.newState==='open')input.value=String(this.page);
    });
    jump.addEventListener('toggle',()=>{
      if(!jump.matches(':popover-open'))return;
      const anchor=byId('pageCount').getBoundingClientRect();
      const below=anchor.bottom+6+jump.offsetHeight<=innerHeight-8;
      jump.style.top=Math.max(8,Math.min(innerHeight-jump.offsetHeight-8,below?anchor.bottom+6:anchor.top-jump.offsetHeight-6))+'px';
      jump.style.left=Math.max(8,Math.min(anchor.left,innerWidth-jump.offsetWidth-8))+'px';
      input.select();
    });
    jump.addEventListener('submit',event=>{
      event.preventDefault();
      jump.hidePopover();
      void this.navigate(this.doc.id,input.valueAsNumber).catch(error=>toast(message(error)));
    });
    window.addEventListener('resize',()=>{if(jump.matches(':popover-open'))jump.hidePopover();if(!byId('menu').hidden)this.closeMenu();});
    const toggleReadText=()=>{
      this.cancelCapture(false);
      this.cancelPin();this.marks.closePageEditor();
      this.readingText=!this.readingText;
      this.updatePageFormat();
      this.card.revealIn(byId('original'));
    };
    const togglePlacePin=()=>{
      this.cancelCapture(false);
      if(this.placingPin){this.cancelPin();return;}
      if(!this.pdfView)return;
      this.card.close();this.marks.closePageEditor();this.desk.dismissDrawer();
      if(this.desk.visibleLanguage==='translation')this.setReadingMode('source');
      this.readingText=false;this.placingPin=true;this.updatePageFormat();this.markLayer.place(true);
    };
    click('readText',toggleReadText); click('placePin',togglePlacePin);
    click('translate',()=>this.translatePage());
    const resizePages=(value:ZoomSetting)=>{
      this.zoom=value; this.desk.setZoom(value);
      if(this.pdfView)this.pdfView.setZoom(value);
      else if(!this.pdf){
        const n=value==='fit-page'?1:value;
        document.querySelector<HTMLElement>('.pages')!.style.width=n*100+'%';
        for(const sheet of document.querySelectorAll<HTMLElement>('.web-reading-sheet'))sheet.style.setProperty('--article-zoom',String(n));
      }
      this.search.paintPage();
    };
    this.pdfControls=bindPdfControls({
      getZoom:()=>this.zoom, setZoom:resizePages, getTargetLanguage:()=>this.targetLanguage,
      onTargetLanguageSaved:()=>this.refresh(), openLanguageSettings:()=>settingsDialog(this,'ai'),
      onRetranslatePage:()=>this.retranslateBlocks(), closeMenu:r=>this.closeMenu(r),
      onFocusChange:mode=>{this.desk.setFocus(mode);this.pdfView?.setFocusMode(mode,true);this.search.paintPage();}
    });
    click('originalMode',()=>this.setReadingMode('source'));
    click('parallel',()=>this.setReadingMode('bilingual'));
    const tabs=Object.keys(sidebarTabs) as (keyof typeof sidebarTabs)[];
    for(const [index,id] of tabs.entries()){
      click(id,()=>this.selectTab(sidebarTabs[id]));
      byId(id).addEventListener('keydown',event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();
        const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
        const target=byId(tabs[next]);
        target.click();target.focus();
      });
    }
    click('closeDialog',()=>byId<HTMLDialogElement>('dialog').close());
    const shortcuts=installShortcuts({
      isCapturing:()=>this.capturing,
      isPlacingPin:()=>this.placingPin,
      isSearchOpen:()=>this.search.isOpen, openSearch:()=>this.search.open(), closeSearch:()=>this.search.close(),
      cancelCapture:()=>this.cancelCapture(true),
      closeMenu:()=>this.closeMenu(true),
      dismissDrawer:()=>this.desk.dismissDrawer(),
      dismissCard:()=>this.card.dismiss(true),
      canNextPage:()=>Boolean(this.pdf && this.page<this.pdf.pages),
      canPrevPage:()=>Boolean(this.pdf && this.page>1),
      canNextSection:()=>Boolean(this.doc.book && this.page<this.doc.book.sections.length),
      canPrevSection:()=>Boolean(this.doc.book && this.page>1),
      canJumpBack:()=>this.jumpHistory.canBack(), canJumpForward:()=>this.jumpHistory.canForward(), jumpBack:()=>{void this.jumpInHistory('back').catch(e=>toast(message(e)));}, jumpForward:()=>{void this.jumpInHistory('forward').catch(e=>toast(message(e)));},
      toggleBilingual:()=>this.setReadingMode(this.desk.mode==='bilingual'?'source':'bilingual'),
      toggleSidebar:tab=>this.toggleSidebar(tab),
      stepZoom:delta=>this.pdfControls?.stepZoom(delta)
    });
    click('more',()=>{const menu=byId('menu');if(!menu.hidden){this.closeMenu(true);return;}this.syncMenuActions();menu.hidden=false;
      menu.style.right=Math.max(6,innerWidth-byId('more').getBoundingClientRect().right)+'px';
      menu.style.top=byId('more').getBoundingClientRect().bottom+4+'px';
      byId('more').setAttribute('aria-expanded','true');menu.querySelector<HTMLElement>('button:not([hidden])')?.focus();});
    const items:[string,Glyph,()=>unknown][]=[
      [label('Find in document','文档内搜索'),'search',()=>this.search.open()],
      [label('Vocabulary and history','生词与历史'),'clock',async()=>{await this.refresh();collectionsDialog(this);}],
      [label('Keyboard shortcuts','快捷键'),'keyboard',()=>shortcuts.open()],
      [label('Reset reading layout','重置阅读布局'),'columns',()=>{
        this.readingText=false;this.desk.reset();this.updatePageFormat();resizePages(1);this.pdfControls?.syncZoom(1);
        this.pdfView?.setFocusMode(this.desk.focus);
        toast(label('Reading layout reset.','阅读布局已重置。'));
      }],
      [label('Connections','连接设置'),'settings',()=>settingsDialog(this)],[label('Open in new tab','在新标签页打开'),'popout',()=>window.open(sourceUrl(this.doc.id,this.page),'_blank','noopener')]
    ];
    this.menuPin=button('',()=>{this.closeMenu(false);togglePlacePin();},'','pin'); this.menuPin.hidden=true;
    this.menuRead=button('',()=>{this.closeMenu(true);toggleReadText();},'','note'); this.menuRead.hidden=true;
    this.jumpControls=bindJumpHistoryControls({history:this.jumpHistory,isMobileBar:()=>this.desk.isMobileBar,closeMenu:r=>this.closeMenu(r),onBack:()=>this.jumpInHistory('back'),onForward:()=>this.jumpInHistory('forward')});
    byId('menu').append(...this.jumpControls.menuButtons,this.menuPin,this.menuRead);
    for(const [title,glyph,action] of items)byId('menu').append(button(title,async()=>{this.closeMenu(true);await action();},'',glyph));
    this.desk.connect(mode=>this.pdfView?.setFocusMode(mode), () => refreshNotebookHighlights(this));
    bindPdfDropTarget(byId('reader'), files => { void this.importFiles(files, text => toast(text)).catch(e => toast(message(e))); }, { isBlocked: () => Boolean(document.querySelector('dialog[open]')) });
    byId('menu').addEventListener('focusout',event=>{
      if(event.relatedTarget instanceof HTMLElement && !event.relatedTarget.closest('#menu,#more,#pdfThemeMenu'))this.closeMenu();
    });
    document.addEventListener('pointerdown',e=>{
      if(!(e.target instanceof Element))return;
      if(!e.target.closest('#menu,#more,#pdfThemeMenu'))this.closeMenu();
      if(!this.card.hasOpenTool && !e.target.closest('#card,#selectionDock,#docSearch,#rail,#paperScroll,#pageFormat,#returnDiscussion,.headings,.paper-chat,.desk-split,.topbar,#mobileBar,#pdfThemeMenu,.citation-preview,.figure-pin-card,dialog'))this.card.dismiss();
    });
  }
  private selectTab(tab:SidebarTab):void {
    this.tab=tab;
    localStorage.setItem('reader.tab.'+this.doc.id,tab);
    this.repaintNotes();
  }
  private toggleSidebar(tab:SidebarTab):void {
    if(this.desk.notebookOpen && this.tab===tab){this.desk.showNotebook(false);return;}
    const switching=this.desk.notebookOpen;
    this.selectTab(tab);this.desk.showNotebook(true,tab==='contents');
    if(switching)byId(Object.entries(sidebarTabs).find(([,t])=>t===tab)![0]).focus({preventScroll:true});
  }
  private closeMenu(restoreFocus=false):void {
    if(byId('menu').hidden)return;
    byId('menu').hidden=true;byId('more').setAttribute('aria-expanded','false');
    if(restoreFocus)byId('more').focus({preventScroll:true});
  }
}
const reader=new Reader();
void reader.start().catch(error=>{
  const panel=byId('loading');panel.hidden=false;panel.replaceChildren(el('p','',message(error)),button(label('Open library','打开资料库'),()=>libraryDialog(reader),'text-btn'));
});
