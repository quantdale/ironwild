## Why

The repository's documentation has drifted from the code in ways that actively mislead a new contributor or a future implementation agent. The README's "Project layout" omits eight source directories and the entire asset/scripting surface, so a reader cannot find the animation, asset-pipeline, VFX, render, cell-streaming, or tooling code that exists; its quality-gate list omits the asset validator that the `gate-assets-in-ci` change is about to make mandatory; and its testing section overstates unit coverage (addressed by `harden-core-verification`). A code comment in `ui/menus.js` asserts that "raw innerHTML assignments" do not exist in the codebase while three modules use them directly. The three architecture-contract documents are historical records presented without a "these describe the original design waves" note, so they read as current specification. The planning documents in `docs/aaa-upgrade/` are not connected to the OpenSpec change set, so there is no single entry point for planned work.

## What Changes

- **Refresh the README's project layout** so it lists every current source directory, the tooling scripts, and the asset locations, matching the actual tree.
- **Update the README's quality-gate list** to include the asset validator, and state the test-strategy split (unit vs. E2E) accurately.
- **Correct the false innerHTML claim** in `ui/menus.js`. There are four direct assignments, not three: `settings.js`, `hud.js`, `quests.js`, and `systems/expedition.js`. State the actual static-template policy at each site. Do not convert them in this change.
- **Label the architecture documents as historical design records** with a one-line status note each, so a reader knows the current contracts are documented elsewhere.
- **Add an index/entry point** that ties the strategic planning documents and the OpenSpec change set together, so planned work has one navigable home.
- **Add a short note on cross-module global-state ownership**, since several `G.*` fields are declared outside `core/state.js` despite that file's header claiming it owns cross-module state.
- Documentation and comments only; no code behavior changes (the innerHTML call sites currently interpolate only build-time constants and are not an injection risk today — the change corrects the claim, not a vulnerability).

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
<!-- None. -->

Non-behavioral: documentation and comment corrections. It is marked `skip_specs: true` in `.openspec.yaml`.

## Impact

- Affected files: `README.md`, a documentation index (new, e.g. `docs/README.md`), status notes added to `ARCHITECTURE.md` / `ARCHITECTURE_V2.md` / `ARCHITECTURE_V3.md`, a comment correction in `src/ui/menus.js`, and a short ownership note in `src/core/state.js` (or `docs/`).
- No runtime, build, or test impact; the innerHTML comment fix touches only a comment unless the DOMParser adoption is taken (a code change with its own small verification, covered explicitly as an option in the tasks).
