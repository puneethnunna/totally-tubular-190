# Totally Tubular Simulator

**Play it:** https://puneethnunna.github.io/totally-tubular-190/

<img src="assets/frc190-logo.jpg" alt="FRC Team 190 logo" width="120" align="right">

Built by **Claude and Puneeth Nunna from FRC Team 190, Gompei and the H.E.R.D.** (Mass Academy & WPI).

A browser-based FRC robot simulator for **TOTALLY TUBULAR**, Team 190's mock game for the 2026 off-season. Drive a robot on a field built from our Onshape CAD, pick up tubes, hang them on your alliance's posts, and climb the platforms in the endgame. You can play alone or against CPU robots. There are no accounts and nothing to install.

## What it's for

- **Learning the game.** New members and drive-team candidates can learn the rules, field layout and scoring by playing, without needing a real field or robot.
- **Driver practice.** Practice with a keyboard or a controller from the driver station view, the same way you'd drive at an event.
- **Testing robot ideas.** Teams can import their robot's STL from CAD and drive it on the field, to get a feel for its size and speed before building it.
- **Strategy talks.** Run 1v1 to 3v3 matches against CPU robots to see how cycles, defense and the endgame play out.

## Inspired by frsim.com

This project was inspired by [frsim.com](https://frsim.com/), a browser simulator for official FRC games. We liked how quickly you can go from opening the page to driving, so we followed its overall flow:
- pick a game, then a home screen, then match setup and robot choice
- driver station, third-person and first-person cameras
- a similar control layout for keyboard and controller

Everything here is our own code, built for our own game. It isn't affiliated with frsim, FIRST or any sponsor, and the CPU teams are fictional.

## Features

- **CAD-accurate field** converted from the Onshape field STL, so posts, zones, platforms and chutes match the real dimensions.
- **Game modes:** Solo (1v0), 1v1, 2v2 and 3v3 against CPU robots, at easy, normal or hard difficulty.
- **Robot picker** with 10 built-in robots (stacker, tosser, climber and sweeper styles), plus **STL import** for your own CAD.
- **Realistic physics:**
  - mass, traction-limited acceleration, and swerve or tank drive
  - solid bumper collisions
  - an elevator and intake you can see move
- **Auto-align:** inside your scoring zone, press Place and the robot lines up with a post and scores.
- **Full rules:**
  - AUTO and TELEOP scoring, with the endgame in the last 30 s of TELEOP
  - fouls and tech fouls
  - ranking points
  - a results screen
- **Rebindable controls** for both keyboard and controller.

## Default controls

| Action | Keyboard | Controller |
|---|---|---|
| Drive / strafe | W A S D | Left stick |
| Turn | J / L | Right stick |
| Intake | Shift or F | LT |
| Raise elevator to UPPER (stays until changed) | Z | Y |
| Raise elevator to LOWER (stays until changed) | X | B |
| Score: places if a post is in reach, auto-aligns inside your scoring zone, otherwise shoots the tube out; floor drop if no tier chosen | Space or H | RT |
| Drop tube | Q | LB |
| Stow elevator (clears the tier) | E | X |
| Climb | G | RB |
| Request human-player tube | T | D-pad down |
| Change camera | C | L3 |
| Pause / restart | Esc / R | Back / Start |

## Running it locally

It's a static site with no build step. Browsers won't load it straight from your disk, so serve the folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

Tests run in Node: `node test/sim.test.mjs` (also `rules`, `robots`, `input`, `autoalign`, and `headless` for full CPU matches).

## Project layout

- `js/sim.js`: physics and game mechanics
- `js/match.js`, `js/scoring.js`, `js/fouls.js`: match clock, scoring and rules
- `js/ai.js`, `js/autoalign.js`: CPU robots and auto-align
- `js/renderer.js`, `js/field3d.js`, `js/models.js`: Three.js rendering
- `js/ui.js`, `js/main.js`, `js/input.js`: menus, HUD and controls
- `js/robots.js`, `js/stlImport.js`, `js/importDialog.js`: robot roster and STL import
- `assets/field.bin`: field mesh made from the CAD by `tools/stl_to_field.py`
- `GAME_MANUAL.txt`: the TOTALLY TUBULAR rules
