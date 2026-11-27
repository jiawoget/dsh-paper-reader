import { lookup } from 'node:dns/promises';
import { get as getHttp, request as requestHttp, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { get as getHttps, request as requestHttps } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { articleUrl } from '../shared/web-article.js';
import { fail, PDF_LIMIT } from './library.js';

const special = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) special.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const)
  special.addSubnet(address, prefix, 'ipv6');

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !special.check(address, 'ipv4');
  return family === 6 && /^[23]/i.test(address) && !special.check(address, 'ipv6');
}

function checkedUrl(raw: unknown): URL {
  const url = typeof raw === 'string' ? articleUrl(raw) : undefined;
  if (!url) fail('Enter a public HTTP or HTTPS webpage address.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host.includes('.') && !isIP(host) || /(?:^|\.)(localhost|local|internal|home\.arpa)$/.test(host) ||
      (isIP(host) && !publicAddress(host))) fail('Use a public webpage address. For a private page, open it in your browser and use the reader extension.');
  url.hash = '';
  return url;
}

const publicLookup: RequestOptions['lookup'] = (hostname, options, callback) => {
  void lookup(hostname, { all: true, verbatim: true }).then(addresses => {
    if (!addresses.length || addresses.some(({address}) => !publicAddress(address))) throw new Error('This address does not resolve to a public website.');
    // The socket uses this exact answer. A second DNS lookup at connect time could otherwise change the destination.
    const preferred = addresses.find(item => item.family === (options.family || 4)) || addresses[0];
    if (options.all) callback(null, [preferred, ...addresses.filter(item => item !== preferred)]);
    else callback(null, preferred.address, preferred.family);
  }).catch((error: Error) => callback(error, '', 0));
};

const REACH_ERROR = 'The website could not be reached. Open the original webpage and try the browser extension.';
type ProxyTarget = { protocol: 'http:' | 'https:'; host: string; port: number; auth?: string };
type PublicResourceOptions = { lookup?: RequestOptions['lookup']; ca?: string | Buffer; signal?: AbortSignal };

const pickEnv = (env: NodeJS.ProcessEnv, upper: string, lower: string): string => env[upper]?.trim() || env[lower]?.trim() || '';
const decodeCredential = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };

function matchesNoProxy(url: URL, noProxy: string): boolean {
  if (!noProxy) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const raw of noProxy.split(',')) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === '*') return true;
    const bracket = token.startsWith('[') ? /^\[([^\]]+)\](?::(\d+))?$/.exec(token) : null;
    if (token.startsWith('[') && !bracket) continue;
    const colon = !bracket && token.indexOf(':') === token.lastIndexOf(':') ? token.indexOf(':') : -1;
    const entryHost = bracket ? bracket[1] : colon !== -1 ? token.slice(0, colon) : token;
    const entryPort = bracket ? (bracket[2] ?? '') : colon !== -1 ? token.slice(colon + 1) : '';
    if (entryPort && entryPort !== port) continue;
    if (entryHost === '*') return true;
    const pattern = entryHost.replace(/^\.+/, '').replace(/\.$/, '');
    if (pattern && (host === pattern || host.endsWith('.' + pattern))) return true;
  }
  return false;
}

export function resolveProxy(url: URL, env: NodeJS.ProcessEnv = process.env): ProxyTarget | undefined {
  const raw = url.protocol === 'https:' ? pickEnv(env, 'HTTPS_PROXY', 'https_proxy') : pickEnv(env, 'HTTP_PROXY', 'http_proxy');
  if (!raw || matchesNoProxy(url, pickEnv(env, 'NO_PROXY', 'no_proxy'))) return undefined;
  const parsed = URL.parse(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return undefined;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  const auth = parsed.username || parsed.password
    ? 'Basic ' + Buffer.from(`${decodeCredential(parsed.username)}:${decodeCredential(parsed.password)}`).toString('base64')
    : undefined;
  return { protocol: parsed.protocol, host: parsed.hostname.replace(/^\[|\]$/g, ''), port, ...(auth ? { auth } : {}) };
}

function requestViaTunnel(url: URL, proxy: ProxyTarget, headers: Record<string, string>, signal: AbortSignal, ca?: string | Buffer): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error(REACH_ERROR)); return; }
    const targetPort = url.port || '443', authority = `${url.hostname}:${targetPort}`, servername = url.hostname.replace(/^\[|\]$/g, '');
    let settled = false, rawSocket: Duplex | undefined, tlsSocket: TLSSocket | undefined, innerReq: ClientRequest | undefined;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const destroySockets = () => { tlsSocket?.destroy(); rawSocket?.destroy(); };
    const failReach = () => {
      if (settled) return;
      settled = true; cleanup(); destroySockets(); reject(new Error(REACH_ERROR));
    };
    const onAbort = () => { connectReq.destroy(); innerReq?.destroy(); destroySockets(); failReach(); };
    signal.addEventListener('abort', onAbort, { once: true });
    const connectReq = (proxy.protocol === 'https:' ? requestHttps : requestHttp)({
      host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority, agent: false, signal,
      ...(proxy.protocol === 'https:' && ca ? { ca } : {}),
      headers: { host: authority, ...(proxy.auth ? { 'proxy-authorization': proxy.auth } : {}) }
    });
    connectReq.once('error', failReach);
    connectReq.once('connect', (connectRes, socket, head) => {
      rawSocket = socket;
      socket.on('error', () => { socket.destroy(); });
      if (settled || signal.aborted || !connectRes.statusCode || connectRes.statusCode < 200 || connectRes.statusCode >= 300) { failReach(); return; }
      if (head.length) socket.unshift(head);
      innerReq = getHttps({
        host: servername, port: Number(targetPort), path: url.pathname + url.search, signal,
        headers: { ...headers, host: url.host, connection: 'close' },
        createConnection: () => {
          tlsSocket = tlsConnect({ socket, host: servername, ...(isIP(servername) ? {} : { servername }), ...(ca ? { ca } : {}) });
          tlsSocket.once('close', () => { socket.destroy(); cleanup(); });
          return tlsSocket;
        }
      }, res => {
        res.once('close', () => { destroySockets(); cleanup(); });
        if (settled) { res.destroy(); return; }
        settled = true; resolve(res);
      });
      innerReq.once('error', failReach);
    });
    connectReq.end();
  });
}

function openResponse(url: URL, headers: Record<string, string>, signal: AbortSignal, options?: PublicResourceOptions): Promise<IncomingMessage> {
  const proxy = resolveProxy(url);
  if (proxy && url.protocol === 'https:') return requestViaTunnel(url, proxy, headers, signal, options?.ca);
  return new Promise((resolve, reject) => {
    const request = proxy
      ? (proxy.protocol === 'https:' ? getHttps : getHttp)({
          host: proxy.host, port: proxy.port, path: url.href, agent: false, signal,
          ...(proxy.protocol === 'https:' && options?.ca ? { ca: options.ca } : {}),
          headers: { ...headers, host: url.host, ...(proxy.auth ? { 'proxy-authorization': proxy.auth } : {}) }
        }, resolve)
      : (url.protocol === 'https:' ? getHttps : getHttp)(url, {
          agent: false, lookup: options?.lookup ?? publicLookup, signal, headers,
          ...(url.protocol === 'https:' && options?.ca ? { ca: options.ca } : {})
        }, resolve);
    request.once('error', () => reject(new Error(REACH_ERROR)));
  });
}

export interface PublicResource { url: URL; bytes: Buffer; type: string; charset?: string }
export async function publicResource(raw: unknown, kind: 'document' | 'image' | 'json', options?: PublicResourceOptions): Promise<PublicResource> {
  let url = checkedUrl(raw);
  const signal = options?.signal ?? AbortSignal.timeout(35_000);
  const headers = {
    Accept: kind === 'image' ? 'image/*' : kind === 'json' ? 'application/json' : 'text/html,application/xhtml+xml,application/pdf',
    'Accept-Encoding': 'identity', 'User-Agent': 'DSH-Paper-Reader/0.1 (article reader)'
  };
  for (let hops = 0; hops < 6; hops++) {
    const response = await openResponse(url, headers, signal, options);
    const status = response.statusCode || 500;
    if ([301,302,303,307,308].includes(status) && response.headers.location) {
      response.destroy();
      url = checkedUrl(articleUrl(response.headers.location, url.href)?.href);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      fail('The website returned HTTP ' + status + '. Open the original webpage to sign in or use the reader extension.', 502);
    }
    const mime = response.headers['content-type'] || '';
    const type = mime.split(';')[0].trim().toLowerCase();
    const imageType = /^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)$/;
    if (kind === 'json' && type !== 'application/json') {
      response.destroy(); fail('OpenStax did not return book metadata.', 415);
    }
    if (kind === 'image' && !imageType.test(type) || kind === 'document' && !['application/pdf','application/octet-stream','text/html','application/xhtml+xml',''].includes(type)) {
      response.destroy(); fail(kind === 'image' ? 'The website did not return an illustration.' : 'This link does not return an HTML article or PDF.', 415);
    }
    const html = ['text/html', 'application/xhtml+xml'].includes(type);
    const limit = kind === 'json' ? 1024 * 1024 : kind === 'image' ? 12 * 1024 * 1024 : html ? 5 * 1024 * 1024 : PDF_LIMIT;
    if (Number(response.headers['content-length']) > limit) { response.destroy(); fail('This resource is too large to open.', 413); }
    const encoding = response.headers['content-encoding'];
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined;
    if (encoding && encoding !== 'identity' && !decoder) { response.destroy(); fail('The website returned an unsupported transfer encoding.', 415); }
    const source = decoder ? response.pipe(decoder) : response;
    if (decoder) response.on('error', error => decoder.destroy(error));
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of source) {
        length += chunk.length;
        if (length > limit) fail('This resource is too large to open.', 413);
        chunks.push(chunk);
      }
    } finally { response.destroy(); decoder?.destroy(); }
    return { url, type, charset: /charset\s*=\s*["']?([\w-]+)/i.exec(mime)?.[1], bytes: Buffer.concat(chunks, length) };
  }
  fail('This website redirects too many times.', 502);
}
