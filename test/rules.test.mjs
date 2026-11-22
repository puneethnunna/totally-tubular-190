import assert from 'node:assert/strict';
import { SIDES, ROBOT_PRESETS } from '../js/config.js';
import { computeScore } from '../js/scoring.js';
import { createFoulTracker } from '../js/fouls.js';
import { createMatch } from '../js/match.js';
import { createBot } from '../js/ai.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

function mkSim({ robots = [], placed = {}, floor = {} } = {}) {
  // placed: { 'blue-lower-0': [autoFlags...] }, floor: { blue: count, red: count }
  const tubes = [], posts = [];
  let id = 0;
  for (const a of ['blue', 'red']) {
    for (const p of SIDES[a].posts) {
      const ids = (placed[p.id] || []).map((auto, i) => { tubes.push({ id: id, state: 'post', post: p.id, stackIndex: i, placedInAuto: !!auto }); return id++; });
      posts.push({ ...p, tubes: ids });
    }
    const fa = SIDES[a].floorArea;
    for (let i = 0; i < (floor[a] || 0); i++) tubes.push({ id: id++, state: 'floor', x: (fa.x0 + fa.x1) / 2, z: fa.z0 + 0.5 + (i % 10) * 0.3, placedInAuto: false });
  }
  return { state: { time: 0, robots, tubes, posts } };
}
const bot = (id, alliance, slot, o = {}) => ({ id, alliance, slot, number: id, preset: ROBOT_PRESETS[0], x: 0, z: 0, heading: 0, vx: 0, vz: 0,
  held: [], action: null, support: 0, contacts: [], ...o });
const plat = (alliance, x, support, slot, id = `${alliance}-${slot}`) => bot(id, alliance, slot, { x, z: alliance === 'blue' ? -3.3 : 3.3, support });
const done = (fouls) => ({ phase: 'done', fouls: fouls || { list: [], forcedLevel4: new Set() } });

test('Appendix A example = 76 pts (56 tube + 20 platform), platform RP', () => {
  const placed = {};
  for (let i = 0; i < 5; i++) placed[`blue-lower-${i}`] = [0, 0];                // 10 lower
  for (let i = 0; i < 8; i++) placed[`blue-upper-${i}`] = [0];                   // 8 upper
  const sim = mkSim({ placed, floor: { blue: 12 }, robots: [plat('blue', 0, 3, 0), plat('blue', -1.3, 2, 1), plat('blue', 1.3, 1, 2)] });
  const s = computeScore(sim, done()).blue;
  assert.equal(s.tubePoints, 56);
  assert.equal(s.platform.points, 20);
  assert.equal(s.total, 76);
  assert.equal(s.rp.platform16, 1);
  assert.equal(s.platform.projected, false);
});

test('3-per-post cap', () => {
  const sim = mkSim({ placed: { 'red-upper-2': [0, 0, 0, 0, 0] } });
  const s = computeScore(sim, done()).red;
  assert.equal(s.teleop.upper, 3);
  assert.equal(s.tubePoints, 9);
  assert.equal(s.fullPosts, 1);
});

test('11 full posts = 1 RP, 12 = 2 RP', () => {
  const mk = (k) => { const p = {}; SIDES.blue.posts.slice(0, k).forEach((q) => { p[q.id] = [0, 0, 0]; }); return computeScore(mkSim({ placed: p }), done()).blue; };
  assert.equal(mk(11).fullPosts, 11);
  assert.equal(mk(11).rp.posts8 + mk(11).rp.posts12, 1);
  assert.equal(mk(12).rp.posts8 + mk(12).rp.posts12, 2);
});

test('two L3 + one L1 = 24 platform points; mutual contact drops to lowest', () => {
  const rs = () => [plat('blue', -0.5, 3, 0), plat('blue', 0.5, 3, 1), plat('blue', 1.5, 1, 2)];
  assert.equal(computeScore(mkSim({ robots: rs() }), done()).blue.platform.points, 24);
  const r = rs(); r[1].contacts = ['blue-2']; r[2].contacts = ['blue-1'];
  assert.equal(computeScore(mkSim({ robots: r }), done()).blue.platform.points, 4 + 4 + 10);
  const off = rs(); off[0].x = 0; off[0].z = 0; // carpet outside platform zone
  assert.equal(computeScore(mkSim({ robots: off }), done()).blue.platform.points, 14);
});

test('AUTO tubes count double; TELEOP = total - auto', () => {
  const s = computeScore(mkSim({ placed: { 'blue-lower-0': [1, 1, 0], 'blue-upper-0': [1] } }), done());
  assert.equal(s.blue.auto.lower, 2); assert.equal(s.blue.teleop.lower, 1);
  assert.equal(s.blue.tubePoints, 2 * 4 + 1 * 2 + 6);
});

test('projected platform before done; RP win only at done', () => {
  const sim = mkSim({ placed: { 'blue-upper-0': [0] } });
  const s = computeScore(sim, { phase: 'endgame', fouls: null });
  assert.equal(s.blue.platform.projected, true); assert.equal(s.blue.rp.win, 0);
  const d = computeScore(sim, done());
  assert.equal(d.winner, 'blue'); assert.equal(d.blue.rp.win, 3);
});

test('G103 tech foul on offender, G111 escalation after 3 s, points to opponent', () => {
  const b = bot('blue-0', 'blue', 0, { x: 6.8, z: -1, contacts: ['red-0'] });
  const r = bot('red-0', 'red', 0, { x: 6.0, z: -1, contacts: ['blue-0'] });
  const sim = { state: { time: 10, robots: [b, r], tubes: [], posts: [] } };
  const match = { phase: 'teleop', remaining: 60, fouls: createFoulTracker() };
  match.fouls.update(sim, match, 0.1);
  assert.equal(match.fouls.list.length, 1);
  assert.deepEqual([match.fouls.list[0].rule, match.fouls.list[0].type, match.fouls.list[0].against], ['G103', 'tech', 'red']);
  for (let i = 0; i < 31; i++) match.fouls.update(sim, match, 0.1);
  assert.equal(match.fouls.list.length, 2);
  const s = computeScore(sim, { ...match, phase: 'done' });
  assert.equal(s.blue.fouls.points, 20); assert.equal(s.blue.total, 20);
});

test('G105 warning then card, G106 launch, G108 forces level 4, G110', () => {
  const f = createFoulTracker();
  const r = bot('red-0', 'red', 0, { x: 6.5, z: 3 }); // inside red loading zone
  const sim = { state: { time: 1, robots: [r], tubes: [], posts: [] } };
  f.update(sim, { phase: 'auto' }, 0.1); r.x = 0; f.update(sim, { phase: 'auto' }, 0.1);
  r.x = 6.5; f.update(sim, { phase: 'auto' }, 0.1);
  assert.deepEqual(f.list.map((e) => e.type), ['warning', 'card']);
  const g = createFoulTracker();
  const l = bot('blue-0', 'blue', 0, { x: 3, z: 0 });
  g.onEvents([{ type: 'launch', robotId: 'blue-0' }]); g.update({ state: { time: 2, robots: [l] } }, { phase: 'teleop' }, 0.1);
  assert.equal(g.list[0].rule, 'G106');
  const h = createFoulTracker();
  const v = bot('blue-0', 'blue', 0, { x: 0, z: -3, support: 2, contacts: ['red-0'] });
  const o = bot('red-0', 'red', 0, { x: 0.5, z: -2.3, contacts: ['blue-0'] });
  h.update({ state: { time: 3, robots: [v, o] } }, { phase: 'endgame' }, 0.1);
  assert.equal(h.list[0].rule, 'G108'); assert.equal(h.list[0].against, 'red'); assert.ok(h.forcedLevel4.has('blue-0'));
  const k = createFoulTracker();
  const a = bot('blue-0', 'blue', 0, { x: -1.2, z: 0, contacts: ['red-0'] }), c = bot('red-0', 'red', 0, { x: -2.2, z: 0, contacts: ['blue-0'] }); // blue starts at +x, so -x is past midfield
  k.update({ state: { time: 3, robots: [a, c] } }, { phase: 'auto' }, 0.1);
  assert.equal(k.list[0].rule, 'G110'); assert.equal(k.list[0].robotId, 'blue-0');
});

test('match phases and results', () => {
  const sim = mkSim({ placed: { 'blue-upper-0': [1] }, robots: [] });
  const m = createMatch(sim);
  assert.equal(m.phase, 'pre'); m.start();
  const seen = new Set(); let snap = false;
  for (let i = 0; i < 130 * 10 + 5; i++) { sim.state.time += 0.1; m.update(0.1); seen.add(m.phase); snap = snap || !!m.autoSnapshot; }
  assert.deepEqual([...seen], ['auto', 'transition', 'teleop', 'endgame', 'post', 'done']);
  assert.ok(snap && m.final && m.final.winner === 'blue' && m.final.blue.total === 6);
});

test('bot smoke: returns Input objects and scores a preload', () => {
  const r = bot('blue-0', 'blue', 0, { x: 6.1, z: -0.9, heading: Math.PI, held: [1], preset: ROBOT_PRESETS[0] });
  const sim = mkSim({ robots: [r] });
  const b = createBot('blue-0', 'blue', 'hard');
  const match = { phase: 'auto', remaining: 120 };
  let pressed = false;
  for (let i = 0; i < 1200 && !pressed; i++) {
    const inp = b.think(sim, match, 1 / 60);
    assert.equal(typeof inp, 'object');
    if (inp.scoreUpper) { pressed = true; break; }
    const v = 1 / 60; r.vx = (inp.moveX || 0) * 3; r.vz = (inp.moveZ || 0) * 3;
    r.x += r.vx * v; r.z += r.vz * v; r.heading += (inp.rotate || 0) * 4 * v; sim.state.time += v;
  }
  assert.ok(pressed, 'bot never pressed scoreUpper');
  assert.ok(r.x > 6.5 && r.x < 7.7, `final x ${r.x}`);
});

test('1-6 robots: missing slots score 0, solo/1v1 scoring and fouls work', () => {
  const sim = mkSim({ robots: [plat('blue', 0, 3, 1), plat('red', 0, 2, 2)] });
  const s = computeScore(sim, done());
  assert.deepEqual(s.blue.platform.levels, [0, 3, 0]); assert.equal(s.blue.platform.points, 10);
  assert.deepEqual(s.red.platform.levels, [0, 0, 2]);
  const solo = mkSim({ robots: [plat('blue', 0, 4, 0)] });
  const r = computeScore(solo, done());
  assert.equal(r.blue.total, 15); assert.equal(r.red.total, 0); assert.equal(r.winner, 'blue');
  const f = createFoulTracker(); // no opponents: nothing to foul
  f.update(solo, { phase: 'teleop' }, 0.1); assert.equal(f.list.length, 0);
});

test('fouls use per-robot radius', () => {
  const zone = SIDES.red.scoringZone; // blue robot just outside the red zone edge: touches only if its radius is large enough
  const mk = (radius) => bot('blue-0', 'blue', 0, { radius, x: zone.x0 - 0.55, z: 0, contacts: ['red-0'] });
  const run = (radius) => {
    const f = createFoulTracker();
    f.update({ state: { time: 1, robots: [mk(radius), bot('red-0', 'red', 0, { x: zone.x0 + 0.4, z: 0, contacts: ['blue-0'] })] } }, { phase: 'teleop' }, 0.1);
    return f.list.some((e) => e.rule === 'G103');
  };
  assert.equal(run(0.45), false); assert.equal(run(0.6), true);
});

test('bots handle solo play and custom radius/tank presets', () => {
  for (const preset of ROBOT_PRESETS) {
    const r = bot('blue-0', 'blue', 0, { x: 2, z: 0, heading: 0, radius: 0.6, omega: 0, held: [], preset });
    const sim = mkSim({ robots: [r] });
    for (const d of ['easy', 'normal', 'hard']) for (const ph of ['auto', 'teleop', 'endgame']) {
      const inp = createBot('blue-0', 'blue', d).think(sim, { phase: ph, remaining: ph === 'endgame' ? 10 : 100 }, 1 / 60);
      for (const v of Object.values(inp)) assert.ok(typeof v === 'boolean' || Number.isFinite(v));
    }
  }
});

console.log(`${n} tests passed`);
