// Foul tracker: G103 G104 G105 G106 G108 G110 + G111 escalation. See CONTRACT.md.
// main.js MUST call tracker.onEvents(sim.drainEvents()) each frame (launch events drive G106).
import { SIDES, ROBOT, ALLIANCES, opponent, inRect } from './config.js';

const R0 = ROBOT.radius, rad = (r) => (r.bumper ? Math.max(r.bumper.lx, r.bumper.lz) / 2 : r.radius ?? R0), SPACE = 1.83, ESC = 3; // rad = bumper half-size
const touches = (rc, r) => Math.hypot(r.x - Math.max(rc.x0, Math.min(rc.x1, r.x)), r.z - Math.max(rc.z0, Math.min(rc.z1, r.z))) < rad(r);
const crossed = (r) => (r.alliance === 'blue' ? r.x + rad(r) < 0 : r.x - rad(r) > 0); // robots start in their own scoring zone: blue at +x

// Pair rules: offender r, victim o. `ok` = offender-side condition besides contact.
const RULES = [
  { id: 'G103', type: 'tech', ok: (r) => touches(SIDES[opponent(r.alliance)].scoringZone, r), text: 'contact in opponent SCORING ZONE' },
  { id: 'G104', type: 'tech', ok: (r) => touches(SIDES[opponent(r.alliance)].loadingZone, r), text: 'contact in opponent LOADING ZONE' },
  { id: 'G108', type: 'foul', ok: (r, o, ph) => ph === 'endgame' && (o.support > 0 || touches(SIDES[o.alliance].platformZone, o)),
    text: 'contact with opponent at its PLATFORM in ENDGAME', victim: true },
  { id: 'G110', type: 'tech', ok: (r, o, ph) => ph === 'auto' && crossed(r), text: 'AUTO contact past midfield' },
];

export function createFoulTracker() {
  const list = [], fresh = [], forcedLevel4 = new Set(), pairs = new Map(), pending = [], warns = new Map(), inLoad = new Set();
  let lastSim = null;
  const add = (t, rule, type, r, text) => {
    const f = { t, rule, type, against: r.alliance, robotId: r.id, text };
    list.push(f); fresh.push(f);
  };

  function update(sim, match, dt) {
    lastSim = sim;
    const S = sim.state, t = S.time, ph = match.phase;
    for (const e of pending.splice(0)) { // G106
      const r = S.robots.find((x) => x.id === e.robotId);
      if (r && !inRect(SIDES[r.alliance].scoringZone, r.x, r.z, rad(r))) add(t, 'G106', 'tech', r, `${r.number} launched outside its SCORING ZONE`);
    }
    for (const r of S.robots) { // G105
      const inside = ph === 'auto' && ALLIANCES.some((a) => touches(SIDES[a].loadingZone, r));
      if (inside && !inLoad.has(r.id)) {
        inLoad.add(r.id);
        const n = (warns.get(r.id) || 0) + 1;
        warns.set(r.id, n);
        add(t, 'G105', n === 1 ? 'warning' : 'card', r, `${r.number} entered a LOADING ZONE in AUTO (${n === 1 ? 'warning' : 'yellow card'})`);
      } else if (!inside) inLoad.delete(r.id);
    }
    for (const r of S.robots) {
      for (const o of S.robots) {
        if (r.alliance === o.alliance) continue;
        const touch = (r.contacts || []).includes(o.id) || (o.contacts || []).includes(r.id);
        const near = Math.hypot(r.x - o.x, r.z - o.z) < SPACE;
        for (const rule of RULES) {
          const key = `${rule.id}|${r.id}|${o.id}`, s = pairs.get(key), ok = rule.ok(r, o, ph);
          const fire = (esc) => {
            add(t, rule.id, rule.type, r, `${r.number}: ${rule.text}${esc ? ' (G111 escalation)' : ''}`);
            if (rule.victim) forcedLevel4.add(o.id);
          };
          if (!s) { if (ok && touch) { pairs.set(key, { timer: 0 }); fire(false); } }
          else if (!ok || !near) pairs.delete(key);
          else if ((s.timer += dt) >= ESC) { s.timer = 0; fire(true); }
        }
      }
    }
  }

  return {
    list, forcedLevel4,
    update,
    onEvents(events) { for (const e of events || []) if (e.type === 'launch') pending.push(e); },
    drainNew() { return fresh.splice(0); },
  };
}
