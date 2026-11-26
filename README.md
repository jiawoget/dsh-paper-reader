# DSH Paper Reader

[中文使用与交付说明](交付说明.md)

Paper Reader runs inside the DeepSeek Harness (DSH) Web sidebar for side-by-side reading of PDFs, web articles, and OpenStax books. You can translate passages into your chosen language, ask questions about a passage, figure, or whole paper, keep source-linked Notes and Marks, and export BibTeX or RIS citations. A companion Chrome and Edge extension adds selection lookup and page capture on ordinary websites.

The interface switches automatically between English and Simplified Chinese based on your browser locale. Dark mode follows DSH Web (`body[data-ds-dark-theme]`) or your system `prefers-color-scheme: dark` setting in standalone tabs, including the extension popup and floating card. PDF pages default to a white paper surface, and you can switch page surfaces under `Aa` between Paper, Warm Sepia, Low-Glare Dim, and Smart Dark.

## Install in DSH

Requires Node.js `>=24.9`. Tested with DeepSeek Harness Web `0.2.2-rc.5`.

1. Open **Plugins → Add plugin** in the DSH sidebar.
2. Paste `github:jiawoget/dsh-paper-reader` and choose **Install**. If DSH prompts for install scripts from `onnxruntime-node` or `protobufjs`, review the list and choose **Allow these scripts and retry**.
3. Choose **Enable now** (and restart DSH if prompted), then open **Paper Reader** in the sidebar to view the bundled bilingual paper.

To install from a terminal instead, stop any running `dsh web` process and run:

```sh
dsh plugin --profile web add github:jiawoget/dsh-paper-reader --allow-build=onnxruntime-node --allow-build=protobufjs
dsh web
```

The two `--allow-build` flags cover the only production dependencies with install scripts (`onnxruntime-node` and `protobufjs`). To uninstall later, open **Plugins → Installed plugins → dsh-paper-reader → Uninstall**.

## Library and reading modes

### Sources and local document management

Open **Library** to load four kinds of sources:

- **Local PDFs**: Choose Open a PDF to import one or more files (up to 80 MB each), or drag and drop PDFs onto the reader or Library dialog. Paper Reader extracts embedded PDF metadata plus arXiv IDs and DOIs from the first page. The bundled 16-page PagedAttention paper opens on page 6 with a prebuilt Simplified Chinese translation.
- **Web articles, arXiv, and DOIs**: Choose Open web page and paste an HTTP/HTTPS article URL, a bare arXiv ID (such as `2309.06180`), an `arxiv.org/abs/` or `arxiv.org/pdf/` URL, or a bare DOI (`10.xxxx/...`). Academic identifiers import the paper metadata and PDF directly; ordinary webpages extract prose, code blocks, figures, tables, and equations with offline figure caching.
- **OpenStax books**: Paste an OpenStax book or section URL and choose Open book. The Contents tab groups sections by chapter, downloads each section on demand, and resumes at the last paragraph you read.
- **Zotero libraries**: Open Library → Zotero to browse desktop or web collections, filter by title, author, or year, and open attached PDFs or linked webpages.

On this device (the default Library tab when Zotero is not connected) stores opened documents for offline access. Filter by reading status (Unread, Reading, Done, Starred) or type (PDF, Web, Book), sort by recently read, recently added, or title, and organize items with stars and tags. Each row tracks reading progress (`p. N / M` for PDFs, `%` scroll progress for web articles, and section resume for OpenStax books). The search bar searches across local documents, notes, and marks; click any hit to jump straight to that document, note, or highlight. You can rename or delete any imported document there; deleting removes its files, cached translations across languages, SQLite records (Notes, Marks, Paper chat, vocabulary entries, outlines, citations, and triage/progress metadata), and saved browser reading state. The bundled PagedAttention sample stays protected from renaming and deletion.

### Bilingual reading, navigation, PDF controls, and offline model

Papers start in Original view. Select text in either language to highlight its counterpart, or switch to Bilingual view (Translation on narrow screens) to compare both columns side by side. On phones (`<= 520px`), the reader switches to a compact topbar (`<= 52px`) and a thumb-reachable bottom bar with `>= 44×44px` touch targets.

For PDFs, choose translation scope between Full page, Active column, and Active passage, or toggle between Read text and View PDF page. When a bilingual pane is narrower than 500 px, Full page automatically switches to Active column to keep translated text legible. Use the inline language selector and Re-translate button in the translation header to switch target languages or re-run the current page (or pick Re-translate passage from the selection card's More menu). Figure lettering, table cells, and display equations remain in their printed form while prose and captions translate.

Adjust PDF display with `Aa` (Paper, Warm Sepia, Low-Glare Dim, Smart Dark), zoom presets (Fit page, `75%`, Fit width, `125%`, `150%`, `200%`), `-`/`+` buttons, or `Ctrl/Cmd+Wheel`. Move through long papers with 50-step jump history (`<` / `>`, `Alt+←` / `Alt+→`), native PDF internal links, Contents bookmarks (or Generate contents with AI when a PDF has none), and cross-page full-text search (`Ctrl/Cmd+F`) across PDFs, web articles, OpenStax books, and cached translations. To restore default pane widths after resizing, use More actions → Reset reading layout.

Open **Connections** (More actions → Connections) to manage settings across three tabs (AI & Translation, Obsidian, Zotero) with a sticky Save connections footer. Under AI & Translation, choose from eight built-in translation languages (Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Spanish) or Custom… (up to 64 characters), define a Translation glossary (`term = translation`, or `term` alone to keep it unchanged) to lock terms during AI translation, and add custom research prompt templates. Cached pages are stored per language, so switching back reuses prior translations without repeating model requests. When a translation request fails, the translated header offers Retry translation and Connections.

Both the bundled PagedAttention translation and the optional local CPU translator apply only when Translation language is Simplified Chinese; other languages require a connected DSH or custom LLM. To install the optional offline English-to-Chinese OPUS-MT model (about 120 MB, SHA-256 verified, pinned to commit `046f55ae`), run:

```sh
dsh plugin --profile web exec paper-reader-install-model
```

From a local clone, run `npm run install:translation-model` instead. Without configured LLM credentials, Paper Reader falls back to this local model for imported PDFs. Override its weights directory with `PAPER_READER_MT_MODEL_DIR`. ([OPUS-MT model card](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh) · [Pinned model files](https://huggingface.co/Xenova/opus-mt-en-zh/tree/046f55aec303cdee3e0318604406d4df20f1e8ea))

## Questions, Marks, and Notes

### Selection card, screenshots, and Paper chat

Selecting text opens a selection card with up to four primary actions: Highlight (with one-click Yellow/Key point, Green/Method, and Purple/Question dots), Ask AI (with Explain inside the discussion panel), Write note, and More (Save word, Re-translate passage, Insert passage link, Locate, and view switching). While drafting a note, Insert into note places selected text from an AI reply at the cursor, and saved notes become context for later questions about that passage.

For figures, tables, or equations in a PDF, web article, or OpenStax book, choose **Capture** in the top toolbar (or press `s`) and drag a box over the cutout overlay. From the capture bar you can Ask, Explain, Write note, Pin, Copy PNG, Save PNG, or Cancel. Pin creates up to three draggable, collapsible, zoomable floating figure cards that stay on screen across page turns and jump back to the source page through jump history. Choose Add a screenshot beside a follow-up to compare two regions together. Vision-capable models read cropped images directly; text-only models use selectable text inside the crop.

Open **Paper chat** at the bottom of the reader (**Section chat** for OpenStax books) to ask about the whole document. Replies stream incrementally with live Markdown and KaTeX rendering, and clicking Stop keeps the partial reply with Retry, Copy, and Delete controls. You can also copy or delete individual exchanges and reset threads with Clear chat. Clickable `(p. N)` chips inside AI answers jump directly to the cited page.

Use the inline Question model popover (shared with passage questions) to pick a DSH model and reasoning effort by name, and attach the active selection with Use selected passage. Empty threads offer built-in bilingual research prompt chips (Structured Brief, Datasets & Metrics, Methodology Critique, Key Equations & Notation in Paper chat; Explain Step-by-Step, Extract Equation (LaTeX), Extract Table (Markdown), Intuition & Example in Selection/Region chat) alongside custom templates defined under Connections → AI & Translation → Custom research prompts. Unsent passage discussion drafts also appear under Unsent questions. Save any reply with Add to Notes, or highlight a sentence to Save selection (with Undo and View), and reopen the original thread later via View discussion.

### Notes, Marks, Reading Pack export, and Obsidian sync

The sidebar organizes study panels across four tabs: Contents, Notes, Marks, and Reference. Dock the sidebar on the left or right, float it over the paper, or let narrow screens switch it to a bottom sheet.

- **Notes**: a Markdown editor with a Markdown source toggle, Refresh notes, and bidirectional passage links. Place the cursor in a sentence or table cell, select a passage in the paper, and choose Insert passage link to jump back later.
- **Marks**: collects Yellow (Key point), Green (Method), and Purple (Question) highlights alongside page pins (Add page note / Pin on PDF), with All, Highlights, and Page notes tabs, color filter pills, keyword search, and Cite in Notes.
- **Reading Pack Markdown export**: both Notes and Marks include Copy Markdown and Download .md actions that export YAML frontmatter, notes, vocabulary, and page-grouped highlights and page notes.
- **Highlight display**: under Notes, set Highlights to In Notes to show highlights alongside matching notes, or In Marks only to keep the writing area clear.
- **Vocabulary and history**: open More actions → Vocabulary and history to search saved words and prior lookups across documents.

To sync notes with Obsidian, choose **Connect Obsidian** (or Connections → Obsidian) and pick your local vault folder. Paper Reader edits `.md` files directly under `<vault>/Paper Reader/` (one file per paper, or one file per chapter for OpenStax books such as `Paper Reader/principles-finance/1 Introduction to Finance.md`) and stores linked source copies under `Paper Reader/Sources/`. Export to Obsidian writes notes and Marks together while preserving bidirectional sync; Saved to vault confirms writes, Refresh notes loads external edits, and Compare latest resolves conflicting edits side by side.

## Citations and Zotero

Hover, click, or keyboard-focus numbered citations in the text to open the citation popover with Jump to References (p. N), Copy, and Open / Import (which imports linked arXiv, DOI, or web references straight into the reader). Open the **Reference** tab to edit document metadata inline (Edit metadata for title, authors, venue, year, and DOI), inspect formatted output in the collapsible Preview BibTeX / RIS panel, and export via Copy BibTeX, Download .bib, Copy RIS, or Download .ris. Exports build deterministic ASCII citekeys, escape LaTeX special characters, detect arXiv IDs, extract academic HTML `<meta>` tags (`citation_*` and `dc.*`) from imported webpages, and merge fields from linked Zotero items.

For desktop Zotero access, turn on "Allow other applications on this computer to communicate with Zotero" in Zotero's advanced settings. For remote access, open Connections → Zotero (or Library → Zotero → Connection settings), switch to Web library, and enter your library ID (plus a read-access API key for private libraries). From Reference, you can link a document to an existing Zotero item or file it into collections. ([Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api) · [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/basics))

## Keyboard shortcuts

Press `?` or open **More actions → Keyboard shortcuts** inside the reader to open the two-column shortcut modal. Single-key shortcuts pause automatically while typing in inputs, the Notes editor, or open dialogs.

| Area | Key | Action |
|---|---|---|
| Reading | `←` / `→` | Previous or next PDF page / OpenStax book section |
| Reading | `g` | Go to page |
| Reading | `Alt+←` / `Alt+→` | Jump back or forward in reading history |
| Reading | `Ctrl/Cmd+F` | Find in document |
| Reading | `b` | Toggle Original and Bilingual view |
| Reading | `s` | Ask with a screenshot (Capture) |
| Reading | `+` / `=` / `-` | Zoom in or zoom out |
| Reading | `?` | Open keyboard shortcuts |
| Reading | `Esc` | Cancel screenshot, close menu, card, search, or dialog |
| Panels | `l` | Open Library |
| Panels | `n` / `c` / `m` / `r` | Toggle Notes, Contents, Marks, or Reference sidebar |
| Panels | `←` / `→` / `Home` / `End` | Switch tabs in sidebar, Library, Connections, or Vocabulary and history |
| Notes editor | `Ctrl/Cmd+S`, `Ctrl/Cmd+B`, `Ctrl/Cmd+I` | Save notes, bold text, italic text |
| Notes editor | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Y` | Undo or redo |
| Composers | `Enter` / `Shift+Enter` | Send Paper chat or selection message / new line |
| Composers | `Ctrl/Cmd+Enter` | Save selection note or mark |

## Optional browser extension

To look up passages or capture login-gated pages on any website, download and extract the [repository ZIP](https://github.com/jiawoget/dsh-paper-reader/archive/refs/heads/main.zip). Open the extensions page in Chrome or Edge, turn on Developer mode, choose **Load unpacked**, and select `dist/extension`.

The extension reuses your signed-in DSH Web session in the same browser profile and needs no separate pairing token. Open the extension popup, expand **Connection settings**, enter your Local DSH address (default `http://127.0.0.1:29812`), and keep that DSH Web tab open.

In the popup, choose Enable selection cards to show the floating card (Translate, Explain in context, Ask, ☆ Save word, Add to Notes, Read ↗) when you highlight text, Open in Paper Reader to capture and open the active page, or Save silently to library to save the page in the background without switching tabs and flash a `✓` badge on the extension icon. On `arxiv.org/abs/`, `arxiv.org/pdf/`, and `.pdf` tabs, capture imports the paper directly instead of scraping the browser PDF viewer. Right-clicking a page or selection also exposes Translate selection with DSH and Open in Paper Reader.

## Development and testing

Source code, build scripts, and tests use strict TypeScript (`Node.js >=24.9`). Keep `dist/` committed because DSH installs plugins directly from GitHub; rebuild before committing code or stylesheet changes. Static assets live in `public/` and `extension/`.

```sh
npm ci
npm run typecheck
npm run build
npm run check
npm run dev
npm start
npm test
npm run test:e2e
```

- `npm run build` runs `npm run typecheck` and bundles all server, web, client, and extension targets into `dist/`. `npm run dev` watches source and asset files.
- `npm run check` runs `scripts/check-hygiene.ts` to verify file-size ceilings and ratchets, stylesheet line length and selector overlap, dead exports, and cross-file duplication.
- `npm start` launches local DSH Web with `paper-reader.patch.yml` on `http://127.0.0.1:29812`.
- `npm test` runs the `node:test` unit and integration suites under `tests/*.test.ts`.
- `npm run test:e2e` runs the Playwright suites in isolated Chrome profiles against ephemeral DSH hosts (`--port 0` and temporary `DSH_HOME`).

To run a single default E2E suite, invoke scripts from `package.json` such as `npm run test:browser`, `npm run test:extension`, `npm run test:integrations`, `npm run test:target-language`, `npm run test:citation-export`, `npm run test:dark-theme-a11y`, or `npm run test:shortcuts-i18n`.

Three default `npm run test:e2e` suites (`npm run test:reader-selection`, `npm run test:paper-chat`, and `npm run test:zotero-desktop`) also accept optional local-PDF or live-service environment variables, while `npm run test:passage-links` and `npm run test:reading-layout` accept an optional local PDF path as a CLI argument.

Four opt-in suites stay outside `npm run test:e2e` because they require an external PDF, live internet access, or a live model: `npm run test:pdf-artwork`, `npm run test:floating-selection`, `npm run test:zotero-public`, and `npm run test:sidebar-model`.

Runtime data defaults to `$DSH_HOME/paper-reader` (or `~/.dsh/paper-reader`). Key environment variables:

- `PAPER_READER_HOME`: overrides the plugin data directory.
- `PAPER_READER_MT_MODEL_DIR`: overrides the local OPUS-MT weights directory.
- `PAPER_READER_HEADED=1`, `CHROME_PATH`, `DSH_ENTRY`: controls visible Playwright runs and binary paths for E2E suites.
- `PAPER_READER_LIVE_CHAT=1`, `PAPER_READER_SELECTION_PDF`, `PAPER_READER_LIVE_ZOTERO_DESKTOP=1`: enables live-model, external-PDF, or Windows desktop Zotero write tests.

Browse acceptance walkthroughs and screenshots for [OpenStax and Google Research](docs/acceptance/books-and-blog/ACCEPTANCE.md), [web reading and Zotero](docs/acceptance/web-zotero/ACCEPTANCE.md), and [the contents sidebar and PDF outline](docs/acceptance/sidebar-contents/ACCEPTANCE.md).

Kwon and colleagues' PagedAttention paper is distributed under CC BY 4.0; the bundled Simplified Chinese edition is an adaptation. See [Paper attribution and license](public/assets/paper-attribution.txt).
