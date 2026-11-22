// Menus, setup flow, HUD, pause, results. Keyboard "layers": ↑↓ move, ←→ adjust, Enter select, Esc back.
// Optional modules (robots / preview3d / importDialog) are imported dynamically with graceful fallbacks.
import { SIDES, ROBOT_PRESETS, ROBOT, FIELD, POINTS, TIMING, RP, TUBE, opponent } from './config.js';
import { flattenStrokes, mirrorStrokes, pathMarkers, stagedSpots, clampToField } from './autopath.js';
import { ACTIONS, GROUPS, MAX_CHIPS, DEFAULT_PADCFG, keyLabel, padLabel, effectiveKeys, effectivePad, rebindKey, rebindPad, migrateControls, detectBinding, tierLabel } from './input.js';

const opt = (p) => import(p).catch((e) => { console.warn('optional module', p, e.message); return null; });
const [RBM, PV, IMP] = await Promise.all([opt('./robots.js'), opt('./preview3d.js'), opt('./importDialog.js')]);

// ---------- settings ----------
const KEY = 'tt-settings';
export const DEFAULTS = { quality: 'high', background: true, camera: 'driver', cameraFollow: 'smooth', hideGui: false, fieldRelative: true, autoHP: true, autoAlign: true,
  driverName: '', volume: 70, muted: false, speeds: [40, 70, 100], midfield: 8, difficulty: 'normal', mode: '1v1', alliance: 'blue', robotId: '', keys: {}, pad: {}, padCfg: { ...DEFAULT_PADCFG }, ctlVersion: 0, showStats: false, autoPaths: {} };
export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  s = migrateControls({ ...DEFAULTS, ...s });
  // old builds used fake 5-digit ids (builtin-11046 = team 1046 + 10000); map to the real team ids
  { const m = /^builtin-(\d{5})$/.exec(s.robotId || ''); if (m) s.robotId = 'builtin-' + (+m[1] - 10000); }
  if (s.camera === 'chase') s.camera = 'third';
  if (!['driver', 'third', 'first'].includes(s.camera)) s.camera = 'driver';
  if (!Array.isArray(s.speeds) || s.speeds.length !== 3) s.speeds = [...DEFAULTS.speeds];
  return s;
}
export const saveSettings = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

// ---------- robots (with fallback to ROBOT_PRESETS) ----------
const NUMS = ['1678', '254', '971', '2910', '118', '1323'];
const FALLBACK = ROBOT_PRESETS.map((p, i) => ({ id: 'builtin-' + p.id, number: NUMS[i % NUMS.length], name: p.name, team: p.name, place: '', source: 'builtin', preset: p, stats: null }));
const roster = () => (RBM?.ROSTER?.length ? RBM.ROSTER : FALLBACK);
let ALL = roster().slice();
export async function refreshRobots() {
  try { ALL = RBM?.listRobots ? await RBM.listRobots() : roster().slice(); } catch (e) { console.warn(e); ALL = roster().slice(); }
  return ALL;
}
const findRobot = (id) => ALL.find((r) => r.id === id) || roster().find((r) => r.id === id) || roster()[0];
export async function ensureMeshes(defs) { try { await RBM?.ensureMeshes?.(defs); } catch (e) { console.warn('ensureMeshes', e); } }

function specRows(def) {
  const p = def.preset || {}, s = def.stats || {};
  const sp = s.speedFtS ?? p.maxSpeed * 3.281, ac = s.accelFtS2 ?? p.accel * 5.25, push = s.pushLb ?? (p.mass || 61) * 2.205, ir = s.intakeRate ?? 1 / (p.intakeTime || 0.25);
  return [['Speed', `${(+sp).toFixed(1)} ft/s`, sp / 18], ['Acceleration', `${Math.round(ac)} ft/s²`, ac / 45], ['Push', `${Math.round(push)} lb`, push / 200],
    ['Intake rate', `${(+ir).toFixed(1)} /s`, ir / 8], ['Place time', `${p.placeTime}s`, 1 - (p.placeTime - 0.3) / 0.9], ['Climb', `Level ${p.maxClimb}`, p.maxClimb / 4],
    ['Reach', p.canUpper ? 'Upper + lower' : p.canLaunch ? 'Launcher' : 'Lower', p.canUpper ? 1 : p.canLaunch ? 0.7 : 0.5], ['Capacity', s.capacity || '2 tubes', 1]];
}
const tagsOf = (def) => def.stats?.tags || [def.preset.drive, def.preset.canUpper ? 'upper posts' : 'lower posts', def.preset.canLaunch ? 'launches' : '', `climbs L${def.preset.maxClimb}`].filter(Boolean);
const specHTML = (def) => `<div class="sgrid">${specRows(def).map(([l, v, f]) => { const n = Math.max(0, Math.min(10, Math.round(f * 10)));
  return `<div class="sp1"><div class="spl"><span>${l}</span>${v}</div><div class="sbar">${Array.from({ length: 10 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div></div>`; }).join('')}</div>
  <div class="tags">${tagsOf(def).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const hint = (...p) => `<div class="foot">${p.map(([k, t]) => `<span><span class="kbd">${k}</span>${t}</span>`).join('')}</div>`;
const pad2 = (n) => String(n).padStart(2, '0');
const topbar = (crumb) => `<div class="top"><div class="wm"><i class="tico"></i>TOTALLY TUBULAR</div>${crumb ? `<span class="crumb">${crumb}</span>` : ''}<div class="team"><img src="assets/frc190-logo.jpg" alt="FRC Team 190 logo"><span><b>FRC 190</b>Gompei and the H.E.R.D.</span></div></div>`;
const CRUMB = '2026 Totally Tubular';
const CAMNAME = { driver: 'Driver station', third: 'Third person', first: 'First person' };

// Legal start for a robot's centre: bumpers inside own SCORING ZONE, outside own LEVEL 1 area (G109).
export function clampStart(alliance, x, z) {
  const S = SIDES[alliance], R = ROBOT.outer / 2, zn = S.scoringZone, f = S.floorArea;
  x = Math.max(zn.x0 + R, Math.min(zn.x1 - R, x)); z = Math.max(zn.z0 + R, Math.min(zn.z1 - R, z));
  if (x > f.x0 - R && x < f.x1 + R && z > f.z0 - R && z < f.z1 + R) x = f.x0 > zn.x0 ? f.x0 - R : f.x1 + R;
  return { x, z };
}

// Robot preview host wrapper: real preview3d if available, else a number/name placeholder.
function makePreview(host) {
  let pv = null;
  try { pv = PV?.createRobotPreview?.(host) || null; } catch (e) { console.warn('preview3d', e); }
  return {
    show(def, alliance) {
      if (pv) { try { pv.show(def, alliance); return; } catch (e) { console.warn(e); pv = null; } }
      host.innerHTML = `<div class="pvph"><b>${esc(def.number)}</b><span>${esc(def.name)}</span></div>`;
    },
    dispose() { try { pv?.dispose?.(); } catch {} host.textContent = ''; },
  };
}

export function createUI(app) {
  const $ui = document.getElementById('ui'), $ov = document.getElementById('overlay'), $hud = document.getElementById('hud');
  const $toasts = document.getElementById('toasts'), $cd = document.getElementById('countdown');
  const st = app.settings;
  const save = () => { saveSettings(st); hintDev = null; app.onSettings?.(); };

  // ---------- layer / focus engine ----------
  const stack = [];
  const top = () => stack[stack.length - 1];
  let capturing = null;
  function focus(L, i) {
    if (!L.items.length) return;
    L.i = (i + L.items.length) % L.items.length;
    L.items.forEach((it, k) => it.el.classList.toggle('focus', k === L.i));
    L.items[L.i].el.scrollIntoView?.({ block: 'nearest' });
    L.items[L.i].onFocus?.();
  }
  const SELF = '.sg,input,.lc,.tabs button,.kc,.tg b,.del,.car';
  function reg(items) {
    for (const it of items) {
      if (it.bound) continue; it.bound = true;
      it.el.addEventListener('click', (e) => {
        const L = stack.find((l) => l.items.includes(it)); if (!L) return;
        focus(L, L.items.indexOf(it));
        if (it.onClick) it.onClick(e); else if (!e.target.closest(SELF)) it.activate?.();
      });
      it.el.addEventListener('mouseenter', () => { const L = top(); if (L && !L.noHover && L.items.includes(it)) focus(L, L.items.indexOf(it)); });
    }
  }
  const pushLayer = (L) => { reg(L.items); L.i = L.i ?? 0; stack.push(L); focus(L, L.i); return L; };
  const popLayer = () => { stack.pop(); const t = top(); if (t) focus(t, t.i); };
  const setItems = (L, items, i = 0) => { L.items = items; reg(items); focus(L, i); };
  addEventListener('keydown', (e) => {
    const L = top(); if (!L || L.passthrough || capturing) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); return; }
    if (L.onKey?.(e)) return e.preventDefault();
    const k = e.key, it = L.items[L.i];
    if (k === 'ArrowUp') focus(L, L.i - 1);
    else if (k === 'ArrowDown') focus(L, L.i + 1);
    else if (k === 'ArrowLeft') L.horizontal ? focus(L, L.i - 1) : it.adjust?.(-1);
    else if (k === 'ArrowRight') L.horizontal ? focus(L, L.i + 1) : it.adjust?.(1);
    else if (k === 'Enter' || k === ' ') it.activate?.();
    else if (k === 'Escape' || k === 'Backspace') L.back?.();
    else return;
    e.preventDefault();
  });
  addEventListener('keydown', (e) => {
    if (!capturing) return;
    if (capturing.pad && e.key !== 'Escape' && e.key !== 'Backspace') return;
    e.preventDefault(); e.stopImmediatePropagation();
    capturing.done(e.key === 'Escape' ? null : e.key === 'Backspace' ? '' : e.code);
  }, true);

  // ---------- builders ----------
  const seg = (label, opts, get, set) => {
    const el = h(`<div class="card row"><span class="lab">${label}</span><div class="segs">${opts.map((o, i) => `<button class="sg ${o.c || ''}" data-i="${i}">${o.t}</button>`).join('')}</div></div>`);
    const paint = () => el.querySelectorAll('.sg').forEach((c, i) => c.classList.toggle('sel', opts[i].v === get()));
    const step = (d) => { const i = opts.findIndex((o) => o.v === get()); set(opts[(i + d + opts.length) % opts.length].v); paint(); };
    el.querySelectorAll('.sg').forEach((c, i) => c.addEventListener('click', () => { set(opts[i].v); paint(); }));
    paint(); return { el, adjust: step, activate: () => step(1), paint };
  };
  const btn = (label, fn, cls = '') => { const el = h(`<button class="btn ${cls}">${label}</button>`); return { el, activate: fn }; };
  const screens = {}, hooks = {};
  const mkScreen = (name, html, cls = '') => { const el = h(`<div class="screen ${name} ${cls}">${html}</div>`); $ui.appendChild(el); screens[name] = el; return el; };
  const hist = [];
  let cur = null, fromPause = false, pauseInfo = null;
  function show(name, push = true) {
    if (cur && push && cur !== name && cur !== 'none') hist.push(cur);
    if (cur) hooks[cur]?.leave?.();
    cur = name; stack.length = 0; $ov.innerHTML = ''; capturing = null;
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('on', k === name));
    hooks[name]?.enter?.();
  }
  const goBack = () => {
    if (fromPause) { fromPause = false; show('none', false); return showPause(pauseInfo); }
    show(hist.pop() || 'home', false);
  };

  // ---------- pick a game ----------
  const pickEl = mkScreen('pick', `${topbar()}<h1 class="ptitle">Pick a game</h1><div class="pgrid">
    <div class="gcard"><i class="tubeart"></i><div><div class="yr">2026</div><div class="gn hf">Totally<br>Tubular</div><div class="gf"><span class="btn sm">Play →</span></div></div></div>
    <div class="gcard ghost"><i class="tubeart b"></i><div><div class="yr">Next season</div><div class="gn hf">Coming<br>soon</div></div></div>
    <div class="gcard ghost"><div><div class="yr">Next season</div><div class="gn hf">Coming<br>soon</div></div></div></div>${hint(['←→', 'Choose'], ['Enter', 'Play'])}`, 'bg');
  const pickItem = { el: pickEl.querySelector('.gcard'), activate: () => show('home') };
  hooks.pick = { enter: () => { hist.length = 0; pushLayer({ items: [pickItem], horizontal: true }); } };

  // ---------- state shared by home / setup / picker ----------
  const S = { mode: st.mode, alliance: st.alliance, robotId: st.robotId, diff: st.difficulty, start: null, cpuA: [], cpuO: [] };
  const NAME = () => st.driverName || 'Driver';
  const counts = () => ({ solo: { ally: 0, opp: 0 }, '1v1': { ally: 0, opp: 1 }, '2v2': { ally: 1, opp: 2 }, '3v3': { ally: 2, opp: 3 }, local: { ally: 0, opp: 1 } }[S.mode] || { ally: 0, opp: 1 });
  const myRobot = () => findRobot(S.robotId || roster()[0].id);

  // ---------- home ----------
  const homeEl = mkScreen('home', `${topbar(CRUMB)}
    <div class="hl"><div class="eyebrow">2026 season · Team 190</div><h1 class="htitle">Totally<br>Tubular</h1><ul class="hmenu"></ul>
      <div class="namecard"><i class="av"></i><label>Driver name<input class="dn" maxlength="24" placeholder="Driver"></label></div></div>
    <div class="hr"><div class="pvbox"></div><button class="car l">‹</button><button class="car r">›</button>
      <div class="hinfo"><div class="bn hf"></div><div><strong></strong><small></small></div><div class="pager"><div class="pb"><i></i></div><span class="pn1"></span></div></div></div>
    ${hint(['↑↓', 'Move'], ['←→', 'Robots'], ['Enter', 'Select'])}`, 'bg');
  const homeMenu = homeEl.querySelector('.hmenu');
  const dn = homeEl.querySelector('.dn'), av = homeEl.querySelector('.av');
  const paintName = () => { av.textContent = NAME()[0]; };
  dn.addEventListener('input', () => { st.driverName = dn.value; paintName(); saveSettings(st); });
  const homeItems = [['Play', () => show('setup')], ['Import robot', () => runImport(async (d) => { S.robotId = st.robotId = d.id; saveSettings(st); show('setup'); })],
    ['Rules', () => show('rules')], ['Settings', () => show('settings')], ['Change game', () => show('pick')]]
    .map(([t, fn]) => { const el = h(`<li class="mi">${t}</li>`); homeMenu.appendChild(el); return { el, activate: fn }; });
  const nameItem = { el: homeEl.querySelector('.namecard'), activate: () => dn.focus() };
  let hi = 0, hpv = null, htimer = 0;
  function homeShow(d = 0) {
    const L = roster(); hi = (hi + d + L.length) % L.length; const r = L[hi];
    hpv?.show(r, S.alliance);
    homeEl.querySelector('.bn').textContent = r.number;
    homeEl.querySelector('.hinfo strong').textContent = r.name;
    homeEl.querySelector('.hinfo small').textContent = r.place || r.team || '';
    homeEl.querySelector('.pb i').style.width = `${((hi + 1) / L.length) * 100}%`;
    homeEl.querySelector('.pn1').textContent = `${hi + 1}/${L.length}`;
    clearInterval(htimer); htimer = setInterval(() => homeShow(1), 7000);
  }
  homeEl.querySelector('.car.l').addEventListener('click', () => homeShow(-1));
  homeEl.querySelector('.car.r').addEventListener('click', () => homeShow(1));
  hooks.home = {
    enter() {
      dn.value = st.driverName; paintName(); hpv = makePreview(homeEl.querySelector('.pvbox')); homeShow(0);
      pushLayer({ items: [...homeItems, nameItem], back: () => show('pick'), onKey: (e) => { if (e.key === 'ArrowLeft') return homeShow(-1) || true; if (e.key === 'ArrowRight') return homeShow(1) || true; } });
    },
    leave() { clearInterval(htimer); hpv?.dispose(); hpv = null; },
  };

  // ---------- import (home / picker) ----------
  async function runImport(after) {
    if (!IMP?.openImportDialog) return toast('Robot import is not available in this build', { tag: '!' });
    const L = pushLayer({ items: [{ el: h('<i></i>') }], passthrough: true });
    let def = null;
    try { def = await IMP.openImportDialog(document.body); } catch (e) { console.error(e); toast('Import failed: ' + e.message, { tag: '!' }); }
    stack.splice(stack.indexOf(L), 1); const t = top(); if (t) focus(t, t.i);
    if (def) { await refreshRobots(); await after?.(def); }
  }

  // ---------- setup ----------
  const setupEl = mkScreen('setup', `${topbar(CRUMB)}<h1 class="ttl">Match setup</h1>
    <div class="cols"><div class="left"></div>
      <div class="rightc"><div class="rh"><div class="segs mtabs"><button class="sg sel" data-t="start">Start position</button><button class="sg" data-t="path">Auto path</button></div>
          <div class="racts"><button class="rs"><span>↺ Reset spot</span></button><button class="rc" hidden><span>✕ Clear</span></button></div></div>
        <div class="mapw"><canvas id="spot"></canvas></div>
        <div class="pinfo"></div><div class="pc"></div>
        <div class="legend"><span><i class="ic g"></i>Intake: path passes a staged tube</span><span><i class="ic y"></i>Score: path reaches your posts</span></div></div></div>
    <div class="bar"></div>`);
  const left = setupEl.querySelector('.left'), bar = setupEl.querySelector('.bar'), cv = setupEl.querySelector('#spot'), mapw = setupEl.querySelector('.mapw');
  const mapTabs = setupEl.querySelector('.mtabs'), mapHelp = setupEl.querySelector('.pc'), pathInfo = setupEl.querySelector('.pinfo'); let setupLayer = null;
  const robotCard = h(`<div class="card rcard"><div class="rinfo"><b></b><div class="nm"></div><small></small></div><button class="btn">Change</button></div>`);
  const pvCard = h('<div class="card pvcard"></div>');
  const lineupBox = h('<div class="card"><span class="lab">Lineup <span style="color:var(--ink-3)">· click a CPU robot to swap</span></span><div class="lineup"></div></div>');
  const rowRobot = { el: robotCard, activate: () => show('picker') };
  const mirrorStart = () => { const old = S.strokes || [], c = clampStart(S.alliance, -S.start.x, -S.start.z); S.start = { ...c, heading: (S.start.heading || 0) + Math.PI }; loadPath(mirrorStrokes(old)); if (S.strokes.length) savePath(); };
  const defaultStart = () => ({ ...SIDES[S.alliance].starts[0] });
  const rowAlli = seg('Alliance', [{ v: 'blue', t: '<i class="dot blue"></i>Blue', c: 'blue' }, { v: 'red', t: '<i class="dot red"></i>Red', c: 'red' }], () => S.alliance,
    (v) => { if (v === S.alliance) return; S.alliance = st.alliance = v; saveSettings(st); mirrorStart(); refresh(true); });
  const rowMode = seg('Mode', [{ v: 'solo', t: 'Solo <small>1v0</small>' }, { v: '1v1', t: '1v1' }, { v: '2v2', t: '2v2' }, { v: '3v3', t: '3v3' }, { v: 'local', t: 'Local 2P' }], () => S.mode,
    (v) => { S.mode = st.mode = v; saveSettings(st); refresh(); });
  const rowCam = seg('Camera', Object.entries(CAMNAME).map(([v, t]) => ({ v, t })), () => st.camera, (v) => { st.camera = v; save(); });
  const rowDiff = seg('CPU difficulty', ['easy', 'normal', 'hard'].map((v) => ({ v, t: v })), () => S.diff, (v) => { S.diff = st.difficulty = v; saveSettings(st); });
  const rowLine = { el: lineupBox, activate: () => { S.cpuA = []; S.cpuO = []; refresh(); } };
  const rowReset = { el: setupEl.querySelector('.rs'), activate: () => { if (S.tab === 'path') { S.strokes.pop(); savePath(); paintTools(); } else { S.start = defaultStart(); loadPath(); } drawMap(); } };
  const rowClear = { el: setupEl.querySelector('.rc'), activate: () => { S.strokes = []; savePath(); paintTools(); drawMap(); } };
  const rowTabs = { el: mapTabs, adjust: () => setMapTab(S.tab === 'path' ? 'start' : 'path'), activate: () => setMapTab(S.tab === 'path' ? 'start' : 'path') };
  mapTabs.querySelectorAll('.sg').forEach((b) => b.addEventListener('click', () => setMapTab(b.dataset.t)));
  const itemsFor = () => [rowRobot, rowAlli, rowMode, rowCam, rowDiff, rowLine, rowTabs, rowReset, ...(S.tab === 'path' ? [rowClear] : []), bBack, bRules, bSet, bStart];
  const bBack = btn('Back', () => goBack()), bRules = btn('Rules', () => show('rules')), bSet = btn('Settings', () => show('settings')), bStart = btn('Start match', () => startMatch(), 'ac');
  [bBack].forEach((b) => bar.appendChild(b.el)); bar.appendChild(h('<span class="sp"></span>')); [bRules, bSet, bStart].forEach((b) => bar.appendChild(b.el));
  [robotCard, pvCard, rowAlli.el, rowMode.el, rowCam.el, rowDiff.el, lineupBox].forEach((e) => left.appendChild(e));
  let spv = null;

  function fillCpu() {
    const used = new Set([myRobot().id]), c = counts(), L = roster();
    const fix = (arr, n) => { for (let i = 0; i < n; i++) {
      if (!arr[i] || used.has(arr[i]) || !ALL.some((r) => r.id === arr[i])) { const pool = L.filter((r) => !used.has(r.id)); arr[i] = (pool.length ? pool : L)[Math.floor(Math.random() * (pool.length || L.length))].id; }
      used.add(arr[i]); } };
    fix(S.cpuA, c.ally); fix(S.cpuO, c.opp);
  }
  function cycleCpu(k, d) {
    const arr = k[0] === 'a' ? S.cpuA : S.cpuO, i = +k.slice(1), c = counts(), L = roster();
    const used = new Set([myRobot().id, ...S.cpuA.slice(0, c.ally), ...S.cpuO.slice(0, c.opp)].filter((x) => x !== arr[i]));
    let j = L.findIndex((r) => r.id === arr[i]);
    for (let n = 0; n < L.length; n++) { j = (j + d + L.length) % L.length; if (!used.has(L[j].id)) break; }
    arr[i] = L[j].id; refresh();
  }
  function paintLineup() {
    const c = counts(), A = S.alliance, O = opponent(A);
    const chip = (def, tag, k) => `<button class="lc ${k ? 'cpu' : 'you'}" ${k ? `data-k="${k}"` : ''}><i></i><span class="ln">${esc(def.number)}</span><span class="nmx">${esc(def.name)}</span>${tag ? `<em>${tag}</em>` : ''}</button>`;
    const rows = { [A]: [chip(myRobot(), 'YOU')], [O]: [] };
    for (let i = 0; i < c.ally; i++) rows[A].push(chip(findRobot(S.cpuA[i]), 'CPU', 'a' + i));
    for (let i = 0; i < c.opp; i++) rows[O].push(S.mode === 'local' ? chip(findRobot(S.cpuO[i]), 'P2', 'o' + i) : chip(findRobot(S.cpuO[i]), 'CPU', 'o' + i));
    const box = lineupBox.querySelector('.lineup');
    box.innerHTML = ['blue', 'red'].map((a) => `<div class="lr ${a}"><b>${a}</b><div class="chs">${rows[a].join('') || '<span class="sub" style="color:var(--ink-3);font-size:12px;padding-top:4px">—</span>'}</div></div>`).join('');
    box.querySelectorAll('.lc.cpu').forEach((b) => b.addEventListener('click', (e) => cycleCpu(b.dataset.k, e.shiftKey ? -1 : 1)));
  }
  function refresh(reshow = false) {
    const r = myRobot();
    robotCard.querySelector('b').textContent = r.number; robotCard.querySelector('.nm').textContent = r.name; robotCard.querySelector('small').textContent = r.place || r.team || '';
    if (reshow || spv?.id !== r.id) { spv?.show(r, S.alliance); if (spv) spv.id = r.id; }
    fillCpu(); paintLineup();
    [rowAlli, rowMode, rowCam, rowDiff].forEach((x) => x.paint()); drawMap();
  }
  hooks.setup = {
    enter() {
      S.robotId = S.robotId && ALL.some((r) => r.id === S.robotId) ? S.robotId : roster()[0].id;
      if (!S.start) S.start = defaultStart();
      S.tab = S.tab || 'start'; loadPath();
      spv = makePreview(pvCard); spv.id = null; refresh(true);
      const items = itemsFor();
      setupLayer = pushLayer({ items, i: items.length - 1, back: goBack, onKey: (e) => {
        const k = e.key.toLowerCase();
        if ((k === 'j' || k === 'l') && S.tab === 'start') { S.start.heading = (S.start.heading || 0) + (k === 'l' ? 0.15 : -0.15); drawMap(); return true; }
      } });
      setMapTab(S.tab); requestAnimationFrame(drawMap);
    },
    leave() { spv?.dispose(); spv = null; setupLayer = null; },
  };
  // CPU starts: partners take the default spots farthest from the player's spot; opponents their default spots.
  function assignStarts() {
    const c = counts(), A = S.alliance, O = opponent(A), d = (s) => Math.hypot(s.x - S.start.x, s.z - S.start.z);
    return { ally: SIDES[A].starts.map((s) => ({ ...s })).sort((a, b) => d(b) - d(a)).slice(0, c.ally), opp: SIDES[O].starts.slice(0, c.opp).map((s) => ({ ...s })) };
  }
  function startMatch() {
    fillCpu(); const c = counts();
    app.onStart({ mode: S.mode, local: S.mode === 'local', alliance: S.alliance, player: myRobot(), difficulty: S.diff, camera: st.camera,
      allies: S.cpuA.slice(0, c.ally).map(findRobot), opps: S.cpuO.slice(0, c.opp).map(findRobot), start: { ...S.start }, starts: assignStarts(), autoPath: S.strokes.length ? fullPath() : null });
  }

  // 2D map: START POSITION tab (drag the spot) and AUTO PATH tab (sketch the path; icons mark automatic actions)
  const MM = 18;   // px of margin around the field for zone labels
  const wx = (g, x) => g.ox + (x + FIELD.halfL) * g.s, wz = (g, z) => g.oy + (z + FIELD.halfW) * g.s;
  const geom = () => { const w = cv.clientWidth, hh = cv.clientHeight, s = Math.max(1, Math.min((w - 2 * MM) / FIELD.length, (hh - 2 * MM) / FIELD.width)); return { w, hh, s, ox: (w - s * FIELD.length) / 2, oy: (hh - s * FIELD.width) / 2 }; };
  let drag = false, stroking = false;
  const fullPath = () => [{ x: S.start.x, z: S.start.z }, ...flattenStrokes(S.strokes)];
  function drawMap() {
    if (!S.start || !cv.clientWidth) return;
    const dpr = devicePixelRatio || 1; cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = geom(), s = g.s, pathTab = S.tab === 'path';
    const R = (r, fill, stroke, w = 1) => { c.beginPath(); c.rect(wx(g, r.x0), wz(g, r.z0), (r.x1 - r.x0) * s, (r.z1 - r.z0) * s); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = w; c.stroke(); } };
    R({ x0: -FIELD.halfL, x1: FIELD.halfL, z0: -FIELD.halfW, z1: FIELD.halfW }, '#0d0f13', '#ffffff30');
    c.beginPath(); c.moveTo(wx(g, 0), wz(g, -FIELD.halfW)); c.lineTo(wx(g, 0), wz(g, FIELD.halfW)); c.strokeStyle = '#ffffff22'; c.lineWidth = 1; c.stroke();
    // zone labels live in the margins around the field so they never overlap field art (short forms when narrow)
    const fs = Math.max(8, Math.min(11, s * 0.34)), label = (txt, short, xa, xb, top, col) => {
      c.font = `700 ${fs}px system-ui`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = col;
      const w = (xb - xa) * s - 4, t = c.measureText(txt).width <= w ? txt : c.measureText(short).width <= w ? short : '';
      if (t) c.fillText(t, wx(g, (xa + xb) / 2), top ? g.oy - MM / 2 : g.oy + FIELD.width * s + MM / 2);
    };
    const stg = stagedSpots(st.midfield ?? 8), usedTubes = new Set();
    const full = fullPath(), mk = pathTab && full.length > 1 ? pathMarkers(full, S.alliance, st.midfield ?? 8) : { intakes: [], scores: [] };
    for (const a of ['blue', 'red']) {
      const Sd = SIDES[a], col = a === 'blue' ? '61,132,250' : '241,68,69', mine = a === S.alliance, K = (o) => `rgba(${col},${o})`, top = a === 'blue';
      R(Sd.scoringZone, K(mine ? 0.13 : 0.05), K(mine ? 0.6 : 0.35)); R(Sd.loadingZone, K(0.05), K(0.3));
      R(Sd.floorArea, K(0.12), K(0.75), 1.5); R(Sd.platformZone, null, K(0.3)); R(Sd.l1Area, K(0.1), K(0.55));
      Sd.platforms.forEach((p, i) => { R(p, K(0.15 + i * 0.12), K(0.8)); if (s >= 14) { c.font = `800 ${Math.max(9, s * 0.5)}px system-ui`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = K(0.95); c.fillText(String(p.level), wx(g, (p.x0 + p.x1) / 2), wz(g, (p.z0 + p.z1) / 2)); } });
      R(Sd.shortWall, '#9a9a9a'); Sd.chutes.forEach((u) => { c.fillStyle = '#f0c13e'; c.fillRect(wx(g, u.x) - 2.5, wz(g, u.z) - 2.5, 5, 5); });
      // posts: each peg runs from the wall to its tip (lower and upper tiers share the same spot from above)
      c.lineWidth = Math.max(2, s * 0.09); c.strokeStyle = K(1); c.lineCap = 'round';
      Sd.posts.filter((p) => p.tier === 'lower').forEach((p) => { c.beginPath(); c.moveTo(wx(g, p.baseX), wz(g, p.z)); c.lineTo(wx(g, p.tipX), wz(g, p.z)); c.stroke(); c.beginPath(); c.arc(wx(g, p.tipX), wz(g, p.z), Math.max(2, s * 0.07), 0, 7); c.fillStyle = '#fff'; c.fill(); });
      c.lineCap = 'butt';
      // staging-row tube spots (empty slots faint, populated ones solid)
      Sd.stagingRow.forEach((p) => { c.beginPath(); c.arc(wx(g, p.x), wz(g, p.z), TUBE.outerRadius * s, 0, 7); c.setLineDash([3, 3]); c.strokeStyle = '#f0c13e30'; c.lineWidth = 1; c.stroke(); c.setLineDash([]); });
      label(mine ? 'YOUR SCORING ZONE' : 'SCORING ZONE', mine ? 'YOUR ZONE' : 'SCORING', Sd.scoringZone.x0, Sd.scoringZone.x1, top, K(0.95));
      label('LOADING ZONE', 'LOADING', Sd.loadingZone.x0, Sd.loadingZone.x1, top, K(0.7));
      label('PLATFORMS', 'PLAT.', Sd.platformZone.x0, Sd.platformZone.x1, top, K(0.7));
    }
    c.font = `700 ${fs}px system-ui`; c.textBaseline = 'middle'; c.textAlign = 'center';
    for (const a of ['blue', 'red']) { const x = SIDES[a].driverStationX < 0 ? g.ox - MM / 2 : g.ox + FIELD.length * s + MM / 2; c.save(); c.translate(x, g.hh / 2); c.rotate(SIDES[a].driverStationX < 0 ? -Math.PI / 2 : Math.PI / 2); c.fillStyle = a === 'blue' ? 'rgba(61,132,250,.85)' : 'rgba(241,68,69,.85)'; if (g.oy > 6 || true) c.fillText(`${a.toUpperCase()} DRIVERS`, 0, 0); c.restore(); }
    for (const t of stg) {
      const hit = mk.intakes.some((m) => Math.hypot(m.x - t.x, m.z - t.z) < 0.01);
      c.beginPath(); c.arc(wx(g, t.x), wz(g, t.z), TUBE.outerRadius * s, 0, 7); c.fillStyle = hit ? 'rgba(56,210,122,.28)' : 'rgba(240,193,62,.18)'; c.fill(); c.strokeStyle = hit ? '#38d27a' : '#f0c13e'; c.lineWidth = Math.max(1.5, s * 0.05); c.stroke();
    }
    const sq = (x, z, hd, fill, stroke, lw = 1.5) => {
      c.save(); c.translate(wx(g, x), wz(g, z)); c.rotate(hd); const r = ROBOT.outer * s / 2;
      c.fillStyle = fill; c.strokeStyle = stroke; c.lineWidth = lw; c.fillRect(-r, -r, 2 * r, 2 * r); c.strokeRect(-r, -r, 2 * r, 2 * r);
      c.beginPath(); c.moveTo(r * 0.95, 0); c.lineTo(r * 0.45, -r * 0.35); c.lineTo(r * 0.45, r * 0.35); c.closePath(); c.fillStyle = stroke; c.fill(); c.restore();
    };
    const st2 = assignStarts(), col = S.alliance === 'blue' ? '61,132,250' : '241,68,69';
    st2.ally.forEach((p) => sq(p.x, p.z, p.heading, 'rgba(255,255,255,.04)', 'rgba(255,255,255,.25)', 1));
    st2.opp.forEach((p) => sq(p.x, p.z, p.heading, 'rgba(255,255,255,.04)', 'rgba(255,255,255,.2)', 1));
    sq(S.start.x, S.start.z, S.start.heading || 0, `rgba(${col},.4)`, drag ? '#f0c13e' : '#fff', 2);
    c.beginPath(); c.arc(wx(g, S.start.x), wz(g, S.start.z), TUBE.outerRadius * s * 0.8, 0, 7); c.strokeStyle = '#f0c13e'; c.lineWidth = Math.max(1.5, s * 0.05); c.stroke(); // preload
    if (!pathTab) return;
    // ---- the drawn path: line + direction arrows + action icons
    if (full.length > 1) {
      c.lineJoin = 'round'; c.lineCap = 'round';
      c.beginPath(); full.forEach((p, k) => (k ? c.lineTo(wx(g, p.x), wz(g, p.z)) : c.moveTo(wx(g, p.x), wz(g, p.z)))); c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = 6; c.stroke();
      c.strokeStyle = '#f0c13e'; c.lineWidth = 3; c.stroke();
      let acc = 0; const gap = 1.3, as = Math.max(5, s * 0.2);
      for (let k = 1; k < full.length; k++) {
        const a = full[k - 1], b = full[k], L = Math.hypot(b.x - a.x, b.z - a.z); if (L < 1e-6) continue;
        const ang = Math.atan2(b.z - a.z, b.x - a.x); let d = gap - acc;
        while (d <= L) { const x = wx(g, a.x + (b.x - a.x) * d / L), y = wz(g, a.z + (b.z - a.z) * d / L); c.save(); c.translate(x, y); c.rotate(ang); c.beginPath(); c.moveTo(as, 0); c.lineTo(-as * 0.7, -as * 0.75); c.lineTo(-as * 0.7, as * 0.75); c.closePath(); c.fillStyle = '#16130a'; c.fill(); c.strokeStyle = '#f0c13e'; c.lineWidth = 1.5; c.stroke(); c.restore(); d += gap; }
        acc = L - (d - gap);
      }
      const e = full[full.length - 1]; c.beginPath(); c.arc(wx(g, e.x), wz(g, e.z), 4.5, 0, 7); c.fillStyle = '#f0c13e'; c.fill();
    }
    const badge = (x, z, col2, draw) => {
      const px = wx(g, x), py = wz(g, z) - Math.max(15, s * 0.7), r = Math.max(8, s * 0.33);
      c.beginPath(); c.moveTo(px, py + r + 5); c.lineTo(px - 4, py + r - 1); c.lineTo(px + 4, py + r - 1); c.fillStyle = col2; c.fill();
      c.beginPath(); c.arc(px, py, r, 0, 7); c.fillStyle = col2; c.fill(); c.strokeStyle = '#0b0d11'; c.lineWidth = 2; c.stroke();
      c.strokeStyle = '#0b0d11'; c.fillStyle = '#0b0d11'; c.lineWidth = Math.max(1.6, r * 0.2); c.lineCap = 'round'; c.lineJoin = 'round'; draw(px, py, r * 0.55);
    };
    mk.intakes.forEach((m) => badge(m.x, m.z, '#38d27a', (x, y, q) => { c.beginPath(); c.moveTo(x - q, y - q * 0.2); c.lineTo(x, y + q * 0.8); c.lineTo(x + q, y - q * 0.2); c.moveTo(x - q, y - q); c.lineTo(x, y - q * 0.0 - q * 0.0); c.moveTo(x, y - q * 1.0); c.lineTo(x + q, y - q); c.stroke(); }));
    mk.scores.forEach((m) => badge(m.x, m.z, '#f0c13e', (x, y, q) => { c.beginPath(); c.moveTo(x - q, y + q * 0.1); c.lineTo(x - q * 0.2, y + q * 0.8); c.lineTo(x + q, y - q * 0.8); c.stroke(); }));
  }
  const mapPos = (e) => { const g = geom(), r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - g.ox) / g.s - FIELD.halfL, z: (e.clientY - r.top - g.oy) / g.s - FIELD.halfW }; };
  const moveTo = (e) => { const p = mapPos(e), q = clampStart(S.alliance, p.x, p.z); S.start.x = q.x; S.start.z = q.z; drawMap(); };
  const addPt = (e, force) => {
    const p = clampToField(mapPos(e), 0.3), cs = S.strokes[S.strokes.length - 1]; if (!cs) return;
    const l = cs[cs.length - 1] || flattenStrokes(S.strokes.slice(0, -1)).pop() || S.start;
    if (force || Math.hypot(p.x - l.x, p.z - l.z) >= 0.12) { cs.push(p); drawMap(); }
  };
  cv.addEventListener('pointerdown', (e) => {
    try { cv.setPointerCapture(e.pointerId); } catch {}
    if (S.tab === 'path') { stroking = true; mapw.classList.add('drag'); S.strokes.push([]); addPt(e, true); }
    else { drag = true; mapw.classList.add('drag'); moveTo(e); }
  });
  cv.addEventListener('pointermove', (e) => { if (stroking) addPt(e); else if (drag) moveTo(e); });
  const endDrag = (e) => {
    if (stroking) { addPt(e, false); S.strokes = S.strokes.filter((s2) => s2.length); savePath(); paintTools(); }
    if (drag && !stroking) { const k = pathKey(); if (k !== S.pathKey) loadPath(); }
    drag = stroking = false; mapw.classList.remove('drag'); drawMap();
  };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  new ResizeObserver(() => cur === 'setup' && drawMap()).observe(mapw);

  // auto path persistence: per alliance + nearest default start; mirrored when the alliance flips
  const pathKey = () => { const A = S.alliance, d = (p) => Math.hypot(p.x - S.start.x, p.z - S.start.z); let b = 0; SIDES[A].starts.forEach((p, k) => { if (d(p) < d(SIDES[A].starts[b])) b = k; }); return `${A}:${b}`; };
  const copyStrokes = (a) => (a || []).map((s2) => s2.map((p) => ({ x: p.x, z: p.z })));
  function loadPath(fallback) { S.pathKey = pathKey(); S.strokes = copyStrokes(st.autoPaths?.[S.pathKey] || fallback || []); paintTools(); }
  function savePath() {
    st.autoPaths = st.autoPaths && typeof st.autoPaths === 'object' ? st.autoPaths : {}; S.pathKey = pathKey();
    if (S.strokes.length) st.autoPaths[S.pathKey] = copyStrokes(S.strokes); else delete st.autoPaths[S.pathKey];
    saveSettings(st);
  }
  function setMapTab(t) {
    S.tab = t; setupEl.classList.toggle('tab-path', t === 'path');
    mapTabs.querySelectorAll('.sg').forEach((b) => b.classList.toggle('sel', b.dataset.t === t));
    rowReset.el.querySelector('span').textContent = t === 'path' ? '↶ Undo' : '↺ Reset spot'; paintTools();
    mapHelp.innerHTML = t === 'path'
      ? 'Drag on the field to draw your AUTO path from your robot; extra strokes join in order. No path = the CPU drives your robot in AUTO.'
      : 'Drag to place it, hold <span class="kbd">J</span> or <span class="kbd">L</span> to turn it. Legal start: inside your SCORING ZONE, outside your LEVEL 1 area (G109).';
    if (setupLayer) setItems(setupLayer, itemsFor(), Math.min(setupLayer.i, itemsFor().length - 1));
    drawMap();
  }
  function paintTools() { const n = S.strokes.length; rowClear.el.hidden = S.tab !== 'path'; rowReset.el.classList.toggle('dis', S.tab === 'path' && !n); rowClear.el.classList.toggle('dis', !n); pathInfo.textContent = S.tab === 'path' ? (n ? `${flattenStrokes(S.strokes).length} points · ${n} stroke${n > 1 ? 's' : ''}` : 'No path drawn — CPU drives AUTO') : ''; }

  // ---------- choose your robot ----------
  const pickerEl = mkScreen('picker', `${topbar(CRUMB)}<h1 class="ptitle">Choose your robot</h1>
    <div class="pk"><div class="pkl"><div class="pkh"><span class="rost">Roster<em></em></span><label class="search"><input placeholder="Search number, team or place   ( / )"></label></div><div class="pkgrid"></div></div>
      <aside class="pkr"><div class="card rb"><div class="top2"><span>Robot</span><span class="al"><i class="dot"></i><span></span></span></div><div class="rn2"><b class="hf"></b><div><strong></strong><small></small></div></div></div>
        <div class="card spec"><div class="st">Spec</div><div class="sbody"></div></div></aside></div><div class="bar"></div>`);
  const pkGrid = pickerEl.querySelector('.pkgrid'), pkSearch = pickerEl.querySelector('.search input'), pkBar = pickerEl.querySelector('.bar');
  const pBack = btn('Back', () => goBack()), pDrive = btn('Drive', () => choose(), 'ac');
  pkBar.appendChild(pBack.el); pkBar.appendChild(h('<span class="sp"></span>')); pkBar.appendChild(pDrive.el);
  let pkLayer = null, pkSel = null, pkPrev = [], pkIO = null;
  const choose = () => { if (!pkSel) return; S.robotId = st.robotId = pkSel; saveSettings(st); goBack(); };
  function pkSelect(def) {
    pkSel = def.id; const red = S.alliance === 'red';
    pkGrid.querySelectorAll('.rc').forEach((e) => { e.classList.toggle('sel', e.dataset.id === def.id); e.classList.toggle('red', red); });
    const rb = pickerEl.querySelector('.rb'); rb.querySelector('.al').className = 'al ' + S.alliance; rb.querySelector('.al span').textContent = S.alliance + ' alliance';
    rb.querySelector('.al .dot').className = 'dot ' + S.alliance;
    rb.querySelector('b').textContent = def.number; rb.querySelector('strong').textContent = def.name; rb.querySelector('small').textContent = def.place || def.team || '';
    pickerEl.querySelector('.sbody').innerHTML = specHTML(def);
    pDrive.el.textContent = `Drive ${def.number}`;
  }
  function pkBuild() {
    const q = pkSearch.value.trim().toLowerCase();
    const list = ALL.filter((r) => !q || `${r.number} ${r.name} ${r.team || ''} ${r.place || ''}`.toLowerCase().includes(q));
    pkPrev.forEach((p) => p.dispose()); pkPrev = []; pkIO?.disconnect(); pkGrid.innerHTML = '';
    pickerEl.querySelector('.rost em').textContent = list.length;
    const impEl = h('<div class="rc imp"><span>+</span>Import STL</div>'); pkGrid.appendChild(impEl);
    const items = [{ el: impEl, activate: () => runImport(async (d) => { pkSel = d.id; pkSearch.value = ''; pkBuild(); }) }];
    pkIO = new IntersectionObserver((es) => es.forEach((e) => { const p = e.target._pv; if (!p) return; if (e.isIntersecting && !p.on) { p.on = true; p.show(e.target._def, S.alliance); } }), { root: pkGrid, rootMargin: '200px' });
    list.forEach((def) => {
      const del = def.source === 'stl' ? '<button class="del" title="Delete robot">×</button>' : '';
      const el = h(`<div class="rc" data-id="${esc(def.id)}"><div class="pvh"></div><div class="rcf"><b>${esc(def.number)}</b><div><strong>${esc(def.name)}</strong><small>${esc(def.place || def.team || '')}</small></div></div>${del}</div>`);
      const pv = makePreview(el.querySelector('.pvh')); el._pv = pv; el._def = def; pkPrev.push(pv); pkGrid.appendChild(el); pkIO.observe(el);
      el.querySelector('.del')?.addEventListener('click', async (e) => { e.stopPropagation();
        if (!confirm(`Delete imported robot ${def.number} ${def.name}?`)) return;
        try { await RBM.deleteRobot(def.id); } catch (er) { console.warn(er); }
        await refreshRobots(); if (S.robotId === def.id) S.robotId = st.robotId = roster()[0].id; if (pkSel === def.id) pkSel = S.robotId; pkBuild(); });
      el.addEventListener('dblclick', () => choose());
      items.push({ el, def, onFocus: () => pkSelect(def), onClick: () => {}, activate: () => choose() });
    });
    items.push(pBack, pDrive);
    const si = Math.max(1, items.findIndex((x) => x.def?.id === pkSel));
    if (!items.some((x) => x.def?.id === pkSel) && items[1]?.def) pkSelect(items[1].def);
    if (pkLayer) setItems(pkLayer, items, si);
    return items;
  }
  pkSearch.addEventListener('input', () => { pkBuild(); });
  hooks.picker = {
    enter() {
      pkSel = S.robotId; pkSearch.value = '';
      pkLayer = pushLayer({ items: [{ el: h('<i></i>') }], back: goBack, noHover: true, onKey: (e) => {
        const L = pkLayer, n = L.items.length - 2, i = L.i, k = e.key;
        if (k === '/') { pkSearch.focus(); return true; }
        const cols = getComputedStyle(pkGrid).gridTemplateColumns.split(' ').length;
        if (i < n) {
          if (k === 'ArrowRight') focus(L, Math.min(i + 1, n - 1)); else if (k === 'ArrowLeft') focus(L, Math.max(i - 1, 0));
          else if (k === 'ArrowDown') focus(L, i + cols < n ? i + cols : n); else if (k === 'ArrowUp') focus(L, i - cols >= 0 ? i - cols : i); else return false;
          return true;
        }
        if (k === 'ArrowLeft' || k === 'ArrowRight') { focus(L, i === n ? n + 1 : n); return true; }
        if (k === 'ArrowUp') { focus(L, Math.max(1, L.items.findIndex((x) => x.def?.id === pkSel))); return true; }
        return k === 'ArrowDown';
      } });
      pkBuild();
    },
    leave() { pkPrev.forEach((p) => p.dispose()); pkPrev = []; pkIO?.disconnect(); pkLayer = null; },
  };

  // ---------- rules ----------
  const P = POINTS, T = TIMING;
  const rulesEl = mkScreen('rules', `${topbar(CRUMB)}<h1 class="ptitle">Rules</h1><div class="page">
  <p>Two alliances score identical tubes on the floor and on two tiers of eight posts, then finish on elevated platforms. ${TUBE.perAlliance} tubes per alliance: staged midfield tubes, one preload per robot, the rest fed by your human player from the loading station. Condensed from the game manual (Draft 0.10).</p>
  <h3>Match phases</h3><table><tr><th>Phase</th><th class="n">Time</th><th>Notes</th></tr>
  <tr><td>AUTO</td><td class="n">${T.auto}s</td><td>No human-player tubes, no entering either LOADING ZONE, tubes score double. No contact with opponents once fully past center.</td></tr>
  <tr><td>TRANSITION</td><td class="n">${T.transition}s</td><td>Robots are disabled between AUTO and TELEOP; no driving or actions.</td></tr>
  <tr><td>TELEOP</td><td class="n">${T.teleop}s</td><td>Loading permitted. The last ${T.endgame}s are ENDGAME.</td></tr>
  <tr><td>Assessment</td><td class="n">+${T.assessDelay}s</td><td>Platform positions are judged 3 seconds after the buzzer.</td></tr></table>
  <h3>Scoring</h3><table><tr><th>Action</th><th class="n">TELEOP</th><th class="n">AUTO</th></tr>
  <tr><td>Tube fully inside your LEVEL 1 SCORING AREA (floor)</td><td class="n">${P.floor.teleop}</td><td class="n">${P.floor.auto}</td></tr>
  <tr><td>Tube on a LOWER post</td><td class="n">${P.lower.teleop}</td><td class="n">${P.lower.auto}</td></tr>
  <tr><td>Tube on an UPPER post</td><td class="n">${P.upper.teleop}</td><td class="n">${P.upper.auto}</td></tr>
  ${[1, 2, 3, 4].map((l) => `<tr><td>Robot on PLATFORM LEVEL ${l} (end of match)</td><td class="n">${P.platform[l]}</td><td class="n">-</td></tr>`).join('')}
  <tr><td>FOUL received</td><td class="n">${P.foul}</td><td class="n">${P.foul}</td></tr><tr><td>TECH FOUL received</td><td class="n">${P.techFoul}</td><td class="n">${P.techFoul}</td></tr></table>
  <p>Only ${P.maxScoringPerPost} tubes per post count. Each robot scores its highest supported level only. Floor tubes must be fully inside the area.</p>
  <h3>Ranking points</h3><table><tr><th>Condition</th><th class="n">RP</th></tr>
  <tr><td>Win / Tie</td><td class="n">${RP.win} / ${RP.tie}</td></tr><tr><td>8 of 16 posts with 3 tubes</td><td class="n">+${RP.posts8}</td></tr>
  <tr><td>12 of 16 posts with 3 tubes</td><td class="n">+${RP.posts12}</td></tr><tr><td>16+ platform points</td><td class="n">+${RP.platform16}</td></tr></table>
  <h3>Key gameplay rules</h3><div class="g"><ul>
  <li><b>G101</b> Control at most 2 tubes. Foul per occurrence.</li>
  <li><b>G102</b> No deliberate de-scoring of opponent tubes.</li>
  <li><b>G103</b> No contact with opponents while any part of you is in their SCORING ZONE. Tech foul.</li>
  <li><b>G104</b> Same for their LOADING ZONE; no entering either LOADING ZONE in AUTO. Tech foul.</li>
  <li><b>G105</b> No human-player loading in AUTO.</li></ul><ul>
  <li><b>G106</b> Launch only when fully inside your own SCORING ZONE. Tech foul.</li>
  <li><b>G108</b> Last 30s: no contact with opponents touching their PLATFORM ZONE. They are awarded LEVEL 4.</li>
  <li><b>G109</b> Start AUTO with bumpers inside your SCORING ZONE and outside the LEVEL 1 area.</li>
  <li><b>G110</b> No opponent contact in AUTO once fully past mid-field. Tech foul.</li>
  <li><b>G111</b> After a foul you have 3s to stop or get 6 ft (1.83 m) clear, or it repeats.</li></ul></div>
  <h3>Robot limits</h3><p>Robot perimeter 120 in, extension 20 in beyond the frame (30 in in ENDGAME near the platforms), 2-tube carry limit, one extension direction at a time.</p>
  </div>${hint(['↑↓', 'Scroll'], ['Esc', 'Back'])}`);
  hooks.rules = { enter: () => pushLayer({ items: [{ el: h('<i></i>') }], back: goBack, onKey: (e) => {
    const d = { ArrowDown: 60, ArrowUp: -60, PageDown: 400, PageUp: -400 }[e.key]; if (d) { rulesEl.querySelector('.page').scrollBy(0, d); return true; } } }) };

  // ---------- settings ----------
  const setEl = mkScreen('settings', `${topbar(CRUMB)}<h1 class="ptitle">Settings</h1><div class="swh" style="width:min(600px,100%);margin:0 auto;padding:0 12px"><div class="tabs"></div></div><div class="sw"></div><div class="bar"></div>`);
  const TABS = ['general', 'display', 'keyboard', 'controller'];
  let tab = 'general', sLayer = null, rumT = 0, hintDev = null;
  const tabsEl = setEl.querySelector('.tabs'), swEl = setEl.querySelector('.sw');
  tabsEl.innerHTML = TABS.map((t) => `<button data-t="${t}">${t}</button>`).join('');
  tabsEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.t)));
  const sBack = btn('Back', () => goBack()), sReset = btn('Reset controls', () => { st.keys = {}; st.pad = {}; st.speeds = [...DEFAULTS.speeds]; save(); setTab(tab); kbNote('Controls reset to defaults.'); });
  const sbar = setEl.querySelector('.bar'); sbar.appendChild(sBack.el); sbar.appendChild(h('<span class="sp"></span>')); sbar.appendChild(sReset.el);
  const tabsItem = { el: tabsEl, adjust: (d) => setTab(TABS[(TABS.indexOf(tab) + d + TABS.length) % TABS.length], true), activate: () => {} };
  const clampv = (v, a, b) => Math.max(a, Math.min(b, v));
  const rowSlider = (label, min, max, step, get, set, fmt = (v) => v + '%') => {
    const el = h(`<div class="srow"><span>${label}</span><div class="ctl"><input type="range" min="${min}" max="${max}" step="${step}"><span class="pct"></span></div></div>`);
    const inp = el.querySelector('input'), pct = el.querySelector('.pct'), paint = () => { inp.value = get(); pct.textContent = fmt(get()); };
    inp.addEventListener('input', () => { set(+inp.value); paint(); }); paint();
    return { el, adjust: (d) => { set(clampv(get() + d * step, min, max)); paint(); } };
  };
  const rowTog = (label, opts, get, set) => {
    const el = h(`<div class="srow"><span>${label}</span><div class="ctl"><div class="tg">${opts.map((o, i) => `<b data-i="${i}">${o.t}</b>`).join('')}</div></div></div>`);
    const paint = () => el.querySelectorAll('b').forEach((b, i) => b.classList.toggle('on', opts[i].v === get()));
    const step = (d) => { const i = opts.findIndex((o) => o.v === get()); set(opts[(i + d + opts.length) % opts.length].v); paint(); };
    el.querySelectorAll('b').forEach((b, i) => b.addEventListener('click', () => { set(opts[i].v); paint(); })); paint();
    return { el, adjust: step, activate: () => step(1) };
  };
  const OO = [{ v: false, t: 'Off' }, { v: true, t: 'On' }];
  const group = (title, rows) => { const w = h(`<div><div class="sec">${title}</div><div class="srows"></div></div>`); rows.forEach((r) => w.querySelector('.srows').appendChild(r.el)); return w; };
  // ----- rebinding helpers -----
  let kbMsg = null;
  const CAPHINT = 'Press a key… Esc cancels, Backspace clears';
  const kbNote = (t) => { if (kbMsg) kbMsg.textContent = t || 'Click a key to change it.'; };
  const startCapture = (opts) => {
    if (capturing) capturing.done(null);
    capturing = { pad: !!opts.pad, done: (v) => { capturing = null; opts.done(v); } };
    if (opts.pad) padWatch(capturing, opts.pad);
  };
  // wait for the pad to be released, then resolve with the first button / stick direction pushed
  function padWatch(cap, kind) {
    const pc = () => ({ ...DEFAULT_PADCFG, ...(st.padCfg || {}) });
    let armed = false;
    const tick = () => {
      if (capturing !== cap) return;
      const pad = pickPad(), b = pad ? detectBinding(pad, pc()) : null;
      if (!b) armed = true; else if (armed) return cap.done(b);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const kbRows = [];
  function keyRow(a) {
    const id = a.id, el = h(`<div class="srow"><span>${a.label}</span><div class="ctl"></div></div>`), ctl = el.querySelector('.ctl');
    const paint = () => {
      const l = effectiveKeys(st.keys)[id];
      ctl.innerHTML = l.map((c, i) => `<button class="kc" data-i="${i}">${keyLabel(c)}</button>`).join('') + (l.length < MAX_CHIPS ? '<button class="kc add" data-i="+">+</button>' : '');
      ctl.querySelectorAll('.kc').forEach((b) => b.addEventListener('click', () => cap(b)));
    };
    function cap(b) {
      const idx = b.dataset.i === '+' ? '+' : +b.dataset.i;
      b.classList.add('cap'); b.textContent = '…'; kbNote(CAPHINT);
      startCapture({ done: (code) => {
        let note = '';
        if (code !== null) { const r = rebindKey(st.keys, id, idx, code); st.keys = r.map; note = r.note; save(); }
        kbRows.forEach((r) => r.paint()); kbNote(note);
      } });
    }
    const row = { el, paint, activate: () => cap(ctl.querySelector('.kc')) }; kbRows.push(row); paint(); return row;
  }
  const pickPad = () => { const all = [...(navigator.getGamepads?.() || [])], d = st.padCfg?.device; return (d !== 'auto' && all[d]) || all.find(Boolean) || null; };
  const padRows = [];
  function padRow(a, note) {
    const id = a.id, el = h(`<div class="srow"><span>${a.label}</span><div class="ctl"><button class="kc"></button></div></div>`), chip = el.querySelector('.kc');
    const paint = () => { const b = effectivePad(st.pad)[id]; chip.textContent = b ? padLabel(b) : '—'; chip.classList.toggle('add', !b); chip.classList.remove('cap'); };
    const cap = () => {
      if (!pickPad()) return note('Plug in a controller, or press a button on one, to change its buttons.');
      chip.classList.add('cap'); chip.textContent = '…'; note('Press a button or push a stick / trigger… Esc cancels, Backspace clears');
      startCapture({ pad: true, done: (b) => {
        let n = '';
        if (b !== null) { const r = rebindPad(st.pad, id, b === '' ? null : b); st.pad = r.map; n = r.note; save(); }
        padRows.forEach((r) => r.paint()); note(n);
      } });
    };
    chip.addEventListener('click', cap);
    const row = { el, paint, activate: cap, onClick: cap }; padRows.push(row); paint(); return row;
  }
  const padStatus = () => { const p = pickPad(); return p ? esc(p.id.replace(/\s*\(.*$/, '').slice(0, 48) || 'Controller') : 'Not connected'; };
  const FLIP = (i) => (st.padCfg.flipAB && i < 2 ? 1 - i : st.padCfg.flipXY && (i === 2 || i === 3) ? 5 - i : i);
  const BTNN = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→', 'Home'];
  function controllerTest() {
    const el = h(`<div class="ctest"><div class="ct-h">Controller test</div><div class="ct-msg">Press a button on your controller</div>
      <div class="ct-b">${BTNN.map((n) => `<i>${n}</i>`).join('')}</div><div class="ct-a">${['LX', 'LY', 'RX', 'RY'].map((n) => `<div><span>${n}</span><b><u></u></b><em>0.00</em></div>`).join('')}</div></div>`);
    const bs = [...el.querySelectorAll('.ct-b i')], as = [...el.querySelectorAll('.ct-a div')], msg = el.querySelector('.ct-msg');
    const tick = () => {
      if (!el.isConnected) return;
      const pad = pickPad(), pressed = [];
      bs.forEach((b, i) => { const on = !!pad && pad.buttons.some((x, k) => FLIP(k) === i && (x.pressed || x.value > 0.5)); b.classList.toggle('on', on); if (on) pressed.push(BTNN[i]); });
      as.forEach((a, i) => { const v = pad?.axes?.[i] || 0; a.querySelector('u').style.cssText = `left:${50 + Math.min(0, v) * 50}%;width:${Math.abs(v) * 50}%`; a.querySelector('em').textContent = v.toFixed(2); });
      const moved = pad?.axes?.some((v, i) => i < 4 && Math.abs(v) > 0.2);
      msg.textContent = !pad ? 'Press a button on your controller' : pressed.length || moved ? `Pressed: ${pressed.join(' + ') || '(stick)'}` : 'Connected — press any button';
      const sv = swEl.querySelector('.cstat'); if (sv) sv.innerHTML = padStatus();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return el;
  }
  function setTab(t, keepFocus) {
    tab = t; tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t)); swEl.innerHTML = '';
    let rows = [], nodes = [];
    if (t === 'general') {
      const nm = h(`<div class="srow"><span>Name</span><div class="ctl"><input class="fld" maxlength="24" placeholder="Driver"></div></div>`), ni = nm.querySelector('input');
      ni.value = st.driverName; ni.addEventListener('input', () => { st.driverName = ni.value; saveSettings(st); });
      const r1 = { el: nm, activate: () => ni.focus() };
      const vol = rowSlider('Volume', 0, 100, 5, () => st.volume, (v) => { st.volume = v; save(); });
      const mute = rowTog('Mute sound', OO, () => !!st.muted, (v) => { st.muted = v; save(); });
      const sp = [0, 1, 2].map((i) => rowSlider(`Speed ${i + 1} (key ${i + 1})`, 10, 100, 5, () => st.speeds[i], (v) => { st.speeds[i] = v; save(); }));
      const mid = rowSlider('Midfield tubes per alliance', 0, 8, 1, () => st.midfield, (v) => { st.midfield = v; save(); }, (v) => v);
      const hp = rowTog('Human player auto-feed', OO, () => st.autoHP, (v) => { st.autoHP = v; save(); });
      const aal = rowTog('Auto-align (Score inside your scoring zone)', OO, () => st.autoAlign !== false, (v) => { st.autoAlign = v; save(); });
      rows = [r1, vol, mute, ...sp, aal, mid, hp];
      nodes = [group('Driver', [r1]), group('Sound', [vol, mute]), group('Controls', [...sp, aal]), group('Match', [mid, hp])];
    } else if (t === 'display') {
      const q = rowTog('Graphics', [{ v: 'low', t: 'Low' }, { v: 'high', t: 'High' }], () => st.quality, (v) => { st.quality = v; save(); });
      const bg = rowTog('Background (stands + crowd)', OO, () => st.background, (v) => { st.background = v; save(); });
      const cm = rowTog('Default camera', Object.entries(CAMNAME).map(([v, t2]) => ({ v, t: t2 })), () => st.camera, (v) => { st.camera = v; save(); });
      const fl = rowTog('Camera follow', [{ v: 'smooth', t: 'Smooth' }, { v: 'tight', t: 'Tight' }, { v: 'locked', t: 'Locked' }], () => st.cameraFollow, (v) => { st.cameraFollow = v; save(); });
      const fr = rowTog('Field-relative drive', OO, () => st.fieldRelative, (v) => { st.fieldRelative = v; save(); });
      const hg = rowTog('Hide GUI (keep scoreboard)', OO, () => st.hideGui, (v) => { st.hideGui = v; save(); });
      rows = [q, bg, cm, fl, fr, hg]; nodes = [group('Graphics', [q, bg]), group('Camera', [cm, fl, fr]), group('Interface', [hg])];
    } else if (t === 'keyboard') {
      kbRows.length = 0;
      const nb = h('<div class="notebar"><span class="kmsg"></span><span>Changes save automatically.</span></div>'); kbMsg = nb.querySelector('.kmsg'); kbNote('');
      nodes = [nb];
      for (const grp of GROUPS) { const rs = ACTIONS.filter((a) => a.group === grp).map(keyRow); rows.push(...rs); nodes.push(group(grp, rs)); }
    } else {
      padRows.length = 0;
      const pc = st.padCfg, setc = (k, v) => { pc[k] = v; save(); };
      const nb = h('<div class="notebar"><span class="pmsg">Click a row, then press a controller button or push a stick.</span><span>Changes save automatically.</span></div>');
      const pnote = (t) => { nb.querySelector('.pmsg').textContent = t || 'Click a row, then press a controller button or push a stick.'; };
      const stat = { el: h(`<div class="srow"><span>Controller</span><span class="ctl cstat" style="flex:none;color:var(--ink-2)">${padStatus()}</span></div>`) };
      const dev = rowTog('Device', [{ v: 'auto', t: 'Auto' }, { v: 0, t: '1' }, { v: 1, t: '2' }, { v: 2, t: '3' }, { v: 3, t: '4' }], () => pc.device, (v) => setc('device', v));
      const fab = rowTog('Flip A/B', OO, () => pc.flipAB, (v) => setc('flipAB', v)), fxy = rowTog('Flip X/Y', OO, () => pc.flipXY, (v) => setc('flipXY', v));
      const dz = rowSlider('Stick deadzone', 0, 40, 1, () => pc.deadzone, (v) => setc('deadzone', v));
      const fine = rowSlider('Fine control (response curve)', 0, 100, 5, () => pc.fine, (v) => setc('fine', v), (v) => (v ? v + '%' : 'Off'));
      const rum = rowSlider('Rumble strength', 0, 100, 10, () => pc.rumble, (v) => { setc('rumble', v); clearTimeout(rumT); rumT = setTimeout(() => app.onRumble?.(), 150); });
      const srows = [stat, dev, fab, fxy, dz, fine, rum];
      nodes = [nb, group('Device', srows), controllerTest()];
      rows = [dev, fab, fxy, dz, fine, rum];
      for (const grp of GROUPS) { const rs = ACTIONS.filter((a) => a.group === grp && a.pad).map((a) => padRow(a, pnote)); rows.push(...rs); nodes.push(group(grp, rs)); }
      nodes.push(h('<div class="note">Speed 1 / 2 / 3 are keyboard only. Sticks can be bound to Drive / Turn (or any action); triggers are buttons LT / RT.</div>'));
    }
    nodes.forEach((n) => swEl.appendChild(n));
    if (sLayer) setItems(sLayer, [tabsItem, ...rows, sBack, sReset], keepFocus ? 0 : sLayer.i);
  }
  hooks.settings = { enter() { sLayer = pushLayer({ items: [tabsItem], back: goBack }); setTab(tab); }, leave() { sLayer = null; } };

  // ---------- HUD ----------
  $hud.innerHTML = `<div class="sbw"><div class="sb"><div class="sbox red" id="rs">0</div><div class="sclk"><div class="t" id="clk">2:05</div><div class="ph" id="ph">READY</div></div><div class="sbox blue" id="bs">0</div></div></div>
    <div class="bl"><div class="tubes"><div class="tube"></div><div class="tube"></div></div><div class="pn" id="pn"></div><div class="pl" id="pl"></div><div class="prog"><i id="pg"></i></div></div>
    <div class="aa" id="aa" hidden><div class="chip"><svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="9" class="trk"/><circle cx="12" cy="12" r="9" class="arc" id="aaring" pathLength="100"/></svg><b>AUTO-ALIGN</b><span id="aat"></span></div><div class="line"><i id="aal"></i></div></div>
    <div class="tierchip floor" id="tierchip">FLOOR</div>
    <div class="br"><div class="hst" id="hst"></div><div class="hints" id="hints"></div></div>
    <div class="stats" id="stats" hidden></div><div class="bd" id="bd" hidden></div>`;
  const $ = (id) => $hud.querySelector('#' + id);
  const PHL = { pre: 'READY', auto: 'AUTO', transition: 'TRANSITION', teleop: 'TELEOP', endgame: 'ENDGAME', post: 'ASSESSING', done: 'FINAL' };
  let hintDef = null;
  function setHints(def, dev = 'kb') {
    hintDef = def; hintDev = dev;
    const KB = effectiveKeys(st.keys), PD = effectivePad(st.pad), pad = dev === 'pad';
    const lab = (id) => (pad ? padLabel(PD[id]) : keyLabel(KB[id][0] || ''));
    const k = (a, b) => (a ? `<span><span class="kbd">${a}</span>${b}</span>` : '');
    const move = pad ? 'L' : ['up', 'left', 'down', 'right'].map(lab).join('');
    $('hints').innerHTML = [k(move, 'drive'), k(pad ? 'R' : `${lab('rotL')}/${lab('rotR')}`, 'turn'), k(lab('intake'), 'intake'), k(lab('upper'), 'arm upper'), k(lab('lower'), 'arm lower'), k(lab('place'), 'score (floor if unarmed)'), k(lab('drop'), 'drop'),
      k(lab('climb'), 'climb'), k(lab('tube'), 'request tube'), k(lab('stow'), 'stow'), k(lab('camera'), 'camera'), k(lab('slot'), 'flip cam'), pad ? '' : k('1-3', 'speed'), k(lab('pause'), 'pause'), k(lab('breakdown'), 'breakdown')].join('');
    $('pn').textContent = `${def.number} ${def.name}`;
  }
  const showStats = (on) => { $('stats').hidden = !on; };
  function showBreakdown(on, f, A = 'blue') {
    const el = $('bd'); el.hidden = !on; if (!on || !f) return;
    const B = f.blue || {}, R = f.red || {}, g = (o, ...p) => p.reduce((a, k) => a?.[k], o) ?? 0;
    const rows = [['floor', 'floor'], ['lower', 'lower'], ['upper', 'upper']].flatMap(([k, l]) => ['auto', 'teleop'].map((ph) => [`${ph.toUpperCase()} ${l}`, ph, k, P[k][ph]]))
      .map(([l, ph, k, per]) => `<tr><td>${l}</td><td class="n b">${g(B, ph, k)} <span class="sub">(${g(B, ph, k) * per})</span></td><td class="n r">${g(R, ph, k)} <span class="sub">(${g(R, ph, k) * per})</span></td></tr>`).join('');
    el.innerHTML = `<div class="bdc"><h4>Score breakdown</h4><table><tr><th></th><th class="n b">Blue</th><th class="n r">Red</th></tr>${rows}
      <tr><td>Platform</td><td class="n b">${g(B, 'platform', 'points')}</td><td class="n r">${g(R, 'platform', 'points')}</td></tr>
      <tr><td>Fouls received</td><td class="n b">${g(B, 'fouls', 'points')}</td><td class="n r">${g(R, 'fouls', 'points')}</td></tr>
      <tr class="tot"><td>TOTAL</td><td class="n b">${g(B, 'total')}</td><td class="n r">${g(R, 'total')}</td></tr></table></div>`;
  }
  // FRC-style field clock: seconds left in the CURRENT period (AUTO 0:20->0:00, TRANSITION 0:00, TELEOP 1:45->0:00)
  const clockStr = (m) => { const s = Math.max(0, Math.ceil((m?.periodRemaining ?? m?.remaining ?? 0) - 1e-6)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
  let lastHud = {};
  function updateHUD(d) {
    const { match, score, me, camera, armed, cap } = lastHud = d;
    if (hintDef && (d.device || 'kb') !== hintDev) setHints(hintDef, d.device || 'kb');
    if (d.stats && !$('stats').hidden) $('stats').textContent = `FPS ${Math.round(d.stats.fps)}  ·  SPEED ${d.stats.speed.toFixed(1)} m/s`;
    $('clk').textContent = clockStr(match);
    const ph = $('ph'); ph.textContent = PHL[match?.phase] || ''; ph.classList.toggle('endgame', match?.phase === 'endgame');
    $('rs').textContent = score?.red?.total ?? 0; $('bs').textContent = score?.blue?.total ?? 0;
    $hud.querySelectorAll('.tube').forEach((t, i) => t.classList.toggle('on', i < (me?.held?.length ?? 0)));
    const aaEl = $('aa'); aaEl.hidden = !d.auto;
    if (d.auto) { const pr = Math.round(100 * (d.auto.progress || 0)); $('aat').textContent = d.auto.label; $('aaring').style.strokeDasharray = `${pr} 100`; $('aal').style.width = pr + '%'; }
    const tc = $('tierchip'); tc.textContent = tierLabel(armed); tc.className = 'tierchip ' + (armed || 'floor');
    const a = me?.action; $('pg').style.width = a && a.duration ? `${Math.min(100, (100 * a.t) / a.duration)}%` : '0%'; $('pl').textContent = a ? a.type.toUpperCase() : '';
    $('hst').textContent = `${(CAMNAME[camera] || camera).toUpperCase()}  ·  SPEED ${Math.round((cap ?? 1) * 100)}%`;
  }

  // ---------- toasts / countdown ----------
  function toast(text, o = {}) {
    const el = h(`<div class="toast ${o.alliance || ''} ${o.foul ? 'foul' : ''}">${o.tag ? `<b>${esc(o.tag)}</b>` : ''}${esc(text)}</div>`);
    $toasts.appendChild(el); while ($toasts.children.length > 5) $toasts.firstChild.remove();
    setTimeout(() => el.classList.add('out'), o.ms || 3600); setTimeout(() => el.remove(), (o.ms || 3600) + 450);
  }
  let lastCd = null;
  function countdown(v) {
    if (v == null) { $cd.hidden = true; lastCd = null; return; }
    $cd.hidden = false; if (v !== lastCd) { $cd.innerHTML = `<span>${v}</span>`; lastCd = v; }
  }

  // ---------- pause / results ----------
  let closePause = () => {};
  function showPause(info = {}) {
    pauseInfo = info;
    const hd = lastHud, A = info.alliance || 'blue', sc = hd.score, you = sc?.[A]?.total ?? 0, them = sc?.[opponent(A)]?.total ?? 0;
    const mk = (t, fn) => ({ el: h(`<div class="mi">${t}</div>`), activate: fn });
    const items = [mk('Resume', () => resume()), mk('Restart', () => { close(); app.onRestart(); }),
      mk('Settings', () => { fromPause = true; show('settings'); }), mk('Back to setup', () => { close(); app.onQuit('setup'); }), mk('Title screen', () => { close(); app.onQuit('title'); })];
    const ov = h(`<div class="ov"><div class="pz"><h2>Paused</h2><div class="who"><i class="dot ${A}"></i>${A[0].toUpperCase() + A.slice(1)} alliance · ${esc(info.label || '')}</div>
      <div class="mt"><div class="y">You<b>${you}</b></div><div>${PHL[hd.match?.phase] || ''}<b>${clockStr(hd.match)}</b></div><div class="t">Them<b>${them}</b></div></div><div class="pm"></div></div></div>`);
    items.forEach((i) => ov.querySelector('.pm').appendChild(i.el)); $ov.appendChild(ov);
    const close = () => { ov.remove(); if (top()?.pause) popLayer(); };
    const resume = () => { close(); app.onResume(); };
    pushLayer({ items, pause: true, back: resume }); closePause = close;
  }

  function showResults(f, fouls = []) {
    const B = f.blue || {}, R = f.red || {}, g = (o, ...p) => p.reduce((a, k) => a?.[k], o) ?? 0;
    const tp = (n, per) => `${n} <span class="sub">(${n * per})</span>`;
    const rows = [['AUTO floor', 'auto', 'floor', P.floor.auto], ['AUTO lower', 'auto', 'lower', P.lower.auto], ['AUTO upper', 'auto', 'upper', P.upper.auto],
      ['TELEOP floor', 'teleop', 'floor', P.floor.teleop], ['TELEOP lower', 'teleop', 'lower', P.lower.teleop], ['TELEOP upper', 'teleop', 'upper', P.upper.teleop]]
      .map(([l, ph, k, per]) => `<tr><td>${l}</td><td class="n b">${tp(g(B, ph, k), per)}</td><td class="n r">${tp(g(R, ph, k), per)}</td></tr>`).join('');
    const w = g(B, 'total') > g(R, 'total') ? 'blue' : g(R, 'total') > g(B, 'total') ? 'red' : 'tie';
    const ov = h(`<div class="ov"><div class="res"><div class="win ${w}">${w === 'tie' ? 'Tie match' : w + ' alliance wins'}</div>
      <table><tr><th>Category</th><th class="n b">Blue</th><th class="n r">Red</th></tr>${rows}
      <tr><td>Platform points</td><td class="n b">${g(B, 'platform', 'points')}</td><td class="n r">${g(R, 'platform', 'points')}</td></tr>
      <tr><td>Fouls received (foul / tech)</td><td class="n b">${g(B, 'fouls', 'points')} <span class="sub">(${g(B, 'fouls', 'foul')} / ${g(B, 'fouls', 'tech')})</span></td><td class="n r">${g(R, 'fouls', 'points')} <span class="sub">(${g(R, 'fouls', 'foul')} / ${g(R, 'fouls', 'tech')})</span></td></tr>
      <tr><td>Full posts</td><td class="n b">${g(B, 'fullPosts')}/16</td><td class="n r">${g(R, 'fullPosts')}/16</td></tr>
      <tr class="tot"><td>TOTAL</td><td class="n b">${g(B, 'total')}</td><td class="n r">${g(R, 'total')}</td></tr>
      <tr><td>Ranking points (win ${g(B, 'rp', 'win')}/${g(R, 'rp', 'win')}, posts ${g(B, 'rp', 'posts8') + g(B, 'rp', 'posts12')}/${g(R, 'rp', 'posts8') + g(R, 'rp', 'posts12')}, platform ${g(B, 'rp', 'platform16')}/${g(R, 'rp', 'platform16')})</td><td class="n b">${g(B, 'rp', 'total')} RP</td><td class="n r">${g(R, 'rp', 'total')} RP</td></tr></table>
      ${fouls.length ? `<p class="sub" style="margin:10px 0 0">Penalties: ${fouls.slice(0, 12).map((x) => `${esc(x.rule)} ${esc(x.type)} vs ${esc(x.against)}`).join(' · ')}</p>` : ''}
      <div class="acts"></div></div></div>`);
    const done = (fn) => () => { ov.remove(); popLayer(); fn(); };
    const items = [btn('Play again', done(() => app.onRestart()), 'ac'), btn('Back to setup', done(() => app.onQuit('setup'))), btn('Title screen', done(() => app.onQuit('title')))];
    items.forEach((i) => ov.querySelector('.acts').appendChild(i.el)); $ov.appendChild(ov);
    pushLayer({ items, horizontal: true, back: () => items[1].activate() });
  }

  return {
    show, showPick: () => show('pick'), showHome: () => { hist.length = 0; show('home'); }, showSetup: () => show('setup'),
    showHUD: (on, def) => { $hud.hidden = !on; document.body.classList.toggle('nogui', !!st.hideGui); if (on && def) { hintDef = def; hintDev = null; setHints(def, lastHud.device || 'kb'); } if (!on) { $toasts.innerHTML = ''; countdown(null); } },
    updateHUD, showStats, showBreakdown, toast, countdown, showPause, hidePause: () => closePause(), showResults,
    menuOpen: () => stack.length > 0,
    error: (msg) => { const e = h(`<div class="err">${esc(msg)}</div>`); (screens.pick || document.body).appendChild(e); },
    refreshRobots,
  };
}
