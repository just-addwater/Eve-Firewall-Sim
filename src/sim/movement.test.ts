import { describe, it, expect } from 'vitest';
import { runCalibration } from './calibration';
import { SHIP, PROPS, maxVelocity, tau } from './data';
import { Sim, makeM1Sim } from './sim';
import { APPROACH_STANDOFF } from './ship';
import { v3, len } from './vec3';

describe('derived constants from pinned SDE data', () => {
  it('props-off speed matches the fitting window exactly (87.5 m/s)', () => {
    expect(SHIP.vBase).toBeCloseTo(87.5, 5);
  });
  it('AB/MWD top speeds match the data-pass derivation', () => {
    expect(maxVelocity(PROPS.ab, false)).toBeCloseTo(443.7, 0);
    expect(maxVelocity(PROPS.mwd, false)).toBeCloseTo(1210.0, 0);
    expect(maxVelocity(PROPS.ab, true)).toBeCloseTo(621.8, 0);
    expect(maxVelocity(PROPS.mwd, true)).toBeCloseTo(1771.3, 0);
  });
  it('align time derivations match (9.46 s no links, 7.44 s with links)', () => {
    expect(-tau(null, false) * Math.log(0.25)).toBeCloseTo(9.46, 1);
    expect(-tau(null, true) * Math.log(0.25)).toBeCloseTo(7.44, 1);
  });
  it('MWD-on accel time constant is ~20 s', () => {
    expect(tau(PROPS.mwd, false)).toBeCloseTo(19.95, 1);
  });
});

describe('calibration harness (simulated behavior matches analytic model)', () => {
  const rows = runCalibration();
  for (const r of rows) {
    it(`${r.name}: expected ${r.expected.toFixed(2)}${r.unit}, measured ${r.measured.toFixed(2)}${r.unit}`, () => {
      expect(r.pass, `${r.name}: |${r.expected} - ${r.measured}| > ${r.tol}`).toBe(true);
    });
  }
});

describe('movement integration details', () => {
  it('position follows the exact exponential integral from rest', () => {
    const s = new Sim();
    s.ship.command = { kind: 'align', dir: v3(1, 0, 0), label: 't' };
    const tc = tau(null, true), vm = SHIP.vBase;
    for (let i = 0; i < 30; i++) s.step();
    const t = 30;
    const analytic = vm * (t - tc * (1 - Math.exp(-t / tc)));
    expect(s.ship.pos.x).toBeCloseTo(analytic, 0);
  });
  it('keep-at-range under MWD converges to the band and settles', () => {
    const s = makeM1Sim();
    s.ship.links = false;
    s.setCommand({ kind: 'keepAtRange', targetId: 'b10', range: 2000 });
    s.toggleProp('mwd');
    const errs: number[] = [];
    for (let i = 0; i < 180; i++) {
      s.step();
      errs.push(Math.abs(s.distanceTo('b10') - 2000));
    }
    const tail = errs.slice(-30);
    expect(Math.max(...tail)).toBeLessThan(400);   // holds near the band
    expect(s.ship.speed()).toBeLessThan(150);      // no full-speed thrash
  });

  it('approach stops at the ~500 m stand-off instead of ramming through', () => {
    const s = makeM1Sim();
    s.ship.links = false;
    s.setCommand({ kind: 'approach', targetId: 'b10' });
    s.toggleProp('ab');
    let minD = Infinity;
    for (let i = 0; i < 360; i++) { s.step(); minD = Math.min(minD, s.distanceTo('b10')); }
    expect(minD).toBeGreaterThan(APPROACH_STANDOFF - 150);
    expect(s.distanceTo('b10')).toBeLessThan(APPROACH_STANDOFF + 500);
  });

  it('align-to flies at the object at full speed and runs it down', () => {
    const s = makeM1Sim();
    s.ship.links = false;
    s.setCommand({ kind: 'alignTo', targetId: 'b10' });
    s.toggleProp('ab');
    s.step();
    expect(len(s.ship.desiredVelocity(s.lookup))).toBeCloseTo(s.ship.maxSpeed(), 3);
    let minD = Infinity;
    for (let i = 0; i < 120; i++) { s.step(); minD = Math.min(minD, s.distanceTo('b10')); }
    expect(minD).toBeLessThan(APPROACH_STANDOFF);
  });

  it('EVE keep-at-range overshoots on a heavy MWD hull; smooth mode floats in', () => {
    const closest = (mode: 'smooth' | 'eve'): number => {
      const s = makeM1Sim();
      s.ship.links = false;
      s.ship.kraMode = mode;
      s.setCommand({ kind: 'keepAtRange', targetId: 'b10', range: 2000 });
      s.toggleProp('mwd');
      let minD = Infinity;
      for (let i = 0; i < 180; i++) { s.step(); minD = Math.min(minD, s.distanceTo('b10')); }
      return minD;
    };
    expect(closest('eve')).toBeLessThan(1000);    // blows through the range and burns back
    expect(closest('smooth')).toBeGreaterThan(1500);
  });

  it('MJD: 9 s spool, 100 km jump along heading, cooldown blocks reuse', () => {
    const s = makeM1Sim();               // ship at rest, heading +x
    s.toggleMjd();
    for (let i = 0; i < 9; i++) s.step();
    expect(s.ship.pos.x).toBeGreaterThan(99_000);
    expect(s.ship.pos.x).toBeLessThan(101_000);
    expect(s.ship.mjd.state).toBe('cooldown');
    const n0 = s.notifications.length;
    s.toggleMjd();                       // refused during cooldown
    expect(s.ship.mjd.state).toBe('cooldown');
    expect(s.notifications.length).toBe(n0 + 1);
  });

  it('only one prop module can run at a time', () => {
    const s = new Sim();
    s.toggleProp('ab');
    s.toggleProp('mwd');
    expect(s.ship.mwd.active).toBe(false);
    expect(s.notifications.length).toBe(1);
  });
  it('deceleration after MWD shutdown uses the lighter mass tau', () => {
    const s = new Sim();
    s.ship.links = false;
    s.ship.command = { kind: 'align', dir: v3(1, 0, 0), label: 't' };
    s.toggleProp('mwd');
    for (let i = 0; i < 60; i++) s.step();     // at full MWD speed
    s.toggleProp('mwd');                        // pending off; cycle ends at t=70
    while (s.time < 69) s.step();
    const v69 = s.ship.speed();                 // still boosted at t=69
    expect(v69).toBeGreaterThan(1100);
    expect(s.ship.mwd.active).toBe(true);
    s.step();                                   // t=70: deactivates, then integrates with light mass
    expect(s.ship.mwd.active).toBe(false);
    const tcOff = tau(null, false);             // 6.825 s
    const expected = SHIP.vBase + (v69 - SHIP.vBase) * Math.exp(-1 / tcOff);
    expect(s.ship.speed()).toBeCloseTo(expected, 1);
  });
});
