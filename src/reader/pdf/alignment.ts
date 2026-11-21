import type { Passage, SentencePair } from './model.js';

// Each row maps a run of translated sentences to the exact start of a
// corresponding source passage. Some English sentences become two in Chinese.
type AlignmentRow = readonly [targetSentenceCount: number, originalStartsWith: string];
const boundaries: Readonly<Record<string, readonly AlignmentRow[]>> = {
  'block-tables': [[2, 'divides it into'], [1, 'The KV block manager'], [1, 'Each block table entry'], [1, 'Separating logical']],
  'decoding-steps': [[1, 'Next, we walk'], [1, '① As in'], [1, 'Instead, it reserves'], [1, 'In this case,'],
    [1, 'In the prefill step'], [1, 'vLLM then stores'], [1, '② In the first'], [1, 'Since one slot remains'], [2, '③ At the second']],
  'iteration-compute': [[2, 'requests and the latest tokens'], [1, 'During LLM'], [1, 'Storing multiple tokens'],
    [1, 'However, a larger block size'], [1, 'We study the effect']],
  'two-requests': [[1, 'Again, vLLM'], [2, 'As all the blocks'], [1, 'This allows more requests'], [1, 'Once a request finishes'],
    [1, 'In Fig. 7'], [1, 'The logical blocks of the two sequences'], [1, 'The neighboring logical blocks']],
  'other-decoding': [[2, '§4.3 shows'], [2, 'In many successful'], [1, 'We show the general']],
  'parallel-sampling': [[1, 'Parallel sampling.'], [1, 'In LLM-based program assistants'], [1, 'So far we have implicitly']]
};

export function alignSample(id: string, source: string, target: string | undefined): SentencePair[] | undefined {
  const rows = boundaries[id];
  if (!target || !rows) return undefined;
  const sentences = target.match(/[^\u3002\uff01\uff1f\n]+[\u3002\uff01\uff1f]*/gu) || [];
  const starts = rows.map(([, anchor]) => source.indexOf(anchor));
  const count = rows.reduce((total, [n]) => total + n, 0);
  if (sentences.length !== count || starts[0] !== 0 || starts.some((s, i) => i > 0 && s <= starts[i - 1])) return undefined;
  let next = 0;
  return rows.map(([n], i) => {
    const start = next;
    next += n;
    return { original: source.slice(starts[i], starts[i + 1] ?? source.length).trim(),
      translated: sentences.slice(start, next).join('').trim() };
  });
}

function compact(s: string): string { return s.replace(/\s+/gu, ''); }

type BilingualText = Pick<Passage, 'text' | 'translation' | 'sentencePairs'>;

const english = new Intl.Segmenter('en', { granularity: 'sentence' });
const chinese = new Intl.Segmenter('zh', { granularity: 'sentence' });
const recovered = new WeakMap<BilingualText, { source: string; target: string; pairs?: SentencePair[] }>();
const scientificName = /[A-Z].*[A-Z0-9]/u;

function sentences(text: string, segmenter: Intl.Segmenter): string[] {
  const result: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const previous = result.at(-1);
    // ICU may split "(Fig. 2)" and "Sec. 4". Keep the reference in its sentence.
    const afterReference = previous && segmenter === english && /\b(?:figs?|eqs?|secs?|refs?|nos?)\.\s*$/iu.test(previous) && /^\s*\d/u.test(segment);
    const lineWrap = previous && !/[.!?。！？][)"'’”»）】\]]*\s*$/u.test(previous);
    if (afterReference || lineWrap) {
      result[result.length - 1] += segment;
    } else result.push(segment);
  }
  return result.map(sentence => sentence.trim()).filter(Boolean);
}

/** The positions of bilingual landmarks survive even when a model rewrites the surrounding words. */
function landmarks(parts: string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  const pattern = /\b[A-Za-z]\s*\(\s*[A-Za-z]\s*\)|\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]|\d+(?:\.\d+)*%?|[A-Za-z][A-Za-z0-9-]*/gu;
  parts.forEach((sentence, index) => {
    for (const [value] of sentence.normalize('NFKC').matchAll(pattern)) {
      if (/^[A-Za-z][A-Za-z0-9-]*$/u.test(value) && !scientificName.test(value)) continue;
      const token = compact(value);
      const rows = positions.get(token) ?? [];
      if (rows.at(-1) !== index) rows.push(index);
      positions.set(token, rows);
    }
  });
  return positions;
}

function recoverSentences(source: string, target: string): SentencePair[] | undefined {
  const originals = sentences(source, english), translations = sentences(target, chinese);
  if (originals.length < 2 || originals.length !== translations.length) return;
  const shared = new Set<number>(), targetPositions = landmarks(translations);
  for (const [token, originalPositions] of landmarks(originals)) {
    const translatedPositions = targetPositions.get(token);
    if (!translatedPositions) continue;
    if (originalPositions.length !== translatedPositions.length ||
      originalPositions.some((position, index) => position !== translatedPositions[index])) return;
    // A term in every sentence cannot establish their order.
    if (originalPositions.length < originals.length) originalPositions.forEach(position => shared.add(position));
  }
  if (shared.size < (originals.length === 2 ? 1 : 2)) return;
  let unanchored = 0;
  for (let index = 0; index < originals.length; index++) {
    unanchored = shared.has(index) ? 0 : unanchored + 1;
    if (unanchored > 2) return;
  }
  return originals.map((original, index) => ({ original, translated: translations[index] }));
}

function availablePairs(p: BilingualText): SentencePair[] | undefined {
  if (p.sentencePairs?.length || !p.translation) return p.sentencePairs;
  let cached = recovered.get(p);
  if (!cached || cached.source !== p.text || cached.target !== p.translation) {
    cached = { source: p.text, target: p.translation, pairs: recoverSentences(p.text, p.translation) };
    recovered.set(p, cached);
  }
  return cached.pairs;
}

function uniqueIdentifier(text: string, term: string): boolean {
  const at = text.indexOf(term);
  return at >= 0 && text.indexOf(term, at + 1) < 0 && !/[A-Za-z0-9_]/u.test(text[at - 1] ?? '') &&
    !/[A-Za-z0-9_]/u.test(text[at + term.length] ?? '');
}

export function correspondingText(p: BilingualText, quote: string, from: 'original' | 'translated', offset?: number): string | undefined {
  if (p.translation && /^[A-Za-z][A-Za-z0-9-]{1,40}$/u.test(quote) && scientificName.test(quote) &&
    uniqueIdentifier(p.text, quote) && uniqueIdentifier(p.translation, quote)) return quote;
  const pairs = availablePairs(p);
  if (!pairs?.length || !quote) return undefined;
  if (compact(p.translation ?? '') !== compact(pairs.map(pair => pair.translated).join('')) ||
    compact(p.text) !== compact(pairs.map(pair => pair.original).join(''))) return undefined;
  const needle = compact(quote), components = pairs.map(pair => compact(pair[from]));
  const corpus = components.join('');
  const text = from === 'original' ? p.text : p.translation ?? '';
  const hinted = offset === undefined ? -1 : compact(text.slice(0, offset)).length;
  const at = hinted >= 0 && corpus.startsWith(needle, hinted) ? hinted : corpus.indexOf(needle);
  if (at < 0) return undefined;
  const counterpart = from === 'original' ? 'translated' : 'original';
  const pairedText = counterpart === 'original' ? p.text : p.translation!;
  let position = 0, peerEnd = 0, first = -1, last = -1;
  for (let i = 0; i < components.length; i++) {
    const end = position + components[i].length;
    const peer = pairs[i][counterpart];
    const peerStart = pairedText.indexOf(peer, peerEnd);
    if (peerStart < 0) return undefined;
    peerEnd = peerStart + peer.length;
    if (end > at && position < at + needle.length) {
      if (first < 0) first = peerStart;
      last = peerEnd;
    }
    position = end;
  }
  return first < 0 ? undefined : pairedText.slice(first, last);
}

export function pairSelection(p: BilingualText, selected: string, from: 'original' | 'translated', offset?: number) {
  const other = from === 'original' ? 'translated' : 'original';
  const aligned = correspondingText(p, selected, from, offset);
  const original = from === 'original' ? selected : aligned || p.text;
  const translated = from === 'translated' ? selected : aligned || p.translation;
  const whole = from === 'original' ? p.text : p.translation;
  const exactPair = Boolean(translated && (compact(selected) === compact(whole ?? '') ||
    (aligned && compact(correspondingText(p, aligned, other) ?? '') === compact(selected))));
  return { original, translated, exactPair };
}
