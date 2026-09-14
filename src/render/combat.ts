// Combat rendering: fleets as point sprites (EVE brackets at fleet zoom),
// missiles as light streaks (no brackets — they're not selectable in EVE),
// smartbomb pulses as expanding EMP rings.
import * as THREE from 'three';
import { Sim } from '../sim/sim';
import { SHIP_CLASS, ShipClass } from '../sim/combat';
import { Vec3 } from '../sim/vec3';

const MAX_SHIPS = 1024;
const MAX_MISSILES = 6000;
const MAX_FLEETS = 3;
const PULSE_MS = 800;      // smartbomb ripple: eases out to range while fading
const KILL_MS = 260;       // missile-kill pop
const MAX_KILL_FX = 400;

const lerp3 = (a: Vec3, b: Vec3, f: number): Vec3 =>
  ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });

/** UniWiki "Brackets in space → Player ships" glyphs (white PNGs, tinted by
 *  the material color): battleship vs cruiser per member type. Plain glyphs
 *  only — no standing chip (removed per user request). */
const CLOUD_KEYS = ['h_battleship', 'h_cruiser', 'f_battleship', 'f_cruiser'] as const;

/** PointsMaterial size is in DEVICE pixels: scale by the render pixel ratio
 *  so brackets hold a constant ~14 CSS px at any zoom on any display. */
const BRACKET_PX = 14 * Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2);

function bracketTexture(cls: ShipClass): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const tx = new THREE.CanvasTexture(c);
  const img = new Image();
  img.onload = () => {
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;   // crisp 2x pixel upscale of the 16px glyph
    g.drawImage(img, 0, 0, 32, 32);
    tx.needsUpdate = true;
  };
  img.src = `icons/bracket_${cls}.png`;
  return tx;
}

export class CombatLayer {
  readonly group = new THREE.Group();
  private shipGeos = new Map<string, THREE.BufferGeometry>();
  private shipBufs = new Map<string, Float32Array>();
  private streakGeo = new THREE.BufferGeometry();
  private streakPos = new Float32Array(MAX_MISSILES * 6);
  private vecGeo = new THREE.BufferGeometry();
  private vecPos = new Float32Array(MAX_SHIPS * 6);
  private vecLines!: THREE.LineSegments;
  private pulsePool: THREE.Group[] = [];
  private activePulses: { mesh: THREE.Group; born: number }[] = [];
  private killPool: THREE.Sprite[] = [];
  private activeKills: { sprite: THREE.Sprite; born: number }[] = [];
  private flashTex: THREE.Texture | null = null;
  private laneLines: THREE.Line[] = [];
  /** Training aids master switch (lane lines; ghost markers live in the bracket layer). */
  aidsVisible = true;
  /** Ship velocity-vector lines follow the tactical overlay toggle. */
  vectorsVisible = true;

  constructor() {
    // One point cloud per side x ship class: red hostiles, fleet-purple friendlies.
    for (const key of CLOUD_KEYS) {
      const hostile = key[0] === 'h';
      const cls = key.slice(2) as ShipClass;
      const geo = new THREE.BufferGeometry();
      const buf = new Float32Array(MAX_SHIPS * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(buf, 3).setUsage(THREE.DynamicDrawUsage));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        size: BRACKET_PX, sizeAttenuation: false, map: bracketTexture(cls),
        color: hostile ? 0xe04f38 : 0xa98be0,
        transparent: true, alphaTest: 0.3, depthWrite: false,
      }));
      pts.frustumCulled = false;
      this.group.add(pts);
      this.shipGeos.set(key, geo);
      this.shipBufs.set(key, buf);
    }

    this.streakGeo.setAttribute('position', new THREE.BufferAttribute(this.streakPos, 3).setUsage(THREE.DynamicDrawUsage));
    // Light-streak gradient: bright blue-white head fading to near-black tail.
    // The colors are per-slot constants, so the buffer is filled once.
    const streakCol = new Float32Array(MAX_MISSILES * 6);
    for (let i = 0; i < MAX_MISSILES; i++) {
      streakCol[i * 6] = 0.13; streakCol[i * 6 + 1] = 0.17; streakCol[i * 6 + 2] = 0.24;   // head
      streakCol[i * 6 + 3] = 0.003; streakCol[i * 6 + 4] = 0.005; streakCol[i * 6 + 5] = 0.008; // tail
    }
    this.streakGeo.setAttribute('color', new THREE.BufferAttribute(streakCol, 3));
    const streaks = new THREE.LineSegments(this.streakGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.17,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    streaks.frustumCulled = false;
    this.group.add(streaks);

    // Small velocity-vector lines on other ships (tactical overlay draws these
    // for everything on grid — user-confirmed in the Photon screenshots).
    this.vecGeo.setAttribute('position', new THREE.BufferAttribute(this.vecPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.vecLines = new THREE.LineSegments(this.vecGeo, new THREE.LineBasicMaterial({
      color: 0x7fa8c0, transparent: true, opacity: 0.35, depthWrite: false,
    }));
    this.vecLines.frustumCulled = false;
    this.group.add(this.vecLines);

    // Training-aid lane lines: subtle dashed amber (less poster-like than a
    // solid beam — polish per user feedback).
    for (let i = 0; i < MAX_FLEETS; i++) {
      const laneGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(laneGeo, new THREE.LineDashedMaterial({
        color: 0xd0a94f, transparent: true, opacity: 0.22, dashSize: 900, gapSize: 700,
      }));
      line.frustumCulled = false;
      this.laneLines.push(line);
      this.group.add(line);
    }
  }

  /** EMP pulse per the reference footage: a hot central flash, a translucent
   *  expanding shockwave shell, and the sharp leading ring torus. */
  private spawnPulse(pos: Vec3): void {
    let grp = this.pulsePool.pop();
    if (!grp) {
      grp = new THREE.Group();
      // The ripple: a thin torus-like band in the ship's plane (the tactical
      // plane), soft blue-white, fading towards its inner edge.
      const eq = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1, 96),
        new THREE.MeshBasicMaterial({
          color: 0xa9d2ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
      eq.name = 'eq';
      eq.rotation.x = -Math.PI / 2;
      // Faint camera-facing silhouette so the ripple still reads edge-on.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.95, 1, 64),
        new THREE.MeshBasicMaterial({
          color: 0x9fc8f5, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
      ring.name = 'ring';
      // Barely-there volume.
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 16),
        new THREE.MeshBasicMaterial({
          color: 0x6fa8e8, transparent: true, opacity: 0.05, side: THREE.BackSide,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
      shell.name = 'shell';
      grp.add(eq, ring, shell);
      this.group.add(grp);
    }
    grp.visible = true;
    grp.position.set(pos.x, pos.y, pos.z);
    this.activePulses.push({ mesh: grp, born: performance.now() });
  }

  update(sim: Sim, frac: number, camera: THREE.Camera): void {
    const c = sim.combat;
    if (!c) {
      for (const geo of this.shipGeos.values()) geo.setDrawRange(0, 0);
      this.streakGeo.setDrawRange(0, 0);
      return;
    }

    // Ships: members interpolate their own chase positions (each pilots its
    // own keep-at-range on the FC). Hostiles vanish from grid while in warp.
    let vn = 0;
    const counts: Record<string, number> = { h_battleship: 0, h_cruiser: 0, f_battleship: 0, f_cruiser: 0 };
    const blobs: { blob: typeof c.friendly; hostile: boolean }[] =
      [{ blob: c.friendly, hostile: false }];
    for (const f of c.hostiles) if (f.visible()) blobs.push({ blob: f.blob, hostile: true });
    for (const { blob, hostile } of blobs) {
      for (const m of blob.members) {
        const key = (hostile ? 'h_' : 'f_') + (SHIP_CLASS[m.type] ?? 'battleship');
        const n = counts[key];
        if (n >= MAX_SHIPS) continue;
        const buf = this.shipBufs.get(key)!;
        const p = lerp3(m.prevPos, m.pos, frac);
        buf[n * 3] = p.x;
        buf[n * 3 + 1] = p.y;
        buf[n * 3 + 2] = p.z;
        counts[key] = n + 1;
        // Velocity vector from the member's own eased velocity (they no
        // longer share the blob's).
        const msp = Math.hypot(m.vel.x, m.vel.y, m.vel.z);
        if (this.vectorsVisible && msp > 5 && vn < MAX_SHIPS) {
          const vLen = Math.min(3500, msp * 8);
          this.vecPos[vn * 6] = p.x; this.vecPos[vn * 6 + 1] = p.y; this.vecPos[vn * 6 + 2] = p.z;
          this.vecPos[vn * 6 + 3] = p.x + (m.vel.x / msp) * vLen;
          this.vecPos[vn * 6 + 4] = p.y + (m.vel.y / msp) * vLen;
          this.vecPos[vn * 6 + 5] = p.z + (m.vel.z / msp) * vLen;
          vn++;
        }
      }
    }
    for (const [key, geo] of this.shipGeos) {
      geo.setDrawRange(0, counts[key]);
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
    this.vecGeo.setDrawRange(0, vn * 2);
    (this.vecGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // Missiles as streaks along their motion. A missile that impacted on the
    // current tick still flies its last leg up to the impact point (the sim
    // resolved it mid-tick), so nothing disappears a tick short of the target.
    let s = 0;
    for (const m of c.missiles) {
      if (s >= MAX_MISSILES) break;
      let f = frac;
      if (!m.alive) {
        if (m.hitAt !== sim.time || m.impactFrac === undefined || frac >= m.impactFrac) continue;
        f = frac / m.impactFrac;
      }
      const p = lerp3(m.prevPos, m.pos, f);
      let dx = m.pos.x - m.prevPos.x, dy = m.pos.y - m.prevPos.y, dz = m.pos.z - m.prevPos.z;
      const dl = Math.hypot(dx, dy, dz);
      if (dl > 1) { dx /= dl; dy /= dl; dz /= dl; } else { dx = dy = dz = 0; }
      // Tail ~half a tick of travel: fast missiles draw long rays.
      const L = Math.max(600, m.speed * 0.5);
      this.streakPos[s * 6] = p.x; this.streakPos[s * 6 + 1] = p.y; this.streakPos[s * 6 + 2] = p.z;
      this.streakPos[s * 6 + 3] = p.x - dx * L;
      this.streakPos[s * 6 + 4] = p.y - dy * L;
      this.streakPos[s * 6 + 5] = p.z - dz * L;
      s++;
    }
    this.streakGeo.setDrawRange(0, s * 2);
    (this.streakGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // Training-aid lane lines: each missile-armed fleet -> its called target.
    const fc = lerp3(c.friendly.prevCenter, c.friendly.center, frac);
    this.laneLines.forEach((line, i) => {
      const f = c.hostiles[i];
      line.visible = !!f && this.aidsVisible && f.visible() && f.p.missile !== null;
      if (!line.visible) return;
      const hc = lerp3(f.blob.prevCenter, f.blob.center, frac);
      const tgt = c.friendly.members[f.calledTargetIdx];
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.setXYZ(0, hc.x, hc.y, hc.z);
      attr.setXYZ(1, fc.x + tgt.offset.x, fc.y + tgt.offset.y, fc.z + tgt.offset.z);
      attr.needsUpdate = true;
      line.computeLineDistances(); // dashes need per-vertex distances
    });

    // Consume new pulse + kill FX from the sim.
    for (const fx of c.pulseFx.splice(0)) this.spawnPulse(fx.pos);
    for (const fx of c.killFx.splice(0)) this.spawnKill(fx.pos);

    // Animate pulses. Rendering target (design brief, reference footage): an
    // expanding ring torus around the ship, blue-white for EMP, with
    // staggered bombs reading as concentric ripples. Kept subtle: no central
    // flash, a thin ripple in the ship's plane that eases out to range and
    // fades, a faint silhouette ring and an almost-invisible shell for volume.
    const now = performance.now();
    const R = 7500;
    this.activePulses = this.activePulses.filter(p => {
      const age = (now - p.born) / PULSE_MS;
      if (age >= 1) {
        p.mesh.visible = false;
        this.pulsePool.push(p.mesh);
        return false;
      }
      const ring = p.mesh.getObjectByName('ring') as THREE.Mesh;
      const eq = p.mesh.getObjectByName('eq') as THREE.Mesh;
      const shell = p.mesh.getObjectByName('shell') as THREE.Mesh;
      const r = R * (1 - Math.pow(1 - age, 2.0));   // ease-out expansion over the whole life
      const fade = Math.pow(1 - age, 1.4);          // fades from the start, like the footage
      eq.scale.setScalar(Math.max(1, r));
      (eq.material as THREE.MeshBasicMaterial).opacity = 0.5 * fade;
      ring.scale.setScalar(Math.max(1, r));
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.16 * fade;
      ring.quaternion.copy((camera as THREE.PerspectiveCamera).quaternion);
      shell.scale.setScalar(Math.max(1, r));
      (shell.material as THREE.MeshBasicMaterial).opacity = 0.05 * fade;
      return true;
    });

    // Missile-kill flashes: quick pop where the wave caught each missile.
    this.activeKills = this.activeKills.filter(k => {
      const age = (now - k.born) / KILL_MS;
      if (age >= 1) {
        k.sprite.visible = false;
        this.killPool.push(k.sprite);
        return false;
      }
      // Small, dim pop — a missile winking out, not an explosion.
      const sz = 220 + 380 * age;
      k.sprite.scale.set(sz, sz, 1);
      (k.sprite.material as THREE.SpriteMaterial).opacity = 0.45 * (1 - age) * (1 - age);
      return true;
    });
  }

  /** Small additive flash at a missile-kill position (pooled sprites). */
  private spawnKill(pos: Vec3): void {
    let sp = this.killPool.pop();
    if (!sp) {
      if (this.activeKills.length >= MAX_KILL_FX) return;
      sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTexture(), color: 0xbfe4ff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.group.add(sp);
    }
    sp.visible = true;
    sp.position.set(pos.x, pos.y, pos.z);
    this.activeKills.push({ sprite: sp, born: performance.now() });
  }

  private flashTexture(): THREE.Texture {
    if (!this.flashTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const rad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      rad.addColorStop(0, 'rgba(255,255,255,1)');
      rad.addColorStop(0.25, 'rgba(190,225,255,0.8)');
      rad.addColorStop(1, 'rgba(120,180,255,0)');
      g.fillStyle = rad;
      g.fillRect(0, 0, 64, 64);
      this.flashTex = new THREE.CanvasTexture(c);
    }
    return this.flashTex;
  }
}
