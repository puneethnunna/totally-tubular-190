import assert from 'node:assert/strict';
import { createSim } from '../js/sim.js';
import { SIDES, FIELD, POINTS, ROBOT_PRESETS } from '../js/config.js';

const presets = ['stacker', 'tosser', 'climber', 'sweeper', 'stacker', 'sweeper'];
const mk = () => createSim({
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
assert.equal(cl.support, 2, 'climbed L2'); assert.equal(cl.y, 0.2);
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
    assert.ok(Math.abs(q.x) <= FIELD.halfL + 1e-6 && Math.abs(q.z) <= FIELD.halfW + 1e-6, 'tube in field ' + q.state);
  }
  for (const pp of sim.state.posts) assert.ok(pp.tubes.length <= POINTS.maxPhysicalPerPost);
}
console.log('fuzz ok', Date.now() - t0, 'ms', JSON.stringify(counts(sim)), 'tubes', sim.state.tubes.length);
console.log('sim tests passed');
