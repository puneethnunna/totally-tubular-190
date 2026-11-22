// Match clock + phase machine. See CONTRACT.md / CONTRACT2.md.
// Timeline: AUTO 20 s -> TRANSITION 2 s (robots disabled) -> TELEOP 105 s (last 30 s = ENDGAME) -> POST 3 s -> done.
// match.remaining = time left in the whole match (127 -> 0); match.periodRemaining = time left in the current period
// (what an FRC field display shows). match.simPhase = phase to hand to sim.step (transition is simulated as 'pre' = disabled).
import { TIMING } from './config.js';
import { computeScore } from './scoring.js';
import { createFoulTracker } from './fouls.js';

export function createMatch(sim) {
  const total = TIMING.total, autoEnd = TIMING.auto, teleopStart = TIMING.auto + TIMING.transition, endAt = total - TIMING.endgame;
  const periodLeft = (ph, e) => ph === 'pre' ? TIMING.auto : ph === 'auto' ? Math.max(0, autoEnd - e) : ph === 'transition' ? 0 : ph === 'teleop' || ph === 'endgame' ? Math.max(0, total - e) : 0;
  const m = {
    sim, phase: 'pre', elapsed: 0, remaining: total, periodRemaining: TIMING.auto, paused: false,
    autoSnapshot: null, final: null, fouls: createFoulTracker(), score: null,
    get simPhase() { return m.phase === 'transition' ? 'pre' : m.phase; },
    start() { if (m.phase === 'pre') m.phase = 'auto'; },
    pause() { m.paused = true; },
    resume() { m.paused = false; },
    update(dt) {
      if (m.phase !== 'pre' && m.phase !== 'done' && !m.paused) {
        m.elapsed += dt;
        m.remaining = Math.max(0, total - m.elapsed);
        const e = m.elapsed;
        const next = e < autoEnd ? 'auto' : e < teleopStart ? 'transition' : e < endAt ? 'teleop' : e < total ? 'endgame' : e < total + TIMING.assessDelay ? 'post' : 'done';
        if (m.phase === 'auto' && next !== 'auto') m.autoSnapshot = computeScore(sim, m);
        m.phase = next;
        m.periodRemaining = periodLeft(next, e);
        if (next === 'auto' || next === 'teleop' || next === 'endgame') m.fouls.update(sim, m, dt);
      }
      m.score = computeScore(sim, m);
      if (m.phase === 'done' && !m.final) {
        m.final = { blue: m.score.blue, red: m.score.red, winner: m.score.winner, fouls: m.fouls.list.slice(), autoSnapshot: m.autoSnapshot };
      }
    },
  };
  m.score = computeScore(sim, m);
  return m;
}
