import type { ChatSource, DocumentInfo, NotebookSnapshot, OpenDocument, PageView, ReaderState, SourceRecord, ZoteroItem } from '../shared/types.js';
import type { DiscussionRef } from './discussion-drafts.js';
import type { PaperAnnotation } from '../shared/annotations.js';
import { DEFAULT_TARGET_LANGUAGE, TARGET_LANGUAGE_MAX_LENGTH, TARGET_LANGUAGE_PRESETS, findTargetLanguagePreset } from '../shared/languages.js';
import { chapterPassageLabel } from '../shared/notebook-structure.js';
import { readSelectionRange, readTranslatedLocator, type SavedSelectionRange, type TranslatedLocator } from '../shared/source-link.js';
import { notebookEditor } from './notebook.js';
import { api, button, byId, el, icon, inputField, message, modal, readerLabel as label, safeWeb, sourceUrl, toast } from './ui.js';

export interface ReaderPort {
  doc: DocumentInfo; page: number; state: ReaderState; view?: PageView;
  navigate(id:string,page?:number,anchor?:string,quote?:string,target?:TranslatedLocator,range?:SavedSelectionRange):Promise<void>;
  openDocument(opened:OpenDocument):Promise<void>;
  importFile(file:File):Promise<void>;
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
  const base=inputField('API base URL',data.baseUrl,'url');
  const model=inputField('Model',data.model);
  const key=inputField('API key','', 'password',data.hasApiKey?'Key saved':'Optional for local models');
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
  const vault=inputField('Obsidian vault folder',data.vaultPath,'text','Absolute path to your vault');
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
  const status=data.aiMode==='dsh'?'Using DSH: '+(data.hostModel||data.hostProvider||'host model'):data.aiMode==='api'?'Custom model configured':'Configure a model for new translations and follow-up questions.';
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
    try {const result=await api('zotero.status',zoteroSettings());if(version===testVersion)testResult.textContent=result.detail;}
    catch(error){if(version===testVersion)testResult.textContent=message(error);}
  },'btn');
  testLine.append(test,testResult);
  const switchMode=()=>{webFields.hidden=mode.value==='desktop';desktopHint.hidden=!webFields.hidden;id.input.required=!webFields.hidden;id.input.disabled=webFields.hidden;};
  mode.onchange=switchMode;switchMode();
  for(const field of [mode,select,id.input,zotKey.input,clearZot])field.addEventListener('input',()=>{testVersion++;testResult.textContent='';});
  if(!returnToLibrary)form.append(el('h3','','Language model'),el('p','hint',status),base.row,model.row,key.row,clearField(clearModel,'Remove saved model key',data.hasApiKey),
    langRow,customLang.row,
    rule(),el('h3','','Obsidian'),vault.row,el('p','hint',label('Choose a vault from the Obsidian desktop app. Paper Reader keeps each book’s chapter notes together in a folder.', '选择 Obsidian 桌面应用中的仓库。Paper Reader 会将同一本书的章节笔记放在一个文件夹中。')),
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
  const body=modal('Words and history');
  const tabs=el('div','tabs');
  tabs.setAttribute('role','group');
  tabs.setAttribute('aria-label',label('Collection view','收藏视图'));
  for(const [key,label] of [['vocabulary','Vocabulary'],['history','History']] as const){
    const b=button(label,()=>collectionsDialog(app,key));b.setAttribute('aria-pressed',String(tab===key));tabs.append(b);
  }
  const query=el('input','search');query.type='search';query.placeholder='Find a word or passage';query.setAttribute('aria-label',query.placeholder);
  const rows=el('div');body.append(tabs,query,rows);
  const display=()=>{
    rows.replaceChildren();
    const records=app.state[tab].filter(w=>(w.text+' '+w.meaning+' '+w.title).toLowerCase().includes(query.value.toLowerCase()));
    if(!records.length)rows.append(el('p','hint',query.value?'No matching entries.':tab==='history'?'Your lookups appear here.':'Save words from a selection card.'));
    for(const word of records){
      const line=el('div','list-row');line.append(el('strong','',word.text));
      if(word.meaning)line.append(el('p','',word.meaning));
      else if(word.context){
        const detail=el('details','selection-counterpart');
        detail.append(el('summary','','Passage context'),el('p','',word.context));line.append(detail);
      }
      const actions=el('div','row');
      actions.append(button(word.title || 'Open source',async()=>{
        if(word.docId){
          const url=URL.canParse(word.sourceUrl)?new URL(word.sourceUrl):undefined;
          await app.navigate(word.docId,word.page,word.anchor,url?.searchParams.get('quote')||word.text,url&&readTranslatedLocator(url),url&&readSelectionRange(url));close();
        }
        else {const link=safeWeb(word.sourceUrl);if(link)window.open(link,'_blank','noopener');}
      },'text-btn','arrow'));
      if(tab==='vocabulary')actions.append(button('Remove',async()=>{await api('vocab.delete',{id:word.id});await app.refresh();display();},'subtle'));
      line.append(actions);rows.append(line);
    }
  };
  query.addEventListener('input',display);display();
}

export function sourceChip(app:ReaderPort,source:Pick<SourceRecord,'docId'|'page'|'anchor'|'label'> & {sourceUrl?:string;context?:string},quote=''):HTMLButtonElement {
  const url=source.sourceUrl && URL.canParse(source.sourceUrl)?new URL(source.sourceUrl):undefined;
  const savedTarget=url && readTranslatedLocator(url);
  // Earlier selection notes kept the Chinese text in context before links recorded its offset.
  const legacyTarget=source.context && source.context!==quote && /\p{Script=Han}/u.test(source.context) ? {text:source.context}:undefined;
  const target=savedTarget && source.context?.startsWith(savedTarget.text)?{...savedTarget,text:source.context}:savedTarget??legacyTarget;
  const section=app.doc.id===source.docId && app.doc.book?.sections[source.page-1];
  const location=section ? chapterPassageLabel(section.title,source.label) :
    (app.doc.kind==='web'?label('Article','文章'):'p. '+source.page)+(source.label?' · '+source.label:'');
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
  const link=(anchor:string,label:string,quote='')=>sourceChip(app,{docId:'pagedattention',page:6,anchor,label},quote);
  const one=el('section','sample-section');
  one.append(el('h3','','From page 6'),el('p','','Trace a request from its logical blocks to the physical KV cache. The mapping lets a sequence grow without reserving contiguous memory.'),
    el('blockquote','quote','“the mapping between logical and physical KV blocks of each request”'),link('block-tables','Left column','block tables'));
  const two=el('section','sample-section');
  two.append(el('h3','','What does a block table store?'),el('p','','A request keeps a table of physical block locations. The next token can use a free slot in its last block.'));
  const image=app.page===6?app.view?.figureImage?.('figure-6'):undefined;
  if(image)figureCache.set('figure-6',image);
  const src=figureCache.get('figure-6');
  if(src){const thumb=button('',()=>app.navigate('pagedattention',6,'figure-6'),'thumb');const img=el('img');img.src=src;img.alt='Figure 6. Block table translation in vLLM.';thumb.setAttribute('aria-label','Locate Figure 6');thumb.append(img);two.append(thumb);}
  two.append(link('figure-6','Figure 6'));
  const three=el('section','sample-section');const check=el('input');check.type='checkbox';check.checked=localStorage.getItem('reader.reviewed-figure-6')==='yes';
  check.onchange=()=>localStorage.setItem('reader.reviewed-figure-6',check.checked?'yes':'no');
  const checkLabel=el('label','check-row');checkLabel.append(check,'Revisit the mapping in Figure 6.');
  three.append(el('h3','','To revisit'),checkLabel);parent.append(one,two,three);
}

export function paperNotebook(app: ReaderPort) {
  return notebookEditor(app, sourceChip, () => settingsDialog(app, true));
}
export function notesPanel(app:ReaderPort,parent:HTMLElement):void {
  const editor = paperNotebook(app);
  if (editor) editor.attach(parent, app.doc.id==='pagedattention'?node=>guide(app,node):undefined);
  else parent.replaceChildren(el('p','hint',app.notebookError || 'Opening notebook…'),button('Vault settings',()=>settingsDialog(app,true),'text-btn'));
}
export function referencePanel(app:ReaderPort,parent:HTMLElement):void {
  const doc=app.doc;
  const title=doc.paperTitle || doc.title;
  const trail=el('div','trail');trail.append(icon('folder',13),'Library / Reference');
  parent.append(trail,el('h1','',title));
  if(doc.authors)parent.append(el('p','',doc.authors+' · '+doc.venue));
  const web=safeWeb(doc.url);
  if(web){const link=el('a','external',doc.doi?'Original paper ↗':'Original article ↗');link.href=web;link.target='_blank';link.rel='noopener';parent.append(link);}
  parent.append(rule(),el('h3','','Zotero'));
  const desktop=app.state.settings.zoteroMode==='desktop';
  const library=app.state.settings.zoteroLibraryType+':'+app.state.settings.zoteroLibraryId;
  const legacyKey='reader.zotero.'+library+':'+doc.id;
  const configured=desktop || Boolean(app.state.settings.zoteroLibraryId);
  const connection=el('section','zotero-connection'),status=el('p'),connectionActions=el('div','row');
  connection.ariaLabel='Zotero connection';status.setAttribute('role','status');
  connection.append(status,connectionActions);parent.append(connection);
  const settings=button('Connection settings',()=>settingsDialog(app,'zotero'),'btn','settings');
  let readOnly=!desktop && !app.state.settings.hasZoteroKey;
  const test=async()=>{
    status.textContent='Checking library access…';
    const result=await api('zotero.status',{});
    if(!connection.isConnected)return;
    connection.dataset.connected=String(result.connected);status.textContent=result.detail;
    readOnly=result.access==='read';
    if(configured)addItem.disabled=readOnly || !result.connected;
  };
  connectionActions.append(button('Test connection',test,'btn'),settings);
  if(!configured){
    status.textContent='Connect a Zotero library to find references and manage their collections.';
    connectionActions.prepend(button('Connect desktop',async()=>{
      await api('settings.save',{zoteroMode:'desktop'});await app.refresh();app.repaintNotes();
    },'btn'));
    return;
  }
  const summary=el('div','list-row');parent.append(summary);
  const query=el('input','search');query.type='search';query.value=doc.title.replace(/\.pdf$/i,'');query.setAttribute('aria-label','Search Zotero');
  const found=el('div'),editor=el('div');
  async function restore():Promise<void>{
    const oldKey=desktop ? null : localStorage.getItem(legacyKey);
    const result=await api('zotero.get',{docId:doc.id,key:oldKey||undefined});
    if(!summary.isConnected || app.doc.id!==doc.id)return;
    const item=result.item;
    summary.replaceChildren();addItem.hidden=Boolean(item);
    if(!item){summary.append(el('p','hint','Find an existing item or save this document to a collection.'));return;}
    const titleLine=el('p');titleLine.append(el('strong','',item.title));
    const actions=el('div','row');
    summary.append(el('div','section-title','Linked reference'),titleLine,actions);
    actions.append(button('Manage collections',()=>choose(item),'text-btn','folder'));
    if(desktop || item.webUrl){
      const link=el('a','external','Open in Zotero ↗');
      link.href=desktop ? 'zotero://select/library/items/'+encodeURIComponent(item.key) : item.webUrl!;
      link.target='_blank';link.rel='noopener';actions.append(link);
    }
    if(oldKey)localStorage.removeItem(legacyKey);
  }
  async function choose(item?:ZoteroItem):Promise<void>{
    const {collections}=await api('zotero.collections',{});
    if(!editor.isConnected || app.doc.id!==doc.id)return;
    const checked=new Set(item?.collections||[]);
    editor.replaceChildren(el('div','section-title',item?'Collections for '+item.title:'Choose collections'));
    if(item)editor.append(button('Link this item',async()=>{
      await api('zotero.link',{docId:doc.id,key:item.key});editor.replaceChildren();found.replaceChildren();await restore();toast('Linked to this paper.');
    },'btn','note'));
    for(const c of collections){const l=el('label','check-row'),box=el('input');box.type='checkbox';box.checked=checked.has(c.key);box.disabled=box.checked || readOnly;
      box.onchange=()=>{if(box.checked)checked.add(c.key);else checked.delete(c.key);};l.append(box,c.name);editor.append(l);}
    if(readOnly){editor.append(el('p','hint','This connection can read and link items. Enable write access to change collections.'));return;}
    if(!collections.length)editor.append(el('p','hint','Saving without a collection adds the item to your library.'));
    const progress=el('p','hint');progress.setAttribute('role','status');
    editor.append(button(item?'Update Zotero item':'Save to Zotero',async()=>{
      progress.textContent=desktop?'Saving… Check Zotero for an approval dialog.':'Saving…';
      try{
        await api('zotero.save',{docId:doc.id,key:item?.key,title,url:doc.url,doi:doc.doi,collections:[...checked]});
        found.replaceChildren();editor.replaceChildren();await restore();await test();toast('Saved to your Zotero library.');
      }catch(error){progress.textContent=message(error);}
    },'btn primary','check'),progress);
  }
  const addItem=button('Add to library',()=>choose(),'btn','plus');
  addItem.disabled=readOnly;
  parent.append(query,button('Find item',async()=>{
    const {items}=await api('zotero.search',{query:query.value});
    found.replaceChildren();if(!items.length)found.append(el('p','hint','No matching items.'));
    for(const item of items)found.append(button(item.title,()=>choose(item),'doc-row','note'));
  },'btn','book'),addItem,found,editor);
  void test().catch(error=>{status.textContent=message(error);});
  void restore().catch(error=>{summary.replaceChildren(el('p','hint',message(error)));});
}
