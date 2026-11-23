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
  async function askWorker(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply) throw new Error("The extension did not respond. Reopen its menu and try again.");
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }
  function action(op, payload) {
    return askWorker({ type: "action", op, payload });
  }
  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/shared/openstax.ts
  function bookSlug(value) {
    return typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,239}$/u.test(value);
  }
  function openStaxLocation(raw) {
    const url = typeof raw === "string" && raw.length <= 8192 ? URL.parse(raw) : null;
    if (!url || !["https:", "http:"].includes(url.protocol) || !["openstax.org", "www.openstax.org"].includes(url.hostname) || url.username || url.password || url.port) return;
    const match = /^\/books\/([^/]+)(?:\/pages(?:\/([^/]+))?)?\/?$/.exec(url.pathname) ?? /^\/details\/books\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return;
    let book, section;
    try {
      book = decodeURIComponent(match[1]);
      section = match[2] ? decodeURIComponent(match[2]) : void 0;
    } catch {
      return;
    }
    if (!bookSlug(book) || section && !bookSlug(section)) return;
    let fragment = url.hash.slice(1);
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
    }
    return { book, section, fragment: fragment || void 0 };
  }

  // src/extension/card-style.ts
  var cardStyle = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.card { display: grid; gap: 9px; width: 100%; max-height: min(470px,calc(100dvh - 16px)); overflow: auto; overscroll-behavior: contain; padding: 15px 15px 12px; border: 1px solid #dce0e9; border-radius: 9px; background: #fff; box-shadow: 0 6px 27px #222a3d2c, 0 1px 4px #222a3d13; color: #1f222b; font: normal 13px/1.5 system-ui,"Microsoft YaHei",sans-serif; text-align: left; direction: ltr; }
.head { display: flex; align-items: flex-start; gap: 8px; }
h2 { flex: 1; margin: 0; font-size: 18px; font-weight: 620; line-height: 1.35; letter-spacing: -.24px; max-height: 5.4em; overflow: auto; overflow-wrap: anywhere; }
button, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: 0; background: none; padding: 0; }
button:focus-visible, textarea:focus-visible { outline: 2px solid #8154ca; outline-offset: 2px; }
button:disabled { cursor: default; opacity: .56; }
.close { font-size: 19px; line-height: 20px; color: #666e7e; padding: 0 2px; }
.modes, .foot, .editor-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.modes button { color: #585568; padding: 3px 7px; min-height: 24px; border-radius: 4px; font-size: 12px; }
.modes button:hover, .modes button[aria-pressed="true"] { background: #efe7fb; color: #593194; }
.answer { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; max-height: 220px; overflow: auto; }
.question { margin: 0; padding: 4px 8px; border-left: 2px solid #9b79d3; color: #524062; background: #f7f4fb; font-size: 12px; overflow-wrap: anywhere; }
.hint { color: #697180; font-size: 12px; }
.error { color: #923c38; }
.foot { border-top: 1px solid #e8eaf0; padding-top: 9px; }
.foot button, .editor-actions button { padding: 4px 8px; border-radius: 5px; font-size: 12px; }
.foot button:first-child { margin-right: auto; }
.foot button:hover, .editor-actions button:hover { background: #f2eef8; }
.foot [data-do="open"] { color: #5f6676; font-size: 11px; }
.foot .primary, .editor-actions .primary { background: #7044c4; color: white; }
.foot .primary:hover, .editor-actions .primary:hover { background: #6037ad; }
.editor { display: grid; gap: 6px; }
.model-picker summary { cursor: pointer; color: #5e408e; font-size: 12px; overflow-wrap: anywhere; }
.question-model-form, .question-model-form label { display: grid; gap: 4px; }
.question-model-form { gap: 8px; padding: 8px 0; }
.question-model-form select { min-width: 0; width: 100%; font: inherit; }
.question-model-form .hint { margin: 0; }
.question-model-form .hint:empty { display: none; }
.question-model-form button { justify-self: start; padding: 4px 8px; border-radius: 4px; color: #593194; background: #efe7fb; }
.editor textarea { width: 100%; min-height: 55px; resize: vertical; padding: 6px 8px; border-radius: 5px; border: 1px solid #cbd0dd; background: #fbfcfe; }
.editor-actions { justify-content: flex-end; }
.status { color: #5d526f; font-size: 12px; margin: 0; overflow-wrap: anywhere; }
.status:empty { display: none; }
`;

  // src/shared/question-model-form.ts
  function questionModelForm({ label, defaultName, load, save }) {
    const form = document.createElement("form");
    form.className = "question-model-form";
    const field = (caption) => {
      const row = document.createElement("label"), title = document.createElement("span"), select2 = document.createElement("select");
      row.className = "field";
      title.textContent = caption;
      row.append(title, select2);
      form.append(row);
      return { row, select: select2 };
    };
    const model = field(label("Model", "\u6A21\u578B")), effort = field(label("Reasoning effort", "\u63A8\u7406\u5F3A\u5EA6"));
    const status = document.createElement("p");
    status.className = "hint";
    status.setAttribute("role", "status");
    const apply = document.createElement("button"), retry = document.createElement("button");
    apply.type = "submit";
    apply.className = "btn primary";
    apply.textContent = label("Use model", "\u4F7F\u7528\u6B64\u6A21\u578B");
    retry.type = "button";
    retry.className = "text-btn";
    retry.textContent = label("Reload models", "\u91CD\u65B0\u52A0\u8F7D\u6A21\u578B");
    form.append(status, retry, apply);
    const options = /* @__PURE__ */ new Map();
    const key = (provider, id) => JSON.stringify([provider, id]);
    const fallback = label("Reader default", "\u9605\u8BFB\u5668\u9ED8\u8BA4\u6A21\u578B") + (defaultName ? " \xB7 " + defaultName : "");
    function efforts(selected) {
      const reasoning = options.get(model.select.value)?.model.reasoning;
      effort.select.replaceChildren(new Option(label("Model default", "\u6A21\u578B\u9ED8\u8BA4") + (reasoning?.defaultEffort ? " \xB7 " + (reasoning.efforts.find((e) => e.id === reasoning.defaultEffort)?.name || reasoning.defaultEffort) : ""), ""));
      for (const item of reasoning?.efforts ?? []) effort.select.add(new Option(item.name || item.id, item.id));
      effort.row.hidden = !reasoning?.efforts.length;
      if (selected && Array.from(effort.select.options).some((o) => o.value === selected)) effort.select.value = selected;
      else if (selected && options.has(model.select.value)) {
        status.textContent = label("The saved effort is unavailable. Choose a new effort or use the model default.", "\u5DF2\u4FDD\u5B58\u7684\u63A8\u7406\u5F3A\u5EA6\u4E0D\u53EF\u7528\uFF0C\u53EF\u91CD\u65B0\u9009\u62E9\u6216\u4F7F\u7528\u6A21\u578B\u9ED8\u8BA4\u503C\u3002");
      }
    }
    model.select.onchange = () => {
      apply.disabled = false;
      efforts();
    };
    async function loadModels() {
      model.select.disabled = apply.disabled = true;
      retry.hidden = effort.row.hidden = true;
      options.clear();
      model.select.replaceChildren(new Option(fallback, ""));
      status.textContent = label("Loading DSH models\u2026", "\u6B63\u5728\u52A0\u8F7D DSH \u6A21\u578B\u2026");
      try {
        const { groups, selected, failures } = await load();
        for (const group of groups) {
          const groupNode = document.createElement("optgroup");
          groupNode.label = group.name || group.id;
          for (const entry of group.models) {
            const id = key(group.id, entry.id);
            options.set(id, { model: entry, selection: { provider: group.id, model: entry.id } });
            groupNode.append(new Option(entry.name || entry.id, id));
          }
          model.select.append(groupNode);
        }
        status.textContent = failures.length ? label("Unavailable providers", "\u6682\u4E0D\u53EF\u7528\u7684\u63D0\u4F9B\u5546") + " \xB7 " + failures.map((p) => p.name || p.id).join(", ") : !options.size ? label("DSH has no models available.", "DSH \u5F53\u524D\u6CA1\u6709\u53EF\u7528\u6A21\u578B\u3002") : "";
        retry.hidden = Boolean(options.size && !failures.length);
        if (selected) {
          const saved = key(selected.provider, selected.model);
          if (!options.has(saved)) {
            const missing = new Option(selected.model + " \xB7 " + label("unavailable", "\u4E0D\u53EF\u7528"), saved);
            missing.disabled = true;
            model.select.add(missing);
          }
          model.select.value = saved;
        }
        efforts(selected?.reasoningEffort);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : label("Could not load the DSH model catalog.", "\u65E0\u6CD5\u52A0\u8F7D DSH \u6A21\u578B\u5217\u8868\u3002");
        retry.hidden = false;
      }
      model.select.disabled = false;
      apply.disabled = Boolean(model.select.value && !options.has(model.select.value));
    }
    retry.onclick = () => void loadModels();
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (apply.disabled) return;
      const choice = options.get(model.select.value)?.selection;
      apply.disabled = model.select.disabled = effort.select.disabled = retry.disabled = true;
      try {
        await save(choice ? { ...choice, ...effort.select.value && { reasoningEffort: effort.select.value } } : null);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : label("Could not save this model.", "\u65E0\u6CD5\u4FDD\u5B58\u6B64\u6A21\u578B\u3002");
      } finally {
        apply.disabled = model.select.disabled = effort.select.disabled = retry.disabled = false;
      }
    };
    void loadModels();
    return form;
  }

  // src/shared/web-article.ts
  function articleUrl(value, base) {
    if (!value || value.length > 8192) return;
    const url = URL.parse(value, base);
    if (url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url;
  }
  var excludedTags = new Set("nav aside footer form button input textarea select script style noscript template svg canvas iframe dialog".split(" "));
  var blocks = new Set("body article main section header div p h1 h2 h3 h4 h5 h6 pre li dt dd figcaption blockquote tr".split(" "));
  var clean = (value) => value.replace(/\s+/g, " ").trim();
  function extractArticle(root, tree2, address, fallbackTitle, picked) {
    const { tag, attr, children } = tree2;
    const bookSection = Boolean(openStaxLocation(address)?.section);
    const classes = (node) => (attr(node, "class") || "").toLowerCase().split(/\s+/);
    function excluded(node) {
      const name = tag(node), role = attr(node, "role");
      const imageButton = bookSection && name === "button" && classes(node).includes("image-button-wrapper");
      return excludedTags.has(name) && !imageButton || role === "navigation" || role === "dialog" || role === "banner" || role === "contentinfo" || attr(node, "hidden") !== null || attr(node, "inert") !== null || attr(node, "aria-hidden") === "true" || attr(node, "data-dsh-paper-reader") !== null || attr(node, "contenteditable") !== null && attr(node, "contenteditable") !== "false" || classes(node).some((c) => /^(?:ltx_author_notes|ltx_note_outer|ltx_page_footer|sr-only|visually-hidden|screen-reader-text|share-buttons|social-share)$/.test(c)) || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attr(node, "style") || "") || Boolean(tree2.invisible?.(node));
    }
    let articleRoot = root, rank = 0, documentBase, pageTitle = fallbackTitle;
    const researchBlog = articleUrl(address)?.hostname === "research.google";
    let storyHeader, storySummary, storyBody;
    const coverImages = /* @__PURE__ */ new Set(), figureDescriptions = /* @__PURE__ */ new Set();
    function find(node, depth, storyPart) {
      if (depth > 150 || tag(node) === "#text") return;
      const name = tag(node);
      if (name === "base" && !documentBase) documentBase = articleUrl(attr(node, "href") || "", address)?.href;
      if (name === "title" && !pageTitle) pageTitle = clean(tree2.text(node));
      if (excluded(node)) return;
      if (researchBlog) {
        const names = classes(node);
        if (names.includes("basic-hero") && names.includes("bhoig")) {
          storyHeader = node;
          storyPart = "header";
        }
        if (names.includes("blog-summary")) storySummary = node;
        if (names.includes("blog-detail-wrapper")) {
          storyBody = node;
          storyPart = "body";
        }
        if (name === "img" && storyPart === "header") coverImages.add(node);
        if (name === "img" && storyPart === "body" && attr(node, "alt")) figureDescriptions.add(attr(node, "alt"));
      }
      const candidate = bookSection && attr(node, "id") === "main-content" ? 7 : bookSection && attr(node, "data-book-content") === "true" ? 6 : name === "article" ? 5 : attr(node, "itemprop") === "articleBody" || classes(node).includes("article") ? 4 : name === "main" || attr(node, "role") === "main" ? 3 : name === "body" ? 1 : 0;
      if (candidate > rank) {
        rank = candidate;
        articleRoot = node;
      }
      for (const child of children(node)) find(child, depth + 1, storyPart);
    }
    find(root, 0);
    const base = documentBase || address;
    const paragraphs = [];
    const layout2 = {};
    let ids = [], parts = [];
    let containsPick = false, pickedIndex = -1, title = "";
    let current = "p", total = 0;
    function add(text, info, spans = []) {
      if (!text) return;
      total += text.length;
      if (total > 1e6 || paragraphs.length >= 4e3 || text.length > 24e3) throw new Error("This article is too long to open in the reader.");
      const index = paragraphs.length;
      if (containsPick) pickedIndex = index;
      paragraphs.push(text);
      if (ids.length) info.ids = [...new Set(ids)].slice(0, 80);
      if (spans.length) info.spans = spans;
      if (info.kind !== "p" || info.ids || info.spans) layout2["p-" + (index + 1)] = info;
      if (info.kind === "h1" && !title) title = text;
      ids = [];
      containsPick = false;
    }
    function flush() {
      let value = "", space = false;
      const spans = [];
      for (const part of parts) {
        const trimmed = clean(part.text);
        if (!trimmed) {
          if (part.text) space = true;
          continue;
        }
        if (value && (space || /^\s/.test(part.text))) value += " ";
        const start = value.length;
        value += trimmed;
        if (part.span) spans.push({ ...part.span, start, end: value.length });
        space = /\s$/.test(part.text);
      }
      add(value, { kind: current }, spans);
      parts = [];
    }
    function plain(node, depth = 0) {
      const name = tag(node);
      if (depth > 150) return "";
      if (name === "#text") return tree2.text(node);
      if (name === "annotation" || name === "annotation-xml" || excluded(node)) return "";
      if (name === "br") return "\n";
      return Array.from(children(node), (child) => plain(child, depth + 1)).join("");
    }
    function visit(node, kind, inline, depth) {
      if (depth > 150) return;
      const name = tag(node);
      if (name === "#text") {
        if (node === picked) containsPick = true;
        parts.push({ text: tree2.text(node), span: inline });
        return;
      }
      if (excluded(node)) return;
      const found = classes(node);
      if (coverImages.has(node) && figureDescriptions.has(attr(node, "alt") || "")) return;
      if (name === "a" && /^h[1-6]$/.test(kind) && attr(node, "href")?.startsWith("#") && /^[#¶§🔗]+$/u.test(clean(plain(node)))) return;
      if (name === "h1" && found.includes("small") && Array.from(children(node)).some((child) => tag(child) === "a")) return;
      const block = blocks.has(name);
      const graphic = name === "img" || name === "object" && (attr(node, "type") || "").startsWith("image/");
      if (block || graphic || name === "table") flush();
      const id = attr(node, "id");
      if (id && id.length <= 256) ids.push(id);
      if (node === picked) containsPick = true;
      if (picked !== void 0 && (name === "pre" || name === "table" || name === "math") && tree2.contains?.(node, picked)) {
        if (name !== "table" || !found.some((c) => /ltx_eqn|ltx_equation/.test(c))) containsPick = true;
      }
      if (name === "br") {
        parts.push({ text: " " });
        return;
      }
      if (graphic) {
        const src = articleUrl(attr(node, "data-src") || attr(node, name === "object" ? "data" : "src") || "", base);
        if (src && attr(node, "role") !== "presentation" && !["0", "1"].includes(attr(node, "width") || "") && !["0", "1"].includes(attr(node, "height") || "")) {
          const alt = clean(attr(node, "alt") || "").slice(0, 1024);
          add(alt || "Illustration", { kind: "image", image: { url: src.href, alt } });
        }
        return;
      }
      if (name === "pre") {
        const code = plain(node).replace(/^\n|\n$/g, "").trimEnd();
        if (code.trim()) add(code, { kind: "pre" });
        return;
      }
      if (name === "math") {
        const tex = attr(node, "alttext")?.trim();
        parts.push({ text: clean(plain(node)) || tex || "", span: tex && tex.length <= 4096 ? { kind: "math", value: tex } : inline });
        return;
      }
      if (name === "table" && !found.some((c) => /ltx_eqn|ltx_equation/.test(c))) {
        let rows2 = function(row) {
          if (tag(row) === "tr") {
            const values = Array.from(children(row)).filter((cell) => ["th", "td"].includes(tag(cell))).map((cell) => clean(plain(cell)));
            if (values.length) cells.push(values);
          } else if (["tbody", "thead", "tfoot", "table"].includes(tag(row))) for (const child of children(row)) rows2(child);
        };
        var rows = rows2;
        const cells = [];
        rows2(node);
        if (cells.length) add(cells.map((row) => row.join("	")).join("\n"), { kind: "table", cells });
        return;
      }
      let next = kind;
      if (/^h[1-6]$/.test(name)) next = name;
      else if (name === "figcaption" || researchBlog && name === "div" && found.includes("caption")) next = "caption";
      else if (name === "blockquote") next = "quote";
      else if (name === "li") next = "list";
      else if (found.includes("ltx_equation") || found.includes("ltx_eqn_row")) next = "equation";
      else if (found.includes("ltx_authors") || found.includes("author")) next = "byline";
      if (name === "a") {
        const link = articleUrl(attr(node, "href") || "", base);
        if (link) inline = { kind: "link", value: link.href };
      } else if (!inline && ["code", "em", "strong", "b", "i"].includes(name)) {
        inline = { kind: name === "b" || name === "strong" ? "strong" : name === "code" ? "code" : "em" };
      }
      const previous = current;
      if (block) current = next;
      for (const child of children(node)) visit(child, next, inline, depth + 1);
      if (block) {
        flush();
        current = previous;
      }
    }
    if (storyHeader && storyBody) {
      visit(storyHeader, "p", void 0, 0);
      if (storySummary) visit(storySummary, "p", void 0, 0);
      visit(storyBody, "p", void 0, 0);
    } else visit(articleRoot, "p", void 0, 0);
    flush();
    if (!paragraphs.length) throw new Error("No visible article text was found on this page. Open the original webpage and use the browser extension.");
    return { article: { url: address, title: title || pageTitle || new URL(address).hostname, paragraphs, articleLayout: layout2 }, index: pickedIndex };
  }

  // src/extension/web-page.ts
  var blockTags = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption,dt,dd,th,td,div,section,article,main,body";
  var tidy = (text) => text.replace(/\s+/g, " ").trim();
  function elementOf(node) {
    return node instanceof Element ? node : node.parentElement;
  }
  function currentPick() {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const start = elementOf(range.startContainer);
    const end = elementOf(range.endContainer);
    const controls = 'input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[data-dsh-paper-reader]';
    if (!start || !end || start.closest(controls) || end.closest(controls)) return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const block = start.closest(blockTags) || start;
    const surrounding = tidy(block instanceof HTMLElement ? block.innerText : block.textContent || "");
    const index = Math.max(0, surrounding.indexOf(tidy(text)));
    const context = surrounding.slice(Math.max(0, index - 900), index + Math.min(text.length, 1800) + 900);
    return { range: range.cloneRange(), block, text, context: context || text };
  }
  var tree = {
    tag: (node) => node instanceof Element ? node.localName : node.nodeName,
    attr: (node, name) => node instanceof Element ? node.getAttribute(name) : null,
    children: (node) => node.childNodes,
    text: (node) => node.textContent || "",
    contains: (parent, child) => parent.contains(child),
    invisible(node) {
      if (!(node instanceof Element)) return false;
      const style = getComputedStyle(node);
      return style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden";
    }
  };
  function snapshot(pick) {
    if (!document.body) throw new Error("The page content has not loaded yet.");
    const { article, index: selected } = extractArticle(document, tree, location.href, document.title, pick?.range.startContainer);
    let index = selected < 0 ? 0 : selected;
    if (pick && selected < 0) {
      index = article.paragraphs.findIndex((text) => text === pick.context);
      if (index < 0) {
        index = article.paragraphs.length;
        article.paragraphs.push(pick.context);
      }
    }
    return { article, anchor: "p-" + (index + 1), label: "Paragraph " + (index + 1) };
  }

  // src/extension/card.ts
  var WebSource = class {
    constructor(pick) {
      this.pick = pick;
    }
    pick;
    captured;
    importing;
    bookSource;
    bookPage;
    docId = "";
    url = location.href;
    get page() {
      if (this.captured) return this.captured;
      if (this.url !== location.href || this.pick && !this.pick.range.startContainer.isConnected) {
        throw new Error("The article has changed. Select the passage again to save its location.");
      }
      return this.captured = snapshot(this.pick);
    }
    record() {
      if (this.bookSource) return this.bookSource;
      const { article, anchor, label } = this.page;
      return { docId: this.docId, title: article.title, sourceUrl: article.url, anchor, label, page: 1 };
    }
    async collect() {
      this.importing ??= this.importSource().catch((error) => {
        this.importing = void 0;
        throw error;
      });
      return this.importing;
    }
    async importSource() {
      if (openStaxLocation(this.url)) {
        const { doc, page, anchor: fragment } = await action("web.open", { url: this.url });
        if (!doc.book) throw Error("This book section could not be opened.");
        this.bookPage = page ?? null;
        const number = page || doc.defaultPage || 1;
        let anchor = fragment || "";
        if (this.pick) {
          const text = this.pick.text.trim().replace(/\s+/g, " ");
          const context = this.pick.context.trim().replace(/\s+/g, " ");
          const matches = (doc.paragraphs ?? []).map((p, i) => ({ p: p.replace(/\s+/g, " "), id: "p-" + (i + 1) })).filter(({ p }) => p.includes(text));
          const ids = /* @__PURE__ */ new Set();
          for (let node = this.pick.block; node; node = node.parentElement) if (node.id) ids.add(node.id);
          const structural = matches.filter((m) => doc.articleLayout?.[m.id]?.ids?.some((id) => ids.has(id)));
          const exact = matches.filter((m) => m.p === context);
          const best = structural.length === 1 ? structural : exact.length === 1 ? exact : matches;
          if (best.length !== 1) throw Error("Open this section in the reader and select the passage there to save its exact location.");
          anchor = best[0].id;
        }
        const local = new URL(readerAddress(await getOrigin(), doc.id, anchor, this.bookPage));
        if (this.pick) local.searchParams.set("quote", this.pick.text.slice(0, 1024));
        return this.bookSource = { docId: doc.id, title: doc.title, page: number, anchor, label: doc.book.sections[number - 1].title, sourceUrl: local.href };
      }
      return action("web.import", this.page.article).then(({ doc }) => {
        if (!doc?.id) throw new Error("DSH did not return an article ID. Try again.");
        this.docId = doc.id;
        return this.record();
      });
    }
    async open() {
      const source = await this.collect();
      await askWorker({ type: "reader", doc: source.docId, anchor: source.anchor, page: this.bookPage });
    }
  };
  var layout = `
<section class="card" role="dialog" aria-label="DSH selection card" lang="en">
  <div class="head"><h2></h2><button type="button" class="close" data-do="close" aria-label="Close card">\xD7</button></div>
  <div class="modes"><button type="button" data-do="translate">Translate</button><button type="button" data-do="explain">Explain in context</button><button type="button" data-do="followup">Ask</button></div>
  <p class="question" hidden></p>
  <p class="answer hint" aria-live="polite">Choose a lookup to use your DSH model.</p>
  <details class="model-picker" hidden><summary>Question model</summary></details>
  <form class="editor" hidden><label><span></span><textarea rows="2"></textarea></label>
    <div class="editor-actions"><button type="button" data-do="cancel">Cancel</button><button type="submit" class="primary" data-do="submit">Send</button></div>
  </form>
  <div class="foot"><button type="button" data-do="open">Read \u2197</button><button type="button" data-do="vocab">\u2606 Save word</button><button type="button" class="primary" data-do="note">Add to notes</button></div>
  <p class="status" role="status"></p>
</section>`;
  function showCard(pick, close, restored) {
    const source = new WebSource(pick);
    const host = document.createElement("div");
    host.dataset.dshPaperReader = "";
    const setHost = (name, value) => host.style.setProperty(name, value, "important");
    for (const [name, value] of Object.entries({ all: "initial", position: "fixed", display: "block", "z-index": "2147483647", width: "min(306px, calc(100vw - 16px))" })) setHost(name, value);
    const shadow = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cardStyle);
    shadow.adoptedStyleSheets = [sheet];
    const template = document.createElement("template");
    template.innerHTML = layout;
    shadow.append(template.content.cloneNode(true));
    const panel = shadow.querySelector(".card");
    const answer = shadow.querySelector(".answer");
    const submitted = shadow.querySelector(".question");
    const status = shadow.querySelector(".status");
    const editor = shadow.querySelector("form");
    const modelPicker = shadow.querySelector(".model-picker");
    const textarea = shadow.querySelector("textarea");
    const button = (id) => shadow.querySelector('[data-do="' + id + '"]');
    const turns = restored?.turns.slice() ?? [];
    const fields = restored ? { ...restored.fields } : { followup: "", note: "" };
    const events = new AbortController();
    let formMode = restored?.mode ?? "note";
    let meaning = restored?.meaning ?? "";
    let busy = false;
    let savedWord = false;
    let savedNote = false;
    shadow.querySelector("h2").textContent = pick.text;
    modelPicker.ontoggle = () => {
      modelPicker.querySelector("form")?.remove();
      if (!modelPicker.open) return;
      modelPicker.append(questionModelForm({
        label: (english) => english,
        load: () => action("ai.models", {}),
        save: (questionModel) => run(async () => {
          await action("ai.selectModel", { questionModel });
          modelPicker.open = false;
          modelPicker.querySelector("summary").textContent = ["Question model", questionModel?.model, questionModel?.reasoningEffort].filter(Boolean).join(" \xB7 ");
        })
      }));
    };
    function position() {
      if (!pick.range.startContainer.isConnected) {
        close();
        return;
      }
      const rects = Array.from(pick.range.getClientRects()).filter((r) => r.width && r.height);
      const rect = rects.at(-1) || pick.range.getBoundingClientRect();
      const line = rects.filter((r) => r.top < rect.bottom && r.bottom > rect.top);
      const left = line.length ? Math.min(...line.map((r) => r.left)) : rect.left;
      const bottom = window.innerHeight - 8;
      setHost("visibility", rect.bottom < 0 || rect.top > window.innerHeight ? "hidden" : "visible");
      setHost("left", Math.max(8, Math.min(left, window.innerWidth - host.offsetWidth - 8)) + "px");
      const fitsBelow = rect.bottom + 8 + host.offsetHeight <= bottom;
      const top = fitsBelow ? rect.bottom + 8 : rect.top - host.offsetHeight - 8;
      setHost("top", Math.max(8, Math.min(top, bottom - host.offsetHeight)) + "px");
    }
    function controls() {
      for (const input of shadow.querySelectorAll("button[data-do]")) {
        const id = input.dataset.do;
        input.disabled = id !== "close" && (busy || id === "vocab" && savedWord || id === "note" && savedNote);
      }
      textarea.disabled = busy;
    }
    async function run(operation) {
      if (busy) return;
      busy = true;
      controls();
      status.textContent = "";
      try {
        await operation();
      } catch (error) {
        status.textContent = errorText(error);
      } finally {
        busy = false;
        controls();
      }
    }
    function toggleMode(mode) {
      for (const item of shadow.querySelectorAll(".modes button")) item.setAttribute("aria-pressed", String(item.dataset.do === mode));
    }
    async function lookup(mode, question) {
      modelPicker.hidden = true;
      modelPicker.open = false;
      toggleMode(mode);
      submitted.hidden = !question;
      submitted.textContent = question || "";
      answer.className = "answer hint";
      answer.textContent = "Looking up\u2026";
      let reply;
      try {
        const result = await action("ai", { mode, text: pick.text, context: pick.context, ...question ? { question, history: turns.slice(-8) } : {} });
        reply = result?.text?.trim();
        if (!reply) throw new Error("The model returned an empty answer. Try again.");
      } catch (error) {
        answer.className = "answer error";
        answer.textContent = errorText(error);
        modelPicker.hidden = mode !== "followup";
        return;
      }
      answer.className = "answer";
      answer.textContent = reply;
      turns.push({ role: "user", content: question || (mode === "explain" ? "Explain the selection in context." : "Translate the selection.") }, { role: "assistant", content: reply });
      if (mode === "followup") fields.followup = "";
      editor.hidden = true;
      if (mode !== "followup") {
        if (mode === "translate" || !meaning) meaning = reply;
        try {
          await action("history.add", { ...source.record(), text: pick.text, meaning: reply, context: pick.context });
        } catch (error) {
          status.textContent = "Could not save lookup history. " + errorText(error);
        }
      }
    }
    function edit(mode) {
      modelPicker.hidden = mode !== "followup";
      modelPicker.open = false;
      formMode = mode;
      editor.hidden = false;
      editor.querySelector("label span").textContent = mode === "note" ? "Note" : "Ask about this passage";
      textarea.value = fields[mode];
      textarea.placeholder = mode === "note" ? "Optional. Leave blank to save the meaning or quote." : "What does this word refer to here?";
      textarea.required = mode === "followup";
      button("submit").textContent = mode === "note" ? "Save note" : "Send";
      if (mode === "followup") toggleMode(mode);
      position();
      textarea.focus({ preventScroll: true });
    }
    textarea.oninput = () => {
      fields[formMode] = textarea.value;
    };
    panel.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    panel.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const id = event.target.closest("button")?.dataset.do;
      if (id === "close") {
        close();
        return;
      }
      if (busy) return;
      if (id === "translate" || id === "explain") {
        editor.hidden = true;
        void run(() => lookup(id));
      } else if (id === "note" || id === "followup") edit(id);
      else if (id === "cancel") {
        fields[formMode] = "";
        editor.hidden = modelPicker.hidden = true;
        modelPicker.open = false;
      } else if (id === "open") void run(() => source.open());
      else if (id === "vocab") void run(async () => {
        const saved = await source.collect();
        await action("vocab.save", { ...saved, text: pick.text, meaning, context: pick.context });
        savedWord = true;
        button("vocab").textContent = "Word saved";
        status.textContent = "Saved to your vocabulary.";
      });
    });
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!event.isTrusted || busy) return;
      const value = textarea.value.trim();
      if (formMode === "followup") {
        if (value) void run(() => lookup("followup", value));
        return;
      }
      void run(async () => {
        const saved = await source.collect();
        await action("note.save", { ...saved, text: value || meaning || pick.text, quote: pick.text });
        editor.hidden = true;
        fields.note = "";
        savedNote = true;
        button("note").textContent = "Note added";
        status.textContent = "Added to this article\u2019s notes.";
      });
    });
    document.documentElement.appendChild(host);
    const size = new ResizeObserver(position);
    size.observe(panel);
    window.addEventListener("resize", position, { signal: events.signal });
    document.addEventListener("scroll", position, { capture: true, passive: true, signal: events.signal });
    position();
    if (restored) {
      const previous = turns.findLast((turn) => turn.role === "assistant");
      if (previous) {
        answer.className = "answer";
        answer.textContent = previous.content;
      }
      if (restored.lastQuestion) {
        submitted.hidden = false;
        submitted.textContent = restored.lastQuestion;
      }
      edit(restored.mode);
    }
    return {
      host,
      source,
      get busy() {
        return busy;
      },
      get editing() {
        return !editor.hidden && Boolean(textarea.value.trim());
      },
      draft() {
        if (!fields.followup.trim() && !fields.note.trim()) return;
        return {
          mode: fields[formMode].trim() ? formMode : formMode === "note" ? "followup" : "note",
          fields: { ...fields },
          turns: turns.slice(-8),
          meaning,
          lastQuestion: submitted.hidden ? "" : submitted.textContent ?? ""
        };
      },
      translate: () => run(() => lookup("translate")),
      dispose() {
        size.disconnect();
        events.abort();
        host.remove();
      }
    };
  }

  // src/extension/content.ts
  var world = window;
  if (!world.dshPaperReaderReady) {
    let samePick2 = function(a, b) {
      return a.text === b.text && a.context === b.context && a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset && a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset;
    }, dismiss2 = function() {
      const pick = card?.source.pick;
      if (pick && card) {
        const node = pick.range.startContainer, kept = (drafts.get(node) ?? []).filter((entry) => !samePick2(entry.pick, pick));
        const draft = card.draft();
        if (draft) kept.push({ pick, draft });
        if (kept.length) drafts.set(node, kept);
        else drafts.delete(node);
      }
      card?.dispose();
      card = void 0;
    }, select2 = function() {
      const pick = currentPick();
      if (!pick) return;
      const previous = card?.source.pick;
      if (card?.busy || previous && samePick2(previous, pick)) return card;
      dismiss2();
      const restored = drafts.get(pick.range.startContainer)?.find((entry) => samePick2(entry.pick, pick));
      card = showCard(pick, dismiss2, restored?.draft);
      return card;
    }, schedule2 = function() {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        if (enabled) select2();
      });
    };
    samePick = samePick2, dismiss = dismiss2, select = select2, schedule = schedule2;
    world.dshPaperReaderReady = true;
    let enabled = false;
    let card;
    let scheduled = 0;
    const drafts = /* @__PURE__ */ new WeakMap();
    document.addEventListener("pointerdown", (event) => {
      if (event.isTrusted && card && !card.busy && !card.editing && !event.composedPath().includes(card.host)) dismiss2();
    }, true);
    document.addEventListener("pointerup", (event) => {
      if (enabled && event.isTrusted && event.button === 0 && (!card || !event.composedPath().includes(card.host))) schedule2();
    }, true);
    document.addEventListener("keyup", (event) => {
      if (!event.isTrusted) return;
      if (event.key === "Escape") {
        dismiss2();
        return;
      }
      if (enabled && (!card || !event.composedPath().includes(card.host)) && (event.shiftKey || event.key === "Shift")) schedule2();
    }, true);
    async function handle(command) {
      if (command === "enable") {
        enabled = true;
        select2();
      }
      if (command === "disable") {
        enabled = false;
        cancelAnimationFrame(scheduled);
        dismiss2();
      }
      if (command === "translate") {
        const open = select2();
        if (!open) throw new Error("Select a word or sentence on the page to translate.");
        await open.translate();
      }
      if (command === "capture") {
        const pick = currentPick();
        const previous = card?.source.pick;
        const same = previous && pick && previous.range.startContainer === pick.range.startContainer && previous.range.startOffset === pick.range.startOffset && previous.text === pick.text;
        await (same && card ? card.source : new WebSource(pick)).open();
      }
      return { enabled };
    }
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message.channel !== "paper-reader-page" || sender.id !== chrome.runtime.id) return;
      void handle(message.command).then((data) => respond({ ok: true, data }), (error) => respond({ ok: false, error: errorText(error) }));
      return true;
    });
  }
  var samePick;
  var dismiss;
  var select;
  var schedule;
})();
