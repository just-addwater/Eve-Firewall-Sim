// Render-side interpolation of the 1 Hz authoritative state.
//
// Linear interpolation between two ticks gives piecewise-constant velocity —
// a visible kink once a second while accelerating or turning, and the camera
// is hard-locked to the own ship so the whole sky kinked with it. A cubic
// Hermite across the tick, using the velocities the sim already stores at
// both ends, is C1-continuous: position AND velocity match at every tick
// boundary. Units: metres, m/s, tick length 1 s (so velocity terms need no
// scaling).
import { Vec3 } from '../sim/vec3';

/** Position at fraction t∈[0,1] of the tick from (p0,v0) to (p1,v1).
 *  A snapped tick (p0 == p1, e.g. after an MJD teleport) returns p1: the
 *  velocity terms would otherwise bulge the path around a point that did
 *  not move. */
export function hermitePos(p0: Vec3, v0: Vec3, p1: Vec3, v1: Vec3, t: number): Vec3 {
  if (snapped(p0, p1)) return { x: p1.x, y: p1.y, z: p1.z };
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return {
    x: h00 * p0.x + h10 * v0.x + h01 * p1.x + h11 * v1.x,
    y: h00 * p0.y + h10 * v0.y + h01 * p1.y + h11 * v1.y,
    z: h00 * p0.z + h10 * v0.z + h01 * p1.z + h11 * v1.z,
  };
}

/** Velocity (m/s) at fraction t — the derivative of hermitePos, so the speed
 *  readout eases through the tick as well. */
export function hermiteVel(p0: Vec3, v0: Vec3, p1: Vec3, v1: Vec3, t: number): Vec3 {
  if (snapped(p0, p1)) return { x: v1.x, y: v1.y, z: v1.z };
  const t2 = t * t;
  const d00 = 6 * t2 - 6 * t, d10 = 3 * t2 - 4 * t + 1, d01 = -6 * t2 + 6 * t, d11 = 3 * t2 - 2 * t;
  return {
    x: d00 * p0.x + d10 * v0.x + d01 * p1.x + d11 * v1.x,
    y: d00 * p0.y + d10 * v0.y + d01 * p1.y + d11 * v1.y,
    z: d00 * p0.z + d10 * v0.z + d01 * p1.z + d11 * v1.z,
  };
}

function snapped(p0: Vec3, p1: Vec3): boolean {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  return dx * dx + dy * dy + dz * dz < 1;
}
