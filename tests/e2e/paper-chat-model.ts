import { createServer } from 'node:http';

/** Reject requests unless the actual imported document, selection and follow-up history reach the model. */
export async function startModel() {
  const server = createServer(async (req, res) => {
    const pieces: Buffer[] = [];
    for await (const piece of req) pieces.push(Buffer.from(piece));
    const envelope = JSON.parse(Buffer.concat(pieces).toString()), data = JSON.parse(envelope.messages[1].content);
    let answer = '';
    if (!data.paper && data.text?.toLowerCase() === 'residual') answer = 'A residual is the difference a block learns.';
    if (data.paper?.pageCount === 12 && data.paper.excerpts.some((part: { page: number; text: string }) =>
      part.page === 12 && /Table\s+14[.]/.test(part.text) && /8[.]9\s+9[.]0/.test(part.text))) {
      if (data.question.startsWith('In Table 14') && data.selection?.page === 2 && data.selection.selected.toLowerCase() === 'residual') {
        answer = 'Table 14 reports **8.9%** validation error and **9.0%** test error (p. 12).';
      }
      if (data.question.startsWith('Which of') && !data.selection && data.history?.some((turn: {answer: string}) => turn.answer.includes('8.9%'))) {
        answer = 'The test localization error was **9.0%** (p. 12).';
      }
    }
    res.writeHead(answer ? 200 : 422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Model listener unavailable.');
  return { origin: 'http://127.0.0.1:' + address.port, close: () => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())) };
}
