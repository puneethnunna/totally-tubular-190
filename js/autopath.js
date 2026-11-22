// User-drawn AUTO path follower (pure logic, no THREE / DOM).
//
//   const ap = createAutoPath(path, robotId);   path: [{x,z},...] | [[x,z],...] | { pts } | { strokes }
//   ap.step(sim, dt) -> Input | null            null once the path (and any scoring) is finished
//   ap.done, ap.index, ap.skips, ap.scoreFired, ap.state
//
// Actions are automatic:
//  * INTAKE  - held while the robot is close to a loose tube that the path passes within AP.intakeNear (and speed is cut there).
//  * SCORE   - when the path enters the own scoring zone next to the posts (nearPosts) and the robot holds tubes, path following pauses and
//              autoalign.js drives to the nearest open post (upper if the preset can, else lower, or launch for launchers). Then the
//              path continues.
//  * BLOCKED - if commanded to move but not moving for AP.stuckTime s, skip ahead along the path.
// Also exports helpers shared with the setup screen (mirror, flatten, resample, markers).
import { FIELD, SIDES, TUBE, inRect } from './config.js';
import { createAutoAlign } from './autoalign.js';

export const AP = {
  spacing: 0.25,        // m between resampled waypoints
  reachTol: 0.4,        // m to count a waypoint as reached
  lookahead: 1,         // waypoints ahead to steer at
  cruise: 0.85,         // fraction of maxSpeed
  brake: 4,             // m/s^2 used for the end-of-path speed profile
  intakeNear: 0.6,      // m: a tube counts as "on the path" within this distance
  intakeSlow: 0.4,      // speed scale while closing on a tube
  intakeRange: 1.6,     // m: start intaking / slowing when the tube is this close to the robot
  stuckTime: 1.5,       // s
  skipAhead: 4,         // waypoints skipped when blocked (~1 m)
  nearPostsDx: 1.35,    // m from the post tip plane that counts as "at the posts"
  maxScoreTries: 3,     // consecutive place attempts per scoring event (2 held tubes + 1 retry)
  margin: 0.6,          // m kept from the field walls
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- path helpers ----------
export const toPoint = (p) => (Array.isArray(p) ? { x: p[0], z: p[1] } : { x: p.x, z: p.z });
export function flattenStrokes(strokes) {
  const out = [];
  for (const s of strokes || []) for (const p of s) { const q = toPoint(p), l = out[out.length - 1]; if (!l || Math.hypot(l.x - q.x, l.z - q.z) > 1e-6) out.push(q); }
  return out;
}
export const mirrorStrokes = (strokes) => (strokes || []).map((s) => s.map((p) => { const q = toPoint(p); return { x: -q.x, z: -q.z }; }));
export function pathPoints(path) {
  if (!path) return [];
  if (Array.isArray(path)) return Array.isArray(path[0]) && Array.isArray(path[0][0]) ? flattenStrokes(path) : path.map(toPoint);
  if (path.strokes) return flattenStrokes(path.strokes);
  if (path.pts) return path.pts.map(toPoint);
  return [];
}
export function resample(pts, spacing = AP.spacing) {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const out = [{ ...pts[0] }];
  let carry = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-9) continue;
    let d = spacing - carry;
    while (d <= L) { const t = d / L; out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); d += spacing; }
    carry = L - (d - spacing);
  }
  const l = out[out.length - 1], e = pts[pts.length - 1];
  if (Math.hypot(l.x - e.x, l.z - e.z) > 1e-3) out.push({ x: e.x, z: e.z });
  return out;
}
export const clampToField = (p, m = AP.margin) => ({ x: clamp(p.x, -FIELD.halfL + m, FIELD.halfL - m), z: clamp(p.z, -FIELD.halfW + m, FIELD.halfW - m) });
const distSeg = (p, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz, t = L2 < 1e-12 ? 0 : clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / L2, 0, 1);
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};
export function distToPolyline(p, pts, from = 0, to = pts.length - 1) {
  let best = Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.z - pts[0].z);
  for (let k = Math.max(0, from); k < Math.min(pts.length - 1, to); k++) best = Math.min(best, distSeg(p, pts[k], pts[k + 1]));
  return best;
}

// The robot is "at the posts": inside its own scoring zone and within AP.nearPostsDx of the post tip plane.
export function nearPosts(alliance, x, z) {
  const S = SIDES[alliance], tipX = S.posts[0].tipX;
  return inRect(S.scoringZone, x, z) && Math.abs(x - tipX) <= AP.nearPostsDx;
}
// Indices of the first point of each run of path inside nearPosts (SCORE markers).
export function scoreEntries(pts, alliance) {
  const out = []; let inside = false;
  pts.forEach((p, k) => { const n = nearPosts(alliance, p.x, p.z); if (n && !inside) out.push(k); inside = n; });
  return out;
}
// Staged midfield tube spots (same placement rule as sim.js).
export function stagedSpots(midfield = 8) {
  const out = [];
  for (const a of ['blue', 'red']) {
    const row = SIDES[a].stagingRow, n = clamp(Math.floor(midfield), 0, row.length);
    for (let i = 0; i < n; i++) { const p = row[n === 1 ? 3 : Math.round((i * (row.length - 1)) / (n - 1))]; out.push({ x: p.x, z: p.z, alliance: a }); }
  }
  return out;
}
// Markers for the setup screen: intake icons at staged tubes the path passes, score icons where it enters the post area.
export function pathMarkers(pts, alliance, midfield = 8) {
  const rs = resample(pts);
  const intakes = rs.length > 1 ? stagedSpots(midfield).filter((t) => distToPolyline(t, rs) <= AP.intakeNear).map((t) => ({ x: t.x, z: t.z })) : [];
  const scores = scoreEntries(rs, alliance).map((k) => ({ x: rs[k].x, z: rs[k].z }));
  return { intakes, scores };
}

// ---------- follower ----------
export function createAutoPath(path, robotId) {
  const pts = resample(pathPoints(path).map((p) => clampToField(p)));
  const aa = createAutoAlign();
  let i = 0, init = false, stuck = 0, skips = 0, events = null, ev = 0, tries = 0, scoreFired = 0, idle = 0, done = pts.length < 2;
  let postEnd = 0;

  function startScore(sim, r) {
    const pr = r.preset, tiers = pr.canUpper || pr.canLaunch ? ['upper', 'lower'] : ['lower'];
    for (const tier of tiers) { const s = aa.start(sim, robotId, tier); if (s.ok) { scoreFired++; return true; } }
    return false;
  }

  function step(sim, dt) {
    const r = sim.robotById(robotId);
    if (!r || done) return null;
    if (!init) {
      init = true; events = scoreEntries(pts, r.alliance);
      while (i < pts.length - 1 && Math.hypot(pts[i].x - r.x, pts[i].z - r.z) < AP.reachTol) i++;
    }
    // --- automatic scoring in progress
    if (aa.active) {
      const out = aa.step(sim, dt, null);
      if (out) return out;
      if (r.held.length && aa.result?.ok && tries < AP.maxScoreTries) { tries++; if (startScore(sim, r)) { const o = aa.step(sim, dt, null); if (o) return o; } }
      tries = 0;
    }
    // advance along the path
    while (i < pts.length && Math.hypot(pts[i].x - r.x, pts[i].z - r.z) < (i === pts.length - 1 ? 0.2 : AP.reachTol)) i++;
    // scoring trigger: the path has reached the post area, the robot is there and holds a tube
    if (ev < events.length && i >= events[ev]) {
      if (!r.held.length) ev++;
      else if (nearPosts(r.alliance, r.x, r.z)) {
        ev++; tries = 1;
        if (startScore(sim, r)) { const o = aa.step(sim, dt, null); if (o) return o; }
      } else if (i > events[ev] + 8 || i >= pts.length) { postEnd += dt; if (postEnd > 1.5) ev++; }
    }
    if (i >= pts.length) {
      if (ev < events.length && r.held.length) { idle += dt; if (idle < 2) return {}; }
      done = true; return null;
    }

    const pr = r.preset, tank = pr.drive === 'tank', tgt = pts[Math.min(pts.length - 1, i + AP.lookahead)];
    const dx = tgt.x - r.x, dz = tgt.z - r.z, d = Math.hypot(dx, dz) || 1e-6, ux = dx / d, uz = dz / d;

    // loose tubes the path passes: intake + slow down
    let intake = false, near = false;
    if (r.held.length < 2) {
      for (const t of sim.state.tubes) {
        if (t.state !== 'floor') continue;
        const tx = t.x - r.x, tz = t.z - r.z;
        if (Math.abs(tx) > AP.intakeRange || Math.abs(tz) > AP.intakeRange || Math.hypot(tx, tz) > AP.intakeRange) continue;
        if (distToPolyline(t, pts, i - 3, i + 14) > AP.intakeNear) continue;
        near = true; if (Math.hypot(tx, tz) < AP.intakeRange) intake = true; break;
      }
    }
    // speed profile: cruise, brake into the end, slow in corners and near tubes
    const remaining = d + (pts.length - 1 - i) * AP.spacing;
    let v = Math.min(pr.maxSpeed * AP.cruise, Math.sqrt(2 * AP.brake * remaining) + 0.3);
    const ahead = pts[Math.min(pts.length - 1, i + 5)], turn = Math.abs(wrap(Math.atan2(ahead.z - tgt.z, ahead.x - tgt.x) - Math.atan2(uz, ux)));
    if (i + 5 < pts.length) v *= 1 - 0.45 * Math.min(1, turn / 1.2);
    if (near) v *= AP.intakeSlow;
    const hErr = wrap(Math.atan2(uz, ux) - r.heading);
    if (tank) v *= clamp(1.2 - Math.abs(hErr), 0, 1); // turn in place first when facing the wrong way

    // blocked?
    if (v > 0.5 && Math.hypot(r.vx || 0, r.vz || 0) < 0.15) stuck += dt; else stuck = Math.max(0, stuck - dt);
    if (stuck > AP.stuckTime) { stuck = 0; skips++; i = Math.min(pts.length, i + AP.skipAhead); }

    const out = { intake };
    if (tank) { out.throttle = v / pr.maxSpeed; out.turn = clamp(hErr * 1.6, -1, 1); }
    else { out.moveX = (ux * v) / pr.maxSpeed; out.moveZ = (uz * v) / pr.maxSpeed; out.rotate = clamp(hErr * 1.6, -1, 1); }
    return out;
  }

  return {
    step,
    get done() { return done; },
    get index() { return i; },
    get skips() { return skips; },
    get scoreFired() { return scoreFired; },
    get points() { return pts; },
    get state() { return { i, n: pts.length, skips, scoreFired, scoring: aa.active, done }; },
  };
}
