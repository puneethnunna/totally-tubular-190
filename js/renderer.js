import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SIDES, ROBOT, TUBE, FIELD } from './config.js';
import { buildField } from './field3d.js';
import { createRobotModel, getTubeAssets } from './models.js';

const MAX_TUBES = 216;
const TIER_STOW = new Set(['stow', 'floor']);

// Driver-station centers (z) per alliance, slot 0..2 = left..right as that alliance's drivers see the field.
// Measured from the CAD's station dividers (blue end: dividers at z = -1.70, 0.14, 2.0, 3.84; red is the (x,z) mirror).
export const DRIVER_Z = { blue: [-0.78, 1.07, 2.92], red: [0.78, -1.07, -2.92] };
export const CAM = {
  driver: { dist: 0.6, eye: 1.8, fov: 55 },          // eye at x = -+(8.75 + dist), looking at (0, 0.5, 0)
  third: { back: 3.5, up: 3.0, lookAhead: 1.8, lookY: 0.3, fov: 55 },
  first: { fwd: 0.3, up: 0.75, pitch: 0.15, fov: 75 }, // pitch rad (~8.5 deg) downward
  top: { fov: 50 },
};
// exponential follow rates (1/s) per cameraFollow setting: [position, look-at]
const RATES = {
  smooth: { third: [3.2, 5], first: [12, 16], fixed: [4, 4] },
  tight: { third: [10, 14], first: [26, 30], fixed: [6, 6] },
};

export function createRenderer(canvas) {
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 0.85;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141824);
  scene.fog = new THREE.Fog(0x141824, 40, 110);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 250);
  camera.position.set(-12, 4.2, 1.1);

  // image-based lighting like frsim (RoomEnvironment) + one soft-shadow key light covering the whole field
  const pmrem = new THREE.PMREMGenerator(gl);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xd6e4ff, 0x4a4a55, 0.35));
  const sun = new THREE.DirectionalLight(0xfff4e6, 1.8);
  sun.position.set(-6, 20, 8);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -12; sc.right = 12; sc.top = 8.5; sc.bottom = -8.5; sc.near = 4; sc.far = 50;
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.025; sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  const field = buildField(scene);

  // tubes (instanced)
  const { geometry, material } = getTubeAssets();
  const tubes = new THREE.InstancedMesh(geometry, material, MAX_TUBES);
  tubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tubes.castShadow = tubes.receiveShadow = true; tubes.frustumCulled = false; tubes.count = 0;
  scene.add(tubes);

  const models = new Map(); // id -> { key, model }
  let mode = 'driver', alliance = 'blue', playerId = null, quality = 'high', slot = 0, follow = 'smooth';
  let init = true, last = performance.now(), fovTarget = CAM.driver.fov, hidden = false;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camUp = new THREE.Vector3(0, 1, 0);
  const tp = new THREE.Vector3(), tl = new THREE.Vector3(), tu = new THREE.Vector3(0, 1, 0);

  const Q = {
    flat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
    tmp: new THREE.Quaternion(), tmp2: new THREE.Quaternion(),
  };
  const Y = new THREE.Vector3(0, 1, 0), v3 = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4();

  function setCameraMode(m, a = alliance, robotId = null, opts = {}) {
    if (m === 'chase') m = 'third';
    mode = m; alliance = a; playerId = robotId;
    slot = Math.max(0, Math.min(2, (opts && opts.slot) | 0));
    fovTarget = (CAM[m] || CAM.driver).fov;
    if (m === 'free') { camera.fov = 50; camera.updateProjectionMatrix(); }
    restoreHidden();
  }

  function setOptions(o = {}) {
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
    tp.set(sx * (8.75 + d.dist), d.eye, DRIVER_Z[alliance][slot]); tl.set(0, 0.5, 0);
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

  const AX = new THREE.Vector3();
  function syncTubes(state) {
    let n = 0;
    const t = state.time || 0;
    const byRobot = new Map(state.robots.map((r) => [r.id, r]));
    const slot = new Map();
    for (const tb of state.tubes) {
      if (n >= MAX_TUBES) break;
      v3.set(tb.x, tb.y, tb.z);
      Q.tmp.copy(Q.flat); // lying flat
      let yaw = null;     // vertical ring: axis along (sin yaw, 0, cos yaw)
      if (tb.state === 'held') {
        const r = byRobot.get(tb.holder), e = r && models.get(r.id);
        if (e) {
          const i = slot.get(r.id) || 0; slot.set(r.id, i + 1);
          e.model.carry.getWorldPosition(v3);
          if (!TIER_STOW.has(r.armTier) && r.arm > 0.3) yaw = Math.PI / 2 - r.heading;
          else { v3.y += i * 0.16; Q.tmp.premultiply(Q.tmp2.setFromAxisAngle(Y, -r.heading)); }
        }
      } else if (tb.state === 'post') yaw = Math.PI / 2;
      else if (tb.state === 'chute') yaw = 0;
      else if (tb.state === 'flight') {
        AX.set(-tb.vz, 0, tb.vx);
        if (AX.lengthSq() > 1e-6) Q.tmp.premultiply(Q.tmp2.setFromAxisAngle(AX.normalize(), t * 7));
      }
      if (yaw !== null) Q.tmp.setFromAxisAngle(Y, yaw);
      tubes.setMatrixAt(n++, m4.compose(v3, Q.tmp, ONE));
    }
    tubes.count = n;
    tubes.instanceMatrix.needsUpdate = true;
  }

  function render(sim) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    syncRobots(sim.state.robots, dt);
    syncTubes(sim.state);
    if (mode !== 'free') {
      cameraTargets(sim);
      const locked = follow === 'locked' && (mode === 'third' || mode === 'first');
      const kp = init || locked ? 1 : 1 - Math.exp(-dt * rate[0]), kl = init || locked ? 1 : 1 - Math.exp(-dt * rate[1]);
      init = false;
      camPos.lerp(tp, kp); camLook.lerp(tl, kl); camUp.lerp(tu, kl).normalize();
      camera.position.copy(camPos); camera.up.copy(camUp); camera.lookAt(camLook);
      if (Math.abs(camera.fov - fovTarget) > 0.01) {
        camera.fov += (fovTarget - camera.fov) * (1 - Math.exp(-dt * 6)); camera.updateProjectionMatrix();
      }
    } else { camPos.copy(camera.position); camLook.set(0, 0, 0); camUp.set(0, 1, 0); }
    gl.render(scene, camera);
  }

  setQuality('high');
  resize();
  return { scene, camera, gl, canvas, field, setCameraMode, setOptions, render, resize, setQuality, get quality() { return quality; }, get mode() { return mode; } };
}
