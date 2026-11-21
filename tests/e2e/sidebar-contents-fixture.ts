import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const printedHeadings = [
  { text: '1 Introduction', page: 1, level: 1, y: 1380 },
  { text: '2 Study design', page: 2, level: 1, y: 1380 },
  { text: '2.1 Secondary controls', page: 2, level: 2, y: 490 },
  { text: '3 Findings', page: 3, level: 1, y: 1380 }
];
export const bookmarkTitles = ['Opening remarks', 'Experiment plan', 'The control group', 'Outcome'];

function text(x: number, y: number, size: number, value: string) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${value}) Tj ET`;
}

/** Three real PDF pages with distinguishable headings and same-page destinations. */
export function outlinePdf(kind: 'bookmarked' | 'plain' | 'scan'): Buffer {
  const objects: string[] = [];
  const add = (value: string) => objects.push(value);
  const catalog = add('');
  const pagesRoot = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pages = Array.from({ length: kind === 'scan' ? 1 : 3 }, (_, index) => {
    const page = index + 1;
    const content = kind === 'scan'
      ? 'q 400 0 0 280 75 1020 cm BI /W 32 /H 12 /CS /G /BPC 1 /F /AHx ID\n' +
        ('003807fffc7ffe00'.repeat(6)) + '>\nEI Q'
      : [
        ...printedHeadings.filter(heading => heading.page === page).flatMap((heading, index) => [
          text(85, heading.y, 22 - 4 * index, heading.text),
          text(85, heading.y - 35, 13, 'This passage describes the observations recorded for this part of the study.'),
          text(85, heading.y - 55, 13, 'The observations were then compared across a separate set of samples.')
        ]),
        text(85, 87, 13, 'End of the source page.'),
        text(85, 65, 11, 'Source page ' + page)
      ].join('\n');
    const stream = add('<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream');
    return add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 1500] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`);
  });
  objects[pagesRoot - 1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(page => page + ' 0 R').join(' ')}] >>`;
  let catalogEntries = '';
  if (kind === 'bookmarked') {
    const outline = add('');
    const opening = add('');
    const design = add('');
    const controls = add('');
    const results = add('');
    objects[outline - 1] = `<< /Type /Outlines /First ${opening} 0 R /Last ${results} 0 R /Count 4 >>`;
    objects[opening - 1] = `<< /Title (${bookmarkTitles[0]}) /Parent ${outline} 0 R /Next ${design} 0 R /Dest [${pages[0]} 0 R /Fit] >>`;
    objects[design - 1] = `<< /Title (${bookmarkTitles[1]}) /Parent ${outline} 0 R /Prev ${opening} 0 R /Next ${results} 0 R /First ${controls} 0 R /Last ${controls} 0 R /Count 1 /Dest (design-start) >>`;
    objects[controls - 1] = `<< /Title (${bookmarkTitles[2]}) /Parent ${design} 0 R /Dest [${pages[1]} 0 R /XYZ 85 497 null] >>`;
    objects[results - 1] = `<< /Title (${bookmarkTitles[3]}) /Parent ${outline} 0 R /Prev ${design} 0 R /Dest [${pages[2]} 0 R /Fit] >>`;
    catalogEntries = ` /Outlines ${outline} 0 R /Names << /Dests << /Names [(design-start) [${pages[1]} 0 R /XYZ 85 1387 null]] >> >>`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R${catalogEntries} >>`;
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((value, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

/** A loopback model that only accepts the real PDF's extracted source lines. */
export async function startOutlineModel() {
  const key = randomUUID();
  const model = 'reader-contents-fixture';
  const calls: { pages: number[]; matched: string[] }[] = [];
  let received = 0;
  const server = createServer(async (request, response) => {
    received++;
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== 'Bearer ' + key) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (envelope.model !== model || envelope.messages?.[1]?.role !== 'user') {
        response.writeHead(422).end();
        return;
      }
      const input: { pageCount: number; pages: { page: number; lines: { id: string; text: string }[] }[] } =
        JSON.parse(envelope.messages[1].content);
      const entries = printedHeadings.flatMap(heading => {
        const line = input.pages.find(page => page.page === heading.page)?.lines.find(item => item.text === heading.text);
        return line ? [{ id: line.id, level: heading.level, text: heading.text }] : [];
      });
      calls.push({ pages: input.pages.map(page => page.page), matched: entries.map(entry => entry.text) });
      response.setHeader('Content-Type', 'application/json');
      if (input.pageCount !== 3 || entries.length !== printedHeadings.length) {
        response.writeHead(422).end(JSON.stringify({ error: { message: 'The fixture did not receive each printed PDF heading.' } }));
        return;
      }
      const selection = calls.length === 1 ? [{ id: 'not-a-source-line', level: 1 }] : entries.map(({ id, level }) => ({ id, level }));
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ entries: selection }) }, finish_reason: 'stop' }]
      }));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The outline model fixture did not bind a loopback port.');
  return {
    baseUrl: 'http://127.0.0.1:' + address.port + '/v1', key, model, calls, received: () => received,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
