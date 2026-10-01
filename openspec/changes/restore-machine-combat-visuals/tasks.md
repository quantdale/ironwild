# Tasks — Restore machine combat visuals (machine-presentation)

## 0. Cross-change coordination (read before editing)

This change edits `src/machines/ai.js` (attack scripts) and may touch `src/assets/manifest.js` (weak-point tag declarations). Two sibling changes also touch those files:

- **`fix-hud-telemetry-accuracy`** edits the single `MACH_CAP` line at the top of `ai.js` and adds a `CONFIG` constant. Apply that change **first**, or keep the `MACH_CAP` edit and this change's attack-script edits in separate commits so they do not fight over the same file.
- **`fix-bestiary-discovery`** deliberately does **not** edit `ai.js` (it subscribes to the existing `machineHit` event instead). Confirm that assumption still holds before starting; if this change ends up editing the `machineScanned` emit sites, that is a new conflict and the two changes must be sequenced.

Also: `tests/e2e/asset-pipeline.spec.js` is extended by this change; `gate-assets-in-ci` only references it (no edit), so there is no conflict there.

## 1. Weak-point rebinding on authored install

- [ ] 1.1 In `src/anim/machineAnim.js installAuthored()`, before hiding any procedural mesh, read the authored rig's weak-point markers from `root.userData.weakPoints` (populated by `src/systems/assets.js collectWeakPoints()`) and match them to the machine's declared weak points by name/tag.
- [ ] 1.2 When a match exists, repoint the machine's `weakPoints[i].mesh` at the authored marker node so hit detection (`projectiles.js collideMachines`, `spear.js applySwingHits`), focus-scan labels, the colorblind weak-point cue, and bow aim assist all read the authored rig's live transform. Preserve the existing `radius`, `multiplier`, `hp`, and `name` from `machines.js registerWeakPoint` so balance and difficulty are unchanged.
- [ ] 1.3 When the authored rig supplies no usable marker for a declared weak point, do NOT retire the procedural body for that machine: keep `installAuthored` returning `false` (stay procedural) so no hit target is left pointing at hidden geometry.
- [ ] 1.4 On rebind, carry the weak point's emissive treatment onto the authored marker (or attach a small visible marker node) so the weak point remains visually distinct against the rig's own materials; the glow must survive quality-tier changes.
- [ ] 1.5 Keep `broken` state authoritative: when a rebound weak point's hit points are depleted, the break MUST be visible on the mesh that is actually drawn. The current `applyHit` char loop iterates `wp._mats` (procedural materials on hidden meshes), so rebinding alone is **not** sufficient — route the char/darken feedback to the bound marker. Verified failure: breaking an authored skitter optic leaves the rendered emissive byte-identical (`0xFF6F59`, intensity 1.0) before and after.

## 2. Drive attack telegraphs through the animator

- [ ] 2.1 In `src/machines/ai.js`, call `m.animator.playAttack('<move>')` when each per-type attack enters its anticipation phase, using the `ATTACK_WINDOWS` keys already defined in `src/anim/machineAnim.js` (`lunge`, `swipeL`, `swipeR`, `kick`, `dash`, `bolt`, `dive`, `roll`, `crush`, `tail`). Cover `skitterAttack`, `rendclawAttack`, `bramblehornAttack`, `ironmawAttack`, `duskwingAttack`, `bulwarkAttack`, `monarchTick`/`monarchStomp`/`monarchTail`, and `mirefangTick`/`startMireAmbush`.
- [ ] 2.2 Wrap each call in the same isolation style already used in `updateMachineAnimators` (try/catch + console.error) so a broken authored rig can never abort the AI step.
- [ ] 2.3 Do NOT change where damage is applied. `ai.js` keeps full damage authority; the animator only describes and plays the timing. Confirm the returned `anticipation`/`active`/`recovery` windows match the AI's own phase durations for each type, and adjust `ATTACK_WINDOWS` values if the AI has drifted.
- [ ] 2.4 Keep the existing procedural pose channels (`a.crouch`, `a.rear`, `a.roar`, `a.lean`, `a.rollSpin`, jaw/grinder) untouched so procedural machines are byte-for-byte unchanged.

## 3. Drive hit reactions and death performance

- [ ] 3.1 In `src/machines/machines.js applyHit()`, on resolved (non-deflected) damage call `m.animator.playHitReact(strength)` with a strength derived from the damage fraction of max hp, in addition to the existing `m._anim.flinch = 0.25`.
- [ ] 3.2 In `src/machines/machines.js killMachine()`, call `m.animator.playDeath()` before emitting `machineDied`, so the death performance starts on the killing frame.
- [ ] 3.3 Verify the animator dispose path in `src/machines/ai.js updateMachines()` still runs exactly once per disposed machine record and that a death performance is allowed to finish before resources are released (or that the fade/tip-over in `updateDeath()` remains the visible death beat for procedural machines).
- [ ] 3.4 Ensure a machine that dies while an authored attack clip is still playing settles to the death state without leaving a looping action or a stale lock on the locomotion state machine.

## 4. Installed-rig safety guarantees

- [ ] 4.1 Add a one-time (per machine, at install) verification in `installAuthored()` that every declared, unbroken weak point resolves to a node that is visible in the authored rig; if any fails, fall back to procedural presentation rather than half-installing.
- [ ] 4.2 Confirm that asset load/decode failure, a mixer-less clip set, and a missing-convention rig all still leave the machine fully presented and hittable (existing catch paths in `attachMachineAnimator` plus the new checks).
- [ ] 4.3 Do not add any per-frame deep-traverse visibility scan; the guarantee must be established once at install.

## 5. Unit coverage

- [ ] 5.1 Extend `tests/unit/machine-animator.test.js` (node env, `vi.resetModules()` + dynamic import pattern already in use): a rig with no `wp_*` markers must not hide the procedural body; a rig with markers must rebind the machine's weak-point mesh to the authored node.
- [ ] 5.2 Add a case that `playAttack` in procedural mode returns the synthesized `ATTACK_WINDOWS` metadata for each roster type and that the returned windows bound the AI's actual phase durations.
- [ ] 5.3 Add a call-counting harness test: construct a machine, resolve a hit through `machine.hit(...)`, and assert `playHitReact` was invoked; resolve lethal damage and assert `playDeath` was invoked.
- [ ] 5.4 Add a case asserting a broken rebound weak point stops registering weak-point hits and reports its broken state.
- [ ] 5.5 Confirm the whole existing unit suite still passes (`npm test`) — the procedural path must be unregressed.
- [ ] 5.6 Add a case proving the defect this change fixes: with an authored rig whose clips include an attack, invoking `playAttack` puts that clip into a running state — and, symmetrically, omitting the call leaves only locomotion running. This pins the "clips load but never play" failure mode that is invisible to any mode-only assertion.
- [ ] 5.7 Add a case that breaking a rebound weak point mutates the material of the **bound** (authored) marker, not only the procedural one — i.e. assert the rendered emissive/colour actually changes.
- [ ] 5.8 Add a case for the fallback: an authored rig with no `wp_*` markers stays procedural, so break feedback remains visible through the existing procedural path.

## 6. E2E coverage

- [ ] 6.1 Extend `tests/e2e/asset-pipeline.spec.js` with a **state-feedback** assertion: for every alive machine (authored and procedural), break a weak point through `machine.hit()` and assert the rendered representation of that weak point actually changes. Do **not** assert only "a visible weak-point mesh exists" — that already passes today and cannot detect this defect.
- [ ] 6.2 Add an E2E case that aggro + closes on an authored machine and asserts its mixer leaves `loc_idle` and enters an attack state (attack animation actually plays), using the existing `window.__IW` debug handle.
- [ ] 6.3 Add an E2E case that damages an authored machine's weak point to zero and asserts the break is observable and the weak point stops taking weak-point damage.
- [ ] 6.4 Keep the existing assertion that skitter/ironmaw/duskwing upgrade to authored mode — the fix must not be implemented by disabling the upgrade. Note that this existing assertion only checks `animator.mode === 'authored'`; it passes today despite the clips never playing and break feedback being invisible, so it is a necessary but **not** sufficient gate. Do not treat it as evidence the upgrade is working.
- [ ] 6.5 Run `npx playwright test` and confirm the full suite is green with a clean console (`CONSOLE_ALLOWLIST` unchanged).

## 7. Verification and documentation

- [ ] 7.1 Run `npm run lint`, `npm test`, `npm run build` — all clean.
- [ ] 7.2 Re-run the runtime probe used during this audit (authored-root mesh enumeration + mixer action sampling + before/after break comparison) and confirm: (a) `playAttack`/`playHitReact`/`playDeath` are non-zero under forced combat, (b) the authored mixer leaves `loc_idle` during an attack, and (c) breaking a weak point measurably changes the rendered emissive.
- [ ] 7.3 Update the header comments in `src/anim/machineAnim.js` and `src/machines/ai.js` to state that gameplay owns damage authority and the animator owns presentation timing, and that the two must be invoked from the AI/damage paths.
- [ ] 7.4 Note in `docs/BALANCE.md` only if the weak-point rebinding changes effective hit geometry in a way that affects the documented TTK tables; otherwise leave balance numbers untouched.
