const englishWords = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
const sentenceWords = /\b(?:a|an|the|is|are|was|were|will|can|must|has|have|had|we|this|these|that|they|from|with|without|into|on|in|of|at|than|which|when|each|every|across|between)\b/i;

export function isUntranslatedEnglish(source: string, result: string): boolean {
  const content = result.replace(/^\s*\p{Script=Han}{1,4}\s*[:：]\s*/u, '');
  if (/\p{Script=Han}/u.test(content) || /^\s*\[\d+(?:[,\s–-]+\d+)*\]/.test(source) ||
    /\bet al\.\s*(?:\(?\d{4}\)?)?[.,]?\s*$/i.test(source) ||
    (/\b(?:19|20)\d{2}\b/.test(source) && /\b(?:doi|isbn|arxiv|journal|proceedings|vol\.|pp\.)\b/i.test(source))) return false;
  const original = source.normalize('NFKC').match(englishWords) ?? [];
  const lowercase = original.filter(word => /^[a-z]{2}/.test(word)).length;
  const sentence = original.length >= 3 && lowercase >= 2 && /[.!?]["'’”)]*\s*$/.test(source);
  const passage = original.length >= 5 && lowercase >= 3 && sentenceWords.test(source);
  if (!sentence && !passage) return false;
  const translated = content.normalize('NFKC').match(englishWords) ?? [];
  const phrase = (words: string[]) => ' ' + words.join(' ').toLowerCase() + ' ';
  return phrase(translated).includes(phrase(original));
}

export function hasDecoderRepetition(result: string, source = ''): boolean {
  const compact = result.replace(/\s+/gu, '');
  const original = source.replace(/\s+/gu, '');
  // Old OPUS title caches can contain this stutter inside "deep residual learning".
  // A legacy cache read has no source, so only recognize a short leading title in that case.
  const stutter = /\u6df1[\u5c42\u5c64\u5ea6]\u7559{3,}[\u5b66\u5b78][\u4e60\u7fd2]/u.exec(compact);
  if (stutter && !original.includes(stutter[0]) &&
    (source ? /\bresidual[\s-]+learning\b/i.test(source) : stutter.index === 0 && compact.length <= 80)) return true;
  // Marian can continue emitting the same word or punctuation after a sentence ends.
  // Exclude digits, Latin names, equation operators and ordinary ellipses.
  for (const match of compact.matchAll(/[.,:;!?，。；：、！？]{7,}|([\p{Script=Han}][\p{Script=Han},.:;!?，。；：、！？]{0,39}?)\1{3,}/gu)) {
    const run = match[0], unit = match[1];
    if (/^\.+$/.test(run) && (run.length < 32 || /\d/.test(compact[match.index + run.length] ?? ''))) continue;
    if ((!unit || run.length >= (unit.length === 1 ? 6 : 10)) && !original.includes(run)) return true;
  }
  return false;
}

export function translationQualityError(source: string, result: string): string | undefined {
  if (hasDecoderRepetition(result, source)) return 'The model returned repeated text. Retry the page translation.';
  if (isUntranslatedEnglish(source, result)) return 'The model returned the original English passage. Retry the page translation.';
}

export { targetsSimplifiedChinese } from './languages.js';
