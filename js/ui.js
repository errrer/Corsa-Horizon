// HUD, minimap, full map, menus (garage, autoshow, events, wheelspin, repo town, stats, settings), photo mode.
import { CARS, carById, PAINTS, UPGRADES, upgradePrice, AWD_PRICE } from './cars.js';
import { deriveSpec, computePI, classOf } from './physics.js';
import { TYPES, poisInRect } from './events.js';
import { heightAt, surfaceAt, SURF, SURF_NAME, S, world } from './terrain.js';
import { fmtNum, fmtTime, fmtClock, clamp } from './util.js';
import { ACHIEVEMENTS, xpForNext, SETTINGS_DEFAULT } from './save.js';
import { STATIONS } from './audio.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hexCss = (h) => '#' + h.toString(16).padStart(6, '0');
const WX_NAME = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', fog: 'Fog', snow: 'Snow' };
const SURF_COL = [[44, 44, 50], [150, 112, 66], [76, 140, 62], [222, 200, 140], [122, 118, 112], [240, 242, 247], [44, 100, 160]];

export class UI {
  constructor(game) {
    this.g = game; this.tab = 'map'; this.menuOpen = false; this.toasts = []; this.mapView = null; this.mapImg = null;
    this.el = { speed: $('speed'), gear: $('gear'), unit: $('unit'), nitro: $('nitroFill'), credits: $('credits'), lvl: $('lvl'), xp: $('xpFill'), clock: $('clock'), wx: $('wxIcon'), road: $('roadName'), prompt: $('prompt'), ev: $('evhud'), compass: $('compass'), spins: $('spinsBadge'), carName: $('carName') };
    this.gauge = $('gauge').getContext('2d');
    this.mini = $('mini').getContext('2d');
    // minimap terrain cache, filled a few rows per frame
    this.mm = { N: 44, span: 520, buf: document.createElement('canvas'), tmp: document.createElement('canvas'), row: 99, cx: 0, cz: 0, ready: false };
    this.mm.buf.width = this.mm.buf.height = this.mm.tmp.width = this.mm.tmp.height = this.mm.N;
    this.mm.data = this.mm.tmp.getContext('2d').createImageData(this.mm.N, this.mm.N);
    this.hintT = 0; this.cdTimer = 0;
    $('menuBody').addEventListener('click', (e) => this.onClick(e));
    $('menuBody').addEventListener('input', (e) => this.onInput(e));
    $('menuBody').addEventListener('change', (e) => this.onInput(e));
    $('tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) { this.tab = t.dataset.tab; this.renderMenu(); this.g.audio.blip('ui'); } });
    $('overlay').addEventListener('click', (e) => this.onOverlay(e));
    $('photo').addEventListener('click', (e) => this.onPhoto(e));
  }

  // ---------- transient messages ----------
  toast(msg, kind = 'info') {
    const box = $('toasts'), d = document.createElement('div');
    d.className = 'toast ' + kind; d.textContent = msg; box.appendChild(d);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => d.remove(), 3200);
  }
  banner(t, s) {
    $('bnT').textContent = t; $('bnS').textContent = s || ''; const b = $('banner');
    b.classList.remove('hidden'); b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
    clearTimeout(this.bnT); this.bnT = setTimeout(() => b.classList.add('hidden'), 4200);
  }
  countdown(txt) { const c = $('countdown'); c.textContent = txt; c.classList.remove('show'); void c.offsetWidth; c.classList.add('show'); }
  levelUp(lv) { this.toast(`LEVEL UP! You are now level ${lv}`, 'level'); this.g.audio.blip('level'); }

  // ---------- HUD ----------
  hud(c, dt, time) {
    const g = this.g, st = g.state, set = st.settings, mph = set.units === 'mph';
    const sp = c.kmh * (mph ? 0.621371 : 1);
    this.el.speed.textContent = Math.round(sp);
    this.el.unit.textContent = mph ? 'MPH' : 'KM/H';
    this.el.gear.textContent = c.reverse && c.u < 0.5 ? 'R' : c.speed < 0.5 && c.rpm < 1200 ? 'N' : String(c.gear + 1);
    this.el.nitro.style.width = (c.nitro * 100).toFixed(0) + '%';
    this.el.nitro.style.filter = c.nitroOn ? 'brightness(1.8)' : '';
    this.el.credits.textContent = fmtNum(st.credits) + ' CR';
    this.el.lvl.textContent = 'LV ' + st.level;
    this.el.xp.style.width = (100 * st.xp / xpForNext(st.level)).toFixed(1) + '%';
    this.el.clock.textContent = fmtClock(g.hour);
    this.el.wx.textContent = (WX_NAME[g.weather.type] || '') + (world.season === 'winter' ? ' · Winter' : world.season === 'autumn' ? ' · Autumn' : world.season === 'spring' ? ' · Spring' : '');
    this.el.road.textContent = c.inWater ? 'Water' : SURF_NAME[c.surf] + ' · ' + Math.round(c.y) + ' m';
    this.el.carName.textContent = g.carSpec.name + '  ' + g.carSpec.cls + ' ' + g.carSpec.pi;
    if (st.wheelspins > 0) { this.el.spins.classList.remove('hidden'); this.el.spins.textContent = st.wheelspins + ' wheelspin' + (st.wheelspins > 1 ? 's' : ''); } else this.el.spins.classList.add('hidden');
    // compass
    const deg = ((Math.atan2(Math.sin(c.yaw), Math.cos(c.yaw)) * 180) / Math.PI + 360) % 360;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let wp = '';
    if (g.waypoint) wp = `  ·  Waypoint ${Math.round(Math.hypot(g.waypoint.x - c.x, g.waypoint.z - c.z))} m`;
    this.el.compass.textContent = dirs[Math.round(deg / 45) % 8] + ' ' + Math.round(deg) + '°' + wp;
    this.drawGauge(c);
    this.updateSkill();
    this.updateEvHud();
    // prompt
    let pr = '';
    if (g.mode === 'play') {
      if (g.events.near && !g.events.race) pr = `Press <b>ENTER</b> to start<br>${esc(g.events.near.name)} <span class="mut">(${TYPES[g.events.near.type].label})</span>`;
      else if (g.repoTown.near) { const r = g.repoTown.near.repo; pr = `Press <b>E</b> to enter<br>${esc(r.name)}`; }
      else if (g.nearSpin) pr = 'Press <b>E</b> to open Wheelspin';
    }
    if (pr !== this.lastPr) { this.lastPr = pr; if (pr) { this.el.prompt.innerHTML = pr; this.el.prompt.classList.remove('hidden'); } else this.el.prompt.classList.add('hidden'); }
    // hints
    if (set.hints) {
      this.hintT += dt;
      const hints = ['W/S throttle & brake · A/D steer · Space handbrake to drift · Shift nitro', 'Drive into the glowing beams to find races & challenges', 'Hold G to rewind time · C changes camera · M opens the map', 'Visit the plaza to find Iron Strike and NodeNGW'];
      if (this.hintT > 14) { this.hintT = 0; }
      $('hint').textContent = this.hintT < 9 && g.time < 300 ? hints[Math.floor(g.time / 14) % hints.length] : '';
    } else $('hint').textContent = '';
    $('rewind').classList.toggle('hidden', !g.rewinding);
    $('radio').classList.toggle('hidden', this.radioT <= 0 || this.radioT === undefined);
    if (this.radioT > 0) this.radioT -= dt;
  }
  showRadio(name) { $('radio').textContent = '♪ ' + name; this.radioT = 3.2; }
  drawGauge(c) {
    const x = this.gauge, W = 260, cx = 130, cy = 130, r = 108;
    x.clearRect(0, 0, W, W);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, f = clamp((c.rpm - 900) / (c.redline - 900), 0, 1);
    x.lineWidth = 14; x.lineCap = 'round';
    x.strokeStyle = 'rgba(13,17,23,.75)'; x.beginPath(); x.arc(cx, cy, r, a0, a1); x.stroke();
    const red = f > 0.88;
    const grad = x.createLinearGradient(20, 0, 240, 0); grad.addColorStop(0, '#3fb950'); grad.addColorStop(0.65, '#e3b341'); grad.addColorStop(1, '#f85149');
    x.strokeStyle = c.nitroOn ? '#79c0ff' : grad; x.beginPath(); x.arc(cx, cy, r, a0, a0 + (a1 - a0) * f); x.stroke();
    x.lineWidth = 2; x.strokeStyle = 'rgba(255,255,255,.35)';
    for (let i = 0; i <= 8; i++) { const a = a0 + ((a1 - a0) * i) / 8; x.beginPath(); x.moveTo(cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14)); x.lineTo(cx + Math.cos(a) * (r - 22), cy + Math.sin(a) * (r - 22)); x.stroke(); }
    if (red) { x.fillStyle = '#f85149'; x.beginPath(); x.arc(cx, cy - 76, 4, 0, 6.3); x.fill(); }
    if (c.tcsOn) { x.fillStyle = '#e3b341'; x.font = 'bold 11px system-ui'; x.fillText('TCS', 62, 232); }
  }
  updateSkill() {
    const s = this.g.skill, box = $('skill');
    if (s.base <= 0) { if (!box.classList.contains('hidden')) box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    $('skScore').textContent = fmtNum(s.base * s.mult);
    $('skMult').textContent = s.mult > 1 ? '×' + s.mult : '';
    $('skFill').style.width = (100 * clamp(s.timer / 3, 0, 1)) + '%';
    $('skLines').textContent = s.lines.slice(-3).join('  ·  ');
  }
  updateEvHud() {
    const h = this.g.events.hud, el = this.el.ev;
    if (!h) { if (!el.classList.contains('hidden')) el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    let html = '';
    if (h.kind === 'race') {
      const place = `${h.pos}<small>/${h.total}</small>`;
      html = `<div class="ev-title">${esc(h.name)}</div><div class="ev-big">${h.pos}<span class="mut" style="font-size:16px">/${h.total}</span> &nbsp; ${fmtTime(h.time)}</div><div class="ev-row"><span>CP ${h.cp}/${h.cps}</span>${h.laps ? `<span>Lap ${h.lap}/${h.laps}</span>` : ''}<span class="mut">${h.rivals.map(esc).join(', ')}</span></div><div class="ev-bar"><i style="width:${(h.pct * 100).toFixed(0)}%"></i></div>`;
    } else {
      const pips = (h.tiers || []).map((t, i) => `<span>${'★'.repeat(i + 1)} ${fmtNum(t)}</span>`).join('');
      html = `<div class="ev-title">${esc(h.title)}</div><div class="ev-big">${esc(h.line)}</div><div class="ev-row mut">${pips}</div>${h.pct !== undefined ? `<div class="ev-bar"><i style="width:${(h.pct * 100).toFixed(0)}%"></i></div>` : ''}`;
    }
    if (html !== this.lastEv) { this.lastEv = html; el.innerHTML = html; }
  }

  // ---------- minimap ----------
  stepMinimap(c) {
    const m = this.mm, N = m.N;
    if (m.row >= N) {
      // finished: publish, restart around the car every so often
      if (!m.ready || Math.hypot(c.x - m.cx, c.z - m.cz) > 70 || m.age > 3) {
        if (m.row === N && m.cx !== undefined && m.fill) { m.tmp.getContext('2d').putImageData(m.data, 0, 0); const bc = m.buf.getContext('2d'); bc.clearRect(0, 0, N, N); bc.drawImage(m.tmp, 0, 0); m.ready = true; m.pubX = m.cx; m.pubZ = m.cz; m.fill = false; }
        m.cx = c.x; m.cz = c.z; m.row = 0; m.fill = true; m.age = 0;
      } else m.age += 1 / 60;
      if (m.row >= N) return;
    }
    const d = m.data.data;
    for (let k = 0; k < 5 && m.row < N; k++, m.row++) {
      const j = m.row;
      for (let i = 0; i < N; i++) {
        const x = m.cx + ((i + 0.5) / N - 0.5) * m.span, z = m.cz + ((j + 0.5) / N - 0.5) * m.span;
        const h = heightAt(x, z), s = surfaceAt(x, z, h);
        const col = SURF_COL[s], sh = s === SURF.ASPHALT || s === SURF.WATER ? 1 : clamp(0.78 + h / 220, 0.6, 1.15), o = (j * N + i) * 4;
        d[o] = col[0] * sh; d[o + 1] = col[1] * sh; d[o + 2] = col[2] * sh; d[o + 3] = 255;
      }
    }
    if (m.row >= N && m.fill) { m.row = N; }
  }
  drawMinimap(c, time) {
    this.stepMinimap(c);
    const x = this.mini, W = 220, m = this.mm, g = this.g;
    x.save(); x.clearRect(0, 0, W, W);
    x.beginPath(); x.arc(110, 110, 108, 0, 6.3); x.clip();
    x.fillStyle = '#10151c'; x.fillRect(0, 0, W, W);
    const scale = W / 330; // px per metre (zoomed in on the 520 m texture)
    x.translate(110, 110); x.rotate(c.yaw + Math.PI); // forward = up
    x.save();
    if (m.ready) { x.imageSmoothingEnabled = true; x.translate((m.pubX - c.x) * scale, (m.pubZ - c.z) * scale); x.drawImage(m.buf, -m.span / 2 * scale, -m.span / 2 * scale, m.span * scale, m.span * scale); }
    x.restore();
    // world axes: +x right, +z down on texture; rotation above keeps heading up (yaw measured from +z)
    const rect = 330 * 0.75;
    const pois = poisInRect(c.x - rect, c.z - rect, c.x + rect, c.z + rect);
    for (const p of pois) {
      if (p.type === 'board' || (!g.state.discovered[p.id] && p.type !== 'sprint' && p.type !== 'circuit' && p.type !== 'cross')) continue;
      this.drawPoi(x, (p.x - c.x) * scale, (p.z - c.z) * scale, p, 7, g.state.done[p.id]);
    }
    const f = world.festival; this.drawPoi(x, (f.x - c.x) * scale, (f.z - c.z) * scale, { type: 'sprint', special: 'F' }, 8);
    if (g.waypoint) {
      const dx = g.waypoint.x - c.x, dz = g.waypoint.z - c.z, d = Math.hypot(dx, dz), k = Math.min(1, 95 / (d * scale || 1));
      x.fillStyle = '#e3b341'; x.beginPath(); x.arc(dx * scale * k, dz * scale * k, 6, 0, 6.3); x.fill();
    }
    for (const r of g.events.rivalsList()) { x.fillStyle = '#f85149'; x.beginPath(); x.arc((r.x - c.x) * scale, (r.z - c.z) * scale, 3.5, 0, 6.3); x.fill(); }
    x.restore();
    // player arrow (screen space, always up)
    x.save(); x.translate(110, 110); x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(0, -11); x.lineTo(8, 9); x.lineTo(0, 5); x.lineTo(-8, 9); x.closePath(); x.stroke(); x.fill(); x.restore();
  }
  drawPoi(x, px, pz, p, r, done) {
    const T = TYPES[p.type]; x.save(); x.translate(px, pz); x.rotate(-this.g.car.yaw - Math.PI);
    x.fillStyle = '#0d1117'; x.strokeStyle = p.special ? '#3fb950' : T.color; x.lineWidth = 2.5; x.beginPath(); x.arc(0, 0, r, 0, 6.3); x.fill(); x.stroke();
    x.fillStyle = p.special ? '#3fb950' : T.color; x.font = `bold ${r + 1}px system-ui`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(p.special || T.icon, 0, 1);
    if (done && done.stars) { x.fillStyle = '#e3b341'; x.fillRect(-r, r + 1, 2 * r * Math.min(1, done.stars / 3), 2); }
    x.restore();
  }

  // ---------- menu ----------
  openMenu(tab) {
    this.menuOpen = true; if (tab) this.tab = tab; $('menu').classList.remove('hidden'); this.renderMenu(); this.g.onMenu(true);
  }
  closeMenu() { this.menuOpen = false; $('menu').classList.add('hidden'); this.g.onMenu(false); this.g.save(); }
  renderMenu() {
    const tabs = [['map', 'Map'], ['events', 'Festival'], ['garage', 'Garage'], ['shop', 'Autoshow'], ['spin', 'Wheelspin'], ['repos', 'Games'], ['online', 'Online'], ['stats', 'Progress'], ['settings', 'Settings'], ['help', 'Controls']];
    $('tabs').innerHTML = tabs.map(([k, n]) => `<div class="tab ${k === this.tab ? 'on' : ''}" data-tab="${k}">${n}</div>`).join('') + '<div style="flex:1"></div><div class="tab" data-tab="__close" id="closeTab">✕ Resume</div>';
    $('closeTab').onclick = (e) => { e.stopPropagation(); this.closeMenu(); };
    const body = $('menuBody');
    const fn = { map: this.tMap, events: this.tEvents, garage: this.tGarage, shop: this.tShop, spin: this.tSpin, repos: this.tRepos, online: this.tOnline, stats: this.tStats, settings: this.tSettings, help: this.tHelp }[this.tab] || this.tMap;
    this.mapC = null;
    body.innerHTML = '';
    fn.call(this, body);
  }
  statBar(label, v, max) { return `<div class="stat"><span>${label}</span><div><i style="width:${clamp(100 * v / max, 0, 100)}%"></i></div></div>`; }
  carCard(spec, extra, selected) {
    const st = this.g.state, own = st.cars[spec.id], up = own ? own.up : {}, d = deriveSpec(spec, up), pi = computePI(d), cls = classOf(pi);
    return `<div class="card ${selected ? 'sel' : ''}"><h4>${esc(spec.name)}</h4><div class="sub"><span class="pill ${cls}">${cls} ${pi}</span>${esc(spec.drive)} · ${spec.cyl} cyl</div>
      ${this.statBar('Speed', d.top, 420)}${this.statBar('Power', d.kw / d.mass * 1000, 700)}${this.statBar('Handling', d.mu * 100, 160)}${this.statBar('Off-road', spec.offroad * 100, 100)}
      <div class="mut" style="font-size:12px;margin:6px 0">${esc(spec.desc)}</div>${extra}</div>`;
  }

  tMap(body) {
    const g = this.g, c = g.car;
    body.innerHTML = `<div id="mapWrap"><canvas id="mapC"></canvas><div class="maptools"><button class="btn small" data-act="zoomIn">＋</button><button class="btn small" data-act="zoomOut">－</button><button class="btn small" data-act="mapHome">Centre on me</button><button class="btn small" data-act="clearWp">Clear waypoint</button><button class="btn small" data-act="resetRoad">Reset to road</button><div class="maptip" id="mapTip">Drag to pan · click to set a waypoint · click an icon for details</div></div></div>`;
    this.mapC = $('mapC'); const cv = this.mapC;
    this.mapView = this.mapView || { cx: c.x, cz: c.z, span: 3600 };
    this.mapView.cx = c.x; this.mapView.cz = c.z; this.mapSel = null;
    requestAnimationFrame(() => {
      cv.width = cv.clientWidth * Math.min(2, devicePixelRatio || 1); cv.height = cv.clientHeight * Math.min(2, devicePixelRatio || 1);
      this.renderMapImage(); this.drawMap();
    });
    let drag = null;
    cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cx: this.mapView.cx, cz: this.mapView.cz, moved: false }; cv.style.cursor = 'grabbing'; };
    cv.onpointermove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      const mpp = this.mapView.span / cv.clientWidth; this.mapView.cx = drag.cx - dx * mpp; this.mapView.cz = drag.cz - dy * mpp;
      this.drawMap(true);
    };
    cv.onpointerup = (e) => {
      cv.style.cursor = 'grab'; if (!drag) return;
      if (!drag.moved) this.mapClick(e); else { this.renderMapImage(); this.drawMap(); }
      drag = null;
    };
    cv.onwheel = (e) => { e.preventDefault(); this.zoomMap(e.deltaY > 0 ? 1.25 : 0.8); };
  }
  zoomMap(k) { this.mapView.span = clamp(this.mapView.span * k, 600, 14000); this.renderMapImage(); this.drawMap(); }
  renderMapImage() {
    const cv = this.mapC; if (!cv) return;
    const v = this.mapView, N = 130, img = document.createElement('canvas'); img.width = img.height = N;
    const ictx = img.getContext('2d'), data = ictx.createImageData(N, N), d = data.data, ar = cv.width / cv.height;
    const spanZ = v.span / ar;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = v.cx + ((i + 0.5) / N - 0.5) * v.span * 1.6, z = v.cz + ((j + 0.5) / N - 0.5) * spanZ * 1.6;
      const h = heightAt(x, z), s = surfaceAt(x, z, h), col = SURF_COL[s], sh = s === SURF.ASPHALT || s === SURF.WATER ? 1 : clamp(0.75 + h / 200, 0.6, 1.2), o = (j * N + i) * 4;
      d[o] = col[0] * sh; d[o + 1] = col[1] * sh; d[o + 2] = col[2] * sh; d[o + 3] = 255;
    }
    ictx.putImageData(data, 0, 0); this.mapImg = { img, cx: v.cx, cz: v.cz, span: v.span, spanZ };
  }
  m2s(x, z) { const v = this.mapView, cv = this.mapC; return [(x - v.cx) / v.span * cv.width + cv.width / 2, (z - v.cz) / (v.span * cv.height / cv.width) * cv.height + cv.height / 2]; }
  drawMap(fast) {
    const cv = this.mapC; if (!cv) return; const x = cv.getContext('2d'), v = this.mapView, g = this.g, W = cv.width, H = cv.height;
    x.fillStyle = '#0b0f14'; x.fillRect(0, 0, W, H);
    const mi = this.mapImg;
    if (mi) {
      const w = (mi.span * 1.6 / v.span) * W, h = (mi.spanZ * 1.6 / (v.span * H / W)) * H, [px, pz] = this.m2s(mi.cx, mi.cz);
      x.imageSmoothingEnabled = true; x.drawImage(mi.img, px - w / 2, pz - h / 2, w, h);
    }
    // grid
    const pois = poisInRect(v.cx - v.span, v.cz - v.span, v.cx + v.span, v.cz + v.span), unit = Math.max(W / 900, 0.9);
    const c = g.car;
    for (const p of pois) {
      if (p.type === 'board') continue;
      const near = Math.hypot(p.x - c.x, p.z - c.z) < S * 2.2;
      if (!near && !g.state.discovered[p.id]) continue;
      if (p.type === 'barn' && !g.state.barns[p.id]) { if (!(g.state.discovered[p.id])) continue; }
      const [sx, sz] = this.m2s(p.x, p.z); if (sx < -20 || sz < -20 || sx > W + 20 || sz > H + 20) continue;
      this.drawMapIcon(x, sx, sz, p, 11 * unit, g.state.done[p.id], this.mapSel === p);
    }
    const f = world.festival, [fx, fz] = this.m2s(f.x, f.z); this.drawMapIcon(x, fx, fz, { type: 'sprint', special: 'F', name: 'Festival' }, 13 * unit);
    for (const it of g.repoTown.items.slice(0, 0)) { /* repo town buildings are shown only in the town tab */ }
    if (g.waypoint) { const [wx, wz] = this.m2s(g.waypoint.x, g.waypoint.z); x.fillStyle = '#e3b341'; x.strokeStyle = '#000'; x.lineWidth = 2; x.beginPath(); x.arc(wx, wz, 8 * unit, 0, 6.3); x.fill(); x.stroke(); }
    const [cx, cz] = this.m2s(c.x, c.z); x.save(); x.translate(cx, cz); x.rotate(-c.yaw + Math.PI); x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(0, -13 * unit); x.lineTo(9 * unit, 10 * unit); x.lineTo(0, 5 * unit); x.lineTo(-9 * unit, 10 * unit); x.closePath(); x.stroke(); x.fill(); x.restore();
  }
  drawMapIcon(x, sx, sz, p, r, done, sel) {
    const T = TYPES[p.type];
    x.fillStyle = '#0d1117'; x.strokeStyle = p.special ? '#3fb950' : T.color; x.lineWidth = sel ? 5 : 3; x.beginPath(); x.arc(sx, sz, r, 0, 6.3); x.fill(); x.stroke();
    x.fillStyle = p.special ? '#3fb950' : T.color; x.font = `bold ${r * 1.1}px system-ui`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(p.special || T.icon, sx, sz + 1);
    if (done && done.stars) { x.fillStyle = '#e3b341'; x.font = `bold ${r * 0.8}px system-ui`; x.fillText('★'.repeat(Math.min(3, done.stars)), sx, sz + r + 6); }
  }
  mapClick(e) {
    const cv = this.mapC, rect = cv.getBoundingClientRect(), sx = (e.clientX - rect.left) * (cv.width / rect.width), sz = (e.clientY - rect.top) * (cv.height / rect.height), v = this.mapView, g = this.g;
    let best = null, bd = 22 * (cv.width / 900);
    for (const p of poisInRect(v.cx - v.span, v.cz - v.span, v.cx + v.span, v.cz + v.span)) {
      if (p.type === 'board') continue; const [px, pz] = this.m2s(p.x, p.z), d = Math.hypot(px - sx, pz - sz); if (d < bd) { bd = d; best = p; }
    }
    const tip = $('mapTip');
    if (best) {
      this.mapSel = best; const T = TYPES[best.type], dn = g.state.done[best.id];
      tip.innerHTML = `<b style="color:${T.color}">${esc(best.name)}</b> · ${T.label}${dn ? ` · ${'★'.repeat(dn.stars || 0)}` : ''} &nbsp; <button class="btn small" data-act="wp" data-x="${best.x}" data-z="${best.z}">Set waypoint</button> <button class="btn small primary" data-act="travel" data-x="${best.x}" data-z="${best.z}">Fast travel</button>`;
    } else {
      const wx = v.cx + (sx / cv.width - 0.5) * v.span, wz = v.cz + (sz / cv.height - 0.5) * v.span * cv.height / cv.width;
      g.waypoint = { x: wx, z: wz }; this.mapSel = null; tip.textContent = 'Waypoint set.'; g.audio.blip('ui');
    }
    this.drawMap();
  }

  tEvents(body) {
    const g = this.g, st = g.state, c = g.car, list = [];
    for (const p of poisInRect(c.x - S * 4, c.z - S * 4, c.x + S * 4, c.z + S * 4)) {
      if (p.type === 'board' || p.type === 'barn') continue; if (!st.discovered[p.id] && Math.hypot(p.x - c.x, p.z - c.z) > S * 2.2) continue;
      list.push({ p, d: Math.hypot(p.x - c.x, p.z - c.z) });
    }
    list.sort((a, b) => a.d - b.d);
    const done = Object.values(st.done).length;
    body.innerHTML = `<h3>Festival events <span class="mut" style="font-size:13px">${done} completed · ${Object.keys(st.boards).length} boards · ${Object.keys(st.barns).length} barn finds</span></h3>
    <div class="row"><button class="btn" data-act="travel" data-x="${world.festival.x - 60}" data-z="${world.festival.z}">Fast travel to the Festival</button><button class="btn" data-act="resetRoad">Reset car to road</button></div>
    <div class="grid">${list.slice(0, 40).map(({ p, d }) => {
      const T = TYPES[p.type], dn = st.done[p.id], extra = p.tiers ? `<div class="mut" style="font-size:12px">★ ${fmtNum(p.tiers[0])} · ★★ ${fmtNum(p.tiers[1])} · ★★★ ${fmtNum(p.tiers[2])}</div>` : `<div class="mut" style="font-size:12px">Reward up to ${fmtNum(p.credits || 0)} CR</div>`;
      return `<div class="card"><h4 style="color:${T.color}">${esc(p.name)}</h4><div class="sub">${T.label} · difficulty ${'●'.repeat(p.diff || 1)}${dn ? ' · ' + '★'.repeat(dn.stars || 0) : ''}${dn && dn.bestT ? ' · best ' + fmtTime(dn.bestT) : ''}</div>${extra}<div class="row sp"><span class="mut">${(d / 1000).toFixed(1)} km</span><span><button class="btn small" data-act="wp" data-x="${p.x}" data-z="${p.z}">Waypoint</button> <button class="btn small primary" data-act="travel" data-x="${p.x}" data-z="${p.z}">Travel</button></span></div></div>`;
    }).join('') || '<div class="mut">Drive around to discover events.</div>'}</div>`;
  }

  tGarage(body) {
    const g = this.g, st = g.state, cur = st.cars[st.current], spec = carById(st.current), d = deriveSpec(spec, cur.up);
    const owned = Object.keys(st.cars).map(carById);
    body.innerHTML = `<div class="row sp"><h3>Garage</h3><span class="gold">${fmtNum(st.credits)} CR</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">${owned.map((s) => `<div data-act="pick" data-id="${s.id}" style="cursor:pointer">${this.carCard(s, '', s.id === st.current)}</div>`).join('')}</div>
    <h3 style="margin-top:18px">${esc(spec.name)} <span class="pill ${classOf(computePI(d))}">${classOf(computePI(d))} ${computePI(d)}</span></h3>
    <div class="row"><span class="mut">Paint</span><div class="swatches">${PAINTS.map((p) => `<div class="sw ${cur.color === p ? 'on' : ''}" style="background:${hexCss(p)}" data-act="paint" data-c="${p}"></div>`).join('')}</div></div>
    ${UPGRADES.map((u) => { const lv = cur.up[u.key] || 0, price = upgradePrice(spec, u.key, lv); return `<div class="up"><div class="nm"><b>${u.name}</b><div class="mut" style="font-size:12px">${u.desc}</div></div><div class="pips">${[0, 1, 2, 3].map((i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</div><button class="btn small ${lv < 4 ? 'primary' : ''}" data-act="upgrade" data-k="${u.key}" ${lv >= 4 || st.credits < price ? 'disabled' : ''}>${lv >= 4 ? 'MAX' : fmtNum(price) + ' CR'}</button></div>`; }).join('')}
    ${spec.drive !== 'AWD' ? `<div class="up"><div class="nm"><b>All-wheel drive conversion</b><div class="mut" style="font-size:12px">More traction off the line and on loose surfaces</div></div><button class="btn small primary" data-act="upgrade" data-k="drive" ${cur.up.drive || st.credits < AWD_PRICE(spec) ? 'disabled' : ''}>${cur.up.drive ? 'Installed' : fmtNum(AWD_PRICE(spec)) + ' CR'}</button></div>` : ''}
    ${Object.keys(st.cars).length > 1 ? `<div class="row"><button class="btn danger small" data-act="sell" data-id="${st.current}">Sell this car (${fmtNum(Math.round(spec.price * 0.45))} CR)</button></div>` : ''}`;
  }
  tShop(body) {
    const st = this.g.state;
    body.innerHTML = `<div class="row sp"><h3>Autoshow</h3><span class="gold">${fmtNum(st.credits)} CR</span></div><div class="grid">${CARS.map((s) => {
      const own = st.cars[s.id]; return this.carCard(s, `<div class="row sp"><span class="gold">${s.price ? fmtNum(s.price) + ' CR' : 'Free'}</span>${own ? '<span class="green">Owned</span>' : `<button class="btn small primary" data-act="buy" data-id="${s.id}" ${st.credits < s.price ? 'disabled' : ''}>Buy</button>`}</div>`, false);
    }).join('')}</div>`;
  }
  tSpin(body) {
    const st = this.g.state;
    body.innerHTML = `<h3>Wheelspin</h3><p class="mut">Earn wheelspins by levelling up and winning races for the first time. Prizes: credits, XP, and rare cars.</p>
    <div class="ov" style="margin:0 auto;max-width:560px"><div class="big">${st.wheelspins}</div><div class="mut">wheelspins available</div><div style="margin-top:14px"><button class="btn big" data-act="spin" ${st.wheelspins ? '' : 'disabled'}>Spin!</button></div></div>`;
  }
  tRepos(body) {
    const rt = this.g.repoTown;
    body.innerHTML = `<h3>Games</h3><p class="mut">The two big buildings in the festival plaza are the real games. Drive up to a door and press E, or open them from here.</p>
    <div class="grid">${rt.repos.map((r) => `<div class="card"><h4>${esc(r.name)}</h4><div class="sub">${esc(r.lang || '')}${this.g.state.repos[r.name] ? ' · visited' : ''}</div><div class="mut" style="font-size:13px;min-height:40px">${esc(r.desc)}</div><div class="row">${rt.siteUrl(r) ? `<a class="btn small primary" href="${esc(rt.siteUrl(r))}" target="_blank" rel="noopener">Play</a>` : ''}${r.url ? `<a class="btn small" href="${esc(r.url)}" target="_blank" rel="noopener">Repository</a>` : ''}</div></div>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn" data-act="travel" data-x="${world.festival.x + 130}" data-z="${world.festival.z}">Drive to the plaza</button></div>`;
  }
  tOnline(body) {
    const n = this.g.net, set = this.g.state.settings;
    body.innerHTML = `<h3>Horizon World server</h3><p class="mut">Everyone plays in one shared open world, up to 20 drivers per server. You are connected automatically when you start driving; if a server is full you roll over to the next one. Online play needs the game running from a normal website such as GitHub Pages.</p>
    <label class="set">Your name <input type="text" data-set="name" maxlength="16" value="${esc(set.name || 'Racer')}" style="width:180px"></label>
    <div class="row"><button class="btn primary" data-act="joinRoom">Connect</button> <button class="btn danger" data-act="leaveRoom">Go offline</button></div>
    <div id="netStatus" class="gold" style="margin:12px 0;font-weight:700"></div><div id="netList"></div>`;
    this.refreshOnline();
  }
  refreshOnline() {
    const s = $('netStatus'), l = $('netList'), n = this.g.net; if (!s || !n) return;
    s.textContent = n.status;
    l.innerHTML = n.online ? '<h4>Players</h4>' + n.list().map((p) => `<div class="card" style="padding:8px 14px;margin:4px 0">${esc(p.name)}</div>`).join('') : '';
  }
  tStats(body) {
    const st = this.g.state, s = st.stats, ach = ACHIEVEMENTS.map((a) => ({ a, ok: !!st.ach[a.id] }));
    body.innerHTML = `<h3>Progress</h3><div class="kv"><div><small>Level</small><b>${st.level}</b></div><div><small>Distance</small><b>${s.km.toFixed(1)} km</b></div><div><small>Top speed</small><b>${Math.round(s.topKmh)} km/h</b></div><div><small>Races won</small><b>${s.wins}/${s.races}</b></div><div><small>Drift points</small><b>${fmtNum(s.driftPts)}</b></div><div><small>Longest jump</small><b>${Math.round(s.maxJump)} m</b></div><div><small>Best skill chain</small><b>${fmtNum(s.skillBest)}</b></div><div><small>Near misses</small><b>${s.nearMiss}</b></div><div><small>Cars owned</small><b>${Object.keys(st.cars).length}/${CARS.length}</b></div><div><small>Play time</small><b>${Math.round(s.playTime / 60)} min</b></div></div>
    <h3>Achievements ${ach.filter((x) => x.ok).length}/${ach.length}</h3><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))">${ach.map(({ a, ok }) => `<div class="ach ${ok ? 'done' : ''}"><span>${ok ? '🏆' : '🔒'}</span><div><b>${a.name}</b><span class="mut">${a.desc}</span></div></div>`).join('')}</div>`;
  }
  tSettings(body) {
    const set = this.g.state.settings, sel = (k, opts) => `<select data-set="${k}">${opts.map(([v, n]) => `<option value="${v}" ${String(set[k]) === String(v) ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    const rng = (k, min, max, step) => `<input type="range" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${set[k]}">`;
    const chk = (k) => `<input type="checkbox" data-set="${k}" ${set[k] ? 'checked' : ''}>`;
    body.innerHTML = `<h3>Settings</h3>
    <label class="set">Graphics quality ${sel('quality', [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']])}</label>
    <label class="set">Traffic density ${sel('traffic', [[0, 'Off'], [1, 'Light'], [2, 'Normal'], [3, 'Heavy']])}</label>
    <label class="set">Units ${sel('units', [['kmh', 'km/h'], ['mph', 'mph']])}</label>
    <label class="set">Time of day ${sel('tod', [['real', 'Real clock'], ['cycle', 'Fast cycle (24 min day)'], ['6.5', 'Sunrise'], ['12', 'Noon'], ['18.2', 'Sunset'], ['23', 'Night']])}</label>
    <label class="set">Weather ${sel('weather', [['auto', 'Dynamic'], ['clear', 'Clear'], ['cloudy', 'Cloudy'], ['rain', 'Rain'], ['storm', 'Thunderstorm'], ['fog', 'Fog'], ['snow', 'Snow']])}</label>
    <label class="set">Season ${sel('season', [['auto', 'Automatic (real date)'], ['summer', 'Summer'], ['spring', 'Spring'], ['autumn', 'Autumn'], ['winter', 'Winter']])}</label>
    <label class="set">Opponent difficulty ${sel('difficulty', [[0, 'Relaxed'], [1, 'Normal'], [2, 'Hard'], [3, 'Expert']])}</label>
    <label class="set">Field of view ${rng('fov', 55, 95, 1)}</label>
    <label class="set">Master volume ${rng('master', 0, 1, 0.05)}</label><label class="set">Music volume ${rng('music', 0, 1, 0.05)}</label><label class="set">Effects volume ${rng('sfx', 0, 1, 0.05)}</label>
    <label class="set">Radio station ${sel('radio', STATIONS.map((s, i) => [i, s.name]))}</label>
    <label class="set">ABS ${chk('abs')}</label><label class="set">Traction control ${chk('tcs')}</label><label class="set">Racing line ${chk('line')}</label><label class="set">Camera shake ${chk('shake')}</label><label class="set">Tutorial hints ${chk('hints')}</label>
    <label class="set">World seed <span><input type="number" id="seedIn" value="${set.seed}" style="width:110px"> <button class="btn small" data-act="applySeed">Generate new world</button> <button class="btn small" data-act="randSeed">Random</button></span></label>
    <h3 style="margin-top:18px">Racing wheel (G29, G920, Thrustmaster, Fanatec...)</h3>
    <div class="mut" style="margin-bottom:8px">${this.g.padName ? 'Detected: ' + esc(this.g.padName) : 'No wheel detected - plug it in and turn the wheel or press a pedal, then reopen this page.'}</div>
    <label class="set">Use wheel when connected ${chk('wheelOn')}</label>
    <label class="set">Wheel rotation (degrees lock-to-lock) ${rng('wheelRange', 180, 900, 10)}</label>
    <label class="set">Steering response curve ${rng('wheelCurve', 0.6, 1.6, 0.05)}</label>
    <label class="set">Centre deadzone ${rng('wheelDead', 0, 0.1, 0.005)}</label>
    <div class="row"><button class="btn primary" data-act="wheelCal">Calibrate wheel &amp; pedals</button> <button class="btn" data-act="wheelReset">Reset mapping</button></div>
    <div class="mut" style="margin-top:6px;line-height:1.7">Right paddle nitro - left paddle / X handbrake - circle rewind - triangle camera - options menu - share map. Force feedback is not available to web pages, but steering, pedals and buttons are fully supported.</div>
    <h3 style="margin-top:18px">Save data</h3>
    <div class="row"><button class="btn" data-act="exportSave">Export save</button><button class="btn" data-act="importSave">Import save</button><button class="btn danger" data-act="wipe">Erase all progress</button></div>`;
  }
  tHelp(body) {
    body.innerHTML = `<h3>Controls</h3><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
    <div class="card"><h4>Keyboard</h4><div class="mut" style="line-height:1.9">W / ↑ throttle · S / ↓ brake & reverse<br>A D / ← → steer · <b>Space</b> handbrake<br><b>Shift</b> nitro · <b>H</b> horn · <b>G</b> hold to rewind<br><b>C</b> camera · <b>V</b> look back · <b>R</b> next radio station<br><b>M</b> map · <b>Esc</b> pause menu · <b>Enter</b> start event<br><b>E</b> interact · <b>T</b> reset to road · <b>P</b> photo mode · <b>F</b> fullscreen</div></div>
    <div class="card"><h4>Racing wheel</h4><div class="mut" style="line-height:1.9">Plug in a G29 / G920 / any wheel, then Settings &gt; Racing wheel &gt; Calibrate.<br>Paddles nitro / handbrake - circle rewind - triangle camera</div></div>
    <div class="card"><h4>Gamepad</h4><div class="mut" style="line-height:1.9">Left stick steer · RT gas · LT brake<br>A handbrake · B / RB nitro · X rewind · Y camera<br>Start menu · Back map · D-pad up start event · D-pad right radio</div></div>
    <div class="card"><h4>Touch</h4><div class="mut" style="line-height:1.9">On-screen buttons appear automatically on touch devices.</div></div>
    <div class="card"><h4>How to play</h4><div class="mut" style="line-height:1.7">Drive through glowing beams to start races, drift zones, speed traps and speed zones. Jump danger-sign ramps, smash bonus boards, find barns, chain skills for XP, level up for wheelspins, and buy or upgrade cars.</div></div></div>`;
  }

  // ---------- menu actions ----------
  onClick(e) {
    const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
    const g = this.g, st = g.state, a = el.dataset.act;
    switch (a) {
      case 'zoomIn': this.zoomMap(0.7); break; case 'zoomOut': this.zoomMap(1.4); break;
      case 'mapHome': this.mapView.cx = g.car.x; this.mapView.cz = g.car.z; this.renderMapImage(); this.drawMap(); break;
      case 'clearWp': g.waypoint = null; this.drawMap(); break;
      case 'resetRoad': g.placeOnRoad(); this.closeMenu(); break;
      case 'wp': g.waypoint = { x: +el.dataset.x, z: +el.dataset.z }; this.toast('Waypoint set', 'info'); this.drawMap && this.drawMap(); g.audio.blip('ui'); break;
      case 'travel': g.travel(+el.dataset.x, +el.dataset.z); this.closeMenu(); break;
      case 'pick': st.current = el.dataset.id; g.applyCar(true); this.renderMenu(); g.audio.blip('ui'); break;
      case 'paint': st.cars[st.current].color = +el.dataset.c; g.applyCar(false); this.renderMenu(); break;
      case 'upgrade': {
        const k = el.dataset.k, spec = carById(st.current), own = st.cars[st.current];
        const price = k === 'drive' ? AWD_PRICE(spec) : upgradePrice(spec, k, own.up[k] || 0);
        if (st.credits < price) break; st.credits -= price; own.up[k] = k === 'drive' ? 1 : (own.up[k] || 0) + 1; g.applyCar(false); g.audio.blip('ok'); g.save(); this.renderMenu(); break;
      }
      case 'buy': { const s = carById(el.dataset.id); if (st.credits >= s.price && !st.cars[s.id]) { st.credits -= s.price; g.giveCar(s.id); st.current = s.id; g.applyCar(true); g.audio.blip('level'); g.save(); this.toast(`Purchased ${s.name}`, 'good'); this.renderMenu(); } break; }
      case 'sell': { const s = carById(el.dataset.id); if (confirm(`Sell ${s.name}?`)) { st.credits += Math.round(s.price * 0.45); delete st.cars[s.id]; st.current = Object.keys(st.cars)[0]; g.applyCar(true); g.save(); this.renderMenu(); } break; }
      case 'spin': this.closeMenu(); g.spinWheel(); break;
            case 'joinRoom': g.state.settings.online = true; g.net.join(); break;
      case 'wheelCal': g.toggleMenu && g.paused ? g.toggleMenu() : 0; g.startCalibration(); break;
      case 'wheelReset': g.state.settings.wheelMap = null; g.save(); g.ui.toast('Wheel mapping reset', 'info'); break;
      case 'leaveRoom': g.state.settings.online = false; g.net.leave(); break;
      case 'applySeed': { const v = parseInt($('seedIn').value, 10) || 1; this.closeMenu(); g.newWorld(v); break; }
      case 'randSeed': { const v = Math.floor(Math.random() * 99999) + 1; this.closeMenu(); g.newWorld(v); break; }
      case 'exportSave': { const t = g.exportSave(); try { navigator.clipboard.writeText(t); this.toast('Save copied to clipboard', 'good'); } catch (err) { prompt('Copy your save:', t); } break; }
      case 'importSave': { const t = prompt('Paste your exported save data:'); if (t) { try { g.importSave(t); this.closeMenu(); } catch (err) { this.toast('Invalid save data', 'bad'); } } break; }
      case 'wipe': if (confirm('Erase ALL progress? This cannot be undone.')) g.wipeSave(); break;
      default: break;
    }
  }
  onInput(e) {
    const el = e.target, k = el.dataset && el.dataset.set; if (!k) return;
    const set = this.g.state.settings;
    let v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
    if (['traffic', 'difficulty'].includes(k)) v = parseInt(v, 10);
    if (k === 'radio') { this.g.setStation(parseInt(v, 10)); return; }
    set[k] = v; this.g.applySettings(k);
  }

  // ---------- overlays ----------
  showOverlay(html) { const o = $('overlay'); o.innerHTML = html; o.classList.remove('hidden'); this.g.onMenu(true); }
  hideOverlay() { $('overlay').classList.add('hidden'); $('overlay').innerHTML = ''; this.overlayMode = null; this.g.onMenu(false); }
  showResults(r) {
    this.overlayMode = 'results';
    const posTxt = ['', '1st', '2nd', '3rd'][r.pos] || r.pos + 'th';
    this.showOverlay(`<div class="ov"><div class="mut">${esc(r.title)}</div><div class="big" style="color:${r.pos === 1 ? '#e3b341' : r.pos <= 3 ? '#c9d1d9' : '#f0883e'}">${posTxt}</div><div class="mut">of ${r.total} racers</div>
      <div class="kv" style="grid-template-columns:1fr 1fr"><div><small>Time</small><b>${fmtTime(r.time)}</b></div><div><small>Best</small><b>${fmtTime(r.best)}</b></div></div>
      <div class="rew"><span class="gold">+${fmtNum(r.credits)} CR</span><span style="color:#58a6ff">+${fmtNum(r.xp)} XP</span>${r.spin ? '<span style="color:#a371f7">+1 Wheelspin</span>' : ''}</div>
      <div class="row" style="justify-content:center"><button class="btn big" data-ov="continue">Continue</button></div></div>`);
  }
  onOverlay(e) {
    const el = e.target.closest('[data-ov]'); if (!el) return; const g = this.g;
    switch (el.dataset.ov) {
      case 'continue': this.hideOverlay(); g.events.endRace(); break;
      case 'close': this.hideOverlay(); break;
      case 'spinagain': this.hideOverlay(); g.spinWheel(); break;
      case 'collect': this.hideOverlay(); break;
      default: break;
    }
  }
  showSpin(prize, labels, idx) {
    this.overlayMode = 'spin';
    const tiles = labels.map((l) => `<div class="tile" style="color:${l.c}">${esc(l.t)}</div>`).join('');
    this.showOverlay(`<div class="ov"><h2>Wheelspin</h2><div class="reel"><div class="strip" id="strip">${tiles}</div></div><div id="spinRes" class="mut" style="min-height:60px">Spinning...</div><div class="row" id="spinBtns" style="justify-content:center;visibility:hidden"><button class="btn big" data-ov="collect">Collect</button></div></div>`);
    const strip = $('strip'), reel = strip.parentElement;
    requestAnimationFrame(() => {
      const tile = 130, off = idx * tile + tile / 2 - reel.clientWidth / 2 + (Math.random() - 0.5) * 60;
      strip.style.transform = `translateX(${-off}px)`;
      this.g.audio.blip('rewind');
    });
    setTimeout(() => {
      const res = $('spinRes'); if (!res) return;
      res.innerHTML = `<div style="font-size:26px;font-weight:900;color:${prize.c}">${esc(prize.t)}</div><div>${esc(prize.sub || '')}</div>`;
      $('spinBtns').style.visibility = 'visible'; this.g.audio.blip('level');
    }, 3600);
  }
  showRepo(item) {
    const g = this.g, r = item.repo, url = g.repoTown.siteUrl(r);
    this.showOverlay(`<div class="ov repo"><h2>${esc(r.name)}</h2><div class="mut">${esc(r.lang || 'No language')} · ★ ${r.stars} · ⑂ ${r.forks}${r.updated ? ' · pushed ' + esc(r.updated) : ''}</div><p>${esc(r.desc)}</p>
      <div class="row">${r.url ? `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Open repository</a>` : ''}${url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">Open live site</a>` : ''}<button class="btn" data-ov="close">Keep driving</button></div></div>`);
  }

  // ---------- photo mode ----------
  openPhoto() {
    const p = $('photo'); p.classList.remove('hidden');
    p.innerHTML = `<span>Photo mode</span><button class="btn small" data-p="shot">📷 Capture</button><button class="btn small" data-p="hud">Toggle HUD</button><label class="mut">FOV <input type="range" data-p="fov" min="25" max="90" value="60"></label><label class="mut">Time <input type="range" data-p="time" min="0" max="24" step="0.1" value="${this.g.hour.toFixed(1)}"></label><span class="mut">Arrows/WASD orbit · Q/E up/down · Esc exit</span><button class="btn small" data-p="exit">Exit</button>`;
    p.oninput = (e) => { const k = e.target.dataset.p; if (k === 'fov') this.g.photo.fov = +e.target.value; if (k === 'time') { this.g.hourOverride = +e.target.value; } };
  }
  closePhoto() { $('photo').classList.add('hidden'); $('hud').classList.remove('hidden'); }
  onPhoto(e) {
    const el = e.target.closest('button[data-p]'); if (!el) return; const g = this.g;
    if (el.dataset.p === 'shot') g.capture();
    else if (el.dataset.p === 'hud') { $('hud').classList.toggle('hidden'); }
    else if (el.dataset.p === 'exit') g.exitPhoto();
  }
}
