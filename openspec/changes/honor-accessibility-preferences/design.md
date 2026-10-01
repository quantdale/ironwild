# Design — Honor accessibility preferences (accessibility)

## Current-state analysis

### The setting exists end-to-end except at the point of use

Trace of `reduceFlashing`:

| Layer | File | State |
| --- | --- | --- |
| Definition | `src/ui/settings.js:35` | `reduceFlashing: false` in `A11Y_DEFAULTS`, commented "damp HUD flash overlays (hit vignette, reticle kick)" |
| Load/merge | `src/ui/settings.js:109` | `if (typeof saved.reduceFlashing === 'boolean') G.settings.reduceFlashing = saved.reduceFlashing;` |
| Persistence | `src/ui/settings.js:198` (`setValue` → `persist`) | written to `ironwild-settings` |
| UI control | `src/ui/settings.js:204`, `:391` | checkbox wired to the key |
| Republish | `src/ui/a11y.js:37` | `reduceFlashing: !!s.reduceFlashing` into `window.__IW_A11Y` |
| **Consumer** | — | **none** |

A repository-wide grep for `reduceFlashing` outside `a11y.js` / `settings.js` returns only two comments in `src/ui/hud.js` (lines 381, 727) that *assume* a consumer exists:

> "Classes are static (no keyframes) - so users with reduceFlashing get no additional motion."

That comment describes the bow-reticle emphasis classes (correctly keyframe-free), but it implies the setting governs the HUD's other motion, which it does not.

### What actually flashes today

All of these are unconditional:

1. `#iw-vig` — low-HP overlay. `#iw-vig.on { animation: iwvig 1.15s ease-in-out infinite; }`, `@keyframes iwvig { 0%,100%{opacity:.25} 50%{opacity:.85} }`. Toggled by `updateHUD`: `els.vig.classList.toggle('on', hpF < 0.3)`. A 0.25→0.85 opacity pulse at 0.87 Hz, full screen, red — this is the highest-risk effect for photosensitivity and the one the setting's own comment names first ("hit vignette").
2. `#iw-grain` — `animation: iwgrain .7s steps(5) infinite` translating a 180px noise tile across a `-40px` inset overlay. Continuous motion, ~0.05 opacity, full screen.
3. `#iw-xpbar.pulse` — `animation:iwxppulse .45s ease-out` box-shadow flash, added/removed by `onXpGain` with a forced reflow.
4. `#iw-lightning` (weather) — `flashLevel = randRange(rng, 0.5, 0.85)`, decayed via `Math.exp(-dt * 11)` and written to a full-screen white `div` opacity every frame. Peak 0.85 opacity full-screen white, every 2.5–9 s during storms.
5. `iwqflash` (contracts) — `.iw-qslot.done { animation:iwqflash .5s ease-in-out 3; }` background flash on completion (3 iterations, local to a small panel).
6. `iwpulse` (start screen "CLICK TO BEGIN") — pre-game only, `opacity .35 ↔ 1` at 1.6 s.

Scope decision: cover 1–4 (the full-screen or high-amplitude ones the setting's own description names) plus 5 (trivial, same mechanism). Leave 6 alone: it is a title-screen affordance shown only before a run starts, where flashing carries no gameplay risk and suppressing it would hide the primary call to action.

## Intended approach

Drive the reduction from CSS via a body-level class, matching the pattern `ui/a11y.js` already uses for high contrast (`document.body.classList.toggle('iw-high-contrast', ...)`). This costs zero per-frame JavaScript and is applied live on `settingsChanged` through the existing `WATCHED_KEYS` set.

- `ui/a11y.js`: also toggle `iw-reduce-flashing` on `<body>`; add `reduceFlashing` to the `WATCHED_KEYS` set (it is already watched — confirm; it is listed at line 15).
- `ui/hud.js injectStyles()`: add rules under `body.iw-reduce-flashing` that (a) set `#iw-vig.on { animation: none; opacity: .55 }` — a steady, clearly visible but non-pulsing warning; (b) `animation: none` on `#iw-grain`; (c) `animation: none` on `#iw-xpbar.pulse`; (d) `animation: none` on `.iw-qslot.done`.
- `world/weather.js strike()`: clamp `flashLevel` by reading `G.settings.reduceFlashing` at strike time (single read per strike, not per frame), e.g. `randRange(rng, 0.15, 0.3)` when enabled, keeping the existing decay. This is the one place that needs JS because the flash is written imperatively.

CSS `!important` is not required: the rules are more specific (`body.iw-reduce-flashing #iw-vig.on` beats `#iw-vig.on`).

### Why a class rather than per-frame checks

`hud.js` already polls the player every frame, but the flashing layers are driven by CSS animations keyed off classes, so a per-frame JS check would either fight the animation (restart thrash) or require removing/re-adding classes each frame. A single body class is the correct lever and makes the reduced state inspectable in devtools.

## Control flow after the change

```text
settings checkbox -> setValue('reduceFlashing', bool) -> persist + bus 'settingsChanged'
  -> ui/a11y.js apply() -> body.classList.toggle('iw-reduce-flashing', bool)
                          window.__IW_A11Y.reduceFlashing = bool
  -> CSS: body.iw-reduce-flashing #iw-vig.on { animation:none; opacity:.55 }  (+ 3 more)
  -> weather.js next strike(): flashLevel = reduce ? randRange(.15,.3) : randRange(.5,.85)

boot: loadSettings() -> createA11y() -> apply() -> class applied before first frame
```

## Data-flow / state changes

No new persisted fields; `reduceFlashing` is already in the `ironwild-settings` object and already round-trips. No event-payload changes. `window.__IW_A11Y` gains no new shape (the key already exists).

## Failure handling

- If `document.body` is unavailable (headless/partial DOM), `a11y.js` already wraps DOM access in try/catch and keeps state in the module `current` snapshot — extend that rather than adding a new failure mode.
- If a future stylesheet renames the layer ids, the reduced-flashing rules silently stop applying. Mitigation: add a unit assertion that each targeted element id/class still exists in the injected stylesheet text, so a rename breaks a test rather than a user's setting.

## Alternatives considered

- **Remove the effects entirely when reduced flashing is on.** Rejected: the low-HP warning is safety-relevant information, not decoration. A steady, non-pulsing overlay preserves the signal.
- **Expose a "reduce motion" preference distinct from "reduce flashing".** Rejected as scope creep; the grain translation is motion but at 0.05 opacity it is not the photosensitivity risk the setting addresses. Note it as a possible future option.
- **Scale flash intensities via existing per-frame JS in `hud.js`/`weather.js` only.** Rejected for the CSS-driven layers (thrashing, per-frame cost); used only for the weather flash where the value is already imperative.

## Testing strategy

- Unit (`src/ui/hud.js` is DOM-heavy; use the existing `hud-telemetry.test.js` approach — import-safe, pure-helper coverage):
  - assert the injected stylesheet (or a constant listing the targeted selectors) contains a `body.iw-reduce-flashing` rule for each of `#iw-vig`, `#iw-grain`, `#iw-xpbar.pulse`, `.iw-qslot.done`, and that each rule sets `animation: none`;
  - assert the low-HP reduced rule sets a non-zero static opacity (so the warning is not lost);
  - `src/ui/a11y.js`: assert `apply()` toggles the body class for the preference (using a `document.body` stub from `tests/setup.dom.js`, extended with a minimal `classList` if needed).
- E2E (`tests/e2e/a11y-lifecycle.spec.js` already exists and covers persisted a11y settings):
  - enable reduced flashing, reload, start a run, drop health below 30%, and assert `#iw-vig` has the `on` class while its computed `animation-name` is `none`;
  - assert the `iw-reduce-flashing` body class is present at boot and absent by default.

## Risks

- Over-suppression making the game less readable — mitigated by keeping a static low-HP overlay and a visible (if dimmer) lightning flash.
- CSS specificity mistakes leaving the animation active — mitigated by the E2E computed-style assertion, which is the only check that actually proves the cascade resolves.
