import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServices } from '../src/server/services.js';
import type { QuestionModel } from '../src/shared/types.js';

test('questions use the exact DSH provider, model and opaque effort across restarts and concurrent choices', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = { provider: 'second', model: 'same-model-id', reasoningEffort: 'deliberate-v2' };
  const first = { provider: 'first', model: selected.model };
  const reasoning = { efforts: [{ id: selected.reasoningEffort, name: 'Deliberate' }], defaultEffort: selected.reasoningEffort };
  const groups = [first, selected].map(({ provider, model }) => ({ id: provider, name: provider, models: [
    { id: model, name: 'Reader', ...(provider === 'second' && { reasoning }) }
  ] }));
  let secondAvailable = true;
  const packets: QuestionModel[] = [];
  const ctx = {
    sessionController: { modelCatalog: async () => ({ groups, failures: [{ id: 'offline', name: 'Offline', message: 'private detail' }] }) },
    agentDefaultModel: { currentSelection: () => selected },
    llm: {
      listProviders: () => groups,
      listModels: (id: string) => groups.filter(g => g.id === id && (id !== 'second' || secondAvailable))
        .flatMap(g => g.models.map(m => ({ id: m.id, name: m.name, inputModalities: ['text'] }))),
      resolveModelInfo: async (id: string, model: string) => groups.find(g => g.id === id)?.models.find(m => m.id === model),
      async *stream(packet: QuestionModel) {
        const { provider, model, reasoningEffort } = packet;
        packets.push({ provider, model, ...(reasoningEffort && { reasoningEffort }) });
        yield { type: 'text-delta', text: provider };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  };
  let apiCalls = 0;
  const options = { root, ctx, fetchImpl: async () => {
    apiCalls++;
    return Response.json({ choices: [{ message: { content: 'reader endpoint' }, finish_reason: 'stop' }] });
  } };
  const act = createServices(options);
  const passage = { mode: 'followup', text: 'Read', question: 'Why?' };
  const paper = { title: 'Review', pageCount: 1, partial: false, excerpts: [{ page: 1, text: 'Example' }] };
  const ask = { docId: 'review', requestId: randomUUID(), paper, question: 'Why?' };
  assert.deepEqual(await act('ai.models'), { groups, failures: [{ id: 'offline', name: 'Offline' }], selected: undefined });
  await act('ai', passage);
  assert.deepEqual(packets.pop(), selected, 'The DSH deployment default includes the provider and effort.');
  await act('settings.save', { baseUrl: 'http://127.0.0.1:48961', model: 'manual-reader' });
  await act('ai.selectModel', { questionModel: selected });
  await act('settings.save', { zoteroMode: 'desktop' });
  const reopen = createServices(options);
  assert.deepEqual((await reopen('state')).settings.questionModel, selected);
  assert.deepEqual((await reopen('ai.models')).selected, selected);
  assert.deepEqual(await reopen('chat.ask', ask), { text: selected.provider });
  assert.deepEqual(await reopen('ai', { ...passage, mode: 'explain' }), { text: selected.provider });
  const [explicit, inherited] = await Promise.all([
    reopen('ai', { ...passage, questionModel: first }), reopen('chat.searchTerms', { question: 'Why?' })
  ]);
  assert.deepEqual([explicit.text, inherited.text], ['first', 'second']);
  assert.deepEqual(packets.filter(p => p.provider === 'second'), Array(3).fill(selected));
  assert.deepEqual(packets.filter(p => p.provider === 'first'), [first]);
  assert.equal(apiCalls, 0);
  assert.deepEqual(await reopen('ai', { ...passage, questionModel: null }), { text: 'reader endpoint' });
  assert.deepEqual(await reopen('ai', { mode: 'translate', text: 'text' }), { text: 'reader endpoint' });

  const count = packets.length;
  const invalidSelections = [{ ...first, reasoningEffort: selected.reasoningEffort }, { ...first, provider: 'missing' }];
  for (const invalid of invalidSelections) {
    await assert.rejects(reopen('ai.selectModel', { questionModel: invalid }), { status: 409 });
    await assert.rejects(reopen('ai', { ...passage, questionModel: invalid }), { status: 409 });
  }
  secondAvailable = false;
  await assert.rejects(reopen('chat.ask', { ...ask, requestId: randomUUID() }), { status: 409 });
  assert.deepEqual((await reopen('state')).settings.questionModel, selected);
  assert.equal(packets.length, count);
  assert.equal(apiCalls, 2, 'A disappearing host route must never send the question to the manual endpoint.');
  await reopen('ai.selectModel', { questionModel: null });
  assert.deepEqual(await act('ai', passage), { text: 'reader endpoint' });

  const deltas: string[] = [];
  const streamed = await reopen('ai', { ...passage, questionModel: first }, { onDelta: chunk => deltas.push(chunk) });
  assert.equal(streamed.text, 'first');
  assert.deepEqual(deltas, ['first']);
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(reopen('ai', { ...passage, questionModel: first }, { signal: canceled.signal }), { status: 499 });
});
