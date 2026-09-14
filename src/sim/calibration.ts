// Calibration harness: runs headless sims and compares measured behavior against
// the analytic expectations derived from pinned SDE data (docs/data-pinned.md).
// Used by both the in-app calibration panel and the vitest suite.
import { Sim } from './sim';
import { v3 } from './vec3';
import { SHIP, PROPS, maxVelocity, tau, SKILLS } from './data';

export interface CalRow { name: string; expected: number; measured: number; unit: string; tol: number; pass: boolean; }

function freshSim(links = false): Sim {
  const s = new Sim();
  s.ship.links = links;
  s.ship.command = { kind: 'align', dir: v3(1, 0, 0), label: 'calibration' };
  return s;
}

/** Time (s) for speed to first reach fraction f of vMax, linearly interpolated between ticks. */
function timeToFraction(s: Sim, f: number, vMax: number, maxSteps = 400): number {
  let prev = 0;
  for (let i = 1; i <= maxSteps; i++) {
    s.step();
    const sp = s.ship.speed();
    if (sp >= f * vMax) {
      const t1 = i - 1, t2 = i;
      return t1 + (f * vMax - prev) / (sp - prev) * (t2 - t1);
    }
    prev = sp;
  }
  return NaN;
}

function row(name: string, expected: number, measured: number, unit: string, tol: number): CalRow {
  return { name, expected, measured, unit, tol, pass: Math.abs(expected - measured) <= tol };
}

export function runCalibration(): CalRow[] {
  const rows: CalRow[] = [];

  // Top speeds (steady-state after long run).
  const settle = (setup: (s: Sim) => void, steps = 300): number => {
    const s = freshSim(false);
    setup(s);
    for (let i = 0; i < steps; i++) s.step();
    return s.ship.speed();
  };
  rows.push(row('Max velocity, props off', SHIP.vBase, settle(() => {}), 'm/s', 0.01));
  rows.push(row('Max velocity, AB', maxVelocity(PROPS.ab, false), settle(s => s.toggleProp('ab')), 'm/s', 0.1));
  rows.push(row('Max velocity, MWD', maxVelocity(PROPS.mwd, false), settle(s => s.toggleProp('mwd')), 'm/s', 0.1));
  rows.push(row('Max velocity, AB overheated', maxVelocity(PROPS.ab, true),
    settle(s => { s.ship.ab.overheat = true; s.toggleProp('ab'); }), 'm/s', 0.1));
  rows.push(row('Max velocity, MWD overheated', maxVelocity(PROPS.mwd, true),
    settle(s => { s.ship.mwd.overheat = true; s.toggleProp('mwd'); }), 'm/s', 0.1));

  // Align time from rest (props off, links off): t75 = -tau * ln(0.25).
  {
    const s = freshSim(false);
    const expected = -tau(null, false) * Math.log(0.25); // 9.462 s from SDE numbers
    rows.push(row('Align time (rest -> 75% vMax), no links', expected,
      timeToFraction(s, 0.75, SHIP.vBase), 's', 0.25));
  }
  // Align time with links: reconciles the user's fitting window (7.44 s).
  {
    const s = freshSim(true);
    const expected = -tau(null, true) * Math.log(0.25);
    rows.push(row('Align time with fleet boosts (fitting window: 7.44)', expected,
      timeToFraction(s, 0.75, SHIP.vBase), 's', 0.25));
  }
  // MWD accel time constant: time to 1 - 1/e of vMax equals tau.
  {
    const s = freshSim(false);
    s.toggleProp('mwd');
    const vm = maxVelocity(PROPS.mwd, false);
    const expected = tau(PROPS.mwd, false); // ~19.95 s
    rows.push(row('MWD accel time constant (63.2% vMax)', expected,
      timeToFraction(s, 1 - Math.E ** -1, vm), 's', 0.35));
  }
  // Cycle rule: deactivation lands at cycle end, not on request.
  {
    const s = freshSim(false);
    s.toggleProp('mwd');                       // active at t=0, 10 s cycle
    for (let i = 0; i < 3; i++) s.step();      // t=3
    s.toggleProp('mwd');                       // request off -> pending
    let activeAt9 = false, inactiveAt10 = false;
    for (let i = 0; i < 7; i++) {
      s.step();
      if (s.time === 9) activeAt9 = s.ship.mwd.active;
      if (s.time === 10) inactiveAt10 = !s.ship.mwd.active;
    }
    rows.push(row('MWD still active at t=9 after off-request at t=3', 1, activeAt9 ? 1 : 0, 'bool', 0));
    rows.push(row('MWD deactivated at cycle end (t=10)', 1, inactiveAt10 ? 1 : 0, 'bool', 0));
  }
  // Smartbomb cycle at Energy Pulse Weapons V (data check, no sim needed).
  rows.push(row('Smartbomb cycle at EPW V', 7.5, 10 * SKILLS.energyPulseWeapons, 's', 0));

  return rows;
}
