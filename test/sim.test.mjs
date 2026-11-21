import assert from 'node:assert/strict';
import { createSim } from '../js/sim.js';
import { SIDES, FIELD, POINTS, ROBOT_PRESETS } from '../js/config.js';

const presets = ['stacker', 'tosser', 'climber', 'sweeper', 'stacker', 'sweeper'];
const mk = (o = {}) => createSim({ ...o,
  robots: ['blue', 'red'].flatMap((al, a) => [0, 1, 2].map((s) => ({
    id: `${al}-${s}`, alliance: al, slot: s, number: String(100 + s), preset: presets[a * 3 + s], preload: true }))),
  midfield: { blue: 8, red: 8 }, autoHumanPlayer: true,
});
const dt = 1 / 120;
const counts = (sim) => sim.state.tubes.reduce((m, t) => ((m[t.state] = (m[t.state] || 0) + 1), m), {});

// --- setup
let sim = mk();
assert.equal(sim.state.robots.length, 6);
assert.equal(sim.state.reserve.blue, 97);
assert.equal(sim.state.tubes.length, 16 + 6);
assert.equal(counts(sim).held, 6);
assert.equal(sim.state.posts.length, 32);

// --- drive blue-0 (stacker) to a post and place
const r = sim.state.robots[0];
const post = SIDES.blue.posts.find((p) => p.id === 'blue-upper-2');
const run = (n, inp, ph) => { for (let i = 0; i < n; i++) sim.step(dt, { 'blue-0': typeof inp === 'function' ? inp(i) : inp }, ph); };
run(600, () => ({ rotate: Math.max(-1, Math.min(1, -r.heading * 3)), moveX: r.x < 7.2 ? 1 : 0, moveZ: Math.max(-1, Math.min(1, (post.z - r.z) * 3)) }), 'auto');
assert.ok(Math.abs(r.heading) < 0.1, 'heading ' + r.heading);
assert.ok(Math.abs(r.z - post.z) < 0.15, 'z ' + r.z);
sim.drainEvents();
run(1, { scoreUpper: true }, 'auto');
run(200, {}, 'auto');
const ev = sim.drainEvents();
assert.ok(ev.some((e) => e.type === 'place' && e.postId === post.id), 'place event');
const p = sim.state.posts.find((q) => q.id === post.id);
assert.equal(p.tubes.length, 1);
const t = sim.state.tubes.find((q) => q.id === p.tubes[0]);
assert.equal(t.state, 'post'); assert.ok(t.placedInAuto); assert.equal(t.y, post.y);
assert.equal(r.held.length, 0);


// --- intake from floor
sim = mk();
const b1 = sim.state.robots[1], tube0 = sim.state.tubes.find((q) => q.state === 'floor');
tube0.x = b1.x - 1.0; tube0.z = b1.z;
for (let i = 0; i < 240; i++) sim.step(dt, { 'blue-1': { intake: true } }, 'teleop');
assert.equal(b1.held.length, 2, 'intake works');

// --- tosser launch
sim = mk();
const tos = sim.state.robots[1]; // blue-1 tosser
tos.x = 5.2; tos.z = -1.0; tos.heading = 0;
sim.step(dt, {}, 'teleop');
sim.step(dt, { 'blue-1': { launch: true } }, 'teleop');
for (let i = 0; i < 240; i++) sim.step(dt, {}, 'teleop');
const evl = sim.drainEvents();
assert.ok(evl.some((e) => e.type === 'launch'));
assert.ok(sim.state.posts.some((q) => q.alliance === 'blue' && q.tubes.length === 1), 'launch hooked a post');

// --- climb
sim = mk();
const cl = sim.state.robots[0]; // stacker maxClimb 3
cl.x = -1.2; cl.z = -2.0; cl.heading = -Math.PI / 2;
sim.step(dt, {}, 'endgame');
for (let i = 0; i < 300; i++) sim.step(dt, { 'blue-0': { climb: true, moveZ: -0.2 } }, 'endgame');
assert.equal(cl.support, 2, 'climbed L2'); assert.equal(cl.y, SIDES.blue.platforms[0].height);
cl.heading = 0;
for (let i = 0; i < 300; i++) sim.step(dt, { 'blue-0': { climb: true, moveX: 0.3 } }, 'endgame');
assert.equal(cl.support, 3, 'climbed L3 ' + cl.x);
for (let i = 0; i < 300; i++) sim.step(dt, { 'blue-0': { climb: true, moveX: 0.3 } }, 'endgame');
assert.equal(cl.support, 3, 'stacker cannot reach L4');
for (let i = 0; i < 300; i++) sim.step(dt, { 'blue-0': { moveZ: 1 } }, 'endgame');
assert.ok(cl.support < 2 && cl.y === 0, 'drove off');

// --- human feed never in auto
sim = mk();
for (let i = 0; i < 600; i++) sim.step(dt, {}, 'auto');
assert.equal(sim.state.reserve.blue, 97);
assert.equal(sim.requestHumanTube('blue'), false);
for (let i = 0; i < 600; i++) sim.step(dt, {}, 'teleop');
assert.ok(sim.state.reserve.blue < 97);

// ===== physics =====
const mk1 = (robots, o = {}) => createSim({ robots, midfield: { blue: 0, red: 0 }, autoHumanPlayer: false, ...o });
const bot = (id, al, slot, preset, start, extra = {}) => ({ id, alliance: al, slot, number: id, preset, start, preload: false, ...extra });
const runS = (s, n, inp, ph = 'teleop') => { for (let i = 0; i < n; i++) s.step(dt, typeof inp === 'function' ? inp(i) : inp, ph); };
const swerveP = ROBOT_PRESETS.find((q) => q.id === 'stacker'), tankP = ROBOT_PRESETS.find((q) => q.id === 'tosser');

// --- solo (1 robot) + preset as object with radius/mass
sim = mk1([bot('a', 'blue', 0, 'stacker', { x: 0, z: 0, heading: 0 })]);
assert.equal(sim.state.robots.length, 1);
runS(sim, 240, { a: { moveX: 1 } });
assert.ok(sim.state.robots[0].x > 3, 'solo drives');
sim = mk1([bot('a', 'red', 2, { ...swerveP, id: 'custom', radius: 0.62, mass: 80, model: { kind: 'procedural', style: 'stacker' } }, { x: 0, z: 0, heading: 0 })]);
const big = sim.state.robots[0];
assert.equal(big.radius, 0.62); assert.equal(big.mass, 80); assert.equal(big.preset.id, 'custom');
runS(sim, 600, { a: { moveX: 1 } });
assert.ok(Math.abs(big.x - (SIDES.blue.posts[0].tipX - 0.62)) < 0.02, 'custom radius stops at post rail ' + big.x);
big.x = 3; big.vx = 0;
runS(sim, 600, { a: { moveZ: 1 } });
assert.ok(Math.abs(big.z - (FIELD.halfW - 0.62)) < 0.02, 'custom radius stops at side wall ' + big.z);

// --- traction-limited accel with motor-curve taper, no overshoot of top speed
sim = mk1([bot('a', 'blue', 0, 'sweeper', { x: -6, z: 0, heading: 0 })]); // accel 12 > traction
const sw = sim.state.robots[0], sweeperP = ROBOT_PRESETS.find((q) => q.id === 'sweeper');
let vPrev = 0, aMax = 0, vTop = 0, t50 = 0, t90 = 0;
for (let i = 0; i < 360; i++) {
  sim.step(dt, { a: { moveX: 1 } }, 'teleop');
  aMax = Math.max(aMax, (sw.vx - vPrev) / dt); vPrev = sw.vx; vTop = Math.max(vTop, sw.vx);
  if (!t50 && sw.vx > 0.5 * sweeperP.maxSpeed) t50 = i * dt; if (!t90 && sw.vx > 0.9 * sweeperP.maxSpeed) t90 = i * dt;
}
assert.ok(aMax < 10.8, 'accel <= mu*g, got ' + aMax);
assert.ok(vTop <= sweeperP.maxSpeed * 1.001 && vTop > 0.9 * sweeperP.maxSpeed, 'top speed ' + vTop);
assert.ok(t90 > 2.2 * t50, `accel tapers toward top speed (${t50.toFixed(2)} -> ${t90.toFixed(2)})`);
// module response: commanded step does not change velocity instantly
sim = mk1([bot('a', 'blue', 0, 'stacker', { x: 0, z: 0, heading: 0 })]);
runS(sim, 2, { a: { moveX: 1 } });
assert.ok(sim.state.robots[0].vx < 0.2 && sim.state.robots[0].vx > 0, 'commanded step ramps in (module response)');

// --- swerve: translation and rotation are independent; sharing traction slows both
const swerveRun = (rotate) => {
  const s = mk1([bot('a', 'blue', 0, 'stacker', { x: 3, z: -3, heading: 0 })]);
  runS(s, 90, { a: { moveZ: 1, rotate } });
  return s.state.robots[0];
};
const sA = swerveRun(0), sB = swerveRun(1);
assert.ok(sA.z > -3 + 1.5 && Math.abs(sA.heading) < 1e-3, 'swerve strafes without turning');
assert.ok(sB.heading > 0.5 && sB.z > -3 + 0.8 && sB.z < sA.z, 'translate+rotate share traction (z ' + sB.z + ' < ' + sA.z + ')');

// --- tank cannot strafe
sim = mk1([bot('a', 'blue', 0, 'tosser', { x: 0, z: 0, heading: 0 })]);
runS(sim, 240, { a: { throttle: 1, turn: 0 } });
assert.ok(sim.state.robots[0].x > 3 && Math.abs(sim.state.robots[0].z) < 0.01, 'tank drives straight');
sim = mk1([bot('a', 'blue', 0, 'tosser', { x: 0, z: 0, heading: 0 })]);
const tk = sim.state.robots[0]; tk.vz = 3; // shoved sideways
runS(sim, 120, { a: {} });
assert.ok(Math.abs(tk.z) < 0.4 && Math.abs(tk.vz) < 0.01, 'lateral shove scrubs off fast: ' + tk.z);
sim = mk1([bot('a', 'blue', 0, 'tosser', { x: 0, z: 0, heading: 0 })]);
runS(sim, 36, { a: { moveZ: 1 } }); // 0.3 s of "strafe" input: turns first, no sideways slide
assert.ok(Math.abs(sim.state.robots[0].z) < 0.15 && sim.state.robots[0].heading > 0.3, 'tank turns instead of strafing');
sim = mk1([bot('a', 'blue', 0, swerveP.id, { x: 0, z: 0, heading: 0 })]);
runS(sim, 36, { a: { moveZ: 1 } });
assert.ok(sim.state.robots[0].z > 0.2, 'swerve does strafe');

// --- push: heavy robot shoves a lighter one; lighter slides, heavier barely slows
const pushRun = (mHeavy, mLight) => {
  const s = mk1([
    bot('h', 'blue', 0, { ...swerveP, mass: mHeavy }, { x: -1.5, z: 0, heading: 0 }),
    bot('l', 'red', 0, { ...swerveP, mass: mLight }, { x: -0.3, z: 0, heading: Math.PI })]);
  runS(s, 120, { h: { moveX: 1 }, l: {} });
  return { s, h: s.state.robots[0], l: s.state.robots[1] };
};
let pr = pushRun(90, 45);
assert.ok(pr.l.x > 0.5, 'light robot pushed back ' + pr.l.x);
assert.ok(pr.h.x > -0.8, 'heavy robot advanced ' + pr.h.x);
assert.ok(pr.l.x - pr.h.x < 1.0 + 0.05, 'robots stay in contact, no overlap > 5cm');
assert.ok(Math.abs(pr.l.z) < 0.4, 'push is mostly straight');
const dLight = pr.l.x;
pr = pushRun(45, 90);
assert.ok(pr.l.x + 0.3 < 0.2 && pr.h.x < -0.8, 'light robot cannot push heavy one ' + [pr.h.x, pr.l.x]);
pr = pushRun(61, 61);
assert.ok(pr.l.x < dLight, 'equal masses: push is harder than heavy vs light');

// --- collisions produce spin (off-center hit) but not head-on
const spinRun = (dz) => {
  const s = mk1([
    bot('a', 'blue', 0, 'stacker', { x: -2, z: 0, heading: 0 }),
    bot('b', 'red', 0, 'stacker', { x: -1.0, z: dz, heading: Math.PI })]);
  s.state.robots[0].vx = 3;
  let peak = 0;
  for (let i = 0; i < 60; i++) { s.step(dt, {}, 'teleop'); for (const r of s.state.robots) peak = Math.max(peak, Math.abs(r.omega)); }
  return peak;
};
assert.ok(spinRun(0.55) > 0.5, 'glancing hit spins robots ' + spinRun(0.55));
assert.ok(spinRun(0) < 0.05, 'head-on hit does not spin');
// wall hits: restitution + friction spin, never escape the field
sim = mk1([bot('a', 'blue', 0, 'stacker', { x: 7.0, z: 0, heading: 0 })]);
sim.state.robots[0].vx = 3; sim.state.robots[0].vz = 2;
let wspin = 0; for (let i = 0; i < 40; i++) { sim.step(dt, {}, 'teleop'); wspin = Math.max(wspin, Math.abs(sim.state.robots[0].omega)); }
assert.ok(wspin > 0.1 && sim.state.robots[0].x <= FIELD.halfL - 0.5 + 1e-6, 'wall friction spins robot');

// --- up to 6 robots, any slots (1v0, 1v1, 2v2, 3v3 slot combos) stay finite and in-field
for (const slots of [[0], [0, 2], [1, 2], [0, 1, 2]]) {
  const rs = ['blue', 'red'].flatMap((al) => slots.map((sl) => bot(`${al}${sl}`, al, sl, ROBOT_PRESETS[sl % 4].id, undefined, { preload: true })));
  const s = mk1(rs);
  assert.equal(s.state.robots.length, rs.length);
  runS(s, 600, (i) => Object.fromEntries(rs.map((q) => [q.id, { moveX: Math.sin(i / 40 + q.slot), moveZ: Math.cos(i / 55), rotate: 0.5, intake: true }])));
  for (const x of s.state.robots) assert.ok(Number.isFinite(x.x + x.z) && Math.abs(x.x) <= FIELD.halfL);
}

// --- tubes: light, bouncy off walls, rolling friction, robots shove them
sim = mk1([bot('a', 'blue', 0, 'stacker', { x: -5, z: 3, heading: 0 })]);
const tb = sim.state.tubes.length ? sim.state.tubes[0] : null;
assert.equal(tb, null);
const mkTube = (s, x, z, vx, vz = 0) => {
  s.state.tubes.push({ id: 'x' + s.state.tubes.length, origin: 'blue', x, y: 0.0635, z, vx, vy: 0, vz, state: 'floor', holder: null, post: null,
    stackIndex: -1, placedInAuto: false, yaw: 0, spin: 0, lockT: 0, chuteT: 0, moving: true, flight: null });
  return s.state.tubes.at(-1);
};
const wallX = FIELD.halfL - 0.279;
let tq = mkTube(sim, wallX - 0.3, -2, 4);
runS(sim, 20, {});
assert.ok(tq.vx < 0 && tq.vx > -2.2, 'tube bounces off wall with restitution ~0.4, vx=' + tq.vx);
runS(sim, 600, {});
assert.ok(Math.hypot(tq.vx, tq.vz) === 0 && !tq.moving, 'rolling friction stops tube');
const t1 = mkTube(sim, 0, -2, 3), t2 = mkTube(sim, 0.9, -2, 0);
runS(sim, 30, {});
assert.ok(t2.vx > 1.0 && t1.vx < 0.9 && t1.vx > 0, 'tube-tube collision transfers momentum (restitution 0.4) ' + [t1.vx, t2.vx]);
const robBefore = sim.state.robots[0];
sim = mk1([bot('a', 'blue', 0, 'stacker', { x: -2, z: 0, heading: 0 })]);
const pushed = mkTube(sim, -0.4, 0, 0);
runS(sim, 120, { a: { moveX: 1 } });
assert.ok(pushed.x > sim.state.robots[0].x, 'robot pushes tube ahead of it');
const ctl = mk1([bot('a', 'blue', 0, 'stacker', { x: -2, z: 0, heading: 0 })]);
runS(ctl, 120, { a: { moveX: 1 } });
assert.ok(ctl.state.robots[0].x - sim.state.robots[0].x < 0.15, 'tube barely slows robot (0.4 kg vs 61 kg): ' + [ctl.state.robots[0].x, sim.state.robots[0].x]);
// free flight has quadratic drag + bounces, and lands inside field
sim = mk1([bot('a', 'blue', 0, 'tosser', { x: -3, z: 0, heading: 0 }, { preload: true })]);
sim.step(dt, { a: { launch: true } }, 'teleop'); runS(sim, 200, {});
const ev2 = sim.drainEvents();
assert.ok(ev2.some((e) => e.type === 'launch') && ev2.some((e) => e.type === 'land'), 'free throw launches and lands');
const th = sim.state.tubes[0];
assert.ok(th.x > 0.4 && th.x < 2.4 && th.state !== 'flight' && th.y <= 0.07 + 1e-6, 'thrown tube lands downfield ' + th.x);

// --- determinism: same seed + inputs -> same state
const detRun = (seed) => {
  const s = mk({ seed });
  for (let i = 0; i < 1500; i++) s.step(dt, Object.fromEntries(s.state.robots.map((q, k) => [q.id, { moveX: Math.sin(i / 30 + k), moveZ: Math.cos(i / 45 - k), rotate: Math.sin(i / 20), intake: true, launch: i % 200 === 0 }])), 'teleop');
  return JSON.stringify([s.state.robots.map((q) => [q.x, q.z, q.heading, q.omega]), s.state.tubes.map((q) => [q.x, q.z, q.yaw])]);
};
assert.equal(detRun(5), detRun(5), 'deterministic');

// --- 216 loose tubes + 6 robots stays fast
sim = mk();
for (let i = 0; i < 200; i++) mkTube(sim, -7 + (i % 20) * 0.7, -3.4 + Math.floor(i / 20) * 0.7, 0);
{
  const t0 = process.hrtime.bigint(), N = 600;
  for (let i = 0; i < N; i++) sim.step(dt, Object.fromEntries(sim.state.robots.map((q, k) => [q.id, { moveX: Math.sin(i / 30 + k), moveZ: Math.cos(i / 45), rotate: 1 }])), 'teleop');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log('perf', ms.toFixed(3), 'ms/step with', sim.state.tubes.length, 'tubes');
  assert.ok(ms < 1, 'step < 1 ms');
}

// --- fuzz 125 s
sim = mk();
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const ids = sim.state.robots.map((x) => x.id);
let inp = {};
const t0 = Date.now();
for (let i = 0; i < 125 * 120; i++) {
  const time = i * dt;
  const ph = time < 3 ? 'pre' : time < 23 ? 'auto' : time < 95 ? 'teleop' : time < 125 ? 'endgame' : 'post';
  if (i % 30 === 0) {
    inp = {};
    for (const id of ids) inp[id] = {
      moveX: rnd() * 2 - 1, moveZ: rnd() * 2 - 1, rotate: rnd() * 2 - 1, throttle: rnd() * 2 - 1, turn: rnd() * 2 - 1,
      intake: rnd() < 0.7, scoreLower: rnd() < 0.1, scoreUpper: rnd() < 0.1, scoreFloor: rnd() < 0.05, launch: rnd() < 0.1, climb: rnd() < 0.5 };
  } else for (const id of ids) { const o = inp[id]; o.scoreLower = o.scoreUpper = o.scoreFloor = o.launch = false; }
  sim.step(dt, inp, ph);
  if (i % 60 === 0) sim.drainEvents();
  for (const x of sim.state.robots) {
    for (const v of [x.x, x.y, x.z, x.heading, x.vx, x.vz, x.omega, x.arm]) assert.ok(Number.isFinite(v), 'NaN robot');
    assert.ok(Math.abs(x.x) <= FIELD.halfL && Math.abs(x.z) <= FIELD.halfW, 'robot in field');
    assert.ok(x.held.length <= 2);
  }
  for (const q of sim.state.tubes) {
    for (const v of [q.x, q.y, q.z, q.vx, q.vy, q.vz]) assert.ok(Number.isFinite(v), 'NaN tube');
    assert.ok(Math.abs(q.x) <= FIELD.halfL + 1e-6 && Math.abs(q.z) <= FIELD.halfW + 1e-6, 'tube in field ' + q.state + ' ' + q.x.toFixed(3) + ',' + q.z.toFixed(3) + ' ' + q.id);
  }
  for (const pp of sim.state.posts) assert.ok(pp.tubes.length <= POINTS.maxPhysicalPerPost);
}
console.log('fuzz ok', Date.now() - t0, 'ms', JSON.stringify(counts(sim)), 'tubes', sim.state.tubes.length);
console.log('sim tests passed');
