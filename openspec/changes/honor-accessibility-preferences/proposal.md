## Why

The settings panel offers a "Reduce Flashing" accessibility toggle that is described in code and UI as damping HUD flash overlays, but nothing ever reads it — the value is persisted, republished on every `settingsChanged`, and then ignored. Meanwhile the HUD runs several unconditional full-screen or pulsing animations: a low-HP vignette that pulses at 1.15 s, an animated film-grain layer, an XP-bar pulse, and the lightning flash div. A player who explicitly asks for reduced flashing gets nothing, which is both an accessibility failure and a correctness failure between the documented setting and the implementation.

## What Changes

- **Make `reduceFlashing` actually gate the flashing HUD effects.** When enabled, the low-HP damage vignette, the animated film-grain overlay, and the XP-bar pulse are suppressed or replaced with a static, non-animated equivalent. The lightning weather flash is a separate world effect and is reduced (not removed) so it stays readable but no longer strobes.
- **Keep the static, non-flashing parts of those layers.** The cinematic vignette and grain *texture* can remain as static overlays (a still image is not flashing); only their animation is removed. This preserves the art direction for users who do not need the reduction.
- **Make the setting apply live and on boot,** consistent with every other accessibility option, and make it observable (a body-level class or CSS custom property the styles can key off) rather than requiring per-frame JavaScript.
- **Add regression coverage** proving the toggle changes the rendered state of the flashing layers and that it round-trips through persistence.
- No change to the default value (off) or to any other accessibility option.

## Capabilities

### New Capabilities
- `accessibility`: The observable contract that every user-facing accessibility preference offered in settings is applied to the running game — that flashing effects are reduced when requested, that the preference applies live and on boot, and that it persists.

### Modified Capabilities
<!-- None: first specification of this behavior; openspec/specs/ is currently empty. -->

## Impact

- Affected code: `src/ui/a11y.js` (publish a flashing-reduction class/property), `src/ui/hud.js` (`#iw-vig` keyframes, `#iw-grain` `iwgrain` keyframes, `#iw-xpbar.pulse` `iwxppulse` keyframes), `src/world/weather.js` (lightning `flashLevel` ceiling), `src/ui/settings.js` (wiring), `tests/unit/` (new coverage).
- The reduction is CSS-driven where possible so it costs nothing per frame; the weather flash needs a small JS clamp because it is animated imperatively.
- Visual-only effect; no gameplay, persistence-format, or input changes.
