// Streams the endless world around the player as render chunks: terrain, roads, scenery,
// lamps, billboards, towns and ramps. Geometry is merged per chunk to keep draw calls low.
import * as THREE from 'three';
import {
  CH, S, FAM, SURF, world, heightNoRamp, nearRoad, roadOther, roadFrame, intersection, forestDensity,
  dryness, detailNoise, patchNoise, townAt, getRamp,
} from './terrain.js';
import { clamp, lerp, smoothstep, hash2, mulberry32 } from './util.js';

// ---------- colour helpers (palettes are authored in sRGB, vertex colours are linear) ----------
const toLin = (c) => Math.pow(clamp(c, 0, 1), 2.2);
const punch = (c, s = 1.3, b = 1.1) => { const a = (c[0] + c[1] + c[2]) / 3; return [(a + (c[0] - a) * s) * b, (a + (c[1] - a) * s) * b, (a + (c[2] - a) * s) * b]; };
const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mix3 = (a, b, t, o) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; };
const GRASS = { summer: hex(0x3fa627), spring: hex(0x55bd36), autumn: hex(0x9a7a2c), winter: hex(0xe2e6ee) };
const C = {
  sand: hex(0xdcc78f), desert: hex(0xd2ab6b), rock: hex(0x726c66), snow: hex(0xf3f6fb), dirt: hex(0x73543a),
  asphalt: hex(0x5a5c64), gravel: hex(0x8a847a), seabed: hex(0x7f8c76), deep: hex(0x2e4f5c), forest: hex(0x2e7a22),
};

// ---------- merged low-poly geometry builder ----------
export class GeoBuilder {
  constructor(uvs = false) { this.p = []; this.c = []; this.uv = uvs ? [] : null; this.n = 0; }
  v(x, y, z, col, u = 0, vv = 0) {
    this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]);
    if (this.uv) this.uv.push(u, vv);
    this.n++;
  }
  tri(a, b, c, col, uvs) {
    this.v(a[0], a[1], a[2], col, uvs ? uvs[0] : 0, uvs ? uvs[1] : 0);
    this.v(b[0], b[1], b[2], col, uvs ? uvs[2] : 0, uvs ? uvs[3] : 0);
    this.v(c[0], c[1], c[2], col, uvs ? uvs[4] : 0, uvs ? uvs[5] : 0);
  }
  quad(a, b, c, d, col, uvs) { // a,b,c,d in order around the face
    this.tri(a, b, c, col, uvs ? [uvs[0], uvs[1], uvs[2], uvs[3], uvs[4], uvs[5]] : null);
    this.tri(a, c, d, col, uvs ? [uvs[0], uvs[1], uvs[4], uvs[5], uvs[6], uvs[7]] : null);
  }
  // box with y-rotation; (cx,cy,cz) = centre of the bottom face
  box(cx, cy, cz, sx, sy, sz, yaw, col, win = 0) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const hx = sx / 2, hz = sz / 2;
    const P = (lx, ly, lz) => [cx + lx * cs + lz * sn, cy + ly, cz - lx * sn + lz * cs];
    const b0 = P(-hx, 0, -hz), b1 = P(hx, 0, -hz), b2 = P(hx, 0, hz), b3 = P(-hx, 0, hz);
    const t0 = P(-hx, sy, -hz), t1 = P(hx, sy, -hz), t2 = P(hx, sy, hz), t3 = P(-hx, sy, hz);
    if (win) { // window-textured sides (u across, v up)
      const uw = sx / 12.8, ud = sz / 12.8, vh = sy / 13.6, v0 = (cy % 13.6) / 13.6;
      this.quad(b0, b1, t1, t0, col, [0, v0, uw, v0, uw, v0 + vh, 0, v0 + vh]);
      this.quad(b1, b2, t2, t1, col, [0, v0, ud, v0, ud, v0 + vh, 0, v0 + vh]);
      this.quad(b2, b3, t3, t2, col, [0, v0, uw, v0, uw, v0 + vh, 0, v0 + vh]);
      this.quad(b3, b0, t0, t3, col, [0, v0, ud, v0, ud, v0 + vh, 0, v0 + vh]);
      const r = [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02];
      this.quad(t0, t1, t2, t3, col, r);
    } else {
      this.quad(b0, b1, t1, t0, col); this.quad(b1, b2, t2, t1, col);
      this.quad(b2, b3, t3, t2, col); this.quad(b3, b0, t0, t3, col);
      this.quad(t0, t1, t2, t3, col);
    }
  }
  cone(cx, cy, cz, r, h, seg, col, colTop) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * 6.2832, a1 = ((i + 1) / seg) * 6.2832;
      this.v(cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r, col);
      this.v(cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r, col);
      this.v(cx, cy + h, cz, colTop || col);
    }
  }
  cyl(cx, cy, cz, r0, r1, h, seg, col) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * 6.2832, a1 = ((i + 1) / seg) * 6.2832;
      const p0 = [cx + Math.cos(a0) * r0, cy, cz + Math.sin(a0) * r0], p1 = [cx + Math.cos(a1) * r0, cy, cz + Math.sin(a1) * r0];
      const q0 = [cx + Math.cos(a0) * r1, cy + h, cz + Math.sin(a0) * r1], q1 = [cx + Math.cos(a1) * r1, cy + h, cz + Math.sin(a1) * r1];
      this.quad(p0, p1, q1, q0, col);
      this.tri(q0, q1, [cx, cy + h, cz], col);
    }
  }
  sphere(cx, cy, cz, r, seg, col, colTop, sy = 1) {
    const rings = Math.max(3, seg >> 1);
    for (let j = 0; j < rings; j++) {
      const t0 = (j / rings) * Math.PI, t1 = ((j + 1) / rings) * Math.PI;
      const y0 = Math.cos(t0) * r * sy, y1 = Math.cos(t1) * r * sy, r0 = Math.sin(t0) * r, r1 = Math.sin(t1) * r;
      const cc = j < rings / 2 && colTop ? colTop : col;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * 6.2832, a1 = ((i + 1) / seg) * 6.2832;
        const A = [cx + Math.cos(a0) * r0, cy + y0, cz + Math.sin(a0) * r0], B = [cx + Math.cos(a1) * r0, cy + y0, cz + Math.sin(a1) * r0];
        const Cc = [cx + Math.cos(a1) * r1, cy + y1, cz + Math.sin(a1) * r1], D = [cx + Math.cos(a0) * r1, cy + y1, cz + Math.sin(a0) * r1];
        if (j === 0) this.tri(A, Cc, D, cc); else if (j === rings - 1) this.tri(A, B, Cc, cc); else this.quad(A, B, Cc, D, cc);
      }
    }
  }
  rock(cx, cy, cz, r, col, rnd) {
    const k = () => 0.75 + rnd() * 0.5;
    const T = [cx, cy + r * 0.95 * k(), cz], Bt = [cx, cy - r * 0.3, cz];
    const X0 = [cx - r * k(), cy + r * 0.15, cz], X1 = [cx + r * k(), cy + r * 0.15, cz];
    const Z0 = [cx, cy + r * 0.15, cz - r * k()], Z1 = [cx, cy + r * 0.15, cz + r * k()];
    const dk = [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8];
    this.tri(T, X1, Z1, col); this.tri(T, Z1, X0, col); this.tri(T, X0, Z0, col); this.tri(T, Z0, X1, col);
    this.tri(Bt, Z1, X1, dk); this.tri(Bt, X0, Z1, dk); this.tri(Bt, Z0, X0, dk); this.tri(Bt, X1, Z0, dk);
  }
  build() {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(this.p);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    if (this.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.computeVertexNormals();
    return g;
  }
}

// ---------- canvas textures ----------
function canvasTex(w, h, draw, repeat = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function noiseFill(ctx, w, h, base, amp, count) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const g = Math.floor(128 + (Math.random() - 0.5) * amp * 255);
    ctx.fillStyle = `rgba(${g},${g},${g},0.18)`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}
export const BOARD_TEXTS = ['SHIP IT!', 'git commit -m "vibes"', 'PAGES FM 101.1', 'MERGE EARLY, MERGE OFTEN', 'HORIZON PAGES FESTIVAL', '404: SPEED LIMIT NOT FOUND', 'BUILD PASSING', 'FORK ME ON GITHUB', 'RESOLVING CONFLICTS...', 'LGTM'];
export function makeSignTex(text, bg = '#0d1117', fg = '#e6edf3', accent = '#2ea043') {
  return canvasTex(512, 192, (ctx, w, h) => {
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = accent; ctx.fillRect(0, 0, w, 14); ctx.fillRect(0, h - 14, w, 14);
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let size = 64; ctx.font = `bold ${size}px system-ui, sans-serif`;
    while (ctx.measureText(text).width > w - 40 && size > 18) { size -= 4; ctx.font = `bold ${size}px system-ui, sans-serif`; }
    ctx.fillText(text, w / 2, h / 2 + 4);
  }, false);
}

export function makeMaterials() {
  const grain = canvasTex(256, 256, (c, w, h) => noiseFill(c, w, h, '#d8d8d8', 0.35, 5000));
  const loadImg = (n, cb) => { const im = new Image(); im.onload = () => cb(im); im.src = 'assets/tex/' + n; };
  const photoTex = (n) => { const t = new THREE.TextureLoader().load('assets/tex/' + n); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const drawRoad = (c, w, h, img) => {
    if (img) { c.globalCompositeOperation = 'source-over'; c.fillStyle = '#000'; c.fillRect(0, 0, w, h); c.globalCompositeOperation = 'lighter'; for (let i = 0; i < 3; i++) c.drawImage(img, 0, 0, w, h); c.globalCompositeOperation = 'source-over'; }
    else noiseFill(c, w, h, '#6d7078', 0.22, 4500);
    const k = w / 128;
    c.fillStyle = '#e8e8e8'; c.fillRect(5 * k, 0, 4 * k, h); c.fillRect(w - 9 * k, 0, 4 * k, h);
    c.fillStyle = '#e3b72b'; c.fillRect(w / 2 - 5 * k, 0, 3 * k, h); c.fillRect(w / 2 + 2 * k, 0, 3 * k, h);
    c.fillStyle = '#d8d8d8';
    for (let y = 0; y < h; y += h / 2) { c.fillRect(w * 0.25 - 1.5 * k, y, 3 * k, h / 4); c.fillRect(w * 0.75 - 1.5 * k, y, 3 * k, h / 4); }
  };
  const road = canvasTex(256, 512, (c, w, h) => drawRoad(c, w, h, null));
  const plain = canvasTex(256, 256, (c, w, h) => noiseFill(c, w, h, '#6d7078', 0.22, 2500));
  const drawDirt = (c, w, h, img) => {
    if (img) { c.fillStyle = '#000'; c.fillRect(0, 0, w, h); c.globalCompositeOperation = 'lighter'; for (let i = 0; i < 2; i++) c.drawImage(img, 0, 0, w, h); c.globalCompositeOperation = 'source-over'; }
    else noiseFill(c, w, h, '#7a5b3a', 0.35, 4000);
    c.fillStyle = 'rgba(40,26,14,0.35)'; c.fillRect(w * 0.26, 0, w * 0.12, h); c.fillRect(w * 0.62, 0, w * 0.12, h);
  };
  const dirt = canvasTex(256, 256, (c, w, h) => drawDirt(c, w, h, null));
  loadImg('asphalt.jpg', (im) => {
    drawRoad(road.image.getContext('2d'), 256, 512, im); road.needsUpdate = true;
    const pc = plain.image.getContext('2d'); pc.fillStyle = '#000'; pc.fillRect(0, 0, 256, 256); pc.globalCompositeOperation = 'lighter'; for (let i = 0; i < 3; i++) pc.drawImage(im, 0, 0, 256, 256); pc.globalCompositeOperation = 'source-over'; plain.needsUpdate = true;
  });
  loadImg('dirt.jpg', (im) => { drawDirt(dirt.image.getContext('2d'), 256, 256, im); dirt.needsUpdate = true; });
  const tGrass = photoTex('grass.jpg'), tDirt = photoTex('dirt.jpg'), tSand = photoTex('sand.jpg'), tAsph = photoTex('asphalt.jpg');
  const wall = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#cfd4da'; c.fillRect(0, 0, w, h);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { c.fillStyle = '#34465c'; c.fillRect(i * 64 + 14, j * 64 + 12, 36, 38); }
  });
  const rnd = mulberry32(99);
  const lit = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (rnd() < 0.62) { c.fillStyle = rnd() < 0.7 ? '#ffd58a' : '#bfe3ff'; c.fillRect(i * 64 + 14, j * 64 + 12, 36, 38); }
  });
  const mats = {
    terrain: (() => {
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: grain, roughness: 0.96, metalness: 0, side: THREE.DoubleSide });
      m.onBeforeCompile = (sh) => {
        sh.uniforms.tGrass = { value: tGrass }; sh.uniforms.tDirt = { value: tDirt }; sh.uniforms.tSand = { value: tSand }; sh.uniforms.tAsph = { value: tAsph };
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 splat; varying vec4 vSplat;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vSplat; uniform sampler2D tGrass; uniform sampler2D tDirt; uniform sampler2D tSand; uniform sampler2D tAsph;')
          .replace('#include <map_fragment>', `#include <map_fragment>
          vec2 sp = vMapUv;
          vec3 g1 = texture2D(tGrass, sp * 0.55).rgb * 0.6 + texture2D(tGrass, sp * 0.13 + 0.37).rgb * 0.4;
          vec3 d1 = texture2D(tDirt, sp * 0.5).rgb * 0.6 + texture2D(tDirt, sp * 0.11 + 0.21).rgb * 0.4;
          vec3 s1 = texture2D(tSand, sp * 0.4).rgb * 0.6 + texture2D(tSand, sp * 0.09 + 0.55).rgb * 0.4;
          vec3 a1 = texture2D(tAsph, sp * 0.6).rgb;
          vec3 dG = mix(vec3(1.0), clamp(g1 / vec3(0.195, 0.209, 0.076), 0.35, 2.4), 0.85);
          vec3 dD = mix(vec3(1.0), clamp(d1 / vec3(0.065, 0.045, 0.035), 0.35, 2.4), 0.85);
          vec3 dS = mix(vec3(1.0), clamp(s1 / vec3(0.684, 0.523, 0.279), 0.5, 1.8), 0.8);
          vec3 dA = mix(vec3(1.0), clamp(a1 / vec3(0.0196, 0.0186, 0.0165), 0.35, 2.4), 0.8);
          float ws = clamp(1.0 - vSplat.x - vSplat.y - vSplat.z - vSplat.w, 0.0, 1.0);
          diffuseColor.rgb *= dG * vSplat.x + dD * vSplat.y + dS * vSplat.z + dA * vSplat.w + vec3(ws);`);
      };
      return m;
    })(),
    road: new THREE.MeshStandardMaterial({ map: road, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    plain: new THREE.MeshStandardMaterial({ map: plain, roughness: 0.88, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    dirt: new THREE.MeshStandardMaterial({ map: dirt, roughness: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    scenery: new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 0.9, metalness: 0 }),
    lampPole: new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 0.6, metalness: 0.3 }),
    lampHead: new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: 0xffd88a, emissiveIntensity: 0, roughness: 0.4 }),
    bldg: new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, vertexColors: true, map: wall, emissiveMap: lit, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.75, metalness: 0.1 }),
    board: [], grain,
  };
  mats.roadBase = [mats.road, mats.plain, mats.dirt];
  return mats;
}

const seasonTree = {
  summer: { pine: hex(0x1f5a2b), oak: [hex(0x3b8a2a), hex(0x2f7a22), hex(0x4a9a30)] },
  spring: { pine: hex(0x2a6a34), oak: [hex(0xf1a8c4), hex(0xe58db0), hex(0x7cc04a)] },
  autumn: { pine: hex(0x28532a), oak: [hex(0xd9742a), hex(0xc43d1d), hex(0xe6b422)] },
  winter: { pine: hex(0xcfe0e6), oak: [hex(0x8b7d72), hex(0x9a8f86), hex(0xb9b0aa)] },
};
const TRUNK = hex(0x4e3624);

export class ChunkManager {
  constructor(scene, mats) {
    this.scene = scene; this.mats = mats; this.map = new Map();
    this.radius = 5; this.perFrame = 1; this.treeDensity = 1; this.stats = { chunks: 0 };
    this.billboardTex = BOARD_TEXTS.map((t) => makeSignTex(t));
    this.boardMats = this.billboardTex.map((t) => new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.0, roughness: 0.6, side: THREE.DoubleSide }));
    this.poleMat = new THREE.MeshStandardMaterial({ color: 0x555a63, roughness: 0.7, metalness: 0.4 });
    this.planeGeo = new THREE.PlaneGeometry(12, 4.5);
    this.poleGeo = new THREE.BoxGeometry(0.5, 7, 0.5);
    this.idxCache = new Map();
    this.q = { circles: [], boxes: [] };
    this.extra = { circles: [], boxes: [] }; // colliders owned by permanent landmarks (festival, repo town)
  }
  setQuality(radius, perFrame, treeDensity) { this.radius = radius; this.perFrame = perFrame; this.treeDensity = treeDensity; }
  flush() { for (const ch of [...this.map.values()]) this.dispose(ch); this.map.clear(); }
  dispose(ch) {
    this.scene.remove(ch.group);
    ch.group.traverse((o) => { if (o.isMesh && o.geometry && !o.userData.shared) o.geometry.dispose(); });
    this.map.delete(ch.key);
  }
  setNight(n) {
    this.mats.lampHead.emissiveIntensity = n * 2.2;
    this.mats.bldg.emissiveIntensity = n * 1.1;
    for (const m of this.boardMats) m.emissiveIntensity = n * 0.8;
  }

  update(px, pz, force = false) {
    const ccx = Math.floor(px / CH), ccz = Math.floor(pz / CH), R = this.radius;
    const need = [];
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const d = dx * dx + dz * dz;
      if (d > R * R + 1) continue;
      need.push({ cx: ccx + dx, cz: ccz + dz, d, lod: Math.max(Math.abs(dx), Math.abs(dz)) <= 2 ? 0 : 1 });
    }
    need.sort((a, b) => a.d - b.d);
    let budget = force ? 1e9 : this.perFrame;
    for (const n of need) {
      if (budget <= 0) break;
      const key = n.cx + ',' + n.cz;
      const ch = this.map.get(key);
      if (!ch) { this.build(n.cx, n.cz, n.lod); budget--; }
      else if (ch.lod !== n.lod) { this.dispose(ch); this.build(n.cx, n.cz, n.lod); budget--; }
    }
    for (const ch of [...this.map.values()]) {
      if (Math.abs(ch.cx - ccx) > R + 1 || Math.abs(ch.cz - ccz) > R + 1) this.dispose(ch);
    }
    this.stats.chunks = this.map.size;
  }

  getIndex(segs) {
    if (this.idxCache.has(segs)) return this.idxCache.get(segs);
    const n = segs + 1, idx = [];
    for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    this.idxCache.set(segs, idx);
    return idx;
  }

  build(cx, cz, lod) {
    const ox = cx * CH, oz = cz * CH;
    const group = new THREE.Group();
    group.position.set(ox, 0, oz);
    const ch = { key: cx + ',' + cz, cx, cz, lod, group, circles: [], boxes: [] };
    const segs = lod === 0 ? 32 : 16;
    this.buildTerrain(ch, ox, oz, segs);
    this.buildRoads(ch, ox, oz);
    this.buildScenery(ch, ox, oz, lod);
    this.buildTown(ch, ox, oz);
    this.buildRamps(ch, ox, oz);
    this.scene.add(group);
    this.map.set(ch.key, ch);
    return ch;
  }

  buildTerrain(ch, ox, oz, segs) {
    const n = segs + 1, step = CH / segs, W = n + 2;
    const H = new Float32Array(W * W);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) H[j * W + i] = heightNoRamp(ox + (i - 1) * step, oz + (j - 1) * step);
    const skirt = 4 * segs * 2 + 8;
    const total = n * n + skirt;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3), uv = new Float32Array(total * 2), spl = new Float32Array(total * 4);
    const tmp = [0, 0, 0], tmp2 = [0, 0, 0], tmp3 = [0, 0, 0], season = world.season;
    const grassC = GRASS[season] || GRASS.summer;
    const nr = { edge: 0, fam: 0 };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, hh = H[(j + 1) * W + (i + 1)];
      const x = ox + i * step, z = oz + j * step;
      const gx = (H[(j + 1) * W + i] - H[(j + 1) * W + i + 2]) / (2 * step);
      const gz = (H[j * W + i + 1] - H[(j + 2) * W + i + 1]) / (2 * step);
      const il = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      pos[k * 3] = i * step; pos[k * 3 + 1] = hh; pos[k * 3 + 2] = j * step;
      nor[k * 3] = gx * il; nor[k * 3 + 1] = il; nor[k * 3 + 2] = gz * il;
      uv[k * 2] = x / 7; uv[k * 2 + 1] = z / 7;
      // colour
      nearRoad(x, z, nr);
      let c;
      const dn = detailNoise(x, z), pn = patchNoise(x, z);
      let sg = 0, sd = 0, ss = 0, sa = 0;
      if (nr.edge < 0.9) { c = FAM[nr.fam].dirt ? C.dirt : C.asphalt; if (FAM[nr.fam].dirt) sd = 1; else sa = 1; }
      else if (nr.edge < 3.2 && !FAM[nr.fam].dirt) { const q = smoothstep(0.9, 2.2, nr.edge); c = mix3(C.asphalt, C.gravel, q, tmp); sa = 1 - q; sd = q; }
      else if (hh < -0.35) { c = mix3(C.seabed, C.deep, clamp(-hh / 10, 0, 1), tmp); ss = 1; }
      else {
        const dry = dryness(x, z);
        const forest = forestDensity(x, z);
        mix3(grassC, C.forest, season === 'winter' ? 0 : clamp(forest * 0.55, 0, 0.55), tmp);
        if (season !== 'winter') { tmp[0] *= 1 + pn * 0.18; tmp[1] *= 1 + pn * 0.14; }
        c = mix3(tmp, C.desert, smoothstep(0.52, 0.72, dry), tmp2);
        c = mix3(c, C.sand, 1 - smoothstep(0.6, 2.2, hh), tmp3);
        c = mix3(c, C.rock, Math.max(smoothstep(66, 92, hh), smoothstep(0.82, 0.66, il)), tmp2);
        c = mix3(c, C.snow, smoothstep(98, 122, hh) * (il > 0.7 ? 1 : 0.4), tmp3);
        ss = Math.max(smoothstep(0.52, 0.72, dry), 1 - smoothstep(0.6, 2.2, hh));
        const rk = Math.max(smoothstep(66, 92, hh), smoothstep(0.82, 0.66, il));
        sg = (1 - ss) * (1 - rk) * (season === 'winter' ? 0.2 : 1);
      }
      spl[k * 4] = sg; spl[k * 4 + 1] = sd; spl[k * 4 + 2] = ss * (hh < -0.35 ? 1 : 0.85); spl[k * 4 + 3] = sa;
      const br = 0.94 + dn * 0.06;
      const pc = punch(c); col[k * 3] = toLin(pc[0] * br); col[k * 3 + 1] = toLin(pc[1] * br); col[k * 3 + 2] = toLin(pc[2] * br);
    }
    // skirts hide cracks between LODs
    let s = n * n;
    const addSkirt = (ia, ib) => {
      for (const idx of [ia, ib]) {
        pos[s * 3] = pos[idx * 3]; pos[s * 3 + 1] = pos[idx * 3 + 1] - 7; pos[s * 3 + 2] = pos[idx * 3 + 2];
        nor[s * 3] = nor[idx * 3]; nor[s * 3 + 1] = nor[idx * 3 + 1]; nor[s * 3 + 2] = nor[idx * 3 + 2];
        col[s * 3] = col[idx * 3]; col[s * 3 + 1] = col[idx * 3 + 1]; col[s * 3 + 2] = col[idx * 3 + 2];
        uv[s * 2] = uv[idx * 2]; uv[s * 2 + 1] = uv[idx * 2 + 1];
        for (let q = 0; q < 4; q++) spl[s * 4 + q] = spl[idx * 4 + q];
        s++;
      }
    };
    const idx = this.getIndex(segs).slice();
    const edges = [];
    for (let i = 0; i < segs; i++) {
      edges.push([i, i + 1]); // j = 0
      edges.push([segs * n + i, segs * n + i + 1]); // j = segs
      edges.push([i * n, (i + 1) * n]); // i = 0
      edges.push([i * n + segs, (i + 1) * n + segs]); // i = segs
    }
    for (const [a, b] of edges) {
      const base = s; addSkirt(a, b);
      idx.push(a, b, base, b, base + 1, base);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.mats.terrain);
    m.receiveShadow = true;
    ch.group.add(m);
  }

  buildRoads(ch, ox, oz) {
    const paved = { p: [], uv: [], i: [] }, dirt = { p: [], uv: [], i: [] };
    const plainP = { p: [], uv: [], i: [] };
    const fr = {};
    const lampPoles = new GeoBuilder(), lampHeads = new GeoBuilder();
    const steel = hex(0x6b727c), headc = [1, 0.95, 0.8];
    for (let f = 0; f < 4; f++) {
      const F = FAM[f];
      const t0 = F.axis === 0 ? ox : oz;
      const crossLo = F.axis === 0 ? oz : ox;
      const i0 = Math.floor((crossLo - F.off - F.amp * 1.3 - 24) / S), i1 = Math.ceil((crossLo + CH - F.off + F.amp * 1.3 + 24) / S);
      for (let i = i0; i <= i1; i++) {
        let lo = 1e9, hi = -1e9;
        const pts = [];
        for (let k = 0; k <= 32; k++) {
          const t = t0 + k * 4;
          roadFrame(f, i, t, fr);
          pts.push({ x: fr.x, z: fr.z, nx: fr.nx, nz: fr.nz, t });
          const cr = F.axis === 0 ? fr.z : fr.x;
          if (cr < lo) lo = cr; if (cr > hi) hi = cr;
        }
        if (hi < crossLo - 14 || lo > crossLo + CH + 14) continue;
        const tgt = F.dirt ? dirt : paved;
        const base = tgt.p.length / 3;
        const w = F.w + (F.dirt ? 0.4 : 0.15), yoff = F.dirt ? 0.05 : 0.08;
        for (let k = 0; k < pts.length; k++) {
          const P = pts[k];
          const lx = P.x + P.nx * w, lz = P.z + P.nz * w, rx = P.x - P.nx * w, rz = P.z - P.nz * w;
          tgt.p.push(lx - ox, heightNoRamp(lx, lz) + yoff, lz - oz, rx - ox, heightNoRamp(rx, rz) + yoff, rz - oz);
          tgt.uv.push(0, P.t / 16, 1, P.t / 16);
          if (k < pts.length - 1) { const a = base + k * 2; tgt.i.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
        }
        // street lamps along paved roads (aligned to a global 44 m grid)
        if (!F.dirt) {
          const first = Math.ceil(t0 / 44) * 44;
          for (let t = first; t < t0 + CH; t += 44) {
            roadFrame(f, i, t, fr);
            const side = (Math.floor(t / 44) & 1) ? 1 : -1;
            const lx = fr.x + fr.nx * side * (F.w + 2.6), lz = fr.z + fr.nz * side * (F.w + 2.6);
            const e = nearRoad(lx, lz).edge;
            if (e > 6) continue;
            const hy = heightNoRamp(lx, lz);
            const toRoad = Math.atan2(-fr.nx * side, -fr.nz * side);
            lampPoles.box(lx - ox, hy, lz - oz, 0.22, 7.6, 0.22, toRoad, steel);
            const ax = lx + Math.sin(toRoad) * 1.5, az = lz + Math.cos(toRoad) * 1.5;
            lampPoles.box(ax - ox, hy + 7.4, az - oz, 0.14, 0.14, 3.0, toRoad, steel);
            const hx = lx + Math.sin(toRoad) * 2.6, hz = lz + Math.cos(toRoad) * 2.6;
            lampHeads.box(hx - ox, hy + 7.25, hz - oz, 0.6, 0.18, 1.0, toRoad, headc);
            ch.circles.push([lx, lz, 0.45]);
          }
        }
      }
    }
    const mk = (d, mat, shadow = true) => {
      if (!d.p.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(d.p), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(d.uv), 2));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(d.i), 1));
      g.computeVertexNormals();
      for (let q = 1; q < g.attributes.normal.array.length; q += 3) g.attributes.normal.array[q] = Math.abs(g.attributes.normal.array[q]);
      const m = new THREE.Mesh(g, mat); m.receiveShadow = shadow; ch.group.add(m);
    };
    mk(dirt, this.mats.dirt);
    mk(paved, this.mats.road);
    // intersection discs (paved x paved) owned by the chunk containing their centre
    const rxLo = Math.floor((ox - 100) / S) - 1, rxHi = Math.ceil((ox + CH + 100) / S) + 1;
    const rzLo = Math.floor((oz - 100) / S) - 1, rzHi = Math.ceil((oz + CH + 100) / S) + 1;
    const ip = { x: 0, z: 0 };
    for (let rz = rzLo; rz <= rzHi; rz++) for (let rx = rxLo; rx <= rxHi; rx++) {
      intersection(0, rz, 1, rx, ip);
      if (ip.x < ox || ip.x >= ox + CH || ip.z < oz || ip.z >= oz + CH) continue;
      const R = 13.5, segs = 20, base = plainP.p.length / 3;
      plainP.p.push(ip.x - ox, heightNoRamp(ip.x, ip.z) + 0.11, ip.z - oz); plainP.uv.push(0.5, 0.5);
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * 6.2832, px = ip.x + Math.cos(a) * R, pz = ip.z + Math.sin(a) * R;
        plainP.p.push(px - ox, heightNoRamp(px, pz) + 0.11, pz - oz); plainP.uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
      }
      for (let k = 0; k < segs; k++) plainP.i.push(base, base + 1 + k, base + 1 + ((k + 1) % segs));
    }
    mk(plainP, this.mats.plain);
    if (lampPoles.n) { const m = new THREE.Mesh(lampPoles.build(), this.mats.lampPole); m.castShadow = true; ch.group.add(m); }
    if (lampHeads.n) { const m = new THREE.Mesh(lampHeads.build(), this.mats.lampHead); ch.group.add(m); }
    // billboards beside paved roads
    if (hash2(ch.cx, ch.cz, world.seed + 31) < 0.3) {
      const f = hash2(ch.cx, ch.cz, world.seed + 32) < 0.5 ? 0 : 1, F = FAM[f];
      const t0 = F.axis === 0 ? ox : oz, cross = F.axis === 0 ? oz : ox;
      const i = Math.round((cross + CH / 2 - F.off) / S);
      roadFrame(f, i, t0 + CH / 2, fr);
      const side = hash2(ch.cx, ch.cz, world.seed + 33) < 0.5 ? 1 : -1;
      const bx = fr.x + fr.nx * side * (F.w + 12), bz = fr.z + fr.nz * side * (F.w + 12);
      if (bx >= ox && bx < ox + CH && bz >= oz && bz < oz + CH && nearRoad(bx, bz).edge > 6) {
        const hy = heightNoRamp(bx, bz);
        const face = Math.atan2(-fr.nx * side, -fr.nz * side);
        const tex = Math.floor(hash2(ch.cx, ch.cz, world.seed + 34) * this.boardMats.length);
        const mesh = new THREE.Mesh(this.planeGeo, this.boardMats[tex]);
        mesh.position.set(bx - ox, hy + 8.5, bz - oz); mesh.rotation.y = face; mesh.userData.shared = true;
        const cs = Math.cos(face), sn = Math.sin(face);
        for (const s of [-4.2, 4.2]) {
          const pole = new THREE.Mesh(this.poleGeo, this.poleMat);
          pole.position.set(bx - ox + s * cs, hy + 3.5, bz - oz - s * sn); pole.userData.shared = true;
          ch.group.add(pole); pole.castShadow = true;
          ch.circles.push([bx + s * cs, bz - s * sn, 0.6]);
        }
        ch.group.add(mesh);
      }
    }
  }

  buildScenery(ch, ox, oz, lod) {
    const seed = world.seed, season = world.season, T = seasonTree[season] || seasonTree.summer;
    const trees = new GeoBuilder(), rocks = new GeoBuilder();
    const cell = CH / 12, rnd = mulberry32(hash2(ch.cx, ch.cz, seed + 40) * 4294967296);
    const dens = this.treeDensity;
    let count = 0;
    for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) {
      const gi = ch.cx * 12 + i, gj = ch.cz * 12 + j;
      if (lod === 1 && ((gi + gj) & 1)) continue;
      const r1 = hash2(gi, gj, seed + 21), r2 = hash2(gi, gj, seed + 22), r3 = hash2(gi, gj, seed + 23), r4 = hash2(gi, gj, seed + 24);
      const x = ox + (i + 0.15 + r2 * 0.7) * cell, z = oz + (j + 0.15 + r3 * 0.7) * cell;
      const forest = forestDensity(x, z);
      const dry = dryness(x, z);
      const isDesert = dry > 0.22;
      const prob = (isDesert ? 0.06 : forest * 0.62) * dens;
      const rockP = isDesert ? 0.07 : 0.05;
      if (r1 > prob + rockP) continue;
      const h = heightNoRamp(x, z);
      if (h < 2.2 || h > 100) continue;
      const nr = nearRoad(x, z);
      if (nr.edge < (FAM[nr.fam].dirt ? 3 : 7)) continue;
      const hx = heightNoRamp(x + 2, z), hz = heightNoRamp(x, z + 2);
      if (Math.hypot(hx - h, hz - h) / 2 > 0.65) continue;
      const lx = x - ox, lz = z - oz;
      if (r1 > prob) { // rock
        const sz = 0.8 + r4 * 2.2;
        rocks.rock(lx, h, lz, sz, mix3(C.rock, C.sand, isDesert ? 0.5 : 0, [0, 0, 0]).map((q) => toLin(q * (0.85 + r4 * 0.3))), rnd);
        if (sz > 1.4) ch.circles.push([x, z, sz * 0.8]);
        continue;
      }
      if (++count > 90) continue;
      const sc = 0.8 + r4 * 0.9;
      const lin = (c, k = 1) => { const p = punch(c, 1.25, 1.08); return [toLin(p[0] * k), toLin(p[1] * k), toLin(p[2] * k)]; };
      if (isDesert) {
        const cc = lin(hex(0x4f8a4a), 0.9 + r4 * 0.2);
        trees.cyl(lx, h, lz, 0.32 * sc, 0.28 * sc, 2.8 * sc, 6, cc);
        trees.box(lx + 0.5 * sc, h + 1.2 * sc, lz, 0.9 * sc, 0.25 * sc, 0.25 * sc, 0, cc);
        trees.cyl(lx + 0.9 * sc, h + 1.2 * sc, lz, 0.2 * sc, 0.18 * sc, 1.1 * sc, 5, cc);
        ch.circles.push([x, z, 0.5]);
      } else if (h < 7 && r4 > 0.5) { // palm
        const tc = lin(hex(0x8a6a44));
        trees.cyl(lx, h, lz, 0.28 * sc, 0.2 * sc, 5.5 * sc, 5, tc);
        for (let f = 0; f < 6; f++) {
          const a = (f / 6) * 6.2832 + r2 * 6;
          const L = 3.2 * sc, tip = [lx + Math.cos(a) * L, h + 5.2 * sc, lz + Math.sin(a) * L];
          const side = [Math.cos(a + 1.57) * 0.5, 0, Math.sin(a + 1.57) * 0.5];
          trees.tri([lx + side[0], h + 5.7 * sc, lz + side[2]], [lx - side[0], h + 5.7 * sc, lz - side[2]], tip, lin(hex(0x3d8f3a)));
          trees.tri([lx - side[0], h + 5.7 * sc, lz - side[2]], [lx + side[0], h + 5.7 * sc, lz + side[2]], tip, lin(hex(0x3d8f3a)));
        }
        ch.circles.push([x, z, 0.4]);
      } else if (h > 58 || r4 < 0.5) { // pine
        const k = 0.85 + (r1 * 7 % 1) * 0.3;
        const pc = lin(T.pine, k), top = lin(T.pine, k * 1.15);
        trees.cyl(lx, h, lz, 0.28 * sc, 0.22 * sc, 1.8 * sc, 5, lin(TRUNK));
        trees.cone(lx, h + 1.2 * sc, lz, 1.9 * sc, 3.2 * sc, 7, pc, top);
        trees.cone(lx, h + 3.0 * sc, lz, 1.45 * sc, 2.9 * sc, 7, pc, top);
        trees.cone(lx, h + 4.6 * sc, lz, 0.95 * sc, 2.6 * sc, 7, pc, top);
        ch.circles.push([x, z, 0.5]);
      } else { // broadleaf
        const col = T.oak[Math.floor(r4 * 7.7) % 3];
        const k = 0.9 + (r1 * 9 % 1) * 0.2;
        trees.cyl(lx, h, lz, 0.34 * sc, 0.26 * sc, 2.6 * sc, 5, lin(TRUNK));
        trees.sphere(lx, h + 3.9 * sc, lz, 2.3 * sc, 6, lin(col, k), lin(col, k * 1.18), 0.9);
        trees.sphere(lx + 0.9 * sc, h + 3.2 * sc, lz + 0.5 * sc, 1.5 * sc, 5, lin(col, k * 0.92));
        ch.circles.push([x, z, 0.55]);
      }
    }
    if (trees.n) { const m = new THREE.Mesh(trees.build(), this.mats.scenery); m.castShadow = lod === 0; ch.group.add(m); }
    if (rocks.n) { const m = new THREE.Mesh(rocks.build(), this.mats.scenery); m.castShadow = lod === 0; ch.group.add(m); }
  }

  buildTown(ch, ox, oz) {
    // towns sit at road intersections; any chunk within ~170 m of one draws its buildings
    const rxLo = Math.floor((ox - 260) / S) - 1, rxHi = Math.ceil((ox + CH + 260) / S) + 1;
    const rzLo = Math.floor((oz - 260) / S) - 1, rzHi = Math.ceil((oz + CH + 260) / S) + 1;
    const bg = new GeoBuilder(true);
    for (let rz = rzLo; rz <= rzHi; rz++) for (let rx = rxLo; rx <= rxHi; rx++) {
      const town = townAt(rx, rz);
      if (!town) continue;
      if (town.x < ox - 260 || town.x > ox + CH + 260 || town.z < oz - 260 || town.z > oz + CH + 260) continue;
      const rnd = mulberry32(town.seed);
      for (let gz = -6; gz <= 6; gz++) for (let gx = -6; gx <= 6; gx++) {
        const r0 = rnd(), r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd();
        const dd = Math.hypot(gx, gz);
        if (dd < 1.2 || dd > 6.4 || r0 < 0.1) continue;
        const bx = town.x + gx * 34 + (r1 - 0.5) * 8, bz = town.z + gz * 34 + (r2 - 0.5) * 12;
        if (bx < ox || bx >= ox + CH || bz < oz || bz >= oz + CH) continue;
        const w = 12 + r3 * 12, d = 12 + r4 * 12, hgt = (7 + r0 * 16 + Math.max(0, 6 - dd) * (6 + r1 * 12)) * (0.7 + r2 * 0.6);
        const edge = Math.min(nearRoad(bx - w * 0.6, bz - d * 0.6).edge, nearRoad(bx + w * 0.6, bz + d * 0.6).edge, nearRoad(bx - w * 0.6, bz + d * 0.6).edge, nearRoad(bx + w * 0.6, bz - d * 0.6).edge, nearRoad(bx, bz).edge);
        if (edge < 7) continue;
        let lo = 1e9, hi = -1e9;
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
          const hh = heightNoRamp(bx + sx * w / 2, bz + sz * d / 2); lo = Math.min(lo, hh); hi = Math.max(hi, hh);
        }
        if (hi - lo > 4.5 || lo < 1.5) continue;
        const tint = [[0.96, 0.96, 0.98], [1, 0.94, 0.86], [0.88, 0.92, 1], [0.95, 1, 0.92], [1, 0.9, 0.9]][Math.floor(r1 * 4.99)];
        const lc = tint.map((q) => toLin(q * (0.8 + r2 * 0.2)));
        bg.box(bx - ox, lo - 3, bz - oz, w, hgt + (hi - lo) + 3, d, 0, lc, 1);
        if (hgt > 22) bg.box(bx - ox, hi + hgt, bz - oz, 0.4, 7, 0.4, 0, [0.4, 0.4, 0.4]);
        ch.boxes.push([bx - w / 2, bz - d / 2, bx + w / 2, bz + d / 2]);
      }
    }
    if (bg.n) { const m = new THREE.Mesh(bg.build(), this.mats.bldg); m.castShadow = true; m.receiveShadow = true; ch.group.add(m); }
  }

  buildRamps(ch, ox, oz) {
    const rxLo = Math.floor(ox / S) - 1, rxHi = Math.floor((ox + CH) / S) + 1;
    const riLo = Math.round((oz - 140) / S) - 1, riHi = Math.round((oz + CH + 140) / S) + 1;
    const bg = new GeoBuilder();
    const orange = [toLin(0.95), toLin(0.45), toLin(0.1)], stripe = [toLin(0.95), toLin(0.85), toLin(0.15)];
    for (let ri = riLo; ri <= riHi; ri++) for (let rx = rxLo; rx <= rxHi; rx++) {
      const r = getRamp(rx, ri);
      if (!r || r.x < ox || r.x >= ox + CH || r.z < oz || r.z >= oz + CH) continue;
      const P = (u, v, hgt) => [r.x + r.ux * u + r.vx * v - ox, heightNoRamp(r.x + r.ux * u + r.vx * v, r.z + r.uz * u + r.vz * v) + hgt, r.z + r.uz * u + r.vz * v - oz];
      const Wd = r.W - 0.75;
      const a0 = P(0, -Wd, 0), a1 = P(0, Wd, 0), b0 = P(r.L, -Wd, r.rise), b1 = P(r.L, Wd, r.rise);
      const c0 = P(r.L, -Wd, 0), c1 = P(r.L, Wd, 0);
      a0[1] += 0.05; a1[1] += 0.05;
      bg.quad(a0, b0, b1, a1, orange);
      for (let k = 0; k < 5; k++) { // hazard stripes
        const u0 = (k / 5) * r.L + 1.2, u1 = u0 + 2.1, h0 = (u0 / r.L) * r.rise + 0.06, h1 = (u1 / r.L) * r.rise + 0.06;
        bg.quad(P(u0, -Wd, h0), P(u1, -Wd, h1), P(u1, Wd, h1), P(u0, Wd, h0), stripe);
      }
      bg.quad(b0, b1, c1, c0, [0.2, 0.2, 0.2]);
      bg.tri(a0, c0, b0, [0.25, 0.25, 0.25]); bg.tri(a1, b1, c1, [0.25, 0.25, 0.25]);
      // danger sign
      const sp = P(-6, Wd + 2, 0);
      bg.box(sp[0], sp[1], sp[2], 0.2, 3.2, 0.2, 0, [0.3, 0.3, 0.3]);
      bg.box(sp[0], sp[1] + 3, sp[2], 1.6, 1.6, 0.12, -r.phi + 1.5708, stripe);
      ch.circles.push([ox + sp[0], oz + sp[2], 0.5]);
    }
    if (bg.n) { const m = new THREE.Mesh(bg.build(), this.mats.scenery); m.castShadow = true; m.receiveShadow = true; ch.group.add(m); }
  }

  // Gather static colliders around a point (3x3 chunks). out.circles = [x,z,r], out.boxes = [minx,minz,maxx,maxz]
  collidersNear(x, z, out = this.q) {
    out.circles.length = 0; out.boxes.length = 0;
    const cx = Math.floor(x / CH), cz = Math.floor(z / CH);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const ch = this.map.get(cx + dx + ',' + (cz + dz));
      if (!ch) continue;
      for (const c of ch.circles) out.circles.push(c);
      for (const b of ch.boxes) out.boxes.push(b);
    }
    for (const c of this.extra.circles) if (Math.abs(c[0] - x) < 260 && Math.abs(c[1] - z) < 260) out.circles.push(c);
    for (const b of this.extra.boxes) if (b[0] < x + 260 && b[2] > x - 260 && b[1] < z + 260 && b[3] > z - 260) out.boxes.push(b);
    return out;
  }
  has(x, z) { return this.map.has(Math.floor(x / CH) + ',' + Math.floor(z / CH)); }
}
