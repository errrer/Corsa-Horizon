// Festival-style content: procedurally placed events (races, drift zones, speed traps, speed zones,
// danger-sign jumps), bonus boards and barn finds, plus the runtime that drives them.
import * as THREE from 'three';
import { S, FAM, world, roadFrame, roadOther, intersection, heightAt, getRamp, nearRoad, surfaceAt, SURF } from './terrain.js';
import { hash2, mulberry32, clamp, lerp, angDiff, fmtTime, pick } from './util.js';
import { Rival, randomRivalSpec, randomPaint, bumpPair } from './ai.js';
import { obb } from './collide.js';
import { CARS } from './cars.js';

export const TYPES = {
  sprint: { label: 'Street Race', color: '#58a6ff', hex: 0x58a6ff, icon: 'S' },
  circuit: { label: 'Circuit Race', color: '#a371f7', hex: 0xa371f7, icon: 'C' },
  cross: { label: 'Cross Country', color: '#3fb950', hex: 0x3fb950, icon: 'X' },
  drift: { label: 'Drift Zone', color: '#f0883e', hex: 0xf0883e, icon: 'D' },
  trap: { label: 'Speed Trap', color: '#f85149', hex: 0xf85149, icon: 'T' },
  zone: { label: 'Speed Zone', color: '#ff7b72', hex: 0xff7b72, icon: 'Z' },
  danger: { label: 'Danger Sign', color: '#e3b341', hex: 0xe3b341, icon: 'J' },
  barn: { label: 'Barn Find', color: '#d29922', hex: 0xd29922, icon: 'B' },
  board: { label: 'Bonus Board', color: '#f778ba', hex: 0xf778ba, icon: '+' },
};
const NAME_A = ['Hotfix', 'Merge', 'Rebase', 'Cherry-Pick', 'Fast-Forward', 'Stash', 'Detached HEAD', 'Force Push', 'Pull Request', 'Main Branch', 'Feature Flag', 'Release', 'Origin', 'Upstream', 'Blame', 'Bisect', 'Squash', 'Checkout', 'Localhost', 'Legacy Code', 'Dependency', 'Hash Rush', 'Sudo', 'Pipeline'];
const NAME_B = { sprint: ['Sprint', 'Dash', 'Run', 'Rush'], circuit: ['Circuit', 'Loop', 'Ring', 'Gauntlet'], cross: ['Cross Country', 'Trailblazer', 'Off-Road Run', 'Wild Fork'], drift: ['Drift Zone', 'Slide Show', 'Skid Row'], trap: ['Speed Trap', 'Radar Gate', 'Latency Test'], zone: ['Speed Zone', 'Throughput Test', 'Bandwidth Run'], danger: ['Danger Sign', 'Stack Overflow', 'Null Pointer Jump'] };
const cache = new Map();
const _i = { x: 0, z: 0 };

export function regionPOIs(rx, rz) {
  const key = rx + ',' + rz;
  if (cache.has(key)) return cache.get(key);
  const seed = world.seed, r = (k) => hash2(rx, rz, seed * 3 + k), list = [];
  const home = rx === 0 && rz === 0;
  const I = intersection(0, rz, 1, rx, {});
  const diff = clamp(1 + Math.floor(Math.hypot(rx, rz) / 3 + r(1) * 1.4), 1, 3);
  const nm = (type, k) => `${pick(NAME_A, r(20 + k))} ${pick(NAME_B[type], r(30 + k))}`;
  if (home || r(2) < 0.52) {
    const q = r(3), type = home ? 'sprint' : q < 0.4 ? 'sprint' : q < 0.65 ? 'circuit' : 'cross';
    const credits = Math.round((type === 'circuit' ? 4200 : type === 'cross' ? 3300 : 3000) * (0.8 + 0.4 * diff) / 100) * 100;
    list.push({ id: `race:${rx},${rz}`, type, name: nm(type, 0), x: I.x, z: I.z, rx, rz, diff, credits, xp: Math.round(credits * 0.2), seed: Math.floor(r(4) * 1e6), laps: 1 });
  }
  if (!home) {
    const ramp = getRamp(rx, rz);
    const tierMul = 1 + 0.2 * (diff - 1);
    const cr = (a) => a.map((v) => Math.round(v * (0.7 + 0.3 * diff) / 100) * 100);
    if (ramp) {
      list.push({ id: `danger:${rx},${rz}`, type: 'danger', name: nm('danger', 1), x: ramp.x - ramp.ux * 52, z: ramp.z - ramp.uz * 52, rx, rz, diff, ramp, tiers: [25, 45, 70], rewards: cr([1500, 3000, 6000]), xp: [150, 300, 600] });
    } else if (r(5) < 0.72) {
      const q = r(6), t0 = rx * S + 140 + r(7) * 90;
      const type = q < 0.36 ? 'drift' : q < 0.66 ? 'trap' : 'zone';
      const len = type === 'drift' ? 340 : type === 'zone' ? 520 : 0;
      const a = {}; roadFrame(0, rz, t0, a);
      const poi = { id: `${type}:${rx},${rz}`, type, name: nm(type, 2), x: a.x, z: a.z, yaw: a.yaw, rx, rz, diff, t0, t1: t0 + len, fam: 0, idx: rz, rewards: cr([1500, 3000, 6000]), xp: [150, 300, 600] };
      if (type === 'drift') poi.tiers = [4000, 12000, 30000].map((v) => Math.round(v * tierMul));
      else if (type === 'zone') poi.tiers = [85, 115, 145];
      else poi.tiers = [130, 175, 215];
      if (len) { const b = {}; roadFrame(0, rz, poi.t1, b); poi.x2 = b.x; poi.z2 = b.z; }
      list.push(poi);
    }
    if (r(8) < 0.15) {
      const rnd = mulberry32(Math.floor(r(9) * 1e9));
      for (let tries = 0; tries < 14; tries++) {
        const x = rx * S + 120 + rnd() * (S - 240), z = rz * S + 120 + rnd() * (S - 240);
        const h = heightAt(x, z);
        if (h < 4 || h > 70 || nearRoad(x, z).edge < 70 || surfaceAt(x, z, h) === SURF.WATER) continue;
        if (Math.abs(heightAt(x + 8, z) - h) > 2 || Math.abs(heightAt(x, z + 8) - h) > 2) continue;
        list.push({ id: `barn:${rx},${rz}`, type: 'barn', name: 'Barn Find', x, z, yaw: rnd() * 6.28, rx, rz, rumor: { x: x + (rnd() - 0.5) * 220, z: z + (rnd() - 0.5) * 220 } });
        break;
      }
    }
    if (r(10) < 0.5) {
      for (let k = 0; k < 2; k++) {
        const t = rz * S + 220 + k * 330 + r(11 + k) * 60, f = {}; roadFrame(1, rx, t, f);
        list.push({ id: `board:${rx},${rz}:${k}`, type: 'board', name: 'Bonus Board', x: f.x, z: f.z, yaw: f.yaw, rx, rz });
      }
    }
  }
  cache.set(key, list);
  return list;
}
export const clearPOICache = () => cache.clear();
export function poisInRect(x0, z0, x1, z1) {
  const out = [];
  for (let rz = Math.floor(z0 / S) - 1; rz <= Math.floor(z1 / S) + 1; rz++) for (let rx = Math.floor(x0 / S) - 1; rx <= Math.floor(x1 / S) + 1; rx++)
    for (const p of regionPOIs(rx, rz)) if (p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1) out.push(p);
  return out;
}

// ---------- routes ----------
function segPoints(gx, gz, dx, dz, out, lead = 0) {
  const a = {}, b = {};
  if (dx) {
    intersection(0, gz, 1, gx, a); intersection(0, gz, 1, gx + dx, b);
    const s = Math.sign(b.x - a.x) || 1, t0 = a.x - s * lead;
    for (let t = t0; (b.x - t) * s > 0; t += 8 * s) { const f = {}; roadFrame(0, gz, t, f); out.push({ x: f.x, z: f.z }); }
  } else {
    intersection(0, gz, 1, gx, a); intersection(0, gz + dz, 1, gx, b);
    const s = Math.sign(b.z - a.z) || 1, t0 = a.z - s * lead;
    for (let t = t0; (b.z - t) * s > 0; t += 8 * s) { const f = {}; roadFrame(1, gx, t, f); out.push({ x: f.x, z: f.z }); }
  }
}
function finishRoute(raw, loop, laps, startS, cps) {
  const step = 8;
  let pts = raw;
  const n0 = loop ? 4 : 6;
  for (let it = 0; it < n0; it++) {
    const q = pts.map((p) => ({ ...p }));
    for (let i = 0; i < pts.length; i++) {
      if (!loop && (i === 0 || i === pts.length - 1)) continue;
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
      q[i].x = pts[i].x * 0.5 + (a.x + b.x) * 0.25; q[i].z = pts[i].z * 0.5 + (a.z + b.z) * 0.25;
    }
    pts = q;
  }
  if (loop) pts.push({ ...pts[0] });
  // resample uniformly
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const len = cum[cum.length - 1], n = Math.floor(len / step) + 1, res = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(i * step, len);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const t = (d - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-6);
    res.push({ x: lerp(pts[j].x, pts[j + 1].x, t), z: lerp(pts[j].z, pts[j + 1].z, t), yaw: 0, curv: 0 });
  }
  if (loop) res[res.length - 1] = { ...res[0] };
  for (let i = 0; i < res.length; i++) {
    const a = res[Math.max(0, i - 1)], b = res[Math.min(res.length - 1, i + 1)];
    res[i].yaw = Math.atan2(b.x - a.x, b.z - a.z);
  }
  for (let i = 0; i < res.length; i++) {
    const a = res[(i - 2 + res.length) % res.length], b = res[(i + 2) % res.length];
    res[i].curv = Math.abs(angDiff(a.yaw, b.yaw)) / (4 * step);
  }
  const L = (res.length - 1) * step;
  return { pts: res, step, len: L, loop, laps, startS, cps };
}
export function buildRoute(poi) {
  const rnd = mulberry32(poi.seed || 1);
  if (poi.type === 'cross') {
    for (let tries = 0; tries < 24; tries++) {
      const ang = rnd() * 6.283, len = 2000 + rnd() * 600, raw = [], cps = [];
      let ok = true;
      for (let d = -80; d <= len; d += 8) {
        const x = poi.x + Math.sin(ang) * d, z = poi.z + Math.cos(ang) * d;
        if (d % 40 === 0 && heightAt(x, z) < 1.6) { ok = false; break; }
        raw.push({ x, z });
      }
      if (!ok && tries < 23) continue;
      const r = finishRoute(raw, false, 1, 80, null);
      r.cross = true; r.pts.forEach((p, i) => { p.yaw = ang; p.curv = 0; });
      return r;
    }
  }
  let raw = [];
  if (poi.type === 'circuit') {
    const sx = rnd() < 0.5 ? 1 : -1, sz = rnd() < 0.5 ? 1 : -1;
    segPoints(poi.rx, poi.rz, sx, 0, raw); segPoints(poi.rx + sx, poi.rz, 0, sz, raw);
    segPoints(poi.rx + sx, poi.rz + sz, -sx, 0, raw); segPoints(poi.rx, poi.rz + sz, 0, -sz, raw);
    return finishRoute(raw, true, poi.laps || 1, 0, null);
  }
  let gx = poi.rx, gz = poi.rz, last = [0, 0];
  const steps = 3 + (poi.diff > 1 ? 1 : 0);
  for (let k = 0; k < steps; k++) {
    const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter((o) => !(o[0] === -last[0] && o[1] === -last[1]));
    const o = opts[Math.floor(rnd() * opts.length)];
    segPoints(gx, gz, o[0], o[1], raw, k === 0 ? 80 : 0);
    gx += o[0]; gz += o[1]; last = o;
  }
  const f = {}; // finish a little past the last intersection
  raw.push({ x: raw[raw.length - 1].x, z: raw[raw.length - 1].z });
  return finishRoute(raw, false, 1, 80, null);
}

// ---------- event manager ----------
const iconCache = {};
function iconTex(type) {
  if (iconCache[type]) return iconCache[type];
  const cv = document.createElement('canvas'); cv.width = cv.height = 96;
  const c = cv.getContext('2d'), T = TYPES[type];
  c.fillStyle = '#0d1117'; c.beginPath(); c.arc(48, 48, 42, 0, 6.3); c.fill();
  c.lineWidth = 7; c.strokeStyle = T.color; c.stroke();
  c.fillStyle = T.color; c.font = 'bold 48px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(T.icon, 48, 52);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return (iconCache[type] = t);
}

export class EventManager {
  constructor(game) {
    this.g = game; this.markers = new Map(); this.race = null; this.chal = null; this.hud = null;
    this.near = null; this.cd = 0; this.locked = false; this.ribbon = null; this.gates = []; this.lastReg = '';
    this.beamGeo = new THREE.CylinderGeometry(1.1, 1.1, 90, 12, 1, true).translate(0, 45, 0);
    this.ringGeo = new THREE.RingGeometry(3.6, 4.4, 36).rotateX(-Math.PI / 2);
    this.matCache = {};
    this.boardGeo = new THREE.BoxGeometry(5, 1.6, 0.25);
    this.postGeo = new THREE.BoxGeometry(0.35, 6, 0.35);
    this.group = new THREE.Group(); game.scene.add(this.group);
    this.statusById = (id) => game.state.done[id] || null;
  }
  mat(type) {
    if (!this.matCache[type]) {
      const col = TYPES[type].hex;
      this.matCache[type] = {
        beam: new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
        ring: new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, side: THREE.DoubleSide, fog: false }),
        icon: new THREE.SpriteMaterial({ map: iconTex(type), depthWrite: false, fog: false }),
        post: new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.8 }),
      };
    }
    return this.matCache[type];
  }
  makeMarker(poi) {
    const g = new THREE.Group(), M = this.mat(poi.type);
    const y = heightAt(poi.x, poi.z);
    g.position.set(poi.x, y, poi.z);
    if (poi.type === 'board') {
      const f = new THREE.Group(); f.rotation.y = poi.yaw;
      for (const s of [-1, 1]) { const p = new THREE.Mesh(this.postGeo, M.post); p.position.set(s * 10.5, 3, 0); f.add(p); }
      const b = new THREE.Mesh(this.boardGeo, M.post); b.position.set(0, 6.4, 0); b.scale.set(4.4, 1, 1); f.add(b);
      g.add(f); g.userData.board = true;
    } else if (poi.type === 'barn') {
      const mat = new THREE.MeshStandardMaterial({ color: 0x8c2f23, roughness: 0.9 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(11, 6, 15), mat); body.position.y = 3; body.castShadow = true;
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 6.6, 3.4, 4).rotateY(Math.PI / 4), new THREE.MeshStandardMaterial({ color: 0x4a4a4f, roughness: 0.8 }));
      roof.scale.set(1, 1, 1.4); roof.position.y = 7.6; roof.castShadow = true;
      const door = new THREE.Mesh(new THREE.BoxGeometry(5, 4.6, 0.3), new THREE.MeshStandardMaterial({ color: 0x3a1a14 }));
      door.position.set(0, 2.3, 7.55);
      g.add(body, roof, door); g.rotation.y = poi.yaw; g.userData.barn = true; g.userData.model = [body, roof, door];
      const spr = new THREE.Sprite(M.icon); spr.scale.set(9, 9, 1); spr.position.y = 15; spr.visible = false; g.userData.spr = spr; g.add(spr);
      return g;
    } else {
      const beam = new THREE.Mesh(this.beamGeo, M.beam); beam.frustumCulled = false; g.add(beam);
      const ring = new THREE.Mesh(this.ringGeo, M.ring); ring.position.y = 0.3; g.add(ring);
      if (poi.x2 !== undefined) { // end marker
        const e = new THREE.Mesh(this.beamGeo, M.beam); e.frustumCulled = false; e.scale.set(0.6, 0.6, 0.6);
        e.position.set(poi.x2 - poi.x, heightAt(poi.x2, poi.z2) - y, poi.z2 - poi.z); g.add(e);
      }
      const spr = new THREE.Sprite(M.icon); spr.scale.set(11, 11, 1); spr.position.y = 20; g.add(spr);
    }
    return g;
  }

  update(dt, car, time) {
    const g = this.g, px = car.x, pz = car.z;
    // keep markers for nearby regions
    const rx0 = Math.floor(px / S), rz0 = Math.floor(pz / S);
    const key = rx0 + ',' + rz0 + ',' + world.seed;
    if (key !== this.lastReg) {
      this.lastReg = key;
      const keep = new Set();
      for (let rz = rz0 - 1; rz <= rz0 + 1; rz++) for (let rx = rx0 - 1; rx <= rx0 + 1; rx++) for (const p of regionPOIs(rx, rz)) {
        keep.add(p.id);
        if (!this.markers.has(p.id)) { const m = this.makeMarker(p); m.userData.poi = p; this.group.add(m); this.markers.set(p.id, m); }
      }
      for (const [id, m] of this.markers) if (!keep.has(id)) { this.group.remove(m); m.traverse((o) => { if (o.isMesh && o.userData.own) o.geometry.dispose(); }); this.markers.delete(id); }
    }
    this.near = null;
    if (this.cd > 0) this.cd -= dt;
    const st = g.state;
    for (const [id, m] of this.markers) {
      const p = m.userData.poi, d = Math.hypot(p.x - px, p.z - pz);
      m.visible = d < 1500;
      if (m.userData.board && st.boards[id]) m.visible = false;
      if (d < 380 && !st.discovered[id]) { st.discovered[id] = 1; if (p.type !== 'board') g.ui.toast(`Discovered: ${p.name}`, 'info'); }
      if (m.userData.barn) { m.userData.spr.visible = false; }
      if (this.race || this.chal) continue;
      if (p.type === 'sprint' || p.type === 'circuit' || p.type === 'cross') {
        if (d < 22 && car.speed < 25) this.near = p;
      } else if (p.type === 'barn') {
        if (d < 14 && !st.barns[id]) this.claimBarn(p);
      } else if (p.type === 'board') {
        if (!st.boards[id]) {
          const dx = px - p.x, dz = pz - p.z, sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
          const along = dx * sy + dz * cy, lat = dx * cy - dz * sy;
          if (Math.abs(along) < 3.2 && Math.abs(lat) < 11.5 && car.y - heightAt(p.x, p.z) < 8) this.collectBoard(p);
        }
      } else if (d < 180) this.checkChallengeStart(p, car);
    }
    if (this.race) this.updateRace(dt, car, time);
    if (this.chal) this.updateChallenge(dt, car);
    for (const gt of this.gates) gt.rotation.y += dt * 0.5;
  }

  // ---------- simple pickups ----------
  collectBoard(p) {
    const g = this.g;
    g.state.boards[p.id] = 1; g.addXp(250); g.skillAdd('Bonus Board', 1500, 'smash');
    g.ui.toast('BONUS BOARD  +250 XP', 'good'); g.audio.blip('coin');
  }
  claimBarn(p) {
    const g = this.g, st = g.state;
    st.barns[p.id] = 1;
    const locked = CARS.filter((c) => !st.cars[c.id]);
    if (locked.length) {
      const c = locked[Math.floor(Math.random() * locked.length)];
      g.giveCar(c.id);
      g.ui.banner('BARN FIND!', `You found a ${c.name} (${c.cls} ${c.pi})`);
    } else { g.addCredits(30000); g.ui.banner('BARN FIND!', 'Collection complete: +30,000 CR'); }
    g.audio.blip('level'); g.addXp(1000);
  }

  // ---------- challenges (auto-start) ----------
  checkChallengeStart(p, car) {
    if (this.cd > 0) return;
    let ok = false;
    if (p.type === 'danger') {
      const r = p.ramp, dx = car.x - r.x, dz = car.z - r.z, u = dx * r.ux + dz * r.uz, v = dx * r.vx + dz * r.vz;
      ok = u > -56 && u < -40 && Math.abs(v) < 12 && car.speed > 12 && (Math.sin(car.yaw) * r.ux + Math.cos(car.yaw) * r.uz) > 0.7;
    } else {
      const t = p.fam === 0 ? car.x : car.z;
      const lat = Math.abs(p.fam === 0 ? car.z - roadOther(0, p.idx, t) : 0);
      const fwd = Math.sin(car.yaw) > 0.4;
      ok = t >= p.t0 - 2 && t < p.t0 + 14 && lat < 14 && fwd && car.speed > 8;
    }
    if (!ok) return;
    this.chal = { poi: p, t: 0, score: 0, dist: 0, max: 0, state: 'run', driftStart: this.g.driftTotal, air: false, start: null };
    this.g.ui.toast(`${TYPES[p.type].label.toUpperCase()}: ${p.name}`, 'info'); this.g.audio.blip('cp');
  }
  stars(poi, v) { return v >= poi.tiers[2] ? 3 : v >= poi.tiers[1] ? 2 : v >= poi.tiers[0] ? 1 : 0; }
  finishChallenge(v, label) {
    const c = this.chal, p = c.poi, g = this.g, st = g.state;
    const stars = this.stars(p, v), prev = (st.done[p.id] && st.done[p.id].stars) || 0;
    let cr = 0, xp = 20;
    for (let s = prev; s < stars; s++) { cr += p.rewards[s]; xp += p.xp[s]; }
    const best = Math.max(v, (st.done[p.id] && st.done[p.id].best) || 0);
    st.done[p.id] = { stars: Math.max(stars, prev), best };
    if (cr) g.addCredits(cr); g.addXp(xp);
    g.ui.banner(`${p.name}`, `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}  ${label}${cr ? `   +${cr.toLocaleString()} CR` : ''}`);
    g.audio.blip(stars ? 'ok' : 'bad');
    this.chal = null; this.hud = null; this.cd = 6;
  }
  updateChallenge(dt, car) {
    const c = this.chal, p = c.poi, g = this.g; c.t += dt;
    if (p.type === 'danger') {
      const r = p.ramp, dx = car.x - r.x, dz = car.z - r.z, u = dx * r.ux + dz * r.uz;
      if (!c.air && !car.grounded && u > 0 && u < r.L + 16) { c.air = true; c.start = { x: car.x, z: car.z }; }
      this.hud = { kind: 'danger', title: p.name, line: c.air ? `${Math.hypot(car.x - c.start.x, car.z - c.start.z).toFixed(0)} m` : 'Hit the ramp!', tiers: p.tiers, unit: 'm' };
      if (c.air && car.grounded) { const d = Math.hypot(car.x - c.start.x, car.z - c.start.z); this.finishChallenge(d, `${d.toFixed(0)} m`); return; }
      if (c.t > 14 || u > r.L + 90 || u < -70) { this.chal = null; this.hud = null; this.cd = 3; }
      return;
    }
    const t = p.fam === 0 ? car.x : car.z;
    if (p.type === 'trap') {
      c.max = Math.max(c.max, car.kmh);
      this.hud = { kind: 'trap', title: p.name, line: `${car.kmh.toFixed(0)} km/h`, tiers: p.tiers, unit: 'km/h' };
      if (t > p.t0 + 8) this.finishChallenge(c.max, `${c.max.toFixed(0)} km/h`);
      return;
    }
    c.dist += car.speed * dt;
    const lat = Math.abs(car.z - roadOther(0, p.idx, car.x));
    if (p.type === 'drift') {
      c.score = g.driftTotal - c.driftStart;
      this.hud = { kind: 'drift', title: p.name, line: `${Math.round(c.score).toLocaleString()} pts`, tiers: p.tiers, unit: 'pts', pct: clamp((t - p.t0) / (p.t1 - p.t0), 0, 1) };
      if (t >= p.t1) this.finishChallenge(c.score, `${Math.round(c.score).toLocaleString()} pts`);
    } else {
      const avg = c.dist / Math.max(c.t, 0.5) * 3.6;
      this.hud = { kind: 'zone', title: p.name, line: `${avg.toFixed(0)} km/h avg`, tiers: p.tiers, unit: 'km/h', pct: clamp((t - p.t0) / (p.t1 - p.t0), 0, 1) };
      if (t >= p.t1) this.finishChallenge(avg, `${avg.toFixed(0)} km/h avg`);
    }
    if (t < p.t0 - 20 || lat > 45 || c.t > 90) { this.chal = null; this.hud = null; this.cd = 3; g.ui.toast('Challenge failed', 'bad'); g.audio.blip('bad'); }
  }

  // ---------- races ----------
  startRace(poi) {
    const g = this.g;
    if (this.race || !poi) return;
    const route = buildRoute(poi);
    const rnd = mulberry32(poi.seed + 7);
    const spec = g.car.spec;
    const diffMul = [0.9, 1, 1.07, 1.14][g.state.settings.difficulty] || 1;
    const cruise = clamp(spec.top / 3.6 * 0.62, 34, 62) * diffMul * (0.88 + 0.07 * poi.diff);
    const slots = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) slots.push({ s: route.startS - 9 - r * 11, off: c ? 4 : -4 });
    const pi = Math.floor(rnd() * slots.length), mine = slots.splice(pi, 1)[0];
    const rivals = [];
    const names = ['ghost_commit', 'Nullpointer', 'rm_rf_slash', 'tabs_not_spaces', 'LGTM_bot', 'segfault', 'yak_shaver', 'merge_conflict'];
    for (let i = 0; i < 5; i++) {
      const sl = slots[i], rs = CARS[Math.floor(rnd() * CARS.length)];
      const rv = new Rival(g.scene, route, { s: sl.s, off: sl.off, name: names[(i + poi.seed) % names.length] }, rs, randomPaint(rnd), 0.93 + rnd() * 0.09);
      rivals.push(rv);
    }
    const smp = this.cpPos({ route }, mine.s), nx = Math.cos(smp.yaw), nz = -Math.sin(smp.yaw);
    g.placeCar(smp.x + nx * mine.off, smp.z + nz * mine.off, smp.yaw, 0);
    // checkpoints
    const total = route.loop ? route.len * route.laps : route.len;
    const cps = []; for (let s = 170; s < total - 40; s += 170) cps.push(s); cps.push(total);
    this.race = { poi, route, rivals, state: 'count', cd: 4.2, t: 0, cps, cp: 0, total, idx: 0, laps: 0, ps: 0, finished: false, finishT: 0, cruise, pos: 6, off: 0, lastBeep: 4, endTimer: 0 };
    this.locked = true;
    this.buildRibbon();
    this.ensureGates();
    g.ui.toast(`${poi.name}`, 'info');
    g.onEventStart(poi);
  }
  buildRibbon() {
    if (this.ribbon) { this.group.remove(this.ribbon); this.ribbon.geometry.dispose(); }
    const N = 40;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    const idx = []; for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    this.ribbon = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    this.ribbon.frustumCulled = false; this.ribbon.renderOrder = 3; this.ribbon.visible = false; this.group.add(this.ribbon); this.ribbonN = N;
  }
  ensureGates() {
    if (this.gates.length) return;
    const mk = (col) => {
      const g = new THREE.Group();
      const m = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.2, roughness: 0.4 });
      for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9, 0.7), m); p.position.set(s * 11, 4.5, 0); g.add(p); }
      const b = new THREE.Mesh(new THREE.BoxGeometry(23, 1, 0.7), m); b.position.set(0, 9, 0); g.add(b);
      const holder = new THREE.Group(); holder.add(g); holder.userData.inner = g; this.group.add(holder); holder.visible = false;
      return holder;
    };
    this.gateA = mk(0x58a6ff); this.gateB = mk(0x8b949e); this.gates = [];
  }
  cpPos(race, s) {
    const r = race.route;
    let d = s; if (r.loop) d = ((s % r.len) + r.len) % r.len;
    const f = clamp(d / r.step, 0, r.pts.length - 1), i = Math.floor(f), a = r.pts[i], b = r.pts[Math.min(i + 1, r.pts.length - 1)], t = f - i;
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), yaw: a.yaw };
  }
  updateRace(dt, car, time) {
    const R = this.race, g = this.g, r = R.route;
    R.t += R.state === 'run' || R.state === 'done' ? dt : 0;
    // player progress along the route
    {
      const n = r.pts.length, lo = R.idx - 4, hi = R.idx + 30;
      let best = 1e9, bi = R.idx;
      for (let k = lo; k <= hi; k++) {
        const i = ((k % (n - 1)) + (n - 1)) % (n - 1);
        const d = (r.pts[i].x - car.x) ** 2 + (r.pts[i].z - car.z) ** 2;
        if (d < best) { best = d; bi = i; }
      }
      if (r.loop && R.idx > n * 0.85 && bi < n * 0.15) R.laps++;
      else if (r.loop && R.idx < n * 0.15 && bi > n * 0.85) R.laps--;
      R.idx = bi; R.off = Math.sqrt(best);
      R.ps = (r.loop ? R.laps * r.len : 0) + bi * r.step;
      if (!r.loop && bi === 0 && R.ps < r.startS) R.ps = bi * r.step;
    }
    const ahead = R.rivals.filter((v) => v.s > R.ps).length;
    R.pos = 1 + ahead;
    // countdown
    if (R.state === 'count') {
      R.cd -= dt;
      const sec = Math.ceil(R.cd);
      if (sec !== R.lastBeep) { R.lastBeep = sec; if (sec > 0 && sec <= 3) { g.ui.countdown(String(sec)); g.audio.blip('beep'); } }
      if (R.cd <= 0) { R.state = 'run'; R.t = 0; this.locked = false; g.ui.countdown('GO!'); g.audio.blip('go'); }
    }
    const others = [{ x: car.x, z: car.z, speed: car.speed }, ...R.rivals];
    const hold = R.state === 'count' || (g.mods && g.mods.f.freeze);
    for (const v of R.rivals) v.update(dt, { playerS: R.ps, cruise: R.cruise, rubber: true, t: R.t, hold, others });
    for (let i = 0; i < R.rivals.length; i++) for (let j = i + 1; j < R.rivals.length; j++) {
      const a = R.rivals[i], b = R.rivals[j], hit = obb(a, b);
      if (hit) bumpPair(a, b, hit);
    }
    // gates for the next checkpoints
    const next = R.cps[R.cp], last = R.cp === R.cps.length - 1;
    if (next !== undefined && R.state !== 'done') {
      const p = this.cpPos(R, next);
      this.gateA.visible = true; this.gateA.position.set(p.x, heightAt(p.x, p.z), p.z); this.gateA.rotation.y = p.yaw + Math.PI / 2 * 0;
      this.gateA.userData.inner.rotation.y = 0; this.gateA.rotation.y = p.yaw;
      const n2 = R.cps[R.cp + 1];
      if (n2 !== undefined) { const q = this.cpPos(R, n2); this.gateB.visible = true; this.gateB.position.set(q.x, heightAt(q.x, q.z), q.z); this.gateB.rotation.y = q.yaw; } else this.gateB.visible = false;
      if (R.state === 'run') {
        const d = Math.hypot(p.x - car.x, p.z - car.z);
        if ((d < 26 || R.ps >= next + 8) && R.ps >= next - 20) {
          R.cp++; g.audio.blip('cp');
          if (last) this.finishRace(); else g.ui.toast(`Checkpoint ${R.cp}/${R.cps.length}`, 'info');
        }
      }
    } else { this.gateA.visible = false; this.gateB.visible = false; }
    // racing line
    if (g.state.settings.line && R.state !== 'done' && !r.cross) this.updateRibbon(car); else if (this.ribbon) this.ribbon.visible = false;
    if (r.cross && R.state !== 'done' && next !== undefined) { /* cross country: beams show the way */ }
    // off route warning
    if (R.state === 'run' && !r.cross && R.off > 70) { R.offT = (R.offT || 0) + dt; if (R.offT > 4) { R.offT = 0; g.ui.toast('Off route - follow the line!', 'bad'); } } else R.offT = 0;
    if (R.state === 'done') { R.endTimer += dt; if (R.endTimer > 6) this.endRace(); }
    this.hud = { kind: 'race', pos: R.pos, total: R.rivals.length + 1, lap: r.loop ? clamp(R.laps + 1, 1, r.laps) : 0, laps: r.loop ? r.laps : 0, time: R.t, cp: R.cp, cps: R.cps.length, rivals: [...R.rivals].sort((a, b) => b.s - a.s).slice(0, 3).map((v) => v.name), pct: clamp(R.ps / R.total, 0, 1), name: R.poi.name };
  }
  updateRibbon(car) {
    const R = this.race, r = R.route, N = this.ribbonN, pos = this.ribbon.geometry.attributes.position.array, col = this.ribbon.geometry.attributes.color.array;
    const n = r.pts.length;
    for (let k = 0; k < N; k++) {
      const i = (R.idx + 2 + k * 2);
      const idx = r.loop ? i % (n - 1) : Math.min(i, n - 1);
      const p = r.pts[idx], nx = Math.cos(p.yaw), nz = -Math.sin(p.yaw), w = 1.1;
      const y = heightAt(p.x, p.z) + 0.3;
      pos[k * 6] = p.x + nx * w; pos[k * 6 + 1] = y; pos[k * 6 + 2] = p.z + nz * w;
      pos[k * 6 + 3] = p.x - nx * w; pos[k * 6 + 4] = y; pos[k * 6 + 5] = p.z - nz * w;
      const c = clamp(p.curv * 55, 0, 1);
      const cr = lerp(0.25, 1, Math.min(1, c * 2)), cg = c < 0.5 ? 1 : lerp(1, 0.1, (c - 0.5) * 2), cb = 0.2;
      for (let q = 0; q < 2; q++) { col[k * 6 + q * 3] = cr; col[k * 6 + q * 3 + 1] = cg; col[k * 6 + q * 3 + 2] = cb; }
    }
    this.ribbon.geometry.attributes.position.needsUpdate = true; this.ribbon.geometry.attributes.color.needsUpdate = true;
    this.ribbon.visible = true;
  }
  finishRace() {
    const R = this.race, g = this.g, st = g.state;
    if (R.finished) return;
    R.finished = true; R.state = 'done'; R.finishT = R.t;
    const fin = R.rivals.filter((v) => v.finished).length;
    const pos = 1 + fin;
    const mult = [1, 1, 0.7, 0.5, 0.35, 0.25, 0.2][pos] || 0.2;
    const cr = Math.round(R.poi.credits * mult * [0.8, 1, 1.25, 1.6][st.settings.difficulty] / 100) * 100;
    const xp = Math.round(R.poi.xp * mult * 2);
    const prev = st.done[R.poi.id];
    const bestT = prev && prev.bestT ? Math.min(prev.bestT, R.t) : R.t;
    st.done[R.poi.id] = { stars: Math.max(pos === 1 ? 3 : pos <= 3 ? 2 : 1, (prev && prev.stars) || 0), bestT, bestPos: Math.min(pos, (prev && prev.bestPos) || 99) };
    st.stats.races++; if (pos === 1) st.stats.wins++;
    g.addCredits(cr); const lv = g.addXp(xp);
    if (pos === 1 && !(prev && prev.won)) { st.wheelspins++; st.done[R.poi.id].won = 1; }
    g.audio.blip(pos <= 3 ? 'level' : 'ok');
    g.ui.showResults({ title: R.poi.name, pos, total: R.rivals.length + 1, time: R.t, best: bestT, credits: cr, xp, spin: pos === 1 && !(prev && prev.won) });
    this.locked = false;
  }
  endRace() {
    const R = this.race; if (!R) return;
    for (const v of R.rivals) v.dispose();
    this.race = null; this.hud = null; this.locked = false; this.cd = 5;
    this.gateA.visible = false; this.gateB.visible = false; if (this.ribbon) this.ribbon.visible = false;
    this.g.onEventEnd();
  }
  cancel() {
    if (this.race) { this.endRace(); this.g.ui.toast('Event cancelled', 'info'); }
    this.chal = null; this.hud = null;
  }
  tryStart() { if (this.near && !this.race) { this.startRace(this.near); return true; } return false; }
  rivalsList() { return this.race ? this.race.rivals : []; }
}
