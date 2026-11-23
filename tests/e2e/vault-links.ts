import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function visibleMarkdown(raw: string): string {
  const visible = raw.replace(/<!--[\s\S]*?-->/gu, '');
  assert.doesNotMatch(visible, /\/api\/paper-reader\/app\/|https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/])/iu);
  return visible;
}

export function markdownLinks(markdown: string) {
  return Array.from(markdown.matchAll(/\[((?:\\.|[^\[\]\\\r\n])+)\]\(<([^>\r\n]+)>\)/gu),
    match => ({ label: match[1].replace(/\\(.)/gu, '$1'), target: match[2] }));
}

export function vaultSource(vault: string, note: string, target: string) {
  assert.doesNotMatch(target, /^(?:[A-Z][A-Z\d+.-]*:|[/\\])|\\/iu, 'The library link must be relative to the note.');
  const url = new URL(target, pathToFileURL(note));
  const file = fileURLToPath(url);
  assert.equal(path.dirname(file), path.join(vault, 'Paper Reader', 'Sources'));
  return { file, fragment: decodeURIComponent(url.hash.slice(1)) };
}
