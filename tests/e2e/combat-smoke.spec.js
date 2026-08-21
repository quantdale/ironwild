// Combat smoke: damage in, machine dies, XP granted.
//
// Damage path used: `machine.hit(damage, point, weakPoint)` - the exact public
// entry the game's own projectile system calls on a confirmed hit
// (src/combat/projectiles.js resolveHit -> machine.hit). A scripted real-arrow
// hit would need pointer-lock aim + draw timing against roaming AI, which is
// not deterministic; everything downstream of the impact (hp, weak points,
// killMachine, loot drop, 'machineDied' XP via systems/xp.js) runs for real.
import { expect, test } from '@playwright/test';
import { startGame } from './helpers.js';

// Mirrors KILL_XP in src/systems/xp.js (only types we may encounter here).
const KILL_XP = { skitter: 20, bramblehorn: 30, rendclaw: 45 };
const ALPHA_MULT = 1.5;

test('arrow-scale hit reduces hp; lethal damage kills and grants XP', async ({ page }) => {
  await startGame(page);

  // Pick a skitter near the front of the roster (prefer a non-alpha so the XP
  // expectation is the base value).
  const target = await page.evaluate(() => {
    const list = window.__IW.G.machines;
    let idx = list.findIndex(
      (m) => m.alive && m.type === 'skitter' && !String(m.name).startsWith('Alpha'),
    );
    if (idx < 0) idx = list.findIndex((m) => m.alive && m.type === 'skitter');
    if (idx < 0) return null;
    const m = list[idx];
    return {
      idx,
      name: m.name,
      type: m.type,
      alpha: String(m.name).startsWith('Alpha'),
      hp: m.hp,
      alive: m.alive,
    };
  });
  expect(target, 'populated world must contain a skitter').not.toBeNull();
  expect(target.alive).toBe(true);

  // One arrow-scale hit (CONFIG.arrowBaseDamage = 22): hp must drop by exactly
  // that amount through the game's own applyHit path.
  const oneHit = await page.evaluate(({ idx }) => {
    const m = window.__IW.G.machines[idx];
    const before = m.hp;
    const returned = m.hit(22, m.group.position.clone(), null);
    return { before, after: m.hp, returned };
  }, { idx: target.idx });
  expect(oneHit.returned, 'non-deflecting hit returns truthy').not.toBe(false);
  expect(oneHit.after).toBeCloseTo(oneHit.before - 22, 6);

  // Lethal damage. Pin the XP pool first so no level-up carry can mask the
  // delta, then hit repeatedly until the machine's own death path fires.
  const expectedXp = Math.round(KILL_XP[target.type] * (target.alpha ? ALPHA_MULT : 1));
  const lethal = await page.evaluate(({ idx }) => {
    const G = window.__IW.G;
    G.xp.cur = 0;
    G.xp.next = 1e9; // keep the grant inside cur - no level-up wrap
    const m = G.machines[idx];
    let guard = 0;
    while (m.alive && guard++ < 60) m.hit(50, m.group.position.clone(), null);
    return { alive: m.alive, hp: m.hp, xpCur: G.xp.cur };
  }, { idx: target.idx });

  expect(lethal.alive, 'machine dead flag after lethal damage').toBe(false);
  expect(lethal.hp).toBeLessThanOrEqual(0);
  expect(lethal.xpCur, `kill grants ${expectedXp} xp`).toBe(expectedXp);

  // Dead machines stay in G.machines as harvestable carcasses (alive=false);
  // removal only happens after the carcass fade window.
  const after = await page.evaluate(({ idx }) => {
    const m = window.__IW.G.machines[idx];
    return { stillListed: window.__IW.G.machines.includes(m), alive: m.alive };
  }, { idx: target.idx });
  expect(after.stillListed).toBe(true);
  expect(after.alive).toBe(false);
});
