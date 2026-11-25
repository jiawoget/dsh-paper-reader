import { channel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import http, { type ClientRequest, type RequestOptions } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const output = process.env.PAPER_READER_E2E_PUBLISHER_LOG;
if (!output) throw new Error('The end-to-end publisher log path is missing.');

const tracedHosts = new Set(['openstax.org', 'research.google', 'storage.googleapis.com', 'arxiv.org', 'export.arxiv.org', 'doi.org', 'dx.doi.org', 'api.crossref.org']);
function log(raw: string, method: string, accept: string) {
  const url = URL.parse(raw);
  if (!url || !tracedHosts.has(url.hostname)) return;
  appendFileSync(output!, JSON.stringify({ url: url.href, method, accept }) + '\n');
}

// In the live run these diagnostic events observe requests without replacing transport.
channel('http.client.request.start').subscribe(event => {
  const { request } = event as { request: ClientRequest };
  const original = request.getHeader('x-reader-e2e-original-url');
  const url = original ?? `${request.protocol}//${request.host}${request.path}`;
  log(String(url), request.method, String(request.getHeader('accept') ?? ''));
});
channel('undici:request:create').subscribe(event => {
  const { request } = event as { request: { origin: string; path: string; method: string; headers: string[] | string } };
  const headers = typeof request.headers === 'string' ? request.headers : request.headers.join(':');
  const original = /^x-reader-e2e-original-url:\s*(https?:\/\/[^\r\n]+)$/im.exec(headers)?.[1];
  log(original ?? request.origin + request.path, request.method, /^accept:\s*([^\r\n]+)$/im.exec(headers)?.[1] ?? '');
});

const fixtureOrigin = process.env.PAPER_READER_E2E_PUBLISHER_FIXTURE;
if (fixtureOrigin) {
  const fixture = new URL(fixtureOrigin);
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1') throw new Error('The publisher fixture must stay on loopback.');
  const get = http.get;
  const request = http.request;
  const fixtureTarget = (input: unknown) => {
    const url = input instanceof URL || typeof input === 'string' ? URL.parse(String(input)) : null;
    return url && tracedHosts.has(url.hostname) ? url : null;
  };
  for (const transport of [http, https]) {
    for (const method of ['get', 'request'] as const) {
      const original = transport[method];
      transport[method] = ((input: unknown, ...args: unknown[]) => {
        const target = fixtureTarget(input);
        if (!target) return Reflect.apply(original, transport, [input, ...args]);
        const options = typeof args[0] === 'function' ? {} : { ...(args.shift() as RequestOptions) };
        // The public-resource parser still sees the publisher URL and follows its redirects.
        // Only the disposable fixture socket skips the production public-address DNS lookup.
        delete options.lookup;
        options.headers = { ...options.headers, 'x-reader-e2e-original-url': target.href };
        return Reflect.apply(method === 'get' ? get : request, http, [new URL(target.pathname + target.search, fixture), options, ...args]);
      }) as typeof transport[typeof method];
    }
  }
  syncBuiltinESMExports();
}
