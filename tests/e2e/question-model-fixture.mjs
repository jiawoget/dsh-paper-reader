// Register two offline models with the real DSH catalog and echo the resolved call.
export const inject = ['llm'];
export function apply(ctx) {
  const provider = 'reader-test';
  const models = [
    { provider, id: 'plain', name: 'Plain model', inputModalities: ['text'] },
    { provider, id: 'reasoner', name: 'Reasoning model', inputModalities: ['text'],
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
  ];
  const resolveModel = (_, id) => models.find(model => model.id === id);
  ctx.llm.registerAdapter([provider], {
    providerInfo: () => ({ id: provider, name: 'Offline test models' }),
    providerRetryPolicy: () => undefined,
    listModels: () => models, resolveModel,
    prepareCall: (route, id) => ({
      model: resolveModel(route, id),
      async *stream({ provider, model, reasoningEffort, messages, signal }) {
        const prompt = JSON.stringify(messages ?? '');
        if (prompt.includes('slow-stream-markdown')) {
          const chunks = ['### Key **Result**\n\nFirst ', 'paragraph with `code`.\n\n', '- Item one\n- Item two'];
          let full = '';
          yield { type: 'block-start', index: 0, blockType: 'text' };
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) {
              await new Promise((resolve, reject) => {
                if (signal?.aborted) { reject(new Error('Aborted')); return; }
                const timer = setTimeout(resolve, 450);
                signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true });
              });
            }
            full += chunks[i];
            yield { type: 'text-delta', index: 0, text: chunks[i] };
          }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: full } };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        const text = [provider, model, reasoningEffort || 'default'].join(' / ');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })
  });
}
