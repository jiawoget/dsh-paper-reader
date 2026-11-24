import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import type { Operations } from '../../src/shared/types.js';
import { withHost, type HostFixture } from './host.js';

const docId = 'pagedattention';
const title = 'PagedAttention.pdf';
const question = '这个截图中块表的箭头指向什么？';
const sentence = '块表将逻辑块映射到物理块。';
const remainder = '截图中的箭头指向相应的物理块。';
const answer = sentence + remainder;
const followup = '在同一截图上，查表后还需要读取什么？';
const followupAnswer = '还需要读出对应物理块中存放的键和值。';
const words = 'each request';
const textQuestion = '这个选段里的 request 指什么？';
const textAnswer = '这里指一次需要独立缓存上下文的推理请求。';
const mixedQuestion = '把这句原文和图 6 放在一起看，块表属于谁？';
const mixedAnswer = '每个请求用自己的块表查找物理块。';
const readerText = '看原文时先独立思考。\n\n这里预留下一条阅读记录。';

interface ModelPart { type: string; text?: string; image_url?: { url?: string } }
interface ModelRequest {
  question: string;
  text?: string;
  history?: { role: string; content: string }[];
  image?: string;
}

async function discussionModel(hold: boolean) {
  const key = randomUUID(), model = 'discussion-continuity-fixture';
  const replies = new Map([[question, answer], [followup, followupAnswer], [textQuestion, textAnswer], [mixedQuestion, mixedAnswer]]);
  const gates = new Map([question, followup].map(value => [value, {
    reached: Promise.withResolvers<ModelRequest>(), release: Promise.withResolvers<void>()
  }]));
  const calls: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== 'Bearer ' + key) { response.writeHead(403).end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string; messages: { role: string; content: string | ModelPart[] }[]
      };
      const input = envelope.messages.find(message => message.role === 'user')?.content;
      const json = typeof input === 'string' ? input : input?.find(part => part.type === 'text')?.text;
      if (envelope.model !== model || !json) { response.writeHead(400).end(); return; }
      const image = Array.isArray(input) ? input.find(part => part.type === 'image_url')?.image_url?.url : undefined;
      const payload = { ...JSON.parse(json), image } as ModelRequest;
      const reply = replies.get(payload.question);
      if (!reply || ((payload.question !== textQuestion) !== Boolean(image?.startsWith('data:image/png;base64,')))) {
        response.writeHead(422).end(); return;
      }
      calls.push(payload);
      const gate = gates.get(payload.question);
      gate?.reached.resolve(payload);
      if (hold && gate) await gate.release.promise;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { key, model, calls, gates, origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>(resolve => {
      for (const gate of gates.values()) gate.release.resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    }) };
}

async function action<K extends keyof Operations>(page: Page, host: HostFixture, op: K, payload: Operations[K][0]): Promise<Operations[K][1]> {
  const response = await page.request.post(host.origin + '/api/paper-reader/action', { data: { op, payload } });
  assert.ok(response.ok(), op + ' returned HTTP ' + response.status());
  return response.json();
}

async function drawCrop(page: Page, figureNumber = 6, intent = '提问'): Promise<void> {
  await page.locator('#captureRegion').click();
  const figure = page.locator('#original .pdf-figure[data-block-id="figure-' + figureNumber + '"]');
  await figure.scrollIntoViewIfNeeded();
  const area = await figure.boundingBox();
  assert.ok(area, 'The figure being captured must be visible.');
  await page.mouse.move(area.x + area.width * .08, area.y + area.height * .18);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * .59, area.y + area.height * .75, { steps: 12 });
  await page.mouse.up();
  await page.locator('.pdf-capture-actions').getByRole('button', { name: intent, exact: true }).click();
}

async function visibleClick(page: Page, locator: Locator): Promise<void> {
  // The PDF adds interactive overlays above the raster. Choose an actual exposed point.
  const point = await locator.evaluate(element => {
    const area = element.getBoundingClientRect();
    for (const horizontal of [.03, .97, .06, .93, .12, .88]) {
      for (const vertical of [.10, .19, .27, .40, .58, .72, .86]) {
        const x = area.left + area.width * horizontal, y = area.top + area.height * vertical;
        const target = document.elementFromPoint(x, y);
        if (target?.closest('#paperScroll') && !target.closest('[data-block-id], #card, button, #rail') &&
          target.closest('#original, #translated') === element.closest('#original, #translated')) return { x, y };
      }
    }
    return undefined;
  });
  assert.ok(point, 'An exposed non-interactive page point must be clickable.');
  await page.mouse.click(point.x, point.y);
}

async function dragText(page: Page, run: Locator, words: string): Promise<void> {
  await run.scrollIntoViewIfNeeded();
  const points = await run.evaluate((element, phrase) => {
    const node = element.firstChild;
    if (!(node instanceof Text)) throw Error('A visible PDF text run is required.');
    const index = node.data.indexOf(phrase);
    if (index < 0) throw Error('The PDF text run did not contain ' + phrase);
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + phrase.length);
    const bounds = range.getBoundingClientRect();
    return { left: bounds.left + .4, right: bounds.right - .4, y: bounds.top + bounds.height / 2 };
  }, words);
  await page.mouse.move(points.left, points.y);
  await page.mouse.down();
  await page.mouse.move(points.right, points.y, { steps: 10 });
  await page.mouse.up();
}

async function afterPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const evidenceLabel = process.argv[2] ?? '回归';
const baselineProbes = process.argv.includes('--baseline-probes');
const sameReply = process.argv.includes('--same-reply-probe');
const returnLocation = process.argv.includes('--return-location-probe');
const returnInColumn = process.argv.includes('--column');
await withHost(async host => {
  const browser = await chromium.launch({ executablePath: host.executable });
  const model = await discussionModel(!baselineProbes);
  const evidence = path.join(host.artifacts, 'reviews', 'reader-journeys', evidenceLabel);
  const entry = host.origin + '/api/paper-reader/app/index.html?doc=' + docId + '&page=6';
  try {
    await mkdir(evidence, { recursive: true });
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(12_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const photo = (name: string) => page.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled' });
    const chat = page.locator('.selection-chat:visible');
    const card = page.locator('#card');
    const history = page.getByRole('region', { name: '全文问答' });
    const figure = page.locator('#original .pdf-figure[data-block-id="figure-6"]');
    const sourceRun = (words: string) => page.locator('#original .pdf-native-text [data-block-id="block-tables"]').filter({ hasText: words }).first();
    const translated = page.locator('#translated .pdf-translated-text[data-block-id="block-tables"]').filter({ hasText: /逻辑/ });
    const getBook = () => action(page, host, 'notebook.get', { docId, title, sourceUrl: entry });
    const getHistory = () => action(page, host, 'chat.history', { docId });
    const questionRow = (value: string) => history.locator('.paper-chat-question').filter({ hasText: value });
    const answerRow = (value: string) => history.locator('.paper-chat-reply').filter({ hasText: value });
    const showHistory = async () => {
      if (!(await history.getByRole('textbox').isVisible())) await history.getByRole('button', { name: '全文问答', exact: true }).click();
    };
    await page.goto(host.authenticatedUrl);
    await action(page, host, 'settings.save', { baseUrl: model.origin + '/v1', apiKey: model.key, model: model.model });
    if (sameReply) {
      const book = await getBook();
      await action(page, host, 'notebook.write', { docId, title, sourceUrl: entry, expectedRevision: book.revision, markdown: readerText });
    }
    await page.goto(entry);
    await figure.waitFor();
    const browserScript = await page.request.get(host.origin + '/api/paper-reader/app/app.js');
    assert.ok(browserScript.ok());
    const browserDigest = createHash('sha256').update(await browserScript.body()).digest('hex');
    const serverDigest = createHash('sha256').update(await readFile('dist/server/index.js')).digest('hex');
    console.log(JSON.stringify({ chrome: browser.version(), browserDigest, serverDigest }));
    let highlight: Locator | undefined;
    if (baselineProbes) {
      const words = 'the mapping between logical';
      await dragText(page, sourceRun(words), words);
      await card.getByRole('button', { name: '高亮', exact: true }).click();
      highlight = page.locator('#original .annotation-highlight').first();
      await highlight.waitFor({ state: 'attached' });
    }
    await drawCrop(page);
    const field = chat.getByRole('textbox');
    await field.fill(question);
    if (!baselineProbes) {
      await visibleClick(page, page.locator('#original .pdf-raster'));
      assert.equal(await field.inputValue(), question, 'The first unsent screenshot question must survive a blank-paper click.');
      await sourceRun(words).click();
      assert.equal(await field.inputValue(), question, 'A click on ordinary English text must preserve the first unsent screenshot question.');
      await figure.click();
      assert.equal(await field.inputValue(), question, 'A casual figure click must preserve the first unsent screenshot question.');
      await page.locator('#parallel').click();
      await translated.click();
      assert.equal(await field.inputValue(), question, 'A click on translated text must preserve the first unsent screenshot question.');
      await page.locator('#originalMode').click();
      await page.reload();
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await showHistory();
      await history.locator('summary').filter({ hasText: '未发送的追问' }).click();
      await history.getByRole('button', { name: new RegExp(question) }).click();
      await field.waitFor();
      assert.equal(await field.inputValue(), question, 'A first question must remain recoverable in the same tab before any answer exists.');
      assert.equal(model.calls.length, 0);
      assert.deepEqual((await getHistory()).exchanges, []);
      await photo('00-刷新后找回未发送的首问');
    }
    await field.press('Enter');
    if (!baselineProbes) {
      await chat.getByText('正在回答…', { exact: true }).waitFor();
      await figure.click();
      await chat.getByText('正在回答…', { exact: true }).waitFor();
      const first = model.gates.get(question)!;
      await Promise.race([first.reached.promise, page.waitForTimeout(12_000).then(() => {
        if (!model.calls.some(call => call.question === question)) throw Error('The loopback model did not receive the first screenshot.');
      })]);
      first.release.resolve();
    }
    await chat.getByText(answer, { exact: true }).waitFor();
    const original = (await getHistory()).exchanges.find(turn => turn.question === question);
    assert.ok(original?.source);
    const originalSource = original.source;
    assert.ok(originalSource.anchor.startsWith('region-'));
    assert.equal(model.calls.length, 1);
    await photo('01-截图刚回答');

    if (returnLocation) {
      await page.locator('#next').click();
      await page.waitForURL(url => url.searchParams.get('page') === '7');
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await page.locator('#parallel').click();
      await page.locator('#zoom').selectOption('1.25');
      if (returnInColumn) await page.locator('#translationMode').selectOption('column');
      await showHistory();
      const paper = page.locator('#paperScroll');
      await paper.evaluate(node => {
        node.scrollTo({ top: 185, left: 32, behavior: 'instant' });
        document.getElementById('translated')?.scrollTo({ top: 113, behavior: 'instant' });
      });
      const position = () => paper.evaluate(node => ({ page: new URL(location.href).searchParams.get('page'),
        mode: document.getElementById('reader')?.dataset.readingMode,
        translationScope: document.getElementById('reader')?.dataset.translationView,
        top: node.scrollTop, left: node.scrollLeft,
        translationTop: document.getElementById('translated')?.scrollTop }));
      const before = await position();
      console.log(JSON.stringify({ before }));
      assert.equal(before.mode, 'bilingual');
      assert.ok(before.top > 0);
      if (returnInColumn) assert.ok(before.translationTop && before.translationTop > 0, 'The selected translated column must have measurable independent scroll.');
      await photo('02-跳转前第7页双语位置');
      await history.getByRole('button', { name: '继续问这张截图', exact: true }).click();
      await page.waitForURL(url => url.searchParams.get('page') === '6');
      await chat.getByText(answer, { exact: true }).waitFor();
      assert.equal(await chat.locator('img').getAttribute('src'), model.calls[0].image);
      await chat.getByRole('button', { name: '收起讨论', exact: true }).click();
      await page.waitForURL(url => url.searchParams.get('page') === '7');
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await history.getByRole('textbox').waitFor();
      await page.waitForFunction(({ top, left, translationTop }) => {
        const reader = document.getElementById('paperScroll')!;
        const translation = document.getElementById('translated')!;
        return Math.abs(reader.scrollTop - top) <= 1 && Math.abs(reader.scrollLeft - left) <= 1 &&
          Math.abs(translation.scrollTop - (translationTop ?? 0)) <= 1;
      }, before);
      const after = await position();
      assert.equal(after.mode, before.mode);
      assert.equal(after.translationScope, before.translationScope);
      console.log(JSON.stringify({ before, after, historyRestored: true, recoveredExactCrop: true }));
      await photo('03-收起讨论后的实际阅读位置');
      await history.getByRole('button', { name: '全文问答', exact: true }).click();
      await page.locator('#originalMode').click();
      await drawCrop(page, 8, '接着问');
      const comparison = '图 8 里的箭头和上一页图 6 中的一样吗？';
      await field.fill(comparison);
      await field.press('Home');
      await field.press('ArrowRight');
      await chat.locator('.followup-material').getByRole('button', { name: '图 6', exact: true }).click();
      await page.waitForURL(url => url.searchParams.get('page') === '6');
      await page.getByRole('button', { name: '返回讨论', exact: true }).click();
      await page.waitForURL(url => url.searchParams.get('page') === '7');
      await field.waitFor();
      assert.equal(await field.inputValue(), comparison);
      assert.equal(await field.evaluate(input => (input as HTMLTextAreaElement).selectionStart), 1);
      assert.equal(model.calls.length, 1, 'Inspecting earlier evidence and returning must not send the draft.');
      console.log('从图 8 回图 6 核对，返回同一追问及停笔处。');
      await chat.getByRole('button', { name: '移除刚加入的材料' }).click();
      await page.waitForURL(url => url.searchParams.get('page') === '6');
      await chat.getByText(answer, {exact:true}).waitFor();
      await dragText(page, sourceRun(words), words);
      await card.getByRole('button', { name: '接着问', exact: true }).click();
      await field.fill(mixedQuestion);
      await field.press('Enter');
      await chat.getByText(mixedAnswer, {exact:true}).waitFor();
      const mixed = model.calls.at(-1)!;
      assert.equal(mixed.image, model.calls[0].image);
      assert.equal(mixed.text, words);
      assert.deepEqual(mixed.history, [{role:'user',content:question},{role:'assistant',content:answer}]);
      console.log('选原文接着问：同一问题带上所选文字和图 6 的原始截图。');
      return;
    }

    if (sameReply) {
      const [firstParagraph, secondParagraph] = readerText.split('\n\n');
      await page.locator('#mobileRail').click();
      await page.locator('#rail .cm-line').filter({ hasText: firstParagraph }).click();
      await page.keyboard.press('End');
      await page.locator('#closeRail').click();
      await chat.getByRole('button', { name: '记入笔记', exact: true }).click();
      await chat.getByText('已记入', { exact: true }).waitFor();
      const repliesInBook = async () => (await getBook()).markdown.split(answer).length - 1;
      assert.equal(await repliesInBook(), 1);
      const savedMarkdown = (await getBook()).markdown;
      assert.ok(savedMarkdown.indexOf(firstParagraph) < savedMarkdown.indexOf(answer) &&
        savedMarkdown.indexOf(answer) < savedMarkdown.indexOf(secondParagraph));
      await chat.getByRole('button', { name: '收起讨论', exact: true }).click();
      await showHistory();
      const archived = answerRow(answer);
      await archived.getByText(answer, { exact: true }).waitFor();
      const archiveSave = archived.getByRole('button', { name: '记入笔记', exact: true });
      const duplicateControl = await archiveSave.isVisible();
      if (duplicateControl) {
        await archiveSave.click();
        await archived.getByText('已记入', { exact: true }).waitFor();
      }
      const storedCopies = await repliesInBook();
      console.log(JSON.stringify({ duplicateControl, storedCopies }));
      await photo('02-同轮从截图与全文两处核对');
      assert.equal(storedCopies, 1, 'The same reply must not be inserted twice when switching from its discussion to its archive.');
      assert.ok((await getBook()).markdown.includes('reply=' + original.requestId));
      await page.reload();
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await showHistory();
      await archived.getByText(answer, { exact: true }).waitFor();
      await archived.getByText('已记入', { exact: true }).waitFor();
      assert.equal(await archiveSave.isVisible(), false);
      await archived.getByRole('button', { name: '查看', exact: true }).click();
      const reference = page.locator('#rail .notebook-passage-link[href*="reply="]');
      const link = new URL((await reference.getAttribute('href'))!);
      assert.equal(link.searchParams.get('reply'), original.requestId);
      assert.equal(link.searchParams.get('anchor'), originalSource.anchor);
      assert.equal(await reference.innerText(), 'p. 6 · 图 6', 'The saved screenshot citation identifies the printed figure.');
      const editor = page.getByRole('textbox', { name: '笔记 Markdown' });
      await editor.click();
      await page.keyboard.press('Control+Home');
      const wrote = page.waitForResponse(response => response.request().method() === 'POST' &&
        response.url().endsWith('/api/paper-reader/action') && response.request().postDataJSON()?.op === 'notebook.write');
      const addedByReader = '自己的新增记录。';
      await page.keyboard.insertText(addedByReader);
      assert.ok((await wrote).ok());
      const afterWriting = (await getBook()).markdown;
      assert.ok(afterWriting.startsWith(addedByReader + firstParagraph) && afterWriting.endsWith(secondParagraph));
      await photo('03-刷新后查看保留原有及新增文字');
      await archived.getByRole('button', { name: '撤销', exact: true }).click();
      await archived.getByText('已记入', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await repliesInBook(), 0);
      assert.equal((await getBook()).markdown, addedByReader + readerText);
      await photo('04-撤销只删回答保留读者文字');
      await archived.getByRole('button', { name: '继续问这张截图', exact: true }).click();
      await chat.getByRole('button', { name: '记入笔记', exact: true }).waitFor();
      const legacy = savedMarkdown.replace('[p. 6 · 图 6]', '[p. 6 · 截图选区]');
      await action(page, host, 'notebook.write', { docId, title, sourceUrl: entry, expectedRevision: (await getBook()).revision, markdown: legacy });
      const fresh = await browser.newPage({ locale: 'zh-CN' });
      await fresh.goto(host.authenticatedUrl);
      await fresh.goto(entry);
      await fresh.getByRole('button', { name: '打开笔记' }).click();
      const oldSource = fresh.getByRole('link', { name: 'p. 6 · 截图选区', exact: true });
      const discussion = oldSource.locator('..').getByRole('link', { name: '查看讨论', exact: true });
      const copied = (await discussion.getAttribute('href'))!;
      await oldSource.click();
      await fresh.waitForURL(url => url.searchParams.get('anchor') === originalSource.anchor);
      await fresh.locator('#original .pdf-region-marker').waitFor();
      await fresh.goto(copied);
      const resumed = fresh.locator('.selection-chat:visible');
      await resumed.getByText(question, { exact: true }).waitFor();
      const focused = resumed.locator('.selection-answer:focus');
      await focused.waitFor();
      assert.equal(await focused.getAttribute('data-reply-id'), original.requestId);
      assert.equal((await getBook()).markdown, legacy);
      await fresh.close();
      console.log('PASS a legacy screenshot citation opens its crop and exact discussion in a fresh browser session.');
      console.log('PASS same screenshot reply can be reviewed and undone from history without a duplicate.');
      return;
    }

    const dockStatus = () => chat.isVisible();
    await visibleClick(page, page.locator('#original .pdf-raster'));
    console.log('白纸点击后原讨论：' + String(await dockStatus()));
    await page.locator('#mobileRail').click();
    console.log('打开右侧栏后原讨论：' + String(await dockStatus()));
    await page.locator('#closeRail').click();
    await page.locator('#parallel').click();
    console.log('点双语后原讨论：' + String(await dockStatus()));
    await page.locator('#originalMode').click();
    await figure.click();
    console.log('点已有图表后原讨论：' + String(await dockStatus()));
    if (!baselineProbes) {
      await chat.getByText(answer, { exact: true }).waitFor();
      await page.locator('#parallel').click();
      await translated.click();
      await chat.getByText(answer, { exact: true }).waitFor();
      await page.locator('#originalMode').click();
    }
    await photo('02-改看文章元素');

    if (highlight) {
      const restoreOldRegion = async () => {
        await showHistory();
        await questionRow(question).locator('.source-chip').click();
        await page.locator('#original .pdf-region-marker').click();
        await chat.getByText(answer, { exact: true }).waitFor();
      };
      await restoreOldRegion();
      const draft = '核对完译段后继续写这句。';
      await field.fill(draft);
      await page.locator('#parallel').click();
      await translated.click();
      await afterPaint(page);
      console.log('点实际译段后截图讨论：' + String(await dockStatus()));
      await page.locator('#originalMode').click();
      await restoreOldRegion();
      console.log('同一页面点击出处与框后保留未发草稿：' + String((await field.inputValue()) === draft));

      const highlightBounds = await highlight.boundingBox();
      assert.ok(highlightBounds);
      await highlight.scrollIntoViewIfNeeded();
      const visibleHighlight = await highlight.boundingBox();
      assert.ok(visibleHighlight);
      await page.mouse.click(visibleHighlight.x + visibleHighlight.width * .5, visibleHighlight.y + visibleHighlight.height * .5);
      await page.locator('.annotation-editor').waitFor();
      console.log('点实际已有高亮后截图讨论：' + String(await dockStatus()));
      await page.getByRole('button', { name: '关闭标记', exact: true }).click();
      if (await page.locator('#closeRail').isVisible()) await page.locator('#closeRail').click();
      await restoreOldRegion();

      await dragText(page, sourceRun(words), words);
      await card.getByRole('button', { name: /^(提问|单独提问)$/ }).waitFor();
      console.log('拖出新文字选区后截图讨论：' + String(await dockStatus()));
      await photo('04-选中新文字');
      await restoreOldRegion();
      await page.locator('#next').click();
      await page.waitForURL(url => url.searchParams.get('page') === '7');
      console.log('翻至下一页后截图讨论：' + String(await dockStatus()));
      await restoreOldRegion();
      assert.equal(model.calls.length, 1, 'Legacy source navigation and reopening must not contact the model.');
    }

    await page.reload();
    await page.locator('#loading').waitFor({ state: 'hidden' });
    if (!baselineProbes) {
      await page.locator('#next').click();
      await page.waitForURL(url => url.searchParams.get('page') === '7');
    }
    await showHistory();
    const row = answerRow(answer);
    await row.getByText(answer, { exact: true }).waitFor();
    const storedQuestion = questionRow(question);
    console.log(JSON.stringify({ historyLabel: await storedQuestion.innerText(), historyReply: await row.innerText(),
      historyReplyButtons: await row.getByRole('button').allTextContents(), pageErrors: errors }));
    await photo('03-刷新后翻到全文历史');

    const save = row.getByRole('button', { name: '记入笔记', exact: true });
    assert.ok(await save.isVisible(), 'A saved screenshot answer must offer direct notebook saving from the history after reload.');
    const before = await getBook();
    await dragText(page, row.locator('.paper-answer p'), sentence);
    await row.getByRole('button', { name: '记下选句', exact: true }).click();
    await row.getByText('已记入', { exact: true }).waitFor();
    const excerpt = await getBook();
    assert.ok(excerpt.markdown.includes(sentence) && !excerpt.markdown.includes(remainder));
    assert.ok(excerpt.markdown.includes(originalSource.anchor));
    await photo('04-全文历史直接记下选句');
    await row.getByRole('button', { name: '撤销', exact: true }).click();
    await row.getByText('已记入', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await getBook()).markdown, before.markdown);
    await row.locator('.paper-answer p').click();
    await save.click();
    await row.getByText('已记入', { exact: true }).waitFor();
    const book = await getBook();
    assert.ok(book.markdown.includes(answer));
    assert.ok(book.markdown.includes(originalSource.anchor));
    assert.equal((new URL(page.url())).searchParams.get('page'), '7', 'Saving from history should not take the reader to the screenshot page.');
    await row.getByRole('button', { name: '查看', exact: true }).click();
    const savedLink = page.locator('#rail .notebook-passage-link').filter({ hasText: 'p. 6' });
    const href = new URL((await savedLink.getAttribute('href'))!);
    assert.equal(href.searchParams.get('anchor'), originalSource.anchor);
    await photo('05-全文历史直接存全答与回链');
    await savedLink.click();
    await page.waitForURL(url => url.searchParams.get('page') === '6' && url.searchParams.get('anchor') === originalSource.anchor);
    await page.locator('#original .pdf-region-marker').waitFor();
    if (await page.locator('#closeRail').isVisible()) await page.locator('#closeRail').click();
    await page.locator('#next').click();
    await page.waitForURL(url => url.searchParams.get('page') === '7');
    await showHistory();

    await history.getByRole('button', { name: '继续问这张截图', exact: true }).click();
    await chat.getByText(answer, { exact: true }).waitFor();
    await page.waitForURL(url => url.searchParams.get('page') === '6');
    const image = chat.locator('img');
    assert.equal(await image.getAttribute('src'), model.calls[0].image);
    assert.equal(model.calls.length, 1, 'The history resume control should restore the discussion without a new model request.');
    await photo('06-从跨页历史恢复原截图');
    await field.fill(followup);
    await field.press('Enter');
    await chat.getByText('正在回答…', { exact: true }).waitFor();
    const subsequent = model.gates.get(followup)!;
    const sendResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url().endsWith('/api/paper-reader/action') && response.request().postDataJSON()?.payload?.question === followup);
    await dragText(page, sourceRun(words), words);
    await card.getByRole('button', { name: '单独提问', exact: true }).click();
    await field.fill(textQuestion);
    await field.press('Enter');
    await chat.getByText(textAnswer, { exact: true }).waitFor();
    subsequent.release.resolve();
    assert.ok((await sendResponse).ok());
    const resumed = await subsequent.reached.promise;
    assert.equal(resumed.image, model.calls[0].image);
    assert.deepEqual(resumed.history, [{ role: 'user', content: question }, { role: 'assistant', content: answer }]);
    assert.equal(model.calls.find(call => call.question === textQuestion)?.text, words);
    assert.deepEqual(model.calls.find(call => call.question === textQuestion)?.history, []);
    const turns = (await getHistory()).exchanges;
    assert.equal(turns.find(turn => turn.question === followup)?.thread, original.thread);
    assert.notEqual(turns.find(turn => turn.question === textQuestion)?.thread, original.thread);
    assert.equal(await chat.getByText(followupAnswer, { exact: true }).count(), 0);
    await photo('07-迟到截图答复没有进入文字讨论');

    await page.reload();
    await page.locator('#loading').waitFor({ state: 'hidden' });
    await showHistory();
    const textRow = answerRow(textAnswer);
    await textRow.getByRole('button', { name: '记入笔记', exact: true }).click();
    await textRow.getByText('已记入', { exact: true }).waitFor();
    assert.ok((await getBook()).markdown.includes(textAnswer));
    await history.getByRole('button', { name: '继续问这段原文', exact: true }).click();
    await chat.getByText(textAnswer, { exact: true }).waitFor();
    await chat.locator('.discussion-source blockquote').getByText(words, { exact: true }).waitFor();
    assert.equal(await chat.getByText(followupAnswer, { exact: true }).count(), 0);
    assert.equal(model.calls.length, 3);
    await photo('08-从历史恢复准确文字选段');
    await chat.getByRole('button', { name: '记笔记', exact: true }).click();
    const ownNote = '下一次读到该段时，对照独立逻辑缓存。';
    await card.getByRole('textbox', { name: '笔记内容' }).fill(ownNote);
    await card.getByRole('button', { name: '保存笔记', exact: true }).click();
    await card.getByText('笔记已保存。', { exact: true }).waitFor();
    assert.ok((await getBook()).markdown.includes(ownNote));
    assert.deepEqual(errors, []);
    await photo('09-恢复原文讨论后写个人笔记');
    console.log('PASS first-question draft, delayed PNG, passive reading clicks, direct history excerpt and undo, notebook crop link, and independent text history and notes.');
  } finally { await browser.close(); await model.close(); }
});
