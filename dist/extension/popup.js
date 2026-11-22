"use strict";
(() => {
  // src/extension/protocol.ts
  var allowedHosts = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]"]);
  var defaultOrigin = "http://127.0.0.1:29812";
  function localOrigin(value = defaultOrigin) {
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error("Enter the full address of your local DSH, such as " + defaultOrigin);
    }
    if (!allowedHosts.has(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Enter an HTTP or HTTPS origin on localhost, 127.0.0.1, or [::1].");
    }
    return url.origin;
  }
  async function getOrigin() {
    const stored = await chrome.storage.local.get("serviceOrigin");
    return localOrigin(typeof stored.serviceOrigin === "string" ? stored.serviceOrigin : void 0);
  }
  async function askWorker(message2) {
    const reply = await chrome.runtime.sendMessage(message2);
    if (!reply) throw new Error("The extension did not respond. Reopen its menu and try again.");
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }
  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/extension/popup.ts
  var toggle = document.querySelector("#toggle");
  var read = document.querySelector("#read");
  var message = document.querySelector("#message");
  var originInput = document.querySelector("#origin");
  var enabled = false;
  var chinese = /^zh(?:-|$)/i.test(navigator.language);
  var label = (english, simplified) => chinese ? simplified : english;
  if (chinese) {
    document.documentElement.lang = "zh-CN";
    read.textContent = "\u5728\u9605\u8BFB\u5668\u4E2D\u6253\u5F00";
    toggle.textContent = "\u542F\u7528\u5212\u8BCD";
    message.textContent = "\u9009\u4E2D\u539F\u6587\u4E2D\u7684\u8BCD\u53E5\uFF0C\u53EF\u4EE5\u7FFB\u8BD1\u3001\u63D0\u95EE\u6216\u8BB0\u7B14\u8BB0\u3002";
    const launch = document.querySelector("#launch");
    launch.textContent = "\u6253\u5F00 DSH \u2197";
    launch.title = "\u6253\u5F00\u672C\u673A DSH";
    document.querySelector("summary").textContent = "\u8FDE\u63A5\u8BBE\u7F6E";
    document.querySelector('label[for="origin"]').textContent = "\u672C\u673A DSH \u5730\u5740";
    document.querySelector('button[type="submit"]').textContent = "\u4FDD\u5B58\u5730\u5740";
  }
  function tell(text, failed = false) {
    message.textContent = text;
    message.classList.toggle("error", failed);
  }
  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === void 0) throw new Error("Could not find the active tab.");
    return tab.id;
  }
  async function command(command2) {
    toggle.disabled = read.disabled = true;
    try {
      const tabId = await activeTab();
      if (command2 === "capture") tell(label("Capturing the article\u2026", "\u6B63\u5728\u8BFB\u53D6\u6587\u7AE0\u2026"));
      const reply = await askWorker({ type: "tab", tabId, command: command2 });
      enabled = reply.enabled;
      toggle.textContent = enabled ? label("Disable selection cards", "\u5173\u95ED\u5212\u8BCD") : label("Enable selection cards", "\u542F\u7528\u5212\u8BCD");
      toggle.setAttribute("aria-pressed", String(enabled));
      if (command2 === "enable") {
        window.close();
      } else if (command2 === "capture") {
        tell(label("Opened the article in Paper Reader.", "\u6587\u7AE0\u5DF2\u5728\u9605\u8BFB\u5668\u4E2D\u6253\u5F00\u3002"));
        window.close();
      } else if (command2 === "disable") tell(label("Selection cards are off for this page.", "\u6B64\u9875\u5212\u8BCD\u5DF2\u5173\u95ED\u3002"));
      else {
        const badge = await chrome.action.getBadgeText({ tabId });
        if (badge === "!") tell(await chrome.action.getTitle({ tabId }), true);
        else if (enabled) tell(label("Selection cards are on. Select a word or sentence on this page.", "\u5212\u8BCD\u5DF2\u5F00\u542F\u3002\u53EF\u5728\u539F\u6587\u4E2D\u9009\u4E2D\u8BCD\u53E5\u3002"));
      }
    } catch (error) {
      tell(errorText(error), true);
    } finally {
      toggle.disabled = read.disabled = false;
    }
  }
  toggle.onclick = () => void command(enabled ? "disable" : "enable");
  read.onclick = () => void command("capture");
  document.querySelector("#launch").onclick = async () => {
    try {
      await chrome.tabs.create({ url: await getOrigin() });
    } catch (error) {
      tell(errorText(error), true);
    }
  };
  document.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const origin = localOrigin(originInput.value);
      await chrome.storage.local.set({ serviceOrigin: origin });
      originInput.value = origin;
      tell(label("Your local DSH address was saved.", "\u672C\u673A DSH \u5730\u5740\u5DF2\u4FDD\u5B58\u3002"));
    } catch (error) {
      tell(errorText(error), true);
    }
  };
  void getOrigin().then((origin) => {
    originInput.value = origin;
  }, (error) => tell(errorText(error), true));
  void command("status");
})();
