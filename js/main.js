// Boot + game loop glue. `?stubs=1` loads test/stubs/* instead of js/* (or `?stubs=sim,ai` for specific modules).
import { SIDES, ALLIANCES, ROBOT_PRESETS, DEFAULT_TEAMS, opponent } from './config.js';
import { createInput } from './input.js';
import { createUI, loadSettings } from './ui.js';

const STEP = 1 / 120;
const stubQ = new URLSearchParams(location.search).get('stubs') || '';
const useStub = (n) => stubQ === '1' || stubQ.split(',').includes(n);
const NAMES = ['sim', 'match', 'scoring', 'fouls', 'ai', 'field3d', 'models', 'renderer'];
const M = {}, missing = [];
await Promise.all(NAMES.map(async (n) => {
  try { M[n] = await import(useStub(n) ? `../test/stubs/${n}.js` : `./${n}.js`); } catch (e) { missing.push(`${n} (${e.message})`); console.error('module', n, e); }
}));

const canvas = document.getElementById('game');
const settings = loadSettings();
const input = createInput();
let renderer = null, game = null, lastCfg = null, paused = false, lastT = performance.now(), hudT = 0, score = null, scoreT = 0;
const camModes = () => (lastCfg?.mode === 'local' ? ['driver', 'top'] : ['driver', 'chase', 'top']);

const ui = createUI({
  settings,
  onStart: (cfg) => startGame(cfg),
  onRestart: () => lastCfg && startGame(lastCfg),
  onResume: () => { paused = false; game?.match?.resume?.(); },
  onQuit: () => quit(),
  onCamera: (d) => cycleCam(d),
  getCamera: () => game?.cam || settings.camera,
  onSettings: () => renderer?.setQuality?.(settings.quality),
});
ui.showHome();
if (missing.length) ui.error(`Missing modules: ${missing.join(', ')}. Add ?stubs=1 to the URL to use test stubs.`);

try {
  if (!missing.includes('renderer') || useStub('renderer')) {
    renderer = M.renderer?.createRenderer(canvas);
    if (!renderer.field) M.field3d?.buildField(renderer.scene); // the real renderer builds its own field
    renderer.setQuality?.(settings.quality);
  }
} catch (e) { console.error(e); ui.error('Could not start the 3D renderer: ' + e.message); renderer = null; }
addEventListener('resize', () => renderer?.resize?.());

function setCam(mode) {
  if (!game) return;
  game.cam = mode; renderer?.setCameraMode?.(mode, game.p[0].alliance, game.p[0].id);
}
function cycleCam(d = 1) {
  const m = camModes(); setCam(m[(m.indexOf(game.cam) + d + m.length) % m.length]);
}

function startGame(cfg) {
  if (!renderer || missing.length) return ui.error('Cannot start: ' + (missing.join(', ') || 'renderer unavailable'));
  lastCfg = cfg; ui.hidePause(); paused = false;
  const A = cfg.alliance, two = cfg.mode === 'local';
  const p2 = two ? (cfg.sameAlliance ? { alliance: A, slot: 1 } : { alliance: opponent(A), slot: 0 }) : null;
  const robots = [], p = [], bots = {};
  for (const al of ALLIANCES) {
    const base = SIDES[al].starts.map((s) => ({ ...s })); let starts = base;
    if (al === A) {
      const d = (s) => Math.hypot(s.x - cfg.start.x, s.z - cfg.start.z);
      const rest = base.map((s, i) => ({ s, i })).sort((a, b) => d(b.s) - d(a.s)).slice(0, 2).sort((a, b) => a.i - b.i).map((o) => o.s);
      starts = [{ ...cfg.start }, ...rest];
    }
    for (let slot = 0; slot < 3; slot++) {
      const isP1 = al === A && slot === 0, isP2 = p2 && p2.alliance === al && p2.slot === slot;
      const preset = isP1 ? cfg.preset : isP2 ? cfg.p2preset : ROBOT_PRESETS[Math.floor(Math.random() * ROBOT_PRESETS.length)];
      const id = `${al}-${slot}`;
      robots.push({ id, alliance: al, slot, number: isP1 ? String(cfg.team) : DEFAULT_TEAMS[al][slot], preset: preset.id, start: starts[slot], preload: true });
      if (isP1) p.unshift({ id, alliance: al, pi: 0, preset });
      else if (isP2) p.push({ id, alliance: al, pi: 1, preset });
      else bots[id] = M.ai.createBot(id, al, cfg.difficulty);
    }
  }
  const sim = M.sim.createSim({ robots, midfield: { blue: cfg.midfield, red: cfg.midfield }, autoHumanPlayer: settings.autoHP });
  const match = M.match.createMatch(sim);
  input.setPlayers(two ? 2 : 1); input.setEnabled(true);
  game = { sim, match, p, bots, state: 'countdown', cdEnd: performance.now() + 3400, acc: 0, phase: 'pre', cam: settings.camera, cfg };
  if (two && game.cam === 'chase') game.cam = 'driver';
  document.body.classList.add('playing');
  ui.show('none', false); ui.showHUD(true, p[0].preset);
  renderer.resize?.(); setCam(game.cam); score = null;
  ui.updateHUD({ match, score, me: robotOf(p[0].id), camera: game.cam });
}

function quit() {
  game = null; paused = false; input.setEnabled(false); document.body.classList.remove('playing');
  ui.showHUD(false); ui.hidePause(); ui.showHome();
}

const robotOf = (id) => game?.sim.state.robots.find((r) => r.id === id);
const EDGES = ['scoreLower', 'scoreUpper', 'scoreFloor', 'launch'];
const PHASE_MSG = { auto: 'AUTO — go!', teleop: 'TELEOP', endgame: 'ENDGAME — climb!', post: 'Match over' };

function foulToast(f) {
  const t = f.type === 'tech' ? 'TECH FOUL' : f.type === 'foul' ? 'FOUL' : 'WARNING';
  ui.toast(`${t} on ${String(f.against).toUpperCase()}${f.text ? ' — ' + f.text : ''}`, { tag: f.rule, foul: true, alliance: f.against });
}
function eventToast(e) {
  const r = e.robotId && robotOf(e.robotId), human = game.p.some((q) => q.id === e.robotId);
  if (!human && e.type !== 'climb') return;
  const msg = { pickup: 'Tube picked up', place: 'Tube placed', launch: 'Tube launched', land: 'Tube landed', feed: 'Human player feed', climb: 'Climb', invalid: 'Cannot do that' }[e.type];
  if (e.type === 'contact' || !msg) return;
  if (!human && e.type === 'climb') return;
  ui.toast(e.text || msg, { alliance: r?.alliance, tag: e.type === 'invalid' ? '!' : '' });
}

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  if (!game) return;
  const { sim, match } = game;
  const g = input.takeGlobal();
  if (game.state === 'run' && g.camera) cycleCam(1);
  if (game.state === 'run' && g.pause && !paused) pause();

  if (game.state === 'countdown') {
    const left = game.cdEnd - t, n = Math.ceil((left - 400) / 1000);
    ui.countdown(n > 0 ? n : 'GO');
    if (left <= 0) { match.start?.(); game.state = 'run'; setTimeout(() => ui.countdown(null), 400); }
  } else if (game.state === 'run' && !paused) {
    const frameIn = {};
    for (const q of game.p) {
      const r = robotOf(q.id);
      const i = input.poll(q.alliance, q.pi, { cameraMode: game.cam, heading: r?.heading, drive: q.preset.drive, fieldRelative: settings.fieldRelative });
      if (i.requestTube && match.phase !== 'auto') { if (sim.requestHumanTube?.(q.alliance) === false) ui.toast('Human player not available', { alliance: q.alliance }); }
      frameIn[q.id] = i;
    }
    game.acc += dt;
    let first = true;
    while (game.acc >= STEP) {
      const inputs = {}, ph = match.phase, live = ph === 'auto' || ph === 'teleop' || ph === 'endgame';
      if (live) {
        for (const q of game.p) { const i = { ...frameIn[q.id] }; if (!first) EDGES.forEach((k) => (i[k] = false)); inputs[q.id] = i; }
        for (const id in game.bots) inputs[id] = game.bots[id].think(sim, match, STEP) || {};
      }
      first = false;
      sim.step(STEP, inputs, ph);
      match.update(STEP);
      game.acc -= STEP;
    }
    const ev = sim.drainEvents?.() || [];
    match.fouls?.onEvents?.(ev);
    ev.forEach(eventToast);
    match.fouls?.drainNew?.().forEach(foulToast);
    if (match.phase !== game.phase) { game.phase = match.phase; if (PHASE_MSG[match.phase]) ui.toast(PHASE_MSG[match.phase], { tag: '●' }); }
    if (match.phase === 'done' && game.state === 'run') {
      game.state = 'over'; input.clear();
      ui.updateHUD({ match, score: match.final, me: robotOf(game.p[0].id), camera: game.cam });
      ui.showResults(match.final || score || {}, match.fouls?.list || []);
    }
  }
  renderer.render(sim);
  if (t - hudT > 100) {
    hudT = t;
    if (t - scoreT > 250 && game.state !== 'over') { scoreT = t; try { score = M.scoring.computeScore(sim, match); } catch (e) { score = score || null; } }
    if (game.state !== 'over') ui.updateHUD({ match, score, me: robotOf(game.p[0].id), camera: game.cam });
  }
}

function pause() { paused = true; game.match.pause?.(); input.clear(); ui.showPause(); }
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && game?.state === 'run' && !paused) { e.preventDefault(); pause(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && game?.state === 'run' && !paused) pause(); });
requestAnimationFrame(frame);
window.__tt = { get game() { return game; }, M };
