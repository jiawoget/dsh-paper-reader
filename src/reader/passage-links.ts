interface PassageDefinition { id: string; url: URL; from: number; to: number }
export interface PassageLink { label: string; url: URL; from: number; to: number; replyId?: string }

export function passageLabel(location: number | string, selection: string): string {
  const clean = selection.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(clean);
  const limit = /\p{Script=Han}/u.test(clean) ? 16 : 32;
  let excerpt = characters.slice(0, limit).join('');
  if (characters.length > limit) {
    const space = excerpt.lastIndexOf(' ');
    if (space > limit * .65) excerpt = excerpt.slice(0, space);
    excerpt = excerpt.trimEnd() + '…';
  }
  return (typeof location === 'number' ? 'p. ' + location : location) + (excerpt ? ' · ' + excerpt : '');
}

export function markdownPassageLabel(location: number | string, selection: string): string {
  return passageLabel(location, selection).replace(/[\\\[\]|]/gu, '\\$&');
}

export function discussionId(url: URL, parameter: 'discussion' | 'reply' = 'discussion'): string | undefined {
  const id = url.searchParams.get(parameter) ?? '';
  return /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(id) ? id : undefined;
}

function passageDestination(value: string): URL | undefined {
  const url = URL.parse(value);
  if (url && ['http:', 'https:'].includes(url.protocol) && url.pathname === '/api/paper-reader/app/index.html' &&
      url.searchParams.get('doc') && (discussionId(url) ||
        /^[1-9]\d*$/u.test(url.searchParams.get('page') ?? '') && url.searchParams.get('anchor'))) return url;
}

export function passageDefinitions(markdown: string): PassageDefinition[] {
  const matches = markdown.matchAll(/^\[(p\d+-[\da-f]{8})\]:[ \t]+(?:<([^>\r\n]+)>|(https?:\/\/\S+))[ \t]*(?:\r?\n|$)/gimu);
  const definitions: PassageDefinition[] = [];
  for (const match of matches) {
    const url = passageDestination(match[2] ?? match[3]);
    if (url) definitions.push({ id: match[1], url, from: match.index, to: match.index + match[0].length });
  }
  return definitions;
}

export function notebookBodyEnd(markdown: string, definitions: PassageDefinition[]): number {
  let end = markdown.length;
  for (const definition of definitions.toReversed()) {
    if (markdown.slice(definition.to, end).trim()) break;
    end = definition.from;
  }
  return end === markdown.length ? end : markdown.slice(0, end).trimEnd().length;
}

export function passageLinks(markdown: string, definitions: PassageDefinition[]): PassageLink[] {
  const destinations = new Map(definitions.map(definition => [definition.id.toLowerCase(), definition.url]));
  const links: PassageLink[] = [];
  for (const match of markdown.matchAll(/\[((?:\\.|[^\[\]\\\n])+)\](?:\[(p\d+-[\da-f]{8})\]|\(<(https?:\/\/[^>\r\n]+)>\))/giu)) {
    const url = match[2] ? destinations.get(match[2].toLowerCase()) : passageDestination(match[3]);
    if (!url) continue;
    const discussion = discussionId(url), replyId = discussion ? undefined : discussionId(url, 'reply');
    if (!match[2] && !discussion && !replyId && !/^p\. \d+(?: · |$)/u.test(match[1])) continue;
    links.push({ label: match[1].replace(/\\(.)/gu, '$1'), url, from: match.index, to: match.index + match[0].length, replyId });
  }
  return links;
}
