// three.js scene: starfield + soft nebula backdrop, tactical overlay rings
// (including the red smartbomb-range ring EVE itself draws), beacon elevation
// lines, and the velocity vector. Ships/brackets are HTML (see ui/brackets.ts),
// matching how EVE at fleet zoom is essentially brackets on a skybox.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Sim } from '../sim/sim';
import { Vec3 } from '../sim/vec3';
import { CombatLayer } from './combat';
import pinned from '../../data/pinned.json';

// The tactical overlay plane is FIXED in world space (horizontal, through the
// ship) — EVE does not re-orient it with the camera (user-verified against
// client screenshots at multiple camera angles).

// Ring ladder read off the client (video + user's Photon screenshots): the
// overlay draws 1/5/10/20/30/40/50/75/100/150/200(+) km rings.
export const RING_RADII_KM = [1, 5, 10, 20, 30, 40, 50, 75, 100, 150, 200, 300];
export const SB_RANGE_M = pinned.modules.sbDarkBloodLargeEMP.rangeM;

function circlePoints(r: number, n = 128): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  return pts;
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private overlay = new THREE.Group();
  private velArrow!: THREE.ArrowHelper;
  private elevLines: THREE.Line[] = [];
  private shipGroup = new THREE.Group();
  private headingHelper = new THREE.Object3D();
  /** Nose orientation without bank; the model is this plus a roll about its long axis. */
  private noseQ = new THREE.Quaternion();
  private bank = 0;                                   // rad, eased
  private static readonly NOSE_MAX_RATE = 0.21;       // rad/s (~12°/s) — battleship pivot
  private static readonly BANK_GAIN = 1.7;            // rad of bank per rad/s of yaw
  private static readonly MAX_BANK = 0.35;            // rad (~20°)
  private lastNoseMs = 0;
  readonly combat = new CombatLayer();
  modelRot = new THREE.Euler(0, 0, 0); // STL axis correction (long axis is native Z; tune by eye)
  overlayVisible = true;
  /** Set by main.ts on selection: interpolated world pos of the selected entity. */
  selectedPosGetter: (() => Vec3 | null) | null = null;
  private selLine!: THREE.Line;
  private selArc!: THREE.Line;
  private alignLine!: THREE.Line;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Lighting for the ship model (background/overlay materials are unlit).
    this.scene.add(new THREE.HemisphereLight(0x93a7c4, 0x05070a, 0.9));
    const sun = new THREE.DirectionalLight(0xffe8c8, 1.6);
    sun.position.set(1, 0.45, 0.6);
    this.scene.add(sun);

    this.scene.add(this.combat.group);

    // Own-ship model (user-provided Nestor STL), scaled to hull size and
    // oriented so the nose tracks the velocity heading.
    this.scene.add(this.shipGroup);
    new STLLoader().load(`${import.meta.env.BASE_URL}models/nestor.stl`, geo => {
      geo.center();
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      const size = new THREE.Vector3();
      geo.boundingBox!.getSize(size);
      const scale = 480 / Math.max(size.x, size.y, size.z); // Nestor ~480 m overall
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0x9aa1a8, metalness: 0.55, roughness: 0.45,
      }));
      mesh.scale.setScalar(scale);
      // Corrective rotation: map the STL's native axes so the nose is +Z.
      mesh.rotation.set(this.modelRot.x, this.modelRot.y, this.modelRot.z);
      this.shipGroup.add(mesh);
    });

    // Starfield
    const starGeo = new THREE.BufferGeometry();
    const N = 3500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(2_500_000);
      pos.set([v.x, v.y, v.z], i * 3);
      const b = 0.35 + Math.random() * 0.65;
      const tint = Math.random();
      col.set([b * (tint > 0.8 ? 0.8 : 1), b * (tint > 0.9 ? 0.85 : 1), b], i * 3);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
      size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.4,
    })));

    // Nebula backdrop: inside-out sphere with procedural vertex colors.
    // Darker base with more defined, varied nebula patches (user request).
    const neb = new THREE.IcosahedronGeometry(3_000_000, 3);
    const nc: number[] = [];
    const blobs = [
      { d: new THREE.Vector3(0.6, 0.15, 0.4).normalize(), c: new THREE.Color(0.075, 0.10, 0.17), p: 4 },
      { d: new THREE.Vector3(-0.5, -0.1, 0.7).normalize(), c: new THREE.Color(0.12, 0.07, 0.05), p: 5 },
      { d: new THREE.Vector3(-0.2, 0.6, -0.6).normalize(), c: new THREE.Color(0.045, 0.09, 0.11), p: 4 },
      { d: new THREE.Vector3(0.15, -0.5, -0.85).normalize(), c: new THREE.Color(0.09, 0.05, 0.12), p: 6 },
      { d: new THREE.Vector3(0.85, -0.2, -0.4).normalize(), c: new THREE.Color(0.05, 0.055, 0.10), p: 7 },
    ];
    const vp = neb.getAttribute('position');
    for (let i = 0; i < vp.count; i++) {
      const d = new THREE.Vector3().fromBufferAttribute(vp, i).normalize();
      const c = new THREE.Color(0.004, 0.005, 0.008);
      // A tad darker overall (user request, third dimming pass).
      const DIM = 0.78;
      for (const b of blobs) {
        const w = Math.pow(Math.max(0, d.dot(b.d)), b.p) * DIM;
        c.r += b.c.r * w; c.g += b.c.g * w; c.b += b.c.b * w;
      }
      nc.push(c.r, c.g, c.b);
    }
    neb.setAttribute('color', new THREE.Float32BufferAttribute(nc, 3));
    this.scene.add(new THREE.Mesh(neb, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, depthWrite: false,
    })));

    // Tactical overlay rings
    for (const km of RING_RADII_KM) {
      const geo = new THREE.BufferGeometry().setFromPoints(circlePoints(km * 1000));
      this.overlay.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0x4a5f73, transparent: true, opacity: 0.28,
      })));
    }
    const sbGeo = new THREE.BufferGeometry().setFromPoints(circlePoints(SB_RANGE_M));
    this.overlay.add(new THREE.Line(sbGeo, new THREE.LineBasicMaterial({
      color: 0xb03030, transparent: true, opacity: 0.55,
    })));
    // Targeting range: the client draws it as a red DOTTED ring (EVE Uni
    // "Tactical overlay"). Nestor 75 km base x Long Range Targeting V = 93.75 km.
    const tgtGeo = new THREE.BufferGeometry().setFromPoints(circlePoints(93_750));
    const tgtRing = new THREE.Line(tgtGeo, new THREE.LineDashedMaterial({
      color: 0xb54040, transparent: true, opacity: 0.45, dashSize: 1800, gapSize: 1400,
    }));
    tgtRing.computeLineDistances();
    this.overlay.add(tgtRing);
    this.scene.add(this.overlay);

    // Velocity vector arrow (EVE tactical UI): short arrow from the ship along
    // the direction of travel, length scaling with speed.
    this.velArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 500, 0x9fc3d8, 120, 60);
    (this.velArrow.line.material as THREE.LineBasicMaterial).transparent = true;
    (this.velArrow.line.material as THREE.LineBasicMaterial).opacity = 0.75;
    (this.velArrow.cone.material as THREE.MeshBasicMaterial).transparent = true;
    (this.velArrow.cone.material as THREE.MeshBasicMaterial).opacity = 0.75;
    this.scene.add(this.velArrow);

    // White line to the selected object (tactical overlay, per EVE Uni wiki).
    const mkLine = (color: number, opacity: number): THREE.Line => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
      line.visible = false;
      this.scene.add(line);
      return line;
    };
    this.selLine = mkLine(0xd8e2ea, 0.45);
    // Thin blue trajectory line toward the align point (the align marker itself
    // is HTML — see brackets.ts; this is the in-space line from the ship).
    this.alignLine = mkLine(0x6fa8c8, 0.5);

    // White arc for an off-plane selected object (client behavior): swings the
    // TRUE 3D distance down onto the overlay plane so range reads correctly.
    const arcGeo = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 33 }, () => new THREE.Vector3()));
    this.selArc = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({
      color: 0xd8e2ea, transparent: true, opacity: 0.3,
    }));
    this.selArc.visible = false;
    this.scene.add(this.selArc);
  }

  private setLine(line: THREE.Line, a: Vec3, b: Vec3): void {
    const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, a.x, a.y, a.z);
    attr.setXYZ(1, b.x, b.y, b.z);
    attr.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  ensureElevLines(n: number): void {
    while (this.elevLines.length < n) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0x4a5f73, transparent: true, opacity: 0.35,
      }));
      this.elevLines.push(line);
      this.scene.add(line);
    }
  }

  resize(w: number, h: number): void { this.renderer.setSize(w, h, false); }

  render(sim: Sim, shipRenderPos: Vec3, shipRenderVel: Vec3, frac: number, camera: THREE.PerspectiveCamera): void {
    this.overlay.visible = this.overlayVisible;
    this.overlay.position.set(shipRenderPos.x, shipRenderPos.y, shipRenderPos.z);

    // Ship model: follow interpolated position; ease the nose toward the
    // velocity direction with a battleship-slow, frame-rate-independent tau
    // (a Nestor answers the helm in seconds, not frames).
    this.shipGroup.position.set(shipRenderPos.x, shipRenderPos.y, shipRenderPos.z);
    const v = shipRenderVel;
    const sp = Math.hypot(v.x, v.y, v.z);
    const hd = sp > 0.5 ? { x: v.x / sp, y: v.y / sp, z: v.z / sp } : sim.ship.heading;
    this.headingHelper.position.copy(this.shipGroup.position);
    this.headingHelper.lookAt(
      shipRenderPos.x + hd.x * 1000, shipRenderPos.y + hd.y * 1000, shipRenderPos.z + hd.z * 1000);
    const now = performance.now();
    const dtMs = Math.min(100, now - (this.lastNoseMs || now));
    this.lastNoseMs = now;
    // Ease with a turn-rate cap, so a full reversal reads as a battleship's
    // slow pivot instead of a quick flip.
    const prevQ = this.noseQ.clone();
    const ang = this.noseQ.angleTo(this.headingHelper.quaternion);
    if (ang > 1e-6) {
      const step = Math.min(ang * (1 - Math.exp(-dtMs / 2600)), SceneView.NOSE_MAX_RATE * dtMs / 1000);
      this.noseQ.rotateTowards(this.headingHelper.quaternion, step);
    }
    // Bank into turns: roll against the yaw rate about world up (model forward
    // is local +Z; a left turn rotates +Z toward +X, which banks left = −roll).
    const f0 = new THREE.Vector3(0, 0, 1).applyQuaternion(prevQ);
    const f1 = new THREE.Vector3(0, 0, 1).applyQuaternion(this.noseQ);
    const yawStep = Math.atan2(f0.z * f1.x - f0.x * f1.z, f0.x * f1.x + f0.z * f1.z);
    const yawRate = dtMs > 0 ? yawStep / (dtMs / 1000) : 0;
    const bankTarget = Math.max(-SceneView.MAX_BANK, Math.min(SceneView.MAX_BANK, -yawRate * SceneView.BANK_GAIN));
    this.bank += (bankTarget - this.bank) * (1 - Math.exp(-dtMs / 800));
    this.shipGroup.quaternion.copy(this.noseQ)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.bank));

    // Velocity arrow: from the ship along travel direction, sized by speed.
    this.velArrow.visible = sp > 2;
    if (this.velArrow.visible) {
      this.velArrow.position.set(shipRenderPos.x, shipRenderPos.y, shipRenderPos.z);
      this.velArrow.setDirection(new THREE.Vector3(hd.x, hd.y, hd.z));
      const len = 200 + sp * 10;
      this.velArrow.setLength(len, Math.min(500, len * 0.18), Math.min(250, len * 0.08));
    }

    // Overlay lines: white line to the selected object; blue trajectory line
    // toward the align point while an align command runs.
    const selPos = this.selectedPosGetter?.() ?? null;
    this.selLine.visible = this.overlayVisible && !!selPos;
    if (selPos) this.setLine(this.selLine, shipRenderPos, selPos);
    // Off-plane selection: arc the 3D distance down to the overlay plane.
    let arcShown = false;
    if (selPos && this.overlayVisible) {
      const rx = selPos.x - shipRenderPos.x, ry = selPos.y - shipRenderPos.y, rz = selPos.z - shipRenderPos.z;
      const dh = Math.hypot(rx, rz);
      const d3 = Math.hypot(dh, ry);
      const phi = Math.atan2(ry, dh);
      if (d3 > 1 && dh > 1 && Math.abs(phi) > 0.02) {
        const ux = rx / dh, uz = rz / dh;
        const attr = this.selArc.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < 33; i++) {
          const th = (phi * i) / 32;
          const h = Math.cos(th) * d3, y = Math.sin(th) * d3;
          attr.setXYZ(i, shipRenderPos.x + ux * h, shipRenderPos.y + y, shipRenderPos.z + uz * h);
        }
        attr.needsUpdate = true;
        this.selArc.geometry.computeBoundingSphere();
        arcShown = true;
      }
    }
    this.selArc.visible = arcShown;
    const cmd = sim.ship.command;
    this.alignLine.visible = this.overlayVisible && cmd?.kind === 'align';
    if (cmd?.kind === 'align') {
      this.setLine(this.alignLine, shipRenderPos, {
        x: shipRenderPos.x + cmd.dir.x * 300_000,
        y: shipRenderPos.y + cmd.dir.y * 300_000,
        z: shipRenderPos.z + cmd.dir.z * 300_000,
      });
    }

    const pois = sim.pois();
    this.ensureElevLines(pois.length);
    this.elevLines.forEach((line, i) => {
      if (i >= pois.length) { line.visible = false; return; }
      const b = pois[i];
      line.visible = this.overlayVisible;
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.setXYZ(0, b.pos.x, b.pos.y, b.pos.z);
      attr.setXYZ(1, b.pos.x, shipRenderPos.y, b.pos.z);
      attr.needsUpdate = true;
    });

    this.combat.vectorsVisible = this.overlayVisible;
    this.combat.update(sim, frac, camera);

    this.renderer.render(this.scene, camera);
  }
}
