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
  function readerAddress(origin, doc, anchor, page = 1) {
    const url = new URL("/api/paper-reader/app/index.html", localOrigin(origin));
    url.searchParams.set("doc", doc);
    if (page !== null) url.searchParams.set("page", String(page));
    if (anchor) url.searchParams.set("anchor", anchor);
    return url.href;
  }
  var extensionActions = ["ai", "history.add", "web.import", "web.open", "vocab.save", "note.save"];
  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/extension/background.ts
  async function postToReader(origin, op, payload, fromTab) {
    if (fromTab && location.origin !== origin) return { ok: false, error: "The DSH tab navigated away. Reopen your local DSH and try again." };
    try {
      const response = await fetch(origin + "/api/paper-reader/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: fromTab ? "same-origin" : "include",
        redirect: "error",
        body: JSON.stringify({ op, payload })
      });
      const json = response.headers.get("content-type")?.includes("json");
      const data = json ? await response.json() : null;
      const reason = data && typeof data === "object" && "error" in data ? data.error : null;
      if (response.status === 401 || response.status === 403) {
        if (op === "ai" && typeof reason === "string" && /\b(?:API key|model service)\b/i.test(reason)) return { ok: false, error: reason };
        return { ok: false, error: "Choose Open DSH in the extension menu, sign in, and try again." };
      }
      if (!json) return { ok: false, error: "DSH did not return reader data. Check the local address, sign-in status, and reader patch." };
      if (!response.ok || reason) return { ok: false, error: typeof reason === "string" ? reason : "DSH request failed (HTTP " + response.status + ")." };
      return { ok: true, data };
    } catch {
      return { ok: false, error: "Could not reach your local DSH. Start the service and check the address in Connection settings." };
    }
  }
  async function serviceAction(op, payload) {
    if (!extensionActions.includes(op)) throw new Error("This operation is unavailable in the extension.");
    const origin = await getOrigin();
    const url = new URL(origin);
    const tabs = await chrome.tabs.query({ url: url.protocol + "//" + url.hostname + "/*" });
    const localTab = tabs.find((tab) => tab.id !== void 0 && tab.url && new URL(tab.url).origin === origin && !tab.discarded);
    let reply;
    if (localTab?.id !== void 0) {
      const result = await chrome.scripting.executeScript({
        target: { tabId: localTab.id },
        world: "ISOLATED",
        func: postToReader,
        args: [origin, op, payload, true]
      });
      reply = result[0]?.result || null;
    } else reply = await postToReader(origin, op, payload, false);
    if (!reply) throw new Error("The local DSH tab was closed. Reopen it and try again.");
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }
  async function commandTab(tabId, command, frameId = 0) {
    const message = { channel: "paper-reader-page", command };
    if (command === "status") {
      try {
        const reply2 = await chrome.tabs.sendMessage(tabId, message, { frameId });
        if (reply2?.ok) return reply2.data;
      } catch {
      }
      return { enabled: false };
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
    } catch {
      throw new Error("Open the extension on a regular webpage. Browser settings, extension stores, and restricted frames cannot be read.");
    }
    const reply = await chrome.tabs.sendMessage(tabId, message, { frameId });
    if (!reply?.ok) throw new Error(reply?.error || "The webpage did not respond. Refresh it and try again.");
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: "DSH Paper Reader" });
    return reply.data;
  }
  async function handle(request, sender) {
    if (sender.id !== chrome.runtime.id) throw new Error("Unknown request source.");
    switch (request.type) {
      case "tab":
        if (!sender.url?.startsWith(chrome.runtime.getURL("popup.html"))) throw new Error("Use the extension menu to act on the current tab.");
        return commandTab(request.tabId, request.command);
      case "action":
        return serviceAction(request.op, request.payload);
      case "reader":
        if (!request.doc || request.anchor && !/^p-[1-9]\d*$/.test(request.anchor) || request.page != null && (!Number.isSafeInteger(request.page) || request.page < 1)) throw new Error("The excerpt is missing its article location.");
        await chrome.tabs.create({ url: readerAddress(await getOrigin(), request.doc, request.anchor, request.page) });
        return {};
      default:
        throw new Error("Unknown extension command.");
    }
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    void handle(request, sender).then((data) => respond({ ok: true, data }), (err) => respond({ ok: false, error: errorText(err) }));
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      const documentUrlPatterns = ["http://*/*", "https://*/*"];
      const chinese = /^zh(?:-|$)/i.test(chrome.i18n.getUILanguage());
      chrome.contextMenus.create({ id: "translate-selection", title: chinese ? "\u7528 DSH \u7FFB\u8BD1\u9009\u533A" : "Translate selection with DSH", contexts: ["selection"], documentUrlPatterns });
      chrome.contextMenus.create({ id: "read-this-page", title: chinese ? "\u5728\u9605\u8BFB\u5668\u4E2D\u6253\u5F00" : "Open in Paper Reader", contexts: ["page", "selection"], documentUrlPatterns });
    });
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (tab?.id === void 0) return;
    const tabId = tab.id;
    const command = info.menuItemId === "translate-selection" ? "translate" : "capture";
    void commandTab(tabId, command, info.frameId ?? 0).catch(async (error) => {
      await chrome.action.setBadgeText({ tabId, text: "!" });
      await chrome.action.setTitle({ tabId, title: errorText(error) });
    });
  });
})();
