import * as THREE from 'three';
import { ROBOT_PRESETS } from './config.js';
import { parseSTL, prepareRobotMeshData, geometryFromData } from './stlImport.js';
import { buildPreset, saveImportedRobot, setMeshGeometry } from './robots.js';
import { createRobotPreview } from './preview3d.js';

const CSS = `
.tt-import{--paper:#0b0d11;--surface:#161616;--sunk:#232323;--ink:#eae8e3;--ink-2:#a8a8a8;--ink-3:#717171;--line:#ffffff14;--line-strong:#ffffff26;--blue:#3d84fa;--red:#f14445;--gold:#f0c13e;
position:fixed;inset:0;z-index:1000;background:var(--paper);color:var(--ink);font:600 13px/1.4 "Mona Sans",system-ui,sans-serif;display:flex;flex-direction:column;overflow:hidden}
.tt-import *{box-sizing:border-box}
.tt-import h1{margin:22px 0 14px;text-align:center;font-weight:800;font-stretch:75%;text-transform:uppercase;font-size:44px;letter-spacing:.01em}
.tt-import .main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(320px,1fr);gap:18px;padding:0 28px 18px;max-width:1200px;width:100%;margin:0 auto;overflow:auto}
.tt-import .card{background:var(--surface);border:1px solid var(--line);border-radius:10px}
.tt-import .stage{position:relative;min-height:340px;display:flex;flex-direction:column;overflow:hidden}
.tt-import .view{flex:1;position:relative;min-height:280px}
.tt-import .drop{position:absolute;inset:14px;border:2px dashed var(--line-strong);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;color:var(--ink-2);cursor:pointer;transition:.15s}
.tt-import .drop b{font-size:22px;font-weight:800;font-stretch:75%;text-transform:uppercase;color:var(--ink)}
.tt-import.drag .drop,.tt-import .drop:hover{border-color:var(--gold);background:#f0c13e0d}
.tt-import .drop.hide{display:none}
.tt-import .bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--line);color:var(--ink-2);font-size:12px;flex-wrap:wrap}
.tt-import .bar .sp{flex:1}
.tt-import .drop,.tt-import .msg,.tt-import .prog{z-index:1}
.tt-import .prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--gold);transform-origin:left;transform:scaleX(0);transition:transform .2s}
.tt-import .msg{position:absolute;left:14px;top:12px;font-size:12px;color:var(--ink-2);pointer-events:none}
.tt-import .panel{padding:16px;display:flex;flex-direction:column;gap:12px;align-content:start}
.tt-import .sec{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin-top:2px}
.tt-import .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tt-import label{display:flex;flex-direction:column;gap:4px;color:var(--ink-2);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.tt-import label.chk{flex-direction:row;align-items:center;gap:8px;text-transform:none;font-size:13px;color:var(--ink);letter-spacing:0}
.tt-import input[type=text],.tt-import input[type=number],.tt-import select{background:var(--sunk);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:8px 9px;font:inherit;font-size:14px;width:100%;text-transform:none;letter-spacing:0}
.tt-import input:focus,.tt-import select:focus{outline:none;border-color:var(--gold)}
.tt-import input.bad{border-color:var(--red)}
.tt-import input[type=checkbox]{accent-color:var(--gold);width:16px;height:16px}
.tt-import .seg{display:flex;gap:0;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.tt-import .seg button{flex:1;background:var(--sunk);color:var(--ink-2);border:0;padding:7px 8px;font:inherit;font-size:12px;cursor:pointer}
.tt-import .seg button.on{background:var(--gold);color:#111}
.tt-import .warn{background:#f1444520;border:1px solid #f1444566;color:#ffb3b3;border-radius:6px;padding:8px 10px;font-size:12px;display:none}
.tt-import .warn.show{display:block}
.tt-import .btn{font:800 15px "Mona Sans",system-ui,sans-serif;font-stretch:75%;text-transform:uppercase;border-radius:8px;padding:14px 34px;cursor:pointer;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink)}
.tt-import .btn.go{background:var(--gold);color:#111;border-color:var(--gold);min-width:260px}
.tt-import .btn:disabled{opacity:.35;cursor:not-allowed}
.tt-import .foot{display:flex;justify-content:space-between;padding:14px 28px;border-top:1px solid var(--line);background:#0b0d11}
.tt-import .link{background:none;border:0;color:var(--gold);font:inherit;cursor:pointer;padding:0}
@media(max-width:820px){.tt-import .main{grid-template-columns:1fr}.tt-import h1{font-size:30px}}
`;

const $ = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const IN = 39.3701, FT = 3.28084;

export function openImportDialog(hostEl = document.body) {
  return new Promise((resolve) => {
    if (!document.getElementById('tt-import-css')) { const s = document.createElement('style'); s.id = 'tt-import-css'; s.textContent = CSS; document.head.appendChild(s); }
    const tplOpts = ROBOT_PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    const root = $(`<div class="tt-import" role="dialog" aria-label="Import robot">
      <h1>Import your robot</h1>
      <div class="main">
        <div class="card stage">
          <div class="view"><div class="drop"><b>Drop your robot .STL here</b><span>or click to choose a file. Binary or ASCII, mm / in / m, Z-up or Y-up.</span></div>
            <div class="msg"></div><div class="prog"></div></div>
          <div class="bar"><span class="info">No file loaded</span><span class="sp"></span>
            <span class="seg alli"><button data-a="blue" class="on">BLUE</button><button data-a="red">RED</button></span>
            <button class="link again" style="display:none">CHOOSE ANOTHER FILE</button></div>
        </div>
        <div class="card panel">
          <div class="sec">Orientation</div>
          <div class="row"><label>Units<select name="units"><option value="auto">Auto-detect</option><option value="mm">Millimeters</option><option value="in">Inches</option><option value="m">Meters</option></select></label>
            <label>Up axis<span class="seg up"><button data-u="z" class="on">Z UP</button><button data-u="y">Y UP</button></span></label></div>
          <div class="row"><label>Front direction<span class="seg"><button class="rot">ROTATE 90&deg; <span class="deg">(0&deg;)</span></button></span></label><label class="size"><span>Detected size</span><span class="sz" style="font-size:14px;color:var(--ink);text-transform:none">&mdash;</span></label></div>
          <div class="warn"></div>
          <div class="sec">Robot</div>
          <div class="row"><label>Team number<input type="text" name="number" maxlength="5" inputmode="numeric" placeholder="e.g. 1234"></label><label>Robot name<input type="text" name="name" maxlength="28" placeholder="e.g. Tubey"></label></div>
          <label>Team name<input type="text" name="team" maxlength="40" placeholder="e.g. The Tube Crew"></label>
          <div class="sec">Abilities</div>
          <div class="row"><label>Template<select name="tpl">${tplOpts}</select></label><label>Drivetrain<select name="drive"><option value="swerve">Swerve</option><option value="tank">Tank</option></select></label></div>
          <div class="row"><label>Max speed (ft/s)<input type="number" name="speed" min="2" max="25" step="0.5"></label><label>Max climb level<select name="climb"><option value="1">LEVEL 1</option><option value="2">LEVEL 2</option><option value="3">LEVEL 3</option><option value="4">LEVEL 4</option></select></label></div>
          <div class="row"><label class="chk"><input type="checkbox" name="upper"> Can reach upper posts</label><label class="chk"><input type="checkbox" name="launch"> Can launch tubes</label></div>
        </div>
      </div>
      <div class="foot"><button class="btn cancel">Cancel</button><button class="btn go" disabled>Save robot</button></div>
      <input type="file" accept=".stl,model/stl" hidden>
    </div>`);
    const q = (s) => root.querySelector(s), f = (n) => root.querySelector(`[name=${n}]`);
    hostEl.appendChild(root);

    const view = q('.view'), drop = q('.drop'), msg = q('.msg'), prog = q('.prog'), fileIn = q('input[type=file]'), goBtn = q('.go');
    const preview = createRobotPreview(view);
    let raw = null, rawTris = 0, data = null, alliance = 'blue', busy = 0, fileName = '';
    const opts = { units: 'auto', upAxis: 'z', rotateY: 0 };

    const setProg = (v, text = '') => { prog.style.transform = `scaleX(${v})`; msg.textContent = text; };

    function applyTemplate() {
      const t = ROBOT_PRESETS.find((p) => p.id === f('tpl').value);
      f('drive').value = t.drive; f('speed').value = (t.maxSpeed * FT).toFixed(1); f('climb').value = t.maxClimb;
      f('upper').checked = t.canUpper; f('launch').checked = t.canLaunch;
    }

    function updateInfo() {
      if (!data) return;
      const x = data.footprint.x * IN, z = data.footprint.z * IN, h = data.height * IN, per = 2 * (x + z);
      q('.sz').textContent = `${x.toFixed(1)} × ${z.toFixed(1)} × ${h.toFixed(1)} in`;
      q('.info').textContent = `${fileName} · ${data.units.toUpperCase()} · ${data.triCount.toLocaleString()} tris${rawTris > data.triCount ? ` (from ${rawTris.toLocaleString()})` : ''}`;
      const w = q('.warn'), msgs = [];
      if (per > 120) msgs.push(`Frame perimeter is ${per.toFixed(0)} in; the limit is 120 in. You can still save, but this robot would not be legal in a real match.`);
      if (Math.max(x, z) > 60 || Math.max(x, z) < 12) msgs.push('The size looks odd for an FRC robot. Check the units setting.');
      if (h > 72) msgs.push(`Height is ${(h / 12).toFixed(1)} ft; check the up axis.`);
      w.textContent = msgs.join(' '); w.classList.toggle('show', !!msgs.length);
    }

    async function rebuild() {
      if (!raw) return;
      const my = ++busy;
      setProg(0.6, 'Processing…'); await tick();
      if (my !== busy) return;
      data = prepareRobotMeshData({ positions: raw }, opts);
      const geo = geometryFromData(THREE, data);
      setMeshGeometry('draft', geo);
      await preview.show({ number: f('number').value || '', preset: { id: 'stacker', model: { kind: 'mesh', meshId: 'draft', footprint: data.footprint, height: data.height } } }, alliance);
      if (my !== busy) return;
      setProg(0); updateInfo(); validate();
    }

    async function load(file) {
      if (!file) return;
      if (!/\.stl$/i.test(file.name)) { setProg(0, 'Please choose an .stl file.'); return; }
      try {
        fileName = file.name;
        setProg(0.15, 'Reading file…'); await tick();
        const buf = await file.arrayBuffer();
        setProg(0.35, 'Parsing…'); await tick();
        const p = parseSTL(buf);
        if (!p.triCount) throw new Error('No triangles found');
        raw = p.positions; rawTris = p.triCount;
        drop.classList.add('hide'); q('.again').style.display = '';
        if (!f('name').value) f('name').value = file.name.replace(/\.stl$/i, '').replace(/[_-]+/g, ' ').slice(0, 28);
        await rebuild();
      } catch (e) { setProg(0, 'Could not read that file: ' + e.message); }
    }

    function validate() {
      const ok = !!data && /^[0-9A-Za-z]{1,5}$/.test(f('number').value.trim()) && f('name').value.trim().length > 0;
      goBtn.disabled = !ok;
    }

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      preview.dispose(); root.remove(); resolve(result);
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); } };
    document.addEventListener('keydown', onKey, true);

    // events
    drop.onclick = q('.again').onclick = () => { fileIn.value = ''; fileIn.click(); };
    fileIn.onchange = () => load(fileIn.files[0]);
    for (const ev of ['dragenter', 'dragover']) root.addEventListener(ev, (e) => { e.preventDefault(); root.classList.add('drag'); });
    for (const ev of ['dragleave', 'drop']) root.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === root) root.classList.remove('drag'); });
    root.addEventListener('drop', (e) => load(e.dataTransfer.files[0]));
    f('units').onchange = () => { opts.units = f('units').value; rebuild(); };
    q('.up').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; opts.upAxis = b.dataset.u; q('.up').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); rebuild(); };
    q('.rot').onclick = () => { opts.rotateY = (opts.rotateY + 90) % 360; q('.deg').innerHTML = `(${opts.rotateY}&deg;)`; rebuild(); };
    q('.alli').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; alliance = b.dataset.a; q('.alli').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); if (data) rebuild(); };
    f('tpl').onchange = applyTemplate;
    for (const n of ['number', 'name']) f(n).oninput = () => { f(n).classList.remove('bad'); validate(); };
    f('number').onchange = () => { if (data) rebuild(); };
    q('.cancel').onclick = () => close(null);
    goBtn.onclick = async () => {
      if (!data) return;
      goBtn.disabled = true; goBtn.textContent = 'Saving…';
      const tpl = f('tpl').value, number = f('number').value.trim();
      const speed = Math.min(25, Math.max(2, +f('speed').value || 12)) / FT;
      const preset = buildPreset(tpl, {
        name: f('name').value.trim(), drive: f('drive').value, maxSpeed: +speed.toFixed(2),
        maxClimb: +f('climb').value, canUpper: f('upper').checked, canLower: true, canLaunch: f('launch').checked,
      });
      const def = { number, name: f('name').value.trim(), team: f('team').value.trim() || 'Independent', place: 'Imported STL', preset,
        stats: { sizeIn: { x: +(data.footprint.x * IN).toFixed(1), z: +(data.footprint.z * IN).toFixed(1), y: +(data.height * IN).toFixed(1) } } };
      try { close(await saveImportedRobot(def, data)); }
      catch (e) { goBtn.textContent = 'Save robot'; goBtn.disabled = false; setProg(0, 'Save failed: ' + e.message); }
    };

    applyTemplate(); validate();
    f('number').focus();
  });
}
