// src/server/local-translation-worker.ts
import { stdin, stdout } from "node:process";
import { Converter } from "opencc-js/t2cn";

// src/server/service-types.ts
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/shared/translation-quality.ts
var englishWords = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
var sentenceWords = /\b(?:a|an|the|is|are|was|were|will|can|must|has|have|had|we|this|these|that|they|from|with|without|into|on|in|of|at|than|which|when|each|every|across|between)\b/i;
function isUntranslatedEnglish(source, result) {
  const content = result.replace(new RegExp("^\\s*\\p{Script=Han}{1,4}\\s*[:\uFF1A]\\s*", "u"), "");
  if (new RegExp("\\p{Script=Han}", "u").test(content) || /^\s*\[\d+(?:[,\s–-]+\d+)*\]/.test(source) || /\bet al\.\s*(?:\(?\d{4}\)?)?[.,]?\s*$/i.test(source) || /\b(?:19|20)\d{2}\b/.test(source) && /\b(?:doi|isbn|arxiv|journal|proceedings|vol\.|pp\.)\b/i.test(source)) return false;
  const original = source.normalize("NFKC").match(englishWords) ?? [];
  const lowercase = original.filter((word) => /^[a-z]{2}/.test(word)).length;
  const sentence = original.length >= 3 && lowercase >= 2 && /[.!?]["'’”)]*\s*$/.test(source);
  const passage = original.length >= 5 && lowercase >= 3 && sentenceWords.test(source);
  if (!sentence && !passage) return false;
  const translated = content.normalize("NFKC").match(englishWords) ?? [];
  const phrase = (words) => " " + words.join(" ").toLowerCase() + " ";
  return phrase(translated).includes(phrase(original));
}
function hasDecoderRepetition(result, source = "") {
  const compact = result.replace(/\s+/gu, "");
  const original = source.replace(/\s+/gu, "");
  const stutter = /\u6df1[\u5c42\u5c64\u5ea6]\u7559{3,}[\u5b66\u5b78][\u4e60\u7fd2]/u.exec(compact);
  if (stutter && !original.includes(stutter[0]) && (source ? /\bresidual[\s-]+learning\b/i.test(source) : stutter.index === 0 && compact.length <= 80)) return true;
  for (const match of compact.matchAll(/[.,:;!?，。；：、！？]{7,}|([\p{Script=Han}][\p{Script=Han},.:;!?，。；：、！？]{0,39}?)\1{3,}/gu)) {
    const run2 = match[0], unit = match[1];
    if (/^\.+$/.test(run2) && (run2.length < 32 || /\d/.test(compact[match.index + run2.length] ?? ""))) continue;
    if ((!unit || run2.length >= (unit.length === 1 ? 6 : 10)) && !original.includes(run2)) return true;
  }
  return false;
}
function translationQualityError(source, result) {
  if (hasDecoderRepetition(result, source)) return "The model returned repeated text. Retry the page translation.";
  if (isUntranslatedEnglish(source, result)) return "The model returned the original English passage. Retry the page translation.";
}

// src/server/local-translation-worker.ts
var simplify = Converter({ from: "t", to: "cn" });
var englishSentences = new Intl.Segmenter("en", { granularity: "sentence" });
var glossary = new Map(Object.entries({
  "vector quantization": "\u5411\u91CF\u91CF\u5316",
  "deep residual learning": "\u6DF1\u5EA6\u6B8B\u5DEE\u5B66\u4E60",
  "residual learning": "\u6B8B\u5DEE\u5B66\u4E60",
  "residual network": "\u6B8B\u5DEE\u7F51\u7EDC",
  "residual net": "\u6B8B\u5DEE\u7F51\u7EDC",
  "residual function": "\u6B8B\u5DEE\u51FD\u6570",
  "residual mapping": "\u6B8B\u5DEE\u6620\u5C04",
  "residual vector": "\u6B8B\u5DEE\u5411\u91CF",
  "residual representation": "\u6B8B\u5DEE\u8868\u793A",
  "shortcut connection": "\u6377\u5F84\u8FDE\u63A5",
  "identity mapping": "\u6052\u7B49\u6620\u5C04",
  "backpropagation": "\u53CD\u5411\u4F20\u64AD",
  "feedforward neural network": "\u524D\u9988\u795E\u7ECF\u7F51\u7EDC",
  "convolutional neural network": "\u5377\u79EF\u795E\u7ECF\u7F51\u7EDC"
}));
var visionTasks = new Map(Object.entries({ detection: "\u68C0\u6D4B", localization: "\u5B9A\u4F4D", segmentation: "\u5206\u5272" }));
var residualForms = /* @__PURE__ */ new Map([
  ["\u6DF1\u5EA6\u6B8B\u5DEE\u5B66\u4E60", /深[度层]?(?:剩余|残余|残留|留级|留{2,3}|残差)学习/g],
  ["\u6B8B\u5DEE\u5B66\u4E60", /(?:剩余|残余|残留|留级|留{2,3})学习/g],
  ["\u6B8B\u5DEE\u7F51\u7EDC", /(?:剩余|残余|残留)(?:神经)?(?:网络|网)/g],
  ["\u6B8B\u5DEE\u51FD\u6570", /(?:剩余|残余|残留|留守)(?:功能|函数)/g],
  ["\u6B8B\u5DEE\u6620\u5C04", /(?:剩余|残余|残留)(?:绘图|映射)/g],
  ["\u6B8B\u5DEE\u5411\u91CF", /(?:剩余|残余|残留)(?:向量|矢量)/g],
  ["\u6B8B\u5DEE\u8868\u793A", /(?:剩余|残余|残留)(?:表示|表征)/g]
]);
var headings = new Map(Object.entries({
  abstract: "\u6458\u8981",
  introduction: "\u5F15\u8A00",
  "related work": "\u76F8\u5173\u5DE5\u4F5C",
  methods: "\u65B9\u6CD5",
  results: "\u7ED3\u679C",
  discussion: "\u8BA8\u8BBA",
  conclusion: "\u7ED3\u8BBA",
  conclusions: "\u7ED3\u8BBA",
  references: "\u53C2\u8003\u6587\u732E"
}));
var literalPatterns = [
  /https?:\/\/[^\s<>"{}]+(?<![.,;:!?])/,
  /(?:\{[\w.,+\s-]+\}|[\w.+-]+)@(?:[\w-]+\.)+[\w-]+/,
  /\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?(?:\s*\[[\w.-]+\])?/,
  /\b[A-Za-z]\([A-Za-z]\w*\)(?:\s*(?::=|[=+\-−×÷])\s*(?:[A-Za-z]\([A-Za-z]\w*\)|[A-Za-z0-9]\b))*/,
  /\[\d+(?:[,\s–-]+\d+)*\]/,
  /\b\d+(?:\.\d+)?\s*%|\b\d+\.\d+\b/
];
var candidate = new RegExp("(?<literal>" + literalPatterns.map((re) => re.source).join("|") + ")|\\b(?<term>(?:non-)?(?:" + [...glossary.keys()].sort((a, b) => b.length - a.length).join("|") + ")s?)\\b|\\b(?<word>[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\\b", "gi");
function protectedTerms(source) {
  const terms = [];
  for (const match of source.matchAll(candidate)) {
    if ((terms.at(-1)?.end ?? 0) > match.index) continue;
    const word = match[0];
    let end = match.index + word.length;
    let target;
    if (match.groups?.term) {
      const key = word.toLowerCase().replace(/^non-/, "").replace(/s$/, "");
      target = (word.toLowerCase().startsWith("non-") ? "\u975E" : "") + glossary.get(key);
    } else if (match.groups?.literal) {
      target = word;
    } else if (/[a-z][A-Z]|^[A-Z]{2}/.test(word)) {
      const task = /^\s+(detection|localization|segmentation)\b/i.exec(source.slice(end));
      target = word;
      if (task) {
        target += visionTasks.get(task[1].toLowerCase());
        end += task[0].length;
      }
    } else continue;
    terms.push({ start: match.index, end, target });
  }
  return terms;
}
function isByline(source) {
  const names = source.split(/[\s,&]+/).filter((word) => word && word !== "and");
  return (names.length >= 8 || names.length >= 3 && /,|&| and /.test(source)) && names.every((name) => new RegExp("^\\p{Lu}[\\p{Ll}\\p{M}'\u2019-]+$|^\\p{Lu}\\.$", "u").test(name)) && !/\b(?:the|a|an|of|for|in|with|by|from|learning|methods?|networks?|models?)\b/i.test(source);
}
function splitToFit(sentence, model) {
  if (model.tokenizer.encode(sentence).length <= 160) return [sentence];
  const middle = Math.floor(sentence.length / 2);
  const left = sentence.lastIndexOf(" ", middle);
  const right = sentence.indexOf(" ", middle);
  const cut = left > middle / 2 ? left : right > 0 && right < sentence.length - 1 ? right : middle;
  return [...splitToFit(sentence.slice(0, cut).trim(), model), ...splitToFit(sentence.slice(cut).trim(), model)];
}
async function translatePassage(source, model) {
  const heading = /^(\d+(?:\.\d+)*\.?\s+)?([a-z ]+)$/i.exec(source);
  const title = heading && headings.get(heading[2].toLowerCase());
  if (heading && title) return (heading[1] ?? "") + title;
  if (isByline(source) || /^(?:[A-Z][\p{L}'’-]+ ){1,3}(?:Research|Laboratories|Labs)$/u.test(source)) return source;
  const prepared = source.replace(/\bFig\.\s*(?=\d)/gi, "Figure ");
  const parts = [...englishSentences.segment(prepared)].flatMap(({ segment }) => splitToFit(segment.trim(), model));
  const translated = [];
  for (const part of parts) translated.push(await translateSentence(part, model));
  return translated.join(" ");
}
async function decode(source, model, terms = []) {
  if (!/[A-Za-z]{2}/.test(source)) return simplify(source);
  for (let attempt = 0; attempt < 2; attempt++) {
    const options = attempt === 0 ? void 0 : { no_repeat_ngram_size: 3 };
    const [row] = await model(source, options);
    let target = simplify(row?.translation_text.trim() ?? "");
    for (const term of terms) {
      const variant = residualForms.get(term.target);
      if (variant) target = target.replace(variant, term.target);
    }
    if (target && !translationQualityError(source, target)) return target;
  }
  throw new Error("Unusable model output.");
}
async function translateSentence(source, model) {
  const terms = protectedTerms(source);
  if (!terms.length) return decode(source, model);
  if (terms.length === 1) {
    const [term] = terms, before = source.slice(0, term.start), after = source.slice(term.end);
    if (/^[\s\p{P}]*$/u.test(before + after)) return before + term.target + after.replace(/\.$/, "\u3002");
  }
  const natural = await decode(source, model, terms);
  const counts = /* @__PURE__ */ new Map();
  for (const { target } of terms) counts.set(target, (counts.get(target) ?? 0) + 1);
  if ([...counts].every(([target, count]) => natural.split(target).length - 1 >= count)) return natural;
  const fragments = [];
  const existing = new Set(Array.from(source.matchAll(/x\s*(\d+)\s*>/gi), (match) => Number(match[1])));
  let end = 0, offset = 1;
  while (terms.some((_, i) => existing.has(offset + i))) offset += terms.length;
  let masked = "";
  for (const [index, term] of terms.entries()) {
    const prefix = source.slice(end, term.start);
    fragments.push(prefix);
    masked += prefix + "<x" + (offset + index) + ">";
    end = term.end;
  }
  fragments.push(source.slice(end));
  masked += source.slice(end);
  const output = await decode(masked, model);
  const seen = /* @__PURE__ */ new Set();
  let valid = true;
  const restored = output.replace(/[<\x60'"‘“]\s*x\s*(\d+)\s*>/gi, (word, digits) => {
    const index = Number(digits) - offset;
    if (!terms[index] || seen.has(index)) {
      valid = false;
      return word;
    }
    seen.add(index);
    return terms[index].target;
  });
  if (valid && seen.size === terms.length && !hasDecoderRepetition(restored, source)) return restored;
  const parts = [];
  for (const [index, fragment] of fragments.entries()) {
    if (fragment.trim()) parts.push(await decode(fragment.trim(), model));
    if (terms[index]) parts.push(terms[index].target);
  }
  return parts.join(" ");
}
async function run() {
  const chunks = [];
  for await (const bytes of stdin) chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isObject(request) || typeof request.directory !== "string" || !Array.isArray(request.blocks)) throw new Error("Bad worker request.");
  let model;
  try {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    model = await pipeline("translation", request.directory, {
      dtype: "q8",
      device: "cpu",
      local_files_only: true,
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 }
    });
  } catch {
    stdout.write(JSON.stringify({ failure: "load" }));
    return;
  }
  try {
    const translations = {};
    for (const item of request.blocks) {
      if (!isObject(item) || typeof item.id !== "string" || typeof item.text !== "string") throw new Error("Bad passage.");
      translations[item.id] = await translatePassage(item.text, model);
    }
    stdout.write(JSON.stringify({ translations }));
  } finally {
    await model.dispose();
  }
}
run().catch(() => stdout.write(JSON.stringify({ failure: "translation" })));
