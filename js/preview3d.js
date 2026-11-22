import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createRobotModel } from './models.js';
import { ensureMeshes } from './robots.js';

// One shared WebGLRenderer for every preview; each preview owns a 2D canvas that gets the frame via drawImage.
let R, ENV;
const previews = new Set();
let raf = 0, last = 0;

function shared() {
  if (R) return R;
  R = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: false });
  R.setClearColor(0x000000, 0);
  R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.3;
  R.outputColorSpace = THREE.SRGBColorSpace;
  R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
  const pm = new THREE.PMREMGenerator(R);
  ENV = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  return R;
}

function loop(now) {
  raf = previews.size ? requestAnimationFrame(loop) : 0;
  if (now - last < 33) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  for (const p of previews) p.frame(dt);
}

export function createRobotPreview(host, { autoRotate = true, spin = 0.5, fitRing = false } = {}) {
  const canvas = host instanceof HTMLCanvasElement ? host : document.createElement('canvas');
  if (canvas !== host) { canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none'; host.appendChild(canvas);
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; }
  const g2 = canvas.getContext('2d');
  const scene = new THREE.Scene();
  scene.environment = (shared(), ENV);
  scene.environmentIntensity = 1;
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(2.6, 5.5, 3.2);   // soft key
  sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.radius = 5; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
  Object.assign(sun.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1.6, near: 1, far: 14 });
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3d48, 0.7));
  const fill = new THREE.DirectionalLight(0xd5e4ff, 0.35); fill.position.set(-4, 3, -2); scene.add(fill);
  const cam = new THREE.PerspectiveCamera(28, 1.6, 0.1, 50);
  const stage = new THREE.Group(); scene.add(stage);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.03, 48), new THREE.MeshStandardMaterial({ color: 0x1d1d20, roughness: 0.85, metalness: 0, envMapIntensity: 0.25 }));
  disc.position.y = -0.016; disc.receiveShadow = true; stage.add(disc);
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.515, 128), new THREE.MeshBasicMaterial({ color: 0xf0c13e, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; stage.add(ring);
  const turntable = new THREE.Group(); stage.add(turntable);
  let fit = null;
  function placeCam(aspect) {
    if (!fit) return;
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    let vHalf = Math.max(fit.y * 0.72, 0.5) + 0.3, hHalf =Math.max(fit.x, fit.z) * 0.66 + 0.05;
    if (fitRing) { hHalf = Math.max(hHalf, 1.62); vHalf = Math.max(vHalf * 1.3, 2.1); }   // home carousel: the whole gold ring stays in frame
    const d = Math.max(vHalf / t, hHalf / (t * aspect)) * 1.02;
    cam.position.set(d * 0.55, d * 0.45 + fit.y * 0.1, d * 0.7); cam.lookAt(0, fit.y * 0.42, 0);
  }
  let model = null, state = null, ticket = 0, visible = true, disposed = false, yaw = -0.6;
  const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((e) => { visible = e[e.length - 1].isIntersecting; }) : null;
  if (io) io.observe(canvas);

  async function show(def, alliance = 'blue') {
    const my = ++ticket;
    await ensureMeshes([def]);
    if (my !== ticket || disposed) return;
    if (model) { turntable.remove(model.object); model = null; }
    state = { id: 'preview', alliance, number: def.number || '', preset: def.preset, x: 0, y: 0, z: 0, heading: 0, armTier: 'stow', arm: 0, support: 0, held: [], isPlayer: false };
    model = createRobotModel(state);
    turntable.add(model.object);
    const box = new THREE.Box3().setFromObject(model.object), size = box.getSize(new THREE.Vector3());
    fit = size.clone();
    placeCam(cam.aspect || 1.6);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function frame(dt) {
    if (!model || !visible || !canvas.isConnected) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    if (autoRotate) yaw += dt * spin;
    turntable.rotation.y = yaw;
    model.update({ ...state, heading: 0 }, dt, false);
    if (Math.abs(cam.aspect - w / h) > 1e-3) { cam.aspect = w / h; cam.updateProjectionMatrix(); placeCam(cam.aspect); }
    if (R.domElement.width !== pw || R.domElement.height !== ph) R.setSize(pw, ph, false);
    R.render(scene, cam);
    g2.clearRect(0, 0, pw, ph);
    g2.drawImage(R.domElement, 0, 0);
  }

  const api = {
    show, frame, canvas,
    setYaw(v) { yaw = v; },
    dispose() {
      disposed = true; previews.delete(api); if (io) io.disconnect();
      disc.geometry.dispose(); ring.geometry.dispose();
      if (canvas.parentNode === host) host.removeChild(canvas);
    },
  };
  previews.add(api);
  return api;
}
