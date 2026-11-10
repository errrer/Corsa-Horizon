// Car roster (fictional, git-flavoured) and procedural low-poly car / traffic models.
import * as THREE from 'three';
import { computePI, classOf } from './physics.js';

// z fractions along the car (front = +0.5): cabin front base / front top / rear top / rear base
const STYLES = {
  hatch:   { L: 3.95, W: 1.74, H: 1.48, clear: 0.16, belt: 0.92, cab: [0.13, -0.02, -0.40, -0.5], hood: 0.14, tail: 0.05, wr: 0.31 },
  rally:   { L: 4.10, W: 1.82, H: 1.48, clear: 0.24, belt: 0.98, cab: [0.12, -0.02, -0.38, -0.48], hood: 0.12, tail: 0.05, wr: 0.35, wing: 1, scoop: 1 },
  coupe:   { L: 4.35, W: 1.82, H: 1.30, clear: 0.14, belt: 0.84, cab: [0.08, -0.08, -0.30, -0.40], hood: 0.16, tail: 0.08, wr: 0.33, spoiler: 1 },
  muscle:  { L: 4.80, W: 1.94, H: 1.36, clear: 0.15, belt: 0.88, cab: [0.02, -0.12, -0.30, -0.38], hood: 0.12, tail: 0.06, wr: 0.35, scoop: 1, stripes: 1 },
  suv:     { L: 4.70, W: 1.95, H: 1.86, clear: 0.28, belt: 1.18, cab: [0.16, 0.08, -0.42, -0.5], hood: 0.12, tail: 0.04, wr: 0.40, roofrack: 1 },
  gt:      { L: 4.55, W: 1.94, H: 1.26, clear: 0.12, belt: 0.80, cab: [0.06, -0.10, -0.28, -0.36], hood: 0.18, tail: 0.10, wr: 0.34, spoiler: 1 },
  roadster:{ L: 4.00, W: 1.84, H: 1.22, clear: 0.13, belt: 0.82, cab: [0.05, 0.02, 0.0, -0.02], hood: 0.14, tail: 0.1, wr: 0.32, open: 1 },
  buggy:   { L: 3.40, W: 1.92, H: 1.50, clear: 0.34, belt: 0.75, cab: [0.0, 0.0, 0.0, 0.0], hood: 0.1, tail: 0.1, wr: 0.42, open: 1, cage: 1 },
  super:   { L: 4.50, W: 2.00, H: 1.14, clear: 0.11, belt: 0.74, cab: [0.04, -0.10, -0.24, -0.34], hood: 0.2, tail: 0.12, wr: 0.34, spoiler: 1 },
  hyper:   { L: 4.70, W: 2.06, H: 1.10, clear: 0.10, belt: 0.70, cab: [0.0, -0.12, -0.22, -0.32], hood: 0.22, tail: 0.14, wr: 0.35, wing: 1 },
};

STYLES.gt3 = { ...STYLES.super, L: 4.57, W: 1.85, H: 1.28, wr: 0.35 };
STYLES.huracan = { ...STYLES.super, L: 4.52, W: 1.93, H: 1.17, wr: 0.35 };
STYLES.m5 = { ...STYLES.gt, L: 4.97, W: 1.9, H: 1.47, wr: 0.352 };
const B = (o) => ({ cgH: 0.5, brake: 1.15, stiff: 9.5, offroad: 0.1, steer: 0.55, roll: 1, cyl: 4, nitroBase: 1, ...o });
const RAW = [
  B({ id: 'commit', name: 'Commit Compact', style: 'hatch', price: 0, mass: 1150, kw: 95, top: 185, drive: 'FWD', mu: 1.12, wf: 0.6, color: 0x2ea043, cyl: 4, desc: 'Small, honest and free. Every repo starts here.' }),
  B({ id: 'branch', name: 'Branch Rally', style: 'rally', price: 28000, mass: 1280, kw: 190, top: 205, drive: 'AWD', mu: 1.18, wf: 0.56, offroad: 0.85, steer: 0.6, color: 0x388bfd, cyl: 4, downforce: 0.3, desc: 'AWD gravel hero. Loves a feature branch off-road.' }),
  B({ id: 'hotfix', name: 'Hotfix Drifter', style: 'coupe', price: 42000, mass: 1250, kw: 230, top: 240, drive: 'RWD', mu: 1.15, wf: 0.54, steer: 0.62, color: 0xf0883e, cyl: 6, gripR: 0.94, desc: 'Rear-drive and sideways. Ships fixes at 3 a.m.' }),
  B({ id: 'merge', name: 'Merge Muscle', style: 'muscle', price: 55000, mass: 1700, kw: 300, top: 265, drive: 'RWD', mu: 1.1, wf: 0.55, color: 0xda3633, cyl: 8, gripR: 0.95, desc: 'Big V8 that merges whether you like it or not.' }),
  B({ id: 'fork', name: 'Fork Offroader', style: 'suv', price: 38000, mass: 2100, kw: 220, top: 190, drive: 'AWD', mu: 1.1, wf: 0.52, offroad: 0.95, cgH: 0.75, roll: 1.5, color: 0x8957e5, cyl: 6, desc: 'Tall, tough and fully forked from the wilderness.' }),
  B({ id: 'stash', name: 'Stash GT', style: 'gt', price: 95000, mass: 1500, kw: 360, top: 290, drive: 'RWD', mu: 1.22, wf: 0.52, downforce: 0.5, color: 0x1f6feb, cyl: 8, desc: 'A grand tourer that always keeps your work safe.' }),
  B({ id: 'rebase', name: 'Rebase Roadster', style: 'roadster', price: 70000, mass: 1100, kw: 270, top: 260, drive: 'RWD', mu: 1.25, wf: 0.5, steer: 0.6, color: 0xd29922, cyl: 4, desc: 'Light, open-top and rewrites history.' }),
  B({ id: 'buggy', name: 'Pull Request Buggy', style: 'buggy', price: 30000, mass: 850, kw: 160, top: 170, drive: 'AWD', mu: 1.2, wf: 0.45, offroad: 1, steer: 0.65, color: 0xe3b341, cyl: 4, desc: 'Approved by everyone. Jumps over anything.' }),
  B({ id: 'release', name: 'Release Candidate', style: 'super', price: 210000, mass: 1450, kw: 520, top: 330, drive: 'AWD', mu: 1.35, wf: 0.45, downforce: 1.0, color: 0xf85149, cyl: 10, desc: 'Almost production-ready. Mostly just fast.' }),
  B({ id: 'huracan', name: 'Lamborghini Huracán', style: 'huracan', glb: 'huracan', price: 185000, mass: 1422, kw: 449, top: 325, drive: 'AWD', mu: 1.42, wf: 0.43, downforce: 0.9, steer: 0.52, color: 0xf0883e, cyl: 10, desc: 'Italian V10 supercar. Model by RBLXSupercars (CC BY 4.0).' }),
  B({ id: 'gt3', name: 'Porsche 911 GT3', style: 'gt3', glb: 'gt3', price: 165000, mass: 1435, kw: 375, top: 318, drive: 'RWD', mu: 1.4, wf: 0.39, downforce: 1.1, steer: 0.5, color: 0xe6edf3, cyl: 6, desc: 'Track-bred flat-six. Model by Ddiaz Design (CC BY 4.0).' }),
  B({ id: 'patch', name: 'Patch Hot Hatch', style: 'hatch', price: 18000, mass: 1080, kw: 140, top: 215, drive: 'FWD', mu: 1.2, wf: 0.6, steer: 0.6, color: 0xf778ba, cyl: 4, desc: 'Tiny, loud and fixes your commute in one patch.' }),
  B({ id: 'tag', name: 'Tag Roadster', style: 'roadster', price: 33000, mass: 960, kw: 150, top: 225, drive: 'RWD', mu: 1.22, wf: 0.5, steer: 0.62, color: 0x39d0d4, cyl: 4, desc: 'Featherweight open-top. Tagged v1.0.' }),
  B({ id: 'cache', name: 'Cache Turbo', style: 'coupe', price: 48000, mass: 1380, kw: 275, top: 255, drive: 'AWD', mu: 1.2, wf: 0.55, color: 0xa5d6ff, cyl: 4, desc: 'Always hot, always fast to respond.' }),
  B({ id: 'lint', name: 'Lint Trail Truck', style: 'suv', price: 52000, mass: 2250, kw: 260, top: 195, drive: 'AWD', mu: 1.12, wf: 0.5, offroad: 1, cgH: 0.78, roll: 1.5, color: 0x9e6a03, cyl: 6, desc: 'Cleans up any trail you point it at.' }),
  B({ id: 'diff', name: 'Diff Drift King', style: 'coupe', price: 78000, mass: 1290, kw: 380, top: 270, drive: 'RWD', mu: 1.2, wf: 0.52, steer: 0.66, gripR: 0.92, color: 0xd29922, cyl: 6, desc: 'Shows exactly what changed, in tyre smoke.' }),
  B({ id: 'stack', name: 'Stack SUV', style: 'suv', price: 62000, mass: 2050, kw: 330, top: 235, drive: 'AWD', mu: 1.14, wf: 0.5, offroad: 0.8, cgH: 0.74, roll: 1.4, color: 0x21262d, cyl: 8, desc: 'Family hauler with a very deep call stack.' }),
  B({ id: 'pipeline', name: 'BMW M5', style: 'm5', glb: 'm5', price: 135000, mass: 1940, kw: 441, top: 305, drive: 'AWD', mu: 1.3, wf: 0.54, downforce: 0.5, steer: 0.54, color: 0x388bfd, cyl: 8, desc: 'Twin-turbo V8 super saloon. Model: 2018 BMW M5 (CC BY).' }),
  B({ id: 'yank', name: 'Yank SS Muscle', style: 'muscle', price: 88000, mass: 1750, kw: 450, top: 285, drive: 'RWD', mu: 1.12, wf: 0.54, gripR: 0.93, color: 0xf0883e, cyl: 8, desc: 'Force-pushed to the limit.' }),
  B({ id: 'blame', name: 'Blame Buggy XL', style: 'buggy', price: 45000, mass: 980, kw: 230, top: 190, drive: 'AWD', mu: 1.22, wf: 0.46, offroad: 1, steer: 0.66, color: 0xda3633, cyl: 6, desc: 'It was not your fault. It was the jump.' }),
  B({ id: 'cherry', name: 'Cherry-Pick Speedster', style: 'roadster', price: 105000, mass: 1050, kw: 340, top: 285, drive: 'RWD', mu: 1.3, wf: 0.5, steer: 0.6, color: 0xe3b341, cyl: 6, desc: 'Takes only the best commits.' }),
  B({ id: 'bisect', name: 'Bisect Rally Pro', style: 'rally', price: 64000, mass: 1260, kw: 290, top: 225, drive: 'AWD', mu: 1.2, wf: 0.54, offroad: 0.9, steer: 0.62, downforce: 0.35, color: 0x2ea043, cyl: 4, desc: 'Finds the fastest line in half the time.' }),
  B({ id: 'mainst', name: 'Main Street Super', style: 'super', price: 320000, mass: 1400, kw: 620, top: 345, drive: 'RWD', mu: 1.38, wf: 0.43, downforce: 1.1, color: 0x388bfd, cyl: 10, desc: 'Straight from main. Nothing but speed.' }),
  B({ id: 'hash', name: 'Hash Hypercar', style: 'hyper', price: 480000, mass: 1380, kw: 780, top: 375, drive: 'AWD', mu: 1.45, wf: 0.44, downforce: 1.4, color: 0x8957e5, cyl: 8, desc: 'Collision-free at any speed. Mostly.' }),
  B({ id: 'deploy', name: 'Deploy Hypercar', style: 'hyper', price: 650000, mass: 1350, kw: 900, top: 400, drive: 'AWD', mu: 1.5, wf: 0.44, downforce: 1.6, steer: 0.5, color: 0xe6edf3, cyl: 12, desc: 'Straight to production. No rollback.' }),
];
export const CARS = RAW.map((c) => {
  const st = STYLES[c.style];
  const spec = { ...c, L: st.L, W: st.W, H: st.H, wb: st.L * 0.63, track: st.W - 0.3, wheelR: st.wr, redline: 6800 + c.cyl * 120 };
  spec.pi = computePI(spec); spec.cls = classOf(spec.pi);
  return spec;
});
export const carById = (id) => CARS.find((c) => c.id === id) || CARS[0];
export const PAINTS = [0x2ea043, 0x388bfd, 0xf0883e, 0xda3633, 0x8957e5, 0xd29922, 0xe6edf3, 0x21262d, 0xf778ba, 0x39d0d4, 0xa5d6ff, 0x9e6a03];
export const UPGRADES = [
  { key: 'engine', name: 'Engine', desc: '+9% power per level', base: 0.06 },
  { key: 'tires', name: 'Tires', desc: '+3.5% grip per level', base: 0.04 },
  { key: 'weight', name: 'Weight reduction', desc: '-3.5% mass per level', base: 0.05 },
  { key: 'aero', name: 'Aero', desc: 'More downforce at speed', base: 0.04 },
  { key: 'nitro', name: 'Nitrous', desc: 'Bigger, stronger boost', base: 0.05 },
];
export const upgradePrice = (spec, key, level) => {
  const u = UPGRADES.find((x) => x.key === key);
  return Math.round(Math.max(1500, spec.price * u.base) * (level + 1) * 1.2 / 100) * 100;
};
export const AWD_PRICE = (spec) => Math.round(Math.max(8000, spec.price * 0.12) / 100) * 100;

// ---------- geometry helpers ----------
function loft(sections) {
  const pos = [], nP = sections[0].pts.length;
  const V = (s, k) => { const p = sections[s].pts[k % nP]; return [p[0], p[1], sections[s].z]; };
  const T = (a, b, c) => pos.push(...a, ...b, ...c);
  for (let s = 0; s < sections.length - 1; s++) for (let k = 0; k < nP; k++) {
    const a = V(s, k), b = V(s, k + 1), c = V(s + 1, k + 1), d = V(s + 1, k);
    T(a, b, c); T(a, c, d);
  }
  for (const [s, rev] of [[0, true], [sections.length - 1, false]]) {
    let cx = 0, cy = 0; for (const p of sections[s].pts) { cx += p[0]; cy += p[1]; }
    const c = [cx / nP, cy / nP, sections[s].z];
    for (let k = 0; k < nP; k++) rev ? T(c, V(s, k + 1), V(s, k)) : T(c, V(s, k), V(s, k + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}
const boxM = (mat, sx, sy, sz, x, y, z, parent, cast = true) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  m.position.set(x, y, z); m.castShadow = cast; parent.add(m); return m;
};

let shared = null;
function sharedMats() {
  if (shared) return shared;
  shared = {
    glass: new THREE.MeshStandardMaterial({ color: 0x141c26, roughness: 0.12, metalness: 0.5, side: THREE.DoubleSide }),
    tire: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xc9d1d9, roughness: 0.3, metalness: 0.8 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xaab2bb, roughness: 0.25, metalness: 0.9 }),
    tireGeo: new THREE.CylinderGeometry(1, 1, 1, 16).rotateZ(Math.PI / 2),
  };
  return shared;
}

// Builds a drivable car model. Returns { group, body, wheels, tail, head, flame }
export function buildCar(spec, colorHex) {
  const st = STYLES[spec.style] || STYLES.hatch, M = sharedMats();
  const { L, W, H, clear, belt } = st;
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.3, metalness: 0.35, side: THREE.DoubleSide });
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff1010, emissiveIntensity: 0.6 });
  const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 0.9 });
  const w2 = W / 2, y0 = clear, yt = belt;
  const poly = (w, yb, yTop, tw = 0.88) => { const ym = yb + (yTop - yb) * 0.45; return [[-w * 0.9, yb], [w * 0.9, yb], [w, ym], [w * tw, yTop], [-w * tw, yTop], [-w, ym]]; };
  // lower body
  const zf = L / 2;
  const secs = [
    { z: -zf, pts: poly(w2 * 0.9, y0 + 0.05, yt - st.tail, 0.84) },
    { z: -zf * 0.88, pts: poly(w2 * 0.97, y0, yt - st.tail * 0.3, 0.88) },
    { z: -zf * 0.5, pts: poly(w2, y0, yt, 0.9) },
    { z: zf * 0.35, pts: poly(w2, y0, yt, 0.9) },
    { z: zf * 0.8, pts: poly(w2 * 0.97, y0, yt - st.hood, 0.86) },
    { z: zf, pts: poly(w2 * 0.88, y0 + 0.06, yt - st.hood - 0.12, 0.8) },
  ];
  const lower = new THREE.Mesh(loft(secs), body); lower.castShadow = true; group.add(lower);
  // cabin
  const [cfb, cft, crt, crb] = st.cab;
  if (!st.open) {
    const cw = w2 * 0.9, tw = w2 * 0.7, top = H;
    const cab = loft([
      { z: crb * L, pts: [[-cw, yt - 0.02], [cw, yt - 0.02], [tw, yt + 0.16], [-tw, yt + 0.16]] },
      { z: crt * L, pts: [[-cw, yt - 0.02], [cw, yt - 0.02], [tw, top], [-tw, top]] },
      { z: cft * L, pts: [[-cw, yt - 0.02], [cw, yt - 0.02], [tw, top], [-tw, top]] },
      { z: cfb * L, pts: [[-cw, yt - 0.02], [cw, yt - 0.02], [tw, yt + 0.05], [-tw, yt + 0.05]] },
    ]);
    const cabM = new THREE.Mesh(cab, M.glass); cabM.castShadow = true; group.add(cabM);
    boxM(body, tw * 2 + 0.02, 0.07, (cft - crt) * L + 0.1, 0, top - 0.02, ((cft + crt) / 2) * L, group);
    if (st.roofrack) { boxM(M.dark, tw * 1.6, 0.06, (cft - crt) * L * 0.8, 0, top + 0.06, ((cft + crt) / 2) * L, group); }
  } else {
    // windscreen + seats
    const wz = cfb * L;
    const ws = boxM(M.glass, W * 0.82, 0.5, 0.05, 0, yt + 0.25, wz - 0.1, group); ws.rotation.x = -0.5;
    boxM(M.dark, 0.5, 0.45, 0.5, w2 * 0.38, yt + 0.12, wz - 0.9, group); boxM(M.dark, 0.5, 0.45, 0.5, -w2 * 0.38, yt + 0.12, wz - 0.9, group);
    if (st.cage) {
      for (const sx of [-1, 1]) {
        boxM(M.dark, 0.08, H - yt, 0.08, sx * (w2 - 0.2), yt + (H - yt) / 2, wz - 0.3, group);
        boxM(M.dark, 0.08, H - yt, 0.08, sx * (w2 - 0.2), yt + (H - yt) / 2, wz - 1.6, group);
        boxM(M.dark, 0.08, 0.08, 1.4, sx * (w2 - 0.2), H, wz - 0.95, group);
      }
      boxM(M.dark, W - 0.3, 0.08, 0.08, 0, H, wz - 0.95, group);
    }
  }
  // details
  boxM(M.dark, W * 0.5, 0.2, 0.06, 0, y0 + 0.28, zf - 0.04, group, false); // grille
  boxM(head, 0.38, 0.14, 0.08, w2 * 0.66, yt - st.hood - 0.04, zf - 0.07, group, false);
  boxM(head, 0.38, 0.14, 0.08, -w2 * 0.66, yt - st.hood - 0.04, zf - 0.07, group, false);
  boxM(tail, 0.44, 0.13, 0.06, w2 * 0.66, yt - st.tail - 0.08, -zf + 0.02, group, false);
  boxM(tail, 0.44, 0.13, 0.06, -w2 * 0.66, yt - st.tail - 0.08, -zf + 0.02, group, false);
  boxM(M.dark, W * 0.96, 0.12, 0.1, 0, y0 + 0.08, zf - 0.08, group, false); // front splitter / bumper
  boxM(M.dark, W * 0.96, 0.12, 0.1, 0, y0 + 0.08, -zf + 0.08, group, false);
  for (const sx of [-1, 1]) {
    if (!st.open) boxM(body, 0.12, 0.1, 0.2, sx * (w2 + 0.04), yt + 0.1, cfb * L - 0.1, group, false); // mirrors
    boxM(M.dark, 0.04, 0.1, L * 0.55, sx * (w2 - 0.01), y0 + 0.06, 0, group, false); // skirts
  }
  if (st.scoop) boxM(M.dark, 0.5, 0.1, 0.7, 0, yt - st.hood + 0.04, zf * 0.55, group);
  if (st.spoiler || st.wing) {
    const hh = st.wing ? 0.42 : 0.2;
    for (const sx of [-1, 1]) boxM(M.dark, 0.06, hh, 0.12, sx * w2 * 0.6, yt - st.tail + hh / 2, -zf + 0.25, group);
    boxM(body, W * 0.94, 0.06, st.wing ? 0.42 : 0.3, 0, yt - st.tail + hh, -zf + 0.22, group);
  }
  if (st.stripes) { boxM(M.chrome, 0.28, 0.01, L * 0.62, 0.22, yt - st.hood * 0.4 + 0.012, zf * 0.15, group, false); boxM(M.chrome, 0.28, 0.01, L * 0.62, -0.22, yt - st.hood * 0.4 + 0.012, zf * 0.15, group, false); }
  for (const sx of [-1, 1]) boxM(M.chrome, 0.1, 0.1, 0.22, sx * w2 * 0.45, y0 + 0.12, -zf + 0.02, group, false); // exhausts

  // nitro flames
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.6, 8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x66b3ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.position.set(0, y0 + 0.14, -zf - 0.7); flame.visible = false; flame.scale.z = -1;
  group.add(flame);

  // wheels
  const wheels = [];
  const wr = st.wr, ww = Math.min(0.3, 0.2 + (W - 1.7) * 0.2), wbh = spec.wb / 2;
  const wx = w2 - ww / 2 - 0.02;
  for (const [sx, sz, front] of [[1, 1, true], [-1, 1, true], [1, -1, false], [-1, -1, false]]) {
    const pivot = new THREE.Group(); pivot.position.set(sx * wx, wr, sz * wbh);
    const spin = new THREE.Group(); pivot.add(spin);
    const tire = new THREE.Mesh(M.tireGeo, M.tire); tire.scale.set(ww, wr, wr); tire.castShadow = true; spin.add(tire);
    const rim = new THREE.Mesh(M.tireGeo, M.rim); rim.scale.set(ww + 0.02, wr * 0.64, wr * 0.64); spin.add(rim);
    boxM(M.dark, ww + 0.05, wr * 1.1, 0.07, 0, 0, 0, spin, false);
    boxM(M.dark, ww + 0.05, 0.07, wr * 1.1, 0, 0, 0, spin, false);
    group.add(pivot); wheels.push({ pivot, spin, front, side: sx });
  }
  group.userData = { L, W, wr, wbh, wx };
  return { group, body, wheels, tail, head, flame, bodyMat: body, st };
}

// ---------- traffic ----------
export const TRAFFIC_KINDS = ['sedan', 'hatch', 'van', 'truck', 'bus', 'suv'];
export function buildTraffic(kind, colorHex) {
  const M = sharedMats();
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.5, metalness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff1010, emissiveIntensity: 0.5 });
  let L = 4.4, W = 1.8, wr = 0.32;
  if (kind === 'sedan' || kind === 'hatch' || kind === 'suv') {
    const m = buildCar({ style: kind === 'sedan' ? 'coupe' : kind, wb: (kind === 'hatch' ? 3.95 : kind === 'suv' ? 4.7 : 4.35) * 0.63 }, colorHex);
    m.group.userData.traffic = true;
    return { group: m.group, wheels: m.wheels, L: m.group.userData.L, W: m.group.userData.W, tail: m.tail };
  }
  const dims = { van: [5.2, 2.0, 2.3], truck: [8.5, 2.5, 3.4], bus: [11.5, 2.55, 3.2] }[kind];
  L = dims[0]; W = dims[1]; wr = kind === 'van' ? 0.36 : 0.5;
  const h = dims[2];
  if (kind === 'van') {
    boxM(body, W, h - 0.5, L, 0, 0.5, 0, group);
    boxM(M.glass, W * 0.9, 0.7, 0.1, 0, 1.55, L / 2 - 0.9, group);
  } else if (kind === 'truck') {
    boxM(body, W * 0.96, 2.1, 2.2, 0, 0.7, L / 2 - 1.1, group); // cab
    boxM(M.glass, W * 0.9, 0.7, 0.1, 0, 1.75, L / 2 - 0.02, group);
    boxM(new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.7 }), W, 2.5, L - 2.8, 0, 0.9, -1.4, group);
  } else {
    boxM(body, W, h - 0.5, L, 0, 0.5, 0, group);
    boxM(M.glass, W + 0.02, 0.8, L * 0.85, 0, 1.6, -0.3, group, false);
    boxM(M.glass, W * 0.9, 0.9, 0.1, 0, 1.6, L / 2 + 0.01, group);
  }
  boxM(tail, W * 0.8, 0.14, 0.06, 0, 0.9, -L / 2 - 0.01, group, false);
  const wheels = [];
  const axles = kind === 'bus' || kind === 'truck' ? [L / 2 - 1.3, -L / 2 + 1.5] : [L / 2 - 1.1, -L / 2 + 1.1];
  for (const sx of [-1, 1]) for (const z of axles) {
    const pivot = new THREE.Group(); pivot.position.set(sx * (W / 2 - 0.1), wr, z);
    const spin = new THREE.Group(); pivot.add(spin);
    const tire = new THREE.Mesh(M.tireGeo, M.tire); tire.scale.set(0.3, wr, wr); spin.add(tire);
    boxM(M.dark, 0.34, wr * 1.1, 0.07, 0, 0, 0, spin, false);
    group.add(pivot); wheels.push({ pivot, spin, front: z > 0, side: sx });
  }
  return { group, wheels, L, W, tail };
}
