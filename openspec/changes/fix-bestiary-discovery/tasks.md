# Tasks — Fix bestiary discovery (bestiary-progression)

## 0. Cross-change coordination (read before editing)

This change is **fully independent** of every sibling change: its only production-code edit is a new bus subscriber in `src/systems/bestiary.js`, and no other change edits that file. It can be assigned to a parallel agent with no coordination risk.

Two nearby changes touch related code, so read them before deciding scope (neither blocks you):

- `restore-machine-combat-visuals` edits `src/machines/ai.js` and the `machineHit`/`machineScanned` emit sites' surrounding code. This change does **not** edit `ai.js` or `focus.js` — it subscribes to the already-emitted `machineHit`. If that change alters the `machineHit` payload shape, re-check the `p.machine` read here.
- `enforce-permadeath-run-model` changes what happens to `G.bestiary` across a run boundary (a finished run is not restorable). This change does not alter the persisted shape (`{ seen, killed }`) or the save version, so the two are compatible; if the permadeath change lands first, simply re-run this change's save round-trip assertions.

## 1. Add the combat discovery trigger

- [ ] 1.1 In `src/systems/bestiary.js`, add a `onHit(p)` handler that reads `p.machine.type` and calls the existing `markSeen()`; ignore payloads with no `machine` or with an unlisted type.
- [ ] 1.2 Subscribe it in `createBestiary()` via `bus.on('machineHit', onHit)`, keeping the existing `machineScanned` and `machineDied` subscriptions.
- [ ] 1.3 Do **not** change `markSeen` / `markKilled` / `ensureEntry` semantics — the `if (e.seen) return` early-return already provides the once-only guarantee; add a comment noting that it is what keeps the announcement single-shot.
- [ ] 1.4 Do not loosen the `machineScanned` Vantage filter in `src/machines/ai.js` or `src/ui/focus.js` — that event carries the map-reveal reward and must stay Vantage-only.
- [ ] 1.5 Verify the ordering property: a machine that is hit and then killed yields exactly one `kind: 'seen'` and one `kind: 'killed'` transition.
- [ ] 1.6 Confirm no change is needed to `G.bestiary`'s shape or `save.js`'s serialize/restore path (`{ seen, killed }` is already round-tripped); do not bump the save version.

## 2. Guard against noisy or premature discovery

- [ ] 2.1 Confirm a deflected hit (bulwark front armor) does not emit `machineHit` and therefore does not reveal — verify against `src/combat/projectiles.js resolveHit` and the spear's `applySwingHits` early return; if the spear path emits on deflection, suppress discovery there.
- [ ] 2.2 Confirm the bestiary never reveals from proximity/aggro alone (no new per-frame scan is introduced).
- [ ] 2.3 Confirm the existing HUD toast cap (max 5) still bounds simultaneous reveal announcements during a multi-species fight.

## 3. Unit coverage

- [ ] 3.1 Create `tests/unit/bestiary.test.js` using the `vi.resetModules()` + dynamic-import pattern (bus is a module singleton; unsubscribe in `afterEach`, as `tests/unit/events.test.js` does).
- [ ] 3.2 `machineHit` with a known type sets `seen` and leaves `killed` false.
- [ ] 3.3 Repeated `machineHit` for the same type emits `bestiaryUnlock { kind: 'seen' }` exactly once and a single `notify` (count emissions via a bus subscription).
- [ ] 3.4 `machineDied` sets both flags and emits `kind: 'killed'` once across repeated kills of the same type.
- [ ] 3.5 Reveal-then-kill produces exactly one `seen` and one `killed` transition, in that order.
- [ ] 3.6 `machineScanned` still reveals without killing (Vantage path preserved).
- [ ] 3.7 An unknown machine type is ignored: no entry created, no throw.
- [ ] 3.8 A `machineHit` with no `machine` field is ignored without throwing.
- [ ] 3.9 `speciesLore` returns a line only when `killed`, and `''` otherwise; `speciesName` falls back to the raw key for an unknown type.
- [ ] 3.10 `createBestiary()` seeds every `SPECIES` entry as `{ seen: false, killed: false }` and is idempotent on a second call.
- [ ] 3.11 Run `npm test` and confirm the whole suite passes.

## 4. Save round-trip coverage

- [ ] 4.1 Assert a revealed-only entry serializes and restores as `{ seen: true, killed: false }` (add to the save suite if `harden-core-verification` landed; otherwise cover it here).
- [ ] 4.2 Assert a malformed bestiary record in a hand-edited save restores to safe booleans rather than propagating junk (behavior already implemented in `save.js`; this pins it).
- [ ] 4.3 Assert a save written before this change (no bestiary field) still loads and the module's defaults stand in.

## 5. E2E coverage

- [ ] 5.1 Start a run, select a non-Vantage machine, apply resolved damage through its own `hit()` path (mirroring the approach already used in `tests/e2e/combat-smoke.spec.js`), and assert `G.bestiary[type].seen === true` while `killed === false`.
- [ ] 5.2 Kill the same machine and assert `G.bestiary[type].killed === true`.
- [ ] 5.3 Assert the Vantage scan → map reveal path is unaffected (either reuse an existing assertion or drive a scan directly and assert `G.mapRevealed === true` and the skill-point grant).
- [ ] 5.4 Assert the console stays clean through the sequence.
- [ ] 5.5 Run the full Playwright suite.

## 6. Verification

- [ ] 6.1 `npm run lint` clean.
- [ ] 6.2 `npm test` passes.
- [ ] 6.3 `npm run build` succeeds.
- [ ] 6.4 `npx playwright test` — full suite green.

## 7. Documentation

- [ ] 7.1 Update the `src/systems/bestiary.js` header comment so the `seen` trigger list matches the implementation (damaged **or** focus-scanned), replacing the phrasing that implies scanning is the only discovery path.
- [ ] 7.2 Confirm `README.md`'s bestiary line already matches the implemented behavior; change it only if the implemented trigger set diverges from "scanning or fighting one reveals its name".
- [ ] 7.3 Note in the `docs/BALANCE.md` scan/XP section that combat damage does not grant the scan reward (map reveal, skill points, scan XP) so the economy tables stay accurate.
