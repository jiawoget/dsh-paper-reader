import { stdin, stdout } from 'node:process';
import { Converter } from 'opencc-js/t2cn';
import type { TranslationPipeline } from '@huggingface/transformers';
import { isObject } from './service-types.js';
import { hasDecoderRepetition, translationQualityError } from '../shared/translation-quality.js';

const simplify = Converter({ from: 't', to: 'cn' });
const englishSentences = new Intl.Segmenter('en', { granularity: 'sentence' });

// Keep source terms in context while Marian translates the surrounding sentence.
// The spelling of copied identifiers and the glossary itself never apply to a configured provider.
const glossary = new Map(Object.entries({
  'vector quantization': '\u5411\u91cf\u91cf\u5316',
  'deep residual learning': '深度残差学习', 'residual learning': '残差学习',
  'residual network': '残差网络', 'residual net': '残差网络', 'residual function': '残差函数',
  'residual mapping': '残差映射', 'residual vector': '残差向量', 'residual representation': '残差表示',
  'shortcut connection': '捷径连接', 'identity mapping': '恒等映射', 'backpropagation': '反向传播',
  'feedforward neural network': '前馈神经网络', 'convolutional neural network': '卷积神经网络'
}));
const visionTasks = new Map(Object.entries({ detection: '\u68c0\u6d4b', localization: '\u5b9a\u4f4d', segmentation: '\u5206\u5272' }));
// OPUS often translates the technical sense of "residual" literally. Normalize
// a whole term only when that same term occurs in the English sentence.
const residualForms = new Map<string, RegExp>([
  ['深度残差学习', /深[度层]?(?:剩余|残余|残留|留级|留{2,3}|残差)学习/g],
  ['残差学习', /(?:剩余|残余|残留|留级|留{2,3})学习/g],
  ['残差网络', /(?:剩余|残余|残留)(?:神经)?(?:网络|网)/g],
  ['残差函数', /(?:剩余|残余|残留|留守)(?:功能|函数)/g],
  ['残差映射', /(?:剩余|残余|残留)(?:绘图|映射)/g],
  ['残差向量', /(?:剩余|残余|残留)(?:向量|矢量)/g],
  ['残差表示', /(?:剩余|残余|残留)(?:表示|表征)/g]
]);
const headings = new Map(Object.entries({
  abstract: '摘要', introduction: '引言', 'related work': '相关工作', methods: '方法',
  results: '结果', discussion: '讨论', conclusion: '结论', conclusions: '结论', references: '参考文献'
}));
const literalPatterns = [
  /https?:\/\/[^\s<>"{}]+(?<![.,;:!?])/,
  /(?:\{[\w.,+\s-]+\}|[\w.+-]+)@(?:[\w-]+\.)+[\w-]+/,
  /\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?(?:\s*\[[\w.-]+\])?/,
  /\b[A-Za-z]\([A-Za-z]\w*\)(?:\s*(?::=|[=+\-−×÷])\s*(?:[A-Za-z]\([A-Za-z]\w*\)|[A-Za-z0-9]\b))*/,
  /\[\d+(?:[,\s–-]+\d+)*\]/, /\b\d+(?:\.\d+)?\s*%|\b\d+\.\d+\b/
];
const candidate = new RegExp('(?<literal>' + literalPatterns.map(re => re.source).join('|') +
  ')|\\b(?<term>(?:non-)?(?:' + [...glossary.keys()].sort((a, b) => b.length - a.length).join('|') +
  ')s?)\\b|\\b(?<word>[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\\b', 'gi');

interface Term { start: number; end: number; target: string }

function protectedTerms(source: string): Term[] {
  const terms: Term[] = [];
  for (const match of source.matchAll(candidate)) {
    if ((terms.at(-1)?.end ?? 0) > match.index) continue;
    const word = match[0];
    let end = match.index + word.length;
    let target: string;
    if (match.groups?.term) {
      const key = word.toLowerCase().replace(/^non-/, '').replace(/s$/, '');
      target = (word.toLowerCase().startsWith('non-') ? '非' : '') + glossary.get(key)!;
    } else if (match.groups?.literal) {
      target = word;
    } else if (/[a-z][A-Z]|^[A-Z]{2}/.test(word)) {
      // Keep benchmarks paired with their specific tasks when Marian reorders a list.
      const task = /^\s+(detection|localization|segmentation)\b/i.exec(source.slice(end));
      target = word;
      if (task) {
        target += visionTasks.get(task[1].toLowerCase())!;
        end += task[0].length;
      }
    } else continue;
    terms.push({ start: match.index, end, target });
  }
  return terms;
}

function isByline(source: string): boolean {
  const names = source.split(/[\s,&]+/).filter(word => word && word !== 'and');
  return (names.length >= 8 || (names.length >= 3 && /,|&| and /.test(source))) &&
    names.every(name => /^\p{Lu}[\p{Ll}\p{M}'’-]+$|^\p{Lu}\.$/u.test(name)) &&
    !/\b(?:the|a|an|of|for|in|with|by|from|learning|methods?|networks?|models?)\b/i.test(source);
}

function splitToFit(sentence: string, model: TranslationPipeline): string[] {
  if (model.tokenizer.encode(sentence).length <= 160) return [sentence];
  const middle = Math.floor(sentence.length / 2);
  const left = sentence.lastIndexOf(' ', middle);
  const right = sentence.indexOf(' ', middle);
  const cut = left > middle / 2 ? left : right > 0 && right < sentence.length - 1 ? right : middle;
  return [...splitToFit(sentence.slice(0, cut).trim(), model), ...splitToFit(sentence.slice(cut).trim(), model)];
}

async function translatePassage(source: string, model: TranslationPipeline): Promise<string> {
  const heading = /^(\d+(?:\.\d+)*\.?\s+)?([a-z ]+)$/i.exec(source);
  const title = heading && headings.get(heading[2].toLowerCase());
  if (heading && title) return (heading[1] ?? '') + title;
  if (isByline(source) || /^(?:[A-Z][\p{L}'’-]+ ){1,3}(?:Research|Laboratories|Labs)$/u.test(source)) return source;
  const prepared = source.replace(/\bFig\.\s*(?=\d)/gi, 'Figure ');
  const parts = [...englishSentences.segment(prepared)].flatMap(({ segment }) => splitToFit(segment.trim(), model));
  const translated: string[] = [];
  for (const part of parts) translated.push(await translateSentence(part, model));
  return translated.join(' ');
}

async function decode(source: string, model: TranslationPipeline, terms: readonly Term[] = []): Promise<string> {
  if (!/[A-Za-z]{2}/.test(source)) return simplify(source);
  // A padded batch can continue past a shorter row's EOS in the JS Marian pipeline.
  for (let attempt = 0; attempt < 2; attempt++) {
    const options = attempt === 0 ? undefined : model.model._prepare_generation_config(null, { no_repeat_ngram_size: 3 });
    const [row] = (await model(source, options)).flat();
    let target = simplify(row?.translation_text.trim() ?? '');
    for (const term of terms) {
      const variant = residualForms.get(term.target);
      if (variant) target = target.replace(variant, term.target);
    }
    if (target && !translationQualityError(source, target)) return target;
  }
  throw new Error('Unusable model output.');
}

async function translateSentence(source: string, model: TranslationPipeline): Promise<string> {
  const terms = protectedTerms(source);
  if (!terms.length) return decode(source, model);
  if (terms.length === 1) {
    const [term] = terms, before = source.slice(0, term.start), after = source.slice(term.end);
    if (/^[\s\p{P}]*$/u.test(before + after)) return before + term.target + after.replace(/\.$/, '。');
  }

  const natural = await decode(source, model, terms);
  const counts = new Map<string, number>();
  for (const { target } of terms) counts.set(target, (counts.get(target) ?? 0) + 1);
  if ([...counts].every(([target, count]) => natural.split(target).length - 1 >= count)) return natural;

  const fragments: string[] = [];
  const existing = new Set(Array.from(source.matchAll(/x\s*(\d+)\s*>/gi), match => Number(match[1])));
  let end = 0, offset = 1;
  while (terms.some((_, i) => existing.has(offset + i))) offset += terms.length;
  let masked = '';
  for (const [index, term] of terms.entries()) {
    const prefix = source.slice(end, term.start);
    fragments.push(prefix);
    masked += prefix + '<x' + (offset + index) + '>';
    end = term.end;
  }
  fragments.push(source.slice(end));
  masked += source.slice(end);
  const output = await decode(masked, model);
  const seen = new Set<number>();
  let valid = true;
  const restored = output.replace(/[<\x60'"‘“]\s*x\s*(\d+)\s*>/gi, (word, digits: string) => {
    const index = Number(digits) - offset;
    if (!terms[index] || seen.has(index)) { valid = false; return word; }
    seen.add(index);
    return terms[index].target;
  });
  if (valid && seen.size === terms.length && !hasDecoderRepetition(restored, source)) return restored;
  // Rarely the model drops or duplicates a marker. Translate the intervening
  // text separately so every identifier is restored exactly once in that case.
  const parts: string[] = [];
  for (const [index, fragment] of fragments.entries()) {
    if (fragment.trim()) parts.push(await decode(fragment.trim(), model));
    if (terms[index]) parts.push(terms[index].target);
  }
  return parts.join(' ');
}

async function run(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const bytes of stdin) chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isObject(request) || typeof request.directory !== 'string' || !Array.isArray(request.blocks)) throw new Error('Bad worker request.');
  let model: TranslationPipeline;
  try {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    model = await pipeline<'translation'>('translation', request.directory, {
      dtype: 'q8', device: 'cpu', local_files_only: true,
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 }
    });
  } catch {
    stdout.write(JSON.stringify({ failure: 'load' }));
    return;
  }
  try {
    const translations: Record<string,string> = {};
    for (const item of request.blocks) {
      if (!isObject(item) || typeof item.id !== 'string' || typeof item.text !== 'string') throw new Error('Bad passage.');
      translations[item.id] = await translatePassage(item.text, model);
    }
    stdout.write(JSON.stringify({ translations }));
  } finally { await model.dispose(); }
}
run().catch(() => stdout.write(JSON.stringify({ failure: 'translation' })));
