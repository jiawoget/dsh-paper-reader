import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import type { Page } from 'playwright-core';

// Inspect the protected selection card through DevTools. All user actions below
// are ordinary mouse or keyboard input; page scripts cannot enter its shadow root.
export async function inCardShadow<T>(page: Page, functionDeclaration: string, args: unknown[] = []): Promise<T | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-dsh-paper-reader]' });
    if (!nodeId) return null;
    const { node } = await cdp.send('DOM.describeNode', { nodeId, pierce: true });
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      arguments: args.map(value => ({ value })),
      functionDeclaration
    });
    return result.value as T | null;
  } finally {
    await cdp.detach();
  }
}

export async function cardElement(page: Page, selector: string): Promise<{ text: string; x: number; y: number } | null> {
  return inCardShadow(page, function(this: ShadowRoot, query: string) {
    const element = this.querySelector<HTMLElement>(query);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      text: element instanceof HTMLTextAreaElement ? element.value : element.innerText,
      x: box.left + box.width / 2, y: box.top + box.height / 2
    };
  }.toString(), [selector]);
}

export async function clickCard(page: Page, selector: string): Promise<void> {
  const element = await cardElement(page, selector);
  assert.ok(element, 'Missing card control ' + selector);
  await page.mouse.click(element.x, element.y);
}

export async function until(probe: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 8500;
  do {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.fail(message);
}

// Native extension popups are browser UI targets, so Playwright does not list
// them as pages. Attach to the actual popup opened by a toolbar invocation.
export async function openToolbar(source: Page, id: string) {
  await source.bringToFront();
  const browser = source.context().browser()!;
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
  const tab = targetInfos.find(info => info.url === source.url());
  assert.ok(tab, 'The source tab must be active');
  await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
  const popupUrl = 'chrome-extension://' + id + '/popup.html';
  let targetId = '';
  await until(async () => {
    const pages = await cdp.send('Target.getTargets', { filter: [{ type: 'page' }, { exclude: true }] });
    targetId = pages.targetInfos.find(info => info.url === popupUrl)?.targetId || '';
    return !!targetId;
  }, 'The browser did not open the extension toolbar menu');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  let serial = 0;
  async function send<T>(method: string, params: unknown): Promise<T> {
    const id = ++serial;
    return new Promise<T>((resolve, reject) => {
      function receive(event: { sessionId: string; message: string }): void {
        if (event.sessionId !== sessionId) return;
        const msg = JSON.parse(event.message) as { id?: number; result: T; error?: { message: string } };
        if (msg.id !== id) return;
        clearTimeout(timeout);
        cdp.off('Target.receivedMessageFromTarget', receive);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
      const timeout = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(new Error('Popup timed out during ' + method)); }, 3000);
      cdp.on('Target.receivedMessageFromTarget', receive);
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
        clearTimeout(timeout); cdp.off('Target.receivedMessageFromTarget', receive); reject(error);
      });
    });
  }
  async function evaluate<T, P>(operation: (input: P) => T, input: P): Promise<T> {
    const expression = '(' + operation.toString() + ')(' + JSON.stringify(input) + ')';
    const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!result.exceptionDetails, 'The extension popup could not be inspected');
    return result.result.value;
  }
  await until(() => evaluate(() => Boolean(document.readyState === 'complete' && document.querySelector<HTMLInputElement>('#origin')?.value &&
    document.querySelector<HTMLButtonElement>('#toggle') && !document.querySelector<HTMLButtonElement>('#toggle')!.disabled), null), 'The toolbar did not finish loading');
  return {
    evaluate,
    async click(selector: string): Promise<void> {
      const point = await evaluate(selector => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, selector);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point });
    },
    async screenshot(file: string): Promise<void> {
      const clip = await evaluate(() => ({ x: 0, y: 0, width: document.body.offsetWidth, height: document.body.offsetHeight, scale: 1 }), null);
      const result = await send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
      await writeFile(file, Buffer.from(result.data, 'base64'));
    },
    async detach(): Promise<void> { await cdp.detach(); }
  };
}
