// HTML bracket layer: in EVE, brackets and labels are UI drawn over space.
// Own ship, beacons, and tactical-ring distance labels live here.
import { CameraRig } from '../render/camera';
import { Sim } from '../sim/sim';
import { Vec3, dist, add, sub, scale, norm } from '../sim/vec3';
import { GUIDANCE_RIG_MULT, MISSILE_INFO } from '../sim/combat';
import { RING_RADII_KM } from '../render/scene';
import { fmtDist } from './format';

export class BracketLayer {
  private root: HTMLElement;
  private els = new Map<string, HTMLElement>();
  private ringEls: HTMLElement[] = [];
  selectedId: string | null = null;
  onSelect: (id: string | null) => void = () => {};
  ringsVisible = true;
  aidsVisible = true;
  private alignMarker: { pos: Vec3; el: HTMLElement; fadeStart: number | null } | null = null;
  private hoverEl: HTMLElement | null = null;
  private mouse: { x: number; y: number } | null = null;

  setMouse(x: number, y: number): void { this.mouse = { x, y }; }
  clearMouse(): void { this.mouse = null; }

  constructor(root: HTMLElement) {
    this.root = root;
    // Two labels per ring (both ends of a world-fixed axis, as in EVE).
    for (const km of RING_RADII_KM) {
      for (let side = 0; side < 2; side++) {
        const el = document.createElement('div');
        el.className = 'ring-label';
        el.textContent = `${km}`;
        this.root.appendChild(el);
        this.ringEls.push(el);
      }
    }
  }

  /** Clear all entity brackets (scenario restart — entity ids/fleets change). */
  reset(): void {
    for (const el of this.els.values()) el.remove();
    this.els.clear();
    this.selectedId = null;
    if (this.alignMarker) { this.alignMarker.el.remove(); this.alignMarker = null; }
  }

  /** EVE align-point marker: a small circle anchored at the clicked point in
   *  space (user-verified). It STAYS there while the align command runs and
   *  fades only once the command changes. */
  setAlignMarker(pos: Vec3): void {
    if (this.alignMarker) this.alignMarker.el.remove();
    const el = document.createElement('div');
    el.className = 'align-marker';
    el.innerHTML = '<div class="am-ring"></div>';
    this.root.appendChild(el);
    this.alignMarker = { pos, el, fadeStart: null };
  }

  private ensure(id: string, cls: string, html: string): HTMLElement {
    let el = this.els.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = cls;
      el.innerHTML = html;
      el.addEventListener('pointerdown', e => e.stopPropagation());
      el.addEventListener('click', e => {
        e.stopPropagation();
        this.onSelect(id === 'ship' ? null : id);
      });
      this.root.appendChild(el);
      this.els.set(id, el);
    }
    return el;
  }

  update(sim: Sim, rig: CameraRig, shipRenderPos: Vec3, frac: number, w: number, h: number): void {
    // Own ship marker
    const shipEl = this.ensure('ship', 'bracket ship-bracket', '<div class="diamond own"></div>');
    const sp = rig.project(shipRenderPos, w, h);
    place(shipEl, sp);

    // Fleet centroid labels + selected-ship marker (combat mode).
    if (sim.combat) {
      const c = sim.combat;
      const lerpC = (blob: { prevCenter: Vec3; center: Vec3 }): Vec3 => ({
        x: blob.prevCenter.x + (blob.center.x - blob.prevCenter.x) * frac,
        y: blob.prevCenter.y + (blob.center.y - blob.prevCenter.y) * frac,
        z: blob.prevCenter.z + (blob.center.z - blob.prevCenter.z) * frac,
      });
      const fc = lerpC(c.friendly);
      const anchorEl = this.ensure('anchor', 'bracket beacon-bracket',
        '<div class="diamond friendly"></div><div class="blabel"><span class="bname">Fleet anchor</span><span class="bdist"></span></div>');
      anchorEl.classList.toggle('selected', this.selectedId === 'anchor');
      const ap = rig.project(fc, w, h);
      place(anchorEl, ap);
      if (ap) (anchorEl.querySelector('.bdist') as HTMLElement).textContent = fmtDist(dist(shipRenderPos, fc));

      // Per-fleet centroid labels + training-aid ghost markers.
      c.hostiles.forEach((f, i) => {
        const hcF = lerpC(f.blob);
        const hostEl = this.ensure(`hlabel${i}`, 'bracket hostile-label',
          `<div class="blabel"><span class="bname">${f.p.shipType} fleet</span><span class="bdist"></span></div>`);
        const hp = f.visible() ? rig.project(hcF, w, h) : null;
        place(hostEl, hp);
        if (hp) (hostEl.querySelector('.bdist') as HTMLElement).textContent = fmtDist(dist(shipRenderPos, hcF));

        // Ghost at the ideal firewall spot: on this fleet's lane, one
        // missile-tick upstream of its called target.
        const ghostEl = this.ensure(`ghost${i}`, 'bracket ghost-marker',
          '<div class="ghost-ring"></div><div class="ghost-dot"></div><div class="blabel"><span class="gname">firewall spot</span></div>');
        let gp: { x: number; y: number } | null = null;
        if (this.aidsVisible && f.visible() && f.p.missile !== null) {
          const tgt = c.friendly.members[f.calledTargetIdx];
          // Members chase the FC now — use the live interpolated position,
          // not the old center+offset station.
          const tPos = {
            x: tgt.prevPos.x + (tgt.pos.x - tgt.prevPos.x) * frac,
            y: tgt.prevPos.y + (tgt.pos.y - tgt.prevPos.y) * frac,
            z: tgt.prevPos.z + (tgt.pos.z - tgt.prevPos.z) * frac,
          };
          const laneLen = dist(hcF, tPos);
          const rigMult = c.cfg.guidanceRigs !== false ? GUIDANCE_RIG_MULT : 1;
          const upstream = Math.min(laneLen * 0.5, MISSILE_INFO[f.p.missile].speed * f.p.mult * rigMult);
          const ideal = add(tPos, scale(norm(sub(hcF, tPos)), upstream));
          gp = rig.project(ideal, w, h);
        }
        place(ghostEl, gp);
      });

      const selEl = this.ensure('sel-marker', 'bracket sel-marker', '<div class="selbox"></div>');
      let selPos: Vec3 | null = null;
      if (this.selectedId && this.selectedId !== 'anchor') {
        const side = this.selectedId[0] === 'f' ? c.friendly
          : this.selectedId[0] === 'h' ? c.hostiles[parseInt(this.selectedId.slice(1), 10)]?.blob ?? null
          : null;
        const m = side?.members.find(x => x.id === this.selectedId);
        if (m) {
          selPos = {
            x: m.prevPos.x + (m.pos.x - m.prevPos.x) * frac,
            y: m.prevPos.y + (m.pos.y - m.prevPos.y) * frac,
            z: m.prevPos.z + (m.pos.z - m.prevPos.z) * frac,
          };
        }
      }
      place(selEl, selPos ? rig.project(selPos, w, h) : null);
    }

    // Beacons
    for (const b of sim.beacons) {
      const el = this.ensure(b.id, 'bracket beacon-bracket',
        `<div class="diamond"></div><div class="blabel"><span class="bname">${b.name}</span><span class="bdist"></span></div>`);
      el.classList.toggle('selected', this.selectedId === b.id);
      const p = rig.project(b.pos, w, h);
      place(el, p);
      if (p) (el.querySelector('.bdist') as HTMLElement).textContent = fmtDist(dist(shipRenderPos, b.pos));
    }

    // Align-point marker: pinned in space while aligning; fades out ~0.7 s
    // after the command changes to anything else.
    if (this.alignMarker) {
      const m = this.alignMarker;
      const aligning = sim.ship.command.kind === 'align';
      if (aligning) m.fadeStart = null;
      else if (m.fadeStart === null) m.fadeStart = performance.now();
      const fade = m.fadeStart === null ? 0 : (performance.now() - m.fadeStart) / 700;
      if (fade >= 1) { m.el.remove(); this.alignMarker = null; }
      else {
        place(m.el, rig.project(m.pos, w, h));
        m.el.style.opacity = `${(1 - fade) * 0.9}`;
      }
    }

    // Bracket hover: nearest ship box within ~12 px of the cursor shows an
    // EVE-style name + distance label.
    if (this.mouse && sim.combat) {
      let best: { d2: number; p: { x: number; y: number }; name: string; type: string; hostile: boolean; pos: Vec3 } | null = null;
      const consider = (members: typeof sim.combat.friendly.members, hostile: boolean): void => {
        for (const m of members) {
          const wp = {
            x: m.prevPos.x + (m.pos.x - m.prevPos.x) * frac,
            y: m.prevPos.y + (m.pos.y - m.prevPos.y) * frac,
            z: m.prevPos.z + (m.pos.z - m.prevPos.z) * frac,
          };
          const p = rig.project(wp, w, h);
          if (!p) continue;
          const dx = p.x - this.mouse!.x, dy = p.y - this.mouse!.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 144 && (!best || d2 < best.d2)) best = { d2, p, name: m.name, type: m.type, hostile, pos: wp };
        }
      };
      consider(sim.combat.friendly.members, false);
      for (const f of sim.combat.hostiles) if (f.visible()) consider(f.blob.members, true);
      if (best !== null) {
        const b: { p: { x: number; y: number }; name: string; type: string; hostile: boolean; pos: Vec3 } = best;
        if (!this.hoverEl) {
          this.hoverEl = document.createElement('div');
          this.hoverEl.className = 'hover-label';
          this.root.appendChild(this.hoverEl);
        }
        this.hoverEl.className = `hover-label ${b.hostile ? 'hostile' : 'friendly'}`;
        this.hoverEl.innerHTML = `<span class="hn">${b.name} (${b.type})</span><span class="hd">${fmtDist(dist(shipRenderPos, b.pos))}</span>`;
        this.hoverEl.style.display = '';
        this.hoverEl.style.transform = `translate(${b.p.x + 11}px, ${b.p.y - 6}px)`;
      } else if (this.hoverEl) {
        this.hoverEl.style.display = 'none';
      }
    } else if (this.hoverEl) {
      this.hoverEl.style.display = 'none';
    }

    // Ring distance labels: along a world-fixed diagonal axis on the overlay
    // plane, one label at each end (EVE behavior — labels do not track the
    // camera; the axis is fixed in space).
    const AX = 0.7071, AZ = 0.7071;
    RING_RADII_KM.forEach((km, i) => {
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? 1 : -1;
        const wp = {
          x: shipRenderPos.x + AX * sgn * km * 1000,
          y: shipRenderPos.y,
          z: shipRenderPos.z + AZ * sgn * km * 1000,
        };
        const p = this.ringsVisible ? rig.project(wp, w, h) : null;
        place(this.ringEls[i * 2 + side], p);
      }
    });
  }
}

function place(el: HTMLElement, p: { x: number; y: number } | null): void {
  if (!p) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.style.transform = `translate(${p.x}px, ${p.y}px)`;
}
