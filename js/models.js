import * as THREE from 'three';
import { TUBE, ROBOT, SIDES } from './config.js';

// ---------- tubes ----------
let TA;
export function getTubeAssets() {
  if (TA) return TA;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f7fa'; g.fillRect(0, 0, 32, 8);
  g.fillStyle = '#8fc6ea'; g.fillRect(32, 0, 32, 8);
  const map = new THREE.CanvasTexture(c);
  map.wrapS = THREE.RepeatWrapping; map.repeat.set(6, 1);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.NearestFilter;
  // Torus axis is +z; renderer/models orient it.
  const geometry = new THREE.TorusGeometry(TUBE.outerRadius - TUBE.tubeRadius, TUBE.tubeRadius, 14, 48);
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.4, metalness: 0.05 });
  return (TA = { geometry, material });
}

// Tube lying flat (axis = y).
export function createTubeModel() {
  const { geometry, material } = getTubeAssets();
  const m = new THREE.Mesh(geometry, material);
  m.rotation.x = -Math.PI / 2;
  m.castShadow = m.receiveShadow = true;
  const o = new THREE.Group();
  o.add(m);
  return o;
}

// ---------- robots ----------
const mats = {};
const M = (k, make) => mats[k] || (mats[k] = make());
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2, ...o });
const frameMat = () => M('frame', () => std(0x2b2f36, { metalness: 0.5, roughness: 0.4 }));
const alu = () => M('alu', () => std(0xb9bec7, { metalness: 0.7, roughness: 0.35 }));
const blk = () => M('blk', () => std(0x16181c, { roughness: 0.8 }));
const orange = () => M('orange', () => std(0xff8a1f, { roughness: 0.5 }));
const bumperCache = new Map();
function bumperMat(alliance, number) {
  const key = alliance + number;
  if (bumperCache.has(key)) return bumperCache.get(key);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  const col = '#' + SIDES[alliance].color.toString(16).padStart(6, '0');
  g.fillStyle = col; g.fillRect(0, 0, 256, 64);
  g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, 0, 256, 6); g.fillRect(0, 58, 256, 6);
  g.font = 'bold 46px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.45)';
  g.strokeText(String(number), 128, 34); g.fillStyle = '#fff'; g.fillText(String(number), 128, 34);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.9 });
  bumperCache.set(key, mat);
  return mat;
}

const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
};
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 14);
const bx = (w, h, d, mat, x, y, z) => { const m = mesh(BOX, mat, x, y, z); m.scale.set(w, h, d); return m; };
const cyl = (r, len, mat, x, y, z, axis = 'z') => {
  const m = mesh(CYL, mat, x, y, z); m.scale.set(r, len, r);
  if (axis === 'z') m.rotation.x = Math.PI / 2; else if (axis === 'x') m.rotation.z = Math.PI / 2;
  return m;
};

const TIER_H = { stow: 0.45, floor: 0.2, lower: 0.95, upper: 1.75 };

export function createRobotModel(robot) {
  const preset = robot.preset || {};
  const id = preset.id || 'stacker';
  const root = new THREE.Group();
  const body = new THREE.Group();   // slight pitch/roll room
  root.add(body);
  const s = ROBOT.size, h = s / 2, b = ROBOT.bumper;

  // chassis + wheels
  body.add(bx(s, 0.1, s, frameMat(), 0, 0.14, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) body.add(cyl(0.075, 0.07, blk(), sx * 0.3, 0.075, sz * (h - 0.02)));
  // bumpers
  const bm = bumperMat(robot.alliance, robot.number);
  const by = 0.19, bh = 0.2;
  for (const sx of [-1, 1]) {
    body.add(bx(b, bh, ROBOT.outer, bm, sx * (h + b / 2), by, 0));
    body.add(bx(s, bh, b, bm, 0, by, sx * (h + b / 2)));
  }

  // intake roller
  const roller = new THREE.Group(); roller.position.set(h - 0.02, 0.13, 0);
  const rw = id === 'sweeper' ? 0.92 : 0.6;
  roller.add(cyl(0.05, rw, orange(), 0, 0, 0));
  roller.add(bx(0.06, 0.012, rw, blk(), 0.03, 0, 0));
  body.add(roller);
  if (id === 'sweeper') {
    body.add(bx(0.12, 0.2, 1.0, frameMat(), h - 0.08, 0.25, 0));
    for (const sz of [-1, 1]) body.add(bx(0.3, 0.08, 0.06, alu(), h - 0.2, 0.15, sz * 0.46));
  }

  // lift (mast + carriage + arm)
  const tall = id === 'climber' ? 1.3 : id === 'stacker' ? 1.0 : 0.85;
  const mastX = -0.25;
  const inner = [];
  const rails = id === 'stacker' || id === 'climber' ? [0] : [-0.3, 0.3];
  for (const z of rails) {
    body.add(bx(0.12, tall, 0.12, id === 'climber' ? frameMat() : alu(), mastX - 0.04, 0.2 + tall / 2, z));
    const st = bx(0.09, 1, 0.09, orange(), mastX, 0, z);
    body.add(st); inner.push(st);
  }
  const carriage = new THREE.Group(); carriage.position.set(mastX, TIER_H.stow, 0);
  body.add(carriage);
  carriage.add(bx(0.12, 0.14, rails.length > 1 ? 0.7 : 0.2, orange(), 0, 0, 0));
  const arm = bx(1, 0.06, 0.12, alu(), 0.3, 0, 0);
  carriage.add(arm);
  const hook = cyl(0.025, 0.14, alu(), 0.6, 0.06, 0, 'y');
  carriage.add(hook);
  const carry = new THREE.Object3D(); carry.position.set(0.7, 0.0, 0);
  carriage.add(carry);

  // preset extras
  let wheels = [], hooks = null;
  if (id === 'tosser') {
    const sh = new THREE.Group(); sh.position.set(-0.05, 0.42, 0); sh.rotation.z = Math.PI / 5; body.add(sh);
    sh.add(bx(0.7, 0.28, 0.36, frameMat(), 0, 0, 0));
    for (const dx of [0.2, 0.38]) {
      const w = cyl(0.09, 0.3, orange(), dx, 0.12, 0); sh.add(w); wheels.push(w);
    }
    sh.add(bx(0.7, 0.04, 0.4, alu(), 0, 0.15, 0));
  }
  if (id === 'climber') {
    hooks = new THREE.Group(); hooks.position.set(mastX + 0.08, 0.2 + tall, 0); body.add(hooks);
    for (const z of [-0.22, 0.22]) {
      hooks.add(bx(0.06, 0.3, 0.06, alu(), 0, 0.15, z));
      const j = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 8, 16, Math.PI), alu());
      j.position.set(0.1, 0.3, z); j.rotation.z = 0; j.castShadow = true; hooks.add(j);
    }
  }
  if (id === 'stacker') body.add(bx(0.3, 0.2, 0.3, frameMat(), -0.05, 0.3, 0)); // electronics

  // player marker
  const marker = new THREE.Group(); marker.visible = false;
  const mmat = new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, depthTest: false });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 8, 32), mmat); ring.rotation.x = Math.PI / 2;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.3, 4), mmat); cone.rotation.x = Math.PI; cone.position.y = 0.3;
  marker.add(ring, cone); marker.renderOrder = 10;
  root.add(marker);

  let hCur = TIER_H.stow, eCur = 0, spin = 0, wspin = 0, t = 0;
  const maxH = id === 'climber' || id === 'stacker' ? 1.8 : 1.0;

  function update(rs, dt = 0.016, isPlayer = rs.isPlayer) {
    t += dt;
    root.position.set(rs.x, rs.y || 0, rs.z);
    root.rotation.y = -rs.heading;
    const k = 1 - Math.exp(-dt * 10);
    const tier = rs.armTier || 'stow';
    const hT = Math.min(TIER_H[tier] ?? TIER_H.stow, maxH);
    hCur += (hT - hCur) * k;
    eCur += ((tier === 'stow' || tier === 'floor' ? 0 : rs.arm) * ROBOT.maxExtension - eCur) * k;
    carriage.position.y = hCur;
    for (const st of inner) { st.scale.y = Math.max(0.2, hCur - 0.1); st.position.y = 0.2 + st.scale.y / 2; }
    const L = 0.6 + eCur;
    arm.scale.x = L; arm.position.x = L / 2;
    hook.position.x = L; carry.position.x = L + 0.1;
    spin += (rs.intakeOn ? 22 : 0) * dt;
    roller.rotation.z = -spin;
    const launching = rs.action && rs.action.type === 'launch';
    wspin += (launching ? 60 : 8) * dt;
    for (const w of wheels) w.rotation.y = wspin;
    if (hooks) {
      const c = rs.action && rs.action.type === 'climb' ? Math.min(1, (rs.action.t || 0) / (rs.action.duration || 1)) : (rs.support >= 2 ? 1 : 0);
      hooks.position.y = 0.2 + tall - 0.25 + c * 0.25;
    }
    marker.visible = !!isPlayer;
    if (isPlayer) { marker.position.y = 1.9 + Math.sin(t * 3) * 0.08 + (id === 'climber' ? 0.5 : 0); marker.rotation.y = t * 1.5; }
  }
  update({ ...robot, x: 0, z: 0, heading: 0, armTier: 'stow', arm: 0 }, 1);
  return { object: root, update, carry, root };
}
