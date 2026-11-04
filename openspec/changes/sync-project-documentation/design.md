# Design — Sync project documentation (docs)

## Current-state analysis

### 1. README "Project layout" omits most of the tree

The README block lists 10 source directories. The repository actually contains 14 under `src/`, plus tooling and assets:

```text
src/     actual: anim  assets  audio  combat  core  input  machines  player
                 render  systems  ui  vfx  world
README claims: core world player combat machines systems ui audio
missing:      anim  assets  input  render  vfx
```

`src/world/` is described as "terrain + biomes, sky/day-night, weather, props & pickups" but also contains `cells.js` (the cell-streaming manager), `lod.js`, `materials.js` (dead — see `retire-dead-scaffolding`), and `landmark.js`. `src/systems/` is described as "save/load, hunt contracts, XP/leveling, bestiary" but also contains the asset pipeline (`assets.js`), telemetry (`perf.js`), and dynamic resolution (`dynres.js`). The block omits `scripts/` (10 tooling scripts, including the asset generator and validator), `public/assets/` (the authored GLBs), and the new `openspec/` planning root.

A reader following the README to find the asset pipeline, the animation runtime, the VFX engine, or the cell manager would conclude none of it exists.

### 2. README quality gates omit the asset validator

```text
$ grep -c "assets:validate" README.md
0
```

`package.json` defines `assets:validate` and `assets:create-cert`; `verify` is documented in the README as `lint && test && test:e2e`. The `gate-assets-in-ci` change makes the validator mandatory in CI and in `verify` — the README must be updated in the same campaign or it will be wrong the moment that change lands.

### 3. The testing section overstates unit coverage

Already covered by `harden-core-verification`, but it is listed here because both changes touch the same README section and must not conflict:

> "Unit tests cover the deterministic core — RNG, event bus, damage/weak-point math, status timing, terrain generation, XP, quests, bestiary, and save normalization (including corrupt-save handling)."

Four of those eight named areas had no unit test before that change. The two changes must be sequenced (or the edit reconciled) so the README ends accurate.

### 4. A comment asserts something false about the codebase

`src/ui/menus.js`, header for `setPanelHtml`:

> "…but routing through DOMParser keeps raw innerHTML assignments **out of the codebase**: the parser adopts nodes safely and never executes scripts."

Reality — four direct `innerHTML` assignments exist:

| Location | Interpolates |
| --- | --- |
| `src/ui/settings.js` settings overlay | build-time constants (slider defs, mode lists, quality/difficulty options) |
| `src/ui/hud.js` SVG reticle | markup built from `RET_R` / `RET_C` constants |
| `src/systems/quests.js` contract slot | icon/name/bar markup |
| `src/systems/expedition.js` `buildUi()` | a static frontier-expedition template; title and detail are later set with `textContent` |

All three interpolate only module-level constants — there is no injection vulnerability today, and none is being claimed. The defect is that the comment tells a future maintainer a codebase-wide invariant holds when it does not, so a later editor may add a dynamic value to one of the other `innerHTML` sites believing the pattern is already considered safe. That is a real (if modest) maintenance hazard created by a false invariant.

### 5. Architecture documents read as current specification

`ARCHITECTURE.md` (v1), `ARCHITECTURE_V2.md`, `ARCHITECTURE_V3.md` are, by their own headers, additive contract documents written for parallel "agents" building v1/v2/v3 waves. They remain accurate as *historical* records — the modules they describe still exist and mostly still honor the contracts. But they contain no status note, and their `## Machine roster` in `ARCHITECTURE.md` lists 4 machine types while the game ships 9. A reader landing on `ARCHITECTURE.md` has no signal that the 4-type roster is superseded by V2/V3 and the asset pipeline.

The fix is **not** to rewrite them (they are a useful design record and the directive warns against inventing work). The fix is a status banner on each: which wave it describes, that later waves extend rather than replace it, and where the current implementation is described instead.

### 6. No single entry point for planned work

`docs/aaa-upgrade/` contains five substantial planning documents (`MASTER_PLAN.md`, `ROADMAP.md`, `VERTICAL_SLICE.md`, `PERFORMANCE_BUDGETS.md`, `RESEARCH_REFERENCES.md`) plus `docs/BALANCE.md` and `docs/perf/`. None references the OpenSpec change set that now exists in `openspec/`. A future implementation agent (or contributor) has no index telling them which document governs what, or that two systems of planned work coexist.

### 7. Cross-module state ownership is not where `core/state.js` claims

`src/core/state.js` header:

> "One mutable singleton shared by all systems. Systems read/write G.* directly; **anything cross-module lives here.**"

Fields added outside `core/state.js` that are genuinely cross-module:

| Field | Declared in | Consumed by |
| --- | --- | --- |
| `G.timeOfDay` | `world/environment.js` (`if (G.timeOfDay === undefined) G.timeOfDay = 0.35`) | `systems/save.js` (persisted), `render/lighting.js` (IBL bake + per-frame intensity), `audio/audio.js` (day/night chord) |
| `G.quests.genCount` | `systems/quests.js` (`if (!Number.isFinite(...)) ... = 0`) | `systems/save.js` (persisted) |
| `G.weather.gust`, `G.weather.lastStrikeAt`, `G.weather.lastStrikeDist` | `world/weather.js` | `world/props.js` (gust), `audio/audio.js` (thunder) |
| `G.settings.aimMode/crouchMode/aimAssist/uiScale/camShakeScale/...` | `ui/settings.js` (`applyA11yDefaults`) | `core/input.js`, `player/*`, `ui/*` — the module documents this as deliberate |

The last one is already documented as intentional and correctly reasoned. The first three are undocumented drift. It is not a defect — the code is coherent and every field has exactly one writer — but the `core/state.js` header makes a claim that is now false, and that is the same class of problem as the innerHTML comment: a false invariant that licenses future mistakes.

## Intended approach

Correct the claims, add the missing index, and leave the historical design records intact.

### README

- Rewrite the layout block from the actual tree, one line per directory, in the existing terse style. Include `scripts/`, `public/assets/`, and `openspec/`.
- Add the asset validator to the quality-gate list, coordinated with `gate-assets-in-ci` (which owns the gate itself).
- Coordinate the testing section with `harden-core-verification` (which owns the coverage claim).

### innerHTML policy

Two honest options:

- **(A) Make the comment true.** Rewrite the `menus.js` header to say that `setPanelHtml` uses DOMParser for the menu templates and that four other sites assign `innerHTML` with static templates only. Add a one-line note at each site: *static template only; never interpolate dynamic or user data — use `textContent` for that.* This is the required change.
- **(B) Also convert the four sites to DOMParser/textContent.** Removes the class of hazard entirely.

Choose **(A)** as the required change and record **(B)** as an optional follow-up. Rationale: the four sites currently violate no invariant, and converting `hud.js`'s SVG `innerHTML` to DOMParser is a behavior-sensitive edit to a live reticle (browsers historically parsed SVG differently via `innerHTML` vs. DOMParser — switching can change rendering in some engines) for no current security benefit. Choosing (B) here would trade a documentation defect for a rendering risk. The invariant note at each site is what actually prevents the hazard.

### Architecture document status banners

Add a short banner at the top of each of the three files:

- what wave it describes and when it was authoritative;
- that later waves extend rather than replace it, and that `ARCHITECTURE.md`'s 4-type roster is superseded by V2/V3 plus the asset manifest;
- a pointer to where current behavior is actually described (module headers; `docs/BALANCE.md` for numbers; `openspec/specs/` for capability contracts once archived).

Do not edit the bodies.

### Documentation index

Create `docs/README.md` as a short map:

| Document | Governs |
| --- | --- |
| `README.md` | how to run, how to play, controls |
| `ARCHITECTURE*.md` | historical design contracts (v1/v2/v3 waves) |
| `docs/BALANCE.md` | combat/economy constants and their audit history |
| `docs/aaa-upgrade/MASTER_PLAN.md` | long-range product/quality strategy |
| `docs/aaa-upgrade/ROADMAP.md` | phased implementation program |
| `docs/aaa-upgrade/VERTICAL_SLICE.md` | the target slice and its acceptance bar |
| `docs/aaa-upgrade/PERFORMANCE_BUDGETS.md` | frame/draw-call/memory budgets and the benchmark contract |
| `docs/perf/` | captured perf baselines (with commit/renderer attribution) |
| `openspec/` | implementation-ready change proposals (this campaign) |

Plus a short "which document wins" rule: OpenSpec change specs govern planned behavior changes; `docs/BALANCE.md` governs numbers; module headers govern current implementation; the `aaa-upgrade` documents govern long-range intent and are not binding for a specific change.

### Cross-module state note

Add a short subsection to `core/state.js`'s header (or, if the header is already long, a `docs/` note referenced from it) recording which `G.*` fields are declared outside `state.js`, who writes each, and that `ui/settings.js`'s Wave J keys are deliberate. This documents the actual arrangement so the "anything cross-module lives here" claim is either narrowed to "declared at initialization in `state.js`, plus the documented exceptions below" or removed.

Note: the `fix-hud-telemetry-accuracy` change touches `core/state.js` (adding the machine-cap constant) and `harden-core-verification` touches `README.md`. Sequence this change after both, or make the edits non-overlapping and reconcile explicitly — recorded in the tasks to avoid two changes fighting over the same lines.

## Control flow after the change

Documentation only. No runtime control flow changes.

## Data-flow / state changes

None. The only source-file edit is a comment (option A) plus, if taken, optional DOMParser conversions that must be behavior-verified (explicitly not required by this change).

## Failure handling

- Documentation drift recurs over time. Mitigation: the index gives a single place to update, and the status banners make the historical documents self-describing so future edits know where their authority ends.
- If a future change adds a new top-level directory and forgets the README, that is a process gap, not a defect this change can fully close; note it rather than pretending otherwise.

## Alternatives considered

- **Rewrite `ARCHITECTURE.md` to describe the current 9-machine roster.** Rejected: it would destroy the v1 contract record that the module comments and the design rationale still reference, and the V2/V3 documents exist precisely because the waves were additive. A status banner is the correct, minimal fix.
- **Take option (B) and convert the four `innerHTML` sites.** Rejected as described above (SVG parsing risk in `hud.js` for no current benefit).
- **Delete the `aaa-upgrade` planning documents** as superseded by OpenSpec. Rejected: they carry long-range product/strategy intent (visual identity, engine-migration triggers, the vertical-slice bar) that the change proposals deliberately do not restate, and deleting them would lose real content.
- **Add a docs-lint CI job** that fails when the README layout block drifts from the tree. Tempting and cheap, but the layout block is prose (descriptions, not just names), so a mechanical check would be brittle. Rejected; noted as an option.

## Rollout / compatibility

Documentation and comments only. No migration, no config, no behavior. The README edits must be reconciled with the two changes that also touch `README.md`.

## Testing strategy

- `npm run lint` — confirms no source comment edit broke anything (comments cannot, but the run is cheap and the optional DOMParser conversions, if taken, are covered by E2E).
- `npm test` and `npx playwright test` — unchanged; run them only if any optional code conversion (option B) is taken.
- Manual review: every directory in the actual tree appears in the README layout block; every npm script that is part of a quality gate appears in the quality-gate list; each architecture file opens with a status banner; `docs/README.md` links resolve.
- A grep pass confirming no remaining comment asserts the false innerHTML invariant.

## Risks

- **Merging friction with other changes that edit the same README sections.** Mitigated by sequencing this change last and by explicitly listing the coordinating changes in the tasks.
- **Scope creep into rewriting planning documents.** The tasks deliberately forbid editing the bodies of the architecture and `aaa-upgrade` documents; only banners and the index are in scope.
