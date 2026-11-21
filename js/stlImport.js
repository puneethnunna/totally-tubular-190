// STL parsing + robot-mesh preparation. The core (parseSTL, prepareRobotMeshData, pack/unpack) is THREE-free so it runs in Node.
export const MAX_TRIS = 150000;

export function parseSTL(buf) {
  if (buf.buffer && !(buf instanceof ArrayBuffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const len = buf.byteLength;
  if (len >= 84) {
    const n = new DataView(buf).getUint32(80, true);
    if (84 + 50 * n === len) return parseBinary(buf, n);
  }
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(len, 512)));
  if (/^\s*solid/i.test(head) && /facet|vertex/i.test(head)) {
    const r = parseASCII(buf);
    if (r.triCount) return r;
  }
  if (len >= 84) return parseBinary(buf, Math.min(new DataView(buf).getUint32(80, true), Math.floor((len - 84) / 50)));
  throw new Error('Not a valid STL file');
}

function parseBinary(buf, n) {
  const dv = new DataView(buf), positions = new Float32Array(n * 9);
  for (let i = 0, o = 84; i < n; i++, o += 50) {
    for (let k = 0; k < 9; k++) positions[i * 9 + k] = dv.getFloat32(o + 12 + k * 4, true);
  }
  return { positions, triCount: n };
}

function parseASCII(buf) {
  const text = new TextDecoder().decode(buf);
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let arr = new Float32Array(30000), n = 0, m;
  while ((m = re.exec(text))) {
    if (n + 3 > arr.length) { const a = new Float32Array(arr.length * 2); a.set(arr); arr = a; }
    arr[n++] = +m[1]; arr[n++] = +m[2]; arr[n++] = +m[3];
  }
  const triCount = Math.floor(n / 9);
  return { positions: arr.slice(0, triCount * 9), triCount };
}

function bounds(p) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = p[i + k];
    if (v < b[k]) b[k] = v;
    if (v > b[k + 3]) b[k + 3] = v;
  }
  return b;
}

// Vertex clustering: snap vertices to a grid, average per cell, drop collapsed triangles.
export function decimate(p, target = MAX_TRIS) {
  if (p.length / 9 <= target) return p;
  const b = bounds(p), ext = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1;
  let N = 700, out = p;
  for (let pass = 0; pass < 12; pass++, N = Math.floor(N * 0.8)) {
    out = cluster(p, b, ext / N);
    if (out.length / 9 <= target) break;
  }
  return out;
}

function cluster(p, b, cell) {
  const nv = p.length / 3, map = new Map(), vid = new Int32Array(nv);
  const sum = [], cnt = [];
  const K = 2048;
  for (let i = 0; i < nv; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const key = Math.floor((x - b[0]) / cell) + K * (Math.floor((y - b[1]) / cell) + K * Math.floor((z - b[2]) / cell));
    let id = map.get(key);
    if (id === undefined) { id = cnt.length; map.set(key, id); cnt.push(0); sum.push(0, 0, 0); }
    vid[i] = id; cnt[id]++; sum[id * 3] += x; sum[id * 3 + 1] += y; sum[id * 3 + 2] += z;
  }
  const out = new Float32Array(p.length);
  let n = 0;
  for (let t = 0; t < nv; t += 3) {
    const a = vid[t], c = vid[t + 1], d = vid[t + 2];
    if (a === c || c === d || a === d) continue;
    for (const v of [a, c, d]) for (let k = 0; k < 3; k++) out[n++] = sum[v * 3 + k] / cnt[v];
  }
  return out.slice(0, n);
}

export function detectUnits(p) {
  const b = bounds(p), ext = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
  return ext > 100 ? 'mm' : ext > 8 ? 'in' : 'm';
}
const UNIT_SCALE = { mm: 0.001, in: 0.0254, m: 1 };

// parsed {positions} -> { positions (m, y-up, centered on footprint, on y=0, front +x), triCount, footprint:{x,z}, height, radius, units }
export function prepareRobotMeshData(parsed, { units = 'auto', upAxis = 'z', rotateY = 0 } = {}) {
  const src = parsed.positions;
  const u = units === 'auto' ? detectUnits(src) : units, s = UNIT_SCALE[u];
  const up = upAxis.toLowerCase() === 'z';
  const a = ((rotateY % 360) + 360) % 360 * Math.PI / 180, ca = Math.round(Math.cos(a)), sa = Math.round(Math.sin(a));
  const p = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    let x = src[i] * s, y = src[i + 1] * s, z = src[i + 2] * s;
    if (up) { const t = y; y = z; z = -t; }   // Z-up -> Y-up (rotate -90 deg about x)
    p[i] = x * ca + z * sa; p[i + 1] = y; p[i + 2] = -x * sa + z * ca;
  }
  const d = decimate(p), b = bounds(d);
  const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2, y0 = b[1];
  for (let i = 0; i < d.length; i += 3) { d[i] -= cx; d[i + 1] -= y0; d[i + 2] -= cz; }
  const fx = b[3] - b[0], fz = b[5] - b[2];
  const radius = Math.min(0.65, Math.max(0.42, Math.hypot(fx, fz) / 2));
  return { positions: d, triCount: d.length / 9, footprint: { x: fx, z: fz }, height: b[4] - b[1], radius, units: u };
}

// Compact storage: 16-bit quantisation inside the bounding box.
export function packMesh(data) {
  const p = data.positions, b = bounds(p), q = new Uint16Array(p.length);
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    const r = b[k + 3] - b[k] || 1;
    q[i + k] = Math.round((p[i + k] - b[k]) / r * 65535);
  }
  return { q, min: b.slice(0, 3), max: b.slice(3), footprint: data.footprint, height: data.height, radius: data.radius, units: data.units };
}
export function unpackMesh(m) {
  const q = m.q, p = new Float32Array(q.length);
  for (let i = 0; i < q.length; i += 3) for (let k = 0; k < 3; k++) p[i + k] = m.min[k] + q[i + k] / 65535 * (m.max[k] - m.min[k]);
  return { positions: p, triCount: p.length / 9, footprint: m.footprint, height: m.height, radius: m.radius, units: m.units };
}

export function geometryFromData(THREE, data) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.computeVertexNormals();   // non-indexed -> flat shading
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData = { footprint: data.footprint, height: data.height, radius: data.radius, triCount: data.triCount };
  return g;
}

export async function prepareRobotMesh(parsed, opts) {
  const THREE = await import('three');
  const data = prepareRobotMeshData(parsed, opts);
  return { geometry: geometryFromData(THREE, data), ...data };
}
