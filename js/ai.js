// AI drivers: ambient traffic on the paved roads and kinematic rivals that follow race routes.
import * as THREE from 'three';
import { buildCar, buildTraffic, TRAFFIC_KINDS, CARS, PAINTS } from './cars.js';
import { heightAt, roadFrame, nearestRoadIndex, FAM } from './terrain.js';
import { clamp, lerp, damp, angDiff, TAU } from './util.js';
import { makeTag } from './tags.js';

const TCOL = [0xdfe3e8, 0x1c2128, 0x8b949e, 0xc9d1d9, 0x1f6feb, 0xb62324, 0x2ea043, 0xd29922, 0x6e7681, 0xf0f3f6];

export function pose(g, x, z, yaw, L, tilt = 1) {
  const sy = Math.sin(yaw), cy = Math.cos(yaw), hl = L * 0.45;
  const y = heightAt(x, z);
  const fF = heightAt(x + sy * hl, z + cy * hl), fR = heightAt(x - sy * hl, z - cy * hl);
  g.rotation.order = 'YXZ';
  g.position.set(x, y, z);
  g.rotation.set(-Math.atan2(fF - fR, hl * 2) * tilt, yaw, 0);
  return y;
}
function spinWheels(wheels, rot) { for (const w of wheels) w.spin.rotation.x = rot; }

export class Traffic {
  constructor(scene) { this.scene = scene; this.cars = []; this.target = 0; this.side = 1; }
  setCount(n) { this.target = n; }
  clear() { for (const c of this.cars) this.scene.remove(c.group); this.cars.length = 0; }
  spawn(px, pz) {
    const fam = Math.random() < 0.5 ? 0 : 1, F = FAM[fam];
    const idx = nearestRoadIndex(fam, px, pz);
    const tp = F.axis === 0 ? px : pz;
    const dir = Math.random() < 0.5 ? 1 : -1, lane = Math.random() < 0.55 ? 0 : 1;
    const t = tp + (Math.random() < 0.5 ? -1 : 1) * (170 + Math.random() * 260);
    for (const o of this.cars) if (o.state === 'drive' && o.fam === fam && o.idx === idx && o.dir === dir && o.lane === lane && Math.abs(o.t - t) < 40) return;
    const kind = TRAFFIC_KINDS[Math.floor(Math.random() * TRAFFIC_KINDS.length)];
    const m = buildTraffic(kind, TCOL[Math.floor(Math.random() * TCOL.length)]);
    m.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(m.group);
    const car = { kind, group: m.group, wheels: m.wheels, tail: m.tail, L: m.L, W: m.W, fam, idx, t, dir, lane, speed: lane === 0 ? 18 + Math.random() * 1.5 : 26 + Math.random() * 1.5, state: 'drive', x: 0, z: 0, yaw: 0, vx: 0, vz: 0, spin: 0, wrot: 0, life: 0, passed: false, hitT: 0 };
    this.place(car);
    this.cars.push(car);
  }
  place(c) {
    const F = FAM[c.fam], fr = {};
    roadFrame(c.fam, c.idx, c.t, fr);
    const lat = (c.lane === 0 ? 3.1 : 6.9) * this.side * c.dir;
    c.x = fr.x + fr.nx * lat; c.z = fr.z + fr.nz * lat;
    c.yaw = fr.yaw + (c.dir < 0 ? Math.PI : 0);
  }
  update(dt, px, pz, qualityMul = 1) {
    const want = Math.round(this.target * qualityMul);
    if (this.cars.length < want && Math.random() < 0.15) this.spawn(px, pz);
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.state === 'drive') {
        c.t += c.dir * c.speed * dt;
        this.place(c);
      } else {
        c.life += dt;
        c.x += c.vx * dt; c.z += c.vz * dt; c.yaw += c.spin * dt;
        const k = Math.exp(-1.4 * dt); c.vx *= k; c.vz *= k; c.spin *= k;
        c.speed = Math.hypot(c.vx, c.vz);
      }
      pose(c.group, c.x, c.z, c.yaw, c.L);
      c.wrot += (c.state === 'drive' ? c.speed : Math.hypot(c.vx, c.vz)) / 0.35 * dt;
      spinWheels(c.wheels, c.wrot);
      const d = Math.hypot(c.x - px, c.z - pz);
      if (d > 520 || (c.state === 'free' && c.life > 12 && d > 60) || this.cars.length > want + 3) {
        this.scene.remove(c.group); this.cars.splice(i, 1);
      }
    }
  }
  // returns static-ish footprints for collisions
  hit(c, nx, nz, impulse) {
    if (c.state === 'drive') { c.state = 'free'; c.life = 0; c.vx = Math.sin(c.yaw) * c.speed; c.vz = Math.cos(c.yaw) * c.speed; }
    c.vx += nx * impulse; c.vz += nz * impulse; c.spin += (Math.random() - 0.5) * impulse * 0.12;
  }
}

// ---------- rivals ----------
// Rivals are real dynamic drivers: they find their progress on the route, steer with pure pursuit toward a
// look-ahead point, brake for corners, avoid other cars and can be bumped around.
export class Rival {
  constructor(scene, route, grid, spec, color, skill) {
    this.scene = scene; this.route = route; this.spec = spec;
    const m = buildCar(spec, color);
    m.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.group = m.group; this.wheels = m.wheels; this.tail = m.tail;
    this.L = m.group.userData.L; this.W = m.group.userData.W; this.wb = spec.wb || this.L * 0.63;
    this.skill = skill; this.name = grid.name; this.off = grid.off; this.offT = grid.off;
    this.speed = 0; this.yr = 0; this.finished = false; this.finishT = 0; this.wrot = 0; this.lap = 0; this.s = 0;
    this.noise = Math.random() * 100; this.vx = 0; this.vz = 0; this.bump = 0; this.idx = 0; this.stuck = 0;
    this.idx = clamp(Math.round(grid.s / route.step), 0, route.pts.length - 2);
    const p = this.sample(grid.s), nx = Math.cos(p.yaw), nz = -Math.sin(p.yaw);
    this.x = p.x + nx * grid.off; this.z = p.z + nz * grid.off; this.yaw = p.yaw;
    this.tag = makeTag(grid.name, '#f0883e'); this.tag.position.set(0, (spec.H || 1.5) + 1.2, 0); this.group.add(this.tag);
    scene.add(this.group);
    pose(this.group, this.x, this.z, this.yaw, this.L);
  }
  sample(s) {
    const r = this.route, n = r.pts.length;
    let f = s / r.step; let i = Math.floor(f);
    if (r.loop) i = ((i % (n - 1)) + (n - 1)) % (n - 1); else i = clamp(i, 0, n - 2);
    const t = clamp(f - Math.floor(f), 0, 1), a = r.pts[i], b = r.pts[(i + 1) % n];
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), yaw: a.yaw, curv: a.curv };
  }
  track() {
    const r = this.route, n = r.pts.length, N = n - 1;
    let best = 1e12, bi = this.idx;
    for (let k = -3; k <= 14; k++) {
      let i = this.idx + k;
      if (r.loop) i = ((i % N) + N) % N; else if (i < 0 || i > n - 2) continue;
      const p = r.pts[i], d = (p.x - this.x) ** 2 + (p.z - this.z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    if (r.loop) { if (this.idx > N * 0.85 && bi < N * 0.15) this.lap++; else if (this.idx < N * 0.15 && bi > N * 0.85) this.lap--; }
    this.idx = bi; this.offRoute = Math.sqrt(best);
    const a = r.pts[bi], b = r.pts[(bi + 1) % n], st2 = r.step * r.step;
    const t = clamp(((this.x - a.x) * (b.x - a.x) + (this.z - a.z) * (b.z - a.z)) / st2, 0, 1);
    this.sLocal = (bi + t) * r.step;
    this.s = (r.loop ? this.lap * r.len : 0) + this.sLocal;
  }
  update(dt, ctx) {
    const r = this.route;
    this.track();
    const sp = this.speed;
    // ---- corner speed from the tightest curve ahead ----
    let vCorner = 999;
    for (let k = 0; k < 7; k++) {
      const p = this.sample(this.sLocal + 6 + k * 13);
      const v = Math.sqrt((15 + 7 * this.skill) / Math.max(p.curv, 0.0008));
      if (v < vCorner) vCorner = v;
    }
    // ---- avoidance: shift sideways around cars ahead, slow if too close ----
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    let wantOff = this.off, slow = 1;
    for (const o of ctx.others || []) {
      if (o === this) continue;
      const dx = o.x - this.x, dz = o.z - this.z, ahead = dx * fx + dz * fz, side = dx * rx + dz * rz;
      if (ahead > 0 && ahead < 26 && Math.abs(side) < 3.4) {
        wantOff += (side > 0 ? -1 : 1) * 3.2 * (1 - ahead / 26);
        if (ahead < 12 && sp > (o.speed || 0)) slow = Math.min(slow, 0.55 + ahead / 40);
      }
    }
    this.offT = damp(this.offT, clamp(wantOff, -6, 6), 2.5, dt);
    // ---- pure pursuit ----
    const Ld = clamp(7 + sp * 0.5, 9, 45);
    const tp = this.sample(this.sLocal + Ld), nx = Math.cos(tp.yaw), nz = -Math.sin(tp.yaw);
    const tx = tp.x + nx * this.offT, tz = tp.z + nz * this.offT;
    const alpha = angDiff(this.yaw, Math.atan2(tx - this.x, tz - this.z));
    let yrT = (Math.max(sp, 3) * 2 * Math.sin(alpha)) / Ld;
    const maxLat = (11 + 5 * this.skill) * (1 + (this.spec.mu ? (this.spec.mu - 1.1) * 0.8 : 0));
    const yrMax = maxLat / Math.max(sp, 4);
    yrT = clamp(yrT, -yrMax, yrMax);
    this.yr = damp(this.yr, yrT, 9, dt);
    this.yaw += this.yr * dt;
    // ---- speed ----
    const gapToPlayer = this.s - ctx.playerS;
    let rubber = 1;
    if (ctx.rubber) { if (gapToPlayer > 100) rubber = 1 - clamp((gapToPlayer - 100) / 600, 0, 0.12); else if (gapToPlayer < -60) rubber = 1 + clamp((-gapToPlayer - 60) / 500, 0, 0.09); }
    let target = Math.min(ctx.cruise * this.skill * rubber * (0.97 + 0.03 * Math.sin(this.noise + ctx.t * 0.4)), vCorner * (0.9 + this.skill * 0.1)) * slow;
    target *= clamp(1.15 - Math.abs(alpha) * 0.9, 0.25, 1);
    if (ctx.hold) target = 0;
    const acc = target > sp ? 8.5 : 18;
    this.speed += clamp(target - sp, -acc * dt, acc * dt);
    this.speed *= 1 - Math.min(0.9, this.bump) * dt; this.bump = Math.max(0, this.bump - dt * 1.5);
    // ---- integrate (heading motion + decaying collision impulse) ----
    this.x += (Math.sin(this.yaw) * this.speed + this.vx) * dt; this.z += (Math.cos(this.yaw) * this.speed + this.vz) * dt;
    const k = Math.exp(-2.6 * dt); this.vx *= k; this.vz *= k;
    // stuck recovery
    if (!ctx.hold && !this.finished && this.speed < 1.5) { this.stuck += dt; if (this.stuck > 3.5) { const p = this.sample(this.sLocal + 4); this.x = p.x; this.z = p.z; this.yaw = p.yaw; this.speed = 6; this.stuck = 0; } } else this.stuck = 0;
    if (this.offRoute > 90) { const p = this.sample(this.sLocal); this.x = p.x; this.z = p.z; this.yaw = p.yaw; }
    if (!r.loop && this.s >= r.len && !this.finished) { this.finished = true; this.finishT = ctx.t; }
    if (r.loop && this.s >= r.len * r.laps && !this.finished) { this.finished = true; this.finishT = ctx.t; }
    if (this.finished) this.speed *= Math.exp(-1.2 * dt);
    pose(this.group, this.x, this.z, this.yaw, this.L);
    this.wrot += this.speed / 0.33 * dt; spinWheels(this.wheels, this.wrot);
    for (const w of this.wheels) if (w.front) w.pivot.rotation.y = clamp(this.yr * this.wb / Math.max(this.speed, 3), -0.5, 0.5);
    if (this.tail) this.tail.emissiveIntensity = target < sp - 1 ? 2.4 : 0.6;
  }
  dispose() { this.scene.remove(this.group); }
}

// Car-vs-car collision between two rivals (or any {x,z,vx,vz,speed,bump} bodies): separate, exchange impulse, both slow down.
export function bumpPair(a, b, hit) {
  const h = hit.depth * 0.5 + 0.02;
  a.x -= hit.nx * h; a.z -= hit.nz * h; b.x += hit.nx * h; b.z += hit.nz * h;
  const sa = a.speed || 0, sb = b.speed || 0;
  const rel = Math.abs(sa - sb) * 0.5 + 1.5;
  a.vx -= hit.nx * rel * 0.6; a.vz -= hit.nz * rel * 0.6; b.vx += hit.nx * rel * 0.6; b.vz += hit.nz * rel * 0.6;
  a.speed *= 0.9; b.speed *= 0.9; a.bump = Math.min(1.5, (a.bump || 0) + 0.6); b.bump = Math.min(1.5, (b.bump || 0) + 0.6);
}

export const randomRivalSpec = (rnd) => CARS[Math.floor(rnd() * CARS.length)];
export const randomPaint = (rnd) => PAINTS[Math.floor(rnd() * PAINTS.length)];
