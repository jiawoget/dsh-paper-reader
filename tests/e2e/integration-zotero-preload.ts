// Loaded only in the isolated integration-test host. The product keeps the official Zotero origin.
const fixture = process.env.READER_TEST_ZOTERO_ORIGIN;
if (!fixture) throw new Error('Set the isolated Zotero fixture origin before loading its test route.');
const local = new URL(fixture);
if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1') throw new Error('The Zotero fixture must be bound to loopback.');
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'https://api.zotero.org') return realFetch(input, init);
  return realFetch(new URL(url.pathname + url.search, local), init);
};
