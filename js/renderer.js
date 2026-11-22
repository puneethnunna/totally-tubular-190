import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SIDES, ROBOT, TUBE, FIELD } from './config.js';
import { buildField } from './field3d.js';
import { createRobotModel, getTubeAssets, LIFT } from './models.js';

const MAX_TUBES = 216;

// Driver-station centers (z) per alliance, slot 0..2 = left..right as that alliance's drivers see the field.
// Measured from the CAD's station dividers (blue end: dividers at z = -1.70, 0.14, 2.0, 3.84; red is the (x,z) mirror).
export const DRIVER_Z = { blue: [-0.78, 1.07, 2.92], red: [0.78, -1.07, -2.92] };
export const CAM = {
  driver: { dist: 0.4, eye: 1.75, fov: 62 },       // standing just behind the alliance wall at eye height, like frsim          // eye at x = -+(8.75 + dist), looking at (0, 0.5, 0)
  third: { back: 3.4, up: 4.2, lookAhead: 2.4, lookY: 0.2, fov: 60 },
  first: { fwd: 0.3, up: 0.75, pitch: 0.15, fov: 75 }, // pitch rad (~8.5 deg) downward
  top: { fov: 50 },
};
// exponential follow rates (1/s) per cameraFollow setting: [position, look-at]
// Driver-station tracking: look-at = lerp(field center, robot, w); fov narrows from NEAR to FAR as the robot gets farther.
export const TRACK = {
  fovNear: 58, fovFar: 32, distNear: 4, distFar: 18, maxFovSpeed: 18,   // deg, m, deg/s
  smooth: { w: 0.75, look: 2.6, fov: 2.2 }, tight: { w: 0.9, look: 7, fov: 5 }, locked: { w: 0.9, look: 0, fov: 5 },
};
const RATES = {
  smooth: { third: [3.2, 5], first: [12, 16], fixed: [4, 4] },
  tight: { third: [10, 14], first: [26, 30], fixed: [6, 6] },
};

export function createRenderer(canvas) {
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.05;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1f2330);
  scene.fog = new THREE.Fog(0x1f2330, 45, 120);
  // frsim-style dark sky gradient (top #0b0f16 -> horizon #27303f), unlit and unfogged
  const sky = new THREE.Mesh(new THREE.SphereGeometry(200, 24, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color('#171a24') }, hor: { value: new THREE.Color('#2a2e3a') } },
    vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 hor; varying float h; void main(){ gl_FragColor = vec4(mix(hor, top, pow(clamp(h,0.,1.), 0.55)), 1.);\n#include <colorspace_fragment>\n}',
  }));
  sky.renderOrder = -10; sky.frustumCulled = false; sky.name = 'sky'; scene.add(sky);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 250);
  camera.position.set(-12, 4.2, 1.1);

  // image-based lighting like frsim (RoomEnvironment) + one soft-shadow key light covering the whole field
  const pmrem = new THREE.PMREMGenerator(gl);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.9;
  scene.add(new THREE.HemisphereLight(0xe3ecff, 0x666a74, 0.9));      // sky fill + ground bounce (#4a4a4a)
  const fill = new THREE.DirectionalLight(0xd5e4ff, 0.5);            // cool fill from the opposite side, no shadow
  fill.position.set(9, 10, -7); scene.add(fill);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);              // key light
  sun.position.set(-6, 20, 8);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -12; sc.right = 12; sc.top = 8.5; sc.bottom = -8.5; sc.near = 4; sc.far = 50;
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.025; sun.shadow.radius = 4;
  scene.add(sun, sun.target);

  const field = buildField(scene);

  // tubes (instanced)
  const { geometry, material } = getTubeAssets();
  const tubes = new THREE.InstancedMesh(geometry, material, MAX_TUBES);
  tubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tubes.castShadow = tubes.receiveShadow = true; tubes.frustumCulled = false; tubes.count = 0;
  scene.add(tubes);

  const models = new Map(); // id -> { key, model }
  let driverTracking = true, mode = 'driver', alliance = 'blue', playerId = null, quality = 'high', slot = 0, follow = 'smooth';
  let fovRate = 6, trackRobot = false, init = true, last = performance.now(), fovTarget = CAM.driver.fov, hidden = false;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camUp = new THREE.Vector3(0, 1, 0);
  const tp = new THREE.Vector3(), tl = new THREE.Vector3(), tu = new THREE.Vector3(0, 1, 0);

  const Q = {
    flat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
    tmp: new THREE.Quaternion(), tmp2: new THREE.Quaternion(),
  };
  const Y = new THREE.Vector3(0, 1, 0), XAX = new THREE.Vector3(1, 0, 0), v3 = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), ZERO3 = new THREE.Vector3(1e-4, 1e-4, 1e-4), m4 = new THREE.Matrix4();

  // Driver view looks through the player's own driver-station panel (it is 2.7 m tall in the CAD), like a real driver over the wall.
  let ghosted = null;
  function ghostStation(a) {
    if (ghosted === a) return;
    const mats = field.cad?.userData?.mats; if (!mats) return;
    for (const al of ['blue', 'red']) {
      const m = mats['station-' + al]; if (!m) continue;
      if (!m.userData.base) m.userData.base = { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
      const g = al === a, b = m.userData.base;
      m.transparent = g || b.transparent; m.opacity = g ? 0.16 : b.opacity; m.depthWrite = g ? false : b.depthWrite; m.needsUpdate = true;
    }
    ghosted = a;
  }
  function setCameraMode(m, a = alliance, robotId = null, opts = {}) {
    if (m !== 'driver') ghostStation(null);
    if (m === 'chase') m = 'third';
    mode = m; alliance = a; playerId = robotId;
    slot = Math.max(0, Math.min(2, (opts && opts.slot) | 0));
    fovTarget = (CAM[m] || CAM.driver).fov;
    if (m === 'free') { camera.fov = 50; camera.updateProjectionMatrix(); }
    restoreHidden();
  }

  function setOptions(o = {}) {
    if (o.driverTracking !== undefined) driverTracking = !!o.driverTracking;
    if (o.cameraFollow && RATES[o.cameraFollow] !== undefined) follow = o.cameraFollow;
    else if (o.cameraFollow === 'locked') follow = 'locked';
    if (o.background !== undefined) field.stands.visible = !!o.background;
    if (o.quality) setQuality(o.quality);
  }

  // First person: hide the player's own superstructure (everything above bumper height) so it can't block the view.
  const hbox = new THREE.Box3();
  function restoreHidden() {
    for (const e of models.values()) if (e.hide) { for (const m of e.hide) m.visible = true; e.hide = null; }
  }
  function applyHidden(e) {
    if (!e.hide) {
      e.hide = [];
      e.model.object.updateMatrixWorld(true);
      e.model.object.traverse((o) => { if (o.isMesh && hbox.setFromObject(o).min.y > 0.4) e.hide.push(o); });
    }
    for (const m of e.hide) m.visible = false;
  }

  function setQuality(q) {
    quality = q;
    const hi = q === 'high';
    sun.castShadow = hi;
    sun.shadow.mapSize.set(hi ? 4096 : 1024, hi ? 4096 : 1024);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    gl.setPixelRatio(hi ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    resize();
  }

  function resize(w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight) {
    gl.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  const find = (sim) => sim.state.robots.find((r) => r.id === playerId) || sim.state.robots.find((r) => r.alliance === alliance) || null;
  let rate = RATES.smooth.fixed;
  function cameraTargets(sim) {
    tu.set(0, 1, 0);
    rate = (RATES[follow] || RATES.smooth).fixed;
    if (mode === 'top') {
      const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const dist = Math.max((FIELD.halfW + 1.2) / t, (FIELD.halfL + 1.2) / (t * camera.aspect));
      tp.set(0, dist, 0); tl.set(0, 0, 0); tu.set(0, 0, -1);
      return;
    }
    const rs = (mode === 'third' || mode === 'first') ? find(sim) : null;
    if (rs && mode === 'third') {
      const f = SIDES[alliance].screenForward, c = CAM.third, y = rs.y || 0;   // alliance's view, not the robot's heading
      tp.set(rs.x - f.x * c.back, y + c.up, rs.z - f.z * c.back);
      tl.set(rs.x + f.x * c.lookAhead, c.lookY + y * 0.5, rs.z + f.z * c.lookAhead);
      rate = (RATES[follow] || RATES.smooth).third;
      return;
    }
    if (rs && mode === 'first') {
      const c = CAM.first, ch = Math.cos(rs.heading), sh = Math.sin(rs.heading), y = rs.y || 0;
      tp.set(rs.x + ch * c.fwd, y + c.up, rs.z + sh * c.fwd);
      tl.set(tp.x + ch * 5, tp.y - 5 * Math.tan(c.pitch), tp.z + sh * 5);
      rate = (RATES[follow] || RATES.smooth).first;
      return;
    }
    const d = CAM.driver, sx = SIDES[alliance].driverStationX < 0 ? -1 : 1;   // fixed station behind the alliance wall
    tp.set(sx * (8.75 + d.dist), d.eye, DRIVER_Z[alliance][slot]); tl.set(0, 0.35, 0);
    ghostStation(mode === 'driver' ? alliance : null);
    fovTarget = d.fov; fovRate = 6; trackRobot = false;
    const tr = (driverTracking && mode === 'driver') ? find(sim) : null;
    if (tr) {
      const T = TRACK[follow] || TRACK.smooth, y = tr.y || 0;
      // never aim past the field edge, and never at more than the weighted blend: bounded swing
      const rx = THREE.MathUtils.clamp(tr.x, -FIELD.halfL + 0.4, FIELD.halfL - 0.4), rz = THREE.MathUtils.clamp(tr.z, -FIELD.halfW + 0.2, FIELD.halfW - 0.2);
      tl.set(rx * T.w, 0.5 + (0.3 + y * 0.5 - 0.5) * T.w, rz * T.w);
      rate = [(RATES[follow] || RATES.smooth).fixed[0], T.look || 1]; fovRate = T.fov; trackRobot = true;
      const dist = Math.hypot(rx - tp.x, rz - tp.z), k = THREE.MathUtils.smoothstep(dist, TRACK.distNear, TRACK.distFar);
      fovTarget = TRACK.fovNear + (TRACK.fovFar - TRACK.fovNear) * k;
    }
  }

  function syncRobots(rs, dt) {
    const seen = new Set();
    for (const r of rs) {
      seen.add(r.id);
      const key = `${r.alliance}|${r.number}|${r.preset && r.preset.id}`;
      let e = models.get(r.id);
      if (!e || e.key !== key) {
        if (e) scene.remove(e.model.object);
        e = { key, model: createRobotModel(r) };
        scene.add(e.model.object); models.set(r.id, e);
      }
      e.model.update(r, dt, r.id === playerId);
      if (mode === 'first' && r.id === playerId) applyHidden(e); else if (e.hide) { for (const m of e.hide) m.visible = true; e.hide = null; }
      e.model.object.updateMatrixWorld(true);
    }
    for (const [id, e] of models) if (!seen.has(id)) { scene.remove(e.model.object); models.delete(id); }
  }

  // ---- tube poses ----
  // Every tube keeps a render record. When its (state, slot) key changes (picked up, handed to a post, slot shift...) the
  // displayed pose eases from where it was last drawn to the new target pose, so tubes slide instead of snapping.
  // ---- tube poses ----
  // Every tube keeps a render record. When its (state, slot) key changes (picked up, handed to a post, slot shift...) the
  // displayed pose eases from where it was last drawn to the new target pose, so tubes slide instead of snapping.
  const AX = new THREE.Vector3();
  const recs = new Map(), postMap = new Map(), byRobot = new Map(), tgtP = new THREE.Vector3(), tgtQ = new THREE.Quaternion();
  const ST = { floor: 0, chute: 1, held: 2, post: 3, flight: 4 };
  const newRec = () => ({ key: -1, p: new THREE.Vector3(), q: new THREE.Quaternion(), fp: new THREE.Vector3(), fq: new THREE.Quaternion(), t: 0, dur: 0, hop: 0, holder: null, st: '' });
  const easeS = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  const PEG_FINAL = LIFT.FINAL, PEG_GAP = 0.14;   // tube center rests FINAL beyond the tip toward the wall; older tubes are pushed back 0.14 each

  let recState = null;
  function syncTubes(state, dt) {
    // A new match (or restart) makes a new state whose tube ids start again at t0; records from the old match would make
    // those tubes ease in from where the old tube with the same id was drawn, flying across the field.
    if (state !== recState) { recs.clear(); recState = state; }
    let n = 0;
    const t = state.time || 0;
    byRobot.clear();
    for (const r of state.robots) byRobot.set(r.id, r);
    postMap.clear();
    for (const p of state.posts) postMap.set(p.id, p);
    for (const tb of state.tubes) {
      if (n >= MAX_TUBES) break;
      let rec = recs.get(tb.id);
      const fresh = !rec;
      if (fresh) recs.set(tb.id, (rec = newRec()));
      let slot = 0, hopH = 0;
      tgtP.set(tb.x, tb.y, tb.z);
      Q.tmp.copy(Q.flat);  // lying flat
      let yaw = null;      // vertical ring: axis along (sin yaw, 0, cos yaw)
      let model = null;
      if (tb.state === 'held') {
        const r = byRobot.get(tb.holder), e = r && models.get(r.id);
        if (e) {
          model = e.model;
          slot = Math.max(0, Math.min(1, r.held.indexOf(tb.id)));
          (model.carries ? model.carries[slot] : model.carry).getWorldPosition(tgtP);
          const bl = model.lift ? model.lift.blend : 0;
          yaw = Math.PI / 2 - r.heading * (1 - bl);     // ring axis follows the claw; lines up with the peg axis (x) as it extends
        }
      } else if (tb.state === 'post') {
        const p = postMap.get(tb.post);
        if (p) {
          slot = Math.max(0, p.tubes.length - 1 - tb.stackIndex);    // newest tube sits at the tip, older ones are pushed toward the wall
          tgtP.set(p.tipX - p.dirX * (PEG_FINAL + PEG_GAP * slot), p.y, p.z);
        }
        yaw = Math.PI / 2;
      } else if (tb.state === 'chute') {   // tips from upright (tilt 1) to flat (tilt 0) as it settles
        const k = tb.tilt || 0;   // pure tip about the ring's horizontal axis, matching the sim's contact height
        Q.tmp.setFromAxisAngle(Y, tb.yaw || 0).multiply(Q.tmp2.setFromAxisAngle(XAX, -(Math.PI / 2) * (1 - k)));
      }
      else if (tb.state === 'flight') {
        AX.set(-tb.vz, 0, tb.vx);
        if (AX.lengthSq() > 1e-6) Q.tmp.premultiply(Q.tmp2.setFromAxisAngle(AX.normalize(), t * 7));
      }
      if (yaw !== null) Q.tmp.setFromAxisAngle(Y, yaw);
      tgtQ.copy(Q.tmp);

      const key = (ST[tb.state] ?? 0) * 8 + slot;
      if (fresh) { rec.key = key; rec.st = tb.state; rec.dur = 0; }
      else if (key !== rec.key) {
        const from = rec.st, to = tb.state;
        let dur = 0.18;
        if (from === 'held' && to === 'post') dur = (rec.holder && rec.holder.lift && rec.holder.lift.slideT) || LIFT.SLIDE;   // claw pushes it onto the peg
        else if ((from === 'floor' || from === 'chute') && to === 'held') { dur = 0.34; hopH = 0.1; }                       // intake pulls it in
        else if (from === 'held' && to === 'flight') dur = 0.05;
        else if (from === 'flight') dur = 0.05;
        if (dur > 0) { rec.fp.copy(rec.p); rec.fq.copy(rec.q); rec.t = 0; rec.dur = dur; rec.hop = hopH; }
        rec.key = key; rec.st = tb.state;
      }
      if (rec.dur > 0 && rec.t < rec.dur) {
        rec.t += dt;
        const s = easeS(rec.t / rec.dur);
        rec.p.lerpVectors(rec.fp, tgtP, s); rec.p.y += Math.sin(Math.PI * s) * rec.hop;
        rec.q.slerpQuaternions(rec.fq, tgtQ, s);
      } else { rec.p.copy(tgtP); rec.q.copy(tgtQ); rec.dur = 0; }
      rec.holder = tb.state === 'held' ? model : rec.holder;
      const inFace = mode === 'first' && tb.state === 'held' && tb.holder === playerId;   // own held tubes would fill the first-person view
      tubes.setMatrixAt(n++, m4.compose(rec.p, rec.q, inFace ? ZERO3 : ONE));
    }
    tubes.count = n;
    tubes.instanceMatrix.needsUpdate = true;
  }

  function render(sim) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    syncRobots(sim.state.robots, dt);
    syncTubes(sim.state, dt);
    if (mode !== 'free') {
      cameraTargets(sim);
      const locked = follow === 'locked' && (mode === 'third' || mode === 'first' || (mode === 'driver' && trackRobot));
      const kp = init || locked ? 1 : 1 - Math.exp(-dt * rate[0]), kl = init || locked ? 1 : 1 - Math.exp(-dt * rate[1]);
      init = false;
      camPos.lerp(tp, kp); camLook.lerp(tl, kl); camUp.lerp(tu, kl).normalize();
      camera.position.copy(camPos); camera.up.copy(camUp); camera.lookAt(camLook);
      if (Math.abs(camera.fov - fovTarget) > 0.01) {
        let df = (fovTarget - camera.fov) * (1 - Math.exp(-dt * fovRate));
        if (trackRobot) df = THREE.MathUtils.clamp(df, -TRACK.maxFovSpeed * dt, TRACK.maxFovSpeed * dt);   // no sudden zoom pumps
        camera.fov += df; camera.updateProjectionMatrix();
      }
    } else { camPos.copy(camera.position); camLook.set(0, 0, 0); camUp.set(0, 1, 0); }
    // the glazed shelf of the end walls nearly vanishes when the camera sits behind it (driver stations), else it veils the whole view
    const em = field.cad && field.cad.userData.mats && field.cad.userData.mats.endwall;
    if (em) em.opacity = Math.abs(camera.position.x) > 8.3 ? 0.04 : 0.42;
    gl.render(scene, camera);
  }

  setQuality('high');
  resize();
  return { scene, camera, gl, canvas, field, setCameraMode, setOptions, render, resize, setQuality, get quality() { return quality; }, get mode() { return mode; }, get models() { return models; } };
}
