import type { QuestionCatalog, QuestionModel } from './types.js';

type Label = (english: string, chinese: string) => string;
interface ModelFormOptions {
  label: Label;
  defaultName?: string;
  load(): Promise<QuestionCatalog>;
  save(model: QuestionModel | null): Promise<void>;
}

export function questionModelForm({ label, defaultName, load, save }: ModelFormOptions): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'question-model-form';
  const field = (caption: string) => {
    const row = document.createElement('label'), title = document.createElement('span'), select = document.createElement('select');
    row.className = 'field'; title.textContent = caption;
    row.append(title, select); form.append(row);
    return { row, select };
  };
  const model = field(label('Model', '模型')), effort = field(label('Reasoning effort', '推理强度'));
  const status = document.createElement('p');
  status.className = 'hint'; status.setAttribute('role', 'status');
  const apply = document.createElement('button'), retry = document.createElement('button');
  apply.type = 'submit'; apply.className = 'btn primary'; apply.textContent = label('Use model', '使用此模型');
  retry.type = 'button'; retry.className = 'text-btn'; retry.textContent = label('Reload models', '重新加载模型');
  form.append(status, retry, apply);
  const options = new Map<string, { selection: QuestionModel; model: QuestionCatalog['groups'][number]['models'][number] }>();
  const key = (provider: string, id: string) => JSON.stringify([provider, id]);
  const fallback = label('Reader default', '阅读器默认模型') + (defaultName ? ' · ' + defaultName : '');
  function efforts(selected?: string) {
    const reasoning = options.get(model.select.value)?.model.reasoning;
    effort.select.replaceChildren(new Option(label('Model default', '模型默认') +
      (reasoning?.defaultEffort ? ' · ' + (reasoning.efforts.find(e => e.id === reasoning.defaultEffort)?.name || reasoning.defaultEffort) : ''), ''));
    for (const item of reasoning?.efforts ?? []) effort.select.add(new Option(item.name || item.id, item.id));
    effort.row.hidden = !reasoning?.efforts.length;
    if (selected && Array.from(effort.select.options).some(o => o.value === selected)) effort.select.value = selected;
    else if (selected && options.has(model.select.value)) {
      status.textContent = label('The saved effort is unavailable. Choose a new effort or use the model default.', '已保存的推理强度不可用，可重新选择或使用模型默认值。');
    }
  }
  model.select.onchange = () => { apply.disabled = false; efforts(); };
  async function loadModels() {
    model.select.disabled = apply.disabled = true; retry.hidden = effort.row.hidden = true;
    options.clear();
    model.select.replaceChildren(new Option(fallback, ''));
    status.textContent = label('Loading DSH models…', '正在加载 DSH 模型…');
    try {
      const { groups, selected, failures } = await load();
      for (const group of groups) {
        const groupNode = document.createElement('optgroup'); groupNode.label = group.name || group.id;
        for (const entry of group.models) {
          const id = key(group.id, entry.id);
          options.set(id, { model: entry, selection: { provider: group.id, model: entry.id } });
          groupNode.append(new Option(entry.name || entry.id, id));
        }
        model.select.append(groupNode);
      }
      status.textContent = failures.length ? label('Unavailable providers', '暂不可用的提供商') + ' · ' + failures.map(p => p.name || p.id).join(', ')
        : !options.size ? label('DSH has no models available.', 'DSH 当前没有可用模型。') : '';
      retry.hidden = Boolean(options.size && !failures.length);
      if (selected) {
        const saved = key(selected.provider, selected.model);
        if (!options.has(saved)) {
          const missing = new Option(selected.model + ' · ' + label('unavailable', '不可用'), saved);
          missing.disabled = true; model.select.add(missing);
        }
        model.select.value = saved;
      }
      efforts(selected?.reasoningEffort);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : label('Could not load the DSH model catalog.', '无法加载 DSH 模型列表。');
      retry.hidden = false;
    }
    model.select.disabled = false;
    apply.disabled = Boolean(model.select.value && !options.has(model.select.value));
  }
  retry.onclick = () => void loadModels();
  form.onsubmit = async event => {
    event.preventDefault();
    if (apply.disabled) return;
    const choice = options.get(model.select.value)?.selection;
    apply.disabled = model.select.disabled = effort.select.disabled = retry.disabled = true;
    try { await save(choice ? { ...choice, ...(effort.select.value && { reasoningEffort: effort.select.value }) } : null); }
    catch (error) { status.textContent = error instanceof Error ? error.message : label('Could not save this model.', '无法保存此模型。'); }
    finally { apply.disabled = model.select.disabled = effort.select.disabled = retry.disabled = false; }
  };
  void loadModels();
  return form;
}
