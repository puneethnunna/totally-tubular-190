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
  };
  SOUNDS.start = SOUNDS.autoStart;

  return {
    play(name) {
      try {
        const fn = SOUNDS[name];
        if (!fn || volume <= 0 || !ensure()) return false;
        if (ctx.state === 'suspended') ctx.resume?.();
        fn(ctx.currentTime + 0.03);
        return true;
      } catch (e) { return false; }
    },
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
