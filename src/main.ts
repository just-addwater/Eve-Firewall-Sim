import './ui/hud.css';
import { Sim, makeCombatSim } from './sim/sim';
import { ScenarioConfig, DEFAULT_SCENARIO } from './sim/combat';
import { SceneView } from './render/scene';
import { CameraRig } from './render/camera';
import { BracketLayer } from './ui/brackets';
import { Hud, verbRange } from './ui/hud';
import { Vec3 } from './sim/vec3';
import { PropKey } from './sim/modules';
import { hermitePos, hermiteVel } from './render/interp';

function loadScenario(): ScenarioConfig {
  try {
    const raw = localStorage.getItem('efs.scenario');
    if (raw) return { ...DEFAULT_SCENARIO, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SCENARIO };
}
function saveScenario(cfg: ScenarioConfig): void {
  try { localStorage.setItem('efs.scenario', JSON.stringify(cfg)); } catch { /* ignore */ }
}

let scenario = loadScenario();
let sim: Sim = makeCombatSim(scenario);
let collisionsOn = true;
let kraEve = false;
let aidsOn = true;

/** Movement verbs on a target; orbit / keep-at-range use the right-click defaults. */
function issueVerb(kind: 'approach' | 'alignTo' | 'orbit' | 'keepAtRange', targetId: string): void {
  if (kind === 'orbit' || kind === 'keepAtRange') sim.setCommand({ kind, targetId, range: verbRange[kind] });
  else if (kind === 'alignTo') sim.setCommand({ kind: 'alignTo', targetId });
  else sim.setCommand({ kind: 'approach', targetId });
}

const canvas = document.getElementById('space') as HTMLCanvasElement;
const scene = new SceneView(canvas);
const rig = new CameraRig(window.innerWidth / window.innerHeight);
rig.attach(canvas);

const brackets = new BracketLayer(document.getElementById('brackets')!);

// Interpolated ship state for rendering (authoritative sim is 1 Hz; everything
// visible must derive from interpolated state or it lurches once per second).
let frac = 0;
// Own-ship render state is a cubic Hermite across the tick (see render/interp.ts):
// linear interpolation kinked once a second, and the camera is locked to it.
function shipRenderPos(): Vec3 {
  return hermitePos(sim.ship.prevPos, sim.ship.prevVel, sim.ship.pos, sim.ship.vel, frac);
}
function shipRenderVel(): Vec3 {
  return hermiteVel(sim.ship.prevPos, sim.ship.prevVel, sim.ship.pos, sim.ship.vel, frac);
}
rig.lookAt(shipRenderPos);

/** Default look-at distance for a subject the camera hasn't visited yet —
 *  the client frames an object by its size (ships here are 0.3–0.5 km hulls,
 *  fleet members sit in a few-km worm, so ~15 km frames the ship + neighbours). */
const LOOKAT_DEFAULT_DIST = 15_000;
/** Look at a sim object by id, or the own ship for null. */
function lookAtId(id: string | null): void {
  if (!id) { rig.lookAt(shipRenderPos, 'ship'); return; }
  rig.lookAt(() => sim.lookup(id)?.pos ?? shipRenderPos(), id, LOOKAT_DEFAULT_DIST);
}

function select(id: string | null): void {
  brackets.selectedId = id;
  hud.selectedId = id;
  scene.selectedPosGetter = id ? () => sim.lookup(id)?.pos ?? null : null;
}

const hud = new Hud(document.getElementById('hud')!, sim, scenario, {
  toggleProp: (key: PropKey) => sim.toggleProp(key),
  toggleHeat: (key: PropKey) => {
    const m = sim.ship.module(key);
    m.overheat = !m.overheat;
  },
  toggleBomb: i => sim.toggleBomb(i),
  toggleMjd: () => sim.toggleMjd(),
  setThrottle: f => { sim.ship.throttle = f; },
  stop: () => sim.setCommand({ kind: 'stop' }),
  command: issueVerb,
  setKraEve: on => { kraEve = on; sim.ship.kraMode = on ? 'eve' : 'smooth'; },
  lookAt: id => lookAtId(id === 'ship' ? null : id),
  select,
  setLinks: on => { sim.ship.links = on; },
  setOverlay: on => { scene.overlayVisible = on; brackets.ringsVisible = on; },
  setZoomSpeed: f => { rig.zoomSpeed = f; },
  setCamSpeed: f => { rig.rotSpeed = f; },
  setInertia: f => { rig.inertia = f; },
  setCamDynamic: on => { rig.dynamic = on; },
  setCamLock: on => { rig.lockPointer = on; },
  setCamOffset: f => { rig.setOffset(f); },
  setAids: on => {
    aidsOn = on;
    scene.combat.aidsVisible = on;
    brackets.aidsVisible = on;
    sim.calloutsVisible = on;   // relocation toasts are a training aid too
  },
  setCollisions: on => { collisionsOn = on; sim.collisions = on; },
  restartScenario: cfg => {
    scenario = cfg;
    saveScenario(cfg);
    sim = makeCombatSim(cfg);
    sim.collisions = collisionsOn;
    sim.ship.kraMode = kraEve ? 'eve' : 'smooth';
    sim.calloutsVisible = aidsOn;
    hud.setSim(sim);
    brackets.reset();
    select(null);
    lookAtId(null);
  },
});

brackets.onSelect = select;

// Double-click in space: align to that direction (EVE: "Aligning to a point in space").
canvas.addEventListener('dblclick', e => {
  if (deselectTimer !== undefined) { clearTimeout(deselectTimer); deselectTimer = undefined; }
  const dir = rig.rayDirection(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
  sim.setCommand({ kind: 'align', dir, label: 'Aligning to a point in space' });
  // The client pins the align marker way out on the sky along the click ray —
  // effectively at infinity, not on the tactical grid (3,000 km is deep space
  // but safely inside the 8,000 km camera far plane).
  const cam = rig.camera.position;
  brackets.setAlignMarker({
    x: cam.x + dir.x * 3_000_000, y: cam.y + dir.y * 3_000_000, z: cam.z + dir.z * 3_000_000,
  });
});
// Clicking empty space deselects — but only a clean click. Browsers fire
// `click` after a camera drag too (the client never touches selection while
// rotating), and a double-click-to-align fires two clicks first, so deselect
// is deferred until a dblclick has had its chance to cancel it.
// (Travel is measured by the camera rig from movementX/Y: while the pointer is
// locked for rotation, clientX/Y freeze and can't tell a drag from a click.)
let deselectTimer: number | undefined;
canvas.addEventListener('click', e => {
  if (rig.draggedSincePress) return;
  if (e.detail > 1) return;
  deselectTimer = window.setTimeout(() => { deselectTimer = undefined; select(null); }, 250);
});
canvas.addEventListener('pointermove', e => brackets.setMouse(e.clientX, e.clientY));
canvas.addEventListener('pointerleave', () => brackets.clearMouse());

window.addEventListener('keydown', e => {
  // Typing in a field (seed, counts…) must not fire ship hotkeys.
  const tgt = e.target as HTMLElement | null;
  if (tgt && /^(INPUT|SELECT|TEXTAREA)$/.test(tgt.tagName)) {
    if (e.key === 'Escape' || e.key === 'Enter') tgt.blur();
    return;
  }
  if (hud.handleKey(e)) { e.preventDefault(); return; }
  const sel = brackets.selectedId;
  const fkey = /^F([1-7])$/.exec(e.key);
  const digit = /^[1-7]$/.exec(e.key);
  if (fkey || (digit && !e.ctrlKey && !e.altKey)) {
    const idx = parseInt((fkey ? fkey[1] : digit![0]), 10) - 1;
    sim.toggleBomb(idx);
    e.preventDefault();
    return;
  }
  if (e.code === 'Space' && e.ctrlKey) { sim.setCommand({ kind: 'stop' }); e.preventDefault(); }
  else if (e.key === 'j') sim.toggleMjd();
  else if (e.key === 'q' && sel) issueVerb('approach', sel);
  else if (e.key === 'a' && sel) issueVerb('alignTo', sel);
  else if (e.key === 'w' && sel) issueVerb('orbit', sel);
  else if (e.key === 'e' && sel) issueVerb('keepAtRange', sel);
  else if (e.key === 'c') lookAtId(sel);
  else if (e.key === 'r') { lookAtId(null); rig.resetView(); }
  else if (e.key === 'o') hud.toggleOverlay(); // keeps the checkbox + button in sync
});

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  scene.resize(w, h);
  rig.camera.aspect = w / h;
  rig.setSize(w, h); // re-applies the camera offset and the projection matrix
}
window.addEventListener('resize', resize);
resize();

// Main loop: fixed 1 Hz authoritative stepping, interpolated 60 fps rendering.
// Stepping is driven by wall-clock accumulation from BOTH a timer and rAF:
// background tabs throttle rAF to zero, but interval timers still fire ~1/s,
// so the sim keeps its 1 Hz cadence when the pane is not front. If the page is
// suspended longer, the accumulator is capped (the sim pauses; no fast-forward).
const TIME_SCALE = 1;
let acc = 0;
let last = performance.now();
function advance(): void {
  const now = performance.now();
  acc = Math.min(3000, acc + (now - last) * TIME_SCALE);
  last = now;
  while (acc >= 1000) { sim.step(); acc -= 1000; }
}
setInterval(advance, 100);

let lastFrame = performance.now();
function frame(now: number): void {
  const dt = Math.min(250, now - lastFrame);
  lastFrame = now;
  advance();
  frac = acc / 1000;
  rig.update(dt);
  const sp = shipRenderPos();
  const sv = shipRenderVel();
  scene.render(sim, sp, sv, frac, rig.camera);
  brackets.update(sim, rig, sp, frac, window.innerWidth, window.innerHeight);
  hud.update(sim, frac, { speed: Math.hypot(sv.x, sv.y, sv.z), shipPos: sp });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
