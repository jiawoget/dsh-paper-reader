// The body and backlink are ordinary Markdown. The three HTML comments identify
// their boundaries without making headings, blank lines or lists structural.
export interface Block { id: string; start: number; end: number; bodyStart: number; bodyEnd: number; reference: string }
export function chapterPassageLabel(section: string, label: string): string {
  if (!label || label === section) return section;
  return label.startsWith(section + ' · ') ? label : section + ' · ' + label;
}
export function escapedComments(text: string): string { return text.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;'); }
export function markdownHeading(text: string): string {
  return escapedComments(text.replace(/\s+/g, ' ')).replace(/([\\#*_\[\]<>])/g, '\\$1');
}
const marker = /^<!-- paper-reader:(note|source|end) ([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}) -->\r?$/gm;
const markerError = () => new Error('A note marker is incomplete or repeated. Restore its matching note, source and end comments in the Markdown file.');

export function notebookBlocks(markdown: string): Block[] {
  const matches = [...markdown.matchAll(marker)];
  const seen = new Set<string>();
  const result: Block[] = [];
  for (let i = 0; i < matches.length; i += 3) {
    const [open, source, end] = matches.slice(i, i + 3);
    if (!end || open[1] !== 'note' || source[1] !== 'source' || end[1] !== 'end' ||
        open[2] !== source[2] || open[2] !== end[2] || seen.has(open[2])) throw markerError();
    seen.add(open[2]);
    const afterOpen = open.index + open[0].length;
    const bodyStart = afterOpen + (markdown.slice(afterOpen, source.index).match(/^\n(?:\r?\n)?/)?.[0].length ?? 0);
    const bodyEnd = source.index - (markdown.slice(bodyStart, source.index).match(/(?:\r?\n){1,2}$/)?.[0].length ?? 0);
    result.push({ id: open[2], start: open.index, end: end.index + end[0].length,
      bodyStart, bodyEnd, reference: markdown.slice(source.index + source[0].length, end.index).trim() });
  }
  return result;
}
