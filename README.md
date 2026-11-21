# DSH Paper Reader

[中文安装与交付说明](交付说明.md)

Read a paper in two synchronized columns, select a passage in either language and keep notes that reopen the original page and passage. Paper Reader runs inside the DeepSeek Harness Web sidebar. The companion Chrome and Edge extension provides lookup and article capture on ordinary web pages.

## Run locally

Use Node.js 24.9 or newer and DeepSeek Harness Web. This project uses DSH `0.2.2-rc.5` for acceptance testing. From the project directory run the following commands. If you unpacked a release ZIP, the reader and extension are already built, so you can skip `npm run build`.

```sh
npm ci
npm run build
npm start
```

Open the browser session started by DSH and choose **Paper Reader** in the sidebar. For another Chrome profile, open the complete `dsh web:` address printed by the running host in that profile. DSH establishes a local session and redirects to its main window. The default port is `29812`. To choose another, run `dsh web --patch ./paper-reader.patch.yml --host 127.0.0.1 --port 29813` and enter that address in the extension's **Connection settings**.

For offline English-to-Chinese translation of imported PDFs, run `npm run install:translation-model`. It downloads and verifies about 120 MB of model files. The bundled bilingual paper is available immediately. The installer and reader honor `PAPER_READER_MT_MODEL_DIR` for a custom location. [OPUS-MT model card](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh) · [Pinned ONNX conversion](https://huggingface.co/Xenova/opus-mt-en-zh/tree/046f55aec303cdee3e0318604406d4df20f1e8ea)

## Read and annotate

- **Library → Zotero** shows the items and collections in the running desktop app. Choose a collection, search by title, author or year, and open a paper to read its attached PDF or linked webpage. Open a collection or item in Zotero to organize it there. **On this device** keeps the documents you have read, including their notes, available when Zotero is closed.
- **Library → Open web page** accepts an article URL. Use **Contents** to jump to a section, select a passage to discuss it, and follow its note back to the original sentence. Code, figures, tables and equations keep their place. A figure becomes available offline after the reader loads it once.
- Paste an OpenStax book or section URL and choose **Open book**. The **Contents** sidebar opens at your current chapter on desktop. Expand a chapter and select a section, or use the arrows to read in sequence. On a phone, tap **Contents** to browse chapters. Opening the book again returns to the last paragraph you read. Each section downloads when you visit it.
- For an OpenStax book, **Notes** follows the current chapter. In an Obsidian vault, the first note creates a chapter file, such as `Paper Reader/principles-finance/1 Introduction to Finance.md`. Notes from 1.1 and 1.2 share that file. Each saved passage links back to its section in the reader and on OpenStax.
- **Open a PDF** accepts a local file. The bundled PagedAttention paper opens on page 6 and includes a Simplified Chinese edition of all 16 pages.
- Open **Contents** to navigate the PDF’s bookmarks. For a PDF without bookmarks, choose **Generate contents with AI**. The reader uses your connected model, links sections to positions on the original pages, and saves the result for the next visit. Image-only scans need a searchable text layer.
- **Original** is the starting view. Select a passage to read its translation beside the PDF, or choose **Bilingual** to compare the two panes. Switching views keeps the page, selection and active draft. Narrow windows show one language at a time in Bilingual mode. The reader remembers your choice of reading view.
- For an imported PDF with selectable English text, opening a page in **Bilingual** mode translates its passages and saves them for the next visit. A configured provider handles the translation. The installed on-device model can translate locally when the default provider has no credentials. A failed request offers **Retry** and **Connections** in the translated pane.
- The bilingual pane keeps figure lettering, table cells and display equations in their printed form. Prose and captions receive translations. Paper Reader redraws the PDF and its artwork at the displayed size when you zoom or drag a divider.
- Drag the dividers between the original, translation and notebook to allocate reading space. With **Active column**, clicking either printed column in the full original displays that column in translation. **Active passage** follows a single passage. Use **Full page** to see both translated columns. **Reset reading layout** restores the defaults.
- Select text in either language to highlight the corresponding passage in the other. On desktop, **Open bilingual view** shows both languages at the selection and keeps the chosen translation scope. On a phone, **Show translation** and **Show original** switch the visible language.
- Select a passage and choose **Explain** for an explanation or **Ask AI** to type a question. **Add to notebook** saves the reply with its passage link. Select a sentence first to **Save selection**. The excerpt goes at your last writing position, or at the end of the notebook if you haven't placed the cursor. **Undo** removes it. **View** shows it in the notebook.
- In the PDF toolbar, choose **Ask with a screenshot** and drag around a figure, table or passage. Choose **Ask**, **Explain** or **Write note**. To compare figures, choose **Add a screenshot** beside your follow-up and draw around the second one. Your question and first figure stay in the discussion. Selecting a new passage or screenshot on the paper also lets you ask in this discussion or ask separately. A vision model can read the crops together. A text-only model uses their selectable text.
- **Write note** opens a draft for your own comment. While working on that draft, **Insert into note** adds a selected part of an answer at the draft cursor. Once you save, questions about that screenshot or passage automatically use its saved notes. For example, if your note asks for a German explanation, you can ask the reader to explain the passage that way.
- Hover over a numbered citation or focus it with the keyboard to read the corresponding titles from the PDF's bibliography.
- Open **Paper chat** below the paper to ask about the whole document. **Use selected passage** attaches the active selection. Earlier replies let you save the answer or a selected sentence directly to Notes. From an excerpt in the notebook, its source link opens the paper and **View discussion** reopens the question that led to it. **Unsent questions** restores a local draft after a page change or a refresh in the same tab.
- Under **Notes**, **Highlights → In notes** shows a highlight next to a matching citation or at the end of the notebook. **In Marks only** keeps the writing area clear of highlights. The display preference applies across papers. **Markdown** shows the underlying file, where explicit citations and your own writing are saved.
- Use the position selector in the notebook or standalone reading discussion to dock it on the left or right, or float it over the paper. Drag the floating title or focus it and use the arrow keys. Narrow screens use a bottom sheet and restore your desktop position when widened.
- To link your own summary to the paper, place the notebook cursor in a sentence or table cell, select the passage in the paper, and choose **Insert passage link**. Each compact label has a Markdown reference definition in the same vault file. Select a label in the editor to return to the passage.
- Under **More actions**, **Vocabulary and history** lists saved words and previous lookups. **Connections** controls the model, Obsidian vault and Zotero library.
- To connect Obsidian, use **Connect Obsidian** to choose your local vault. Chrome and Obsidian edit the same `.md` file in its `Paper Reader` folder. **Saved to vault** confirms a write. Returning to the reader or choosing **Refresh notebook** reads external changes. When edits conflict, **Compare latest** lets you review the saved file alongside your draft. Existing reader notes accompany the paper when you connect the vault.
- For desktop access, enable **Allow other applications on this computer to communicate with Zotero** in Zotero’s advanced settings. To switch to a Web library, choose **Library → Connection settings → Web library**. Public libraries need a library ID, and private libraries also need a key with read access. Use **Reference** to link a document or file it in a collection. [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api) · [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/basics)

## Use the browser extension

In Chrome or Edge, open the extensions page, enable developer mode and choose **Load unpacked**. Select `dist/extension` from this project. Keep a signed-in DSH tab open in the same browser profile.

Open the extension on an article and choose **Enable selection cards**. Select a word or sentence to translate, ask a follow-up or save a note. **Open in Paper Reader** captures the page you are viewing, including pages that need a browser login.

## Project and verification

Application logic, build scripts and tests are authored in strict TypeScript. The `dist` directory contains the compiled DSH and browser entry points. Source data and UI assets live in `public` and `extension`.

```sh
npm run build
npm test
npm run test:e2e
```

The build runs the strict TypeScript check. The end-to-end suite opens the extension, PDF reader and integration panels in isolated Chrome profiles with a real DSH host. To run only one group, use `npm run test:extension`, `npm run test:browser` or `npm run test:integrations`. Set `PAPER_READER_HEADED=1` to watch the acceptance run. Set `CHROME_PATH` and `DSH_ENTRY` if the tests need help locating Chrome or DSH's `lib/bin.js`.

The PDF checks turn through all 16 bundled pages and exercise CPU inference, retries and cache reopening. Run `npm run test:pdf-artwork -- "path/to/Deep Residual Learning for Image Recognition.pdf"` to compare the original and translated artwork pixel by pixel. Run `npm run test:reading-modes` to check the default Original view, mode switching, paired highlights and the passage dock. Run `npm run test:selection-note-draft` to check draft recovery and save retries.

`npm run test:reader-selection` covers saved notes, formatted replies and follow-ups about a selected answer. Set `PAPER_READER_SELECTION_PDF` to use a downloaded copy of the ResNet paper. The standard chat and Zotero tests use local test services. A separate run with `PAPER_READER_LIVE_CHAT=1` uses the configured DSH model with an isolated reader library. The notebook integration tests edit a real Markdown file in a disposable vault.

`npm run test:passage-links -- "path/to/Deep Residual Learning for Image Recognition.pdf"` checks the table links, excerpts and bibliography against the real paper. `npm run test:reading-layout -- "path/to/Deep Residual Learning for Image Recognition.pdf"` measures the raster, dividers and embedded laptop layouts. `npm run test:paper-chat` checks off-page evidence, selections and restored conversations. `npm run test:zotero-public` reads Zotero's published example library. On Windows, `PAPER_READER_LIVE_ZOTERO_DESKTOP=1` enables native write acceptance for `npm run test:zotero-desktop` in a disposable profile with Zotero's approval dialog.

The reader stores its library, translations and notebook under `$DSH_HOME/paper-reader`, or `~/.dsh/paper-reader` by default. Set `PAPER_READER_HOME` to choose another data directory. The DSH patch loads the plugin when that host starts.

`npm run test:web-zotero` checks the reading and library workflows in isolated Chrome. Add `-- --live` to run against an arXiv HTML paper, the Go Blog and Zotero’s public example library.

`npm run test:book-reading` checks book navigation, paragraph-level resume, chapter files and blog figures. Add `-- --live --evidence` to use Google Research and OpenStax and save the screenshots and publisher request counts.

`npm run test:sidebar-contents` checks native and AI-generated PDF contents in Chrome. `npm run test:sidebar-model` generates a fresh outline using the installed DSH model and a bookmark-free test copy of the public PagedAttention paper. Add `-- --evidence` to save its outline and screenshot.

The release includes reader walkthroughs and screenshots for [OpenStax and Google Research](docs/acceptance/books-and-blog/ACCEPTANCE.md), [web reading and Zotero](docs/acceptance/web-zotero/ACCEPTANCE.md), and [the contents sidebar and PDF outline](docs/acceptance/sidebar-contents/ACCEPTANCE.md).

Kwon and colleagues' PagedAttention paper is distributed under CC BY 4.0. The bundled Chinese edition is an adaptation. [Paper attribution and license](public/assets/paper-attribution.txt)
