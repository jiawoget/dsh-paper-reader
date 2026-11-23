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
      async *stream({ provider, model, reasoningEffort }) {
        const text = [provider, model, reasoningEffort || 'default'].join(' / ');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })
  });
}
