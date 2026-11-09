// Sky dome, sun/moon lighting, day/night cycle, clouds, water plane, weather (rain, snow, fog, storms).
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './util.js';

export const WEATHER_TYPES = {
  clear: { cloud: 0.1, rain: 0, snow: 0, fog: 0 },
  cloudy: { cloud: 0.7, rain: 0, snow: 0, fog: 0.08 },
  rain: { cloud: 0.92, rain: 0.8, snow: 0, fog: 0.25 },
  storm: { cloud: 1, rain: 1, snow: 0, fog: 0.4 },
  fog: { cloud: 0.5, rain: 0, snow: 0, fog: 0.9 },
  snow: { cloud: 0.85, rain: 0, snow: 0.85, fog: 0.35 },
};

export class Weather {
  constructor() {
    this.type = 'clear'; this.auto = true; this.timer = 150;
    this.cur = { ...WEATHER_TYPES.clear }; this.wet = 0; this.flash = 0; this.bolt = 6; this.thunder = null;
  }
  set(type) { this.type = type; this.timer = 150 + Math.random() * 200; }
  update(dt, season) {
    const t = WEATHER_TYPES[this.type];
    const k = 1 - Math.exp(-0.12 * dt);
    for (const key of ['cloud', 'rain', 'snow', 'fog']) this.cur[key] += (t[key] - this.cur[key]) * k;
    this.wet = clamp(this.wet + (this.cur.rain > 0.15 ? dt * 0.05 * this.cur.rain : -dt * 0.01), 0, 1);
    if (season === 'winter' && this.cur.rain > 0.2) this.cur.rain *= 0.0;
    if (this.auto) {
      this.timer -= dt;
      if (this.timer <= 0) {
        const w = { clear: 0.62, cloudy: 0.2, rain: 0.09, fog: 0.04, storm: 0.03, snow: season === 'winter' ? 0.3 : 0.02 };
        if (season === 'winter') { w.rain = 0.02; w.storm = 0.02; }
        let r = Math.random() * Object.values(w).reduce((a, b) => a + b, 0), pick = 'clear';
        for (const [n, v] of Object.entries(w)) { if ((r -= v) <= 0) { pick = n; break; } }
        this.set(pick);
      }
    }
    this.flash = Math.max(0, this.flash - dt * 3.5);
    if (this.type === 'storm' && this.cur.rain > 0.6) {
      this.bolt -= dt;
      if (this.bolt <= 0) { this.flash = 1; this.bolt = 4 + Math.random() * 9; if (this.thunder) this.thunder(0.4 + Math.random() * 1.8); }
    }
  }
}

const SKY_VS = `varying vec3 vDir; void main(){ vDir = position; vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; }`;
const SKY_FS = `
uniform vec3 uTop; uniform vec3 uHor; uniform vec3 uSunCol; uniform vec3 uSunDir; uniform float uNight; uniform float uCloud;
varying vec3 vDir;
float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
void main(){
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHor, uTop, pow(h, 0.45));
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunCol * (pow(sd, 900.0) * 7.0 + pow(sd, 9.0) * 0.25) * (1.0 - uCloud * 0.85);
  float md = dot(d, -normalize(uSunDir));
  col += vec3(0.8,0.85,1.0) * smoothstep(0.9985, 0.9993, md) * uNight * (1.0 - uCloud);
  float st = step(0.9972, hash(floor(d*280.0))) * smoothstep(0.04, 0.3, d.y) * uNight * (1.0 - uCloud);
  col += vec3(st);
  if (d.y < 0.0) col = mix(uHor, uHor * 0.7, clamp(-d.y * 5.0, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const rgb = (c, r, g, b) => c.setRGB(r, g, b, THREE.SRGBColorSpace);
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export class SkySystem {
  constructor(scene, renderer, camera) {
    this.scene = scene; this.renderer = renderer; this.camera = camera;
    this.night = 0; this.dayF = 1; this.sunDir = new THREE.Vector3(0, 1, 0);
    this.viewDist = 800;
    scene.fog = new THREE.FogExp2(0xb5cde6, 0.0025);

    this.uniforms = {
      uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uNight: { value: 0 }, uCloud: { value: 0 },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 14),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    this.dome.scale.setScalar(3000); this.dome.renderOrder = -10; this.dome.frustumCulled = false;
    scene.add(this.dome);

    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a4036, 1);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera; sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80; sc.near = 10; sc.far = 500;
    this.sun.shadow.bias = -0.0005; this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun); scene.add(this.sun.target);

    // clouds
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const cx = cv.getContext('2d');
    for (let i = 0; i < 14; i++) {
      const x = 30 + Math.random() * 68, y = 44 + Math.random() * 40, r = 18 + Math.random() * 26;
      const g = cx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      cx.fillStyle = g; cx.fillRect(0, 0, 128, 128);
    }
    const ctex = new THREE.CanvasTexture(cv); ctex.colorSpace = THREE.SRGBColorSpace;
    this.clouds = [];
    this.cloudMat = new THREE.SpriteMaterial({ map: ctex, transparent: true, depthWrite: false, opacity: 0.8, fog: false });
    for (let i = 0; i < 32; i++) {
      const s = new THREE.Sprite(this.cloudMat);
      const a = Math.random() * 6.283, d = 400 + Math.random() * 2000;
      s.userData = { a, d, alt: 330 + Math.random() * 300, size: 500 + Math.random() * 800, k: i / 32 };
      s.scale.set(s.userData.size, s.userData.size * 0.45, 1); s.renderOrder = -5;
      scene.add(s); this.clouds.push(s);
    }

    // water
    const wc = document.createElement('canvas'); wc.width = wc.height = 128;
    const wx = wc.getContext('2d'); wx.fillStyle = '#9ec4d8'; wx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 500; i++) { wx.fillStyle = `rgba(255,255,255,${Math.random() * 0.25})`; wx.fillRect(Math.random() * 128, Math.random() * 128, 2 + Math.random() * 5, 1); }
    this.waterTex = new THREE.CanvasTexture(wc); this.waterTex.wrapS = this.waterTex.wrapT = THREE.RepeatWrapping; this.waterTex.repeat.set(220, 220); this.waterTex.colorSpace = THREE.SRGBColorSpace;
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x2c7fa8, map: this.waterTex, transparent: true, opacity: 0.82, roughness: 0.12, metalness: 0.15 }),
    );
    this.water.position.y = -0.04; this.water.renderOrder = 1;
    scene.add(this.water);

    // rain
    this.RN = 1400;
    this.rainPos = new Float32Array(this.RN * 6);
    this.rainState = new Float32Array(this.RN * 3);
    for (let i = 0; i < this.RN; i++) { this.rainState[i * 3] = (Math.random() - 0.5) * 50; this.rainState[i * 3 + 1] = Math.random() * 28; this.rainState[i * 3 + 2] = (Math.random() - 0.5) * 50; }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xb4c7dc, transparent: true, opacity: 0.45, fog: false, depthWrite: false }));
    this.rain.frustumCulled = false; this.rain.visible = false; scene.add(this.rain);
    // snow
    this.SN = 1200;
    this.snowPos = new Float32Array(this.SN * 3); this.snowSeed = new Float32Array(this.SN * 3);
    for (let i = 0; i < this.SN; i++) { this.snowSeed[i * 3] = (Math.random() - 0.5) * 50; this.snowSeed[i * 3 + 1] = Math.random() * 25; this.snowSeed[i * 3 + 2] = (Math.random() - 0.5) * 50; }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3));
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.2, transparent: true, opacity: 0.9, depthWrite: false, fog: false }));
    this.snow.frustumCulled = false; this.snow.visible = false; scene.add(this.snow);
    this.t = 0;
  }

  setViewDistance(d) { this.viewDist = d; }
  setShadows(on, size) {
    this.renderer.shadowMap.enabled = on; this.sun.castShadow = on;
    if (on && size && this.sun.shadow.mapSize.x !== size) { this.sun.shadow.mapSize.set(size, size); if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; } }
  }

  update(dt, hour, wx, focus) {
    this.t += dt;
    const ang = ((hour - 6) / 24) * Math.PI * 2;
    const sy = Math.sin(ang);
    this.sunDir.set(Math.cos(ang) * 0.82, sy, 0.38).normalize();
    const sy2 = this.sunDir.y;
    const dayF = smoothstep(-0.1, 0.25, sy2);
    const night = 1 - smoothstep(-0.2, 0.08, sy2);
    this.dayF = dayF; this.night = night;
    const sunset = Math.exp(-Math.pow(sy2 / 0.2, 2)) * (sy2 > -0.2 ? 1 : 0);
    const cloud = wx.cur.cloud, fogW = wx.cur.fog, flash = wx.flash;

    let top = mixc([0.03, 0.05, 0.15], [0.14, 0.5, 1.0], dayF);
    let hor = mixc([0.09, 0.12, 0.25], [0.66, 0.85, 1.0], dayF);
    hor = mixc(hor, [1.0, 0.52, 0.28], sunset * 0.75);
    top = mixc(top, [1.0, 0.6, 0.45].map((v, i) => v * 0.6 + top[i] * 0.4), sunset * 0.25);
    const gray = dayF * 0.8 + (1 - dayF) * 0.08;
    top = mixc(top, [gray * 0.8, gray * 0.85, gray * 0.95], cloud * 0.75);
    hor = mixc(hor, [gray, gray * 1.02, gray * 1.06], cloud * 0.6 + fogW * 0.3);
    if (flash > 0) { top = mixc(top, [0.8, 0.85, 1], flash * 0.6); hor = mixc(hor, [0.85, 0.9, 1], flash * 0.6); }
    rgb(this.uniforms.uTop.value, top[0], top[1], top[2]);
    rgb(this.uniforms.uHor.value, hor[0], hor[1], hor[2]);
    const sc = mixc([1, 0.95, 0.85], [1, 0.55, 0.3], sunset);
    rgb(this.uniforms.uSunCol.value, sc[0], sc[1], sc[2]);
    this.uniforms.uSunDir.value.copy(this.sunDir);
    this.uniforms.uNight.value = night; this.uniforms.uCloud.value = Math.min(1, cloud + fogW * 0.5);

    // fog follows the horizon colour; density from view distance and weather
    const fog = this.scene.fog;
    fog.color.copy(this.uniforms.uHor.value);
    fog.density = (1.5 / this.viewDist) * (1 + fogW * 5.5) * (night > 0.5 ? 0.9 : 1);
    this.renderer.setClearColor(fog.color);

    // lights
    const moon = sy2 < -0.08;
    const dirv = moon ? this.sunDir.clone().multiplyScalar(-1) : this.sunDir;
    const sunI = 10.5 * dayF * (1 - 0.5 * cloud) * (1 - fogW * 0.3);
    const moonI = 3.0 * smoothstep(-0.08, -0.3, sy2) * (1 - cloud * 0.6);
    this.sun.intensity = moon ? moonI : sunI;
    const lc = moon ? [0.55, 0.65, 1] : mixc([1, 0.97, 0.9], [1, 0.6, 0.35], sunset);
    rgb(this.sun.color, lc[0], lc[1], lc[2]);
    this.sun.position.set(focus.x + dirv.x * 160, focus.y + dirv.y * 160 + 20, focus.z + dirv.z * 160);
    this.sun.target.position.set(focus.x, focus.y, focus.z);
    this.hemi.intensity = 1.5 + 4.0 * dayF * (1 - cloud * 0.15) + flash * 6;
    const hs = mixc([0.16, 0.22, 0.42], [0.8, 0.9, 1], dayF);
    rgb(this.hemi.color, hs[0], hs[1], hs[2]);
    rgb(this.hemi.groundColor, 0.4 * dayF + 0.08, 0.34 * dayF + 0.08, 0.26 * dayF + 0.09);

    // dome & clouds follow the camera
    const cp = this.camera.position;
    this.dome.position.copy(cp);
    const cc = mixc([0.25, 0.27, 0.34], [1, 1, 1], dayF);
    const cs = mixc(cc, [1, 0.65, 0.5], sunset * 0.6);
    this.cloudMat.color.setRGB(cs[0], cs[1], cs[2], THREE.SRGBColorSpace);
    this.cloudMat.opacity = clamp(0.25 + cloud * 0.7, 0, 0.95);
    const wind = 6 + cloud * 14;
    for (const s of this.clouds) {
      const u = s.userData;
      s.visible = u.k < 0.2 + 0.8 * cloud;
      u.a += (wind * dt) / u.d * 0.4;
      s.position.set(cp.x + Math.cos(u.a) * u.d, u.alt, cp.z + Math.sin(u.a) * u.d);
    }

    // water follows the camera (snapped so the texture does not swim)
    this.water.position.x = Math.round(cp.x / 40.9) * 40.9; this.water.position.z = Math.round(cp.z / 40.9) * 40.9;
    this.waterTex.offset.x = (this.t * 0.0008) % 1; this.waterTex.offset.y = (this.t * 0.0005) % 1;
    const wc = mixc([0.03, 0.08, 0.12], [0.17, 0.5, 0.66], dayF);
    this.water.material.color.setRGB(wc[0], wc[1], wc[2], THREE.SRGBColorSpace);

    // precipitation around the camera
    const rainI = wx.cur.rain, snowI = wx.cur.snow;
    this.rain.visible = rainI > 0.05; this.snow.visible = snowI > 0.05;
    if (this.rain.visible) {
      const n = Math.floor(this.RN * Math.min(1, rainI)), st = this.rainState, p = this.rainPos;
      for (let i = 0; i < n; i++) {
        let y = st[i * 3 + 1] - dt * 32; if (y < 0) { y += 28; st[i * 3] = (Math.random() - 0.5) * 50; st[i * 3 + 2] = (Math.random() - 0.5) * 50; }
        st[i * 3 + 1] = y;
        const x = cp.x + st[i * 3], z = cp.z + st[i * 3 + 2], yy = cp.y - 8 + y;
        p[i * 6] = x; p[i * 6 + 1] = yy; p[i * 6 + 2] = z;
        p[i * 6 + 3] = x + 0.05; p[i * 6 + 4] = yy + 0.9; p[i * 6 + 5] = z;
      }
      this.rain.geometry.setDrawRange(0, n * 2);
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.material.opacity = 0.25 + 0.25 * rainI;
    }
    if (this.snow.visible) {
      const n = Math.floor(this.SN * Math.min(1, snowI)), st = this.snowSeed, p = this.snowPos;
      for (let i = 0; i < n; i++) {
        let y = st[i * 3 + 1] - dt * 2.2; if (y < 0) y += 25;
        st[i * 3 + 1] = y;
        p[i * 3] = cp.x + st[i * 3] + Math.sin(this.t * 0.7 + i) * 0.6; p[i * 3 + 1] = cp.y - 8 + y; p[i * 3 + 2] = cp.z + st[i * 3 + 2] + Math.cos(this.t * 0.5 + i * 1.3) * 0.6;
      }
      this.snow.geometry.setDrawRange(0, n);
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
  }
}
