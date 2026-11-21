import { ReaderStore } from './reader-store.js';
import type { Library } from './library.js';
import { providerFailure, readJson, type Fetcher } from './provider-http.js';
import { readZoteroPdf } from './zotero-attachment.js';
import { ZoteroConnection } from './zotero-connection.js';
import {
  address, isObject, ServiceError, single, stringValue,
  type Input, type PrivateSettings, type ServiceResults, type ZoteroCollection, type ZoteroItem
} from './service-types.js';

const validKey = /^[23456789A-NP-Z]{8}$/;
function keyOf(raw: unknown): string {
  if (typeof raw !== 'string' || !validKey.test(raw)) throw new ServiceError(400, 'Invalid Zotero item or collection key.');
  return raw;
}
function itemTypeError(): never { throw new ServiceError(502, 'Zotero returned an invalid library object.'); }
function text(raw: unknown): string { return typeof raw === 'string' ? raw : ''; }
function doiFor(raw: unknown): string {
  const doi = single(raw, 'DOI', 2048).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
  if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new ServiceError(400, 'Enter a DOI such as 10.1000/example.');
  return doi;
}
interface RemoteItem extends ZoteroItem {
  version: number; filename: string; contentType: string; parentKey: string;
  children?: number; preferredAttachment?: string;
}
function sourceUrl(raw: unknown): string | undefined {
  const url = URL.parse(text(raw));
  if (url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
}
function zoteroWebUrl(links: unknown): string | undefined {
  const alternate = isObject(links) && isObject(links.alternate) && URL.parse(text(links.alternate.href));
  return alternate && alternate.origin === 'https://www.zotero.org' && !alternate.username && !alternate.password ? alternate.href : undefined;
}
function articleFor(item: RemoteItem): string | undefined {
  const source = sourceUrl(item.url);
  if (source) {
    const url = new URL(source);
    const abstract = /^(?:www\.)?arxiv\.org$/i.test(url.hostname) && /^\/abs\/([\w.-]+(?:\/[\w.-]+)?)\/?$/.exec(url.pathname);
    return abstract ? 'https://arxiv.org/pdf/' + abstract[1] : source;
  }
  const doi = item.doi.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return sourceUrl('https://doi.org/' + doi);
}
function pdfItem(item: RemoteItem): boolean {
  return item.type === 'attachment' && (item.contentType.split(';')[0].trim().toLowerCase() === 'application/pdf' || /\.pdf$/i.test(item.filename));
}
function itemFor(raw: unknown): RemoteItem {
  if (!isObject(raw) || typeof raw.key !== 'string' || !validKey.test(raw.key) || !isObject(raw.data)) itemTypeError();
  const data = raw.data;
  const type = text(data.itemType);
  const memberships = data.collections ?? (['note', 'annotation', 'attachment'].includes(type) ? [] : undefined);
  if (!Array.isArray(memberships)) itemTypeError();
  const collections: string[] = [];
  for (const key of memberships) {
    if (typeof key !== 'string' || !validKey.test(key)) itemTypeError();
    collections.push(key);
  }
  const version = raw.version ?? data.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) itemTypeError();
  const links = isObject(raw.links) ? raw.links : {};
  const attachment = isObject(links.attachment) ? URL.parse(text(links.attachment.href)) : null;
  const meta = isObject(raw.meta) ? raw.meta : {};
  return {
    key: raw.key, version, collections, title: text(data.title) || text(data.filename), url: sourceUrl(data.url) ?? '', doi: text(data.DOI),
    type, date: text(data.date), creator: text(meta.creatorSummary), filename: text(data.filename), contentType: text(data.contentType),
    parentKey: text(data.parentItem), children: typeof meta.numChildren === 'number' ? meta.numChildren : undefined,
    preferredAttachment: attachment?.pathname.split('/').pop(),
    webUrl: zoteroWebUrl(links)
  };
}
interface Page { objects: unknown[]; total: number | undefined; more: boolean }
type Save = ServiceResults['zotero.save'];

export class ZoteroLibrary {
  readonly #connection: ZoteroConnection;
  readonly #store: ReaderStore;
  constructor(settings: PrivateSettings, private fetcher: Fetcher, store: ReaderStore) {
    this.#connection = new ZoteroConnection(settings, fetcher, store);
    this.#store = store;
  }
  #request(endpoint: string, init: RequestInit = {}): Promise<Response> {
    return this.#connection.request(endpoint, init);
  }
  status(): Promise<ServiceResults['zotero.status']> { return this.#connection.status(); }
  async #list(endpoint: string, parameters: Record<string, string>): Promise<Page> {
    const response = await this.#request(endpoint + '?' + new URLSearchParams(parameters).toString());
    const data = await readJson(response, 'Zotero');
    if (!Array.isArray(data)) itemTypeError();
    const count = response.headers.get('Total-Results');
    return { objects: data, total: count && /^\d+$/.test(count) ? Number(count) : undefined, more: /rel="next"/i.test(response.headers.get('Link') ?? '') };
  }
  async #namespace(expected?: unknown): Promise<string> {
    const library = await this.#connection.namespace();
    if (expected !== undefined && single(expected, 'Zotero library', 512, true) !== library) {
      throw new ServiceError(409, 'The Zotero library changed. Refresh the library and choose the item again.');
    }
    return library;
  }
  async collections(input: Input): Promise<ServiceResults['zotero.collections']> {
    const library = await this.#namespace(input.library);
    const list = new Map<string, ZoteroCollection>();
    let start = 0;
    for (;;) {
      const page = await this.#list('/collections', { start: String(start), limit: '100' });
      const previousCount = list.size;
      for (const row of page.objects) {
        if (!isObject(row) || typeof row.key !== 'string' || !validKey.test(row.key) || !isObject(row.data) || typeof row.data.name !== 'string') itemTypeError();
        list.set(row.key, { key: row.key, name: row.data.name, parentCollection: text(row.data.parentCollection) || null, webUrl: zoteroWebUrl(row.links) });
      }
      start += page.objects.length;
      const more = page.total === undefined ? page.more || page.objects.length === 100 : start < page.total;
      if (!more) break;
      if (list.size === previousCount) throw new ServiceError(502, 'Zotero collection paging stalled. Refresh the library and try again.');
    }
    return { collections: [...list.values()], library };
  }
  async browse(input: Input): Promise<ServiceResults['zotero.browse']> {
    const library = await this.#namespace(input.library);
    const query = stringValue(input.query, 'query', 2048);
    let start = this.#offset(input.start);
    const collection = input.collection ? '/collections/' + keyOf(input.collection) : '';
    for (;;) {
      const page = await this.#list(collection + '/items/top', {
        start: String(start), limit: '50', q: query, qmode: 'titleCreatorYear', sort: 'dateModified', direction: 'desc', itemType: '-note'
      });
      const items = page.objects.map(itemFor).filter(item => !item.parentKey && item.type !== 'annotation' && item.type !== 'note' &&
        (item.type !== 'attachment' || pdfItem(item) || Boolean(articleFor(item))));
      start += page.objects.length;
      const more = page.objects.length > 0 && (page.more || (page.total === undefined ? page.objects.length === 50 : start < page.total));
      if (items.length || !more) return { library, mode: this.#connection.mode, items, nextStart: more ? start : null };
    }
  }
  #offset(value: unknown): number {
    const start = value ?? 0;
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) throw new ServiceError(400, 'Invalid Zotero search offset.');
    return start;
  }
  async #search(query: string, start: number, limit: number, mode = 'titleCreatorYear'): Promise<ServiceResults['zotero.search']> {
    const page = await this.#list('/items/top', { q: query, qmode: mode, start: String(start), limit: String(limit) });
    const items = page.objects.map(itemFor).filter(row => !['annotation', 'attachment', 'note'].includes(row.type));
    return { items, total: page.total ?? items.length, hasMore: page.more || (page.total !== undefined && start + page.objects.length < page.total) };
  }
  search(input: Input): Promise<ServiceResults['zotero.search']> {
    return this.#search(stringValue(input.query, 'query', 2048), this.#offset(input.start), 50);
  }
  async #getItem(key: string): Promise<RemoteItem | null> {
    const response = await this.#request('/items/' + key);
    if (response.status === 404) return null;
    const item = itemFor(await readJson(response, 'Zotero'));
    if (item.key !== key) itemTypeError();
    return item;
  }
  async #attachments(item: RemoteItem): Promise<RemoteItem[]> {
    if (item.type === 'attachment') return [item];
    if (item.children === 0) return [];
    const attached = new Map<string, RemoteItem>();
    let start = 0;
    for (;;) {
      const page = await this.#list('/items/' + item.key + '/children', { itemType: 'attachment', start: String(start), limit: '100' });
      const previous = attached.size;
      for (const object of page.objects) {
        const file = itemFor(object);
        if (file.type === 'attachment' && (!file.parentKey || file.parentKey === item.key)) attached.set(file.key, file);
      }
      start += page.objects.length;
      if (!(page.more || (page.total === undefined ? page.objects.length === 100 : start < page.total))) break;
      if (attached.size === previous) throw new ServiceError(502, 'Zotero attachment paging stalled. Open the item again.');
    }
    return [...attached.values()].sort((a, b) => Number(b.key === item.preferredAttachment) - Number(a.key === item.preferredAttachment));
  }
  async open(input: Input, documents: Library): Promise<ServiceResults['zotero.open']> {
    const library = await this.#namespace(single(input.library, 'Zotero library', 512, true));
    const key = keyOf(input.key), item = await this.#getItem(key);
    if (!item) throw new ServiceError(404, 'This item was removed from Zotero. Refresh the library.');
    for (const docId of this.#store.documentsForItem(library, key)) {
      try { return { kind: 'document', doc: await documents.get(docId) }; }
      catch (error) { if (!isObject(error) || error.status !== 404) throw error; }
    }
    const attachments = await this.#attachments(item);
    let attachmentError: ServiceError | undefined;
    for (const file of attachments.filter(pdfItem)) {
      let bytes: Buffer | null;
      try { bytes = await readZoteroPdf(this.#connection, this.fetcher, file.key); }
      catch (error) {
        // Public metadata and permission to download the attached file are independent in Zotero.
        if (!(error instanceof ServiceError) || ![403, 413, 502, 504].includes(error.status)) throw error;
        if (error.status !== 403) attachmentError ??= error;
        continue;
      }
      if (bytes) {
        const doc = await documents.importPdf(item.title || file.filename, bytes);
        this.#store.linkDocument(library, doc.id, key);
        return { kind: 'document', doc };
      }
    }
    const url = articleFor(item) || attachments.map(articleFor).find(Boolean);
    if (url) return { kind: 'article', url };
    if (attachmentError) throw attachmentError;
    const zoteroUrl = this.#connection.mode === 'desktop' ? 'zotero://select/library/items/' + key :
      item.webUrl ?? 'https://www.zotero.org' + this.#connection.prefix + '/items/' + key;
    return { kind: 'unavailable', zoteroUrl };
  }
  async get(input: Input): Promise<ServiceResults['zotero.get']> {
    const docId = single(input.docId, 'document ID', 512, true);
    const namespace = await this.#connection.namespace();
    const saved = this.#store.citation(namespace, 'document/' + docId);
    const key = saved ?? (input.key ? keyOf(input.key) : undefined);
    if (!key) return { item: null };
    const item = await this.#getItem(key);
    if (!item) throw new ServiceError(404, 'The linked item was removed from Zotero. Find an item to link again.');
    if (!saved) this.#store.linkDocument(namespace, docId, key);
    return { item };
  }
  async link(input: Input): Promise<ServiceResults['zotero.link']> {
    const docId = single(input.docId, 'document ID', 512, true), key = keyOf(input.key);
    const library = await this.#namespace(input.library);
    const item = await this.#getItem(key);
    if (!item) throw new ServiceError(404, 'This item is no longer in the selected Zotero library.');
    this.#store.linkDocument(library, docId, key);
    return { item };
  }
  async #add(key: string, chosen: string[]): Promise<Save | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = '/items/' + key;
      const item = await this.#getItem(key);
      if (!item) return null;
      const collections = [...new Set([...item.collections, ...chosen])];
      if (collections.length === item.collections.length) return { key, collections, created: false };
      // Zotero replaces array-valued properties. Merge against the exact version we will PATCH.
      const response = await this.#request(url, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Unmodified-Since-Version': String(item.version) },
        body: JSON.stringify({ collections })
      });
      if (response.status === 412) continue;
      if (!response.ok) throw providerFailure('Zotero', response.status);
      return { key, collections, created: false };
    }
    throw new ServiceError(409, 'The Zotero item is being edited elsewhere. Refresh and try again.');
  }
  async #find(title: string, url: string, doi: string): Promise<string | null> {
    const match = (item: ZoteroItem) => {
      if (doi && item.doi) return item.doi.toLowerCase() === doi.toLowerCase();
      if (url && item.url) return item.url === url;
      return !url && !doi && item.title.toLowerCase() === title.toLowerCase();
    };
    const candidates = await this.#search(title, 0, 100);
    const first = candidates.items.find(match);
    if (first || !doi) return first?.key ?? null;
    return (await this.#search(doi, 0, 100, 'everything')).items.find(match)?.key ?? null;
  }
  async save(input: Input): Promise<Save> {
    this.#connection.requireFiling();
    const docId = single(input.docId, 'document ID', 512);
    const saved = await this.#saveItem(input);
    if (docId) this.#store.linkDocument(await this.#connection.namespace(), docId, saved.key);
    return saved;
  }
  async #saveItem(input: Input): Promise<Save> {
    const incoming = input.collections ?? [];
    if (!Array.isArray(incoming) || incoming.length > 500) throw new ServiceError(400, 'Invalid selection of Zotero collections.');
    const collections = [...new Set(incoming.map(keyOf))];
    if (input.key) {
      const existing = await this.#add(keyOf(input.key), collections);
      if (!existing) throw new ServiceError(404, 'This item is no longer in the selected Zotero library.');
      return existing;
    }
    const title = stringValue(input.title, 'paper title', 2048, true);
    const url = address(input.url);
    const doi = doiFor(input.doi || (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(url) ? url : ''));
    const identity = doi ? 'doi/' + doi.toLowerCase() : url ? 'url/' + url : 'title/' + title.toLowerCase();
    const namespace = await this.#connection.namespace();
    const previous = this.#store.citation(namespace, identity);
    const matched = previous ?? await this.#find(title, url, doi);
    // A durable key makes retry safe even if the original POST succeeded just before the connection failed.
    const key = this.#store.citation(namespace, identity, matched);
    if (!key) throw new ServiceError(500, 'Could not reserve a citation record.');
    const existing = await this.#add(key, collections);
    if (existing) return existing;
    const itemType = doi || !url || /\.pdf(?:[?#]|$)/i.test(url) ? 'journalArticle' : 'webpage';
    const data: Input = { key, version: 0, itemType, title, url, creators: [], collections, tags: [], relations: {} };
    if (doi) data.DOI = doi;
    const response = await this.#request('/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([data]) });
    const output = response.status === 412 ? undefined : await readJson(response, 'Zotero');
    const failed = isObject(output) && isObject(output.failed) ? output.failed['0'] : undefined;
    if (response.status === 412 || (isObject(failed) && Number(failed.code) === 412)) {
      const concurrent = await this.#add(key, collections);
      if (concurrent) return concurrent;
      throw providerFailure('Zotero', 412);
    }
    if (isObject(failed)) throw providerFailure('Zotero', typeof failed.code === 'number' ? failed.code : 400);
    if (!isObject(output)) itemTypeError();
    const confirmed = isObject(output.successful) ? output.successful['0'] : undefined;
    const oldResponse = isObject(output.success) ? output.success['0'] : undefined;
    const unchanged = isObject(output.unchanged) ? output.unchanged['0'] : undefined;
    if (!(isObject(confirmed) && confirmed.key === key) && oldResponse !== key && unchanged !== key) {
      throw new ServiceError(502, 'Zotero has not confirmed the save. Retry to check the same item.');
    }
    return { key, collections, created: unchanged !== key };
  }
}
