# Horizon Pages

An endless open-world racing festival (open-world festival style) that runs entirely in the browser.
Plain static files: no build step, no server. Three.js loads from the jsDelivr CDN.

## Deploy to GitHub Pages

1. Create a repository and push this folder's contents to it (`index.html` must be at the root).
2. Repo **Settings > Pages > Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`.
3. Open `https://<you>.github.io/<repo>/`.


Local test: `python3 -m http.server` in this folder, then open http://localhost:8000 (ES modules do not work from `file://`).

## Features

- Infinite procedural world (seeded): mountains, forests, deserts, lakes, snow, towns, paved and dirt road grids, ramps
- Arcade-sim physics: tyre model, weight transfer, handbrake drifts, nitro, jumps, water
- Day/night cycle (real clock or fast cycle), dynamic weather (rain, storm, fog, snow), seasons
- Festival hub with ferris wheel and plaza; two buildings link to Iron Strike and NodeNGW
- Events: street, circuit and cross-country races, drift zones, speed traps, speed zones, danger-sign jumps, bonus boards, barn finds
- AI traffic and rivals, skill chains, XP, levels, credits, wheelspins
- 10 cars, upgrades, AWD swap, paint, autoshow
- Map with waypoints and fast travel, minimap, photo mode, rewind, 4 cameras
- Synthesised engine sounds and 4 procedural radio stations
- Keyboard, gamepad and touch controls; autosave, export/import

## Extras

- Online: Menu > Online. Host a room and share the 5-letter code (peer-to-peer via PeerJS; players get name tags).
- Mod menu: type `supermod` while driving.
- Rival bots steer with pure pursuit, avoid each other, and collide with you and with each other.

## Controls

W/S gas and brake, A/D steer, Space handbrake, Shift nitro, H horn, G hold to rewind, C camera, V look back, R radio, M map, Esc menu, Enter start event, E interact, T reset to road, P photo mode, F fullscreen.

## Files

`js/terrain.js` world generation, `chunks.js` streaming geometry, `physics.js` car model, `cars.js` models and roster, `events.js` events and races, `ai.js` traffic and rivals, `sky.js` sky and weather, `audio.js` sound, `landmarks.js` festival and Repo Town, `ui.js` HUD and menus, `save.js` progress, `main.js` game loop.

## Credits

Lamborghini Huracán model: "2016 Lamborghini Huracan" by RBLXSupercars (https://sketchfab.com/3d-models/2016-lamborghini-huracan-32f8ddbfb9ef45b085b0fa614f43af0f), licensed CC BY 4.0.
