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
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Aborted')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true });
  });
  ctx.llm.registerAdapter([provider], {
    providerInfo: () => ({ id: provider, name: 'Offline test models' }),
    providerRetryPolicy: () => undefined,
    listModels: () => models, resolveModel,
    prepareCall: (route, id) => ({
      model: resolveModel(route, id),
      async *stream({ provider, model, reasoningEffort, system, messages, signal }) {
        const prompt = JSON.stringify([system ?? '', messages ?? '']);
        if (prompt.includes('slow-stream-markdown')) {
          const chunks = ['### Key **Result**\n\nFirst ', 'paragraph with `code`.\n\n', '- Item one\n- Item two'];
          let full = '';
          yield { type: 'block-start', index: 0, blockType: 'text' };
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) await delay(450, signal);
            full += chunks[i];
            yield { type: 'text-delta', index: 0, text: chunks[i] };
          }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: full } };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        if (prompt.includes('Extract structured review-table cells') || prompt.includes('Screen the supplied paper')) {
          const isPaged = prompt.includes('PagedAttention'), isExt = prompt.includes('Extract structured review-table cells');
          if (isExt && !isPaged) await delay(650, signal);
          const text = isExt ? JSON.stringify({ cells: {
            research_question: { value: isPaged ? 'Eliminate KV-cache fragmentation' : 'Reduce attention memory I/O', quote: isPaged ? 'The KV block manager also maintains block tables' : 'IO-aware exact attention', page: isPaged ? 6 : null, reasoning: 'Core problem.' },
            method: { value: isPaged ? 'PagedAttention block KV cache' : 'Abstract method', quote: isPaged ? 'The KV block manager also maintains block tables' : 'IO-aware exact attention', page: isPaged ? 6 : null, reasoning: 'Extracted from source.' },
            key_findings: { value: '2-4x higher serving throughput', quote: 'fabricated unverified quote string', page: isPaged ? 6 : null, reasoning: 'Headline finding.' },
            datasets: { value: 'ShareGPT, Alpaca', quote: 'fabricated unverified quote string', page: isPaged ? 6 : null, reasoning: 'Datasets listed.' },
            key_metrics: { value: '2-4x throughput', quote: '', page: null, reasoning: 'Throughput metric.' },
            main_result: { value: 'Near-zero KV waste', quote: '', page: null, reasoning: 'Main result.' },
            limitations: { value: 'Single-node focus', quote: '', page: null, reasoning: 'Scope limit.' }
          } }) : JSON.stringify({ criteria: {
            llm_serving: { decision: isPaged ? 'yes' : 'maybe', quote: isPaged ? 'The KV block manager also maintains block tables' : '', page: isPaged ? 6 : null, reasoning: 'Serving focus.' },
            open_weights: { decision: isPaged ? 'no' : 'yes', quote: '', page: null, reasoning: 'Weights check.' }
          } });
          yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
        }
        const text = prompt.includes('Cite exact page numbers as (p. N)')
          ? '### Structured Brief\n\nPagedAttention manages KV blocks efficiently (p. 2).'
          : [provider, model, reasoningEffort || 'default'].join(' / ');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })
  });
}
