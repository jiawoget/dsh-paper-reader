import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type RequestOptions } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publicResource, resolveProxy } from '../src/server/public-resource.js';

const PROXY_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;

async function withProxyEnv(overrides: Partial<Record<(typeof PROXY_KEYS)[number], string>>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>(PROXY_KEYS.map(k => [k, process.env[k]]));
  for (const k of PROXY_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) process.env[k] = v;
  try { await fn(); } finally {
    for (const k of PROXY_KEYS) {
      const prev = saved.get(k);
      if (prev === undefined) delete process.env[k]; else process.env[k] = prev;
    }
  }
}

async function createSelfSignedCert(): Promise<{ key: Buffer; cert: Buffer }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-proxy-cert-'));
  try {
    const keyPath = path.join(dir, 'key.pem'), certPath = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=article.example', '-addext', 'subjectAltName=DNS:article.example,DNS:redirect.example'
    ], { stdio: 'ignore' });
    return { key: await readFile(keyPath), cert: await readFile(certPath) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const localLookup: RequestOptions['lookup'] = (_host, options, cb) => {
  if (options.all) cb(null, [{ address: '127.0.0.1', family: 4 }]); else cb(null, '127.0.0.1', 4);
};

test('resolveProxy honors HTTP_PROXY, HTTPS_PROXY, credentials, scheme-less URLs, and NO_PROXY rules', () => {
  assert.deepEqual(resolveProxy(new URL('https://arxiv.org/html/1'), { https_proxy: 'proxy.corp:911' }), { protocol: 'http:', host: 'proxy.corp', port: 911 });
  assert.equal(resolveProxy(new URL('http://arxiv.org/'), { HTTPS_PROXY: 'http://proxy.corp:911' }), undefined);
  assert.equal(resolveProxy(new URL('https://arxiv.org/'), { HTTP_PROXY: 'http://proxy.corp:911' }), undefined);
  assert.equal(resolveProxy(new URL('https://arxiv.org/'), { HTTPS_PROXY: 'socks5://proxy.corp:1080' }), undefined);
  assert.deepEqual(
    resolveProxy(new URL('http://article.example/doc'), { HTTP_PROXY: 'http://alice%40lab:p%3Ass@proxy.corp:8080' }),
    { protocol: 'http:', host: 'proxy.corp', port: 8080, auth: 'Basic ' + Buffer.from('alice@lab:p:ss').toString('base64') }
  );
  const env = { HTTP_PROXY: 'http://proxy.corp:80', HTTPS_PROXY: 'https://proxy.corp' };
  for (const [target, noProxy] of [
    ['https://arxiv.org/', '*'], ['https://article.example/', 'ARTICLE.EXAMPLE'], ['https://sub.article.example/', 'article.example'],
    ['https://sub.article.example/', '.article.example'], ['https://article.example/', '.article.example'],
    ['https://article.example/', 'article.example:443'], ['http://article.example/', 'article.example:80'], ['https://article.example:8443/', 'article.example:8443']
  ]) assert.equal(resolveProxy(new URL(target), { ...env, NO_PROXY: noProxy }), undefined, `${target} / ${noProxy}`);
  assert.ok(resolveProxy(new URL('https://evil-article.example/'), { ...env, NO_PROXY: '.article.example' }));
  assert.ok(resolveProxy(new URL('http://article.example/'), { ...env, NO_PROXY: 'article.example:443' }));
  assert.equal(resolveProxy(new URL('https://article.example/'), env)?.port, 443);
});

test('publicResource supports direct fetch, NO_PROXY bypass, HTTP_PROXY, HTTPS_PROXY CONNECT tunnel, redirects, abort cleanup, and SSRF protection', async t => {
  const tlsCreds = await createSelfSignedCert();
  const directServer = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<article>direct:${req.url}</article>`);
  });
  const httpsServer = createHttpsServer(tlsCreds, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://redirect.example/landed' }).end(); return; }
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<p>partial'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<article>tls:${req.headers.host}${req.url}</article>`);
  });
  const httpReqs: { url?: string; auth?: string }[] = [], connectReqs: { target?: string; auth?: string }[] = [];
  let openTunnels = 0;
  const proxyServer = createHttpServer((req, res) => {
    httpReqs.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    if (req.url === 'http://article.example/start') { res.writeHead(302, { location: '/final' }).end(); return; }
    if (req.url === 'http://article.example/evil-redirect') { res.writeHead(302, { location: `http://127.0.0.1:${directPort}/secret` }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<article>proxied:${req.url}</article>`);
  });
  proxyServer.on('connect', (req, clientSocket, head) => {
    connectReqs.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    if (req.url === 'deny.example:443') { clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); clientSocket.end(); return; }
    openTunnels++;
    const upstream = netConnect(httpsPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket); clientSocket.pipe(upstream);
    });
    const closeBoth = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.once('close', () => clientSocket.resume());
    clientSocket.once('close', () => { openTunnels--; upstream.destroy(); });
    upstream.once('error', closeBoth); clientSocket.once('error', closeBoth);
  });
  await Promise.all([directServer, httpsServer, proxyServer].map(s => new Promise<void>(r => s.listen(0, '127.0.0.1', r))));
  const directPort = (directServer.address() as AddressInfo).port;
  const httpsPort = (httpsServer.address() as AddressInfo).port;
  const proxyPort = (proxyServer.address() as AddressInfo).port;
  t.after(() => { for (const s of [directServer, httpsServer, proxyServer]) { s.close(); s.closeAllConnections(); } });

  await withProxyEnv({}, async () => {
    const res = await publicResource(`http://article.example:${directPort}/plain`, 'document', { lookup: localLookup });
    assert.equal(res.bytes.toString('utf8'), '<article>direct:/plain</article>');
  });
  for (const noProxy of ['*', 'article.example', '.article.example', `article.example:${directPort}`]) {
    httpReqs.length = 0;
    await withProxyEnv({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: noProxy }, async () => {
      const res = await publicResource(`http://article.example:${directPort}/bypass`, 'document', { lookup: localLookup });
      assert.equal(res.bytes.toString('utf8'), '<article>direct:/bypass</article>');
      assert.equal(httpReqs.length, 0);
    });
  }
  httpReqs.length = 0;
  await withProxyEnv({ HTTP_PROXY: `http://alice%40lab:s%3Aecret@127.0.0.1:${proxyPort}` }, async () => {
    const res = await publicResource('http://article.example/start', 'document');
    assert.equal(res.url.href, 'http://article.example/final');
    assert.equal(res.bytes.toString('utf8'), '<article>proxied:http://article.example/final</article>');
    assert.deepEqual(httpReqs.map(r => r.url), ['http://article.example/start', 'http://article.example/final']);
    assert.equal(httpReqs[0].auth, 'Basic ' + Buffer.from('alice@lab:s:ecret').toString('base64'));
  });
  connectReqs.length = 0;
  await withProxyEnv({ HTTPS_PROXY: `http://bob:pw@127.0.0.1:${proxyPort}` }, async () => {
    const res = await publicResource('https://article.example/redirect', 'document', { ca: tlsCreds.cert });
    assert.equal(res.url.href, 'https://redirect.example/landed');
    assert.equal(res.bytes.toString('utf8'), '<article>tls:redirect.example/landed</article>');
    assert.deepEqual(connectReqs.map(r => r.target), ['article.example:443', 'redirect.example:443']);
    assert.equal(connectReqs[0].auth, 'Basic ' + Buffer.from('bob:pw').toString('base64'));
    await assert.rejects(publicResource('https://deny.example/doc', 'document', { ca: tlsCreds.cert }), /could not be reached/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(publicResource('https://article.example/slow', 'document', { ca: tlsCreds.cert, signal: controller.signal }));
    for (let i = 0; i < 25 && openTunnels > 0; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(openTunnels, 0);
  });
  httpReqs.length = 0; connectReqs.length = 0;
  await withProxyEnv({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }, async () => {
    for (const blocked of [`http://127.0.0.1:${directPort}/`, 'https://localhost/secret', 'http://10.0.0.1/meta', 'http://foo.local/admin', 'http://[::1]/']) {
      await assert.rejects(publicResource(blocked, 'document'), /public/);
    }
    assert.equal(httpReqs.length, 0); assert.equal(connectReqs.length, 0);
    await assert.rejects(publicResource('http://article.example/evil-redirect', 'document'), /public/);
    assert.equal(httpReqs.length, 1);
  });
});
