// Horizon Pages - entry point. Wires renderer, world, physics, AI, events, audio and UI together.
import * as THREE from 'three';
import { initWorld, setSeason, world, heightAt, nearRoad, nearestRoadIndex, roadFrame, FAM } from './terrain.js';
import { CarPhysics, deriveSpec, computePI, classOf, snapshot, restore } from './physics.js';
import { CARS, carById } from './cars.js';
import { makeCarModel, loadModel } from './models.js';
import { loadBuildings } from './buildings.js';
import { makeMaterials, ChunkManager } from './chunks.js';
import { SkySystem, Weather } from './sky.js';
import { AudioSys, STATIONS } from './audio.js';
import { Traffic } from './ai.js';
import { EventManager, clearPOICache } from './events.js';
import { Festival, RepoTown } from './landmarks.js';
import { Net } from './net.js';
import { ModMenu } from './mods.js';
import { obb } from './collide.js';
import { bumpPair } from './ai.js';
import * as Save from './save.js';
import { UI } from './ui.js';
import { clamp, lerp, damp, angDiff, fmtNum } from './util.js';

const $ = (id) => document.getElementById(id);
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const PRESETS = {
  low: { pr: 1, radius: 3, pf: 1, trees: 0.35, shadow: 0, view: 520, traffic: 0.5, aa: false },
  medium: { pr: Math.min(DPR, 1.25), radius: 4, pf: 1, trees: 0.7, shadow: 1024, view: 720, traffic: 0.85, aa: true },
  high: { pr: Math.min(DPR, 1.75), radius: 5, pf: 2, trees: 1, shadow: 2048, view: 950, traffic: 1, aa: true },
  ultra: { pr: DPR, radius: 6, pf: 3, trees: 1.3, shadow: 2048, view: 1200, traffic: 1.2, aa: true },
};
const TRAFFIC_COUNT = [0, 6, 12, 20];
const SEASON_BY_MONTH = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

// ---------- tiny particle system ----------
class Particles {
  constructor(scene, n = 420) {
    this.n = n; this.i = 0;
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 4); this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n); this.grow = new Float32Array(n); this.base = new Float32Array(n * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('pcol', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.mesh = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'attribute float size; attribute vec4 pcol; varying vec4 vC; void main(){ vC=pcol; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*(380.0/max(-mv.z,1.0)); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'varying vec4 vC; void main(){ float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.12,d)*vC.a; if(a<0.01) discard; gl_FragColor=vec4(vC.rgb,a); }',
    }));
    this.mesh.frustumCulled = false; scene.add(this.mesh);
  }
  emit(x, y, z, vx, vy, vz, life, size, grow, r, g, b, a) {
    const k = this.i; this.i = (this.i + 1) % this.n;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    this.life[k] = life; this.max[k] = life; this.size[k] = size; this.grow[k] = grow;
    this.base[k * 4] = r; this.base[k * 4 + 1] = g; this.base[k * 4 + 2] = b; this.base[k * 4 + 3] = a;
  }
  update(dt) {
    for (let k = 0; k < this.n; k++) {
      if (this.life[k] <= 0) { this.col[k * 4 + 3] = 0; continue; }
      this.life[k] -= dt;
      const f = Math.max(0, this.life[k] / this.max[k]);
      this.pos[k * 3] += this.vel[k * 3] * dt; this.pos[k * 3 + 1] += this.vel[k * 3 + 1] * dt; this.pos[k * 3 + 2] += this.vel[k * 3 + 2] * dt;
      this.size[k] += this.grow[k] * dt;
      this.col[k * 4] = this.base[k * 4]; this.col[k * 4 + 1] = this.base[k * 4 + 1]; this.col[k * 4 + 2] = this.base[k * 4 + 2];
      this.col[k * 4 + 3] = this.base[k * 4 + 3] * f;
    }
    const a = this.mesh.geometry.attributes; a.position.needsUpdate = a.pcol.needsUpdate = a.size.needsUpdate = true;
  }
}

// tyre marks: a ring buffer of dark quads laid behind slipping wheels
class Skids {
  constructor(scene, n = 700) {
    this.n = n; this.i = 0; this.last = [null, null];
    this.pos = new Float32Array(n * 12); const idx = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 1, q * 4 + 3, q * 4 + 2], q * 6);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.attr = g.attributes.position;
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2; scene.add(this.mesh);
  }
  clear() { this.last = [null, null]; }
  update(c) {
    const on = c.grounded && c.wheelSlip > 0.45 && c.speed > 5 && !c.inWater && c.surf !== 5;
    if (!on) { this.last = [null, null]; return; }
    const s = Math.sin(c.yaw), co = Math.cos(c.yaw), back = c.spec.wb * 0.5, half = c.spec.track * 0.5;
    for (let k = 0; k < 2; k++) {
      const side = k ? 1 : -1, x = c.x - s * back + co * side * half, z = c.z - co * back - s * side * half, p = this.last[k];
      this.last[k] = { x, z };
      if (!p) continue;
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz); if (d < 0.25 || d > 4) { if (d > 4) this.last[k] = null; continue; }
      const nx = (-dz / d) * 0.15, nz = (dx / d) * 0.15, o = this.i * 12, y0 = heightAt(p.x, p.z) + 0.05, y1 = heightAt(x, z) + 0.05;
      this.pos.set([p.x - nx, y0, p.z - nz, p.x + nx, y0, p.z + nz, x - nx, y1, z - nz, x + nx, y1, z + nz], o);
      this.i = (this.i + 1) % this.n; this.attr.needsUpdate = true;
    }
  }
}

class Game {
  constructor() {
    this.state = Save.load();
    this.mode = 'loading'; this.paused = false; this.time = 0; this.hour = 12; this.hourCycle = 9; this.hourOverride = null;
    this.waypoint = null; this.nearSpin = false; this.rewinding = false; this.driftTotal = 0; this.photo = { fov: 60, yaw: 0, pitch: 0.25, dist: 7, h: 0 };
    this.skill = { base: 0, mult: 1, timer: 0, lines: [], kinds: new Set() };
    this.keys = {}; this.pad = { buttons: [], axes: [] }; this.touch = {}; this.steerIn = 0; this.rewindBuf = []; this.rewindT = 0;
    this.cam = { yaw: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), mode: this.state.settings.cam || 0, back: false, shake: 0, fov: 68, orbit: 0 };
    this.q = { circles: [], boxes: [] }; this.softHit = new Map(); this.saveT = 0; this.achT = 0; this.stationName = '';
    this.fps = 60; this.slowT = 0; this.auto = { chain: 0 };
  }

  async init() {
    const st = this.state, set = st.settings;
    const canvas = $('c');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: (PRESETS[set.quality] || PRESETS.medium).aa, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(set.fov, innerWidth / innerHeight, 0.4, 4200);
    this.scene.add(this.camera);
    this.audio = new AudioSys();
    this.audio.vol = { master: set.master, music: set.music, sfx: set.sfx };
    this.ui = new UI(this);
    this.setLoad(0.02, 'Seeding the world...');
    await frame();
    this.season = set.season === 'auto' ? SEASON_BY_MONTH[new Date().getMonth()] : set.season;
    initWorld(set.seed, this.season);
    this.mats = makeMaterials();
    this.chunks = new ChunkManager(this.scene, this.mats);
    this.sky = new SkySystem(this.scene, this.renderer, this.camera);
    this.weather = new Weather(); this.weather.thunder = (d) => this.audio.thunder(d);
    this.particles = new Particles(this.scene); this.skids = new Skids(this.scene);
    this.traffic = new Traffic(this.scene);
    this.events = new EventManager(this);
    this.festival = new Festival(this.scene, this.chunks);
    this.repoTown = new RepoTown(this.scene, this.chunks, this.mats, this.festival);
    this.car = new CarPhysics(carById(st.current));
    this.applyQuality();
    this.applyCar(true);
    await this.setupPost();
    this.setLoad(0.06, 'Loading car models...');
    try { this.setLoad(0.06, 'Loading city towers...'); await loadBuildings(); } catch (e) { console.warn('buildings unavailable', e); }
    for (const k of ['huracan', 'gt3', 'm5']) { try { this.setLoad(0.07, 'Loading car models...'); await loadModel(k); } catch (e) { console.warn(k + ' model unavailable', e); } }
    this.applyCar(true);
    this.setLoad(0.08, 'Raising the festival...');
    await frame();
    this.festival.build();
    this.repoTown.load();
    this.net = new Net(this); this.mods = new ModMenu(this);
    this.placeOnRoad(world.festival.x - 125, world.festival.z, true);
    this.applySettings('weather'); this.applySettings('tod');
    await this.buildChunks();
    this.bind(); this.resize();
    this.setStation(set.radio || 0, true);
    this.updateTitleInfo();
    $('loading').classList.add('hidden'); $('title').classList.remove('hidden');
    this.mode = 'title'; this.last = performance.now();
    if ('ontouchstart' in window || navigator.maxTouchPoints > 1) $('touch').classList.remove('hidden');
    requestAnimationFrame((t) => this.loop(t));
  }
  async setupPost() {
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }, { RoomEnvironment }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'), import('three/addons/postprocessing/OutputPass.js'),
        import('three/addons/environments/RoomEnvironment.js')]);
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
      const q = this.state.settings.quality, rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: q === 'ultra' || q === 'high' ? 4 : 2 });
      const comp = new EffectComposer(this.renderer, rt);
      comp.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.2, 0.5, 2.6);
      comp.addPass(this.bloom); comp.addPass(new OutputPass());
      this.composer = comp; this.resize();
    } catch (e) { console.warn('Post-processing unavailable', e); this.composer = null; }
  }
  renderFrame() {
    const p = PRESETS[this.state.settings.quality] || PRESETS.medium;
    if (this.composer && p.shadow) this.composer.render(); else this.renderer.render(this.scene, this.camera);
  }
  setLoad(p, msg) { $('ldFill').style.width = (p * 100).toFixed(0) + '%'; if (msg) $('ldMsg').textContent = msg; }
  async buildChunks() {
    const R = this.chunks.radius, total = Math.PI * R * R, c = this.car, pf = this.chunks.perFrame;
    this.chunks.perFrame = 4;
    for (let i = 0; i < 400; i++) {
      const before = this.chunks.map.size;
      this.chunks.update(c.x, c.z);
      this.setLoad(0.1 + 0.88 * Math.min(1, this.chunks.map.size / total), ['Paving roads...', 'Planting trees...', 'Hiding barn finds...', 'Polishing the sun...'][Math.floor(i / 6) % 4]);
      if (this.chunks.map.size === before) break;
      await frame();
    }
    this.chunks.perFrame = pf;
  }
  updateTitleInfo() { $('titleInfo').textContent = 'Find Iron Strike and NodeNGW in the festival plaza. Type supermod for the mod menu.'; }

  // ---------- settings ----------
  applyQuality() {
    const p = PRESETS[this.state.settings.quality] || PRESETS.medium;
    this.renderer.setPixelRatio(p.pr); this.renderer.setSize(innerWidth, innerHeight, false); if (this.composer) this.resize();
    this.chunks.setQuality(p.radius, p.pf, p.trees);
    this.sky.setViewDistance(p.view); this.sky.setShadows(!!p.shadow, p.shadow);
    this.sky.sun.shadow.camera.left = -(60 + p.radius * 8); this.sky.sun.shadow.camera.right = 60 + p.radius * 8; this.sky.sun.shadow.camera.top = 60 + p.radius * 8; this.sky.sun.shadow.camera.bottom = -(60 + p.radius * 8); this.sky.sun.shadow.camera.updateProjectionMatrix();
    this.qMul = p.traffic;
    this.traffic.setCount(TRAFFIC_COUNT[this.state.settings.traffic] ?? 2);
  }
  applySettings(k) {
    const set = this.state.settings;
    switch (k) {
      case 'quality': this.applyQuality(); this.chunks.flush(); break;
      case 'traffic': this.traffic.setCount(TRAFFIC_COUNT[set.traffic] ?? 2); break;
      case 'fov': this.camera.fov = set.fov; this.camera.updateProjectionMatrix(); break;
      case 'master': case 'music': case 'sfx': this.audio.setVolumes({ master: set.master, music: set.music, sfx: set.sfx }); break;
      case 'weather': if (set.weather === 'auto') this.weather.auto = true; else { this.weather.auto = false; this.weather.set(set.weather); } break;
      case 'season': {
        this.season = set.season === 'auto' ? SEASON_BY_MONTH[new Date().getMonth()] : set.season;
        setSeason(this.season); this.chunks.flush(); break;
      }
      case 'tod': this.hourOverride = null; break;
      case 'github': break;
      default: break;
    }
    this.save();
  }
  setStation(i, silent) {
    const s = this.audio.setStation(i); this.state.settings.radio = this.audio.station;
    if (!silent) this.ui.showRadio(s.name);
  }
  onMenu(b) { this.paused = b || this.mode === 'photo'; }

  // ---------- car ----------
  applyCar(rebuild) {
    const st = this.state, base = carById(st.current), own = st.cars[st.current] || (st.cars[st.current] = { color: base.color, up: {} });
    const spec = deriveSpec(base, own.up); spec.pi = computePI(spec); spec.cls = classOf(spec.pi);
    this.carSpec = spec; this.car.setSpec(spec);
    if (this.model) this.scene.remove(this.model.group);
    const m = makeCarModel(base, own.color); this.model = m;
    if (this.envTex && m.mats) for (const mt of m.mats) if (mt && !mt.envMap && mt.isMeshStandardMaterial) { mt.envMap = this.envTex; mt.envMapIntensity = 0.4; }
    m.group.rotation.order = 'YXZ';
    if (this.envTex) { const b = m.body; b.envMap = this.envTex; b.envMapIntensity = 0.5; b.roughness = 0.3; b.metalness = 0.5; if (b.emissive) b.emissive.setScalar(0); if (b.color) { const mx = Math.max(b.color.r, b.color.g, b.color.b); if (mx > 0.72) b.color.multiplyScalar(0.72 / mx); } }
    m.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.headlight = new THREE.SpotLight(0xfff0d0, 0, 90, 0.5, 0.6, 1.2);
    this.headlight.position.set(0, 0.9, 1.8); this.headlight.target.position.set(0, 0, 22);
    m.group.add(this.headlight, this.headlight.target);
    this.scene.add(m.group);
  }
  giveCar(id) { const s = carById(id); if (!this.state.cars[id]) this.state.cars[id] = { color: s.color, up: {} }; this.save(); }
  placeCar(x, z, yaw, speed = 0) {
    this.car.reset(x, z, yaw, speed); this.car.y = heightAt(x, z);
    this.rewindBuf.length = 0; this.cam.yaw = yaw; this.camSnap = true; this.softHit.clear(); if (this.skids) this.skids.clear();
    this.skillReset();
  }
  placeOnRoad(x = this.car.x, z = this.car.z, start = false) {
    const f = nearRoad(x, z).fam, F = FAM[f], idx = nearestRoadIndex(f, x, z), t = F.axis === 0 ? x : z, fr = {};
    roadFrame(f, idx, t, fr);
    const heading = start ? fr.yaw : (Math.cos(this.car.yaw) * Math.cos(fr.yaw) + Math.sin(this.car.yaw) * Math.sin(fr.yaw) >= 0 ? fr.yaw : fr.yaw + Math.PI);
    const side = heading === fr.yaw ? -3.2 : 3.2;
    this.placeCar(fr.x + fr.nx * side, fr.z + fr.nz * side, heading, 0);
  }
  travel(x, z) { if (this.events.race || this.events.chal) this.events.cancel(); this.placeOnRoad(x, z, true); this.chunks.update(x, z); this.toastTravel(); }
  toastTravel() { this.ui.toast('Fast travel', 'info'); this.audio.blip('ok'); }

  // ---------- economy / skill ----------
  addXp(n) { const lv = Save.addXp(this.state, n); if (lv) this.ui.levelUp(this.state.level); return lv; }
  addCredits(n) { this.state.credits += Math.round(n); }
  skillAdd(label, pts, kind) {
    const s = this.skill; s.base += pts; s.kinds.add(kind); s.mult = s.kinds.size; s.timer = 3;
    const i = s.lines.indexOf(label); if (i >= 0) s.lines.splice(i, 1); s.lines.push(label);
    if (s.lines.length > 6) s.lines.shift();
  }
  skillReset() { const s = this.skill; s.base = 0; s.mult = 1; s.timer = 0; s.lines = []; s.kinds.clear(); }
  skillBank() {
    const s = this.skill, score = Math.round(s.base * s.mult), st = this.state.stats;
    if (score >= 100) {
      st.skillBest = Math.max(st.skillBest, score);
      this.addXp(score / 40); this.addCredits(score / 25);
      this.ui.toast(`Skill chain banked: ${fmtNum(score)} pts  (x${s.mult})`, 'good'); this.audio.blip('coin');
    }
    this.skillReset();
  }
  spinWheel() {
    const st = this.state; if (st.wheelspins <= 0) return;
    st.wheelspins--; st.stats.wheelspins++;
    const locked = CARS.filter((c) => !st.cars[c.id] && c.price <= 120000);
    const r = Math.random(); let prize;
    if (r < 0.06 && locked.length) { const c = locked[Math.floor(Math.random() * locked.length)]; this.giveCar(c.id); prize = { t: c.name, c: '#e3b341', sub: `${c.cls} ${c.pi} - added to your garage!` }; }
    else if (r < 0.35) { const x = [5000, 10000, 25000][Math.floor(Math.random() * 3)]; this.addCredits(x); prize = { t: fmtNum(x) + ' CR', c: '#e3b341', sub: 'Credits' }; }
    else if (r < 0.65) { const x = [300, 600, 1500][Math.floor(Math.random() * 3)]; this.addXp(x); prize = { t: x + ' XP', c: '#58a6ff', sub: 'Experience' }; }
    else if (r < 0.8) { this.addCredits(2500); prize = { t: '2,500 CR', c: '#e3b341', sub: 'Credits' }; }
    else if (r < 0.9) { this.addXp(150); prize = { t: '150 XP', c: '#58a6ff', sub: 'Experience' }; }
    else { st.wheelspins++; prize = { t: 'Free Spin', c: '#a371f7', sub: 'Spin again!' }; }
    const pool = [{ t: '2,500 CR', c: '#e3b341' }, { t: '600 XP', c: '#58a6ff' }, { t: '10,000 CR', c: '#e3b341' }, { t: 'Free Spin', c: '#a371f7' }, { t: '150 XP', c: '#58a6ff' }, { t: 'Rare Car', c: '#3fb950' }, { t: '25,000 CR', c: '#e3b341' }, { t: '1,500 XP', c: '#58a6ff' }];
    const labels = []; for (let i = 0; i < 30; i++) labels.push(pool[Math.floor(Math.random() * pool.length)]);
    const idx = 24; labels[idx] = { t: prize.t, c: prize.c };
    this.ui.showSpin(prize, labels, idx); this.save();
  }
  onEventStart() { this.rewindBuf.length = 0; this.skillReset(); }
  onEventEnd() { this.rewindBuf.length = 0; }

  // ---------- world ----------
  async newWorld(seed) {
    const st = this.state; st.settings.seed = seed;
    st.discovered = {}; st.done = {}; st.boards = {}; st.barns = {};
    this.events.cancel(); this.traffic.clear();
    for (const m of this.events.markers.values()) this.events.group.remove(m);
    this.events.markers.clear(); this.events.lastReg = '';
    initWorld(seed, this.season); clearPOICache(); this.chunks.flush();
    this.festival.build(); this.repoTown.build();
    this.waypoint = null; this.mode = 'loading'; $('loading').classList.remove('hidden');
    this.placeOnRoad(world.festival.x - 125, world.festival.z, true);
    await this.buildChunks();
    $('loading').classList.add('hidden'); this.mode = 'play'; this.ui.toast(`New world generated (seed ${seed})`, 'good'); this.save();
  }
  save() { Save.save(this.state); }
  exportSave() { return Save.exportSave(this.state); }
  importSave(t) { this.state = Save.importSave(t); this.save(); location.reload(); }
  wipeSave() { Save.wipe(); this.state = Save.defaults(); location.reload(); }

  // ---------- input ----------
  bind() {
    addEventListener('resize', () => this.resize());
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => { this.keys = {}; });
    addEventListener('beforeunload', () => this.save());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.save(); });
    $('title').addEventListener('click', (e) => { if (e.target.closest('[data-act="start"]')) this.start(); });
    const hold = (id, key) => { const el = $(id); if (!el) return; const on = (v) => (e) => { e.preventDefault(); this.touch[key] = v; }; el.addEventListener('pointerdown', on(true)); el.addEventListener('pointerup', on(false)); el.addEventListener('pointercancel', on(false)); el.addEventListener('pointerleave', on(false)); el.addEventListener('contextmenu', (e) => e.preventDefault()); };
    hold('tLeft', 'left'); hold('tRight', 'right'); hold('tGas', 'gas'); hold('tBrake', 'brake'); hold('tHand', 'hand'); hold('tNitro', 'nitro');
    $('tCam').addEventListener('pointerdown', (e) => { e.preventDefault(); this.nextCam(); });
    $('tMenu').addEventListener('pointerdown', (e) => { e.preventDefault(); this.toggleMenu(); });
    window.addEventListener('error', (e) => this.fatal(e.message + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '')));
    window.addEventListener('unhandledrejection', (e) => this.fatal(String(e.reason && e.reason.stack || e.reason)));
  }
  fatal(msg) { const f = $('fatal'); f.classList.remove('hidden'); f.innerHTML = `<b>Something went wrong</b><br><code>${String(msg).replace(/</g, '&lt;')}</code><br><button class="btn" onclick="this.parentNode.classList.add('hidden')">Dismiss</button>`; }
  resize() { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth, innerHeight, false); if (this.composer) { this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(innerWidth, innerHeight); this.bloom.resolution.set(innerWidth / 2, innerHeight / 2); } }
  start() {
    this.audio.init(); this.audio.setVolumes({}); this.audio.setStation(this.state.settings.radio || 0);
    if (this.net && this.state.settings.online !== false) setTimeout(() => this.net.autoJoin(), 1500);
    $('title').classList.add('hidden'); $('hud').classList.remove('hidden'); this.mode = 'play'; this.last = performance.now();
    if (!document.fullscreenElement && /Mobi|Android/i.test(navigator.userAgent)) document.documentElement.requestFullscreen?.().catch(() => {});
  }
  nextCam() { this.cam.mode = (this.cam.mode + 1) % 4; this.state.settings.cam = this.cam.mode; this.audio.blip('ui'); }
  toggleMenu(tab) {
    if (this.mode === 'photo') return this.exitPhoto();
    if (this.mode !== 'play') return;
    if (this.ui.menuOpen) this.ui.closeMenu(); else if (!$('overlay').classList.contains('hidden')) { if (this.ui.overlayMode !== 'results') this.ui.hideOverlay(); } else this.ui.openMenu(tab);
  }
  onKey(e, down) {
    const k = e.code;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k) && e.target === document.body) e.preventDefault();
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { if (k === 'Escape' && down) e.target.blur(); return; }
    this.keys[k] = down;
    if (!down) return;
    if (this.mode === 'title') { if (k === 'Enter' || k === 'Space') this.start(); return; }
    if (this.mode === 'photo') { if (k === 'Escape' || k === 'KeyP') this.exitPhoto(); return; }
    if (this.mode !== 'play') return;
    if (k === 'Escape') this.toggleMenu();
    else if (k === 'KeyM') { if (this.ui.menuOpen && this.ui.tab === 'map') this.ui.closeMenu(); else if (!this.ui.menuOpen) this.ui.openMenu('map'); }
    if (this.paused) return;
    switch (k) {
      case 'KeyC': this.nextCam(); break;
      case 'KeyR': this.setStation(this.audio.station + 1); break;
      case 'Enter': this.events.tryStart(); break;
      case 'KeyE': this.interact(); break;
      case 'KeyT': if (!this.events.race) { this.placeOnRoad(); this.ui.toast('Reset to road', 'info'); } break;
      case 'KeyP': this.enterPhoto(); break;
      case 'KeyF': if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); break;
      default: break;
    }
  }
  interact() {
    if (this.repoTown.near) {
      const it = this.repoTown.near; if (!this.state.repos[it.repo.name]) { this.state.repos[it.repo.name] = 1; this.addXp(120); }
      this.ui.showRepo(it);
    } else if (this.nearSpin) { if (this.state.wheelspins > 0) this.spinWheel(); else this.ui.toast('No wheelspins left - level up or win races!', 'info'); }
  }
  enterPhoto() {
    this.mode = 'photo'; this.paused = true; const p = this.photo; p.yaw = 0; p.pitch = 0.22; p.dist = 7.5; p.h = 0; p.fov = this.camera.fov;
    this.hourOverride = this.hour; this.ui.openPhoto(); this.audio.horn(false);
  }
  exitPhoto() { this.mode = 'play'; this.paused = false; this.hourOverride = null; this.ui.closePhoto(); this.camera.fov = this.state.settings.fov; this.camera.updateProjectionMatrix(); }
  capture() {
    this.renderFrame();
    $('c').toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `horizon-pages-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
    this.audio.blip('photo'); this.ui.toast('Photo saved', 'good');
  }
  readPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : []; const p = pads && [...pads].find((x) => x && x.connected);
    const prev = this.pad.buttons; const b = p ? p.buttons.map((x) => x.pressed) : []; const edge = (i) => b[i] && !prev[i];
    this.pad = { buttons: b, axes: p ? p.axes : [], p, tr: p ? p.buttons[7]?.value || 0 : 0, tl: p ? p.buttons[6]?.value || 0 : 0 };
    if (!p) return;
    if (this.mode === 'play') {
      if (edge(9)) this.toggleMenu(); if (edge(8)) this.toggleMenu('map');
      if (!this.paused) { if (edge(3)) this.nextCam(); if (edge(12)) this.events.tryStart(); if (edge(15)) this.setStation(this.audio.station + 1); if (edge(0) && false) this.interact(); }
    } else if (this.mode === 'title' && (edge(0) || edge(9))) this.start();
  }
  input() {
    const k = this.keys, t = this.touch, pad = this.pad, ax = pad.axes[0] || 0, dz = Math.abs(ax) > 0.12 ? ax : 0;
    let steer = (k.KeyA || k.ArrowLeft || t.left ? 1 : 0) - (k.KeyD || k.ArrowRight || t.right ? 1 : 0) - dz;
    const throttle = Math.max(k.KeyW || k.ArrowUp || t.gas ? 1 : 0, pad.tr || 0);
    const brake = Math.max(k.KeyS || k.ArrowDown || t.brake ? 1 : 0, pad.tl || 0);
    const hand = !!(k.Space || t.hand || pad.buttons[0]);
    const nitro = !!(k.ShiftLeft || k.ShiftRight || t.nitro || pad.buttons[1] || pad.buttons[5]);
    const rewind = !!(k.KeyG || pad.buttons[2]);
    return { steer: clamp(steer, -1, 1), throttle, brake, hand, nitro, rewind, horn: !!(k.KeyH), back: !!k.KeyV };
  }

  // ---------- main loop ----------
  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    let dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; if (!(dt > 0)) dt = 0.016;
    this.fps = lerp(this.fps, 1 / dt, 0.05);
    try { this.frame(dt); } catch (e) { console.error(e); if (!this.errShown) { this.errShown = true; this.fatal(e.stack || e.message); } }
  }
  frame(dt) {
    const set = this.state.settings, c = this.car;
    this.readPad();
    // time of day
    if (this.hourOverride !== null) this.hour = this.hourOverride;
    else if (set.tod === 'real') { const d = new Date(); this.hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; }
    else if (set.tod === 'cycle') { this.hourCycle = (this.hourCycle + dt / 60) % 24; this.hour = this.hourCycle; }
    else this.hour = parseFloat(set.tod) || 12;

    if (this.mode === 'play' && !this.paused) this.simulate(dt);
    else if (this.mode === 'title') { this.cam.orbit += dt * 0.12; }
    else if (this.mode === 'photo') this.photoControls(dt);

    // dynamic world (runs always so the title screen & menus feel alive)
    const run = this.mode !== 'loading';
    this.weather.update(this.paused ? 0 : dt, this.season);
    this.updateCamera(dt);
    this.sky.update(dt, this.hour, this.weather, { x: c.x, y: c.y, z: c.z });
    this.chunks.setNight(this.sky.night);
    { const wet = this.weather.cur.rain; this.mats.road.roughness = 0.88 - 0.62 * wet; this.mats.road.color.setScalar(1 - 0.28 * wet); this.mats.terrain.color.setScalar(1 - 0.16 * wet); if (this.envTex) { this.mats.road.envMap = this.envTex; this.mats.road.envMapIntensity = wet * 0.7; } }
    if (run) this.chunks.update(c.x, c.z);
    this.festival.update(dt, this.time, this.sky.night);
    this.repoTown.update(dt, this.time, c);
    this.syncModel(dt);
    if (this.net) this.net.update(dt);
    this.headlight.intensity = this.sky.night > 0.3 || this.weather.cur.fog > 0.4 ? 160 * Math.max(this.sky.night, 0.5) : 0;
    this.particles.update(dt);
    if (this.mode !== 'title') this.audio.update(c, this.weather, this.paused || this.mode !== 'play');
    this.audio.radioTick();
    if (this.mode === 'play' || this.mode === 'photo') { this.ui.hud(c, dt, this.time); this.mmT = (this.mmT || 0) + 1; if (this.mmT % 2 === 0) this.ui.drawMinimap(c, this.time); }
    this.renderFrame();
    const fx = $('speedfx'); if (fx) fx.style.opacity = this.mode === 'play' ? clamp((c.kmh - 120) / 200, 0, 0.9) + (c.nitroOn ? 0.25 : 0) : 0;
  }

  simulate(dt) {
    const c = this.car, st = this.state, set = st.settings, inp = this.input();
    this.time += dt; st.stats.playTime += dt;
    // rewind
    const canRew = !this.events.locked;
    this.rewinding = inp.rewind && canRew && this.rewindBuf.length > 3;
    if (this.rewinding) {
      this.rewindT += dt * 1.8 / 0.1;
      let n = Math.floor(this.rewindT); this.rewindT -= n;
      while (n-- > 0 && this.rewindBuf.length > 1) this.rewindBuf.pop();
      restore(c, this.rewindBuf[this.rewindBuf.length - 1]); c.grounded = true; c.vy = 0;
      c.worldVel(); this.audio.blip && Math.random() < 0.05 && this.audio.blip('rewind');
      this.skillReset();
    } else {
      this.rewindT += dt; if (this.rewindT >= 0.1) { this.rewindT = 0; this.rewindBuf.push(snapshot(c)); if (this.rewindBuf.length > 220) this.rewindBuf.shift(); }
      // controls
      const lock = this.events.locked;
      const target = lock ? 0 : inp.steer;
      this.steerIn = damp(this.steerIn, target, Math.abs(target) > Math.abs(this.steerIn) ? 9 : 14, dt);
      const ctl = { throttle: lock ? 0 : inp.throttle, brake: lock ? 0 : inp.brake, steer: this.steerIn, handbrake: lock ? true : inp.hand, nitro: !lock && inp.nitro, abs: set.abs, tcs: set.tcs, stm: set.stm };
      c.throttleIn = ctl.throttle;
      const wasNitro = c.nitroOn, wasGear = c.gear;
      const N = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / N;
      this.chunks.collidersNear(c.x, c.z, this.q);
      this.mods.tick();
      const god = this.mods.f.god;
      for (let i = 0; i < N; i++) { c.step(h, ctl, this.weather.wet); if (!god) this.collide(c); if (this.mods.f.boost && ctl.throttle > 0.1) c.u += 32 * h * ctl.throttle; }
      c.updateAttitude(dt);
      if (c.nitroOn && !wasNitro) this.audio.nitro();
      if (c.gear !== wasGear && c.gear > wasGear) this.audio.shift();
      this.audio.horn(inp.horn);
      // water & falls
      if ((c.inWater && c.waterT > 2.2) || c.y < -40) { this.placeOnRoad(); this.ui.toast('Back on the road', 'info'); }
    }
    c.worldVel();
    // events & AI
    this.events.update(dt, c, this.time);
    this.traffic.update(dt, c.x, c.z, this.qMul);
    if (!this.mods.f.god) this.carVsAI(dt);
    this.nearSpin = Math.hypot(c.x - world.festival.x, c.z - world.festival.z) < 32 && !this.events.race;
    this.skillTick(dt);
    // stats
    const s = st.stats; s.km += c.speed * dt / 1000; s.topKmh = Math.max(s.topKmh, c.kmh);
    if (!c.grounded) s.airTime += dt;
    if ((this.achT += dt) > 2) { this.achT = 0; this.checkAch(); }
    if ((this.saveT += dt) > 20) { this.saveT = 0; this.save(); }
    this.emitParticles(dt); this.skids.update(c);
    // camera shake from impacts
    this.cam.shake = Math.max(0, this.cam.shake - dt * 3);
  }

  collide(c) {
    const q = this.q, s = Math.sin(c.yaw), co = Math.cos(c.yaw), L = c.spec.L, R = c.spec.W * 0.5, off = L * 0.3;
    for (let k = 0; k < 2; k++) {
      const px = c.x + s * off * (k ? -1 : 1), pz = c.z + co * off * (k ? -1 : 1);
      for (const o of q.circles) {
        const dx = px - o[0], dz = pz - o[1], min = o[2] + R;
        if (dx * dx + dz * dz >= min * min) continue;
        if (o[2] < 0.65) { this.softHitObj(o, c); continue; }
        this.bump(c, dx, dz, min);
      }
      for (const b of q.boxes) {
        if (px < b[0] - R || px > b[2] + R || pz < b[1] - R || pz > b[3] + R) continue;
        const cx = clamp(px, b[0], b[2]), cz = clamp(pz, b[1], b[3]);
        let dx = px - cx, dz = pz - cz;
        if (dx === 0 && dz === 0) { // centre inside: push along the shortest axis
          const l = px - b[0], r = b[2] - px, t = pz - b[1], bt = b[3] - pz, m = Math.min(l, r, t, bt);
          dx = m === l ? -1 : m === r ? 1 : 0; dz = m === t ? -1 : m === bt ? 1 : 0; this.bump(c, dx, dz, R + m); continue;
        }
        if (dx * dx + dz * dz < R * R) this.bump(c, dx, dz, R);
      }
    }
  }
  bump(c, dx, dz, min) {
    const d = Math.hypot(dx, dz) || 1e-3, nx = dx / d, nz = dz / d, pen = min - d;
    c.x += nx * pen; c.z += nz * pen;
    c.worldVel();
    const vn = c.vx * nx + c.vz * nz;
    if (vn < 0) {
      c.vx -= 1.25 * vn * nx; c.vz -= 1.25 * vn * nz; c.vx *= 0.985; c.vz *= 0.985;
      c.setWorldVel(c.vx, c.vz); c.r += (Math.random() - 0.5) * Math.min(1.2, -vn * 0.05);
      const imp = -vn; if (imp > 2.5) this.crash(imp);
    }
  }
  softHitObj(o, c) {
    const now = this.time, last = this.softHit.get(o) || -99;
    if (now - last < 4) return;
    this.softHit.set(o, now);
    if (c.speed > 6) { c.u *= 0.985; this.state.stats.smashed++; this.audio.pop(); this.skillAdd('Smash', 150, 'smash'); }
  }
  crash(imp) {
    this.audio.crash(imp); this.cam.shake = Math.min(1, this.cam.shake + imp * 0.04);
    if (imp > 7) { if (this.skill.base > 0) this.ui.toast('Skill chain lost!', 'bad'); this.skillReset(); }
  }
  carVsAI(dt) {
    const c = this.car, me = { x: c.x, z: c.z, yaw: c.yaw, L: c.spec.L, W: c.spec.W };
    c.worldVel();
    for (const t of this.traffic.cars) {
      const d = Math.hypot(t.x - c.x, t.z - c.z); if (d > 14) continue;
      const hit = obb(me, { x: t.x, z: t.z, yaw: t.yaw, L: t.L, W: t.W });
      if (hit) {
        const tvx = t.state === 'drive' ? Math.sin(t.yaw) * t.speed : t.vx, tvz = t.state === 'drive' ? Math.cos(t.yaw) * t.speed : t.vz;
        const rel = (c.vx - tvx) * hit.nx + (c.vz - tvz) * hit.nz, push = Math.max(0, rel);
        this.traffic.hit(t, hit.nx, hit.nz, push * 0.9 + 2);
        c.x -= hit.nx * (hit.depth * 0.55 + 0.02); c.z -= hit.nz * (hit.depth * 0.55 + 0.02);
        t.x += hit.nx * hit.depth * 0.45; t.z += hit.nz * hit.depth * 0.45;
        if (push > 0) { c.vx -= hit.nx * push * 0.5; c.vz -= hit.nz * push * 0.5; c.setWorldVel(c.vx, c.vz); c.worldVel(); }
        if (push > 3) this.crash(push);
        t.near = false; t.passed = true;
      } else if (t.state === 'drive') {
        if (d < 4.6 && c.speed > 16) t.near = true;
        else if (t.near && d > 6 && !t.passed) { t.passed = true; this.state.stats.nearMiss++; this.skillAdd('Near Miss', 400, 'near'); this.audio.blip('coin'); }
      }
    }
    const bodies = [...this.events.rivalsList(), ...(this.net ? [...this.net.remotes.values()] : [])];
    for (const r of bodies) {
      const hit = obb(me, { x: r.x, z: r.z, yaw: r.yaw, L: r.L, W: r.W });
      if (!hit) continue;
      const rvx = Math.sin(r.yaw) * r.speed, rvz = Math.cos(r.yaw) * r.speed;
      const rel = (c.vx - rvx) * hit.nx + (c.vz - rvz) * hit.nz;
      c.x -= hit.nx * (hit.depth * 0.5 + 0.02); c.z -= hit.nz * (hit.depth * 0.5 + 0.02);
      // both cars lose speed and get shoved sideways
      if (rel > 0) { c.vx -= hit.nx * rel * 0.55; c.vz -= hit.nz * rel * 0.55; c.setWorldVel(c.vx, c.vz); c.worldVel(); }
      c.u *= 0.95; c.r += (Math.random() - 0.5) * 0.4;
      bumpPair({ x: 0, z: 0, vx: 0, vz: 0, speed: 0 }, r, { nx: hit.nx, nz: hit.nz, depth: hit.depth * 0.5 });
      if (rel > 3) this.crash(rel * 0.5);
    }
  }
  skillTick(dt) {
    const c = this.car, s = this.skill, st = this.state.stats;
    if (c.drifting) { const pts = dt * Math.abs(c.slip) * c.speed * 28; this.driftTotal += pts; st.driftPts += pts; this.skillAdd('Drift', pts, 'drift'); }
    if (c.kmh > 170 && c.grounded) this.skillAdd('Speed', dt * (c.kmh - 150) * 1.2, 'speed');
    if (!c.grounded && c.air > 0.7) this.skillAdd('Air', dt * 90, 'air');
    if (c.justLanded) {
      c.justLanded = false;
      if (c.lastAir > 0.8) {
        const d = Math.hypot(c.vx, c.vz) * c.lastAir; st.jumps++; st.maxJump = Math.max(st.maxJump, d);
        this.skillAdd(`Jump ${Math.round(d)} m`, d * 18, 'air');
        if (c.landing > 9) this.audio.landing(c.landing); c.landing = 0;
      } else if (c.landing > 4) { this.audio.landing(c.landing); c.landing = 0; }
    }
    if (s.base > 0) {
      const active = c.drifting || (c.kmh > 170 && c.grounded) || (!c.grounded && c.air > 0.7);
      if (!active) { s.timer -= dt; if (s.timer <= 0) this.skillBank(); } else s.timer = 3;
    }
  }
  checkAch() {
    const st = this.state;
    for (const a of Save.ACHIEVEMENTS) {
      if (st.ach[a.id]) continue;
      let ok = false; try { ok = a.test(st); } catch (e) { ok = false; }
      if (ok) { st.ach[a.id] = Date.now(); this.ui.toast(`Achievement: ${a.name}`, 'level'); this.audio.blip('level'); this.addXp(300); this.addCredits(2000); }
    }
  }

  // ---------- visuals ----------
  syncModel(dt) {
    const c = this.car, m = this.model, g = m.group;
    g.position.set(c.x, c.y, c.z);
    g.rotation.set(-c.pitch, c.yaw, c.roll);
    for (const w of m.wheels) { if (w.front) w.pivot.rotation.y = c.steerAngle; w.spin.rotation.x = c.wheelRot; }
    m.tail.emissiveIntensity = c.brakeOn || c.reverse ? 2.6 : 0.6;
    m.head.emissiveIntensity = 0.9 + this.sky.night * 1.6;
    m.flame.visible = c.nitroOn; if (c.nitroOn) m.flame.scale.set(1 + Math.random() * 0.3, 1 + Math.random() * 0.3, -(1 + Math.random() * 0.5));
    g.visible = this.cam.mode !== 2 || this.mode !== 'play' || this.cam.back;
  }
  updateCamera(dt) {
    const cam = this.camera, C = this.cam, c = this.car, set = this.state.settings;
    let px, py, pz, lx, ly, lz, fov = set.fov;
    if (this.mode === 'title' || this.mode === 'loading') {
      const a = C.orbit, d = 9 + Math.sin(C.orbit * 0.7) * 1.5;
      px = c.x + Math.sin(a) * d; pz = c.z + Math.cos(a) * d; py = c.y + 2.2 + Math.sin(C.orbit * 0.5) * 0.6; lx = c.x; ly = c.y + 0.8; lz = c.z; fov = 52;
      C.pos.set(px, py, pz); C.look.set(lx, ly, lz);
    } else if (this.mode === 'photo') {
      const p = this.photo, a = c.yaw + Math.PI + p.yaw, d = p.dist;
      px = c.x + Math.sin(a) * d * Math.cos(p.pitch); pz = c.z + Math.cos(a) * d * Math.cos(p.pitch); py = c.y + 1.0 + Math.sin(p.pitch) * d + p.h;
      py = Math.max(py, heightAt(px, pz) + 0.4); lx = c.x; ly = c.y + 0.9; lz = c.z; fov = p.fov;
      C.pos.set(px, py, pz); C.look.set(lx, ly, lz);
    } else {
      const spd = c.speed, back = C.back = !!this.keys.KeyV;
      // blend camera heading between car heading and velocity direction so drifts look good
      const velYaw = spd > 6 ? Math.atan2(c.vx, c.vz) : c.yaw;
      const want = c.yaw + angDiff(c.yaw, velYaw) * 0.35;
      if (this.camSnap) { C.yaw = c.yaw; }
      C.yaw += angDiff(C.yaw, want) * Math.min(1, dt * (spd > 3 ? 5 : 3));
      const yaw = back ? C.yaw + Math.PI : C.yaw, mode = C.mode;
      const dist = [6.2, 9.5, 0, 0.2][mode] + (mode < 2 ? spd * 0.012 : 0), hgt = [2.3, 3.6, 1.15, 0.75][mode] * (mode === 2 ? c.spec.H / 1.4 : 1);
      if (mode < 2) {
        px = c.x - Math.sin(yaw) * dist * (back ? -1 : 1) * (back ? -1 : 1); pz = c.z - Math.cos(yaw) * dist; py = c.y + hgt + c.pitch * -2;
        if (back) { px = c.x + Math.sin(c.yaw) * dist; pz = c.z + Math.cos(c.yaw) * dist; }
        lx = c.x + Math.sin(yaw) * 3 * (back ? -1 : 1); lz = c.z + Math.cos(yaw) * 3 * (back ? -1 : 1); ly = c.y + 1.2;
        if (back) { lx = c.x - Math.sin(c.yaw) * 6; lz = c.z - Math.cos(c.yaw) * 6; }
      } else {
        const f = mode === 2 ? 0.55 : 2.1, sgn = back ? -1 : 1, ay = c.yaw;
        px = c.x + Math.sin(ay) * f * sgn; pz = c.z + Math.cos(ay) * f * sgn; py = c.y + hgt;
        lx = px + Math.sin(ay) * 20 * sgn; lz = pz + Math.cos(ay) * 20 * sgn; ly = py - c.pitch * 8 * sgn + 0.0;
      }
      py = Math.max(py, heightAt(px, pz) + 0.7);
      fov = set.fov + clamp(spd * 0.14, 0, 14) + (c.nitroOn ? 7 : 0) + (mode === 2 ? 6 : 0);
      if (set.shake && this.mode === 'play') {
        const sh = C.shake * 0.35 + (c.nitroOn ? 0.03 : 0) + clamp(spd / 100, 0, 1) * 0.012 + (c.surf !== 0 && c.grounded ? 0.01 * clamp(spd / 40, 0, 1) : 0);
        px += (Math.random() - 0.5) * sh; py += (Math.random() - 0.5) * sh; pz += (Math.random() - 0.5) * sh;
      }
      const k = this.camSnap || mode >= 2 ? 1 : Math.min(1, dt * 14);
      C.pos.x = lerp(C.pos.x, px, k); C.pos.y = lerp(C.pos.y, py, k); C.pos.z = lerp(C.pos.z, pz, k);
      C.look.set(lx, ly, lz); this.camSnap = false;
      px = C.pos.x; py = C.pos.y; pz = C.pos.z;
    }
    cam.position.set(px, py, pz); cam.lookAt(C.look);
    C.fov = damp(C.fov, fov, 6, dt); cam.fov = C.fov; cam.updateProjectionMatrix();
  }
  photoControls(dt) {
    const k = this.keys, p = this.photo;
    if (k.ArrowLeft || k.KeyA) p.yaw += dt * 1.2; if (k.ArrowRight || k.KeyD) p.yaw -= dt * 1.2;
    if (k.ArrowUp || k.KeyW) p.pitch = clamp(p.pitch + dt * 0.8, -0.1, 1.3); if (k.ArrowDown || k.KeyS) p.pitch = clamp(p.pitch - dt * 0.8, -0.1, 1.3);
    if (k.KeyQ) p.dist = clamp(p.dist + dt * 6, 2.5, 40); if (k.KeyE) p.dist = clamp(p.dist - dt * 6, 2.5, 40);
    this.camera.fov = p.fov; this.camera.updateProjectionMatrix();
  }
  emitParticles(dt) {
    const c = this.car, P = this.particles, s = Math.sin(c.yaw), co = Math.cos(c.yaw), pt = this.model;
    const rate = (n) => { const k = n * dt; return Math.floor(k) + (Math.random() < k - Math.floor(k) ? 1 : 0); };
    const rr = (a) => (Math.random() - 0.5) * a;
    if (c.grounded && c.wheelSlip > 0.35 && c.speed > 4) {
      const surf = c.surf, wet = surf === 6;
      const col = wet ? [0.8, 0.9, 1] : surf === 0 ? [0.85, 0.85, 0.87] : surf === 5 ? [0.95, 0.97, 1] : surf === 3 ? [0.88, 0.78, 0.55] : [0.5, 0.4, 0.28];
      const n = rate(40 * c.wheelSlip);
      for (let i = 0; i < n; i++) {
        const side = Math.random() < 0.5 ? -1 : 1, bx = c.x - s * c.L * 0.5 + co * side * c.spec.track * 0.5, bz = c.z - co * c.L * 0.5 - s * side * c.spec.track * 0.5;
        P.emit(bx, c.y + 0.15, bz, c.vx * 0.2 + rr(1.5), 0.6 + Math.random() * 0.9, c.vz * 0.2 + rr(1.5), 0.9 + Math.random() * 0.7, 1.2, 3.2, col[0], col[1], col[2], surf === 0 ? 0.55 : 0.7);
      }
    } else if (c.grounded && c.surf !== 0 && c.speed > 12) {
      const n = rate(c.speed * 0.5);
      const col = c.surf === 6 ? [0.8, 0.9, 1] : c.surf === 5 ? [0.95, 0.97, 1] : c.surf === 3 ? [0.88, 0.78, 0.55] : [0.5, 0.42, 0.3];
      for (let i = 0; i < n; i++) P.emit(c.x - s * c.L * 0.45 + rr(c.spec.track), c.y + 0.2, c.z - co * c.L * 0.45 + rr(c.spec.track), c.vx * 0.15 + rr(1.2), 0.5 + Math.random(), c.vz * 0.15 + rr(1.2), 0.8 + Math.random() * 0.5, 0.9, 2.4, col[0], col[1], col[2], 0.4);
    }
    if (c.nitroOn) {
      const n = rate(60);
      for (let i = 0; i < n; i++) P.emit(c.x - s * (c.L * 0.55) + rr(0.2), c.y + 0.4 + rr(0.1), c.z - co * (c.L * 0.55) + rr(0.2), -s * 7 + c.vx * 0.5 + rr(1), rr(0.6), -co * 7 + c.vz * 0.5 + rr(1), 0.25, 0.7, -1.5, 0.35, 0.65, 1, 0.8);
    }
    if (c.landing > 4 && c.grounded) { for (let i = 0; i < 14; i++) P.emit(c.x + rr(2), c.y + 0.2, c.z + rr(2), rr(5), 1 + Math.random() * 2, rr(5), 1, 1.2, 2.5, 0.8, 0.78, 0.7, 0.6); }
  }
}

const frame = () => new Promise((r) => requestAnimationFrame(r));
const game = new Game();
window.game = game;
game.init().catch((e) => { console.error(e); const f = $('fatal'); f.classList.remove('hidden'); f.innerHTML = '<b>Could not start</b><br><code>' + String(e && e.stack || e).replace(/</g, '&lt;') + '</code><br>Needs a browser with WebGL and an internet connection to load Three.js from the CDN.'; $('loading').classList.add('hidden'); });
