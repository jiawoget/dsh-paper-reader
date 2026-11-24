import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import type { JournalNote, ReaderState } from '../../src/shared/types.js';
import { openReader, withHost } from './host.js';
import { dragAnswer } from './selection-gestures.js';

const firstQuestion = 'What does the paper say is difficult about deeper networks?';
const secondQuestion = 'How does the proposed framework address that problem?';
const noteBody = 'Compare the residual formulation with directly fitting the desired mapping.';
const revisedNote = noteBody + '\nCheck the plain-network baseline in Figure 1.';
const liveModel = process.env.PAPER_READER_LIVE_CHAT === '1';
const clean = (value: string) => value.replace(/(\p{L})-\r?\n(?=\p{Ll})/gu, '$1').replace(/\s+/gu, ' ').trim();

async function selection(page: Page): Promise<{ text: string; anchor: string }> {
  const runs = page.locator('#original .pdf-native-text [data-block-id]');
  const first = runs.filter({ hasText: 'Deeper neural networks' }).first();
  await first.scrollIntoViewIfNeeded();
  const anchor = await first.getAttribute('data-block-id');
  assert.ok(anchor);
  const text = await page.locator('#original .pdf-native-text [data-block-id="' + anchor + '"]').evaluateAll(elements => {
    const start = elements[0].firstChild;
    let end = start;
    for (const element of elements) {
      if (element.firstChild instanceof Text) {
        end = element.firstChild;
      }
    }
    if (!(start instanceof Text) || !(end instanceof Text)) throw new Error('PDF text runs are missing.');
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.length);
    const selected = window.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    elements[0].dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    return selected.toString();
  });
  return { text: clean(text), anchor };
}

function notes(page: Page): Promise<JournalNote[]> {
  return page.evaluate(async () => {
    const response = await fetch('../action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'state' }) });
    if (!response.ok) throw Error('The test notebook could not be read.');
    return ((await response.json()) as ReaderState).notes;
  });
}

async function closeSelection(card: Locator): Promise<void> {
  const closeWorkspace = card.getByRole('button', { name: 'Close passage workspace', exact: true });
  if (await closeWorkspace.isVisible()) await closeWorkspace.click();
  await card.getByRole('button', { name: 'Close selection', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
}

function openSelectionNotes(card: Locator, count: number): Promise<void> {
  return card.getByRole('button', { name: 'Notes (' + count + ')', exact: true }).click();
}

async function translatedTerm(reader: Page, anchor: string): Promise<void> {
  const target = reader.locator('#translated .pdf-translated-text[data-block-id="' + anchor + '"]');
  await target.waitFor({ timeout: 300_000 });
  const picked = await target.evaluate(node => {
    const text = node.firstChild;
    if (!(text instanceof Text)) throw Error('The imported paragraph lacks a translated text node.');
    const candidates = [...text.data.matchAll(/(?=(\p{Script=Han}{4}))/gu)];
    const group = candidates.find(item => text.data.indexOf(item[1]) !== item.index) ?? candidates[Math.floor(candidates.length / 3)];
    if (!group) throw Error('No four-character selection was available.');
    return { text: group[1], offset: group.index };
  });
  const select = async () => {
    await target.evaluate((node, pick) => {
      const range = document.createRange();
      range.setStart(node.firstChild!, pick.offset);
      range.setEnd(node.firstChild!, pick.offset + pick.text.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    }, picked);
    await reader.locator('#card').getByRole('heading', { name: picked.text, exact: true }).waitFor();
  };
  async function marked(): Promise<boolean> {
    return target.evaluate(async (node, pick) => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const range = document.createRange();
      range.setStart(node.firstChild!, pick.offset);
      range.setEnd(node.firstChild!, pick.offset + pick.text.length);
      const expected = [...range.getClientRects()].filter(r => r.width > .4);
      const marked = [...document.querySelectorAll('#translated .pdf-quote-mark')].map(el => el.getBoundingClientRect());
      const matches = expected.length > 0 && expected.length === marked.length && expected.every((r, i) =>
        Math.abs(r.left - marked[i].left) < 1.5 && Math.abs(r.top - marked[i].top) < 1.5 && Math.abs(r.width - marked[i].width) < 1.5);
      if (!matches) throw Error(JSON.stringify({ selected: pick, expected, marked, location: location.search }));
      return matches;
    }, picked);
  }
  const card = reader.locator('#card');
  await select();
  const broadMeaning = await card.locator('.meaning:visible').allTextContents();
  await reader.evaluate(() => window.getSelection()?.removeAllRanges());
  await card.getByRole('button', { name: 'Locate', exact: true }).click();
  assert.deepEqual({ visibleGlossCharacters: broadMeaning.join('').length, exactTargetHighlighted: await marked() },
    { visibleGlossCharacters: 0, exactTargetHighlighted: true },
    'An unaligned four-character selection must keep the surrounding English collapsed and return to the exact translated characters.');
  await select();
  await card.getByRole('button', { name: /^(Ask AI|Ask separately)$/ }).click();
  assert.ok(await card.getByRole('button', { name: 'Translate to English' }).isVisible());
  await card.getByRole('button', { name: 'Close chat' }).click();
  const details = card.locator('details').filter({ hasText: 'Original paragraph context' });
  assert.equal(await details.getAttribute('open'), null);
  await details.locator('summary').click();
  assert.ok((await details.locator('p').innerText()).length > 200);
  await details.locator('summary').click();
  await card.getByRole('button', { name: 'Save word' }).click();
  await card.getByRole('button', { name: 'Write note' }).click();
  await card.getByLabel('Your note', { exact: true }).fill('Revisit this Chinese term.');
  await card.getByRole('button', { name: 'Save note', exact: true }).click();
  await card.getByText('Note saved.', { exact: true }).waitFor();
  const note = (await notes(reader)).find(entry => entry.text === 'Revisit this Chinese term.');
  assert.ok(note && note.context === picked.text && note.quote.length > 200);
  await closeSelection(card);
  await reader.getByRole('button', { name: 'Original', exact: true }).click();
  await reader.getByRole('button', { name: 'Original', exact: true, pressed: true }).waitFor();
  await reader.locator('#loading').waitFor({ state: 'hidden' });
  await reader.locator('.source-chip[data-note-id="' + note.id + '"]').click();
  await reader.waitForURL(url => url.searchParams.get('anchor') === anchor && url.searchParams.get('targetQuote') === picked.text);
  await reader.locator('#loading').waitFor({ state: 'hidden' });
  await reader.getByRole('button', { name: 'Bilingual', exact: true, pressed: true }).waitFor();
  await reader.locator('#translated .pdf-quote-mark').first().waitFor();
  assert.ok(await marked(), 'Following a translated note from the original-only view must reveal its four characters.');
  await reader.goto(note.sourceUrl);
  await target.waitFor();
  await reader.locator('#translated .pdf-quote-mark').first().waitFor();
  assert.ok(await marked(), 'The saved link must repaint the target after the imported translation is loaded.');
  const vocabulary = await reader.evaluate(async () => (await (await fetch('../action', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'state' }) })).json() as ReaderState).vocabulary);
  assert.equal(vocabulary.find(word => word.text === picked.text)?.meaning, '');
  await reader.getByRole('button', { name: 'More actions' }).click();
  await reader.getByRole('button', { name: 'Vocabulary and history' }).click();
  await reader.getByRole('dialog').locator('.list-row').filter({hasText:picked.text}).getByRole('button', { name: note.title }).click();
  await reader.getByRole('dialog').waitFor({state:'hidden'});
  assert.ok(await marked(), 'The vocabulary source must return to the same translated occurrence.');
}

interface Exchange { text: string; context: string; question: string; answerQuote?: string; history: { role: string; content: string }[] }
async function controlledProvider() {
  const requests: Exchange[] = [];
  const answers = [
    'A **residual block** learns the difference between the target mapping and its input.\n\n\\[ F(x) = H(x) - x \\]\n\n' +
    '- The shortcut carries the input \\(x\\).\n- Two paths are summed using \x60add\x60. See the [original paper](https://arxiv.org/abs/1512.03385) and **[34, 49]**.',
    'The shortcut preserves the input while the learned layers adjust the mapping.',
    'Changing only the residual can make an identity mapping easier to fit.',
    'The identity path passes information directly through the block.'
  ];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input: Exchange & { blocks?: { id: string; text: string }[] } = JSON.parse(body.messages[1].content);
    if (input.blocks) {
      const translations: Record<string,string> = {};
      for (const block of input.blocks) {
        if (block.text === 'Residual learning') translations[block.id] = '\u6b8b\u5dee\u5b66\u4e60';
        else if (block.text.includes('The researchers compare a network')) translations[block.id] =
          '\u66f4\u6df1\u7684\u795e\u7ecf\u7f51\u7edc\u66f4\u96be\u8bad\u7ec3\u3002\u7814\u7a76\u4eba\u5458\u6bd4\u8f83\u4e24\u79cd\u795e\u7ecf\u7f51\u7edc\u3002\u5feb\u6377\u8fde\u63a5\u4f20\u9012\u8f93\u5165\u3002';
        else { res.writeHead(400).end(); return; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        choices: [{ finish_reason:'stop', message:{role:'assistant',content:JSON.stringify({translations})} }]
      }));
      return;
    }
    requests.push(input);
    if (requests.length === 2) { res.writeHead(429).end(); return; }
    const answer = input.question ? answers[requests.length === 1 ? 0 : Math.min(requests.length - 2, answers.length - 1)]
      : /^abstract$/iu.test(input.text) ? '\u6458\u8981' : '\u6b8b\u5dee\u5b66\u4e60';
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }]
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = server.address();
  assert.ok(endpoint && typeof endpoint === 'object');
  return { requests, answers, url: 'http://127.0.0.1:' + endpoint.port + '/v1',
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function pickAnswer(page: Page, answerIndex: number, css: string): Promise<string> {
  const answer = page.locator('.selection-answer').nth(answerIndex);
  const text = await answer.locator(css).first().evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selected = document.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    return selected.toString();
  });
  await page.getByRole('group', { name: 'Selected answer text' }).waitFor();
  return text;
}

async function repeatedEnglish(reader: Page, anchor: string): Promise<void> {
  const card = reader.locator('#card'), body = 'Check this occurrence of network.';
  const rows = reader.locator('#original .pdf-native-text [data-block-id="' + anchor + '"]');
  const select = async (occurrence: number) => {
    await rows.evaluateAll((elements, wanted) => {
      let index = 0;
      for (const element of elements) {
        const node = element.firstChild;
        if (!(node instanceof Text)) continue;
        for (const match of node.data.matchAll(/network/giu)) {
          if (index++ !== wanted) continue;
          const range = document.createRange();
          range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
          element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
          return;
        }
      }
      throw Error('The selected paragraph needs two occurrences of the term.');
    }, occurrence);
    await card.getByRole('heading', { name: /^network$/i }).waitFor();
  };
  for (const occurrence of [0, 1]) {
    await select(occurrence);
    await card.getByRole('button', { name: 'Write note' }).click();
    await card.getByRole('textbox', { name: 'Your note' }).fill(body);
    await card.getByRole('button', { name: 'Save note' }).click();
    await card.getByText('Note saved.', { exact: true }).waitFor();
    assert.equal(await card.locator('.selection-saved-note').count(), 1);
    await closeSelection(card);
  }
  const created = (await notes(reader)).filter(note => note.text === body);
  assert.equal(created.length, 2);
  const offsets = created.map(note => Number(new URL(note.sourceUrl).searchParams.get('rangeStart')));
  assert.notEqual(offsets[0], offsets[1]);
  await select(0);
  await openSelectionNotes(card, 1);
  const first = offsets[0] < offsets[1] ? created[0] : created[1];
  await card.locator('.selection-saved-note[data-note-id="' + first.id + '"]').waitFor();
  assert.equal(await card.locator('.selection-saved-note').count(), 1);
}

async function translateWord(reader: Page): Promise<void> {
  const source = reader.locator('#original .pdf-native-text [data-block-id]').filter({ hasText: /^(Abstract|Residual learning)$/iu }).first();
  const id = await source.getAttribute('data-block-id');
  const target = reader.locator('#translated .pdf-translated-text[data-block-id="' + id + '"]');
  const card = reader.locator('#card');
  for (const [index, node] of [source, target].entries()) {
    await node.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element.firstChild!);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    });
    await card.getByRole('heading', { name: (await node.innerText()).trim(), exact: true }).waitFor();
    if (index === 0) {
      await card.getByRole('button', { name: 'Ask AI' }).click();
      assert.equal(await card.getByRole('button', { name: 'Translate to Chinese' }).count(), 0);
    }
    await card.getByRole('button', { name: 'Save word' }).click();
    await closeSelection(card);
  }
  const vocabulary = await reader.evaluate(async () => ((await (await fetch('../action', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'state' }) })).json()) as ReaderState).vocabulary);
  const term = (await target.innerText()).trim();
  assert.equal(vocabulary.find(word => word.text === term)?.meaning, (await source.innerText()).trim(),
    'A saved Chinese term must use the English counterpart even when its shared chat previously translated the English term.');
}

async function legacyNote(reader: Page): Promise<void> {
  const url = new URL(reader.url());
  url.search = new URLSearchParams({ doc: 'pagedattention', page: '6' }).toString();
  await reader.goto(url.href);
  await reader.getByRole('button', { name: 'Bilingual', exact: true }).click();
  const block = reader.locator('#translated .pdf-translated-text[data-block-id="block-tables"]');
  await block.waitFor();
  const card = reader.locator('#card');
  const offset = 12;
  const picked = await block.evaluate((node, at) => {
    document.getSelection()?.removeAllRanges();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return node.firstChild!.textContent!.slice(at, at + 20);
  }, offset);
  const original = await card.locator('.selection-counterpart p').textContent();
  assert.ok(original && original.length > 180);
  const noteText = 'Check this earlier Chinese annotation against the paper.';
  await reader.evaluate(async ({ text, quote, selected, at }) => {
    const source = new URL(location.href);
    source.searchParams.set('anchor', 'block-tables');
    source.searchParams.set('quote', quote.slice(0, 240));
    source.searchParams.set('targetQuote', selected);
    source.searchParams.set('targetOffset', String(at));
    const response = await fetch('../action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'note.save', payload: { docId: 'pagedattention', title: 'PagedAttention.pdf', page: 6,
        anchor: 'block-tables', label: 'Left column', text, quote, context: selected, sourceUrl: source.href } }) });
    if (!response.ok) throw Error('Could not seed the earlier linked note.');
  }, { text: noteText, quote: original, selected: picked, at: offset });
  await reader.reload();
  await block.evaluate((node, at) => {
    const range = document.createRange();
    range.setStart(node.firstChild!, at); range.setEnd(node.firstChild!, at + 20);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  }, offset);
  await openSelectionNotes(card, 1);
  await card.getByText(noteText, { exact: true }).waitFor();
  const aligned = await card.locator('.selection-counterpart p').textContent();
  assert.ok(aligned && aligned.length < original.length, 'This edition must now align the chosen text to a narrower English passage.');
  assert.equal(await card.getByRole('button', { name: 'Edit', exact: true }).count(), 1);
  assert.equal(await card.getByRole('textbox', { name: 'Your note' }).count(), 0);
}

async function liveConversation(reader: Page, reviewDir: string): Promise<void> {
  const settings = await reader.evaluate(async () => ((await (await fetch('../action', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'state' }) })).json()) as ReaderState).settings);
  assert.equal(settings.aiMode, 'dsh', 'The installed DSH model must be available for the live conversation.');
  assert.equal(settings.vaultPath, '', 'The live acceptance note belongs in the isolated reader.');
  assert.equal((await notes(reader)).length, 0);
  const card = reader.locator('#card');
  const prefix = 'Compare “', placeholder = 'this idea', suffix = '” with the plain-network baseline.';
  const initial = prefix + placeholder + suffix;
  await card.getByRole('button', { name: 'Write note' }).click();
  const editor = card.getByRole('textbox', { name: 'Your note', exact: true });
  await editor.fill(initial);
  await editor.press('Control+Home');
  for (const _ of prefix) await reader.keyboard.press('ArrowRight');
  for (const _ of placeholder) await reader.keyboard.press('Shift+ArrowRight');
  assert.deepEqual(await editor.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]),
    [prefix.length, prefix.length + placeholder.length]);
  await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
  assert.equal(await card.getByRole('button', { name: /explain/i }).count(), 0);
  const input = card.getByRole('textbox', { name: 'Message about this selection' });
  await input.fill('In two brief sentences, what does a residual block learn? Bold the key term and show one display equation for the residual.');
  await input.press('Enter');
  const answer = card.locator('.selection-answer').first();
  const error = card.getByRole('alert');
  await Promise.race([answer.waitFor({ timeout: 120_000 }), error.waitFor({ timeout: 120_000 }).then(async () => {
    throw Error('The installed DSH model returned an error. ' + await error.innerText());
  })]);
  const math = answer.locator('.katex-display').first();
  await math.waitFor();
  await math.scrollIntoViewIfNeeded();
  const excerpt = await dragAnswer(reader, answer.locator('strong').filter({ hasNot: reader.locator('.katex') }).first());
  const actions = card.getByRole('group', { name: 'Selected answer text' });
  await actions.getByRole('button', { name: 'Insert into note' }).click();
  const composed = prefix + excerpt + suffix;
  assert.equal(await editor.inputValue(), composed);
  assert.equal((await notes(reader)).length, 0);
  await editor.press('Control+z');
  assert.equal(await editor.inputValue(), initial);
  await editor.press('Control+Shift+z');
  assert.equal(await editor.inputValue(), composed);
  await editor.evaluate((field: HTMLTextAreaElement, range) => field.setSelectionRange(range.start, range.end),
    { start: prefix.length, end: prefix.length + excerpt.length });
  const save = card.getByRole('button', { name: 'Save note', exact: true });
  await save.scrollIntoViewIfNeeded();
  await reader.evaluate(() => document.fonts.ready);
  await reader.screenshot({ path: path.join(reviewDir, 'selection-draft-live.png'), animations: 'disabled' });
  await save.click();
  await card.getByText('Note saved.', { exact: true }).waitFor();
  const saved = await notes(reader);
  assert.equal(saved.length, 1); assert.equal(saved[0].text, composed);
  await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await actions.getByRole('button', { name: 'Ask follow-up' }).click();
  assert.equal(await card.locator('.chat-composer blockquote').innerText(), excerpt);
  await input.fill('How does this affect the identity mapping?');
  await input.press('Enter');
  await card.locator('.selection-answer').nth(1).waitFor({ timeout: 120_000 });
  assert.ok((await card.locator('.selection-answer').nth(1).innerText()).trim().length > 20);
  await reader.reload();
  const again = await selection(reader);
  await openSelectionNotes(card, 1);
  await card.locator('.selection-saved-note[data-note-id="' + saved[0].id + '"]').waitFor();
  assert.deepEqual((await notes(reader)).map(note => [note.id, note.text, note.quote]), [[saved[0].id, composed, again.text]]);
  console.log('PASS live conversation with ' + settings.hostProvider + ' / ' + settings.hostModel +
    ': inserted ' + JSON.stringify(excerpt) + ' into a partially written note, preserved both sides and undo/redo, ' +
    'checked one explicit save after reload, displayed the equation and received the quoted follow-up.');
}

await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable, headless: process.env.PAPER_READER_HEADED !== '1' });
  const provider = await controlledProvider();
  try {
    const context = await browser.newContext({ viewport: { width: 1390, height: 860 }, deviceScaleFactor: 1, locale: 'en-US' });
    const shell = await context.newPage();
    const pane = await openReader(shell, host.authenticatedUrl);
    const reader = await context.newPage();
    reader.setDefaultTimeout(12_000);
    const errors: string[] = [];
    reader.on('pageerror', error => errors.push(error.message));
    await reader.goto(await pane.locator('body').evaluate(body => body.ownerDocument.location.href));
    await reader.locator('#original .pdf-native-text [data-block-id]').first().waitFor();
    const localPdf = process.env.PAPER_READER_SELECTION_PDF;
    if (liveModel) assert.ok(localPdf, 'Set PAPER_READER_SELECTION_PDF for the live provider check.');
    let pdf = localPdf;
    if (!pdf) {
      await reader.getByRole('button', { name: 'More actions' }).click();
      await reader.getByRole('button', { name: 'Connections', exact: true }).click();
      await reader.getByRole('dialog').getByLabel('API base URL').fill(provider.url);
      await reader.getByRole('dialog').getByRole('button', { name: 'Save connections' }).click();
      await reader.getByRole('dialog').waitFor({state:'hidden'});
      const fixture = await context.newPage();
      await fixture.setContent('<style>@page{size:letter;margin:1in}main{width:370px;font:16px Georgia}aside{break-before:page}</style><main><h1>Residual learning</h1><p>Deeper neural networks are more difficult to train. The researchers compare a network that directly learns a mapping with another that learns a residual function. A shortcut connection carries the input forward. Their experiments compare deep residual networks against plain networks of equal depth. The discussion examines training error and the optimization of deeper architectures.</p></main><aside><h2>References</h2><p>[34] B. D. Ripley. Pattern recognition and neural networks. Cambridge university press, 1996.</p><p>[49] W. Venables and B. Ripley. Modern applied statistics with s-plus. 1999.</p></aside>');
      pdf = path.join(host.scratch, 'Selection research fixture.pdf');
      await fixture.pdf({ path: pdf, preferCSSPageSize: true });
      await fixture.close();
    }
    await reader.getByRole('button', { name: 'Open library' }).click();
    const [chooser] = await Promise.all([reader.waitForEvent('filechooser'), reader.getByRole('button', { name: 'Open a PDF' }).click()]);
    await chooser.setFiles(pdf);
    await reader.getByRole('dialog').waitFor({ state: 'hidden' });
    await reader.getByRole('button', { name: 'Bilingual', exact: true }).click();
    await reader.getByRole('button', { name: 'Show notes', exact: true }).click();
    await reader.getByRole('tab', { name: 'Notes', exact: true }).click();
    const selected = await selection(reader);
    assert.ok(selected.text.length > 200);
    const card = reader.locator('#card');
    await card.waitFor();
    const title = await card.getByRole('heading', { level: 2 }).innerText();
    assert.ok(title.length < 50 && !selected.text.startsWith(title), 'A passage needs a short descriptive heading, separate from its quotation.');
    assert.equal(await card.getByRole('button', { name: 'Save word' }).count(), 0);
    const preview = card.locator('blockquote').first();
    assert.ok((await preview.innerText()).length < selected.text.length);
    await card.getByRole('button', { name: 'Show full passage' }).click();
    assert.equal(await preview.innerText(), selected.text);
    await card.getByRole('button', { name: 'Show less' }).click();
    const reviewDir = path.join(host.artifacts, liveModel ? 'reviews/reading-desk' : 'reviews/floating-workspace');
    if (localPdf) {
      await mkdir(reviewDir, { recursive: true });
      await reader.waitForFunction(() => !document.querySelector('#translated .pdf-translation-state[data-state="pending"]:not([hidden]), #translated .pdf-translation-state[data-state="loading"]:not([hidden])'),
        undefined, { timeout: 200_000 });
    }
    if (liveModel) {
      await liveConversation(reader, reviewDir);
      assert.deepEqual(errors, []);
      return;
    }
    await card.getByRole('button', { name: 'Write note' }).click();
    const editor = card.getByRole('textbox', { name: 'Your note', exact: true });
    await editor.fill(noteBody);
    await card.getByRole('button', { name: 'Save note' }).click();
    await card.getByText('Note saved.', { exact: true }).waitFor();
    assert.equal(await editor.count(), 0, 'A saved note must leave the editor and its Save control.');
    const rail = reader.getByRole('textbox', { name: 'Notes Markdown' });
    await rail.getByText(noteBody, { exact: true }).waitFor();
    const [initial] = await notes(reader);
    assert.equal(initial.quote, selected.text);
    assert.equal(initial.anchor, selected.anchor);
    const backlink = new URL(initial.sourceUrl);
    assert.equal(backlink.searchParams.get('doc'), initial.docId);
    assert.equal(backlink.searchParams.get('page'), '1');
    assert.ok(backlink.searchParams.get('quote'), 'Long passages still need a locator in their source link.');
    await closeSelection(card);
    await selection(reader);
    await openSelectionNotes(card, 1);
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await editor.inputValue(), noteBody);
    await editor.fill(revisedNote);
    await card.getByRole('button', { name: 'Save note' }).click();
    await rail.getByText('Check the plain-network baseline in Figure 1.', { exact: false }).first().waitFor();
    const updated = await notes(reader);
    assert.deepEqual(updated.map(note => [note.id, note.text, note.quote]), [[initial.id, revisedNote, selected.text]]);

    // A second editor commits an actual update through the host while the card holds a different draft.
    const myDraft = revisedNote + '\nCompare the training curves.';
    const otherText = 'Another reader tab updated this note.';
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.fill(myDraft);
    await reader.evaluate(async ({ current, text }) => {
      const response = await fetch('../action', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'note.save', payload: { ...current, text, expectedUpdatedAt: current.updatedAt } }) });
      if (!response.ok) throw Error('The concurrent test edit failed.');
    }, { current: updated[0], text: otherText });
    await card.getByRole('button', { name: 'Save note' }).click();
    await card.getByRole('alert').getByText(otherText, { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), myDraft);
    assert.equal((await notes(reader))[0].text, otherText);
    await card.getByRole('button', { name: 'Keep my draft' }).click();
    await card.getByRole('button', { name: 'Save note' }).click();
    await card.getByText('Note saved.', { exact: true }).waitFor();
    assert.deepEqual((await notes(reader)).map(note => [note.id, note.text]), [[initial.id, myDraft]]);

    await card.getByRole('button', { name: 'Add another note' }).click();
    const secondNote = 'The identity shortcut makes the unchanged mapping easy to express.';
    await editor.fill(secondNote);
    await card.getByRole('button', { name: 'Save note' }).click();
    await rail.getByText(secondNote, { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Edit', exact: true }).count(), 2);
    assert.equal(await card.getByRole('button', { name: 'Save note', exact: true }).count(), 0);
    if (localPdf) await reader.screenshot({ path: path.join(reviewDir, 'saved-selection-notes.png'), animations: 'disabled' });
    const paired = reader.locator('#translated .pdf-translated-text[data-block-id="' + selected.anchor + '"]');
    await paired.waitFor();
    await paired.evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node.firstChild!);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    });
    await openSelectionNotes(card, 2);
    await card.getByText(secondNote, { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Edit', exact: true }).count(), 2,
      'Reopening the entire paired translation must restore both saved notes.');

    await rail.getByText(secondNote, { exact: true }).click();
    await reader.keyboard.press('End');
    await reader.keyboard.type(' Compare a plain block.');
    await reader.keyboard.press('Control+s');
    await card.locator('.selection-saved-note').filter({ hasText: 'Compare a plain block.' }).waitFor();

    // An explicitly unconfigured endpoint exercises the same UI on machines with or without a DSH model.
    await reader.getByRole('button', { name: 'More actions' }).click();
    await reader.getByRole('button', { name: 'Connections', exact: true }).click();
    const dialog = reader.getByRole('dialog');
    await dialog.getByLabel('API base URL').fill('https://reader-selection-test.invalid/v1');
    await dialog.getByRole('button', { name: 'Save connections' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await selection(reader);
    await card.getByRole('button', { name: 'Ask AI' }).click();
    assert.equal(await card.getByRole('button', { name: /explain/i }).count(), 0, 'Once discussion is open, the composer handles follow-ups.');
    const question = card.getByRole('textbox', { name: 'Message about this selection' });
    await question.fill(firstQuestion);
    await card.getByText(/connect a model/i).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
    await card.getByRole('button', { name: 'Connections', exact: true }).click();
    await dialog.getByLabel('API base URL').fill(provider.url);
    await dialog.getByRole('button', { name: 'Save connections' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await question.inputValue(), firstQuestion);
    const send = card.getByRole('button', { name: 'Send', exact: true });
    await send.click();
    const log = card.getByRole('log', { name: 'Selection chat history' });
    await log.locator('strong').getByText('residual block', { exact: true }).waitFor();
    assert.equal(await log.locator('.katex-display').count(), 1);
    assert.equal(await log.locator('.katex').count(), 2);
    assert.equal(await log.locator('.selection-answer li').count(), 2);
    assert.equal(await log.locator('code').textContent(), 'add');
    assert.equal(await log.getByRole('link', { name: 'original paper' }).getAttribute('href'), 'https://arxiv.org/abs/1512.03385');
    assert.equal(await card.getByRole('button', { name: 'Translate to Chinese' }).count(), 0);
    await log.getByRole('button', { name: 'References 34, 49', exact: true }).focus();
    const references = reader.getByRole('tooltip');
    await references.getByText('Pattern recognition and neural networks', { exact: true }).waitFor();
    await references.getByText('Modern applied statistics with s-plus', { exact: true }).waitFor();
    await reader.keyboard.press('Escape');
    await references.waitFor({ state: 'hidden' });
    await question.fill(secondQuestion);
    await question.press('Enter');
    const problem = card.getByRole('alert');
    await problem.getByText(/rate-limited/).waitFor();
    assert.equal(await question.inputValue(), secondQuestion);
    assert.ok(await log.getByText(firstQuestion, { exact: true }).isVisible());
    const unsent = 'Which experiment would test that explanation?';
    await question.fill(unsent);
    await card.getByRole('button', { name: 'Retry', exact: true }).click();
    await log.getByText(provider.answers[1], { exact: true }).waitFor();
    assert.equal(await question.inputValue(), unsent, 'Retrying a failed turn must preserve a different unsent message.');
    assert.equal(await log.getByText(secondQuestion, { exact: true }).count(), 1);
    assert.deepEqual(provider.requests.map(input => input.text), Array(3).fill(selected.text));
    assert.ok(provider.requests[0].context.includes('Deeper neural networks'));
    assert.deepEqual(provider.requests.map(input => input.question), [firstQuestion, secondQuestion, secondQuestion]);
    assert.deepEqual(provider.requests[1].history, [{ role: 'user', content: firstQuestion }, { role: 'assistant', content: provider.answers[0] }]);
    assert.deepEqual(provider.requests[2].history, provider.requests[1].history);

    const unsavedNote = 'Check the optimization argument against Figure 1.';
    await openSelectionNotes(card, 2);
    await card.getByRole('button', { name: 'Add another note' }).click();
    await editor.fill(unsavedNote);
    await editor.press('End');
    await reader.keyboard.type('!');
    const peerNote = (await notes(reader))[0];
    const peerText = peerNote.text + '\nThe other tab added a reading question.';
    await reader.evaluate(async ({ note, text }) => {
      const response = await fetch('../action', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'note.save', payload: { ...note, text, expectedUpdatedAt: note.updatedAt } }) });
      if (!response.ok) throw Error('The competing saved-note edit failed.');
      window.dispatchEvent(new Event('focus'));
    }, { note: peerNote, text: peerText });
    await card.locator('.selection-saved-note').getByText('The other tab added a reading question.', { exact: false }).waitFor();
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), unsavedNote, 'Refreshing saved notes must preserve the active draft and its undo history.');
    await editor.press('Control+Home');
    for (const _ of 'Check the ') await reader.keyboard.press('ArrowRight');
    for (const _ of 'optimization') await reader.keyboard.press('Shift+ArrowRight');
    assert.deepEqual(await editor.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]), [10, 22]);
    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const excerpt = await dragAnswer(reader, log.locator('.selection-answer').first().locator('strong').first());
    const quoteBar = card.getByRole('group', { name: 'Selected answer text' });
    const countBeforeInsert = (await notes(reader)).length;
    const insert = quoteBar.getByRole('button', { name: 'Insert into note' });
    assert.ok(await insert.isVisible(), 'An answer excerpt should be insertable into the active draft.');
    await insert.click();
    const composed = 'Check the ' + excerpt + ' argument against Figure 1.';
    assert.equal(await editor.inputValue(), composed);
    assert.equal((await notes(reader)).length, countBeforeInsert);
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), unsavedNote);
    await editor.press('Control+Shift+z');
    assert.equal(await editor.inputValue(), composed);
    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    assert.equal(await card.getByRole('button', { name: 'Translate to Chinese' }).count(), 0);
    await quoteBar.getByRole('button', { name: 'Ask follow-up' }).click();
    assert.equal(await question.inputValue(), '');
    const quotedQuestion = 'Why is this easier to optimize?';
    await question.fill(quotedQuestion);
    const drafts = card.getByRole('combobox', { name: 'Question drafts' });
    await drafts.selectOption('paper');
    assert.equal(await question.inputValue(), unsent);
    await pickAnswer(reader, 0, 'strong');
    await quoteBar.getByRole('button', { name: 'Ask follow-up' }).click();
    assert.equal(await question.inputValue(), quotedQuestion);
    await question.press('Enter');
    await log.getByText(provider.answers[2], { exact: true }).waitFor();
    assert.equal(provider.requests[3].answerQuote, excerpt);
    assert.equal(provider.requests[3].text, selected.text);
    assert.equal(provider.requests[3].history.length, 4);
    assert.equal(await question.inputValue(), unsent);
    const anotherExcerpt = await pickAnswer(reader, 2, 'p');
    await quoteBar.getByRole('button', { name: 'Ask follow-up' }).click();
    await question.fill('Which path preserves the input?');
    await question.press('Enter');
    await log.getByText(provider.answers[3], { exact: true }).waitFor();
    assert.equal(provider.requests[4].answerQuote, anotherExcerpt);
    assert.ok(provider.requests[4].history[4].content.includes(excerpt));
    await openSelectionNotes(card, 2);
    await editor.evaluate((field: HTMLTextAreaElement) => {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
    await editor.press('End');
    await editor.press('Enter');
    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await pickAnswer(reader, 0, '.katex-display .katex-html');
    await insert.click();
    const withMath = composed + '\n$$\nF(x) = H(x) - x\n$$';
    assert.equal(await editor.inputValue(), withMath);
    assert.equal((await notes(reader)).length, countBeforeInsert);
    await card.getByRole('button', { name: 'Save note', exact: true }).click();
    await card.getByText('Note saved.', { exact: true }).waitFor();
    const clipped = (await notes(reader)).filter(note => note.text === withMath);
    assert.equal(clipped.length, 1);
    assert.equal(clipped[0].sourceUrl, initial.sourceUrl);
    assert.equal((await notes(reader)).length, countBeforeInsert + 1);
    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await pickAnswer(reader, 0, 'strong');
    await insert.click();
    assert.equal(await editor.inputValue(), excerpt, 'Inserting with no active draft opens an editable selection note.');
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await notes(reader)).length, countBeforeInsert + 1);
    await card.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await pickAnswer(reader, 0, 'strong');
    await closeSelection(card);
    await selection(reader);
    if (!(await log.isVisible())) await card.getByRole('button', { name: 'Ask AI' }).click();
    await log.getByText(provider.answers[3], { exact: true }).waitFor();
    await openSelectionNotes(card, 3);
    await card.locator('.selection-saved-note').filter({ hasText: composed }).locator('.katex-display').waitFor();
    await reader.setViewportSize({ width: 390, height: 700 });
    await reader.getByRole('button', { name: 'Close notes', exact: true }).click();
    await reader.getByRole('button', { name: 'Original', exact: true }).click();
    await selection(reader);
    await card.getByRole('button', { name: 'Ask AI' }).click();
    await card.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const mobile = await card.boundingBox();
    assert.ok(mobile && mobile.x >= 0 && mobile.y >= 0 && mobile.x + mobile.width <= 390 && mobile.y + mobile.height <= 700);
    assert.equal(await question.inputValue(), unsent);
    await reader.setViewportSize({ width: 1390, height: 860 });
    await reader.getByRole('button', { name: 'Bilingual', exact: true }).click();
    await reader.getByRole('button', { name: 'Show notes', exact: true }).click();
    await repeatedEnglish(reader, selected.anchor);
    await translatedTerm(reader, selected.anchor);
    await translateWord(reader);
    await legacyNote(reader);
    assert.deepEqual(errors, []);
    console.log('PASS selection workspace: independent bilingual notes, undoable excerpt insertion at a saved selection, explicit saves, Markdown math, follow-up history, draft recovery, mobile and exact source navigation. Chat used a controlled HTTP provider on an isolated DSH host.');
  } finally { await browser.close(); await provider.close(); }
}, {}, { installedModelProfile: liveModel });
