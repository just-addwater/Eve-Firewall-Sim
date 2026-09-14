// World container: authoritative 1 Hz stepping, entities, notifications.
import { Vec3, v3, dist, clone, add, sub, scale, dot, norm } from './vec3';
import { Ship, Command, TargetInfo } from './ship';
import { PropKey } from './modules';
import { CombatWorld, ScenarioConfig, DEFAULT_SCENARIO, SHIP_CLASS, MISSILE_INFO, GUIDANCE_RIG_MULT } from './combat';
import { PINNED } from './data';

const MJD = {
  spoolS: PINNED.modules.mjdLarge.spoolAtSkillVMs / 1000,        // 9 s at skill V
  cooldownS: PINNED.modules.mjdLarge.reactivationMs / 1000,      // 180 s
  jumpM: PINNED.modules.mjdLarge.jumpDistanceM,                  // 100 km
};

export interface Beacon { id: string; name: string; pos: Vec3; }
export interface Notification { text: string; at: number; }

export class Sim {
  time = 0;                       // integer seconds (authoritative ticks completed)
  readonly ship = new Ship();
  beacons: Beacon[] = [];
  combat: CombatWorld | null = null;
  notifications: Notification[] = [];
  /** Approximate sphere bumping vs fleet members (option, default on). APPROXIMATED. */
  collisions = true;
  /** Hostile-fleet text callouts ("aligning out", "landed") are a training aid:
   *  with aids off the player reads relocations from the overview and Local. */
  calloutsVisible = true;

  lookup = (id: string): TargetInfo | null => {
    const b = this.beacons.find(x => x.id === id);
    if (b) return { pos: b.pos, vel: v3(0, 0, 0), name: b.name };
    if (this.combat) {
      if (id === 'anchor') return { pos: this.combat.friendly.center, vel: this.combat.friendly.vel, name: 'Fleet anchor' };
      let side = null;
      if (id[0] === 'f') side = this.combat.friendly;
      else if (id[0] === 'h') side = this.combat.hostiles[parseInt(id.slice(1), 10)]?.blob ?? null;
      if (side) {
        const m = side.members.find(x => x.id === id);
        if (m) return { pos: m.pos, vel: side.vel, name: `${m.name} (${m.type})` };
      }
    }
    return null;
  };

  /** Authoritative step. Order is a documented, calibratable policy — see combat.ts. */
  step(): void {
    this.time += 1;
    if (this.combat) {
      // 1. Pulses resolve against the previous tick's positions.
      this.combat.resolvePulses(this.time, clone(this.ship.pos));
    }
    // 2. Player ship integrates; MJD timers resolve on the tick.
    this.ship.step(1, this.time, this.lookup);
    const mjd = this.ship.mjd;
    if (mjd.state === 'spooling' && this.time >= mjd.spoolEndsAt) {
      const h = this.ship.heading;
      this.ship.pos = add(this.ship.pos, scale(h, MJD.jumpM));
      this.ship.prevPos = clone(this.ship.pos);   // no interpolation streak across the jump
      mjd.state = 'cooldown';
      mjd.readyAt = this.time + MJD.cooldownS;
      this.notify('Micro Jump Drive engaged — jumped 100 km');
    } else if (mjd.state === 'cooldown' && this.time >= mjd.readyAt) {
      mjd.state = 'idle';
    }
    if (this.combat) {
      // 3. Fleets, 4. missiles (guidance/move/impact/expiry), 5. spawns.
      this.combat.stepFleets(1, this.time);
      this.combat.stepMissiles(this.time);
      this.combat.stepSpawns(this.time);
      if (this.collisions) this.resolveBumps();
      this.combat.checkReaction(this.time, this.ship.pos);
      for (const text of this.combat.callouts.splice(0)) if (this.calloutsVisible) this.notify(text);
    }
  }

  /** Sphere bumps vs fleet members: skimming the ball at speed costs you.
   *  Client collisions are near-elastic and mass-weighted — a Nestor at MWD
   *  speed gets thrown well off line and shoves the other hull too. The
   *  kicked velocity then decays under the normal helm tau. APPROXIMATED. */
  private resolveBumps(): void {
    const MIN_SEP = 600;      // m, ~two battleship hulls
    const RESTITUTION = 0.8;  // near-elastic
    const mShip = this.ship.mass();
    const blobs = [this.combat!.friendly];
    for (const f of this.combat!.hostiles) if (f.visible()) blobs.push(f.blob);
    for (const blob of blobs) {
      for (const m of blob.members) {
        const d = dist(this.ship.pos, m.pos);
        if (d >= MIN_SEP) continue;
        const away = d > 1 ? scale(sub(this.ship.pos, m.pos), 1 / d) : v3(1, 0, 0);
        const mOther = memberMass(m.type);
        const wShip = mOther / (mShip + mOther);   // the lighter body moves more
        const wOther = mShip / (mShip + mOther);
        const overlap = MIN_SEP - d;
        this.ship.pos = add(this.ship.pos, scale(away, overlap * wShip));
        m.pos = sub(m.pos, scale(away, overlap * wOther));
        const closing = dot(sub(this.ship.vel, m.vel), away);
        if (closing < 0) {
          const j = -(1 + RESTITUTION) * closing;   // relative-velocity impulse
          this.ship.vel = add(this.ship.vel, scale(away, j * wShip));
          m.vel = sub(m.vel, scale(away, j * wOther));
        }
      }
    }
  }

  notify(text: string): void {
    this.notifications.push({ text, at: this.time });
    if (this.notifications.length > 4) this.notifications.shift();
  }

  toggleProp(key: PropKey): void {
    const err = this.ship.toggleProp(key, this.time);
    if (err) this.notify(err);
  }

  toggleBomb(i: number): void {
    this.combat?.bombs[i]?.toggle(this.time);
  }

  toggleMjd(): void {
    const mjd = this.ship.mjd;
    if (mjd.state === 'spooling') { this.notify('The Micro Jump Drive is already spooling.'); return; }
    if (mjd.state === 'cooldown') {
      this.notify(`Micro Jump Drive reactivation in ${Math.max(0, mjd.readyAt - this.time)} s.`);
      return;
    }
    mjd.state = 'spooling';
    mjd.spoolEndsAt = this.time + MJD.spoolS;
    this.notify('Micro Jump Drive spooling — jump in 9 seconds');
  }

  /** For the HUD: MJD button state + ring progress at (fractional) time t. */
  mjdStatus(t: number): { state: 'idle' | 'spooling' | 'cooldown'; prog: number } {
    const mjd = this.ship.mjd;
    if (mjd.state === 'spooling') {
      return { state: 'spooling', prog: Math.min(1, 1 - (mjd.spoolEndsAt - t) / MJD.spoolS) };
    }
    if (mjd.state === 'cooldown') {
      return { state: 'cooldown', prog: Math.min(1, 1 - (mjd.readyAt - t) / MJD.cooldownS) };
    }
    return { state: 'idle', prog: 0 };
  }

  setCommand(c: Command): void { this.ship.command = c; }

  distanceTo(id: string): number {
    const t = this.lookup(id);
    return t ? dist(this.ship.pos, t.pos) : NaN;
  }

  /** Points of interest that get tactical-overlay elevation lines. */
  pois(): { pos: Vec3 }[] {
    const out: { pos: Vec3 }[] = [...this.beacons.map(b => ({ pos: b.pos }))];
    if (this.combat) {
      out.push({ pos: this.combat.friendly.center });
      for (const f of this.combat.hostiles) if (f.visible()) out.push({ pos: f.blob.center });
    }
    return out;
  }

  /** EVE-style status line for the current command. */
  status(): { title: string; sub: string } | null {
    const c = this.ship.command;
    const name = (id: string) => this.lookup(id)?.name ?? '';
    const fmt = (m: number) => m >= 10000
      ? `${Math.round(m / 1000).toLocaleString('en-US')} km`
      : `${Math.round(m).toLocaleString('en-US')} m`;
    switch (c.kind) {
      case 'stop': return this.ship.speed() > 1 ? { title: 'STOPPING', sub: '' } : null;
      case 'align': return { title: 'ALIGNING', sub: c.label };
      case 'approach': return { title: 'APPROACHING', sub: name(c.targetId) };
      case 'alignTo': return { title: 'ALIGNING', sub: name(c.targetId) };
      case 'orbit': {
        // Actual radius too: under the exponential model an MWD orbit balloons
        // well past the commanded range, as on Tranquility.
        const actual = this.distanceTo(c.targetId);
        const at = Number.isFinite(actual) ? ` (at ${fmt(actual)})` : '';
        return { title: 'ORBITING', sub: `${name(c.targetId)} — ${fmt(c.range)}${at}` };
      }
      case 'keepAtRange': return { title: 'KEEPING AT RANGE', sub: `${name(c.targetId)} — ${fmt(c.range)}` };
    }
  }
}

/** Rough hull mass for bump physics (kg): Apocalypse/Typhoon-class ~100,000 t,
 *  HAC/logi cruisers ~12,000 t. */
function memberMass(type: string): number {
  return SHIP_CLASS[type] === 'cruiser' ? 12e6 : 100e6;
}

/** M1 practice world (kept for the movement test suite). */
export function makeM1Sim(): Sim {
  const sim = new Sim();
  sim.beacons = [
    { id: 'b10', name: 'Practice Beacon Alpha', pos: v3(10_000, 1_500, 4_000) },
    { id: 'b50', name: 'Practice Beacon Bravo', pos: v3(-32_000, -6_000, 38_000) },
    { id: 'b150', name: 'Practice Beacon Charlie', pos: v3(120_000, 25_000, -85_000) },
  ];
  return sim;
}

/** M2 combat drill world. Player start per cfg.playerStart (default: just
 *  off the ball, the legacy 4 km x-offset the tests rely on). */
export function makeCombatSim(cfg: ScenarioConfig = DEFAULT_SCENARIO): Sim {
  const sim = new Sim();
  sim.combat = new CombatWorld(cfg);
  const fc = clone(sim.combat.friendly.center);
  const f0 = sim.combat.hostiles[0];
  const laneDir = f0 ? norm(sub(f0.blob.center, fc)) : v3(1, 0, 0);
  let start: Vec3;
  switch (cfg.playerStart ?? 'ball') {
    case 'lane': {
      // The ideal firewall spot: one missile tick upstream of the ball.
      const rig = cfg.guidanceRigs !== false ? GUIDANCE_RIG_MULT : 1;
      const laneLen = f0 ? dist(f0.blob.center, fc) : 0;
      const up = f0 && f0.p.missile
        ? Math.min(laneLen * 0.5, MISSILE_INFO[f0.p.missile].speed * f0.p.mult * rig)
        : 8000;
      start = add(fc, scale(laneDir, up));
      break;
    }
    case 'off': {
      // 30 km abeam of the lane: the drill is getting onto it in time.
      const perp = norm(v3(-laneDir.z, 0, laneDir.x));
      start = add(fc, scale(perp, 30_000));
      break;
    }
    default:
      start = clone(fc);
      start.x += 4000;
  }
  sim.ship.pos = start;
  sim.ship.prevPos = clone(start);
  if (cfg.gate) sim.beacons = [{ id: 'gate', name: 'Stargate', pos: clone(fc) }];
  return sim;
}
