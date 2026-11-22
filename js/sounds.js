// Original synthesized match sounds (Web Audio API, no audio files). Safe to import/call in node (no AudioContext -> no-ops).
// createSounds() -> { play(name), setVolume(0..1), unlock() }
// Names: autoStart (alias 'start'), autoEnd, teleopStart, endgame, matchEnd.

export function createSounds() {
  const Ctx = typeof globalThis !== 'undefined' && (globalThis.AudioContext || globalThis.webkitAudioContext);
  let ctx = null, master = null, volume = 0.7, unlocked = false;

  function ensure() {
    if (ctx || !Ctx) return ctx;
    try {
      ctx = new Ctx();
      master = ctx.createGain(); master.gain.value = volume * 0.8;
      const comp = ctx.createDynamicsCompressor();   // keep stacked partials from clipping
      master.connect(comp); comp.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  // One enveloped oscillator -> optional lowpass -> master. opts: slideTo (Hz), vib (Hz depth), lp (cutoff), attack, release
  function tone(freq, t0, dur, type, gain, o = {}) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + (o.slideT ?? dur));
    if (o.vib) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = 6; lg.gain.value = o.vib; l.connect(lg); lg.connect(osc.frequency); l.start(t0); l.stop(t0 + dur + 0.1); }
    const at = o.attack ?? 0.01, rl = o.release ?? 0.08;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + at);
    g.gain.setValueAtTime(gain, Math.max(t0 + at, t0 + dur - rl));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let out = osc;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; osc.connect(f); out = f; }
    out.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }
  // Bell: inharmonic sine partials with exponential decay
  function bell(freq, t0, gain = 0.3, len = 1.6) {
    for (const [m, a, d] of [[1, 1, 1], [2.01, 0.5, 0.7], [2.76, 0.35, 0.5], [4.07, 0.2, 0.3]]) {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq * m;
      g.gain.setValueAtTime(gain * a, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len * d);
      osc.connect(g); g.connect(master); osc.start(t0); osc.stop(t0 + len * d + 0.05);
    }
  }
  // Breath noise burst (whistle / horn air)
  function noise(t0, dur, gain, hp = 1800) {
    const n = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = hp; f.Q.value = 1.2;
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master); src.start(t0);
  }
  // Field buzzer: two slightly detuned square/saw waves (beating) with a harsh low-passed edge
  function buzzer(freq, t0, dur, gain = 0.28) {
    tone(freq, t0, dur, 'square', gain, { lp: 2400, attack: 0.015, release: 0.12 });
    tone(freq * 1.012, t0, dur, 'sawtooth', gain * 0.7, { lp: 2000, attack: 0.015, release: 0.12 });
    tone(freq / 2, t0, dur, 'square', gain * 0.5, { lp: 900, attack: 0.02, release: 0.12 });
  }
  const chord = (fs, t0, dur, gain) => fs.forEach((f) => tone(f, t0, dur, 'sawtooth', gain, { lp: 3200, attack: 0.012, release: 0.15 }));

  const SOUNDS = {
    // Bright "charge" fanfare: quick rising arpeggio, then a held major chord
    autoStart(t) {
      [523.25, 659.25, 783.99].forEach((f, i) => chord([f, f * 2], t + i * 0.13, 0.12, 0.12));
      chord([783.99, 1046.5], t + 0.42, 0.16, 0.14);
      chord([659.25, 880], t + 0.62, 0.16, 0.14);
      chord([523.25, 659.25, 783.99, 1046.5], t + 0.82, 1.0, 0.13);
    },
    // Short, flat buzzer
    autoEnd(t) { buzzer(233, t, 0.9); },
    // Bell strikes plus a short horn blip after the transition
    teleopStart(t) {
      for (let i = 0; i < 3; i++) bell(1046.5, t + i * 0.22, 0.26, 1.3);
      tone(349.23, t + 0.1, 0.6, 'sawtooth', 0.16, { lp: 1400, attack: 0.03, release: 0.2 });
      tone(440, t + 0.1, 0.6, 'sawtooth', 0.12, { lp: 1400, attack: 0.03, release: 0.2 });
    },
    // Train-whistle-like warning: two rising, wobbling chord sweeps with breath noise
    endgame(t) {
      for (let k = 0; k < 2; k++) {
        const t0 = t + k * 0.95, d = 0.8;
        for (const f of [587, 740, 880]) tone(f * 0.85, t0, d, 'triangle', 0.14, { slideTo: f, slideT: 0.25, vib: 7, attack: 0.05, release: 0.25 });
        noise(t0, d, 0.05, 2600);
      }
    },
    // Long match-end buzzer
    matchEnd(t) { buzzer(196, t, 2.4, 0.3); },
    // Robot one-shots: bumper hit, tube onto a peg, intake grab
    thud(t) { noise(t, 0.12, 0.22, 160); tone(70, t, 0.1, 'sine', 0.2, { attack: 0.003, release: 0.08 }); },
    clack(t) { noise(t, 0.05, 0.12, 2600); tone(520, t, 0.05, 'triangle', 0.06, { attack: 0.002, release: 0.04 }); },
    grab(t) { noise(t, 0.09, 0.08, 900); },
  };
  SOUNDS.start = SOUNDS.autoStart;

  // Continuous robot voices (player robot): swerve/drive motor whine rising with speed, intake roller buzz, elevator hum.
  let voices = null;
  function voice(type, lp) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = type; f.type = 'lowpass'; f.frequency.value = lp; g.gain.value = 0;
    o.connect(f); f.connect(g); g.connect(master); o.start();
    return { o, f, g };
  }
  function setV(v, freq, gain, t) { v.o.frequency.setTargetAtTime(freq, t, 0.05); v.g.gain.setTargetAtTime(gain, t, 0.06); }

  // Real sound files override the synthesized cues when present: assets/sounds/<name>.(mp3|ogg|wav)
  // names: autoStart, autoEnd, teleopStart, endgame, matchEnd, thud, clack, grab. Missing files fall back silently.
  const files = {};
  let manifest = null;   // assets/sounds/manifest.json maps cue name -> file name; only listed files are fetched (no 404 noise)
  async function loadFile(name) {
    if (name in files) return files[name];
    files[name] = null;
    try {
      if (!manifest) { const m = await fetch(new URL('../assets/sounds/manifest.json', import.meta.url)); manifest = m.ok ? await m.json() : {}; }
      const file = manifest[name]; if (!file) return null;
      const res = await fetch(new URL(`../assets/sounds/${file}`, import.meta.url)); if (!res.ok) return null;
      files[name] = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch (e) { /* missing or undecodable: keep the synthesized cue */ }
    return files[name];
  }
  function playFile(buf, t) { const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = buf; g.gain.value = 1.0; s.connect(g); g.connect(master); s.start(t); }

  return {
    preload() { try { if (ensure()) for (const n of ['autoStart', 'autoEnd', 'teleopStart', 'endgame', 'matchEnd']) loadFile(n); } catch (e) { /* ignore */ } },
    play(name) {
      try {
        const fn = SOUNDS[name];
        if (!fn || volume <= 0 || !ensure()) return false;
        if (ctx.state === 'suspended') ctx.resume?.();
        const t0 = ctx.currentTime + 0.03, real = files[name];
        if (real) playFile(real, t0); else fn(t0);
        if (!(name in files)) loadFile(name);   // fetch a real file for next time if one exists
        return true;
      } catch (e) { return false; }
    },
    // speed 0..1 (fraction of top speed), turn 0..1, intake bool, lift 0..1 (elevator speed)
    robot({ speed = 0, turn = 0, intake = false, lift = 0 } = {}) {
      try {
        if (volume <= 0 || !unlocked || !ensure()) return;
        if (!voices) voices = { a: voice('sawtooth', 900), b: voice('sawtooth', 700), roll: voice('sawtooth', 1400), roll2: voice('sawtooth', 2200), lift: voice('triangle', 800) };
        const t = ctx.currentTime, m = Math.min(1, Math.max(speed, turn * 0.7));
        setV(voices.a, 90 + 620 * m, 0.035 * Math.min(1, m * 1.6), t);
        setV(voices.b, 92.5 + 640 * m, 0.025 * Math.min(1, m * 1.6), t);
        // intake roller motor: a brushless whine that spins up/down (two detuned saws), not a buzz
        const spin = intake ? 1 : 0, wob = 1 + 0.01 * Math.sin(t * 23);
        setV(voices.roll, (230 + 160 * spin) * wob, intake ? 0.026 : 0, t);
        setV(voices.roll2, (462 + 330 * spin) * wob, intake ? 0.012 : 0, t);
        setV(voices.lift, 210 + 260 * lift, lift > 0.05 ? 0.035 * Math.min(1, lift * 2) : 0, t);
      } catch (e) { /* audio is optional */ }
    },
    silence() { try { if (voices) for (const v of Object.values(voices)) v.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } catch (e) { /* ignore */ } },
    setVolume(v) {
      volume = Math.min(1, Math.max(0, Number.isFinite(+v) ? +v : 0));
      try { if (master) master.gain.value = volume * 0.8; } catch (e) { /* ignore */ }
    },
    unlock() {
      try {
        if (!ensure()) return false;
        if (ctx.state === 'suspended') ctx.resume?.();
        if (!unlocked) { unlocked = true; const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); }
        return true;
      } catch (e) { return false; }
    },
  };
}
