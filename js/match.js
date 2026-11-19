// Match clock + phase machine. See CONTRACT.md.
import { TIMING } from './config.js';
import { computeScore } from './scoring.js';
import { createFoulTracker } from './fouls.js';

export function createMatch(sim) {
  const total = TIMING.total, endAt = total - TIMING.endgame;
  const m = {
    sim, phase: 'pre', elapsed: 0, remaining: total, paused: false,
    autoSnapshot: null, final: null, fouls: createFoulTracker(), score: null,
    start() { if (m.phase === 'pre') m.phase = 'auto'; },
    pause() { m.paused = true; },
    resume() { m.paused = false; },
    update(dt) {
      if (m.phase !== 'pre' && m.phase !== 'done' && !m.paused) {
        m.elapsed += dt;
        m.remaining = Math.max(0, total - m.elapsed);
        const e = m.elapsed;
        const next = e < TIMING.auto ? 'auto' : e < endAt ? 'teleop' : e < total ? 'endgame' : e < total + TIMING.assessDelay ? 'post' : 'done';
        if (m.phase === 'auto' && next !== 'auto') m.autoSnapshot = computeScore(sim, m);
        m.phase = next;
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
