// AutoAlign tests on the real sim. Run: node test/autoalign.test.mjs
import assert from 'node:assert/strict';
import { createSim } from '../js/sim.js';
import { createAutoAlign, inScoringZone, ZONE_MSG } from '../js/autoalign.js';
import { SIDES } from '../js/config.js';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const DT = 1 / 60;

function setup(preset, alliance, x, z, heading, extra = []) {
  const robots = [{ id: 'me', alliance, slot: 0, preset, start: { x, z, heading }, preload: true }, ...extra];
  const sim = createSim({ robots, midfield: { blue: 0, red: 0 }, autoHumanPlayer: false });
  return sim;
}
const postTubes = (sim, tier, alliance) => sim.state.posts.filter((p) => p.alliance === alliance && p.tier === tier).reduce((a, p) => a + p.tubes.length, 0);
// Run until auto-align finishes. Returns { t (s until the place action began), done (s total), result }.
function run(sim, aa, maxT = 8, manual = () => null) {
  let tAct = null, T = 0;
  while (aa.active && T < maxT) {
    const inp = aa.step(sim, DT, manual(T));
    if (inp === null) break;
    sim.step(DT, { me: inp }, 'teleop'); T += DT;
    if (tAct === null && sim.robotById('me').action) tAct = T;
  }
  for (let i = 0; i < 90; i++) sim.step(DT, {}, 'teleop'); // let a launched tube land
  return { tAct, T, result: aa.result };
}
const spots = (a) => (a === 'blue'
  ? [[6.0, -2.8, Math.PI], [5.6, 0.9, Math.PI / 2], [7.0, -0.5, 0], [6.2, 1.2, -2.0]]
  : [[-6.0, 2.8, 0], [-5.6, -0.9, -Math.PI / 2], [-7.0, 0.5, Math.PI], [-6.2, -1.2, 1.1]]);

for (const alliance of ['blue', 'red']) {
  t(`swerve stacker places UPPER from several poses (${alliance})`, () => {
    for (const [x, z, h] of spots(alliance)) {
      const sim = setup('stacker', alliance, x, z, h), aa = createAutoAlign(), r = sim.robotById('me');
      const s = aa.start(sim, 'me', 'auto'); assert.ok(s.ok, s.reason); assert.match(aa.target.label, /^UPPER \d$/);
      const { tAct, result } = run(sim, aa);
      assert.ok(result.ok, `${alliance} ${x},${z}: ${result.reason}`); assert.ok(tAct !== null && tAct <= 4.2, `took ${tAct}`);
      assert.equal(postTubes(sim, 'upper', alliance), 1, `upper count ${x},${z}`); assert.equal(r.held.length, 0); assert.equal(aa.active, false);
    }
  });
  t(`swerve stacker LOWER tier + sweeper (lower only) (${alliance})`, () => {
    for (const preset of ['stacker', 'sweeper']) for (const [x, z, h] of spots(alliance).slice(0, 3)) {
      const sim = setup(preset, alliance, x, z, h), aa = createAutoAlign();
      const s = aa.start(sim, 'me', preset === 'sweeper' ? 'auto' : 'lower'); assert.ok(s.ok, s.reason); assert.match(aa.target.label, /^LOWER/);
      const { tAct, result } = run(sim, aa);
      assert.ok(result.ok && tAct <= 4.2, `${preset} ${x},${z}: ${result.reason} ${tAct}`); assert.equal(postTubes(sim, 'lower', alliance), 1); assert.equal(postTubes(sim, 'upper', alliance), 0);
    }
  });
  t(`tank tosser: drive-in LOWER place and AUTO launch (${alliance})`, () => {
    for (const [x, z, h] of spots(alliance).slice(0, 3)) {
      let sim = setup('tosser', alliance, x, z, h), aa = createAutoAlign();
      assert.ok(aa.start(sim, 'me', 'lower').ok); assert.match(aa.target.label, /^LOWER/);
      let { tAct, result } = run(sim, aa);
      assert.ok(result.ok && tAct <= 4.3, `tank lower ${x},${z}: ${result.reason} ${tAct}`); assert.equal(postTubes(sim, 'lower', alliance), 1);
      sim = setup('tosser', alliance, x, z, h); aa = createAutoAlign();
      assert.ok(aa.start(sim, 'me', 'auto').ok); assert.equal(aa.target.mode, 'launch');
      ({ tAct, result } = run(sim, aa));
      assert.ok(result.ok && tAct <= 4.3, `tank launch ${x},${z}: ${result.reason} ${tAct}`); assert.equal(postTubes(sim, 'upper', alliance) + postTubes(sim, 'lower', alliance), 1, 'launched tube on a post');
    }
  });
}
t('snaps to the NEAREST eligible post of the tier (ignores fill level), skips full ones', () => {
  for (const z of [-2.8, -0.5, 0.8]) {
    const sim = setup('stacker', 'blue', 6.0, z, Math.PI);
    const ups = sim.state.posts.filter((p) => p.alliance === 'blue' && p.tier === 'upper');
    const near = (list) => list.reduce((a, p) => (Math.hypot(p.tipX - 0.5 - 6.0, p.z - z) < Math.hypot(a.tipX - 0.5 - 6.0, a.z - z) ? p : a));
    const nearest = near(ups); assert.ok(createAutoAlign().start(sim, 'me', 'upper').ok);
    const aa = createAutoAlign(); aa.start(sim, 'me', 'upper'); assert.equal(aa.target.id, nearest.id, `z=${z}`);
    for (let i = 0; i < 3; i++) nearest.tubes.push('x' + i); // now full -> next nearest
    const aa2 = createAutoAlign(); aa2.start(sim, 'me', 'upper'); assert.equal(aa2.target.id, near(ups.filter((p) => p !== nearest)).id);
    nearest.tubes.length = 0; ups.filter((p) => p !== nearest)[0].tubes.push('y'); // a partly filled far post gets no bonus
    const aa3 = createAutoAlign(); aa3.start(sim, 'me', 'upper'); assert.equal(aa3.target.id, nearest.id);
  }
});
t('auto-align with two tubes held double-places onto the nearest empty post', () => {
  const sim = createSim({ robots: [{ id: 'me', alliance: 'blue', slot: 0, preset: 'stacker', start: { x: 6.0, z: -0.5, heading: Math.PI }, preload: true }], midfield: { blue: 4, red: 0 }, autoHumanPlayer: false }), r = sim.robotById('me');
  const sim2tube = (s) => { const q = s.state.tubes.find((u) => u.state === 'floor'); q.state = 'held'; q.holder = 'me'; return q; };
  const x = sim2tube(sim); r.held.push(x.id);
  const aa = createAutoAlign(); assert.ok(aa.start(sim, 'me', 'upper').ok); const id = aa.target.id;
  const { result } = run(sim, aa, 9); assert.ok(result.ok, result.reason);
  assert.equal(sim.state.posts.find((p) => p.id === id).tubes.length, 2); assert.equal(r.held.length, 0);
});
t('refuses outside the scoring zone / without a tube / unsupported tier', () => {
  const sim = setup('stacker', 'blue', 0, 0, 0), aa = createAutoAlign();
  assert.equal(inScoringZone(sim.robotById('me')), false);
  const s = aa.start(sim, 'me', 'auto'); assert.equal(s.ok, false); assert.equal(s.reason, ZONE_MSG); assert.equal(aa.active, false);
  const s2 = setup('stacker', 'blue', 6, 0, 0); s2.robotById('me').held.length = 0;
  assert.equal(createAutoAlign().start(s2, 'me', 'auto').reason, 'No tube held');
  const s3 = setup('sweeper', 'blue', 6, 0, 0); assert.equal(createAutoAlign().start(s3, 'me', 'upper').ok, false);
  const red = setup('stacker', 'red', 6, 0, 0); assert.equal(createAutoAlign().start(red, 'me', 'auto').reason, ZONE_MSG); // blue's zone is not red's
  assert.ok(SIDES.blue.scoringZone.x0 > 0);
});
t('only a deliberate, held drive input cancels (drift, early input and a second press do not)', () => {
  let sim = setup('stacker', 'blue', 6.0, -2.8, Math.PI), aa = createAutoAlign(); aa.start(sim, 'me', 'auto');
  let out = aa.step(sim, DT, { moveX: 0.05 }); assert.ok(out && aa.active, 'small drift does not cancel');
  for (let i = 0; i < 30; i++) aa.step(sim, DT, { rotate: 1 }); assert.ok(aa.active, 'input in the first 0.5 s is ignored');
  for (let i = 0; i < 60; i++) aa.step(sim, DT, { moveX: 0.4 }); assert.ok(aa.active, 'moderate input does not cancel');
  assert.ok(aa.step(sim, DT, { place: true }) && aa.active, 'pressing Place again does not cancel');
  for (let i = 0; i < 50 && aa.active; i++) out = aa.step(sim, DT, { rotate: 0.9 });
  assert.equal(aa.active, false); assert.equal(aa.result.reason, 'Auto-align cancelled');
  sim = setup('tosser', 'blue', 6.0, -2.8, Math.PI); aa = createAutoAlign(); aa.start(sim, 'me', 'lower');
  for (let i = 0; i < 120 && aa.active; i++) aa.step(sim, DT, { throttle: -1 }); assert.equal(aa.active, false);
  aa.start(sim, 'me', 'auto'); aa.cancel(); assert.equal(aa.active, false);
  const { result } = run(sim, aa, 1); assert.ok(sim.robotById('me').held.length === 1 && postTubes(sim, 'upper', 'blue') === 0, 'nothing placed after cancel');
});
t('blocked by another robot: picks a different post or aborts', () => {
  // a defender parked right in front of the nearest upper post
  const sim = setup('stacker', 'blue', 6.0, -2.8, Math.PI, [{ id: 'opp', alliance: 'red', slot: 0, preset: 'stacker', start: { x: 6.7, z: -2.4, heading: 0 }, preload: false }]);
  const aa = createAutoAlign(); const s = aa.start(sim, 'me', 'auto'); assert.ok(s.ok, s.reason);
  assert.ok(Math.abs(aa.target.z - -2.4) > 0.5 || aa.target.x < 6.2, 'did not target the blocked spot');
  const { result, T } = run(sim, aa, 6);
  assert.ok(result.ok || /blocked|timed/i.test(result.reason), result.reason); assert.ok(T <= 6);
});
t('times out instead of running forever', () => {
  const sim = setup('tosser', 'blue', 6.0, -2.8, Math.PI), aa = createAutoAlign(); aa.start(sim, 'me', 'lower');
  let T = 0; while (aa.active && T < 12) { const i = aa.step(sim, DT); if (i) { i.throttle = 0; i.turn = 0; } sim.step(DT, { me: i || {} }, 'teleop'); T += DT; }
  assert.equal(aa.active, false); assert.match(aa.result.reason, /timed out/); assert.ok(T < 5);
});
console.log(`\n${n} tests passed`);

// auto-align starts as soon as the bumper reaches the scoring-zone tape (robot centre still outside)
{
  const { createSim } = await import('../js/sim.js');
  const { createAutoAlign } = await import('../js/autoalign.js');
  const s = createSim({ robots: [{ id: 'blue-0', alliance: 'blue', slot: 0, number: '190', preset: 'stacker' }], midfield: { blue: 0, red: 0 } });
  const r = s.state.robots[0]; r.x = 4.75; r.z = -1; r.heading = 0; s.step(1 / 120, {}, 'teleop');
  const aa = createAutoAlign(); const res = aa.start(s, 'blue-0', 'upper');
  if (!res.ok) throw new Error('auto-align should start from the zone line: ' + res.reason);
  let placed = false;
  for (let i = 0; i < 120 * 6 && aa.active; i++) { const o = aa.step(s, 1 / 120, null) || {}; s.step(1 / 120, { 'blue-0': o }, 'teleop'); for (const e of s.drainEvents()) if (e.type === 'place') placed = true; }
  if (!placed) throw new Error('auto-align from the zone line did not place');
  console.log('ok - auto-align from the zone line');
}
