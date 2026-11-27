# AGENTS.md — Agent Workflow, UX & Code Quality Rules for `dsh-paper-reader`

This repository is maintained as a **long-term, zero-framework, zero-bloat local-first product** (`src/reader`, `src/server`, `src/extension`, `src/shared`, `public/`). Every feature, fix, and cleanup follows a strict branch-verify-dual-review-PR-squash-merge workflow.

## Key References

Read the relevant source of truth before starting work:

- **Product & CLI guide:** `README.md`, `交付说明.md`
- **Build & test scripts:** `package.json`
- **RPC & shared contracts:** `src/shared/types.ts`
- **SQLite schema & cascade hygiene:** `src/server/reader-store.ts`
- **Acceptance & design notes:** `docs/`

---

## Non-Negotiable Safety & Environment Rules

1. **Port & Process Isolation:**
   - **NEVER** stop, restart, or interfere with `127.0.0.1:3080` or any external `dsh web` process.
   - Always run tests and exploratory browser checks on an isolated port (`--port 0`, or a dedicated unused port such as `29822` / `29830`) with a temporary `DSH_HOME` and `PAPER_READER_HOME`. Terminate all spawned servers/browsers and remove temp directories before finishing.
2. **Repo Hygiene:**
   - `dist/` is committed and must always stay byte-exact with `src/`, `public/`, and `extension/`.
   - Keep machine-local and scratch files untracked (`.agents/`, `.impeccable/`, `artifacts/`, `.npmrc`, screenshots).
   - Zero new npm dependencies unless explicitly approved by the maintainer.

---

## Frontend Design System Standards (Hard Rules)

Every frontend UI, CSS, SVG, or layout change in `public/`, `src/reader/`, and `src/extension/` MUST obey all five rules:

1. **Layout & Information Minimalism:**
   - Zero nested boxes, nested cards, or redundant dividers.
   - Zero slogans, subtitles, secondary tags, or explanatory prose; when a feature needs explanation, place a compact `(i)` icon whose hover/focus tooltip provides concise guidance.
   - Establish visual hierarchy through typography, alignment, and whitespace rather than explanatory copy.
2. **Apple.com Minimalist Aesthetic, Palette & Whitespace:**
   - Follow an Apple.com-inspired minimalist visual language: restrained, crisp, and high-craft.
   - **90/10 Color Ratio:** 90% neutral or cool-light surfaces (or calm neutral-dark surfaces in dark mode) and 10% single core accent color highlighting primary actions or key data.
   - **Zero** gradients, neon/high-saturation accents, or heavy drop-shadow cards (use whisper-quiet `1px` borders and minimal elevation only on floating overlays/dialogs).
   - **Typography Weight & Contrast:** Bold, darker headings paired with softer regular body text.
   - **Generous Whitespace:** Use `1.5×` padding and margins relative to dense dashboards; prefer breathing room over packing chrome.
3. **Typography, Spacing Grid, Radii & REicon Icons:**
   - **Global Font:** Self-hosted MIT **Geist** (`public/assets/fonts/Geist-Variable.woff2`, 100% offline, zero new npm dependencies); `18px` bold (`600/700`) section headings and `16px`/`14px` regular (`400`) body copy.
   - **Spacing Grid:** Strict multiples of `4px` (`4, 8, 12, 16, 20, 24, 32, …`) without exception.
   - **Radius Scale:** `8px–40px` scaled by component size and hierarchy (`8px` small controls, `12–16px` inputs/panels, `24–40px` dialogs/drawers/pills).
   - **Icons:** **REicon** (`reicon.dev/docs`, MIT) linear pure inline SVG style — `18px` artwork, `1.5px` stroke width, centered inside a `24×24px` transparent viewBox (`src/reader/research/icons.ts`).
4. **Intent-Revealed Controls:**
   - Keep secondary controls hidden at rest and reveal them on user intent (hover, selection, keyboard focus, or scroll proximity) — including the site-wide floating paper action bar (`paper-float-bar.ts`).
5. **Visual Screenshot Acceptance:**
   - Judge visual quality from real rendered browser screenshots (alignment, wrapping, whitespace, hierarchy, occlusion, contrast), never from computed CSS properties alone.

---

## Mandatory Delivery Workflow

Every feature, fix, or cleanup task must follow these steps in order. Do not push work directly to `main`.

### 1. Branch from `main`

- Start from an up-to-date `main` branch (`git checkout main && git pull --ff-only`).
- Create one focused branch per feature/fix/cleanup (`feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`).
- Keep changes focused on the task, **except** extracting a shared helper module to prevent copy-paste (`>= 8` duplicated lines) is always permitted and required.

### 2. Implement Cleanly

- **Reuse first:** Inspect existing primitives (`src/shared/`, `src/reader/`, `src/server/`, `tests/e2e/helpers/`) before adding new helpers.
- **Replace and delete in the same PR:** Delete obsolete implementations and legacy CSS rules instead of leaving compatibility shims, feature flags, commented-out code, or another CSS override layer.
- **Preserve behavior & assertions:** Preserve existing user-visible behavior and passing tests unless the task explicitly changes behavior. Never weaken or delete test assertions merely to make a failing test pass.
- **Do not bypass quality gates:** Never introduce `any`, `as unknown as`, `eslint-disable`, `@ts-ignore`, skipped tests, or `TODO` placeholders.
- **No comments in new/modified code:** Write self-documenting code with zero added comments in newly written or modified lines (leave untouched pre-existing comments as-is).
- **Bilingual & theme parity:** Any user-facing UI change must stay consistent across EN/ZH locales, Light/Dark themes, and `prefers-reduced-motion`.

### 3. Local Verification & Mandatory Dual-Agent PR Review Gate

Before merging (and before opening/finalizing a PR), complete **automated verification** plus **two independent review agents** on the PR branch. Neither review agent may rubber-stamp based on "CI passed."

#### 3a. Local Build & Automated Verification

Run locally and verify every check passes:

```sh
npm run typecheck
npm run build
git diff --exit-code dist/
npm run check -- --diff origin/main --strict-diff
npm test
```

Also run:
- `npm run check:ux-smoke` on every PR that touches `public/` or UI code (fast deterministic desktop `1024–1440px` + mobile `390×844` Light/Dark geometry, touch-target, tab-jitter, and fold check — catches CSS/geometry defects before reviewers spin up)
- Targeted E2E suites in parallel via `npm run test:e2e -- test:<suite1> test:<suite2>` (or full 4-way parallel `npm run test:e2e` for cross-cutting or release PRs)

If an E2E suite cannot run due to a genuine environment blocker, stop and report the exact blocker rather than silently skipping it.

#### 3b. Independent Review Agent A — Live-Data Interaction & Visual Judge (`Live-Data Judge`)

**Mission:** Protect and improve real user experience; guarantee zero UX or visual regression using real live-data journeys and rendered screenshots.

1. **Invoke Required Skills:**
   - Load and apply `impeccable` (`~/.gemini/config/skills/impeccable/SKILL.md`) to critique and score every touched interaction.
   - When UI copy or user-facing documentation changes, also apply `no-ai-slop` (`~/.gemini/config/skills/no-ai-slop/SKILL.md`).
2. **Exploratory Live-Data Browser Testing & Visual Screenshot Inspection (NOT mock-only or `npm run test:e2e`):**
   - Do **not** run the automated test suite or mock-only routes as a substitute for UX review.
   - Boot the PR build on an isolated port (`--port 0`, isolated temp `DSH_HOME` and `PAPER_READER_HOME`, never interfering with `127.0.0.1:3080` or `127.0.0.1:29822`). For LLM-backed flows, copy or inherit the machine's existing local LLM/provider config or environment variables read-only into the isolated temp `DSH_HOME`.
   - Launch headless Playwright/Chromium and **use the feature like a real human researcher** against real live APIs (OpenAlex/arXiv/EPMC/S2 and live LLM streaming): open papers, click, type, drag, resize, stream AI replies, click `Stop` mid-stream, trigger error/recovery paths, toggle EN/ZH locales, toggle Light/Dark themes, and verify cross-page workflows end-to-end.
   - Capture and visually inspect **real rendered screenshots** across **Desktop (`1440×900`, `1160×900`, `1024×768`)** and **Mobile (`390×844`)** in **Light/Dark** and **EN/ZH**, including **dynamic intermediate states** (mid-stream AI rendering, loading states, open popovers/dialogs, revealed floating bars, active drag/capture).
3. **Hard UX & Design-System Reject Triggers (P1 Blocking — NEVER downgrade to P2):**
   - **Silent truncation or overflow:** Any tablist/button/label silently clipped (`scrollWidth > clientWidth`, e.g., `Reference` clipped to `Refere`), or `#docTitle < 80px` at desktop widths (`1024–1440px`).
   - **Mobile chrome bloat / touch targets:** At `390×844`, top chrome exceeding `18%` of viewport height, horizontal overflow, or visible interactive controls `< 44×44px` on mobile (or `< 24×24px` WCAG 2.5.8 anywhere).
   - **Broken streaming & interruption UX:** Raw unrendered Markdown/LaTeX flashing during AI streaming, or clicking `Stop` silently discarding already-streamed content.
   - **Cognitive overload / off-fold CTA:** Text-selection card (`#card`) presenting `> 4` primary actions at once, or a dialog's primary Save/Submit button pushed below the fold without a sticky footer. (Note: the compact intent-revealed REicon Paper Action Bar displays up to 5 actions — 4 when the paper is already in the local library.)
   - **Design-system violations:** Nested bordered cards, explanatory prose subtitles instead of `(i)` tooltips, gradients/neon/heavy card shadows, broken Geist font loading, or off-standard icon strokes.
   - **Bilingual legibility / craft regressions:** Translated text compressed below `11px` or overlapping figures/headings, `0px` icon-to-text gaps, missing EN/ZH localization, or dark/light contrast below WCAG AA.
   - **Score regression:** Any touched interaction scoring lower on `impeccable` than its pre-PR baseline.
4. **Required Deliverable:** Per-interaction `impeccable` scorecard for every touched interaction (Discoverability / Feedback / Visual Craft / Ergonomics), summary of live-data browser journeys with concrete DOM + rendered screenshot evidence, and verdict (`APPROVE` or `REQUEST_CHANGES`).

#### 3c. Independent Review Agent B — Code Quality & Anti-Bloat Reviewer (`Code Quality Reviewer`)

**Mission:** Guard long-term maintainability by ruthlessly blocking AI slop, duplication, unnecessary code, reinvented wheels, and test bloat.

1. **Core Principle — Anti-Bloat ≠ "Zero New npm Deps":**
   - Never approve a bloated diff just because `package.json` is unchanged. Audit code volume, duplication, abstraction weight, and simplification opportunities across the **whole touched files** (avoid diff-only myopia).
2. **Hard Code Quality Reject Triggers (Mandatory `REQUEST_CHANGES`):**
   - **R1 — Zero Copy-Paste & No Scope Excuses:** Any `>= 8` lines of cross-file duplicated logic in `src/` or `tests/`, or any `new Function(...)` string-injected test helper, is an automatic **REJECT**. Narrow PR scope **never** excuses copy-paste — extracting a shared helper module is always allowed and required.
   - **R2 — File Size Ceilings & Ratchet:**
     - New `src/**/*.ts` files must be `<= 350` lines; new `tests/**/*.ts` files must be `<= 500` lines.
     - Existing oversized files (`app.ts`, `pdf-view.ts`, `notebook.ts`, `selection-chat.ts`, `selection-card.ts`, `panels.ts`, `reader-store.ts`, `citation-export.ts`, `reading-desk.css`, and oversized E2E files) are on a **ratchet**: net growth `> +10` lines without splitting or deleting legacy code is **REJECT**.
     - No pseudo-minified CSS lines (`> 240` characters on a single line).
     - Never justify a large file by citing another existing large file (*normalization of deviance*).
   - **R3 — PR Diff Budget & Test-to-Prod Ratio:**
     - Exclude `dist/` and lockfiles. Feature PRs exceeding `+600` net lines or `fix:` PRs exceeding `+250` net lines must be split unless explicitly justified.
     - Test-to-prod added-line ratio `> 2.5:1` is a red flag: **REJECT** redundant E2E scripts that re-test already-covered flows, **REJECT** creating a new standalone E2E process when an existing same-domain suite can absorb the assertion, and **REJECT** brittle regex meta-tests that police prose style.
   - **R4 — No Layered CSS Overrides, Dead Code, or Over-Engineered Wheels:**
     - **REJECT** CSS fixes that append another override layer in `reading-desk.css` instead of deleting the obsolete rule in `reader.css`/`selection-card.css`, or that add new `!important` outside `[hidden]`/`.pdf-sheet` protection.
     - **REJECT** dead/unused exports, obsolete browser fallbacks (e.g., `document.execCommand`), scattered duplicate EN/ZH strings repeated across `>= 3` files (consolidate into shared i18n constants), and over-engineered bespoke engines where a lean minimal subset suffices.
   - **R5 — Deletion & Simplification Accountability:**
     - Every review must actively ask: *"What in this PR (or in the touched files) can be deleted, unified, or written in half the lines without losing clarity or behavior?"*
3. **Required Deliverable (Mandatory Scorecard at top of every Code Quality Review):**
   ```markdown
   ## Code Quality & Anti-Bloat Scorecard
   - Net LoC delta (excl. dist/lock): +X / -Y (net Z)
   - Prod vs Test delta & ratio: prod +A/-B | test +C/-D (ratio R:1)
   - Largest touched file (before -> after): path (N1 -> N2 lines)
   - Cross-file duplication & dead-export check: PASS / FAIL
   - Code deleted or simplified in this PR: <explicit list, or why 0 deletions>
   - Verdict: APPROVE / REQUEST_CHANGES
   ```

Resolve every blocking finding from **both** review agents, rebuild `dist/`, re-run affected verification, and re-verify before merging.

### 3d. Velocity & Execution Efficiency Rules (Mandatory for All Future Runs)

Enforce these 6 rules to keep delivery 3×–4× faster without relaxing any UX or code quality gate:

- **V1 — Pre-Flight Deterministic UX Smoke:** Run `npm run check:ux-smoke` before invoking `Live-Data Judge` on any UI/CSS PR to eliminate deterministic geometry/touch-target/overflow ping-pong on Iter 1.
- **V2 — Delta-Scoped Re-Verification & Micro-Fix Fast Path:** On Iter 2+, **only re-run the rejecting reviewer(s)** (and any newly impacted domain); already-`APPROVE`d reviewers carry forward automatically. For `<= 15`-line surgical CSS/focus/ARIA/label micro-fixes, run a fast `< 4m` targeted delta probe + 1–2 directly affected E2E suites + `npm run check -- --diff origin/main --strict-diff` instead of a full multi-agent/full-E2E re-run.
- **V3 — 4-Way Parallel E2E & Zero Same-SHA Duplication:** Always execute multi-suite E2E via `npm run test:e2e` (default `concurrency=4`, isolated `--port 0`). When the author already ran and logged passing E2E on the exact same commit SHA (`git rev-parse HEAD`), `Code Quality Reviewer` does **not** serially re-run the identical full E2E batch — verify SHA parity, `npm run check -- --diff origin/main --strict-diff`, `git diff --exit-code dist/`, and run only targeted adversarial/new checks.
- **V4 — Strict 2-Reviewer Consolidation (No Redundant 4-Agent Fan-Out):** Keep exactly two independent review agents per PR — **Live-Data Judge** (reusing `tests/e2e/helpers/` probes rather than rewriting 300-line scripts from scratch) and **Code Quality Reviewer** (absorbing logic/security/race adversarial checks). Do **not** spawn a redundant standalone Forensic Auditor when `npm run check -- --diff origin/main --strict-diff` + `git diff --exit-code dist/` already enforce mechanical integrity and zero-comment diff checks.
- **V5 — Flat Orchestration (`<= 2` Layers) & Inline PR Delivery:** Avoid deep nested sub-orchestrator chains (`<= 2` layers max) and redundant per-PR cold-start explorers when codebase context is already mapped. Never spawn a separate Delivery Subagent just for `git push`, `gh pr create`, and `gh pr merge --squash` — execute delivery inline once gates pass.
- **V6 — Optional Worktree Pipelining:** Non-conflicting PRs may prepare in an isolated git worktree while the prior PR is in review/merge, then rebase cleanly onto synced `main`.

### 4. Open a Pull Request

- Commit clean, focused changes on the feature branch and push to `origin`.
- Open a PR targeting `main` (`gh pr create --base main`).
- The PR description must include:
  - **Summary:** what changed and why
  - **Verification:** exact commands executed (including `dist/` parity and E2E suites) and observed results
  - **Live-Data Judge Audit:** per-interaction `impeccable` scores + exploratory headless browser summary
  - **Code Quality Reviewer Audit:** 6-item Anti-Bloat Scorecard + deletions/simplifications
  - **Changed files / scope:** concise list of affected areas
  - **Unverified items:** anything not verified (with reason), or explicitly `None`

### 5. Automated PR Review / CI Checks (When Active)

- If GitHub CI checks or an automated PR review bot (e.g., `chatgpt-codex-connector[bot]`) triggers on the PR, wait for completion before merging.
- Fix valid findings on the branch (re-running verification and pushing), or reply concisely on the PR for false positives.

### 6. Squash-Merge and Sync `main`

- Always merge PRs into `main` using `--squash` (never merge commits or rebase merges), and only after:
  1. Local build, `dist/` parity, unit tests, `npm run check` (once added), and targeted E2E suites pass on the latest commit.
  2. **Live-Data Judge** (`APPROVE`) confirms real-user exploratory flows and zero UX regression.
  3. **Code Quality Reviewer** (`APPROVE`) confirms zero AI slop, zero copy-paste, and adherence to LoC/ratchet/anti-bloat gates.
  4. Any active CI checks or automated PR reviews have completed with no unresolved blocking findings.
- Squash-merge and sync local `main`:

```sh
gh pr merge <pr-number> --squash --delete-branch
git checkout main
git pull --ff-only
```

---

## Quick Checklist

- [ ] Dedicated branch created from latest `main`
- [ ] Clean implementation: reused existing helpers, deleted obsolete code/CSS, zero unapproved deps, zero `3080` interference
- [ ] Local verification passed (`npm run typecheck`, `npm run build`, `git diff --exit-code dist/`, `npm run check -- --diff origin/main --strict-diff`, `npm test`, `npm run check:ux-smoke` on UI PRs, parallel E2E via `npm run test:e2e`)
- [ ] **Live-Data Judge** (`APPROVE`): `impeccable` per-interaction scores + exploratory headless browser testing across desktop/mobile, EN/ZH, Light/Dark, and dynamic states
- [ ] **Code Quality Reviewer** (`APPROVE`): 6-item Anti-Bloat Scorecard, zero copy-paste/AI slop/dead code/added comments, ratchet & diff budgets respected, adversarial logic/security checks passed
- [ ] Iter 2+ followed delta-scoped re-verification (no re-running already-`APPROVE`d reviewers or identical same-SHA E2E batches)
- [ ] PR opened and squash-merged inline into `main` (`--squash --delete-branch`) and local `main` synced
