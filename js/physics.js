// Arcade-sim car physics (pure JS, no rendering). Body-frame bicycle model with
// Pacejka-style tyres, friction circle, weight transfer, handbrake drifting, nitro,
// terrain following, jumps and a simple automatic gearbox.
// Conventions: forward = (sin yaw, cos yaw); positive steer / yaw rate = turning LEFT;
// u = forward speed, v = lateral speed (left positive), r = yaw rate.
import { heightAt, surfaceAt, gradient, SURF, SURF_MU, SURF_ROLL } from './terrain.js';
import { clamp, lerp, smoothstep, damp } from './util.js';

const G = 9.81, RHO = 1.2;
const _g = { gx: 0, gz: 0 };

export function deriveSpec(base, up = {}) {
  const s = { ...base };
  s.kw = base.kw * (1 + 0.09 * (up.engine || 0));
  s.mass = base.mass * (1 - 0.035 * (up.weight || 0));
  s.mu = base.mu * (1 + 0.035 * (up.tires || 0));
  s.downforce = (base.downforce || 0) + 0.12 * (up.aero || 0);
  s.nitroPower = 0.4 + 0.12 * (up.nitro || 0);
  s.nitroCap = 1 + 0.25 * (up.nitro || 0);
  if (up.drive) s.drive = 'AWD';
  return s;
}
export function computePI(s) {
  const pw = (s.kw / s.mass) * 1000;
  return Math.round(clamp(100 + pw * 0.9 + s.top * 0.5 + (s.mu - 1) * 220 + (s.drive === 'AWD' ? 18 : 0), 100, 999));
}
export const classOf = (pi) =>
  pi <= 300 ? 'D' : pi <= 400 ? 'C' : pi <= 500 ? 'B' : pi <= 600 ? 'A' : pi <= 700 ? 'S1' : pi <= 800 ? 'S2' : 'X';

export class CarPhysics {
  constructor(spec) {
    this.setSpec(spec);
    this.reset(0, 0, 0, 0);
  }
  setSpec(spec) {
    this.spec = spec;
    const m = spec.mass;
    this.m = m;
    this.L = spec.wb;
    this.a = this.L * (1 - spec.wf); // CG -> front axle
    this.b = this.L * spec.wf; // CG -> rear axle
    this.Iz = m * this.a * this.b * 1.25;
    this.P = spec.kw * 1000;
    this.vtop = spec.top / 3.6;
    const Froll = 0.015 * m * G;
    this.CdA = Math.max(0.12, ((this.P * 0.9 * 0.88) / this.vtop - Froll) * 2 / (RHO * this.vtop * this.vtop));
    this.gearMax = [0.17, 0.31, 0.46, 0.62, 0.80, 1.0].map((f) => f * this.vtop * 1.03);
    this.redline = spec.redline || 7400;
    this.idle = 950;
  }
  reset(x, z, yaw, speed = 0) {
    const y = heightAt(x, z);
    Object.assign(this, {
      x, y, z, yaw, u: speed, v: 0, r: 0, vy: 0, pitch: 0, roll: 0, steerAngle: 0,
      gear: 0, rpm: 1000, rpmFrac: 0, shiftT: 0, nitro: 1, nitroOn: false,
      grounded: true, air: 0, landing: 0, slip: 0, drifting: false, drift: 0,
      spinF: 0, spinR: 0, wheelRot: 0, brakeOn: false, reverse: false, ax: 0,
      surf: SURF.ASPHALT, inWater: false, waterT: 0, sus: 0, wet: 0, hp: 0,
      wheelSlip: 0, tcsOn: false, vx: 0, vz: 0, speed: 0, kmh: 0,
    });
    this._tq = 0;
  }
  get fx() { return Math.sin(this.yaw); }
  get fz() { return Math.cos(this.yaw); }
  worldVel() { const s = Math.sin(this.yaw), c = Math.cos(this.yaw); this.vx = this.u * s + this.v * c; this.vz = this.u * c - this.v * s; return this; }
  setWorldVel(vx, vz) { const s = Math.sin(this.yaw), c = Math.cos(this.yaw); this.u = vx * s + vz * c; this.v = vx * c - vz * s; }
  shift(d) { const g = clamp(this.gear + d, 0, 5); if (g !== this.gear) { this.gear = g; this.shiftT = 0.18; } }

  powerCurve(f) { return f < 0.8 ? 0.5 + 0.5 * (f / 0.8) : 1 - 0.1 * ((f - 0.8) / 0.2); }

  // Advance simulation by dt. inp: {throttle, brake, steer, handbrake, nitro, abs, tcs, stm, manual}
  step(dt, inp, wet = 0) {
    const s = this.spec;
    this.wet = wet;
    // ---- terrain queries (cached for a few substeps) ----
    this._tq -= dt;
    if (this._tq <= 0) {
      this._tq = 1 / 30;
      this._h = heightAt(this.x, this.z);
      gradient(this.x, this.z, _g);
      this._gx = _g.gx; this._gz = _g.gz;
      this.surf = surfaceAt(this.x, this.z, this._h);
    }
    const surf = this.surf;
    let surfMu = SURF_MU[surf];
    if (surf !== SURF.ASPHALT) surfMu = lerp(surfMu, 1, s.offroad * 0.55);
    if (surf === SURF.ASPHALT) surfMu *= 1 - 0.3 * wet;
    else if (surf !== SURF.WATER) surfMu *= 1 - 0.15 * wet;
    const rollMul = SURF_ROLL[surf] * (1 - s.offroad * 0.3);
    const mu = s.mu * surfMu;

    const u = this.u, v = this.v, r = this.r;
    const vAbs = Math.abs(u), sgnu = u >= 0 ? 1 : -1;
    const m = this.m, L = this.L, a = this.a, b = this.b;

    // ---- steering ----
    const maxSteer = s.steer / (1 + Math.pow(vAbs / (s.steerSpeed || 26), 2));
    const target = clamp(inp.steer, -1, 1) * maxSteer;
    const rate = (Math.abs(target) > Math.abs(this.steerAngle) ? 3.4 : 5.5) * (1 + vAbs * 0.01);
    this.steerAngle += clamp(target - this.steerAngle, -rate * dt, rate * dt);
    const dl = this.steerAngle;

    // ---- controls ----
    let thr = clamp(inp.throttle, 0, 1), brk = clamp(inp.brake, 0, 1);
    this.reverse = false;
    if (brk > 0.05 && thr < 0.05 && u < 0.8 && !this.nitroOn) { this.reverse = true; thr = brk; brk = 0; }
    else if (thr > 0.05 && brk < 0.05 && u < -0.8) { brk = 1; }
    this.brakeOn = brk > 0.05 || (this.reverse && u > 0.5);
    const hand = inp.handbrake ? 1 : 0;

    // ---- gearbox / rpm ----
    this.shiftT = Math.max(0, this.shiftT - dt);
    const g = this.gear;
    const fG = vAbs / this.gearMax[g];
    if (!inp.manual && this.shiftT <= 0) {
      if (fG > 0.94 && g < 5 && !this.reverse) this.shift(1);
      else if (g > 0 && vAbs < this.gearMax[g - 1] * 0.72) this.shift(-1);
    }
    this.rpmFrac = clamp(fG, 0, 1.04);
    const clutch = thr > 0.1 ? 0.34 * (1 - smoothstep(0, 14, vAbs)) : 0;
    const rpmT = this.idle + (this.redline - this.idle) * Math.max(this.rpmFrac, clutch);
    this.rpm = damp(this.rpm, rpmT + (this.shiftT > 0 ? -1200 : 0), 14, dt);
    if (this.rpm > this.redline && thr > 0.1) this.rpm = this.redline - Math.random() * 180; // limiter bounce

    // ---- nitro ----
    this.nitroOn = !!inp.nitro && this.nitro > 0.02 && thr > 0.3 && !this.reverse && this.grounded;
    if (this.nitroOn) this.nitro = Math.max(0, this.nitro - dt / (7 * (s.nitroCap || 1)));
    else this.nitro = Math.min(1, this.nitro + dt * (this.drifting ? 0.06 : vAbs > 25 ? 0.018 : 0.005));
    const boost = this.nitroOn ? 1 + (s.nitroPower || 0.4) : 1;

    // ---- axle loads ----
    const dFz = clamp((this.ax * m * (s.cgH || 0.5)) / L, -0.35 * m * G, 0.35 * m * G);
    const down = 0.5 * RHO * (s.downforce || 0) * u * u;
    let FzF = m * G * s.wf - dFz + down * 0.45;
    let FzR = m * G * (1 - s.wf) + dFz + down * 0.55;
    FzF = Math.max(FzF, 0.12 * m * G); FzR = Math.max(FzR, 0.12 * m * G);
    const air = !this.grounded;
    if (air) { FzF = 0; FzR = 0; }

    // ---- longitudinal demands ----
    let Fdrive = 0;
    if (this.reverse) Fdrive = -Math.min((thr * this.P * 0.35) / Math.max(vAbs, 2.5), 0.45 * m * G) * (vAbs < 9 ? 1 : 0);
    else if (this.shiftT <= 0.0) Fdrive = (thr * this.P * 0.88 * this.powerCurve(this.rpmFrac) * boost) / Math.max(vAbs, 3);
    if (this.nitroOn) Fdrive += 0.22 * m * G * (s.nitroPower || 0.4) * (1 - smoothstep(30, 90, vAbs));
    const brakeMax = (s.brake || 1.2) * m * G * 1.1;
    let Fbrk = brk * brakeMax * (u > 0.3 ? 1 : u < -0.3 ? -1 : 0);
    const shareF = s.drive === 'FWD' ? 1 : s.drive === 'AWD' ? 0.42 : 0;
    const shareR = 1 - shareF;
    let FxF = Fdrive * shareF - Math.sign(Fbrk) * Math.min(Math.abs(Fbrk) * 0.62, 1e9);
    let FxR = Fdrive * shareR - Math.sign(Fbrk) * Math.abs(Fbrk) * 0.38;
    if (hand) FxR -= sgnu * Math.min(0.6 * m * G, Math.abs(u) * 4000) * (vAbs > 0.3 ? 1 : 0);

    // friction circle
    const capF = mu * FzF * (s.gripF || 1), capR = mu * FzR * (s.gripR || 1) * (hand ? 0.5 : 1);
    let ratioF = capF > 1 ? Math.abs(FxF) / capF : 0, ratioR = capR > 1 ? Math.abs(FxR) / capR : 0;
    const absOn = inp.abs !== false, tcsOn = inp.tcs !== false;
    this.tcsOn = false;
    const braking = Fbrk !== 0;
    for (let pass = 0; pass < 2; pass++) {
      const isF = pass === 0;
      let ratio = isF ? ratioF : ratioR;
      let Fx = isF ? FxF : FxR;
      const cap = isF ? capF : capR;
      if (ratio > 0.97) {
        const isBrake = braking && Math.sign(Fx) === -sgnu;
        if (isBrake && absOn) { Fx = Math.sign(Fx) * cap * 0.97; ratio = 0.97; }
        else if (!isBrake && tcsOn) { Fx = Math.sign(Fx) * cap * 0.97; ratio = 0.97; this.tcsOn = true; }
        else { Fx = Math.sign(Fx) * cap * 0.9; ratio = Math.min(ratio, 1.6); }
      }
      if (isF) { FxF = Fx; ratioF = ratio; } else { FxR = Fx; ratioR = ratio; }
    }
    this.spinF = Math.max(0, ratioF - 0.97); this.spinR = Math.max(0, ratioR - 0.97);
    const lfF = Math.sqrt(Math.max(0.12, 1 - 0.8 * Math.min(ratioF, 1) ** 2));
    const lfR = Math.sqrt(Math.max(0.12, 1 - 0.8 * Math.min(ratioR, 1) ** 2));

    // ---- lateral tyre forces ----
    const den = Math.max(vAbs, 2.5);
    const afSlip = Math.atan2(v + a * r, den) - dl * sgnu;
    const arSlip = Math.atan2(v - b * r, den);
    const B = s.stiff || 9.5, C = 1.35, lowSpd = clamp(vAbs / 3, 0, 1);
    const handMu = hand ? 0.34 : 1;
    const DF = mu * FzF * lfF * (s.gripF || 1) * lowSpd, DR = mu * FzR * lfR * (s.gripR || 1) * lowSpd * handMu;
    const FyF = -DF * Math.sin(C * Math.atan(B * afSlip));
    const FyR = -DR * Math.sin(C * Math.atan(B * arSlip));
    this.slipF = afSlip; this.slipR = arSlip;

    // rotate front forces into body frame
    const cd = Math.cos(dl), sd = Math.sin(dl);
    const FxFb = FxF * cd - FyF * sd, FyFb = FxF * sd + FyF * cd;

    // ---- resistive forces ----
    let Fres = -0.5 * RHO * this.CdA * u * Math.abs(u) - 0.015 * rollMul * m * G * Math.tanh(u * 3) * (air ? 0 : 1);
    if (thr < 0.05 && !this.brakeOn && !air) Fres -= 0.045 * m * G * Math.tanh(u * 0.6) * clamp(this.rpmFrac * 2, 0.3, 1);
    // slope (gravity along the surface)
    const sx = Math.sin(this.yaw), cz = Math.cos(this.yaw);
    let FslopeX = 0, FslopeY = 0;
    if (this.grounded) {
      FslopeX = -m * G * (this._gx * sx + this._gz * cz);
      FslopeY = -m * G * (this._gx * cz - this._gz * sx);
    }
    // ---- integrate body frame ----
    const Fxt = FxFb + FxR + Fres + FslopeX;
    const Fyt = FyFb + FyR + FslopeY;
    const Mz = a * FyFb - b * FyR - 0.28 * this.Iz * r * clamp(vAbs / 20, 0, 1) * (s.stab || 1);
    this.ax = Fxt / m;
    let nu = u + (Fxt / m + v * r) * dt;
    let nv = v + (Fyt / m - u * r) * dt;
    let nr = r + (Mz / this.Iz) * dt;
    if (air) { nr *= Math.exp(-0.25 * dt); }

    // low-speed kinematic blend (avoids slip-angle singularity)
    const kin = 1 - smoothstep(1.5, 5, Math.abs(nu));
    if (kin > 0 && !air) {
      const rk = (nu * Math.tan(dl)) / L;
      nr = lerp(nr, rk, Math.min(1, kin * dt * 12));
      nv *= 1 - Math.min(1, kin * dt * 9);
    }
    // parking
    if (thr < 0.02 && Math.abs(nu) < 0.35 && this.grounded) {
      const slopeF = Math.hypot(this._gx, this._gz);
      if (brk > 0.02 || hand || slopeF * 1.0 < 0.5 * mu) { nu *= 1 - Math.min(1, dt * 10); nv *= 1 - Math.min(1, dt * 10); nr *= 1 - Math.min(1, dt * 10); }
    }
    this.u = nu; this.v = nv; this.r = nr;
    this.yaw += this.r * dt;

    // ---- slip / drift bookkeeping ----
    const spd = Math.hypot(this.u, this.v);
    this.speed = spd; this.kmh = spd * 3.6;
    this.slip = Math.atan2(this.v, Math.max(Math.abs(this.u), 1));
    const wasDrift = this.drifting;
    this.drifting = this.grounded && spd > 9 && Math.abs(this.slip) > 0.26 && this.u > 0;
    this.drift = this.drifting ? Math.abs(this.slip) : 0;
    this.wheelSlip = Math.max(this.spinF, this.spinR, Math.min(1, Math.abs(this.slip) * 2.2) * (spd > 5 ? 1 : 0), this.brakeOn && ratioF > 0.9 ? 0.5 : 0);

    // ---- world integration ----
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this.vx = this.u * sy + this.v * cy;
    this.vz = this.u * cy - this.v * sy;
    this.x += this.vx * dt; this.z += this.vz * dt;

    // vertical: gravity, ground contact, jumps
    this.vy -= G * dt * (this.gravMul === undefined ? 1 : this.gravMul);
    this.y += this.vy * dt;
    const h = heightAt(this.x, this.z);
    let vyg = this._gx * this.vx + this._gz * this.vz;
    {
      // steep terrain acts like a wall/hill, not a launch ramp: cap climb rate, bleed speed
      const hv = Math.hypot(this.vx, this.vz);
      if (vyg > 0 && hv > 1) {
        const slope = vyg / hv;
        const maxSlope = 0.5;
        if (slope > maxSlope) {
          const over = slope - maxSlope;
          const k = Math.exp(-over * 9 * dt - (slope > 1.1 ? 0.25 : 0));
          this.u *= k; this.v *= k;
          if (slope > 1.1) { this.hitWall = (this.hitWall || 0) + 1; }
          vyg = Math.min(vyg * (maxSlope + over * 0.15) / slope, 7);
        }
        vyg = Math.min(vyg, 9);
      }
    }
    const gap = this.y - h;
    if (gap <= 0 || (gap < 0.14 && this.vy <= vyg + 0.9)) {
      const impact = vyg - this.vy;
      if (!this.grounded) { this.lastAir = this.air; this.justLanded = true; }
      if (!this.grounded && this.air > 0.18 && impact > 3) this.landing = Math.max(this.landing, impact);
      this.y = h; this.vy = Math.min(vyg, this.vy > vyg ? this.vy : vyg); this.grounded = true; this.air = 0;
    } else {
      this.grounded = false; this.air += dt;
    }
    // water
    const depth = SEA_LEVEL - h;
    this.inWater = h < -0.35 && this.grounded;
    if (this.inWater) {
      const k = Math.exp(-(0.7 + clamp(depth, 0, 3) * 0.5) * dt);
      this.u *= k; this.v *= k;
      this.waterT += dt;
    } else this.waterT = Math.max(0, this.waterT - dt * 2);
    this.wheelRot += (this.u / (s.wheelR || 0.33)) * dt + (this.spinR + this.spinF) * 25 * dt;
    this._tqH = h;
  }

  // Visual attitude: pitch / roll from the terrain under the four wheels
  updateAttitude(dt) {
    const s = this.spec, sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const hw = (s.track || 1.5) * 0.5, hl = this.L * 0.5;
    let pT, rT;
    if (this.grounded) {
      const fF = heightAt(this.x + sy * hl, this.z + cy * hl), fR = heightAt(this.x - sy * hl, this.z - cy * hl);
      const lL = heightAt(this.x + cy * hw, this.z - sy * hw), lR = heightAt(this.x - cy * hw, this.z + sy * hw);
      pT = Math.atan2(fF - fR, this.L); // nose up positive
      rT = Math.atan2(lL - lR, hw * 2); // left side up positive
      // no squat / dive: body stays level under braking and acceleration
      rT += (this.u * this.r) * 0.0035 * (s.roll || 1); // body roll (leans outward)
    } else {
      const hv = Math.max(Math.hypot(this.vx, this.vz), 1);
      pT = Math.atan2(this.vy, hv) * 0.8; rT = this.roll * 0.98;
    }
    this.pitch = damp(this.pitch, pT, this.grounded ? 12 : 2.5, dt);
    this.roll = damp(this.roll, rT, this.grounded ? 12 : 2.5, dt);
    this.sus = damp(this.sus, 0, 8, dt);
  }
}
const SEA_LEVEL = 0;

export function snapshot(c) {
  return { x: c.x, y: c.y, z: c.z, yaw: c.yaw, u: c.u, v: c.v, r: c.r, vy: c.vy, nitro: c.nitro, gear: c.gear };
}
export function restore(c, s) {
  Object.assign(c, s);
  c.steerAngle = 0; c.grounded = false; c.air = 0.0; c._tq = 0;
}
