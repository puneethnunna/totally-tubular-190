// STUB sim: moves robots, spawns tubes, emits events. Testing only.
import { ROBOT_PRESETS, SIDES, SIDES as S } from '../../js/config.js';
export function createSim(o) {
  const events = []; let n = 0;
  const robots = o.robots.map((r) => ({ id: r.id, alliance: r.alliance, slot: r.slot, number: r.number, preset: ROBOT_PRESETS.find((p) => p.id === r.preset),
    x: r.start?.x ?? S[r.alliance].starts[r.slot].x, z: r.start?.z ?? S[r.alliance].starts[r.slot].z, y: 0, heading: r.start?.heading ?? 0, vx: 0, vz: 0, omega: 0, held: r.preload ? [`p-${r.id}`] : [], action: null, arm: 0, armTier: 'stow', support: 0, intakeOn: false, contacts: [] }));
  const tubes = [];
  for (const a of ['blue', 'red']) S[a].stagingRow.slice(0, o.midfield?.[a] ?? 0).forEach((p) => tubes.push({ id: `t${n++}`, origin: a, x: p.x, y: 0.07, z: p.z, vx: 0, vy: 0, vz: 0, state: 'floor', holder: null, post: null, stackIndex: 0 }));
  const state = { time: 0, robots, tubes, posts: [...S.blue.posts, ...S.red.posts].map((p) => ({ ...p, tubes: [] })), reserve: { blue: 97, red: 97 } };
  return { state, drainEvents: () => events.splice(0), requestHumanTube: (a) => { events.push({ type: 'feed', text: `${a} feed` }); return true; },
    step(dt, inp) {
      state.time += dt;
      for (const r of robots) {
        const i = inp[r.id] || {}, sp = r.preset.maxSpeed;
        const mx = i.moveX ?? Math.cos(r.heading) * (i.throttle || 0), mz = i.moveZ ?? Math.sin(r.heading) * (i.throttle || 0);
        r.vx = mx * sp; r.vz = mz * sp; r.x += r.vx * dt; r.z += r.vz * dt; r.heading += ((i.rotate ?? i.turn) || 0) * r.preset.turnRate * dt;
        r.x = Math.max(-8, Math.min(8, r.x)); r.z = Math.max(-3.5, Math.min(3.5, r.z)); r.intakeOn = !!i.intake;
        if (i.scoreLower && r.held.length) { r.held.pop(); r.action = { type: 'place', t: 0, duration: 0.7 }; events.push({ type: 'place', robotId: r.id }); }
        if (i.intake && r.held.length < 2 && Math.random() < 0.01) { r.held.push('x'); events.push({ type: 'pickup', robotId: r.id }); }
        if (r.action) { r.action.t += dt; if (r.action.t > r.action.duration) r.action = null; }
      }
    } };
}
