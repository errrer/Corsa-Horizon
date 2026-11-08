// Oriented-box (OBB) collision between two cars lying on the ground plane.
// A car is {x, z, yaw, L, W}; forward = (sin yaw, cos yaw). Returns the push normal pointing from a to b.
export function obb(a, b) {
  const af = [Math.sin(a.yaw), Math.cos(a.yaw)], ar = [Math.cos(a.yaw), -Math.sin(a.yaw)];
  const bf = [Math.sin(b.yaw), Math.cos(b.yaw)], br = [Math.cos(b.yaw), -Math.sin(b.yaw)];
  const dx = b.x - a.x, dz = b.z - a.z;
  if (dx * dx + dz * dz > (a.L + b.L) * (a.L + b.L) * 0.3) return null;
  let best = 1e9, nx = 0, nz = 0;
  for (const ax of [af, ar, bf, br]) {
    const ra = (a.L / 2) * Math.abs(ax[0] * af[0] + ax[1] * af[1]) + (a.W / 2) * Math.abs(ax[0] * ar[0] + ax[1] * ar[1]);
    const rb = (b.L / 2) * Math.abs(ax[0] * bf[0] + ax[1] * bf[1]) + (b.W / 2) * Math.abs(ax[0] * br[0] + ax[1] * br[1]);
    const d = dx * ax[0] + dz * ax[1], o = ra + rb - Math.abs(d);
    if (o <= 0) return null;
    if (o < best) { best = o; const s = d >= 0 ? 1 : -1; nx = ax[0] * s; nz = ax[1] * s; }
  }
  return { nx, nz, depth: best };
}
