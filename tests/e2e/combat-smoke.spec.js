// Combat smoke: damage in, machine dies, XP granted.
//
// Damage path used: `machine.hit(damage, point, weakPoint)` - the exact public
// entry the game's own projectile system calls on a confirmed hit
// (src/combat/projectiles.js resolveHit -> machine.hit). A scripted real-arrow
// hit would need pointer-lock aim + draw timing against roaming AI, which is
// not deterministic; everything downstream of the impact (hp, weak points,
// killMachine, loot drop, 'machineDied' XP via systems/xp.js) runs for real.
import { expect, test } from '@playwright/test';
import { startGame, watchConsole } from './helpers.js';

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

// Bestiary discovery (openspec/changes/fix-bestiary-discovery): a resolved hit
// reveals the species exactly once, a kill completes the entry and reveals
// lore, and combat discovery pays none of the scan rewards (map reveal, skill
// points, scan XP).
//
// The damage path here mirrors what the game's own projectile layer does after
// machine.hit() resolves (src/combat/projectiles.js resolveHit): the hit is
// applied first, and only a landed hit (hit() !== false) is followed by the
// 'machineHit' bus event that triggers discovery. A deflected hit never emits
// the event, which is exactly why the sequence is spelled out here rather than
// assumed: machine.hit() alone emits no events at all (machines.js applyHit).
test('engaging a machine reveals its species once; a kill completes the entry', async ({ page }) => {
  const consoleLog = watchConsole(page); // attach BEFORE navigation
  await startGame(page);

  const target = await page.evaluate(() => {
    const list = window.__IW.G.machines;
    const idx = list.findIndex((m) => m.alive && m.type === 'skitter');
    if (idx < 0) return null;
    return { idx, type: list[idx].type, hp: list[idx].hp, alive: list[idx].alive };
  });
  expect(target, 'populated world must contain a skitter').not.toBeNull();
  expect(target.alive).toBe(true);

  // Pin the scan-reward state before any engagement so the discovery delta is
  // measurable even if a roaming AI acted first.
  const before = await page.evaluate(() => ({
    mapRevealed: window.__IW.G.mapRevealed,
    skillPoints: window.__IW.G.inventory.skillPoints,
    xp: window.__IW.G.xp.cur,
  }));

  // One arrow-scale hit through the real resolveHit sequence.
  const firstHit = await page.evaluate(({ idx }) => {
    const G = window.__IW.G;
    const m = G.machines[idx];
    const returned = m.hit(22, m.group.position.clone(), null);
    if (returned !== false) {
      G.bus.emit('machineHit', {
        machine: m,
        point: m.group.position.clone(),
        damage: 22,
        weak: false,
        partName: null,
      });
    }
    return {
      landed: returned !== false,
      entry: { ...G.bestiary[m.type] },
    };
  }, { idx: target.idx });
  expect(firstHit.landed, 'non-deflecting hit lands').toBe(true);
  expect(firstHit.entry, 'damaged species is revealed').toEqual({ seen: true, killed: false });

  // Discovery pays no scan rewards: no map reveal, no skill points, no scan XP.
  const after = await page.evaluate(() => ({
    mapRevealed: window.__IW.G.mapRevealed,
    skillPoints: window.__IW.G.inventory.skillPoints,
    xp: window.__IW.G.xp.cur,
  }));
  expect(after.mapRevealed, 'discovery never reveals the map').toBe(before.mapRevealed);
  expect(after.skillPoints, 'discovery never grants skill points').toBe(before.skillPoints);
  expect(after.xp, 'discovery never grants scan XP').toBe(before.xp);

  // Kill through the same path; the reveal is already spent, so only the
  // completion transition remains. Order mirrors resolveHit exactly: hit()
  // resolves first (a lethal hit emits 'machineDied' from killMachine), then
  // 'machineHit' follows for any landed hit - by then markSeen is a no-op and
  // only the completion announcement fires.
  const killed = await page.evaluate(({ idx }) => {
    const G = window.__IW.G;
    const m = G.machines[idx];
    let guard = 0;
    while (m.alive && guard++ < 60) {
      const returned = m.hit(50, m.group.position.clone(), null);
      if (returned === false) continue; // deflected: real path emits no machineHit
      G.bus.emit('machineHit', {
        machine: m,
        point: m.group.position.clone(),
        damage: 50,
        weak: false,
        partName: null,
      });
    }
    return {
      alive: m.alive,
      entry: { ...G.bestiary[m.type] },
    };
  }, { idx: target.idx });
  expect(killed.alive, 'machine dead after lethal damage').toBe(false);
  expect(killed.entry, 'kill completes the entry').toEqual({ seen: true, killed: true });

  // Zero-tolerance console check across the whole sequence.
  const { console: consoleOffenses, pageErrors } = consoleLog.offenses();
  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(consoleOffenses, 'console errors/warnings during discovery sequence').toEqual([]);
});

// The Vantage scan path (the reward-bearing 'machineScanned' event) is
// unchanged by discovery: it still reveals the species AND pays the map
// reveal + 2 skill points exactly once per Vantage.
test('Vantage scan still reveals the species and pays the map-reveal reward', async ({ page }) => {
  const consoleLog = watchConsole(page); // attach BEFORE navigation
  await startGame(page);

  const vantage = await page.evaluate(() => {
    const list = window.__IW.G.machines;
    const idx = list.findIndex((m) => m.alive && m.type === 'vantage');
    if (idx < 0) return null;
    return { idx, type: list[idx].type };
  });
  expect(vantage, 'populated world must contain a vantage').not.toBeNull();

  // ai.js's own 'machineScanned' subscriber grants the reward when a Vantage
  // is scanned (type-checked and once per machine), exactly as focus.js drives
  // it. Drive that event directly - it is the game's own scan contract.
  const scanned = await page.evaluate(({ idx }) => {
    const G = window.__IW.G;
    const m = G.machines[idx];
    const before = {
      mapRevealed: G.mapRevealed,
      skillPoints: G.inventory.skillPoints,
    };
    G.bus.emit('machineScanned', { machine: m });
    return {
      before,
      after: {
        mapRevealed: G.mapRevealed,
        skillPoints: G.inventory.skillPoints,
      },
      entry: { ...G.bestiary[m.type] },
    };
  }, { idx: vantage.idx });

  expect(scanned.entry, 'scan reveals without killing').toEqual({ seen: true, killed: false });
  expect(scanned.after.mapRevealed, 'scan reveals the map').toBe(true);
  expect(scanned.after.skillPoints, 'scan pays +2 skill points')
    .toBe(scanned.before.skillPoints + 2);

  // A second scan of the same machine pays nothing again (once per Vantage).
  const rescan = await page.evaluate(({ idx }) => {
    const G = window.__IW.G;
    const m = G.machines[idx];
    const before = G.inventory.skillPoints;
    G.bus.emit('machineScanned', { machine: m });
    return { before, after: G.inventory.skillPoints };
  }, { idx: vantage.idx });
  expect(rescan.after, 'no double reward on re-scan').toBe(rescan.before);

  const { console: consoleOffenses, pageErrors } = consoleLog.offenses();
  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(consoleOffenses, 'console errors/warnings during scan sequence').toEqual([]);
});
