import { activateAfterTouchDrag, el, message, readerLabel as label, toast } from './ui.js';

export type PromptScope = 'paper' | 'selection';
export type CustomPromptScope = PromptScope | 'all';
export interface ResearchPrompt { readonly id: string; readonly scope: PromptScope; readonly label: string; readonly prompt: string; readonly custom?: boolean }
export interface CustomPromptTemplate { readonly scope: CustomPromptScope; readonly label: string; readonly prompt: string }
type BuiltinTemplate = readonly [id: string, scope: PromptScope, labelEn: string, labelZh: string, promptEn: string, promptZh: string];

const MAX_CUSTOM_PROMPTS = 20;

const BUILTINS: readonly BuiltinTemplate[] = [
  ['brief', 'paper', 'Structured Brief', '结构化精要',
    'Give a structured brief of this paper covering: 1) core problem and motivation, 2) key method/architecture, 3) main quantitative results, and 4) limitations. Cite exact page numbers as (p. N) for every major claim.',
    '请给出这篇论文的结构化精要，包含：1）核心问题与动机，2）关键方法与架构，3）主要定量实验结果，4）局限性。每条关键结论请用 (p. N) 标注对应页码。'],
  ['datasets', 'paper', 'Datasets & Metrics', '数据集与指标',
    'Summarize the datasets, benchmarks, baselines, and evaluation metrics used in this paper, including key experimental settings and main numbers. Cite pages as (p. N).',
    '请汇总本文使用的数据集、基准测试、对比基线和评估指标，列出关键实验设置与主要结果数据，并用 (p. N) 标注页码。'],
  ['critique', 'paper', 'Methodology Critique', '方法批判',
    'Critically evaluate the methodology: identify key assumptions, potential weaknesses, missing ablations or baselines, and threats to validity grounded in the paper. Cite pages as (p. N).',
    '请批判性评估本文的方法：指出核心假设、潜在薄弱点、缺失的消融实验或基线，以及效度风险，并结合论文内容用 (p. N) 标注页码。'],
  ['equations', 'paper', 'Key Equations & Notation', '核心公式与符号',
    'List the paper\'s key equations and mathematical notation in a concise glossary (symbol, meaning, and role in the method) using LaTeX math. Cite pages as (p. N).',
    '请整理本文的核心公式与关键数学符号表（含符号、含义及在方法中的作用），使用 LaTeX 公式表示，并用 (p. N) 标注页码。'],
  ['step-by-step', 'selection', 'Explain Step-by-Step', '分步讲解',
    'Explain this selection step-by-step from first principles, clarifying each concept, step, and how it connects to the surrounding context.',
    '请由浅入深分步讲解这段内容，阐明每个关键概念、推导步骤及其与上下文的联系。'],
  ['latex', 'selection', 'Extract Equation (LaTeX)', '提取公式 (LaTeX)',
    'Extract all equations or mathematical expressions from this selection as clean LaTeX (using $$ ... $$ for display equations), then briefly define each symbol.',
    '请将这段内容中的公式或数学表达式提取为规范的 LaTeX（独立公式使用 $$ ... $$），并简要说明各符号的含义。'],
  ['table', 'selection', 'Extract Table (Markdown)', '提取表格 (Markdown)',
    'Extract the data or comparison from this selection into a clean Markdown table, preserving exact headers, units, and numbers, followed by one sentence on the main takeaway.',
    '请将这段内容中的数据或对比整理为规范的 Markdown 表格，准确保留表头、单位与数值，并在表后用一句话总结核心发现。'],
  ['intuition', 'selection', 'Intuition & Example', '直觉与示例',
    'Give the core intuition behind this selection and illustrate it with a small, concrete worked example.',
    '请用通俗直觉解释这段内容的核心思想，并举一个具体的小例子帮助理解。']
];

const isChineseLocale = () => typeof navigator !== 'undefined' && /^zh(?:-|$)/i.test(navigator.language);

export function parseCustomPrompts(raw?: string): CustomPromptTemplate[] {
  if (!raw) return [];
  const entries = new Map<string, CustomPromptTemplate>();
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.search(/[|｜]/u);
    if (sep <= 0) continue;
    const left = trimmed.slice(0, sep).trim(), prompt = trimmed.slice(sep + 1).trim();
    if (!left || !prompt) continue;
    const scoped = /^(paper|selection|region)\s*[:：]\s*(.*)$/iu.exec(left);
    const scope: CustomPromptScope = scoped ? (scoped[1].toLowerCase() === 'paper' ? 'paper' : 'selection') : 'all';
    const text = (scoped ? scoped[2] : left).trim();
    if (!text) continue;
    const key = scope + '\u0000' + text.normalize('NFKC').toLowerCase();
    entries.delete(key);
    entries.set(key, { scope, label: text, prompt });
  }
  return [...entries.values()].slice(0, MAX_CUSTOM_PROMPTS);
}

export function promptsForScope(scope: PromptScope, customPrompts?: string, zh = isChineseLocale()): ResearchPrompt[] {
  const builtin: ResearchPrompt[] = BUILTINS.filter(item => item[1] === scope).map(([id, s, en, cn, pEn, pZh]) => ({
    id, scope: s, label: zh ? cn : en, prompt: zh ? pZh : pEn
  }));
  const custom: ResearchPrompt[] = parseCustomPrompts(customPrompts)
    .filter(item => item.scope === 'all' || item.scope === scope)
    .map((item, index) => ({ id: 'custom-' + index, scope, label: item.label, prompt: item.prompt, custom: true }));
  return [...builtin, ...custom];
}

export function createPromptBar(scope: PromptScope, onPick: (prompt: string) => void | Promise<void>) {
  const root = el('div', 'chat-prompt-bar');
  root.setAttribute('role', 'group');
  root.hidden = true;
  let signature = '', lastDisabled: boolean | undefined;
  return {
    root,
    sync(customPrompts: string | undefined, visible: boolean, disabled: boolean): void {
      root.hidden = !visible;
      if (!visible) return;
      const zh = isChineseLocale();
      const nextSig = (zh ? '1' : '0') + '\u0000' + (customPrompts ?? '');
      if (nextSig !== signature) {
        signature = nextSig; lastDisabled = disabled;
        root.ariaLabel = label('Research prompts', '学术提示词');
        root.replaceChildren();
        for (const item of promptsForScope(scope, customPrompts, zh)) {
          const btn = el('button', 'chat-prompt-chip' + (item.custom ? ' is-custom' : ''), item.label);
          btn.type = 'button'; btn.dataset.promptId = item.id; btn.title = item.prompt; btn.disabled = disabled;
          btn.onclick = () => { if (!btn.disabled) void Promise.resolve(onPick(item.prompt)).catch(e => toast(message(e))); };
          activateAfterTouchDrag(btn);
          root.append(btn);
        }
      } else if (lastDisabled !== disabled) {
        lastDisabled = disabled;
        for (const chip of root.querySelectorAll('button')) chip.disabled = disabled;
      }
    }
  };
}
