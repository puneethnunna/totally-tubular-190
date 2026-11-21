// Boot + game loop glue. `?stubs=1` loads test/stubs/* instead of js/* (or `?stubs=sim,ai` for specific modules).
import { SIDES, opponent } from './config.js';
import { createInput } from './input.js';
import { createUI, loadSettings, saveSettings, ensureMeshes } from './ui.js';

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
input.setKeys(settings.keys);
let renderer = null, game = null, lastCfg = null, paused = false, lastT = performance.now(), hudT = 0, score = null, scoreT = 0;
const CAMS = ['driver', 'third', 'first'];

const ui = createUI({
  settings,
  onStart: (cfg) => startGame(cfg),
  onRestart: () => lastCfg && startGame(lastCfg),
  onResume: () => resume(),
  onQuit: (to) => quit(to),
  onSettings: () => { input.setKeys(settings.keys); applyRenderOpts(); document.body.classList.toggle('nogui', !!settings.hideGui); },
});
await ui.refreshRobots();
ui.showPick();
if (missing.length) ui.error(`Missing modules: ${missing.join(', ')}. Add ?stubs=1 to the URL to use test stubs.`);

try {
  if (!missing.includes('renderer') || useStub('renderer')) {
    renderer = M.renderer?.createRenderer(canvas);
    if (!renderer.field) M.field3d?.buildField(renderer.scene); // the real renderer builds its own field
    applyRenderOpts();
  }
} catch (e) { console.error(e); ui.error('Could not start the 3D renderer: ' + e.message); renderer = null; }
addEventListener('resize', () => renderer?.resize?.());
function applyRenderOpts() {
  renderer?.setQuality?.(settings.quality);
  renderer?.setOptions?.({ cameraFollow: settings.cameraFollow, background: settings.background });
}

function setCam(mode) {
  if (!game) return;
  game.cam = mode; settings.camera = mode; saveSettings(settings);
  const p = game.p[0], legacy = !renderer?.setOptions; // pre-round-2 renderers only know driver/chase/top
  renderer?.setCameraMode?.(legacy && mode !== 'driver' ? 'chase' : mode, p.alliance, p.id, { slot: game.slot });
}
const cycleCam = (d = 1) => setCam(CAMS[(CAMS.indexOf(game.cam) + d + CAMS.length) % CAMS.length]);

async function startGame(cfg) {
  if (!renderer || missing.length) return ui.error('Cannot start: ' + (missing.join(', ') || 'renderer unavailable'));
  lastCfg = cfg; ui.hidePause(); paused = false; game = null;
  const A = cfg.alliance, O = opponent(A), robots = [], p = [], bots = {};
  const defs = [cfg.player, ...cfg.allies, ...cfg.opps];
  await ensureMeshes(defs);
  const stubSim = useStub('sim');
  const add = (al, slot, def, start, human) => {
    const id = `${al}-${slot}`;
    robots.push({ id, alliance: al, slot, number: def.number, preset: stubSim ? def.preset.id : def.preset, start, preload: true });
    if (human !== undefined) p.push({ id, alliance: al, pi: human, def });
    else bots[id] = M.ai.createBot(id, al, cfg.difficulty);
  };
  add(A, 0, cfg.player, cfg.start, 0);
  cfg.allies.forEach((d, i) => add(A, i + 1, d, cfg.starts.ally[i]));
  cfg.opps.forEach((d, i) => add(O, i, d, cfg.starts.opp[i], cfg.local && i === 0 ? 1 : undefined));
  const mid = settings.midfield ?? 8;
  let sim;
  try { sim = M.sim.createSim({ robots, midfield: { blue: mid, red: mid }, autoHumanPlayer: settings.autoHP }); }
  catch (e) {
    console.warn('createSim with preset objects failed, retrying with preset ids', e);
    sim = M.sim.createSim({ robots: robots.map((r) => ({ ...r, preset: r.preset.id || r.preset })), midfield: { blue: mid, red: mid }, autoHumanPlayer: settings.autoHP });
  }
  const match = M.match.createMatch(sim);
  input.setPlayers(p.length); input.setEnabled(true);
  game = { sim, match, p, bots, state: 'countdown', cdEnd: performance.now() + 3400, acc: 0, phase: 'pre', cam: settings.camera, slot: 0, tier: 'auto', cap: settings.speeds[2] / 100, cfg };
  document.body.classList.add('playing');
  ui.show('none', false); ui.showHUD(true, p[0].def);
  renderer.resize?.(); setCam(game.cam); score = null;
  ui.updateHUD(hud());
}

function quit(to = 'title') {
  game = null; paused = false; input.setEnabled(false); document.body.classList.remove('playing');
  ui.showHUD(false); ui.hidePause(); to === 'setup' ? ui.showSetup() : ui.showHome();
}

const robotOf = (id) => game?.sim.state.robots.find((r) => r.id === id);
const hud = () => ({ match: game.match, score, me: robotOf(game.p[0].id), camera: game.cam, tier: game.tier, cap: game.cap });
const EDGES = ['scoreLower', 'scoreUpper', 'scoreFloor', 'launch'];
const PHASE_MSG = { auto: 'AUTO — go!', teleop: 'TELEOP', endgame: 'ENDGAME — climb!', post: 'Match over' };
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Is the robot lined up with one of its upper posts (facing the wall, laterally within reach)?
function upperReady(r) {
  if (!r || !r.held?.length) return false;
  return SIDES[r.alliance].posts.some((p) => p.tier === 'upper' && Math.abs(r.z - p.z) < 0.4 && Math.abs(p.tipX - r.x) < 1.4 &&
    Math.abs(wrapA(r.heading - (p.dirX > 0 ? Math.PI : 0))) < 0.7);
}

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

function pause() { if (!game || game.state !== 'run' || paused) return; paused = true; game.match.pause?.(); input.setEnabled(false); const q = game.p[0]; ui.showPause({ alliance: q.alliance, label: `${q.def.number} ${q.def.name}` }); }
function resume() { paused = false; game?.match?.resume?.(); input.setEnabled(true); }

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  if (!game) return;
  const { sim, match } = game;
  const g = input.takeGlobal();
  if (game.state === 'run' && !paused) {
    if (g.camera) cycleCam(1);
    if (g.slot) { game.slot = (game.slot + 1) % 3; setCam(game.cam); ui.toast(`Driver station ${game.slot + 1}`, { tag: 'V' }); }
    if (g.speed) { game.cap = settings.speeds[g.speed - 1] / 100; ui.toast(`Speed cap ${settings.speeds[g.speed - 1]}%`, { tag: g.speed }); }
    if (g.restart && lastCfg) return void startGame(lastCfg);
    if (g.pause) pause();
  }

  if (game.state === 'countdown') {
    const left = game.cdEnd - t, n = Math.ceil((left - 400) / 1000);
    ui.countdown(n > 0 ? n : 'GO');
    if (left <= 0) { match.start?.(); game.state = 'run'; setTimeout(() => ui.countdown(null), 400); }
  } else if (game.state === 'run' && !paused) {
    const frameIn = {};
    for (const q of game.p) {
      const r = robotOf(q.id), pr = q.def.preset;
      const i = input.poll(q.alliance, q.pi, { cameraMode: game.cam, heading: r?.heading, drive: pr.drive, fieldRelative: settings.fieldRelative, cap: game.cap,
        tier: { mode: game.tier, canUpper: !!pr.canUpper, canLower: pr.canLower !== false, upperReady: upperReady(r) } });
      if (i.tierToggle && q.pi === 0) { game.tier = { auto: 'upper', upper: 'lower', lower: 'auto' }[game.tier]; ui.toast(`Score tier: ${game.tier.toUpperCase()}`, { tag: 'Z' }); }
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
      ui.updateHUD(hud());
      ui.showResults(match.final || score || {}, match.fouls?.list || []);
    }
  }
  renderer.render(sim);
  if (t - hudT > 100) {
    hudT = t;
    if (t - scoreT > 250 && game.state !== 'over') { scoreT = t; try { score = M.scoring.computeScore(sim, match); } catch (e) { score = score || null; } }
    if (game.state !== 'over') ui.updateHUD(hud());
  }
}

document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
requestAnimationFrame(frame);
window.__tt = { get game() { return game; }, M, ui, input, startGame, settings };
