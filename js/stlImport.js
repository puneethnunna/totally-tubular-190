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

// Vertex clustering with quadric-ish vertex placement (keeps sharp edges / silhouettes much cleaner than plain averaging).
// The grid is searched for the FINEST cell size whose result fits the triangle budget.
export function decimate(p, target = MAX_TRIS) {
  if (p.length / 9 <= target) return p;
  const b = bounds(p), ext = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1;
  const nv = p.length / 3, K = 4096;
  const ids = (N) => {   // cell id per vertex + surviving triangle count
    const cell = ext / N, map = new Map(), vid = new Int32Array(nv);
    let cells = 0;
    for (let i = 0; i < nv; i++) {
      const key = Math.floor((p[i * 3] - b[0]) / cell) + K * (Math.floor((p[i * 3 + 1] - b[1]) / cell) + K * Math.floor((p[i * 3 + 2] - b[2]) / cell));
      let id = map.get(key);
      if (id === undefined) { id = cells++; map.set(key, id); }
      vid[i] = id;
    }
    let tris = 0;
    for (let t = 0; t < nv; t += 3) if (vid[t] !== vid[t + 1] && vid[t + 1] !== vid[t + 2] && vid[t] !== vid[t + 2]) tris++;
    return { vid, cells, tris, cell };
  };
  // N = cells along the longest axis; surviving tris grow ~N^2. One probe, then a short bracketed binary search.
  const r0 = ids(500);
  let best = r0.tris <= target ? r0 : null;
  const guess = Math.max(6, Math.round(500 * Math.sqrt(target / Math.max(1, r0.tris))));
  let lo = Math.max(6, Math.floor(guess * 0.6)), hi = Math.min(3000, Math.ceil(guess * 1.5));
  if (best) lo = Math.max(lo, 501);
  for (let it = 0; it < 6 && lo <= hi; it++) {
    const mid = (lo + hi) >> 1, r = ids(mid);
    if (r.tris <= target) { best = r; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) best = ids(6);
  return placeCluster(p, best);
}

function placeCluster(p, { vid, cells, cell }) {
  const nv = p.length / 3;
  const cnt = new Float64Array(cells), sum = new Float64Array(cells * 3);
  const Q = new Float64Array(cells * 10);    // A(6: xx xy xz yy yz zz), b(3), w
  for (let i = 0; i < nv; i++) { const c = vid[i]; cnt[c]++; sum[c * 3] += p[i * 3]; sum[c * 3 + 1] += p[i * 3 + 1]; sum[c * 3 + 2] += p[i * 3 + 2]; }
  for (let t = 0; t < nv; t += 3) {
    const o = t * 3;
    const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
    const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area2 = Math.hypot(nx, ny, nz);
    if (area2 < 1e-18) continue;
    nx /= area2; ny /= area2; nz /= area2;
    const d = -(nx * p[o] + ny * p[o + 1] + nz * p[o + 2]), w = area2;   // area-weighted
    for (let k = 0; k < 3; k++) {
      const c = vid[t + k] * 10;
      Q[c] += w * nx * nx; Q[c + 1] += w * nx * ny; Q[c + 2] += w * nx * nz;
      Q[c + 3] += w * ny * ny; Q[c + 4] += w * ny * nz; Q[c + 5] += w * nz * nz;
      Q[c + 6] -= w * d * nx; Q[c + 7] -= w * d * ny; Q[c + 8] -= w * d * nz; Q[c + 9] += w;
    }
  }
  const pos = new Float32Array(cells * 3);
  for (let c = 0; c < cells; c++) {
    const mx = sum[c * 3] / cnt[c], my = sum[c * 3 + 1] / cnt[c], mz = sum[c * 3 + 2] / cnt[c], q = c * 10;
    const lam = 0.08 * (Q[q] + Q[q + 3] + Q[q + 5]) / 3 + 1e-12;     // regularise toward the centroid
    const a = Q[q] + lam, bb = Q[q + 1], cc = Q[q + 2], d = Q[q + 3] + lam, e = Q[q + 4], f = Q[q + 5] + lam;
    const r0 = Q[q + 6] + lam * mx, r1 = Q[q + 7] + lam * my, r2 = Q[q + 8] + lam * mz;
    const det = a * (d * f - e * e) - bb * (bb * f - e * cc) + cc * (bb * e - d * cc);
    let x = mx, y = my, z = mz;
    if (Math.abs(det) > 1e-30) {
      x = (r0 * (d * f - e * e) - bb * (r1 * f - e * r2) + cc * (r1 * e - d * r2)) / det;
      y = (a * (r1 * f - e * r2) - r0 * (bb * f - e * cc) + cc * (bb * r2 - r1 * cc)) / det;
      z = (a * (d * r2 - r1 * e) - bb * (bb * r2 - r1 * cc) + r0 * (bb * e - d * cc)) / det;
      const lim = cell * 0.75;     // never wander far from the centroid
      if (!(Math.abs(x - mx) < lim && Math.abs(y - my) < lim && Math.abs(z - mz) < lim)) { x = mx; y = my; z = mz; }
    }
    pos[c * 3] = x; pos[c * 3 + 1] = y; pos[c * 3 + 2] = z;
  }
  const out = new Float32Array(p.length);
  let n = 0;
  for (let t = 0; t < nv; t += 3) {
    const a = vid[t], c = vid[t + 1], d = vid[t + 2];
    if (a === c || c === d || a === d) continue;
    for (const v of [a, c, d]) { out[n++] = pos[v * 3]; out[n++] = pos[v * 3 + 1]; out[n++] = pos[v * 3 + 2]; }
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

// robots.js registers BufferGeometryUtils.toCreasedNormals here (keeps this module THREE-free for Node tests).
let creaseFn = null;
export const CREASE_ANGLE = Math.PI / 6;   // 30 deg
export function setCreaseFn(fn) { creaseFn = fn; }

export function geometryFromData(THREE, data) {
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  if (creaseFn) { const c = creaseFn(g, CREASE_ANGLE); g.dispose(); g = c; }   // smooth curved parts, keep hard edges
  else g.computeVertexNormals();   // non-indexed -> flat shading
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData = { footprint: data.footprint, height: data.height, radius: data.radius, triCount: data.triCount };
  return g;
}

export async function prepareRobotMesh(parsed, opts) {
  const THREE = await import('three');
  const data = prepareRobotMeshData(parsed, opts);
  return { geometry: geometryFromData(THREE, data), ...data };
}
