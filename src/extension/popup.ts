import { askWorker, errorText, getOrigin, localOrigin } from './protocol.js';
import type { TabCommand } from './protocol.js';

const toggle = document.querySelector<HTMLButtonElement>('#toggle')!;
const read = document.querySelector<HTMLButtonElement>('#read')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;
const originInput = document.querySelector<HTMLInputElement>('#origin')!;
let enabled = false;
const chinese = /^zh(?:-|$)/i.test(navigator.language);
const label = (english: string, simplified: string) => chinese ? simplified : english;
if (chinese) {
  document.documentElement.lang = 'zh-CN';
  read.textContent = '在阅读器中打开';
  toggle.textContent = '启用划词';
  message.textContent = '选中原文中的词句，可以翻译、提问或记笔记。';
  const launch = document.querySelector<HTMLButtonElement>('#launch')!;
  launch.textContent = '打开 DSH ↗'; launch.title = '打开本机 DSH';
  document.querySelector('summary')!.textContent = '连接设置';
  document.querySelector('label[for="origin"]')!.textContent = '本机 DSH 地址';
  document.querySelector('button[type="submit"]')!.textContent = '保存地址';
}

function tell(text: string, failed = false): void {
  message.textContent = text;
  message.classList.toggle('error', failed);
}

async function activeTab(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('Could not find the active tab.');
  return tab.id;
}

async function command(command: TabCommand): Promise<void> {
  toggle.disabled = read.disabled = true;
  try {
    const tabId = await activeTab();
    if (command === 'capture') tell(label('Capturing the article…','正在读取文章…'));
    const reply = await askWorker<{ enabled: boolean }>({ type: 'tab', tabId, command });
    enabled = reply.enabled;
    toggle.textContent = enabled ? label('Disable selection cards','关闭划词') : label('Enable selection cards','启用划词');
    toggle.setAttribute('aria-pressed', String(enabled));
    if (command === 'enable') {
      window.close();
    } else if (command === 'capture') {
      tell(label('Opened the article in Paper Reader.','文章已在阅读器中打开。'));
      window.close();
    } else if (command === 'disable') tell(label('Selection cards are off for this page.','此页划词已关闭。'));
    else {
      const badge = await chrome.action.getBadgeText({ tabId });
      if (badge === '!') tell(await chrome.action.getTitle({ tabId }), true);
      else if (enabled) tell(label('Selection cards are on. Select a word or sentence on this page.','划词已开启。可在原文中选中词句。'));
    }
  } catch (error) { tell(errorText(error), true); }
  finally { toggle.disabled = read.disabled = false; }
}

toggle.onclick = () => void command(enabled ? 'disable' : 'enable');
read.onclick = () => void command('capture');
document.querySelector<HTMLButtonElement>('#launch')!.onclick = async () => {
  try { await chrome.tabs.create({ url: await getOrigin() }); }
  catch (error) { tell(errorText(error), true); }
};
document.querySelector('form')!.onsubmit = async event => {
  event.preventDefault();
  try {
    const origin = localOrigin(originInput.value);
    await chrome.storage.local.set({ serviceOrigin: origin });
    originInput.value = origin;
    tell(label('Your local DSH address was saved.','本机 DSH 地址已保存。'));
  } catch (error) { tell(errorText(error), true); }
};
void getOrigin().then(origin => { originInput.value = origin; }, error => tell(errorText(error), true));
void command('status');
