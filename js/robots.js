import * as THREE from 'three';
import { ROBOT_PRESETS, ROBOT } from './config.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { packMesh, unpackMesh, geometryFromData, setCreaseFn } from './stlImport.js';

setCreaseFn(toCreasedNormals);

const M2FT = 3.28084, KG2LB = 2.20462;
export const TEMPLATES = ROBOT_PRESETS.map((p) => p.id);

export function deriveStats(p, extra = {}) {
  const tags = [p.drive === 'tank' ? 'TANK' : 'SWERVE'];
  if (p.canUpper) tags.push('REACHES UPPER POSTS');
  else if (p.canLower) tags.push('LOWER POSTS ONLY');
  if (p.canLaunch) tags.push('LAUNCHES');
  if (p.maxClimb >= 2) tags.push('CLIMBS L' + p.maxClimb);
  if (p.intakeTime <= 0.15) tags.push('FAST INTAKE');
  return {
    speedFtS: +(p.maxSpeed * M2FT).toFixed(1), accelFtS2: Math.round(p.accel * M2FT * 1.6),
    pushLb: Math.round((p.mass || 61) * KG2LB * (p.drive === 'tank' ? 1.15 : 0.95)),
    intakeRate: +(1 / p.intakeTime).toFixed(1), capacity: '2 TUBES', tags, ...extra,
  };
}

// Build a full preset from a ROBOT_PRESETS template id + overrides.
export function buildPreset(template, over = {}) {
  const t = ROBOT_PRESETS.find((p) => p.id === template) || ROBOT_PRESETS[0];
  const { blurb, ...base } = t;
  return { ...base, radius: ROBOT.radius, mass: 61, ...over, id: t.id, model: over.model || { kind: 'procedural', style: t.id } };
}

function entry(number, name, team, place, tpl, o = {}, model = {}, statsExtra = {}) {
  const { speed = 1, accel = 1, ...rest } = o;
  const t = ROBOT_PRESETS.find((p) => p.id === tpl);
  const preset = buildPreset(tpl, {
    name, maxSpeed: +(t.maxSpeed * speed).toFixed(2), accel: +(t.accel * accel).toFixed(1),
    ...rest, model: { kind: 'procedural', style: tpl, ...model },
  });
  return { id: 'builtin-' + number, number: String(number), name, team, place, source: 'builtin', preset, stats: deriveStats(preset, statsExtra) };
}

// accents are powder-coat team colors (deep, slightly desaturated); bumpers are always alliance cloth.
// model.frame: 'black' = black anodized tube, 'silver' = satin aluminum tube.
export const ROSTER = [
  entry(11046, 'Bunyip', 'Brickworks Robotics', 'Harbor Falls', 'stacker', { speed: 1.05, mass: 64 }, { accent: 0xe8731a, frame: 'black', mastHeight: 1.0 }),
  entry(11414, 'Undertow', 'Tidewater Engineering', 'Saltmarsh Bay', 'tosser', { speed: 1.04, accel: 1.05 }, { accent: 0x14857c, frame: 'silver', mastHeight: 0.8 }),
  entry(11114, 'Redline', 'Foundry Forge', 'Ironvale', 'climber', { speed: 1.08, mass: 66 }, { accent: 0xc8202f, frame: 'black', mastHeight: 1.3 }),
  entry(13310, 'Static', 'Kestrel Alliance', 'Mesa Verde Flats', 'sweeper', { speed: 1.02, accel: 1.1, mass: 57 }, { accent: 0xf0b400, frame: 'black', mastHeight: 0.8 }),
  entry(16328, 'Gearbox', 'Burrow Collective', 'Copperfield', 'stacker', { speed: 0.92, accel: 0.9, mass: 68, placeTime: 0.6, canLower: true }, { accent: 0x6a3fb5, frame: 'silver', mastHeight: 1.12 }),
  entry(12910, 'Pronghorn', 'Cedar Run Makers', 'Cedar Run', 'stacker', { speed: 1.1, accel: 1.1, mass: 59, placeTime: 0.55 }, { accent: 0x1f62d6, frame: 'silver', mastHeight: 0.92 }),
  entry(11690, 'Comet Trail', 'Lodestar Robotics', 'Northpoint', 'tosser', { speed: 0.95, mass: 62, turnRate: 4.2 }, { accent: 0xc2338a, frame: 'black', mastHeight: 0.9 }),
  entry(17558, 'Ctrl-Z', 'Rewind Robotics', 'Lakeshore', 'sweeper', { speed: 1.06, accel: 1.0, mass: 55, canLower: true }, { accent: 0x0e93a3, frame: 'silver', mastHeight: 0.85 }),
  entry(10971, 'Phalanx', 'Mixtape Mechanics', 'Silver Hollow', 'climber', { speed: 1.0, accel: 1.1, climbTime: 0.7, mass: 63 }, { accent: 0xe3c000, frame: 'black', mastHeight: 1.25 }),
  entry(10118, 'Sea Monster', 'Bayou Builders', 'Gulfport Landing', 'stacker', { speed: 0.98, accel: 1.15, mass: 61, intakeTime: 0.2 }, { accent: 0x12a06b, frame: 'silver', mastHeight: 1.05 }),
];

// ---------- persistence (IndexedDB with in-memory fallback) ----------
const DB = 'tt-robots';
const memDefs = new Map(), memMeshes = new Map(), geoCache = new Map();
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    try {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('robots', { keyPath: 'id' }); rq.result.createObjectStore('meshes', { keyPath: 'id' }); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = rq.onblocked = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  if (!d) return undefined;
  try {
    return await new Promise((res, rej) => {
      const t = d.transaction(store, mode), r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  } catch { return undefined; }
}

export async function listRobots() {
  const stored = await tx('robots', 'readonly', (s) => s.getAll());
  const map = new Map(memDefs);
  for (const d of stored || []) map.set(d.id, d);
  const imported = [...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return [...imported, ...ROSTER];
}

export async function getRobot(id) {
  const b = ROSTER.find((r) => r.id === id);
  if (b) return b;
  return memDefs.get(id) || (await tx('robots', 'readonly', (s) => s.get(id))) || null;
}

export async function saveImportedRobot(def, meshData) {
  const id = def.id && def.id.startsWith('stl-') ? def.id : 'stl-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const finish = ['aluminum', 'black', 'team'].includes(def.finish) ? def.finish : (def.preset && def.preset.model && def.preset.model.finish) || 'aluminum';
  const model = { kind: 'mesh', meshId: id, footprint: meshData.footprint, height: meshData.height, finish };
  const out = { ...def, finish, id, source: 'stl', createdAt: def.createdAt || Date.now(), preset: { ...def.preset, radius: meshData.radius, model } };
  out.stats = deriveStats(out.preset, def.stats && { sizeIn: def.stats.sizeIn });
  geoCache.set(id, geometryFromData(THREE, meshData));
  memDefs.set(id, out); memMeshes.set(id, packMesh(meshData));
  await tx('meshes', 'readwrite', (s) => s.put({ id, ...packMesh(meshData) }));
  await tx('robots', 'readwrite', (s) => s.put(out));
  return out;
}

export async function deleteRobot(id) {
  memDefs.delete(id); memMeshes.delete(id);
  const g = geoCache.get(id); if (g) g.dispose();
  geoCache.delete(id);
  await tx('robots', 'readwrite', (s) => s.delete(id));
  await tx('meshes', 'readwrite', (s) => s.delete(id));
}

export async function ensureMeshes(defs) {
  for (const d of defs || []) {
    const m = d && d.preset && d.preset.model;
    if (!m || m.kind !== 'mesh' || geoCache.has(m.meshId)) continue;
    const packed = memMeshes.get(m.meshId) || (await tx('meshes', 'readonly', (s) => s.get(m.meshId)));
    if (packed) geoCache.set(m.meshId, geometryFromData(THREE, unpackMesh(packed)));
  }
}

export function getMeshSync(meshId) { return geoCache.get(meshId) || null; }

// Register an in-memory geometry (e.g. an unsaved import preview) under a mesh id.
export function setMeshGeometry(meshId, geometry) {
  const old = geoCache.get(meshId);
  if (old && old !== geometry) old.dispose();
  geoCache.set(meshId, geometry);
}
