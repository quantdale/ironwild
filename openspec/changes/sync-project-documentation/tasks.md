# Tasks — Sync project documentation (docs)

## 0. Cross-change coordination (read before editing)

This is the **last** change in the recommended order, because it documents the outcome of several others. Files it touches that siblings also edit:

- **`README.md`** — `harden-core-verification` owns the testing-coverage paragraph; `gate-assets-in-ci` owns the quality-gate list. This change must **not** duplicate those edits: make the layout block and the index, and defer the coordinated sections to their owners (see tasks 1.1–1.3).
- **`src/core/state.js`** — `fix-hud-telemetry-accuracy` adds a `CONFIG` constant. Apply that change first, then add the header note here.
- **`src/ui/menus.js`** — `complete-input-action-coverage` (`updateMenus`) and `enforce-permadeath-run-model` (`buildDom`) both edit code in this module; this change's only edit here is the `setPanelHtml` comment. Apply both first.
- **`src/world/materials.js`** — `retire-dead-scaffolding` deletes it. Apply that first, then decide whether the README layout omits the entry (task 2.6).
- **`src/ui/settings.js` / `src/ui/hud.js` / `src/assets/manifest.js` / `src/systems/quests.js`** — referenced here for the state-ownership note only; do not edit them beyond the note.

## 1. Coordinate with the changes that also touch the README

- [ ] 1.1 Sequence this change **after** `harden-core-verification` (owns the testing-coverage paragraph) and after `gate-assets-in-ci` (owns the quality-gate list) so the two do not fight over the same README sections.
- [ ] 1.2 If either of those has not landed, still make the layout-block and index updates, and leave the coordinated sections for the owning change rather than duplicating the edit.
- [ ] 1.3 Note the shared-file overlap in the commit message so the reviewer sees the coordination.

## 2. Refresh the README project layout

- [ ] 2.1 Rewrite the `## Project layout` block from the actual tree, one line per directory, in the existing terse style.
- [ ] 2.2 Add the missing source directories: `src/anim/` (animation graph + machine animators), `src/assets/` (asset manifest/conventions), `src/input/` (gamepad layer), `src/render/` (environment lighting + art direction), `src/vfx/` (pooled VFX engine + effect library).
- [ ] 2.3 Correct the `src/world/` description to mention cell streaming, LOD helpers, and landmarks, not only terrain/sky/weather/props.
- [ ] 2.4 Correct the `src/systems/` description to mention the asset pipeline, telemetry, and dynamic resolution.
- [ ] 2.5 Add `scripts/` (tooling: asset generation, asset validation, perf capture, E2E chunking), `public/assets/` (authored GLBs + provenance), and `openspec/` (change proposals).
- [ ] 2.6 Omit `src/world/materials.js` from the layout description if `retire-dead-scaffolding` has landed; otherwise mark it as unused so the README does not point a reader at dead code.

## 3. README quality gates and testing

- [ ] 3.1 Add `npm run assets:validate` to the quality-gate list (coordinated with `gate-assets-in-ci`, which changes `verify` to include it).
- [ ] 3.2 Document the new `test:coverage` script if `harden-core-verification` added one.
- [ ] 3.3 Ensure the testing section's enumerated unit-coverage list matches reality after `harden-core-verification`; if that change has not landed, correct the list by hand rather than leaving the overstatement.
- [ ] 3.4 State the unit-vs-E2E split explicitly (which areas are unit-covered and which are covered only by the browser suite).

## 4. Correct the false innerHTML invariant

- [ ] 4.1 In `src/ui/menus.js`, rewrite the `setPanelHtml` header comment so it no longer claims raw `innerHTML` assignments are absent from the codebase. State the actual policy: menu templates go through DOMParser; three other modules assign `innerHTML` with build-time constants only.
- [ ] 4.2 Add a one-line invariant note at each of the three `innerHTML` sites — `src/ui/settings.js` (settings overlay), `src/ui/hud.js` (SVG reticle markup), `src/systems/quests.js` (contract slot template) — reading: static build-time template only; never interpolate dynamic, user, or network data (use `textContent` for that).
- [ ] 4.3 Do **not** convert the three sites to DOMParser in this change; record it as an optional follow-up (SVG `innerHTML` → DOMParser can change rendering in some engines, and there is no current injection risk).
- [ ] 4.4 Grep for any other comment asserting a codebase-wide invariant that does not hold and fix or remove it.

## 5. Status banners on the architecture documents

- [ ] 5.1 Add a status banner to `ARCHITECTURE.md`: it is the v1 contract record, later waves extend rather than replace it, and its 4-type machine roster is superseded by V2/V3 plus `src/assets/manifest.js`.
- [ ] 5.2 Add a matching banner to `ARCHITECTURE_V2.md` and `ARCHITECTURE_V3.md`, each naming the wave it documents and where current behavior is actually described.
- [ ] 5.3 Point readers at: module headers (current implementation), `docs/BALANCE.md` (numbers), and `openspec/specs/` (capability contracts once archived).
- [ ] 5.4 Do **not** edit the bodies of these three documents.

## 6. Documentation index

- [ ] 6.1 Create `docs/README.md` mapping each document to what it governs: `README.md`, the three architecture files, `docs/BALANCE.md`, the five `docs/aaa-upgrade/` documents, `docs/perf/`, and `openspec/`.
- [ ] 6.2 Add a short "which document wins" rule: OpenSpec change specs govern planned behavior changes; `docs/BALANCE.md` governs constants; module headers govern current implementation; the `aaa-upgrade` documents express long-range intent and are not binding on a specific change.
- [ ] 6.3 Link `docs/README.md` from the main `README.md` so the index is discoverable.
- [ ] 6.4 Verify every relative link in the index resolves (including the `openspec/` paths and the `docs/perf/` baseline file).

## 7. Cross-module state ownership note

- [ ] 7.1 In `src/core/state.js`, narrow or qualify the header claim that "anything cross-module lives here" so it matches reality.
- [ ] 7.2 Document the fields declared elsewhere: `G.timeOfDay` (`world/environment.js`), `G.quests.genCount` (`systems/quests.js`), `G.weather.gust` / `lastStrikeAt` / `lastStrikeDist` (`world/weather.js`), and the Wave J accessibility keys (`ui/settings.js`, already documented as deliberate).
- [ ] 7.3 For each, state the single owning writer and the known consumers so a future contributor knows where to look.
- [ ] 7.4 Do **not** relocate any of these fields in this change; documenting the actual arrangement is the scope. Note relocation as a possible future cleanup.
- [ ] 7.5 Coordinate with `fix-hud-telemetry-accuracy`, which adds a machine-cap constant to `CONFIG` in the same file.

## 8. Verification

- [ ] 8.1 Every directory in the actual tree appears in the README layout block (walk `src/`, `scripts/`, `public/assets/`, `openspec/`).
- [ ] 8.2 Every npm script that participates in a quality gate appears in the README's gate list.
- [ ] 8.3 Each of the three architecture files opens with a status banner.
- [ ] 8.4 `docs/README.md` links all resolve.
- [ ] 8.5 Grep confirms no remaining comment asserts the false innerHTML invariant.
- [ ] 8.6 `npm run lint` clean, `npm test` passes, `npm run build` succeeds.
- [ ] 8.7 `npx playwright test` — full suite green (unchanged expected; run to confirm the comment-only edits are inert).
- [ ] 8.8 `git status` shows only documentation and comment changes — no runtime code behavior modified.
