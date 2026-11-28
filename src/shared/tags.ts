import type { DocumentInfo, TopicRecord } from './types.js';

export const MAX_DOC_TAGS = 20;
export const MAX_TAG_LEN = 40;
export interface TagStat { tag: string; count: number; label?: string }

const STOPWORDS = new Set(
  'the and for with from that this into over under through using via based paper study method methods approach approaches results result analysis towards toward large novel new efficient effective fast high low multi deep model models learning data work works propose proposed show shows achieve achieves improve improves across between without within their these those such more most than also only when where while which what have been were will would could should can are was not our its per all any one two use used abstract section figure table benchmark evaluation'.split(' ')
);

export const isInternalTag = (tag: string): boolean => /^screen:/i.test(tag);
export const normalizeTag = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN);

export function normalizeTagList(raw: readonly string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const item of raw) {
    const clean = normalizeTag(item), key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key); out.push(clean);
    if (out.length >= MAX_DOC_TAGS) break;
  }
  return out;
}

export function mergeTags(current: readonly string[], opts: { add?: readonly string[]; remove?: readonly string[] }): string[] {
  const removeKeys = new Set((opts.remove ?? []).map(t => normalizeTag(t).toLocaleLowerCase()).filter(Boolean));
  return normalizeTagList([...current.filter(t => !removeKeys.has(normalizeTag(t).toLocaleLowerCase())), ...(opts.add ?? [])]);
}

export function collectLibraryTags(docs: readonly DocumentInfo[], topics?: readonly TopicRecord[]): TagStat[] {
  const counts = new Map<string, { count: number; variants: Map<string, number>; label?: string; preferred?: string }>();
  const touch = (raw: string) => {
    const clean = normalizeTag(raw);
    if (!clean || isInternalTag(clean)) return null;
    const key = clean.toLocaleLowerCase();
    let entry = counts.get(key);
    if (!entry) { entry = { count: 0, variants: new Map() }; counts.set(key, entry); }
    return { clean, key, entry };
  };
  for (const tp of topics ?? []) {
    const hit = touch(tp.tag || tp.name);
    if (!hit) continue;
    hit.entry.preferred = hit.clean;
    if (tp.name && tp.name !== hit.clean) hit.entry.label = `${tp.name} (#${hit.clean})`;
  }
  for (const doc of docs) {
    const seenDoc = new Set<string>();
    for (const raw of doc.meta?.tags ?? []) {
      const hit = touch(raw);
      if (!hit || seenDoc.has(hit.key)) continue;
      seenDoc.add(hit.key); hit.entry.count++; hit.entry.variants.set(hit.clean, (hit.entry.variants.get(hit.clean) ?? 0) + 1);
    }
  }
  const out: TagStat[] = [];
  for (const e of counts.values()) {
    let tag = e.preferred ?? '', best = -1;
    if (!tag) for (const [s, n] of e.variants) if (n > best || (n === best && s.localeCompare(tag) < 0)) { tag = s; best = n; }
    if (tag) out.push({ tag, count: e.count, ...(e.label ? { label: e.label } : {}) });
  }
  return out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function filterTagStats(stats: readonly TagStat[], query: string, limit = 24): { items: TagStat[]; total: number; hiddenCount: number; createTag: string | null } {
  const clean = normalizeTag(query), needle = clean.toLocaleLowerCase();
  const matched = needle ? stats.filter(s => s.tag.toLocaleLowerCase().includes(needle) || (s.label?.toLocaleLowerCase().includes(needle) ?? false)) : stats;
  const items = matched.slice(0, limit), exact = Boolean(needle && stats.some(s => s.tag.toLocaleLowerCase() === needle));
  return { items, total: matched.length, hiddenCount: Math.max(0, matched.length - items.length), createTag: clean && !isInternalTag(clean) && !exact ? clean : null };
}

export function suggestOfflineTags(doc: Pick<DocumentInfo, 'title' | 'paperTitle' | 'abstract' | 'venue' | 'meta'>, taxonomy: readonly TagStat[], limit = 4): string[] {
  const existing = new Set((doc.meta?.tags ?? []).map(t => normalizeTag(t).toLocaleLowerCase()).filter(Boolean));
  const titleRaw = [doc.paperTitle, doc.title].filter(Boolean).join(' '), bodyRaw = [doc.abstract, doc.venue].filter(Boolean).join(' ');
  const titleLow = titleRaw.toLocaleLowerCase(), bodyLow = bodyRaw.toLocaleLowerCase(), matchedTax: { tag: string; score: number; count: number }[] = [];
  for (const stat of taxonomy) {
    const clean = normalizeTag(stat.tag), key = clean.toLocaleLowerCase();
    if (!clean || isInternalTag(clean) || existing.has(key)) continue;
    let score = (titleLow.includes(key) ? 3 : 0) + (bodyLow.includes(key) ? 1.5 : 0);
    if (!score) {
      const parts = key.split(/[\s/_-]+/).filter(p => p.length >= 3 || /[\u4e00-\u9fff]{2,}/.test(p));
      if (parts.length > 1) { const th = parts.filter(p => titleLow.includes(p)).length, bh = parts.filter(p => bodyLow.includes(p)).length; score = th === parts.length ? 2.5 : bh === parts.length ? 1.25 : th > 0 ? (th / parts.length) * 1.2 : 0; }
    }
    if (score > 0) matchedTax.push({ tag: clean, score: score * (1 + Math.log2(stat.count + 1) * 0.25), count: stat.count });
  }
  const out: string[] = [], push = (tag: string) => { const k = tag.toLocaleLowerCase(); if (!tag || isInternalTag(tag) || existing.has(k)) return false; existing.add(k); out.push(tag); return out.length >= limit; };
  for (const item of matchedTax.sort((a, b) => b.score - a.score || b.count - a.count || a.tag.localeCompare(b.tag))) if (push(item.tag)) return out;
  const kw = new Map<string, { label: string; score: number }>();
  const scan = (text: string, weight: number) => {
    for (const raw of text.match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[A-Za-z][A-Za-z0-9]{2,27}|[\u4e00-\u9fff]{2,6}/g) ?? []) {
      const low = raw.toLocaleLowerCase();
      if ((low.length < 3 && !/[\u4e00-\u9fff]{2,}/.test(low)) || STOPWORDS.has(low) || /^\d+$/.test(low) || existing.has(low)) continue;
      const bonus = raw.includes('-') ? 1.4 : /^[A-Z0-9]{2,6}$/.test(raw) ? 1.25 : 1, cur = kw.get(low), label = normalizeTag(/^[A-Z0-9-]{2,8}$/.test(raw) ? raw : low);
      if (cur) cur.score += weight * bonus; else if (label) kw.set(low, { label, score: weight * bonus });
    }
  };
  scan(titleRaw, 3); scan(bodyRaw, 1);
  for (const { label } of [...kw.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))) if (push(label)) break;
  return out;
}
