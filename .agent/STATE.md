# Current State

**Repository:** `quantdale/ironwild`  
**State:** IMPLEMENTED_ACTIVE_PROTOTYPE

## Durable product truth

IRONWILD is an implemented browser machine-hunting action prototype with repository-documented gameplay, progression, persistence, rendering, authored-asset validation, unit tests, and Playwright E2E. Desktop keyboard/mouse + pointer-lock remains the documented gameplay input model.

The latest implementation change before this documentation refresh added narrow-screen/safe-area layout rules for quest, HUD, and minimap surfaces. That change improves responsive presentation; it is not evidence of touch controls or a mobile gameplay certification.

## Validation surface

Current `package.json` exposes `lint`, `test`, `assets:validate`, `test:e2e`, and `verify`. `verify` runs lint, unit tests, then production-build Playwright E2E; asset validation remains an explicit additional gate for authored-content work.

This documentation sweep did not execute those commands, so no fresh PASS is claimed here.

## Continuation

Read `AGENTS.md` and `ONBOARDING.md`, then reconcile any active execution prompt with current `main`. Resume from the first genuinely incomplete requirement, keep architecture/history records intact, and update this state when a campaign changes product boundaries, validation, supported inputs/platforms, or completion/blocker status.
