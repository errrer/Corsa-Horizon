// Loads the downtown tower GLBs (decimated copies of the supplied building models) so towns can place them.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const BUILD = { list: [], ready: false };
// scale = metres per model unit (models are about 1-3 units wide)
const DEFS = [
  { id: 'b01', scale: 7.5 }, { id: 'b02', scale: 12 }, { id: 'b05', scale: 11 }, { id: 'b06', scale: 22 },
];

async function fetchGlb(id) {
  try {
    const r = await fetch(`assets/buildings/${id}.glb`); if (!r.ok) throw new Error('missing');
    const buf = await r.arrayBuffer(); if (new Uint32Array(buf, 0, 1)[0] !== 0x46546c67) throw new Error('not glb');
    return buf;
  } catch (e) {
    const bin = atob(await (await fetch(`assets/buildings/${id}.b64.txt`)).text()), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
}

export async function loadBuildings() {
  if (BUILD.ready) return;
  for (const d of DEFS) {
    try {
      const buf = await fetchGlb(d.id);
      const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
      const parts = []; const box = new THREE.Box3();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox);
        const m = o.material; m.side = THREE.DoubleSide; m.roughness = Math.max(0.55, m.roughness || 0.6); m.metalness = 0;
        parts.push({ geo: o.geometry, mat: m });
      });
      const sz = box.getSize(new THREE.Vector3());
      BUILD.list.push({ id: d.id, parts, scale: d.scale, w: sz.x * d.scale, d: sz.z * d.scale, h: sz.y * d.scale });
    } catch (e) { console.warn('building ' + d.id + ' unavailable', e); }
  }
  BUILD.ready = BUILD.list.length > 0;
}
