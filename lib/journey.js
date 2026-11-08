const EARTH = 6371008.8;
const RAD = Math.PI / 180;
const validPoint = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
  && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
const wrap = value => ((value + 540) % 360) - 180;

/** Great-circle metres. Invalid points return 0 and are excluded by the geometry helpers. */
export function distanceMeters(a, b) {
  if (!validPoint(a) || !validPoint(b)) return 0;
  const lat = (b[0] - a[0]) * RAD, lon = wrap(b[1] - a[1]) * RAD;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(lon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
