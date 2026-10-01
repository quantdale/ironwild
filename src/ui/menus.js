// IRONWILD - full-screen UI: start screen, pause, inventory + crafting,
// skill tree, death screen. Owns the pointer-lock lifecycle: any open panel
// sets G.paused=true and unlocks the pointer; closing relocks it.
// v2: Continue button (systems/save.js), fire-arrow crafting, and gear buttons
// that open the settings modal (ui/settings.js).

import { bus } from "../core/events.js";
import { G } from "../core/state.js";
import { Input } from "../core/input.js";
import * as save from "../systems/save.js";
import * as settings from "./settings.js";
import { SPECIES, speciesName, speciesLore } from "../systems/bestiary.js";
import { renderExpandedMap, updateExpandedMap } from "./minimap.js";

const SKILLS = [
  { id: "heartier", name: "Heartier Frame", desc: "+30 max health" },
  { id: "steadyAim", name: "Steady Aim", desc: "Faster draw, steadier aim" },
  { id: "hunterKiller", name: "Hunter-Killer", desc: "+30% weak-point damage" },
  { id: "scavenger", name: "Scavenger", desc: "Double resource pickups" },
  { id: "secondWind", name: "Second Wind", desc: "Dodge costs half stamina" },
  { id: "deepFocus", name: "Deep Focus", desc: "+50% focus duration" },
];

const CONTROLS = [
  ["WASD", "Move"],
  ["MOUSE", "Look"],
  ["HOLD LMB", "Draw bow / loose arrow"],
  ["RMB", "Aim"],
  ["SHIFT", "Sprint"],
  ["SPACE", "Jump"],
  ["CTRL", "Dodge"],
  ["C", "Crouch toggle"],
  ["X", "Arrow type"],
  ["E", "Interact"],
  ["H", "Use medicine"],
  ["HOLD Q", "Focus scan"],
  ["P", "Quicksave"],
  ["I", "Inventory"],
  ["TAB", "Skills"],
  ["B", "Bestiary"],
  ["M", "World map"],
  ["ESC", "Pause"],
];

let created = false;
let els = null;
let activePanel = null; // null | 'pause' | 'inventory' | 'skills' | 'bestiary' | 'map' | 'death'
let graceUntil = 0; // pause auto-trigger suppressed until relock settles
let deathHandled = false;

export function createMenus() {
  if (created) return;
  created = true;
  injectStyles();
  buildDom();

  // Start on first click anywhere on the start screen.
  els.start.addEventListener("click", startGame);

  els.resumeBtn.addEventListener("click", resume);
  els.quitBtn.addEventListener("click", () => location.reload());
  els.restartBtn.addEventListener("click", () => location.reload());
  els.craftArrows.addEventListener("click", craftArrows);
  els.craftMed.addEventListener("click", craftMedicine);
  els.craftFire.addEventListener("click", craftFireArrows);
  els.craftArmor.addEventListener("click", craftArmor);
  // Gear buttons open the settings modal; stopPropagation keeps the start
  // screen's click-anywhere-to-begin from also firing.
  const openSettings = (e) => {
    e.stopPropagation();
    if (typeof settings.openSettings === "function") settings.openSettings();
  };
  els.gearStart.addEventListener("click", openSettings);
  els.gearPause.addEventListener("click", openSettings);
  if (els.continueBtn) els.continueBtn.addEventListener("click", continueGame);
  if (els.newRunBtn) els.newRunBtn.addEventListener("click", newRun);
  for (const def of SKILLS) {
    els.skillCards[def.id].addEventListener("click", () => buySkill(def));
  }

  // Never let Tab move browser focus.
  window.addEventListener("keydown", (e) => {
    if (e.code === "Tab") e.preventDefault();
  });

  // Single lock-change slot (per Input contract) - menus own it.
  Input.onLockChange(onLockChange);

  // A rejected relock fires pointerlockerror during Chromium's ~1s post-Esc
  // cooldown; stretch the grace so the fallback auto-pause doesn't flash the
  // pause screen back while the retry settles.
  document.addEventListener("pointerlockerror", () => {
    if (G.started && !G.gameOver) {
      graceUntil = Math.max(graceUntil, performance.now() + 1500);
    }
  });

  bus.on("playerDied", onPlayerDied);
}

export function updateMenus(dt = 1 / 60) {
  if (!created || !G.started || G.gameOver) return;
  // Settings modal is up: it owns the keyboard (Escape closes itself via a
  // capture-phase handler); don't toggle panels or auto-pause beneath it.
  if (typeof settings.isOpen === "function" && settings.isOpen()) return;

  if (Input.pressed("KeyI")) {
    if (activePanel === "inventory") closePanel();
    else if (activePanel === null) openPanel("inventory");
  }
  if (Input.pressed("Tab")) {
    if (activePanel === "skills") closePanel();
    else if (activePanel === null) openPanel("skills");
  }
  if (Input.pressed("KeyB")) {
    if (activePanel === "bestiary") closePanel();
    else if (activePanel === null) openPanel("bestiary");
  }
  if (Input.wasActionPressed("map") && !Input.isActionShared("map")) {
    if (activePanel === "map") closePanel();
    else if (activePanel === null) openPanel("map");
  }
  if (Input.pressed("Escape")) {
    if (
      activePanel === "inventory" ||
      activePanel === "skills" ||
      activePanel === "bestiary" ||
      activePanel === "map"
    )
      closePanel();
    else if (activePanel === "pause") resume();
    // An Escape that REACHES the page always means "pause". While genuinely
    // locked the browser consumes Esc itself (exit lock -> onLockChange ->
    // showPause), so this branch only sees keys from the unlocked states:
    // lockBroken fallback, a transient denied-relock window, or environments
    // where lock never engaged. Gating on lockBroken left those windows dead
    // - Esc did nothing until the grace auto-pause fired.
    else showPause();
  }

  if (activePanel === "map") updateExpandedMap(els.mapCanvas, dt);

  // Fallback: pointer lost without a lock-change callback (missed event,
  // OS-level focus steal). Only after the relock grace window has passed;
  // skipped once Input.lockBroken falls back to free-cursor look.
  if (
    !Input.locked &&
    !Input.lockBroken &&
    activePanel === null &&
    performance.now() > graceUntil
  ) {
    showPause();
  }
}

// ---------------------------------------------------------------- flow

function getCanvas() {
  return (
    document.querySelector("#app canvas") ||
    document.querySelector("canvas") ||
    document.body
  );
}

function startGame() {
  if (G.started) return;
  beginGame();
}

/** Shared start flow: dismiss the start screen and take pointer lock. */
function beginGame() {
  G.started = true;
  els.start.classList.add("hidden");
  graceUntil = performance.now() + 1500;
  Input.lockPointer(getCanvas());
  bus.emit("ui", { action: "start" });
}

/** Continue button: restore the save first, then proceed exactly like a fresh start. */
function continueGame(e) {
  e.stopPropagation();
  if (G.started) return;
  try {
    if (typeof save.loadGame === "function") save.loadGame();
  } catch (err) {
    console.error("[menus] save.loadGame failed:", err);
  }
  beginGame();
}

/** New Run button: confirm, wipe the save slot, reload into a fresh boot. */
function newRun(e) {
  e.stopPropagation(); // the start screen's click-anywhere-to-begin must not fire
  if (!confirm("Delete saved run and start fresh?")) return;
  try {
    if (typeof save.clearSave === "function") save.clearSave();
  } catch (err) {
    console.error("[menus] save.clearSave failed:", err);
  }
  location.reload();
}

function onLockChange(locked) {
  if (!created) return;
  if (locked) {
    graceUntil = 0;
    if (activePanel === "pause") hidePause();
  } else if (G.started && !G.gameOver && activePanel === null) {
    showPause();
  }
}

function showPause() {
  if (activePanel !== null || !G.started || G.gameOver) return;
  activePanel = "pause";
  G.paused = true;
  // Release the pointer like every other panel: when Escape REACHES the page
  // (headless browsers, some Linux WMs / kiosk modes) the lock is still
  // engaged - without this the cursor stays captured and the pause UI cannot
  // be clicked at all. No-op where the browser already exited the lock.
  Input.unlockPointer();
  els.pause.classList.remove("hidden");
  bus.emit("ui", { action: "pause" });
}

function hidePause() {
  if (activePanel !== "pause") return;
  els.pause.classList.add("hidden");
  activePanel = null;
  G.paused = false;
}

function resume() {
  if (activePanel !== "pause") return;
  hidePause();
  graceUntil = performance.now() + 1500;
  Input.lockPointer(getCanvas());
  bus.emit("ui", { action: "resume" });
}

function openPanel(name) {
  if (activePanel !== null) return;
  activePanel = name; // set BEFORE unlocking so onLockChange sees it
  G.paused = true;
  els[name].classList.remove("hidden");
  if (name === "inventory") refreshInventory();
  else if (name === "skills") refreshSkills();
  else if (name === "bestiary") refreshBestiary();
  else if (name === "map") {
    renderExpandedMap(els.mapCanvas);
    els.mapStatus.textContent = G.mapRevealed
      ? "FRONTIER SURVEY COMPLETE"
      : "FOCUS-SCAN A VANTAGE TO REVEAL THE FRONTIER";
  }
  Input.unlockPointer();
  bus.emit("ui", { action: "open" });
}

function closePanel() {
  if (
    activePanel !== "inventory" &&
    activePanel !== "skills" &&
    activePanel !== "bestiary" &&
    activePanel !== "map"
  )
    return;
  const name = activePanel;
  els[name].classList.add("hidden");
  activePanel = null;
  G.paused = false;
  graceUntil = performance.now() + 1500;
  Input.lockPointer(getCanvas());
  bus.emit("ui", { action: "close" });
}

function onPlayerDied() {
  if (deathHandled) return;
  deathHandled = true;
  G.gameOver = true;
  if (activePanel && activePanel !== "death") {
    els[activePanel].classList.add("hidden");
  }
  activePanel = "death";
  G.paused = true;
  Input.unlockPointer();
  setTimeout(() => els.death.classList.add("show"), 650);
}

// ---------------------------------------------------------------- crafting

function craftArrows() {
  const inv = G.inventory;
  if (inv.wood < 1 || inv.shards < 2 || inv.arrows + 5 > inv.maxArrows) return;
  inv.wood -= 1;
  inv.shards -= 2;
  inv.arrows += 5;
  bus.emit("craft", { item: "arrows" });
  bus.emit("notify", { text: "Crafted 5 arrows", tone: "good" });
  bus.emit("ui", { action: "click" });
  refreshInventory();
}

function craftMedicine() {
  const inv = G.inventory;
  if (inv.oil < 2 || inv.wood < 1) return;
  inv.oil -= 2;
  inv.wood -= 1;
  inv.medicine += 1;
  bus.emit("craft", { item: "medicine" });
  bus.emit("notify", { text: "Crafted medicine", tone: "good" });
  bus.emit("ui", { action: "click" });
  refreshInventory();
}

function craftFireArrows() {
  const inv = G.inventory;
  if (inv.oil < 2 || inv.shards < 3 || inv.fireArrows + 5 > inv.maxFireArrows)
    return;
  inv.oil -= 2;
  inv.shards -= 3;
  inv.fireArrows += 5;
  bus.emit("craft", { item: "fireArrows" });
  bus.emit("notify", { text: "Crafted 5 fire arrows", tone: "good" });
  bus.emit("ui", { action: "click" });
  refreshInventory();
}

// v4: hide-armor tiers - a one-time upgrade per rank rather than a stackable
// craft (mirrors buySkill's rank gating), costing hide + shards. See
// player.js ARMOR_REDUCTION for the resulting damage cut (12% / 22%).
const ARMOR_COST = [null, { hide: 4, shards: 3 }, { hide: 6, shards: 6 }];

function armorAffordable() {
  const inv = G.inventory;
  const next = inv.armor + 1;
  const cost = ARMOR_COST[next];
  return cost ? inv.hide >= cost.hide && inv.shards >= cost.shards : false;
}

function craftArmor() {
  const inv = G.inventory;
  const next = inv.armor + 1;
  const cost = ARMOR_COST[next];
  if (!cost || !armorAffordable()) return;
  inv.hide -= cost.hide;
  inv.shards -= cost.shards;
  inv.armor = next;
  bus.emit("craft", { item: "armor" });
  bus.emit("notify", {
    text: `Hide armor upgraded — rank ${next}`,
    tone: "good",
  });
  bus.emit("ui", { action: "click" });
  refreshInventory();
}

function refreshInventory() {
  const inv = G.inventory;
  for (const key of [
    "shards",
    "wood",
    "oil",
    "medicine",
    "arrows",
    "fireArrows",
    "hide",
  ]) {
    els.resCounts[key].textContent = String(inv[key]);
  }
  els.spCount.textContent = String(inv.skillPoints);
  els.craftArrows.disabled = !(
    inv.wood >= 1 &&
    inv.shards >= 2 &&
    inv.arrows + 5 <= inv.maxArrows
  );
  els.craftMed.disabled = !(inv.oil >= 2 && inv.wood >= 1);
  els.craftFire.disabled = !(
    inv.oil >= 2 &&
    inv.shards >= 3 &&
    inv.fireArrows + 5 <= inv.maxFireArrows
  );

  const next = inv.armor + 1;
  const cost = ARMOR_COST[next];
  if (!cost) {
    els.armorName.textContent = "Hide Armor — rank 2 (max)";
    els.armorCost.textContent = "—";
    els.craftArmor.textContent = "MAXED";
    els.craftArmor.disabled = true;
  } else {
    els.armorName.textContent = `Hide Armor — rank ${inv.armor} → ${next}`;
    els.armorCost.textContent = `${cost.hide} hide • ${cost.shards} shards`;
    els.craftArmor.textContent = "UPGRADE";
    els.craftArmor.disabled = !armorAffordable();
  }
}

// ---------------------------------------------------------------- skills

function buySkill(def) {
  if (G.skills[def.id] > 0) return;
  if (G.inventory.skillPoints < 1) {
    bus.emit("notify", { text: "Not enough skill points", tone: "bad" });
    return;
  }
  G.inventory.skillPoints -= 1;
  G.skills[def.id] = 1;
  bus.emit("skillUp", { id: def.id });
  bus.emit("notify", { text: `Skill acquired — ${def.name}`, tone: "good" });
  bus.emit("ui", { action: "click" });
  refreshSkills();
}

function refreshSkills() {
  for (const def of SKILLS) {
    const card = els.skillCards[def.id];
    const owned = G.skills[def.id] > 0;
    card.classList.toggle("owned", owned);
    card.classList.toggle("available", !owned && G.inventory.skillPoints >= 1);
    els.skillState[def.id].textContent = owned ? "RANK 1" : "COST 1 PT";
  }
  els.spCount2.textContent = String(G.inventory.skillPoints);
}

// ---------------------------------------------------------------- bestiary

function refreshBestiary() {
  let discovered = 0;
  for (const type of SPECIES) {
    const e = G.bestiary[type] || { seen: false, killed: false };
    const card = els.bestiaryCards[type];
    card.classList.toggle("seen", e.seen);
    card.classList.toggle("killed", e.killed);
    if (e.killed) discovered++;
    els.bestiaryName[type].textContent = e.seen ? speciesName(type) : "???";
    els.bestiaryLore[type].textContent = e.killed
      ? speciesLore(type)
      : e.seen
        ? "Not yet defeated."
        : "Undiscovered.";
  }
  els.bestiaryCount.textContent = `${discovered} / ${SPECIES.length}`;
}

// ---------------------------------------------------------------- dom build

/** True when systems/save.js reports an existing save slot (defensive). */
function saveAvailable() {
  if (typeof save.hasSave !== "function") return false;
  try {
    return !!save.hasSave();
  } catch (err) {
    return false;
  }
}

/** Small settings gear button pinned bottom-right of a full-screen panel. */
function appendGear(parent) {
  const gear = document.createElement("button");
  gear.className = "iw-gear";
  gear.title = "Settings";
  gear.setAttribute("aria-label", "Settings");
  gear.textContent = "\u2699\uFE0E"; // gear glyph, forced text presentation
  parent.appendChild(gear);
  return gear;
}

/**
 * Static-template HTML install for menu screens. Every template below
 * interpolates build-time constants ONLY (no user/network data), but routing
 * through DOMParser keeps raw innerHTML assignments out of the codebase:
 * the parser adopts nodes safely and never executes scripts.
 */
function setPanelHtml(el, html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  el.replaceChildren(...doc.body.childNodes);
}

function buildDom() {
  els = { skillCards: {}, skillState: {}, resCounts: {} };

  // START
  const start = document.createElement("div");
  start.className = "iw-screen";
  start.id = "iw-start";
  const canContinue = saveAvailable();
  setPanelHtml(
    start,
    `
    <div class="iw-title-shell">
      <div class="iw-title-topline">
        <span>FRONTIER PROGRAM // VALLEY 07</span>
        <span class="iw-live"><i></i> LIVE WORLD</span>
      </div>
      <div class="iw-title-hero">
        <div class="iw-title-kicker">A MACHINE-HUNTING EXPEDITION</div>
        <div class="iw-title">IRONWILD</div>
        <div class="iw-tagline">The machines remember.</div>
        <div class="iw-title-rule"><span></span></div>
        <p class="iw-title-copy">Cross the reclaimed frontier. Read the machines. Take back what the wild buried.</p>
      </div>
      <div class="iw-title-lower">
        <div class="iw-controls-panel">
          <div class="iw-section-label">FIELD MANUAL <span>TACTICAL CONTROLS</span></div>
          <div class="iw-controls">${CONTROLS.map(
            ([k, a]) =>
              `<div class="iw-control"><span class="iw-ck">${k}</span><span class="iw-ca">${a}</span></div>`,
          ).join("")}
          </div>
        </div>
        <div class="iw-launch-panel">
          <div class="iw-launch-status"><span></span> EXPEDITION READY</div>
          ${canContinue ? '<button class="iw-btn iw-primary" id="iw-continue">CONTINUE RUN</button>' : ""}
          ${canContinue ? '<button class="iw-btn iw-secondary" id="iw-newrun">NEW EXPEDITION</button>' : ""}
          <div class="iw-clickbegin">${canContinue ? "OR CLICK TO BEGIN A NEW RUN" : "CLICK TO BEGIN"}</div>
          <div class="iw-launch-note">NO PATH IS SAFE TWICE</div>
        </div>
      </div>
      <div class="iw-title-footer"><span>IRONWILD // SYSTEMS ONLINE</span><span>BUILD 0.1 // SURVIVE · HUNT · REMEMBER</span></div>
    </div>`,
  );
  document.body.appendChild(start);
  els.start = start;
  els.continueBtn = start.querySelector("#iw-continue");
  els.newRunBtn = start.querySelector("#iw-newrun");
  els.gearStart = appendGear(start);

  // PAUSE
  const pause = document.createElement("div");
  pause.className = "iw-screen hidden";
  setPanelHtml(
    pause,
    `
    <div class="iw-panel">
      <div class="iw-panel-title">PAUSED</div>
      <button class="iw-btn" id="iw-resume">RESUME</button>
      <button class="iw-btn" id="iw-quit">QUIT</button>
    </div>`,
  );
  document.body.appendChild(pause);
  els.pause = pause;
  els.resumeBtn = pause.querySelector("#iw-resume");
  els.quitBtn = pause.querySelector("#iw-quit");
  els.gearPause = appendGear(pause);

  // INVENTORY
  const inv = document.createElement("div");
  inv.className = "iw-screen hidden";
  setPanelHtml(
    inv,
    `
    <div class="iw-panel iw-wide">
      <div class="iw-panel-title">INVENTORY</div>
      <div class="iw-res-grid" id="iw-res-grid"></div>
      <div class="iw-section">CRAFT</div>
      <div class="iw-craft-row">
        <span class="iw-craft-name">Arrows ×5</span>
        <span class="iw-cost">1 wood • 2 shards</span>
        <button class="iw-btn iw-small" id="iw-craft-arrows">CRAFT</button>
      </div>
      <div class="iw-craft-row">
        <span class="iw-craft-name">Medicine</span>
        <span class="iw-cost">2 oil • 1 wood</span>
        <button class="iw-btn iw-small" id="iw-craft-med">CRAFT</button>
      </div>
      <div class="iw-craft-row">
        <span class="iw-craft-name">Fire arrows ×5</span>
        <span class="iw-cost">2 oil • 3 shards</span>
        <button class="iw-btn iw-small" id="iw-craft-fire">CRAFT</button>
      </div>
      <div class="iw-section">EQUIPMENT</div>
      <div class="iw-craft-row">
        <span class="iw-craft-name" id="iw-armor-name">Hide Armor</span>
        <span class="iw-cost" id="iw-armor-cost"></span>
        <button class="iw-btn iw-small" id="iw-craft-armor">UPGRADE</button>
      </div>
      <div class="iw-sp-line">Skill points: <span id="iw-sp-count">0</span></div>
      <div class="iw-hint">[I] or [ESC] to close</div>
    </div>`,
  );
  document.body.appendChild(inv);
  els.inventory = inv;
  els.craftArrows = inv.querySelector("#iw-craft-arrows");
  els.craftMed = inv.querySelector("#iw-craft-med");
  els.craftFire = inv.querySelector("#iw-craft-fire");
  els.craftArmor = inv.querySelector("#iw-craft-armor");
  els.armorName = inv.querySelector("#iw-armor-name");
  els.armorCost = inv.querySelector("#iw-armor-cost");
  els.spCount = inv.querySelector("#iw-sp-count");
  const grid = inv.querySelector("#iw-res-grid");
  for (const [key, label, color] of [
    ["wood", "WOOD", "#6b4a2f"],
    ["shards", "SHARDS", "#59e3ff"],
    ["oil", "OIL", "#8a4b32"],
    ["medicine", "MEDICINE", "#e06a5a"],
    ["arrows", "ARROWS", "#cfd8dc"],
    ["fireArrows", "FIRE ARROWS", "#ff9642"],
    ["hide", "HIDE", "#b98a5e"],
  ]) {
    const cell = document.createElement("div");
    cell.className = "iw-res-cell";
    setPanelHtml(
      cell,
      `<span class="iw-sw" style="background:${color}"></span>` +
        `<span class="iw-res-label">${label}</span>` +
        `<span class="iw-res-val">0</span>`,
    );
    grid.appendChild(cell);
    els.resCounts[key] = cell.querySelector(".iw-res-val");
  }

  // SKILLS
  const sk = document.createElement("div");
  sk.className = "iw-screen hidden";
  const cards = SKILLS.map(
    (d) =>
      `<div class="iw-skill" data-id="${d.id}">
       <div class="iw-skill-name">${d.name}</div>
       <div class="iw-skill-desc">${d.desc}</div>
       <div class="iw-skill-state" data-state="${d.id}">COST 1 PT</div>
     </div>`,
  ).join("");
  setPanelHtml(
    sk,
    `
    <div class="iw-panel iw-wide">
      <div class="iw-panel-title">SKILLS</div>
      <div class="iw-skills-grid">${cards}</div>
      <div class="iw-sp-line">Skill points: <span id="iw-sp-count2">0</span></div>
      <div class="iw-hint">[TAB] or [ESC] to close</div>
    </div>`,
  );
  document.body.appendChild(sk);
  els.skills = sk;
  els.spCount2 = sk.querySelector("#iw-sp-count2");
  for (const def of SKILLS) {
    const card = sk.querySelector(`.iw-skill[data-id="${def.id}"]`);
    els.skillCards[def.id] = card;
    els.skillState[def.id] = card.querySelector(`[data-state="${def.id}"]`);
  }

  // BESTIARY
  els.bestiaryCards = {};
  els.bestiaryName = {};
  els.bestiaryLore = {};
  const best = document.createElement("div");
  best.className = "iw-screen hidden";
  const bCards = SPECIES.map(
    (type) =>
      `<div class="iw-best" data-type="${type}">
       <div class="iw-best-name" data-name="${type}">???</div>
       <div class="iw-best-lore" data-lore="${type}">Undiscovered.</div>
     </div>`,
  ).join("");
  setPanelHtml(
    best,
    `
    <div class="iw-panel iw-wide">
      <div class="iw-panel-title">BESTIARY</div>
      <div class="iw-best-grid">${bCards}</div>
      <div class="iw-sp-line">Entries complete: <span id="iw-best-count">0 / ${SPECIES.length}</span></div>
      <div class="iw-hint">Scan or fight a machine to begin its entry — kill one to complete it. [B] or [ESC] to close</div>
    </div>`,
  );
  document.body.appendChild(best);
  els.bestiary = best;
  els.bestiaryCount = best.querySelector("#iw-best-count");
  for (const type of SPECIES) {
    const card = best.querySelector(`.iw-best[data-type="${type}"]`);
    els.bestiaryCards[type] = card;
    els.bestiaryName[type] = card.querySelector(`[data-name="${type}"]`);
    els.bestiaryLore[type] = card.querySelector(`[data-lore="${type}"]`);
  }

  // WORLD MAP
  const map = document.createElement("div");
  map.className = "iw-screen hidden";
  setPanelHtml(
    map,
    `
    <div class="iw-panel iw-map-panel">
      <div class="iw-panel-title">FRONTIER MAP</div>
      <div class="iw-map-wrap">
        <canvas id="iw-world-map" aria-label="World map"></canvas>
        <div class="iw-map-legend">
          <span><i class="iw-legend-dot iw-legend-player"></i>YOU</span>
          <span><i class="iw-legend-dot iw-legend-quest"></i>CONTRACT</span>
          <span><i class="iw-legend-dot iw-legend-expedition"></i>EXPEDITION</span>
          <span><i class="iw-legend-dot iw-legend-landmark"></i>LANDMARK</span>
          <span><i class="iw-legend-dot iw-legend-danger"></i>MACHINE</span>
        </div>
      </div>
      <div class="iw-map-status">${G.mapRevealed ? "FRONTIER SURVEY COMPLETE" : "FOCUS-SCAN A VANTAGE TO REVEAL THE FRONTIER"}</div>
      <div class="iw-hint">[M] or [ESC] to close · map pauses the hunt</div>
    </div>`,
  );
  document.body.appendChild(map);
  els.map = map;
  els.mapCanvas = map.querySelector("#iw-world-map");
  els.mapStatus = map.querySelector(".iw-map-status");

  // DEATH
  const death = document.createElement("div");
  death.className = "iw-death";
  setPanelHtml(
    death,
    `
    <div class="iw-death-inner">
      <div class="iw-death-title">YOU DIED</div>
      <div class="iw-death-sub">The wild reclaims all.</div>
      <button class="iw-btn" id="iw-restart">RESTART</button>
    </div>`,
  );
  document.body.appendChild(death);
  els.death = death;
  els.restartBtn = death.querySelector("#iw-restart");
}

function injectStyles() {
  if (document.getElementById("iw-menu-style")) return;
  const st = document.createElement("style");
  st.id = "iw-menu-style";
  st.textContent = `
.iw-screen{position:fixed;inset:0;z-index:30;display:flex;align-items:center;
  justify-content:center;background:rgba(4,7,10,.72);
  font-family:'Segoe UI',system-ui,sans-serif;color:#dfe7ea;}
.iw-screen.hidden{display:none;}
.iw-panel{background:rgba(10,14,18,.88);border:1px solid rgba(255,255,255,.15);
  padding:28px 36px;display:flex;flex-direction:column;align-items:center;gap:12px;
  min-width:280px;}
.iw-panel.iw-wide{min-width:520px;max-width:92vw;}
.iw-map-panel{min-width:min(780px,92vw);max-width:92vw;}
.iw-map-wrap{position:relative;width:min(720px,78vw);aspect-ratio:1;max-height:68vh;}
#iw-world-map{display:block;width:100%;height:100%;image-rendering:auto;background:#061016;
  box-shadow:0 0 0 1px rgba(89,227,255,.24),0 12px 34px rgba(0,0,0,.45);}
.iw-map-legend{position:absolute;left:12px;bottom:12px;display:flex;flex-wrap:wrap;gap:8px 14px;
  padding:7px 9px;background:rgba(4,7,10,.78);font-size:10px;letter-spacing:.08em;color:rgba(223,231,234,.78);}
.iw-map-legend span{display:flex;align-items:center;gap:5px;}
.iw-legend-dot{width:7px;height:7px;display:inline-block;border-radius:50%;}
.iw-legend-player{background:#eef6f8;}
.iw-legend-quest{background:#f2c14e;}
.iw-legend-expedition{background:#59e3ff;}
.iw-legend-landmark{background:#f1d58a;}
.iw-legend-danger{background:#ff4d3d;}
.iw-map-status{font-size:11px;letter-spacing:.15em;color:#59e3ff;}

.iw-panel-title,.iw-title{letter-spacing:.35em;font-weight:700;}
.iw-panel-title{font-size:18px;margin-bottom:6px;color:#eef6f8;}

#iw-start{cursor:pointer;background:rgba(4,7,10,.85);}
.iw-start-inner{display:flex;flex-direction:column;align-items:center;gap:18px;}
.iw-title{font-size:64px;color:#eef6f8;text-shadow:0 0 24px rgba(89,227,255,.25);}
.iw-tagline{font-size:15px;font-style:italic;color:rgba(223,231,234,.65);
  letter-spacing:.12em;}
.iw-controls{display:grid;grid-template-columns:auto auto;gap:4px 16px;
  margin-top:10px;font-size:12px;}
.iw-ck{text-align:right;color:#59e3ff;letter-spacing:1px;font-weight:600;}
.iw-ca{color:rgba(223,231,234,.75);letter-spacing:.4px;}
.iw-clickbegin{margin-top:16px;font-size:15px;letter-spacing:.4em;color:#eef6f8;
  animation:iwpulse 1.6s ease-in-out infinite;}
@keyframes iwpulse{0%,100%{opacity:.35;}50%{opacity:1;}}

.iw-btn{pointer-events:auto;cursor:pointer;background:rgba(89,227,255,.08);
  border:1px solid rgba(89,227,255,.45);color:#dfe7ea;padding:9px 26px;
  font-family:inherit;font-size:13px;letter-spacing:.2em;transition:background .15s;}
.iw-btn:hover:not(:disabled){background:rgba(89,227,255,.22);}
.iw-btn:disabled{opacity:.35;cursor:default;border-color:rgba(255,255,255,.15);}
.iw-btn.iw-small{padding:5px 14px;font-size:11px;}

.iw-gear{position:absolute;right:18px;bottom:18px;width:38px;height:38px;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:rgba(10,14,18,.7);border:1px solid rgba(89,227,255,.45);
  color:#59e3ff;font-family:inherit;font-size:19px;line-height:1;padding:0;
  pointer-events:auto;transition:background .15s;}
.iw-gear:hover{background:rgba(89,227,255,.22);}

#iw-continue{margin-top:6px;}
#iw-newrun{margin-top:-6px;} /* keep the CONTINUE / NEW RUN pair visually grouped */

.iw-res-grid{display:grid;grid-template-columns:repeat(6,auto);gap:10px 26px;
  margin:4px 0 8px;}
.iw-res-cell{display:flex;align-items:center;gap:8px;font-size:13px;}
.iw-res-label{color:rgba(223,231,234,.7);font-size:11px;letter-spacing:.08em;}
.iw-res-val{font-weight:700;min-width:20px;text-align:right;}
.iw-sw{width:11px;height:11px;border:1px solid rgba(255,255,255,.25);display:inline-block;}

.iw-section{font-size:12px;letter-spacing:.3em;color:#59e3ff;margin-top:6px;}
.iw-craft-row{display:flex;align-items:center;gap:18px;width:100%;justify-content:space-between;}
.iw-craft-name{font-size:14px;min-width:110px;}
.iw-cost{font-size:12px;color:rgba(223,231,234,.6);flex:1;text-align:left;}
.iw-sp-line{font-size:12px;color:rgba(223,231,234,.7);margin-top:4px;}
.iw-hint{font-size:11px;color:rgba(223,231,234,.45);letter-spacing:.1em;}

.iw-skills-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:4px 0;}
.iw-skill{border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.03);
  padding:14px;width:170px;cursor:pointer;pointer-events:auto;
  display:flex;flex-direction:column;gap:6px;transition:border-color .15s;}
.iw-skill:hover{border-color:rgba(89,227,255,.5);}
.iw-skill.owned{border-color:#59e3ff;background:rgba(89,227,255,.08);cursor:default;}
.iw-skill.available{border-color:rgba(126,214,126,.55);}
.iw-skill-name{font-size:13px;font-weight:700;letter-spacing:.06em;color:#eef6f8;}
.iw-skill-desc{font-size:11px;color:rgba(223,231,234,.65);flex:1;}
.iw-skill-state{font-size:10px;letter-spacing:.15em;color:#59e3ff;}
.iw-skill.owned .iw-skill-state{color:#7ed67e;}
.iw-skill:not(.available):not(.owned) .iw-skill-state{color:rgba(223,231,234,.4);}

.iw-best-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:4px 0;
  max-height:52vh;overflow-y:auto;}
.iw-best{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.02);
  padding:12px;width:170px;display:flex;flex-direction:column;gap:5px;
  transition:border-color .15s;}
.iw-best-name{font-size:12px;font-weight:700;letter-spacing:.08em;color:rgba(223,231,234,.35);}
.iw-best-lore{font-size:11px;color:rgba(223,231,234,.4);font-style:italic;line-height:1.35;}
.iw-best.seen{border-color:rgba(89,227,255,.35);}
.iw-best.seen .iw-best-name{color:#59e3ff;}
.iw-best.killed{border-color:rgba(126,214,126,.55);background:rgba(126,214,126,.05);}
.iw-best.killed .iw-best-name{color:#eef6f8;}
.iw-best.killed .iw-best-lore{color:rgba(223,231,234,.75);font-style:normal;}

.iw-death{position:fixed;inset:0;z-index:40;display:flex;align-items:center;
  justify-content:center;background:radial-gradient(ellipse at center,
  rgba(20,4,4,.86),rgba(0,0,0,.96));opacity:0;pointer-events:none;
  transition:opacity 1.4s;font-family:'Segoe UI',system-ui,sans-serif;color:#dfe7ea;}
.iw-death.show{opacity:1;pointer-events:auto;}
.iw-death-inner{display:flex;flex-direction:column;align-items:center;gap:16px;}
.iw-death-title{font-size:58px;letter-spacing:.4em;color:#c94f43;font-weight:800;
  text-shadow:0 0 30px rgba(160,20,20,.5);}
.iw-death-sub{font-size:14px;font-style:italic;color:rgba(223,231,234,.6);
  letter-spacing:.12em;margin-bottom:10px;}
/* Cinematic title surface: clear hierarchy, launch focus, and responsive field manual. */
#iw-start {
  cursor: pointer;
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 35%, rgba(21,55,70,.28), transparent 48%), linear-gradient(180deg, rgba(2,8,17,.78), rgba(3,10,15,.52) 48%, rgba(2,8,10,.92));
}
#iw-start::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: .22;
  background: linear-gradient(90deg, transparent 49.9%, rgba(89,227,255,.12) 50%, transparent 50.1%), repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,.018) 4px);
}
#iw-start::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 140px rgba(0,0,0,.78), inset 0 -90px 150px rgba(0,0,0,.46);
}
.iw-title-shell {
  position: relative;
  z-index: 1;
  width: min(1120px, 88vw);
  min-height: min(650px, 88vh);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 24px 0 20px;
}
.iw-title-topline, .iw-title-footer {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  color: rgba(223,231,234,.45);
  font-size: 10px;
  letter-spacing: .18em;
}
.iw-title-topline { border-bottom: 1px solid rgba(89,227,255,.18); padding-bottom: 12px; }
.iw-title-footer { border-top: 1px solid rgba(255,255,255,.1); padding-top: 12px; font-size: 9px; }
.iw-live { color: rgba(126,214,126,.72); }
.iw-live i, .iw-launch-status span {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin: 0 7px 1px 0;
  border-radius: 50%;
  background: #7ed67e;
  box-shadow: 0 0 10px #7ed67e;
}
.iw-title-hero { display: flex; flex-direction: column; align-items: center; text-align: center; margin: 15px 0 10px; }
.iw-title-kicker { color: #59e3ff; font-size: 11px; letter-spacing: .38em; font-weight: 600; margin-bottom: 12px; }
.iw-title { font-size: clamp(48px, 7vw, 88px); line-height: .95; letter-spacing: .08em; color: #eef6f8; text-shadow: 0 0 24px rgba(89,227,255,.28), 0 4px 30px rgba(0,0,0,.55); }
.iw-tagline { font-size: 16px; font-style: italic; color: rgba(223,231,234,.68); letter-spacing: .16em; margin-top: 13px; }
.iw-title-rule { width: 240px; height: 1px; background: rgba(89,227,255,.18); margin: 19px 0 13px; position: relative; }
.iw-title-rule span { position: absolute; left: 50%; top: -2px; width: 5px; height: 5px; background: #59e3ff; transform: rotate(45deg); box-shadow: 0 0 12px #59e3ff; }
.iw-title-copy { max-width: 430px; margin: 0; color: rgba(223,231,234,.56); font-size: 12px; line-height: 1.7; letter-spacing: .08em; }
.iw-title-lower { display: grid; grid-template-columns: 1fr 300px; gap: 70px; align-items: end; }
.iw-controls-panel { border-left: 1px solid rgba(89,227,255,.28); padding-left: 18px; }
.iw-section-label { color: #59e3ff; font-size: 10px; letter-spacing: .25em; margin-bottom: 12px; }
.iw-section-label span { color: rgba(223,231,234,.35); margin-left: 10px; letter-spacing: .12em; }
#iw-start .iw-controls { display: grid; grid-template-columns: repeat(2, minmax(190px, 1fr)); gap: 7px 30px; margin-top: 0; font-size: 11px; }
.iw-control { display: grid; grid-template-columns: 88px 1fr; gap: 10px; align-items: center; }
#iw-start .iw-ck { text-align: left; color: #59e3ff; letter-spacing: .09em; font-weight: 700; white-space: nowrap; }
#iw-start .iw-ca { color: rgba(223,231,234,.67); letter-spacing: .04em; white-space: nowrap; }
.iw-launch-panel { border: 1px solid rgba(89,227,255,.22); background: rgba(4,13,19,.52); padding: 20px 22px 17px; display: flex; flex-direction: column; align-items: center; gap: 9px; box-shadow: 0 12px 35px rgba(0,0,0,.2); }
.iw-launch-status { color: rgba(126,214,126,.75); font-size: 10px; letter-spacing: .18em; margin-bottom: 4px; }
.iw-btn.iw-primary { width: 100%; background: rgba(89,227,255,.16); border-color: rgba(89,227,255,.72); font-weight: 700; }
.iw-btn.iw-secondary { width: 100%; border-color: rgba(255,255,255,.2); font-size: 10px; padding: 7px 18px; }
#iw-start .iw-clickbegin { margin-top: 8px; font-size: 11px; letter-spacing: .18em; color: rgba(238,246,248,.78); }
.iw-launch-note { font-size: 9px; letter-spacing: .18em; color: rgba(223,231,234,.3); margin-top: 4px; }
@media (max-width: 800px) {
  .iw-title-shell { width: 88vw; min-height: 92vh; padding: 18px 0 14px; }
  .iw-title-topline span:first-child, .iw-title-footer span:last-child { display: none; }
  .iw-title-lower { grid-template-columns: 1fr; gap: 20px; align-items: stretch; }
  .iw-controls-panel { order: 2; }
  .iw-launch-panel { order: 1; }
  #iw-start .iw-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 14px; font-size: 10px; }
  .iw-control { grid-template-columns: 72px 1fr; gap: 6px; }
  #iw-start .iw-ca { white-space: normal; }
  .iw-title-copy { display: none; }
  .iw-title-hero { margin: 12px 0 5px; }
}
@media (max-height: 650px) and (min-width: 801px) {
  .iw-title-shell { min-height: 94vh; padding-top: 12px; padding-bottom: 10px; }
  .iw-title-copy { display: none; }
  .iw-title-rule { margin: 10px 0 7px; }
  #iw-start .iw-controls { gap: 5px 24px; }
  .iw-launch-panel { padding: 13px 18px 11px; }
}
`;
  document.head.appendChild(st);
}
