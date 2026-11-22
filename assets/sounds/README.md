# Field sound files (optional)

Drop audio files here to replace the game's built-in synthesized sounds. Use files you have the right to use
(for example the official field sounds FIRST provides to teams). Name them exactly:

| File | When it plays |
|---|---|
| `autoStart.mp3` | Match start / AUTO begins |
| `autoEnd.mp3` | AUTO ends (start of the 2 s transition) |
| `teleopStart.mp3` | TELEOP begins |
| `endgame.mp3` | ENDGAME warning (30 s left) |
| `matchEnd.mp3` | Match ends |
| `thud.mp3`, `clack.mp3`, `grab.mp3` | Robot bump, tube onto a peg, intake grab (optional) |

`.ogg` and `.wav` also work. Then list each file in `manifest.json`, for example:

```json
{ "autoStart": "autoStart.mp3", "autoEnd": "autoEnd.mp3", "teleopStart": "teleopStart.mp3", "endgame": "endgame.mp3", "matchEnd": "matchEnd.mp3" }
```

Anything not listed falls back to the built-in sound.
