// Keyboard + Gamepad input (frsim-style keys). poll(alliance, playerIndex, opts) -> contract Input (+ requestTube).
// opts: { cameraMode, heading, drive:'swerve'|'tank', fieldRelative, cap (0..1), tier:{mode,canUpper,canLower,upperReady} }
// Rotation: positive = heading increases (turning toward the robot's right). Call poll once per frame.
import { SIDES } from './config.js';

export const ACTIONS = [
  ['up', 'Drive forward', 'Driving'], ['down', 'Drive back', 'Driving'], ['left', 'Strafe left', 'Driving'], ['right', 'Strafe right', 'Driving'],
  ['rotL', 'Turn left', 'Driving'], ['rotR', 'Turn right', 'Driving'], ['sp1', 'Speed 1', 'Driving'], ['sp2', 'Speed 2', 'Driving'], ['sp3', 'Speed 3', 'Driving'],
  ['intake', 'Intake (hold)', 'Scoring'], ['score', 'Score (auto tier)', 'Scoring'], ['tier', 'Toggle tier: auto / lower / upper', 'Scoring'], ['drop', 'Drop / outtake', 'Scoring'],
  ['launch', 'Launch', 'Scoring'], ['climb', 'Climb (hold, endgame)', 'Scoring'], ['tube', 'Human player tube', 'Scoring'],
  ['camera', 'Cycle camera', 'Match'], ['slot', 'Driver station slot', 'Match'], ['pause', 'Pause', 'Match'], ['restart', 'Restart', 'Match'],
];
export const DEFAULT_KEYS = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA'], right: ['KeyD'], rotL: ['KeyJ', 'ArrowLeft'], rotR: ['KeyL', 'ArrowRight'],
  sp1: ['Digit1'], sp2: ['Digit2'], sp3: ['Digit3'], intake: ['ShiftLeft', 'KeyF'], score: ['Space'], tier: ['KeyZ'], drop: ['KeyQ'], launch: ['KeyX'],
  climb: ['KeyG'], tube: ['KeyH'], camera: ['KeyC'], slot: ['KeyV'], pause: ['Escape'], restart: ['KeyR'],
};
// Second human in LOCAL 2P.
const K2 = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], rotL: ['Comma'], rotR: ['Period'], intake: ['Slash'],
  score: ['Enter'], tier: ['KeyN'], drop: ['Semicolon'], launch: ['Quote'], climb: ['KeyP'], tube: ['KeyO'] };
const NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift', Escape: 'Esc', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Enter: 'Enter', Backquote: '`', Minus: '-', Equal: '=', Tab: 'Tab', ControlLeft: 'Ctrl', AltLeft: 'Alt' };
export const keyLabel = (c) => NAMES[c] || c.replace(/^(Key|Digit|Numpad)/, '');

const DZ = 0.12;
const dz = (v) => (Math.abs(v) < DZ ? 0 : Math.sign(v) * (Math.abs(v) - DZ) / (1 - DZ));
const clamp = (v) => Math.max(-1, Math.min(1, v));
const norm = (c) => (c === 'ShiftRight' ? 'ShiftLeft' : c);

export function createInput() {
  const down = new Set(), edge = new Set();
  let players = 1, enabled = false, custom = {};
  const prevBtn = {}, prevStart = {};
  const keys = (id, pi = 0) => (pi === 1 ? K2[id] : (custom[id] || DEFAULT_KEYS[id]) || []).filter((c) => !(players === 2 && pi === 0 && c.startsWith('Arrow'))).map(norm);
  const allCodes = () => new Set([...ACTIONS.map((a) => a[0])].flatMap((id) => [...keys(id, 0), ...(players === 2 ? keys(id, 1) : [])]));
  const clear = () => { down.clear(); edge.clear(); };
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
  addEventListener('keydown', (e) => {
    if (!enabled || typing(e)) return;
    const c = norm(e.code);
    if (allCodes().has(c)) e.preventDefault();
    if (!e.repeat) edge.add(c);
    down.add(c);
  });
  addEventListener('keyup', (e) => down.delete(norm(e.code)));
  addEventListener('blur', clear);

  const held = (id, pi) => keys(id, pi).some((c) => down.has(c));
  const tap = (id, pi) => { let r = false; for (const c of keys(id, pi)) if (edge.delete(c)) r = true; return r; };
  const pads = () => [...(navigator.getGamepads?.() || [])].filter(Boolean);

  function poll(alliance, pi = 0, o = {}) {
    if (!enabled) return {};
    const S = SIDES[alliance], pad = pads()[pi], cap = o.cap ?? 1;
    const b = (i) => !!pad?.buttons[i]?.pressed;
    const pb = (pad && (prevBtn[pad.index] ||= [])) || [];
    const bEdge = (i) => b(i) && !pb[i];
    let fx = (held('right', pi) ? 1 : 0) - (held('left', pi) ? 1 : 0), fy = (held('up', pi) ? 1 : 0) - (held('down', pi) ? 1 : 0);
    let rot = (held('rotR', pi) ? 1 : 0) - (held('rotL', pi) ? 1 : 0);
    if (pad) {
      const ax = dz(pad.axes[0] || 0), ay = -dz(pad.axes[1] || 0), rx = dz(pad.axes[2] || 0);
      if (Math.abs(ax) > Math.abs(fx)) fx = ax;
      if (Math.abs(ay) > Math.abs(fy)) fy = ay;
      if (Math.abs(rx) > Math.abs(rot)) rot = rx;
    }
    const t = o.tier || {};
    const scoreEdge = tap('score', pi) || (pad ? bEdge(0) : false);
    const tier = t.mode === 'upper' ? 'upper' : t.mode === 'lower' ? 'lower' : (t.canUpper && t.upperReady ? 'upper' : 'lower');
    const upper = tier === 'upper' && t.canUpper !== false;
    const out = {
      intake: held('intake', pi) || (pad ? (pad.buttons[7]?.value || 0) > 0.3 : false),
      scoreLower: scoreEdge && !upper, scoreUpper: scoreEdge && upper,
      scoreFloor: tap('drop', pi) || (pad ? bEdge(1) : false),
      launch: tap('launch', pi) || (pad ? bEdge(2) : false),
      climb: held('climb', pi) || b(4),
      requestTube: tap('tube', pi) || (pad ? bEdge(5) : false),
      tierToggle: tap('tier', pi) || (pad ? bEdge(3) : false),
    };
    if (pad) pad.buttons.forEach((x, i) => { pb[i] = x.pressed; });
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

  // Match-level actions (P1 keys): camera, slot, restart, pause, speed cap 1..3.
  function takeGlobal() {
    const g = { camera: tap('camera', 0), slot: tap('slot', 0), restart: tap('restart', 0), pause: tap('pause', 0), speed: 0 };
    for (const n of [1, 2, 3]) if (tap('sp' + n, 0)) g.speed = n;
    for (const p of pads()) { const s = !!p.buttons[9]?.pressed; if (s && !prevStart[p.index]) g.pause = true; prevStart[p.index] = s; }
    return g;
  }

  return { poll, takeGlobal, clear, setPlayers: (n) => { players = n; }, setKeys: (k) => { custom = k || {}; }, setEnabled: (v) => { enabled = v; clear(); } };
}
