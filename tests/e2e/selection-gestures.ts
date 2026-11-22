import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';

type Point = { x: number; y: number };

export async function dragBox(page: Page, start: Point, end: Point, touch: boolean): Promise<void> {
  if (!touch) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    return;
  }
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let step = 1; step <= 12; step++) {
      const x = start.x + (end.x - start.x) * (step / 12), y = start.y + (end.y - start.y) * (step / 12);
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await input.detach(); }
}

export async function dragAnswer(page: Page, excerpt: Locator): Promise<string> {
  await excerpt.scrollIntoViewIfNeeded();
  const { start, end } = await excerpt.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects()).filter(r => r.width && r.height);
    const first = rects[0], last = rects.at(-1)!;
    return { start: [first.left + .2, first.top + first.height / 2], end: [last.right - .2, last.top + last.height / 2] };
  });
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  await page.mouse.move(end[0], end[1], { steps: 8 });
  await page.mouse.up();
  const selected = await page.getByRole('group', { name: 'Selected answer text' }).getAttribute('aria-description');
  assert.ok(selected);
  assert.equal(selected, await excerpt.innerText());
  return selected;
}
