import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ServiceError } from './service-types.js';

export type ObsidianLauncher = (uri: string) => Promise<void>;

const isFile = (file: string) => { try { return Boolean(statSync(file, { throwIfNoEntry: false })?.isFile()); } catch { return false; } };
const isDir = (file: string) => { try { return Boolean(statSync(file, { throwIfNoEntry: false })?.isDirectory()); } catch { return false; } };
const onPath = (name: string) => (process.env.PATH ?? '').split(path.delimiter)
  .filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, name)).find(isFile);

function launch(command: string, args: string[], errorMessage: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => reject(new ServiceError(503, errorMessage)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function installedObsidian(): ObsidianLauncher | undefined {
  if (process.platform === 'win32') {
    const directories = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles];
    const executable = directories.filter((dir): dir is string => Boolean(dir && path.isAbsolute(dir)))
      .map(dir => path.join(dir, 'Obsidian', 'Obsidian.exe')).find(isFile);
    if (!executable) return;
    // Match the Windows Obsidian protocol registration: Obsidian.exe receives a single URI argument.
    return uri => launch(executable, [uri], 'Windows could not start Obsidian. Open the notebook link with the Obsidian app.');
  }
  if (process.platform === 'darwin') {
    if (!['/Applications/Obsidian.app', path.join(homedir(), 'Applications/Obsidian.app')].some(isDir)) return;
    return uri => launch('/usr/bin/open', ['-a', 'Obsidian', uri], 'macOS could not start Obsidian. Open the notebook link with the Obsidian app.');
  }
  if (process.platform === 'linux') {
    const opener = onPath('xdg-open');
    const present = Boolean(onPath('obsidian') || ['/opt/Obsidian/obsidian', '/var/lib/flatpak/exports/bin/md.obsidian.Obsidian',
      path.join(homedir(), '.local/share/flatpak/exports/bin/md.obsidian.Obsidian')].some(isFile));
    if (!opener || !present) return;
    return uri => launch(opener, [uri], 'Could not start Obsidian via xdg-open. Open the notebook link with the Obsidian app.');
  }
  return;
}
