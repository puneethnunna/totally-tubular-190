// Shared constants for the TOTALLY TUBULAR simulator.
// Units: meters, seconds, radians. World is Three.js y-up; the floor is the x/z plane.
// Field center is (0,0). Long axis = x. Blue drivers stand at -x, red drivers at +x.
// The field is diagonally symmetric: red geometry = blue geometry rotated 180° about y
// (x,z) -> (-x,-z). Use mirror() to derive one side from the other.

export const FIELD = {
  length: 16.5,          // x extent: -8.25 .. 8.25
  width: 8.0,            // z extent: -4 .. 4
  halfL: 8.25,
  halfW: 4.0,
  wallHeight: 0.5,
};

export const TIMING = {
  auto: 20,
  teleop: 105,
  endgame: 30,           // last 30 s of TELEOP
  assessDelay: 3,        // platforms assessed at T+3 s
  get total() { return this.auto + this.teleop; },
};

export const POINTS = {
  floor:  { teleop: 1, auto: 2 },
  lower:  { teleop: 2, auto: 4 },
  upper:  { teleop: 3, auto: 6 },
  platform: [0, 4, 6, 10, 15],   // index = level
  foul: 4,
  techFoul: 10,
  maxScoringPerPost: 3,
  maxPhysicalPerPost: 4,
};

export const RP = { win: 3, tie: 1, posts8: 1, posts12: 1, platform16: 1 };

export const TUBE = {
  outerRadius: 0.25,     // footprint radius on the floor
  tubeRadius: 0.07,      // torus cross-section radius
  mass: 0.4,
  friction: 2.5,         // linear damping on floor (1/s)
  perAlliance: 108,
  midfieldPerAlliance: 8,
};

export const ROBOT = {
  size: 0.80,            // frame square (≈30x30in, 120in perimeter)
  bumper: 0.10,          // bumper thickness each side
  get outer() { return this.size + 2 * this.bumper; },   // 1.0 m bumper-to-bumper
  radius: 0.5,           // collision circle radius
  maxExtension: 0.51,    // 20 in beyond frame
  endgameExtension: 0.76,// 30 in (R110)
  carryLimit: 2,         // G101
};

export const mirror = (p) => ({ ...p, x: -p.x, z: -p.z });
const rect = (x0, x1, z0, z1) => ({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
const mirrorRect = (r) => rect(-r.x1, -r.x0, -r.z1, -r.z0);
export const inRect = (r, x, z, pad = 0) => x >= r.x0 + pad && x <= r.x1 - pad && z >= r.z0 + pad && z <= r.z1 - pad;

// ---------- BLUE-side definitions (red derived by mirroring) ----------
// Blue SCORES on the +x end (in front of RED driver stations). Blue LOADS at the -x end.
const POST_Z_RED = [-1.13, -0.50, 0.12, 0.77, 1.39, 2.03, 2.66, 3.30]; // red posts on the -x wall
const blueScoringZone = rect(5.18, 8.25, -4.0, 1.86);
const blueFloorArea   = rect(7.0, 8.25, -4.0, 1.86);   // LEVEL 1 SCORING AREA (no cap)
const blueLoadingZone = rect(-8.25, -5.18, -4.0, -1.86);
const bluePlatformZone = rect(-1.9, 1.9, -4.0, -1.4);
const blueL1Area      = rect(-1.8, 1.8, -2.7, -1.5);   // taped carpet LEVEL 1
const bluePlatforms = [ // LEVEL 2,3,4 raised boxes against the -z wall
  { level: 2, height: 0.20, ...rect(-1.9, -0.633, -4.0, -2.7) },
  { level: 3, height: 0.40, ...rect(-0.633, 0.633, -4.0, -2.7) },
  { level: 4, height: 0.60, ...rect(0.633, 1.9, -4.0, -2.7) },
];
const blueChutes = [ // where human-player tubes enter; dir points into the field
  { x: -7.25, z: -4.0, dirX: 0, dirZ: 1 },
  { x: -6.20, z: -4.0, dirX: 0, dirZ: 1 },
  { x: -8.25, z: -2.95, dirX: 1, dirZ: 0 },
];
const blueStarts = [ // inside own scoring zone, outside floor area (G109); heading π = facing -x
  { x: 6.1, z: -2.8, heading: Math.PI },
  { x: 6.1, z: -0.9, heading: Math.PI },
  { x: 6.1, z: 1.0, heading: Math.PI },
];
const blueStagingRow = POST_Z_RED.map((_, i) => ({ x: 0.29, z: [-2.24, -1.64, -1.05, -0.40, 0.25, 0.91, 1.56, 2.19][i] }));
// Short wall separating blue LOADING ZONE from red SCORING ZONE (robots cannot cross).
const blueShortWall = { ...rect(-8.25, -5.18, -1.89, -1.83), height: 0.5 };
const blueDriverCam = { pos: { x: -10.8, y: 7.0, z: 0.8 }, look: { x: 0.8, y: 0, z: 0 } }; // high enough to see over the post wall

function makePosts(alliance) {
  // Posts that `alliance` scores on. Red posts sit on the -x wall, protruding toward +x.
  const posts = [];
  for (const tier of ['lower', 'upper']) {
    POST_Z_RED.forEach((z, index) => {
      const p = {
        id: `${alliance}-${tier}-${index}`, alliance, tier, index,
        baseX: -8.25, z,
        tipX: tier === 'lower' ? -7.85 : -7.95,
        y: tier === 'lower' ? 0.9 : 1.7,
        dirX: 1,
      };
      if (alliance === 'blue') { p.baseX = -p.baseX; p.tipX = -p.tipX; p.z = -p.z; p.dirX = -1; }
      posts.push(p);
    });
  }
  return posts;
}

function side(alliance) {
  const b = alliance === 'blue';
  const m = (r) => (b ? r : mirrorRect(r));
  const mp = (p) => (b ? { ...p } : { ...mirror(p), dirX: -p.dirX, dirZ: -p.dirZ, heading: p.heading !== undefined ? p.heading + Math.PI : undefined });
  return {
    alliance,
    color: b ? 0x1f5bff : 0xe8202a,
    scoringZone: m(blueScoringZone),
    floorArea: m(blueFloorArea),
    loadingZone: m(blueLoadingZone),
    platformZone: m(bluePlatformZone),
    l1Area: m(blueL1Area),
    platforms: bluePlatforms.map((p) => ({ ...p, ...m(p) })),
    chutes: blueChutes.map(mp),
    starts: blueStarts.map(mp),
    stagingRow: blueStagingRow.map(mp),
    shortWall: { ...m(blueShortWall), height: blueShortWall.height },
    posts: makePosts(alliance),
    driverCam: b ? blueDriverCam : { pos: { x: 10.8, y: 7.0, z: -0.8 }, look: { x: -0.8, y: 0, z: 0 } },
    driverStationX: b ? -8.6 : 8.6,
    // Joystick "up" on screen maps to this field direction for this alliance's drivers.
    screenForward: b ? { x: 1, z: 0 } : { x: -1, z: 0 },
    screenRight: b ? { x: 0, z: 1 } : { x: 0, z: -1 },
  };
}

export const SIDES = { blue: side('blue'), red: side('red') };
export const ALLIANCES = ['blue', 'red'];
export const opponent = (a) => (a === 'blue' ? 'red' : 'blue');
export const midline = 0; // x = 0 is center field

// Playable robot designs. `capabilities` drives sim + AI behaviour.
export const ROBOT_PRESETS = [
  { id: 'stacker', name: 'Swerve Stacker', drive: 'swerve', maxSpeed: 4.2, accel: 9, turnRate: 4.5,
    canLower: true, canUpper: true, canLaunch: false, maxClimb: 3, intakeTime: 0.25, placeTime: 0.7, climbTime: 1.2,
    blurb: 'Elevator + hook arm. Reaches both post tiers. Climbs to LEVEL 3.' },
  { id: 'tosser', name: 'Tank Tosser', drive: 'tank', maxSpeed: 4.6, accel: 10, turnRate: 3.8,
    canLower: true, canUpper: false, canLaunch: true, maxClimb: 2, intakeTime: 0.2, placeTime: 0.6, climbTime: 1.4,
    blurb: 'Flywheel launcher. Lobs tubes onto posts from inside the SCORING ZONE.' },
  { id: 'climber', name: 'Peak Climber', drive: 'swerve', maxSpeed: 3.6, accel: 7, turnRate: 4.0,
    canLower: true, canUpper: true, canLaunch: false, maxClimb: 4, intakeTime: 0.35, placeTime: 0.9, climbTime: 0.8,
    blurb: 'Slower stacker built for the endgame. The only design that reaches LEVEL 4.' },
  { id: 'sweeper', name: 'Floor Sweeper', drive: 'swerve', maxSpeed: 4.9, accel: 12, turnRate: 5.2,
    canLower: true, canUpper: false, canLaunch: false, maxClimb: 2, intakeTime: 0.12, placeTime: 0.45, climbTime: 1.0,
    blurb: 'Fast full-width intake. Floods the LEVEL 1 area and lower posts.' },
];

export const DEFAULT_TEAMS = {
  blue: ['1678', '254', '971'],
  red: ['2910', '118', '1323'],
};
