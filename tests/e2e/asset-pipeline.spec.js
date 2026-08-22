// Authored-asset pipeline E2E: the repository-generated certification GLB
// ('wayshrine') must load through AssetManager in the PRODUCTION build -
// network fetch, glTF decode, convention resolution (socket_*/wp_*/clips),
// LOD pruning, scene placement, and telemetry counting. This is the first
// spec that exercises the real GLTFLoader path (unit tests use the DI seam).
import { expect, test } from "@playwright/test";
import { gotoGame, startGame, SWGL_POLL_MS, SWGL_SPEC_MS } from "./helpers.js";

test("hunter authored rig replaces the procedural body and keeps weapons bound", async ({
  page,
}) => {
  test.setTimeout(SWGL_SPEC_MS);
  await gotoGame(page);
  await startGame(page);

  // Authored swap completes asynchronously after boot.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const G = window.__IW.G;
          let found = null;
          G.player.group.traverse((o) => {
            if (!found && o.userData && o.userData.assetId === "hunter") {
              found = o;
            }
          });
          return !!found;
        }),
      { timeout: SWGL_POLL_MS },
    )
    .toBe(true);

  // Pose groups rebound onto the authored rig (same names/pivots) and the
  // weapon anchors resolve - the bow must have re-attached to authored handL.
  const probe = await page.evaluate(() => {
    const g = window.__IW.G.player.group;
    return {
      legL: !!g.getObjectByName("legL"),
      handL: !!g.getObjectByName("handL"),
      handR: !!g.getObjectByName("handR"),
      sockets: ["socket_hand_l", "socket_hand_r", "socket_back", "socket_hips"].filter(
        (n) => !!g.getObjectByName(n),
      ),
      torsoTwisting: (() => {
        const t = g.getObjectByName("torso");
        return t ? typeof t.rotation.x === "number" : false;
      })(),
    };
  });
  expect(probe.legL).toBe(true);
  expect(probe.handL).toBe(true);
  expect(probe.handR).toBe(true);
  expect(probe.sockets).toHaveLength(4);
  expect(probe.torsoTwisting).toBe(true);

  // Gameplay must remain live after the visual swap.
  expect(await page.evaluate(() => window.__IW.G.paused)).toBe(false);
});

test("skitter machines upgrade to the authored animator", async ({ page }) => {
  test.setTimeout(SWGL_SPEC_MS);
  await gotoGame(page);
  await startGame(page);

  // EVERY authored machine type (skitter/ironmaw/duskwing) must flip its
  // animator to authored mode once its GLB resolves; procedural visuals stay
  // retired. Machines of a type with no authored GLB keep procedural mode -
  // today that set is empty except non-rigged vantage/monarch records.
  const probe = await page.evaluate(() => {
    const G = window.__IW.G;
    const AUTHORED = new Set(["skitter", "ironmaw", "duskwing"]);
    const per = {};
    let mismatched = 0;
    for (const m of G.machines) {
      if (!m.alive || !m.animator) continue;
      if (!AUTHORED.has(m.type)) continue;
      per[m.type] = per[m.type] || { n: 0, authored: 0 };
      per[m.type].n++;
      if (m.animator.mode === "authored") {
        per[m.type].authored++;
      } else {
        mismatched++;
      }
    }
    return { per, mismatched };
  });

  expect(Object.keys(probe.per).length).toBe(3);
  expect(probe.mismatched).toBe(0);

  // The world must still be simulating (no pause/regression from the swaps).
  expect(await page.evaluate(() => window.__IW.G.paused)).toBe(false);
});


test("certification asset loads through the real pipeline", async ({ page }) => {
  test.setTimeout(SWGL_SPEC_MS);
  await gotoGame(page);
  await startGame(page);

  // Telemetry publisher appears once landmarks module boots.
  await expect
    .poll(
      async () =>
        page.evaluate(() => !!window.__IW_PERF_ASSETS && window.__IW_PERF_ASSETS()),
      { timeout: SWGL_POLL_MS },
    )
    .not.toBeNull();

  // The wayshrine decoded + cached through the real loaders.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__IW_PERF_ASSETS ? window.__IW_PERF_ASSETS() : null;
        return s ? s.cached : 0;
      }),
    )
    .toBeGreaterThanOrEqual(1);

  // Convention resolution on the live clone: sockets, weak point, clip map,
  // and single-LOD pruning all ride into the game via userData.
  const probe = await page.evaluate(() => {
    const G = window.__IW.G;
    let found = null;
    G.scene.traverse((o) => {
      if (!found && o.userData && o.userData.assetId === "wayshrine") found = o;
    });
    if (!found) return null;
    return {
      lod: found.userData.lod,
      sockets: Object.keys(found.userData.sockets || {}),
      weakPoints: (found.userData.weakPoints || []).map((w) => w.name),
      clips: Object.keys(found.userData.clips || {}),
      inScene: !!found.parent,
    };
  });
  expect(probe, "wayshrine clone must exist in the scene").not.toBeNull();
  expect(probe.lod).toBe(0); // instantiate({lod:0}) prunes to exactly one level
  expect(probe.sockets).toContain("socket_brazier");
  expect(probe.weakPoints).toContain("wp_core");
  expect(probe.clips).toContain("act_spin");
  expect(probe.inScene).toBe(true);

  // KTX2 delivery proof: the material's base color must be a REAL texture
  // object decoded by KTX2Loader from the embedded container (not just the
  // baseColorFactor fallback).
  const tex = await page.evaluate(() => {
    const G = window.__IW.G;
    let root = null;
    G.scene.traverse((o) => {
      if (!root && o.userData && o.userData.assetId === "wayshrine") root = o;
    });
    if (!root) return null;
    let mapInfo = null;
    root.traverse((o) => {
      if (!mapInfo && o.isMesh && o.material && o.material.map) {
        const t = o.material.map;
        // Class via three's boolean flags - constructor.name is mangled in
        // production bundles.
        const kind = t.isCompressedTexture
          ? "compressed"
          : t.isDataTexture
            ? "data"
            : "other";
        mapInfo = { kind, size: [t.image?.width, t.image?.height] };
      }
    });
    return mapInfo;
  });
  expect(tex, "KTX2 base-color texture must be bound").not.toBeNull();
  expect(tex.kind).toBe("data"); // uncompressed KTX2 -> DataTexture path
  expect(tex.size[0]).toBe(64);

  // Perf report exposes the same stats (F3 HUD data source).
  const reportAssets = await page.evaluate(
    () => window.__IW.perf.getReport().assets,
  );
  expect(reportAssets).toBeTruthy();
  expect(reportAssets.cached).toBeGreaterThanOrEqual(1);
});
