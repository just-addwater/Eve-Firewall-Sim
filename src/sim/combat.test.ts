import { describe, it, expect } from 'vitest';
import { Sim, makeCombatSim } from './sim';
import { DEFAULT_SCENARIO, Smartbomb, MISSILE_INFO, GUIDANCE_RIG_MULT, DOCTRINES, segmentSphereChord, ScenarioConfig, memberHelm } from './combat';
import { v3, add, scale, norm, sub, clone, len } from './vec3';

// Legacy (random) hostile FC by default so the geometry tests stay seeded-stable;
// the 'enemy FC' suite below opts into the smarter behaviours.
// The shipped defaults later moved to the user's doctrine (Machariel blues,
// cruise Typhoons + a Cerberus HAM fleet); the geometry proofs below were
// written against the original single-fleet heavy-missile drill, pinned here.
const LEGACY: Partial<ScenarioConfig> = {
  friendlyHull: 'Apocalypse', friendlySpeed: 300, friendlyPattern: 'orbit',
  hostileSpeed: 400, missile: 'heavy', extraFleets: [], fightingDistanceKm: 50, warpPeriodS: 90,
};
function drill(over: Partial<ScenarioConfig> = {}): Sim {
  return makeCombatSim({ ...DEFAULT_SCENARIO, ...LEGACY, fcSkill: 0, hostilePersonalities: false, ...over });
}

describe('smartbomb rack', () => {
  it('cycle is 7.5 s at Energy Pulse Weapons V; range 7,500 m; 375 EM', () => {
    expect(Smartbomb.cycleS).toBeCloseTo(7.5, 5);
    expect(Smartbomb.rangeM).toBe(7500);
    expect(Smartbomb.damage).toBe(375);
  });

  it('pulses on activation, then every cycle while active', () => {
    const b = new Smartbomb();
    b.toggle(0);
    const times: number[] = [];
    for (let t = 1; t <= 20; t++) times.push(...b.duePulses(t));
    // activation pulse ~0, then 7.5, 15
    expect(times.length).toBe(3);
    expect(times[1] - times[0]).toBeCloseTo(7.5, 3);
    expect(times[2] - times[1]).toBeCloseTo(7.5, 3);
  });

  it('toggling off deactivates at cycle end WITHOUT the repeat pulse', () => {
    const b = new Smartbomb();
    b.toggle(0);
    let fired = 0;
    for (let t = 1; t <= 3; t++) fired += b.duePulses(t).length;
    expect(fired).toBe(1);          // activation pulse only
    b.toggle(3);                    // request off mid-cycle
    for (let t = 4; t <= 20; t++) fired += b.duePulses(t).length;
    expect(fired).toBe(1);          // no pulse at 7.5 — "without repeating"
    expect(b.active).toBe(false);
  });

  it('staggered activation gives ~1 s pulse cadence; simultaneous gives 7.5 s gaps', () => {
    const staggered: number[] = [];
    const bombs = Array.from({ length: 7 }, () => new Smartbomb());
    bombs.forEach((b, i) => b.toggle(i)); // one per second
    for (let t = 1; t <= 40; t++) for (const b of bombs) staggered.push(...b.duePulses(t));
    staggered.sort((a, b2) => a - b2);
    let maxGap = 0;
    for (let i = 1; i < staggered.length; i++) maxGap = Math.max(maxGap, staggered[i] - staggered[i - 1]);
    expect(maxGap).toBeLessThanOrEqual(1.51); // near-continuous coverage

    const together = Array.from({ length: 7 }, () => new Smartbomb());
    together.forEach(b => b.toggle(0));
    const times2: number[] = [];
    for (let t = 1; t <= 40; t++) for (const b of together) times2.push(...b.duePulses(t));
    const uniq = [...new Set(times2.map(x => Math.round(x * 1000)))].sort((a, b2) => a - b2);
    expect((uniq[1] - uniq[0]) / 1000).toBeCloseTo(7.5, 2); // 7.5 s holes
  });
});

describe('interception mechanics', () => {
  it('a pulse kills every missile whose tick sample is within 7,500 m and no others', () => {
    const s = drill();
    const c = s.combat!;
    c.missiles.push(
      { pos: add(clone(s.ship.pos), v3(7000, 0, 0)), prevPos: v3(), speed: 6450, infoKey: 'heavy', targetIdx: 0, expiresAt: 999, alive: true },
      { pos: add(clone(s.ship.pos), v3(8100, 0, 0)), prevPos: v3(), speed: 6450, infoKey: 'heavy', targetIdx: 0, expiresAt: 999, alive: true },
    );
    s.toggleBomb(0);
    s.step(); // pulse resolves against pre-step samples
    expect(c.score.killed).toBe(1);
    expect(c.missiles.filter(m => m.alive).length).toBe(1);
  });

  it('a missile that impacts mid-tick leaks and cannot be caught afterwards', () => {
    const s = drill();
    const c = s.combat!;
    const target = c.friendly.members[0];
    // Park the player ON the target: even so, a hull-bonused missile whose last
    // sample is outside the bubble impacts before any pulse can touch it.
    s.ship.pos = clone(target.pos);
    s.ship.prevPos = clone(s.ship.pos);
    s.ship.command = { kind: 'stop' };
    const speed = MISSILE_INFO.heavy.speed * DEFAULT_SCENARIO.missileVelocityMult
      * (DEFAULT_SCENARIO.guidanceRigs !== false ? GUIDANCE_RIG_MULT : 1); // 8,385 — still > the 7.5 km bubble per tick
    const back = norm(sub(c.hostile.center, c.friendly.center));
    c.missiles.push({
      pos: add(clone(target.pos), scale(back, 7900)), // just outside bubble, < 1 tick of travel
      prevPos: v3(), speed, infoKey: 'heavy', targetIdx: 0, expiresAt: 999, alive: true,
    });
    s.toggleBomb(0); // pulsing every cycle from now on
    s.step();
    expect(c.score.leaked).toBe(1);
    expect(c.score.killed).toBe(0);
  });

  it('upstream on-lane placement catches a full volley; far off-lane leaks it', () => {
    const run = (offLane: boolean): { killed: number; leaked: number } => {
      const s = drill({ hostileCount: 10, launchersPerShip: 4, friendlySpeed: 0, hostileSpeed: 0 });
      const c = s.combat!;
      const target = () => c.friendly.members[c.calledTargetIdx];
      // Position: on the hostile->target line, 5 km upstream of the target —
      // or 30 km perpendicular to it.
      const lane = norm(sub(c.hostile.center, target().pos));
      s.ship.pos = offLane
        ? add(clone(target().pos), scale(v3(-lane.z, 0, lane.x), 30_000))
        : add(clone(target().pos), scale(lane, 5_000));
      s.ship.prevPos = clone(s.ship.pos);
      s.ship.command = { kind: 'stop' };
      s.ship.throttle = 0;
      c.bombs.forEach((b, i) => b.toggle(i * 1)); // staggered
      for (let t = 0; t < 40; t++) s.step();
      return { killed: c.score.killed, leaked: c.score.leaked };
    };
    const on = run(false);
    expect(on.killed).toBeGreaterThan(on.leaked * 3); // catches the large majority
    const off = run(true);
    expect(off.killed).toBe(0);
    expect(off.leaked).toBeGreaterThan(30);           // whole volleys leak
  });

  it('missiles arrive as a stream: per-ship fire offsets, correct totals', () => {
    const s = drill({ hostileCount: 10, launchersPerShip: 4, volleyPeriodS: 8 });
    const c = s.combat!;
    for (let t = 0; t < 7; t++) s.step();
    // offsets are spread over [4, 12): by t=6 only part of the fleet has fired
    expect(c.score.launched).toBeGreaterThan(0);
    expect(c.score.launched).toBeLessThan(40);
    while (s.time < 28) s.step();
    // each ship fired floor((28-offset)/8)+1 = 3 or 4 cycles of 4 missiles
    expect(c.score.launched).toBeGreaterThanOrEqual(120);
    expect(c.score.launched).toBeLessThanOrEqual(160);
  });

  it('missiles cross 50 km in ~5-8 ticks at hull-bonused heavy speed', () => {
    const s = drill({ hostileCount: 1, launchersPerShip: 1, friendlySpeed: 0, hostileSpeed: 0, fightingDistanceKm: 50 });
    const c = s.combat!;
    while (c.score.launched === 0 && s.time < 15) s.step();
    const spawnTick = s.time;
    while (c.score.leaked === 0 && s.time < spawnTick + 20) s.step();
    expect(c.score.leaked).toBeGreaterThanOrEqual(1);
    const flight = c.score.recent.find(e => e.kind === 'leak')!.t - spawnTick;
    // ~44-56 km (hostile spread) at 9,675 m/s -> 4-7 ticks
    expect(flight).toBeGreaterThanOrEqual(3);
    expect(flight).toBeLessThanOrEqual(9);
  });

  it('hostile fleet warps: fires stop off-grid, lands at fighting distance, resumes', () => {
    const s = drill({ warpPeriodS: 20, hostileCount: 5, launchersPerShip: 1, friendlySpeed: 0 });
    const c = s.combat!;
    let sawHidden = false, launchedAtHide = 0, firedWhileHidden = 0, wasHidden = false;
    for (let t = 0; t < 90; t++) {
      s.step();
      const hidden = !c.hostileVisible();
      if (hidden) {
        if (!wasHidden) launchedAtHide = c.score.launched; // new hidden window
        sawHidden = true;
        firedWhileHidden += c.score.launched - launchedAtHide;
        launchedAtHide = c.score.launched;
      }
      wasHidden = hidden;
    }
    expect(sawHidden).toBe(true);
    expect(firedWhileHidden).toBe(0);
    // Seeded warp phases vary; give the fleet time to land and cycle a volley.
    while ((!c.hostileVisible() || c.score.launched <= launchedAtHide) && s.time < 140) s.step();
    expect(c.hostileVisible()).toBe(true);
    const d = Math.hypot(
      c.hostile.center.x - c.friendly.center.x,
      c.hostile.center.y - c.friendly.center.y,
      c.hostile.center.z - c.friendly.center.z);
    expect(Math.abs(d - 50_000)).toBeLessThan(15_000);
    expect(c.score.launched).toBeGreaterThan(launchedAtHide); // firing resumed
  });

  it('reaction time is recorded when the bubble covers the new lane', () => {
    const s = drill({ warpPeriodS: 15, hostileCount: 5, launchersPerShip: 1, friendlySpeed: 0, hostileSpeed: 0 });
    const c = s.combat!;
    s.ship.command = { kind: 'stop' };
    s.ship.pos = v3(500_000, 0, 500_000); // far away: lane never covered accidentally
    s.ship.prevPos = clone(s.ship.pos);
    while (c.score.reactions.length === 0 && s.time < 200) {
      s.step();
      if (c.pendingReactionAt !== null && s.time - c.pendingReactionAt === 3) {
        const T = c.friendly.members[c.calledTargetIdx].pos;
        const lane = norm(sub(c.hostile.center, T));
        s.ship.pos = add(clone(T), scale(lane, 6000)); // jump onto the lane
        s.ship.prevPos = clone(s.ship.pos);
      }
    }
    expect(c.score.reactions.length).toBeGreaterThan(0);
    expect(c.score.reactions[0]).toBeGreaterThanOrEqual(3);
    expect(c.score.reactions[0]).toBeLessThanOrEqual(5);
  });

  it('bumping pushes the player off ship hulls (option default on)', () => {
    const s = drill();
    const m = s.combat!.friendly.members[0];
    s.ship.command = { kind: 'stop' };
    s.ship.pos = clone(m.pos);
    s.ship.prevPos = clone(s.ship.pos);
    s.step();
    const d = Math.hypot(s.ship.pos.x - m.pos.x, s.ship.pos.y - m.pos.y, s.ship.pos.z - m.pos.z);
    expect(d).toBeGreaterThanOrEqual(550);
  });

  it('multi-fleet: each doctrine fires its own missiles; Eagle distractor fires none', () => {
    const s = drill({
      hostileCount: 10, warpPeriodS: 0, launchersPerShip: 2,
      extraFleets: [
        { doctrine: 'raven-cruise', count: 8, distanceKm: 90, warpPeriodS: 0 },
        { doctrine: 'eagle-rail', count: 8, distanceKm: 60, warpPeriodS: 0 },
      ],
    });
    const c = s.combat!;
    expect(c.hostiles.length).toBe(3);
    expect(c.hostiles[2].blob.members[0].type).toBe('Eagle');
    for (let t = 0; t < 25; t++) s.step();
    const speeds = new Set(c.missiles.map(m => Math.round(m.speed)));
    const rig = DEFAULT_SCENARIO.guidanceRigs !== false ? GUIDANCE_RIG_MULT : 1;
    expect(speeds.has(Math.round(MISSILE_INFO.heavy.speed * DEFAULT_SCENARIO.missileVelocityMult * rig)))
      .toBe(true);                                                                // Typhoon heavies (no hull velocity bonus)
    expect(speeds.has(Math.round(MISSILE_INFO.cruise.speed * DOCTRINES['raven-cruise'].mult * rig)))
      .toBe(true);                                                                // Raven cruise (×1.5 hull trait)
    expect(speeds.size).toBe(2);                                                  // Eagles fired nothing
    // each missile fleet has its own lane (called target may differ)
    expect(c.hostiles[0].p.missile).toBe('heavy');
    expect(c.hostiles[1].p.missile).toBe('cruise');
    expect(c.hostiles[2].p.missile).toBeNull();
  });

  it('segmentSphereChord: lane length inside the bubble', () => {
    const a = v3(-20000, 0, 0), b = v3(20000, 0, 0);
    // Sphere centered on the lane: full diameter chord.
    expect(segmentSphereChord(a, b, v3(0, 0, 0), 7500)).toBeCloseTo(15000, 5);
    // Off-axis by 6 km: chord = 2*sqrt(7500² − 6000²) = 9000.
    expect(segmentSphereChord(a, b, v3(0, 6000, 0), 7500)).toBeCloseTo(9000, 5);
    // Beyond radius: no coverage.
    expect(segmentSphereChord(a, b, v3(0, 8000, 0), 7500)).toBe(0);
    // Sphere past the segment end: clipped by the segment.
    expect(segmentSphereChord(a, b, v3(20000, 0, 0), 7500)).toBeCloseTo(7500, 5);
  });

  it('Barghest doctrine: ×3 hull velocity with halved flight time (range ×1.5 net)', () => {
    const s = drill({
      hostileCount: 5, warpPeriodS: 0, launchersPerShip: 1,
      extraFleets: [{ doctrine: 'barghest-cruise', count: 5, distanceKm: 110, warpPeriodS: 0 }],
    });
    const c = s.combat!;
    const rig = DEFAULT_SCENARIO.guidanceRigs !== false ? GUIDANCE_RIG_MULT : 1;
    const bSpeed = Math.round(MISSILE_INFO.cruise.speed * DOCTRINES['barghest-cruise'].mult * rig);
    const ft = MISSILE_INFO.cruise.flightS * DOCTRINES['barghest-cruise'].ftMult;
    let seen = 0;
    for (let t = 0; t < 30; t++) {
      const before = c.missiles.length;
      s.step();
      for (let i = before; i < c.missiles.length; i++) {
        const m = c.missiles[i];
        if (Math.round(m.speed) !== bSpeed) continue;
        seen++;
        expect(m.expiresAt - s.time).toBeGreaterThanOrEqual(Math.floor(ft));
        expect(m.expiresAt - s.time).toBeLessThanOrEqual(Math.ceil(ft));
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('drills are deterministic per seed', () => {
    const a = drill({ seed: 42 }), b = drill({ seed: 42 });
    for (let t = 0; t < 30; t++) { a.step(); b.step(); }
    expect(a.combat!.score).toEqual(b.combat!.score);
    expect(a.combat!.hostile.center).toEqual(b.combat!.hostile.center);
  });
});

describe('fleet discipline', () => {
  it('tight keeps the agile legacy helm; sloppy is slower, wider and laggier', () => {
    const tight = memberHelm(0, 'Apocalypse', 1150, 1000, 0.5, 0.5, 0.5);
    const real = memberHelm(0.5, 'Apocalypse', 1150, 1000, 0.5, 0.5, 0.5);
    const sloppy = memberHelm(1, 'Apocalypse', 1150, 1000, 0.5, 0.5, 0.5);
    expect(tight.tau).toBeCloseTo(3.75, 5);
    expect(tight.stopDist).toBe(1000);
    expect(real.tau).toBeGreaterThan(tight.tau);         // MWD battleship helm ~18 s
    expect(sloppy.tau).toBeGreaterThan(real.tau);
    expect(sloppy.speedMult).toBeLessThan(real.speedMult);
    expect(sloppy.stopDist).toBe(2500);
    expect(sloppy.maxLag).toBe(2 * real.maxLag);
  });

  it('a stopped MWD fleet burns back in at fleet speed, not the 100 m/s floor', () => {
    const s = drill({ friendlySpeed: 1150, warpPeriodS: 0 });
    const c = s.combat!;
    for (let t = 0; t < 240; t++) s.step();
    c.cfg.friendlySpeed = 0;
    for (let t = 0; t < 120; t++) s.step();
    const f = c.friendly;
    const d = f.members.map(m => len(sub(m.pos, f.center))).sort((a, b) => a - b);
    expect(d[Math.floor(d.length / 2)]).toBeLessThan(3000);
  });
});

describe('enemy FC', () => {
  const angleBetween = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
    Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z));

  it('a ruthless FC lands opposite the player bubble', () => {
    const s = drill({ fcSkill: 1, warpPeriodS: 20, hostileCount: 5, launchersPerShip: 1, friendlySpeed: 0 });
    const c = s.combat!;
    s.ship.command = { kind: 'stop' };
    s.ship.pos = add(clone(c.friendly.center), v3(40_000, 0, 0));
    s.ship.prevPos = clone(s.ship.pos);
    let landings = 0;
    let prev = c.hostiles[0].state;
    while (landings < 2 && s.time < 400) {
      s.step();
      const st = c.hostiles[0].state;
      if (st === 'landing' && prev === 'warping') {
        landings++;
        const h = sub(c.hostile.center, c.friendly.center);
        const p = sub(s.ship.pos, c.friendly.center);
        expect(angleBetween(h, p)).toBeGreaterThan((120 * Math.PI) / 180);
      }
      prev = st;
    }
    expect(landings).toBe(2);
  });

  it('a ruthless FC calls stragglers or logi and promotes its pre-called secondary', () => {
    const s = drill({ fcSkill: 1, retargetPeriodS: 5, friendlySpeed: 300, warpPeriodS: 0, hostileCount: 5 });
    const c = s.combat!;
    const f = c.hostiles[0];
    let calls = 0;
    let lastSecondary = f.secondaryIdx;
    for (let t = 0; t < 120; t++) {
      s.step();
      if (f.secondaryIdx !== lastSecondary) {
        calls++;
        if (lastSecondary !== null) expect(f.calledTargetIdx).toBe(lastSecondary);
        const sec = c.friendly.members[f.secondaryIdx!];
        const fc = c.friendly.center;
        const far = c.friendly.members
          .map((m, i) => ({ i, d: len(sub(m.pos, fc)) }))
          .filter(x => x.i !== f.calledTargetIdx)
          .sort((a, b) => b.d - a.d).slice(0, 3).map(x => x.i);
        expect(sec.type === 'Guardian' || far.includes(f.secondaryIdx!)).toBe(true);
        lastSecondary = f.secondaryIdx;
      }
    }
    expect(calls).toBeGreaterThan(10);
  });

  it('fleets that leave system are gone 20-45 s and reappear in Local ~8 s before landing', () => {
    const s = drill({ warpPeriodS: 20, hostileCount: 5, launchersPerShip: 1, friendlySpeed: 0 });
    const f = s.combat!.hostiles[0];
    let leftAt: number | null = null, backAt: number | null = null, trip: number | null = null;
    while (trip === null && s.time < 800) {
      const wasIn = f.inLocal, prevState = f.state;
      s.step();
      if (wasIn && !f.inLocal) { leftAt = s.time; backAt = null; }
      if (!wasIn && f.inLocal && f.state === 'warping') backAt = s.time;
      if (prevState === 'warping' && f.state === 'landing' && leftAt !== null) {
        trip = s.time - leftAt;
        expect(backAt).not.toBeNull();
        expect(s.time - backAt!).toBe(8);
      }
      if (prevState === 'warping' && f.state === 'landing') leftAt = null;
    }
    expect(trip).not.toBeNull();
    expect(trip!).toBeGreaterThanOrEqual(20);
    expect(trip!).toBeLessThanOrEqual(45);
  });

  it('alpha sync: the whole fleet fires on the same tick', () => {
    const s = drill({ alphaSync: true, hostileCount: 10, launchersPerShip: 1, warpPeriodS: 0, volleyPeriodS: 8 });
    const c = s.combat!;
    const bursts: number[] = [];
    for (let t = 0; t < 30; t++) {
      const before = c.score.launched;
      s.step();
      if (c.score.launched > before) bursts.push(c.score.launched - before);
    }
    expect(bursts.length).toBeGreaterThanOrEqual(3);
    for (const b of bursts) expect(b).toBe(10);
  });

  it('HAM dive fleet closes to ~15 km; long-range cruise fleet sits still', () => {
    const dive = drill({ missile: 'ham', shipType: 'Cerberus', missileVelocityMult: 2, hostileSpeed: 900,
      hostilePersonalities: true, warpPeriodS: 0, fightingDistanceKm: 50, friendlySpeed: 0 });
    for (let t = 0; t < 150; t++) dive.step();
    const dc = dive.combat!;
    expect(len(sub(dc.hostile.center, dc.friendly.center))).toBeLessThan(25_000);

    const sit = drill({ missile: 'cruise', shipType: 'Raven', missileVelocityMult: 1.5, hostileSpeed: 350,
      hostilePersonalities: true, warpPeriodS: 0, fightingDistanceKm: 120, friendlySpeed: 0 });
    const start = clone(sit.combat!.hostile.center);
    for (let t = 0; t < 60; t++) sit.step();
    expect(len(sub(sit.combat!.hostile.center, start))).toBeLessThan(500);
  });

  it('relocation callouts are hidden when training aids are off', () => {
    const s = drill({ warpPeriodS: 15, hostileCount: 5, launchersPerShip: 1, friendlySpeed: 0 });
    s.calloutsVisible = false;
    for (let t = 0; t < 120; t++) s.step();
    expect(s.notifications.some(n => /fleet/.test(n.text))).toBe(false);
  });
});
