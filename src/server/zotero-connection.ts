import type { ZoteroStatus } from '../shared/types.js';
import { providerFailure, readJson, send, type Fetcher } from './provider-http.js';
import { ReaderStore } from './reader-store.js';
import { isObject, ServiceError, zoteroModeFor, type PrivateSettings } from './service-types.js';

const desktopApi = 'http://127.0.0.1:23119/api';
const webApi = 'https://api.zotero.org';

export class ZoteroConnection {
  readonly mode: 'web' | 'desktop';
  readonly prefix: string;
  private instance?: Promise<string>;
  constructor(private settings: PrivateSettings, private fetcher: Fetcher, private store: ReaderStore) {
    this.mode = zoteroModeFor(settings);
    this.prefix = this.mode === 'desktop' ? '/users/0'
      : '/' + (settings.zoteroLibraryType === 'group' ? 'groups' : 'users') + '/' + settings.zoteroLibraryId;
  }
  private async identify(): Promise<string> {
    let response: Response;
    try { response = await send(this.fetcher, desktopApi + '/', {}, 'Zotero desktop', 4000); }
    catch { throw new ServiceError(503, 'Open Zotero on this computer, then test the connection again.'); }
    if (response.status === 403) throw new ServiceError(403, 'In Zotero, open Settings → Advanced and enable “Allow other applications on this computer to communicate with Zotero”.');
    if (!response.ok || response.headers.get('Zotero-API-Version') !== '3') throw new ServiceError(503, 'Enable the local API in Zotero Settings → Advanced, then test again.');
    return response.headers.get('Zotero-Server-ID') ?? '';
  }
  private serverId(): Promise<string> { return this.instance ??= this.identify(); }
  requireFiling(): void {
    if (this.mode === 'web' && !this.settings.zoteroApiKey) throw new ServiceError(403, 'Add a Zotero API key with write access in Connection settings to file items.');
  }
  async namespace(): Promise<string> {
    return this.mode === 'web' ? this.prefix : 'desktop/' + (await this.serverId() || 'legacy') + this.prefix;
  }
  private async authorize(serverId: string, headers: Headers): Promise<string> {
    const authHeaders = new Headers(headers);
    authHeaders.delete('Zotero-API-Key');
    authHeaders.delete('If-Unmodified-Since-Version');
    authHeaders.set('Content-Type', 'application/json');
    const response = await send(this.fetcher, desktopApi + '/local/authorize', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ appName: 'Paper Reader' })
    }, 'Zotero desktop approval', 120_000);
    if (response.status === 403) throw new ServiceError(403, 'Zotero declined the change. Choose Save again when you are ready to allow it.');
    const permission = await readJson(response, 'Zotero desktop');
    if (!isObject(permission) || typeof permission.key !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(permission.key)) throw new ServiceError(502, 'Zotero did not return a local authorization.');
    if (permission.remember === true) this.store.zoteroAuthorization(serverId, permission.key);
    return permission.key;
  }
  async request(endpoint: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Zotero-API-Version', '3');
    if (this.mode === 'web') {
      if (!this.settings.zoteroLibraryId) throw new ServiceError(503, 'Enter a Zotero library ID in Connections or choose the desktop app.');
      if (init.method && init.method !== 'GET' && init.method !== 'HEAD') this.requireFiling();
      if (this.settings.zoteroApiKey) headers.set('Zotero-API-Key', this.settings.zoteroApiKey);
      const response = await send(this.fetcher, webApi + this.prefix + endpoint, { ...init, headers }, 'Zotero', 25_000);
      if (!this.settings.zoteroApiKey && [401,403].includes(response.status)) throw new ServiceError(403, 'This library requires a Zotero API key with reading permission. Add it in Connection settings.');
      return response;
    }
    const serverId = await this.serverId();
    if (serverId) headers.set('Zotero-Server-ID', serverId);
    const write = Boolean(init.method && init.method !== 'GET' && init.method !== 'HEAD');
    const issue = () => send(this.fetcher, desktopApi + this.prefix + endpoint, { ...init, headers }, 'Zotero desktop', 25_000);
    let remembered = '';
    if (write) {
      if (!serverId) throw new ServiceError(403, 'This version of Zotero supports reading and linking. Use Zotero 10 or a web library connection to file items.');
      remembered = this.store.zoteroAuthorization(serverId);
      headers.set('Zotero-API-Key', remembered || await this.authorize(serverId, headers));
    }
    let response = await issue();
    if (write && remembered && response.status === 401) {
      this.store.zoteroAuthorization(serverId, '');
      headers.set('Zotero-API-Key', await this.authorize(serverId, headers));
      response = await issue();
    }
    if (response.status === 412 && response.headers.get('Zotero-Server-ID') !== serverId) {
      throw new ServiceError(409, 'The open Zotero library changed. Test the connection and find the item again.');
    }
    return response;
  }
  async status(): Promise<ZoteroStatus> {
    const mode = this.mode;
    try {
      const response = await this.request('/items/top?limit=1');
      const list = await readJson(response, mode === 'desktop' ? 'Zotero desktop' : 'Zotero');
      if (!Array.isArray(list)) throw new ServiceError(502, 'Zotero returned an invalid library response.');
      if (mode === 'desktop') {
        const id = await this.serverId();
        const access = id ? this.store.zoteroAuthorization(id) ? 'write' : 'confirm' : 'read';
        const detail = access === 'write' ? 'Desktop library connected · filing authorized' : access === 'confirm'
          ? 'Desktop library connected · confirm changes in Zotero' : 'Desktop library connected · read and link items';
        return { mode, connected: true, access, detail };
      }
      if (!this.settings.zoteroApiKey) return { mode, connected: true, access: 'read', detail: 'Public web library connected · read and link items' };
      const permissions = await this.webAccess();
      return { mode, connected: true, access: permissions, detail: permissions === 'write' ? 'Web library connected · read and write'
        : permissions === 'read' ? 'Web library connected · read only' : 'Web library connected · filing permission checked on save' };
    } catch (error) { return { mode, connected: false, access: 'none', detail: error instanceof Error ? error.message : 'Could not connect to Zotero.' }; }
  }
  private async webAccess(): Promise<'read' | 'write' | 'unknown'> {
    try {
      const headers = { 'Zotero-API-Version': '3', 'Zotero-API-Key': this.settings.zoteroApiKey };
      const response = await send(this.fetcher, webApi + '/keys/current', { headers }, 'Zotero', 8000);
      if (!response.ok) throw providerFailure('Zotero', response.status);
      const key = await readJson(response, 'Zotero');
      if (!isObject(key) || !isObject(key.access)) return 'unknown';
      const groups = key.access.groups;
      const access = this.settings.zoteroLibraryType === 'user' ? key.userID && String(key.userID) !== this.settings.zoteroLibraryId ? undefined : key.access.user
        : isObject(groups) ? groups[this.settings.zoteroLibraryId] ?? groups.all : undefined;
      return isObject(access) && access.write === true ? 'write' : 'read';
    } catch { return 'unknown'; }
  }
}
