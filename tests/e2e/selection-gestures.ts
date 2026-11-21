import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';

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
