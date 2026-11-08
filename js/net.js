// Peer-to-peer multiplayer over WebRTC using PeerJS (no game server needed; PeerJS's free broker only introduces peers).
// Star topology: guests send their state to the host, the host relays everybody's state to everybody.
import * as THREE from 'three';
import { buildCar, carById } from './cars.js';
import { makeTag } from './tags.js';
import { world } from './terrain.js';
import { angDiff, damp } from './util.js';

const PEER_SRC = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const r2 = (v) => Math.round(v * 100) / 100;

export class Net {
  constructor(g) { this.g = g; this.peer = null; this.role = 'off'; this.conns = new Map(); this.remotes = new Map(); this.status = 'Offline'; this.code = ''; this.sendT = 0; this.last = new Map(); }
  get online() { return this.role !== 'off'; }
  name() { return ((this.g.state.settings.name || 'Racer') + '').replace(/[<>]/g, '').slice(0, 16) || 'Racer'; }
  setStatus(s) { this.status = s; this.g.ui.refreshOnline && this.g.ui.refreshOnline(); }
  async load() {
    if (window.Peer) return;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = PEER_SRC; s.onload = res; s.onerror = () => rej(new Error('Could not load the PeerJS library (offline?)')); document.head.appendChild(s); });
  }
  async host() {
    try { await this.load(); } catch (e) { return this.setStatus(e.message); }
    this.leave(true); this.role = 'host'; this.code = Math.random().toString(36).slice(2, 7).toUpperCase();
    this.setStatus('Opening room...');
    const p = (this.peer = new window.Peer('corsa-' + this.code));
    p.on('open', () => this.setStatus(`Hosting room ${this.code} - share the code`));
    p.on('connection', (c) => this.accept(c));
    p.on('error', (e) => { this.setStatus('Error: ' + (e.type || e.message)); if (e.type === 'unavailable-id') this.host(); });
  }
  accept(c) {
    c.on('open', () => { this.conns.set(c.peer, c); c.send({ t: 'hello', seed: world.seed, host: this.name() }); this.g.ui.toast('A player is joining...', 'info'); this.setStatus(`Hosting room ${this.code} - ${this.conns.size + 1} players`); });
    c.on('data', (d) => this.onData(c.peer, d));
    c.on('close', () => this.drop(c.peer));
    c.on('error', () => this.drop(c.peer));
  }
  async join(code) {
    code = (code || '').trim().toUpperCase(); if (!code) return this.setStatus('Enter a room code first');
    try { await this.load(); } catch (e) { return this.setStatus(e.message); }
    this.leave(true); this.role = 'guest'; this.code = code; this.setStatus('Connecting...');
    const p = (this.peer = new window.Peer());
    p.on('open', () => {
      const c = p.connect('corsa-' + code, { metadata: { name: this.name() } });
      this.hostConn = c;
      c.on('open', () => { this.conns.set('host', c); this.setStatus(`Connected to room ${code}`); this.g.ui.toast('Joined room ' + code, 'good'); });
      c.on('data', (d) => this.onData('host', d));
      c.on('close', () => { this.g.ui.toast('Host left the room', 'bad'); this.leave(); });
      c.on('error', () => this.setStatus('Connection error'));
    });
    p.on('error', (e) => { this.setStatus(e.type === 'peer-unavailable' ? 'Room not found' : 'Error: ' + (e.type || e.message)); if (e.type === 'peer-unavailable') this.role = 'off'; });
  }
  leave(quiet) {
    for (const c of this.conns.values()) try { c.close(); } catch (e) { /* ignore */ }
    this.conns.clear(); if (this.peer) try { this.peer.destroy(); } catch (e) { /* ignore */ }
    this.peer = null; this.hostConn = null;
    for (const r of this.remotes.values()) this.g.scene.remove(r.group);
    this.remotes.clear(); this.last.clear();
    if (!quiet) { this.role = 'off'; this.code = ''; this.setStatus('Offline'); }
  }
  drop(id) {
    this.conns.delete(id); this.last.delete(id);
    const r = this.remotes.get(id); if (r) { this.g.scene.remove(r.group); this.remotes.delete(id); this.g.ui.toast(`${r.name} left`, 'info'); }
    if (this.role === 'host') this.setStatus(`Hosting room ${this.code} - ${this.conns.size + 1} players`);
  }
  onData(from, d) {
    if (!d || !d.t) return;
    if (d.t === 'hello') { if (d.seed !== world.seed) { this.g.ui.toast('Syncing to the host\'s world...', 'info'); this.g.newWorld(d.seed); } this.hostName = d.host; }
    else if (d.t === 's' && this.role === 'host') { this.last.set(from, d.s); this.apply(from, d.s); }
    else if (d.t === 'all' && this.role === 'guest') {
      const me = this.peer && this.peer.id, seen = new Set();
      for (const e of d.list) { if (e.id === me) continue; const id = e.id; seen.add(id); this.apply(id, e); }
      for (const id of [...this.remotes.keys()]) if (!seen.has(id)) this.drop(id);
    }
  }
  apply(id, s) {
    let r = this.remotes.get(id);
    if (!r || r.carId !== s.c || r.color !== s.k) {
      if (r) this.g.scene.remove(r.group);
      let spec; try { spec = carById(s.c); } catch (e) { spec = carById('commit'); }
      const m = buildCar(spec, s.k || spec.color); m.group.rotation.order = 'YXZ';
      m.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const tag = makeTag(s.n || 'Player', '#58a6ff'); tag.position.set(0, spec.H + 1.3, 0); m.group.add(tag);
      m.group.position.set(s.x, s.y, s.z);
      this.g.scene.add(m.group);
      const prev = r; r = { id, group: m.group, wheels: m.wheels, tail: m.tail, spec, carId: s.c, color: s.k, name: s.n || 'Player', tag, x: s.x, y: s.y, z: s.z, yaw: s.w, pitch: 0, roll: 0, wr: 0, speed: 0, L: spec.L, W: spec.W, vx: 0, vz: 0, bump: 0 };
      this.remotes.set(id, r); if (!prev) this.g.ui.toast(`${r.name} joined`, 'good');
    }
    r.name = s.n || r.name; r.t = s; r.seen = performance.now();
  }
  state() {
    const c = this.g.car;
    return { n: this.name(), c: this.g.state.current, k: this.g.state.cars[this.g.state.current].color, x: r2(c.x), y: r2(c.y), z: r2(c.z), w: r2(c.yaw), p: r2(c.pitch), r: r2(c.roll), st: r2(c.steerAngle), wr: r2(c.wheelRot % 6.2832), b: c.brakeOn ? 1 : 0, u: r2(c.speed) };
  }
  update(dt) {
    if (!this.online) return;
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 0.07;
      const me = this.state();
      if (this.role === 'guest') { const c = this.conns.get('host'); if (c && c.open) c.send({ t: 's', s: me }); }
      else if (this.role === 'host' && this.conns.size) {
        const list = [{ id: 'host', ...me }];
        for (const [id, s] of this.last) list.push({ id, ...s });
        for (const c of this.conns.values()) if (c.open) c.send({ t: 'all', list: list.filter((e) => e.id !== c.peer) });
      }
    }
    const now = performance.now();
    for (const [id, r] of [...this.remotes]) {
      if (now - r.seen > 6000) { this.drop(id); continue; }
      const t = r.t, k = Math.min(1, dt * 12);
      // dead-reckon a little along the heading, then ease toward the last received pose
      const ax = t.x + Math.sin(t.w) * t.u * 0.05, az = t.z + Math.cos(t.w) * t.u * 0.05;
      r.x += (ax - r.x) * k; r.y += (t.y - r.y) * k; r.z += (az - r.z) * k;
      r.yaw += angDiff(r.yaw, t.w) * k; r.pitch += (t.p - r.pitch) * k; r.roll += (t.r - r.roll) * k;
      r.speed = t.u; r.wr += t.u / 0.33 * dt;
      r.group.position.set(r.x, r.y, r.z); r.group.rotation.set(-r.pitch, r.yaw, r.roll);
      for (const w of r.wheels) { if (w.front) w.pivot.rotation.y = t.st; w.spin.rotation.x = r.wr; }
      if (r.tail) r.tail.emissiveIntensity = t.b ? 2.6 : 0.6;
    }
  }
  list() { return [{ name: this.name() + ' (you)' }, ...[...this.remotes.values()].map((r) => ({ name: r.name }))]; }
}
