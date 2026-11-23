// Adopted inside a closed shadow root so a site's typography cannot alter the card.
export const cardStyle = `
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
