// Auto path follower tests on the real sim. Run: node test/autopath.test.mjs
import assert from 'node:assert/strict';
import { createSim } from '../js/sim.js';
import { createAutoPath, mirrorStrokes, pathMarkers, resample, scoreEntries } from '../js/autopath.js';
import { SIDES } from '../js/config.js';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const DT = 1 / 120;

function play(preset, alliance, pts, { seconds = 20, extra = [], start } = {}) {
  const s0 = start || SIDES[alliance].starts[1];
  const robots = [{ id: 'me', alliance, slot: 0, preset, start: s0, preload: true }, ...extra];
  const sim = createSim({ robots, midfield: { blue: 8, red: 8 }, autoHumanPlayer: false });
  const ap = createAutoPath(pts, 'me');
  const ev = { pickup: 0, place: 0, launch: 0 }; let maxHeld = 0, minX = 1e9, maxX = -1e9, maxZ = 0;
  for (let k = 0; k < seconds / DT; k++) {
    const inp = ap.step(sim, DT) || {};
    sim.step(DT, { me: inp }, 'auto');
    for (const e of sim.drainEvents()) if (e.robotId === 'me' && e.type in ev) ev[e.type]++;
    const r = sim.robotById('me'); maxHeld = Math.max(maxHeld, r.held.length); minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x); maxZ = Math.max(maxZ, Math.abs(r.z));
  }
  return { sim, ap, ev, r: sim.robotById('me'), maxHeld, minX, maxX, maxZ };
}
const posted = (sim, a) => sim.state.posts.filter((p) => p.alliance === a).reduce((s, p) => s + p.tubes.length, 0);

for (const alliance of ['blue', 'red']) {
  const sg = alliance === 'blue' ? 1 : -1, st = SIDES[alliance].starts[1];
  const tube = SIDES[alliance].stagingRow[2]; // staged tube near the robot's lane
  t(`path start -> staged tube -> back into scoring zone: pickup + place (${alliance}, stacker)`, () => {
    // go out to the tube and come back to the post area next to the start lane
    const path = [{ x: st.x, z: st.z }, { x: (st.x + tube.x) / 2, z: (st.z + tube.z) / 2 }, { x: tube.x, z: tube.z }, { x: tube.x + sg * 1, z: tube.z }, { x: st.x, z: st.z }, { x: sg * 6.9, z: st.z }];
    const mk = pathMarkers(path, alliance);
    assert.ok(mk.intakes.some((m) => Math.hypot(m.x - tube.x, m.z - tube.z) < 0.01), 'intake marker at the tube');
    assert.ok(mk.scores.length >= 1, 'score marker');
    const res = play('stacker', alliance, path);
    assert.ok(res.ev.pickup >= 1, `pickups ${res.ev.pickup}`);
    assert.ok(res.ev.place >= 2, `places ${res.ev.place} (preload + picked tube)`);
    assert.equal(posted(res.sim, alliance), res.ev.place);
    assert.ok(res.ap.done, 'path finished');
  });
}
t('a path with no tubes just drives (no pickup / place)', () => {
  const st = SIDES.blue.starts[2];
  const path = [{ x: st.x, z: st.z }, { x: 4.4, z: st.z }, { x: 4.4, z: 1.7 }];
  const res = play('stacker', 'blue', path, { seconds: 8 });
  assert.equal(res.ev.pickup, 0); assert.equal(res.ev.place, 0);
  assert.ok(Math.hypot(res.r.x - 4.4, res.r.z - 1.7) < 0.5, `ended ${res.r.x.toFixed(2)},${res.r.z.toFixed(2)}`);
  assert.ok(res.ap.done);
});
t('tank tosser follows the path and launches / places in the zone', () => {
  const st = SIDES.blue.starts[1];
  const path = [{ x: st.x, z: st.z }, { x: 3.5, z: st.z }, { x: 6.4, z: st.z }];
  const res = play('tosser', 'blue', path);
  assert.ok(res.ev.place + res.ev.launch >= 1, JSON.stringify(res.ev));
  assert.ok(res.ap.done);
});
t('blocked robot skips ahead (does not stall forever)', () => {
  // a platform box blocks the straight line; the follower must skip waypoints and finish
  const st = SIDES.blue.starts[0], path = [{ x: st.x, z: st.z }, { x: 0.9, z: -3.0 }, { x: 0.9, z: 0.5 }];
  const res = play('stacker', 'blue', path, { seconds: 20 });
  assert.ok(res.ap.skips >= 1, `skips ${res.ap.skips}`);
  assert.ok(res.ap.index > 10, 'advanced along the path');
});
t('mirror + resample + score entries', () => {
  const m = mirrorStrokes([[{ x: 1, z: 2 }, { x: 3, z: -4 }]]); assert.deepEqual(m[0][1], { x: -3, z: 4 });
  const r = resample([{ x: 0, z: 0 }, { x: 1, z: 0 }], 0.25); assert.equal(r.length, 5);
  assert.deepEqual(scoreEntries(resample([{ x: 4, z: -1 }, { x: 7.5, z: -1 }]), 'blue').length, 1);
  assert.deepEqual(scoreEntries(resample([{ x: 6.1, z: -1 }, { x: 5.5, z: -1 }]), 'blue').length, 0, 'start spot is not a score marker');
});
console.log(`${n} autopath tests passed`);
