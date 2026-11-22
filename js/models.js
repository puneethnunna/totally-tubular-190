import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { TUBE, ROBOT, SIDES } from './config.js';
import { getMeshSync } from './robots.js';

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

// ---------- material library (mirrors frsim's robot presets; `shine` -> envMapIntensity, scene.environment supplies the reflections) ----------
// [color, metalness, roughness, shine, extra]
const LIB = {
  aluminumBare:     [0xd3d7dc, 0.75, 0.34, 0.8],
  aluminumSatin:    [0xcdd1d7, 0.7, 0.42, 0.75],
  aluminumAnodized: [0x30343b, 0.6, 0.36, 0.8],
  aluminumClear:    [0xe3e6ea, 0.75, 0.36, 0.8],
  steelZinc:        [0xd3d6da, 0.8, 0.36, 0.8],
  steelRaw:         [0x7d8186, 0.55, 0.62, 0.6],
  steelBlack:       [0x1d1d1f, 0.7, 0.45, 0.7],
  steelChain:       [0x8e9196, 1, 0.34, 1],
  brass:            [0xd7ae5c, 1, 0.22, 1],
  polycarbSmoked:   [0x2b2b2d, 0, 0.06, 1, { transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }],
  polycarbSmokedDark: [0x1e1d1c, 0, 0.06, 1, { transparent: true, opacity: 0.78, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }],
  polycarbClear:    [0xdfe8ee, 0, 0.06, 1, { transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }],
  compliantWheel:   [0x3f8f52, 0, 0.82, 0.25],
  rubber:           [0x161616, 0, 0.9, 0.25],
  silicone:         [0x2c2c2e, 0, 0.7, 0.4],
  gripTape:         [0x222222, 0, 1, 0.1],
  plastic:          [0x202226, 0, 0.5, 0.6],
  powderCoat:       [0xe8731a, 0, 0.68, 0.55],
  motor:            [0x3b3e45, 0.6, 0.42, 0.7],
  cloth:            [0x2149c4, 0, 0.93, 0.12],
  plywood:          [0xb89560, 0, 0.85, 0.15],
};
const matCache = new Map();
export function getMaterial(name, color, extra) {
  const key = name + (color !== undefined ? '#' + color.toString(16) : '') + (extra ? JSON.stringify(extra) : '');
  let m = matCache.get(key);
  if (m) return m;
  const L = LIB[name];
  if (!L) throw new Error('unknown material ' + name);
  const [c, metalness, roughness, shine, ex = {}] = L;
  m = new THREE.MeshStandardMaterial({ color: color !== undefined ? color : c, metalness, roughness, envMapIntensity: shine, ...ex, ...extra });
  m.name = name;
  matCache.set(key, m);
  return m;
}
export const MATERIALS = Object.keys(LIB);
const A = (n) => getMaterial(n);
const CLOTH = { blue: 0x2149c4, red: 0xc41f27 };
const clothMat = (alliance) => getMaterial('cloth', CLOTH[alliance] ?? CLOTH.blue);
const accentMat = (hex) => getMaterial('powderCoat', hex);

// ---------- geometry helpers ----------
const geoCache = new Map();
const cached = (key, make) => geoCache.get(key) || (geoCache.set(key, make()), geoCache.get(key));
// tiny parts: plain box (12 tris); small: 1-segment bevel (108); big tubes/plates: 2-segment bevel (300)
const rboxGeo = (w, h, d, r) => cached(`rb${w}|${h}|${d}|${r}`, () => {
  const mn = Math.min(w, h, d);
  if (r <= 0.003 || mn < 0.022) return new THREE.BoxGeometry(w, h, d);
  return new RoundedBoxGeometry(w, h, d, mn >= 0.05 && r >= 0.005 ? 2 : 1, Math.min(r, mn / 2 - 1e-4));
});
const cylGeo = (r, len, axis, seg) => cached(`cy${r}|${len}|${axis}|${seg}`, () => {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  if (axis === 'z') g.rotateX(Math.PI / 2); else if (axis === 'x') g.rotateZ(Math.PI / 2);
  return g;
});
// Tire with rounded shoulders, axis z.
const tireGeo = (r, w) => cached(`tire${r}|${w}`, () => {
  const c = Math.min(0.007, w / 3), h = w / 2, hub = r * 0.3;
  const pts = [[hub, -h], [r - c, -h], [r - c * 0.3, -h + c * 0.3], [r, -h + c], [r, h - c], [r - c * 0.3, h - c * 0.3], [r - c, h], [hub, h]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(Math.PI / 2);
  return g;
});

function prep(g) {
  const c = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(c.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') c.deleteAttribute(k);
  if (!c.attributes.uv) c.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(c.attributes.position.count * 2), 2));
  c.clearGroups();
  return c;
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

// Collects static parts and merges them into one mesh per material.
class Batch {
  constructor() { this.parts = new Map(); }
  geo(mat, g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const c = prep(g);
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s);
    c.applyMatrix4(_m);
    (this.parts.get(mat) || this.parts.set(mat, []).get(mat)).push(c);
    return this;
  }
  box(mat, w, h, d, x, y, z, r = 0.004, rx = 0, ry = 0, rz = 0) { return this.geo(mat, rboxGeo(w, h, d, r), x, y, z, rx, ry, rz); }
  cyl(mat, r, len, x, y, z, axis = 'y', seg = 14) { return this.geo(mat, cylGeo(r, len, axis, seg), x, y, z); }
  tire(mat, r, w, x, y, z) { return this.geo(mat, tireGeo(r, w), x, y, z); }
  build(parent, { cast = true, receive = true } = {}) {
    for (const [mat, list] of this.parts) {
      const m = new THREE.Mesh(list.length > 1 ? mergeGeometries(list, false) : list[0], mat);
      const transparent = mat.transparent;
      m.castShadow = cast && !transparent; m.receiveShadow = receive && !transparent;
      if (transparent) m.renderOrder = 2;
      parent.add(m);
    }
    this.parts.clear();
    return parent;
  }
}
const newGroup = (parent, x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };

// ---------- bumpers ----------
const BUMPER = { y0: 0.03, h: 0.14, bevel: 0.012, wall: 0.02, planR: 0.06 };   // 1.2 in .. 6.7 in above carpet
function rrPoints(hw, hd, r, seg = 7) {
  const pts = [], arc = (cx, cz, a0) => { for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI / 2; pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cz + Math.sin(a) * r)); } };
  arc(hw - r, hd - r, 0); arc(-hw + r, hd - r, Math.PI / 2); arc(-hw + r, -hd + r, Math.PI); arc(hw - r, -hd + r, Math.PI * 1.5);
  return pts;   // CCW
}
function ringGeo(ox, oz, ix, iz, rOut, rIn, y0, h, bevel) {
  const shape = new THREE.Shape(rrPoints(ox / 2, oz / 2, rOut));
  shape.holes.push(new THREE.Path(rrPoints(ix / 2, iz / 2, rIn).reverse()));
  const depth = h - 2 * bevel;
  let g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 3, curveSegments: 4, steps: 1 });
  g.clearGroups();
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0 + bevel, 0);
  const c = toCreasedNormals(g, 0.85);
  g.dispose();
  return c;
}
const numTexCache = new Map();
function numberTexture(number) {
  const key = String(number);
  if (numTexCache.has(key)) return numTexCache.get(key);
  const W = 2048, H = 342, cv = document.createElement('canvas');   // 6:1 face decal
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffffff';
  const fam = '"Barlow Condensed","Roboto Condensed","Arial Narrow","Helvetica Neue Condensed Bold",Impact,"Arial Black",sans-serif';
  g.font = `800 100px ${fam}`;
  try { g.fontStretch = 'condensed'; } catch { /* older engines */ }
  const txt = String(number);
  const asc100 = g.measureText('0').actualBoundingBoxAscent || 72;
  const px = Math.round(100 * (H * 0.92) / asc100);   // numerals fill 92% of the decal height
  g.font = `800 ${px}px ${fam}`;
  try { g.fontStretch = 'condensed'; } catch { /* */ }
  const tw = g.measureText(txt).width, asc = g.measureText('0').actualBoundingBoxAscent || px * 0.72;
  const sx = Math.min(0.88, (W * 0.96) / Math.max(1, tw));   // condensed: squeeze horizontally, shrink to fit
  g.save();
  g.translate(W / 2, H / 2 + asc / 2);
  g.scale(sx, 1);
  g.fillText(txt, 0, 0);
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  numTexCache.set(key, tex);
  return tex;
}
const decalMatCache = new Map();
function decalMat(number) {
  const key = String(number);
  if (!decalMatCache.has(key)) {
    decalMatCache.set(key, new THREE.MeshBasicMaterial({ map: numberTexture(number), transparent: true, alphaTest: 0.3, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  }
  return decalMatCache.get(key);
}
const bumperGeoCache = new Map();
function bumperGeos(fx, fz, b) {
  const key = [fx, fz, b].map((v) => v.toFixed(3)).join('|');
  let r = bumperGeoCache.get(key);
  if (r) return r;
  const { y0, h, bevel, wall, planR } = BUMPER;
  const ox = fx + 2 * b, oz = fz + 2 * b;
  const rOut = Math.min(planR, ox / 3, oz / 3);
  const cloth = ringGeo(ox, oz, fx + 2 * wall + 0.002, fz + 2 * wall + 0.002, rOut, Math.max(0.008, rOut - b + wall), y0, h, bevel);
  const back = ringGeo(fx + 2 * wall + 0.002, fz + 2 * wall + 0.002, fx + 0.004, fz + 0.004, Math.max(0.01, rOut - b + wall), 0.008, y0 + 0.008, h - 0.022, 0);
  // number decals: one per face, flat planes just proud of the cloth, merged into one geometry
  const yc = y0 + h / 2, parts = [];
  const faces = [[ox, oz, 0, 1, 0], [ox, oz, 0, -1, Math.PI], [oz, ox, 1, 0, Math.PI / 2], [oz, ox, -1, 0, -Math.PI / 2]];
  for (const [len, , nx, nz, ry] of faces) {
    const ph = Math.min(0.117, (len - 0.1) / 6), w = ph * 6, g = new THREE.PlaneGeometry(w, ph);
    g.rotateY(ry);
    g.translate(nx * (ox / 2 + 0.0012), yc, nz * (oz / 2 + 0.0012));
    parts.push(g);
  }
  const decals = mergeGeometries(parts.map((g) => { g.clearGroups(); return g; }), false);
  return bumperGeoCache.set(key, (r = { cloth, back, decals })).get(key);
}
export function createBumper(fx, fz, alliance, number, b = ROBOT.bumper) {
  const { cloth, back, decals } = bumperGeos(fx, fz, b);
  const grp = new THREE.Group();
  const c = new THREE.Mesh(cloth, clothMat(alliance)); c.castShadow = c.receiveShadow = true;
  const k = new THREE.Mesh(back, getMaterial('plywood')); k.castShadow = false; k.receiveShadow = true;
  const d = new THREE.Mesh(decals, decalMat(number)); d.renderOrder = 3;
  grp.add(c, k, d);
  grp.name = 'bumper';
  return grp;
}

// ---------- lift / arm / intake mechanisms (shared by procedural and STL robots) ----------
// Timeline of a PLACE action (u = action.t / action.duration, release at u = 0.7 in sim.js):
//   rise   u 0..0.50  carriage climbs from rest to the peg height (peg y - robot y)
//   extend u 0.16..0.70  telescoping arm + cross-slide bring the tube hole to just short of the peg tip (APPROACH)
//   slide  release .. +SLIDE seconds  claw pushes the tube onto the peg (the renderer moves the tube with it)
//   retract/lower after the slide: slew-limited, the carriage only descends once the arm has cleared the peg
export const LIFT = { PRONG_DY: 0.132, APPROACH: 0.094, FINAL: 0.0735, EMAX: 1.25, SLOT_GAP: 0.14, SLIDE: 0.15 };
const POST_BY_ID = new Map();
for (const a of ['blue', 'red']) for (const p of SIDES[a].posts) POST_BY_ID.set(p.id, p);
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const slew = (cur, tgt, dt, k, v) => { const d = (tgt - cur) * (1 - Math.exp(-dt * k)), m = v * dt; return cur + (d > m ? m : d < -m ? -m : d); };

// cfg: { mastX, zr, tall, n (moving stages), frameM, acc, xA0, yA0 (tube hole center at rest), lazy (hide when idle) }
function createLift(body, cfg) {
  const { mastX, zr, tall, n, frameM, acc, xA0, yA0, lazy } = cfg;
  const baseY = 0.1, L = Math.max(tall - 0.1, n >= 3 ? 0.85 : 0.6), armX0 = xA0 - 0.52, restH = yA0 - LIFT.PRONG_DY;
  const root = newGroup(body), mast = newGroup(root);
  const FB = new Batch();
  for (const z of [-zr, zr]) {
    FB.box(frameM, 0.062, L, 0.062, mastX, baseY + L / 2, z, 0.005);                                   // fixed stage (outer rail)
    FB.box(A('steelChain'), 0.007, L * 0.85, 0.012, mastX + 0.036, baseY + L / 2, z, 0.002);
    FB.box(A('plastic'), 0.08, 0.025, 0.08, mastX, baseY + 0.015, z, 0.004);
  }
  FB.box(frameM, 0.05, 0.04, 2 * zr + 0.06, mastX - 0.012, baseY + L - 0.03, 0, 0.004);
  FB.box(frameM, 0.05, 0.04, 2 * zr + 0.06, mastX - 0.012, baseY + 0.08, 0, 0.004);
  for (const sz of [-1, 1]) FB.box(frameM, 0.18, 0.03, 0.025, mastX + 0.08, baseY + 0.02, sz * (zr - 0.02), 0.004);
  FB.build(mast);
  const stages = [];
  for (let k = 1; k <= n; k++) {
    const g = newGroup(mast), SB = new Batch(), w = 0.056 - 0.006 * k, x = mastX + 0.009 * k, y0 = baseY + 0.02, mat = k % 2 ? A('aluminumBare') : acc;
    for (const z of [-zr, zr]) {
      SB.box(mat, w, L, w, x, y0 + L / 2, z, 0.004);
      SB.box(A('steelChain'), 0.007, L * 0.85, 0.012, x + w / 2 + 0.004, y0 + L / 2, z, 0.002);
      SB.cyl(A('steelChain'), 0.017, 0.012, x + w / 2 + 0.014, y0 + L + 0.012, z, 'z', 12);       // stage sprocket
    }
    SB.box(mat, w * 0.8, 0.035, 2 * zr + w, x, y0 + L - 0.06, 0, 0.004);
    SB.box(mat, w * 0.8, 0.03, 2 * zr + w, x, y0 + 0.05, 0, 0.004);
    SB.build(g); stages.push(g);
  }
  const carriage = newGroup(root, 0, restH, 0), CB = new Batch();
  CB.box(acc, 0.03, 0.4, 2 * zr + 0.1, mastX + 0.065, -0.12, 0, 0.005);                              // carriage plate (overlaps the top stage)
  for (const z of [-zr, zr]) for (const y of [-0.25, 0.05]) CB.cyl(A('aluminumSatin'), 0.014, 0.075, mastX + 0.045, y, z, 'z', 10);
  CB.box(A('aluminumSatin'), 0.04, 0.04, 0.66, mastX + 0.09, 0, 0, 0.005);                           // cross-slide rail
  CB.build(carriage);
  const cart = newGroup(carriage), CT = new Batch();
  CT.box(acc, 0.15, 0.085, 0.13, mastX + 0.09, 0, 0, 0.006);
  CT.box(A('aluminumSatin'), 0.68, 0.052, 0.052, armX0 + 0.34, 0, 0, 0.005);                         // arm stage 1 (fixed to the cart)
  CT.build(cart);
  const mid = newGroup(cart), MB = new Batch();
  MB.box(A('aluminumBare'), 0.68, 0.042, 0.042, armX0 + 0.34, 0, 0, 0.004);                          // arm stage 2
  MB.build(mid);
  const inner = newGroup(mid), IB = new Batch();
  IB.cyl(A('aluminumBare'), 0.017, 0.64, armX0 + 0.32, 0, 0, 'x', 12);                               // stage 3 = the prong the tubes ride on
  IB.box(acc, 0.022, 0.12, 0.09, xA0 - 0.235, 0, 0, 0.004);                                          // backstop
  IB.cyl(A('aluminumBare'), 0.028, 0.016, xA0 + 0.12, 0, 0, 'x', 12);                                // tip cap
  IB.build(inner);
  const carries = [new THREE.Object3D(), new THREE.Object3D()];
  root.add(carries[0], carries[1]);
  const S = { H: restH, E: 0, Z: 0, blend: 0, wasPlacing: false, H0: restH, slideT: LIFT.SLIDE };
  function apply() {
    const C = Math.max(0, S.H - restH);
    carriage.position.y = S.H;
    for (let k = 0; k < stages.length; k++) stages[k].position.y = (C * (k + 1)) / (n + 1);
    cart.position.z = S.Z; mid.position.x = S.E / 2; inner.position.x = S.E / 2;
    const ax = xA0 + S.E, ay = S.H + LIFT.PRONG_DY;
    carries[0].position.set(ax, ay, S.Z); carries[1].position.set(ax - LIFT.SLOT_GAP, ay, S.Z);
    if (lazy) { mast.visible = C > 0.03; carriage.visible = C > 0.03 || S.E > 0.02; }
  }
  function step(rs, dt) {
    const a = rs.action, post = a && a.type === 'place' && a.target !== 'floor' ? POST_BY_ID.get(a.target) : null;
    let direct = false;
    if (post) {
      if (!S.wasPlacing) S.H0 = S.H;
      const c = Math.cos(rs.heading), s = Math.sin(rs.heading), dx = post.tipX - rs.x, dz = post.z - rs.z;
      const f = dx * c + dz * s, l = -dx * s + dz * c;
      const Eapp = Math.min(Math.max(f - LIFT.APPROACH - xA0, 0), LIFT.EMAX), Efin = Math.min(Math.max(f + LIFT.FINAL - xA0, 0), LIFT.EMAX + 0.1);
      // Release times come from the sim (action.releases): one for a single place, two for a double place. The lift stays at post
      // height with the claw out until the LAST tube is on the peg, then falls through to the retract / lower branch below.
      const Ht = post.y - (rs.y || 0) - LIFT.PRONG_DY, d = Math.max(0.1, a.duration), dn = Math.max(0.1, a.normal || d), u = Math.min(1, a.t / dn);
      const rel = a.releases && a.releases.length ? a.releases : [0.7 * d], last = rel[rel.length - 1];
      const slideT = Math.min(LIFT.SLIDE, dn * 0.27), tr = a.t - last;           // seconds since the last release
      S.slideT = slideT;
      if (tr < slideT + 0.001) {
        direct = true;
        const e1 = ease((u - 0.16) / 0.54);
        let i = rel.length - 1; while (i >= 0 && a.t < rel[i]) i--;
        if (i < 0) S.E = Eapp * e1;
        else if (a.t < rel[i] + slideT) S.E = Eapp + (Efin - Eapp) * ease((a.t - rel[i]) / slideT);   // claw pushes tube i+1 onto the peg
        else {                                                                                       // between releases: draw back to load the next tube
          const gap = Math.max(0.05, (rel[i + 1] ?? rel[i] + 1) - rel[i] - 2 * slideT - 0.04);
          S.E = Efin + (Eapp - Efin) * ease((a.t - rel[i] - slideT) / gap);
        }
        S.H = S.H0 + (Ht - S.H0) * ease(u / 0.5);
        S.Z = Math.max(-0.05, Math.min(0.05, l)) * e1;
        S.blend = e1;
      }
    }
    S.wasPlacing = !!post;
    if (!direct) {
      const drop = a && a.type === 'place' && a.target === 'floor';
      const Et = drop ? 0.3 * (rs.arm || 0) : 0;
      S.E = slew(S.E, Et, dt, 9, 3.2);
      S.Z = slew(S.Z, 0, dt, 9, 1.5);
      const tier = drop ? null : rs.liftTier === 'upper' && (rs.preset?.canUpper ?? true) ? 'upper' : rs.liftTier ? 'lower' : null;
      const Hset = tier ? (tier === 'upper' ? 2.54 : 0.6096) - (rs.y || 0) - LIFT.PRONG_DY : restH;   // pre-raise to the chosen post height
      S.H = slew(S.H, S.E > 0.25 ? S.H : Hset, dt, 8, 3.4);       // wait for the claw to clear the peg before lowering
      S.blend = slew(S.blend, 0, dt, 12, 8);
    }
    apply();
  }
  apply();
  return { carries, step, state: S, root, mast, carriage, L, top: baseY + L };
}

// Over-the-bumper intake. The pivot bar sits INSIDE the frame perimeter above the bumper top; two bent arms (pivot -> elbow -> roller)
// stay attached to it at all times. Deployed (deploy 1): the first segment slopes down over the bumper's top-front edge with ~4 cm to
// spare, the second drops in front of the bumper face so the roller touches the carpet and scoops. Stowed (deploy 0): the whole arm
// rotates back/up about the pivot and folds over the robot inside the frame. frontX = outer bumper face x.
// All points are relative to the bumper face: P pivot (-0.22, 0.40), E elbow (+0.02, 0.22), R roller axle (+0.14, 0.05 = tire radius).
const INTAKE = { px: -0.22, py: 0.40, ex: 0.02, ey: 0.22, rx: 0.14, ry: 0.05, stowDeg: 195 };
function buildIntake(body, o) {
  const { frontX, rwid, frameM, wheelColor, lazy } = o;
  const pivotX = frontX + INTAKE.px, pivotY = INTAKE.py;
  const E = [INTAKE.ex - INTAKE.px, INTAKE.ey - INTAKE.py], R = [INTAKE.rx - INTAKE.px, INTAKE.ry - INTAKE.py];   // relative to the pivot
  const mount = newGroup(body, pivotX, 0, 0), MB = new Batch();
  const pivot = newGroup(body, pivotX, pivotY, 0), AB = new Batch();
  const az = rwid / 2 + 0.035;                                                  // arm z
  const post = Math.min(az - 0.02, 0.38);
  for (const sz of [-1, 1]) {                                                   // uprights from the deck to the pivot bar
    MB.box(frameM, 0.04, pivotY - 0.09, 0.03, 0, (pivotY + 0.09) / 2, sz * post, 0.004);
    MB.box(frameM, 0.07, 0.04, 0.04, 0, 0.1, sz * post, 0.004);
  }
  MB.build(mount);
  const seg = (x0, y0, x1, y1, z) => {
    const L = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0);
    AB.box(frameM, L + 0.03, 0.035, 0.02, (x0 + x1) / 2, (y0 + y1) / 2, z, 0.004, 0, 0, ang);
  };
  for (const sz of [-1, 1]) {
    seg(0, 0, E[0], E[1], sz * az);
    seg(E[0], E[1], R[0], R[1], sz * az);
    AB.cyl(A('aluminumBare'), 0.018, 0.045, E[0], E[1], sz * az, 'z', 12);       // elbow hinge
  }
  AB.cyl(A('aluminumBare'), 0.025, rwid + 0.1, 0, 0, 0, 'z', 14);                // pivot shaft
  AB.build(pivot);
  const roller = newGroup(pivot, R[0], R[1], 0), RB = new Batch();
  RB.cyl(A('aluminumBare'), 0.015, rwid + 0.05, 0, 0, 0, 'z', 10);
  const nW = Math.max(3, Math.round(rwid / 0.115));
  for (let i = 0; i < nW; i++) {
    const zz = -rwid / 2 + 0.05 + i * ((rwid - 0.1) / (nW - 1));
    RB.tire(getMaterial('compliantWheel', wheelColor), 0.05, 0.085, 0, 0, zz);
    RB.cyl(A('aluminumBare'), 0.026, 0.09, 0, 0, zz, 'z', 14);
  }
  RB.build(roller);
  const STOW = (INTAKE.stowDeg - Math.atan2(R[1], R[0]) * 180 / Math.PI) * Math.PI / 180;   // rotation (about +z, forward end swings up/back)
  let dep = 0, spin = 0;
  function update(on, rolling, dt) {
    dep += ((on ? 1 : 0) - dep) * (1 - Math.exp(-dt * 12));
    spin += (rolling ? 22 : 0) * dt;
    pivot.rotation.z = STOW * (1 - dep);
    roller.rotation.z = -spin - pivot.rotation.z;                               // spin about its own axle regardless of arm angle
    if (lazy) pivot.visible = mount.visible = dep > 0.03;
  }
  update(false, false, 1);
  return { pivot, roller, update };
}

function makeMarker() {
  const marker = new THREE.Group(); marker.visible = false;
  const mmat = new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, depthTest: false });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 8, 32), mmat); ring.rotation.x = Math.PI / 2;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.3, 4), mmat); cone.rotation.x = Math.PI; cone.position.y = 0.3;
  marker.add(ring, cone); marker.renderOrder = 10;
  return marker;
}

// ---------- imported STL robots ----------
const FINISH_DEFAULT_TEAM = 0xe8731a;
function cadMaterial(finish, accent) {
  const side = THREE.DoubleSide;
  if (finish === 'black') return getMaterial('powderCoat', 0x16181b, { side, roughness: 0.55 });
  if (finish === 'team') return getMaterial('powderCoat', accent ?? FINISH_DEFAULT_TEAM, { side });
  return getMaterial('aluminumSatin', undefined, { side });
}

function createMeshModel(robot, geo) {
  const model = robot.preset.model, ud = geo.userData || {};
  const fp = ud.footprint || model.footprint || { x: 0.76, z: 0.76 };
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const m = new THREE.Mesh(geo, cadMaterial(model.finish || robot.finish || 'aluminum', model.accent));
  m.castShadow = m.receiveShadow = true;
  body.add(m);
  const b = Math.min(ROBOT.bumper, 0.09);
  body.add(createBumper(fp.x, fp.z, robot.alliance, robot.number, b));
  const frontX = fp.x / 2 + b, canUp = robot.preset.canUpper;
  const lift = createLift(body, {
    mastX: -fp.x / 2 + 0.05, zr: canUp ? 0.14 : 0.2, tall: canUp ? 0.95 : 0.7, n: canUp ? 3 : 2, frameM: getMaterial('aluminumAnodized'),
    acc: getMaterial('powderCoat', model.accent ?? FINISH_DEFAULT_TEAM), xA0: frontX - 0.04, yA0: 0.6, lazy: true,
  });
  const intake = buildIntake(body, { frontX, rwid: Math.max(0.3, fp.z * 0.7), frameM: getMaterial('aluminumAnodized'), wheelColor: 0x2f3136, lazy: true });
  const marker = makeMarker(); root.add(marker);
  const top = (ud.height || model.height || 0.8) + 0.6;
  let t = 0;
  function update(rs, dt = 0.016, isPlayer = rs.isPlayer) {
    t += dt;
    root.position.set(rs.x, rs.y || 0, rs.z);
    root.rotation.y = -rs.heading;
    lift.step(rs, dt);
    lift.carriage.visible = lift.carriage.visible || (rs.held && rs.held.length > 0);
    intake.update(!!(rs.intakeOn || (rs.action && rs.action.type === 'intake')), !!rs.intakeOn, dt);
    marker.visible = !!isPlayer;
    if (isPlayer) { marker.position.y = top + Math.sin(t * 3) * 0.08; marker.rotation.y = t * 1.5; }
  }
  update({ ...robot, x: 0, z: 0, heading: 0, armTier: 'stow', arm: 0, action: null }, 1);
  return { object: root, update, carry: lift.carries[0], carries: lift.carries, lift: lift.state, root };
}

// ---------- procedural robots ----------
function swerveModule(S, sx, sz, h, frameM) {
  const x = sx * (h - 0.085), z = sz * (h - 0.078), wr = 0.05;
  S.tire(A('rubber'), wr, 0.034, x, wr, z);
  S.cyl(A('aluminumBare'), 0.027, 0.04, x, wr, z, 'z', 18);
  S.cyl(A('plastic'), 0.012, 0.05, x, wr, z, 'z', 10);
  for (const dz of [-0.024, 0.024]) S.box(frameM, 0.1, 0.1, 0.007, x, 0.075, z + dz, 0.004);
  S.box(A('aluminumAnodized'), 0.1, 0.035, 0.07, x, 0.13, z, 0.006);
  S.cyl(A('motor'), 0.02, 0.07, x, 0.135, z - sz * 0.068, 'z', 14);        // drive motor
  S.cyl(A('motor'), 0.018, 0.06, x - sx * 0.06, 0.135, z, 'y', 14);        // steer motor
  S.cyl(A('aluminumBare'), 0.012, 0.012, x - sx * 0.06, 0.168, z, 'y', 10);
}
function tankDrive(S, h, tread, frameM) {
  for (const sz of [-1, 1]) {
    const z = sz * (h - 0.062);
    for (const x of [-0.28, 0, 0.28]) {
      S.tire(getMaterial('compliantWheel', tread), 0.0508, 0.045, x, 0.0508, z);
      S.cyl(A('aluminumBare'), 0.026, 0.05, x, 0.0508, z, 'z', 16);
      S.cyl(A('plastic'), 0.01, 0.06, x, 0.0508, z, 'z', 10);
    }
    for (const y of [0.0508 + 0.032, 0.0508 - 0.032]) S.box(A('steelChain'), 0.56, 0.007, 0.012, 0, y, z + sz * 0.034, 0.002);
    S.box(frameM, 0.62, 0.05, 0.01, 0, 0.0508, sz * (h - 0.034), 0.003);   // drive rail plate
    S.cyl(A('motor'), 0.027, 0.1, -0.2, 0.1, sz * 0.2, 'x', 16);
    S.box(A('aluminumAnodized'), 0.09, 0.07, 0.07, -0.3, 0.1, sz * 0.2, 0.006);
  }
}

export function createRobotModel(robot) {
  const preset = robot.preset || {};
  const pm = preset.model || {};
  if (pm.kind === 'mesh') {
    const geo = getMeshSync(pm.meshId);
    if (geo) return createMeshModel(robot, geo);
  }
  const id = (pm.kind === 'procedural' && pm.style) || preset.id || 'stacker';
  const accentHex = pm.accent !== undefined ? pm.accent : FINISH_DEFAULT_TEAM;
  const acc = accentMat(accentHex);
  const frameM = pm.frame === 'silver' ? A('aluminumSatin') : A('aluminumAnodized');
  const root = new THREE.Group();
  const body = new THREE.Group();   // slight pitch/roll room
  root.add(body);
  const s = ROBOT.size, h = s / 2, b = ROBOT.bumper;
  const tank = (preset.drive || (id === 'tosser' ? 'tank' : 'swerve')) === 'tank';

  // ---- chassis (static, merged per material) ----
  const S = new Batch();
  const rw = 0.025, rh = 0.05;
  for (const sz of [-1, 1]) S.box(frameM, s, rh, rw, 0, 0.065, sz * (h - rw / 2), 0.005);
  for (const sx of [-1, 1]) S.box(frameM, rw, rh, s - 2 * rw - 0.002, sx * (h - rw / 2), 0.065, 0, 0.005);
  for (const x of [-0.17, 0.17]) S.box(frameM, rw, rh * 0.8, s - 2 * rw - 0.002, x, 0.065, 0, 0.004);
  S.box(A('aluminumSatin'), 0.7, 0.005, 0.7, 0, 0.092, 0, 0.002);                          // deck plate
  // electronics: battery, PDH, rio on a polycarb panel
  S.box(A('polycarbClear'), 0.34, 0.004, 0.3, 0.12, 0.125, -0.05, 0.001);
  S.box(A('plastic'), 0.18, 0.075, 0.075, 0.1, 0.133, 0.24, 0.006);                        // battery
  S.box(A('plastic'), 0.06, 0.012, 0.08, 0.1, 0.17, 0.24, 0.003);      // battery strap/label
  S.box(getMaterial('plastic', 0x8c1a1f), 0.1, 0.03, 0.06, 0.18, 0.145, -0.1, 0.004);      // PDH
  S.box(A('plastic'), 0.14, 0.03, 0.09, 0.07, 0.145, -0.14, 0.004);    // roboRIO
  S.box(A('plastic'), 0.05, 0.04, 0.05, 0.2, 0.15, 0.06, 0.004);       // radio / VRM
  for (const [x, z] of [[0.22, -0.2], [0, -0.2], [0.22, 0.08], [0, 0.08]]) S.cyl(A('aluminumSatin'), 0.006, 0.03, x, 0.108, z, 'y', 8);
  if (tank) tankDrive(S, h, pm.tread ?? 0x3f8f52, frameM);
  else for (const sx of [-1, 1]) for (const sz of [-1, 1]) swerveModule(S, sx, sz, h, frameM);

  // ---- lift: multi-stage elevator + telescoping claw arm (S.build below merges the static chassis) ----
  const tall = pm.mastHeight || (id === 'climber' ? 1.3 : id === 'stacker' ? 1.0 : 0.85);
  const canUpper = preset.canUpper !== undefined ? preset.canUpper : (id === 'stacker' || id === 'climber');
  const wide = !canUpper && id !== 'climber';
  const zr = wide ? 0.3 : 0.13, mastX = wide ? -0.3 : -0.34;
  const lowStow = id === 'sweeper' || id === 'tosser';
  const lift = createLift(body, { mastX, zr, tall, n: canUpper ? 3 : 2, frameM, acc, xA0: lowStow ? 0.47 : 0.30, yA0: lowStow ? 0.62 : 0.55, lazy: false });
  const carries = lift.carries;
  const tallB = lift.top;

  // ---- flip-down intake roller (flex wheels on a shaft) ----
  const rwid = id === 'sweeper' ? 0.86 : 0.6;
  const intake = buildIntake(body, { frontX: h + b, rwid, frameM, wheelColor: id === 'sweeper' ? accentHex : 0x2f3136 });

  // ---- style extras ----
  const wheels = []; let hooks = null;
  if (id === 'sweeper') {
    S.box(frameM, 0.1, 0.2, 1.0, h - 0.30, 0.24, 0, 0.008);
    S.box(A('polycarbSmoked'), 0.2, 0.006, 0.96, h - 0.29, 0.36, 0, 0.001, 0, 0, -0.35);
    for (const sz of [-1, 1]) {
      S.box(A('aluminumSatin'), 0.3, 0.06, 0.04, h - 0.3, 0.17, sz * 0.46, 0.006);
      S.box(acc, 0.12, 0.1, 0.03, h - 0.24, 0.2, sz * 0.5, 0.005);
    }
    S.box(acc, 0.04, 0.16, 0.9, h - 0.25, 0.32, 0, 0.006);
  }
  if (id === 'tosser') {
    const sh = newGroup(body, -0.1, 0.9, 0); sh.rotation.z = Math.PI / 6; // sits above the claw arm's travel (arm rides ~0.45-0.6 m)
    for (const sz of [-1, 1]) S.box(frameM, 0.04, 0.62, 0.04, -0.1, 0.5, sz * 0.2, 0.004);              // shooter towers
    const HB = new Batch();
    for (const sz of [-1, 1]) {
      HB.box(A('polycarbSmoked'), 0.72, 0.3, 0.012, 0.0, 0.0, sz * 0.18, 0.004);
      HB.box(A('aluminumSatin'), 0.75, 0.025, 0.04, 0.0, -0.155, sz * 0.18, 0.004);
      HB.box(A('aluminumSatin'), 0.75, 0.025, 0.04, 0.0, 0.155, sz * 0.18, 0.004);
      HB.cyl(A('plastic'), 0.03, 0.08, 0.2, 0.12, sz * 0.24, 'z', 16);
      HB.cyl(A('plastic'), 0.03, 0.08, 0.38, 0.12, sz * 0.24, 'z', 16);
    }
    HB.box(A('aluminumSatin'), 0.72, 0.012, 0.36, 0, 0.17, 0, 0.003);
    HB.box(A('aluminumSatin'), 0.2, 0.2, 0.36, -0.28, 0, 0, 0.006);
    HB.box(acc, 0.04, 0.12, 0.34, -0.14, 0.02, 0, 0.005);
    HB.cyl(A('plastic'), 0.012, 0.36, 0.2, 0.12, 0, 'z', 10);
    HB.cyl(A('plastic'), 0.012, 0.36, 0.38, 0.12, 0, 'z', 10);
    HB.build(sh);
    for (const dx of [0.2, 0.38]) {
      const w = newGroup(sh, dx, 0.12, 0), WB = new Batch();
      WB.tire(getMaterial('compliantWheel', 0x3f8f52), 0.075, 0.1, 0, 0, -0.09);
      WB.tire(getMaterial('compliantWheel', 0x3f8f52), 0.075, 0.1, 0, 0, 0.09);
      WB.cyl(acc, 0.04, 0.3, 0, 0, 0, 'z', 18);
      
      WB.build(w); wheels.push(w);
    }
  }
  if (id === 'climber') {
    hooks = newGroup(body, mastX + 0.08, tallB - 0.05, 0);
    const HB = new Batch();
    for (const z of [-0.375, 0.375]) {
      HB.box(A('aluminumBare'), 0.045, 0.3, 0.045, 0, 0.15, z, 0.005);
      HB.geo(A('steelZinc'), new THREE.TorusGeometry(0.1, 0.022, 10, 20, Math.PI), 0.1, 0.3, z);
      HB.box(acc, 0.06, 0.05, 0.065, 0, 0.02, z, 0.005);
      HB.cyl(A('steelZinc'), 0.022, 0.05, 0.2, 0.3, z, 'z', 10);
    }
    HB.box(frameM, 0.04, 0.04, 0.75, 0, 0.0, 0, 0.004);
    HB.build(hooks);
    // winch drum + brake at the base of the mast
    S.cyl(A('plastic'), 0.04, 0.3, -0.2, 0.14, 0, 'z', 18);
    S.cyl(acc, 0.055, 0.02, -0.2, 0.14, 0.17, 'z', 18);
    S.cyl(acc, 0.055, 0.02, -0.2, 0.14, -0.17, 'z', 18);
  }
  if (id === 'stacker') {
    S.box(A('aluminumAnodized'), 0.2, 0.1, 0.3, -0.1, 0.17, 0, 0.008);      // elevator gearbox
    S.cyl(A('motor'), 0.03, 0.09, -0.1, 0.22, 0.2, 'x', 16);
    S.cyl(A('motor'), 0.03, 0.09, -0.1, 0.22, -0.2, 'x', 16);
  }
  S.build(body);

  // ---- bumpers ----
  body.add(createBumper(s, s, robot.alliance, robot.number, b));

  // player marker
  const marker = makeMarker();
  root.add(marker);

  let wspin = 0, t = 0;
  const markerY = tallB + 0.9;

  function update(rs, dt = 0.016, isPlayer = rs.isPlayer) {
    t += dt;
    root.position.set(rs.x, rs.y || 0, rs.z);
    root.rotation.y = -rs.heading;
    lift.step(rs, dt);
    intake.update(!!(rs.intakeOn || (rs.action && rs.action.type === 'intake')), !!rs.intakeOn, dt);
    const launching = rs.action && rs.action.type === 'launch';
    wspin += (launching ? 60 : 8) * dt;
    for (const w of wheels) w.rotation.z = wspin;
    if (hooks) {
      const c = rs.action && rs.action.type === 'climb' ? Math.min(1, (rs.action.t || 0) / (rs.action.duration || 1)) : (rs.support >= 2 ? 1 : 0);
      hooks.position.y = tallB - 0.05 + c * 0.25;
    }
    marker.visible = !!isPlayer;
    if (isPlayer) { marker.position.y = markerY + Math.sin(t * 3) * 0.08; marker.rotation.y = t * 1.5; }
  }
  update({ ...robot, x: 0, z: 0, heading: 0, armTier: 'stow', arm: 0, action: null }, 1);
  return { object: root, update, carry: carries[0], carries, lift: lift.state, root };
}
