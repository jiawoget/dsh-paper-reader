import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

interface CachedAsset {
  mtimeMs: number;
  size: number;
  bytes: Uint8Array;
  hash: string;
  etag: string;
}

const IMMUTABLE_PREFIXES = ['vendor/', 'app/chunks/', 'app/assets/fonts/', 'app/katex/fonts/'];
const LONG_CACHE_PREFIXES = ['app/assets/', 'app/katex/'];

export function shortDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === '*') return true;
  const normalized = etag.replace(/^W\//, '');
  return trimmed.split(',').some(part => part.trim().replace(/^W\//, '') === normalized);
}

function cacheControlFor(url: string, requestUrl: string, hash: string): string {
  const version = URL.parse(requestUrl)?.searchParams.get('v');
  if (version && version === hash) return 'private, max-age=31536000, immutable';
  if (IMMUTABLE_PREFIXES.some(prefix => url.startsWith(prefix))) return 'private, max-age=31536000, immutable';
  if (LONG_CACHE_PREFIXES.some(prefix => url.startsWith(prefix))) return 'private, max-age=86400';
  return 'private, no-cache';
}

export function createStaticAssetHandler(url: string, file: string, contentType: string): (req: Request) => Promise<Response> {
  let cached: CachedAsset | undefined;
  return async req => {
    const info = await stat(file);
    if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
      const bytes = new Uint8Array(await readFile(file));
      const hash = shortDigest(bytes);
      cached = { mtimeMs: info.mtimeMs, size: info.size, bytes, hash, etag: `"${hash}"` };
    }
    const headers: Record<string, string> = {
      'content-type': contentType,
      'cache-control': cacheControlFor(url, req.url, cached.hash),
      etag: cached.etag,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    };
    if (etagMatches(req.headers.get('if-none-match'), cached.etag)) return new Response(null, { status: 304, headers });
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(cached.bytes), { headers });
  };
}

export function pdfBytesResponse(req: Request, bytes: Buffer): Response {
  const etag = `"${shortDigest(bytes)}"`;
  const headers: Record<string, string> = {
    'content-type': 'application/pdf',
    'cache-control': 'private, no-cache',
    etag,
    'x-content-type-options': 'nosniff'
  };
  if (etagMatches(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  return new Response(req.method === 'HEAD' ? null : new Uint8Array(bytes), { headers });
}
