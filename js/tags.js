// Floating name tags (canvas sprites) for rivals and online players.
import * as THREE from 'three';

const cache = new Map();
export function makeTag(text, color = '#e6edf3') {
  const key = text + color;
  let mat = cache.get(key);
  if (!mat) {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 72;
    const x = cv.getContext('2d');
    x.font = 'bold 34px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    const w = Math.min(300, x.measureText(text).width + 36);
    x.fillStyle = 'rgba(13,17,23,0.78)'; x.beginPath(); x.roundRect((320 - w) / 2, 8, w, 56, 16); x.fill();
    x.lineWidth = 3; x.strokeStyle = color; x.stroke();
    x.fillStyle = color; x.fillText(text, 160, 37, 280);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
    cache.set(key, mat);
  }
  const s = new THREE.Sprite(mat); s.scale.set(4.4, 1.0, 1); s.renderOrder = 10;
  return s;
}
