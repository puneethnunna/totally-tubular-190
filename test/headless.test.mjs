// Full CPU-vs-CPU match. Usage: node test/headless.test.mjs [solo|1v1|2v2|3v3|all] [easy|normal|hard]
import assert from 'node:assert/strict';
import { createSim } from '../js/sim.js';
import { createMatch } from '../js/match.js';
import { createBot } from '../js/ai.js';
import { ROBOT_PRESETS, DEFAULT_TEAMS, FIELD } from '../js/config.js';

const MODES = { solo: [1, 0], '1v1': [1, 1], '2v2': [2, 2], '3v3': [3, 3] };

function play(mode, diff = 'hard', verbose = false) {
  const [nb, nr] = MODES[mode];
  const robots = [];
  for (const [a, n] of [['blue', nb], ['red', nr]]) for (let s = 0; s < n; s++)
    robots.push({ id: `${a}-${s}`, alliance: a, slot: s, number: DEFAULT_TEAMS[a][s], preset: ROBOT_PRESETS[(s + (a === 'red' ? 1 : 0)) % 4].id });
  const sim = createSim({ robots, midfield: { blue: 8, red: 8 }, autoHumanPlayer: true });
  const match = createMatch(sim);
  const bots = robots.map((r) => createBot(r.id, r.alliance, diff));
  match.start();
  const dt = 1 / 120; let n = 0, frame = {};
  const stuck = Object.fromEntries(robots.map((r) => [r.id, { cur: 0, max: 0 }]));
  const t0 = Date.now();
  while (match.phase !== 'done' && n++ < 200 * 120) {
    const inputs = {};
    if (n % 2 === 1) { frame = {}; robots.forEach((r, i) => (frame[r.id] = bots[i].think(sim, match, dt * 2))); }
    for (const id in frame) { inputs[id] = { ...frame[id] }; if (n % 2 === 0) for (const k of ['scoreLower', 'scoreUpper', 'scoreFloor', 'launch']) inputs[id][k] = false; }
    if (match.phase === 'transition') for (const id in inputs) inputs[id] = {}; // robots disabled
    sim.step(dt, inputs, match.simPhase);
    match.fouls.onEvents(sim.drainEvents());
    match.update(dt);
    for (const t of sim.state.tubes) { // human-player tubes: the ring's lowest edge never goes below the carpet, no upright->flat snaps
      if (t.state === 'chute') assert.ok(t.y - 0.2155 * Math.sin((t.tilt || 0) * Math.PI / 2) >= 0.0635 - 1e-3, `${mode}: chute tube sank`);
      if (t.state === 'floor' && t._wasChuteTilt > 0.05) assert.fail(`${mode}: chute tube snapped flat`);
      t._wasChuteTilt = t.state === 'chute' ? t.tilt || 0 : 0;
      if ((t.state === 'floor' || t.state === 'chute') && t._px !== undefined && t._ps === t.state) assert.ok(Math.hypot(t.x - t._px, t.z - t._pz) < 0.1, `${mode}: tube ${t.id} jumped ${Math.hypot(t.x - t._px, t.z - t._pz).toFixed(2)} m in one step`);
      t._px = t.x; t._pz = t.z; t._ps = t.state;
    }
    for (const [i, r] of sim.state.robots.entries()) {
      const sk = stuck[r.id], bs = bots[robots.findIndex((x) => x.id === r.id)].state; // commanding motion but barely moving, not placing/climbing
      if (['auto', 'teleop', 'endgame'].includes(match.phase) && bs && bs.lastCmd > 0.3 && Math.hypot(r.vx, r.vz) < 0.2 && !r.action && !r.support) sk.max = Math.max(sk.max, (sk.cur += dt)); else sk.cur = 0;
      assert.ok(Number.isFinite(r.x + r.z + r.heading + r.vx + r.vz + r.omega), 'finite robot');
      assert.ok(Math.abs(r.x) <= FIELD.halfL && Math.abs(r.z) <= FIELD.halfW, 'robot in field');
    }
    if (verbose && n % (120 * 25) === 0) console.log(match.phase, Math.round(match.remaining), 'B', match.score.blue.total, 'R', match.score.red.total,
      sim.state.robots.map((r) => `${r.id}:${r.held.length}/${r.support}/${bots[robots.findIndex((x) => x.id === r.id)].state?.mode ?? ''}`).join(' '));
  }
  assert.equal(match.phase, 'done', 'match completes');
  return { f: match.final, match, stuck: Object.fromEntries(Object.entries(stuck).map(([k, v]) => [k, +v.max.toFixed(1)])), ms: Date.now() - t0, n };
}

const nb2 = (m) => MODES[m][0];
const arg = process.argv[2] || 'all', diff = process.argv[3] || 'hard';
for (const mode of arg === 'all' ? Object.keys(MODES) : [arg]) {
  const { f, match, ms, n, stuck } = play(mode, diff, arg !== "all");
  for (const a of ['blue', 'red']) console.log(mode, a, JSON.stringify({ auto: f[a].auto, teleop: f[a].teleop, plat: f[a].platform.levels, fouls: f[a].fouls, total: f[a].total, full: f[a].fullPosts, rp: f[a].rp.total }));
  console.log(mode, 'winner', f.winner, 'fouls', match.fouls.list.length, match.fouls.list.slice(0, 6).map((x) => x.rule + ':' + x.robotId).join(' '), `${ms} ms (${(ms / n).toFixed(3)} ms/step)`);
  const mx = Math.max(...Object.values(stuck));
  console.log(mode, 'max stuck (s)', JSON.stringify(stuck));
  if (nb2(mode) >= 2) assert.ok(mx < 5, `${mode}: a robot was stuck ${mx}s`);
  assert.ok(f.blue.total > 0, `${mode}: blue scored`);
  if (MODES[mode][1]) assert.ok(f.red.total > 0, `${mode}: red scored`);
}
console.log('headless tests passed');
