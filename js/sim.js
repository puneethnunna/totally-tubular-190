// Game state + lightweight 2.5D physics for TOTALLY TUBULAR. No DOM, no Three.js, deterministic.
import { FIELD, TUBE, ROBOT, POINTS, SIDES, ALLIANCES, ROBOT_PRESETS, inRect } from './config.js';

const TAU = Math.PI * 2;
const G = 9.81;
const TR = TUBE.tubeRadius;
const TIP_SPACING = 0.14; // tubes are 5 in thick, so stack along the 24 in peg at 0.14 m
const MAX_SUB = 1 / 120;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const num = (v) => (Number.isFinite(v) ? clamp(v, -1, 1) : 0);
const approach = (v, t, d) => (v < t ? Math.min(v + d, t) : Math.max(v - d, t));
const smooth = (u) => u * u * (3 - 2 * u);

// Tunables
const TUNE = {
  // reach is measured from the bumper face; lift travel adds place time
  reach: 0.6, liftSpeed: 2.2, placeBase: 0.15, placeAngle: (35 * Math.PI) / 180, placeLateral: 0.3,
  launchAngle: (20 * Math.PI) / 180, launchMin: 1.5, launchMax: 5, throwDist: 4,
  intakeNear: 0.3, intakeFar: 1.1, intakeHalf: 0.55, intakeHalfWide: 0.8,
  feedCooldown: 1.5, manualCooldown: 0.8, chuteSpeed: 1.6, chuteTime: 2.0, chuteExitY: 0.7, chuteStagger: 1.2, feedClear: 1.0,
  releaseAt: 0.7, doubleExtra: 0.5, climbTouch: 0.2, climbAngle: (60 * Math.PI) / 180,
};

// Physics constants (SI). Robots: mass/yaw inertia, traction circle, DC-motor curve; tubes: light + bouncy.
const PHYS = {
  mass: 61, radius: ROBOT.radius, inertiaK: 0.55,   // yaw inertia = inertiaK * m * R^2
  mu: 1.05, latMu: 1.6,                             // carpet traction (accel <= mu*g); tank lateral friction
  response: 0.08, kv: 12, kw: 20,                   // module response (s); velocity / yaw-rate loop gains (1/s)
  alpha: 4, tankAlpha: 3.5, moduleR: 0.8,           // yaw accel per rad/s of turnRate; wheel radius from center (x R)
  crr: 0.02,                                        // rolling resistance coefficient
  robotMu: 0.35, wallMu: 0.3, restV: 0.4,           // robot/wall contacts are fully inelastic: they stop, never bounce
  robotH: 0.8, maxStep: 0.08,                       // robot height (tubes fly over it), max robot travel per substep (m)
  tubeRest: 0.4, tubeWallRest: 0.4, tubeRobotRest: 0.3, tubeVisc: 1.4, tubeCrr: 0.5, tubeSpinDecay: 3,
  drag: 0.09, floorBounce: 0.35,                    // tube quadratic air drag (1/m), floor bounce in flight
};

// circle vs rect -> [nx, nz, penetration] pointing out of the rect, or null.
// With the previous (valid) position (ox, oz), the side the body came from wins, so a push can't carry it through a thin wall.
function circleRect(x, z, r, q, ox, oz) {
  const px = clamp(x, q.x0, q.x1), pz = clamp(z, q.z0, q.z1);
  const dx = x - px, dz = z - pz, d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  let n;
  if (d2 > 1e-12) { const d = Math.sqrt(d2); n = [dx / d, dz / d, r - d]; }
  else {
    const l = x - q.x0, rr = q.x1 - x, t = z - q.z0, b = q.z1 - z, m = Math.min(l, rr, t, b);
    n = m === l ? [-1, 0, l + r] : m === rr ? [1, 0, rr + r] : m === t ? [0, -1, t + r] : [0, 1, b + r];
  }
  if (ox === undefined) return n;
  const cx = clamp(ox, q.x0, q.x1), cz = clamp(oz, q.z0, q.z1), ex = ox - cx, ez = oz - cz, e = Math.hypot(ex, ez);
  if (e < 1e-9) return n;
  const nx = ex / e, nz = ez / e;
  if (n[0] * nx + n[1] * nz > 0) return n;
  const pen = r - ((x - cx) * nx + (z - cz) * nz);
  return pen > 0 ? [nx, nz, pen] : n;
}

// ---- bumper colliders: every robot is a rounded rectangle = core rectangle (ax, az) swept by a corner radius m ----
// Shape S = { x, z, c, s (heading cos/sin), ax, az, m, rr (circumscribed) }. Static AABBs are shapes with m = 0; contacts are
// found by SAT on the cores (cores overlapping) or closest vertex-to-core distance (cores apart, margin contact).
const rectShape = (q) => { const ax = (q.x1 - q.x0) / 2, az = (q.z1 - q.z0) / 2; return { x: (q.x0 + q.x1) / 2, z: (q.z0 + q.z1) / 2, c: 1, s: 0, ax, az, m: 0, rr: Math.hypot(ax, az) }; };
const _a = new Float64Array(8), _b = new Float64Array(8), _cand = new Float64Array(24), _cp = [0, 0];
function corners(S, o) {
  const ux = S.c * S.ax, uz = S.s * S.ax, vx = -S.s * S.az, vz = S.c * S.az;
  o[0] = S.x + ux + vx; o[1] = S.z + uz + vz; o[2] = S.x + ux - vx; o[3] = S.z + uz - vz;
  o[4] = S.x - ux - vx; o[5] = S.z - uz - vz; o[6] = S.x - ux + vx; o[7] = S.z - uz + vz;
}
function closest(S, px, pz) { // nearest point of S's core to (px, pz) -> _cp
  const dx = px - S.x, dz = pz - S.z, lx = clamp(dx * S.c + dz * S.s, -S.ax, S.ax), lz = clamp(-dx * S.s + dz * S.c, -S.az, S.az);
  _cp[0] = S.x + lx * S.c - lz * S.s; _cp[1] = S.z + lx * S.s + lz * S.c;
}
const insideCore = (S, px, pz) => { const dx = px - S.x, dz = pz - S.z; return Math.abs(dx * S.c + dz * S.s) <= S.ax && Math.abs(-dx * S.s + dz * S.c) <= S.az; };
// A vs B -> o = { nx, nz (A -> B), pen, px, pz (contact point) } or false. e = extra margin for proximity tests.
function contact(A, B, o, e = 0) {
  const dx = B.x - A.x, dz = B.z - A.z, m = A.m + B.m + e, br = A.rr + B.rr + e;
  if (dx * dx + dz * dz >= br * br) return false;
  let mg = -1e9, mx = 0, mz = 0;
  for (let i = 0; i < 4; i++) {
    const S = i < 2 ? A : B, nx = i & 1 ? -S.s : S.c, nz = i & 1 ? S.c : S.s;
    const pa = A.ax * Math.abs(nx * A.c + nz * A.s) + A.az * Math.abs(-nx * A.s + nz * A.c);
    const pb = B.ax * Math.abs(nx * B.c + nz * B.s) + B.az * Math.abs(-nx * B.s + nz * B.c);
    const dd = dx * nx + dz * nz, g = Math.abs(dd) - pa - pb;
    if (g >= m) return false;
    if (g > mg) { mg = g; mx = dd < 0 ? -nx : nx; mz = dd < 0 ? -nz : nz; }
  }
  if (mg < 0) { // cores overlap: push out along the shallowest axis; contact = middle of the corners lying inside the other core
    corners(A, _a); corners(B, _b);
    let n = 0, sx = 0, sz = 0;
    for (let i = 0; i < 8; i += 2) {
      if (insideCore(B, _a[i], _a[i + 1])) { sx += _a[i]; sz += _a[i + 1]; n++; }
      if (insideCore(A, _b[i], _b[i + 1])) { sx += _b[i]; sz += _b[i + 1]; n++; }
    }
    o.nx = mx; o.nz = mz; o.pen = m - mg;
    o.px = n ? sx / n : (A.x + B.x) / 2; o.pz = n ? sz / n : (A.z + B.z) / 2;
    return true;
  }
  corners(A, _a); corners(B, _b);
  let nc = 0, dmin = 1e9;
  for (let i = 0; i < 8; i += 2) {
    closest(B, _a[i], _a[i + 1]); const d = Math.hypot(_cp[0] - _a[i], _cp[1] - _a[i + 1]);
    _cand[nc * 3] = d; _cand[nc * 3 + 1] = (_a[i] + _cp[0]) / 2; _cand[nc * 3 + 2] = (_a[i + 1] + _cp[1]) / 2; nc++; if (d < dmin) dmin = d;
    closest(A, _b[i], _b[i + 1]); const d2 = Math.hypot(_cp[0] - _b[i], _cp[1] - _b[i + 1]);
    _cand[nc * 3] = d2; _cand[nc * 3 + 1] = (_b[i] + _cp[0]) / 2; _cand[nc * 3 + 2] = (_b[i + 1] + _cp[1]) / 2; nc++; if (d2 < dmin) dmin = d2;
  }
  if (dmin >= m) return false;
  // normal from the closest vertex pair (axis normal when cores touch exactly)
  let bi = 0; for (let i = 1; i < nc; i++) if (_cand[i * 3] < _cand[bi * 3]) bi = i;
  const vi = bi >> 1 << 1, isA = (bi & 1) === 0, vx = isA ? _a[vi] : _b[vi], vz = isA ? _a[vi + 1] : _b[vi + 1];
  if (dmin > 1e-9) { closest(isA ? B : A, vx, vz); const k = isA ? 1 : -1; o.nx = k * (_cp[0] - vx) / dmin; o.nz = k * (_cp[1] - vz) / dmin; }
  else { o.nx = mx; o.nz = mz; }
  o.pen = m - dmin;
  let sx = 0, sz = 0, n = 0;
  for (let i = 0; i < nc; i++) if (_cand[i * 3] < dmin + 0.002) { sx += _cand[i * 3 + 1]; sz += _cand[i * 3 + 2]; n++; }
  o.px = sx / n + o.nx * (A.m - B.m) / 2; o.pz = sz / n + o.nz * (A.m - B.m) / 2;
  return true;
}
// circle vs bumper shape -> [nx, nz (shape -> circle), pen] or null
function circleShape(x, z, R, S) {
  const dx = x - S.x, dz = z - S.z, lx = dx * S.c + dz * S.s, lz = -dx * S.s + dz * S.c, rr = R + S.m;
  const ex = lx - clamp(lx, -S.ax, S.ax), ez = lz - clamp(lz, -S.az, S.az), d2 = ex * ex + ez * ez;
  if (d2 >= rr * rr) return null;
  let nx, nz, pen;
  if (d2 > 1e-12) { const d = Math.sqrt(d2); nx = ex / d; nz = ez / d; pen = rr - d; }
  else {
    const gx = S.ax - Math.abs(lx), gz = S.az - Math.abs(lz);
    if (gx < gz) { nx = Math.sign(lx) || 1; nz = 0; pen = gx + rr; } else { nx = 0; nz = Math.sign(lz) || 1; pen = gz + rr; }
  }
  return [nx * S.c - nz * S.s, nx * S.s + nz * S.c, pen];
}

export function createSim(options = {}) {
  const events = [];
  const emit = (e) => events.push(e);
  let seed = (options.seed ?? 1) >>> 0;
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const midfield = { blue: options.midfield?.blue ?? 8, red: options.midfield?.red ?? 8 };
  const autoHP = options.autoHumanPlayer !== false;

  const posts = [];
  for (const a of ALLIANCES) for (const p of SIDES[a].posts) posts.push({ ...p, tubes: [] });
  const postById = new Map(posts.map((p) => [p.id, p]));
  const walls = ALLIANCES.map((a) => SIDES[a].shortWall);
  // Robots can't drive through the row of pegs; tubes still pass under them.
  const postRails = ALLIANCES.map((a) => {
    const ps = SIDES[a].posts, zs = ps.map((p) => p.z);
    return { x0: Math.min(ps[0].tipX, ps[0].baseX), x1: Math.max(ps[0].tipX, ps[0].baseX), z0: Math.min(...zs) - 0.05, z1: Math.max(...zs) + 0.05 };
  });
  const platforms = ALLIANCES.flatMap((a) => SIDES[a].platforms.map((p) => ({ ...p, alliance: a, id: `${a}-L${p.level}` })));
  const platRects = platforms;
  const obstacles = [...walls, ...postRails, ...platRects], obsShapes = obstacles.map(rectShape);
  const solids = [...walls, ...platRects]; // tall enough to stop a tube in flight (postRails: tubes pass under the pegs)

  const tubes = [];
  const tubeById = new Map();
  let tubeSeq = 0;
  function newTube(origin, x, z, state = 'floor') {
    const t = { id: `t${tubeSeq++}`, origin, x, y: TR, z, vx: 0, vy: 0, vz: 0, state, holder: null, post: null,
      px: x, pz: z, sx: undefined, sz: 0, stackIndex: -1, placedInAuto: false, yaw: 0, spin: 0, lockT: 0, chuteT: 0, tilt: 0, vy: 0, moving: false, flight: null };
    tubes.push(t); tubeById.set(t.id, t);
    return t;
  }

  // ---- robots ----
  const robots = [];
  const robotById = new Map();
  const rt = new Map(); // per-robot internal
  const preloads = { blue: 0, red: 0 };
  for (const o of options.robots ?? []) {
    const op = typeof o.preset === 'object' && o.preset ? o.preset : null;
    const base = ROBOT_PRESETS.find((p) => p.id === (op ? op.id : o.preset)) ?? ROBOT_PRESETS[0];
    const preset = { ...base, ...op, radius: op?.radius > 0 ? op.radius : PHYS.radius, mass: op?.mass > 0 ? op.mass : PHYS.mass };
    const mass = preset.mass, fp = preset.model?.footprint, b0 = fp ? Math.min(ROBOT.bumper, 0.09) : ROBOT.bumper; // same outline as models.js createBumper
    const bm = preset.bumper ?? (fp ? { lx: fp.x + 2 * b0, lz: fp.z + 2 * b0 } : { lx: 2 * preset.radius, lz: 2 * preset.radius });
    const hx = bm.lx / 2, hz = bm.lz / 2, corner = bm.corner ?? Math.min(0.06, bm.lx / 3, bm.lz / 3);
    const radius = Math.hypot(hx - corner, hz - corner) + corner; // circumscribed
    const st = o.start ?? SIDES[o.alliance].starts[o.slot ?? 0] ?? SIDES[o.alliance].starts[0];
    const r = { id: o.id, alliance: o.alliance, slot: o.slot ?? 0, number: o.number ?? '', preset, radius, bumper: { lx: 2 * hx, lz: 2 * hz, corner }, mass, inertia: PHYS.inertiaK * mass * (hx * hx + hz * hz) / 2,
      x: st.x, z: st.z, y: 0, heading: st.heading ?? 0, vx: 0, vz: 0, omega: 0, held: [], action: null,
      arm: 0, armTier: 'stow', support: 0, intakeOn: false, contacts: [] };
    robots.push(r); robotById.set(r.id, r);
    rt.set(r.id, { hx, R0: Math.hypot(hx, hz) / Math.SQRT2, sh: { x: 0, z: 0, c: 1, s: 0, ax: hx - corner, az: hz - corner, m: corner, rr: radius, ex: 0, ez: 0 }, cx: 0, cz: 0, cr: 0, cth: 0, ctu: 0, platform: null, intakeT: 0, intakeTarget: null, touching: new Set(), prevClimb: false, act: null });
    pose(r);
    if (o.preload !== false) {
      const t = newTube(r.alliance, r.x, r.z, 'held');
      t.holder = r.id; r.held.push(t.id); preloads[r.alliance]++;
    }
  }

  // midfield staging rows, evenly spread when fewer than 8
  for (const a of ALLIANCES) {
    const row = SIDES[a].stagingRow, n = clamp(Math.floor(midfield[a]), 0, row.length);
    for (let i = 0; i < n; i++) {
      const p = row[n === 1 ? 3 : Math.round((i * (row.length - 1)) / (n - 1))];
      newTube(a, p.x, p.z);
    }
  }

  const reserve = {};
  for (const a of ALLIANCES) reserve[a] = Math.max(0, TUBE.perAlliance - midfield[a] - preloads[a]);

  const chutes = ALLIANCES.flatMap((a) => SIDES[a].chutes.map((c, i) => ({ alliance: a, index: i, c, cd: 0.5 + 1.2 * i })));   // staggered so the human players feed one tube at a time

  const state = { time: 0, robots, tubes, posts, reserve };
  let phase = 'pre';
  let first = true;

  // ---------- helpers ----------
  const clampIn = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : clamp(v, lo, hi));
  function sh(r) { // bumper shape synced to the robot's current pose
    const S = rt.get(r.id).sh; S.x = r.x; S.z = r.z; return S;
  }
  function pose(r) { // heading changed: refresh rotation and axis-aligned half extents
    const S = rt.get(r.id).sh, c = Math.cos(r.heading), s = Math.sin(r.heading);
    S.c = c; S.s = s; S.ex = S.ax * Math.abs(c) + S.az * Math.abs(s) + S.m; S.ez = S.ax * Math.abs(s) + S.az * Math.abs(c) + S.m;
  }
  const postStackPos = (p, slot) => ({ x: p.tipX - p.dirX * TIP_SPACING * slot, y: p.y, z: p.z }); // slot 0 = at the tip (newest)
  const speed2 = (o) => o.vx * o.vx + o.vz * o.vz;

  function release(t) { // remove from holder
    const r = robotById.get(t.holder);
    if (r) r.held = r.held.filter((id) => id !== t.id);
    t.holder = null;
  }

  function stackOn(t, p, holderId) {
    const idx = p.tubes.length;
    Object.assign(t, { state: 'post', post: p.id, stackIndex: idx, vx: 0, vy: 0, vz: 0,
      flight: null, placedInAuto: phase === 'auto' });
    p.tubes.push(t.id);
    p.tubes.forEach((id, i) => { const o = tubeById.get(id), q = postStackPos(p, p.tubes.length - 1 - i); o.x = q.x; o.y = q.y; o.z = q.z; }); // newest pushes older ones toward the wall
    emit({ type: 'place', robotId: holderId, tubeId: t.id, postId: p.id });
  }

  function dropToFloor(t, x, z, vx = 0, vz = 0) {
    Object.assign(t, { state: 'floor', x, y: TR, z, vx, vy: 0, vz, flight: null, moving: true });
  }

  // ---------- place / launch / climb ----------
  function findPost(r, tier) {
    const c = Math.cos(r.heading), s = Math.sin(r.heading);
    let best = null, bs = 1e9;
    for (const p of posts) {
      if (p.alliance !== r.alliance || p.tier !== tier) continue;
      const wallAng = p.dirX < 0 ? 0 : Math.PI;
      if (Math.abs(wrap(r.heading - wallAng)) > TUNE.placeAngle) continue;
      const dx = p.tipX - r.x, dz = p.z - r.z;
      const f = dx * c + dz * s, l = -dx * s + dz * c;
      if (f <= 0 || f - rt.get(r.id).hx > TUNE.reach || Math.abs(l) > TUNE.placeLateral) continue;
      const sc = Math.abs(f - r.radius) + 2 * Math.abs(l);
      if (sc < bs) { bs = sc; best = p; }
    }
    return best;
  }

  // Elevator travel: the lift has to rise from stow to the post height, so upper takes ~1.7 s and lower ~0.9 s.
  const placeDuration = (r, p) => r.preset.placeTime + TUNE.placeBase + (r.liftTier === p.tier ? 0 : Math.max(0, p.y - (r.y || 0) - 0.45) / TUNE.liftSpeed); // pre-raised elevator skips the travel
  function startPlace(r, tier) {
    const k = rt.get(r.id);
    if (!r.held.length) return emit({ type: 'invalid', robotId: r.id, text: 'no tube held' });
    if ((tier === 'lower' && !r.preset.canLower) || (tier === 'upper' && !r.preset.canUpper))
      return emit({ type: 'invalid', robotId: r.id, text: `cannot place ${tier}` });
    const p = findPost(r, tier);
    if (!p) return emit({ type: 'invalid', robotId: r.id, text: 'no post in range' });
    if (p.tubes.length >= POINTS.maxPhysicalPerPost) return emit({ type: 'invalid', robotId: r.id, postId: p.id, text: 'post full' });
    const normal = placeDuration(r, p);
    // Two tubes in hand and room for both on this post (it holds <= 1): hang both, one after the other, for +DOUBLE_EXTRA s.
    const double = r.held.length >= 2 && p.tubes.length <= 1 && p.tubes.length + 2 <= POINTS.maxPhysicalPerPost;
    r.action = { type: 'place', t: 0, duration: double ? normal + TUNE.doubleExtra : normal, target: p.id };
    if (double) Object.assign(r.action, { double: true, normal, rel: 0, t1: TUNE.releaseAt * normal });
    if (double) r.action.t2 = Math.max(r.action.t1 + 0.3, r.action.duration - 0.15);
    r.action.releases = double ? [r.action.t1, r.action.t2] : [TUNE.releaseAt * normal]; // shared with models.js lift animation
    r.armTier = tier; k.released = false;
  }

  function startScoreFloor(r) {
    if (!r.held.length) return emit({ type: 'invalid', robotId: r.id, text: 'no tube held' });
    r.action = { type: 'place', t: 0, duration: r.preset.placeTime * 0.6, target: 'floor' };
    r.armTier = 'floor'; rt.get(r.id).released = false;
  }

  function pickLaunchPost(r) {
    let best = null;
    for (const tier of ['upper', 'lower']) {
      let bs = 1e9;
      for (const p of posts) {
        if (p.alliance !== r.alliance || p.tier !== tier || p.tubes.length >= POINTS.maxPhysicalPerPost) continue;
        const dx = p.tipX - r.x, dz = p.z - r.z, d = Math.hypot(dx, dz);
        if (d < TUNE.launchMin || d > TUNE.launchMax) continue;
        const e = Math.abs(wrap(Math.atan2(dz, dx) - r.heading));
        if (e <= TUNE.launchAngle && e < bs) { bs = e; best = p; }
      }
      if (best) break;
    }
    return best;
  }

  function startLaunch(r) {
    if (!r.preset.canLaunch || !r.held.length) return emit({ type: 'invalid', robotId: r.id, text: r.held.length ? 'cannot launch' : 'no tube held' });
    const p = pickLaunchPost(r);
    r.action = { type: 'launch', t: 0, duration: 0.4, target: p ? p.id : null };
    r.armTier = p ? p.tier : 'lower'; rt.get(r.id).released = false;
  }

  function doLaunch(r) {
    const t = tubeById.get(r.held[0]);
    const c = Math.cos(r.heading), s = Math.sin(r.heading);
    const hx = rt.get(r.id).hx, x0 = r.x + c * (hx + 0.1), z0 = r.z + s * (hx + 0.1), y0 = r.y + 0.9;
    release(t);
    Object.assign(t, { state: 'flight', x: x0, y: y0, z: z0, placedInAuto: false, post: null });
    const p = r.action.target ? postById.get(r.action.target) : null;
    let tx, ty, tz, T;
    if (p) {
      const s2 = postStackPos(p, 0);
      tx = s2.x; ty = s2.y; tz = s2.z; T = clamp(Math.hypot(tx - x0, tz - z0) / 6, 0.45, 1.1);
    } else {
      tx = clamp(x0 + c * TUNE.throwDist, -FIELD.halfL + TUBE.outerRadius, FIELD.halfL - TUBE.outerRadius);
      tz = clamp(z0 + s * TUNE.throwDist, -FIELD.halfW + TUBE.outerRadius, FIELD.halfW - TUBE.outerRadius);
      ty = TR; T = 0.9;
    }
    const D = Math.hypot(tx - x0, tz - z0), k0 = PHYS.drag;
    const vy = (ty - y0 + 0.5 * G * T * T) / T;
    t.sx = r.x; t.sz = r.z; // spawn point may be inside a wall: resolve from the robot's side
    t.flight = { src: r.id, t: 0, T, x0, y0, z0, tx, ty, tz, vy, post: p ? p.id : null };
    const vk = p || D < 1e-6 ? 1 : (Math.exp(k0 * D) - 1) / (k0 * D); // free throws: start faster to offset air drag
    t.vx = ((tx - x0) / T) * vk; t.vz = ((tz - z0) / T) * vk; t.vy = vy; t.spin = (rnd() - 0.5) * 6;
    emit({ type: 'launch', robotId: r.id, tubeId: t.id, postId: p ? p.id : undefined });
  }

  function findClimbTarget(r, k) {
    // Direct climb: whichever platform the robot is touching and facing (any level above its support; refused if that platform is above maxClimb); the one the robot's center is nearest wins.
    const have = Math.max(r.support, 1);
    let best = null, bd = 1e9;
    for (const q of platforms) {
      if (q.alliance !== r.alliance || q.level <= have) continue;
      const px = clamp(r.x, q.x0, q.x1), pz = clamp(r.z, q.z0, q.z1);
      const dx = px - r.x, dz = pz - r.z, d = Math.hypot(dx, dz);
      closest(sh(r), px, pz); if (Math.hypot(_cp[0] - px, _cp[1] - pz) - r.bumper.corner > TUNE.climbTouch) continue; // bumper-to-platform gap
      if (d > 1e-6 && Math.abs(wrap(Math.atan2(dz, dx) - r.heading)) > TUNE.climbAngle) continue;
      if (d < bd - 1e-6 || (Math.abs(d - bd) <= 1e-6 && q.level > best.level)) { best = q; bd = d; }
    }
    if (best && best.level > r.preset.maxClimb) { // lined up with a platform above maxClimb: no fallback to a neighbour, but say why
      if (!(k.climbMsgT > state.time)) { k.climbMsgT = state.time + 2; emit({ type: 'invalid', robotId: r.id, text: `This robot can only climb to LEVEL ${r.preset.maxClimb}` }); }
      return null;
    }
    return best;
  }

  function startClimb(r, k) {
    const q = findClimbTarget(r, k);
    if (!q) return;
    const S = sh(r), tx = clampIn(r.x, q.x0 + S.ex, q.x1 - S.ex), tz = clampIn(r.z, q.z0 + S.ez, q.z1 - S.ez);
    const open = q.z1 < 0 ? q.z1 : q.z0; // open edge faces field center
    const cz = q.z1 < 0 ? Math.min(tz, open - S.ez) : Math.max(tz, open + S.ez);
    const gained = q.level - Math.max(r.support, 1); // taller direct climbs take longer
    r.action = { type: 'climb', t: 0, duration: r.preset.climbTime * (0.6 + 0.4 * gained), target: q.id };
    k.act = { q, fx: r.x, fz: r.z, fy: r.y, tx, tz: cz };
    r.armTier = 'stow';
    emit({ type: 'climb', robotId: r.id, text: `start L${q.level}` });
  }

  // ---------- robot update ----------
  // Swerve: independent translation + yaw sharing one traction budget; tank: forward drive + skid-steer yaw, strong lateral friction.
  // Braking (error opposing velocity) is limited only by traction, so a stopped robot holds ground until shoved harder than mu*m*g.
  // Command -> module response lag -> motor-curve accel limit -> traction-circle scaling -> velocity.
  function driveRobot(r, k, inp, dt, scale) {
    const p = r.preset, sp = p.maxSpeed * scale, tank = p.drive === 'tank', m = r.mass, g = G;
    let mx = inp.moveX, mz = inp.moveZ, th = inp.throttle, tu = inp.turn, rot = inp.rotate;
    if (tank) {
      if (!th && !tu && (mx || mz)) {
        const err = wrap(Math.atan2(mz, mx) - r.heading);
        tu = clamp(err * 3, -1, 1); th = Math.min(1, Math.hypot(mx, mz)) * Math.max(0, Math.cos(err));
      }
      rot = tu;
    } else { const n = Math.hypot(mx, mz); if (n > 1) { mx /= n; mz /= n; } }
    const a = 1 - Math.exp(-dt / PHYS.response);
    k.cx += (mx - k.cx) * a; k.cz += (mz - k.cz) * a; k.cth += (th - k.cth) * a; k.cr += (rot - k.cr) * a;
    const aTrac = (p.grip ?? PHYS.mu) * g;
    let at = 0, ux = 0, uz = 0, ew = 0, al = 0;
    const c = Math.cos(r.heading), s = Math.sin(r.heading);
    if (tank) {
      const vf = r.vx * c + r.vz * s, e = k.cth * sp - vf;
      ux = c * Math.sign(e); uz = s * Math.sign(e);
      at = Math.min(Math.abs(e) * (e * vf < 0 ? 1 / dt : PHYS.kv), p.accel * clamp(1 - (vf * Math.sign(e)) / p.maxSpeed, 0.08, 2));
    } else {
      const ex = k.cx * sp - r.vx, ez = k.cz * sp - r.vz, en = Math.hypot(ex, ez);
      if (en > 1e-9) {
        ux = ex / en; uz = ez / en;
        at = Math.min(en * (ex * r.vx + ez * r.vz < 0 ? 1 / dt : PHYS.kv), p.accel * clamp(1 - (r.vx * ux + r.vz * uz) / p.maxSpeed, 0.08, 2));
      }
    }
    const wMax = p.turnRate * scale, wT = k.cr * wMax;
    ew = wT - r.omega;
    const a0 = p.turnRate * (tank ? PHYS.tankAlpha : PHYS.alpha), sw = Math.sign(ew);
    al = Math.min(Math.abs(ew) * (ew * r.omega < 0 ? 1 / dt : PHYS.kw), a0 * clamp(1 - (r.omega * sw) / p.turnRate, 0.08, 2));
    // traction circle: translation + yaw force demand share mu*m*g
    const use = at / aTrac + (r.inertia * al) / (PHYS.moduleR * k.R0 * m * aTrac);
    if (use > 1) { at /= use; al /= use; }
    r.vx += ux * at * dt; r.vz += uz * at * dt; r.omega += sw * al * dt;
    if (tank) { // skid-steer: lateral velocity is killed by friction, only a hard shove makes it slide
      const vl = -r.vx * s + r.vz * c, d = Math.min(Math.abs(vl), PHYS.latMu * g * dt) * Math.sign(vl);
      r.vx += s * d; r.vz -= c * d;
    }
    const v = Math.hypot(r.vx, r.vz), rr = PHYS.crr * g * dt;
    if (v > 0) { const f = v <= rr ? 0 : 1 - rr / v; r.vx *= f; r.vz *= f; }
  }

  function updateIntake(r, k, on, dt) {
    const busy = r.action && r.action.type !== 'intake';
    const can = on && !busy && r.held.length < ROBOT.carryLimit;
    r.intakeOn = !!on;
    k.zone = can;
    if (!can) {
      if (r.action?.type === 'intake') r.action = null;
      k.intakeT = 0; k.intakeTarget = null; return;
    }
    const c = Math.cos(r.heading), s = Math.sin(r.heading);
    const half = r.preset.id === 'sweeper' ? TUNE.intakeHalfWide : TUNE.intakeHalf, dr = k.hx - ROBOT.radius; // front face vs the 0.5 m reference
    let best = null, bd = 1e9;
    for (const t of tubes) {
      if ((t.state !== 'floor' && t.state !== 'chute') || t.lockT > 0) continue;
      const dx = t.x - r.x, dz = t.z - r.z, f = dx * c + dz * s, l = -dx * s + dz * c;
      if (f < TUNE.intakeNear + dr || f > TUNE.intakeFar + dr || Math.abs(l) > half) continue;
      const d = f + Math.abs(l);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) { if (r.action?.type === 'intake') r.action = null; k.intakeT = 0; k.intakeTarget = null; return; }
    if (k.intakeTarget !== best.id) { k.intakeTarget = best.id; k.intakeT = 0; }
    k.intakeT += dt;
    r.action = { type: 'intake', t: k.intakeT, duration: r.preset.intakeTime, target: best.id };
    r.armTier = 'floor';
    const px = r.x + c * (0.55 + dr), pz = r.z + s * (0.55 + dr), a = Math.min(1, 12 * dt);
    best.x += (px - best.x) * a; best.z += (pz - best.z) * a;
    best.vx = r.vx; best.vz = r.vz;
    if (k.intakeT >= r.preset.intakeTime) {
      Object.assign(best, { state: 'held', holder: r.id, vx: 0, vz: 0, placedInAuto: false, moving: false });
      r.held.push(best.id);
      r.action = null; k.intakeT = 0; k.intakeTarget = null;
      emit({ type: 'pickup', robotId: r.id, tubeId: best.id });
    }
  }

  function progressAction(r, k, dt) {
    const a = r.action;
    if (!a || a.type === 'intake') return;
    a.t += dt;
    const u = clamp(a.t / a.duration, 0, 1);
    if (a.type === 'climb') {
      // Two phases so the robot never passes through the platform: lift straight up at the edge (bumpers clear the top),
      // then drive forward onto it.
      const q = k.act.q, up = 0.55, lift = smooth(Math.min(1, u / up)), roll = smooth(Math.max(0, (u - up) / (1 - up)));
      r.y = k.act.fy + (q.height + 0.015 - k.act.fy) * lift - (roll > 0 ? 0.015 * roll : 0);
      r.x = k.act.fx + (k.act.tx - k.act.fx) * roll; r.z = k.act.fz + (k.act.tz - k.act.fz) * roll; r.vx = r.vz = r.omega = 0;
      r.arm = Math.sin(Math.PI * u);
      if (u >= 1) {
        k.platform = q; r.y = q.height; r.support = q.level; r.action = null; k.act = null;
        emit({ type: 'climb', robotId: r.id, text: `L${q.level}` });
      }
      return;
    }
    if (a.double) { // two tubes: first goes on at the usual point, the second near the end
      const t = a.t;
      r.arm = t < a.t1 ? t / a.t1 : t < a.t2 ? 1 - 0.15 * Math.sin(Math.PI * (t - a.t1) / (a.t2 - a.t1)) : Math.max(0, 1 - 0.8 * (t - a.t2) / Math.max(1e-6, a.duration - a.t2));
      const due = [a.t1, a.t2];
      while (a.rel < 2 && t >= due[a.rel]) {
        a.rel++;
        const p = postById.get(a.target), id = r.held[0];
        if (id === undefined || p.tubes.length >= POINTS.maxPhysicalPerPost) { r.action = null; return; }
        const tb = tubeById.get(id); release(tb); stackOn(tb, p, r.id);
      }
      k.released = a.rel >= 2;
      if (u >= 1) r.action = null;
      return;
    }
    r.arm = u < TUNE.releaseAt ? u / TUNE.releaseAt : 1 - (u - TUNE.releaseAt) / (1 - TUNE.releaseAt);
    if (!k.released && u >= TUNE.releaseAt) {
      k.released = true;
      if (!r.held.length) { r.action = null; return; }
      if (a.type === 'launch') doLaunch(r);
      else if (a.target === 'floor') {
        const t = tubeById.get(r.held[0]), c = Math.cos(r.heading), s = Math.sin(r.heading);
        release(t);
        dropToFloor(t, r.x + c * (k.hx + 0.4), r.z + s * (k.hx + 0.4), c * 1.2 + r.vx, s * 1.2 + r.vz);
        t.sx = r.x; t.sz = r.z;
        t.lockT = 0.7; t.placedInAuto = false;
        emit({ type: 'place', robotId: r.id, tubeId: t.id, text: 'floor' });
      } else {
        const p = postById.get(a.target);
        if (p.tubes.length >= POINTS.maxPhysicalPerPost) {
          emit({ type: 'invalid', robotId: r.id, postId: p.id, text: 'post full' }); r.action = null; return;
        }
        const t = tubeById.get(r.held[0]);
        release(t); stackOn(t, p, r.id);
      }
    }
    if (u >= 1) r.action = null;
  }

  function moveRobot(r, k, dt) {
    k.hd0 = r.heading; r.heading = wrap(r.heading + r.omega * dt);
    r.x += r.vx * dt; r.z += r.vz * dt;
  }

  // Static contact at world point (px, pz), n from obstacle to robot: inelastic normal impulse (spin from the off-center point), Coulomb friction.
  function wallHit(r, nx, nz, pen, px, pz) {
    const ax = px - r.x, az = pz - r.z;
    r.x += nx * pen; r.z += nz * pen;
    const vn = (r.vx - r.omega * az) * nx + (r.vz + r.omega * ax) * nz;
    if (vn >= 0) return;
    const rn = ax * nz - az * nx, jn = -vn / (1 / r.mass + (rn * rn) / r.inertia);
    r.vx += (nx * jn) / r.mass; r.vz += (nz * jn) / r.mass; r.omega += (rn * jn) / r.inertia;
    const tx = -nz, tz = nx, vt = (r.vx - r.omega * az) * tx + (r.vz + r.omega * ax) * tz, rtn = ax * tz - az * tx;
    const jt = clamp(-vt / (1 / r.mass + (rtn * rtn) / r.inertia), -PHYS.wallMu * jn, PHYS.wallMu * jn);
    r.vx += (tx * jt) / r.mass; r.vz += (tz * jt) / r.mass; r.omega += (rtn * jt) / r.inertia;
  }

  const _C = { nx: 0, nz: 0, pen: 0, px: 0, pz: 0 }, _pt = [0, 0];
  function deepest(S, nx, nz) { // bumper surface point farthest into the half-plane whose outward normal is (nx, nz)
    corners(S, _a);
    let lo = 1e9; for (let i = 0; i < 8; i += 2) lo = Math.min(lo, _a[i] * nx + _a[i + 1] * nz);
    let sx = 0, sz = 0, n = 0;
    for (let i = 0; i < 8; i += 2) if (_a[i] * nx + _a[i + 1] * nz < lo + 0.002) { sx += _a[i]; sz += _a[i + 1]; n++; }
    _pt[0] = sx / n - nx * S.m; _pt[1] = sz / n - nz * S.m;
    return _pt;
  }

  // One pass of robot-vs-static push-out; returns the largest penetration it fixed.
  function worldPass(r, k) {
    let m = 0;
    const S = sh(r);
    const plane = (nx, nz, pen) => {
      if (pen <= 1e-6) return;
      m = Math.max(m, pen);
      if (pen > 1e-3) k.jam = true;
      const p = deepest(sh(r), nx, nz); wallHit(r, nx, nz, pen, p[0], p[1]);
    };
    if (k.platform) {
      const q = k.platform, open = q.z1 < 0;
      if (q.x1 - q.x0 <= 2 * S.ex) { r.x = (q.x0 + q.x1) / 2; r.vx = 0; }
      else { plane(1, 0, q.x0 + S.ex - r.x); plane(-1, 0, r.x - (q.x1 - S.ex)); }
      if (open) plane(0, 1, q.z0 + S.ez - r.z); else plane(0, -1, r.z - (q.z1 - S.ez));
    } else if (r.action?.type !== 'climb') {
      for (const O of obsShapes) {
        if (!contact(O, sh(r), _C)) continue;
        m = Math.max(m, _C.pen); if (_C.pen > 1e-3) k.jam = true; wallHit(r, _C.nx, _C.nz, _C.pen, _C.px, _C.pz);
      }
    }
    plane(1, 0, -FIELD.halfL + S.ex - r.x); plane(-1, 0, r.x - (FIELD.halfL - S.ex));
    plane(0, 1, -FIELD.halfW + S.ez - r.z); plane(0, -1, r.z - (FIELD.halfW - S.ez));
    return m;
  }

  // One pass of bumper-vs-bumper: mass-weighted full push-out + inelastic impulse with friction at the real contact point.
  function pairPass() {
    let m = 0;
    for (let i = 0; i < robots.length; i++) {
      for (let j = i + 1; j < robots.length; j++) {
        const a = robots[i], b = robots[j];
        if (Math.abs(a.y - b.y) > 0.35) continue;
        const aFix = a.action?.type === 'climb', bFix = b.action?.type === 'climb';
        const ia = aFix ? 0 : 1 / a.mass, ib = bFix ? 0 : 1 / b.mass, iia = aFix ? 0 : 1 / a.inertia, iib = bFix ? 0 : 1 / b.inertia;
        if (ia + ib === 0 || !contact(sh(a), sh(b), _C)) continue;
        const { nx, nz, pen, px, pz } = _C;
        if (pen > m) m = pen;
        if (pen > 1e-3) rt.get(a.id).jam = rt.get(b.id).jam = true;
        const cor = pen / (ia + ib), aax = px - a.x, aaz = pz - a.z, bax = px - b.x, baz = pz - b.z;
        a.x -= nx * cor * ia; a.z -= nz * cor * ia; b.x += nx * cor * ib; b.z += nz * cor * ib;
        let rvx = b.vx - b.omega * baz - (a.vx - a.omega * aaz), rvz = b.vz + b.omega * bax - (a.vz + a.omega * aax);
        const vn = rvx * nx + rvz * nz;
        if (vn >= 0) continue;
        const an = aax * nz - aaz * nx, bn = bax * nz - baz * nx;
        const jn = -vn / (ia + ib + an * an * iia + bn * bn * iib);
        a.vx -= nx * jn * ia; a.vz -= nz * jn * ia; b.vx += nx * jn * ib; b.vz += nz * jn * ib; a.omega -= an * jn * iia; b.omega += bn * jn * iib;
        rvx = b.vx - b.omega * baz - (a.vx - a.omega * aaz); rvz = b.vz + b.omega * bax - (a.vz + a.omega * aax);
        const tx = -nz, tz = nx, vt = rvx * tx + rvz * tz, at = aax * tz - aaz * tx, bt = bax * tz - baz * tx;
        const jt = clamp(-vt / (ia + ib + at * at * iia + bt * bt * iib), -PHYS.robotMu * jn, PHYS.robotMu * jn);
        a.vx -= tx * jt * ia; a.vz -= tz * jt * ia; b.vx += tx * jt * ib; b.vz += tz * jt * ib; a.omega -= at * jt * iia; b.omega += bt * jt * iib;
      }
    }
    return m;
  }

  // Iterate pair + world passes until nothing overlaps by more than 0.5 mm; the world pass always runs last so walls win.
  function solveContacts() {
    for (const r of robots) { const k = rt.get(r.id); if (k.platform && (k.platform.z1 < 0 ? r.z > k.platform.z1 - 0.15 : r.z < k.platform.z0 + 0.15)) k.platform = null; }
    const solve = () => {
      for (let it = 0; it < 16; it++) {
        for (const r of robots) rt.get(r.id).jam = false;
        const a = pairPass();
        let w = 0;
        for (const r of robots) w = Math.max(w, worldPass(r, rt.get(r.id)));
        if (a < 5e-4 && w < 5e-4) return;
      }
    };
    solve();
    let jam = false; // a rotation that can't fit (pinched between walls/robots) is blocked: undo this substep's yaw and re-solve
    for (const r of robots) { const k = rt.get(r.id); if (k.jam && r.heading !== k.hd0) { r.heading = k.hd0; r.omega = 0; pose(r); jam = true; } }
    if (jam) solve();
    for (const r of robots) r.contacts = [];
    for (let i = 0; i < robots.length; i++) {
      for (let j = i + 1; j < robots.length; j++) {
        const a = robots[i], b = robots[j], ka = rt.get(a.id);
        if (Math.abs(a.y - b.y) > 0.35 || !contact(sh(a), sh(b), _C, 0.03)) { ka.touching.delete(b.id); continue; }
        a.contacts.push(b.id); b.contacts.push(a.id);
        if (!ka.touching.has(b.id)) { ka.touching.add(b.id); emit({ type: 'contact', robotId: a.id, text: b.id }); }
      }
    }
  }

  // ---------- tubes ----------
  const grid = new Map();
  const cellKey = (x, z) => (Math.floor(x / 0.5) + 64) * 256 + (Math.floor(z / 0.5) + 64);

  function tubeWalls(t) {
    const r = TUBE.outerRadius;
    const mx = FIELD.halfL - r, mz = FIELD.halfW - r;
    const bounce = (q) => {
      const n = circleRect(t.x, t.z, r, q, t.px, t.pz);
      if (!n) return;
      t.x += n[0] * n[2]; t.z += n[1] * n[2];
      const vn = t.vx * n[0] + t.vz * n[1];
      if (vn < 0) { t.vx -= (1 + PHYS.tubeWallRest) * vn * n[0]; t.vz -= (1 + PHYS.tubeWallRest) * vn * n[1]; }
    };
    for (const q of walls) bounce(q);
    for (const q of platRects) bounce(q);
    // Field boundary last: platforms sit flush with the side wall, so a bounce can push past it.
    if (t.x < -mx) { t.x = -mx; if (t.vx < 0) t.vx = -t.vx * PHYS.tubeWallRest; } else if (t.x > mx) { t.x = mx; if (t.vx > 0) t.vx = -t.vx * PHYS.tubeWallRest; }
    if (t.z < -mz) { t.z = -mz; if (t.vz < 0) t.vz = -t.vz * PHYS.tubeWallRest; } else if (t.z > mz) { t.z = mz; if (t.vz > 0) t.vz = -t.vz * PHYS.tubeWallRest; }
  }

  function tubeRobot(t) {
    const R = TUBE.outerRadius;
    for (const r of robots) {
      if (r.y > 0.1) continue;
      const k = rt.get(r.id), dx = t.x - r.x, dz = t.z - r.z, br = r.radius + R;
      if (dx * dx + dz * dz >= br * br) continue;
      const n = circleShape(t.x, t.z, R, sh(r));
      if (!n) continue;
      if (k.zone && t.lockT <= 0) {
        const c = Math.cos(r.heading), s = Math.sin(r.heading), f = dx * c + dz * s, l = -dx * s + dz * c;
        if (f > TUNE.intakeNear + k.hx - ROBOT.radius && Math.abs(l) < (r.preset.id === 'sweeper' ? TUNE.intakeHalfWide : TUNE.intakeHalf)) continue;
      }
      const [nx, nz, pen] = n;
      t.x += nx * pen; t.z += nz * pen;
      const ax = t.x - nx * R - r.x, az = t.z - nz * R - r.z;          // contact arm on the bumper; surface velocity incl. spin
      const rvx = t.vx - (r.vx - r.omega * az), rvz = t.vz - (r.vz + r.omega * ax), vn = rvx * nx + rvz * nz;
      if (vn < 0) {
        const dv = -(1 + (vn < -PHYS.restV ? PHYS.tubeRobotRest : 0)) * vn, mr = TUBE.mass / r.mass;
        t.vx += dv * nx; t.vz += dv * nz; r.vx -= dv * nx * mr; r.vz -= dv * nz * mr;
        t.spin += (rvx * -nz + rvz * nx) * 2;
      }
      tubeWalls(t);
      // pinned against a wall: slide sideways around the robot
      const n2 = circleShape(t.x, t.z, R, sh(r));
      if (n2 && n2[2] > 0.02) {
        const sgn = (-n2[1] * (t.vx || 1) + n2[0] * (t.vz || 0)) >= 0 ? 1 : -1;
        t.x += -n2[1] * sgn * n2[2]; t.z += n2[0] * sgn * n2[2]; tubeWalls(t);
      }
    }
  }

  // Tube in flight vs wall/platform tops, robot bumpers (below robot height). Scripted post shots are only blockable on the way in.
  function flightHit(t, f) {
    const R = TUBE.outerRadius, bot = t.y - TR;
    if (f.post && Math.hypot(f.tx - t.x, f.tz - t.z) < 1) return;
    let hit = false;
    for (const q of solids) {
      if (bot >= q.height) continue;
      const n = circleRect(t.x, t.z, R, q, t.px, t.pz);
      if (!n) continue;
      t.x += n[0] * n[2]; t.z += n[1] * n[2];
      const vn = t.vx * n[0] + t.vz * n[1];
      if (vn < 0) { t.vx -= (1 + PHYS.tubeWallRest) * vn * n[0]; t.vz -= (1 + PHYS.tubeWallRest) * vn * n[1]; }
      hit = true;
    }
    for (const r of robots) {
      if (bot >= r.y + PHYS.robotH || (r.id === f.src && f.t < 0.3)) continue;
      const n = circleShape(t.x, t.z, R, sh(r));
      if (!n) continue;
      t.x += n[0] * n[2]; t.z += n[1] * n[2];
      const vn = (t.vx - r.vx) * n[0] + (t.vz - r.vz) * n[1];
      if (vn < 0) {
        const dv = -(1 + PHYS.tubeRobotRest) * vn, mr = TUBE.mass / r.mass;
        t.vx += dv * n[0]; t.vz += dv * n[1]; r.vx -= dv * n[0] * mr; r.vz -= dv * n[1] * mr;
      }
      hit = true;
    }
    if (hit) f.post = null; // knocked off its scripted arc: ordinary ballistic flight from here
  }

  function updateTubes(dt) {
    const fric = Math.exp(-PHYS.tubeVisc * dt), crr = PHYS.tubeCrr * dt, sdec = Math.exp(-PHYS.tubeSpinDecay * dt);
    const act = [];
    for (const t of tubes) {
      if (t.lockT > 0) t.lockT -= dt;
      if (t.sx === undefined) { t.px = t.x; t.pz = t.z; } else { t.px = t.sx; t.pz = t.sz; t.sx = undefined; } // start-of-substep position: the side a wall push resolves to
      if (t.state === 'held') {
        const r = robotById.get(t.holder), i = r.held.indexOf(t.id), c = Math.cos(r.heading), s = Math.sin(r.heading);
        t.x = clamp(r.x + c * 0.1, -FIELD.halfL + TUBE.outerRadius, FIELD.halfL - TUBE.outerRadius); t.z = clamp(r.z + s * 0.1, -FIELD.halfW + TUBE.outerRadius, FIELD.halfW - TUBE.outerRadius); t.y = r.y + 0.55 + 0.18 * Math.max(0, i);
        t.vx = r.vx; t.vz = r.vz; t.vy = 0; t.moving = false;
      } else if (t.state === 'flight') {
        const f = t.flight;
        f.t += dt;
        if (f.post) {
          const u = Math.min(1, f.t / f.T);
          t.x = f.x0 + (f.tx - f.x0) * u; t.z = f.z0 + (f.tz - f.z0) * u;
          t.y = f.y0 + f.vy * f.t - 0.5 * G * f.t * f.t;
          t.vy = f.vy - G * f.t;
          flightHit(t, f);
          if (f.post && f.t >= f.T) {
            const p = postById.get(f.post);
            if (p.tubes.length < POINTS.maxPhysicalPerPost) stackOn(t, p, undefined);
            else {
              dropToFloor(t, clamp(p.tipX + p.dirX * 0.45, -7.7, 7.7), p.z);
              emit({ type: 'land', tubeId: t.id, postId: p.id, text: 'post full' });
            }
          }
        } else {
          const dk = Math.exp(-PHYS.drag * Math.hypot(t.vx, t.vy, t.vz) * dt); // quadratic air drag
          t.vx *= dk; t.vz *= dk; t.vy = t.vy * dk - G * dt;
          t.x += t.vx * dt; t.y += t.vy * dt; t.z += t.vz * dt;
          t.yaw += t.spin * dt;
          flightHit(t, f);
          const fx = FIELD.halfL - TUBE.outerRadius, fz = FIELD.halfW - TUBE.outerRadius;
          if (Math.abs(t.x) > fx) { t.x = clamp(t.x, -fx, fx); t.vx *= -PHYS.tubeWallRest; }
          if (Math.abs(t.z) > fz) { t.z = clamp(t.z, -fz, fz); t.vz *= -PHYS.tubeWallRest; }
          if (t.y <= TR && t.vy < 0) {
            if (!f.landed) { f.landed = true; emit({ type: 'land', tubeId: t.id }); }
            if (t.vy < -1.2) { t.y = TR; t.vy *= -PHYS.floorBounce; t.vx *= 0.55; t.vz *= 0.55; t.spin += (rnd() - 0.5) * 4; }
            else dropToFloor(t, t.x, t.z, t.vx * 0.45, t.vz * 0.45);
          }
        }
        t.moving = true;
      } else if (t.state === 'floor' || t.state === 'chute') {
        t.x += t.vx * dt; t.z += t.vz * dt;
        if (t.state === 'chute') {
          // Inflatable tube out of the chute (rigid-ring model). tilt = 1 upright .. 0 flat; the lowest point of a ring tipped
          // to angle phi is Rc*sin(phi) + r, so it always rests on its edge and never dips into the carpet.
          const Rc = TUBE.outerRadius - TR, HP = Math.PI / 2;
          let phi = (t.tilt || 0) * HP;
          t.vy = (t.vy || 0) - 9.81 * dt; t.y += t.vy * dt; t.chuteT -= dt;
          const gy = () => Rc * Math.sin(phi) + TR;
          let grounded = t.y <= gy() + 1e-4;
          if (grounded) {
            t.y = gy();
            if (t.vy < -0.5) { t.vy *= -0.45; t.vx *= 0.85; t.vz *= 0.85; t.tiltW = (t.tiltW || 0) - 0.9; }   // edge hits, bounces, starts to tip
            else t.vy = Math.max(0, t.vy);
            const sp = Math.hypot(t.vx, t.vz); if (sp > 0) { const f = Math.max(0, 1 - 1.6 * dt); t.vx *= f; t.vz *= f; }
          }
          if (phi > 0 && (grounded || (t.tiltW || 0) < 0)) {             // topples: gravity torque about the contact edge
            t.tiltW = (t.tiltW || 0) - (9.81 / Rc) * Math.cos(phi) * 0.6 * dt - (phi > HP - 0.02 ? 0.4 * dt : 0);
            phi += t.tiltW * dt;
            if (phi <= 0) phi = 0;
            if (grounded) { t.y = Rc * Math.sin(phi) + TR; t.vy = Rc * Math.cos(phi) * t.tiltW; } // centre rides down with the contact edge
            else t.y = Math.max(t.y, Rc * Math.sin(phi) + TR);
            if (phi <= 0) {                                             // slaps down flat: a small hop, then rests
              t.vy = Math.min(0.6, 0.3 * Math.abs(t.vy)); t.tiltW = 0;
            }
          }
          t.tilt = phi / HP;
          grounded = t.y <= Rc * Math.sin(phi) + TR + 1e-4;
          if (t.chuteT <= 0 && phi > 0) t.tiltW = Math.min(t.tiltW || 0, -1.5);   // overdue: tip it over (never snap)
          if ((grounded && phi <= 0 && Math.abs(t.vy) < 0.05) || t.chuteT <= -3) { t.state = 'floor'; t.tilt = 0; t.tiltW = 0; t.vy = 0; t.y = TR; }
        } else {
          t.y = TR;
          const sp = Math.hypot(t.vx, t.vz);
          if (sp > 0) { const f = sp <= crr ? 0 : fric * (1 - crr / sp); t.vx *= f; t.vz *= f; }
        }
        t.yaw += t.spin * dt; t.spin *= sdec;
        act.push(t);
      }
    }
    // tube-tube (2 iterations) + robots + walls
    for (let it = 0; it < 2; it++) {
      grid.clear();
      for (let i = 0; i < act.length; i++) {
        const k = cellKey(act[i].x, act[i].z);
        const b = grid.get(k); if (b) b.push(i); else grid.set(k, [i]);
      }
      const D = 2 * TUBE.outerRadius;
      for (let i = 0; i < act.length; i++) {
        const a = act[i], cx = Math.floor(a.x / 0.5), cz = Math.floor(a.z / 0.5);
        for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
          const b = grid.get((cx + ox + 64) * 256 + (cz + oz + 64));
          if (!b) continue;
          for (const j of b) {
            if (j <= i) continue;
            const o = act[j];
            let dx = o.x - a.x, dz = o.z - a.z, d2 = dx * dx + dz * dz;
            if (d2 >= D * D) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
            const nx = dx / d, nz = dz / d, pen = (D - d) / 2;
            a.x -= nx * pen; a.z -= nz * pen; o.x += nx * pen; o.z += nz * pen;
            const vn = (o.vx - a.vx) * nx + (o.vz - a.vz) * nz;
            if (vn < 0) {
              const j2 = -(1 + (vn < -PHYS.restV ? PHYS.tubeRest : 0)) * vn / 2, vt = (o.vx - a.vx) * -nz + (o.vz - a.vz) * nx;
              a.vx -= nx * j2; a.vz -= nz * j2; o.vx += nx * j2; o.vz += nz * j2; a.spin -= vt; o.spin += vt;
              for (const u of [a, o]) if (u.state === 'chute' && u.tilt > 0) u.tiltW = Math.min(u.tiltW || 0, -Math.min(4, 2 + Math.abs(j2) * 3)); // knocked over
            }
          }
        }
      }
      for (const t of act) {
        const ux = t.vx, uz = t.vz;
        tubeRobot(t); tubeWalls(t);
        if (t.state === 'chute' && t.tilt > 0) { const dv = Math.hypot(t.vx - ux, t.vz - uz); if (dv > 0.05) t.tiltW = Math.min(t.tiltW || 0, -Math.min(4, 3 * dv)); } // a bump knocks an upright tube over
      }
    }
    for (const t of act) {
      const sp = t.vx * t.vx + t.vz * t.vz;
      if (sp < 0.0016 && t.state === 'floor') { t.vx = t.vz = 0; t.moving = false; if (phase === 'auto') t.placedInAuto = true; }
      else { t.moving = true; t.placedInAuto = false; }
      if (!Number.isFinite(t.x + t.z)) { t.x = 0; t.z = 0; t.vx = t.vz = 0; }
      else if (sp > 144) { const f = 12 / Math.sqrt(sp); t.vx *= f; t.vz *= f; }
    }
  }

  // ---------- human player ----------
  function chuteSpawn(h) {
    const c = h.c;
    return { x: c.x + c.dirX * 0.26, z: c.z + c.dirZ * 0.26 };
  }
  function chuteFree(h) {
    const p = chuteSpawn(h);
    for (const t of tubes) {
      if (t.state !== 'floor' && t.state !== 'chute') continue;
      if (Math.hypot(t.x - p.x, t.z - p.z) < TUNE.feedClear) return false;
    }
    return true;
  }
  function feed(h, cd) {
    const p = chuteSpawn(h);
    const t = newTube(h.alliance, p.x, p.z, 'chute');
    t.vx = h.c.dirX * TUNE.chuteSpeed; t.vz = h.c.dirZ * TUNE.chuteSpeed; t.chuteT = TUNE.chuteTime; t.spin = (rnd() - 0.5) * 1.5;
    t.y = Math.max(TUNE.chuteExitY, TUBE.outerRadius + 0.05); t.vy = 0.2; t.tilt = 1;   // leaves the chute upright
    reserve[h.alliance]--; h.cd = cd;
    for (const o of chutes) if (o !== h && o.alliance === h.alliance) o.cd = Math.max(o.cd, TUNE.chuteStagger); // one tube at a time per alliance
    emit({ type: 'feed', tubeId: t.id, text: `${h.alliance} chute ${h.index}` });
    return true;
  }
  const feedPhase = () => phase === 'teleop' || phase === 'endgame';
  function updateHuman(dt) {
    for (const h of chutes) {
      if (h.cd > 0) h.cd -= dt;
      if (autoHP && feedPhase() && h.cd <= 0 && reserve[h.alliance] > 0 && chuteFree(h)) feed(h, TUNE.feedCooldown);
    }
  }

  // ---------- step ----------
  const ZERO = {};
  function substep(dt, inputs, edges) {
    const disabled = phase === 'pre' || phase === 'post' || phase === 'done';
    for (const r of robots) {
      const k = rt.get(r.id), raw = disabled ? ZERO : inputs?.[r.id] ?? ZERO;
      const inp = { moveX: num(raw.moveX), moveZ: num(raw.moveZ), rotate: num(raw.rotate), throttle: num(raw.throttle), turn: num(raw.turn) };
      const climbing = r.action?.type === 'climb';
      r.liftTier = !raw.intake && (raw.liftTier === 'upper' || raw.liftTier === 'lower') ? raw.liftTier : null; // intake forces the lift down
      if (edges && !disabled && !climbing) {
        const idle = !r.action || r.action.type === 'intake';
        if (idle) {
          if (raw.scoreFloor) startScoreFloor(r);
          else if (raw.launch) startLaunch(r);
          else if (raw.scoreUpper) startPlace(r, 'upper');
          else if (raw.scoreLower) startPlace(r, 'lower');
        }
      }
      if (!disabled && !climbing && raw.climb && phase === 'endgame' && !r.action) startClimb(r, k);
      const a = r.action?.type;
      const scale = a === 'place' ? 0.35 : a === 'launch' ? 0.5 : 1;
      if (r.action?.type === 'climb') { r.vx = r.vz = r.omega = 0; }
      else driveRobot(r, k, inp, dt, scale);
      updateIntake(r, k, !disabled && !!raw.intake, dt);
      if (r.action?.type !== 'climb') moveRobot(r, k, dt);
      progressAction(r, k, dt);
      if (!r.action || (r.action.type !== 'place' && r.action.type !== 'launch' && r.action.type !== 'climb'))
        r.arm = Math.max(0, r.arm - 4 * dt);
      if (r.arm <= 0 && !r.action) r.armTier = 'stow';
      else if (r.action?.type === 'intake') r.armTier = 'floor';
    }
    for (const r of robots) pose(r);
    solveContacts();
    for (const r of robots) {
      const k = rt.get(r.id);
      const targetY = k.platform ? k.platform.height : 0;
      if (r.action?.type !== 'climb') {
        if (r.y > targetY) r.y = Math.max(targetY, r.y - 2.5 * dt); else r.y = targetY;
      }
      if (k.platform) r.support = k.platform.level;
      else r.support = inRect(SIDES[r.alliance].l1Area, r.x, r.z) && r.y < 0.05 ? 1 : 0;
      if (!Number.isFinite(r.x + r.z + r.heading + r.vx + r.vz + r.omega)) { r.vx = r.vz = r.omega = 0; r.x = 0; r.z = 0; r.heading = 0; }
    }
    updateTubes(dt);
    updateHuman(dt);
    state.time += dt;
  }

  function step(dt, inputs, ph) {
    if (ph) phase = ph;
    if (first) { first = false; }
    if (!(dt > 0)) return;
    let vmax = 0;
    for (const r of robots) vmax = Math.max(vmax, Math.hypot(r.vx, r.vz));
    const n = Math.max(Math.ceil(dt / MAX_SUB - 1e-9), Math.ceil((vmax * dt) / PHYS.maxStep - 1e-9)), h = dt / n; // robots never travel > 8 cm per substep
    for (let i = 0; i < n; i++) substep(h, inputs, i === 0);
  }

  function requestHumanTube(alliance, chuteIndex) {
    if (!feedPhase() || !(reserve[alliance] > 0)) return false;
    const list = chutes.filter((h) => h.alliance === alliance && (chuteIndex === undefined || h.index === chuteIndex));
    for (const h of list) if (h.cd <= 0 && chuteFree(h)) return feed(h, TUNE.manualCooldown);
    return false;
  }

  function drainEvents() { return events.splice(0, events.length); }

  return { state, step, drainEvents, requestHumanTube, robotById: (id) => robotById.get(id), tubeById: (id) => tubeById.get(id), tune: TUNE, phys: PHYS };
}
