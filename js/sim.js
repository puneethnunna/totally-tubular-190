// Game state + lightweight 2.5D physics for TOTALLY TUBULAR. No DOM, no Three.js, deterministic.
import { FIELD, TUBE, ROBOT, POINTS, SIDES, ALLIANCES, ROBOT_PRESETS, inRect } from './config.js';

const TAU = Math.PI * 2;
const G = 9.81;
const TR = TUBE.tubeRadius;
const TIP_SPACING = 0.09;
const MAX_SUB = 1 / 60;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const num = (v) => (Number.isFinite(v) ? clamp(v, -1, 1) : 0);
const approach = (v, t, d) => (v < t ? Math.min(v + d, t) : Math.max(v - d, t));
const smooth = (u) => u * u * (3 - 2 * u);

// Tunables
const TUNE = {
  reach: ROBOT.maxExtension + 0.35, placeAngle: (35 * Math.PI) / 180, placeLateral: 0.3,
  launchAngle: (20 * Math.PI) / 180, launchMin: 1.5, launchMax: 5, throwDist: 4,
  intakeNear: 0.3, intakeFar: 1.1, intakeHalf: 0.55, intakeHalfWide: 0.8,
  feedCooldown: 1.5, manualCooldown: 0.8, chuteSpeed: 2.4, chuteTime: 0.6, feedClear: 1.0,
  robotRest: 0.1, tubeRest: 0.3, wallRest: 0.4, grip: 10,
  releaseAt: 0.7, climbTouch: 0.2, climbAngle: (60 * Math.PI) / 180,
};

// circle vs rect -> [nx, nz, penetration] pointing out of the rect, or null
function circleRect(x, z, r, q) {
  const px = clamp(x, q.x0, q.x1), pz = clamp(z, q.z0, q.z1);
  const dx = x - px, dz = z - pz, d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  if (d2 > 1e-12) { const d = Math.sqrt(d2); return [dx / d, dz / d, r - d]; }
  const l = x - q.x0, rr = q.x1 - x, t = z - q.z0, b = q.z1 - z, m = Math.min(l, rr, t, b);
  if (m === l) return [-1, 0, l + r];
  if (m === rr) return [1, 0, rr + r];
  if (m === t) return [0, -1, t + r];
  return [0, 1, b + r];
}

export function createSim(options = {}) {
  const events = [];
  const emit = (e) => events.push(e);
  const midfield = { blue: options.midfield?.blue ?? 8, red: options.midfield?.red ?? 8 };
  const autoHP = options.autoHumanPlayer !== false;

  const posts = [];
  for (const a of ALLIANCES) for (const p of SIDES[a].posts) posts.push({ ...p, tubes: [] });
  const postById = new Map(posts.map((p) => [p.id, p]));
  const walls = ALLIANCES.map((a) => SIDES[a].shortWall);
  const platforms = ALLIANCES.flatMap((a) => SIDES[a].platforms.map((p) => ({ ...p, alliance: a, id: `${a}-L${p.level}` })));
  const platRects = platforms;

  const tubes = [];
  const tubeById = new Map();
  let tubeSeq = 0;
  function newTube(origin, x, z, state = 'floor') {
    const t = { id: `t${tubeSeq++}`, origin, x, y: TR, z, vx: 0, vy: 0, vz: 0, state, holder: null, post: null,
      stackIndex: -1, placedInAuto: false, lockT: 0, chuteT: 0, moving: false, flight: null };
    tubes.push(t); tubeById.set(t.id, t);
    return t;
  }

  // ---- robots ----
  const robots = [];
  const robotById = new Map();
  const rt = new Map(); // per-robot internal
  const preloads = { blue: 0, red: 0 };
  for (const o of options.robots ?? []) {
    const preset = ROBOT_PRESETS.find((p) => p.id === (o.preset?.id ?? o.preset)) ?? ROBOT_PRESETS[0];
    const st = o.start ?? SIDES[o.alliance].starts[o.slot ?? 0];
    const r = { id: o.id, alliance: o.alliance, slot: o.slot ?? 0, number: o.number ?? '', preset,
      x: st.x, z: st.z, y: 0, heading: st.heading ?? 0, vx: 0, vz: 0, omega: 0, held: [], action: null,
      arm: 0, armTier: 'stow', support: 0, intakeOn: false, contacts: [] };
    robots.push(r); robotById.set(r.id, r);
    rt.set(r.id, { platform: null, intakeT: 0, intakeTarget: null, touching: new Set(), prevClimb: false, act: null });
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

  const chutes = ALLIANCES.flatMap((a) => SIDES[a].chutes.map((c, i) => ({ alliance: a, index: i, c, cd: 0.5 + 0.2 * i })));

  const state = { time: 0, robots, tubes, posts, reserve };
  let phase = 'pre';
  let first = true;

  // ---------- helpers ----------
  const postStackPos = (p, idx) => ({ x: p.tipX - p.dirX * TIP_SPACING * idx, y: p.y, z: p.z });
  const speed2 = (o) => o.vx * o.vx + o.vz * o.vz;

  function release(t) { // remove from holder
    const r = robotById.get(t.holder);
    if (r) r.held = r.held.filter((id) => id !== t.id);
    t.holder = null;
  }

  function stackOn(t, p, holderId) {
    const idx = p.tubes.length;
    const s = postStackPos(p, idx);
    Object.assign(t, { state: 'post', post: p.id, stackIndex: idx, x: s.x, y: s.y, z: s.z, vx: 0, vy: 0, vz: 0,
      flight: null, placedInAuto: phase === 'auto' });
    p.tubes.push(t.id);
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
      if (f <= 0 || f - ROBOT.radius > TUNE.reach || Math.abs(l) > TUNE.placeLateral) continue;
      const sc = Math.abs(f - ROBOT.radius) + 2 * Math.abs(l);
      if (sc < bs) { bs = sc; best = p; }
    }
    return best;
  }

  function startPlace(r, tier) {
    const k = rt.get(r.id);
    if (!r.held.length) return emit({ type: 'invalid', robotId: r.id, text: 'no tube held' });
    if ((tier === 'lower' && !r.preset.canLower) || (tier === 'upper' && !r.preset.canUpper))
      return emit({ type: 'invalid', robotId: r.id, text: `cannot place ${tier}` });
    const p = findPost(r, tier);
    if (!p) return emit({ type: 'invalid', robotId: r.id, text: 'no post in range' });
    if (p.tubes.length >= POINTS.maxPhysicalPerPost) return emit({ type: 'invalid', robotId: r.id, postId: p.id, text: 'post full' });
    r.action = { type: 'place', t: 0, duration: r.preset.placeTime, target: p.id };
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
    const x0 = r.x + c * (ROBOT.radius + 0.1), z0 = r.z + s * (ROBOT.radius + 0.1), y0 = r.y + 0.9;
    release(t);
    Object.assign(t, { state: 'flight', x: x0, y: y0, z: z0, placedInAuto: false, post: null });
    const p = r.action.target ? postById.get(r.action.target) : null;
    let tx, ty, tz, T;
    if (p) {
      const s2 = postStackPos(p, p.tubes.length);
      tx = s2.x; ty = s2.y; tz = s2.z; T = clamp(Math.hypot(tx - x0, tz - z0) / 6, 0.45, 1.1);
    } else {
      tx = clamp(x0 + c * TUNE.throwDist, -FIELD.halfL + TUBE.outerRadius, FIELD.halfL - TUBE.outerRadius);
      tz = clamp(z0 + s * TUNE.throwDist, -FIELD.halfW + TUBE.outerRadius, FIELD.halfW - TUBE.outerRadius);
      ty = TR; T = 0.9;
    }
    const vy = (ty - y0 + 0.5 * G * T * T) / T;
    t.flight = { t: 0, T, x0, y0, z0, tx, ty, tz, vy, post: p ? p.id : null };
    t.vx = (tx - x0) / T; t.vz = (tz - z0) / T; t.vy = vy;
    emit({ type: 'launch', robotId: r.id, tubeId: t.id, postId: p ? p.id : undefined });
  }

  function findClimbTarget(r, k) {
    const need = Math.max(r.support, 1) + 1;
    if (need > r.preset.maxClimb) return null;
    const c = Math.cos(r.heading), s = Math.sin(r.heading);
    for (const q of platforms) {
      if (q.alliance !== r.alliance || q.level !== need) continue;
      const px = clamp(r.x, q.x0, q.x1), pz = clamp(r.z, q.z0, q.z1);
      const dx = px - r.x, dz = pz - r.z, d = Math.hypot(dx, dz);
      if (d > ROBOT.radius + TUNE.climbTouch) continue;
      if (d > 1e-6 && Math.abs(wrap(Math.atan2(dz, dx) - r.heading)) > TUNE.climbAngle) continue;
      return q;
    }
    return null;
  }

  function startClimb(r, k) {
    const q = findClimbTarget(r, k);
    if (!q) return;
    const R = ROBOT.radius;
    const tx = clamp(r.x, q.x0 + R, q.x1 - R), tz = clamp(r.z, q.z0 + R, q.z1 - R);
    const open = q.z1 < 0 ? q.z1 : q.z0; // open edge faces field center
    const cz = q.z1 < 0 ? Math.min(tz, open - R) : Math.max(tz, open + R);
    r.action = { type: 'climb', t: 0, duration: r.preset.climbTime, target: q.id };
    k.act = { q, fx: r.x, fz: r.z, fy: r.y, tx, tz: cz };
    r.armTier = 'stow';
    emit({ type: 'climb', robotId: r.id, text: `start L${q.level}` });
  }

  // ---------- robot update ----------
  function driveRobot(r, inp, dt, scale) {
    const p = r.preset, sp = p.maxSpeed * scale;
    let mx = inp.moveX, mz = inp.moveZ, th = inp.throttle, tu = inp.turn, rot = inp.rotate;
    const maxd = p.accel * dt;
    if (p.drive === 'tank') {
      if (!th && !tu && (mx || mz)) {
        const err = wrap(Math.atan2(mz, mx) - r.heading);
        tu = clamp(err * 3, -1, 1); th = Math.min(1, Math.hypot(mx, mz)) * Math.max(0, Math.cos(err));
      }
      const c = Math.cos(r.heading), s = Math.sin(r.heading);
      let vf = r.vx * c + r.vz * s, vl = -r.vx * s + r.vz * c;
      vf = approach(vf, th * sp, maxd);
      vl *= Math.exp(-TUNE.grip * dt);
      r.vx = vf * c - vl * s; r.vz = vf * s + vl * c;
      rot = tu;
    } else {
      const m = Math.hypot(mx, mz);
      if (m > 1) { mx /= m; mz /= m; }
      let dx = mx * sp - r.vx, dz = mz * sp - r.vz;
      const d = Math.hypot(dx, dz);
      if (d > maxd) { dx *= maxd / d; dz *= maxd / d; }
      r.vx += dx; r.vz += dz;
    }
    r.omega = approach(r.omega, rot * p.turnRate * scale, p.turnRate * 10 * dt);
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
    const half = r.preset.id === 'sweeper' ? TUNE.intakeHalfWide : TUNE.intakeHalf;
    let best = null, bd = 1e9;
    for (const t of tubes) {
      if ((t.state !== 'floor' && t.state !== 'chute') || t.lockT > 0) continue;
      const dx = t.x - r.x, dz = t.z - r.z, f = dx * c + dz * s, l = -dx * s + dz * c;
      if (f < TUNE.intakeNear || f > TUNE.intakeFar || Math.abs(l) > half) continue;
      const d = f + Math.abs(l);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) { if (r.action?.type === 'intake') r.action = null; k.intakeT = 0; k.intakeTarget = null; return; }
    if (k.intakeTarget !== best.id) { k.intakeTarget = best.id; k.intakeT = 0; }
    k.intakeT += dt;
    r.action = { type: 'intake', t: k.intakeT, duration: r.preset.intakeTime, target: best.id };
    r.armTier = 'floor';
    const px = r.x + c * 0.55, pz = r.z + s * 0.55, a = Math.min(1, 12 * dt);
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
      const e = smooth(u), q = k.act.q;
      r.x = k.act.fx + (k.act.tx - k.act.fx) * e; r.z = k.act.fz + (k.act.tz - k.act.fz) * e;
      r.y = k.act.fy + (q.height - k.act.fy) * e; r.vx = r.vz = r.omega = 0;
      r.arm = Math.sin(Math.PI * u);
      if (u >= 1) {
        k.platform = q; r.y = q.height; r.support = q.level; r.action = null; k.act = null;
        emit({ type: 'climb', robotId: r.id, text: `L${q.level}` });
      }
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
        dropToFloor(t, r.x + c * (ROBOT.radius + 0.4), r.z + s * (ROBOT.radius + 0.4), c * 1.2 + r.vx, s * 1.2 + r.vz);
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
    r.heading = wrap(r.heading + r.omega * dt);
    r.x += r.vx * dt; r.z += r.vz * dt;
  }

  function collideRobotWorld(r, k) {
    const R = ROBOT.radius;
    const bump = (n) => { const vn = r.vx * n[0] + r.vz * n[1]; if (vn < 0) { r.vx -= vn * n[0]; r.vz -= vn * n[1]; } };
    if (k.platform) {
      const q = k.platform, open = q.z1 < 0;
      const out = open ? r.z > q.z1 - 0.15 : r.z < q.z0 + 0.15;
      if (out) { k.platform = null; }
      else {
        r.x = clamp(r.x, q.x0 + R, q.x1 - R);
        r.z = open ? Math.max(r.z, q.z0 + R) : Math.min(r.z, q.z1 - R);
        r.y = q.height;
      }
    }
    if (!k.platform && r.action?.type !== 'climb') {
      for (const q of walls) { const n = circleRect(r.x, r.z, R, q); if (n) { r.x += n[0] * n[2]; r.z += n[1] * n[2]; bump(n); } }
      for (const q of platRects) { const n = circleRect(r.x, r.z, R, q); if (n) { r.x += n[0] * n[2]; r.z += n[1] * n[2]; bump(n); } }
    }
    const mx = FIELD.halfL - R, mz = FIELD.halfW - R;
    if (r.x < -mx) { r.x = -mx; if (r.vx < 0) r.vx = 0; } else if (r.x > mx) { r.x = mx; if (r.vx > 0) r.vx = 0; }
    if (r.z < -mz) { r.z = -mz; if (r.vz < 0) r.vz = 0; } else if (r.z > mz) { r.z = mz; if (r.vz > 0) r.vz = 0; }
  }

  function collideRobots() {
    const R2 = 2 * ROBOT.radius;
    for (const r of robots) r.contacts = [];
    for (let i = 0; i < robots.length; i++) {
      for (let j = i + 1; j < robots.length; j++) {
        const a = robots[i], b = robots[j];
        if (Math.abs(a.y - b.y) > 0.35) continue;
        let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        const ka = rt.get(a.id), kb = rt.get(b.id);
        const key = b.id;
        if (d < R2 + 0.03) {
          a.contacts.push(b.id); b.contacts.push(a.id);
          if (!ka.touching.has(key)) { ka.touching.add(key); emit({ type: 'contact', robotId: a.id, text: b.id }); }
        } else ka.touching.delete(key);
        if (d >= R2) continue;
        if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
        const nx = dx / d, nz = dz / d, pen = (R2 - d) / 2;
        const aFix = a.action?.type === 'climb', bFix = b.action?.type === 'climb';
        const wa = aFix ? 0 : bFix ? 1 : 0.5, wb = bFix ? 0 : aFix ? 1 : 0.5;
        a.x -= nx * pen * 2 * wa; a.z -= nz * pen * 2 * wa; b.x += nx * pen * 2 * wb; b.z += nz * pen * 2 * wb;
        const vn = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (vn < 0) {
          const j2 = -(1 + TUNE.robotRest) * vn;
          a.vx -= nx * j2 * wa; a.vz -= nz * j2 * wa; b.vx += nx * j2 * wb; b.vz += nz * j2 * wb;
        }
      }
    }
  }

  // ---------- tubes ----------
  const grid = new Map();
  const cellKey = (x, z) => (Math.floor(x / 0.5) + 64) * 256 + (Math.floor(z / 0.5) + 64);

  function tubeWalls(t) {
    const r = TUBE.outerRadius;
    const mx = FIELD.halfL - r, mz = FIELD.halfW - r;
    if (t.x < -mx) { t.x = -mx; if (t.vx < 0) t.vx = -t.vx * TUNE.wallRest; } else if (t.x > mx) { t.x = mx; if (t.vx > 0) t.vx = -t.vx * TUNE.wallRest; }
    if (t.z < -mz) { t.z = -mz; if (t.vz < 0) t.vz = -t.vz * TUNE.wallRest; } else if (t.z > mz) { t.z = mz; if (t.vz > 0) t.vz = -t.vz * TUNE.wallRest; }
    const bounce = (q) => {
      const n = circleRect(t.x, t.z, r, q);
      if (!n) return;
      t.x += n[0] * n[2]; t.z += n[1] * n[2];
      const vn = t.vx * n[0] + t.vz * n[1];
      if (vn < 0) { t.vx -= (1 + TUNE.wallRest) * vn * n[0]; t.vz -= (1 + TUNE.wallRest) * vn * n[1]; }
    };
    for (const q of walls) bounce(q);
    for (const q of platRects) bounce(q);
  }

  function tubeRobot(t) {
    const rr = ROBOT.radius + TUBE.outerRadius;
    for (const r of robots) {
      if (r.y > 0.1) continue;
      const k = rt.get(r.id);
      const dx = t.x - r.x, dz = t.z - r.z, d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      if (k.zone && t.lockT <= 0) {
        const c = Math.cos(r.heading), s = Math.sin(r.heading), f = dx * c + dz * s, l = -dx * s + dz * c;
        if (f > TUNE.intakeNear && Math.abs(l) < (r.preset.id === 'sweeper' ? TUNE.intakeHalfWide : TUNE.intakeHalf)) continue;
      }
      let d = Math.sqrt(d2), nx, nz;
      if (d < 1e-6) { nx = 1; nz = 0; d = 0; } else { nx = dx / d; nz = dz / d; }
      const pen = rr - d;
      t.x += nx * pen; t.z += nz * pen;
      const vn = (t.vx - r.vx) * nx + (t.vz - r.vz) * nz;
      if (vn < 0) { t.vx -= (1 + 0.2) * vn * nx; t.vz -= (1 + 0.2) * vn * nz; }
      tubeWalls(t);
      // pinned against a wall: slide sideways around the robot
      const ex = t.x - r.x, ez = t.z - r.z, ed = Math.hypot(ex, ez);
      if (ed < rr - 0.02) {
        const sgn = (-ez * (t.vx || 1) + ex * (t.vz || 0)) >= 0 ? 1 : -1;
        const tx = -ez / (ed || 1) * sgn, tz = ex / (ed || 1) * sgn, push = rr - ed;
        t.x += tx * push; t.z += tz * push; tubeWalls(t);
      }
    }
  }

  function updateTubes(dt) {
    const fric = Math.exp(-TUBE.friction * dt);
    const act = [];
    for (const t of tubes) {
      if (t.lockT > 0) t.lockT -= dt;
      if (t.state === 'held') {
        const r = robotById.get(t.holder), i = r.held.indexOf(t.id), c = Math.cos(r.heading), s = Math.sin(r.heading);
        t.x = r.x + c * 0.1; t.z = r.z + s * 0.1; t.y = r.y + 0.55 + 0.18 * Math.max(0, i);
        t.vx = r.vx; t.vz = r.vz; t.vy = 0; t.moving = false;
      } else if (t.state === 'flight') {
        const f = t.flight;
        f.t += dt;
        if (f.post) {
          const u = Math.min(1, f.t / f.T);
          t.x = f.x0 + (f.tx - f.x0) * u; t.z = f.z0 + (f.tz - f.z0) * u;
          t.y = f.y0 + f.vy * f.t - 0.5 * G * f.t * f.t;
          t.vy = f.vy - G * f.t;
          if (f.t >= f.T) {
            const p = postById.get(f.post);
            if (p.tubes.length < POINTS.maxPhysicalPerPost) stackOn(t, p, undefined);
            else {
              dropToFloor(t, clamp(p.tipX + p.dirX * 0.45, -7.7, 7.7), p.z);
              emit({ type: 'land', tubeId: t.id, postId: p.id, text: 'post full' });
            }
          }
        } else {
          t.vy -= G * dt; t.x += t.vx * dt; t.y += t.vy * dt; t.z += t.vz * dt;
          t.x = clamp(t.x, -FIELD.halfL + TUBE.outerRadius, FIELD.halfL - TUBE.outerRadius);
          t.z = clamp(t.z, -FIELD.halfW + TUBE.outerRadius, FIELD.halfW - TUBE.outerRadius);
          if (t.y <= TR && t.vy < 0) {
            dropToFloor(t, t.x, t.z, t.vx * 0.4, t.vz * 0.4);
            emit({ type: 'land', tubeId: t.id });
          }
        }
        t.moving = true;
      } else if (t.state === 'floor' || t.state === 'chute') {
        t.x += t.vx * dt; t.z += t.vz * dt; t.y = TR;
        if (t.state === 'chute') { t.chuteT -= dt; if (t.chuteT <= 0) t.state = 'floor'; }
        else { t.vx *= fric; t.vz *= fric; }
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
              const j2 = -(1 + TUNE.tubeRest) * vn / 2;
              a.vx -= nx * j2; a.vz -= nz * j2; o.vx += nx * j2; o.vz += nz * j2;
            }
          }
        }
      }
      for (const t of act) { tubeRobot(t); tubeWalls(t); }
    }
    for (const t of act) {
      const sp = t.vx * t.vx + t.vz * t.vz;
      if (sp < 0.0016 && t.state === 'floor') { t.vx = t.vz = 0; t.moving = false; if (phase === 'auto') t.placedInAuto = true; }
      else { t.moving = true; t.placedInAuto = false; }
      if (!Number.isFinite(t.x + t.z)) { t.x = 0; t.z = 0; t.vx = t.vz = 0; }
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
    t.vx = h.c.dirX * TUNE.chuteSpeed; t.vz = h.c.dirZ * TUNE.chuteSpeed; t.chuteT = TUNE.chuteTime;
    reserve[h.alliance]--; h.cd = cd;
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
      else driveRobot(r, inp, dt, scale);
      updateIntake(r, k, !disabled && !!raw.intake, dt);
      if (r.action?.type !== 'climb') moveRobot(r, k, dt);
      progressAction(r, k, dt);
      if (!r.action || (r.action.type !== 'place' && r.action.type !== 'launch' && r.action.type !== 'climb'))
        r.arm = Math.max(0, r.arm - 4 * dt);
      if (r.arm <= 0 && !r.action) r.armTier = 'stow';
      else if (r.action?.type === 'intake') r.armTier = 'floor';
    }
    collideRobots();
    for (const r of robots) {
      const k = rt.get(r.id);
      collideRobotWorld(r, k);
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
    const n = Math.ceil(dt / MAX_SUB - 1e-9), h = dt / n;
    for (let i = 0; i < n; i++) substep(h, inputs, i === 0);
  }

  function requestHumanTube(alliance, chuteIndex) {
    if (!feedPhase() || !(reserve[alliance] > 0)) return false;
    const list = chutes.filter((h) => h.alliance === alliance && (chuteIndex === undefined || h.index === chuteIndex));
    for (const h of list) if (h.cd <= 0 && chuteFree(h)) return feed(h, TUNE.manualCooldown);
    return false;
  }

  function drainEvents() { return events.splice(0, events.length); }

  return { state, step, drainEvents, requestHumanTube, robotById: (id) => robotById.get(id), tubeById: (id) => tubeById.get(id), tune: TUNE };
}
