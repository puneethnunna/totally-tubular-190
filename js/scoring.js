// Pure scoring: computeScore(sim, match) -> per-alliance breakdown. See CONTRACT.md.
import { POINTS, RP, SIDES, TUBE, ALLIANCES, opponent, inRect } from './config.js';

const lv = () => ({ floor: 0, lower: 0, upper: 0 });
const pts = (c, k) => c.floor * POINTS.floor[k] + c.lower * POINTS.lower[k] + c.upper * POINTS.upper[k];

// Level (0..4) each robot of `alliance` is credited with. Returns { [robotId]: level }.
function platformLevels(S, alliance, forced) {
  const mine = S.robots.filter((r) => r.alliance === alliance);
  const zone = SIDES[alliance].platformZone;
  const level = {};
  for (const r of mine) {
    level[r.id] = forced && forced.has(r.id) ? 4 : (r.support >= 1 && inRect(zone, r.x, r.z) ? r.support : 0);
  }
  // Mutually contacting qualifying robots (not forced) are assessed at the lowest level of their group.
  const ok = mine.filter((r) => level[r.id] > 0 && !(forced && forced.has(r.id)));
  const seen = new Set();
  for (const r of ok) {
    if (seen.has(r.id)) continue;
    const group = [], stack = [r];
    seen.add(r.id);
    while (stack.length) {
      const a = stack.pop();
      group.push(a);
      for (const b of ok) {
        if (seen.has(b.id)) continue;
        if ((a.contacts || []).includes(b.id) || (b.contacts || []).includes(a.id)) { seen.add(b.id); stack.push(b); }
      }
    }
    const low = Math.min(...group.map((g) => level[g.id]));
    for (const g of group) level[g.id] = low;
  }
  return level;
}

export function computeScore(sim, match) {
  const S = sim.state;
  const fouls = match && match.fouls;
  const done = !!match && match.phase === 'done';
  const byId = new Map(S.tubes.map((t) => [t.id, t]));
  const res = {};

  for (const a of ALLIANCES) {
    const tot = lv(), auto = lv();
    let fullPosts = 0;
    for (const t of S.tubes) {
      if (t.state === 'floor' && inRect(SIDES[a].floorArea, t.x, t.z, TUBE.outerRadius)) {
        tot.floor++;
        if (t.placedInAuto) auto.floor++;
      }
    }
    for (const p of S.posts) {
      if (p.alliance !== a) continue;
      const ts = (p.tubes || []).map((id, i) => ({ stackIndex: i, ...byId.get(id) }))
        .sort((x, y) => x.stackIndex - y.stackIndex).slice(0, POINTS.maxScoringPerPost);
      tot[p.tier] += ts.length;
      auto[p.tier] += ts.filter((t) => t.placedInAuto).length;
      if (ts.length >= POINTS.maxScoringPerPost) fullPosts++;
    }
    const teleop = { floor: tot.floor - auto.floor, lower: tot.lower - auto.lower, upper: tot.upper - auto.upper };
    const levels = platformLevels(S, a, fouls && fouls.forcedLevel4);
    const mine = S.robots.filter((r) => r.alliance === a); // levels[slot]; empty slots (solo / 1v1 / 2v2) score 0
    const slots = Array.from({ length: Math.max(3, ...mine.map((r) => r.slot + 1)) }, () => 0);
    for (const r of mine) slots[r.slot] = levels[r.id];
    const platform = { levels: slots, points: slots.reduce((s, l) => s + POINTS.platform[l], 0), projected: !done };
    const f = { foul: 0, tech: 0, points: 0 };
    for (const e of (fouls && fouls.list) || []) {
      if (e.against !== opponent(a)) continue;
      if (e.type === 'foul') { f.foul++; f.points += POINTS.foul; }
      else if (e.type === 'tech') { f.tech++; f.points += POINTS.techFoul; }
    }
    const tubePoints = pts(auto, 'auto') + pts(teleop, 'teleop');
    res[a] = { auto, teleop, platform, fouls: f, tubePoints, total: tubePoints + platform.points + f.points, fullPosts,
      rp: { win: 0, posts8: fullPosts >= 8 ? RP.posts8 : 0, posts12: fullPosts >= 12 ? RP.posts12 : 0,
        platform16: platform.points >= 16 ? RP.platform16 : 0, total: 0 } };
  }
  let winner = null;
  if (done) {
    const d = res.blue.total - res.red.total;
    winner = d > 0 ? 'blue' : d < 0 ? 'red' : 'tie';
    for (const a of ALLIANCES) res[a].rp.win = winner === 'tie' ? RP.tie : winner === a ? RP.win : 0;
  }
  for (const a of ALLIANCES) { const r = res[a].rp; r.total = r.win + r.posts8 + r.posts12 + r.platform16; }
  res.winner = winner;
  return res;
}
