// Adopted inside a closed shadow root so a site's typography cannot alter the card.
export const cardStyle = `
:host {
  all: initial;
  color-scheme: light;
  --scheme: light;
  --card-bg: #fff;
  --card-border: #dce0e9;
  --card-shadow: 0 6px 27px rgb(34 42 61 / 17%), 0 1px 4px rgb(34 42 61 / 8%);
  --ink: #1f222b;
  --muted: #5b6373;
  --mode-ink: #585568;
  --accent: #593194;
  --accent-soft: #efe7fb;
  --hover-bg: #f2eef8;
  --focus: #8154ca;
  --primary: #7044c4;
  --primary-hover: #6037ad;
  --primary-ink: #fff;
  --question-bg: #f7f4fb;
  --question-ink: #524062;
  --question-border: #9b79d3;
  --border: #e8eaf0;
  --input-bg: #fbfcfe;
  --input-border: #82899c;
  --error: #923c38;
  --status: #5d526f;
  --scrollbar: #c1b8ce;
  --selection-bg: #dfd0f7;
  --selection-ink: #1e1330;
}
@media (prefers-color-scheme: dark) {
  :host {
    color-scheme: dark;
    --scheme: dark;
    --card-bg: #1d202b;
    --card-border: #434a63;
    --card-shadow: 0 8px 28px rgb(0 0 0 / 55%), 0 0 0 1px rgb(255 255 255 / 9%);
    --ink: #e7e9f2;
    --muted: #a8aec4;
    --mode-ink: #c6cbe0;
    --accent: #c4aaf8;
    --accent-soft: #2d2542;
    --hover-bg: #2a243d;
    --focus: #bda2f5;
    --primary: #6c46b2;
    --primary-hover: #7b55c2;
    --primary-ink: #fff;
    --question-bg: #262137;
    --question-ink: #d5c7ee;
    --question-border: #9d7fe0;
    --border: #313649;
    --input-bg: #151822;
    --input-border: #6f7791;
    --error: #f28b85;
    --status: #b8accf;
    --scrollbar: #505772;
    --selection-bg: #4e3b77;
    --selection-ink: #f2edfb;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
::selection { background: var(--selection-bg); color: var(--selection-ink); }
.card { display: grid; gap: 9px; width: 100%; max-height: min(470px,calc(100dvh - 16px)); overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--scrollbar) transparent; padding: 15px 15px 12px; border: 1px solid var(--card-border); border-radius: 9px; background: var(--card-bg); box-shadow: var(--card-shadow); color: var(--ink); color-scheme: var(--scheme); font: normal 13px/1.5 system-ui,"Microsoft YaHei",sans-serif; text-align: left; direction: ltr; }
.head { display: flex; align-items: flex-start; gap: 8px; }
h2 { flex: 1; margin: 0; font-size: 18px; font-weight: 620; line-height: 1.35; letter-spacing: -.24px; max-height: 5.4em; overflow: auto; overflow-wrap: anywhere; }
button, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; border: 0; background: none; padding: 0; }
button:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
button:disabled { cursor: default; opacity: .56; }
.close { font-size: 19px; line-height: 20px; color: var(--muted); padding: 0 2px; }
.close:hover { color: var(--ink); }
.modes, .foot, .editor-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.modes button { color: var(--mode-ink); padding: 3px 7px; min-height: 24px; border-radius: 4px; font-size: 12px; }
.modes button:hover, .modes button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
.answer { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; max-height: 220px; overflow: auto; }
.question { margin: 0; padding: 4px 8px; border-left: 2px solid var(--question-border); color: var(--question-ink); background: var(--question-bg); font-size: 12px; overflow-wrap: anywhere; }
.hint { color: var(--muted); font-size: 12px; }
.error { color: var(--error); }
.foot { border-top: 1px solid var(--border); padding-top: 9px; }
.foot button, .editor-actions button { padding: 4px 8px; border-radius: 5px; font-size: 12px; }
.foot button:first-child { margin-right: auto; }
.foot button:hover, .editor-actions button:hover { background: var(--hover-bg); }
.foot [data-do="open"] { color: var(--muted); font-size: 12px; }
.foot .primary, .editor-actions .primary { background: var(--primary); color: var(--primary-ink); }
.foot .primary:hover, .editor-actions .primary:hover { background: var(--primary-hover); }
.editor { display: grid; gap: 6px; }
.model-picker summary { cursor: pointer; color: var(--accent); font-size: 12px; overflow-wrap: anywhere; }
.question-model-form, .question-model-form label { display: grid; gap: 4px; }
.question-model-form { gap: 8px; padding: 8px 0; }
.question-model-form select { min-width: 0; width: 100%; font: inherit; background: var(--input-bg); color: var(--ink); border: 1px solid var(--input-border); border-radius: 4px; padding: 4px 6px; }
.question-model-form .hint { margin: 0; }
.question-model-form .hint:empty { display: none; }
.question-model-form button { justify-self: start; padding: 4px 8px; border-radius: 4px; color: var(--accent); background: var(--accent-soft); }
.question-model-form button:hover { background: var(--hover-bg); }
.question-model-form button.primary { background: var(--primary); color: var(--primary-ink); }
.question-model-form button.primary:hover { background: var(--primary-hover); }
.editor textarea { width: 100%; min-height: 55px; resize: vertical; padding: 6px 8px; border-radius: 5px; border: 1px solid var(--input-border); background: var(--input-bg); color: var(--ink); caret-color: var(--focus); }
.editor textarea::placeholder { color: var(--muted); }
.editor-actions { justify-content: flex-end; }
.status { color: var(--status); font-size: 12px; margin: 0; overflow-wrap: anywhere; }
.status:empty { display: none; }
`;
