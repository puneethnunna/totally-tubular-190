import * as THREE from 'three';
import { SIDES, ROBOT, TUBE, FIELD } from './config.js';
import { buildField } from './field3d.js';
import { createRobotModel, getTubeAssets } from './models.js';

const MAX_TUBES = 216;
const TIER_STOW = new Set(['stow', 'floor']);

export function createRenderer(canvas) {
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.05;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141824);
  scene.fog = new THREE.Fog(0x141824, 40, 110);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 250);
  camera.position.set(-12, 4.2, 1.1);

  scene.add(new THREE.HemisphereLight(0xd6e4ff, 0x5a5a66, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-4, 18, 9);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -12; sc.right = 12; sc.top = 8; sc.bottom = -8; sc.near = 1; sc.far = 45;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const field = buildField(scene);

  // tubes (instanced)
  const { geometry, material } = getTubeAssets();
  const tubes = new THREE.InstancedMesh(geometry, material, MAX_TUBES);
  tubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tubes.castShadow = tubes.receiveShadow = true; tubes.frustumCulled = false; tubes.count = 0;
  scene.add(tubes);

  const models = new Map(); // id -> { key, model }
  let mode = 'driver', alliance = 'blue', playerId = null, quality = 'high';
  let init = true, last = performance.now();
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camUp = new THREE.Vector3(0, 1, 0);
  const tp = new THREE.Vector3(), tl = new THREE.Vector3(), tu = new THREE.Vector3(0, 1, 0);

  const Q = {
    flat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
    tmp: new THREE.Quaternion(), tmp2: new THREE.Quaternion(),
  };
  const Y = new THREE.Vector3(0, 1, 0), v3 = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4();

  function setCameraMode(m, a = alliance, robotId = null) {
    mode = m; alliance = a; playerId = robotId;
  }

  function setQuality(q) {
    quality = q;
    const hi = q === 'high';
    sun.castShadow = hi;
    sun.shadow.mapSize.set(hi ? 2048 : 512, hi ? 2048 : 512);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    gl.setPixelRatio(hi ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    resize();
  }

  function resize(w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight) {
    gl.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function cameraTargets(sim) {
    if (mode === 'top') {
      const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const dist = Math.max((FIELD.halfW + 1.2) / t, (FIELD.halfL + 1.2) / (t * camera.aspect));
      tp.set(0, dist, 0); tl.set(0, 0, 0); tu.set(0, 0, -1);
      return;
    }
    tu.set(0, 1, 0);
    if (mode === 'chase') {
      const rs = sim.state.robots.find((r) => r.id === playerId) || sim.state.robots.find((r) => r.alliance === alliance);
      if (rs) {
        const c = Math.cos(rs.heading), s = Math.sin(rs.heading), y = rs.y || 0;
        tp.set(rs.x - c * 3.4, y + 2.4, rs.z - s * 3.4);
        tl.set(rs.x + c * 2.2, y + 0.4, rs.z + s * 2.2);
        return;
      }
    }
    const d = SIDES[alliance].driverCam;
    tp.set(d.pos.x, d.pos.y, d.pos.z); tl.set(d.look.x, d.look.y, d.look.z);
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
      const k = init ? 1 : 1 - Math.exp(-dt * (mode === 'chase' ? 6 : 3.5));
      init = false;
      camPos.lerp(tp, k); camLook.lerp(tl, k); camUp.lerp(tu, k).normalize();
      camera.position.copy(camPos); camera.up.copy(camUp); camera.lookAt(camLook);
    } else { camPos.copy(camera.position); camLook.set(0, 0, 0); camUp.set(0, 1, 0); }
    gl.render(scene, camera);
  }

  setQuality('high');
  resize();
  return { scene, camera, gl, canvas, field, setCameraMode, render, resize, setQuality, get quality() { return quality; } };
}
