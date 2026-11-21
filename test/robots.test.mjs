import assert from 'node:assert/strict';
import { parseSTL, prepareRobotMeshData, packMesh, unpackMesh, decimate } from '../js/stlImport.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

// 30x30x20 in box in mm, Z-up, origin at a corner far from zero
function boxSTL(w, d, h, off = [100, -50, 7]) {
  const v = (x, y, z) => [x * w + off[0], y * d + off[1], z * h + off[2]];
  const quads = [[[0,0,0],[1,0,0],[1,1,0],[0,1,0]], [[0,0,1],[0,1,1],[1,1,1],[1,0,1]], [[0,0,0],[0,0,1],[1,0,1],[1,0,0]],
    [[0,1,0],[1,1,0],[1,1,1],[0,1,1]], [[0,0,0],[0,1,0],[0,1,1],[0,0,1]], [[1,0,0],[1,0,1],[1,1,1],[1,1,0]]];
  const tris = quads.flatMap(([a, b, c, e]) => [[a, b, c], [a, c, e]]);
  const buf = new ArrayBuffer(84 + 50 * tris.length), dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.forEach((p, j) => v(...p).forEach((c, k) => dv.setFloat32(84 + i * 50 + 12 + (j * 3 + k) * 4, c, true))));
  return buf;
}
const MM = 25.4;

test('parseSTL binary', () => {
  const p = parseSTL(boxSTL(30 * MM, 30 * MM, 20 * MM));
  assert.equal(p.triCount, 12); assert.equal(p.positions.length, 108);
});
test('parseSTL binary with "solid" header', () => {
  const b = boxSTL(30 * MM, 30 * MM, 20 * MM);
  new Uint8Array(b).set(new TextEncoder().encode('solid exported by CAD'), 0);
  assert.equal(parseSTL(b).triCount, 12);
});
test('parseSTL ASCII', () => {
  const t = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1e0 0\nendloop\nendfacet\nendsolid x\n';
  const p = parseSTL(new TextEncoder().encode(t).buffer);
  assert.equal(p.triCount, 1); assert.equal(p.positions[3], 1);
});
test('prepareRobotMeshData: mm, Z-up, centered, on floor', () => {
  const r = prepareRobotMeshData(parseSTL(boxSTL(30 * MM, 30 * MM, 20 * MM)));
  assert.equal(r.units, 'mm');
  assert.ok(Math.abs(r.footprint.x - 0.762) < 1e-3 && Math.abs(r.footprint.z - 0.762) < 1e-3);
  assert.ok(Math.abs(r.height - 0.508) < 1e-3);
  let minY = Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < r.positions.length; i += 3) { minY = Math.min(minY, r.positions[i + 1]); minX = Math.min(minX, r.positions[i]); maxX = Math.max(maxX, r.positions[i]); }
  assert.ok(Math.abs(minY) < 1e-6); assert.ok(Math.abs(minX + maxX) < 1e-6);
  assert.ok(r.radius >= 0.42 && r.radius <= 0.65);
});
test('units auto: inches and meters; rotate swaps footprint', () => {
  assert.equal(prepareRobotMeshData(parseSTL(boxSTL(30, 30, 20))).units, 'in');
  assert.equal(prepareRobotMeshData(parseSTL(boxSTL(0.76, 0.76, 0.5))).units, 'm');
  const r = prepareRobotMeshData(parseSTL(boxSTL(1000, 500, 300)), { units: 'mm', upAxis: 'y', rotateY: 90 });
  assert.ok(Math.abs(r.footprint.x - 0.3) < 1e-3 && Math.abs(r.footprint.z - 1) < 1e-3 && Math.abs(r.height - 0.5) < 1e-3);
});
test('decimation caps triangle count', () => {
  const N = 300, pos = new Float32Array(N * N * 18);
  let o = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    for (const [a, b] of [[0,0],[1,0],[0,1],[1,0],[1,1],[0,1]]) { pos[o++] = i + a; pos[o++] = j + b; pos[o++] = Math.sin(i * 0.1 + j * 0.1); }
  }
  const d = decimate(pos, 20000);
  assert.ok(d.length / 9 <= 20000 && d.length > 0);
});
test('pack/unpack roundtrip', () => {
  const r = prepareRobotMeshData(parseSTL(boxSTL(30 * MM, 30 * MM, 20 * MM)));
  const u = unpackMesh(packMesh(r));
  for (let i = 0; i < r.positions.length; i++) assert.ok(Math.abs(u.positions[i] - r.positions[i]) < 1e-4);
});
console.log(`${n} passed`);
