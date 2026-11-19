// Bot driver: createBot(robotId, alliance, difficulty) -> { think(sim, match, dt) -> Input }.
// Always outputs field-frame moveX/moveZ + rotate (tank robots: sim converts; pure turns use `turn`).
import { FIELD, ROBOT, SIDES, TUBE, ALLIANCES, opponent, inRect } from './config.js';

const R = ROBOT.radius, TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => { a %= TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; };
const hyp = Math.hypot;
const rectDist = (r, x, z) => { const px = clamp(x, r.x0, r.x1), pz = clamp(z, r.z0, r.z1); return { d: hyp(x - px, z - pz), px, pz }; };
const WALLS = ALLIANCES.map((a) => SIDES[a].shortWall);
const BOXES = ALLIANCES.flatMap((a) => SIDES[a].platforms);

const DIFF = {
  easy:   { speed: 0.6,  react: 0.5,  aim: 0.18, end: 18, fill: false },
  normal: { speed: 0.85, react: 0.25, aim: 0.09, end: 22, fill: true },
  hard:   { speed: 1,    react: 0.1,  aim: 0.045, end: 26, fill: true },
};

// Cross-bot claims so teammates don't chase the same tube / post slot (expire after 1.2 s; stale across matches ignored).
const claims = new Map();
const claimed = (k, id, t) => { const c = claims.get(k); return !!c && c.id !== id && t - c.t >= 0 && t - c.t < 1.2; };
const claim = (k, id, t) => claims.set(k, { id, t });

export function createBot(robotId, alliance, difficulty = 'normal') {
  const P = DIFF[difficulty] || DIFF.normal;
  const side = SIDES[alliance], oside = SIDES[opponent(alliance)];
  const wallDir = alliance === 'blue' ? 1 : -1; // x direction toward own post wall
  const st = {
    mode: 'collect', tubeId: null, tubeT: 0, reT: 0, noTube: false, black: new Map(), stuckT: 0, stuckN: 0, flip: 1, unstick: null,
    lastCmd: 0, lastDir: { x: 1, z: 0 }, post: null, postBan: new Map(), staged: false, alignT: 0, creep: 0, fails: 0,
    waiting: false, pressAt: -9, heldAtPress: 0,
  };

  function steer(c, gx, gz, o = {}) {
    const { me } = c;
    const d = hyp(gx - me.x, gz - me.z) || 1e-6, ux = (gx - me.x) / d, uz = (gz - me.z) / d;
    let vx = ux, vz = uz;
    const push = (ax, az, w) => { vx += ax * w; vz += az * w; };
    for (const r of c.S.robots) {
      if (r.id === me.id) continue;
      const rx = me.x - r.x, rz = me.z - r.z, rd = hyp(rx, rz), range = r.alliance === alliance ? 1.8 : 2.2;
      if (rd >= range || rd < 1e-3) continue;
      const w = Math.min(1.5, (range - rd) / 0.8), ax = rx / rd, az = rz / rd;
      let tx = -az, tz = ax;
      if (tx * ux + tz * uz < 0) { tx = -tx; tz = -tz; }
      push(ax, az, w); push(tx, tz, w * 0.8);
    }
    const rects = [...c.zones];
    if (!o.free) {
      const hl = FIELD.halfL, hw = FIELD.halfW;
      for (const [dd, ax, az] of [[hl - me.x, -1, 0], [hl + me.x, 1, 0], [hw - me.z, 0, -1], [hw + me.z, 0, 1]]) if (dd < 0.95) push(ax, az, (0.95 - dd) / 0.5);
      rects.push(...WALLS, ...(o.noBoxes ? [] : BOXES));
    }
    for (const rc of rects) {
      const q = rectDist(rc, me.x, me.z);
      if (q.d < 1 && q.d > 1e-3) push((me.x - q.px) / q.d, (me.z - q.pz) / q.d, (1 - q.d) / 0.5);
    }
    const m = hyp(vx, vz) || 1;
    const sp = (o.speed ?? 1) * P.speed * clamp(d / (o.slow ?? 1.2), o.min ?? 0.2, 1);
    const v = { x: (vx / m) * sp, z: (vz / m) * sp };
    for (const zr of c.zones) { // never drive into protected zones
      const q = rectDist(zr, me.x, me.z);
      if (q.d < 0.62 && q.d > 1e-3) {
        const nx = (me.x - q.px) / q.d, nz = (me.z - q.pz) / q.d, dot = v.x * nx + v.z * nz;
        if (dot < 0) { v.x -= dot * nx; v.z -= dot * nz; }
      }
    }
    return v;
  }

  const turnTo = (me, ang) => clamp(wrap(ang - me.heading) * 3.5, -1, 1);

  function drive(out, c, v, rot) {
    const m = hyp(v.x, v.z), tank = c.preset.drive === 'tank';
    st.lastCmd = m;
    if (m > 1e-3) st.lastDir = { x: v.x / m, z: v.z / m };
    if (m > 0.04) { out.moveX = v.x; out.moveZ = v.z; if (!tank) out.rotate = rot; }
    else if (tank) out.turn = rot; else out.rotate = rot;
  }

  // Precise approach to a stand spot: returns true when in position.
  function hold(c, out, sx, sz, ang) {
    const { me } = c;
    const dx = sx - me.x, dz = sz - me.z, d = hyp(dx, dz), rot = turnTo(me, ang);
    const there = d < 0.16;
    const v = there || d < 0.07 ? { x: 0, z: 0 } : { x: (dx / d) * clamp(d * 1.8, 0.14, 0.5), z: (dz / d) * clamp(d * 1.8, 0.14, 0.5) };
    drive(out, c, v, rot);
    return there && hyp(me.vx, me.vz) < 0.3 && Math.abs(wrap(ang - me.heading)) < P.aim;
  }

  // ---------- collecting ----------
  function tubeOk(tb, c) {
    if (tb.state !== 'floor') return false;
    if (inRect(oside.scoringZone, tb.x, tb.z) || inRect(oside.loadingZone, tb.x, tb.z)) return false;
    if (inRect(side.floorArea, tb.x, tb.z, TUBE.outerRadius)) return false; // already scored
    if (c.auto && (inRect(side.loadingZone, tb.x, tb.z) || (alliance === 'blue' ? tb.x < -0.4 : tb.x > 0.4))) return false;
    if (c.endgame && inRect(oside.platformZone, tb.x, tb.z)) return false;
    return true;
  }

  function pickTube(c) {
    const { me, t } = c, rowX = side.stagingRow[0].x;
    let best = null, bc = 1e9;
    for (const tb of c.S.tubes) {
      if (!tubeOk(tb, c) || claimed('t' + tb.id, me.id, t) || (st.black.get(tb.id) || 0) > t) continue;
      let cost = hyp(tb.x - me.x, tb.z - me.z);
      if (t < 60 && Math.abs(tb.x - rowX) < 0.8) cost -= 2;
      if (!c.auto && inRect(side.loadingZone, tb.x, tb.z)) cost -= 1.5;
      if (tb.id === st.tubeId) cost -= 1;
      if (cost < bc) { bc = cost; best = tb; }
    }
    return best;
  }

  function collect(c, out) {
    const { me, t } = c;
    let tb = st.tubeId != null ? c.S.tubes.find((x) => x.id === st.tubeId) : null;
    if (!tb || !tubeOk(tb, c) || t >= st.reT) {
      const n = pickTube(c);
      st.reT = t + P.react;
      if (n && n.id !== st.tubeId) { st.tubeId = n.id; st.tubeT = t; }
      tb = n; st.noTube = !n;
      if (!n) st.tubeId = null;
    }
    out.intake = true;
    if (!tb) {
      if (!c.auto) { const z = side.loadingZone; drive(out, c, steer(c, (z.x0 + z.x1) / 2, (z.z0 + z.z1) / 2, { speed: 0.7 }), 0); }
      return out;
    }
    claim('t' + tb.id, me.id, t);
    if (t - st.tubeT > 8) { st.black.set(tb.id, t + 10); st.tubeId = null; st.reT = 0; }
    const d = hyp(tb.x - me.x, tb.z - me.z);
    drive(out, c, steer(c, tb.x, tb.z, { slow: 0.8, min: 0.55 }), d < 0.35 ? 0 : turnTo(me, Math.atan2(tb.z - me.z, tb.x - me.x)));
    return out;
  }

  // ---------- scoring ----------
  function choosePost(c) {
    const { me, t, preset } = c;
    let best = null, bc = 1e9;
    for (const p of c.S.posts) {
      if (p.alliance !== alliance) continue;
      const n = p.tubes.length;
      if (n >= 3 || (st.postBan.get(p.id) || 0) > t || claimed(`${alliance}-z${p.index}`, me.id, t)) continue;
      if (p.tier === 'upper' ? !(preset.canUpper || preset.canLaunch) : !preset.canLower) continue;
      let cost = Math.abs(me.z - p.z) * 0.4 + (p.tier === 'upper' ? -1.5 : 0) + (P.fill ? (3 - n) * 1.2 : n * 1.2);
      if (st.post && st.post.p && st.post.p.id === p.id) cost -= 1.5;
      if (cost < bc) { bc = cost; best = p; }
    }
    if (!best) return { method: 'floor' };
    const method = best.tier === 'lower' ? 'lower' : preset.canUpper ? 'upper' : 'launch';
    return { p: best, method };
  }

  function score(c, out) {
    const { me, t, preset } = c, held = me.held.length;
    if (st.waiting) {
      if (t - st.pressAt < 0.3 || me.action) return out;
      st.waiting = false;
      if (held < st.heldAtPress) { st.creep = 0; st.fails = 0; st.reT = 0; }
      else {
        st.fails++; st.creep = Math.min(0.3, st.creep + 0.1);
        if (st.fails >= 3 && st.post && st.post.p) { st.postBan.set(st.post.p.id, t + 8); st.fails = 0; st.creep = 0; st.reT = 0; }
      }
    }
    if (!st.post || t >= st.reT || (st.post.p && st.post.p.tubes.length >= 3)) {
      const prev = st.post && st.post.p && st.post.p.id, n = choosePost(c);
      st.post = n; st.reT = t + 0.6;
      if ((n.p && n.p.id) !== prev) { st.staged = false; st.alignT = 0; st.creep = 0; }
    }
    const tg = st.post;
    let spot, face, press, key;
    if (tg.method === 'floor') {
      const z = side.floorArea, mid = (z.z0 + z.z1) / 2, sz = clamp(me.z, z.z0 + 0.6, z.z1 - 0.6);
      spot = { x: wallDir * 7.4, z: sz }; face = mid > sz ? Math.PI / 2 : -Math.PI / 2; press = 'scoreFloor';
    } else {
      const p = tg.p;
      claim(`${alliance}-z${p.index}`, me.id, t);
      if (tg.method === 'launch') {
        const sx = (wallDir > 0 ? side.scoringZone.x0 : side.scoringZone.x1) + wallDir * (R + 0.3);
        spot = { x: sx, z: p.z }; face = Math.atan2(0, p.tipX - sx); press = 'launch';
      } else {
        spot = { x: p.tipX - wallDir * clamp(0.65 - st.creep, 0.35, 0.75), z: p.z };
        face = wallDir > 0 ? 0 : Math.PI; press = tg.method === 'upper' ? 'scoreUpper' : 'scoreLower';
      }
    }
    const dSpot = hyp(spot.x - me.x, spot.z - me.z);
    const stage = { x: spot.x - wallDir * 1.1, z: spot.z };
    if (!st.staged && (dSpot > 1.4 || Math.abs(me.z - spot.z) > 0.35)) {
      if (hyp(stage.x - me.x, stage.z - me.z) < 0.5) st.staged = true;
      else { drive(out, c, steer(c, stage.x, stage.z, { slow: 1.5 }), turnTo(me, face)); return out; }
    }
    if (dSpot > 2.2) st.staged = false;
    const ready = hold(c, out, spot.x, spot.z, face);
    st.alignT = ready ? st.alignT + c.dt : 0;
    if (ready && st.alignT >= P.react * 0.6 && !me.action && held > 0) {
      if (press === 'launch' && !inRect(side.scoringZone, me.x, me.z, R)) return out;
      out[press] = true;
      st.waiting = true; st.pressAt = t; st.heldAtPress = held; st.alignT = 0;
    }
    return out;
  }

  // ---------- endgame ----------
  function climb(c, out) {
    const { me, S } = c;
    const mates = S.robots.filter((r) => r.alliance === alliance).sort((a, b) => b.preset.maxClimb - a.preset.maxClimb || a.slot - b.slot);
    const lvl = {};
    let cap = 4;
    for (const r of mates) { lvl[r.id] = Math.max(1, Math.min(r.preset.maxClimb, cap)); cap = Math.max(1, lvl[r.id] - 1); }
    const tgt = lvl[me.id], sup = me.support;
    const L2 = side.platforms[0], faceZ = alliance === 'blue' ? -1 : 1, zf = alliance === 'blue' ? L2.z1 : L2.z0;
    const faceHead = faceZ > 0 ? Math.PI / 2 : -Math.PI / 2, ladHead = wallDir > 0 ? 0 : Math.PI;
    const l1z = faceZ * 2.0;
    if (sup >= tgt && sup >= 1) { return out; }
    if (tgt === 1) {
      const i = mates.filter((r) => lvl[r.id] === 1).indexOf(me);
      const px = wallDir * [1.2, 0.1, -1][Math.max(0, i)];
      if (hyp(px - me.x, l1z - me.z) > 0.3) drive(out, c, steer(c, px, l1z, { noBoxes: true }), turnTo(me, faceHead));
      else hold(c, out, px, l1z, faceHead);
      return out;
    }
    if (sup <= 1) {
      const A = { x: (L2.x0 + L2.x1) / 2, z: zf - faceZ * (R + 0.1) };
      const higher = mates.filter((r) => lvl[r.id] > tgt);
      if (c.remaining > 8 && !higher.every((r) => r.support >= 3)) {
        const wz = faceZ * 1.9, wx = wallDir * 0.5;
        if (hyp(wx - me.x, wz - me.z) > 0.3) drive(out, c, steer(c, wx, wz, { noBoxes: true }), turnTo(me, faceHead));
        return out;
      }
      const ex = A.x - me.x, near = hyp(ex, A.z - me.z) < 0.25 && Math.abs(wrap(faceHead - me.heading)) < 0.25;
      if (near || (sup === 1 && Math.abs(ex) < 0.45 && Math.abs(A.z - me.z) < 0.4)) {
        out.climb = true;
        drive(out, c, { x: clamp(ex * 2, -0.2, 0.2), z: faceZ * 0.5 }, turnTo(me, faceHead));
      } else drive(out, c, steer(c, A.x, A.z, { noBoxes: true, slow: 1.5 }), turnTo(me, faceHead));
      return out;
    }
    const nb = side.platforms[sup - 1];
    if (!nb) return out;
    const rot = turnTo(me, ladHead);
    if (S.robots.some((r) => r !== me && r.alliance === alliance && r.support === sup + 1)) { drive(out, c, { x: 0, z: 0 }, rot); return out; }
    const aligned = Math.abs(wrap(ladHead - me.heading)) < 0.3;
    out.climb = aligned;
    drive(out, c, { x: aligned ? wallDir * 0.5 : 0, z: clamp(((nb.z0 + nb.z1) / 2 - me.z) * 2, -0.3, 0.3) }, rot);
    return out;
  }

  function think(sim, match, dt) {
    const S = sim.state, t = S.time, me = S.robots.find((r) => r.id === robotId), out = {};
    const ph = match.phase;
    if (!me || !(ph === 'auto' || ph === 'teleop' || ph === 'endgame')) return out;
    const c = { me, S, t, dt, auto: ph === 'auto', endgame: ph === 'endgame', preset: me.preset, remaining: match.remaining,
      zones: [oside.scoringZone, oside.loadingZone] };
    if (c.auto) c.zones.push(side.loadingZone);
    if (c.endgame) c.zones.push(oside.platformZone);
    const held = me.held.length;
    const climbing = c.endgame && match.remaining <= P.end;

    // stuck detection: commanded motion but not moving -> back up and sidestep
    if (st.lastCmd > 0.35 && hyp(me.vx, me.vz) < 0.18 && !me.action && !climbing) st.stuckT += dt;
    else { st.stuckT = Math.max(0, st.stuckT - dt); if (hyp(me.vx, me.vz) > 0.5) st.stuckN = 0; }
    if (st.stuckT > 0.9) {
      const b = { x: -st.lastDir.x, z: -st.lastDir.z }, s = { x: -b.z * st.flip, z: b.x * st.flip };
      const m = hyp(b.x * 0.7 + s.x * 0.8, b.z * 0.7 + s.z * 0.8) || 1;
      st.unstick = { until: t + 0.7, v: { x: (b.x * 0.7 + s.x * 0.8) / m * P.speed, z: (b.z * 0.7 + s.z * 0.8) / m * P.speed } };
      st.flip = -st.flip; st.stuckT = 0;
      if (++st.stuckN >= 2 && st.tubeId != null) { st.black.set(st.tubeId, t + 8); st.tubeId = null; st.reT = 0; }
    }
    if (st.unstick && t < st.unstick.until) { drive(out, c, st.unstick.v, 0); return out; }

    const busy = me.action && (me.action.type === 'place' || me.action.type === 'launch');
    if (climbing && !busy) { st.lastCmd = 0; return climb(c, out); }
    if (busy) { st.lastCmd = 0; return out; }

    if (!st.waiting) {
      if (st.mode === 'collect') {
        if (held >= (c.auto ? 1 : 2) || (held > 0 && (st.noTube || match.remaining < 15))) { st.mode = 'score'; st.post = null; st.reT = 0; st.staged = false; }
      } else if (held === 0) { st.mode = 'collect'; st.tubeId = null; st.reT = 0; }
    }
    st.lastCmd = 0;
    return st.mode === 'score' ? score(c, out) : collect(c, out);
  }

  return { think, state: st };
}
