import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDF_LIMIT } from './library.js';
import { boundedResponseBytes, providerFailure, send, type Fetcher } from './provider-http.js';
import { isObject, ServiceError } from './service-types.js';
import type { ZoteroConnection } from './zotero-connection.js';

function oversized(): never {
  throw new ServiceError(413, 'The Zotero PDF exceeds the 80 MB reader limit.');
}

async function localFile(url: URL): Promise<Buffer | null> {
  // Only Zotero's authenticated-by-instance loopback /file response can identify a local attachment.
  if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return null;
  let filename: string;
  try { filename = fileURLToPath(url); } catch { return null; }
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(filename) || filename.slice(2).includes(':'))) return null;
  const file = await open(filename, 'r').catch(error => {
    if (isObject(error) && ['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code))) return null;
    throw new ServiceError(502, 'Zotero’s attachment could not be opened.');
  });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    if (stat.size > PDF_LIMIT) oversized();
    const header = Buffer.alloc(Math.min(1024, stat.size));
    await file.read(header, 0, header.length, 0);
    if (!header.includes('%PDF-')) return null;
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) throw new ServiceError(409, 'The Zotero PDF changed while opening. Open it again.');
      position += bytesRead;
    }
    return bytes;
  } finally { await file.close(); }
}

function storageUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (['files.zotero.org', 'storage.zotero.org'].includes(url.hostname)) return true;
  // Zotero File Storage uses both virtual-hosted and path-style S3 download URLs.
  const storage = /^(zoterofilestorage\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.exec(url.hostname);
  return Boolean(storage && (storage[1] || url.pathname.startsWith('/zoterofilestorage/')));
}

export async function readZoteroPdf(connection: ZoteroConnection, fetcher: Fetcher, key: string): Promise<Buffer | null> {
  let response = await connection.request('/items/' + key + '/file', { redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    const location = URL.parse(response.headers.get('location') ?? '');
    await response.body?.cancel();
    if (!location) return null;
    if (connection.mode === 'desktop') return localFile(location);
    if (!storageUrl(location)) return null;
    // A signed storage URL is anonymous. The library credential belongs solely to api.zotero.org.
    response = await send(fetcher, location.href, {}, 'Zotero file storage', 45_000);
  }
  if ([400, 401, 403, 404, 410].includes(response.status)) { await response.body?.cancel(); return null; }
  if (!response.ok) throw providerFailure('Zotero file storage', response.status);
  if (Number(response.headers.get('content-length')) > PDF_LIMIT) { await response.body?.cancel(); oversized(); }
  let bytes: Buffer;
  try { bytes = await boundedResponseBytes(response, PDF_LIMIT); }
  catch (error) {
    if (error instanceof Error && error.message === 'Response exceeds size limit.') oversized();
    throw new ServiceError(502, 'The Zotero PDF download was interrupted. Open it again.');
  }
  return bytes.subarray(0, 1024).includes('%PDF-') ? bytes : null;
}
