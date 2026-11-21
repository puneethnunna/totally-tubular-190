// Pure-logic tests for js/input.js (no DOM). Run: node test/input.test.mjs
import assert from 'node:assert/strict';
import { DEFAULT_KEYS, DEFAULT_PAD, K2, ACTION_IDS, effectiveKeys, effectivePad, findKeyDuplicates, findPadDuplicates, rebindKey, rebindPad,
  migrateControls, resolveTier, nextTier, planPlace, readBinding, axisVal, padLabel, CTL_VERSION } from '../js/input.js';
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
  assert.equal(DEFAULT_KEYS.intake[0], 'ShiftLeft'); assert.equal(DEFAULT_KEYS.place[0], 'Space'); assert.deepEqual(DEFAULT_KEYS.tier, ['KeyZ']); assert.deepEqual(DEFAULT_KEYS.drop, ['KeyQ']);
  assert.deepEqual(DEFAULT_KEYS.climb, ['KeyG']); assert.deepEqual(DEFAULT_KEYS.tube, ['KeyX']); assert.deepEqual(DEFAULT_KEYS.stow, ['KeyE']); assert.deepEqual(DEFAULT_KEYS.camera, ['KeyC']); assert.deepEqual(DEFAULT_KEYS.slot, ['KeyV']);
  assert.equal(CTL_VERSION, 3);
});
t('default controller map has no duplicate bindings', () => { assert.deepEqual(findPadDuplicates(effectivePad({})), []); assert.equal(DEFAULT_PAD.place, 'b7'); assert.equal(DEFAULT_PAD.intake, 'b6'); });
t('player 2 keys do not collide with player 1 globals', () => {
  const g = new Set(['pause', 'restart', 'camera', 'slot', 'stats', 'breakdown', 'fullscreen'].flatMap((i) => DEFAULT_KEYS[i]));
  for (const [id, ks] of Object.entries(K2)) for (const k of ks) assert.ok(!g.has(k), `${id}:${k}`);
});
t('rebinding to a free key replaces the chip', () => {
  const r = rebindKey({}, 'tier', 0, 'KeyT'); assert.deepEqual(r.map.tier, ['KeyT']); assert.equal(r.note, ''); assert.deepEqual(findKeyDuplicates(r.map), []);
});
t('rebinding onto a used key swaps with the other action', () => {
  const r = rebindKey({}, 'tier', 0, 'KeyQ'); // Q is Drop
  assert.deepEqual(r.map.tier, ['KeyQ']); assert.deepEqual(r.map.drop, ['KeyZ']); assert.match(r.note, /swapped/); assert.deepEqual(findKeyDuplicates(r.map), []);
});
t('adding a second key removes it from the other action', () => {
  const r = rebindKey({}, 'tier', '+', 'KeyQ');
  assert.deepEqual(r.map.tier, ['KeyZ', 'KeyQ']); assert.deepEqual(r.map.drop, []); assert.match(r.note, /removed/); assert.deepEqual(findKeyDuplicates(r.map), []);
});
t('right shift normalises to Shift; Backspace clears a chip', () => {
  const sr = rebindKey({}, 'tier', 0, 'ShiftRight').map; assert.deepEqual(sr.tier, ['ShiftLeft']); assert.deepEqual(sr.intake, ['KeyZ', 'KeyF']);
  assert.deepEqual(rebindKey({}, 'up', 0, '').map.up, ['ArrowUp']);
});
t('pad rebinding swaps duplicates and can clear', () => {
  const r = rebindPad({}, 'place', 'b6'); // LT is Intake
  assert.equal(r.map.place, 'b6'); assert.equal(r.map.intake, 'b7'); assert.deepEqual(findPadDuplicates(r.map), []);
  assert.equal(rebindPad({}, 'camera', 'b13').map.camera, 'b13');
  assert.equal(rebindPad({}, 'pause', null).map.pause, null);
});
t('migration: old saved settings reset controls to new defaults but keep other settings', () => {
  const old = { quality: 'low', speeds: [30, 60, 90], keys: { launch: ['KeyX'], score: ['Space'], tube: ['KeyH'], up: ['KeyI'] } };
  const m = migrateControls(old);
  assert.equal(m.ctlVersion, CTL_VERSION); assert.deepEqual(m.keys, {}); assert.deepEqual(m.pad, {}); assert.equal(m.padCfg.deadzone, 12);
  assert.equal(m.quality, 'low'); assert.deepEqual(m.speeds, [30, 60, 90]);
  assert.deepEqual(migrateControls(undefined).keys, {});
  const v2 = migrateControls({ ctlVersion: 2, keys: { up: ['KeyI'], rotL: ['KeyU'] }, pad: { camera: 'b13' } }); // v2 bindings migrate to the v3 defaults
  assert.deepEqual(v2.keys, {}); assert.equal(effectiveKeys(v2.keys).up[0], 'KeyW'); assert.equal(effectiveKeys(v2.keys).rotL[0], 'KeyJ'); assert.deepEqual(v2.pad, {});
});
t('migration: current-version settings are kept, sanitised and de-duplicated', () => {
  const ok = migrateControls({ ctlVersion: CTL_VERSION, keys: { tier: ['KeyT'], bogus: ['KeyP'] }, pad: { camera: 'b13' }, padCfg: { deadzone: 99, rumble: 'x', device: 2 } });
  assert.deepEqual(ok.keys, { tier: ['KeyT'] }); assert.equal(ok.pad.camera, 'b13'); assert.equal(ok.padCfg.deadzone, 40); assert.equal(ok.padCfg.rumble, 50); assert.equal(ok.padCfg.device, 2);
  const bad = migrateControls({ ctlVersion: CTL_VERSION, keys: { tier: ['KeyQ'] } }); // duplicates Drop -> corrupt -> defaults
  assert.deepEqual(bad.keys, {});
});
t('tier AUTO resolution', () => {
  assert.equal(resolveTier('auto', true), 'upper'); assert.equal(resolveTier('auto', false), 'lower');
  assert.equal(resolveTier('lower', true), 'lower'); assert.equal(resolveTier('upper', true), 'upper');
  assert.equal(nextTier('auto', true), 'upper'); assert.equal(nextTier('upper', true), 'lower'); assert.equal(nextTier('lower', true), 'auto'); assert.equal(nextTier('auto', false), 'lower');
});
t('planPlace picks tier / launch / nothing', () => {
  const tune = { reach: 1.2, placeAngle: 0.61, placeLateral: 0.3, launchAngle: 0.35, launchMin: 1.5, launchMax: 5 };
  const posts = [{ tier: 'lower', alliance: 'red', tipX: -7.62, z: 0, dirX: 1 }, { tier: 'upper', alliance: 'red', tipX: -7.62, z: 2, dirX: 1 }];
  const mk = (x, z) => ({ alliance: 'red', x, z, heading: Math.PI, radius: 0.45, held: [{}] });
  const arm = { canUpper: true, canLower: true }, toss = { canUpper: false, canLower: true, canLaunch: true };
  assert.equal(planPlace({ robot: mk(-6.3, 0), preset: arm, mode: 'auto', posts, tune }).act, 'scoreLower'); // auto falls back to lower
  assert.equal(planPlace({ robot: mk(-6.3, 2), preset: arm, mode: 'auto', posts, tune }).act, 'scoreUpper');
  assert.equal(planPlace({ robot: mk(-6.3, 2), preset: arm, mode: 'lower', posts, tune }).act, null);
  assert.equal(planPlace({ robot: mk(-4.5, 0), preset: toss, mode: 'auto', posts, tune }).act, 'launch');
  const far = planPlace({ robot: mk(0, 0), preset: arm, mode: 'auto', posts, tune }); assert.equal(far.act, null); assert.equal(far.why, 'No post in reach');
  assert.equal(planPlace({ robot: { ...mk(-6.3, 0), held: [] }, preset: arm, mode: 'auto', posts, tune }).act, null);
});
t('gamepad reading: deadzone, axis direction, flip, fine curve', () => {
  const pad = { buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0.05, -1, 0, 0] };
  pad.buttons[0].pressed = true;
  assert.equal(readBinding(pad, 'a0+'), 0); assert.equal(readBinding(pad, 'a1-'), 1); assert.equal(readBinding(pad, 'a1+'), 0);
  assert.equal(readBinding(pad, 'b0'), 1); assert.equal(readBinding(pad, 'b1'), 0); assert.equal(readBinding(pad, 'b1', { flipAB: true, deadzone: 12, fine: 0 }), 1);
  assert.ok(axisVal(0.5, 12, 100) < axisVal(0.5, 12, 0)); assert.equal(padLabel('b7'), 'RT'); assert.equal(padLabel('a2-'), 'R←');
});
console.log(`\n${n} tests passed`);
