// Permanent landmarks: the Horizon Pages Festival plaza and the GitHub "Repo Town" district.
import * as THREE from 'three';
import { world, nearRoad, heightAt, roadFrame, FAM } from './terrain.js';
import { GeoBuilder, makeSignTex } from './chunks.js';
import { clamp, hash2, mulberry32, lerp } from './util.js';

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...o });
const glow = (color, k = 1.2) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: k, roughness: 0.4 });
const lin = (c) => Math.pow(clamp(c, 0, 1), 2.2);
const hexRGB = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export class Festival {
  constructor(scene, chunks) {
    this.scene = scene; this.chunks = chunks; this.group = new THREE.Group(); this.occupied = [];
    scene.add(this.group); this.anim = { wheel: null, gondolas: [], lights: [], crowd: null, screen: null };
  }
  clear() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
    this.group = new THREE.Group(); this.scene.add(this.group); this.occupied.length = 0;
    this.chunks.extra.circles.length = 0; this.chunks.extra.boxes.length = 0;
    this.anim = { wheel: null, gondolas: [], lights: [], crowd: null, screen: null };
  }
  free(x, z, r) {
    if (nearRoad(x, z).edge < r + 6) return false;
    for (const o of this.occupied) if (Math.hypot(o[0] - x, o[1] - z) < o[2] + r) return false;
    return true;
  }
  spot(r, radii, rnd) {
    const f = world.festival;
    for (let tries = 0; tries < 60; tries++) {
      const a = rnd() * 6.283, d = radii[0] + rnd() * (radii[1] - radii[0]);
      const x = f.x + Math.cos(a) * d, z = f.z + Math.sin(a) * d;
      if (this.free(x, z, r)) { this.occupied.push([x, z, r]); return { x, z, a }; }
    }
    return null;
  }
  build() {
    this.clear();
    const f = world.festival, rnd = mulberry32(world.seed * 31 + 7), G = this.group, E = this.chunks.extra;
    const at = (o, x, z, y = 0) => { o.position.set(x, f.h + y, z); G.add(o); return o; };
    const face = (x, z) => Math.atan2(f.x - x, f.z - z);
    // stage
    const st = this.spot(30, [75, 110], rnd);
    if (st) {
      const g = new THREE.Group(), yaw = face(st.x, st.z);
      const base = new THREE.Mesh(new THREE.BoxGeometry(34, 2.6, 16), std(0x21262d)); base.position.y = 1.3; base.castShadow = true; g.add(base);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(34, 14, 1), std(0x0d1117)); wall.position.set(0, 9.6, -7.5); g.add(wall);
      const screenMat = new THREE.MeshStandardMaterial({ map: makeSignTex('HORIZON PAGES FESTIVAL', '#0d1117', '#ffffff', '#58a6ff'), emissiveMap: null, emissive: 0x222233, roughness: 0.3 });
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(26, 9.7), screenMat); screen.position.set(0, 9.8, -6.9); g.add(screen); this.anim.screen = screenMat;
      for (const s of [-1, 1]) {
        const sp = new THREE.Mesh(new THREE.BoxGeometry(3, 8, 3), std(0x111111)); sp.position.set(s * 18.5, 4, -3); g.add(sp);
        const tw = new THREE.Mesh(new THREE.BoxGeometry(0.6, 17, 0.6), std(0x30363d)); tw.position.set(s * 16, 8.5, 6); g.add(tw);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(34, 0.6, 0.6), glow(0xff4fd8, 1.6)); beam.position.set(0, 16.5, 6); g.add(beam); this.anim.lights.push(beam.material);
      const beam2 = new THREE.Mesh(new THREE.BoxGeometry(34, 0.6, 0.6), glow(0x58a6ff, 1.6)); beam2.position.set(0, 15, 5); g.add(beam2); this.anim.lights.push(beam2.material);
      g.rotation.y = yaw; at(g, st.x, st.z);
      for (const o of [-1, 0, 1]) E.circles.push([st.x + Math.cos(yaw) * o * 11, st.z - Math.sin(yaw) * o * 11, 9]);
      // crowd in front of the stage
      const N = 160, geo = new THREE.CylinderGeometry(0.26, 0.3, 1.7, 6).translate(0, 0.85, 0);
      const crowd = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), N);
      const m = new THREE.Matrix4(), col = new THREE.Color(), sy = Math.sin(yaw), cy = Math.cos(yaw);
      this.anim.crowdPos = [];
      for (let i = 0; i < N; i++) {
        const lx = (rnd() - 0.5) * 30, lz = 10 + rnd() * 16;
        const x = st.x + lx * cy + lz * sy, z = st.z - lx * sy + lz * cy;
        const ok = nearRoad(x, z).edge > 3;
        m.setPosition(ok ? x : 0, ok ? f.h : -100, ok ? z : 0); crowd.setMatrixAt(i, m);
        col.setHSL(rnd(), 0.6, 0.5); crowd.setColorAt(i, col);
        this.anim.crowdPos.push([ok ? x : 0, ok ? z : 0, rnd() * 6.28, ok]);
      }
      crowd.frustumCulled = false; G.add(crowd); this.anim.crowd = crowd; this.anim.crowdY = f.h;
    }
    // ferris wheel
    const fw = this.spot(26, [95, 135], rnd);
    if (fw) {
      const g = new THREE.Group(), R = 19, hub = 23;
      const legMat = std(0xc9d1d9);
      for (const s of [-1, 1]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(1, hub + 2, 1), legMat); leg.position.set(s * 4, hub / 2, 0); leg.rotation.z = -s * 0.17; g.add(leg); }
      const wheel = new THREE.Group(); wheel.position.y = hub;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.4, 6, 40), glow(0x58a6ff, 0.9)); wheel.add(ring);
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(R * 0.5, 0.25, 6, 28), glow(0xf778ba, 0.9)); wheel.add(ring2);
      for (let i = 0; i < 8; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(R * 2, 0.2, 0.2), legMat); sp.rotation.z = (i / 8) * Math.PI; wheel.add(sp); }
      const gm = [0xf0883e, 0x3fb950, 0xa371f7, 0xf85149, 0xe3b341, 0x39d0d4];
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * 6.283, pivot = new THREE.Group(); pivot.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
        const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 2.4), std(gm[i % gm.length])); cab.position.y = -1.5; pivot.add(cab); wheel.add(pivot); this.anim.gondolas.push(pivot);
      }
      g.add(wheel); this.anim.wheel = wheel;
      g.rotation.y = face(fw.x, fw.z) + Math.PI / 2; at(g, fw.x, fw.z);
      E.circles.push([fw.x, fw.z, 6]);
    }
    // tents
    for (let i = 0; i < 5; i++) {
      const p = this.spot(8, [60, 140], rnd); if (!p) continue;
      const g = new THREE.Group(), c = [0xf85149, 0x58a6ff, 0xe3b341, 0x3fb950, 0xa371f7][i];
      const w = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 3, 10), std(0xf0f3f6)); w.position.y = 1.5; g.add(w);
      const r = new THREE.Mesh(new THREE.ConeGeometry(6.6, 4, 10), std(c)); r.position.y = 5; r.castShadow = true; g.add(r);
      at(g, p.x, p.z); E.circles.push([p.x, p.z, 5.5]);
    }
    // light towers
    for (let i = 0; i < 6; i++) {
      const p = this.spot(2, [55, 150], rnd); if (!p) continue;
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.5, 20, 0.5), std(0x30363d)); pole.position.y = 10; g.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 1.2), glow(0xfff1c9, 1.5)); head.position.y = 20.3; g.add(head); this.anim.lights.push(head.material);
      at(g, p.x, p.z); E.circles.push([p.x, p.z, 0.7]);
    }
    // gate arches across the main roads
    const fr = {};
    for (const [fam, t0, name] of [[0, f.x + 55, 'HORIZON PAGES FESTIVAL'], [1, f.z - 55, 'WELCOME - git checkout fun'], [0, f.x - 55, 'MERGE EARLY, MERGE OFTEN'], [1, f.z + 55, 'SHIP IT!']]) {
      roadFrame(fam, 0, t0, fr);
      const g = new THREE.Group(), w = FAM[fam].w + 3;
      for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(1.1, 11, 1.1), glow(0x58a6ff, 0.5)); p.position.set(s * w, 5.5, 0); g.add(p); E.circles.push([fr.x + fr.nx * s * w, fr.z + fr.nz * s * w, 0.9]); }
      const banner = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 1, 3.4, 0.5), new THREE.MeshStandardMaterial({ map: makeSignTex(name), emissive: 0xffffff, emissiveMap: makeSignTex(name), emissiveIntensity: 0.25 }));
      banner.position.y = 11.2; g.add(banner);
      g.rotation.y = fr.yaw + Math.PI / 2 - Math.PI / 2; // local x axis = road left normal
      g.position.set(fr.x, heightAt(fr.x, fr.z), fr.z); G.add(g);
    }
    // blank-out any structure that ended up over water
    this.centerRing();
  }
  centerRing() {
    const f = world.festival;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(24, 0.5, 6, 48).rotateX(Math.PI / 2), glow(0x2ea043, 1.0));
    ring.position.set(f.x, heightAt(f.x, f.z) + 0.4, f.z); this.group.add(ring); this.anim.lights.push(ring.material);
  }
  update(dt, t, night) {
    const A = this.anim;
    if (A.wheel) { A.wheel.rotation.z += dt * 0.12; for (const g of A.gondolas) g.rotation.z = -A.wheel.rotation.z; }
    for (const m of A.lights) m.emissiveIntensity = 0.4 + night * (1.3 + Math.sin(t * 3 + m.id) * 0.4);
    if (A.screen) { A.screen.emissive.setHSL((t * 0.08) % 1, 0.6, 0.2 + night * 0.25); }
    if (A.crowd) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < A.crowdPos.length; i++) {
        const c = A.crowdPos[i]; if (!c[3]) continue;
        m.setPosition(c[0], A.crowdY + Math.abs(Math.sin(t * 5 + c[2])) * 0.35, c[1]); A.crowd.setMatrixAt(i, m);
      }
      A.crowd.instanceMatrix.needsUpdate = true;
    }
  }
}

// ---------- GitHub Repo Town ----------
const LANG = { JavaScript: 0xf1e05a, TypeScript: 0x3178c6, Python: 0x3572a5, HTML: 0xe34c26, CSS: 0x563d7c, Java: 0xb07219, C: 0x888888, 'C++': 0xf34b7d, 'C#': 0x178600, Rust: 0xdea584, Go: 0x00add8, Shell: 0x89e051, Lua: 0x4a4aff, Kotlin: 0xa97bff, Swift: 0xf05138, Ruby: 0xcc342d, PHP: 0x4f5d95, Dart: 0x00b4ab, Vue: 0x41b883, SCSS: 0xc6538c, 'Jupyter Notebook': 0xda5b0b };
export const DEMO_REPOS = ['horizon-pages', 'portfolio', 'dotfiles', 'my-first-game', 'api-server', 'notes', 'shaders', 'cli-tools', 'blog', 'ml-experiments'].map((name, i) => ({
  name, desc: 'Demo repository (connect your GitHub username in Settings to see yours).', stars: [42, 12, 3, 7, 1, 0, 19, 5, 2, 0][i], forks: i % 4, lang: ['JavaScript', 'HTML', 'Shell', 'JavaScript', 'Python', 'Rust', 'TypeScript', 'Go', 'CSS', 'Python'][i], url: 'https://github.com', pages: i % 3 === 0, site: '', updated: '', size: 400 * (i + 1), demo: true,
}));

export function guessGithubUser(settings) {
  const q = new URLSearchParams(location.search).get('user');
  if (q) return q.trim();
  if (settings.github) return settings.github.trim();
  const h = location.hostname;
  if (h.endsWith('.github.io')) return h.split('.')[0];
  return '';
}

export class RepoTown {
  constructor(scene, chunks, mats, festival) {
    this.scene = scene; this.chunks = chunks; this.mats = mats; this.festival = festival;
    this.group = new THREE.Group(); scene.add(this.group); this.repos = []; this.items = []; this.user = ''; this.status = 'idle'; this.near = null; this.rings = [];
  }
  async load(user, force = false) {
    this.user = user;
    if (!user) { this.repos = DEMO_REPOS; this.status = 'demo'; this.build(); return; }
    const ck = 'hp.repos.' + user.toLowerCase();
    try {
      const c = JSON.parse(localStorage.getItem(ck) || 'null');
      if (c && !force && Date.now() - c.t < 3600e3) { this.repos = c.repos; this.status = 'ok'; this.build(); return; }
    } catch (e) { /* ignore */ }
    this.status = 'loading';
    try {
      const res = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(res.status === 404 ? 'User not found' : res.status === 403 ? 'GitHub rate limit reached - try later' : 'GitHub error ' + res.status);
      const data = await res.json();
      this.repos = data.filter((r) => !r.archived || true).map((r) => ({
        name: r.name, desc: r.description || 'No description yet.', stars: r.stargazers_count, forks: r.forks_count, lang: r.language || '', url: r.html_url,
        pages: !!r.has_pages, site: r.homepage || '', updated: r.pushed_at ? r.pushed_at.slice(0, 10) : '', size: r.size || 0, fork: !!r.fork,
      }));
      if (!this.repos.length) throw new Error('This user has no public repositories');
      try { localStorage.setItem(ck, JSON.stringify({ t: Date.now(), repos: this.repos })); } catch (e) { /* ignore */ }
      this.status = 'ok';
    } catch (e) {
      this.repos = DEMO_REPOS; this.status = 'error'; this.error = e.message || String(e);
    }
    this.build();
  }
  siteUrl(r) {
    if (r.site && /^https?:\/\//.test(r.site)) return r.site;
    if (!r.pages) return '';
    return r.name.toLowerCase() === (this.user + '.github.io').toLowerCase() ? `https://${this.user}.github.io/` : `https://${this.user}.github.io/${r.name}/`;
  }
  clear() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.items.length = 0; this.rings.length = 0;
    this.chunks.extra.boxes = this.chunks.extra.boxes.filter((b) => !b.repo);
  }
  build() {
    this.clear();
    const f = world.festival, bg = new GeoBuilder(true);
    const slots = [];
    for (const R of [118, 146, 174, 202]) {
      const n = Math.floor((Math.PI * 2 * R) / 24);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + R * 0.01, x = f.x + Math.cos(a) * R, z = f.z + Math.sin(a) * R;
        if (nearRoad(x, z).edge < 14) continue;
        if (this.festival.occupied.some((o) => Math.hypot(o[0] - x, o[1] - z) < o[2] + 9)) continue;
        if (heightAt(x, z) < 2) continue;
        slots.push({ x, z, a });
      }
    }
    this.repos.slice(0, slots.length).forEach((r, i) => {
      const s = slots[i], w = 12, h = 10 + Math.min(34, Math.log2(1 + r.stars) * 6 + Math.log10(1 + r.size) * 2.5);
      const base = hexRGB(LANG[r.lang] || 0x8b949e), c = base.map((v) => lin(v * 0.7 + 0.3 * 0.9));
      const y0 = Math.min(heightAt(s.x - 6, s.z - 6), heightAt(s.x + 6, s.z + 6), heightAt(s.x, s.z)) - 2;
      const yaw = Math.atan2(f.x - s.x, f.z - s.z);
      bg.box(s.x, y0, s.z, w, h + (heightAt(s.x, s.z) - y0), w, yaw, c, 1);
      const fx = Math.sin(yaw), fz = Math.cos(yaw), gy = heightAt(s.x, s.z);
      // sign
      const tex = makeSignTex(`${r.name}  *${r.stars}`, '#0d1117', '#e6edf3', r.lang ? '#' + (LANG[r.lang] || 0x8b949e).toString(16).padStart(6, '0') : '#8b949e');
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(10, 3.4), new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.35, side: THREE.DoubleSide }));
      sign.position.set(s.x + fx * (w / 2 + 0.15), gy + 4.2, s.z + fz * (w / 2 + 0.15)); sign.rotation.y = yaw; this.group.add(sign);
      const door = { x: s.x + fx * (w / 2 + 5), z: s.z + fz * (w / 2 + 5) };
      if (r.pages) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.22, 8, 28).rotateX(Math.PI / 2), glow(0x3fb950, 1.4));
        ring.position.set(door.x, gy + 0.4, door.z); this.group.add(ring); this.rings.push(ring);
      }
      const box = [s.x - 6.8, s.z - 6.8, s.x + 6.8, s.z + 6.8]; box.repo = true; this.chunks.extra.boxes.push(box);
      this.items.push({ repo: r, door, x: s.x, z: s.z });
    });
    const m = new THREE.Mesh(bg.build(), this.mats.bldg); m.castShadow = true; m.receiveShadow = true; this.group.add(m);
  }
  update(dt, t, car) {
    for (const r of this.rings) r.rotation.y += dt * 1.5;
    this.near = null;
    let best = 13;
    for (const it of this.items) { const d = Math.hypot(it.door.x - car.x, it.door.z - car.z); if (d < best) { best = d; this.near = it; } }
  }
}
