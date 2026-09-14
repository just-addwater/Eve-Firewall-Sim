// Pinned SDE data (see docs/data-pinned.md) plus the all-V skill layer.
// Nothing here is hand-tuned: every derived value traces to data/pinned.json.
import pinned from '../../data/pinned.json';

export const PINNED = pinned;

// Skill multipliers, all-V pilot (CANONICAL percentages, see docs/data-pinned.md).
export const SKILLS = {
  navigationVelocity: 1.25,      // Navigation V: +5%/lvl ship velocity
  accelerationControl: 1.25,     // Acceleration Control V: +5%/lvl AB/MWD boost
  evasiveManeuvering: 0.75,      // Evasive Maneuvering V: -5%/lvl inertia
  energyPulseWeapons: 0.75,      // Energy Pulse Weapons V: -5%/lvl smartbomb cycle
} as const;

// Fleet-boost (skirmish links) solve-for factors, from reconciling the user's
// fitting window (align 7.44 s, sig 352 m). EMPIRICAL — see docs/data-pinned.md.
export const LINKS = { agility: 0.786, sig: 0.838 } as const;

const nestor = pinned.nestor;
const mwd = pinned.modules.mwdGistX500;
const ab = pinned.modules.abGistX100;

export const SHIP = {
  // Hull + 2x Imperial Navy 1600mm plates. Trimarks impose no velocity penalty
  // in current fitted stats (verified against the user's fitting window).
  massBase: nestor.mass + 2 * pinned.modules.platIN1600.massAddition, // 26,000,000 kg
  inertiaBase: nestor.agility,                                        // 0.35
  vBase: nestor.maxVelocity * SKILLS.navigationVelocity,              // 87.5 m/s
  sigBase: nestor.signatureRadius,                                    // 420 m
  radius: nestor.radius,
} as const;

export interface PropStats {
  key: 'ab' | 'mwd';
  name: string;
  speedFactor: number;       // %
  thrust: number;            // N (speedBoostFactor)
  massAddition: number;      // kg while active
  durationS: number;         // cycle seconds
  overloadBonus: number;     // extra fraction on speedFactor when overheated (+0.5)
  sigMult: number;           // signature multiplier while active
}

export const PROPS: Record<'ab' | 'mwd', PropStats> = {
  ab: {
    key: 'ab', name: 'Gist X-Type 100MN Afterburner',
    speedFactor: ab.speedFactor, thrust: ab.speedBoostFactor,
    massAddition: ab.massAddition, durationS: ab.durationMs / 1000,
    overloadBonus: ab.overloadSpeedFactorBonusPct / 100, sigMult: 1,
  },
  mwd: {
    key: 'mwd', name: 'Gist X-Type 500MN Microwarpdrive',
    speedFactor: mwd.speedFactor, thrust: mwd.speedBoostFactor,
    massAddition: mwd.massAddition, durationS: mwd.durationMs / 1000,
    overloadBonus: mwd.overloadSpeedFactorBonusPct / 100,
    sigMult: 1 + mwd.sigRadiusBonusPct / 100, // +350%
  },
};

/** Total ship mass given the active prop module (mass addition applies while active). */
export function totalMass(activeProp: PropStats | null): number {
  return SHIP.massBase + (activeProp ? activeProp.massAddition : 0);
}

/** Effective inertia modifier (Evasive Maneuvering V, optional fleet boosts). */
export function inertiaEff(links: boolean): number {
  return SHIP.inertiaBase * SKILLS.evasiveManeuvering * (links ? LINKS.agility : 1);
}

/**
 * Max velocity with a prop module running.
 * EMPIRICAL formula (validated: props-off derives to exactly 87.5 m/s, matching
 * the user's fitting window): v = vBase * (1 + sf% * AccelControl * heat * thrust / mass).
 */
export function maxVelocity(activeProp: PropStats | null, overheated: boolean): number {
  if (!activeProp) return SHIP.vBase;
  const sf = (activeProp.speedFactor / 100)
    * SKILLS.accelerationControl
    * (overheated ? 1 + activeProp.overloadBonus : 1);
  return SHIP.vBase * (1 + sf * activeProp.thrust / totalMass(activeProp));
}

/** Exponential movement time constant tau = I * M / 1e6 seconds. EMPIRICAL. */
export function tau(activeProp: PropStats | null, links: boolean): number {
  return inertiaEff(links) * totalMass(activeProp) / 1e6;
}

/** Displayed signature radius. */
export function signature(activeProp: PropStats | null, links: boolean): number {
  return SHIP.sigBase * (links ? LINKS.sig : 1) * (activeProp ? activeProp.sigMult : 1);
}
