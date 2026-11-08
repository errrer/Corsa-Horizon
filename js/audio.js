// Fully synthesized audio (no files): engine, tyres, wind, rain, collisions, UI and a
// small procedural radio with several stations.
export const STATIONS = [
  { name: 'Radio Off', bpm: 0 },
  { name: 'Corsa FM 101.1 - Synthwave', bpm: 108, root: 45, scale: [0, 3, 5, 7, 10], prog: [0, -4, -2, -5], style: 'synth' },
  { name: 'Commit Beats - Four on the Floor', bpm: 124, root: 40, scale: [0, 2, 3, 5, 7, 8, 10], prog: [0, 0, -2, -4], style: 'house' },
  { name: 'Merge Lo-fi - Chill Hop', bpm: 76, root: 43, scale: [0, 2, 4, 7, 9], prog: [0, 5, -3, -5], style: 'lofi' },
  { name: 'Hotfix Radio - Breakbeat', bpm: 140, root: 38, scale: [0, 1, 4, 5, 7, 8], prog: [0, 0, 1, -2], style: 'break' },
];
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioSys {
  constructor() { this.ctx = null; this.station = 0; this.vol = { master: 0.7, music: 0.5, sfx: 0.8 }; this.ready = false; this.step = 0; this.nextT = 0; this.hornOn = false; }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.connect(this.master);
    const comp = ctx.createDynamicsCompressor(); comp.connect(this.music); this.musicBus = comp;
    this.setVolumes(this.vol);
    // noise buffer
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    const loopNoise = (type, freq, q) => {
      const s = ctx.createBufferSource(); s.buffer = nb; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(this.sfx); s.start();
      return { f, g };
    };
    this.tire = loopNoise('bandpass', 1100, 3);
    this.wind = loopNoise('lowpass', 500, 0.5);
    this.rainN = loopNoise('highpass', 2500, 0.3);
    this.dirtN = loopNoise('lowpass', 900, 0.7);
    // engine: 3 oscillators -> filter -> gain
    this.eFilter = ctx.createBiquadFilter(); this.eFilter.type = 'lowpass'; this.eFilter.frequency.value = 800;
    this.eGain = ctx.createGain(); this.eGain.gain.value = 0;
    this.eOsc = [['sawtooth', 1, 0.5], ['square', 0.5, 0.35], ['sawtooth', 2, 0.18]].map(([t, m, g]) => {
      const o = ctx.createOscillator(); o.type = t; const og = ctx.createGain(); og.gain.value = g;
      o.connect(og); og.connect(this.eFilter); o.start(); return { o, m };
    });
    this.eFilter.connect(this.eGain); this.eGain.connect(this.sfx);
    // turbo whistle
    this.turbo = ctx.createOscillator(); this.turbo.type = 'sine'; this.tg = ctx.createGain(); this.tg.gain.value = 0;
    this.turbo.connect(this.tg); this.tg.connect(this.sfx); this.turbo.start();
    this.ready = true;
  }
  setVolumes(v) {
    Object.assign(this.vol, v);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master, t, 0.05);
    this.music.gain.setTargetAtTime(this.vol.music * 0.8, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
  }
  // per-frame driving sound
  update(c, wx, paused) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, k = 0.06;
    if (paused) { this.eGain.gain.setTargetAtTime(0, t, 0.05); this.tire.g.gain.setTargetAtTime(0, t, 0.05); this.wind.g.gain.setTargetAtTime(0, t, 0.1); this.rainN.g.gain.setTargetAtTime(0, t, 0.1); return; }
    const cyl = c.spec.cyl || 4;
    const fire = ((c.rpm / 60) * cyl) / 2;
    for (const e of this.eOsc) e.o.frequency.setTargetAtTime(Math.max(18, fire * e.m), t, 0.03);
    const thr = c.throttleIn || 0;
    this.eFilter.frequency.setTargetAtTime(380 + c.rpm * 0.45 + thr * 1400, t, k);
    this.eGain.gain.setTargetAtTime((0.1 + 0.22 * thr) * (c.spec.cyl >= 8 ? 1.15 : 1) * (c.rpm > 400 ? 1 : 0), t, k);
    this.turbo.frequency.setTargetAtTime(2200 + c.rpm * 0.9, t, 0.08);
    this.tg.gain.setTargetAtTime(thr > 0.6 && c.rpm > 3000 ? 0.012 : 0, t, 0.1);
    const slip = c.grounded ? Math.min(1, Math.max(0, c.wheelSlip - 0.15)) : 0;
    const asph = c.surf === 0;
    this.tire.g.gain.setTargetAtTime(asph ? slip * 0.22 : 0, t, 0.05);
    this.tire.f.frequency.setTargetAtTime(900 + slip * 900, t, 0.1);
    this.dirtN.g.gain.setTargetAtTime(!asph && c.grounded ? Math.min(0.18, c.speed * 0.005 + slip * 0.1) : 0, t, 0.1);
    this.wind.g.gain.setTargetAtTime(Math.min(0.28, (c.speed / 90) ** 2 * 0.3), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(300 + c.speed * 9, t, 0.1);
    this.rainN.g.gain.setTargetAtTime(wx.cur.rain * 0.07, t, 0.4);
  }
  env(type, freq, dur, gain, dest, delay = 0, freqEnd) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.sfx); o.start(t); o.stop(t + dur + 0.02);
  }
  noiseHit(dur, gain, freq, type = 'lowpass', delay = 0, dest) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.start(t, Math.random()); s.stop(t + dur);
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest || this.sfx);
  }
  crash(i) { if (!this.ready) return; const g = Math.min(1, i / 20); this.noiseHit(0.35, 0.5 * g + 0.1, 900); this.env('sine', 120, 0.25, 0.6 * g + 0.1, null, 0, 40); }
  landing(i) { if (!this.ready) return; const g = Math.min(1, i / 14); this.noiseHit(0.25, 0.3 * g, 400); this.env('sine', 90, 0.3, 0.5 * g, null, 0, 35); }
  shift() { if (!this.ready) return; this.noiseHit(0.08, 0.05, 2500, 'bandpass'); }
  pop() { if (!this.ready) return; this.noiseHit(0.06, 0.12, 700); }
  nitro() { if (!this.ready) return; this.noiseHit(0.8, 0.14, 1800, 'bandpass'); this.env('sawtooth', 200, 0.6, 0.05, null, 0, 700); }
  thunder(delay) { if (!this.ready) return; this.noiseHit(2.6, 0.55, 220, 'lowpass', delay); this.env('sine', 60, 2.2, 0.4, null, delay, 25); }
  blip(kind = 'ui') {
    if (!this.ready) return;
    if (kind === 'ui') this.env('triangle', 660, 0.08, 0.1);
    else if (kind === 'ok') { this.env('triangle', 520, 0.12, 0.14); this.env('triangle', 780, 0.18, 0.14, null, 0.08); }
    else if (kind === 'level') [523, 659, 784, 1046].forEach((f, i) => this.env('square', f, 0.2, 0.08, null, i * 0.09));
    else if (kind === 'beep') this.env('square', 440, 0.18, 0.12);
    else if (kind === 'go') this.env('square', 880, 0.45, 0.14);
    else if (kind === 'cp') { this.env('sine', 880, 0.2, 0.14); this.env('sine', 1320, 0.25, 0.1, null, 0.06); }
    else if (kind === 'bad') this.env('sawtooth', 180, 0.3, 0.1, null, 0, 90);
    else if (kind === 'coin') { this.env('square', 988, 0.08, 0.07); this.env('square', 1319, 0.2, 0.07, null, 0.07); }
    else if (kind === 'rewind') this.env('sawtooth', 900, 0.5, 0.08, null, 0, 120);
    else if (kind === 'photo') { this.noiseHit(0.05, 0.2, 3000, 'highpass'); this.env('square', 1800, 0.04, 0.05); }
  }
  horn(on) {
    if (!this.ready || on === this.hornOn) return;
    this.hornOn = on;
    if (on) {
      this.hornO = [392, 494].map((f) => { const o = this.ctx.createOscillator(); o.type = 'square'; o.frequency.value = f; const g = this.ctx.createGain(); g.gain.value = 0.06; o.connect(g); g.connect(this.sfx); o.start(); return o; });
    } else if (this.hornO) { this.hornO.forEach((o) => o.stop()); this.hornO = null; }
  }

  // ---------- radio ----------
  setStation(i) { this.station = ((i % STATIONS.length) + STATIONS.length) % STATIONS.length; this.step = 0; if (this.ctx) this.nextT = this.ctx.currentTime + 0.1; return STATIONS[this.station]; }
  radioTick() {
    if (!this.ready) return;
    const S = STATIONS[this.station];
    if (!S.bpm) return;
    const ctx = this.ctx, sixteenth = 60 / S.bpm / 4;
    if (this.nextT < ctx.currentTime) this.nextT = ctx.currentTime + 0.05;
    while (this.nextT < ctx.currentTime + 0.25) { this.playStep(S, this.step++, this.nextT, sixteenth); this.nextT += sixteenth; }
  }
  tone(type, f, t, dur, gain, filterF) {
    const ctx = this.ctx, o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let last = o;
    if (filterF) { const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = filterF; o.connect(fl); last = fl; }
    last.connect(g); g.connect(this.musicBus); o.start(t); o.stop(t + dur + 0.05);
  }
  drum(kind, t, gain = 1) {
    const ctx = this.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.7 * gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g); g.connect(this.musicBus); o.start(t); o.stop(t + 0.25);
    } else {
      const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; const f = ctx.createBiquadFilter();
      f.type = kind === 'hat' ? 'highpass' : 'bandpass'; f.frequency.value = kind === 'hat' ? 7500 : 1800;
      const g = ctx.createGain(); const dur = kind === 'hat' ? 0.05 : 0.14; g.gain.setValueAtTime((kind === 'hat' ? 0.16 : 0.35) * gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.musicBus); s.start(t, Math.random()); s.stop(t + dur + 0.02);
    }
  }
  playStep(S, n, t, sx) {
    const s = n % 16, bar = Math.floor(n / 16) % 4, chord = S.prog[bar];
    const root = S.root + chord, sc = S.scale;
    const note = (deg, oct = 0) => root + sc[((deg % sc.length) + sc.length) % sc.length] + 12 * (oct + Math.floor(deg / sc.length));
    const style = S.style;
    if (style === 'synth') {
      if (s % 4 === 0) this.drum('kick', t); if (s % 8 === 4) this.drum('snare', t); if (s % 2 === 0) this.drum('hat', t, 0.7);
      if (s % 2 === 0) this.tone('sawtooth', mtof(root + (s % 8 === 6 ? 7 : 0)), t, sx * 1.8, 0.16, 700);
      if ([0, 3, 6, 8, 11, 14].includes(s)) this.tone('square', mtof(note(s % 5 + bar, 2)), t, sx * 2, 0.045, 2600);
      if (s === 0) this.tone('triangle', mtof(root + 12), t, sx * 15, 0.06, 1200);
    } else if (style === 'house') {
      if (s % 4 === 0) this.drum('kick', t); if (s % 8 === 4) this.drum('snare', t, 0.8); if (s % 4 === 2) this.drum('hat', t);
      if (s % 4 === 2) this.tone('sawtooth', mtof(root + 12), t, sx * 1.4, 0.1, 1500);
      if (s % 8 === 0 || s % 8 === 3) this.tone('square', mtof(note(bar + s % 3, 1)), t, sx * 1.5, 0.05, 1800);
    } else if (style === 'lofi') {
      if (s === 0 || s === 10) this.drum('kick', t, 0.8); if (s === 4 || s === 12) this.drum('snare', t, 0.5); if (s % 2 === 0) this.drum('hat', t, 0.4);
      if (s % 8 === 0) { for (const d of [0, 2, 4]) this.tone('triangle', mtof(note(d, 1)), t, sx * 7, 0.07, 1400); }
      if ([2, 7, 11, 14].includes(s)) this.tone('sine', mtof(note(s % 4 + 1, 2)), t, sx * 2.5, 0.06);
    } else {
      if (s === 0 || s === 6 || s === 10) this.drum('kick', t); if (s === 4 || s === 12) this.drum('snare', t); if (s % 2 === 1 || s === 14) this.drum('hat', t, 0.7);
      if (s % 4 === 0 || s === 7 || s === 11) this.tone('sawtooth', mtof(root - 12 + (s === 7 ? 3 : 0)), t, sx * 2, 0.15, 500);
      if (s % 2 === 0) this.tone('square', mtof(note(s / 2 + bar, 2)), t, sx * 1, 0.035, 2200);
    }
  }
}
