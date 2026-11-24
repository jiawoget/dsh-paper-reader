import type { ChatSource, DocumentInfo, NotebookSnapshot, OpenDocument, PageView, ReaderState, SourceRecord, ZoteroItem } from '../shared/types.js';
import type { DiscussionRef } from './discussion-drafts.js';
import type { PaperAnnotation } from '../shared/annotations.js';
import { DEFAULT_TARGET_LANGUAGE, TARGET_LANGUAGE_MAX_LENGTH, TARGET_LANGUAGE_PRESETS, findTargetLanguagePreset } from '../shared/languages.js';
import { buildCitationMetadata, buildCiteKey, formatBibTeX, formatRIS } from '../shared/citation-export.js';
import { chapterPassageLabel } from '../shared/notebook-structure.js';
import { readSelectionRange, readTranslatedLocator, type SavedSelectionRange, type TranslatedLocator } from '../shared/source-link.js';
import { notebookEditor } from './notebook.js';
import { api, button, byId, el, icon, inputField, message, modal, readerLabel as label, safeWeb, sourceUrl, toast, zoteroStatusText } from './ui.js';

export interface ReaderPort {
  doc: DocumentInfo; page: number; state: ReaderState; view?: PageView;
  navigate(id:string,page?:number,anchor?:string,quote?:string,target?:TranslatedLocator,range?:SavedSelectionRange):Promise<void>;
  openDocument(opened:OpenDocument):Promise<void>;
  importFile(file:File):Promise<void>;
  discardDocument?(docId: string): void;
  refresh():Promise<void>;
  repaintNotes():void;
  showNotebook():void;
  openNotebookSource(url:URL):Promise<void>;
  addDiscussionScreenshot(): void;
  discussionScreenshot(source: ChatSource): Promise<string>;
  resumeDiscussion(ref: DiscussionRef, requestId?: string): Promise<void>;
  notebookHighlights(): readonly PaperAnnotation[];
  editNotebookHighlight(id: string, trigger: HTMLElement): void;
  attachDiscussionPosition?(header: HTMLElement, signal: AbortSignal): void;
  saveHighlight?(source:SourceRecord,quote:string):Promise<void>;
  paperSelection?(source?: ChatSource):void;
  showReadingSide?(side: 'source' | 'translation'):void;
  discussionChanged?(docId: string):void;
  regionDiscussionClosed?(explicit: boolean):void;
  notebook?:NotebookSnapshot;
  notebookError?:string;
}
const close = () => byId<HTMLDialogElement>('dialog').close();
const rule = () => el('hr','rule');
const CUSTOM_LANGUAGE = '__custom__';

export function settingsDialog(app:ReaderPort,focusVault:boolean|'zotero'=false,returnToLibrary?:()=>void):void {
  const data=app.state.settings;
  const body=modal(returnToLibrary?label('Zotero connection','Zotero 连接'):label('Connections','连接设置'));
  const form=el('form');
  const base=inputField(label('API base URL','API 接口地址'),data.baseUrl,'url');
  const model=inputField(label('Model','模型'),data.model);
  const key=inputField(label('API key','API 密钥'),'', 'password',data.hasApiKey?label('Key saved','已保存密钥'):label('Optional for local models','本地模型可留空'));
  const currentLang=data.targetLanguage || DEFAULT_TARGET_LANGUAGE;
  const matchedPreset=findTargetLanguagePreset(currentLang);
  const langRow=el('label','field'), langSelect=el('select');
  for(const preset of TARGET_LANGUAGE_PRESETS){
    const option=el('option','',label(preset.labelEn,preset.labelZh));
    option.value=preset.id;
    langSelect.append(option);
  }
  const customOption=el('option','',label('Custom…','自定义…'));
  customOption.value=CUSTOM_LANGUAGE;
  langSelect.append(customOption);
  langSelect.value=matchedPreset ? matchedPreset.id : CUSTOM_LANGUAGE;
  langSelect.ariaLabel=label('Translation language','翻译目标语言');
  langRow.append(el('span','',label('Translation language','翻译目标语言')),langSelect);
  const customLang=inputField(
    label('Custom target language','自定义目标语言'),
    matchedPreset ? '' : currentLang,
    'text',
    label('e.g. Portuguese, Italian, Arabic','例如：葡萄牙语、意大利语、阿拉伯语')
  );
  customLang.input.maxLength=TARGET_LANGUAGE_MAX_LENGTH;
  const switchLanguage=()=>{
    const custom=langSelect.value===CUSTOM_LANGUAGE;
    customLang.row.hidden=!custom;
    customLang.input.required=custom;
    customLang.input.disabled=!custom;
  };
  langSelect.onchange=switchLanguage;
  switchLanguage();
  const vault=inputField(label('Obsidian vault folder','Obsidian 笔记库文件夹'),data.vaultPath,'text',label('Absolute path to your vault','填写 Obsidian 笔记库的绝对路径'));
  const id=inputField(label('Zotero library ID','Zotero 资料库 ID'),data.zoteroLibraryId);
  id.input.inputMode='numeric';id.input.pattern='[1-9][0-9]*';id.input.maxLength=24;
  const zotKey=inputField(label('Zotero API key','Zotero API 密钥'),'','password',data.hasZoteroKey?label('Key saved','已保存密钥'):label('Optional for public libraries','公开资料库可留空'));
  const modeRow=el('label','field'), mode=el('select');
  for(const [value,name] of [['desktop',label('Desktop app on this computer','本机 Zotero')],['web',label('Web library','Zotero 网页资料库')]]){
    const option=el('option','',name);option.value=value;mode.append(option);
  }
  mode.value=data.zoteroMode ?? (data.zoteroLibraryId?'web':'desktop');
  modeRow.append(el('span','',label('Zotero connection','连接方式')),mode);
  const libraryType=el('label','field');const select=el('select');
  for(const [value,name] of [['user',label('Personal library','个人资料库')],['group',label('Group library','群组资料库')]]){
    const option=el('option','',name);option.value=value;select.append(option);
  }
  select.value=data.zoteroLibraryType || 'user';libraryType.append(el('span','',label('Library type','资料库类型')),select);
  const clearModel=el('input');clearModel.type='checkbox';
  const clearZot=el('input');clearZot.type='checkbox';
  function clearField(input:HTMLInputElement,label:string,visible:boolean):HTMLElement{
    const wrapper=el('label','check-row');wrapper.hidden=!visible;wrapper.append(input,label);return wrapper;
  }
  const status=data.aiMode==='dsh'
    ? label('Using DSH: '+(data.hostModel||data.hostProvider||'host model'),'当前使用 DSH：'+(data.hostModel||data.hostProvider||'宿主模型'))
    : data.aiMode==='api'
      ? label('Custom model configured','已配置自定义模型')
      : label('Configure a model for new translations and follow-up questions.','请配置模型以使用新译文与追问功能。');
  const webFields=el('div'),desktopHint=el('p','hint',label('Open Zotero and enable “Allow other applications on this computer to communicate with Zotero” in Settings → Advanced.','打开 Zotero，在「设置 → 高级」中启用「允许此计算机上的其他应用程序与 Zotero 通信」。'));
  const keys=el('a','external',label('Zotero library IDs and API keys ↗','查看 Zotero 资料库 ID 和密钥 ↗'));
  keys.href='https://www.zotero.org/settings/keys';keys.target='_blank';keys.rel='noopener noreferrer';
  webFields.append(libraryType,id.row,zotKey.row,clearField(clearZot,label('Remove saved Zotero key','移除已保存的 Zotero 密钥'),data.hasZoteroKey),
    el('p','hint',label('Enter a library ID to browse public items. Private libraries also need a key with read access.','公开资料库填写 ID 即可浏览。私有资料库还需要具有读取权限的密钥。')),keys);
  const testLine=el('div','zotero-settings-test'),testResult=el('span');
  testResult.setAttribute('role','status');
  const zoteroSettings=()=>({zoteroMode:mode.value==='desktop'?'desktop' as const:'web' as const,
    zoteroLibraryType:select.value==='group'?'group' as const:'user' as const,zoteroLibraryId:id.input.value,
    zoteroApiKey:zotKey.input.value,clearZoteroKey:clearZot.checked});
  let testVersion=0;
  const test=button(label('Test Zotero connection','测试 Zotero 连接'),async()=>{
    if(mode.value==='web' && !id.input.reportValidity())return;
    const version=++testVersion;
    testResult.textContent=label('Checking library access…','正在连接资料库…');
    try {const result=await api('zotero.status',zoteroSettings());if(version===testVersion)testResult.textContent=zoteroStatusText(result.detail);}
    catch(error){if(version===testVersion)testResult.textContent=zoteroStatusText(message(error));}
  },'btn');
  testLine.append(test,testResult);
  const switchMode=()=>{webFields.hidden=mode.value==='desktop';desktopHint.hidden=!webFields.hidden;id.input.required=!webFields.hidden;id.input.disabled=webFields.hidden;};
  mode.onchange=switchMode;switchMode();
  for(const field of [mode,select,id.input,zotKey.input,clearZot])field.addEventListener('input',()=>{testVersion++;testResult.textContent='';});
  if(!returnToLibrary)form.append(el('h3','',label('Language model','语言模型')),el('p','hint',status),base.row,model.row,key.row,clearField(clearModel,label('Remove saved model key','移除已保存的模型密钥'),data.hasApiKey),
    langRow,customLang.row,
    rule(),el('h3','','Obsidian'),vault.row,el('p','hint',label('Choose a vault from the Obsidian desktop app. Paper Reader keeps each book’s chapter notes together in a folder.', '选择 Obsidian 桌面应用中的笔记库。Paper Reader 会将同一本书的章节笔记放在一个文件夹中。')),
    rule(),el('h3','','Zotero'));
  form.append(modeRow,desktopHint,webFields,testLine,rule());
  const actions=el('div','row');
  const save=el('button','btn primary',returnToLibrary?label('Save connection','保存连接'):label('Save connections','保存连接设置'));save.type='submit';actions.append(save);
  if(returnToLibrary)actions.append(button(label('Back to library','返回资料库'),returnToLibrary));
  form.append(actions);
  form.onsubmit=async event=>{
    event.preventDefault();save.disabled=true;
    try{
      const targetLanguage=langSelect.value===CUSTOM_LANGUAGE ? customLang.input.value : langSelect.value;
      await api('settings.save',{...(!returnToLibrary && {baseUrl:base.input.value,model:model.input.value,apiKey:key.input.value,targetLanguage,vaultPath:vault.input.value,clearApiKey:clearModel.checked}),...zoteroSettings()});
      await app.refresh();
      if(byId('refsTab').getAttribute('aria-selected')==='true')app.repaintNotes();
      if(returnToLibrary){if(form.isConnected && byId<HTMLDialogElement>('dialog').open)returnToLibrary();}
      else {close();toast(label('Connections saved.','连接设置已保存。'));}
    }catch(error){toast(message(error));}finally{save.disabled=false;}
  };
  body.append(form);
  if(focusVault==='zotero')mode.focus();
  else if(focusVault)vault.input.focus();
}

export function collectionsDialog(app:ReaderPort,tab:'vocabulary'|'history'='vocabulary'):void {
  const body=modal(label('Vocabulary and history','生词与历史'));
  let activeTab:'vocabulary'|'history'=tab;
  const tabs=el('div','tabs');
  tabs.setAttribute('role','tablist');
  tabs.setAttribute('aria-label',label('Collection view','收藏视图'));
  const panel=el('div');
  panel.id='collections-panel';
  panel.setAttribute('role','tabpanel');
  const tabDefs:[('vocabulary'|'history'), string][]=[
    ['vocabulary',label('Vocabulary','生词')],
    ['history',label('History','历史')]
  ];
  const tabButtons=new Map<'vocabulary'|'history',HTMLButtonElement>();
  const query=el('input','search');
  query.type='search';
  query.placeholder=label('Find a word or passage','搜索词语或段落');
  query.setAttribute('aria-label',query.placeholder);
  const display=()=>{
    panel.replaceChildren();
    const records=app.state[activeTab].filter(w=>(w.text+' '+w.meaning+' '+w.title).toLowerCase().includes(query.value.toLowerCase()));
    if(!records.length)panel.append(el('p','hint',query.value?label('No matching entries.','没有找到符合条件的记录。'):activeTab==='history'?label('Your lookups appear here.','你的查词和提问记录会显示在这里。'):label('Save words from a selection card.','在选区卡片中收藏词语后，会显示在这里。')));
    for(const [rowIndex,word] of records.entries()){
      const line=el('div','list-row');line.append(el('strong','',word.text));
      if(word.meaning)line.append(el('p','',word.meaning));
      else if(word.context){
        const detail=el('details','selection-counterpart');
        detail.append(el('summary','',label('Passage context','上下文')),el('p','',word.context));line.append(detail);
      }
      const actions=el('div','row');
      actions.append(button(word.title || label('Open source','打开出处'),async()=>{
        if(word.docId){
          const url=URL.canParse(word.sourceUrl)?new URL(word.sourceUrl):undefined;
          await app.navigate(word.docId,word.page,word.anchor,url?.searchParams.get('quote')||word.text,url&&readTranslatedLocator(url),url&&readSelectionRange(url));close();
        }
        else {const link=safeWeb(word.sourceUrl);if(link)window.open(link,'_blank','noopener');}
      },'text-btn','arrow'));
      if(activeTab==='vocabulary')actions.append(button(label('Remove','移除'),async()=>{
        await api('vocab.delete',{id:word.id});
        await app.refresh();
        display();
        const remaining=panel.querySelectorAll<HTMLElement>('.list-row');
        const nextRow=remaining[Math.min(rowIndex,remaining.length-1)];
        const focusTarget=nextRow?.querySelector<HTMLElement>('button:last-of-type') ?? tabButtons.get(activeTab);
        focusTarget?.focus({preventScroll:true});
      },'subtle'));
      line.append(actions);panel.append(line);
    }
  };
  const selectTab=(key:'vocabulary'|'history',focusTab=false)=>{
    activeTab=key;
    for(const [tabKey,btn] of tabButtons){
      const selected=tabKey===key;
      btn.setAttribute('aria-selected',String(selected));
      btn.tabIndex=selected?0:-1;
    }
    const activeButton=tabButtons.get(key)!;
    panel.setAttribute('aria-labelledby',activeButton.id);
    display();
    if(focusTab)activeButton.focus({preventScroll:true});
  };
  for(const [key,name] of tabDefs){
    const b=el('button','btn',name);
    b.type='button';
    b.id='collections-tab-'+key;
    b.setAttribute('role','tab');
    b.setAttribute('aria-controls',panel.id);
    b.addEventListener('click',()=>selectTab(key));
    tabButtons.set(key,b);
    tabs.append(b);
  }
  const order:['vocabulary','history']=['vocabulary','history'];
  tabs.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const index=order.indexOf(activeTab);
    const next=event.key==='Home'?0:event.key==='End'?order.length-1:(index+(event.key==='ArrowRight'?1:-1)+order.length)%order.length;
    selectTab(order[next],true);
  });
  body.append(tabs,query,panel);
  query.addEventListener('input',display);
  selectTab(activeTab,true);
}

export function sourceChip(app:ReaderPort,source:Pick<SourceRecord,'docId'|'page'|'anchor'|'label'> & {sourceUrl?:string;context?:string},quote=''):HTMLButtonElement {
  const url=source.sourceUrl && URL.canParse(source.sourceUrl)?new URL(source.sourceUrl):undefined;
  const savedTarget=url && readTranslatedLocator(url);
  // Earlier selection notes kept the Chinese text in context before links recorded its offset.
  const legacyTarget=source.context && source.context!==quote && /\p{Script=Han}/u.test(source.context) ? {text:source.context}:undefined;
  const target=savedTarget && source.context?.startsWith(savedTarget.text)?{...savedTarget,text:source.context}:savedTarget??legacyTarget;
  const section=app.doc.id===source.docId && app.doc.book?.sections[source.page-1];
  const location=section ? chapterPassageLabel(section.title,source.label) :
    (app.doc.kind==='web'?label('Article','文章'):label('p. '+source.page,'第 '+source.page+' 页'))+(source.label?' · '+source.label:'');
  const chip=button(location,()=>url?.searchParams.has('reply') ? app.openNotebookSource(url)
    : app.navigate(source.docId,source.page,source.anchor,quote,target,url&&readSelectionRange(url)),'source-chip');
  chip.append(icon('arrow',10));
  chip.onmouseenter=()=>{if(app.doc.id===source.docId&&app.page===source.page)app.view?.highlight(source.anchor,true,quote,target);};
  chip.onmouseleave=()=>{
    if(app.doc.id!==source.docId || app.page!==source.page)return;
    app.view?.highlight(source.anchor,false);
  };
  return chip;
}

const figureCache=new Map<string,string>();
function guide(app:ReaderPort,parent:HTMLElement):void {
  const link=(anchor:string,caption:string,quote='')=>sourceChip(app,{docId:'pagedattention',page:6,anchor,label:caption},quote);
  const one=el('section','sample-section');
  one.append(el('h3','',label('From page 6','第 6 页要点')),el('p','',label('Trace a request from its logical blocks to the physical KV cache. The mapping lets a sequence grow without reserving contiguous memory.','顺着请求查看逻辑块如何映射到物理 KV 缓存。通过这种映射，序列无需预先占用连续显存即可动态增长。')),
    el('blockquote','quote','“the mapping between logical and physical KV blocks of each request”'),link('block-tables',label('Left column','左栏'),'block tables'));
  const two=el('section','sample-section');
  two.append(el('h3','',label('What does a block table store?','块表里存了什么？')),el('p','',label('A request keeps a table of physical block locations. The next token can use a free slot in its last block.','每个请求都会维护一张物理块位置表，新生成的 token 可以直接写入最后一个块中的空位。')));
  const image=app.page===6?app.view?.figureImage?.('figure-6'):undefined;
  if(image)figureCache.set('figure-6',image);
  const src=figureCache.get('figure-6');
  if(src){const thumb=button('',()=>app.navigate('pagedattention',6,'figure-6'),'thumb');const img=el('img');img.src=src;img.alt=label('Figure 6. Block table translation in vLLM.','图 6：vLLM 中的块表映射示意图。');thumb.setAttribute('aria-label',label('Locate Figure 6','定位到图 6'));thumb.append(img);two.append(thumb);}
  two.append(link('figure-6',label('Figure 6','图 6')));
  const three=el('section','sample-section');const check=el('input');check.type='checkbox';check.checked=localStorage.getItem('reader.reviewed-figure-6')==='yes';
  check.onchange=()=>localStorage.setItem('reader.reviewed-figure-6',check.checked?'yes':'no');
  const checkLabel=el('label','check-row');checkLabel.append(check,label('Revisit the mapping in Figure 6.','回看图 6 中的块表映射。'));
  three.append(el('h3','',label('To revisit','待回顾')),checkLabel);parent.append(one,two,three);
}

export function paperNotebook(app: ReaderPort) {
  return notebookEditor(app, sourceChip, () => settingsDialog(app, true));
}
export function notesPanel(app:ReaderPort,parent:HTMLElement):void {
  const editor = paperNotebook(app);
  if (editor) editor.attach(parent, app.doc.id==='pagedattention'?node=>guide(app,node):undefined);
  else parent.replaceChildren(el('p','hint',app.notebookError || label('Opening notes…','正在打开笔记…')),button(label('Obsidian vault settings','Obsidian 笔记库设置'),()=>settingsDialog(app,true),'text-btn'));
}
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to a hidden textarea when clipboard permissions are denied.
    }
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = el('textarea');
  area.value = text;
  area.readOnly = true;
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.insetInlineStart = '-9999px';
  area.style.top = '0';
  area.style.opacity = '0';
  document.body.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return typeof document.execCommand === 'function' && Boolean(document.execCommand('copy'));
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
}

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function referencePanel(app:ReaderPort,parent:HTMLElement):void {
  const doc=app.doc;
  const title=doc.paperTitle || doc.title;
  const trail=el('div','trail');trail.append(icon('folder',13),label('Library / Reference','资料库 / 文献'));
  parent.append(trail,el('h1','',title));
  const byline=[doc.authors,doc.venue,doc.year && !doc.venue?.includes(doc.year)?doc.year:undefined].filter(Boolean).join(' · ');
  if(byline)parent.append(el('p','',byline));
  const web=safeWeb(doc.url);
  if(web){const link=el('a','external',doc.doi?label('Original paper ↗','原始论文 ↗'):label('Original article ↗','原始文章 ↗'));link.href=web;link.target='_blank';link.rel='noopener';parent.append(link);}
  const desktop=app.state.settings.zoteroMode==='desktop';
  const library=app.state.settings.zoteroLibraryType+':'+app.state.settings.zoteroLibraryId;
  const legacyKey='reader.zotero.'+library+':'+doc.id;
  const configured=desktop || Boolean(app.state.settings.zoteroLibraryId);
  let linkedZotero:ZoteroItem|null=null;
  let zoteroSettled=!configured;
  let zoteroPending:Promise<void>|undefined;
  const exportSection=el('section','citation-export');
  exportSection.setAttribute('aria-label',label('Export citation','导出引文'));
  const exportActions=el('div','citation-export-actions');
  const exportStatus=el('p','citation-export-status');
  exportStatus.setAttribute('role','status');
  exportStatus.setAttribute('aria-live','polite');
  const buildCitationPayload=(format:'bibtex'|'ris')=>{
    const meta=buildCitationMetadata(doc,linkedZotero);
    const content=format==='bibtex'?formatBibTeX(meta):formatRIS(meta);
    const key=buildCiteKey(meta).toLowerCase().replace(/[^a-z0-9]+/g,'') || 'reference';
    return {content,filename:`${key}.${format==='bibtex'?'bib':'ris'}`};
  };
  const waitForZotero=async()=>{
    if(!zoteroSettled && zoteroPending){
      await Promise.race([zoteroPending.catch(()=>undefined),new Promise<void>(resolve=>window.setTimeout(resolve,1500))]);
    }
  };
  const copyCitation=async(format:'bibtex'|'ris')=>{
    if(!zoteroSettled)await waitForZotero();
    if(!exportSection.isConnected || app.doc.id!==doc.id)return;
    const {content}=buildCitationPayload(format);
    const copied=await copyText(content);
    if(!exportSection.isConnected || app.doc.id!==doc.id)return;
    const feedback=copied
      ? (format==='bibtex'?label('BibTeX copied to clipboard.','BibTeX 已复制到剪贴板。'):label('RIS copied to clipboard.','RIS 已复制到剪贴板。'))
      : label('Clipboard access was blocked. Use Download instead.','剪贴板权限受限，请改用下载按钮。');
    exportStatus.textContent=feedback;
    toast(feedback);
  };
  const downloadCitation=async(format:'bibtex'|'ris')=>{
    if(!zoteroSettled)await waitForZotero();
    if(!exportSection.isConnected || app.doc.id!==doc.id)return;
    const {content,filename}=buildCitationPayload(format);
    downloadFile(filename,content,format==='bibtex'?'application/x-bibtex;charset=utf-8':'application/x-research-info-systems;charset=utf-8');
    const feedback=label(`Downloaded ${filename}.`,`已下载 ${filename}。`);
    exportStatus.textContent=feedback;
    toast(feedback);
  };
  exportActions.append(
    button(label('Copy BibTeX','复制 BibTeX'),()=>copyCitation('bibtex'),'btn'),
    button(label('Download .bib','下载 .bib'),()=>downloadCitation('bibtex'),'btn'),
    button(label('Copy RIS','复制 RIS'),()=>copyCitation('ris'),'btn'),
    button(label('Download .ris','下载 .ris'),()=>downloadCitation('ris'),'btn')
  );
  exportSection.append(el('h3','',label('Export citation','导出引文')),exportActions,exportStatus);
  parent.append(exportSection);
  parent.append(rule(),el('h3','','Zotero'));
  const connection=el('section','zotero-connection'),status=el('p'),connectionActions=el('div','row');
  connection.ariaLabel=label('Zotero connection','Zotero 连接');status.setAttribute('role','status');
  connection.append(status,connectionActions);parent.append(connection);
  const settings=button(label('Connection settings','连接设置'),()=>settingsDialog(app,'zotero'),'btn','settings');
  let readOnly=!desktop && !app.state.settings.hasZoteroKey;
  const test=async()=>{
    status.textContent=label('Checking library access…','正在检查资料库连接…');
    const result=await api('zotero.status',{});
    if(!connection.isConnected)return;
    connection.dataset.connected=String(result.connected);status.textContent=zoteroStatusText(result.detail);
    readOnly=result.access==='read';
    if(configured)addItem.disabled=readOnly || !result.connected;
  };
  connectionActions.append(button(label('Test connection','测试连接'),test,'btn'),settings);
  if(!configured){
    status.textContent=label('Connect a Zotero library to find references and manage their collections.','连接 Zotero 资料库后，可查找文献条目并管理所属分类。');
    connectionActions.prepend(button(label('Connect desktop','连接本机 Zotero'),async()=>{
      await api('settings.save',{zoteroMode:'desktop'});await app.refresh();app.repaintNotes();
    },'btn'));
    return;
  }
  const summary=el('div','list-row');parent.append(summary);
  const query=el('input','search');query.type='search';query.value=doc.title.replace(/\.pdf$/i,'');query.setAttribute('aria-label',label('Search Zotero','搜索 Zotero'));
  const found=el('div'),editor=el('div');
  async function restore():Promise<void>{
    const oldKey=desktop ? null : localStorage.getItem(legacyKey);
    const result=await api('zotero.get',{docId:doc.id,key:oldKey||undefined});
    if(!summary.isConnected || app.doc.id!==doc.id)return;
    const item=result.item;
    linkedZotero=item;
    zoteroSettled=true;
    summary.replaceChildren();addItem.hidden=Boolean(item);
    if(!item){summary.append(el('p','hint',label('Find an existing item or save this document to a collection.','查找已有条目，或将当前文档保存到 Zotero 分类。')));return;}
    const titleLine=el('p');titleLine.append(el('strong','',item.title));
    const actions=el('div','row');
    summary.append(el('div','section-title',label('Linked reference','已关联文献')),titleLine,actions);
    actions.append(button(label('Manage collections','管理分类'),()=>choose(item),'text-btn','folder'));
    if(desktop || item.webUrl){
      const link=el('a','external',label('Open in Zotero ↗','在 Zotero 中打开 ↗'));
      link.href=desktop ? 'zotero://select/library/items/'+encodeURIComponent(item.key) : item.webUrl!;
      link.target='_blank';link.rel='noopener';actions.append(link);
    }
    if(oldKey)localStorage.removeItem(legacyKey);
  }
  async function choose(item?:ZoteroItem):Promise<void>{
    const {collections}=await api('zotero.collections',{});
    if(!editor.isConnected || app.doc.id!==doc.id)return;
    const checked=new Set(item?.collections||[]);
    editor.replaceChildren(el('div','section-title',item?label('Collections for '+item.title,'所属分类 · '+item.title):label('Choose collections','选择分类')));
    if(item)editor.append(button(label('Link this item','关联此条目'),async()=>{
      const {item:linked}=await api('zotero.link',{docId:doc.id,key:item.key});
      linkedZotero=linked;zoteroSettled=true;
      editor.replaceChildren();found.replaceChildren();await restore();toast(label('Linked to this paper.','已关联到本文档。'));
    },'btn','note'));
    for(const c of collections){const l=el('label','check-row'),box=el('input');box.type='checkbox';box.checked=checked.has(c.key);box.disabled=box.checked || readOnly;
      box.onchange=()=>{if(box.checked)checked.add(c.key);else checked.delete(c.key);};l.append(box,c.name);editor.append(l);}
    if(readOnly){editor.append(el('p','hint',label('This connection can read and link items. Enable write access to change collections.','当前连接仅支持读取与关联。如需修改分类，请开启写入权限。')));return;}
    if(!collections.length)editor.append(el('p','hint',label('Saving without a collection adds the item to your library.','不选择分类时，条目会直接保存到资料库根目录。')));
    const progress=el('p','hint');progress.setAttribute('role','status');
    editor.append(button(item?label('Update Zotero item','更新 Zotero 条目'):label('Save to Zotero','保存到 Zotero'),async()=>{
      progress.textContent=desktop?label('Saving… Check Zotero for an approval dialog.','正在保存…请在 Zotero 中确认授权弹窗。'):label('Saving…','正在保存…');
      try{
        await api('zotero.save',{docId:doc.id,key:item?.key,title,url:doc.url,doi:doc.doi,collections:[...checked]});
        found.replaceChildren();editor.replaceChildren();await restore();await test();toast(label('Saved to your Zotero library.','已保存到 Zotero 资料库。'));
      }catch(error){progress.textContent=zoteroStatusText(message(error));}
    },'btn primary','check'),progress);
  }
  const addItem=button(label('Add to library','添加到资料库'),()=>choose(),'btn','plus');
  addItem.disabled=readOnly;
  parent.append(query,button(label('Find item','查找条目'),async()=>{
    const {items}=await api('zotero.search',{query:query.value});
    found.replaceChildren();if(!items.length)found.append(el('p','hint',label('No matching items.','没有找到匹配的条目。')));
    for(const item of items)found.append(button(item.title,()=>choose(item),'doc-row','note'));
  },'btn','book'),addItem,found,editor);
  void test().catch(error=>{status.textContent=zoteroStatusText(message(error));});
  zoteroPending=restore().catch(error=>{
    linkedZotero=null;zoteroSettled=true;
    if(summary.isConnected)summary.replaceChildren(el('p','hint',zoteroStatusText(message(error))));
  });
}
