// Propulsion module state machine.
// Cycle rule (observed in-game, "Rules Of Smartbombs" footage): a running module
// cannot stop mid-cycle — toggling it off schedules deactivation at the end of
// the current cycle ("will deactivate without repeating in N seconds").
// Toggling again before the cycle ends cancels the pending deactivation.
// APPROXIMATED policy: module effects (mass, max velocity) are applied at the
// physics boundary on which the sim processes them; cycles are timed from the
// activation tick.
import { PropStats } from './data';

export type PropKey = 'ab' | 'mwd';

export class PropModule {
  readonly stats: PropStats;
  active = false;
  overheat = false;            // prop overheat only: timed boost, no heat damage (design decision)
  pendingDeactivate = false;
  cycleStart = 0;
  cycleEnd = 0;

  constructor(stats: PropStats) { this.stats = stats; }

  /** Attempt activation at sim time t. Returns an error string, or null on success. */
  activate(t: number): string | null {
    if (this.active) {
      if (this.pendingDeactivate) { this.pendingDeactivate = false; return null; } // resume repeating
      return `${this.stats.name} is already active.`;
    }
    this.active = true;
    this.pendingDeactivate = false;
    this.cycleStart = t;
    this.cycleEnd = t + this.stats.durationS;
    return null;
  }

  /** Request deactivation: takes effect at the end of the current cycle. */
  requestDeactivate(): void {
    if (this.active) this.pendingDeactivate = true;
  }

  /** Advance cycle bookkeeping to sim time t (call once per physics step). */
  tick(t: number): void {
    if (!this.active) return;
    while (t >= this.cycleEnd) {
      if (this.pendingDeactivate) {
        this.active = false;
        this.pendingDeactivate = false;
        return;
      }
      this.cycleStart = this.cycleEnd;
      this.cycleEnd += this.stats.durationS;
    }
  }

  /** 0..1 progress of the current cycle at (possibly fractional) time t. */
  cycleProgress(t: number): number {
    if (!this.active) return 0;
    return Math.min(1, Math.max(0, (t - this.cycleStart) / this.stats.durationS));
  }

  /** Seconds until the pending deactivation lands (for tooltip parity). */
  secondsUntilOff(t: number): number | null {
    return this.active && this.pendingDeactivate ? Math.max(0, this.cycleEnd - t) : null;
  }
}
