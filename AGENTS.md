# IRONWILD — Canonical Agent Instructions

This is the repository-level operating contract for coding and planning agents. Harness-specific adapters are subordinate to it.

## Repository identity and product boundary

IRONWILD is an original browser action prototype built around Three.js/Vite with procedural world/gameplay systems and a repository-owned authored-asset certification pipeline. The current documented gameplay surface is keyboard/mouse + pointer lock on desktop-class browsers. Responsive narrow-screen HUD rules exist, but they do **not** by themselves establish touch controls or mobile gameplay support.

Do not infer features from genre similarity. Current implementation, tests, architecture documents, and explicit product docs are authoritative over assumptions.

## Required reading before substantial work

1. `ONBOARDING.md` for machine/bootstrap requirements.
2. `README.md` for current gameplay, controls, layout, rendering, and validation commands.
3. `.agent/STATE.md`, `.agent/PLANNER_HANDOFF.md`, and any active `.agent/EXECUTION_PROMPT.md`.
4. `ARCHITECTURE.md`, `ARCHITECTURE_V2.md`, and `ARCHITECTURE_V3.md` when changing established system boundaries.
5. Relevant `docs/` material and tests for the subsystem being modified.

Resume an active execution prompt only after reconciling it with current `main`; do not replay already-landed work because a conversation or context window is fresh.

## Canonical validation surface

From the repository root, current scripts include:

```bash
npm ci
npm run lint
npm test
npm run assets:validate
npm run test:e2e
npm run verify
```

`npm run verify` is the repository's broad gate (`lint` → unit tests → production-build Playwright E2E). `assets:validate` is separately important when authored GLB/KTX2 assets or their pipeline are touched.

Never claim a gate passed unless it was actually run at the reported checkout. Historical reports and screenshots are evidence of their checkpoint only, not automatic certification of current `main`.

## Engineering guardrails

- Preserve original/repository-owned content; do not introduce copyrighted third-party game assets as a shortcut.
- Treat save compatibility, deterministic game logic, combat/weak-point math, input/pointer-lock behavior, post-processing quality tiers, and asset validation as regression-sensitive surfaces.
- Keep accessibility and persisted settings behavior intact when modifying HUD/rendering/input paths.
- Responsive CSS is not proof of touch input. If true mobile gameplay is introduced, define input semantics, browser/device support, tests, documentation, and fallback behavior explicitly.
- Do not casually weaken quality gates to fit an environment. Record genuine machine/browser blockers instead.

## Documentation discipline

Update living documentation in the same change whenever setup, scripts, controls, supported platforms, gameplay behavior, architecture, save compatibility, quality tiers, validation, or known limitations change.

Preserve historical evidence and architecture history as historical records. Do not rewrite old results to look current. Evidence precedence is:

`current executable validation` > `current implementation/configuration` > `active agent state/prompt` > `living docs` > `historical records` > `assumptions`.

Fix contradictions when found. Avoid persisted live-HEAD claims in living docs unless a file is explicitly a historical checkpoint.

## Git safety

Inspect current status and final diff. Do not discard unrelated work, force-push, rewrite history, or use destructive cleanup as a convenience. Commit only intentional, validated changes; report any skipped or unavailable validation precisely.

Subdirectory-specific instructions may add stricter requirements but must not silently weaken this contract.
