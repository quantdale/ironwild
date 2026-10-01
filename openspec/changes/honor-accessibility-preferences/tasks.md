# Tasks — Honor accessibility preferences (accessibility)

## 0. Cross-change coordination (read before editing)

This change edits `src/ui/hud.js`, `src/ui/settings.js`, and `src/ui/a11y.js`. Sibling changes that also touch them:

- **`fix-hud-telemetry-accuracy`** rewrites the compass dot pool in `hud.js buildDom()` / `updateDots()` while this change adds a CSS rule block to `hud.js injectStyles()`. Different functions, same file: sequence the two, ideally in separate commits.
- **`complete-input-action-coverage`** adds rebind rows to `settings.js CONTROL_ACTIONS` while this change edits the settings labels. Different sections; sequence for safety.
- **`retire-dead-scaffolding`** does not touch these files. No conflict.

## 1. Apply the preference (CSS-driven layers)

- [ ] 1.1 In `src/ui/a11y.js apply()`, toggle a body-level class `iw-reduce-flashing` alongside the existing `iw-high-contrast` toggle, driven by `current.reduceFlashing`, inside the existing try/catch so a headless/DOM-less context degrades exactly as the other preferences do.
- [ ] 1.2 Confirm `reduceFlashing` is present in `WATCHED_KEYS` (it is, at the top of the file) so the class updates live on `settingsChanged`; add a comment naming the body class it drives.
- [ ] 1.3 In `src/ui/hud.js injectStyles()`, add a `body.iw-reduce-flashing` rule block that sets `animation: none` on `#iw-vig.on`, `#iw-grain`, `#iw-xpbar.pulse`, and `.iw-qslot.done`.
- [ ] 1.4 In the same block, give `#iw-vig.on` a static, clearly visible `opacity` (e.g. `0.55`) so the low-health warning remains readable without pulsing.
- [ ] 1.5 Confirm the selectors are more specific than the base rules so no `!important` is needed; verify the cascade resolves via the E2E computed-style check in section 5.
- [ ] 1.6 Confirm the non-animated parts survive: `#iw-cine` (static vignette) and the `#iw-grain` texture itself must still render — only the `iwgrain` animation is removed.
- [ ] 1.7 Do not touch the start screen `iwpulse` "CLICK TO BEGIN" animation (pre-run affordance, out of scope per design).
- [ ] 1.8 Update the stale comments in `src/ui/hud.js` (around the `onBowState` and `bowState` consumers) that currently imply `reduceFlashing` is what keeps the reticle classes motion-free; reword so the comment describes the actual mechanism (the classes are keyframe-free by construction).

## 2. Bound the weather lightning flash

- [ ] 2.1 In `src/world/weather.js strike()`, read `G.settings && G.settings.reduceFlashing` once and select a lower `flashLevel` range (e.g. `0.15`–`0.3`) than the current `0.5`–`0.85`, keeping the existing `Math.exp(-dt * 11)` decay and the `#iw-lightning` write path unchanged.
- [ ] 2.2 Keep the `flashLight` directional-light spike unchanged (it is a scene light, not a screen flash) so the world lighting still reads the strike.
- [ ] 2.3 Guard the read so a missing `G.settings` cannot throw (weather already runs very early in boot).
- [ ] 2.4 Add a short comment recording the chosen bounds and why the effect is reduced rather than removed.

## 3. Settings wiring

- [ ] 3.1 Confirm the `REDUCE FLASHING` checkbox label and its `title`/description communicate what is actually reduced (HUD pulses, grain animation, lightning flash), matching the implemented behavior rather than the old "hit vignette, reticle kick" wording.
- [ ] 3.2 Confirm `loadSettings()` already restores the boolean for older saves and that the `A11Y_DEFAULTS` merge fills it for fresh boots — no change needed unless verification shows otherwise.
- [ ] 3.3 Verify the preference round-trips through the existing `persist()`/`setValue()` path without a schema change; make no change to the `ironwild-settings` shape.

## 4. Unit coverage

- [ ] 4.1 Extend `tests/unit/hud-telemetry.test.js` (or add `tests/unit/a11y-apply.test.js`): assert the injected HUD stylesheet contains a `body.iw-reduce-flashing` rule for each of `#iw-vig`, `#iw-grain`, `#iw-xpbar.pulse`, `.iw-qslot.done`, and that each rule disables animation.
- [ ] 4.2 Assert the reduced low-HP rule still sets a non-zero static opacity (the warning must not disappear).
- [ ] 4.3 In the same suite, assert the `body.iw-high-contrast` rules are untouched by the new block (no regression to the existing high-contrast feature).
- [ ] 4.4 For `src/ui/a11y.js`, add a case asserting `apply()` toggles `iw-reduce-flashing` on the body for the preference value; extend `tests/setup.dom.js` with a minimal `classList` stub only if the existing document stub lacks one.
- [ ] 4.5 Add a case asserting the published `window.__IW_A11Y.reduceFlashing` matches the setting.
- [ ] 4.6 Run `npm test` and confirm the full suite passes.

## 5. E2E coverage

- [ ] 5.1 Extend `tests/e2e/a11y-lifecycle.spec.js` (it already covers persisted a11y settings applying through boot): assert the `iw-reduce-flashing` body class is applied at boot when the preference is persisted, and absent by default.
- [ ] 5.2 Add a computed-style assertion: enable the preference, reload, start a run, force the player's health below the low-health threshold, and assert `#iw-vig` carries the `on` class while its computed `animation-name` is `none`.
- [ ] 5.3 Add a negative control: with the preference off, assert `#iw-vig.on` has a non-`none` computed `animation-name`, proving the assertion above is meaningful.
- [ ] 5.4 Assert the console stays clean across the preference change (no missing-element or style errors).

## 6. Verification

- [ ] 6.1 `npm run lint` clean.
- [ ] 6.2 `npm test` passes.
- [ ] 6.3 `npm run build` succeeds.
- [ ] 6.4 `npx playwright test` — full suite green.
- [ ] 6.5 Manual check (record in the PR description): with the preference on, confirm no full-screen pulse, no moving grain, and a dimmer lightning flash; confirm the low-health warning is still clearly visible.

## 7. Documentation

- [ ] 7.1 Update the `README.md` accessibility line to describe what the colorblind cue and the new flashing reduction actually do, matching the implemented behavior.
- [ ] 7.2 Update the `src/ui/a11y.js` header comment to list the body classes it drives and the CSS-animated layers it governs.
- [ ] 7.3 Add a short note in `docs/BALANCE.md` only if flashing reduction measurably affects time-to-detect low health (it should not; it changes presentation, not timing) — most likely no change is needed.
