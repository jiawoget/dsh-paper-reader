import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Library, PDF_LIMIT, fail, isRecord } from './library.js';
import { openWebArticle } from './web-article.js';
import { publicResource } from './public-resource.js';
import { createServices } from './services.js';
import { onLoopback } from './service-types.js';

type Method = 'GET'|'HEAD'|'POST';
interface HostRoute { path:string; methods:Method[]; requestBody:'buffered'|'streaming'; fetch(request:Request):Promise<Response> }
interface WebListener { getOrigin(): string }
interface ReaderHost {
  connection:{ fetch:{register(route:HostRoute):unknown} };
  inject(services: ['llm'], setup: (child: { llm: unknown }) => () => void): unknown;
  inject(services: ['sessionController'], setup: (child: { sessionController: unknown }) => () => void): unknown;
  inject(services: ['agentDefaultModel'], setup: (child: { agentDefaultModel: unknown }) => () => void): unknown;
  inject(services: ['attachments'], setup: (child: { attachments: unknown }) => () => void): unknown;
  inject(services: ['webServer'], setup: (child: { webServer: WebListener }) => () => void): unknown;
}
export const name = 'paper-reader';
export const inject = ['connection'];
const publicDir = fileURLToPath(new URL('../web/', import.meta.url));
const pdfDir = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const mimeTypes: Record<string,string> = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.pdf':'application/pdf', '.png':'image/png','.json':'application/json','.txt':'text/plain; charset=utf-8',
  '.svg':'image/svg+xml','.wasm':'application/wasm','.bcmap':'application/octet-stream','.ttf':'font/ttf','.otf':'font/otf','.woff2':'font/woff2','.pfb':'application/octet-stream','.icc':'application/vnd.iccprofile' };
const json = (value:unknown, status=200) => Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function localDesktopRequest(req:Request,listener:WebListener|undefined):boolean {
  // DSH's HTTP bridge uses dsh.internal for Request.url. Its authenticated
  // browser carrier forwards Host and Origin and exposes the real bound listener.
  if(!listener)return false;
  const browser=URL.parse(req.headers.get('origin') || '');
  const host=req.headers.get('host');
  if(!browser || !host || !['http:','https:'].includes(browser.protocol) || !onLoopback(browser))return false;
  const authority=URL.parse(browser.protocol+'//'+host);
  try{
    const bound=new URL(listener.getOrigin());
    return onLoopback(bound) && browser.protocol===bound.protocol && browser.port===bound.port && browser.host===authority?.host;
  }catch{return false;}
}
async function boundedBody(request:Request, limit:number):Promise<Buffer> {
  if (Number(request.headers.get('content-length'))>limit) fail('The file exceeds the size limit.',413);
  const reader = request.body?.getReader();
  if (!reader) fail('The request body is empty.');
  const chunks:Uint8Array[]=[]; let bytes=0;
  try {
    for (;;) {
      const next=await reader.read();
      if (next.done) break;
      bytes+=next.value.byteLength;
      if (bytes>limit) { await reader.cancel(); fail('The file exceeds the size limit.',413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks,bytes);
}

export function apply(ctx:ReaderHost):void {
  const root = process.env.PAPER_READER_HOME || path.join(process.env.DSH_HOME || path.join(os.homedir(),'.dsh'),'paper-reader');
  const library = new Library(root);
  const models: {llm?: unknown; attachments?: unknown; sessionController?: unknown; agentDefaultModel?: unknown} = {};
  let listener:WebListener|undefined;
  ctx.inject(['webServer'],child=>{
    const current=child.webServer;listener=current;
    return ()=>{if(listener===current)listener=undefined;};
  });
  ctx.inject(['llm'], child => {
    const provider = child.llm;
    models.llm = provider;
    return () => { if (models.llm === provider) delete models.llm; };
  });
  ctx.inject(['sessionController'], child => {
    const controller = models.sessionController = child.sessionController;
    return () => { if (models.sessionController === controller) delete models.sessionController; };
  });
  ctx.inject(['agentDefaultModel'], child => {
    const defaults = models.agentDefaultModel = child.agentDefaultModel;
    return () => { if (models.agentDefaultModel === defaults) delete models.agentDefaultModel; };
  });
  ctx.inject(['attachments'], child => {
    const store = child.attachments;
    models.attachments = store;
    return () => { if (models.attachments === store) delete models.attachments; };
  });
  const service = createServices({root,ctx:models});
  const route=(suffix:string,methods:Method[],fetch:HostRoute['fetch'],requestBody:HostRoute['requestBody']='buffered') => ctx.connection.fetch.register({
    path:'/api/paper-reader/'+suffix,methods,requestBody,
    async fetch(request) {
      try { return await fetch(request); }
      catch (error:unknown) {
        const status=isRecord(error) && typeof error.status==='number' && error.status>=400 && error.status<=599 ? error.status:400;
        const message=error instanceof SyntaxError?'Invalid request format.':error instanceof Error?error.message:'The request failed.';
        return json({error:message}, status);
      }
    }
  });
  const asset=(url:string,file:string) => route(url,['GET','HEAD'],async req => new Response(req.method==='HEAD'?null:new Uint8Array(await readFile(file)),{
    headers:{'content-type':mimeTypes[path.extname(file)] ?? 'application/octet-stream','cache-control':url.startsWith('vendor/')?'private, max-age=86400':'private, no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'} }));
  function assets(url:string,dir:string):void {
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isDirectory()) assets(url+entry.name+'/',file);
      else if(entry.isFile() && Object.hasOwn(mimeTypes,path.extname(entry.name))) asset(url+entry.name,file);
    }
  }
  assets('app/',publicDir);
  for(const file of ['pdf.mjs','pdf.worker.mjs','pdf.renderer.mjs']) asset('vendor/'+file,path.join(pdfDir,'build',file));
  for(const dir of ['cmaps','standard_fonts','wasm','iccs']) assets('vendor/'+dir+'/',path.join(pdfDir,dir));
  route('pdf',['GET'],async req => new Response(new Uint8Array(await library.bytes(new URL(req.url).searchParams.get('id'))),{headers:{'content-type':'application/pdf','cache-control':'private, no-cache'}}));
  route('article-image',['GET'],async req => {
    const params = new URL(req.url).searchParams;
    const page = params.get('page');
    const resource = await library.articleImage(params.get('doc'), params.get('anchor'), url => publicResource(url, 'image'), page === null ? undefined : Number(page));
    return new Response(new Uint8Array(resource.bytes), { headers: {
      'content-type': resource.type, 'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'"
    } });
  });
  route('import-pdf',['POST'],async req => {
    if(req.headers.get('content-type')?.split(';')[0]!=='application/pdf') fail('Choose a PDF file.',415);
    return json({doc:await library.importPdf(new URL(req.url).searchParams.get('title') || 'Document.pdf',await boundedBody(req,PDF_LIMIT))});
  },'streaming');
  route('action',['POST'],async req => {
    if(req.headers.get('content-type')?.split(';')[0]!=='application/json') fail('A JSON request is required.',415);
    const body:unknown=JSON.parse((await boundedBody(req,5*1024*1024)).toString('utf8'));
    if(!isRecord(body)||typeof body.op!=='string') fail('The operation name is missing.');
    const input=body.payload ?? {};
    if(!isRecord(input)) fail('Invalid operation parameters.');
    switch(body.op){
      case 'notebook.get':
      case 'notebook.write': {
        const book=await service(body.op,input);
        return json({...book,desktopOpenAvailable:book.desktopOpenAvailable && localDesktopRequest(req,listener)});
      }
      case 'notebook.open': {
        if(!localDesktopRequest(req,listener))fail('Use the notebook link to open Obsidian on this device.',403);
        return json(await service(body.op,input));
      }
      case 'library.list': return json({docs:await library.list()});
      case 'library.get': return json({doc:await library.get(input.id)});
      case 'web.import': return json(await library.importWebDocument(input));
      case 'web.open': return json(await openWebArticle(library, input.url));
      case 'book.section': return json({doc:await library.bookSection(input.docId,input.page)});
      case 'translation.get': return json({translations:await library.translations(input.docId,input.page)});
      case 'translation.page': return json({translations:await library.translate(input.docId,input.page,input.blocks,async (blocks,documentKind)=>{
        const result:unknown=await service('ai.blocks',{blocks,documentKind});
        if(!isRecord(result)||!isRecord(result.translations)||!Object.values(result.translations).every(v=>typeof v==='string')) fail('The model returned an invalid translation.',502);
        return result.translations as Record<string,string>;
      })});
      default: return json(await service(body.op,input));
    }
  },'streaming');
}
