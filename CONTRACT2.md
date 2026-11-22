# Round 2 contract — setup flow, STL robots, CAD field polish, cameras, physics

Read `CONTRACT.md` first; everything there still holds unless changed here. `js/config.js` is the
geometry source of truth (now measured from the CAD) — **nobody edits config.js** this round; put
new constants in your own module. frsim reference screenshots are in `ref/frsim/` (local only, not
in git): `00-pick-season`, `01-home`, `02-singleplayer`, `03-robot-picker`, `04/05-settings`,
`06/13-cam-third-person`, `07/14-cam-first-person`, `08/15-cam-driver-station`, `09-pause`,
`10-alliance-red`, `11-start-dragged`, `12-robot-picked-red`. Copy frsim's layout and feel, but use
our own name/branding (no FRS/WCP logos or sponsor names), and keep TOTALLY TUBULAR rules.

frsim tech notes: Three.js, `PCFSoftShadowMap`, `RoomEnvironment` + `PMREMGenerator` image-based
lighting, ACES/AgX tone mapping, `MeshPhysicalMaterial` for clear panels. No physics library —
custom JS physics like ours. UI tokens (dark theme): `--paper:#0b0d11; --surface:#161616;
--sunk:#232323; --ink:#eae8e3; --ink-2:#a8a8a8; --ink-3:#717171; --line:#ffffff14;
--line-strong:#ffffff26; --blue-alliance:#3d84fa; --red-alliance:#f14445; --gold:#f0c13e;`
Font: "Mona Sans" (Google Fonts, has a wdth axis) — headings 800 weight, `font-stretch:75%`,
uppercase; body 13–15px 600.

## Robot definitions (`js/robots.js`, owner: robots agent)

```js
// A robot the player or a CPU can drive.
RobotDef = {
  id: 'builtin-190' | 'stl-<uuid>',
  number: '254', name: 'Cheddar', team: 'Team nickname', place: 'City, ST',
  source: 'builtin' | 'stl',
  preset: {                 // what sim.js / ai.js read (superset of a ROBOT_PRESETS entry)
    id, name, drive: 'swerve'|'tank', maxSpeed, accel, turnRate,
    canLower, canUpper, canLaunch, maxClimb, intakeTime, placeTime, climbTime,
    radius,                 // collision circle radius (m), default ROBOT.radius
    mass,                   // kg incl. bumpers, default 61
    model: { kind: 'procedural', style: 'stacker'|'tosser'|'climber'|'sweeper' }
         | { kind: 'mesh', meshId },   // imported STL
  },
  stats: { speedFtS, accelFtS2, pushLb, capacity, ... }   // display-only, for the spec panel
}
export const ROSTER;                         // ~10 built-in CPU/player robots (real FRC team numbers, made-up designs; ROSTER[0] = team 190 = default player robot)
export async function listRobots();          // ROSTER + imported robots (IndexedDB), imported first
export async function getRobot(id);
export async function saveImportedRobot(def, meshData);   // persists to IndexedDB
export async function deleteRobot(id);
export async function ensureMeshes(defs);    // loads mesh data for 'mesh' models into the sync cache
export function getMeshSync(meshId);         // THREE.BufferGeometry or null (after ensureMeshes)
```
`js/stlImport.js`: `parseSTL(arrayBuffer) → {positions:Float32Array, triCount}` (binary + ASCII),
`prepareRobotMesh(parsed, {units:'auto'|'mm'|'in'|'m', upAxis:'z'|'y', rotateY:0|90|180|270})`
→ centered on its footprint, sitting on y=0, front on +x, decimated to ≤150k tris, plus
`{footprint:{x,z}, height, radius}`.
`js/importDialog.js`: `openImportDialog(hostEl) → Promise<RobotDef|null>` — a full-screen frsim-style
screen: drop/choose STL, live 3D preview with orient/units controls, team number/name, drivetrain,
choose an ability template (stacker/tosser/climber/sweeper) with editable stats, SAVE ROBOT.
`js/preview3d.js`: `createRobotPreview(canvasOrHost) → { show(def, alliance), dispose() }` —
turntable preview on a dark disc with a thin gold ring like frsim (used by home, setup, picker cards).
`js/models.js`: `createRobotModel(robotState)` must support `preset.model.kind==='mesh'` (use
`getMeshSync`, add alliance-colored bumpers sized from the footprint + team number) and the four
procedural styles. A CPU roster entry may vary color accents/heights so robots look distinct.

## Sim changes (owner: physics agent)
- `createSim({ robots: [...] })` accepts **1–6 robots**, any slots. `robots[i].preset` may be a preset
  id string (ROBOT_PRESETS) **or** a full preset object (RobotDef.preset). Use `preset.radius`/`mass`
  when present. Keep `sim.state` shape and all events.
- Realism (frsim-like feel): mass/inertia, traction-limited acceleration with a motor curve (accel
  falls toward top speed), swerve = independent translation + rotation, tank = skid-steer with high
  lateral friction, impulse-based robot–robot collisions using mass + restitution, pushing limited by
  traction (heavier/grippier wins), spin from off-center hits, tubes light/bouncy with rolling
  friction and air drag in flight. Deterministic. Update/extend tests; all must pass.
- fouls.js / ai.js / scoring.js / match.js must work with 1–6 robots (owner: physics agent).

## Renderer / field (owner: field agent)
- `renderer.setCameraMode(mode, alliance, robotId, opts)` modes: `'driver'` (fixed at eye height
  ~1.8 m behind own alliance end, offset by `opts.slot` 0/1/2 like real driver stations),
  `'third'` (hovers over and behind the robot ~3 m up, looking downfield from the alliance
  perspective, smooth follow), `'first'` (on the robot, front-top at ~0.75 m, looks along heading),
  `'top'` (debug overview). Old names 'chase' → treat as 'third'.
- `renderer.setOptions({ cameraFollow:'smooth'|'tight'|'locked', background:true|false })`.
- Field must look like the CAD: clear polycarbonate long walls (fix the opaque dark band on both
  long sides), CAD-like materials, env lighting + soft shadows, sparser spectators (≈25–35% fill,
  open steel bleachers like frsim).

## UI / flow (owner: ui agent)
Screens: PICK A GAME (cards; TOTALLY TUBULAR playable) → GAME HOME (title, menu: PLAY, IMPORT ROBOT,
RULES, SETTINGS, CHANGE GAME; right side = 3D robot carousel with number/name/place + pager like
frsim) → MATCH SETUP (frsim "SINGLE PLAYER" layout): Mode `SOLO (1v0)` / `1v1` / `2v2` / `3v3` vs CPU;
Robot card + CHANGE → CHOOSE YOUR ROBOT (grid of preview cards + spec panel + "+ IMPORT STL" card +
"DRIVE ####"); Alliance BLUE/RED; Camera DRIVER STATION / THIRD PERSON / FIRST PERSON; CPU
difficulty; lineup strip showing every robot in the match (CPU robots drawn from ROSTER, user can
click to swap); Starting spot map (drag, J/L rotate, clamped to G109 legal area, mirrored when
alliance changes); BACK / RULES / SETTINGS / START MATCH. In match: frsim scoreboard, C cycles
driver→third→first, V flips (driver station slot). Controls follow frsim keys where they fit our
game (WASD drive, J/L or ←/→ turn, Shift/F intake, Space score (auto tier: upper if able, else
lower), Z toggle tier, Q outtake/drop, X launch, G climb, H human tube, C camera, Esc pause, R
restart, 1/2/3 speed caps). Driver/third camera = field-relative from the alliance view; first
person = robot-relative.
