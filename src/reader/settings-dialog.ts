import { DEFAULT_TARGET_LANGUAGE, TARGET_LANGUAGE_MAX_LENGTH, TARGET_LANGUAGE_PRESETS, findTargetLanguagePreset, parseTargetLanguage } from '../shared/languages.js';
import { researchText } from './research/labels.js';
import { api, bindTablist, button, byId, el, inputField, message, modal, readerLabel as label, toast, zoteroStatusText, type ReaderPort } from './ui.js';

const close = () => byId<HTMLDialogElement>('dialog').close();
const CUSTOM_LANGUAGE = '__custom__';
type SettingsTab = 'ai' | 'obsidian' | 'zotero' | 'academic';

function clearField(input: HTMLInputElement, text: string, visible: boolean): HTMLElement {
  const wrapper = el('label', 'check-row');
  wrapper.hidden = !visible;
  wrapper.append(input, text);
  return wrapper;
}

function tabPanel(id: string): HTMLDivElement {
  const panel = el('div');
  panel.id = id;
  panel.setAttribute('role', 'tabpanel');
  return panel;
}

export function settingsDialog(app: ReaderPort, focus: boolean | SettingsTab = 'ai', returnToLibrary?: () => void): void {
  const initialTab: SettingsTab = focus === true ? 'obsidian' : focus === false ? 'ai' : focus;
  const data = app.state.settings;
  const body = modal(returnToLibrary ? label('Zotero connection', 'Zotero 连接') : label('Connections', '连接设置'));
  const form = el('form');
  form.noValidate = true;

  const base = inputField(label('API base URL', 'API 接口地址'), data.baseUrl, 'url');
  const model = inputField(label('Model', '模型'), data.model);
  const key = inputField(label('API key', 'API 密钥'), '', 'password', data.hasApiKey ? label('Key saved', '已保存密钥') : label('Optional for local models', '本地模型可留空'));
  const currentLang = data.targetLanguage || DEFAULT_TARGET_LANGUAGE;
  const matchedPreset = findTargetLanguagePreset(currentLang);
  const langRow = el('label', 'field'), langSelect = el('select');
  for (const preset of TARGET_LANGUAGE_PRESETS) {
    const option = el('option', '', label(preset.labelEn, preset.labelZh));
    option.value = preset.id;
    langSelect.append(option);
  }
  const customOption = el('option', '', label('Custom…', '自定义…'));
  customOption.value = CUSTOM_LANGUAGE;
  langSelect.append(customOption);
  langSelect.value = matchedPreset ? matchedPreset.id : CUSTOM_LANGUAGE;
  langSelect.ariaLabel = label('Translation language', '翻译目标语言');
  langRow.append(el('span', '', label('Translation language', '翻译目标语言')), langSelect);

  const customLang = inputField(label('Custom target language', '自定义目标语言'), matchedPreset ? '' : currentLang, 'text', label('e.g. Portuguese, Italian, Arabic', '例如：葡萄牙语、意大利语、阿拉伯语'));
  customLang.input.maxLength = TARGET_LANGUAGE_MAX_LENGTH;
  const switchLanguage = () => {
    const custom = langSelect.value === CUSTOM_LANGUAGE;
    customLang.row.hidden = !custom;
    customLang.input.required = custom;
    customLang.input.disabled = !custom;
  };
  langSelect.onchange = switchLanguage;
  switchLanguage();

  const glossaryRow = el('label', 'field'), glossaryInput = el('textarea');
  glossaryInput.id = 'settingsGlossary';
  glossaryInput.rows = 3;
  glossaryInput.maxLength = 8000;
  glossaryInput.value = data.glossary ?? '';
  glossaryInput.placeholder = label('One entry per line: KV = key-value cache (term only to keep unchanged)', '每行一条：KV = 键值缓存（仅填术语则保留原文）');
  glossaryRow.append(el('span', '', label('Translation glossary', '翻译术语表')), glossaryInput);
  const glossaryHint = el('p', 'hint', label('Matched terms are locked during AI translation. Lines starting with # are ignored.', '翻译时会自动锁定匹配到的术语，以 # 开头的行会被忽略。'));
  const promptsDetails = el('details', 'settings-prompts');
  const promptsRow = el('label', 'field'), promptsInput = el('textarea');
  promptsInput.id = 'settingsCustomPrompts';
  promptsInput.rows = 4;
  promptsInput.maxLength = 8000;
  promptsInput.value = data.customPrompts ?? '';
  promptsInput.placeholder = label('One per line: Label | Prompt (prefix paper: or selection: to scope)', '每行一条：标签 | 提示词（可加 paper: 或 selection: 限定范围）');
  promptsRow.append(el('span', '', label('Prompt templates', '提示词模板')), promptsInput);
  promptsDetails.append(
    el('summary', '', label('Custom research prompts', '自定义学术提示词')),
    promptsRow,
    el('p', 'hint', label('Shown as 1-click chips in empty Paper chat and Selection chat. Lines starting with # are ignored.', '会在空的全文问答与选段讨论中显示为快捷提示词，以 # 开头的行会被忽略。'))
  );

  const vault = inputField(label('Obsidian vault folder', 'Obsidian 笔记库文件夹'), data.vaultPath, 'text', label('Absolute path to your vault', '填写 Obsidian 笔记库的绝对路径'));
  const id = inputField(label('Zotero library ID', 'Zotero 资料库 ID'), data.zoteroLibraryId);
  id.input.inputMode = 'numeric'; id.input.pattern = '[1-9][0-9]*'; id.input.maxLength = 24;
  const zotKey = inputField(label('Zotero API key', 'Zotero API 密钥'), '', 'password', data.hasZoteroKey ? label('Key saved', '已保存密钥') : label('Optional for public libraries', '公开资料库可留空'));
  const modeRow = el('label', 'field'), mode = el('select');
  for (const [value, name] of [['desktop', label('Desktop app on this computer', '本机 Zotero')], ['web', label('Web library', 'Zotero 网页资料库')]]) {
    const option = el('option', '', name); option.value = value; mode.append(option);
  }
  mode.value = data.zoteroMode ?? (data.zoteroLibraryId ? 'web' : 'desktop');
  modeRow.append(el('span', '', label('Zotero connection', '连接方式')), mode);

  const libraryType = el('label', 'field'), select = el('select');
  for (const [value, name] of [['user', label('Personal library', '个人资料库')], ['group', label('Group library', '群组资料库')]]) {
    const option = el('option', '', name); option.value = value; select.append(option);
  }
  select.value = data.zoteroLibraryType || 'user';
  libraryType.append(el('span', '', label('Library type', '资料库类型')), select);

  const clearModel = el('input'); clearModel.type = 'checkbox';
  const clearZot = el('input'); clearZot.type = 'checkbox';
  const arxivRow = el('label', 'field'), arxivSelect = el('select');
  arxivSelect.id = 'settingsArxivFormat';
  arxivSelect.ariaLabel = researchText.arxivFormat();
  for (const [value, name] of [['html', researchText.arxivHtmlDefault()], ['pdf', 'PDF']] as const) {
    const option = el('option', '', name); option.value = value; arxivSelect.append(option);
  }
  arxivSelect.value = data.arxivFormat === 'pdf' ? 'pdf' : 'html';
  arxivRow.append(el('span', '', researchText.arxivFormat()), arxivSelect);
  const oaEmail = inputField(label('OpenAlex email (polite pool)', 'OpenAlex 邮箱（高速通道）'), data.openAlexEmail ?? '', 'email', label('you@university.edu', '选填，例如：邮箱地址'));
  const oaKey = inputField(label('OpenAlex API key', 'OpenAlex API 密钥'), '', 'password', data.hasOpenAlexApiKey ? label('Key saved', '已保存密钥') : label('Optional', '选填'));
  const s2Key = inputField(label('Semantic Scholar API key', 'Semantic Scholar API 密钥'), '', 'password', data.hasSemanticScholarApiKey ? label('Key saved', '已保存密钥') : label('Optional', '选填'));
  const ncbiKey = inputField(label('NCBI / PubMed API key', 'NCBI / PubMed API 密钥'), '', 'password', data.hasNcbiApiKey ? label('Key saved', '已保存密钥') : label('Optional', '选填'));
  const clearOa = el('input'); clearOa.type = 'checkbox';
  const clearS2 = el('input'); clearS2.type = 'checkbox';
  const clearNcbi = el('input'); clearNcbi.type = 'checkbox';
  const status = data.aiMode === 'dsh'
    ? label('Using DSH: ' + (data.hostModel || data.hostProvider || 'host model'), '当前使用 DSH：' + (data.hostModel || data.hostProvider || '宿主模型'))
    : data.aiMode === 'api' ? label('Custom model configured', '已配置自定义模型')
      : label('Configure a model for new translations and follow-up questions.', '请配置模型以使用新译文与追问功能。');

  const webFields = el('div');
  const desktopHint = el('p', 'hint', label('Open Zotero and enable “Allow other applications on this computer to communicate with Zotero” in Settings → Advanced.', '打开 Zotero，在「设置 → 高级」中启用「允许此计算机上的其他应用程序与 Zotero 通信」。'));
  const keys = el('a', 'external', label('Zotero library IDs and API keys ↗', '查看 Zotero 资料库 ID 和密钥 ↗'));
  keys.href = 'https://www.zotero.org/settings/keys'; keys.target = '_blank'; keys.rel = 'noopener noreferrer';
  webFields.append(libraryType, id.row, zotKey.row, clearField(clearZot, label('Remove saved Zotero key', '移除已保存的 Zotero 密钥'), data.hasZoteroKey),
    el('p', 'hint', label('Enter a library ID to browse public items. Private libraries also need a key with read access.', '公开资料库填写 ID 即可浏览。私有资料库还需要具有读取权限的密钥。')), keys);

  const testLine = el('div', 'zotero-settings-test'), testResult = el('span');
  testResult.setAttribute('role', 'status');
  const zoteroSettings = () => ({
    zoteroMode: mode.value === 'desktop' ? 'desktop' as const : 'web' as const,
    zoteroLibraryType: select.value === 'group' ? 'group' as const : 'user' as const,
    zoteroLibraryId: id.input.value, zoteroApiKey: zotKey.input.value, clearZoteroKey: clearZot.checked
  });
  let testVersion = 0;
  const test = button(label('Test Zotero connection', '测试 Zotero 连接'), async () => {
    if (mode.value === 'web' && !id.input.reportValidity()) return;
    const version = ++testVersion;
    testResult.textContent = label('Checking library access…', '正在连接资料库…');
    try {
      const result = await api('zotero.status', zoteroSettings());
      if (version === testVersion) testResult.textContent = zoteroStatusText(result.detail);
    } catch (error) {
      if (version === testVersion) testResult.textContent = zoteroStatusText(message(error));
    }
  }, 'btn');
  testLine.append(test, testResult);

  const switchMode = () => {
    webFields.hidden = mode.value === 'desktop'; desktopHint.hidden = !webFields.hidden;
    id.input.required = !webFields.hidden; id.input.disabled = webFields.hidden;
  };
  mode.onchange = switchMode; switchMode();
  for (const field of [mode, select, id.input, zotKey.input, clearZot]) {
    field.addEventListener('input', () => { testVersion++; testResult.textContent = ''; });
  }

  let selectTab: ((key: SettingsTab, focusTab?: boolean) => void) | undefined;
  let advanced: HTMLDetailsElement | undefined;
  if (!returnToLibrary) {
    const tabs = el('div', 'tabs');
    tabs.setAttribute('aria-label', label('Connection sections', '连接设置分组'));
    const aiBtn = el('button', 'btn', label('AI & Translation', 'AI 与翻译')); aiBtn.id = 'settings-tab-ai';
    const aiPanel = tabPanel('settings-panel-ai');
    aiPanel.append(el('h3', '', label('Language model', '语言模型')), el('p', 'hint', status));
    const clearModelRow = clearField(clearModel, label('Remove saved model key', '移除已保存的模型密钥'), data.hasApiKey);
    if (data.aiMode === 'dsh') {
      advanced = el('details', 'settings-advanced');
      advanced.append(el('summary', '', label('Override with custom API', '使用自定义 API 覆盖')), base.row, model.row, key.row, clearModelRow);
      aiPanel.append(advanced);
    } else aiPanel.append(base.row, model.row, key.row, clearModelRow);
    aiPanel.append(langRow, customLang.row, glossaryRow, glossaryHint, promptsDetails);

    const obsidianBtn = el('button', 'btn', 'Obsidian'); obsidianBtn.id = 'settings-tab-obsidian';
    const obsidianPanel = tabPanel('settings-panel-obsidian');
    obsidianPanel.append(el('h3', '', 'Obsidian'), vault.row,
      el('p', 'hint', label('Choose a vault from the Obsidian desktop app. Paper Reader keeps each book’s chapter notes together in a folder.', '选择 Obsidian 桌面应用中的笔记库。Paper Reader 会将同一本书的章节笔记放在一个文件夹中。')));

    const zoteroBtn = el('button', 'btn', 'Zotero'); zoteroBtn.id = 'settings-tab-zotero';
    const zoteroPanel = tabPanel('settings-panel-zotero');
    zoteroPanel.append(el('h3', '', 'Zotero'), modeRow, desktopHint, webFields, testLine);

    const academicBtn = el('button', 'btn', label('Academic APIs', '学术图谱')); academicBtn.id = 'settings-tab-academic';
    const academicPanel = tabPanel('settings-panel-academic');
    academicPanel.append(
      el('h3', '', label('Academic graph APIs', '学术图谱接口')),
      el('p', 'hint', label('All citation graph features work keyless. Optional free keys raise rate limits.', '所有学术图谱功能默认免密钥可用，选填免费密钥可提高速率上限。')),
      arxivRow, oaEmail.row, oaKey.row, clearField(clearOa, label('Remove saved OpenAlex key', '移除已保存的 OpenAlex 密钥'), Boolean(data.hasOpenAlexApiKey)),
      s2Key.row, clearField(clearS2, label('Remove saved Semantic Scholar key', '移除已保存的 Semantic Scholar 密钥'), Boolean(data.hasSemanticScholarApiKey)),
      ncbiKey.row, clearField(clearNcbi, label('Remove saved NCBI key', '移除已保存的 NCBI 密钥'), Boolean(data.hasNcbiApiKey))
    );

    tabs.append(aiBtn, obsidianBtn, zoteroBtn, academicBtn);
    form.append(tabs, aiPanel, obsidianPanel, zoteroPanel, academicPanel);
    selectTab = bindTablist(tabs, [
      { key: 'ai', button: aiBtn, panel: aiPanel },
      { key: 'obsidian', button: obsidianBtn, panel: obsidianPanel },
      { key: 'zotero', button: zoteroBtn, panel: zoteroPanel },
      { key: 'academic', button: academicBtn, panel: academicPanel }
    ], initialTab);
  } else form.append(modeRow, desktopHint, webFields, testLine);

  const actions = el('div', 'dialog-footer');
  const save = el('button', 'btn primary', returnToLibrary ? label('Save connection', '保存连接') : label('Save connections', '保存连接设置'));
  save.type = 'submit'; actions.append(save);
  actions.append(returnToLibrary ? button(label('Back to library', '返回资料库'), returnToLibrary) : button(label('Cancel', '取消'), close, 'btn'));
  form.append(actions);

  form.onsubmit = async event => {
    event.preventDefault();
    const targetLanguage = langSelect.value === CUSTOM_LANGUAGE ? customLang.input.value : langSelect.value;
    if (!returnToLibrary) {
      if (base.input.value && !base.input.checkValidity()) {
        selectTab?.('ai'); if (advanced) advanced.open = true; base.input.reportValidity(); return;
      }
      const parsedLanguage = parseTargetLanguage(targetLanguage);
      if (!parsedLanguage.ok) { selectTab?.('ai'); customLang.input.focus(); toast(message(new Error(parsedLanguage.error))); return; }
      if (oaEmail.input.value && !oaEmail.input.checkValidity()) { selectTab?.('academic'); oaEmail.input.reportValidity(); return; }
    }
    if (mode.value === 'web' && !id.input.checkValidity()) { selectTab?.('zotero'); id.input.reportValidity(); return; }
    save.disabled = true;
    try {
      await api('settings.save', {
        ...(!returnToLibrary && {
          baseUrl: base.input.value, model: model.input.value, apiKey: key.input.value, targetLanguage, glossary: glossaryInput.value,
          customPrompts: promptsInput.value, vaultPath: vault.input.value, clearApiKey: clearModel.checked,
          openAlexEmail: oaEmail.input.value, openAlexApiKey: oaKey.input.value, clearOpenAlexApiKey: clearOa.checked,
          semanticScholarApiKey: s2Key.input.value, clearSemanticScholarApiKey: clearS2.checked, ncbiApiKey: ncbiKey.input.value, clearNcbiApiKey: clearNcbi.checked,
          arxivFormat: arxivSelect.value === 'pdf' ? 'pdf' as const : 'html' as const
        }),
        ...zoteroSettings()
      });
      await app.refresh();
      if (byId('refsTab').getAttribute('aria-selected') === 'true') app.repaintNotes();
      if (returnToLibrary) { if (form.isConnected && byId<HTMLDialogElement>('dialog').open) returnToLibrary(); }
      else { close(); toast(label('Connections saved.', '连接设置已保存。')); }
    } catch (error) { toast(message(error)); } finally { save.disabled = false; }
  };

  body.append(form);
  if (initialTab === 'zotero') mode.focus();
  else if (initialTab === 'obsidian') vault.input.focus();
  else if (initialTab === 'academic') arxivSelect.focus();
}
