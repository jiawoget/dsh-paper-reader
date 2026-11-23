import type { Settings } from '../shared/types.js';
import { questionModelForm } from '../shared/question-model-form.js';
import type { ReaderPort } from './panels.js';
import { api, byId, el, icon, modal, readerLabel as label } from './ui.js';

export const questionConnected = (settings: Settings) => Boolean(settings.questionModel) || settings.aiMode !== 'unconfigured';

export function questionModelButton(app: ReaderPort) {
  const button = el('button', 'text-btn question-model-trigger'), caption = el('span');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.append(icon('settings', 13), caption);
  const defaultName = () => app.state.settings.aiMode === 'dsh' ? app.state.settings.hostModel :
    app.state.settings.aiMode === 'api' ? app.state.settings.model : undefined;
  function refresh() {
    const choice = app.state.settings.questionModel;
    caption.textContent = [choice?.model || defaultName() || label('Choose model', '选择模型'), choice?.reasoningEffort].filter(Boolean).join(' · ');
    button.ariaLabel = button.title = [label('Question model', '问答模型'), choice?.provider, caption.textContent].filter(Boolean).join(' · ');
  }
  button.onclick = () => {
    const panel = modal(label('Question model', '问答模型'));
    const form = questionModelForm({ label, defaultName: defaultName(), load: () => api('ai.models', {}),
      save: async questionModel => {
        const saved = await api('ai.selectModel', { questionModel });
        app.state.settings.questionModel = saved.questionModel;
        refresh();
        if (form.isConnected) byId<HTMLDialogElement>('dialog').close();
        await app.refresh();
      }
    });
    panel.append(form);
  };
  refresh();
  return { button, refresh };
}
