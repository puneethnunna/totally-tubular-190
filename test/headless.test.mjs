import { createSim } from '../js/sim.js';
import { createMatch } from '../js/match.js';
import { createBot } from '../js/ai.js';
import { ROBOT_PRESETS, DEFAULT_TEAMS } from '../js/config.js';
const robots = [];
for (const a of ['blue', 'red']) for (let s = 0; s < 3; s++)
  robots.push({ id: `${a}-${s}`, alliance: a, slot: s, number: DEFAULT_TEAMS[a][s], preset: ROBOT_PRESETS[(s + (a === 'red' ? 1 : 0)) % 4].id });
const sim = createSim({ robots, midfield: { blue: 8, red: 8 }, autoHumanPlayer: true });
const match = createMatch(sim);
const bots = robots.map(r => createBot(r.id, r.alliance, 'hard'));
match.start();
const dt = 1 / 120; let n = 0, frame = 0;
while (match.phase !== 'done' && n++ < 200 * 120) {
  const inputs = {};
  if (n % 2 === 1) { frame = {}; robots.forEach((r, i) => frame[r.id] = bots[i].think(sim, match, dt * 2)); }
  for (const id in frame) { inputs[id] = { ...frame[id] }; if (n % 2 === 0) for (const k of ['scoreLower','scoreUpper','scoreFloor','launch']) inputs[id][k] = false; }
  sim.step(dt, inputs, match.phase);
  match.fouls.onEvents(sim.drainEvents());
  match.update(dt);
  if (n % (120 * 25) === 0) console.log(match.phase, Math.round(match.remaining), 'B', match.score.blue.total, 'R', match.score.red.total, sim.state.robots.map(r => `${r.id}:${r.held.length}/${r.support}/${bots[robots.findIndex(x=>x.id===r.id)].state?.mode ?? ''}`).join(' '));
}
const f = match.final;
for (const a of ['blue','red']) console.log(a, JSON.stringify({ auto: f[a].auto, teleop: f[a].teleop, plat: f[a].platform, fouls: f[a].fouls, total: f[a].total, full: f[a].fullPosts, rp: f[a].rp }));
console.log('winner', f.winner, 'fouls', match.fouls.list.length, match.fouls.list.slice(0,6).map(x => x.rule + ':' + x.robotId).join(' '));
