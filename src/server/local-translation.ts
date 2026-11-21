import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObject, ServiceError } from './service-types.js';
import { localModelDirectory, modelFiles } from './translation-files.js';

interface Block { id: string; text: string }
const inSourceTree = import.meta.url.endsWith('.ts');
const worker = fileURLToPath(new URL(inSourceTree ? './local-translation-worker.ts' : './local-translation-worker.js', import.meta.url));
let lastJob: Promise<void> = Promise.resolve();

export function localTranslationAvailable(directory = localModelDirectory()): boolean {
  try {
    if (!existsSync(worker)) return false;
    if (process.platform === 'win32') {
      const env = workerEnvironment();
      const locations = [path.dirname(process.execPath), path.join(env.SystemRoot ?? '', 'System32'), ...(env.PATH ?? '').split(path.delimiter)];
      if (!locations.some(dir => path.isAbsolute(dir) && existsSync(path.join(dir, 'msvcp140.dll')))) return false;
    }
    return modelFiles.every(file => statSync(path.join(directory, file.name)).size === file.bytes);
  } catch { return false; }
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'windir', 'SystemDrive', 'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'LANG', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (process.platform === 'win32') {
    const installed = path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'libheif', 'libheif', 'bin');
    for (const directory of [process.env.PAPER_READER_MT_RUNTIME_DIR, installed]) {
      if (directory && path.isAbsolute(directory) && existsSync(path.join(directory, 'msvcp140.dll'))) {
        environment.PATH = (environment.PATH ?? '') + path.delimiter + directory;
        break;
      }
    }
  }
  return environment;
}

async function execute(blocks: readonly Block[], directory: string): Promise<Record<string,string>> {
  const args = inSourceTree ? ['--import', import.meta.resolve('tsx'), worker] : [worker];
  return new Promise((resolve, reject) => {
    const processResult = execFile(process.execPath, args, {
      env: workerEnvironment(), windowsHide: true, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      if (error) return reject(new ServiceError(503, 'The local translation worker stopped. Check the native CPU runtime or retry with a shorter page.'));
      let result: unknown;
      try { result = JSON.parse(stdout); } catch { /* Report an invalid worker response below. */ }
      if (isObject(result) && result.failure === 'load') return reject(new ServiceError(503, 'The local translation model could not load. Verify the installed weights and CPU runtime.'));
      if (!isObject(result) || !isObject(result.translations)) return reject(new ServiceError(502, 'The local model could not translate this page. Retry the translation.'));
      const translations: Record<string,string> = {};
      for (const { id } of blocks) {
        const text = result.translations[id];
        if (typeof text !== 'string' || !text.trim()) return reject(new ServiceError(502, 'The local model did not return every passage.'));
        translations[id] = text;
      }
      resolve(translations);
    });
    processResult.stdin?.on('error', () => { /* execFile handles early worker exit. */ });
    processResult.stdin?.end(JSON.stringify({ directory, blocks }));
  });
}

export async function translateLocally(blocks: readonly Block[], directory = localModelDirectory()): Promise<Record<string,string>> {
  if (!localTranslationAvailable(directory)) throw new ServiceError(503, 'The local English-to-Chinese model is unavailable. Install it with npm run install:translation-model.');
  const job = lastJob.then(() => execute(blocks, directory));
  lastJob = job.then(() => undefined, () => undefined);
  return job;
}
