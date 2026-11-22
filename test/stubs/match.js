// STUB match (20/105 timing). Testing only; ?fast=1 not needed — use __tt.game.match.elapsed = 120 in console.
import { TIMING } from '../../js/config.js';
import { createFoulTracker } from './fouls.js';
export function createMatch(sim) {
  const m = { phase: 'pre', elapsed: 0, running: false, fouls: createFoulTracker(), final: null,
    get remaining() { return Math.max(0, TIMING.total - this.elapsed); },
    get periodRemaining() { const e = this.elapsed, T = TIMING; return this.phase === 'auto' || this.phase === 'pre' ? Math.max(0, T.auto - e) : this.phase === 'transition' ? 0 : this.phase === 'teleop' || this.phase === 'endgame' ? this.remaining : 0; },
    get simPhase() { return this.phase === 'transition' ? 'pre' : this.phase; },
    start() { this.running = true; this.phase = 'auto'; }, pause() { this.running = false; }, resume() { this.running = true; },
    update(dt) {
      if (!this.running) return; this.elapsed += dt; const e = this.elapsed, T = TIMING;
      this.phase = e < T.auto ? 'auto' : e < T.auto + T.transition ? 'transition' : e < T.total - T.endgame ? 'teleop' : e < T.total ? 'endgame' : e < T.total + T.assessDelay ? 'post' : 'done';
      if (this.phase === 'done' && !this.final) { this.final = { blue: { auto: { floor: 1, lower: 2, upper: 0 }, teleop: { floor: 3, lower: 4, upper: 5 }, platform: { points: 10 }, fouls: { foul: 1, tech: 0, points: 4 }, fullPosts: 3, total: 60, rp: { win: 3, posts8: 0, posts12: 0, platform16: 0, total: 3 } },
        red: { auto: { floor: 0, lower: 0, upper: 0 }, teleop: { floor: 2, lower: 1, upper: 1 }, platform: { points: 4 }, fouls: { foul: 0, tech: 0, points: 0 }, fullPosts: 1, total: 20, rp: { win: 0, posts8: 0, posts12: 0, platform16: 0, total: 0 } } }; }
      this.fouls.update?.(sim, this, dt);
    } };
  return m;
}
