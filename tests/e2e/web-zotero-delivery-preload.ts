// The fixture tests Zotero's desktop protocol without taking its real port.
const testOrigin = process.env.PAPER_READER_TEST_DESKTOP_ZOTERO;
if (!testOrigin) throw new Error('The disposable Zotero fixture address is missing.');
const local = new URL(testOrigin);
if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1') throw new Error('The fixture must be on loopback.');
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'http://127.0.0.1:23119') return realFetch(input, init);
  return realFetch(new URL(url.pathname + url.search, local), init);
};
