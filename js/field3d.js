import * as THREE from 'three';
import { FIELD, SIDES, ALLIANCES, TUBE } from './config.js';
import { getTubeAssets } from './models.js';

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

export function buildField(scene) {
  const group = new THREE.Group(); group.name = 'field';
  const { halfL, halfW, wallHeight } = FIELD;
  const white = std(0xf2f4f6, { roughness: 0.4 });
  const wallGl = glass(0xe9f1f6, 0.38);

  // ground beyond field + carpet
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), std(0x2a2e38, { roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.03; ground.receiveShadow = true;
  group.add(ground);
  group.add(box(FIELD.length + 3, 0.04, FIELD.width + 3, std(0x1c1f27), 0, -0.03, 0, false)); // apron
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.length, FIELD.width), new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 1 }));
  carpet.rotation.x = -Math.PI / 2; carpet.receiveShadow = true;
  group.add(carpet);

  // long boundary walls (polycarbonate + rails)
  for (const s of [-1, 1]) {
    const z = s * (halfW + 0.03);
    group.add(box(FIELD.length + 0.2, wallHeight, 0.05, wallGl, 0, wallHeight / 2, z, false));
    group.add(box(FIELD.length + 0.2, 0.05, 0.1, white, 0, wallHeight, z));
    group.add(box(FIELD.length + 0.2, 0.08, 0.1, white, 0, 0.04, z));
  }

  const tapeW = std(0xf5f5f5, { roughness: 0.6 });
  group.add(flat({ x0: -0.03, x1: 0.03, z0: -halfW, z1: halfW }, tapeW, 0.011)); // midline

  const post = {};
  for (const a of ALLIANCES) {
    const S = SIDES[a], col = S.color;
    const solid = std(col, { roughness: 0.65 });
    const tp = std(col, { roughness: 0.6 });
    const dim = std(lighten(col, -0.0).multiplyScalar(0.55), { roughness: 0.6 });
    group.add(flat(S.floorArea, solid, 0.008));                                          // LEVEL 1 SCORING AREA
    tape(group, S.scoringZone, tp, 0.07);
    group.add(flat(S.loadingZone, std(col, { transparent: true, opacity: 0.55, depthWrite: false }), 0.007)); // loading zone
    tape(group, S.loadingZone, tp, 0.05);
    tape(group, S.platformZone, tp, 0.05);
    tape(group, S.l1Area, dim, 0.05);
    group.add(rectBox(S.shortWall, S.shortWall.height, solid));
    for (const p of S.platforms) {
      const w = p.x1 - p.x0, d = p.z1 - p.z0;
      const side = std(col, { roughness: 0.6 }), top = std(lighten(col, 0.55), { roughness: 0.35 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, p.height, d), [side, side, top, side, side, side]);
      m.position.set((p.x0 + p.x1) / 2, p.height / 2, (p.z0 + p.z1) / 2); m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
    // post wall
    post[a] = buildPostWall(a); group.add(post[a]);
    // loading end wall + chutes
    const lz = S.loadingZone, ex = (lz.x0 + lz.x1) / 2 < 0 ? -halfL : halfL;
    group.add(box(0.1, 1.0, lz.z1 - lz.z0, wallGl, ex + Math.sign(ex) * 0.05, 0.5, (lz.z0 + lz.z1) / 2, false));
    group.add(box(0.12, 0.06, lz.z1 - lz.z0, white, ex + Math.sign(ex) * 0.05, 1.0, (lz.z0 + lz.z1) / 2));
    for (const c of S.chutes) group.add(buildChute(c, col));
    // driver-station panels
    const dx = Math.sign(S.driverStationX) * (Math.abs(S.driverStationX) + 1.2);
    for (const z of [-2.7, 0, 2.7]) {
      group.add(box(0.1, 0.55, 2.5, solid, dx, 0.275, z));
      group.add(box(0.06, 1.45, 2.5, glass(lighten(col, 0.6), 0.28), dx, 1.275, z, false));
      group.add(box(0.12, 0.08, 2.5, std(0x2b2f36), dx, 2.03, z));
    }
  }

  // arena backdrop: bleachers along the long sides with instanced crowd
  const stand = std(0x555a66, { roughness: 0.8 });
  const crowdGeo = new THREE.BoxGeometry(0.3, 0.55, 0.25);
  const seats = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const zc = s * (6.0 + i * 1.0), hh = 0.4 * (i + 1) + 0.2;
      group.add(box(34, hh, 1.0, stand, 0, hh / 2 - 0.03, zc));
      for (let x = -16; x <= 16; x += 0.42) if (Math.random() < 0.78) seats.push([x + (Math.random() - 0.5) * 0.1, hh + 0.27, zc + s * 0.05]);
    }
    group.add(box(44, 9, 0.5, std(0x1a1d27, { roughness: 0.9 }), 0, 4.5, s * 14));         // back wall
    group.add(box(44, 0.8, 0.52, std(SIDES[s < 0 ? 'blue' : 'red'].color, { roughness: 0.6 }), 0, 6.2, s * 13.7)); // banner
    group.add(box(44, 0.15, 6, std(0x2c3040), 0, 0.25, s * 5.2)); // curb
  }
  const crowd = new THREE.InstancedMesh(crowdGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), seats.length);
  const mtx = new THREE.Matrix4(), col = new THREE.Color();
  seats.forEach((p, i) => {
    mtx.makeTranslation(p[0], p[1], p[2]); crowd.setMatrixAt(i, mtx);
    col.setHSL(Math.random(), 0.35, 0.12 + Math.random() * 0.2); crowd.setColorAt(i, col);
  });
  crowd.castShadow = false; crowd.receiveShadow = false;
  group.add(crowd);
  // end curtains
  for (const s of [-1, 1]) group.add(box(0.5, 9, 40, std(0x161922), s * 24, 4.5, 0, false));

  scene.add(group);
  return { group, carpet, postWalls: post, crowd };
}
