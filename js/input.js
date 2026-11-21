// Keyboard + Gamepad input, frsim-style bindings remapped to TUBE actions. The top half of this file is pure (no DOM) so node tests can import it.
// poll(alliance, playerIndex, opts) -> { moveX/moveZ/rotate | throttle/turn, intake, climb, place, drop, tierToggle, requestTube, stow } (edges are one-frame).
// Rotation: positive = heading increases (turning toward the robot's right). Call poll once per frame; takeGlobal once per frame.
import { SIDES } from './config.js';

// ---------- action table: [id, label, group, padBindable] ----------
export const ACTIONS = [
  ['up', 'Drive forward', 'Driving', true], ['down', 'Drive back', 'Driving', true], ['left', 'Strafe left', 'Driving', true], ['right', 'Strafe right', 'Driving', true],
  ['rotL', 'Turn left', 'Driving', true], ['rotR', 'Turn right', 'Driving', true],
  ['sp1', 'Speed 1', 'Driving', false], ['sp2', 'Speed 2', 'Driving', false], ['sp3', 'Speed 3', 'Driving', false],
  ['intake', 'Intake (hold)', 'Tubes', true], ['place', 'Place tube', 'Tubes', true], ['tier', 'Post tier (auto / upper / lower)', 'Tubes', true],
  ['drop', 'Drop tube', 'Tubes', true], ['climb', 'Climb (hold, endgame)', 'Tubes', true], ['tube', 'Request tube (human player)', 'Tubes', true], ['stow', 'Arm stow / cancel', 'Tubes', true],
  ['slot', 'Flip camera', 'Camera', true], ['camera', 'Next camera', 'Camera', true],
  ['pause', 'Pause', 'Game', true], ['restart', 'Restart match', 'Game', true], ['stats', 'Show stats', 'Game', true], ['breakdown', 'Score breakdown', 'Game', true], ['fullscreen', 'Fullscreen', 'Game', true],
].map(([id, label, group, pad]) => ({ id, label, group, pad }));
export const GROUPS = ['Driving', 'Tubes', 'Camera', 'Game'];
export const ACTION_IDS = ACTIONS.map((a) => a.id);

export const DEFAULT_KEYS = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA'], right: ['KeyD'], rotL: ['KeyJ', 'ArrowLeft'], rotR: ['KeyL', 'ArrowRight'],
  sp1: ['Digit1'], sp2: ['Digit2'], sp3: ['Digit3'],
  intake: ['ShiftLeft', 'KeyF'], place: ['Space', 'KeyH'], tier: ['KeyZ'], drop: ['KeyQ'], climb: ['KeyG'], tube: ['KeyX'], stow: ['KeyE'],
  slot: ['KeyV'], camera: ['KeyC'], pause: ['Escape'], restart: ['KeyR'], stats: ['Period'], breakdown: ['KeyB'], fullscreen: ['KeyY'],
};
// Gamepad bindings: 'b<N>' = standard-mapping button N, 'a<N>+' / 'a<N>-' = axis N pushed positive / negative, null = unbound.
export const DEFAULT_PAD = {
  up: 'a1-', down: 'a1+', left: 'a0-', right: 'a0+', rotL: 'a2-', rotR: 'a2+', sp1: null, sp2: null, sp3: null,
  intake: 'b6', place: 'b7', tier: 'b1', drop: 'b4', climb: 'b3', tube: 'b5', stow: 'b2',
  slot: 'b10', camera: null, pause: 'b8', restart: 'b9', stats: null, breakdown: null, fullscreen: 'b12',
};
export const DEFAULT_PADCFG = { device: 'auto', flipAB: false, flipXY: false, deadzone: 12, fine: 0, rumble: 50 };
// Second human in LOCAL 2P (keyboard) — avoids every P1 global key (C V R B Y . Esc).
export const K2 = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], rotL: ['Comma'], rotR: ['Slash'], intake: ['Semicolon'],
  place: ['Enter'], tier: ['KeyN'], drop: ['Quote'], climb: ['KeyP'], tube: ['KeyO'], stow: ['KeyI'] };

export const CTL_VERSION = 2;
export const MAX_CHIPS = 2;

// ---------- labels ----------
const NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift', Escape: 'Esc', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Enter: 'Enter', Backquote: '`', Minus: '-', Equal: '=', Tab: 'Tab', ControlLeft: 'Ctrl', AltLeft: 'Alt', BracketLeft: '[', BracketRight: ']', Backslash: '\\' };
export const keyLabel = (c) => NAMES[c] || String(c).replace(/^(Key|Digit|Numpad)/, '');
const BTN = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→', 'Home'];
const AXN = [['L←', 'L→'], ['L↑', 'L↓'], ['R←', 'R→'], ['R↑', 'R↓']];
export function padLabel(b) {
  if (!b) return '';
  const m = /^b(\d+)$/.exec(b); if (m) return BTN[+m[1]] || 'B' + m[1];
  const a = /^a(\d+)([+-])$/.exec(b); if (a) return (AXN[+a[1]] || ['A' + a[1] + '-', 'A' + a[1] + '+'])[a[2] === '-' ? 0 : 1];
  return b;
}
export const normCode = (c) => (c === 'ShiftRight' ? 'ShiftLeft' : c);

// ---------- binding maps (pure) ----------
const isCode = (c) => typeof c === 'string' && c.length > 0 && c.length < 24;
const isPadB = (b) => b === null || (typeof b === 'string' && /^(b\d{1,2}|a\d[+-])$/.test(b));
export function effectiveKeys(custom) {
  const m = {};
  for (const id of ACTION_IDS) m[id] = [...(Array.isArray(custom?.[id]) ? custom[id] : DEFAULT_KEYS[id] || [])].map(normCode);
  return m;
}
export function effectivePad(custom) {
  const m = {};
  for (const id of ACTION_IDS) m[id] = custom && id in custom && isPadB(custom[id]) ? custom[id] : DEFAULT_PAD[id] ?? null;
  return m;
}
export function findKeyDuplicates(map) {
  const seen = new Map(), dups = [];
  for (const id of ACTION_IDS) for (const c of map[id] || []) { if (seen.has(c) && seen.get(c) !== id) dups.push([c, seen.get(c), id]); seen.set(c, id); }
  return dups;
}
export function findPadDuplicates(map) {
  const seen = new Map(), dups = [];
  for (const id of ACTION_IDS) { const b = map[id]; if (!b) continue; if (seen.has(b)) dups.push([b, seen.get(b), id]); seen.set(b, id); }
  return dups;
}
const labelOf = (id) => ACTIONS.find((a) => a.id === id)?.label || id;

// Rebind one key chip. idx = chip index or '+' (add). code '' = clear that chip. A key already used by another action is swapped into
// the chip being replaced (or removed from the other action when adding). Returns { map: full effective map, note }.
export function rebindKey(custom, id, idx, code) {
  const m = effectiveKeys(custom), list = m[id]; let note = '';
  if (!list) return { map: m, note };
  if (code === '') { if (idx !== '+' && idx < list.length) list.splice(idx, 1); return { map: m, note }; }
  code = normCode(code);
  if (!isCode(code)) return { map: m, note };
  const adding = idx === '+' || idx >= list.length, old = adding ? undefined : list[idx];
  if (list.includes(code)) return { map: m, note };
  for (const o of ACTION_IDS) {
    if (o === id) continue;
    const at = m[o].indexOf(code); if (at < 0) continue;
    if (old !== undefined && !m[o].includes(old)) { m[o][at] = old; note = `${keyLabel(code)} swapped with ${labelOf(o)} (now ${keyLabel(old)})`; }
    else { m[o].splice(at, 1); note = `${keyLabel(code)} removed from ${labelOf(o)}`; }
  }
  if (adding) { if (list.length >= MAX_CHIPS) list[MAX_CHIPS - 1] = code; else list.push(code); } else list[idx] = code;
  return { map: m, note };
}
// Rebind a controller binding (one per action). binding null = clear. Duplicates swap with the other action.
export function rebindPad(custom, id, binding) {
  const m = effectivePad(custom); let note = '';
  if (!(id in m)) return { map: m, note };
  if (binding && isPadB(binding)) {
    const old = m[id];
    for (const o of ACTION_IDS) if (o !== id && m[o] === binding) { m[o] = old; note = old ? `${padLabel(binding)} swapped with ${labelOf(o)} (now ${padLabel(old)})` : `${padLabel(binding)} removed from ${labelOf(o)}`; }
    m[id] = binding;
  } else if (binding === null) m[id] = null;
  return { map: m, note };
}

// Old saved settings (no / older ctlVersion) -> new defaults for controls; every other setting is kept. Also repairs corrupt maps.
export function migrateControls(saved) {
  const s = { ...(saved || {}) };
  if (s.ctlVersion !== CTL_VERSION || typeof s.keys !== 'object' || !s.keys) { s.keys = {}; s.pad = {}; s.padCfg = { ...DEFAULT_PADCFG }; }
  s.ctlVersion = CTL_VERSION;
  const keys = {};
  for (const id of ACTION_IDS) if (Array.isArray(s.keys?.[id])) keys[id] = s.keys[id].filter(isCode).slice(0, MAX_CHIPS);
  if (findKeyDuplicates(effectiveKeys(keys)).length) { for (const k in keys) delete keys[k]; }
  const pad = {};
  for (const id of ACTION_IDS) if (s.pad && id in s.pad && isPadB(s.pad[id])) pad[id] = s.pad[id];
  if (findPadDuplicates(effectivePad(pad)).length) { for (const k in pad) delete pad[k]; }
  const n = (v, lo, hi, d) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, +v)) : d), c = s.padCfg || {};
  s.keys = keys; s.pad = pad;
  s.padCfg = { device: c.device === 'auto' || (Number.isInteger(c.device) && c.device >= 0 && c.device < 8) ? c.device : 'auto', flipAB: !!c.flipAB, flipXY: !!c.flipXY,
    deadzone: n(c.deadzone, 0, 40, 12), fine: n(c.fine, 0, 100, 0), rumble: n(c.rumble, 0, 100, 50) };
  return s;
}

// ---------- post tier + placing (pure) ----------
export const TIER_CYCLE = { auto: 'upper', upper: 'lower', lower: 'auto' };
export const tierLabel = (m) => String(m || 'auto').toUpperCase();
export function nextTier(mode, canUpper = true) { let n = TIER_CYCLE[mode] || 'auto'; if (n === 'upper' && !canUpper) n = TIER_CYCLE[n]; return n; }
// AUTO = upper if the robot can place on upper posts, else lower. UPPER / LOWER are explicit.
export function resolveTier(mode, canUpper, canLower = true) { return mode === 'upper' || mode === 'lower' ? mode : canUpper ? 'upper' : canLower === false ? 'upper' : 'lower'; }
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// Mirrors sim.js findPost / pickLaunchPost (without the "post full" check — the sim still rejects those).
export function postInReach(posts, r, tier, t) {
  const c = Math.cos(r.heading), s = Math.sin(r.heading);
  for (const p of posts) {
    if (p.tier !== tier || (p.alliance && p.alliance !== r.alliance)) continue;
    if (Math.abs(wrap(r.heading - (p.dirX < 0 ? 0 : Math.PI))) > t.placeAngle) continue;
    const dx = p.tipX - r.x, dz = p.z - r.z, f = dx * c + dz * s, l = -dx * s + dz * c;
    const front = r.bumper ? r.bumper.lx / 2 : (r.radius || 0); // reach is measured from the bumper front face, like sim.js
    if (f > 0 && f - front <= t.reach && Math.abs(l) <= t.placeLateral) return p;
  }
  return null;
}
export function launchTarget(posts, r, t) {
  for (const tier of ['upper', 'lower']) for (const p of posts) {
    if (p.tier !== tier || (p.alliance && p.alliance !== r.alliance)) continue;
    const dx = p.tipX - r.x, dz = p.z - r.z, d = Math.hypot(dx, dz);
    if (d >= t.launchMin && d <= t.launchMax && Math.abs(wrap(Math.atan2(dz, dx) - r.heading)) <= t.launchAngle) return p;
  }
  return null;
}
// One "Place" button -> which sim edge to fire. AUTO falls back to the other tier if only that post is in reach.
export function planPlace({ robot, preset, mode, posts, tune }) {
  if (!robot?.held?.length) return { act: null, why: 'No tube held' };
  const canUp = !!preset.canUpper, canLow = preset.canLower !== false, pref = resolveTier(mode, canUp, canLow);
  const order = mode === 'auto' || !mode ? [pref, pref === 'upper' ? 'lower' : 'upper'] : [pref];
  for (const t of order) if ((t === 'upper' ? canUp : canLow) && postInReach(posts, robot, t, tune)) return { act: t === 'upper' ? 'scoreUpper' : 'scoreLower', tier: t };
  if (preset.canLaunch && launchTarget(posts, robot, tune)) return { act: 'launch' };
  return { act: null, why: 'No post in reach' };
}

// ---------- gamepad reading (pure) ----------
export function axisVal(v, dzPct = 12, fine = 0) {
  const dz = dzPct / 100, a = Math.abs(v || 0); if (a < dz) return 0;
  return Math.sign(v) * Math.min(1, Math.pow((a - dz) / (1 - dz), 1 + fine / 50));
}
const flipIdx = (i, c) => (c.flipAB && i < 2 ? 1 - i : c.flipXY && (i === 2 || i === 3) ? 5 - i : i);
// 0..1 strength of a binding on a pad-like { buttons:[{pressed,value}], axes:[] }.
export function readBinding(pad, b, c = DEFAULT_PADCFG) {
  if (!pad || !b) return 0;
  const m = /^b(\d+)$/.exec(b);
  if (m) { const x = pad.buttons?.[flipIdx(+m[1], c)]; return x ? (x.pressed || x.value > 0.5 ? 1 : 0) : 0; }
  const a = /^a(\d+)([+-])$/.exec(b); if (!a) return 0;
  const v = (pad.axes?.[+a[1]] || 0) * (a[2] === '-' ? -1 : 1);
  return v > 0 ? axisVal(v, c.deadzone, c.fine) : 0;
}
// First button press / axis push on a pad (for rebinding). prev = previous snapshot { b:[], a:[] } to require a fresh press.
export function detectBinding(pad, c = DEFAULT_PADCFG) {
  if (!pad) return null;
  for (let i = 0; i < (pad.buttons?.length || 0); i++) { const x = pad.buttons[i]; if (x && (x.pressed || x.value > 0.5)) return 'b' + flipIdx(i, c); }
  for (let i = 0; i < (pad.axes?.length || 0) && i < 4; i++) { const v = pad.axes[i] || 0; if (Math.abs(v) > 0.7) return `a${i}${v < 0 ? '-' : '+'}`; }
  return null;
}

// ---------- the live input object (DOM) ----------
export function createInput() {
  const down = new Set(), edge = new Set();
  let players = 1, enabled = false, cfg = { keys: {}, pad: {}, padCfg: DEFAULT_PADCFG }, KB = effectiveKeys({}), PD = effectivePad({}), last = 'kb';
  const prevPad = {};
  const keys = (id, pi = 0) => (pi === 1 ? K2[id] || [] : KB[id] || []).filter((c) => !(players === 2 && pi === 0 && c.startsWith('Arrow')));
  const codeSet = () => new Set(ACTION_IDS.flatMap((id) => [...keys(id, 0), ...(players === 2 ? keys(id, 1) : [])]));
  const clear = () => { down.clear(); edge.clear(); };
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
  addEventListener('keydown', (e) => {
    if (!enabled || typing(e)) return;
    last = 'kb';
    const c = normCode(e.code);
    if (codeSet().has(c)) e.preventDefault();
    if (!e.repeat) edge.add(c);
    down.add(c);
  });
  addEventListener('keyup', (e) => down.delete(normCode(e.code)));
  addEventListener('blur', clear);

  const held = (id, pi) => keys(id, pi).some((c) => down.has(c));
  const tap = (id, pi) => { let r = false; for (const c of keys(id, pi)) if (edge.delete(c)) r = true; return r; };
  const rawPads = () => [...(navigator.getGamepads?.() || [])];
  // P1 uses the chosen device (or the first connected); P2 the next connected pad.
  function padFor(pi) {
    const all = rawPads(), pc = cfg.padCfg || DEFAULT_PADCFG, conn = all.filter(Boolean);
    const pick = pc.device !== 'auto' ? all[pc.device] : null, p1 = pick || conn[0] || null;
    return pi === 0 ? p1 : conn.find((p) => p !== p1) || null;
  }
  const padEdge = (pad, id) => {
    const pr = (prevPad[pad.index] ||= {}), v = readBinding(pad, PD[id], cfg.padCfg) > 0.5, r = v && !pr[id]; pr[id] = v; return r;
  };

  function poll(alliance, pi = 0, o = {}) {
    if (!enabled) return {};
    const S = SIDES[alliance], pad = padFor(pi), pc = cfg.padCfg || DEFAULT_PADCFG, cap = o.cap ?? 1;
    const pv = (id) => (pad ? readBinding(pad, PD[id], pc) : 0);
    let fx = (held('right', pi) ? 1 : 0) - (held('left', pi) ? 1 : 0), fy = (held('up', pi) ? 1 : 0) - (held('down', pi) ? 1 : 0);
    let rot = (held('rotR', pi) ? 1 : 0) - (held('rotL', pi) ? 1 : 0);
    if (pad) {
      const ax = pv('right') - pv('left'), ay = pv('up') - pv('down'), rx = pv('rotR') - pv('rotL');
      if (Math.abs(ax) > Math.abs(fx)) fx = ax;
      if (Math.abs(ay) > Math.abs(fy)) fy = ay;
      if (Math.abs(rx) > Math.abs(rot)) rot = rx;
      if (pi === 0 && (Math.abs(ax) + Math.abs(ay) + Math.abs(rx) > 0.3 || pad.buttons.some((b) => b.pressed))) last = 'pad';
    }
    const pe = (id) => (pad ? padEdge(pad, id) : false);
    const out = {
      intake: held('intake', pi) || pv('intake') > 0.5, climb: held('climb', pi) || pv('climb') > 0.5,
      place: tap('place', pi) | pe('place'), drop: tap('drop', pi) | pe('drop'), tierToggle: tap('tier', pi) | pe('tier'),
      requestTube: tap('tube', pi) | pe('tube'), stow: tap('stow', pi) | pe('stow'),
    };
    for (const k of ['place', 'drop', 'tierToggle', 'requestTube', 'stow']) out[k] = !!out[k];
    if (o.drive === 'tank') {
      const kbTurn = rot + (held('right', pi) ? 1 : 0) - (held('left', pi) ? 1 : 0);
      out.throttle = clamp(fy) * cap;
      out.turn = clamp(Math.abs(kbTurn) > Math.abs(fx) ? kbTurn : fx) * cap;
      if (pad && Math.abs(rot) > Math.abs(out.turn)) out.turn = rot * cap;
    } else {
      const m = Math.hypot(fx, fy); if (m > 1) { fx /= m; fy /= m; }
      let F = S.screenForward, R = S.screenRight;
      if (o.cameraMode === 'first' || o.fieldRelative === false) {
        const h = o.heading || 0;
        F = { x: Math.cos(h), z: Math.sin(h) }; R = { x: -Math.sin(h), z: Math.cos(h) };
      }
      out.moveX = (fy * F.x + fx * R.x) * cap; out.moveZ = (fy * F.z + fx * R.z) * cap;
      out.rotate = clamp(rot) * cap;
    }
    return out;
  }

  // Match-level actions (P1 keys / P1 pad): camera, slot, restart, pause, fullscreen, stats toggle, breakdown (held), speed cap 1..3.
  function takeGlobal() {
    const pad = padFor(0), pe = (id) => (pad ? padEdge(pad, id) : false);
    const g = { camera: tap('camera', 0) | pe('camera'), slot: tap('slot', 0) | pe('slot'), restart: tap('restart', 0) | pe('restart'), pause: tap('pause', 0) | pe('pause'),
      fullscreen: tap('fullscreen', 0) | pe('fullscreen'), stats: tap('stats', 0) | pe('stats'), breakdown: held('breakdown', 0) || (pad ? readBinding(pad, PD.breakdown, cfg.padCfg) > 0.5 : false), speed: 0 };
    for (const k of ['camera', 'slot', 'restart', 'pause', 'fullscreen', 'stats']) g[k] = !!g[k];
    for (const n of [1, 2, 3]) if (tap('sp' + n, 0)) g.speed = n;
    return g;
  }
  function rumble(pi = 0, k = 1) {
    try {
      const pad = padFor(pi), s = ((cfg.padCfg?.rumble ?? 50) / 100) * k; if (!pad || s <= 0) return;
      pad.vibrationActuator?.playEffect?.('dual-rumble', { startDelay: 0, duration: 160, weakMagnitude: Math.min(1, s), strongMagnitude: Math.min(1, s * 0.8) })?.catch?.(() => {});
    } catch {}
  }

  return {
    poll, takeGlobal, clear, rumble, padFor, lastDevice: () => last,
    setPlayers: (n) => { players = n; },
    configure: (s) => { cfg = { keys: s?.keys || {}, pad: s?.pad || {}, padCfg: { ...DEFAULT_PADCFG, ...(s?.padCfg || {}) } }; KB = effectiveKeys(cfg.keys); PD = effectivePad(cfg.pad); },
    setEnabled: (v) => { enabled = v; clear(); },
  };
}
const clamp = (v) => Math.max(-1, Math.min(1, v));
