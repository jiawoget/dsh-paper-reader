import { ServiceError, isObject } from './service-types.js';

export type Fetcher = typeof globalThis.fetch;
export async function send(fetcher: Fetcher, url: string, init: RequestInit, name: string, timeout: number): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: init.redirect === 'manual' ? 'manual' : 'error', signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    if (isObject(error) && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ServiceError(504, name + ' timed out. Try again shortly.');
    }
    throw new ServiceError(502, 'Could not connect to ' + name + '. Check your connection and service address.');
  }
}
export function providerFailure(name: string, status: number): ServiceError {
  if (status === 401 || status === 403) return new ServiceError(403, name + ' denied access. Check the API key and its permissions.');
  if (status === 429) return new ServiceError(429, name + ' rate-limited the request. Try again shortly.');
  if (status === 409 || status === 412) return new ServiceError(409, name + ' changed while saving. Refresh and try again.');
  return new ServiceError(502, name + ' request failed (HTTP ' + status + ').');
}
export async function boundedResponseBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Error('Response exceeds size limit.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export async function boundedResponseText(response: Response, limit: number): Promise<string> {
  return (await boundedResponseBytes(response, limit)).toString('utf8');
}
export async function readJson(response: Response, name: string, limit = 8 * 1024 * 1024): Promise<unknown> {
  if (!response.ok) throw providerFailure(name, response.status);
  try {
    return JSON.parse(await boundedResponseText(response, limit));
  } catch {
    throw new ServiceError(502, name + ' returned unreadable or oversized data.');
  }
}
