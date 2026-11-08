// AI drivers: ambient traffic on the paved roads and kinematic rivals that follow race routes.
import * as THREE from 'three';
import { buildCar, buildTraffic, TRAFFIC_KINDS, CARS, PAINTS } from './cars.js';
import { heightAt, roadFrame, nearestRoadIndex, FAM } from './terrain.js';
import { clamp, lerp, damp, angDiff, TAU } from './util.js';

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
export class Rival {
  constructor(scene, route, grid, spec, color, skill) {
    this.scene = scene; this.route = route; this.spec = spec;
    const m = buildCar(spec, color);
    m.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.group = m.group; this.wheels = m.wheels; this.tail = m.tail;
    this.L = m.group.userData.L; this.W = m.group.userData.W;
    this.s = grid.s; this.off = grid.off; this.speed = 0; this.skill = skill; this.name = grid.name;
    this.x = 0; this.z = 0; this.yaw = 0; this.finished = false; this.finishT = 0; this.wrot = 0; this.lap = 0;
    this.noise = Math.random() * 100; this.vx = 0; this.vz = 0; this.bump = 0;
    scene.add(this.group);
    this.sync(0);
  }
  sample(s) {
    const r = this.route, n = r.pts.length;
    let f = s / r.step; let i = Math.floor(f);
    const loop = r.loop;
    if (loop) { i = ((i % (n - 1)) + (n - 1)) % (n - 1); } else i = clamp(i, 0, n - 2);
    const t = clamp(f - Math.floor(f), 0, 1), a = r.pts[i], b = r.pts[(i + 1) % n];
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), yaw: a.yaw, curv: a.curv };
  }
  sync(dt) {
    const p = this.sample(this.s);
    const nx = Math.cos(p.yaw), nz = -Math.sin(p.yaw);
    const targetX = p.x + nx * this.off, targetZ = p.z + nz * this.off;
    this.x = targetX + this.vx; this.z = targetZ + this.vz;
    const yawT = p.yaw;
    this.yaw = this.yaw + angDiff(this.yaw, yawT) * Math.min(1, dt * 8 + (dt === 0 ? 1 : 0));
    pose(this.group, this.x, this.z, this.yaw, this.L);
    this.wrot += this.speed / 0.33 * dt; spinWheels(this.wheels, this.wrot);
  }
  update(dt, ctx) {
    const r = this.route;
    // look ahead for the tightest corner and pick a safe speed
    let vCorner = 999;
    for (let k = 0; k < 6; k++) {
      const p = this.sample(this.s + 8 + k * 14);
      const v = Math.sqrt((14 + 6 * this.skill) / Math.max(p.curv, 0.0008));
      if (v < vCorner) vCorner = v;
    }
    const gapToPlayer = this.s - ctx.playerS;
    let rubber = 1;
    if (ctx.rubber) { if (gapToPlayer > 100) rubber = 1 - clamp((gapToPlayer - 100) / 600, 0, 0.12); else if (gapToPlayer < -60) rubber = 1 + clamp((-gapToPlayer - 60) / 500, 0, 0.09); }
    let target = Math.min(ctx.cruise * this.skill * rubber * (0.97 + 0.03 * Math.sin(this.noise + ctx.t * 0.4)), vCorner * (0.9 + this.skill * 0.1));
    if (ctx.hold) target = 0;
    const acc = target > this.speed ? 8.5 : 16;
    this.speed += clamp(target - this.speed, -acc * dt, acc * dt);
    this.speed *= 1 - this.bump * dt; this.bump = Math.max(0, this.bump - dt * 2);
    this.s += this.speed * dt;
    this.vx *= Math.exp(-3 * dt); this.vz *= Math.exp(-3 * dt);
    if (!r.loop && this.s >= r.len && !this.finished) { this.finished = true; this.finishT = ctx.t; }
    if (r.loop && this.s >= r.len * r.laps && !this.finished) { this.finished = true; this.finishT = ctx.t; }
    if (this.finished) { this.speed *= Math.exp(-1.2 * dt); if (!r.loop) this.s = Math.min(this.s, r.len + 40); }
    this.sync(dt);
  }
  dispose() { this.scene.remove(this.group); }
}

export const randomRivalSpec = (rnd) => CARS[Math.floor(rnd() * CARS.length)];
export const randomPaint = (rnd) => PAINTS[Math.floor(rnd() * PAINTS.length)];
