import { lookup } from 'node:dns/promises';
import { get as getHttp, type IncomingMessage, type RequestOptions } from 'node:http';
import { get as getHttps } from 'node:https';
import { BlockList, isIP } from 'node:net';
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

export interface PublicResource { url: URL; bytes: Buffer; type: string; charset?: string }
export async function publicResource(raw: unknown, kind: 'document' | 'image' | 'json'): Promise<PublicResource> {
  let url = checkedUrl(raw);
  const signal = AbortSignal.timeout(35_000);
  for (let hops = 0; hops < 6; hops++) {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const get = url.protocol === 'https:' ? getHttps : getHttp;
      const request = get(url, {
        agent: false, lookup: publicLookup, signal,
        headers: { Accept: kind === 'image' ? 'image/*' : kind === 'json' ? 'application/json' : 'text/html,application/xhtml+xml,application/pdf',
          'Accept-Encoding': 'identity', 'User-Agent': 'DSH-Paper-Reader/0.1 (article reader)' }
      }, resolve);
      request.once('error', () => reject(new Error('The website could not be reached. Open the original webpage and try the browser extension.')));
    });
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
