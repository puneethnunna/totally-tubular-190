// Bot driver: createBot(robotId, alliance, difficulty) -> { think(sim, match, dt) -> Input }.
// Always outputs field-frame moveX/moveZ + rotate (tank robots: sim converts; pure turns use `turn`).
import { FIELD, ROBOT, SIDES, TUBE, ALLIANCES, opponent, inRect } from './config.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => { a %= TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; };
const hyp = Math.hypot;
const rectDist = (r, x, z) => { const px = clamp(x, r.x0, r.x1), pz = clamp(z, r.z0, r.z1); return { d: hyp(x - px, z - pz), px, pz }; };
const WALLS = ALLIANCES.map((a) => SIDES[a].shortWall);
const BOXES = ALLIANCES.map((a) => { const p = SIDES[a].platforms; return { x0: Math.min(...p.map((q) => q.x0)), x1: Math.max(...p.map((q) => q.x1)), z0: Math.min(...p.map((q) => q.z0)), z1: Math.max(...p.map((q) => q.z1)) }; });
const RAILS = ALLIANCES.map((a) => { // solid peg rows (same rect as sim.js)
  const ps = SIDES[a].posts, zs = ps.map((p) => p.z);
  return { x0: Math.min(ps[0].tipX, ps[0].baseX), x1: Math.max(ps[0].tipX, ps[0].baseX), z0: Math.min(...zs) - 0.05, z1: Math.max(...zs) + 0.05 };
});

// ---------- waypoint graph: corners of inflated static obstacles, visibility edges cached per obstacle set ----------
const EDGE_M = 0.55, ZONE_M = 0.85; // clearance for edge tests (bumper half-size 0.5 + margin); protected zones get extra so shoves don't cause fouls
const infl = (r, m) => ({ x0: r.x0 - m, x1: r.x1 + m, z0: r.z0 - m, z1: r.z1 + m });
function segHits(ax, az, bx, bz, r) { // open segment vs open rect
  let t0 = 0, t1 = 1;
  for (const [p, q, lo, hi] of [[bx - ax, ax, r.x0, r.x1], [bz - az, az, r.z0, r.z1]]) {
    if (Math.abs(p) < 1e-9) { if (q <= lo || q >= hi) return false; continue; }
    let u = (lo - q) / p, v = (hi - q) / p;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 >= t1 - 1e-9) return false;
  }
  return true;
}
const clear = (G, ax, az, bx, bz, ma, mb) => G.raws.every((r, i) => !segHits(ax, az, bx, bz, infl(r, Math.min(ma[i], mb[i]))));
const margins = (G, x, z) => G.raws.map((r) => clamp(rectDist(r, x, z).d - 0.01, 0, r.m));
const graphs = new Map();
function graphFor(alliance, flags, raws) {
  const key = alliance + flags;
  let G = graphs.get(key);
  if (G) return G;
  G = { raws, nodes: [], adj: [] };
  const lim = (v, h) => Math.abs(v) <= h - 0.5;
  for (const r of raws) for (const [x, z] of [[r.x0 - r.m - 0.07, r.z0 - r.m - 0.07], [r.x1 + r.m + 0.07, r.z0 - r.m - 0.07], [r.x0 - r.m - 0.07, r.z1 + r.m + 0.07], [r.x1 + r.m + 0.07, r.z1 + r.m + 0.07]])
    if (lim(x, FIELD.halfL) && lim(z, FIELD.halfW) && !raws.some((q) => x > q.x0 - q.m && x < q.x1 + q.m && z > q.z0 - q.m && z < q.z1 + q.m)) G.nodes.push({ x, z });
  const F = raws.map((r) => r.m);
  G.adj = G.nodes.map(() => []);
  G.nodes.forEach((a, i) => G.nodes.forEach((b, j) => { if (i < j && clear(G, a.x, a.z, b.x, b.z, F, F)) { const d = hyp(a.x - b.x, a.z - b.z); G.adj[i].push([j, d]); G.adj[j].push([i, d]); } }));
  graphs.set(key, G);
  return G;
}
// First waypoint on the shortest obstacle-free route (goal itself when visible). prev = node index chosen last time (hysteresis).
function plan(G, sx, sz, gx, gz, prev) {
  const ms = margins(G, sx, sz), mg = margins(G, gx, gz);
  if (clear(G, sx, sz, gx, gz, ms, mg)) return { x: gx, z: gz, i: -1 };
  const n = G.nodes.length, dist = new Array(n).fill(Infinity), first = new Array(n).fill(-1), done = new Array(n).fill(false);
  G.nodes.forEach((p, i) => { if (clear(G, sx, sz, p.x, p.z, ms, ms)) { dist[i] = hyp(p.x - sx, p.z - sz) - (i === prev ? 0.4 : 0); first[i] = i; } });
  let best = Infinity, bi = -1;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] >= best) break;
    done[u] = true;
    const p = G.nodes[u];
    if (clear(G, p.x, p.z, gx, gz, mg, mg)) { const tot = dist[u] + hyp(p.x - gx, p.z - gz); if (tot < best) { best = tot; bi = u; } }
    for (const [v, d] of G.adj[u]) if (dist[u] + d < dist[v]) { dist[v] = dist[u] + d; first[v] = first[u]; }
  }
  if (bi < 0) return { x: gx, z: gz, i: -1 };
  const f = G.nodes[first[bi]];
  return { x: f.x, z: f.z, i: first[bi] };
}

const DIFF = {
  easy:   { speed: 0.6,  react: 0.5,  aim: 0.18, end: 18, fill: false },
  normal: { speed: 0.85, react: 0.25, aim: 0.09, end: 22, fill: true },
  hard:   { speed: 1,    react: 0.1,  aim: 0.045, end: 26, fill: true },
};

// Cross-bot claims so teammates don't chase the same tube / post slot (expire after 1.2 s; stale across matches ignored).
const claims = new Map();
const claimed = (k, id, t) => { const c = claims.get(k); return !!c && c.id !== id && t - c.t >= 0 && t - c.t < 1.2; };
const claim = (k, id, t) => claims.set(k, { id, t });

// Published each tick by every bot: priority + the post spot it is using, so others yield and keep clear.
const intents = new Map();
const intent = (id, t) => { const i = intents.get(id); return i && t - i.t >= 0 && t - i.t < 0.5 ? i : null; };

export function createBot(robotId, alliance, difficulty = 'normal') {
  const P = DIFF[difficulty] || DIFF.normal;
  const side = SIDES[alliance], oside = SIDES[opponent(alliance)];
  const wallDir = alliance === 'blue' ? 1 : -1; // x direction toward own post wall
  const st = {
    mode: 'collect', tubeId: null, tubeT: 0, reT: 0, noTube: false, black: new Map(), stuckT: 0, stuckN: 0, rotT: 0, flip: 1, unstick: null,
    lastCmd: 0, lastDir: { x: 1, z: 0 }, post: null, postBan: new Map(), staged: false, alignT: 0, creep: 0, fails: 0,
    waiting: false, pressAt: -9, heldAtPress: 0,
    side: new Map(), navI: -1, waitT: 0, spot: null, stuckAt: -99, detour: null, goalD: 0, idK: [...robotId].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7) / 997,
  };

  const ext = (r) => (r.bumper ? (r.bumper.lx + r.bumper.lz) / 4 : r.radius ?? ROBOT.radius);
  const statics = (c, o) => [...[...WALLS, ...RAILS, ...(o.noBoxes ? [] : BOXES)].map((r) => ({ ...r, m: EDGE_M })), ...c.zones.map((r) => ({ ...r, m: ZONE_M }))];

  function zoneGuard(c, v) { // never drive into protected zones; brake early enough that momentum can't carry us in
    const { me } = c;
    for (const zr of c.zones) {
      const q = rectDist(zr, me.x, me.z);
      if (q.d < 1e-3) continue;
      const nx = (me.x - q.px) / q.d, nz = (me.z - q.pz) / q.d, dot = v.x * nx + v.z * nz, vc = -(me.vx * nx + me.vz * nz);
      if (q.d < c.R + 0.12 && dot < 0) { v.x -= dot * nx; v.z -= dot * nz; }
      else if (vc > 0.4 && vc > Math.sqrt(2 * 4 * Math.max(0, q.d - 0.6))) { v.x += nx * 1.2; v.z += nz * 1.2; if (dot < 0) { v.x -= dot * nx; v.z -= dot * nz; } }
    }
    return v;
  }

  // Route around static obstacles via the waypoint graph, then adjust for other robots: lower-priority bots slow and sidestep.
  function steer(c, gx, gz, o = {}) {
    const { me, t } = c;
    const wallRects = statics(c, o), G = graphFor(alliance, `${c.auto}${c.endgame}${!!o.noBoxes}`, wallRects);
    const wp = plan(G, me.x, me.z, gx, gz, st.navI);
    st.navI = wp.i; st.dbg = { wp, gx, gz };
    const d = hyp(gx - me.x, gz - me.z), wd = hyp(wp.x - me.x, wp.z - me.z) || 1e-6;
    const sp = (o.speed ?? 1) * P.speed * clamp(d / (o.slow ?? 1.2), o.min ?? 0.2, 1);
    const ux = (wp.x - me.x) / wd, uz = (wp.z - me.z) / wd;
    let vx = ux, vz = uz, yielded = false;
    const vm = { x: ux * sp * me.preset.maxSpeed, z: uz * sp * me.preset.maxSpeed };
    for (const r of c.S.robots) {
      if (r.id === me.id) continue;
      const px = r.x - me.x, pz = r.z - me.z, pd = hyp(px, pz) || 1e-6, Rs = ext(me) + ext(r) + 0.2;
      const wx = vm.x - r.vx, wz = vm.z - r.vz, a = wx * wx + wz * wz, bq = -(px * wx + pz * wz), cq = pd * pd - Rs * Rs;
      let ttc = Infinity;
      if (cq <= 0) ttc = bq > 0 ? 0 : Infinity;
      else if (a > 1e-6 && bq > 0) { const disc = bq * bq - a * cq; if (disc >= 0) ttc = (bq - Math.sqrt(disc)) / a; }
      const oi = intent(r.id, t), lower = !oi || c.pri < oi.pri;
      if (pd < Rs + 0.3) { const w = clamp((Rs + 0.3 - pd) / 0.5, 0, 1) * (lower ? 1 : 0.3); vx -= (px / pd) * w; vz -= (pz / pd) * w; }
      if (ttc >= 1 || !lower || o.noYield) continue;
      yielded = true;
      let sx = -pz / pd, sz = px / pd;
      const key = r.id, keep = st.side.get(key);
      const dot = sx * ux + sz * uz;
      if (!keep || t > keep.until) st.side.set(key, { s: Math.abs(dot) > 0.15 ? Math.sign(dot) : (st.flip || 1), until: t + 1 });
      const sg = st.side.get(key).s; sx *= sg; sz *= sg;
      const k = clamp(ttc, 0.1, 1);
      vx = vx * (0.25 + 0.75 * k) + sx * (1.2 - k);
      vz = vz * (0.25 + 0.75 * k) + sz * (1.2 - k);
    }
    c.yielded = c.yielded || yielded;
    for (const rc of c.keepOut) { // space in front of a post being used by a higher-priority robot
      if (hyp(gx - clamp(gx, rc.x0, rc.x1), gz - clamp(gz, rc.z0, rc.z1)) < 0.3) continue;
      const q = rectDist(rc, me.x, me.z);
      if (q.d < c.R + 0.3) { const dd = q.d || 1e-3, w = clamp((c.R + 0.3 - q.d) / 0.4, 0, 1.2); vx += ((me.x - q.px) / dd) * w * (q.d ? 1 : 0); vz += ((me.z - q.pz) / dd) * w; }
    }
    const wm = c.R + 0.05, hl = FIELD.halfL, hw = FIELD.halfW; // safety nudge off boundaries only when nearly touching
    for (const [dd, ax, az] of [[hl - me.x, -1, 0], [hl + me.x, 1, 0], [hw - me.z, 0, -1], [hw + me.z, 0, 1]]) if (dd < wm && (ax ? hl - Math.abs(gx) : hw - Math.abs(gz)) > 0.65) { vx += ax * 0.6; vz += az * 0.6; }
    for (const rc of wallRects) {
      const q = rectDist(rc, me.x, me.z), zm = c.R + 0.04;
      if (q.d < zm && q.d > 1e-3 && rectDist(rc, gx, gz).d > 0.65) { vx += ((me.x - q.px) / q.d) * 0.6; vz += ((me.z - q.pz) / q.d) * 0.6; }
    }
    const m = hyp(vx, vz) || 1, f = yielded ? Math.min(1, m) : 1;
    return zoneGuard(c, { x: (vx / m) * sp * f, z: (vz / m) * sp * f });
  }

  // yaw-rate P loop (~8/s) with a little damping, tuned for the ~80 ms module lag
const turnTo = (me, ang) => clamp((wrap(ang - me.heading) * 12 - me.omega * 0.4) / (me.preset.turnRate || 4), -1, 1);

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
    if (c.preset.drive === 'tank') { // can't strafe: drive along the heading, bias the heading to absorb lateral error
      const cs = Math.cos(me.heading), sn = Math.sin(me.heading), f = dx * cs + dz * sn, l = -dx * sn + dz * cs;
      const th = there ? 0 : clamp(f * 1.8, -0.5, 0.5), tu = turnTo(me, ang + (d > 0.3 ? clamp(l * 1.5, -0.4, 0.4) : 0));
      out.throttle = th; out.turn = tu; st.lastCmd = Math.abs(th);
      if (Math.abs(th) > 0.04) st.lastDir = { x: cs * Math.sign(th), z: sn * Math.sign(th) };
      return there && hyp(me.vx, me.vz) < 0.3 && Math.abs(wrap(ang - me.heading)) < P.aim;
    }
    const v = there || d < 0.07 ? { x: 0, z: 0 } : { x: (dx / d) * clamp(d * 1.8, 0.14, 0.5), z: (dz / d) * clamp(d * 1.8, 0.14, 0.5) };
    drive(out, c, v, rot);
    return there && hyp(me.vx, me.vz) < 0.3 && Math.abs(wrap(ang - me.heading)) < P.aim;
  }

  // ---------- collecting ----------
  function tubeOk(tb, c) {
    if (tb.state !== 'floor') return false;
    if (c.zones.some((z) => rectDist(z, tb.x, tb.z).d < (z === oside.loadingZone ? 1.6 : ZONE_M + 0.05))) return false; // their loading zone is crowded: stay well clear // would mean touching a protected zone
    if (inRect(side.floorArea, tb.x, tb.z, TUBE.outerRadius)) return false; // already scored
    if (c.auto && (inRect(side.loadingZone, tb.x, tb.z) || (alliance === 'blue' ? tb.x < -0.4 : tb.x > 0.4))) return false;
    if (c.endgame && inRect(oside.platformZone, tb.x, tb.z)) return false;
    return true;
  }

  function pickTube(c) {
    const { me, t } = c, rowX = side.stagingRow[0].x;
    let best = null, bc = 1e9;
    const ids = c.S.robots.filter((r) => r.alliance === alliance).map((r) => r.id).sort(), lane = FIELD.halfW * (2 * (ids.indexOf(me.id) + 0.5) / ids.length - 1); // teammates favor different z lanes
    for (const tb of c.S.tubes) {
      if (!tubeOk(tb, c) || claimed('t' + tb.id, me.id, t) || (st.black.get(tb.id) || 0) > t) continue;
      let cost = hyp(tb.x - me.x, tb.z - me.z) + Math.abs(tb.z - lane) * 0.25;
      if (t < 60 && Math.abs(tb.x - rowX) < 0.8) cost -= 2;
      if (!c.auto && inRect(side.loadingZone, tb.x, tb.z)) cost -= 1.5;
      if (tb.id === st.tubeId) cost -= 1;
      for (const z of c.zones) cost += Math.max(0, 1.8 - rectDist(z, tb.x, tb.z).d); // tubes hugging a protected zone are risky
      for (const r of c.S.robots) { const oi = r.id !== me.id && r.alliance === alliance && intent(r.id, t); if (oi && oi.tube && hyp(oi.tube.x - tb.x, oi.tube.z - tb.z) < 1.6) cost += 5; } // teammates spread over different tubes
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
    st.tubePos = { x: tb.x, z: tb.z };
    if (t - st.tubeT > 8) { st.black.set(tb.id, t + 10); st.tubeId = null; st.reT = 0; }
    const d = hyp(tb.x - me.x, tb.z - me.z);
    st.goalD = d;
    drive(out, c, steer(c, tb.x, tb.z, { slow: 0.8, min: 0.55 }), d < 0.35 ? 0 : turnTo(me, Math.atan2(tb.z - me.z, tb.x - me.x)));
    return out;
  }

  // ---------- scoring ----------
  function choosePost(c) {
    const { me, t, preset } = c;
    let best = null, bc = 1e9;
    const mates = c.S.robots.filter((r) => r.alliance === alliance).map((r) => r.id).sort(), zs = c.S.posts.filter((p) => p.alliance === alliance).map((p) => p.z);
    const band = Math.min(...zs) + (Math.max(...zs) - Math.min(...zs)) * (mates.indexOf(me.id) + 0.5) / mates.length; // each teammate prefers its own stretch of the wall
    for (const p of c.S.posts) {
      if (p.alliance !== alliance) continue;
      const n = p.tubes.length;
      if (n >= 3 || (st.postBan.get(p.id) || 0) > t || [-1, 0, 1].some((k) => claimed(`${alliance}-z${p.index + k}`, me.id, t))) continue; // columns within a bumper width are taken
      if (p.tier === 'upper' ? !(preset.canUpper || preset.canLaunch) : !preset.canLower) continue;
      let cost = Math.abs(me.z - p.z) * 0.4 + Math.abs(p.z - band) * 0.5 + (p.tier === 'upper' ? -1.5 : 0) + (P.fill ? (3 - n) * 1.2 : n * 1.2);
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
      spot = { x: wallDir * 7.05, z: sz }; face = mid > sz ? Math.PI / 2 : -Math.PI / 2; press = 'scoreFloor';
    } else {
      const p = tg.p;
      claim(`${alliance}-z${p.index}`, me.id, t);
      if (tg.method === 'launch') {
        const sx = (wallDir > 0 ? side.scoringZone.x0 : side.scoringZone.x1) + wallDir * (c.R + 0.3);
        spot = { x: sx, z: p.z }; face = Math.atan2(0, p.tipX - sx); press = 'launch';
      } else {
        spot = { x: p.tipX - wallDir * clamp(c.R + 0.15 - st.creep, c.R + 0.03, c.R + 0.25), z: p.z };
        face = wallDir > 0 ? 0 : Math.PI; press = tg.method === 'upper' ? 'scoreUpper' : 'scoreLower';
      }
    }
    const dSpot = hyp(spot.x - me.x, spot.z - me.z);
    st.goalD = dSpot;
    if (tg.p && dSpot > 0.9 && c.S.robots.some((r) => r.id !== me.id && hyp(r.x - spot.x, r.z - spot.z) < 0.8)) { st.postBan.set(tg.p.id, t + 3); st.reT = 0; st.staged = false; } // somebody is parked on it: pick another column
    if (tg.p && dSpot < 2.5) st.spot = { x: spot.x, z: spot.z, dir: wallDir };
    const stage = { x: spot.x - wallDir * 1.1, z: spot.z };
    if (!st.staged && (dSpot > 1.4 || Math.abs(me.z - spot.z) > 0.35)) {
      if (hyp(stage.x - me.x, stage.z - me.z) < 0.5) st.staged = true;
      else { drive(out, c, steer(c, stage.x, stage.z, { slow: 1.5 }), turnTo(me, face)); return out; }
    }
    if (dSpot > 2.2) st.staged = false;
    const ready = hold(c, out, spot.x, spot.z, face);
    st.alignT = ready ? st.alignT + c.dt : 0;
    if (ready && st.alignT >= P.react * 0.6 && !me.action && held > 0) {
      if (press === 'launch' && !inRect(side.scoringZone, me.x, me.z, c.R)) return out;
      out[press] = true;
      st.waiting = true; st.pressAt = t; st.heldAtPress = held; st.alignT = 0;
    }
    return out;
  }

  // ---------- endgame ----------
  function levels(S) { // planned platform level per teammate: fastest climber takes the highest, the others the next boxes down
    const mates = S.robots.filter((r) => r.alliance === alliance).sort((a, b) => (a.preset.climbTime ?? 1) - (b.preset.climbTime ?? 1) || a.slot - b.slot), lvl = {};
    let cap = 4;
    for (const r of mates) { lvl[r.id] = Math.max(1, Math.min(4, cap)); cap = Math.max(1, lvl[r.id] - 1); }
    return { mates, lvl };
  }

  function climb(c, out) {
    const { me, S } = c, { mates, lvl } = levels(S);
    const tgt = lvl[me.id], sup = me.support;
    const L2 = side.platforms[0], faceZ = alliance === 'blue' ? -1 : 1, zf = alliance === 'blue' ? L2.z1 : L2.z0;
    const faceHead = faceZ > 0 ? Math.PI / 2 : -Math.PI / 2, ladHead = wallDir > 0 ? 0 : Math.PI;
    const l1z = faceZ * 2.0;
    if (sup >= tgt && sup >= 1) { return out; }
    // wait clear of the ladder lane, then park; steer() keeps yielding to whoever still has to climb past
    const park = (x, z, o = {}) => {
      const v = steer(c, x, z, { noBoxes: true, ...o });
      if (hyp(x - me.x, z - me.z) < 0.3 && !c.yielded) hold(c, out, x, z, faceHead); else drive(out, c, v, turnTo(me, faceHead));
      return out;
    };
    const pending = mates.some((r) => lvl[r.id] > 1 && r.support < lvl[r.id]);
    if (tgt === 1) {
      const i = mates.filter((r) => lvl[r.id] === 1).indexOf(me);
      if (pending && c.remaining > 8) return park(wallDir * 3.2, faceZ * 0.8);
      return park(wallDir * [1.3, 0.3, 0.3][Math.max(0, i)], l1z);
    }
    if (sup <= 1) {
      const PT = side.platforms[Math.max(0, tgt - 2)] || L2; // direct climb: line up with the target level's platform from the carpet
      const A = { x: (PT.x0 + PT.x1) / 2, z: zf - faceZ * (c.R + 0.1) };
      const higher = mates.filter((r) => lvl[r.id] > tgt);
      if (c.remaining > 8 && !higher.every((r) => r.support >= 3)) {
        return park(wallDir * 2.2, faceZ * 0.8);
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

  // Direction away from touching robots, nearby obstacles and the field edge.
  function escapeDir(c) {
    const { me } = c;
    let ex = 0, ez = 0;
    for (const id of me.contacts || []) { const r = c.S.robots.find((q) => q.id === id); if (r) { const d = hyp(me.x - r.x, me.z - r.z) || 1; ex += (me.x - r.x) / d; ez += (me.z - r.z) / d; } }
    for (const rc of [...WALLS, ...RAILS, ...BOXES, ...c.zones]) { const q = rectDist(rc, me.x, me.z); if (q.d < 0.9 && q.d > 1e-3) { const w = (0.9 - q.d) / 0.4; ex += ((me.x - q.px) / q.d) * w; ez += ((me.z - q.pz) / q.d) * w; } }
    for (const [dd, ax, az] of [[FIELD.halfL - me.x, -1, 0], [FIELD.halfL + me.x, 1, 0], [FIELD.halfW - me.z, 0, -1], [FIELD.halfW + me.z, 0, 1]]) if (dd < 0.9) { ex += ax * (0.9 - dd) / 0.4; ez += az * (0.9 - dd) / 0.4; }
    const m = hyp(ex, ez);
    return m < 0.3 ? { x: -st.lastDir.x, z: -st.lastDir.z } : { x: ex / m, z: ez / m };
  }

  function recover(c, out) { // execute a scripted back-out; tanks reverse instead of turning around
    const { me } = c, u = st.unstick, v = zoneGuard(c, { ...u.v });
    if (c.preset.drive === 'tank') {
      const err = wrap(Math.atan2(v.z, v.x) - me.heading);
      if (u.clearFirst) { out.throttle = Math.cos(err) < 0 ? -0.8 : 0.8; out.turn = 0; } // jammed yaw: gain room along the axis first, no turning
      else if (Math.abs(err) > 2.1) { out.throttle = -0.9; out.turn = u.rot || 0; } else { out.turn = u.rot || clamp(err * 2, -1, 1); out.throttle = Math.max(0, Math.cos(err)) * 0.9; }
      return out;
    }
    out.moveX = v.x; out.moveZ = v.z; out.rotate = u.rot || 0;
    return out;
  }

  function think(sim, match, dt) {
    const S = sim.state, t = S.time, raw = S.robots.find((r) => r.id === robotId), out = {};
    const me = raw && { radius: ROBOT.radius, omega: 0, ...raw }; // tolerate minimal robot states
    const ph = match.phase;
    if (!me || !(ph === 'auto' || ph === 'teleop' || ph === 'endgame')) return out;
    const c = { me, S, t, dt, R: me.bumper ? Math.max(me.bumper.lx, me.bumper.lz) / 2 : me.radius, auto: ph === 'auto', endgame: ph === 'endgame', preset: me.preset, remaining: match.remaining,
      zones: [oside.scoringZone, oside.loadingZone], keepOut: [], yielded: false, pri: 0 };
    if (c.auto) c.zones.push(side.loadingZone, wallDir > 0 ? { x0: -FIELD.halfL, x1: -1.2, z0: -FIELD.halfW, z1: FIELD.halfW } : { x0: 1.2, x1: FIELD.halfL, z0: -FIELD.halfW, z1: FIELD.halfW }); // G110: stay on our half in AUTO
    if (c.endgame) c.zones.push(oside.platformZone);
    const held = me.held.length;
    const climbing = c.endgame && match.remaining <= P.end;
    const busy = me.action && (me.action.type === 'place' || me.action.type === 'launch');

    // priority: placing > carrying a tube toward its post > collecting; the longer a bot has been yielding, the higher it ranks
    c.pri = (climbing ? levels(S).lvl[me.id] * 100 - (me.support >= levels(S).lvl[me.id] ? 150 : 0) : 0) + (busy || st.waiting ? 1000 : 0) + (st.mode === 'score' && st.goalD < 1 ? 300 : 0) + held * 30 + (st.mode === 'score' ? 20 : 0) + (climbing ? 15 : 0) - Math.min(st.goalD, 12) * 0.5 + st.waitT * 10 + st.idK;
    for (const r of S.robots) {
      const oi = r.id !== me.id && intent(r.id, t);
      if (oi && oi.spot && oi.pri > c.pri) { const sp = oi.spot, x = [sp.x - sp.dir * 1.4, sp.x + sp.dir * 1.0].sort((a, b) => a - b); c.keepOut.push({ x0: x[0], x1: x[1], z0: sp.z - 0.62, z1: sp.z + 0.62 }); }
    }
    st.spot = null; st.tubePos = null;

    // stuck detection: commanded motion but not moving -> back out away from contacts/obstacles, drop the jammed target, escalate
    if (st.lastCmd > 0.3 && hyp(me.vx, me.vz) < 0.18 && !me.action && (!climbing || !me.support)) st.stuckT += dt;
    else st.stuckT = Math.max(0, st.stuckT - dt);
    if (t - st.stuckAt > 4) st.stuckN = 0;
    if (st.stuckT > 0.8) {
      const e = escapeDir(c), n = ++st.stuckN;
      st.unstick = { until: t + 0.5 + 0.25 * Math.min(n, 4), v: { x: e.x * Math.max(P.speed, 0.7), z: e.z * Math.max(P.speed, 0.7) }, rot: n >= 2 ? st.flip * 0.8 : 0 };
      st.flip = -st.flip; st.stuckT = 0; st.stuckAt = t;
      if (st.mode === 'collect' && st.tubeId != null) { st.black.set(st.tubeId, t + 4 + 4 * n); st.tubeId = null; st.reT = 0; }
      if (st.mode === 'score' && st.post && st.post.p) { st.postBan.set(st.post.p.id, t + 3 + 3 * n); st.reT = 0; st.staged = false; }
      if (n >= 3) st.detour = { until: t + 2.5, x: st.flip * 1.5, z: st.flip * 1.5 };
    }
    if (st.rotT > 0.7 && !me.action) { // yaw blocked (square bumpers jammed against a wall/robot): back toward field center while turning
      const e = escapeDir(c);
      st.unstick = { until: t + 0.9, v: { x: e.x * Math.max(P.speed, 0.7), z: e.z * Math.max(P.speed, 0.7) }, rot: st.rotCmd, clearFirst: true };
      st.rotT = 0;
    }
    if (!c.auto && c.zones.some((z) => rectDist(z, me.x, me.z).d < 0.62) && (me.contacts || []).some((id) => S.robots.find((r) => r.id === id)?.alliance !== alliance) && !st.unstick) { // touching an opponent beside their zone: leave now
      const e = escapeDir(c);
      st.unstick = { until: t + 0.6, v: { x: e.x, z: e.z }, rot: 0 };
    }
    const publish = () => intents.set(me.id, { t, pri: c.pri, spot: st.spot, tube: st.tubePos });
    const finish = (res) => {
      st.rotCmd = res.rotate ?? res.turn ?? 0;
      if (c.preset.drive === 'tank' && res.throttle === undefined && (res.moveX || res.moveZ)) st.rotCmd = clamp(wrap(Math.atan2(res.moveZ, res.moveX) - me.heading) * 3, -1, 1); // field-frame command: sim turns the tank toward it
      if (Math.abs(st.rotCmd) > 0.5 && Math.abs(me.omega) < 0.3 && !me.support) st.rotT += dt; else st.rotT = Math.max(0, st.rotT - dt);
      st.waitT = c.yielded ? Math.min(3, st.waitT + dt) : Math.max(0, st.waitT - 2 * dt);
      publish();
      return res;
    };
    if (st.unstick && t < st.unstick.until) { st.lastCmd = 0; publish(); return recover(c, out); }
    if (st.detour && t < st.detour.until && !busy && !climbing) { // neutral waypoint away from the jam
      drive(out, c, steer(c, st.detour.x, st.detour.z), 0); publish(); return out;
    }

    if (climbing && !busy) { st.lastCmd = 0; st.goalD = 0; return finish(climb(c, out)); }
    if (busy) { st.lastCmd = 0; publish(); return out; }

    if (!st.waiting) {
      if (st.mode === 'collect') {
        if (held >= (c.auto ? 1 : 2) || (held > 0 && (st.noTube || match.remaining < 15))) { st.mode = 'score'; st.post = null; st.reT = 0; st.staged = false; }
      } else if (held === 0) { st.mode = 'collect'; st.tubeId = null; st.reT = 0; }
    }
    st.lastCmd = 0;
    return finish(st.mode === 'score' ? score(c, out) : collect(c, out));
  }

  return { think, state: st };
}
