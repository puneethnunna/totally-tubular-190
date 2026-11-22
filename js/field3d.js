import * as THREE from 'three';
import { FIELD, SIDES, ALLIANCES, TUBE } from './config.js';
import { getTubeAssets } from './models.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Field palette sampled from the game CAD renders (ref/image1-3.png). Independent of robot bumper colors.
export const PALETTE = {
  carpet: '#454b5a', blue: '#1d42d6', red: '#d4262b', structure: '#909090', post: '#595959',
  shelf: '#b0bbc2', shelfFloor: '#7e8a92', chute: '#858585', peg: '#afbac2',
};
export const FIELD_COLOR = { blue: PALETTE.blue, red: PALETTE.red };

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...o });
const glass = (color, op) => std(color, { transparent: true, opacity: op, roughness: 0.15, metalness: 0.1, depthWrite: false });
const lighten = (c, f) => new THREE.Color(c).lerp(new THREE.Color(0xffffff), f);

function box(w, h, d, mat, x, y, z, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true;
  return m;
}
const rectBox = (r, h, mat, y0 = 0) => box(r.x1 - r.x0, h, r.z1 - r.z0, mat, (r.x0 + r.x1) / 2, y0 + h / 2, (r.z0 + r.z1) / 2);
function flat(r, mat, y) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), mat);
  m.rotation.x = -Math.PI / 2; m.position.set((r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2); m.receiveShadow = true;
  return m;
}
function tape(g, r, mat, w = 0.06, y = 0.012) {
  const t = (x0, x1, z0, z1) => g.add(flat({ x0, x1, z0, z1 }, mat, y));
  t(r.x0, r.x1, r.z0, r.z0 + w); t(r.x0, r.x1, r.z1 - w, r.z1);
  t(r.x0, r.x0 + w, r.z0, r.z1); t(r.x1 - w, r.x1, r.z0, r.z1);
}

function carpetTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#8a8d92'; g.fillRect(0, 0, 256, 256);
  const d = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < d.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n;
  }
  g.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(FIELD.length / 1.5, FIELD.width / 1.5);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function buildPostWall(a) {
  const S = SIDES[a], g = new THREE.Group();
  const { baseX, dirX } = S.posts[0], out = -dirX;
  const z0 = S.scoringZone.z0, z1 = S.scoringZone.z1, W = z1 - z0, zc = (z0 + z1) / 2;
  const dark = std(0x4a4d53, { roughness: 0.6 }), rail = std(0x33363b);
  g.add(box(0.12, 1.35, W, dark, baseX + out * 0.06, 0.675, zc));                       // lower wall
  g.add(box(0.03, 0.95, W, glass(0xaec8d8, 0.45), baseX + out * 0.015, 1.825, zc, false)); // glazed back
  g.add(box(0.34, 0.1, W, rail, baseX + dirX * 0.17, 2.25, zc));                         // top rail
  g.add(box(0.34, 0.06, W, std(0x7e8a93), baseX + dirX * 0.17, 1.38, zc));               // shelf floor
  for (let i = 0; i <= 3; i++) {                                                        // dividers
    const z = z0 + (W * i) / 3, e = i === 0 || i === 3;
    g.add(box(0.34, e ? 1.45 : 0.95, 0.06, rail, baseX + dirX * 0.17, e ? 1.6 : 1.85, e ? Math.min(Math.max(z, z0 + 0.03), z1 - 0.03) : z));
  }
  const pegM = std(0xd5d9de, { metalness: 0.8, roughness: 0.3 });
  for (const p of S.posts) {
    const len = Math.abs(p.tipX - p.baseX);
    const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 10), pegM);
    peg.rotation.z = Math.PI / 2; peg.position.set((p.baseX + p.tipX) / 2, p.y, p.z); peg.castShadow = true;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 12), pegM);
    head.rotation.z = Math.PI / 2; head.position.set(p.tipX, p.y, p.z);
    g.add(peg, head);
  }
  return g;
}

function buildChute(c, color) {
  const g = new THREE.Group();
  g.position.set(c.x, 0, c.z); g.rotation.y = -Math.atan2(c.dirZ, c.dirX);  // local +x = into field
  const body = std(0x585c63), gl = glass(0xcfe4f0, 0.3);
  g.add(box(1.0, 0.08, 0.8, body, -0.5, 0.04, 0));
  g.add(box(0.06, 1.1, 0.8, body, -1.0, 0.55, 0));
  for (const s of [-1, 1]) g.add(box(1.0, 1.1, 0.05, gl, -0.5, 0.55, s * 0.4, false));
  g.add(box(1.0, 0.05, 0.8, body, -0.5, 1.1, 0));
  const ramp = box(0.5, 0.05, 0.8, body, 0.2, 0.18, 0); ramp.rotation.z = -0.35; g.add(ramp);
  g.add(box(0.06, 0.35, 0.8, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }), -0.02, 0.3, 0));
  const { geometry, material } = getTubeAssets();
  for (const x of [-0.35, -0.62]) {
    const t = new THREE.Mesh(geometry, material);
    t.rotation.y = Math.PI / 2; t.position.set(x, TUBE.outerRadius + 0.1, 0); t.castShadow = true; g.add(t);
  }
  return g;
}

// Field structures come from the Onshape STL (assets/field.bin, see tools/stl_to_field.py).
// The procedural walls, pegs, chutes and platforms below stay as a stand-in until it loads,
// or for good if it can't be fetched.
const FIELD_URL = new URL('../assets/field.bin', import.meta.url);

// Groups drawn as clear polycarbonate: no shadows, no depth write, rendered after the opaque pass.
const CLEAR = new Set(['endwall', 'sidewall']);

function fieldMaterials() {
  // frsim-style presets: metals get the env map, painted/plastic parts stay matte.
  const alu = (c, rough = 0.34, env = 0.9) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.9, roughness: rough, envMapIntensity: env });
  const coat = (c, rough = 0.68, env = 0.35) => new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: rough, envMapIntensity: env });
  const clear = (c, op) => new THREE.MeshPhysicalMaterial({   // polycarbClear
    color: c, transparent: true, opacity: op, roughness: 0.06, metalness: 0, ior: 1.5, reflectivity: 0.6,
    clearcoat: 0.6, clearcoatRoughness: 0.05, envMapIntensity: 1.3, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const hdpe = (a, f = 0) => coat(new THREE.Color(PALETTE[a]).multiplyScalar(1.12 + f), 0.7, 0.1);   // HDPE-like low-gloss platform / wall plastic
  const apron = (a) => coat(new THREE.Color(PALETTE[a]).multiplyScalar(0.5), 0.6, 0.4);
  return {
    structure: alu(PALETTE.structure, 0.36, 0.8),
    rail: alu(PALETTE.structure, 0.30, 0.9),
    floor: new THREE.MeshStandardMaterial({ map: floorTexture(), bumpMap: fiberBump(), bumpScale: 0.6, roughness: 0.96, metalness: 0, envMapIntensity: 0.3, side: THREE.DoubleSide }),
    base: coat(0x23262d, 0.95, 0.1),
    chute: coat(PALETTE.chute, 0.6, 0.45),
    postwall: coat(PALETTE.post, 0.68, 0.35),
    endwall: clear(PALETTE.shelf, 0.42),
    sidewall: clear(0xd8e8f0, 0.16),
    post: new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 1, roughness: 0.26, envMapIntensity: 1 }),   // steelZinc
    ...Object.fromEntries(['blue', 'red'].flatMap((a) => [2, 3, 4].map((L) => [`platform-${a}-${L}`, hdpe(a)]))),
    'wall-blue': hdpe('blue'), 'wall-red': hdpe('red'),
    'station-blue': apron('blue'), 'station-red': apron('red'),
  };
}

// Long-wall plate heights along x for the +z side (the -z side is the (x,z)->(-x,-z) mirror), from the CAD.
const LONG_WALL = [[-8.23, -1.83, 0.432], [-1.83, 1.83, 1.194], [1.83, 5.18, 0.432], [5.18, 7.21, 0.216], [7.21, 8.23, 1.803]];

// Thin aluminum framing on the clear long walls: top + bottom rails and uprights at every height step.
function longWallFrame() {
  const parts = [], bx = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(g); };
  for (const sg of [1, -1]) {
    const z = sg * 3.835, segs = LONG_WALL.map(([a, b, h]) => (sg > 0 ? [a, b, h] : [-b, -a, h])).sort((p, q) => p[0] - q[0]);
    for (const [a, b, h] of segs) {
      bx(b - a, 0.05, 0.1, (a + b) / 2, h + 0.025, z);
      bx(b - a, 0.06, 0.1, (a + b) / 2, 0.03, z);
    }
    for (let i = 0; i <= segs.length; i++) {
      const x = i === 0 ? segs[0][0] : segs[i - 1][1], h = Math.max(i > 0 ? segs[i - 1][2] : 0, i < segs.length ? segs[i][2] : 0);
      bx(0.07, h + 0.05, 0.1, x, (h + 0.05) / 2, z);
    }
    // mid-span uprights on the long low sections so the panels read as framed lites
    for (const [a, b, h] of segs) if (b - a > 3.2) for (let k = 1; k < Math.round((b - a) / 1.6); k++) { const x = a + ((b - a) * k) / Math.round((b - a) / 1.6); bx(0.05, h, 0.09, x, h / 2, z); }
  }
  const m = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.9, roughness: 0.34, envMapIntensity: 0.9 }));
  m.name = 'long-wall-frame'; m.castShadow = true; m.receiveShadow = true;
  return m;
}

function noiseCanvas(n, amp, base) {
  const c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), d = g.createImageData(n, n);
  for (let i = 0; i < d.data.length; i += 4) { const v = base + (Math.random() - 0.5) * amp; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  g.putImageData(d, 0, 0);
  return c;
}

// Tiled carpet-fiber bump (own repeat, independent of the painted-zone map).
function fiberBump() {
  const t = new THREE.CanvasTexture(noiseCanvas(256, 255, 128));
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(FIELD.length / 0.6, FIELD.width / 0.6); t.anisotropy = 4;
  return t;
}

// Paints the zones onto the CAD carpet face, plus baked contact shadows under walls/platforms.
// UV (0,0) is the field corner at (-halfL, -halfW).
function floorTexture() {
  const W = 4096, H = Math.round(W * FIELD.width / FIELD.length), k = W / FIELD.length;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const R = (r, fill) => { g.fillStyle = fill; g.fillRect((r.x0 + FIELD.halfL) * k, (r.z0 + FIELD.halfW) * k, (r.x1 - r.x0) * k, (r.z1 - r.z0) * k); };
  const tapeIn = (r, col, w = 0.0508) => { // 2 in tape on the inside of a zone edge, like the CAD's split faces
    const { x0, x1, z0, z1 } = r;
    R({ x0, x1, z0, z1: z0 + w }, col); R({ x0, x1, z0: z1 - w, z1 }, col);
    R({ x0, x1: x0 + w, z0, z1 }, col); R({ x0: x1 - w, x1, z0, z1 }, col);
  };
  g.fillStyle = PALETTE.carpet; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'overlay'; g.globalAlpha = 0.2;
  g.fillStyle = g.createPattern(noiseCanvas(256, 255, 128), 'repeat'); g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  for (const a of ALLIANCES) {
    const S = SIDES[a], col = FIELD_COLOR[a];
    R(S.loadingZone, col);
    R(S.floorArea, col);
    tapeIn(S.scoringZone, col);
    tapeIn(S.platformZone, col);
  }
  // contact shadows: blurred dark halos around everything that stands on the carpet (the rects themselves are drawn off-canvas)
  const halo = (r, blur, a) => {
    g.save(); g.shadowColor = `rgba(0,0,0,${a})`; g.shadowBlur = blur * k; g.shadowOffsetX = 100000;
    g.fillStyle = '#000'; g.fillRect((r.x0 + FIELD.halfL) * k - 100000, (r.z0 + FIELD.halfW) * k, (r.x1 - r.x0) * k, (r.z1 - r.z0) * k); g.restore();
  };
  for (const a of ALLIANCES) {
    const S = SIDES[a];
    for (const p of S.platforms) { halo(p, 0.22, 0.55); halo(p, 0.06, 0.5); }
    halo(S.shortWall, 0.14, 0.5);
    const e = Math.sign(S.driverStationX);
    halo({ x0: e * FIELD.halfL - 0.05, x1: e * FIELD.halfL + 0.05, z0: -FIELD.halfW, z1: FIELD.halfW }, 0.3, 0.6);
  }
  for (const s of [-1, 1]) halo({ x0: -FIELD.halfL, x1: FIELD.halfL, z0: s * FIELD.halfW - 0.03, z1: s * FIELD.halfW + 0.03 }, 0.14, 0.4);
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// Creased normals straight from the welded indexed mesh: each corner averages the (area-weighted) normals of the
// faces around its vertex that lie within the crease angle, so pegs/cutouts/frames shade smooth while box edges
// stay crisp. Output is non-indexed (triangle order preserved, so index ranges double as vertex ranges).
function creasedGeometry(pos, idx, creaseDeg = 30) {
  const nT = idx.length / 3, cosT = Math.cos(THREE.MathUtils.degToRad(creaseDeg));
  const fn = new Float32Array(nT * 3), fa = new Float32Array(nT), nV = pos.length / 3;
  const cnt = new Uint32Array(nV + 1);
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z);
    if (l < 1e-12) { y = 1; fa[t] = 0; } else { x /= l; y /= l; z /= l; fa[t] = l; }
    fn[t * 3] = x; fn[t * 3 + 1] = y; fn[t * 3 + 2] = z;
    cnt[idx[t * 3] + 1]++; cnt[idx[t * 3 + 1] + 1]++; cnt[idx[t * 3 + 2] + 1]++;
  }
  for (let i = 0; i < nV; i++) cnt[i + 1] += cnt[i];
  const fill = cnt.slice(0, nV), adj = new Uint32Array(nT * 3);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) adj[fill[idx[t * 3 + k]]++] = t;
  const P = new Float32Array(nT * 9), N = new Float32Array(nT * 9), UV = new Float32Array(nT * 6);
  for (let t = 0; t < nT; t++) {
    const tx = fn[t * 3], ty = fn[t * 3 + 1], tz = fn[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k]; let x = 0, y = 0, z = 0;
      for (let j = cnt[v]; j < cnt[v + 1]; j++) {
        const f = adj[j], w = fa[f];
        if (f === t || tx * fn[f * 3] + ty * fn[f * 3 + 1] + tz * fn[f * 3 + 2] >= cosT) { x += fn[f * 3] * w; y += fn[f * 3 + 1] * w; z += fn[f * 3 + 2] * w; }
      }
      const l = Math.hypot(x, y, z) || 1, o = (t * 3 + k) * 3;
      N[o] = x / l; N[o + 1] = y / l; N[o + 2] = z / l;
      P[o] = pos[v * 3]; P[o + 1] = pos[v * 3 + 1]; P[o + 2] = pos[v * 3 + 2];
      UV[(t * 3 + k) * 2] = (P[o] + FIELD.halfL) / FIELD.length;           // top-down projection, only the floor samples it
      UV[(t * 3 + k) * 2 + 1] = (P[o + 2] + FIELD.halfW) / FIELD.width;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  return g;
}

export async function loadFieldModel(url = FIELD_URL) {
  const get = async (u) => { const r = await fetch(u).catch(() => null); return r && r.ok ? r.arrayBuffer() : null; };
  const good = (b) => b && b.byteLength > 8 && new DataView(b).getUint32(0, true) === 0x31465454;
  let buf = await get(url);
  if (!good(buf) && url === FIELD_URL) buf = await get(new URL('../assets/field.wasm', import.meta.url)); // same bytes, for hosts that won't serve .bin
  if (!buf) throw new Error('field model not found');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x31465454) throw new Error('field.bin: bad magic');   // 'TTF1'
  const hlen = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  const q = new Int16Array(buf, 8 + hlen, head.verts * 3);
  const pos = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) pos[i] = q[i] * head.scale;
  const idxOff = 8 + hlen + q.byteLength + (q.byteLength % 4);
  const idx = new Uint32Array(buf, idxOff, head.tris * 3);
  const mats = fieldMaterials();
  const out = new THREE.Group(); out.name = 'field-cad'; out.userData.mats = mats;
  for (const clearPass of [false, true]) {
    const list = [], chunks = [], groups = []; let n = 0;
    for (const [name, start, count] of head.groups) {
      if (CLEAR.has(name) !== clearPass) continue;
      const m = mats[name] || mats.structure;
      let i = list.indexOf(m); if (i < 0) i = list.push(m) - 1;
      chunks.push(idx.subarray(start, start + count)); groups.push([n, count, i]); n += count;
    }
    if (!n) continue;
    const ia = new Uint32Array(n); let o = 0; for (const c of chunks) { ia.set(c, o); o += c.length; }
    const geo = creasedGeometry(pos, ia, 30);
    for (const [st, c, mi] of groups) geo.addGroup(st, c, mi);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, list);
    mesh.name = clearPass ? 'field-cad-clear' : 'field-cad-solid';
    mesh.castShadow = !clearPass; mesh.receiveShadow = true; mesh.renderOrder = clearPass ? 2 : 0;
    out.add(mesh);
  }
  out.add(longWallFrame());
  return out;
}

export function buildField(scene) {
  const group = new THREE.Group(); group.name = 'field';
  const { halfL, halfW, wallHeight } = FIELD;
  const white = std(0xf2f4f6, { roughness: 0.4 });
  const wallGl = glass(0xe9f1f6, 0.38);

  // ground beyond field + carpet
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), std(0x1a1d25, { roughness: 1, envMapIntensity: 0.1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.03; ground.receiveShadow = true;
  group.add(ground);
  // Everything in standIn is a procedural copy shown until the CAD model loads (or if it can't).
  const standIn = new THREE.Group(); standIn.name = 'field-stand-in'; group.add(standIn);
  standIn.add(box(FIELD.length + 3, 0.04, FIELD.width + 3, std(0x1c1f27), 0, -0.03, 0, false)); // apron
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.length, FIELD.width), new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 1 }));
  carpet.rotation.x = -Math.PI / 2; carpet.receiveShadow = true;
  standIn.add(carpet);
  // long boundary walls (polycarbonate + rails)
  for (const s of [-1, 1]) {
    const z = s * (halfW + 0.03);
    standIn.add(box(FIELD.length + 0.2, wallHeight, 0.05, wallGl, 0, wallHeight / 2, z, false));
    standIn.add(box(FIELD.length + 0.2, 0.05, 0.1, white, 0, wallHeight, z));
    standIn.add(box(FIELD.length + 0.2, 0.08, 0.1, white, 0, 0.04, z));
  }

  const tapeW = std(0xf5f5f5, { roughness: 0.6 });
  standIn.add(flat({ x0: -0.03, x1: 0.03, z0: -halfW, z1: halfW }, tapeW, 0.011)); // midline (stand-in only; the CAD has none)

  const post = {};
  for (const a of ALLIANCES) {
    const S = SIDES[a], col = FIELD_COLOR[a];
    const solid = std(col, { roughness: 0.65 });
    const tp = std(col, { roughness: 0.6 });
    const dim = std(lighten(col, -0.0).multiplyScalar(0.55), { roughness: 0.6 });
    standIn.add(flat(S.floorArea, solid, 0.008));                                        // LEVEL 1 SCORING AREA
    tape(standIn, S.scoringZone, tp, 0.07);
    standIn.add(flat(S.loadingZone, std(col, { transparent: true, opacity: 0.55, depthWrite: false }), 0.007)); // loading zone
    tape(standIn, S.loadingZone, tp, 0.05);
    tape(standIn, S.platformZone, tp, 0.05);
    tape(standIn, S.l1Area, dim, 0.05);
    standIn.add(rectBox(S.shortWall, S.shortWall.height, solid));
    for (const p of S.platforms) {
      const w = p.x1 - p.x0, d = p.z1 - p.z0;
      const side = std(col, { roughness: 0.6 }), top = std(lighten(col, 0.55), { roughness: 0.35 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, p.height, d), [side, side, top, side, side, side]);
      m.position.set((p.x0 + p.x1) / 2, p.height / 2, (p.z0 + p.z1) / 2); m.castShadow = m.receiveShadow = true;
      standIn.add(m);
    }
    // post wall
    post[a] = buildPostWall(a); standIn.add(post[a]);
    // loading end wall + chutes
    const lz = S.loadingZone, ex = (lz.x0 + lz.x1) / 2 < 0 ? -halfL : halfL;
    standIn.add(box(0.1, 1.0, lz.z1 - lz.z0, wallGl, ex + Math.sign(ex) * 0.05, 0.5, (lz.z0 + lz.z1) / 2, false));
    standIn.add(box(0.12, 0.06, lz.z1 - lz.z0, white, ex + Math.sign(ex) * 0.05, 1.0, (lz.z0 + lz.z1) / 2));
    for (const c of S.chutes) standIn.add(buildChute(c, col));
    // driver-station panels
    const dx = Math.sign(S.driverStationX) * (Math.abs(S.driverStationX) + 1.2);
    for (const z of [-2.7, 0, 2.7]) {
      standIn.add(box(0.1, 0.55, 2.5, solid, dx, 0.275, z));
      standIn.add(box(0.06, 1.45, 2.5, glass(lighten(col, 0.6), 0.28), dx, 1.275, z, false));
      standIn.add(box(0.12, 0.08, 2.5, std(0x2b2f36), dx, 2.03, z));
    }
  }

  // arena backdrop: open steel bleachers along both long sides, sparse clustered crowd. Nothing here
  // overlaps the CAD footprint (|x| <= 8.75, |z| <= 4.33): the nearest bleacher rail is at |z| = 5.7.
  const stands = new THREE.Group(); stands.name = 'stands'; group.add(stands);
  buildStands(stands);
  // far walls + end curtains stay well outside the field
  for (const s of [-1, 1]) {
    stands.add(box(60, 11, 0.5, std(0x151822, { roughness: 0.9 }), 0, 5.5, s * 17));
    stands.add(box(60, 0.9, 0.52, std(s < 0 ? FIELD_COLOR.blue : FIELD_COLOR.red, { roughness: 0.6 }), 0, 7.2, s * 16.7));
    stands.add(box(0.5, 11, 36, std(0x12141c, { roughness: 0.9 }), s * 27, 5.5, 0, false));
  }

  scene.add(group);
  const result = { group, carpet, postWalls: post, stands, crowd: stands.userData.crowd, cad: null };
  result.ready = loadFieldModel().then((mesh) => {
    group.remove(standIn); group.add(mesh); result.cad = mesh;
    return mesh;
  }).catch((e) => { console.warn('Field CAD not loaded, using stand-in geometry:', e.message); return null; });
  return result;
}

function rng(seed) { // mulberry32: spectators/seat layout is the same every load
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Frsim-style bleachers: per row two seat planks, a footboard, a back rail, uprights and a stringer, all one
// InstancedMesh of unit boxes. Spectators: ~30% of seats, in a few clusters, as two instanced meshes.
function buildStands(stands) {
  const R = rng(20260101), steel = new THREE.MeshStandardMaterial({ color: 0xaab0b8, metalness: 0.7, roughness: 0.4 });
  const ROWS = 8, X0 = -17, X1 = 17, PITCH = 2.4, rows = [];
  const beams = [];   // [sx, sy, sz, x, y, z]
  for (const s of [-1, 1]) for (let i = 0; i < ROWS; i++) {
    const z = s * (6.0 + i * 0.85), h = 0.38 + i * 0.42;
    rows.push({ s, z, h });
    beams.push([X1 - X0, 0.04, 0.26, 0, h, z - s * 0.05]);              // seat plank
    beams.push([X1 - X0, 0.04, 0.2, 0, h - 0.02, z + s * 0.21]);        // seat plank 2
    beams.push([X1 - X0, 0.04, 0.3, 0, h - 0.4, z - s * 0.5]);          // footboard of the row below
    beams.push([X1 - X0, 0.05, 0.05, 0, h + 0.45, z + s * 0.36]);       // back rail
    beams.push([X1 - X0, 0.04, 0.04, 0, h + 0.2, z + s * 0.36]);        // mid rail
    for (let x = X0; x <= X1 + 0.01; x += PITCH) {
      beams.push([0.05, h + 0.45, 0.05, x, (h + 0.45) / 2, z + s * 0.36]);  // upright
      beams.push([0.04, 0.04, 0.88, x, h - 0.06, z]);                       // cross tie
    }
  }
  for (const s of [-1, 1]) for (let x = X0; x <= X1 + 0.01; x += PITCH) {   // raking stringers
    const z0 = s * 5.6, z1 = s * (6.0 + (ROWS - 1) * 0.85 + 0.4), h1 = 0.38 + (ROWS - 1) * 0.42 - 0.06;
    const len = Math.hypot(z1 - z0, h1), a = Math.atan2(h1, Math.abs(z1 - z0));
    beams.push([0.05, 0.05, len, x, h1 / 2, (z0 + z1) / 2, -a * s]);
  }
  const bm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, beams.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), ax = new THREE.Vector3(1, 0, 0);
  beams.forEach((b, i) => {
    q.setFromAxisAngle(ax, b[6] ? b[6] : 0);
    m4.compose(p.set(b[3], b[4], b[5]), q, sc.set(b[0], b[1], b[2])); bm.setMatrixAt(i, m4);
  });
  bm.instanceMatrix.needsUpdate = true; bm.castShadow = false; bm.receiveShadow = false; bm.frustumCulled = false;
  stands.add(bm);

  // seats -> clustered pick of ~30%
  const seats = [];
  for (const r of rows) for (let x = X0 + 0.4; x < X1; x += 0.46) seats.push({ x, r, sc: 0 });
  const cl = []; for (let i = 0; i < 14; i++) cl.push({ x: X0 + R() * (X1 - X0), s: R() < 0.5 ? -1 : 1, row: R() * ROWS, w: 1.5 + R() * 3, rw: 1 + R() * 2 });
  for (const t of seats) {
    const row = Math.round((t.r.z * t.r.s - 6.0) / 0.85);
    t.sc = R() * 0.55;
    for (const c of cl) if (c.s === t.r.s) t.sc += Math.exp(-(((t.x - c.x) / c.w) ** 2 + ((row - c.row) / c.rw) ** 2));
  }
  seats.sort((a, b) => b.sc - a.sc);
  const crowd = seats.slice(0, Math.round(seats.length * 0.3));
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.5, 0.22), new THREE.MeshStandardMaterial({ roughness: 0.9 }), crowd.length);
  const headM = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshStandardMaterial({ roughness: 0.8, color: 0xd9b59b }), crowd.length);
  const col = new THREE.Color(), skin = [0xe0b99f, 0xc68e6b, 0x8d5a3b, 0xf1cdb4, 0x6b4430];
  crowd.forEach((t, i) => {
    const y = t.r.h + 0.02;
    body.setMatrixAt(i, m4.makeTranslation(t.x, y + 0.27, t.r.z + t.r.s * 0.15));
    headM.setMatrixAt(i, m4.makeTranslation(t.x, y + 0.62, t.r.z + t.r.s * 0.15));
    col.setHSL(R(), 0.3, 0.06 + R() * 0.16); body.setColorAt(i, col);
    headM.setColorAt(i, col.setHex(skin[(R() * skin.length) | 0]));
  });
  for (const m of [body, headM]) { m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; stands.add(m); }
  stands.userData.crowd = body;
}
