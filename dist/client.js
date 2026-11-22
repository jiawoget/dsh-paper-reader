"use strict";
(() => {
  // src/client/dsh.ts
  window.__ModuleLoader__.load({ id: "dsh-paper-reader", factory: (require2) => {
    const h = require2("react").createElement;
    const panel = "paper-reader";
    function Reader() {
      return h("iframe", {
        title: "Paper Reader",
        src: new URL("api/paper-reader/app/index.html", document.baseURI).href,
        style: { border: 0, display: "block", alignSelf: "stretch", flex: "1 1 0", width: "100%", height: "100%", minHeight: 0 }
      });
    }
    function Book() {
      return h(
        "svg",
        { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true },
        h("path", { d: "M3 4.5C6.3 3.7 9.1 4.2 12 6c2.9-1.8 5.7-2.3 9-1.5v14c-3.3-.8-6.1-.3-9 1.5-2.9-1.8-5.7-2.3-9-1.5zM12 6v14" })
      );
    }
    return { inject: ["slots", "layout"], apply(ctx) {
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: panel }, Reader));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: panel, order: -22, label: () => "Paper Reader" }, Book));
    } };
  } });
})();
