// Mod menu: type "supermod" anywhere in the game to open it.
import { CARS } from './cars.js';
import { world } from './terrain.js';

const CODE = 'supermod';
export class ModMenu {
  constructor(g) {
    this.g = g; this.buf = ''; this.open = false;
    this.f = { god: false, nitro: false, grip: false, boost: false, lowg: false, noTraffic: false, freeze: false };
    this.build();
    document.addEventListener('keydown', (e) => this.onKey(e), true);
  }
  onKey(e) {
    if (this.open && e.code === 'Escape') { e.stopPropagation(); e.preventDefault(); this.toggle(false); return; }
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key && e.key.length === 1) {
      this.buf = (this.buf + e.key.toLowerCase()).slice(-CODE.length);
      if (this.buf === CODE) { this.buf = ''; this.toggle(); }
    }
  }
  toggle(v) {
    const g = this.g; if (g.mode !== 'play' && !this.open) return;
    this.open = v === undefined ? !this.open : v;
    this.el.classList.toggle('hidden', !this.open);
    g.onMenu(this.open);
    if (this.open) { this.sync(); g.ui.toast('Mod menu unlocked', 'level'); }
  }
  build() {
    const el = (this.el = document.createElement('div'));
    el.id = 'modmenu'; el.className = 'hidden';
    const tog = (k, t) => `<label class="mrow"><input type="checkbox" data-f="${k}"> ${t}</label>`;
    const btn = (a, t) => `<button class="btn small" data-a="${a}">${t}</button>`;
    el.innerHTML = `<div class="mhead"><b>SUPER MOD MENU</b><button class="btn small" data-a="close">Close (Esc)</button></div>
      <div class="msec">Toggles</div>
      ${tog('god', 'God mode (no collisions, ghost car)')}${tog('nitro', 'Infinite nitro')}${tog('grip', 'Super grip')}${tog('boost', 'Super speed (hold gas)')}${tog('lowg', 'Low gravity')}${tog('noTraffic', 'No traffic')}${tog('freeze', 'Freeze rival bots')}
      <div class="msec">Resources</div>
      <div class="mbtns">${btn('cash', '+100,000 CR')}${btn('xp', '+5,000 XP')}${btn('spins', '+10 wheelspins')}${btn('cars', 'Unlock all cars')}${btn('upgrade', 'Max upgrades (current car)')}</div>
      <div class="msec">Car</div>
      <div class="mbtns">${btn('repair', 'Repair / flip upright')}${btn('launch', 'Launch up')}${btn('stop', 'Stop car')}${btn('winrace', 'Win current race')}${btn('clearTraffic', 'Clear traffic')}</div>
      <div class="msec">Teleport</div>
      <div class="mbtns">${btn('tpWay', 'To waypoint')}${btn('tpFest', 'To festival')}${btn('tpRoad', 'Reset to road')}</div>
      <div class="msec">World</div>
      <label class="mrow">Time of day <input type="range" min="0" max="24" step="0.25" value="12" data-time></label>
      <div class="mbtns">${['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow'].map((w) => btn('wx:' + w, w)).join('')}</div>
      <div class="mut" style="font-size:11px;margin-top:8px">Type <b>supermod</b> again to close.</div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) this.act(b.dataset.a); });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.f) { this.f[t.dataset.f] = t.checked; this.apply(t.dataset.f); }
    });
    el.addEventListener('input', (e) => { if (e.target.hasAttribute('data-time')) { this.g.state.settings.tod = String(e.target.value); this.g.hourOverride = null; } });
  }
  sync() { for (const i of this.el.querySelectorAll('[data-f]')) i.checked = !!this.f[i.dataset.f]; }
  apply(k) {
    const g = this.g;
    if (k === 'lowg') g.car.gravMul = this.f.lowg ? 0.3 : 1;
    if (k === 'noTraffic') { if (this.f.noTraffic) { g.traffic.setCount(0); g.traffic.clear(); } else g.applySettings('traffic'); }
  }
  // called every frame while playing
  tick() {
    const g = this.g, c = g.car, f = this.f;
    if (f.nitro) c.nitro = 1;
    const s = g.carSpec; if (s._mu === undefined) s._mu = s.mu; s.mu = s._mu * (f.grip ? 1.8 : 1);
  }
  act(a) {
    const g = this.g, st = g.state, c = g.car;
    if (a === 'close') return this.toggle(false);
    if (a.startsWith('wx:')) { st.settings.weather = a.slice(3); g.applySettings('weather'); return; }
    switch (a) {
      case 'cash': g.addCredits(100000); break;
      case 'xp': g.addXp(5000); break;
      case 'spins': st.wheelspins += 10; break;
      case 'cars': for (const s of CARS) g.giveCar(s.id); g.ui.toast('All cars unlocked', 'good'); break;
      case 'upgrade': { const o = st.cars[st.current]; for (const k of ['engine', 'tires', 'weight', 'aero', 'nitro']) o.up[k] = 4; o.up.drive = 1; g.applyCar(false); break; }
      case 'repair': g.placeCar(c.x, c.z, c.yaw, c.speed); c.roll = 0; c.pitch = 0; break;
      case 'launch': c.vy = 28; c.grounded = false; break;
      case 'stop': c.u = 0; c.v = 0; c.r = 0; break;
      case 'winrace': { const R = g.events.race; if (R && R.state === 'run') { for (const v of R.rivals) { v.finished = false; } R.cp = R.cps.length - 1; g.events.finishRace(); this.toggle(false); } else g.ui.toast('No race running', 'info'); break; }
      case 'clearTraffic': g.traffic.clear(); break;
      case 'tpWay': if (g.waypoint) { g.travel(g.waypoint.x, g.waypoint.z); this.toggle(false); } else g.ui.toast('Set a waypoint on the map first', 'info'); break;
      case 'tpFest': g.travel(world.festival.x - 60, world.festival.z); this.toggle(false); break;
      case 'tpRoad': g.placeOnRoad(); this.toggle(false); break;
      default: break;
    }
    g.save();
  }
}
