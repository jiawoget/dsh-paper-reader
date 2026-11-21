import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localModelDirectory, modelFiles, modelRevision } from '../src/server/translation-files.js';

const dir = localModelDirectory();
const source = 'https://huggingface.co/Xenova/opus-mt-en-zh/resolve/' + modelRevision + '/';
const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
for (const file of modelFiles) {
  const destination = path.join(dir, file.name);
  try {
    if (digest(await readFile(destination)) === file.digest) continue;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const response = await fetch(source + file.name, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error('Could not download ' + file.name + ' (HTTP ' + response.status + ').');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== file.bytes || digest(bytes) !== file.digest) throw new Error('Integrity check failed for ' + file.name + '.');
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
console.log('Verified the local OPUS-MT English-to-Chinese model at ' + dir);
