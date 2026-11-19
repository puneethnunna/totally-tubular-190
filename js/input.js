// Keyboard + Gamepad input. poll(alliance, playerIndex, opts) -> contract Input (+ requestTube).
// opts: { cameraMode, heading, drive: 'swerve'|'tank', fieldRelative }
// Rotation: positive = heading increases (turning toward the robot's right). Call poll once per frame.
import { SIDES } from './config.js';

const DZ = 0.12;
const K1 = { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], rotL: ['KeyQ', 'ArrowLeft'], rotR: ['KeyE', 'ArrowRight'],
  intake: ['Space', 'ShiftLeft', 'ShiftRight'], lower: ['Digit1', 'KeyU'], upper: ['Digit2', 'KeyI'], floor: ['Digit3', 'KeyF'],
  launch: ['KeyR'], climb: ['KeyG'], tube: ['KeyH'] };
const K2 = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], rotL: ['Comma'], rotR: ['Period'],
  intake: ['Slash'], lower: ['KeyK'], upper: ['KeyL'], floor: ['Semicolon'], launch: ['Quote'], climb: ['KeyP'], tube: ['KeyO'] };
const dz = (v) => (Math.abs(v) < DZ ? 0 : Math.sign(v) * (Math.abs(v) - DZ) / (1 - DZ));
const clamp = (v) => Math.max(-1, Math.min(1, v));

export function createInput() {
  const down = new Set(), edge = new Set();
  let players = 1, enabled = true, maps = [K1, K2];
  const gameCodes = new Set([...Object.values(K1), ...Object.values(K2)].flat());
  const prevBtn = {}, prevStart = {};

  const setPlayers = (n) => {
    players = n;
    maps = [n === 2 ? Object.fromEntries(Object.entries(K1).map(([k, v]) => [k, v.filter((c) => !c.startsWith('Arrow'))])) : K1, K2];
  };
  const clear = () => { down.clear(); edge.clear(); };
  addEventListener('keydown', (e) => {
    if (!enabled || e.target?.tagName === 'INPUT') return;
    if (gameCodes.has(e.code) || e.code === 'KeyC') e.preventDefault();
    if (!e.repeat) edge.add(e.code);
    down.add(e.code);
  });
  addEventListener('keyup', (e) => down.delete(e.code));
  addEventListener('blur', clear);

  const held = (arr) => arr.some((c) => down.has(c));
  const tap = (arr) => { let r = false; for (const c of arr) if (edge.delete(c)) r = true; return r; };
  const pads = () => [...(navigator.getGamepads?.() || [])].filter(Boolean);

  function poll(alliance, pi = 0, o = {}) {
    if (!enabled) return {};
    const K = maps[pi] || K1, S = SIDES[alliance];
    const pad = pads()[pi];
    const b = (i) => !!pad?.buttons[i]?.pressed;
    const pb = (pad && (prevBtn[pad.index] ||= [])) || [];
    const bEdge = (i) => { const r = b(i) && !pb[i]; return r; };
    let fx = (held(K.right) ? 1 : 0) - (held(K.left) ? 1 : 0), fy = (held(K.up) ? 1 : 0) - (held(K.down) ? 1 : 0);
    let rot = (held(K.rotR) ? 1 : 0) - (held(K.rotL) ? 1 : 0);
    if (pad) {
      const ax = dz(pad.axes[0] || 0), ay = -dz(pad.axes[1] || 0), rx = dz(pad.axes[2] || 0);
      if (Math.abs(ax) > Math.abs(fx)) fx = ax;
      if (Math.abs(ay) > Math.abs(fy)) fy = ay;
      if (Math.abs(rx) > Math.abs(rot)) rot = rx;
    }
    const out = {
      intake: held(K.intake) || (pad ? (pad.buttons[7]?.value || 0) > 0.3 : false),
      scoreLower: tap(K.lower) || (pad ? bEdge(0) : false),
      scoreUpper: tap(K.upper) || (pad ? bEdge(3) : false),
      scoreFloor: tap(K.floor) || (pad ? bEdge(1) : false),
      launch: tap(K.launch) || (pad ? bEdge(2) : false),
      climb: held(K.climb) || b(4),
      requestTube: tap(K.tube) || (pad ? bEdge(5) : false),
    };
    if (pad) pad.buttons.forEach((x, i) => { pb[i] = x.pressed; });
    if (o.drive === 'tank') {
      const kbTurn = (held(K.right) ? 1 : 0) - (held(K.left) ? 1 : 0) + rot;
      out.throttle = clamp(fy);
      out.turn = clamp(Math.abs(kbTurn) > Math.abs(fx) ? kbTurn : fx);
      if (pad && Math.abs(rot) > Math.abs(out.turn)) out.turn = rot;
    } else {
      const m = Math.hypot(fx, fy); if (m > 1) { fx /= m; fy /= m; }
      let F = S.screenForward, R = S.screenRight;
      if (o.cameraMode === 'chase' || o.fieldRelative === false) {
        const h = o.heading || 0;
        F = { x: Math.cos(h), z: Math.sin(h) }; R = { x: -Math.sin(h), z: Math.cos(h) };
      }
      out.moveX = fy * F.x + fx * R.x; out.moveZ = fy * F.z + fx * R.z;
      out.rotate = clamp(rot);
    }
    return out;
  }

  // Global (non-robot) actions: camera cycle (C), pause (gamepad Start).
  function takeGlobal() {
    const g = { camera: tap(['KeyC']), pause: false };
    for (const p of pads()) { const s = !!p.buttons[9]?.pressed; if (s && !prevStart[p.index]) g.pause = true; prevStart[p.index] = s; }
    return g;
  }

  return { poll, takeGlobal, setPlayers, clear, setEnabled: (v) => { enabled = v; clear(); } };
}
