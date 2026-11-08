// Loads the Lamborghini Huracan GLB, splits its four wheels out of the merged meshes so they can spin and steer,
// and builds per-car instances. Model: "2016 Lamborghini Huracan" by RBLXSupercars (CC BY 4.0), via Sketchfab.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildCar } from './cars.js';

// Wheel centres in the model's own (post-node-transform) space. Front of the model is -z.
const WHEELS = [
  { x: 83.13, y: 18.322, z: -360.357, R: 1.322, hw: 0.8, front: true, side: 1 },
  { x: 90.07, y: 18.322, z: -360.357, R: 1.322, hw: 0.8, front: true, side: -1 },
  { x: 83.28, y: 18.413, z: -349.609, R: 1.412, hw: 0.95, front: false, side: 1 },
  { x: 89.91, y: 18.413, z: -349.609, R: 1.412, hw: 0.95, front: false, side: -1 },
];
const WHEEL_MATS = new Set(['Details1Mtl', 'Disc1Mtl', 'Meshpart14Mtl', 'Tire1Mtl', 'Wipers1Mtl']);
const CENTER = { x: 86.595, y: 17.0, z: -354.98 }; // wheelbase centre at ground level
const SC = 0.25; // model units -> metres
let TPL = null;

export async function loadHuracan(url = 'assets/huracan.glb') {
  const gltf = await new GLTFLoader().loadAsync(url);
  const scene = gltf.scene; scene.updateMatrixWorld(true);
  const parts = [], mats = {};
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
    const mat = o.material; mats[mat.name] = mat;
    const pos = g.attributes.position, idx = g.index ? g.index.array : null, nTri = (idx ? idx.length : pos.count) / 3;
    const canWheel = WHEEL_MATS.has(mat.name), buckets = [[], [], [], [], []];
    for (let t = 0; t < nTri; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      let w = 4;
      if (canWheel) {
        const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        for (let k = 0; k < 4; k++) { const W = WHEELS[k]; if (Math.abs(cx - W.x) <= W.hw && Math.hypot(cy - W.y, cz - W.z) <= W.R * 1.03) { w = k; break; } }
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
  TPL = { parts, mats };
}
export const huracanReady = () => !!TPL;

function buildHuracan(spec, colorHex) {
  const T = TPL, group = new THREE.Group(), root = new THREE.Group(), holder = new THREE.Group();
  root.rotation.y = Math.PI; root.scale.setScalar(SC); holder.position.set(-CENTER.x, -CENTER.y, -CENTER.z);
  root.add(holder); group.add(root);
  const paint = T.mats.Paint1Mtl.clone(); paint.color.setHex(colorHex);
  const tail = T.mats.Rright1Mtl.clone(); tail.emissive = new THREE.Color(0xff1010); tail.emissiveIntensity = 0.6;
  const head = T.mats.Runl1Mtl.clone();
  const own = { Paint1Mtl: paint, Rright1Mtl: tail, Runl1Mtl: head };
  const pivots = WHEELS.map((W) => {
    const pivot = new THREE.Group(); pivot.position.set(W.x, W.y, W.z);
    const inner = new THREE.Group(); pivot.add(inner); holder.add(pivot);
    // the model is turned 180 degrees, so the spin axis is mirrored
    const spin = { rotation: { get x() { return -inner.rotation.x; }, set x(v) { inner.rotation.x = -v; } } };
    return { pivot, inner, spin, front: W.front, side: W.side };
  });
  for (const p of T.parts) {
    const m = new THREE.Mesh(p.geom, own[p.name] || p.mat);
    if (p.wheel >= 0) { const W = WHEELS[p.wheel]; m.position.set(-W.x, -W.y, -W.z); m.frustumCulled = false; pivots[p.wheel].inner.add(m); }
    else holder.add(m);
    m.castShadow = p.name !== 'Mirrorreflections1Mtl';
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.6, 8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x66b3ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.position.set(0, 0.42, -2.9); flame.visible = false; flame.scale.z = -1; group.add(flame);
  group.userData = { L: spec.L, W: spec.W, wr: 0.34, wbh: 1.36, wx: 0.85 };
  const mats = Object.values(T.mats).map((m) => own[m.name] || m);
  return { group, body: paint, wheels: pivots, tail, head, flame, bodyMat: paint, mats };
}

export function makeCarModel(spec, colorHex) {
  if (spec.glb && TPL) return buildHuracan(spec, colorHex);
  return buildCar(spec, colorHex);
}
