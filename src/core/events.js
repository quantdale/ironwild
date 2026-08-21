// IRONWILD - core event bus
// Tiny synchronous pub/sub used to decouple systems (combat FX, audio, UI, AI).

const listeners = new Map(); // type -> Set<fn>

export const bus = {
  /** Subscribe to an event type. Returns an unsubscribe function. */
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => bus.off(type, fn);
  },

  /** Remove a previously registered listener. */
  off(type, fn) {
    const set = listeners.get(type);
    if (set) set.delete(fn);
  },

  /** Emit an event. Payload may be undefined. Listener errors are isolated. */
  emit(type, payload) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] listener error for "${type}":`, err);
      }
    }
  },
};

// Canonical event types (keep in sync with ARCHITECTURE.md):
//   'noise'        { pos:Vector3, radius:number }          - something loud happened (AI hears it)
//   'arrowFired'   { origin:Vector3, dir:Vector3, power:number }
//   'machineHit'   { machine, point:Vector3, damage:number, weak:boolean, partName:string|null }
//   'partBroken'   { machine, partName:string }
//   'machineDied'  { machine, pos:Vector3 }
//   'machineAlert' { pos:Vector3 }                       - machine escalated to attack (audio bark)
//   'playerHit'    { amount:number, hp:number, pos:Vec3|null }
//   'playerHealed' { hp:number }
//   'playerDied'   {}
//   'pickup'       { type:string, amount:number }           - resource collected
//   'notify'       { text:string, tone?:'info'|'good'|'bad' } - HUD toast
//   'prompt'       { text:string|null }                     - interaction prompt shown/hidden
//   'hitMarker'    { weak:boolean }
//   'ui'           { action:string }                        - ui click / open / close sounds
//   'craft'        { item:string }
//   'skillUp'      { id:string }
// v2 additions:
//   'machineScanned' { machine }                        - focus-scanned a machine (Vantage rewards)
//   'camShake'       { amp:number, time?:number }       - camera.js applies impact shake
//   'settingsChanged'{ key:string, value:* }            - ui/settings.js after any change
//   'questUpdate'    { quest }                          - systems/quests.js progress/completion
//   'gameSaved'      { manual:boolean }                 - systems/save.js
//   'killStreak'     { count:number }                   - machines/ai.js on rapid kills (HUD banner + audio sting + XP streak bonus)
// v3 additions:
//   'xpGain'         { amount:number, reason:string }    - systems/xp.js after any XP source
//   'levelUp'        { level:number }                    - systems/xp.js on level threshold
//   'meleeSwing'     { hit:boolean }                     - player/spear.js on attack
// v4 additions:
//   'bestiaryUnlock' { type:string, kind:'seen'|'killed' } - systems/bestiary.js new entry
