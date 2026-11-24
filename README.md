# DSH Paper Reader

[中文使用与交付说明](交付说明.md)

Paper Reader runs inside the DeepSeek Harness (DSH) Web sidebar for side-by-side reading of PDFs, web articles, and OpenStax books. You can translate passages into your chosen language, ask questions about a passage, figure, or whole paper, keep source-linked Notes and Marks, and export BibTeX or RIS citations. A companion Chrome and Edge extension adds selection lookup and page capture on ordinary websites.

The interface switches automatically between English and Simplified Chinese based on your browser locale. Dark mode follows DSH Web (`body[data-ds-dark-theme]`) or your system `prefers-color-scheme: dark` setting in standalone tabs, including the extension popup and floating card, while `.pdf-sheet` pages keep a white paper surface so printed text and figures stay readable.

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

- **Local PDFs**: Choose `Open a PDF` to import files up to 80 MB. The bundled 16-page PagedAttention paper opens on page 6 with a prebuilt Simplified Chinese translation.
- **Web articles**: Choose `Open web page` and submit `Read article` to extract prose, code blocks, figures, tables, and equations from a URL. Figures stay available offline after their first load.
- **OpenStax books**: Paste an OpenStax book or section URL and choose `Open book`. The `Contents` tab groups sections by chapter, downloads each section on demand, and resumes at the last paragraph you read.
- **Zotero libraries**: Open `Library → Zotero` to browse desktop or web collections, filter by title, author, or year, and open attached PDFs or linked webpages.

Documents you have opened stay under `On this device` even when Zotero is closed. You can rename or delete any imported document there; deleting removes its files, cached translations across languages, SQLite records (Notes, Marks, Paper chat, vocabulary entries, outlines, and citations), and saved browser layout state. The bundled PagedAttention sample stays protected from renaming and deletion.

### Bilingual reading, translation languages, and offline model

Papers start in `Original` view. Select text in either language to highlight its counterpart, or switch to `Bilingual` view (`Translation` on narrow screens) to compare both columns side by side. For PDFs, switch translation scope between `Full page`, `Active column`, and `Active passage`, or toggle between `Read text` and `View PDF page`. Figure lettering, table cells, and display equations remain in their printed form while prose and captions translate, and zooming or dragging splitters redraws pages at the displayed size. Open `Contents` for native PDF bookmarks or `Generate contents with AI` when a PDF has none, hover or keyboard-focus numbered citations to preview bibliography entries, and use `More actions → Reset reading layout` to restore default pane widths.

Open **Connections** (`More actions → Connections`) to choose `Translation language`. Eight presets are built in: Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, and Spanish. Pick `Custom…` to enter any target language up to 64 characters. Cached pages are stored per language, so switching back reuses prior translations without repeating model requests. When a translation request fails, the translated pane offers `Retry translation` and `Connections`.

Both the bundled PagedAttention translation and the optional local CPU translator apply only when `Translation language` is Simplified Chinese; other languages require a connected DSH or custom LLM. To install the optional offline English-to-Chinese OPUS-MT model (about 120 MB, SHA-256 verified, pinned to commit `046f55ae`), run:

```sh
dsh plugin --profile web exec paper-reader-install-model
```

From a local clone, run `npm run install:translation-model` instead. Without configured LLM credentials, Paper Reader falls back to this local model for imported PDFs. Override its weights directory with `PAPER_READER_MT_MODEL_DIR`. ([OPUS-MT model card](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh) · [Pinned model files](https://huggingface.co/Xenova/opus-mt-en-zh/tree/046f55aec303cdee3e0318604406d4df20f1e8ea))

## Questions, Marks, and Notes

### Selection card, screenshots, and Paper chat

Selecting text opens the selection card with `Explain`, `Ask AI`, `Save word` (for short terms), `Highlight`, `Write note`, and `Insert passage link`. While drafting a note, `Insert into note` places selected text from an AI reply at the cursor, and saved notes become context for later questions about that passage.

For figures, tables, or equations, choose **Ask with a screenshot** in the PDF toolbar, drag a box around the region, and pick `Ask`, `Explain`, or `Write note`. Choose `Add a screenshot` beside a follow-up to compare two regions together. Vision-capable models read the cropped images directly; text-only models use selectable text inside the crop.

Open **Paper chat** at the bottom of the reader (**Section chat** when reading an OpenStax book) to ask about the whole document. Pick a DSH model and reasoning effort under `Question model` (shared with passage questions), attach the active selection with `Use selected passage`, and cancel streaming replies with `Stop`. Drafted prompts survive page changes or refreshes under `Unsent questions`. Save any reply with `Add to Notes`, or highlight a sentence to `Save selection` (with `Undo` and `View`), and reopen the original thread later via `View discussion`.

### Notes, Marks, and Obsidian vault sync

The sidebar organizes study panels across four tabs: Contents, Notes, Marks, and Reference. Dock the sidebar on the left or right, float it over the paper, or let narrow screens switch it to a bottom sheet.

- **Notes**: a Markdown editor with a `Markdown` source toggle, `Refresh notes`, and bidirectional passage links. Place the cursor in a sentence or table cell, select a passage in the paper, and choose `Insert passage link` to jump back later.
- **Marks**: collects Yellow, Green, and Purple highlights alongside page pins (`Add page note` / `Pin on PDF`), with `All`, `Highlights`, and `Page notes` filters plus `Cite in Notes`.
- **Highlight display**: under `Notes`, set `Highlights` to `In Notes` to show highlights alongside matching notes, or `In Marks only` to keep the writing area clear.
- **Vocabulary and history**: open `More actions → Vocabulary and history` to search saved words and prior lookups across documents.

To sync notes with Obsidian, choose **Connect Obsidian** and pick your local **Obsidian vault** folder. Paper Reader edits `.md` files directly under `<vault>/Paper Reader/` (one file per paper, or one file per chapter for OpenStax books such as `Paper Reader/principles-finance/1 Introduction to Finance.md`) and stores linked source copies under `Paper Reader/Sources/`. `Saved to vault` confirms writes, `Refresh notes` loads external edits, and `Compare latest` resolves conflicting edits side by side.

## Citations and Zotero

Open the **Reference** tab to export formatted citations via `Copy BibTeX`, `Download .bib`, `Copy RIS`, and `Download .ris`. Exports build deterministic ASCII citekeys, escape LaTeX special characters, detect arXiv IDs, extract academic HTML `<meta>` tags (`citation_*` and `dc.*`) from imported webpages, and merge fields from linked Zotero items.

For desktop Zotero access, turn on `Allow other applications on this computer to communicate with Zotero` in Zotero's advanced settings. For remote access, open `Library → Connection settings → Web library` and enter your library ID (plus a read-access API key for private libraries). From `Reference`, you can link a document to an existing Zotero item or file it into collections. ([Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api) · [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/basics))

## Keyboard shortcuts

Press `?` or open **More actions → Keyboard shortcuts** inside the reader to view the full shortcut list. Shortcuts pause automatically while typing in inputs, the Notes editor, or open dialogs.

| Area | Key | Action |
|---|---|---|
| Reading | `←` / `→` | Previous or next PDF page / OpenStax book section |
| Reading | `b` | Toggle Original and Bilingual view |
| Reading | `+` / `=` / `-` | Zoom in or zoom out |
| Reading | `?` | Open keyboard shortcuts |
| Reading | `Esc` | Cancel screenshot, close menu, card, or dialog |
| Panels | `n` / `c` | Toggle Notes or Contents sidebar |
| Panels | `←` / `→` / `Home` / `End` | Switch tabs in sidebar, Library, or Vocabulary and history |
| Notes editor | `Ctrl/Cmd+S`, `B`, `I` | Save notes, bold text, italic text |
| Notes editor | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Y` | Undo or redo |
| Composers | `Enter` / `Shift+Enter` | Send Paper chat or selection message / new line |
| Composers | `Ctrl/Cmd+Enter` | Save selection note or mark |

## Optional browser extension

To look up passages or capture login-gated pages on any website, download and extract the [repository ZIP](https://github.com/jiawoget/dsh-paper-reader/archive/refs/heads/main.zip). Open the extensions page in Chrome or Edge, turn on Developer mode, choose **Load unpacked**, and select `dist/extension`.

The extension reuses your signed-in DSH Web session in the same browser profile and needs no separate pairing token. Open the extension popup, expand **Connection settings**, enter your `Local DSH address` (default `http://127.0.0.1:29812`), and keep that DSH Web tab open.

Choose `Enable selection cards` in the popup to show the floating card (`Translate`, `Explain in context`, `Ask`, `☆ Save word`, `Add to Notes`, `Read ↗`) when you highlight text, or choose `Open in Paper Reader` to capture the active page. Right-clicking a page or selection also exposes `Translate selection with DSH` and `Open in Paper Reader`.

## Development and testing

Source code, build scripts, and tests use strict TypeScript (`Node.js >=24.9`). Keep `dist/` committed because DSH installs plugins directly from GitHub; rebuild before committing code or stylesheet changes. Static assets live in `public/` and `extension/`.

```sh
npm ci
npm run typecheck
npm run build
npm run dev
npm start
npm test
npm run test:e2e
```

- `npm run build` runs `npm run typecheck` and bundles all server, web, client, and extension targets into `dist/`. `npm run dev` watches source and asset files.
- `npm start` launches local DSH Web with `paper-reader.patch.yml` on `http://127.0.0.1:29812`.
- `npm test` runs the `node:test` unit and integration suites under `tests/*.test.ts`.
- `npm run test:e2e` runs the Playwright suites in isolated Chrome profiles against ephemeral DSH hosts (`--port 0` and temporary `DSH_HOME`).

To run a single E2E group, use scripts such as `npm run test:browser`, `npm run test:extension`, `npm run test:integrations`, `npm run test:target-language`, `npm run test:citation-export`, `npm run test:dark-theme-a11y`, `npm run test:shortcuts-i18n`, `npm run test:collections-delete-hygiene`, `npm run test:web-zotero`, `npm run test:book-reading`, or `npm run test:sidebar-contents`. Opt-in suites for local papers or live services include `npm run test:pdf-artwork`, `npm run test:passage-links`, `npm run test:reading-layout`, `npm run test:paper-chat`, `npm run test:zotero-public`, and `npm run test:sidebar-model`.

Runtime data defaults to `$DSH_HOME/paper-reader` (or `~/.dsh/paper-reader`). Key environment variables:

- `PAPER_READER_HOME`: overrides the plugin data directory.
- `PAPER_READER_MT_MODEL_DIR`: overrides the local OPUS-MT weights directory.
- `PAPER_READER_HEADED=1`, `CHROME_PATH`, `DSH_ENTRY`: controls visible Playwright runs and binary paths for E2E suites.
- `PAPER_READER_LIVE_CHAT=1`, `PAPER_READER_SELECTION_PDF`, `PAPER_READER_LIVE_ZOTERO_DESKTOP=1`: enables live-model, external-PDF, or Windows desktop Zotero write tests.

Browse acceptance walkthroughs and screenshots for [OpenStax and Google Research](docs/acceptance/books-and-blog/ACCEPTANCE.md), [web reading and Zotero](docs/acceptance/web-zotero/ACCEPTANCE.md), and [the contents sidebar and PDF outline](docs/acceptance/sidebar-contents/ACCEPTANCE.md).

Kwon and colleagues' PagedAttention paper is distributed under CC BY 4.0; the bundled Simplified Chinese edition is an adaptation. See [Paper attribution and license](public/assets/paper-attribution.txt).
