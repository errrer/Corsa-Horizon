// Persistent progress (localStorage), settings defaults, XP curve and achievements.
const KEY = 'horizonPages.save.v1';

export const SETTINGS_DEFAULT = {
  quality: 'medium', units: 'kmh', traffic: 2, master: 0.7, music: 0.5, sfx: 0.8, fov: 68, cam: 0,
  tod: '11', todSpeed: 1, weather: 'auto', season: 'auto', difficulty: 1, drive: 'left', seed: 1337,
  wheelOn: true, wheelRange: 540, wheelCurve: 1, wheelDead: 0.02, wheelMap: null,
  github: '', name: 'Racer', radio: 0, abs: true, tcs: true, stm: true, line: true, auto: true, shake: true, hints: true,
};
export function defaults() {
  return {
    v: 1, credits: 15000, xp: 0, level: 1, wheelspins: 1,
    cars: { commit: { color: 0x2ea043, up: {} } }, current: 'commit',
    discovered: {}, done: {}, boards: {}, barns: {}, repos: {},
    stats: { km: 0, topKmh: 0, driftPts: 0, jumps: 0, maxJump: 0, races: 0, wins: 0, smashed: 0, nearMiss: 0, skillBest: 0, airTime: 0, playTime: 0, wheelspins: 0 },
    ach: {}, settings: { ...SETTINGS_DEFAULT },
  };
}
export function load() {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    const out = { ...d, ...s, stats: { ...d.stats, ...(s.stats || {}) }, settings: { ...d.settings, ...(s.settings || {}) } };
    if (!out.settings.bright2) { out.settings.bright2 = true; out.settings.tod = '11'; out.settings.weather = 'auto'; } // one-time: start in daylight
    if (!out.cars || !Object.keys(out.cars).length) out.cars = d.cars;
    if (!out.cars[out.current]) out.current = Object.keys(out.cars)[0];
    return out;
  } catch (e) { return d; }
}
export function save(state) { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked */ } }
export function wipe() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
export const exportSave = (state) => JSON.stringify(state);
export function importSave(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== 'object' || !s.cars) throw new Error('Not a Horizon Pages save');
  const set = { ...SETTINGS_DEFAULT, ...(s.settings || {}) };
  if (!set.bright2) { set.bright2 = true; set.tod = '11'; set.weather = 'auto'; } // one-time: start in daylight
  return { ...defaults(), ...s, settings: set, stats: { ...defaults().stats, ...(s.stats || {}) } };
}

export const xpForNext = (level) => 500 + level * 260;
// returns number of levels gained
export function addXp(state, amount) {
  state.xp += Math.round(amount);
  let gained = 0;
  while (state.xp >= xpForNext(state.level)) {
    state.xp -= xpForNext(state.level); state.level++; gained++;
    state.wheelspins += state.level % 5 === 0 ? 2 : 1;
  }
  return gained;
}

export const ACHIEVEMENTS = [
  { id: 'first', name: 'Hello, World', desc: 'Complete your first event', test: (s) => s.stats.races + Object.keys(s.done).length >= 1 },
  { id: 'win', name: 'Merge Approved', desc: 'Win a race', test: (s) => s.stats.wins >= 1 },
  { id: 'wins5', name: 'Main Branch', desc: 'Win 5 races', test: (s) => s.stats.wins >= 5 },
  { id: 'speed250', name: 'Latency Zero', desc: 'Reach 250 km/h', test: (s) => s.stats.topKmh >= 250 },
  { id: 'speed350', name: 'Overclocked', desc: 'Reach 350 km/h', test: (s) => s.stats.topKmh >= 350 },
  { id: 'jump60', name: 'Stack Overflow', desc: 'Jump 60 m in one go', test: (s) => s.stats.maxJump >= 60 },
  { id: 'drift', name: 'Rebase Master', desc: 'Earn 50,000 drift points', test: (s) => s.stats.driftPts >= 50000 },
  { id: 'near', name: 'Close Call', desc: '25 traffic near misses', test: (s) => s.stats.nearMiss >= 25 },
  { id: 'smash', name: 'Bug Squasher', desc: 'Smash 30 cones, barrels & signs', test: (s) => s.stats.smashed >= 30 },
  { id: 'cars3', name: 'Fork Collector', desc: 'Own 3 cars', test: (s) => Object.keys(s.cars).length >= 3 },
  { id: 'cars8', name: 'Monorepo', desc: 'Own 8 cars', test: (s) => Object.keys(s.cars).length >= 8 },
  { id: 'lvl10', name: 'Contributor', desc: 'Reach level 10', test: (s) => s.level >= 10 },
  { id: 'lvl25', name: 'Maintainer', desc: 'Reach level 25', test: (s) => s.level >= 25 },
  { id: 'boards', name: 'Bonus Hunter', desc: 'Smash 10 bonus boards', test: (s) => Object.keys(s.boards).length >= 10 },
  { id: 'barn', name: 'Barn Find!', desc: 'Discover a barn find', test: (s) => Object.keys(s.barns).length >= 1 },
  { id: 'km100', name: 'Long Haul', desc: 'Drive 100 km', test: (s) => s.stats.km >= 100 },
  { id: 'skill', name: 'Skill Chain', desc: 'Bank a 100,000 point chain', test: (s) => s.stats.skillBest >= 100000 },
  { id: 'repo', name: 'Game Night', desc: 'Visit Iron Strike or NodeNGW', test: (s) => Object.keys(s.repos).length >= 1 },
];
