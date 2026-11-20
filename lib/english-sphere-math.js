// Navigation geometry only. Points are [x,y,z]; quaternions are [x,y,z,w].
// Positive z faces the viewer. All rotations remain independent of the DOM.
export const IDENTITY_QUATERNION = Object.freeze([0, 0, 0, 1]);
const FRONT = [0, 0, 1];
const EPSILON = 1e-12;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
function finiteArray(value, length) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) throw new TypeError('Expected a finite geometry vector.');
  return value;
}
function fraction(value) {
  if (!Number.isFinite(value)) throw new TypeError('Expected a finite interpolation amount.');
  return clamp(value, 0, 1);
}
export function normalizeVector(value) {
  finiteArray(value, 3);
  const length = Math.hypot(...value);
  if (length < EPSILON) return [...FRONT];
  return value.map(component => component / length);
}
function normalizeQuaternion(value) {
  finiteArray(value, 4);
  const length = Math.hypot(...value);
  return length < EPSILON ? [...IDENTITY_QUATERNION] : value.map(component => component / length);
}

// Fibonacci positions distribute all eight areas over both hemispheres, with
// no privileged equator or pair of exactly opposite destinations.
const goldenAngle = Math.PI * (3 - Math.sqrt(5));
export const SPHERE_POINTS = Object.freeze(Array.from({ length: 8 }, (_, index) => {
  const y = 1 - 2 * (index + 0.5) / 8;
  const radius = Math.sqrt(1 - y*y);
  return Object.freeze([Math.sin(index * goldenAngle) * radius, y, Math.cos(index * goldenAngle) * radius]);
}));
export const SPHERE_EDGES = Object.freeze(SPHERE_POINTS.flatMap((_, from) =>
  SPHERE_POINTS.slice(from + 1).map((__, offset) => Object.freeze([from, from + offset + 1]))));

/** Composition: apply right first, then left. */
export function multiplyQuaternions(left, right) {
  const [ax, ay, az, aw] = normalizeQuaternion(left);
  const [bx, by, bz, bw] = normalizeQuaternion(right);
  return normalizeQuaternion([
    aw*bx + ax*bw + ay*bz - az*by,
    aw*by - ax*bz + ay*bw + az*bx,
    aw*bz + ax*by - ay*bx + az*bw,
    aw*bw - ax*bx - ay*by - az*bz,
  ]);
}

/** Smallest rotation from one direction to another, including antipodes. */
export function quaternionBetween(from, to) {
  const a = normalizeVector(from), b = normalizeVector(to);
  const agreement = clamp(dot(a, b), -1, 1);
  if (agreement > 1 - EPSILON) return [...IDENTITY_QUATERNION];
  if (agreement < -1 + EPSILON) {
    // Pick the least parallel coordinate axis, so the perpendicular is stable.
    const axisIndex = a.map(Math.abs).indexOf(Math.min(...a.map(Math.abs)));
    const basis = [0, 0, 0]; basis[axisIndex] = 1;
    return [...normalizeVector(cross(a, basis)), 0];
  }
  return normalizeQuaternion([...cross(a, b), 1 + agreement]);
}

export function rotatePoint(point, quaternion) {
  finiteArray(point, 3);
  const q = normalizeQuaternion(quaternion), vector = q.slice(0, 3);
  const uv = cross(vector, point), uuv = cross(vector, uv);
  return point.map((value, index) => value + 2 * (q[3] * uv[index] + uuv[index]));
}

/** Shortest quaternion arc. A caller can retarget from its currently drawn q. */
export function slerpQuaternions(from, to, amount) {
  const t = fraction(amount), a = normalizeQuaternion(from);
  let b = normalizeQuaternion(to), agreement = dot(a, b);
  // q and -q describe the same orientation. Avoid the long way around.
  if (agreement < 0) { b = b.map(value => -value); agreement = -agreement; }
  if (t === 0) return a;
  if (t === 1) return b;
  if (agreement > 0.9995) return normalizeQuaternion(a.map((value, index) => value + (b[index] - value) * t));
  const angle = Math.acos(clamp(agreement, -1, 1)), sine = Math.sin(angle);
  const startWeight = Math.sin((1 - t) * angle) / sine, endWeight = Math.sin(t * angle) / sine;
  return normalizeQuaternion(a.map((value, index) => value * startWeight + b[index] * endWeight));
}

/** Move the requested area directly to the front, preserving the current roll. */
export function focusQuaternion(index, current = IDENTITY_QUATERNION) {
  if (!Number.isInteger(index) || !SPHERE_POINTS[index]) throw new RangeError('Unknown sphere area.');
  return multiplyQuaternions(quaternionBetween(rotatePoint(SPHERE_POINTS[index], current), FRONT), current);
}

export function slerpPoint(from, to, amount) {
  const t = fraction(amount), a = normalizeVector(from), b = normalizeVector(to);
  if (t === 0) return a;
  if (t === 1) return b;
  return normalizeVector(rotatePoint(a, slerpQuaternions(IDENTITY_QUATERNION, quaternionBetween(a, b), t)));
}

/** steps segments, steps+1 points. Includes finite endpoints for degenerate arcs. */
export function greatCirclePoints(from, to, steps = 32) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 512) throw new RangeError('Sphere arc resolution must be between 1 and 512.');
  const a = normalizeVector(from), b = normalizeVector(to), rotation = quaternionBetween(a, b);
  return Array.from({ length: steps + 1 }, (_, index) => {
    if (index === 0) return [...a];
    if (index === steps) return [...b];
    return normalizeVector(rotatePoint(a, slerpQuaternions(IDENTITY_QUATERNION, rotation, index / steps)));
  });
}

/** Pointer coordinates in [-1,1], x right / y up; outside drags stay on the rim. */
export function arcballPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('Expected finite pointer coordinates.');
  const distance = Math.hypot(x, y);
  return distance > 1 ? [x / distance, y / distance, 0] : [x, y, Math.sqrt(Math.max(0, 1 - distance*distance))];
}

export function dragQuaternion(startPoint, endPoint, current = IDENTITY_QUATERNION) {
  return multiplyQuaternions(quaternionBetween(startPoint, endPoint), current);
}

/** Perspective projection of a rotated point; radius is the visual world unit. */
export function projectPoint(point, { radius = 1, camera = 4, centerX = 0, centerY = 0 } = {}) {
  finiteArray(point, 3);
  if (![radius, camera, centerX, centerY].every(Number.isFinite) || radius <= 0 || camera <= 1 || point[2] >= camera) throw new RangeError('Invalid sphere projection.');
  const scale = camera / (camera - point[2]);
  return { x: centerX + point[0] * radius * scale, y: centerY - point[1] * radius * scale, z: point[2], scale };
}
