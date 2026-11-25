import { readSelectionRange, readTranslatedLocator } from '../shared/source-link.js';
import { api, bindTablist, button, byId, el, modal, readerLabel as label, safeWeb, type ReaderPort } from './ui.js';

const close = () => byId<HTMLDialogElement>('dialog').close();

export function collectionsDialog(app: ReaderPort, tab: 'vocabulary' | 'history' = 'vocabulary'): void {
  const body = modal(label('Vocabulary and history', '生词与历史'));
  let activeTab: 'vocabulary' | 'history' = tab;
  const tabs = el('div', 'tabs'), panel = el('div');
  tabs.setAttribute('aria-label', label('Collection view', '收藏视图'));
  panel.id = 'collections-panel'; panel.setAttribute('role', 'tabpanel');

  const query = el('input', 'search');
  query.type = 'search'; query.placeholder = label('Find a word or passage', '搜索词语或段落');
  query.setAttribute('aria-label', query.placeholder);

  const vocabBtn = el('button', 'btn', label('Vocabulary', '生词'));
  vocabBtn.id = 'collections-tab-vocabulary'; vocabBtn.setAttribute('aria-controls', panel.id);
  const historyBtn = el('button', 'btn', label('History', '历史'));
  historyBtn.id = 'collections-tab-history'; historyBtn.setAttribute('aria-controls', panel.id);
  const tabButtons = new Map<'vocabulary' | 'history', HTMLButtonElement>([['vocabulary', vocabBtn], ['history', historyBtn]]);
  tabs.append(vocabBtn, historyBtn);

  const display = () => {
    panel.replaceChildren();
    const records = app.state[activeTab].filter(w => (w.text + ' ' + w.meaning + ' ' + w.title).toLowerCase().includes(query.value.toLowerCase()));
    if (!records.length) {
      panel.append(el('p', 'hint', query.value ? label('No matching entries.', '没有找到符合条件的记录。')
        : activeTab === 'history' ? label('Your lookups appear here.', '你的查词和提问记录会显示在这里。')
          : label('Save words from a selection card.', '在选区卡片中收藏词语后，会显示在这里。')));
    }
    for (const [rowIndex, word] of records.entries()) {
      const line = el('div', 'list-row');
      line.append(el('strong', '', word.text));
      if (word.meaning) line.append(el('p', '', word.meaning));
      else if (word.context) {
        const detail = el('details', 'selection-counterpart');
        detail.append(el('summary', '', label('Passage context', '上下文')), el('p', '', word.context));
        line.append(detail);
      }
      const actions = el('div', 'row');
      actions.append(button(word.title || label('Open source', '打开出处'), async () => {
        if (word.docId) {
          const url = URL.canParse(word.sourceUrl) ? new URL(word.sourceUrl) : undefined;
          await app.navigate(word.docId, word.page, word.anchor, url?.searchParams.get('quote') || word.text, url && readTranslatedLocator(url), url && readSelectionRange(url));
          close();
        } else { const link = safeWeb(word.sourceUrl); if (link) window.open(link, '_blank', 'noopener'); }
      }, 'text-btn', 'arrow'));
      if (activeTab === 'vocabulary') {
        actions.append(button(label('Remove', '移除'), async () => {
          await api('vocab.delete', { id: word.id });
          await app.refresh();
          display();
          const remaining = panel.querySelectorAll<HTMLElement>('.list-row');
          const nextRow = remaining[Math.min(rowIndex, remaining.length - 1)];
          (nextRow?.querySelector<HTMLElement>('button:last-of-type') ?? tabButtons.get(activeTab))?.focus({ preventScroll: true });
        }, 'subtle'));
      }
      line.append(actions); panel.append(line);
    }
  };

  body.append(tabs, query, panel);
  query.addEventListener('input', display);
  const selectTab = bindTablist(tabs, [{ key: 'vocabulary', button: vocabBtn }, { key: 'history', button: historyBtn }], activeTab, key => {
    activeTab = key; panel.setAttribute('aria-labelledby', tabButtons.get(key)!.id); display();
  });
  selectTab(activeTab, true);
}
