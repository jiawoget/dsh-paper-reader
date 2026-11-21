# Reading desk improvements

The existing paper reader runs in Chrome and edits the same Markdown vault as Obsidian. This revision follows the November 20 feedback on composing a note while reading an AI answer. All implementation and tests use strict TypeScript. The interface and project documentation use English.

| Workflow | Implementation and acceptance |
| --- | --- |
| Draft from an answer | Selection notes and chat share the editor caret. Insert a chosen answer excerpt between existing words, edit again, then explicitly save. Starting without a draft opens one. Omit the redundant translation prompt. |
| Cite a passage from a notebook | The Chrome Markdown editor retains its insertion position while the reader selects a passage. Compact source links can coexist in prose and table cells and restore each exact location after reopening the notebook. |
| Read a numbered citation | Resolve individual numbers, groups and ranges against the current paper's bibliography and reveal the titles on hover or keyboard focus. Keep unknown entries identifiable. |
| Arrange panels and read on a laptop | Each floating panel can collapse, pin, move and resize. The reader allocates width to original, translation and notebook with draggable dividers. A focused translation follows the active printed column alongside the full source. Check normal and scaled 1080p, keyboard controls and a wide viewport. |
| Read a sharp PDF | Size the PDF raster from the actual sheet width, reading zoom and pixel density. Refresh after resizing and keep copied figures and selectable overlays aligned. Check the downloaded ResNet PDF after changing pane widths. |
| Discuss a paper | A resizable dock below the paper accepts a question with a live selection or document-wide context. Follow-ups and the history of its paper survive page changes, re-opening and switching between papers. Verify a question requiring text beyond the current page and a selection conversation in the history. |
| Connect Zotero | The connection screen reports the service actually reached and its permissions. Exercise connection, search, linking and filing using a disposable real library where supported. Distinguish desktop, Web API and test services in the report. |

The independent browser reviewer receives the user-visible feature list. Keep one acceptance screenshot for each workflow and preserve the user's open drafts, vault and Zotero library during verification.
