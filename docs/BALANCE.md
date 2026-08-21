# IRONWILD v3 — Balance Audit

> **Update (post-audit pass):** all twelve findings below were applied to source —
> F1 (`bow.js`, `projectiles.js`), F2 (`projectiles.js`, `machines.js`), F3 (`ai.js`
> `panicFlee`), F4 (`projectiles.js`/`bow.js` power-scaled burn), F5 (`ai.js`
> `completeHarvest` now grants wood), F6/F7 (`machines.js` LOOT, `quests.js` ironmaw
> bonus SP), F8 (`state.js` `maxArrows: 60`), F9 (`ai.js` `DUSKWING_STUN: 2.5`), F10
> (`spear.js` `DMG_WEAK: 40`). F11/F12 were left as documented tradeoffs (low
> severity, no change recommended). This file's body below is the original
> read-only audit, kept intact for the reasoning and TTK tables behind each fix.

Row `balance-audit` deliverable. **No source files were edited during the original audit
pass** (see the update note above for the later fix-up pass). Every constant below was
extracted by reading the working tree; TTK/economy numbers were computed with a throwaway
`node -e` simulation of the exact damage pipeline (`resolveHit` → `applyHit`, burn ticks,
part-break rules). Line numbers refer to the tree as of this audit (v3 rows already merged:
mirefang/monarch bodies + AI, `player/spear.js`, `systems/xp.js`, `ui/tips.js`).

Audited files: `src/core/state.js`, `src/machines/machines.js`, `src/machines/ai.js`,
`src/player/bow.js`, `src/player/player.js`, `src/player/spear.js`,
`src/combat/projectiles.js`, `src/combat/status.js`, `src/systems/xp.js`,
`src/systems/quests.js`, `src/ui/menus.js`, `src/world/props.js`.

---

## 0. Findings at a glance

| # | Severity | Finding |
|---|---|---|
| F1 | high | `hunterKiller` multiplies **all** arrow damage ×1.3, not weak-point-only as documented — one-shots a Skitter through the optic |
| F2 | high | A fire arrow **deflected** by the Bulwark's front armor still applies the full 48 burn — armor identity bypassed |
| F3 | medium | Burn "panic" flag (`m.panic`/`m.panicT`) is set by status.js but **never read** by ai.js — promised flee behavior is dead code |
| F4 | medium | Burn does not scale with draw power: min-draw fire arrow = 9.3 impact + 48 burn = 57.3 effective (87% of a full draw for 15% of the draw time) |
| F5 | high | **Wood is fully non-renewable** (34 units ever) and gates both arrow crafting and medicine — long runs hard-starve |
| F6 | medium | Rendclaw: highest ground melee threat, pays *less* than the fleeing Bramblehorn (4 shards+1 oil vs 3 shards+2 oil) |
| F7 | low | Ironmaw faucet: 13 shards/kill vs trivial core-break kite; hunt contracts pay flat +1 SP regardless of target difficulty |
| F8 | high | Monarch needs 57 standard arrows (weak-first, rank 0) vs `maxArrows: 40` — unwinnable without fire/HK build or mid-fight resupply that doesn't exist |
| F9 | low | Duskwing stuns itself on the ground for 4 s after every dive (~12.6 s cycle) — free kill window each pass |
| F10 | info | Spear weak hit 39 vs Skitter optic 40 hp — misses the break by 1 point |
| F11 | info | Killing the (only, non-respawning) Vantage permanently forfeits map reveal + 2 SP for ~11 shards of loot |
| F12 | info | Vantage re-scan every 30 s re-emits `machineScanned`: passive +15 XP / contract-medicine farm while parked |

---

## 1. Extracted constants

### 1.1 Player weapons & movement

| Constant | Value | Location |
|---|---|---|
| Arrow base damage (full draw) | 22 | `state.js:23` |
| Damage formula | `22 × (0.5 + 0.5·power) × (hunterKiller ? 1.3 : 1)` | `bow.js:181` |
| Min-loose draw fraction | 0.15 → power 0.061 → 11.7 dmg | `bow.js:14`, `bow.js:103` |
| Full-draw time | 0.85 s (Steady Aim ×0.65 = 0.5525 s) | `state.js:26`, `bow.js:96` |
| Arrow speed | lerp(24, 62, power) m/s; gravity ×0.55 | `state.js:24-25`, `projectiles.js:291` |
| Fire arrow impact mult | ×0.8 (17.6 full draw) | `projectiles.js:20` |
| Burn | 12 dps × 4 s = 48, ticks 6 per 0.5 s, refreshed per hit, body-only (no weak mult) | `status.js:10-13`, `projectiles.js:229` |
| Stuck-arrow refund | walk-over ≤1.8 u, standard pool only, 25 s life | `projectiles.js:16-18`, `324-327` |
| Spear (KeyF) | 26 body / 39 weak-flat, 0.8 s cd, 2.4 u ±55° cone, hits every machine in arc once, lunge 1.2 u | `spear.js:17-25` |
| Player HP | 100 (+30 Heartier); medicine heals 45 | `player.js:19-21` |
| Dodge | 25 stamina (12.5 Second Wind), 0.38 s, **full i-frames** (`takeDamage` no-ops while dodging) | `state.js:17-19`, `player.js:218` |
| Stamina | regen 18/s after 0.8 s idle; sprint 12/s; swim drain 8/s, drown 5 dps floored at 10 % maxHp | `player.js:17-18, 36-38` |
| Fall damage | `(impact_vy − 18) × 3` hp below vy −18 | `player.js:41-42` |
| Speeds | walk 6.0 / sprint 10.5 / crouch ×0.5 / wade ×0.5 / swim ×0.35 | `state.js:14-15`, `player.js:25, 35` |

### 1.2 Machine roster (`machines.js:693-701` ROSTER, weak points at cited lines)

| Type | HP | Radius | maxSpeed | Weak points (mult / part-hp / radius) |
|---|---|---|---|---|
| skitter | 60 | 0.55 | 6.0 | optic ×2.5 / 40 / 0.28 (`:129`) |
| bramblehorn | 80 | 0.75 | 8.5 | fuelsac ×2 / 50 / 0.4 (`:178`), cell ×2 / 45 / 0.3 (`:187`) |
| rendclaw | 140 | 0.75 | 7.5 | neckcord ×2.2 / 60 / 0.32 (`:246`) |
| ironmaw | 320 | 1.35 | 3.2 | core ×1.8 / 90 / 0.5 (`:307`) |
| duskwing | 110 | 0.8 | 9.0 | wingL/R ×1.8 / 45 ea / 0.45 (`:364`) |
| bulwark | 280 | 1.15 | 3.0 | vents ×2 / 55 / 0.6 (`:417`); front ±60° cone deflects **all** hits (`machines.js:933-939`) |
| vantage | 160 | 1.0 | 2.0 | uplink ×2 / 50 / 0.34 (`:459`) — peaceful, never fights |
| mirefang | 110 | 1.2 | 4.5 | eye ×2.2 / 35 / 0.34 (`:511`), bellyseam ×1.6 / 50 / 0.55 (`:549`) |
| monarch | 1400 | 3.2 | 2.4 | furnace ×1.5 / 220 / 0.95 (`:592`), kneeL/R ×1.8 / 70 ea / 0.55 (`:675`) |

Alpha variant (`machines.js:976-981`): +60 % hp, outgoing dmg ×1.25, double loot, 15 % seeded
roll (`ai.js:1767`; monarch excluded). Part break ⇒ stagger 1.2 s. Mechanic note: a broken
weak point stops receiving multiplier — later hits there are plain body hits
(`projectiles.js:252`). Parts lose the **full multiplied** damage (`applyHit`,
`machines.js:930-957`), which is what the TTK sim models.

### 1.3 AI attack table (`ai.js`)

| Machine | Attack | Damage | Telegraph | Cooldown / cycle | Notes |
|---|---|---|---|---|---|
| skitter | leap (`:709`,`:714`) | 12 | 0.5 s crouch | cd 3 s; cycle ≈ 4.45 s | leaps from 4–9 u, hit r 1.7 |
| bramblehorn | kick (`:810`,`:815`) | 10 | 0.4 s rear-up | cd 2.5 s | only when cornered/dist < 3; flees at 8.5 (×0.6 fuelsac-broken) |
| rendclaw | claw combo (`:775`,`:783`,`:792`) | 15 ×2 | 0.30 s windup | cd 2.2 s; cycle ≈ 3.2 s | both strikes land if dist < 2.6; neckcord-broken halves dmg |
| ironmaw | charge (`:851`,`:869`) | 30 | 0.8 s roar | cd 6 s; dash 16 u/s ≤ 1.1 s | disabled when core broken (speed −30 %, `:838`) |
| ironmaw | spark bolt (`:883`, `:1436`) | 14 | 0.6 s glow | boltCd 1.8 s; 26 m/s, r 0.9 hit sphere | only 12–30 u while charge on cd |
| duskwing | dive (`:46-49`, `:949`) | 18 | 0.85 s shadow mark | climb-lock 6 s + cd; cycle ≈ 12.6 s | marks where you stood; then grounded stagger **4 s** |
| bulwark | roll (`:52-54`) | 22 | 0.7 s quake | rollCd 7 s; 13 u/s ≤ 1.1 s | disabled when vents broken |
| bulwark | crush | 14 | 0.5 s rear-up | cd 3 s | dist < 3.4 |
| mirefang | ambush lunge (`:1113`) | 20 | submerged (nostril tell) | cd 2.5–3 s | swimmers within 14 u |
| mirefang | death-roll drag (`:1137`) | 6 / 0.45 s | — | ≤ 1.3 s ≈ +18 | while dist < 2.6 |
| monarch | stomp AOE (`:85-87`) | 35, r 4 | 0.8 s foot raise | cd 4.5 s | provokes at dist < 6 |
| monarch | tail swipe (`:88-91`) | 25 | behind > 2 s | tailCd 5 s | reach 7.5, anything not well in front |
| monarch | enrage (`:92`, `:1326-1333`) | — | roar | every 25 % hp lost | walk speed ×1.3 per step, noise r 60 |

Perception: sight 45 u / 140° FOV, close-sense 6 u, concealed-crouch ×0.35 range, wake 18 u,
leave 70 u (`ai.js:23-26`). Respawn: 90 s non-alpha / 240 s alpha; monarch+vantage never
(`ai.js:94-95`). Population: v2 layout 14 + 2 mirefang + 1 monarch, cap `maxMachines+3`
(`ai.js:72`). Boss music radius 80 u (`ai.js:93`).

### 1.4 Economy constants

Income:

| Source | Yield | Location |
|---|---|---|
| World pickups (one-time) | wood 26, shards 20, medicine 8 — 1 unit each (Scavenger ×2) | `props.js:27`, `:898` |
| Loot per kill | skitter 2sh · bramblehorn 3sh+2oil · rendclaw 4sh+1oil · ironmaw 10sh+3oil · duskwing 4sh+2oil · bulwark 7sh+3oil · vantage 6sh+2oil · mirefang 5sh+2oil · monarch 40sh+12oil+3med | `machines.js:707-716` |
| Corpse harvest (any corpse, 1.2 s hold) | +3 shards +1 oil (Scavenger ×2) | `ai.js:1525-1526` |
| Quest rewards | hunt → +1 SP · gather → +6 shards · scanVantage → +1 medicine | `quests.js:23-27` |
| Vantage first scan | map reveal + 2 SP (once per vantage) | `ai.js:1577` |
| Level-up (v3) | +1 SP | `xp.js:62` |
| XP | kills 20/30/45/80/60/70/55/500 (alpha ×1.5), pickup +5, scan +15 | `xp.js:11-23` |

Costs / sinks (`menus.js:203-237`, `state.js:72-82`):

| Craft | Cost | Output |
|---|---|---|
| Arrows | 1 wood + 2 shards | 5 (cap 40) |
| Medicine | 2 oil + 1 wood | 1 |
| Fire arrows | 2 oil + 3 shards | 5 (cap 20) |

Start inventory: 20 arrows, 8 wood, 2 medicine, 1 SP, 0 shards/oil/fire.
Quest sizing: hunt 2–4 of {skitter, bramblehorn, rendclaw, ironmaw}, gather 4–8, refill 20 s
(`quests.js:11-12, 61-67`).

---

## 2. TTK — player killing machines

Assumptions: full-power shots every 1.25 s (0.85 s draw + ~0.4 s handling; Steady Aim ≈
×0.75 on time), spear swings every 0.8 s. Strategies: **b** = body only, **w** = weak-point
until broken then body, **m** = alternating (sloppy aim). Fire columns include burn ticking
between shots plus the post-kill burn tail. Idealized aim on a moving machine; real hunts run
longer. Seconds ≈ shots × 1.25 (e.g. 13 ar ≈ 16.3 s).

| Machine | std R0 b/w/m | std HK b/w/m | fire R0 b/w/m | fire HK b/w/m | spear b/w | Alpha (std R0, weak) |
|---|---|---|---|---|---|---|
| skitter 60 | 3/2/2 | 3/**1**/1 | 2/2/2 | 2/1/1 | 3/2 | 3 ar |
| bramblehorn 80 | 4/2/3 | 3/2/2 | 3/2/2 | 3/2/2 | 4/3 | 3 ar |
| rendclaw 140 | 7/4/4 | 5/4/4 | 5/4/4 | 4/3/3 | 6/5 | 8 ar |
| ironmaw 320 | 15/13/13 | 12/10/10 | 10/9/9 | 9/8/8 | 13/11 | 21 ar |
| duskwing 110 | 5/3/4 | 4/3/3 | 4/3/3 | 3/2/3 | 5/3 | 5 ar |
| bulwark 280 | 13/11/11 | 10/9/9 | 9/8/8 | 8/7/7 | 11/10 | 19 ar |
| vantage 160 | 8/6/6 | 6/5/5 | 6/4/4 | 5/4/4 | 7/6 | 10 ar |
| mirefang 110 | 5/3/4 | 4/3/3 | 4/3/3 | 3/2/3 | 5/3 | 6 ar |
| monarch 1400 | 64/**57**/57 | 49/**43**/43 | 44/**38**/38 | 38/**33**/33 | 54/49 | 96 ar |

Read-outs:

- Weak-point play is worth 30–45 % TTK on single-WP machines (rendclaw 7→4, ironmaw 15→13)
  and is the only way through the bulwark's front (deflect cone).
- With Hunter-Killer **as coded**, a full-draw optic hit deals 71.5 ≥ skitter's 60 hp:
  the alert-calling scout dies to one arrow (F1). As documented (weak-only), it would be
  55 dmg — a 2-shot kill either way, but not an instant delete.
- Fire arrows beat standard on everything that survives ≥ ~2 s (burn adds 48 body dmg);
  they lose raw burst only on sub-2-shot kills.
- Monarch row drives F8: 57 standard arrows > quiver cap 40. Only fire builds (38/33) fit.

## 3. TTK — machines killing the player

"Standing still": eats every hit, knockback ignored (it is a 4.5 u/s velocity nudge ≈ 0.35 u
displacement — negligible). 100 hp baseline; 130 = Heartier.

| Machine | Pattern | Kills 100 hp in | Kills 130 hp in | Alpha |
|---|---|---|---|---|
| rendclaw | combo 30 / 3.2 s cycle | **9.9 s** | 13.1 s | 7.05 s |
| skitter | leap 12 / 4.45 s | 36.4 s | 47 s | 27.5 s |
| ironmaw | bolts 14 / ~3.2 s at range | 23.6 s | 31 s | — |
| ironmaw | charges 30 / ~7.7 s at 15 u | 25.0 s | 32 s | — |
| bulwark | crush 14 / 3.9 s hugged | 27.8 s | 36 s | — |
| bulwark | roll 22 / ~9.5 s at 15 u | 39.7 s | 52 s | — |
| bramblehorn | kick 10 / 3.4 s (cornered only) | 31 s | 40 s | — |
| duskwing | dive 18 / 12.6 s (stands on the mark) | 64.4 s | 84 s | 51.8 s |
| mirefang | ambush 20 + ≤18 drag / ~5.3 s | ~11 s | ~15 s | faster |
| monarch | stomps 35 / ~5.3 s inside r 4 | **11.4 s** | 16.7 s | — |
| monarch | tail 25 / ~7 s loitering behind | 23 s | 30 s | — |

Active-defense reality check:

- **Dodge i-frames are absolute** (`player.js:218`): any hit inside the 0.38 s roll is null,
  including bolts, dives and stomps. Sustain: base one dodge every ~2.19 s (25 ÷ 18 regen +
  0.8 delay), Second Wind ~1.49 s; burst of 4 from full. Against rendclaw's 3.2 s combo
  cycle a competent player can dodge every combo indefinitely — melee threats pressure only
  while the player is shooting/crafting/fleeing through bad terrain.
- Sprint (10.5) outruns every chaser: catch-up +3 u/s on rendclaw, +2 u/s on bramblehorn;
  sprint budget 8.3 s from full stamina. Only bramblehorn (8.5) and duskwing (9.0, aerial)
  close on a walking player (6.0).
- Verdict: standing-still numbers above are worst-case training-dummy values; real deaths
  come from ambushes (mirefang), pinning terrain, and fighting while hurt. Rendclaw and
  monarch stomp are the only sub-12 s threats and both are fully dodge-readable.

## 4. Economy loops

### 4.1 Arrows per hunt (kill + harvest, shards → crafts of 5)

| Prey | Shards in | → Arrows | Arrows spent (weak-first R0) | Net |
|---|---|---|---|---|
| skitter | 2+3=5 | 10 | 2 | +8 |
| bramblehorn | 3+3=6 | 10 | 2 | +8 (+2 oil spare) |
| rendclaw | 4+3=7 | 15 | 4 | +11 |
| ironmaw | 10+3=13 | 30 | 13 | +17 (+3 oil) |
| duskwing | 4+3=7 | 15 | 3 | +12 |
| bulwark | 7+3=10 | 20 | 11 | +9 |
| mirefang | 5+3=8 | 15 | 3 | +12 |
| monarch | 40+3=43 | 40 (cap) | 57 | **−17 and capped** |

Every hunt is arrow-positive except the monarch, which is impossible on standard ammo (F8).
Stuck-arrow walk-over refunds push nets further positive for missed shots.

### 4.2 Wood ledger — the hard ceiling (F5)

Wood enters the inventory exactly two ways: 8 at start + 26 world pickups (`props.js:27`).
Nothing else grants wood — not loot tables, not harvest (`ai.js:1525-1526`), not quests
(`quests.js:23-27`), and pickups never respawn. Total wood ever = **34**:

- All-arrows split: 34 crafts × 5 = 170 arrows maximum ever craftable.
- Each medicine also eats 1 wood, so medicine and ammo directly compete for the same 34.
- Machines respawn every 90 s (240 alpha) — shards/oil income is infinite, wood is not.
  After ~30–60 minutes the crafting economy silently dead-ends.

### 4.3 Medicine sustainability

Heal 45/use. Typical hunt damage taken 30–60 ⇒ ~1 medicine per 1–2 hunts. Oil income is
healthy (bramblehorn 2, harvest 1, ironmaw/bulwark 3 per kill), so oil never binds; **wood**
does (34 medicines max ever, competing with arrows). The scanVantage contract (+1 medicine,
re-roll every refill at 15 %) is the only renewable medicine line (F12).

### 4.4 Shard faucets vs sinks

Per 90 s respawn wave (14 machines ≈ 3 skitter + 3 bramble + 2 rendclaw + 1 ironmaw +
2 duskwing + 2 bulwark + 1 vantage + 2 mirefang): loot ≈ 68 shards + 24 oil, harvest ≈
+33 shards +11 oil ⇒ ~101 shards/wave ≈ 250 arrows of shard value — far beyond need. The
binding constraints are wood (F5) and the quiver cap, not shards. Ironmaw alone refunds 30
arrows per kill for a kite-fight whose teeth (charge) can be surgically removed with two
core hits (F7).

### 4.5 Fire-arrow cost-effectiveness

Fire ×5 costs 2 oil + 3 shards vs standard 2 shards — a fair-looking premium, but burn value
does not scale with draw (F4): a threshold-tap fire arrow (draw 0.15, 0.13 s to reach) lands
9.3 impact + 48 burn = **57.3 effective**, i.e. 87 % of a full-power fire arrow for 15 % of
the draw time. Tap-spamming fire arrows is the dominant ranged strategy once oiled; the
simmed fire-R0 column above actually *understates* this (it assumes full draws).

## 5. XP curve sanity (`xp.js:29`: next = round(100 × level^1.35))

| Level | Need | Cumulative | Kills to clear (rendclaw 45 / ironmaw 80) |
|---|---|---|---|
| 1→2 | 100 | 100 | 3 / 2 |
| 2→3 | 255 | 355 | 8 / 5 |
| 3→4 | 441 | 796 | 18 / 10 |
| 4→5 | 650 | 1446 | 33 / 19 |
| 5→6 | 878 | 2324 | 52 / 30 |
| 6→7 | 1123 | 3447 | 77 / 44 |

- L2 in 2–5 kills: immediate reward feedback. L5 ≈ 1446 xp ≈ 20 typical kills + gathering
  (pickups are 5 apiece; clearing all 26 wood pickups alone is 130 xp). Good session arc.
- Alpha ×1.5 and scan/pickup trickle smooth the curve; monarch 500 ≈ ¾ of the L4→5 band —
  a fitting capstone.
- Skill-point inflation: start 1 + vantage 2 + hunt contracts (+1, unlimited refills) +
  levels means all six skills are bought within roughly a dozen contracts. Acceptable for a
  session-scale game; noted so nobody calls it a bug later.

## 6. Findings (detail)

- **F1 — hunterKiller scope.** `bow.js:181` applies ×1.3 to every arrow; `menus.js:16`
  advertises "+30% weak-point damage". Consequences: skitter one-shot through the optic
  (71.5 ≥ 60); bramblehorn 2-shot via sac; +30 % on chip-damage body spam too. The damage
  is computed at release, before the hit location exists, so the code cannot honor the
  description without moving the multiplier into the hit resolver.
- **F2 — deflected fire still burns.** `resolveHit` calls `machine.hit(...)` then ignites if
  alive (`projectiles.js:228-229`); the bulwark deflect path returns early having applied
  zero damage (`machines.js:933-939`) but leaves it alive ⇒ face-shots ignite. Six face-taps
  ≈ 280 burn dmg: the flank-me puzzle dissolves. Same defect makes part armor (none today)
  and any future "immune" state combustible.
- **F3 — panic flag unread.** `status.js:103-104` sets `m.panic/m.panicT` "consumed by
  machines/ai.js"; ai.js contains zero reads (grep verified). Burning machines fight
  unimpeded; the v2 doc's flee-briefly behavior never happens.
- **F4 — burn ignores draw power.** `applyBurn(machine, BURN_DURATION)` fixed 4 s regardless
  of `power`. See §4.5 for the exploit math.
- **F5 — wood non-renewable.** See §4.2. Highest-impact economy fix available.
- **F6 — rendclaw underpays.** Deadliest common ground AI (sub-10 s dummy kill, outruns
  walking players) drops 4sh+1oil; the flighty bramblehorn drops 3sh+2oil and harvest
  flattens the rest to 3sh+1oil for everything. Risk/reward inverted within the predator tier.
- **F7 — flat contract rewards.** "Hunt 2× Ironmaw" and "Hunt 4× Skitter" both pay +1 SP
  (`quests.js:23-27`); combined with ironmaw's 13-shard corpse the heavy tier has no
  proportional incentive.
- **F8 — monarch ammo wall.** 57 standard arrows weak-first (rank 0) vs `maxArrows: 40`
  (`state.js:78`). No resupply exists mid-fight (loot only drops on death; crafting needs an
  open menu which pauses the game). Only fire builds fit the quiver (38/33). Any rank-0 or
  non-fire build literally cannot finish the boss.
- **F9 — duskwing self-stun.** `DUSKWING_STUN = 4` (`ai.js:47`) grounds it beside the player
  with `staggerTimer` (no actions, no movement) every ~12.6 s cycle; three aimed shots fit
  easily in the window (≈ 66–120 dmg of its 110 hp). Generous to the point of scripted.
- **F10 — spear/optic near-miss.** `DMG_WEAK = 39` (`spear.js:20`) vs skitter optic 40 hp:
  leaves the part at 1 hp, breaking on the second swing instead of the first. One-point fix.
  Consistency positive: the bulwark front cone deflects spear hits too (position-based check
  in `applyHit`), so melee respects armor identity — keep that when tuning.
- **F11 — vantage murder.** Only one spawns and it never respawns; killing it trades map
  reveal + 2 SP + renewable scan-contract medicine for ~11 shards + 3 oil equivalent.
  Legitimate choice, but the UI never warns what is being forfeited.
- **F12 — vantage re-scan farm.** `updateScans` re-emits `machineScanned` every 30 s while
  aimed (`ai.js:57`, `:1604`); each emission completes any live scanVantage contract and
  grants +15 XP. Parking at the vantage prints medicine and XP at contract-refill cadence.

## 7. Recommended constant diffs

All suggestions preserve exports/signatures; owners apply. "Priority" = suggested order.

| Pri | File:Line | Old | New | Fixes |
|---|---|---|---|---|
| 1 | `src/world/props.js:27` | `wood: 26` | `wood: 26` **plus** add wood to harvest (row below) — or make world pickups respawn | F5 |
| 1 | `src/machines/ai.js:1525-1526` | `const shards = 3 * mult;` / `const oil = 1 * mult;` | append `const wood = 1 * mult; G.inventory.wood += wood; bus.emit('pickup', { type: 'wood', amount: wood });` (+ extend notify text) | F5 — every carcass yields 1 salvage wood; restores ~1 wood/kill against ~0.2 wood/kill spend |
| 2 | `src/player/bow.js:181` | `CONFIG.arrowBaseDamage * (0.5 + 0.5 * power) * (G.skills.hunterKiller ? 1.3 : 1)` | `CONFIG.arrowBaseDamage * (0.5 + 0.5 * power)` | F1 step 1 |
| 2 | `src/combat/projectiles.js:221` | `a.damage * (wp ? wp.multiplier : 1) * (fire ? FIRE_DMG_MULT : 1)` | `a.damage * (wp ? wp.multiplier * (G.skills.hunterKiller ? 1.3 : 1) : 1) * (fire ? FIRE_DMG_MULT : 1)` | F1 step 2 — matches the skill description; `G` already imported |
| 3 | `src/combat/projectiles.js:228-229` | `machine.hit(dmg, pt, wp || null);`⏎`if (fire && machine.alive) applyBurn(machine, BURN_DURATION); // weak or body hits ignite` | `const landed = machine.hit(dmg, pt, wp || null) !== false;`⏎`if (fire && machine.alive && landed) applyBurn(machine, BURN_DURATION * (0.35 + 0.65 * (a.power ?? 1)));` | F2 + F4 together (see next two rows for the feed lines) |
| 3 | `src/machines/machines.js:933-939` (deflect block) | `return;` | `return false;` (and add `return true;` as the last line of `applyHit`) | F2 — return value is additive; no existing caller consumes it |
| 3 | `src/player/bow.js:195` | `spawnArrow({ origin, dir, speed, damage, fire: useFire });` | `spawnArrow({ origin, dir, speed, damage, fire: useFire, power });` | F4 feed |
| 3 | `src/combat/projectiles.js:338` | `export function spawnArrow({ origin, dir, speed, damage, fire = false }) {` | `export function spawnArrow({ origin, dir, speed, damage, fire = false, power = 1 }) {` (+ store `a.power = power;` near `a.fire = fire;`) | F4 feed — optional param, additive to the documented signature |
| 4 | `src/core/state.js:78` *(or)* `src/machines/machines.js:702` | `maxArrows: 40` *(or)* `monarch: { ... hp: 1400 ... }` | `maxArrows: 60` *(or)* `hp: 1000` | F8 — either alone makes the boss finishable at rank 0 (1000 hp ⇒ ~41 weak-first arrows… pair with the LOOT bump below if hp stays) |
| 4 | `src/machines/machines.js:710` | `rendclaw: [['shards', 4], ['oil', 1]],` | `rendclaw: [['shards', 6], ['oil', 1]],` | F6 |
| 5 | `src/systems/quests.js:84-85` (`completeQuest`) | `G.inventory[rw.kind] += rw.amount;` | `const amt = (q.type === 'hunt' && q.target === 'ironmaw') ? rw.amount + 1 : rw.amount; G.inventory[rw.kind] += amt;` (+ label suffix) | F7 — heavy hunts pay +1 SP |
| 5 | `src/machines/ai.js:47` | `const DUSKWING_STUN = 4;` | `const DUSKWING_STUN = 2.5;` | F9 |
| 6 | `src/player/spear.js:20` | `const DMG_WEAK = 39;` | `const DMG_WEAK = 40;` | F10 — breaks skitter optic in one swing |
| 6 | `src/machines/ai.js` (tickMachine, machines-ai owner) | — | consume `m.panicT > 0`: retreat from player while burning and not already aggro (v2 doc behavior) | F3 — coordination item; snippet intent only, owner implements |

Explicitly **not** recommended: nerfing burn DPS (fire arrows are the intended answer to F8's
ammo wall and feel great), touching dodge i-frames (they are the game's core defense verb and
every AI telegraph is tuned around being readable), or reducing ironmaw loot (the far-ring
spawn 110–190 u is gate enough).

## 8. Assumptions & caveats

- Cadence 1.25 s/arrow and perfect weak-point tracking are idealizations; treat TTK seconds
  as floors, shot counts as the robust metric.
- Player-side timelines ignore knockback displacement (~0.35 u) and assume the AI re-engages
  instantly off cooldown; both slightly favor the machine.
- Burn model: 6 dmg per 0.5 s tick, timer refreshed to 4 s on every fire-arrow hit, ticks are
  body hits (no weak multiplier), burn persists ~4 s after the final hit — matches
  `status.js`/`projectiles.js` as written.
- Alpha TTK column uses hp ×1.6 only (damageMul affects the player-side table, folded into
  the "Alpha" column of §3 where stated).
- Constants were read from a tree where v3 rows had just landed; if further parallel edits
  shift lines, the identifiers quoted in each diff row remain the source of truth.
