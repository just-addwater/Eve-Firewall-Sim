// EVE-style orbit camera: orbits a focus point (own ship by default), wheel zoom,
// smooth look-at transitions between targets (the user's flying style relies on
// frequent look-at/zoom swings — transitions must be fluid).
//
// Client behaviours mirrored here:
// - Drag with either mouse button rotates; the cursor hides (Pointer Lock) and
//   the drag runs past the screen edge, reappearing where it started.
// - Look-at is an eased ~0.85 s swing, with distance swinging in the same move.
//   Zoom distance is remembered per look-at subject; a new subject opens at a
//   size-appropriate default and the own ship gets its old distance back.
// - Optional "dynamic camera movement": the camera lags and pulls back a little
//   under acceleration, then settles. Off = the hard lock many pilots prefer.
// - Camera offset shifts the whole view so the ship sits off-centre.
// - A barely-perceptible idle drift, and rotation inertia after release.
//   Sensitivity (rotSpeed) and inertia mirror EVE's Camera Settings sliders.
import * as THREE from 'three';
import { Vec3 } from '../sim/vec3';

const DRIFT_RATE = 0.007;      // rad/s — slow idle orbit, barely perceptible
const DRIFT_DELAY_MS = 5000;   // quiet time before the drift starts fading in
const DRIFT_RAMP_MS = 6000;    // fade-in period once it starts
const LOOK_MS = 850;           // look-at swing duration (ease-in-out)
const DRAG_SLOP_PX = 4;        // travel before a press counts as a camera drag
const RESET_TAU_MS = 250;      // reset-camera easing
const ROT_GAIN = 0.0042;       // rad per mouse px at Sensitivity 1 (~1,500 px per turn)
const DRAG_TAU_MS = 90;        // the view glides this far behind the mouse while dragging
const RATE_TAU_MS = 40;        // smoothing of the drag-rate estimate used for the coast
const ZOOM_TAU_MS = 160;       // wheel zoom easing
export const CAM_DEFAULTS = { yaw: 0.8, pitch: 0.35, dist: 60_000 } as const;

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  yaw: number = CAM_DEFAULTS.yaw;
  pitch: number = CAM_DEFAULTS.pitch; // radians above the plane
  dist: number = CAM_DEFAULTS.dist;   // meters
  zoomSpeed = 1;              // user option (multiplier on wheel response)
  rotSpeed = 1;               // user option — EVE "Sensitivity"
  inertia = 0.4;              // user option 0..1 — EVE "Inertia" (rotation momentum)
  lockPointer = true;         // user option — hide cursor while rotating
  dynamic = false;            // user option — EVE "Dynamic camera movement"
  private offset = 0;         // user option — fraction of width the view shifts
  private targetDist: number = CAM_DEFAULTS.dist;
  private focus = new THREE.Vector3();
  private prevTarget = new THREE.Vector3();
  private hasPrevTarget = false;
  private focusTarget: () => Vec3 = () => ({ x: 0, y: 0, z: 0 });
  private subjectKey = 'ship';
  private zoomMemory = new Map<string, number>();
  private trans: { from: THREE.Vector3; fromDist: number; start: number } | null = null;
  private dragging = false;
  private released = false;               // a drag ended since the last frame
  private dragTravel = 0;
  private pendX = 0; private pendY = 0;   // drag deltas not yet applied this frame
  // Rotation is a chase: the mouse moves a TARGET angle and the camera eases
  // after it (the client's glide). On release the coast is added to the target
  // and chased with a longer time constant, so start, stop and coast are one
  // continuous ease instead of raw per-pixel steps plus a separate momentum.
  private yawT: number = CAM_DEFAULTS.yaw; private pitchT: number = CAM_DEFAULTS.pitch;
  private yawRate = 0; private pitchRate = 0; // rad/ms — smoothed drag rate
  private coastTau = 0;                       // >0 while easing out a release
  private lastInputAt = 0;
  private resetting = false;
  private vFast = new THREE.Vector3();    // subject velocity, m/ms (dynamic camera)
  private vSlow = new THREE.Vector3();
  private w = 1; private h = 1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 10, 8_000_000);
  }

  /** Swing the camera to a new subject. `key` identifies it for zoom memory;
   *  `defaultDist` is used the first time that subject is looked at. */
  lookAt(getter: () => Vec3, key = 'ship', defaultDist?: number): void {
    if (key !== this.subjectKey) {
      this.zoomMemory.set(this.subjectKey, this.targetDist);
      this.targetDist = this.zoomMemory.get(key) ?? defaultDist ?? this.targetDist;
      this.subjectKey = key;
    }
    this.focusTarget = getter;
    this.hasPrevTarget = false; // re-seed target delta tracking for the new subject
    this.trans = { from: this.focus.clone(), fromDist: this.dist, start: performance.now() };
    this.vFast.set(0, 0, 0); this.vSlow.set(0, 0, 0);
  }

  /** Ease yaw/pitch/zoom back to the defaults (caller re-targets the own ship). */
  resetView(): void {
    this.resetting = true;
    this.targetDist = CAM_DEFAULTS.dist;
    this.yawRate = 0; this.pitchRate = 0; this.coastTau = 0;
    this.lastInputAt = performance.now();
  }

  /** True if the pointer travelled past the drag slop since the last press —
   *  lets click handlers ignore the click a browser fires after a camera drag. */
  get draggedSincePress(): boolean { return this.dragTravel > DRAG_SLOP_PX; }

  setSize(w: number, h: number): void { this.w = w; this.h = h; this.applyOffset(); }
  setOffset(f: number): void { this.offset = f; this.applyOffset(); }
  private applyOffset(): void {
    if (this.offset === 0) this.camera.clearViewOffset();
    // Shift the sub-view right by a fraction of the width: the scene (and the
    // ship at its centre) slides left, freeing the overview side.
    else this.camera.setViewOffset(this.w, this.h, this.offset * this.w, 0, this.w, this.h);
    this.camera.updateProjectionMatrix();
  }

  attach(el: HTMLElement): void {
    // Right-drag rotates too — the canvas has no context menu to lose.
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.button !== 2) return;
      this.dragging = true;
      this.released = false;
      this.dragTravel = 0;
      this.resetting = false;
      // Grabbing the view stops any coast dead, as in the client.
      this.yawT = this.yaw; this.pitchT = this.pitch;
      this.yawRate = 0; this.pitchRate = 0; this.coastTau = 0;
      this.lastInputAt = performance.now();
      if (!this.lockPointer) {
        try { el.setPointerCapture(e.pointerId); } catch { /* no active pointer (synthetic event) */ }
      }
    });
    el.addEventListener('pointermove', e => {
      if (!this.dragging) return;
      // movementX/Y keep reporting while the pointer is locked (clientX freezes).
      this.pendX += e.movementX;
      this.pendY += e.movementY;
      this.dragTravel += Math.abs(e.movementX) + Math.abs(e.movementY);
      this.lastInputAt = performance.now();
      // Lock only once it is a real drag, so plain clicks never hide the cursor.
      // The press's transient user activation makes the request legal here.
      if (this.lockPointer && this.draggedSincePress && document.pointerLockElement !== el) {
        try {
          const p = el.requestPointerLock() as unknown as Promise<void> | undefined;
          p?.catch?.(() => { /* denied (e.g. re-lock cooldown) — drag still works */ });
        } catch { /* ignore */ }
      }
    });
    const end = (): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.released = true;
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.targetDist *= Math.pow(1.15, (e.deltaY / 100) * this.zoomSpeed);
      this.targetDist = Math.max(300, Math.min(600_000, this.targetDist));
      this.lastInputAt = performance.now();
    }, { passive: false });
  }

  update(dtMs: number): void {
    const now = performance.now();
    const tr = this.trans;
    const te = tr ? Math.min(1, (now - tr.start) / LOOK_MS) : 1;
    const e = easeInOut(te);

    // Zoom: during a look-at the distance swings on the same eased curve;
    // otherwise smoothed toward the wheel's target (constant ratio per notch).
    if (tr) this.dist = tr.fromDist + (this.targetDist - tr.fromDist) * e;
    else this.dist += (this.targetDist - this.dist) * (1 - Math.exp(-dtMs / ZOOM_TAU_MS));

    if (this.resetting) {
      const k = 1 - Math.exp(-dtMs / RESET_TAU_MS);
      const dy = wrapAngle(CAM_DEFAULTS.yaw - this.yaw), dp = CAM_DEFAULTS.pitch - this.pitch;
      this.yaw += dy * k; this.pitch += dp * k;
      this.yawT = this.yaw; this.pitchT = this.pitch;
      if (Math.abs(dy) < 1e-3 && Math.abs(dp) < 1e-3) this.resetting = false;
    } else {
      let chaseTau = DRAG_TAU_MS;
      if (this.dragging) {
        const dYaw = this.pendX * ROT_GAIN * this.rotSpeed;
        const dPitch = this.pendY * ROT_GAIN * this.rotSpeed;
        this.yawT += dYaw;
        this.pitchT += dPitch;
        this.pendX = 0; this.pendY = 0;
        if (dtMs > 0) {
          // Frame-rate-independent estimate of how fast the hand is moving.
          const k = 1 - Math.exp(-dtMs / RATE_TAU_MS);
          this.yawRate += (dYaw / dtMs - this.yawRate) * k;
          this.pitchRate += (dPitch / dtMs - this.pitchRate) * k;
        }
      } else {
        if (this.released) {
          // Inertia: the release speed coasts for inertia×500 ms worth of
          // travel, eased out over a longer chase. Slider 0 = stop dead.
          this.released = false;
          const coastMs = this.inertia * 500;
          this.yawT += this.yawRate * coastMs;
          this.pitchT += this.pitchRate * coastMs;
          this.coastTau = this.inertia > 0 ? DRAG_TAU_MS + this.inertia * 350 : 0;
          this.yawRate = 0; this.pitchRate = 0;
        }
        if (this.coastTau > 0) chaseTau = this.coastTau;
        // Slow cinematic idle drift, fading in only after input has been quiet.
        const quiet = now - this.lastInputAt - DRIFT_DELAY_MS;
        if (quiet > 0) {
          const ramp = Math.min(1, quiet / DRIFT_RAMP_MS);
          this.yawT += DRIFT_RATE * ramp * (dtMs / 1000);
        }
      }
      this.pitchT = Math.max(-1.55, Math.min(1.55, this.pitchT));
      // The chase itself: one ease for drag glide, stop and coast alike.
      const k = 1 - Math.exp(-dtMs / chaseTau);
      const dy = wrapAngle(this.yawT - this.yaw), dp = this.pitchT - this.pitch;
      this.yaw += dy * k; this.pitch += dp * k;
      if (!this.dragging && Math.abs(dy) < 1e-4 && Math.abs(dp) < 1e-4) {
        this.yaw = this.yawT; this.pitch = this.pitchT; this.coastTau = 0;
      }
    }
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));

    const t = this.focusTarget();
    const tv = new THREE.Vector3(t.x, t.y, t.z);
    // Subject velocity for the dynamic camera (a jump such as an MJD resets it).
    if (this.hasPrevTarget && dtMs > 0) {
      const step = tv.clone().sub(this.prevTarget);
      if (step.length() > 20_000) { this.vFast.set(0, 0, 0); this.vSlow.set(0, 0, 0); }
      else {
        this.vFast.lerp(step.divideScalar(dtMs), 1 - Math.exp(-dtMs / 250));
        this.vSlow.lerp(this.vFast, 1 - Math.exp(-dtMs / 1500));
      }
    }
    this.prevTarget.copy(tv);
    this.hasPrevTarget = true;

    let distScale = 1;
    if (tr) {
      // Eased swing from where the camera was looking to the live subject.
      this.focus.copy(tr.from).lerp(tv, e);
      if (te >= 1) this.trans = null;
    } else if (this.dynamic) {
      // Lag = how far the subject's velocity has run ahead of its slow average:
      // non-zero only while accelerating or turning, settling back to zero.
      const lag = this.vFast.clone().sub(this.vSlow).multiplyScalar(2500);
      if (lag.length() > 3000) lag.setLength(3000);
      this.focus.copy(tv).sub(lag);
      distScale = 1 + Math.min(0.15, lag.length() / 1500 * 0.15);
    } else {
      // Hard lock: zero steady-state lag at any speed.
      this.focus.copy(tv);
    }

    const d = this.dist * distScale;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(
      this.focus.x + d * cp * Math.cos(this.yaw),
      this.focus.y + d * sp,
      this.focus.z + d * cp * Math.sin(this.yaw),
    );
    this.camera.lookAt(this.focus);
    this.camera.updateMatrixWorld();
  }

  /** World-space ray direction through a client pixel (for double-click align). */
  rayDirection(clientX: number, clientY: number, w: number, h: number): Vec3 {
    const ndc = new THREE.Vector2((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return { x: rc.ray.direction.x, y: rc.ray.direction.y, z: rc.ray.direction.z };
  }

  /** Project world position to screen px; returns null if behind the camera. */
  project(p: Vec3, w: number, h: number): { x: number; y: number } | null {
    const v = new THREE.Vector3(p.x, p.y, p.z);
    const cam = v.clone().applyMatrix4(this.camera.matrixWorldInverse);
    if (cam.z > -1) return null;
    v.project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
  }
}
