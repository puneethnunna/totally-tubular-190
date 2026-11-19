// STUB 2D top-down renderer on the game canvas. Testing only.
import { FIELD, ROBOT, SIDES } from '../../js/config.js';
export function createRenderer(canvas) {
  const c = canvas.getContext('2d'); let mode = 'driver';
  const resize = () => { canvas.width = innerWidth; canvas.height = innerHeight; }; resize();
  return { scene: {}, camera: {}, resize, setCameraMode(m) { mode = m; },
    render(sim) {
      const s = Math.min(canvas.width / 17, canvas.height / 9); c.setTransform(1, 0, 0, 1, canvas.width / 2, canvas.height / 2); c.clearRect(-9999, -9999, 19999, 19999);
      c.fillStyle = '#222'; c.fillRect(-FIELD.halfL * s, -FIELD.halfW * s, FIELD.length * s, FIELD.width * s);
      for (const r of sim.state.robots) { c.save(); c.translate(r.x * s, r.z * s); c.rotate(r.heading); c.fillStyle = r.alliance === 'blue' ? '#1f5bff' : '#e8202a'; c.fillRect(-s / 2, -s / 2, s, s); c.fillStyle = '#fff'; c.fillRect(0, -3, s / 2, 6); c.restore(); }
      for (const t of sim.state.tubes) { c.beginPath(); c.arc(t.x * s, t.z * s, s * 0.25, 0, 7); c.strokeStyle = '#ffd23f'; c.stroke(); }
      c.fillStyle = '#fff'; c.fillText('STUB ' + mode, -s * 8, -s * 4.2);
    } };
}
