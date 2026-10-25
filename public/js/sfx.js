// Tiny synthesized sound effects (no audio files). Unlocks on first user gesture.
export const sfx = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem("dd_muted") === "1"; } catch (e) { /* storage unavailable */ }

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  function unlock() {
    const c = ensure();
    if (c && c.state === "suspended") c.resume().catch(() => {});
  }

  function tone({ freq = 440, to = null, type = "sine", dur = 0.12, gain = 0.18, at = 0, attack = 0.005, decay = null }) {
    const c = ensure();
    if (!c || muted) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (decay || dur));
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + (decay || dur) + 0.05);
  }

  const N = { C4: 261.63, E4: 329.63, G4: 392.0, A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5 };

  const sounds = {
    pop: () => tone({ freq: 620, to: 980, dur: 0.09, gain: 0.14 }),
    click: () => tone({ freq: 320, type: "square", dur: 0.04, gain: 0.06 }),
    tick: () => tone({ freq: 1100, type: "square", dur: 0.03, gain: 0.07 }),
    join: () => { tone({ freq: N.C5, dur: 0.1, gain: 0.12 }); tone({ freq: N.E5, dur: 0.14, gain: 0.12, at: 0.09 }); },
    whoosh: () => tone({ freq: 500, to: 90, type: "sawtooth", dur: 0.35, gain: 0.07 }),
    stamp: () => { tone({ freq: 140, to: 55, type: "triangle", dur: 0.18, gain: 0.3 }); tone({ freq: 90, to: 40, type: "sine", dur: 0.22, gain: 0.25, at: 0.01 }); },
    reveal: () => { [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => tone({ freq: f, dur: 0.11, gain: 0.13, at: i * 0.085, type: "triangle" })); tone({ freq: N.C6, dur: 0.5, gain: 0.1, at: 0.36, type: "sine" }); },
    scores: () => { tone({ freq: N.G5, dur: 0.22, gain: 0.12, type: "triangle" }); tone({ freq: N.C6, dur: 0.5, gain: 0.12, at: 0.18, type: "triangle" }); },
    fanfare: () => { [N.C5, N.C5, N.C5, N.E5, N.G5, N.C6].forEach((f, i) => tone({ freq: f, dur: i === 5 ? 0.7 : 0.16, gain: 0.14, at: i * 0.15, type: "square" })); },
    wrong: () => tone({ freq: 200, to: 120, type: "sawtooth", dur: 0.25, gain: 0.08 }),
    win: () => { [N.E5, N.G5, N.C6, N.E6].forEach((f, i) => tone({ freq: f, dur: 0.14, gain: 0.12, at: i * 0.1, type: "triangle" })); },
  };

  return {
    unlock,
    play(name) { try { if (sounds[name]) sounds[name](); } catch (e) { /* never let audio break the game */ } },
    get muted() { return muted; },
    setMuted(v) { muted = !!v; try { localStorage.setItem("dd_muted", muted ? "1" : "0"); } catch (e) { /* ignore */ } },
    toggle() { this.setMuted(!muted); return muted; },
  };
})();
