import type { ChatExchange, ChatRequest, ChatSource, PaperEvidence } from '../shared/types.js';
import { ReaderStore } from './reader-store.js';
import { ReaderModel } from './reader-model.js';
import { address, inputObject, isObject, pageNumber, ServiceError, single, stringValue, type Input } from './service-types.js';

function threadId(value: unknown): string {
  if (value === 'paper' || typeof value === 'string' && /^selection-[a-f0-9]{64}$/.test(value)) return value;
  throw new ServiceError(400, 'Invalid conversation.');
}

function chatSource(input: unknown, docId: string): ChatSource | undefined {
  if (input === undefined) return;
  const source = inputObject(input);
  if (source.docId !== docId || source.side !== 'source' && source.side !== 'translation') throw new ServiceError(400, 'This selection belongs to another document.');
  return { docId, title: stringValue(source.title, 'document title', 2048), page: pageNumber(source.page),
    anchor: single(source.anchor, 'passage anchor', 4096), label: stringValue(source.label, 'label', 512),
    sourceUrl: address(source.sourceUrl), original: stringValue(source.original, 'original passage', 100_000),
    selected: stringValue(source.selected, 'selection', 100_000, true), context: stringValue(source.context, 'context', 120_000), side: source.side };
}

function evidence(value: unknown): PaperEvidence {
  const input = inputObject(value), pageCount = pageNumber(input.pageCount);
  if (!Array.isArray(input.excerpts) || !input.excerpts.length || input.excerpts.length > 5000) throw new ServiceError(400, 'The document needs searchable text to answer questions.');
  let size = 0;
  const excerpts = input.excerpts.map(item => {
    const block = inputObject(item), page = pageNumber(block.page), text = stringValue(block.text, 'document evidence', 128_000, true);
    size += text.length;
    if (page > pageCount || size > 128_000) throw new ServiceError(400, 'Check the size and page numbers of the paper excerpts.');
    return { page, text };
  });
  return { title: stringValue(input.title, 'document title', 2048, true), pageCount, partial: input.partial === true, excerpts };
}

export class PaperDiscussions {
  private pending = new Map<string, { signature: string; result: Promise<{ text: string }> }>();
  constructor(private store: ReaderStore, private model: ReaderModel) {}
  history(input: Input): { exchanges: ChatExchange[] } {
    return { exchanges: this.store.chatHistory(single(input.docId, 'document ID', 512, true), input.thread === undefined ? undefined : threadId(input.thread)) };
  }
  ask(input: Input): Promise<{ text: string }> {
    return this.record(input, 'paper', async request => {
      const history = this.store.chatHistory(request.docId).slice(-12).map(turn => ({
        question: turn.question.slice(0, 4000), answer: turn.answer.slice(0, 6000), passage: turn.source?.selected.slice(0, 1500), page: turn.source?.page
      }));
      const paper = evidence(input.paper);
      const reply = await this.model.paper(this.store.settings(), paper, history, request);
      return { ...reply, coverage: { pageCount: paper.pageCount, pagesUsed: new Set(paper.excerpts.map(e => e.page)).size, partial: paper.partial } };
    });
  }
  passage(input: Input): Promise<{ text: string }> {
    if (input.record === undefined) return this.model.passage(this.store.settings(), input);
    const record = inputObject(input.record), thread = threadId(record.thread);
    if (thread === 'paper' || !isObject(record.source)) throw new ServiceError(400, 'A selection conversation needs a passage.');
    return this.record(record, thread, () => this.model.passage(this.store.settings(), input));
  }
  private record(input: Input, thread: string, complete: (request: ChatRequest) => Promise<{ text: string; coverage?: ChatExchange['coverage'] }>): Promise<{ text: string }> {
    const docId = single(input.docId, 'document ID', 512, true), requestId = single(input.requestId, 'message ID', 36, true);
    if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(requestId)) throw new ServiceError(400, 'Invalid message ID.');
    const question = stringValue(input.question, 'question', 16_000, true), source = chatSource(input.source, docId);
    const answerQuote = input.answerQuote === undefined ? undefined : stringValue(input.answerQuote, 'quoted answer', 100_000, true);
    const answerTurn = typeof input.answerTurn === 'number' && Number.isSafeInteger(input.answerTurn) && input.answerTurn >= 0 ? input.answerTurn : undefined;
    const request = { docId, requestId, thread, question, source, answerQuote, answerTurn };
    const identity = (entry: typeof request | ChatExchange) => JSON.stringify([entry.docId, entry.thread, entry.question, entry.source, entry.answerQuote, entry.answerTurn]);
    const signature = identity(request);
    const verify = (same: boolean) => { if (!same) throw new ServiceError(409, 'This message ID was used for a different question.'); };
    const previous = this.store.chatExchange(requestId);
    if (previous) { verify(identity(previous) === signature); return Promise.resolve({ text: previous.answer }); }
    const pending = this.pending.get(requestId);
    if (pending) { verify(pending.signature === signature); return pending.result; }
    const result = complete(request).then(reply => {
      const saved = this.store.saveExchange({ ...request, answer: reply.text, createdAt: new Date().toISOString(), coverage: reply.coverage });
      verify(identity(saved) === signature);
      return { text: saved.answer };
    }).finally(() => this.pending.delete(requestId));
    this.pending.set(requestId, { signature, result });
    return result;
  }
}
