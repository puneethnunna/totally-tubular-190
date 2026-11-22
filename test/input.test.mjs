// Pure-logic tests for js/input.js (no DOM). Run: node test/input.test.mjs
import assert from 'node:assert/strict';
import { DEFAULT_KEYS, DEFAULT_PAD, K2, ACTION_IDS, effectiveKeys, effectivePad, findKeyDuplicates, findPadDuplicates, rebindKey, rebindPad,
  migrateControls, armTier, tierLabel, planPlace, readBinding, axisVal, padLabel, CTL_VERSION } from '../js/input.js';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('default keyboard map has no duplicate keys', () => {
  assert.deepEqual(findKeyDuplicates(effectiveKeys({})), []);
  for (const id of ACTION_IDS) assert.ok(id in DEFAULT_KEYS, id);
  assert.equal(DEFAULT_KEYS.place.includes('Space'), true);
});
t('default keys: W/S forward/back, A/D strafe, J/L turn; arrows are secondary', () => {
  const k = effectiveKeys({});
  assert.equal(k.up[0], 'KeyW'); assert.equal(k.down[0], 'KeyS'); assert.equal(k.left[0], 'KeyA'); assert.equal(k.right[0], 'KeyD'); assert.equal(k.rotL[0], 'KeyJ'); assert.equal(k.rotR[0], 'KeyL');
  assert.deepEqual(k.up.slice(1), ['ArrowUp']); assert.deepEqual(k.rotL.slice(1), ['ArrowLeft']); assert.deepEqual(k.left, ['KeyA']); assert.deepEqual(k.right, ['KeyD']);
  assert.equal(DEFAULT_KEYS.intake[0], 'ShiftLeft'); assert.equal(DEFAULT_KEYS.place[0], 'Space'); assert.deepEqual(DEFAULT_KEYS.upper, ['KeyZ']); assert.deepEqual(DEFAULT_KEYS.lower, ['KeyX']); assert.deepEqual(DEFAULT_KEYS.drop, ['KeyQ']);
  assert.deepEqual(DEFAULT_KEYS.climb, ['KeyG']); assert.deepEqual(DEFAULT_KEYS.tube, ['KeyT']); assert.deepEqual(DEFAULT_KEYS.stow, ['KeyE']); assert.deepEqual(DEFAULT_KEYS.camera, ['KeyC']); assert.deepEqual(DEFAULT_KEYS.slot, ['KeyV']);
  assert.equal(CTL_VERSION, 4);
});
t('default controller map has no duplicate bindings', () => { assert.deepEqual(findPadDuplicates(effectivePad({})), []); assert.equal(DEFAULT_PAD.place, 'b7'); assert.equal(DEFAULT_PAD.upper, 'b3'); assert.equal(DEFAULT_PAD.lower, 'b1'); assert.equal(DEFAULT_PAD.climb, 'b5'); assert.equal(DEFAULT_PAD.intake, 'b6'); });
t('player 2 keys do not collide with player 1 globals', () => {
  const g = new Set(['pause', 'restart', 'camera', 'slot', 'stats', 'breakdown', 'fullscreen'].flatMap((i) => DEFAULT_KEYS[i]));
  for (const [id, ks] of Object.entries(K2)) for (const k of ks) assert.ok(!g.has(k), `${id}:${k}`);
});
t('rebinding to a free key replaces the chip', () => {
  const r = rebindKey({}, 'upper', 0, 'KeyU'); assert.deepEqual(r.map.upper, ['KeyU']); assert.equal(r.note, ''); assert.deepEqual(findKeyDuplicates(r.map), []);
});
t('rebinding onto a used key swaps with the other action', () => {
  const r = rebindKey({}, 'upper', 0, 'KeyQ'); // Q is Drop
  assert.deepEqual(r.map.upper, ['KeyQ']); assert.deepEqual(r.map.drop, ['KeyZ']); assert.match(r.note, /swapped/); assert.deepEqual(findKeyDuplicates(r.map), []);
});
t('adding a second key removes it from the other action', () => {
  const r = rebindKey({}, 'upper', '+', 'KeyQ');
  assert.deepEqual(r.map.upper, ['KeyZ', 'KeyQ']); assert.deepEqual(r.map.drop, []); assert.match(r.note, /removed/); assert.deepEqual(findKeyDuplicates(r.map), []);
});
t('right shift normalises to Shift; Backspace clears a chip', () => {
  const sr = rebindKey({}, 'upper', 0, 'ShiftRight').map; assert.deepEqual(sr.upper, ['ShiftLeft']); assert.deepEqual(sr.intake, ['KeyZ', 'KeyF']);
  assert.deepEqual(rebindKey({}, 'up', 0, '').map.up, ['ArrowUp']);
});
t('pad rebinding swaps duplicates and can clear', () => {
  const r = rebindPad({}, 'place', 'b6'); // LT is Intake
  assert.equal(r.map.place, 'b6'); assert.equal(r.map.intake, 'b7'); assert.deepEqual(findPadDuplicates(r.map), []);
  assert.equal(rebindPad({}, 'camera', 'b11').map.camera, 'b11');
  assert.equal(rebindPad({}, 'pause', null).map.pause, null);
});
t('migration: old saved settings reset controls to new defaults but keep other settings', () => {
  const old = { quality: 'low', speeds: [30, 60, 90], keys: { launch: ['KeyX'], score: ['Space'], tube: ['KeyH'], up: ['KeyI'] } };
  const m = migrateControls(old);
  assert.equal(m.ctlVersion, CTL_VERSION); assert.deepEqual(m.keys, {}); assert.deepEqual(m.pad, {}); assert.equal(m.padCfg.deadzone, 12);
  assert.equal(m.quality, 'low'); assert.deepEqual(m.speeds, [30, 60, 90]);
  assert.deepEqual(migrateControls(undefined).keys, {});
  const v2 = migrateControls({ ctlVersion: 2, keys: { up: ['KeyI'], rotL: ['KeyU'] }, pad: { camera: 'b11' } }); // v2 bindings migrate to the v3 defaults
  assert.deepEqual(v2.keys, {}); assert.equal(effectiveKeys(v2.keys).up[0], 'KeyW'); assert.equal(effectiveKeys(v2.keys).rotL[0], 'KeyJ'); assert.deepEqual(v2.pad, {});
});
t('migration: current-version settings are kept, sanitised and de-duplicated', () => {
  const ok = migrateControls({ ctlVersion: CTL_VERSION, keys: { upper: ['KeyU'], bogus: ['KeyP'] }, pad: { camera: 'b11' }, padCfg: { deadzone: 99, rumble: 'x', device: 2 } });
  assert.deepEqual(ok.keys, { upper: ['KeyU'] }); assert.equal(ok.pad.camera, 'b11'); assert.equal(ok.padCfg.deadzone, 40); assert.equal(ok.padCfg.rumble, 50); assert.equal(ok.padCfg.device, 2);
  const bad = migrateControls({ ctlVersion: CTL_VERSION, keys: { upper: ['KeyQ'] } }); // duplicates Drop -> corrupt -> defaults
  assert.deepEqual(bad.keys, {});
});
t('armTier: Y/Z arms upper, B/X arms lower, same button clears, other switches', () => {
  assert.equal(armTier(null, 'upper'), 'upper'); assert.equal(armTier('upper', 'upper'), null); assert.equal(armTier('upper', 'lower'), 'lower');
  assert.equal(armTier(null, 'lower'), 'lower'); assert.equal(armTier('lower', 'lower'), null); assert.equal(armTier('lower', 'upper'), 'upper');
  assert.equal(tierLabel(null), 'FLOOR'); assert.equal(tierLabel('upper'), 'UPPER'); assert.equal(tierLabel('lower'), 'LOWER');
});
t('planPlace: armed tier / launch / floor when nothing armed', () => {
  const tune = { reach: 1.2, placeAngle: 0.61, placeLateral: 0.3, launchAngle: 0.35, launchMin: 1.5, launchMax: 5 };
  const posts = [{ tier: 'lower', alliance: 'red', tipX: -7.62, z: 0, dirX: 1 }, { tier: 'upper', alliance: 'red', tipX: -7.62, z: 2, dirX: 1 }];
  const mk = (x, z) => ({ alliance: 'red', x, z, heading: Math.PI, radius: 0.45, held: [{}] });
  const arm = { canUpper: true, canLower: true }, toss = { canUpper: false, canLower: true, canLaunch: true };
  assert.equal(planPlace({ robot: mk(-6.3, 0), preset: arm, armed: null, posts, tune }).act, 'scoreFloor'); // RT with nothing armed -> floor
  assert.equal(planPlace({ robot: mk(0, 0), preset: arm, armed: null, posts, tune }).act, 'scoreFloor'); // anywhere on the field
  assert.equal(planPlace({ robot: mk(-6.3, 0), preset: arm, armed: 'lower', posts, tune }).act, 'scoreLower');
  assert.equal(planPlace({ robot: mk(-6.3, 2), preset: arm, armed: 'upper', posts, tune }).act, 'scoreUpper');
  assert.equal(planPlace({ robot: mk(-6.3, 2), preset: arm, armed: 'lower', posts, tune }).act, null);
  assert.equal(planPlace({ robot: mk(-4.5, 0), preset: toss, armed: 'upper', posts, tune }).act, 'launch');
  const far = planPlace({ robot: mk(0, 0), preset: arm, armed: 'upper', posts, tune }); assert.equal(far.act, null); assert.equal(far.why, 'No post in reach');
  assert.equal(planPlace({ robot: { ...mk(-6.3, 0), held: [] }, preset: arm, armed: null, posts, tune }).act, null);
});
t('gamepad reading: deadzone, axis direction, flip, fine curve', () => {
  const pad = { buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0.05, -1, 0, 0] };
  pad.buttons[0].pressed = true;
  assert.equal(readBinding(pad, 'a0+'), 0); assert.equal(readBinding(pad, 'a1-'), 1); assert.equal(readBinding(pad, 'a1+'), 0);
  assert.equal(readBinding(pad, 'b0'), 1); assert.equal(readBinding(pad, 'b1'), 0); assert.equal(readBinding(pad, 'b1', { flipAB: true, deadzone: 12, fine: 0 }), 1);
  assert.ok(axisVal(0.5, 12, 100) < axisVal(0.5, 12, 0)); assert.equal(padLabel('b7'), 'RT'); assert.equal(padLabel('a2-'), 'R←');
});
console.log(`\n${n} tests passed`);
