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
  reach: ROBOT.maxExtension + 0.35, placeAngle: (35 * Math.PI) / 180, placeLateral: 0.3,
  launchAngle: (20 * Math.PI) / 180, launchMin: 1.5, launchMax: 5, throwDist: 4,
  intakeNear: 0.3, intakeFar: 1.1, intakeHalf: 0.55, intakeHalfWide: 0.8,
  feedCooldown: 1.5, manualCooldown: 0.8, chuteSpeed: 2.4, chuteTime: 0.6, feedClear: 1.0,
  releaseAt: 0.7, climbTouch: 0.2, climbAngle: (60 * Math.PI) / 180,
};

// Physics constants (SI). Robots: mass/yaw inertia, traction circle, DC-motor curve; tubes: light + bouncy.
const PHYS = {
  mass: 61, radius: ROBOT.radius, inertiaK: 0.55,   // yaw inertia = inertiaK * m * R^2
  mu: 1.05, latMu: 1.6,                             // carpet traction (accel <= mu*g); tank lateral friction
  response: 0.08, kv: 12, kw: 20,                   // module response (s); velocity / yaw-rate loop gains (1/s)
  alpha: 4, tankAlpha: 3.5, moduleR: 0.8,           // yaw accel per rad/s of turnRate; wheel radius from center (x R)
  crr: 0.02,                                        // rolling resistance coefficient
  robotRest: 0.15, robotMu: 0.35, wallRest: 0.15, wallMu: 0.3, restV: 0.4, slop: 0.003,
  tubeRest: 0.4, tubeWallRest: 0.4, tubeRobotRest: 0.3, tubeVisc: 1.4, tubeCrr: 0.5, tubeSpinDecay: 3,
  drag: 0.09, floorBounce: 0.35,                    // tube quadratic air drag (1/m), floor bounce in flight
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
  const obstacles = [...walls, ...postRails, ...platRects];

  const tubes = [];
  const tubeById = new Map();
  let tubeSeq = 0;
  function newTube(origin, x, z, state = 'floor') {
    const t = { id: `t${tubeSeq++}`, origin, x, y: TR, z, vx: 0, vy: 0, vz: 0, state, holder: null, post: null,
      stackIndex: -1, placedInAuto: false, yaw: 0, spin: 0, lockT: 0, chuteT: 0, moving: false, flight: null };
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
    const mass = preset.mass, radius = preset.radius;
    const st = o.start ?? SIDES[o.alliance].starts[o.slot ?? 0] ?? SIDES[o.alliance].starts[0];
    const r = { id: o.id, alliance: o.alliance, slot: o.slot ?? 0, number: o.number ?? '', preset, radius, mass, inertia: PHYS.inertiaK * mass * radius * radius,
      x: st.x, z: st.z, y: 0, heading: st.heading ?? 0, vx: 0, vz: 0, omega: 0, held: [], action: null,
      arm: 0, armTier: 'stow', support: 0, intakeOn: false, contacts: [] };
    robots.push(r); robotById.set(r.id, r);
    rt.set(r.id, { cx: 0, cz: 0, cr: 0, cth: 0, ctu: 0, platform: null, intakeT: 0, intakeTarget: null, touching: new Set(), prevClimb: false, act: null });
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
      if (f <= 0 || f - r.radius > TUNE.reach || Math.abs(l) > TUNE.placeLateral) continue;
      const sc = Math.abs(f - r.radius) + 2 * Math.abs(l);
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
    const x0 = r.x + c * (r.radius + 0.1), z0 = r.z + s * (r.radius + 0.1), y0 = r.y + 0.9;
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
    const D = Math.hypot(tx - x0, tz - z0), k0 = PHYS.drag;
    const vy = (ty - y0 + 0.5 * G * T * T) / T;
    t.flight = { t: 0, T, x0, y0, z0, tx, ty, tz, vy, post: p ? p.id : null };
    const vk = p || D < 1e-6 ? 1 : (Math.exp(k0 * D) - 1) / (k0 * D); // free throws: start faster to offset air drag
    t.vx = ((tx - x0) / T) * vk; t.vz = ((tz - z0) / T) * vk; t.vy = vy; t.spin = (rnd() - 0.5) * 6;
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
      if (d > r.radius + TUNE.climbTouch) continue;
      if (d > 1e-6 && Math.abs(wrap(Math.atan2(dz, dx) - r.heading)) > TUNE.climbAngle) continue;
      return q;
    }
    return null;
  }

  function startClimb(r, k) {
    const q = findClimbTarget(r, k);
    if (!q) return;
    const R = r.radius;
    const tx = clamp(r.x, q.x0 + R, q.x1 - R), tz = clamp(r.z, q.z0 + R, q.z1 - R);
    const open = q.z1 < 0 ? q.z1 : q.z0; // open edge faces field center
    const cz = q.z1 < 0 ? Math.min(tz, open - R) : Math.max(tz, open + R);
    r.action = { type: 'climb', t: 0, duration: r.preset.climbTime, target: q.id };
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
    const use = at / aTrac + (r.inertia * al) / (PHYS.moduleR * r.radius * m * aTrac);
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
    const half = r.preset.id === 'sweeper' ? TUNE.intakeHalfWide : TUNE.intakeHalf, dr = r.radius - ROBOT.radius;
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
        dropToFloor(t, r.x + c * (r.radius + 0.4), r.z + s * (r.radius + 0.4), c * 1.2 + r.vx, s * 1.2 + r.vz);
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

  // Static obstacle contact (n points from obstacle to robot): restitution on normal, Coulomb friction impulse -> spin.
  function wallHit(r, nx, nz, pen) {
    r.x += nx * pen; r.z += nz * pen;
    const R = r.radius, ax = -nx * R, az = -nz * R;                     // contact arm from center
    const vcx = r.vx - r.omega * az, vcz = r.vz + r.omega * ax;
    const vn = vcx * nx + vcz * nz;
    if (vn >= 0) return;
    const jn = -(1 + (vn < -PHYS.restV ? PHYS.wallRest : 0)) * vn * r.mass;
    r.vx += (nx * jn) / r.mass; r.vz += (nz * jn) / r.mass;
    const tx = -nz, tz = nx, vt = (r.vx - r.omega * az) * tx + (r.vz + r.omega * ax) * tz;
    const kt = 1 / r.mass + (R * R) / r.inertia;
    const jt = clamp(-vt / kt, -PHYS.wallMu * jn, PHYS.wallMu * jn);
    r.vx += (tx * jt) / r.mass; r.vz += (tz * jt) / r.mass; r.omega += (ax * tz - az * tx) * jt / r.inertia;
  }

  function collideRobotWorld(r, k) {
    const R = r.radius;
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
      for (const q of obstacles) { const n = circleRect(r.x, r.z, R, q); if (n) wallHit(r, n[0], n[1], n[2]); }
    }
    const mx = FIELD.halfL - R, mz = FIELD.halfW - R;
    if (r.x < -mx) wallHit(r, 1, 0, -mx - r.x); else if (r.x > mx) wallHit(r, -1, 0, r.x - mx);
    if (r.z < -mz) wallHit(r, 0, 1, -mz - r.z); else if (r.z > mz) wallHit(r, 0, -1, r.z - mz);
  }

  function collideRobots(first) {
    if (first) for (const r of robots) r.contacts = [];
    for (let i = 0; i < robots.length; i++) {
      for (let j = i + 1; j < robots.length; j++) {
        const a = robots[i], b = robots[j];
        if (Math.abs(a.y - b.y) > 0.35) continue;
        const ra = a.radius, rb = b.radius, R2 = ra + rb;
        let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        const ka = rt.get(a.id), key = b.id;
        if (first) {
          if (d < R2 + 0.03) {
            a.contacts.push(b.id); b.contacts.push(a.id);
            if (!ka.touching.has(key)) { ka.touching.add(key); emit({ type: 'contact', robotId: a.id, text: b.id }); }
          } else ka.touching.delete(key);
        }
        if (d >= R2) continue;
        if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
        const nx = dx / d, nz = dz / d;
        const aFix = a.action?.type === 'climb', bFix = b.action?.type === 'climb';
        const ia = aFix ? 0 : 1 / a.mass, ib = bFix ? 0 : 1 / b.mass, iia = aFix ? 0 : 1 / a.inertia, iib = bFix ? 0 : 1 / b.inertia;
        if (ia + ib === 0) continue;
        const cor = (Math.max(R2 - d - PHYS.slop, 0) * 0.9) / (ia + ib);
        a.x -= nx * cor * ia; a.z -= nz * cor * ia; b.x += nx * cor * ib; b.z += nz * cor * ib;
        const aax = nx * ra, aaz = nz * ra, bax = -nx * rb, baz = -nz * rb; // contact arms (a->p, b->p)
        let rvx = b.vx - b.omega * baz - (a.vx - a.omega * aaz), rvz = b.vz + b.omega * bax - (a.vz + a.omega * aax);
        const vn = rvx * nx + rvz * nz;
        if (vn >= 0) continue;
        const jn = (-(1 + (vn < -PHYS.restV ? PHYS.robotRest : 0)) * vn) / (ia + ib);
        a.vx -= nx * jn * ia; a.vz -= nz * jn * ia; b.vx += nx * jn * ib; b.vz += nz * jn * ib;
        rvx = b.vx - b.omega * baz - (a.vx - a.omega * aaz); rvz = b.vz + b.omega * bax - (a.vz + a.omega * aax);
        const tx = -nz, tz = nx, vt = rvx * tx + rvz * tz;
        const kt = ia + ib + ra * ra * iia + rb * rb * iib;
        const jt = clamp(-vt / kt, -PHYS.robotMu * jn, PHYS.robotMu * jn);
        a.vx -= tx * jt * ia; a.vz -= tz * jt * ia; b.vx += tx * jt * ib; b.vz += tz * jt * ib;
        a.omega -= (aax * tz - aaz * tx) * jt * iia; b.omega += (bax * tz - baz * tx) * jt * iib;
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
      const n = circleRect(t.x, t.z, r, q);
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
    for (const r of robots) {
      if (r.y > 0.1) continue;
      const k = rt.get(r.id), rr = r.radius + TUBE.outerRadius;
      const dx = t.x - r.x, dz = t.z - r.z, d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      if (k.zone && t.lockT <= 0) {
        const c = Math.cos(r.heading), s = Math.sin(r.heading), f = dx * c + dz * s, l = -dx * s + dz * c;
        if (f > TUNE.intakeNear + r.radius - ROBOT.radius && Math.abs(l) < (r.preset.id === 'sweeper' ? TUNE.intakeHalfWide : TUNE.intakeHalf)) continue;
      }
      let d = Math.sqrt(d2), nx, nz;
      if (d < 1e-6) { nx = 1; nz = 0; d = 0; } else { nx = dx / d; nz = dz / d; }
      const pen = rr - d;
      t.x += nx * pen; t.z += nz * pen;
      const ax = nx * r.radius, az = nz * r.radius;                   // robot surface velocity incl. spin
      const rvx = t.vx - (r.vx - r.omega * az), rvz = t.vz - (r.vz + r.omega * ax), vn = rvx * nx + rvz * nz;
      if (vn < 0) {
        const dv = -(1 + (vn < -PHYS.restV ? PHYS.tubeRobotRest : 0)) * vn, mr = TUBE.mass / r.mass;
        t.vx += dv * nx; t.vz += dv * nz; r.vx -= dv * nx * mr; r.vz -= dv * nz * mr;
        t.spin += (rvx * -nz + rvz * nx) * 2;
      }
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
    const fric = Math.exp(-PHYS.tubeVisc * dt), crr = PHYS.tubeCrr * dt, sdec = Math.exp(-PHYS.tubeSpinDecay * dt);
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
          const dk = Math.exp(-PHYS.drag * Math.hypot(t.vx, t.vy, t.vz) * dt); // quadratic air drag
          t.vx *= dk; t.vz *= dk; t.vy = t.vy * dk - G * dt;
          t.x += t.vx * dt; t.y += t.vy * dt; t.z += t.vz * dt;
          t.yaw += t.spin * dt;
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
        t.x += t.vx * dt; t.z += t.vz * dt; t.y = TR;
        if (t.state === 'chute') { t.chuteT -= dt; if (t.chuteT <= 0) t.state = 'floor'; }
        else {
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
    t.vx = h.c.dirX * TUNE.chuteSpeed; t.vz = h.c.dirZ * TUNE.chuteSpeed; t.chuteT = TUNE.chuteTime; t.spin = (rnd() - 0.5) * 3;
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
      else driveRobot(r, k, inp, dt, scale);
      updateIntake(r, k, !disabled && !!raw.intake, dt);
      if (r.action?.type !== 'climb') moveRobot(r, k, dt);
      progressAction(r, k, dt);
      if (!r.action || (r.action.type !== 'place' && r.action.type !== 'launch' && r.action.type !== 'climb'))
        r.arm = Math.max(0, r.arm - 4 * dt);
      if (r.arm <= 0 && !r.action) r.armTier = 'stow';
      else if (r.action?.type === 'intake') r.armTier = 'floor';
    }
    collideRobots(true); collideRobots(false);
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

  return { state, step, drainEvents, requestHumanTube, robotById: (id) => robotById.get(id), tubeById: (id) => tubeById.get(id), tune: TUNE, phys: PHYS };
}
