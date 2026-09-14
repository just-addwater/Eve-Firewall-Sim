import { describe, it, expect } from 'vitest';
import { hermitePos, hermiteVel } from './interp';
import { Vec3 } from '../sim/vec3';

const v = (x: number, y = 0, z = 0): Vec3 => ({ x, y, z });
const near = (a: Vec3, b: Vec3, eps = 1e-6): void => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
  expect(Math.abs(a.z - b.z)).toBeLessThan(eps);
};

describe('Hermite tick interpolation', () => {
  // A ship accelerating along x: 100 m/s → 160 m/s over one tick, having
  // covered ~130 m (the sim's exact exponential integral is close to this).
  const p0 = v(0, 5, 7), p1 = v(130, 5, 7), v0 = v(100), v1 = v(160);

  it('matches the tick endpoints exactly', () => {
    near(hermitePos(p0, v0, p1, v1, 0), p0);
    near(hermitePos(p0, v0, p1, v1, 1), p1);
    near(hermiteVel(p0, v0, p1, v1, 0), v0);
    near(hermiteVel(p0, v0, p1, v1, 1), v1);
  });

  it('is C1 across a tick boundary (no velocity kink)', () => {
    // Next tick continues from p1/v1: the velocity just before and just after
    // the boundary must agree, which linear interpolation cannot do.
    const p2 = v(130 + 190, 5, 7), v2 = v(220);
    const before = hermiteVel(p0, v0, p1, v1, 0.999);
    const after = hermiteVel(p1, v1, p2, v2, 0.001);
    near(before, after, 0.5);
    // ...whereas the linear scheme's slopes differ by the full acceleration.
    const linBefore = p1.x - p0.x, linAfter = p2.x - p1.x;
    expect(Math.abs(linBefore - linAfter)).toBeGreaterThan(50);
  });

  it('the velocity is the derivative of the position', () => {
    const t = 0.37, h = 1e-4;
    const a = hermitePos(p0, v0, p1, v1, t - h), b = hermitePos(p0, v0, p1, v1, t + h);
    const numeric = v((b.x - a.x) / (2 * h), (b.y - a.y) / (2 * h), (b.z - a.z) / (2 * h));
    near(hermiteVel(p0, v0, p1, v1, t), numeric, 1e-3);
  });

  it('stays on a straight line at constant velocity', () => {
    const c0 = v(0), c1 = v(300), cv = v(300);
    near(hermitePos(c0, cv, c1, cv, 0.25), v(75));
    near(hermitePos(c0, cv, c1, cv, 0.5), v(150));
  });

  it('a snapped tick (teleport) sits at the endpoint', () => {
    const p = v(1000, 2, 3);
    near(hermitePos(p, v(1200), p, v(1200), 0.5), p);
    near(hermiteVel(p, v(1200), p, v(900), 0.5), v(900));
  });
});
