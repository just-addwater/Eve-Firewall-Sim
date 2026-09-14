// Ship movement: EVE's empirically-established exponential model, stepped at 1 Hz.
//   v(t+dt) = vDes + (v - vDes) * e^(-dt/tau),  tau = I_eff * M / 1e6
// Position uses the exact integral of that curve over the step.
// EMPIRICAL: reproduces EVE align/accel behavior (see docs/deep-research-report.md);
// exact Destiny steering internals are proprietary.
import { Vec3, v3, add, sub, scale, norm, len, dist, cross, clone } from './vec3';
import { PropModule, PropKey } from './modules';
import { PROPS, maxVelocity, tau, totalMass, signature } from './data';

export type Command =
  | { kind: 'stop' }
  | { kind: 'align'; dir: Vec3; label: string }
  | { kind: 'approach'; targetId: string }
  | { kind: 'alignTo'; targetId: string }
  | { kind: 'orbit'; targetId: string; range: number }
  | { kind: 'keepAtRange'; targetId: string; range: number };

export interface TargetInfo { pos: Vec3; vel: Vec3; name: string; }
export type TargetLookup = (id: string) => TargetInfo | null;

const UP = v3(0, 1, 0);
/** Approach ends here (centre-to-centre) instead of ramming through: the client
 *  closes to ~50 m hull-to-hull, which for battleship hulls is ~500 m. */
export const APPROACH_STANDOFF = 500;

export class Ship {
  pos = v3(0, 0, 0);
  vel = v3(0, 0, 0);
  prevPos = v3(0, 0, 0);
  prevVel = v3(0, 0, 0);
  heading = v3(1, 0, 0);
  throttle = 1;                       // fraction of current max velocity
  command: Command = { kind: 'stop' };
  readonly ab = new PropModule(PROPS.ab);
  readonly mwd = new PropModule(PROPS.mwd);
  links = true;                       // fleet boosts toggle (scenario config)
  /** Keep-at-range controller: 'smooth' floats in (default); 'eve' is the raw
   *  full-speed-with-hysteresis controller that overshoots on a heavy hull. */
  kraMode: 'smooth' | 'eve' = 'smooth';
  /** Large Micro Jump Drive: 9 s spool (skill V), 100 km jump along heading, 180 s reactivation. */
  mjd: { state: 'idle' | 'spooling' | 'cooldown'; spoolEndsAt: number; readyAt: number } =
    { state: 'idle', spoolEndsAt: 0, readyAt: 0 };

  activeProp(): PropModule | null {
    if (this.mwd.active) return this.mwd;
    if (this.ab.active) return this.ab;
    return null;
  }

  module(key: PropKey): PropModule { return key === 'ab' ? this.ab : this.mwd; }

  /** EVE restriction: only one propulsion module may run at a time (maxGroupActive 1). */
  toggleProp(key: PropKey, t: number): string | null {
    const mod = this.module(key);
    if (mod.active && !mod.pendingDeactivate) { mod.requestDeactivate(); return null; }
    const other = this.module(key === 'ab' ? 'mwd' : 'ab');
    if (other.active) return 'You cannot activate this module because another propulsion module is already active.';
    return mod.activate(t);
  }

  maxSpeed(): number {
    const p = this.activeProp();
    return maxVelocity(p ? p.stats : null, p ? p.overheat : false);
  }

  currentTau(): number {
    const p = this.activeProp();
    return tau(p ? p.stats : null, this.links);
  }

  mass(): number {
    const p = this.activeProp();
    return totalMass(p ? p.stats : null);
  }

  sig(): number {
    const p = this.activeProp();
    return signature(p && p === this.mwd ? p.stats : null, this.links);
  }

  /** Desired velocity for the current command. Controllers are APPROXIMATED. */
  desiredVelocity(lookup: TargetLookup): Vec3 {
    const speed = this.throttle * this.maxSpeed();
    const c = this.command;
    switch (c.kind) {
      case 'stop': return v3(0, 0, 0);
      case 'align': return scale(norm(c.dir), speed);
      case 'alignTo': {
        // "Align to" an object: point at its current position at full speed and
        // never stop — how you fly a lane onto a fleet member.
        const t = lookup(c.targetId);
        if (!t) return v3(0, 0, 0);
        return scale(norm(sub(t.pos, this.pos)), speed);
      }
      case 'approach': {
        const t = lookup(c.targetId);
        if (!t) return v3(0, 0, 0);
        if (dist(this.pos, t.pos) <= APPROACH_STANDOFF) return clone(t.vel);
        return this.closeToRange(t, APPROACH_STANDOFF, speed);
      }
      case 'keepAtRange': {
        const t = lookup(c.targetId);
        if (!t) return v3(0, 0, 0);
        const err = dist(this.pos, t.pos) - c.range;
        if (this.kraMode === 'eve') {
          // Raw client-style controller: full speed toward/away outside a small
          // hysteresis band, match the target inside it. On a heavy MWD hull it
          // overshoots and burns back — the yo-yo a Nestor pilot manages. APPROXIMATED.
          const band = Math.max(150, c.range * 0.05);
          if (Math.abs(err) <= band) return clone(t.vel);
          const dir = err > 0 ? norm(sub(t.pos, this.pos)) : norm(sub(this.pos, t.pos));
          return add(scale(dir, speed), t.vel);
        }
        if (Math.abs(err) < c.range * 0.05) return clone(t.vel); // hold station relative to target
        return this.closeToRange(t, c.range, speed);
      }
      case 'orbit': {
        const t = lookup(c.targetId);
        if (!t) return v3(0, 0, 0);
        const r = sub(this.pos, t.pos);
        const d = Math.max(len(r), 1);
        const rHat = scale(r, 1 / d);
        let tang = cross(UP, rHat);
        if (len(tang) < 1e-6) tang = cross(v3(1, 0, 0), rHat);
        tang = norm(tang);
        const correction = Math.max(-1, Math.min(1, (d - c.range) / Math.max(c.range, 1)));
        const dir = norm(add(tang, scale(rHat, -correction)));
        return add(scale(dir, speed), t.vel);
      }
    }
  }

  /** Smooth range controller shared by approach and keep-at-range.
   *  Coast-in rule: under the exponential model a coasting ship travels
   *  exactly v*tau, so burn until a coast would land on the band (with a
   *  one-tick margin), then close the remainder near-critically damped
   *  (gain 1/(2*tau): damping ratio 0.707 — meters-scale overshoot only).
   *  Reproduces the characteristic slow "MWD float" into position. */
  private closeToRange(t: TargetInfo, range: number, speed: number): Vec3 {
    const err = dist(this.pos, t.pos) - range;
    const dir = err > 0 ? norm(sub(t.pos, this.pos)) : norm(sub(this.pos, t.pos));
    const tc = this.currentTau();
    const sp = len(this.vel);
    const pTrack = Math.abs(err) / (2 * tc);   // damped-tracking speed
    let mag: number;
    if (Math.abs(err) > sp * tc + speed) mag = speed;      // burn phase
    else if (sp > pTrack * 1.5) mag = 0;                   // bleed excess speed (coast)
    else mag = Math.min(speed, pTrack);                    // damped terminal close
    return add(scale(dir, mag), t.vel);
  }

  /** One physics step of dt seconds (authoritative cadence: dt = 1). */
  step(dt: number, t: number, lookup: TargetLookup): void {
    this.ab.tick(t);
    this.mwd.tick(t);
    const vDes = this.desiredVelocity(lookup);
    const tc = this.currentTau();
    const k = Math.exp(-dt / tc);
    this.prevPos = clone(this.pos);
    this.prevVel = clone(this.vel);
    const dv = sub(this.vel, vDes);
    // exact integral: pos += vDes*dt + dv * tau * (1 - k)
    this.pos = add(this.pos, add(scale(vDes, dt), scale(dv, tc * (1 - k))));
    this.vel = add(vDes, scale(dv, k));
    const sp = len(this.vel);
    if (sp > 0.5) this.heading = norm(this.vel);
  }

  speed(): number { return len(this.vel); }
}
