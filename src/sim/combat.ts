// Combat layer: fleets, missile entities, the smartbomb rack, scoring.
//
// Authoritative order within each 1 Hz step (documented policy, calibratable):
//   1. Smartbomb pulses that occurred during the step window resolve against
//      the PREVIOUS tick's positions (tick-boundary sampling).
//   2. Player ship integrates.
//   3. Fleet blobs integrate (incl. hostile warp state machines).
//   4. Missiles: guidance -> move -> mid-tick impact (leak) or expiry.
//   5. New volleys spawn (per-ship launcher cycles); target calls rotate.
// A missile that impacts mid-tick was last catchable at its previous tick
// sample — this is what makes upstream positioning matter (see design brief).
import { Vec3, v3, add, sub, scale, norm, dist, len, cross, clone, dot } from './vec3';
import { PINNED, SKILLS } from './data';

export type MissileKey = 'light' | 'heavy' | 'ham' | 'cruise' | 'torpedo';

export const MISSILE_INFO: Record<MissileKey, { label: string; speed: number; flightS: number; baseDamage: number }> = {
  light: { label: 'Light Missile', speed: PINNED.missiles.light.allVVelocity, flightS: PINNED.missiles.light.allVFlightS, baseDamage: 83 },
  heavy: { label: 'Heavy Missile', speed: PINNED.missiles.heavy.allVVelocity, flightS: PINNED.missiles.heavy.allVFlightS, baseDamage: 149 },
  ham: { label: 'Heavy Assault Missile', speed: PINNED.missiles.ham.allVVelocity, flightS: PINNED.missiles.ham.allVFlightS, baseDamage: 100 },
  cruise: { label: 'Cruise Missile', speed: PINNED.missiles.cruise.allVVelocity, flightS: PINNED.missiles.cruise.allVFlightS, baseDamage: 375 },
  torpedo: { label: 'Torpedo', speed: PINNED.missiles.torpedo.allVVelocity, flightS: PINNED.missiles.torpedo.allVFlightS, baseDamage: 450 },
};

/** Length of the segment a→b that lies inside the sphere (center c, radius r).
 *  Divided by per-tick missile travel this gives the phase-averaged expected
 *  number of catchable tick-samples on a lane — the live "coverage" metric. */
export function segmentSphereChord(a: Vec3, b: Vec3, c: Vec3, r: number): number {
  const ab = sub(b, a);
  const L = len(ab);
  if (L < 1e-6) return 0;
  const d = scale(ab, 1 / L);
  const ac = sub(c, a);
  const t0 = dot(ac, d);
  const perp2 = Math.max(0, dot(ac, ac) - t0 * t0);
  const h2 = r * r - perp2;
  if (h2 <= 0) return 0;
  const h = Math.sqrt(h2);
  const lo = Math.max(0, t0 - h);
  const hi = Math.min(L, t0 + h);
  return Math.max(0, hi - lo);
}

/** Optional fleet-fit approximation on top of hull traits: two Hydraulic Bay
 *  Thruster I rigs ≈ 1.15 × (1 + 0.15×0.869) ≈ ×1.30 missile velocity.
 *  Toggleable in scenario config (guidanceRigs, default on). */
export const GUIDANCE_RIG_MULT = 1.3;

/** Doctrine presets for hostile fleets. mult = VERIFIED hull missile-velocity
 *  trait at skill V (EVE Uni, checked 2026-08-28): Raven +10%/lvl cruise/torp
 *  velocity → ×1.5; Barghest role +200% velocity with −50% flight time (range
 *  ×1.5 net); Cerberus +20%/lvl HAM velocity → ×2.0. Typhoon and Muninn have
 *  NO missile-velocity bonus (Typhoon: ROF + explosion velocity only; Muninn
 *  became a missile boat in the 2022 rework — confirming the user's meta). */
/** Hull class per ship type: bracket glyph selection + prop-speed presets. */
export type ShipClass = 'battleship' | 'cruiser';
export const SHIP_CLASS: Record<string, ShipClass> = {
  Typhoon: 'battleship', Raven: 'battleship', Barghest: 'battleship', Apocalypse: 'battleship',
  Machariel: 'battleship', Nestor: 'battleship',
  Cerberus: 'cruiser', Muninn: 'cruiser', Eagle: 'cruiser', Guardian: 'cruiser',
};

/** Rough all-V fleet speeds per hull class and prop choice (m/s). */
export type PropChoice = 'none' | 'ab' | 'mwd';
export const PROP_SPEEDS: Record<ShipClass, Record<PropChoice, number>> = {
  battleship: { none: 130, ab: 350, mwd: 1150 },
  cruiser: { none: 250, ab: 650, mwd: 2100 },
};

/** Member helm time constant by hull class and the prop the fleet speed
 *  implies. The player's plated Nestor derives to ~7 s on AB / ~20 s on MWD
 *  (data.ts tau()); fleet battleships get the same order, cruisers roughly a
 *  third. Sluggish helms are what fan a fleet out on every FC turn. APPROXIMATED. */
const HULL_TAU: Record<ShipClass, Record<PropChoice, number>> = {
  battleship: { none: 7, ab: 8, mwd: 18 },
  cruiser: { none: 2.5, ab: 3, mwd: 6.5 },
};
export function memberTau(shipType: string, fleetSpeed: number): number {
  const cls = SHIP_CLASS[shipType] ?? 'battleship';
  const s = PROP_SPEEDS[cls];
  const prop: PropChoice = fleetSpeed > (s.ab + s.mwd) / 2 ? 'mwd'
    : fleetSpeed > (s.none + s.ab) / 2 ? 'ab' : 'none';
  return HULL_TAU[cls][prop];
}

/** Piecewise-linear across the discipline anchors tight (0) / realistic (0.5) / sloppy (1). */
function lerp3(s: number, tight: number, real: number, sloppy: number): number {
  return s < 0.5 ? tight + (real - tight) * s * 2 : real + (sloppy - real) * (s - 0.5) * 2;
}

/** Per-member helm under the fleet-discipline setting. Takes the member's
 *  existing random draws (r1..r3 in 0..1) so the seeded rnd() sequence — and
 *  every phase derived from it — is identical at any setting. */
export function memberHelm(
  sloppiness: number, shipType: string, fleetSpeed: number,
  stopDist: number, r1: number, r2: number, r3: number,
): Pick<ShipEntity, 'tau' | 'speedMult' | 'maxLag' | 'stopDist'> {
  const s = Math.min(1, Math.max(0, sloppiness));
  const hull = memberTau(shipType, fleetSpeed);
  return {
    tau: lerp3(s, 2.5 + 2.5 * r1, hull * (0.85 + 0.4 * r1), hull * (1.1 + 0.6 * r1)),
    speedMult: lerp3(s, 0.90, 0.80, 0.72) + r2 * lerp3(s, 0.16, 0.22, 0.28),
    maxLag: (1500 + 7500 * r3) * lerp3(s, 1, 1, 2),
    stopDist: stopDist * lerp3(s, 1, 1, 2.5),
  };
}

export const DOCTRINES = {
  'typhoon-heavy': { ship: 'Typhoon', missile: 'heavy' as MissileKey | null, mult: 1.0, ftMult: 1, speed: 400 },
  'raven-cruise': { ship: 'Raven', missile: 'cruise' as MissileKey | null, mult: 1.5, ftMult: 1, speed: 350 },
  'barghest-cruise': { ship: 'Barghest', missile: 'cruise' as MissileKey | null, mult: 3.0, ftMult: 0.5, speed: 450 },
  'cerberus-ham': { ship: 'Cerberus', missile: 'ham' as MissileKey | null, mult: 2.0, ftMult: 1, speed: 900 },
  // Cerberus with heavies: Caldari Cruiser +10%/lvl missile velocity → ×1.5 (the HAM role bonus doesn't apply). VERIFY on next data pass.
  'cerberus-heavy': { ship: 'Cerberus', missile: 'heavy' as MissileKey | null, mult: 1.5, ftMult: 1, speed: 900 },
  'muninn-ham': { ship: 'Muninn', missile: 'ham' as MissileKey | null, mult: 1.0, ftMult: 1, speed: 900 },
  // Turret distractor: its damage can't be firewalled — the skill is ignoring its lane.
  'eagle-rail': { ship: 'Eagle', missile: null as MissileKey | null, mult: 1, ftMult: 1, speed: 900 },
} as const;
export type DoctrineKey = keyof typeof DOCTRINES;

export interface ExtraFleetConfig {
  doctrine: DoctrineKey;
  count: number;
  distanceKm: number;
  warpPeriodS: number;
  /** Optional prop override; unset = the doctrine's default speed. */
  prop?: PropChoice;
}

export interface ScenarioConfig {
  friendlyCount: number;
  friendlySpeed: number;        // anchor cruise speed m/s
  /** Blue DPS hull (display + helm class); Guardians stay the logi. Default Machariel. */
  friendlyHull?: string;
  // Fleet 1 (legacy flat fields, kept stable for tests/config):
  hostileCount: number;
  hostileSpeed: number;
  fightingDistanceKm: number;   // 10..255
  missile: MissileKey;
  missileVelocityMult: number;  // hull bonus (load-bearing, see design brief)
  guidanceRigs?: boolean;       // ×1.3 velocity fit approximation (default on)
  /** FC movement styles (user request): orbit, serpentine weave, straight
   *  burn-and-turn legs, or a figure-eight over the grid (blue only). */
  friendlyPattern?: 'orbit' | 'serpentine' | 'burnturn' | 'figure8';
  hostilePattern?: 'orbit' | 'serpentine';
  /** Guardians anchor as their own small ball ~15 km off the FC. */
  logiSeparate?: boolean;
  /** Hostile target calls prefer the Guardians about half the time. */
  hostilesTargetLogi?: boolean;
  /** Fleet discipline, both sides: 0 tight 1 km ball · 0.5 realistic
   *  hull-derived helms (default) · 1 sloppy strung-out worm. */
  fleetSloppiness?: number;
  /** Hostile FC skill 0..1. 0 = legacy random relocations and target calls;
   *  higher lands where the firewall isn't, relocates early when its missiles
   *  are dying, and calls stragglers / logi with a pre-called secondary. */
  fcSkill?: number;
  /** Doctrine personalities: cruise fleets kite (sit still at 100 km+), HAM
   *  fleets dive to ~15 km — sometimes burning straight through the ball —
   *  and warp in at that range. */
  hostilePersonalities?: boolean;
  /** Synced volleys (alpha) with hold-fire while repositioning, instead of a
   *  staggered stream. */
  alphaSync?: boolean;
  /** On relocation a wing of up to 15 ships sometimes lands on a second bearing. */
  wingSplits?: boolean;
  shipType?: string;            // display hull for fleet 1 (default Typhoon)
  warpPeriodS: number;          // fleet 1 (0 = never)
  /** Fleets 2-3 via doctrine presets. */
  extraFleets?: ExtraFleetConfig[];
  launchersPerShip: number;
  volleyPeriodS: number;
  retargetPeriodS: number;
  headingChangePeriodS: number;
  seed: number;
  /** Display name (preset / level / saved slot); purely cosmetic. */
  name?: string;
  /** Where the player spawns: just off the ball (default), on fleet 1's lane
   *  at the ideal firewall spot, or 30 km off to the side (reaction drill). */
  playerStart?: 'ball' | 'lane' | 'off';
  /** Gate-camp flavour: a static "Stargate" beacon under the friendly ball. */
  gate?: boolean;
}

// User's defaults (2026-09-13): Machariel blues on AB in a serpentine; cruise
// Typhoons on AB as fleet 1; an MWD Cerberus HAM fleet as fleet 2.
export const DEFAULT_SCENARIO: ScenarioConfig = {
  friendlyCount: 50, friendlySpeed: 350, friendlyHull: 'Machariel',
  hostileCount: 50, hostileSpeed: 350,
  fightingDistanceKm: 125, missile: 'cruise', missileVelocityMult: 1.0,
  guidanceRigs: true, friendlyPattern: 'serpentine', hostilePattern: 'orbit',
  fcSkill: 0.5, hostilePersonalities: true,
  shipType: 'Typhoon', warpPeriodS: 300,
  extraFleets: [{ doctrine: 'cerberus-heavy', count: 40, distanceKm: 60, warpPeriodS: 180, prop: 'mwd' }],
  name: 'Default — Machs vs cruise Typhoons 125 km + MWD heavy Cerbs 60 km',
  launchersPerShip: 4, volleyPeriodS: 8, retargetPeriodS: 30,
  headingChangePeriodS: 45, seed: 7,
};

/** Deterministic PRNG (mulberry32) so drills are reproducible per seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL_A = ['Kor', 'Vex', 'Tal', 'Mira', 'Dros', 'Ael', 'Numi', 'Rho', 'Sable', 'Ghar', 'Ori', 'Zan', 'Hel', 'Cass', 'Iber'];
const SYL_B = ['ath', 'en', 'ric', 'ova', 'ius', 'ka', 'dor', 'lin', 'mas', 'tez', 'wyn', 'ur', 'is', 'on', 'ette'];
export function pilotName(rnd: () => number): string {
  return SYL_A[Math.floor(rnd() * SYL_A.length)] + SYL_B[Math.floor(rnd() * SYL_B.length)]
    + ' ' + SYL_A[Math.floor(rnd() * SYL_A.length)] + SYL_B[Math.floor(rnd() * SYL_B.length)];
}

export interface ShipEntity {
  id: string; name: string; type: string; hostile: boolean;
  offset: Vec3;   // landing-spread offset from blob center (used on warp arrival)
  pos: Vec3;      // world position, member-piloted (chases the anchor point)
  prevPos: Vec3;  // previous-tick position (render interpolation)
  vel: Vec3;      // eased member velocity
  chaseOff: Vec3; // anchor point = blob center + chaseOff (zero = keep-at-range on the FC itself)
  stopDist: number; // keep-at-range distance on the anchor point (m)
  tau: number;      // per-member helm time constant (s)
  speedMult: number; // individual pilot speed vs fleet speed (slowpokes fall behind)
  maxLag: number;    // personal straggle limit (m): beyond this they burn to rejoin
  wingOff?: Vec3;    // split-wing offset from the fleet anchor (hostile wing splits)
}

const UP = v3(0, 1, 0);
const ANCHOR_ORBIT_R = 25_000;   // friendly FC's lazy orbit radius (m)

/** Members chase at their own pace. Pilots slower than the FC drift back
 *  until they hit their personal straggle limit (maxLag), then burn to hold
 *  it — so under way the fleet strings out into a worm sorted by pilot speed
 *  (head knot at the stop ring, tail out to ~6 km), and a stopped FC lets
 *  everyone close back into the ~1 km clump. */
const MEMBER_MIN_SPEED = 100;    // m/s, battleship-ish
const CATCHUP_MULT = 1.04;       // burn rate when past the personal straggle limit

/** A fleet: one smoothed center (the virtual FC) that members keep-at-range
 *  on individually — FC under way pulls them into a rough trailing line, FC
 *  stopped lets them bunch up around their stop rings. */
export class FleetBlob {
  center: Vec3;
  prevCenter: Vec3;
  vel = v3(0, 0, 0);
  members: ShipEntity[] = [];
  readonly tau: number;
  /** The fleet's cruise speed (m/s): members keep this pace capability even
   *  when the FC stops — a stopped MWD fleet burns back in at MWD speed. */
  cruiseSpeed = 0;

  constructor(center: Vec3, tau: number) {
    this.center = clone(center);
    this.prevCenter = clone(center);
    this.tau = tau;
  }

  integrate(vDes: Vec3, dt: number): void {
    const k = Math.exp(-dt / this.tau);
    this.prevCenter = clone(this.center);
    const dv = sub(this.vel, vDes);
    this.center = add(this.center, add(scale(vDes, dt), scale(dv, this.tau * (1 - k))));
    this.vel = add(vDes, scale(dv, k));
    const fleetSpeed = len(vDes);
    for (const m of this.members) {
      m.prevPos = m.pos;
      const anchor = add(this.center, m.wingOff ? add(m.chaseOff, m.wingOff) : m.chaseOff);
      const r = sub(anchor, m.pos);
      const d = len(r);
      // Past the personal straggle limit the pilot burns to rejoin; inside it
      // they cruise at their own pace (slower pilots drift back to their limit).
      const mult = d > m.maxLag ? Math.max(CATCHUP_MULT, m.speedMult) : m.speedMult;
      const cap = Math.max(Math.max(fleetSpeed, this.cruiseSpeed) * mult, MEMBER_MIN_SPEED);
      // Keep-at-range: close on (or back off from) the stop ring; the error
      // is the desired closing speed, so approach tapers instead of ringing.
      const spd = Math.max(-cap, Math.min(cap, (d - m.stopDist) / dt));
      const vDesM = d > 1 ? scale(r, spd / d) : v3(0, 0, 0);
      const km = Math.exp(-dt / m.tau);
      m.vel = add(vDesM, scale(sub(m.vel, vDesM), km));
      m.pos = add(m.pos, scale(m.vel, dt));
    }
  }

  teleport(dest: Vec3): void {
    this.center = clone(dest);
    this.prevCenter = clone(dest);
    this.vel = v3(0, 0, 0);
    // Land with a spread, dead in space; members then bunch onto their rings.
    for (const m of this.members) {
      m.pos = add(this.center, m.wingOff ? add(m.offset, m.wingOff) : m.offset);
      m.prevPos = m.pos;
      m.vel = v3(0, 0, 0);
    }
  }
}

export function ballOffsets(rnd: () => number, n: number, radius: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const r = radius * Math.cbrt(rnd());
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    out.push(v3(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.5, r * Math.sin(ph) * Math.sin(th)));
  }
  return out;
}

export interface Missile {
  pos: Vec3; prevPos: Vec3;
  speed: number;
  infoKey: MissileKey;
  targetIdx: number;      // index into friendly members
  expiresAt: number;
  alive: boolean;
  /** Impact bookkeeping for the renderer: the tick on which the missile hit
   *  and how far through that tick the impact fell (0..1]. A leaked missile
   *  is dead for the sim at once, but is still drawn flying its last leg to
   *  the impact point (it used to vanish a tick short of the target). */
  hitAt?: number;
  impactFrac?: number;
}

export interface TickerEvent { kind: 'kill' | 'leak'; text: string; pos?: Vec3; }
export interface PulseFx { pos: Vec3; }

export interface Score {
  launched: number; killed: number; leaked: number; expired: number;
  recent: { t: number; kind: 'kill' | 'leak' }[];  // for rolling window
  /** Seconds from each hostile warp-in until the player's bubble covered the new lane. */
  reactions: number[];
}

/** One Dark Blood Large EMP Smartbomb: pulse on activation, then each cycle.
 *  Toggling off mid-cycle "deactivates without repeating" at cycle end. */
export class Smartbomb {
  active = false;
  pendingOff = false;
  activatedAt = 0;
  nextPulseAt = 0;
  static readonly cycleS = (PINNED.modules.sbDarkBloodLargeEMP.durationMs / 1000) * SKILLS.energyPulseWeapons; // 7.5
  static readonly rangeM = PINNED.modules.sbDarkBloodLargeEMP.rangeM;   // 7500
  static readonly damage = PINNED.modules.sbDarkBloodLargeEMP.emDamage; // 375

  toggle(t: number): void {
    if (this.active) { this.pendingOff = !this.pendingOff; return; }
    this.active = true;
    this.pendingOff = false;
    this.activatedAt = t + 1e-3;
    this.nextPulseAt = this.activatedAt;
  }

  duePulses(t: number): number[] {
    const out: number[] = [];
    while (this.active && this.nextPulseAt <= t) {
      const isRepeat = this.nextPulseAt > this.activatedAt;
      if (isRepeat && this.pendingOff) {
        this.active = false;
        this.pendingOff = false;
        return out;
      }
      out.push(this.nextPulseAt);
      this.nextPulseAt += Smartbomb.cycleS;
    }
    return out;
  }

  cycleProgress(t: number): number {
    if (!this.active) return 0;
    const sinceStart = (t - this.activatedAt) % Smartbomb.cycleS;
    return Math.min(1, Math.max(0, sinceStart / Smartbomb.cycleS));
  }
}

interface FleetParams {
  shipType: string;
  missile: MissileKey | null;   // null = artillery/no missiles (distractor fleet)
  mult: number;                 // hull missile-velocity trait multiplier
  ftMult: number;               // hull flight-time multiplier (Barghest 0.5)
  speed: number;
  distanceKm: number;
  warpPeriodS: number;
  count: number;
  personality: FleetPersonality;
}

/** How a hostile fleet fights, beyond the geometric orbit/serpentine pattern. */
type FleetPersonality = 'standard' | 'kite' | 'dive' | 'sit';
const DIVE_RANGE_M = 15_000;   // HAM fleets dive to ~15 km and orbit (and warp in there)

function personalityFor(missile: MissileKey | null, distanceKm: number, on: boolean | undefined): FleetPersonality {
  if (!on || missile === null) return 'standard';
  if (missile === 'cruise') return distanceKm >= 100 ? 'sit' : 'kite';
  if (missile === 'ham') return 'dive';
  return 'standard';
}

/** One hostile fleet: blob + warp state machine + launcher cycles + target call. */
export class HostileFleet {
  readonly p: FleetParams;
  readonly blob: FleetBlob;
  readonly idPrefix: string;
  state: 'engaging' | 'aligning' | 'warping' | 'landing' = 'engaging';
  private stateUntil = 0;
  private warpDest: Vec3 | null = null;
  private nextWarpAt = Infinity;
  private orbitSign: 1 | -1 = 1;
  private weavePhase = 0;
  /** Local-chat presence: some relocations round-trip out of system, so the
   *  Local count drops on leave and spikes back shortly BEFORE the fleet
   *  lands — the real-world early warning the drill trains. */
  inLocal = true;
  private localReturnAt = 0;
  fireAt: number[] = [];
  calledTargetIdx = 0;
  /** Pre-called next primary (skilled FCs call a secondary with each primary). */
  secondaryIdx: number | null = null;
  private nextRetargetAt: number;
  pendingReactionAt: number | null = null;
  private holdWhileAligning = false;   // alpha-sync FCs call hold while repositioning
  private engagedAt = 0;
  private earlyWarpArmed = true;       // one adaptive early relocation per engagement
  private diveMode: 'orbit' | 'through' = 'orbit';
  private throughPoint: Vec3 | null = null;
  private pendingWingOff: Vec3 | null = null;

  constructor(w: CombatWorld, idx: number, p: FleetParams, bearing: number) {
    this.p = p;
    this.idPrefix = `h${idx}_`;
    const rnd = w.rnd;
    const hc = add(w.friendly.center, v3(
      Math.cos(bearing) * p.distanceKm * 1000, (rnd() - 0.5) * 4000,
      Math.sin(bearing) * p.distanceKm * 1000));
    this.blob = new FleetBlob(hc, 8);
    this.blob.cruiseSpeed = p.speed;
    // Hostiles anchor on their FC exactly like the friendlies do (real fleets
    // worm behind their anchor); the 6 km ballOffsets remain only as the
    // warp-landing scatter, which they contract out of after each jump.
    ballOffsets(rnd, p.count, 6000).forEach((off, i) => {
      this.blob.members.push({
        id: `${this.idPrefix}${i}`, name: pilotName(rnd), type: p.shipType,
        hostile: true, offset: off, pos: add(hc, off), prevPos: add(hc, off),
        vel: v3(0, 0, 0),
        chaseOff: scale(norm(v3(rnd() - 0.5, (rnd() - 0.5) * 0.5, rnd() - 0.5)), 60 + 120 * rnd()),
        ...memberHelm(w.cfg.fleetSloppiness ?? 0.5, p.shipType, p.speed,
          1000 + (200 + 200 * rnd()) * (rnd() < 0.5 ? -1 : 1), rnd(), rnd(), rnd()),
      });
    });
    this.fireAt = this.blob.members.map(() => 4 + Math.floor(rnd() * w.cfg.volleyPeriodS));
    // Alpha sync: everyone on one tick (draws above kept so seeded phases don't shift).
    this.holdWhileAligning = w.cfg.alphaSync === true;
    if (this.holdWhileAligning) this.fireAt = this.fireAt.map(() => 4);
    this.calledTargetIdx = Math.floor(rnd() * w.cfg.friendlyCount);
    this.nextRetargetAt = Math.round(w.cfg.retargetPeriodS * (0.5 + rnd()));
    this.orbitSign = rnd() < 0.5 ? 1 : -1;
    this.weavePhase = rnd() * Math.PI * 2;
    if (p.warpPeriodS > 0) this.nextWarpAt = Math.round(p.warpPeriodS * (0.7 + 0.6 * rnd()));
  }

  visible(): boolean { return this.state !== 'warping'; }
  canFire(): boolean {
    return this.p.missile !== null
      && (this.state === 'engaging' || (this.state === 'aligning' && !this.holdWhileAligning));
  }

  /** Engagement range: HAM divers hold (and warp in at) ~15 km. */
  private engageRange(): number {
    return this.p.personality === 'dive' ? DIVE_RANGE_M : this.p.distanceKm * 1000;
  }

  /** When the FC "sees missiles dying" (rolling 30 s intercept > 70%) it
   *  relocates sooner — once per engagement, sooner the better the FC. */
  private maybeRelocateEarly(w: CombatWorld, t: number): void {
    const skill = w.cfg.fcSkill ?? 0;
    if (skill <= 0 || !this.earlyWarpArmed || this.p.warpPeriodS <= 0 || this.p.missile === null) return;
    if (t - this.engagedAt < 20) return;
    const ri = w.rollingIntercept(t, 30);
    if (ri !== null && ri > 70) {
      this.earlyWarpArmed = false;
      this.nextWarpAt = Math.min(this.nextWarpAt, t + Math.round(12 * (1 - skill)));
    }
  }

  /** Pick a relocation bearing and start aligning. A skilled FC lands where
   *  the firewall isn't: opposite the player's bubble as seen from the ball,
   *  with less scatter the better the FC. Extra rnd() draws happen only in the
   *  skill / wing branches, so skill 0 replays the legacy seeded sequence. */
  private beginRelocation(w: CombatWorld, t: number): void {
    const rnd = w.rnd;
    const cur = sub(this.blob.center, w.friendly.center);
    const curBearing = Math.atan2(cur.z, cur.x);
    const delta = (Math.PI / 3 + rnd() * (Math.PI * 2 / 3)) * (rnd() < 0.5 ? 1 : -1);
    let b = curBearing + delta;
    const skill = w.cfg.fcSkill ?? 0;
    if (skill > 0 && rnd() < skill) {
      const p = sub(w.playerPos, w.friendly.center);
      b = Math.atan2(p.z, p.x) + Math.PI + (rnd() - 0.5) * Math.PI * 0.9 * (1 - 0.7 * skill);
    }
    const R = this.engageRange();   // dive fleets warp in at their dive range
    this.warpDest = add(w.friendly.center,
      v3(Math.cos(b) * R, (rnd() - 0.5) * 6000, Math.sin(b) * R));
    // Wing split: a wing lands on a second bearing 60-90° around the ball.
    this.pendingWingOff = null;
    if (w.cfg.wingSplits === true && this.blob.members.length >= 20 && rnd() < 0.5) {
      const b2 = b + (Math.PI / 3 + rnd() * Math.PI / 6) * (rnd() < 0.5 ? 1 : -1);
      const wingDest = add(w.friendly.center,
        v3(Math.cos(b2) * R, (rnd() - 0.5) * 6000, Math.sin(b2) * R));
      this.pendingWingOff = sub(wingDest, this.warpDest);
    }
    this.state = 'aligning';
    this.stateUntil = t + 6;
    w.callouts.push(`${this.p.shipType} fleet is aligning out`);
  }

  /** A real call: one of the most isolated pilots (stragglers, the worm's
   *  tail) or a Guardian — the targets that force "cover the ball or the lone lane". */
  private pickSmartTarget(w: CombatWorld, exclude: number | null = null): number {
    const fc = w.friendly.center;
    const ranked = w.friendly.members
      .map((m, i) => ({ i, d: dist(m.pos, fc), logi: m.type === 'Guardian' }))
      .filter(x => x.i !== exclude)
      .sort((a, b) => b.d - a.d);
    if (w.rnd() < 0.6) return ranked[Math.floor(w.rnd() * Math.min(3, ranked.length))].i;
    const logi = ranked.filter(x => x.logi);
    if (logi.length) return logi[Math.floor(w.rnd() * logi.length)].i;
    return ranked[Math.floor(w.rnd() * ranked.length)].i;
  }

  step(w: CombatWorld, dt: number, t: number): void {
    const rnd = w.rnd;
    switch (this.state) {
      case 'engaging': {
        const r = sub(this.blob.center, w.friendly.center);
        const d = Math.max(len(r), 1);
        const rHat = scale(r, 1 / d);
        const pers = this.p.personality;
        if (pers === 'sit') {
          // Long-range cruise fleets often just sit still on a ping.
          this.blob.integrate(v3(0, 0, 0), dt);
        } else if (pers === 'dive' && this.diveMode === 'through' && this.throughPoint) {
          // Burn straight through the ball and out the far side, then orbit.
          const to = sub(this.throughPoint, this.blob.center);
          if (len(to) < 3000) this.diveMode = 'orbit';
          this.blob.integrate(scale(norm(to), this.p.speed), dt);
        } else {
          let tang = cross(UP, rHat);
          if (len(tang) < 1e-6) tang = v3(1, 0, 0);
          tang = scale(norm(tang), this.orbitSign);
          // Hold the fighting distance while circling; the serpentine pattern
          // adds a radial weave on top of the orbit (user request).
          let radial = Math.max(-1, Math.min(1, (this.engageRange() - d) / 5000));
          if (w.cfg.hostilePattern === 'serpentine') {
            radial += 0.6 * Math.sin((2 * Math.PI * t) / 35 + this.weavePhase);
          }
          if (pers === 'kite') {
            // Kite: pull range while the blues burn at them; if they get
            // inside 60% of the fighting distance anyway, warp out.
            if (dot(w.friendly.vel, rHat) > 50) radial = 1;
            if (d < this.engageRange() * 0.6 && this.p.warpPeriodS > 0) {
              this.nextWarpAt = Math.min(this.nextWarpAt, t);
            }
          }
          const dir = norm(add(tang, scale(rHat, radial)));
          this.blob.integrate(scale(dir, this.p.speed), dt);
        }
        this.maybeRelocateEarly(w, t);
        if (t >= this.nextWarpAt) this.beginRelocation(w, t);
        break;
      }
      case 'aligning': {
        const dir = norm(sub(this.warpDest!, this.blob.center));
        this.blob.integrate(scale(dir, Math.max(this.p.speed, 250)), dt);
        if (t >= this.stateUntil) {
          this.state = 'warping';
          this.stateUntil = t + 8 + Math.round(rnd() * 4);
          this.pendingReactionAt = null;
          // Half the relocations leave the system entirely. A real system
          // change (out through a gate and back) takes 20-45 s, not a ping
          // bounce; Local drops now and spikes again ~8 s before they land.
          if (rnd() < 0.5) {
            this.inLocal = false;
            this.stateUntil = t + 20 + Math.round(rnd() * 25);
            this.localReturnAt = this.stateUntil - 8;
          }
          w.callouts.push(`${this.p.shipType} fleet has warped off grid`);
        }
        break;
      }
      case 'warping': {
        if (!this.inLocal && t >= this.localReturnAt) this.inLocal = true;
        if (t >= this.stateUntil) {
          this.inLocal = true;
          const wingN = this.pendingWingOff ? Math.min(15, Math.floor(this.blob.members.length * 0.3)) : 0;
          this.blob.members.forEach((m, i) => { m.wingOff = i < wingN ? this.pendingWingOff! : undefined; });
          this.blob.teleport(this.warpDest!);
          this.state = 'landing';
          this.stateUntil = t + 5;
          if (this.p.missile !== null) this.pendingReactionAt = t;
          w.callouts.push(wingN > 0
            ? `${this.p.shipType} fleet has landed — split into two wings`
            : `${this.p.shipType} fleet has landed — new lane`);
        }
        break;
      }
      case 'landing': {
        this.blob.integrate(v3(0, 0, 0), dt);
        if (t >= this.stateUntil) {
          this.state = 'engaging';
          this.fireAt = this.blob.members.map(() => t + Math.floor(rnd() * w.cfg.volleyPeriodS));
          // Alpha sync: hold released → one synced first volley this tick.
          if (this.holdWhileAligning) this.fireAt = this.fireAt.map(() => t);
          this.nextWarpAt = t + Math.round(this.p.warpPeriodS * (0.7 + 0.6 * rnd()));
          this.orbitSign = rnd() < 0.5 ? 1 : -1;
          this.engagedAt = t;
          this.earlyWarpArmed = true;
          this.diveMode = 'orbit';
          this.throughPoint = null;
          if (this.p.personality === 'dive' && rnd() < 0.35) {
            // Burn-through: aim at the point past the ball on the far side.
            this.diveMode = 'through';
            const toBall = sub(w.friendly.center, this.blob.center);
            this.throughPoint = add(w.friendly.center, scale(norm(toBall), this.engageRange()));
          }
        }
        break;
      }
    }
  }

  spawn(w: CombatWorld, t: number): void {
    if (t >= this.nextRetargetAt) {
      this.nextRetargetAt += w.cfg.retargetPeriodS;
      const skill = w.cfg.fcSkill ?? 0;
      if (skill > 0 && w.rnd() < skill) {
        // Skilled call: promote the pre-called secondary, pre-call the next.
        this.calledTargetIdx = this.secondaryIdx ?? this.pickSmartTarget(w);
        this.secondaryIdx = this.pickSmartTarget(w, this.calledTargetIdx);
      } else if (w.cfg.hostilesTargetLogi === true && w.rnd() < 0.5) {
        // With the option on, target calls go for the logi about half the time
        // (real hostile FCs call the Guardians first).
        const logi = w.friendly.members
          .map((m, i) => ({ m, i })).filter(x => x.m.type === 'Guardian');
        this.calledTargetIdx = logi[Math.floor(w.rnd() * logi.length)].i;
      } else {
        this.calledTargetIdx = Math.floor(w.rnd() * w.cfg.friendlyCount);
      }
    }
    if (!this.canFire()) return;
    const info = MISSILE_INFO[this.p.missile!];
    const rig = w.cfg.guidanceRigs !== false ? GUIDANCE_RIG_MULT : 1;
    const flightS = info.flightS * this.p.ftMult;
    this.blob.members.forEach((h, i) => {
      if (t < this.fireAt[i]) return;
      this.fireAt[i] += w.cfg.volleyPeriodS;
      for (let l = 0; l < w.cfg.launchersPerShip; l++) {
        const jitter = v3((w.rnd() - 0.5) * 400, (w.rnd() - 0.5) * 400, (w.rnd() - 0.5) * 400);
        const whole = Math.floor(flightS);
        const flight = whole + (w.rnd() < flightS - whole ? 1 : 0);
        w.missiles.push({
          pos: add(h.pos, jitter), prevPos: add(h.pos, jitter),
          speed: info.speed * this.p.mult * rig, infoKey: this.p.missile!,
          targetIdx: this.calledTargetIdx, expiresAt: t + flight, alive: true,
        });
        w.score.launched++;
      }
    });
  }

  /** Reaction: covered = within smartbomb range of this fleet's lane, near the friendly end. */
  checkReaction(w: CombatWorld, t: number, shipPos: Vec3): void {
    if (this.pendingReactionAt === null) return;
    const T = w.friendly.members[this.calledTargetIdx].pos;
    const H = this.blob.center;
    const seg = sub(H, T);
    const L2 = Math.max(dot(seg, seg), 1);
    const u = Math.max(0, Math.min(1, dot(sub(shipPos, T), seg) / L2));
    const closest = add(T, scale(seg, u));
    if (dist(shipPos, closest) <= Smartbomb.rangeM && dist(shipPos, T) <= 45_000) {
      w.score.reactions.push(t - this.pendingReactionAt);
      this.pendingReactionAt = null;
    }
  }
}

export class CombatWorld {
  readonly cfg: ScenarioConfig;
  readonly rnd: () => number;
  friendly: FleetBlob;
  hostiles: HostileFleet[] = [];
  missiles: Missile[] = [];
  bombs: Smartbomb[] = Array.from({ length: 7 }, () => new Smartbomb());
  score: Score = { launched: 0, killed: 0, leaked: 0, expired: 0, recent: [], reactions: [] };
  ticker: TickerEvent[] = [];
  pulseFx: PulseFx[] = [];
  /** Missile-kill flashes for the renderer (drained each frame, like pulseFx). */
  killFx: PulseFx[] = [];
  callouts: string[] = [];
  /** Player position as of the last reaction check — what a hostile FC "sees". */
  playerPos = v3(0, 0, 0);
  private friendlyHeading: Vec3;
  private nextHeadingChangeAt: number;
  private anchorOrbitCenter = v3(0, 0, 0);
  private anchorOrbitSign: 1 | -1 = 1;
  private fig8Phase = 0;

  constructor(cfg: ScenarioConfig) {
    this.cfg = cfg;
    this.rnd = makeRng(cfg.seed);
    const rnd = this.rnd;

    this.friendly = new FleetBlob(v3(0, 0, 12_000), 10);
    this.friendly.cruiseSpeed = cfg.friendlySpeed; // fixed by the fit, even if the FC later stops
    // Anchor orbit ring: the fleet spawns ON the ring so the orbit starts clean.
    this.anchorOrbitCenter = add(this.friendly.center, v3(-ANCHOR_ORBIT_R, 0, 0));
    this.anchorOrbitSign = rnd() < 0.5 ? 1 : -1;
    // Friendlies keep-at-range ~1 km on the FC itself (chaseOff ~zero): FC
    // under way strings them into a trailing line (varied pilot speeds do the
    // spreading); FC stopped bunches them into a tight clump. With the
    // logiSeparate option the Guardians instead anchor their own small ball
    // ~15 km off the FC, as real fleets do.
    const logiDirTh = rnd() * Math.PI * 2;
    const logiOff = v3(Math.cos(logiDirTh) * 15_000, 2000 * (rnd() - 0.5), Math.sin(logiDirTh) * 15_000);
    const hull = cfg.friendlyHull ?? 'Machariel';
    for (let i = 0; i < cfg.friendlyCount; i++) {
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(2 * rnd() - 1);
      const dir = v3(Math.sin(ph) * Math.cos(th), Math.cos(ph) * 0.5, Math.sin(ph) * Math.sin(th));
      const isLogi = i % 4 === 0;
      const sepLogi = isLogi && cfg.logiSeparate === true;
      const stopDist = (sepLogi ? 700 : 1000) + (200 + 200 * rnd()) * (rnd() < 0.5 ? -1 : 1);
      const off = scale(norm(dir), Math.max(400, stopDist));
      // Small lateral chase-point jitter: just enough that the line isn't one
      // mathematically exact ray, small enough that it still reads as a line.
      const jitter = scale(norm(v3(rnd() - 0.5, (rnd() - 0.5) * 0.5, rnd() - 0.5)), 60 + 120 * rnd());
      this.friendly.members.push({
        id: `f${i}`, name: pilotName(rnd),
        type: isLogi ? 'Guardian' : hull,
        hostile: false, offset: off, pos: add(this.friendly.center, off),
        prevPos: add(this.friendly.center, off),
        vel: v3(0, 0, 0),
        chaseOff: sepLogi ? add(logiOff, jitter) : jitter,
        // Helm, pace, straggle limit and keep-at-range per the fleet-discipline
        // setting (see memberHelm); at realistic only a handful hold the head.
        ...memberHelm(cfg.fleetSloppiness ?? 0.5, isLogi ? 'Guardian' : hull,
          cfg.friendlySpeed, stopDist, rnd(), rnd(), rnd()),
      });
    }

    // Fleet 1 from the flat config fields; fleets 2-3 from doctrine presets.
    const baseBearing = rnd() * Math.PI * 2;
    this.hostiles.push(new HostileFleet(this, 0, {
      shipType: cfg.shipType ?? 'Typhoon', missile: cfg.missile, mult: cfg.missileVelocityMult,
      ftMult: 1, speed: cfg.hostileSpeed, distanceKm: cfg.fightingDistanceKm,
      warpPeriodS: cfg.warpPeriodS, count: cfg.hostileCount,
      personality: personalityFor(cfg.missile, cfg.fightingDistanceKm, cfg.hostilePersonalities),
    }, baseBearing));
    (cfg.extraFleets ?? []).slice(0, 2).forEach((ef, i) => {
      const d = DOCTRINES[ef.doctrine];
      const speed = ef.prop ? PROP_SPEEDS[SHIP_CLASS[d.ship] ?? 'battleship'][ef.prop] : d.speed;
      this.hostiles.push(new HostileFleet(this, i + 1, {
        shipType: d.ship, missile: d.missile, mult: d.mult, ftMult: d.ftMult, speed,
        distanceKm: ef.distanceKm, warpPeriodS: ef.warpPeriodS, count: ef.count,
        personality: personalityFor(d.missile, ef.distanceKm, cfg.hostilePersonalities),
      }, baseBearing + (i + 1) * (Math.PI * 2 / 3) + (rnd() - 0.5)));
    });

    this.friendlyHeading = norm(v3(rnd() - 0.5, (rnd() - 0.5) * 0.2, rnd() - 0.5));
    this.nextHeadingChangeAt = cfg.headingChangePeriodS;
  }

  // Back-compat accessors (fleet 1) used by tests and simple UI paths.
  get hostile(): FleetBlob { return this.hostiles[0].blob; }
  get calledTargetIdx(): number { return this.hostiles[0].calledTargetIdx; }
  get pendingReactionAt(): number | null { return this.hostiles[0].pendingReactionAt; }
  hostileVisible(): boolean { return this.hostiles[0].visible(); }

  /** Local-chat member count: you + friendlies + hostiles currently in system. */
  localCount(): number {
    let n = 1 + this.friendly.members.length;
    for (const f of this.hostiles) if (f.inLocal) n += f.blob.members.length;
    return n;
  }

  oldestPendingReaction(): number | null {
    let oldest: number | null = null;
    for (const f of this.hostiles) {
      if (f.pendingReactionAt !== null && (oldest === null || f.pendingReactionAt < oldest)) {
        oldest = f.pendingReactionAt;
      }
    }
    return oldest;
  }

  resolvePulses(t: number, shipPos: Vec3): void {
    let pulseCount = 0;
    for (const b of this.bombs) pulseCount += b.duePulses(t).length;
    if (pulseCount === 0) return;
    for (let i = 0; i < pulseCount; i++) this.pulseFx.push({ pos: clone(shipPos) });
    for (const m of this.missiles) {
      if (!m.alive) continue;
      if (dist(m.pos, shipPos) <= Smartbomb.rangeM) {
        m.alive = false;
        this.killFx.push({ pos: clone(m.pos) });
        this.score.killed++;
        this.score.recent.push({ t, kind: 'kill' });
        this.ticker.push({
          kind: 'kill',
          text: `${(Smartbomb.damage * pulseCount).toLocaleString('en-US')} to ${MISSILE_INFO[m.infoKey].label} - Hits`,
          pos: clone(m.pos),
        });
      }
    }
  }

  stepFleets(dt: number, t: number): void {
    this.friendly.integrate(this.anchorDesiredVel(t), dt);
    for (const f of this.hostiles) f.step(this, dt, t);
  }

  /** Friendly FC movement: large lazy orbit, serpentine weave, straight
   *  burn-and-turn legs (heading re-rolls every headingChangePeriodS), or a
   *  figure-eight swept over the grid center. */
  private anchorDesiredVel(t: number): Vec3 {
    const sp = this.cfg.friendlySpeed;
    if (sp <= 0) return v3(0, 0, 0);
    const pat = this.cfg.friendlyPattern ?? 'orbit';
    if (pat === 'burnturn') return scale(this.friendlyHeading, sp);
    if (pat === 'figure8') {
      // Steer at a carrot a little ahead on a Gerono lemniscate (25 x 12 km).
      this.fig8Phase += (sp / 90_000) * 1; // rough mean path speed -> phase rate
      const carrot = add(this.anchorOrbitCenter, v3(
        25_000 * Math.sin(this.fig8Phase + 0.25), 0,
        12_000 * Math.sin(2 * (this.fig8Phase + 0.25))));
      const to = sub(carrot, this.friendly.center);
      return len(to) < 1 ? v3(0, 0, 0) : scale(norm(to), sp);
    }
    if (pat === 'orbit') {
      const r = sub(this.friendly.center, this.anchorOrbitCenter);
      const d = len(r);
      if (d < 1) return scale(v3(1, 0, 0), sp);
      const rHat = scale(r, 1 / d);
      let tang = cross(UP, rHat);
      if (len(tang) < 1e-6) tang = v3(1, 0, 0);
      tang = scale(norm(tang), this.anchorOrbitSign);
      const radial = Math.max(-1, Math.min(1, (ANCHOR_ORBIT_R - d) / 8000));
      return scale(norm(add(tang, scale(rHat, radial))), sp);
    }
    const h = this.friendlyHeading;
    let perp = cross(UP, h);
    if (len(perp) < 1e-6) perp = v3(1, 0, 0);
    const weave = Math.sin((2 * Math.PI * t) / 40);
    return scale(norm(add(h, scale(norm(perp), 0.8 * weave))), sp);
  }

  stepMissiles(t: number): void {
    for (const m of this.missiles) {
      if (!m.alive) continue;
      const target = this.friendly.members[m.targetIdx];
      const d = dist(m.pos, target.pos);
      if (d <= m.speed) {
        m.alive = false;
        m.hitAt = t;
        m.impactFrac = Math.max(0.05, d / m.speed);
        m.prevPos = clone(m.pos);
        m.pos = clone(target.pos);
        this.score.leaked++;
        this.score.recent.push({ t, kind: 'leak' });
        const info = MISSILE_INFO[m.infoKey];
        const dmg = Math.round(info.baseDamage * 1.5 * (0.8 + 0.4 * this.rnd()));
        const verb = ['Glances Off', 'Hits', 'Penetrates', 'Smashes', 'Wrecks'][Math.floor(this.rnd() * 5)];
        this.ticker.push({ kind: 'leak', text: `${dmg} to ${target.name} - ${verb}`, pos: clone(target.pos) });
        continue;
      }
      if (t >= m.expiresAt) { m.alive = false; this.score.expired++; continue; }
      const dir = norm(sub(target.pos, m.pos));
      m.prevPos = clone(m.pos);
      m.pos = add(m.pos, scale(dir, m.speed));
    }
    if (this.missiles.length > 8000) this.missiles = this.missiles.filter(m => m.alive);
  }

  stepSpawns(t: number): void {
    if (t >= this.nextHeadingChangeAt) {
      this.nextHeadingChangeAt += this.cfg.headingChangePeriodS;
      this.friendlyHeading = norm(v3(this.rnd() - 0.5, (this.rnd() - 0.5) * 0.2, this.rnd() - 0.5));
    }
    for (const f of this.hostiles) f.spawn(this, t);
    const cutoff = t - 120;
    while (this.score.recent.length && this.score.recent[0].t < cutoff) this.score.recent.shift();
  }

  checkReaction(t: number, shipPos: Vec3): void {
    this.playerPos = clone(shipPos);
    for (const f of this.hostiles) f.checkReaction(this, t, shipPos);
  }

  aliveMissiles(): number {
    let n = 0;
    for (const m of this.missiles) if (m.alive) n++;
    return n;
  }

  rollingIntercept(t: number, windowS = 60): number | null {
    let k = 0, l = 0;
    for (const e of this.score.recent) {
      if (e.t >= t - windowS) { if (e.kind === 'kill') k++; else l++; }
    }
    return k + l === 0 ? null : (k / (k + l)) * 100;
  }
}
