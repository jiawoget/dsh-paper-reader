# Paper Reader annotation implementation plan

The approved design is recorded in *阅读与笔记设计稿*. Use the existing TypeScript reader, DSH action service, SQLite database and CodeMirror notebook.

- [x] Persist document-scoped annotations separately from Markdown. Test create/retry, revision-checked updates, delete/restore, coordinates and unchanged notebook content.
- [x] Repaint highlights from saved source locators and anchored PDF pins on changes to page, layout, zoom and language. Keep selection tools and existing source links working. Give overlapping pins a chooser and support keyboard placement.
- [x] Connect the Marks index, in-page editor and notebook citation action. Preserve drafts across mode changes, report conflicting versions, provide undo, and encode the page position in pin citations so deletion of a note still leaves a usable reference.
- [x] Keep one notebook DOM across docked, floating and compact layouts. Retain the editor and selection during repositioning and give dual-language reading enough width.
- [x] Verify the real DSH workflow on PagedAttention pages 6 and 7, reopen a citation in a fresh view, check narrow and desktop layouts, and run type checking, unit tests and affected browser regressions.
