# Paper Reader implementation and acceptance

Build the reading experience from the selected three-column PDF design in the earlier [design discussion](https://chatgpt.com/c/6afd4cd7-7520-83e8-8d71-ee9301a9338f). The DSH plugin, browser extension, build tools and tests use strict TypeScript. Source, interface text, and project documentation use English. Paper translations retain the target language.

| Component | Acceptance |
| --- | --- |
| Paper view | PagedAttention page 6 retains the original figures on both sheets. Selecting a passage opens a floating card without moving its neighbors. A note or translated paragraph can reveal the original location. |
| Library | Reimporting a renamed local PDF keeps its notes. Modifying a captured article creates a new snapshot and preserves old links. |
| Notes and integrations | Notes, vocabulary and lookup history persist. Obsidian exports retain source links and the author's own edits. Zotero collections and model calls use explicitly configured services. |
| Browser extension | Chrome or Edge can look up a selection, translate a sentence, ask a follow-up, and send an article to the reader through the user's DSH session. |
| Verification | Type-check all first-party TypeScript, build the plugin and extension, run unit tests, and exercise the actual DSH sidebar and reader in a browser. Capture the interface on the local machine. |
