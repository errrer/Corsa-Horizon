// Pure world model (no rendering): terrain height, road network, surfaces, ramps, towns.
// Everything is a deterministic function of (x, z, seed) so the world is endless.
import { makeNoise, clamp, lerp, smoothstep, hash2 } from './util.js';

export const S = 900; // road grid spacing / region size (m)
export const CH = 128; // render chunk size (m)
export const SEA = 0;
export const SURF = Object.freeze({ ASPHALT: 0, DIRT: 1, GRASS: 2, SAND: 3, ROCK: 4, SNOW: 5, WATER: 6 });
export const SURF_NAME = ['Asphalt', 'Dirt', 'Grass', 'Sand', 'Rock', 'Snow', 'Water'];
export const SURF_MU = [1.0, 0.74, 0.66, 0.56, 0.84, 0.48, 0.25];
export const SURF_ROLL = [1.0, 2.0, 3.0, 4.2, 2.2, 3.0, 9.0];

// Road families: 0 = paved along X, 1 = paved along Z, 2 = dirt along X, 3 = dirt along Z
export const FAM = [
  { axis: 0, off: 0, amp: 105, w: 10, dirt: false },
  { axis: 1, off: 0, amp: 105, w: 10, dirt: false },
  { axis: 0, off: S / 2, amp: 70, w: 4.6, dirt: true },
  { axis: 1, off: S / 2, amp: 70, w: 4.6, dirt: true },
];

export const world = { seed: 1, season: 'summer', festival: { x: 0, z: 0, h: 6, r: 170 } };
let nCont, nMtn, nDet, nRoad, nDry, nFor;
const rampCache = new Map();
const townCache = new Map();
const interCache = new Map();

export function initWorld(seed = 1, season = 'summer') {
  world.seed = seed | 0 || 1;
  world.season = season;
  nCont = makeNoise(world.seed * 7 + 1);
  nMtn = makeNoise(world.seed * 11 + 2);
  nDet = makeNoise(world.seed * 13 + 3);
  nRoad = makeNoise(world.seed * 17 + 4);
  nDry = makeNoise(world.seed * 19 + 5);
  nFor = makeNoise(world.seed * 23 + 6);
  rampCache.clear(); townCache.clear(); interCache.clear();
  world.festival.r = 170;
  world.festival.active = false; // so the plaza does not affect its own probe
  const c = intersection(0, 0, 1, 0, {});
  const mk = mask(c.x, c.z);
  world.festival.x = c.x; world.festival.z = c.z;
  world.festival.h = Math.max(smax(lowH(c.x, c.z, mk), 3), 7);
  world.festival.active = true;
}
export const setSeason = (s) => { world.season = s; };

function smax(a, b) { return 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + 4)); }
function mask(x, z) { return smoothstep(0.06, 0.62, nMtn.fbm(x * 0.0004 + 50, z * 0.0004 - 20, 2)); }
function lowH(x, z, mk) {
  const c = nCont.fbm(x * 0.00028, z * 0.00028, 3);
  const ridge = 1 - Math.abs(nMtn.n2(x * 0.0011, z * 0.0011));
  return c * 38 + 14 + mk * ridge * 16;
}

// ---------- roads ----------
export function roadOther(f, i, t) {
  const F = FAM[f];
  const sd = f * 13.37 + i * 3.71;
  return i * S + F.off + F.amp * (nRoad.n2(t / 820 + sd, sd * 0.37 + 11.1) + 0.22 * nRoad.n2(t / 260 + sd * 1.7, sd * 0.91 - 5.5));
}
function famDist(f, x, z) {
  const F = FAM[f];
  const t = F.axis === 0 ? x : z;
  const c = F.axis === 0 ? z : x;
  const i0 = Math.round((c - F.off) / S);
  const o = roadOther(f, i0, t);
  let d = Math.abs(c - o);
  const d1 = Math.abs(c - roadOther(f, c > o ? i0 + 1 : i0 - 1, t));
  return d1 < d ? d1 : d;
}
// index of the road in family f nearest to a position
export function nearestRoadIndex(f, x, z) {
  const F = FAM[f];
  const t = F.axis === 0 ? x : z;
  const c = F.axis === 0 ? z : x;
  const i0 = Math.round((c - F.off) / S);
  const o = roadOther(f, i0, t);
  const i1 = c > o ? i0 + 1 : i0 - 1;
  return Math.abs(c - roadOther(f, i1, t)) < Math.abs(c - o) ? i1 : i0;
}
// Position/heading of road (f, i) at coordinate t along it
export function roadFrame(f, i, t, out) {
  const F = FAM[f];
  const o = roadOther(f, i, t);
  const s = (roadOther(f, i, t + 1.5) - roadOther(f, i, t - 1.5)) / 3;
  if (F.axis === 0) { out.x = t; out.z = o; out.yaw = Math.atan2(1, s); }
  else { out.x = o; out.z = t; out.yaw = Math.atan2(s, 1); }
  out.nx = Math.cos(out.yaw); out.nz = -Math.sin(out.yaw); // left normal
  return out;
}
// Intersection of a horizontal-family road fh (index ih) and vertical-family road fv (index iv)
export function intersection(fh, ih, fv, iv, out) {
  const key = fh + ',' + ih + ',' + fv + ',' + iv;
  const hit = interCache.get(key);
  if (hit) { out.x = hit.x; out.z = hit.z; return out; }
  let x = iv * S + FAM[fv].off, z = ih * S + FAM[fh].off;
  for (let k = 0; k < 14; k++) { x = roadOther(fv, iv, z); z = roadOther(fh, ih, x); }
  out.x = x; out.z = z;
  interCache.set(key, { x, z });
  return out;
}
const _nr = { edge: 0, fam: 0 };
// Distance from the road surface edge (<=0 means on the road). Sets _nr.fam
export function nearRoad(x, z, out = _nr) {
  let best = 1e9, bf = 0;
  for (let f = 0; f < 4; f++) {
    const e = famDist(f, x, z) * 0.93 - FAM[f].w;
    if (e < best) { best = e; bf = f; }
  }
  out.edge = best; out.fam = bf;
  return out;
}

// ---------- ramps (danger signs) ----------
export function getRamp(rx, ri) {
  const key = rx + ',' + ri;
  if (rampCache.has(key)) return rampCache.get(key);
  let r = null;
  if (hash2(rx, ri, world.seed + 11) < 0.34 && !(rx === 0 && ri === 0)) {
    const cx = rx * S + 300 + hash2(rx, ri, world.seed + 12) * 300;
    const cz = roadOther(0, ri, cx);
    const s = (roadOther(0, ri, cx + 1.5) - roadOther(0, ri, cx - 1.5)) / 3;
    const phi = Math.atan2(s, 1);
    r = { rx, ri, x: cx, z: cz, phi, ux: Math.cos(phi), uz: Math.sin(phi), vx: -Math.sin(phi), vz: Math.cos(phi), L: 26, W: 8, rise: 4.4 };
  }
  rampCache.set(key, r);
  return r;
}
export function rampAt(x, z) {
  const r = getRamp(Math.floor(x / S), Math.round(z / S));
  if (!r) return 0;
  const dx = x - r.x, dz = z - r.z;
  const u = dx * r.ux + dz * r.uz;
  if (u < 0 || u > r.L) return 0;
  const av = Math.abs(dx * r.vx + dz * r.vz);
  if (av > r.W) return 0;
  return r.rise * (u / r.L) * (1 - smoothstep(r.W - 1.5, r.W, av));
}

// ---------- terrain ----------
export function heightNoRamp(x, z) {
  const mk = mask(x, z);
  const hl = lowH(x, z, mk);
  let r = 0;
  if (mk > 0.01) {
    let a = 1, f = 0.0011, tot = 0;
    for (let i = 0; i < 4; i++) {
      const n = 1 - Math.abs(nMtn.n2(x * f + i * 31.7, z * f - i * 17.3));
      r += n * n * a; tot += a; a *= 0.5; f *= 2.1;
    }
    r /= tot;
  }
  const detail = nDet.fbm(x * 0.004, z * 0.004, 3) * 6 + nDet.n2(x * 0.03, z * 0.03) * 0.9;
  const hf = hl + mk * (r * 120 - 25) + detail;
  const hr = smax(hl, 3);
  const band = 12 + 1.1 * Math.abs(hf - hr);
  let t = 0;
  for (let f = 0; f < 4; f++) {
    const w = FAM[f].w + 2;
    const d = famDist(f, x, z) * 0.93;
    if (d < w + band) { const tf = smoothstep(w + band, w, d); if (tf > t) t = tf; }
  }
  let h = t > 0 ? lerp(hf, hr, t) : hf;
  const p = world.festival;
  if (p.active) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < p.r + 100) h = lerp(h, p.h, smoothstep(p.r + 100, p.r, d));
  }
  return h;
}
export function heightAt(x, z) { return heightNoRamp(x, z) + rampAt(x, z); }
export function gradient(x, z, out) {
  const e = 0.6;
  out.gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  out.gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return out;
}

export const dryness = (x, z) => nDry.fbm(x * 0.0006 + 9, z * 0.0006 - 4, 3);
export function forestDensity(x, z) {
  const f = nFor.fbm(x * 0.0017 + 3, z * 0.0017 - 8, 3);
  return clamp(0.42 + f * 1.4, 0, 1);
}
export const detailNoise = (x, z) => nDet.n2(x * 0.09, z * 0.09);
export const patchNoise = (x, z) => nDet.fbm(x * 0.012 + 40, z * 0.012 - 70, 2);

export function surfaceAt(x, z, h) {
  if (h === undefined) h = heightAt(x, z);
  nearRoad(x, z, _nr);
  if (_nr.edge <= 0.5) return FAM[_nr.fam].dirt ? SURF.DIRT : SURF.ASPHALT;
  if (h < -0.35) return SURF.WATER;
  if (h < 2.1) return SURF.SAND;
  if (h > 108) return SURF.SNOW;
  if (h > 82) return SURF.ROCK;
  if (world.season === 'winter') return SURF.SNOW;
  if (dryness(x, z) > 0.42) return SURF.SAND;
  return SURF.GRASS;
}

// ---------- towns ----------
export function townAt(rx, rz) {
  const key = rx + ',' + rz;
  if (townCache.has(key)) return townCache.get(key);
  let t = null;
  if (!(rx === 0 && rz === 0) && hash2(rx, rz, world.seed + 5) < 0.97) {
    const c = intersection(0, rz, 1, rx, {});
    const h = heightNoRamp(c.x, c.z);
    if (h > 1.5) t = { rx, rz, x: c.x, z: c.z, seed: Math.floor(hash2(rx, rz, world.seed + 6) * 1e6) };
  }
  townCache.set(key, t);
  return t;
}

export const regionOf = (x, z) => ({ rx: Math.floor(x / S), rz: Math.floor(z / S) });
