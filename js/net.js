// Peer-to-peer multiplayer over WebRTC using PeerJS (no game server needed; PeerJS's free broker only introduces peers).
// Star topology: guests send their state to the host, the host relays everybody's state to everybody.
import * as THREE from 'three';
import { carById } from './cars.js';
import { makeCarModel } from './models.js';
import { makeTag } from './tags.js';
import { world } from './terrain.js';
import { angDiff, damp } from './util.js';

const PEER_SRC = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const r2 = (v) => Math.round(v * 100) / 100;
// One shared world: everybody tries server 1; when it is full (20 players) they roll over to server 2, and so on.
const SERVERS = 8, MAX_PLAYERS = 20;
const serverId = (n) => 'horizon-pages-world-' + n;
const PEER_OPTS = { config: { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
] }, debug: 0 };

export class Net {
  constructor(g) { this.g = g; this.peer = null; this.role = 'off'; this.conns = new Map(); this.remotes = new Map(); this.status = 'Offline'; this.server = 0; this.sendT = 0; this.last = new Map(); this.auto = false; this.busy = false; this.shown = ''; addEventListener('pagehide', () => this.leave(true)); }
  get online() { return this.role !== 'off'; }
  get count() { return this.remotes.size + 1; }
  name() { return ((this.g.state.settings.name || 'Racer') + '').replace(/[<>]/g, '').slice(0, 16) || 'Racer'; }
  setStatus(s) { this.status = s; this.g.ui.refreshOnline && this.g.ui.refreshOnline(); }
  async load() {
    if (window.Peer) return;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = PEER_SRC; s.onload = res; s.onerror = () => rej(new Error('Could not reach the multiplayer library. Online play needs a normal website (e.g. GitHub Pages) with internet access.')); document.head.appendChild(s); });
  }
  // Connect to the world: join the first server that has room, or start the first one that nobody is hosting.
  async autoJoin() {
    if (this.busy || this.online) return;
    this.busy = true; this.auto = true;
    try { await this.load(); } catch (e) { this.busy = false; return this.setStatus(e.message); }
    for (let n = 1; n <= SERVERS && this.auto; n++) {
      this.setStatus(`Looking for server ${n}...`);
      let r = await this.tryServer(n);
      if (r === 'retry') r = await this.tryServer(n);
      if (r === 'ok') { this.busy = false; return; }
    }
    this.busy = false;
    if (this.auto) { this.setStatus('Could not connect - retrying shortly'); setTimeout(() => { if (this.auto && !this.online) this.autoJoin(); }, 8000); }
  }
  tryServer(n) {
    return new Promise((resolve) => {
      let done = false, hostTried = false;
      const finish = (r, peer) => { if (done) return; done = true; clearTimeout(timer); if (r !== 'ok' && peer) try { peer.destroy(); } catch (e) { /* ignore */ } resolve(r); };
      const timer = setTimeout(() => finish('fail', gp), 12000);
      const becomeHost = () => {
        if (hostTried || done) return; hostTried = true;
        try { gp.destroy(); } catch (e) { /* ignore */ }
        const hp = new window.Peer(serverId(n), PEER_OPTS);
        hp.on('open', () => { if (done) return; this.peer = hp; this.role = 'host'; this.server = n; this.conns.clear(); this.setStatus(`Server ${n}: you are hosting (1/${MAX_PLAYERS})`); finish('ok', hp); });
        hp.on('connection', (c) => this.accept(c));
        hp.on('error', (e) => { if (e.type === 'unavailable-id') finish('retry', hp); else if (!done) finish('fail', hp); else this.setStatus('Error: ' + (e.type || e.message)); });
        hp.on('disconnected', () => { try { hp.reconnect(); } catch (e) { /* ignore */ } });
      };
      const gp = new window.Peer(undefined, PEER_OPTS);
      gp.on('error', (e) => { if (e.type === 'peer-unavailable') becomeHost(); else if (!hostTried) finish('fail', gp); });
      gp.on('open', () => {
        const c = gp.connect(serverId(n), { metadata: { name: this.name() }, reliable: false });
        c.on('open', () => {
          c.on('data', (d) => {
            if (!d || !d.t) return;
            if (d.t === 'full') { finish('full', gp); return; }
            if (d.t === 'hello' && !done) {
              this.peer = gp; this.hostConn = c; this.role = 'guest'; this.server = n; this.conns.set('host', c);
              c.on('data', (dd) => this.onData('host', dd));
              c.on('close', () => this.lost()); c.on('error', () => this.lost());
              this.onData('host', d); finish('ok', gp);
              this.g.ui.toast(`Joined server ${n}`, 'good');
            }
          });
        });
        c.on('error', () => { if (!hostTried) finish('fail', gp); });
      });
    });
  }
  lost() {
    if (this.role !== 'guest') return;
    this.g.ui.toast('Lost the server - reconnecting...', 'bad');
    const keep = this.auto; this.leave(true); this.role = 'off'; this.setStatus('Reconnecting...');
    if (keep) setTimeout(() => { if (this.auto && !this.online) this.autoJoin(); }, 1200 + Math.random() * 3000);
  }
  accept(c) {
    c.on('open', () => {
      if (this.conns.size + 1 >= MAX_PLAYERS) { c.send({ t: 'full' }); setTimeout(() => { try { c.close(); } catch (e) { /* ignore */ } }, 400); return; }
      this.conns.set(c.peer, c); c.send({ t: 'hello', seed: world.seed, host: this.name(), n: this.server });
      this.setStatus(`Server ${this.server}: hosting (${this.conns.size + 1}/${MAX_PLAYERS})`);
    });
    c.on('data', (d) => this.onData(c.peer, d));
    c.on('close', () => this.drop(c.peer));
    c.on('error', () => this.drop(c.peer));
  }
  // manual controls from the Online tab
  host() { this.leave(); this.auto = true; return this.autoJoin(); }
  join() { this.leave(); this.auto = true; return this.autoJoin(); }
  leave(quiet) {
    if (!quiet) this.auto = false;
    for (const c of this.conns.values()) try { c.close(); } catch (e) { /* ignore */ }
    this.conns.clear(); if (this.peer) try { this.peer.destroy(); } catch (e) { /* ignore */ }
    this.peer = null; this.hostConn = null;
    for (const r of this.remotes.values()) this.g.scene.remove(r.group);
    this.remotes.clear(); this.last.clear();
    if (!quiet) { this.role = 'off'; this.server = 0; this.setStatus('Offline'); }
  }
  drop(id) {
    this.conns.delete(id); this.last.delete(id);
    const r = this.remotes.get(id); if (r) { this.g.scene.remove(r.group); this.remotes.delete(id); this.g.ui.toast(`${r.name} left`, 'info'); }
    if (this.role === 'host') this.setStatus(`Server ${this.server}: hosting (${this.remotes.size + 1}/${MAX_PLAYERS})`);
  }
  onData(from, d) {
    if (!d || !d.t) return;
    if (d.t === 'hello') { if (d.seed !== world.seed) { this.g.ui.toast('Syncing to the server world...', 'info'); this.g.newWorld(d.seed); } this.hostName = d.host; }
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
      const m = makeCarModel(spec, s.k || spec.color); m.group.rotation.order = 'YXZ';
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
    const sk = this.role + this.server + ':' + this.count;
    if (sk !== this.shown) { this.shown = sk; this.setStatus(`Server ${this.server}: ${this.count}/${MAX_PLAYERS} players` + (this.role === 'host' ? ' (hosting)' : '')); }
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
