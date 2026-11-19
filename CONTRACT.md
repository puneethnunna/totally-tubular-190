# TOTALLY TUBULAR Sim — module contract

Static site, no build step, no accounts, no backend. Plain ES modules loaded by `index.html`.
Three.js comes from an import map (do NOT add other CDNs):

```html
<script type="importmap">{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
}}</script>
```

All geometry and constants live in `js/config.js` (read it first; never hard-code field numbers
elsewhere). The game rules are in `GAME_MANUAL.txt`; field pictures in `ref/` (image2.png is the
labelled top view, image1.png isometric, image3.png the post wall, image5.png the loading station).

Coordinate rules: Three.js y-up. Floor = x/z plane. A robot's `heading` h means its front points
along `(cos h, 0, sin h)` in (x, y, z). For a Three.js mesh whose front is modelled along +x,
set `mesh.rotation.y = -h`.

## Files and owners

| File | Owner | Exports |
|---|---|---|
| `js/config.js` | lead (done) | constants, `SIDES`, `ROBOT_PRESETS`, helpers |
| `js/sim.js` | sim agent | `createSim(options)` |
| `js/match.js` | rules agent | `createMatch(sim)` |
| `js/scoring.js` | rules agent | `computeScore(sim, match)` |
| `js/fouls.js` | rules agent | `createFoulTracker()` |
| `js/ai.js` | rules agent | `createBot(robotId, alliance, difficulty)` |
| `js/field3d.js` | render agent | `buildField(scene)` |
| `js/models.js` | render agent | `createRobotModel(robot)`, `createTubeModel()` |
| `js/renderer.js` | render agent | `createRenderer(canvas)` |
| `js/input.js` | ui agent | `createInput()` |
| `js/ui.js` | ui agent | menus, HUD, results |
| `js/main.js` | ui agent | boot + game loop glue |
| `index.html`, `styles.css` | ui agent | |

## Sim (`js/sim.js`)

```js
const sim = createSim({
  robots: [ // always 6: blue slots 0..2, red slots 0..2
    { id: 'blue-0', alliance: 'blue', slot: 0, number: '1678', preset: 'stacker', start: {x,z,heading}?, preload: true },
    ...
  ],
  midfield: { blue: 8, red: 8 },   // 0..8 staged tubes per alliance
  autoHumanPlayer: true,           // human players feed chutes automatically (outside AUTO)
});
sim.step(dt, inputs, phase)  // dt seconds (fixed 1/120 recommended); inputs: { [robotId]: Input }
                             // phase: 'pre'|'auto'|'teleop'|'endgame'|'post'|'done'
sim.state                    // see below; read-only for other modules
sim.drainEvents()            // returns and clears events since last call
sim.requestHumanTube(alliance, chuteIndex?) // manual human-player feed; false if not allowed
```

`Input` (every field optional, default 0/false):
```js
{ moveX, moveZ,     // field-frame translation command, -1..1 (swerve)
  rotate,           // -1..1, positive = CCW seen from above (heading increases)
  throttle, turn,   // -1..1 robot-relative (tank drive); turn>0 = CCW
  intake,           // held: run intake
  scoreLower, scoreUpper, scoreFloor, launch,  // edge-triggered (true for one step)
  climb }           // held: climb onto the next platform level in front of the robot
```
Swerve robots use moveX/moveZ/rotate; tank robots use throttle/turn (if a tank robot gets
moveX/moveZ with zero throttle, convert: turn toward that direction and drive — AI relies on this).

`sim.state`:
```js
{ time,                       // seconds simulated
  robots: [{ id, alliance, slot, number, preset /*object from ROBOT_PRESETS*/,
    x, z, y /*elevation of supporting surface*/, heading, vx, vz, omega,
    held: [tubeId,...],       // max 2 (G101)
    action: null | { type:'place'|'intake'|'launch'|'climb', t, duration, target },
    arm: 0..1,                // visual extension
    armTier: 'stow'|'floor'|'lower'|'upper',
    support: 0|1|2|3|4,       // 0 carpet, 1 inside own L1 taped area, 2..4 on that platform
    intakeOn: bool,
    contacts: [robotId,...] }],   // robots touching this step
  tubes: [{ id, origin /*'blue'|'red' allocation*/, x, y, z, vx, vy, vz,
    state: 'floor'|'held'|'post'|'flight'|'chute',
    holder /*robotId|null*/, post /*postId|null*/, stackIndex,
    placedInAuto: bool }],    // true if it reached its scored spot during AUTO
  posts: [ ...SIDES.blue.posts, ...SIDES.red.posts ] each with extra `tubes: [tubeId,...]`,
  reserve: { blue, red },      // loading-station reserve (108 - midfield - preloads)
}
```
Events: `{ type:'pickup'|'place'|'launch'|'land'|'feed'|'climb'|'contact'|'invalid', robotId?, tubeId?, postId?, text? }`.

Mechanics the sim must implement:
- Drive with accel limits, robot–robot circle collisions (push), walls (field boundary, both short
  walls, platform boxes as obstacles unless the robot is on top), robots push loose tubes.
- Intake: tube within front intake zone & held < 2 & intake held → after preset.intakeTime it is held.
- Place: robot near a post of ITS alliance (front within reach of post tip, facing the wall within
  ~35°, laterally within ~0.25 m of post z) → after placeTime the tube stacks on that post.
  scoreLower needs canLower, scoreUpper needs canUpper. Picks the nearest eligible post.
  scoreFloor drops/ejects a held tube in front of the robot onto the floor.
- Launch (canLaunch): throws a tube ballistically forward; if aimed within tolerance at an own post
  it hooks onto it (prefer upper), otherwise lands on the floor. (Legality is judged by fouls.js.)
- Climb: only in 'endgame'. Robot pressing climb while facing and touching a platform whose level
  is exactly one above its current support (carpet/L1 → L2 → L3 → L4), and level ≤ preset.maxClimb,
  rises onto it over climbTime. Robots driving off a platform drop down. Outside endgame platforms
  are plain obstacles.
- Human player: from reserve, a tube slides out of a chute into the loading zone. Never during AUTO.
  With autoHumanPlayer, each chute keeps ≤1 loose tube near its exit (cooldown ~1.5 s).
- Setup: midfield tubes on the staging rows, one preload per robot (preload:true), robots at starts.

## Match (`js/match.js`)
```js
const match = createMatch(sim);
match.update(dt)   // advances clock; snapshots AUTO tube scoring at end of AUTO
match.phase        // 'pre'|'auto'|'teleop'|'endgame'|'post'|'done'
match.elapsed, match.remaining   // remaining = time left in match (counts down from 125)
match.start(), match.pause(), match.resume()
match.autoSnapshot // score detail at end of AUTO (from computeScore)
match.final        // final result object once phase === 'done' (3 s after end)
```
'post' = the 3 s after the buzzer (robots disabled, platforms still settling); 'done' = assessed.

## Scoring (`js/scoring.js`)
`computeScore(sim, match)` →
```js
{ blue: { auto:{floor,lower,upper}, teleop:{floor,lower,upper}, platform:{levels:[..3], points},
          fouls: { foul, tech, points /*received from opponent's fouls*/ },
          tubePoints, total, fullPosts, rp: { win, posts8, posts12, platform16, total } }, red: {...} }
```
Tubes are generic; floor tubes score for the alliance whose LEVEL 1 SCORING AREA fully contains
them (center inside the area shrunk by TUBE.outerRadius). Post tubes beyond 3 don't score.
AUTO tubes count double; TELEOP count = total per level − AUTO count per level (manual §3.1).

## Fouls (`js/fouls.js`)
`tracker.update(sim, match, dt)` detects G103, G104, G105, G106, G108 (also awards LEVEL 4 to the
victim), G110, G111 escalation every 3 s while contact persists within 6 ft (1.83 m).
`tracker.list` = `[{ t, rule, type:'foul'|'tech'|'warning', against /*alliance*/, robotId, text }]`
`tracker.forcedLevel4` = Set of robotIds. `tracker.drainNew()` for UI toasts.

## AI (`js/ai.js`)
`createBot(robotId, alliance, difficulty /*'easy'|'normal'|'hard'*/)` → `{ think(sim, match, dt) → Input }`.
Collect tubes (midfield, loading-zone chute tubes, loose), drive to own scoring zone, place on the
emptiest own post (<3) using its preset's abilities, avoid protected zones/fouls, climb in endgame.

## Rendering
`createRenderer(canvas)` → `{ scene, camera, setCameraMode(mode, alliance, robotId), render(sim), resize() }`.
Camera modes: 'driver' (alliance driver-station view, like frsim), 'chase' (behind the robot),
'top' (overhead). `render(sim)` syncs all robot/tube meshes from `sim.state` every frame.
