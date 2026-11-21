// FRC-style AutoAlign: pure controller (no DOM). Press Place inside your SCORING ZONE while holding a tube and the robot drives / strafes / turns to
// the alignment pose of the best post, fires the normal place (or launch) edge, and hands control back when the action finishes.
// It only ever outputs the normal sim Input fields (moveX/moveZ/rotate or throttle/turn + one-frame scoreUpper/scoreLower/launch edges),
// so every acceleration / traction / bumper limit still comes from the sim.
//
//   const aa = createAutoAlign();
//   aa.start(sim, robotId, tierMode)  -> { ok, reason }      tierMode: 'auto' | 'upper' | 'lower'
//   aa.step(sim, dt, manualInput?)    -> Input | null         null = not active (finished / cancelled / manual override)
//   aa.cancel(reason?)                aa.active  aa.target  aa.progress  aa.phase  aa.result
import { SIDES, POINTS, inRect } from './config.js';

export const AA = {
  timeout: 4.5,        // s to get aligned and fire (the place animation itself is not counted)
  gap: 0.5,            // m from the bumper front face to the post tip when aligned (sim reach is 1.2 m)
  latTol: 0.04, latTolTank: 0.08,      // lateral centering on the post, m
  headTol: 0.045, headTolTank: 0.06,   // heading square to the wall, rad
  gapTol: 0.15,        // along-axis stand-off tolerance, m
  speedTol: 0.25,      // m/s: must be (nearly) stopped to fire
  stuckTime: 1.5,      // s of "commanding motion but not moving" before picking another post / aborting
  cancelThreshold: 0.2, // manual stick / key magnitude that overrides auto-align
  retries: 2,          // sim rejected the edge (e.g. lost frame) -> try again this many times
  partialBonus: 0.5,   // seconds of "travel time" credit per tube already on a post (finish partially filled posts first)
};
export const ZONE_MSG = 'Auto-align only works in your scoring zone';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const inScoringZone = (r) => !!r && inRect(SIDES[r.alliance].scoringZone, r.x, r.z);
const hxOf = (r) => (r.bumper ? r.bumper.lx / 2 : r.radius || 0.5);
const speedOf = (r) => Math.hypot(r.vx || 0, r.vz || 0);
const label = (p) => `${p.tier.toUpperCase()} ${p.index + 1}`;

// Pose where a robot places on post p: bumper face AA.gap from the tip, centered on the post, square to the wall.
export function placePose(r, p, tune) {
  const phi = p.dirX < 0 ? 0 : Math.PI, c = Math.cos(phi), s = Math.sin(phi), hx = hxOf(r), gap = Math.min(AA.gap, (tune?.reach ?? 1.2) * 0.45);
  return { x: p.tipX - c * (gap + hx), z: p.z, heading: phi, c, s, gap, hx };
}
// Launcher pose: stay where we are if inside launch range, otherwise move just inside it. Always face the post tip.
export function launchPose(r, p, tune) {
  const lo = (tune?.launchMin ?? 1.5) + 0.4, hi = (tune?.launchMax ?? 5) - 0.6;
  const dx = r.x - p.tipX, dz = r.z - p.z, d = Math.hypot(dx, dz) || 1e-6;
  const dT = d < lo ? lo + 0.4 : d > hi ? hi - 0.4 : d;
  const x = p.tipX + (dx / d) * dT, z = p.z + (dz / d) * dT;
  return { x, z, heading: Math.atan2(p.z - z, p.tipX - x), inRange: d >= lo && d <= hi, dist: d };
}

function estTime(r, pose, tank) {
  const pr = r.preset, d = Math.hypot(pose.x - r.x, pose.z - r.z), turn = Math.abs(wrap(pose.heading - r.heading));
  return tank ? d / (0.6 * pr.maxSpeed) + turn / (0.6 * pr.turnRate) + 0.8 : Math.max(d / (0.65 * pr.maxSpeed) + 0.4, turn / (0.6 * pr.turnRate));
}

// Choose the post: has room (< 3 scored), not blocked by another robot, reachable in time. Partially filled posts get a bonus, then nearest.
export function pickTarget(sim, r, mode, exclude = new Set()) {
  const tank = r.preset.drive === 'tank', tiers = mode === 'launch' ? ['upper', 'lower'] : [mode];
  let best = null, bc = Infinity;
  for (const p of sim.state.posts) {
    if (p.alliance !== r.alliance || !tiers.includes(p.tier) || exclude.has(p.id) || p.tubes.length >= POINTS.maxScoringPerPost) continue;
    const pose = mode === 'launch' ? launchPose(r, p, sim.tune) : placePose(r, p, sim.tune);
    if (sim.state.robots.some((o) => o !== r && Math.hypot(o.x - pose.x, o.z - pose.z) < (o.radius || 0.5) + (r.radius || 0.5) * 0.9)) continue; // someone parked on the spot
    const t = estTime(r, pose, tank);
    if (t > AA.timeout * 0.9) continue;
    const cost = t - AA.partialBonus * p.tubes.length + (mode === 'launch' && p.tier === 'lower' ? 3 : 0);
    if (cost < bc) { bc = cost; best = { post: p, pose }; }
  }
  return best;
}

export function createAutoAlign() {
  let st = null, result = null;

  const finish = (ok, reason) => { if (st) result = { ok, reason, target: st.label, time: st.t }; st = null; return null; };
  function setTarget(sim, r, pick) {
    st.post = pick.post; st.label = label(pick.post); st.pose = pick.pose; st.phase = r.preset.drive === 'tank' ? 'pre' : 'drive';
    st.fired = false; st.stuck = 0; st.rev = false;
    st.d0 = Math.hypot(pick.pose.x - r.x, pick.pose.z - r.z) + 0.3 * Math.abs(wrap(pick.pose.heading - r.heading)) + 1e-3;
  }

  function start(sim, robotId, tier = 'auto') {
    const r = sim.robotById(robotId);
    if (!r) return { ok: false, reason: 'No such robot' };
    if (!r.held?.length) return { ok: false, reason: 'No tube held' };
    if (!inScoringZone(r)) return { ok: false, reason: ZONE_MSG };
    const pr = r.preset, canUp = !!pr.canUpper, canLow = pr.canLower !== false;
    let mode;
    if (pr.canLaunch && tier !== 'lower') mode = 'launch'; // launchers lob onto the best post in range (upper first) instead of driving in
    else if (tier === 'upper') mode = 'upper';
    else if (tier === 'lower') mode = 'lower';
    else mode = canUp ? 'upper' : 'lower';
    if (mode === 'upper' && !canUp) return { ok: false, reason: 'This robot cannot score UPPER posts' };
    if (mode === 'lower' && !canLow) return { ok: false, reason: 'This robot cannot score LOWER posts' };
    const pick = pickTarget(sim, r, mode);
    if (!pick) return { ok: false, reason: 'No open post to align to' };
    st = { id: robotId, mode, t: 0, excluded: new Set(), reselects: 0, retries: 0, heldAtFire: 0, alive: true };
    result = null;
    setTarget(sim, r, pick);
    return { ok: true, reason: '', target: st.label };
  }

  // ---- low-level controllers ----
  const heading = (r, target, k = 0.9) => clamp(wrap(target - r.heading) * k, -1, 1);
  const prof = (d, pr, k = 7) => Math.min(pr.maxSpeed * 0.95, Math.sqrt(2 * Math.min(pr.accel * 0.45, 5) * d), k * d); // braking-limited approach speed, m/s

  function swerve(sim, r, pose) {
    const pr = r.preset, ex = pose.x - r.x, ez = pose.z - r.z, d = Math.hypot(ex, ez), v = d > 1e-4 ? prof(d, pr) : 0;
    let vx = d > 1e-4 ? (ex / d) * v : 0, vz = d > 1e-4 ? (ez / d) * v : 0;
    const fade = clamp((d - 0.3) / 0.7, 0, 1); // no shoving away from robots once we're on top of the target
    if (fade > 0) for (const o of sim.state.robots) {
      if (o === r) continue;
      const dx = r.x - o.x, dz = r.z - o.z, dd = Math.hypot(dx, dz) || 1e-6, lim = (r.radius || 0.5) + (o.radius || 0.5) + 0.5;
      if (dd < lim) { const k = ((lim - dd) / 0.5) * 2.5 * fade; vx += (dx / dd) * k; vz += (dz / dd) * k; }
    }
    return { in: { moveX: vx / pr.maxSpeed, moveZ: vz / pr.maxSpeed, rotate: heading(r, pose.heading) }, want: Math.hypot(vx, vz) };
  }

  // Tank: point at the spot (reversing if that is quicker) and drive; returns throttle/turn.
  function tankGoto(r, pose) {
    const pr = r.preset, ex = pose.x - r.x, ez = pose.z - r.z, d = Math.hypot(ex, ez);
    let err = wrap(Math.atan2(ez, ex) - r.heading);
    if (st.rev ? Math.abs(err) < Math.PI / 2 - 0.25 : Math.abs(err) > Math.PI / 2 + 0.25) st.rev = !st.rev;
    if (st.rev) err = wrap(err + Math.PI);
    const v = d > 0.03 ? prof(d, pr, 4) : 0, a = Math.abs(err);
    const th = (a < 0.7 ? v * Math.cos(a) : 0) / pr.maxSpeed * (st.rev ? -1 : 1);
    return { in: { throttle: th, turn: clamp(err * 1.2, -1, 1) }, want: Math.abs(th) * pr.maxSpeed, d };
  }

  function tankFinal(r, pose) { // already roughly in the corridor: square up, then drive straight in / out along the wall normal
    const pr = r.preset, rx = r.x - pose.x, rz = r.z - pose.z;
    const along = rx * pose.c + rz * pose.s, lat = -rx * pose.s + rz * pose.c, herr = wrap(pose.heading - r.heading);
    const e = -along; // distance still to travel along the wall normal (positive = toward the wall)
    const bias = Math.abs(e) > 0.15 ? clamp(lat * 1.5, -0.25, 0.25) : 0;
    const tgt = pose.heading - bias; // positive heading = toward +perp, so to cancel +lat we aim slightly negative
    const turn = clamp(wrap(tgt - r.heading) * 1.2, -1, 1);
    const th = Math.abs(herr) > 0.15 ? 0 : (Math.sign(e) * prof(Math.abs(e), pr, 4)) / pr.maxSpeed;
    return { in: { throttle: th, turn }, want: Math.abs(th) * pr.maxSpeed };
  }

  const ZERO = () => ({ moveX: 0, moveZ: 0, rotate: 0, throttle: 0, turn: 0 });

  function step(sim, dt, manual) {
    if (!st) return null;
    const r = sim.robotById(st.id);
    if (!r) return finish(false, 'Robot lost');
    st.t += dt; api.updateProgress(sim);
    if (manual) {
      const m = Math.max(Math.abs(manual.moveX || 0), Math.abs(manual.moveZ || 0), Math.abs(manual.rotate || 0), Math.abs(manual.throttle || 0), Math.abs(manual.turn || 0));
      if (manual.place || m > AA.cancelThreshold) return finish(false, 'Auto-align cancelled');
    }
    if (st.phase === 'acting') {
      const a = r.action?.type;
      return a === 'place' || a === 'launch' ? ZERO() : finish(true, 'placed');
    }
    if (!r.held.length) return finish(false, 'No tube held');
    if (st.fired) {
      st.fired = false;
      const a = r.action?.type;
      if (a === 'place' || a === 'launch') { st.phase = 'acting'; return ZERO(); }
      if (r.held.length < st.heldAtFire) return finish(true, 'placed');
      if (++st.retries > AA.retries) return finish(false, 'Placement rejected');
    }
    if (st.t > AA.timeout) return finish(false, 'Auto-align timed out');

    const tank = r.preset.drive === 'tank', launch = st.mode === 'launch', p = st.post, pose = launch ? launchPose(r, p, sim.tune) : st.pose;
    if (st.post.tubes.length >= POINTS.maxScoringPerPost) { // someone filled it meanwhile
      st.excluded.add(p.id); const pick = pickTarget(sim, r, st.mode, st.excluded);
      if (!pick) return finish(false, 'No open post to align to');
      setTarget(sim, r, pick); return ZERO();
    }

    // alignment errors
    let ok, ctl;
    const spd = speedOf(r), calm = spd < AA.speedTol && Math.abs(r.omega || 0) < 0.4;
    if (launch) {
      const herr = Math.abs(wrap(pose.heading - r.heading)), dist = launchPose(r, p, sim.tune);
      ok = dist.inRange && herr < (tank ? AA.headTolTank : AA.headTol) * 1.5 && spd < 0.4 && Math.abs(r.omega || 0) < 0.5;
      ctl = tank ? (dist.inRange ? { in: { throttle: 0, turn: heading(r, pose.heading, 1.2) }, want: 0 } : tankGoto(r, pose)) : swerve(sim, r, pose);
    } else {
      const rx = r.x - pose.x, rz = r.z - pose.z, along = rx * pose.c + rz * pose.s, lat = -rx * pose.s + rz * pose.c, herr = Math.abs(wrap(pose.heading - r.heading));
      ok = Math.abs(lat) < (tank ? AA.latTolTank : AA.latTol) && herr < (tank ? AA.headTolTank : AA.headTol) && Math.abs(along) < AA.gapTol && calm;
      if (!tank) ctl = swerve(sim, r, pose);
      else {
        if (st.phase === 'pre' && Math.abs(lat) < 0.12 && herr < 0.5 && along < 0.15 && along > -1.3) st.phase = 'final';
        if (st.phase === 'pre') {
          const pre = { x: pose.x - pose.c * 0.6, z: pose.z - pose.s * 0.6 }; ctl = tankGoto(r, pre);
          if (ctl.d < 0.12 && spd < 0.6) st.phase = 'final';
        }
        if (st.phase === 'final') ctl = tankFinal(r, pose);
      }
    }

    if (ok) { // aligned: fire the normal sim edge and hold still
      const e = launch ? { launch: true } : st.mode === 'upper' ? { scoreUpper: true } : { scoreLower: true };
      st.fired = true; st.heldAtFire = r.held.length;
      return { ...ZERO(), ...e };
    }

    // blocked? (commanding motion but not moving)
    if (ctl.want > 0.5 && spd < 0.15) st.stuck += dt; else st.stuck = Math.max(0, st.stuck - dt);
    if (st.stuck > AA.stuckTime) {
      st.excluded.add(p.id);
      const pick = st.reselects++ < 2 ? pickTarget(sim, r, st.mode, st.excluded) : null;
      if (!pick) return finish(false, 'Auto-align blocked');
      setTarget(sim, r, pick); return ZERO();
    }
    return { ...ZERO(), ...ctl.in };
  }

  const progress = () => {
    if (!st) return result?.ok ? 1 : 0;
    if (st.phase === 'acting') return 1;
    return clamp(st.prog ?? 0, 0, 1);
  };

  const api = {
    start, step,
    cancel: (reason = 'Auto-align cancelled') => { if (st) finish(false, reason); },
    get active() { return !!st; },
    get target() { return st ? { id: st.post.id, tier: st.post.tier, index: st.post.index, label: st.label, mode: st.mode, x: st.pose.x, z: st.pose.z, heading: st.pose.heading } : null; },
    get phase() { return st ? st.phase : 'idle'; },
    get progress() { return progress(); },
    get result() { return result; },
    // refresh the progress ring from the live robot (cheap; main.js calls it once per frame)
    updateProgress(sim) {
      if (!st) return;
      const r = sim.robotById(st.id); if (!r) return;
      if (st.phase === 'acting') { st.prog = 1; return; }
      const pose = st.mode === 'launch' ? launchPose(r, st.post, sim.tune) : st.pose;
      const rem = Math.hypot(pose.x - r.x, pose.z - r.z) + 0.3 * Math.abs(wrap(pose.heading - r.heading));
      st.prog = clamp(1 - rem / st.d0, 0, 0.98);
    },
  };
  return api;
}
