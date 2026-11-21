import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { ServiceError } from './service-types.js';

export type ObsidianLauncher = (uri: string) => Promise<void>;

export function installedObsidian(): ObsidianLauncher | undefined {
  if (process.platform !== 'win32') return;
  const directories = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,'Programs'), process.env.ProgramFiles];
  const executable = directories.filter((dir): dir is string => Boolean(dir && path.isAbsolute(dir)))
    .map(dir => path.join(dir,'Obsidian','Obsidian.exe')).find(file => {
      try { return statSync(file,{throwIfNoEntry:false})?.isFile(); } catch { return false; }
    });
  if (!executable) return;
  return uri => new Promise<void>((resolve,reject) => {
    // Match the Windows Obsidian protocol registration: Obsidian.exe receives a single URI argument.
    const child=spawn(executable,[uri],{shell:false,detached:true,stdio:'ignore',windowsHide:false});
    child.once('error',()=>reject(new ServiceError(503,'Windows could not start Obsidian. Open the notebook link with the Obsidian app.')));
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
