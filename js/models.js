// Loads GLB car models, splits their wheels out so they can spin and steer, and builds per-car instances.
// Credits: "2016 Lamborghini Huracan" by RBLXSupercars and "2022 Porsche 911 GT3 (992)" by Ddiaz Design (both CC BY 4.0, Sketchfab).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildCar } from './cars.js';

// Model-space numbers below were measured from each file (after the node transforms are applied).
const MODELS = {
  huracan: {
    url: 'assets/huracan.glb', b64: ['assets/huracan.b64.txt'], scale: 0.25, flip: true, center: { x: 86.595, y: 17.0, z: -354.98 },
    mode: 'tri', wheelMats: ['Details1Mtl', 'Disc1Mtl', 'Meshpart14Mtl', 'Tire1Mtl', 'Wipers1Mtl'],
    wheels: [
      { x: 83.13, y: 18.322, z: -360.357, R: 1.322, hw: 0.8, front: true, side: 1 }, { x: 90.07, y: 18.322, z: -360.357, R: 1.322, hw: 0.8, front: true, side: -1 },
      { x: 83.28, y: 18.413, z: -349.609, R: 1.412, hw: 0.95, front: false, side: 1 }, { x: 89.91, y: 18.413, z: -349.609, R: 1.412, hw: 0.95, front: false, side: -1 },
    ],
    paint: 'Paint1Mtl', tail: 'Rright1Mtl', head: 'Runl1Mtl', wr: 0.34, wbh: 1.36, wx: 0.85,
  },
  gt3: {
    url: 'assets/gt3.glb', b64: ['assets/gt3.b64.0.txt', 'assets/gt3.b64.1.txt'], scale: 100, flip: false, center: { x: 0, y: 0, z: -0.0003 },
    mode: 'node', splitZ: -0.0003, wheelRoot: 'Combined_Wheels_3D_', calliperRoot: 'Calliper',
    wheels: [
      { x: 0.00789, y: 0.00346, z: 0.01196, front: true, side: 1 }, { x: -0.00789, y: 0.00346, z: 0.01196, front: true, side: -1 },
      { x: 0.00772, y: 0.00364, z: -0.01256, front: false, side: 1 }, { x: -0.00772, y: 0.00364, z: -0.01256, front: false, side: -1 },
    ],
    paint: 'Porsche_911GT3_2022Paint_Material', tail: 'RED_GLASS', head: 'Porsche_911GT3_2022LightA_Material', wr: 0.35, wbh: 1.28, wx: 0.8,
  },
};
const TPL = {};

async function fetchBuffer(cfg) {
  try {
    const r = await fetch(cfg.url); if (!r.ok) throw new Error('missing');
    const buf = await r.arrayBuffer(); if (new Uint32Array(buf, 0, 1)[0] !== 0x46546c67) throw new Error('not glb');
    return buf;
  } catch (e) {
    // some hosts only serve text files: fall back to base64 copies
    const chunks = [];
    for (const u of cfg.b64) {
      const bin = atob(await (await fetch(u)).text()), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      chunks.push(u8);
    }
    const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0)); let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return all.buffer;
  }
}
const clean = (g) => { for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal' && n !== 'uv') g.deleteAttribute(n); if (!g.attributes.normal) g.computeVertexNormals(); if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); if (!g.index) { const n = g.attributes.position.count, a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = i; g.setIndex(new THREE.BufferAttribute(a, 1)); } return g; };

function flipWinding(g) {
  if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; } g.index.needsUpdate = true; }
  else { const p = g.attributes; for (let i = 0; i + 2 < p.position.count; i += 3) for (const n in p) { const at = p[n], s = at.itemSize; for (let k = 0; k < s; k++) { const x = at.array[i * s + k]; at.array[i * s + k] = at.array[(i + 2) * s + k]; at.array[(i + 2) * s + k] = x; } } }
}

export async function loadModel(key) {
  const cfg = MODELS[key], buf = await fetchBuffer(cfg);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
  const scene = gltf.scene; scene.updateMatrixWorld(true);
  const parts = [], mats = {}, groups = {}; // groups: wheel merge buckets for node mode
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const mat = o.material; mats[mat.name] = mat;
    if (mat.transmission > 0) { mat.transmission = 0; mat.transparent = true; mat.depthWrite = false; } // cheap glass
    const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
    if (o.matrixWorld.determinant() < 0) flipWinding(g); // mirrored instances come out inside-out otherwise
    if (cfg.mode === 'node') {
      let kind = 'body'; for (let p = o; p; p = p.parent) { if (p.name === cfg.wheelRoot) { kind = 'wheel'; break; } if (p.name && p.name.startsWith(cfg.calliperRoot)) { kind = 'cal'; break; } }
      if (kind === 'body') { parts.push({ geom: g, mat, name: mat.name, wheel: -1 }); return; }
      g.computeBoundingBox(); const c = g.boundingBox.getCenter(new THREE.Vector3());
      const k = (c.z > cfg.splitZ ? 0 : 2) + (c.x > 0 ? 0 : 1), key2 = kind + k;
      (groups[key2] = groups[key2] || { kind, k, mat, list: [] }).list.push(clean(g));
      return;
    }
    // triangle mode: carve wheel triangles out of the merged meshes
    const pos = g.attributes.position, idx = g.index ? g.index.array : null, nTri = (idx ? idx.length : pos.count) / 3;
    const canWheel = cfg.wheelMats.includes(mat.name), buckets = [[], [], [], [], []];
    for (let t = 0; t < nTri; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      let w = 4;
      if (canWheel) {
        const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        for (let k = 0; k < 4; k++) { const W = cfg.wheels[k]; if (Math.abs(cx - W.x) <= W.hw && Math.hypot(cy - W.y, cz - W.z) <= W.R * 1.03) { w = k; break; } }
      }
      buckets[w].push(a, b, c);
    }
    for (let k = 0; k < 5; k++) {
      if (!buckets[k].length) continue;
      const gg = new THREE.BufferGeometry();
      for (const n in g.attributes) gg.setAttribute(n, g.attributes[n]);
      gg.setIndex(buckets[k]);
      parts.push({ geom: gg, mat, name: mat.name, wheel: k < 4 ? k : -1 });
    }
  });
  for (const gr of Object.values(groups)) {
    const merged = mergeGeometries(gr.list, false);
    if (merged) parts.push({ geom: merged, mat: gr.mat, name: gr.mat.name, wheel: gr.k, spin: gr.kind === 'wheel' });
  }
  TPL[key] = { cfg, parts, mats };
}
export const modelReady = (key) => !!TPL[key];

function buildInstance(spec, colorHex, T) {
  const cfg = T.cfg, group = new THREE.Group(), root = new THREE.Group(), holder = new THREE.Group();
  root.rotation.y = cfg.flip ? Math.PI : 0; root.scale.setScalar(cfg.scale); holder.position.set(-cfg.center.x, -cfg.center.y, -cfg.center.z);
  root.add(holder); group.add(root);
  const own = {}, M = T.mats;
  const paint = (M[cfg.paint] || new THREE.MeshStandardMaterial()).clone(); paint.color.setHex(colorHex); own[cfg.paint] = paint;
  const tail = (M[cfg.tail] || new THREE.MeshStandardMaterial()).clone(); tail.emissive = new THREE.Color(0xff1010); tail.emissiveIntensity = 0.6; own[cfg.tail] = tail;
  const head = (M[cfg.head] || new THREE.MeshStandardMaterial()).clone(); own[cfg.head] = head;
  const sgn = cfg.flip ? -1 : 1; // a turned-around model has a mirrored spin axis
  const pivots = cfg.wheels.map((W) => {
    const pivot = new THREE.Group(); pivot.position.set(W.x, W.y, W.z);
    const inner = new THREE.Group(); pivot.add(inner); holder.add(pivot);
    const spin = { rotation: { get x() { return sgn * inner.rotation.x; }, set x(v) { inner.rotation.x = sgn * v; } } };
    return { pivot, inner, spin, front: W.front, side: W.side };
  });
  for (const p of T.parts) {
    const m = new THREE.Mesh(p.geom, own[p.name] || p.mat);
    if (p.wheel >= 0) { const W = cfg.wheels[p.wheel]; m.position.set(-W.x, -W.y, -W.z); m.frustumCulled = false; (p.spin === false ? pivots[p.wheel].pivot : pivots[p.wheel].inner).add(m); }
    else holder.add(m);
    m.castShadow = !/Mirror|Window|GLASS/i.test(p.name);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.6, 8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x66b3ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.position.set(0, 0.42, -spec.L / 2 - 0.65); flame.visible = false; flame.scale.z = -1; group.add(flame);
  group.userData = { L: spec.L, W: spec.W, wr: cfg.wr, wbh: cfg.wbh, wx: cfg.wx };
  const mats = Object.values(M).map((m) => own[m.name] || m);
  return { group, body: paint, wheels: pivots, tail, head, flame, bodyMat: paint, mats };
}

export function makeCarModel(spec, colorHex) {
  const T = spec.glb && TPL[spec.glb];
  return T ? buildInstance(spec, colorHex, T) : buildCar(spec, colorHex);
}
