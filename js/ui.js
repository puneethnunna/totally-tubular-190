// Screens, HUD, toasts, results. Keyboard-navigable "layers" (↑↓ move, ←→ adjust, Enter select, Esc back).
import { SIDES, ROBOT_PRESETS, ROBOT, FIELD, DEFAULT_TEAMS, POINTS, TIMING, RP, TUBE, opponent, inRect } from './config.js';

const KEY = 'tt-settings';
export const DEFAULTS = { quality: 'high', camera: 'driver', fieldRelative: true, autoHP: true, team: '', difficulty: 'normal', midfield: 8 };
export const loadSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; } };
export const saveSettings = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const hint = (...p) => `<div class="foot">${p.map(([k, t]) => `<span class="hint"><b>${k}</b>${t}</span>`).join('')}</div>`;
const pad2 = (n) => String(n).padStart(2, '0');

// Legal start for a robot's centre: bumpers inside own SCORING ZONE, outside own LEVEL 1 area (G109).
export function clampStart(alliance, x, z) {
  const S = SIDES[alliance], R = ROBOT.outer / 2, zn = S.scoringZone, f = S.floorArea;
  x = Math.max(zn.x0 + R, Math.min(zn.x1 - R, x)); z = Math.max(zn.z0 + R, Math.min(zn.z1 - R, z));
  if (x > f.x0 - R && x < f.x1 + R && z > f.z0 - R && z < f.z1 + R) x = f.x0 > zn.x0 ? f.x0 - R : f.x1 + R;
  return { x, z };
}

export function createUI(app) {
  const $ui = document.getElementById('ui'), $ov = document.getElementById('overlay'), $hud = document.getElementById('hud');
  const $toasts = document.getElementById('toasts'), $cd = document.getElementById('countdown');
  const st = app.settings;
  const save = () => { saveSettings(st); app.onSettings?.(); };

  // ---------- layer / focus engine ----------
  const stack = [];
  const top = () => stack[stack.length - 1];
  function focus(L, i) {
    L.i = (i + L.items.length) % L.items.length;
    L.items.forEach((it, k) => it.el.classList.toggle('focus', k === L.i));
    L.items[L.i].el.scrollIntoView?.({ block: 'nearest' });
  }
  function reg(items) {
    for (const it of items) {
      if (it.bound) continue; it.bound = true;
      it.el.addEventListener('click', (e) => {
        const L = stack.find((l) => l.items.includes(it)); if (!L) return;
        focus(L, L.items.indexOf(it));
        if (!e.target.closest('.chip,input,button.sub')) it.activate?.();
      });
      it.el.addEventListener('mouseenter', () => { const L = top(); if (L?.items.includes(it)) focus(L, L.items.indexOf(it)); });
    }
  }
  const pushLayer = (L) => { reg(L.items); L.i = L.i ?? 0; stack.push(L); focus(L, L.i); return L; };
  const popLayer = () => { stack.pop(); const t = top(); if (t) focus(t, t.i); };
  addEventListener('keydown', (e) => {
    const L = top(); if (!L) return;
    if (e.target?.tagName === 'INPUT') { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); return; }
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

  // ---------- builders ----------
  const chipsRow = (label, opts, get, set, cls = '') => {
    const el = h(`<div class="card row"><span class="lab">${label}</span><div class="chips">${opts.map((o, i) => `<button class="chip ${o.c || ''}" data-i="${i}">${o.t}</button>`).join('')}</div></div>`);
    const paint = () => el.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('sel', opts[i].v === get()));
    const step = (d) => { const i = opts.findIndex((o) => o.v === get()); set(opts[(i + d + opts.length) % opts.length].v); paint(); };
    el.querySelectorAll('.chip').forEach((c, i) => c.addEventListener('click', () => { set(opts[i].v); paint(); }));
    paint(); return { el, adjust: step, activate: () => step(1), paint };
  };
  const btn = (label, fn, cls = '') => { const el = h(`<button class="btn ${cls}">${label}</button>`); return { el, activate: fn }; };
  const screens = {};
  const mkScreen = (name, html) => { const el = h(`<div class="screen ${name}">${html}</div>`); $ui.appendChild(el); screens[name] = el; return el; };
  const hist = [];
  let cur = null;
  function show(name, push = true) {
    if (cur && push && cur !== name) hist.push(cur);
    cur = name; stack.length = 0; $ov.innerHTML = '';
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('on', k === name));
    ({ home: homeLayer, setup: setupLayer, rules: rulesLayer, settings: settingsLayer })[name]?.();
  }
  const goBack = () => { const p = hist.pop() || 'home'; show(p, false); };

  // ---------- home ----------
  const homeEl = mkScreen('home', `<div class="wrap"><div class="kicker">FRC MOCK GAME SIMULATOR</div><h1>TOTALLY<br><span>TUBULAR</span></h1><ul class="menu"></ul></div>${hint(['↑↓', 'Move'], ['Enter', 'Select'], ['Esc', 'Back'])}<div class="errbox"></div>`);
  const homeItems = [['SINGLEPLAYER', () => openSetup('single')], ['LOCAL 2-PLAYER', () => openSetup('local')], ['RULES', () => show('rules')], ['CONTROLS / SETTINGS', () => show('settings')]]
    .map(([t, fn], i) => { const el = h(`<li class="mi"><span class="n">0${i + 1}</span>${t}</li>`); homeEl.querySelector('.menu').appendChild(el); return { el, activate: fn }; });
  const homeLayer = () => pushLayer({ items: homeItems, i: 0 });

  // ---------- setup ----------
  const S = { mode: 'single', preset: 0, p2preset: 1, alliance: 'blue', same: false, diff: st.difficulty, mid: st.midfield, start: null, team: st.team || '' };
  const setupEl = mkScreen('setup', `
    <div class="head"><h2 class="ttl">Singleplayer</h2><div class="sub">Pick a robot, an alliance and a starting spot.</div></div>
    <div class="cols"><div class="left"></div>
      <div class="card right"><span class="lab">Starting spot</span><div class="mapwrap"><canvas id="spot"></canvas></div>
        <div class="pc">Drag your robot inside your SCORING ZONE (outside the LEVEL 1 area, G109). Hold <span class="kbd">J</span> / <span class="kbd">L</span> to rotate.</div></div></div>
    <div class="bar"></div>${hint(['↑↓', 'Move'], ['←→', 'Adjust'], ['Enter', 'Select'], ['J / L', 'Rotate robot'], ['Esc', 'Back'])}`);
  const left = setupEl.querySelector('.left'), bar = setupEl.querySelector('.bar'), cv = setupEl.querySelector('#spot');
  const robotCard = (label, getI, setI, withTeam) => {
    const el = h(`<div class="card row"><span class="lab">${label}</span><div class="robotc"><div class="info">${withTeam ? '<input class="team" maxlength="5" placeholder="Team #" inputmode="numeric">' : '<div class="tn hf"></div>'}<div class="nm"></div><p></p><div class="tags"></div></div><button class="btn sub">Change</button></div></div>`);
    const paint = () => {
      const p = ROBOT_PRESETS[getI()];
      el.querySelector('.nm').textContent = p.name; el.querySelector('p').textContent = p.blurb;
      el.querySelector('.tags').innerHTML = [p.drive, `${p.maxSpeed} m/s`, p.canUpper ? 'upper' : p.canLower ? 'lower' : '', p.canLaunch ? 'launcher' : '', `climb L${p.maxClimb}`].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join('');
    };
    const pick = () => openPicker(getI(), (i) => { setI(i); paint(); drawMap(); });
    el.querySelector('.sub').addEventListener('click', pick);
    const ti = el.querySelector('input'); if (ti) { ti.value = S.team; ti.addEventListener('input', () => { S.team = ti.value.replace(/\D/g, ''); ti.value = S.team; st.team = S.team; saveSettings(st); }); }
    paint(); return { el, paint, activate: pick, adjust: (d) => { setI((getI() + d + ROBOT_PRESETS.length) % ROBOT_PRESETS.length); paint(); }, tn: el.querySelector('.tn') };
  };
  const rowRobot = robotCard('Your robot', () => S.preset, (i) => (S.preset = i), true);
  const rowP2 = robotCard('Player 2 robot', () => S.p2preset, (i) => (S.p2preset = i), false);
  const rowSame = chipsRow('Player 2 alliance', [{ v: false, t: 'Opposing' }, { v: true, t: 'Same as P1' }], () => S.same, (v) => { S.same = v; drawMap(); });
  const resetStart = () => { S.start = { ...SIDES[S.alliance].starts[0] }; drawMap(); };
  const rowAlli = chipsRow('Alliance', [{ v: 'blue', t: 'Blue', c: 'blue' }, { v: 'red', t: 'Red', c: 'red' }], () => S.alliance, (v) => { S.alliance = v; resetStart(); paintTeam(); });
  const rowDiff = chipsRow('Bot difficulty', [{ v: 'easy', t: 'Easy' }, { v: 'normal', t: 'Normal' }, { v: 'hard', t: 'Hard' }], () => S.diff, (v) => { S.diff = v; st.difficulty = v; saveSettings(st); });
  const midEl = h(`<div class="card row"><span class="lab">Midfield tubes staged (per alliance, 0-8)</span><div class="step"><button class="btn sub">−</button><b></b><button class="btn sub">+</button></div></div>`);
  const setMid = (d) => { S.mid = Math.max(0, Math.min(8, S.mid + d)); midEl.querySelector('b').textContent = S.mid; st.midfield = S.mid; saveSettings(st); };
  midEl.querySelectorAll('.btn').forEach((b, i) => b.addEventListener('click', () => setMid(i ? 1 : -1)));
  const rowMid = { el: midEl, adjust: setMid, activate: () => setMid(S.mid >= 8 ? -8 : 1) };
  const rowReset = btn('Reset spot', resetStart);
  const bBack = btn('Back', () => goBack()), bRules = btn('Rules', () => show('rules')), bSet = btn('Settings', () => show('settings')), bStart = btn('Start match', () => startMatch(), 'ac');
  const sp = h('<span class="sp"></span>');
  [bBack, bRules, bSet].forEach((b) => bar.appendChild(b.el)); bar.appendChild(sp); bar.appendChild(bStart.el);
  [rowRobot, rowP2, rowSame, rowAlli, rowDiff, rowMid].forEach((r) => left.appendChild(r.el)); left.appendChild(rowReset.el);
  const paintTeam = () => { rowRobot.el.querySelector('input').placeholder = DEFAULT_TEAMS[S.alliance][0]; };

  function openSetup(mode) {
    S.mode = mode; const two = mode === 'local';
    setupEl.querySelector('.ttl').textContent = two ? 'Local 2-Player' : 'Singleplayer';
    rowP2.el.style.display = rowSame.el.style.display = two ? '' : 'none';
    if (two && S.preset === S.p2preset) S.p2preset = (S.preset + 1) % ROBOT_PRESETS.length;
    rowP2.paint(); S.start = null; show('setup');
  }
  const setupLayer = () => {
    const two = S.mode === 'local';
    const items = [rowRobot, ...(two ? [rowP2, rowSame] : []), rowAlli, rowDiff, rowMid, rowReset, bBack, bRules, bSet, bStart];
    if (!S.start) S.start = { ...SIDES[S.alliance].starts[0] };
    paintTeam(); rowMid.el.querySelector('b').textContent = S.mid; [rowAlli, rowDiff, rowSame].forEach((r) => r.paint());
    pushLayer({ items, i: items.length - 1, back: goBack, onKey: (e) => {
      if (e.key === 'j' || e.key === 'J' || e.key === 'l' || e.key === 'L') { S.start.heading = (S.start.heading || 0) + (e.key.toLowerCase() === 'l' ? 0.15 : -0.15); drawMap(); return true; }
    } });
    requestAnimationFrame(drawMap);
  };
  function startMatch() {
    const t = S.start;
    app.onStart({ mode: S.mode, preset: ROBOT_PRESETS[S.preset], p2preset: ROBOT_PRESETS[S.p2preset], alliance: S.alliance, sameAlliance: S.same, difficulty: S.diff,
      midfield: S.mid, start: { x: t.x, z: t.z, heading: t.heading }, team: S.team || DEFAULT_TEAMS[S.alliance][0] });
  }
  function openPicker(sel, done) {
    let i = sel; const grid = h('<div class="pick"></div>');
    const items = ROBOT_PRESETS.map((p, k) => {
      const el = h(`<div class="card"><div class="nm hf" style="font-size:24px">${esc(p.name)}</div><p class="sub">${esc(p.blurb)}</p><div class="tags robotc"><span class="tag">${p.drive}</span><span class="tag">${p.maxSpeed} m/s</span><span class="tag">climb L${p.maxClimb}</span></div></div>`);
      grid.appendChild(el); return { el, activate: () => { close(); done(k); } };
    });
    const ov = h(`<div class="ov"><div class="panel"><h2>Choose robot</h2></div></div>`); ov.firstChild.appendChild(grid);
    ov.firstChild.appendChild(h(hint(['←→', 'Move'], ['Enter', 'Pick'], ['Esc', 'Cancel'])));
    $ov.appendChild(ov);
    const close = () => { ov.remove(); popLayer(); };
    pushLayer({ items, i, horizontal: true, back: close });
  }

  // 2D start map
  const wx = (g, x) => g.ox + (x + FIELD.halfL) * g.s, wz = (g, z) => g.oy + (z + FIELD.halfW) * g.s;
  const geom = () => { const w = cv.clientWidth, hh = cv.clientHeight, s = Math.min((w - 20) / FIELD.length, (hh - 20) / FIELD.width); return { w, hh, s, ox: (w - s * FIELD.length) / 2, oy: (hh - s * FIELD.width) / 2 }; };
  function drawMap() {
    if (!S.start || !cv.clientWidth) return;
    const dpr = devicePixelRatio || 1; cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = geom(), R = (r, fill, stroke, dash) => { c.beginPath(); c.rect(wx(g, r.x0), wz(g, r.z0), (r.x1 - r.x0) * g.s, (r.z1 - r.z0) * g.s); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.setLineDash(dash || []); c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke(); c.setLineDash([]); } };
    R({ x0: -FIELD.halfL, x1: FIELD.halfL, z0: -FIELD.halfW, z1: FIELD.halfW }, '#181818', '#555');
    c.font = `700 ${Math.max(9, g.s * 0.28)}px system-ui`; c.textAlign = 'center';
    for (const a of ['blue', 'red']) {
      const Sd = SIDES[a], col = a === 'blue' ? '31,91,255' : '232,32,42', mine = a === S.alliance;
      R(Sd.scoringZone, `rgba(${col},${mine ? 0.16 : 0.07})`, `rgba(${col},.55)`, [5, 4]);
      R(Sd.loadingZone, `rgba(${col},.08)`, `rgba(${col},.35)`, [3, 4]);
      R(Sd.floorArea, `rgba(${col},.22)`, `rgba(${col},.8)`);
      R(Sd.platformZone, null, `rgba(${col},.35)`, [3, 3]); R(Sd.l1Area, `rgba(${col},.12)`, `rgba(${col},.6)`);
      Sd.platforms.forEach((p, i) => R(p, `rgba(${col},${0.25 + i * 0.15})`, `rgba(${col},.8)`));
      R(Sd.shortWall, '#aaa'); Sd.chutes.forEach((u) => { c.fillStyle = '#ffd23f'; c.fillRect(wx(g, u.x) - 3, wz(g, u.z) - 3, 6, 6); });
      Sd.posts.filter((p) => p.tier === 'lower').forEach((p) => { c.fillStyle = `rgb(${col})`; c.fillRect(wx(g, p.baseX) - 2, wz(g, p.z) - 3, 4, 6); });
      Sd.stagingRow.forEach((p) => { c.beginPath(); c.arc(wx(g, p.x), wz(g, p.z), g.s * 0.12, 0, 7); c.strokeStyle = '#ffd23f88'; c.stroke(); });
      c.fillStyle = `rgba(${col},.95)`;
      c.fillText(`${a.toUpperCase()} SCORING`, wx(g, (Sd.scoringZone.x0 + Sd.scoringZone.x1) / 2), wz(g, Sd.scoringZone.z1) - 6);
      c.fillText('L1 AREA', wx(g, (Sd.floorArea.x0 + Sd.floorArea.x1) / 2), wz(g, Sd.floorArea.z0) + g.s * 0.5);
      c.fillText(`${a.toUpperCase()} LOADING`, wx(g, (Sd.loadingZone.x0 + Sd.loadingZone.x1) / 2), wz(g, Sd.loadingZone.z1) - 6);
      c.fillText('PLATFORMS', wx(g, (Sd.platformZone.x0 + Sd.platformZone.x1) / 2), wz(g, Sd.platformZone.z1) + g.s * 0.4);
      c.fillText(`${a.toUpperCase()} DRIVERS`, wx(g, Sd.driverStationX < 0 ? -FIELD.halfL + 1.1 : FIELD.halfL - 1.1), wz(g, 3.3));
    }
    const sq = (x, z, hd, fill, stroke) => {
      c.save(); c.translate(wx(g, x), wz(g, z)); c.rotate(hd); const r = ROBOT.outer * g.s / 2;
      c.fillStyle = fill; c.strokeStyle = stroke; c.lineWidth = 2; c.fillRect(-r, -r, 2 * r, 2 * r); c.strokeRect(-r, -r, 2 * r, 2 * r);
      c.beginPath(); c.moveTo(0, 0); c.lineTo(r * 0.9, 0); c.moveTo(r * 0.5, -r * 0.3); c.lineTo(r * 0.9, 0); c.lineTo(r * 0.5, r * 0.3); c.strokeStyle = '#fff'; c.stroke(); c.restore();
    };
    const col = S.alliance === 'blue' ? '31,91,255' : '232,32,42';
    SIDES[S.alliance].starts.forEach((p) => sq(p.x, p.z, p.heading, 'rgba(255,255,255,.04)', 'rgba(255,255,255,.2)'));
    sq(S.start.x, S.start.z, S.start.heading || 0, `rgba(${col},.75)`, '#fff');
  }
  const mapPos = (e) => { const g = geom(), r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - g.ox) / g.s - FIELD.halfL, z: (e.clientY - r.top - g.oy) / g.s - FIELD.halfW }; };
  let drag = false;
  const moveTo = (e) => { const p = mapPos(e), q = clampStart(S.alliance, p.x, p.z); S.start.x = q.x; S.start.z = q.z; drawMap(); };
  cv.addEventListener('pointerdown', (e) => { drag = true; cv.setPointerCapture(e.pointerId); moveTo(e); });
  cv.addEventListener('pointermove', (e) => drag && moveTo(e));
  cv.addEventListener('pointerup', () => (drag = false));
  addEventListener('resize', () => cur === 'setup' && drawMap());

  // ---------- rules ----------
  const P = POINTS, T = TIMING;
  const rulesEl = mkScreen('rules', `<div class="head"><h2>Rules</h2><div class="sub">TOTALLY TUBULAR — condensed from the game manual (Draft 0.10)</div></div><div class="page">
  <p>Two alliances of three robots score identical tubes on the floor and on two tiers of eight posts, then finish on elevated platforms. ${TUBE.perAlliance} tubes per alliance: staged midfield tubes (0-8), one preload per robot, the rest are fed by your human player from the loading station.</p>
  <h3>Match phases</h3><table><tr><th>Phase</th><th class="n">Time</th><th>Notes</th></tr>
  <tr><td>AUTO</td><td class="n">${T.auto}s</td><td>No human-player tubes, no entering either LOADING ZONE, tubes score double. No contact with opponents once fully past center.</td></tr>
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
  const page = (el) => el.querySelector('.page');
  const rulesLayer = () => pushLayer({ items: [{ el: h('<i></i>') }], back: goBack, onKey: (e) => { const d = { ArrowDown: 60, ArrowUp: -60, PageDown: 400, PageUp: -400 }[e.key]; if (d) { page(rulesEl).scrollBy(0, d); return true; } } });

  // ---------- settings / controls ----------
  const keyRows = (rows) => `<table><tr><th>Action</th><th>Player 1</th><th>Player 2 (local)</th><th>Gamepad</th></tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  const setEl = mkScreen('settings', `<div class="head"><h2>Controls / Settings</h2></div><div class="page"><div class="opts"></div>
  <h3>Controls</h3>${keyRows([
    ['Drive (swerve)', 'W A S D (up = away from your driver station)', '↑ ← ↓ →', 'Left stick'],
    ['Drive (tank)', 'W / S throttle, A / D turn', '↑ / ↓, ← / →', 'Left stick'],
    ['Rotate', 'Q / E or ← / →', ', / .', 'Right stick X'],
    ['Intake (hold)', 'Space or Shift', '/', 'RT'], ['Score lower post', '1 or U', 'K', 'A'], ['Score upper post', '2 or I', 'L', 'Y'],
    ['Drop on floor', '3 or F', ';', 'B'], ['Launch', 'R', "'", 'X'], ['Climb (hold, ENDGAME)', 'G', 'P', 'LB'],
    ['Request human-player tube', 'H', 'O', 'RB'], ['Camera / Pause', 'C / Esc', 'C / Esc', '- / Start']])}
  <p class="sub">In chase camera mode, movement is relative to the robot. Menus: ↑↓ move, ←→ adjust, Enter select, Esc back.</p></div>${hint(['↑↓', 'Move'], ['←→', 'Change'], ['Esc', 'Back'])}`);
  const optRows = [
    chipsRow('Graphics quality', [{ v: 'low', t: 'Low' }, { v: 'high', t: 'High' }], () => st.quality, (v) => { st.quality = v; save(); }),
    chipsRow('Default camera', [{ v: 'driver', t: 'Driver' }, { v: 'chase', t: 'Chase' }, { v: 'top', t: 'Top' }], () => st.camera, (v) => { st.camera = v; save(); }),
    chipsRow('Field-relative driving', [{ v: true, t: 'On' }, { v: false, t: 'Off' }], () => st.fieldRelative, (v) => { st.fieldRelative = v; save(); }),
    chipsRow('Human player auto-feed', [{ v: true, t: 'On' }, { v: false, t: 'Off (press H)' }], () => st.autoHP, (v) => { st.autoHP = v; save(); }),
  ];
  const sBack = btn('Back', () => goBack());
  optRows.forEach((r) => { r.el.style.marginBottom = '8px'; setEl.querySelector('.opts').appendChild(r.el); }); setEl.querySelector('.opts').appendChild(sBack.el);
  const settingsLayer = () => { optRows.forEach((r) => r.paint()); pushLayer({ items: [...optRows, sBack], back: goBack }); };

  // ---------- HUD ----------
  $hud.innerHTML = `<div class="sbw"><div class="sb"><div class="sbox red" id="rs">0</div><div class="sclk"><div class="t" id="clk">2:05</div><div class="ph" id="ph">READY</div></div><div class="sbox blue" id="bs">0</div></div>
    <div class="chips2"><div id="rc"></div><div id="bc"></div></div></div>
    <div class="bl"><div class="tubes"><div class="tube"></div><div class="tube"></div></div><div class="pn" id="pn"></div><div class="pl" id="pl"></div><div class="prog"><i id="pg"></i></div></div>
    <div class="br"><div class="hf" id="cam" style="font-size:16px;color:var(--ac)"></div><div class="hints" id="hints"></div></div>`;
  const $ = (id) => $hud.querySelector('#' + id);
  const chips = (sc, a) => {
    if (!sc) return '';
    const pp = sc.platform?.points ?? 0, fp = sc.fullPosts ?? 0;
    return `<span class="c2 ${fp >= 8 ? 'lit' : ''}">POSTS ${fp}/16</span><span class="c2 ${pp >= 16 ? 'lit' : ''}">PLAT ${pp}</span>`;
  };
  const PHL = { pre: 'READY', auto: 'AUTO', teleop: 'TELEOP', endgame: 'ENDGAME', post: 'ASSESSING', done: 'FINAL' };
  function setHints(preset) {
    const k = (a, b) => `<span><span class="kbd">${a}</span>${b}</span>`;
    $('hints').innerHTML = [preset.drive === 'tank' ? k('W/S', 'drive') + k('A/D', 'turn') : k('WASD', 'move') + k('Q/E', 'rotate'), k('Space', 'intake'), k('1', 'lower'), preset.canUpper ? k('2', 'upper') : '', k('3', 'drop'),
      preset.canLaunch ? k('R', 'launch') : '', k('G', 'climb'), k('H', 'tube'), k('C', 'camera'), k('Esc', 'pause')].join('');
    $('pn').textContent = preset.name;
  }
  function updateHUD(d) {
    const { match, score, me, camera } = d;
    const rem = Math.max(0, Math.ceil(match?.remaining ?? 0));
    $('clk').textContent = `${Math.floor(rem / 60)}:${pad2(rem % 60)}`;
    const ph = $('ph'); ph.textContent = PHL[match?.phase] || ''; ph.classList.toggle('endgame', match?.phase === 'endgame');
    $('rs').textContent = score?.red?.total ?? 0; $('bs').textContent = score?.blue?.total ?? 0;
    $('rc').innerHTML = chips(score?.red); $('bc').innerHTML = chips(score?.blue);
    const held = me?.held?.length ?? 0;
    $hud.querySelectorAll('.tube').forEach((t, i) => t.classList.toggle('on', i < held));
    const a = me?.action; $('pg').style.width = a && a.duration ? `${Math.min(100, (100 * a.t) / a.duration)}%` : '0%'; $('pl').textContent = a ? a.type.toUpperCase() : '';
    $('cam').textContent = `CAMERA: ${camera.toUpperCase()}`;
  }

  // ---------- toasts / countdown ----------
  function toast(text, o = {}) {
    const el = h(`<div class="toast ${o.alliance || ''} ${o.foul ? 'foul' : ''}">${o.tag ? `<b>${esc(o.tag)}</b>` : ''}${esc(text)}</div>`);
    $toasts.appendChild(el); while ($toasts.children.length > 6) $toasts.firstChild.remove();
    setTimeout(() => el.classList.add('out'), o.ms || 3800); setTimeout(() => el.remove(), (o.ms || 3800) + 450);
  }
  let lastCd = null;
  function countdown(v) {
    if (v == null) { $cd.hidden = true; lastCd = null; return; }
    $cd.hidden = false; if (v !== lastCd) { $cd.innerHTML = `<span>${v}</span>`; lastCd = v; }
  }

  // ---------- pause / results ----------
  function showPause() {
    const camEl = h('<div class="mi">Camera: <span class="cv" style="margin-left:8px;color:inherit"></span></div>');
    const paint = () => (camEl.querySelector('.cv').textContent = app.getCamera().toUpperCase());
    const mk = (t, fn) => ({ el: h(`<div class="mi">${t}</div>`), activate: fn });
    const items = [mk('Resume', () => resume()), mk('Restart', () => { close(); app.onRestart(); }), { el: camEl, activate: () => { app.onCamera(1); paint(); }, adjust: (d) => { app.onCamera(d); paint(); } }, mk('Quit to menu', () => { close(); app.onQuit(); })];
    const panel = h('<div class="ov"><div class="panel"><h2>Paused</h2></div></div>'); items.forEach((i) => panel.firstChild.appendChild(i.el));
    panel.firstChild.appendChild(h(hint(['↑↓', 'Move'], ['Enter', 'Select'], ['Esc', 'Resume'])));
    $ov.appendChild(panel); paint();
    const close = () => { panel.remove(); if (top()?.pause) popLayer(); };
    const resume = () => { close(); app.onResume(); };
    pushLayer({ items, pause: true, back: resume });
    hidePause = close;
  }
  let hidePause = () => {};
  function showResults(f, fouls = []) {
    const B = f.blue || {}, R = f.red || {}, g = (o, ...p) => p.reduce((a, k) => a?.[k], o) ?? 0;
    const tp = (n, per) => `${n} <span class="sub">(${n * per})</span>`;
    const rows = [['AUTO floor', 'auto', 'floor', P.floor.auto], ['AUTO lower', 'auto', 'lower', P.lower.auto], ['AUTO upper', 'auto', 'upper', P.upper.auto],
      ['TELEOP floor', 'teleop', 'floor', P.floor.teleop], ['TELEOP lower', 'teleop', 'lower', P.lower.teleop], ['TELEOP upper', 'teleop', 'upper', P.upper.teleop]]
      .map(([l, ph, k, per]) => `<tr><td>${l}</td><td class="n b">${tp(g(B, ph, k), per)}</td><td class="n r">${tp(g(R, ph, k), per)}</td></tr>`).join('');
    const lv = (o) => (o?.platform?.levels || []).map((l) => (l ? `L${l}` : '—')).join(' ') || '-';
    const w = g(B, 'total') > g(R, 'total') ? 'blue' : g(R, 'total') > g(B, 'total') ? 'red' : 'tie';
    const ov = h(`<div class="ov"><div class="panel res"><div class="win ${w}">${w === 'tie' ? 'TIE MATCH' : w.toUpperCase() + ' ALLIANCE WINS'}</div>
      <table><tr><th>Category</th><th class="n b">Blue</th><th class="n r">Red</th></tr>${rows}
      <tr><td>Platform points</td><td class="n b">${g(B, 'platform', 'points')}</td><td class="n r">${g(R, 'platform', 'points')}</td></tr>
      <tr><td>Fouls received (foul / tech)</td><td class="n b">${g(B, 'fouls', 'points')} <span class="sub">(${g(B, 'fouls', 'foul')} / ${g(B, 'fouls', 'tech')})</span></td><td class="n r">${g(R, 'fouls', 'points')} <span class="sub">(${g(R, 'fouls', 'foul')} / ${g(R, 'fouls', 'tech')})</span></td></tr>
      <tr><td>Full posts</td><td class="n b">${g(B, 'fullPosts')}/16</td><td class="n r">${g(R, 'fullPosts')}/16</td></tr>
      <tr class="tot"><td>TOTAL</td><td class="n b">${g(B, 'total')}</td><td class="n r">${g(R, 'total')}</td></tr>
      <tr><td>Ranking points (win ${g(B, 'rp', 'win')}/${g(R, 'rp', 'win')}, posts ${g(B, 'rp', 'posts8') + g(B, 'rp', 'posts12')}/${g(R, 'rp', 'posts8') + g(R, 'rp', 'posts12')}, platform ${g(B, 'rp', 'platform16')}/${g(R, 'rp', 'platform16')})</td><td class="n b">${g(B, 'rp', 'total')} RP</td><td class="n r">${g(R, 'rp', 'total')} RP</td></tr></table>
      ${fouls.length ? `<p class="sub" style="margin:10px 0 0">Penalties: ${fouls.slice(0, 12).map((x) => `${esc(x.rule)} ${esc(x.type)} vs ${esc(x.against)}`).join(' · ')}</p>` : ''}
      <div class="acts"></div></div></div>`);
    const items = [btn('Play Again', () => { ov.remove(); popLayer(); app.onRestart(); }, 'ac'), btn('Menu', () => { ov.remove(); popLayer(); app.onQuit(); })];
    items.forEach((i) => ov.querySelector('.acts').appendChild(i.el)); $ov.appendChild(ov);
    pushLayer({ items, horizontal: true, back: () => items[1].activate() });
  }

  return {
    show, showHome: () => { hist.length = 0; show('home'); }, showHUD: (on, preset) => { $hud.hidden = !on; if (on && preset) setHints(preset); if (!on) { $toasts.innerHTML = ''; countdown(null); } },
    updateHUD, toast, countdown, showPause, hidePause: () => hidePause(), showResults,
    menuOpen: () => stack.length > 0,
    error: (msg) => { const e = h(`<div class="err">${esc(msg)}</div>`); homeEl.insertBefore(e, homeEl.querySelector('.foot')); },
  };
}
