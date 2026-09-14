// HUD: speed gauge with throttle, prop + smartbomb module rack, flight status,
// combat-log ticker, live score, overview, toasts, scenario config.
// (The movement calibration harness lives on in src/sim/calibration.ts and
// the vitest suite; its in-app modal was removed by request.)
import { Sim } from '../sim/sim';
import { PropKey } from '../sim/modules';
import { ScenarioConfig, DEFAULT_SCENARIO, MISSILE_INFO, MissileKey, PropChoice, GUIDANCE_RIG_MULT, segmentSphereChord, Smartbomb } from '../sim/combat';
import { Vec3, dist } from '../sim/vec3';
import { fmtClock, fmtDist, fmtNum, fmtSpeed } from './format';

/** Real module icons for the fitted types, served locally from public/icons/
 *  (downloaded from CCP's official Image Service by typeID — SB 14188,
 *  MWD 19359, AB 18676, MJD 4383). */
const modIcon = (k: 'ab' | 'mwd' | 'sb' | 'mjd'): string =>
  `<img class="mico-img" src="${import.meta.env.BASE_URL}icons/${k}.png" alt="" draggable="false">`;

/** Interpolated presentation state — everything visible derives from this, not
 *  from the raw 1 Hz authoritative state, so nothing lurches once per second. */
export interface RenderView { speed: number; shipPos: Vec3; }

export interface HudCallbacks {
  toggleProp(key: PropKey): void;
  toggleHeat(key: PropKey): void;
  toggleBomb(i: number): void;
  toggleMjd(): void;
  setThrottle(f: number): void;
  stop(): void;
  command(kind: 'approach' | 'alignTo' | 'orbit' | 'keepAtRange', targetId: string): void;
  setKraEve(on: boolean): void;
  lookAt(id: string | 'ship'): void;
  select(id: string | null): void;
  setLinks(on: boolean): void;
  setOverlay(on: boolean): void;
  setZoomSpeed(f: number): void;
  setCamSpeed(f: number): void;
  setInertia(f: number): void;
  setCamDynamic(on: boolean): void;
  setCamLock(on: boolean): void;
  setCamOffset(f: number): void;
  setAids(on: boolean): void;
  setCollisions(on: boolean): void;
  restartScenario(cfg: ScenarioConfig): void;
}

function loadPref(key: string, def: number): number {
  try { const v = parseFloat(localStorage.getItem(key) ?? ''); return isNaN(v) ? def : v; } catch { return def; }
}
function savePref(key: string, v: number | boolean): void {
  try { localStorage.setItem(key, String(typeof v === 'boolean' ? (v ? 1 : 0) : v)); } catch { /* ignore */ }
}

/** Default orbit / keep-at-range distances — as in the client, right-click the
 *  verb button to change them; the keyboard verbs (W/E) use them too. */
export const verbRange = {
  orbit: loadPref('efs.orbitRange', 5000),
  keepAtRange: loadPref('efs.karRange', 2000),
};
const RANGE_CHOICES = [500, 1000, 2500, 5000, 7500, 10_000, 15_000, 20_000, 30_000];
const fmtRange = (m: number): string =>
  m >= 10_000 ? `${m / 1000} km` : `${m.toLocaleString('en-US')} m`;
const verbTitle = (verb: 'orbit' | 'keepAtRange'): string =>
  `${verb === 'orbit' ? 'Orbit' : 'Keep at Range'} ${fmtRange(verbRange[verb])} [${verb === 'orbit' ? 'W' : 'E'}] — right-click to set distance`;

/** Right-click distance picker for the orbit / keep-at-range verb buttons. */
function showRangeMenu(btn: HTMLElement, verb: 'orbit' | 'keepAtRange', e: MouseEvent): void {
  document.querySelector('.range-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'range-menu';
  menu.innerHTML = `<div class="rm-title">${verb === 'orbit' ? 'Orbit' : 'Keep at Range'} distance</div>` +
    RANGE_CHOICES.map(m =>
      `<div class="rm-item${m === verbRange[verb] ? ' active' : ''}" data-m="${m}">${fmtRange(m)}</div>`).join('');
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  if (r.right > window.innerWidth) menu.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
  const close = (): void => { menu.remove(); document.removeEventListener('pointerdown', close); };
  menu.addEventListener('pointerdown', ev => ev.stopPropagation());
  menu.addEventListener('click', ev => {
    const m = parseFloat((ev.target as HTMLElement).dataset.m ?? '');
    if (!isNaN(m)) {
      verbRange[verb] = m;
      savePref(verb === 'orbit' ? 'efs.orbitRange' : 'efs.karRange', m);
      btn.title = verbTitle(verb);
    }
    close();
  });
  setTimeout(() => document.addEventListener('pointerdown', close), 0);
}

const ARC = 270; // gauge sweep degrees

/** Photon window-title tools: the client's "—" minimize (collapses to the title bar). */
const WIN_TOOLS = '<span class="win-tools"><span class="win-tool win-min" title="Minimize">—</span></span>';

/** Scenario presets. Multi-fleet compositions come only from here (per-fleet
 *  manual editing is deliberately out of scope until it proves necessary).
 *  Each carries a briefing: what the drill trains, shown at start. */
interface Preset { label: string; brief: string; cfg: Partial<ScenarioConfig>; }
const PRESETS: Record<string, Preset> = {
  // missileVelocityMult = verified hull traits at V (see DOCTRINES in combat.ts);
  // the guidance-rigs config toggle adds the fleet-fit ×1.3 on top.
  heavy50: {
    label: 'Typhoon heavies — 50 km',
    brief: 'One Typhoon fleet streaming heavies from 50 km. Find the lane, sit one missile-tick upstream of the ball, and keep the bombs staggered so every tick has a pulse.',
    cfg: {
      shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0,
      hostileCount: 50, fightingDistanceKm: 50, hostileSpeed: 400, warpPeriodS: 90, extraFleets: [],
      playerStart: 'ball', gate: false,
    },
  },
  cruise90: {
    label: 'Raven cruise — 90 km',
    brief: 'Ravens at 90 km with the hull velocity bonus: cruise missiles cover 10 km a tick, so the catch window is a single sample. Positioning has to be exact.',
    cfg: {
      shipType: 'Raven', missile: 'cruise', missileVelocityMult: 1.5,
      hostileCount: 50, fightingDistanceKm: 90, hostileSpeed: 350, warpPeriodS: 90, extraFleets: [],
      playerStart: 'ball', gate: false,
    },
  },
  two: {
    label: 'Two fleets — split lanes',
    brief: 'Typhoons at 50 km and Ravens at 90 km on separate bearings. One Nestor cannot cover both: read the coverage rows and pick the lane that is leaking.',
    cfg: {
      shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0,
      hostileCount: 40, fightingDistanceKm: 50, hostileSpeed: 400, warpPeriodS: 120,
      extraFleets: [{ doctrine: 'raven-cruise', count: 40, distanceKm: 90, warpPeriodS: 120 }],
      playerStart: 'ball', gate: false,
    },
  },
  three: {
    label: 'Three fleets + Eagle distractor',
    brief: 'Typhoons, Barghests (the fastest lanes in the game) and a rail Eagle fleet that fires no missiles. Identify the turret fleet from the overview Type column and do not waste a lane on it.',
    cfg: {
      shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0,
      hostileCount: 35, fightingDistanceKm: 50, hostileSpeed: 400, warpPeriodS: 120,
      extraFleets: [
        { doctrine: 'barghest-cruise', count: 30, distanceKm: 110, warpPeriodS: 120 },
        { doctrine: 'eagle-rail', count: 30, distanceKm: 60, warpPeriodS: 60 },
      ],
      playerStart: 'ball', gate: false,
    },
  },
  ham20: {
    label: 'HAM brawl — 20 km',
    brief: 'Cerberus fleet diving to 20 km with HAMs. Short lanes, fast retargets, and they warp in almost on top of the ball. Expect to firewall from inside the blob.',
    cfg: {
      shipType: 'Cerberus', missile: 'ham', missileVelocityMult: 2.0,
      hostileCount: 40, fightingDistanceKm: 20, hostileSpeed: 900, warpPeriodS: 60, extraFleets: [],
      playerStart: 'ball', gate: false,
    },
  },
  gatecamp: {
    label: 'Gate camp — static ball',
    brief: 'The fleet sits on a stargate and does not move. Hostiles land 40 km out on a fresh bearing every 45 s. Pure reaction drill: watch Local, read the new bearing off the overview, get on the lane before the first volley.',
    cfg: {
      shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0,
      friendlySpeed: 0, friendlyPattern: 'orbit', fleetSloppiness: 0.3,
      hostileCount: 40, fightingDistanceKm: 40, hostileSpeed: 400, warpPeriodS: 45,
      fcSkill: 0.5, hostilePersonalities: false, extraFleets: [],
      playerStart: 'ball', gate: true,
    },
  },
  full150: {
    label: 'Full scale — 150 v 150',
    brief: 'Sov-fight numbers: 150 blues in a long worm and 150 Typhoons on the lane. The stream is dense enough that a single misplaced tick leaks dozens. Starts you on the lane; hold it.',
    cfg: {
      shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0,
      friendlyCount: 150, friendlySpeed: 300, hostileCount: 150, fightingDistanceKm: 50,
      hostileSpeed: 400, warpPeriodS: 120, fleetSloppiness: 0.6, extraFleets: [],
      playerStart: 'lane', gate: false,
    },
  },
};

const START_LABELS: Record<NonNullable<ScenarioConfig['playerStart']>, string> = {
  ball: 'Just off the ball', lane: 'On the lane (firewall spot)', off: '30 km off the lane',
};

/** Named scenario slots (localStorage). */
const SLOTS_KEY = 'efs.slots';
function loadSlots(): Record<string, ScenarioConfig> {
  try { return JSON.parse(localStorage.getItem(SLOTS_KEY) ?? '{}') as Record<string, ScenarioConfig>; } catch { return {}; }
}
function saveSlots(s: Record<string, ScenarioConfig>): void {
  try { localStorage.setItem(SLOTS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

interface OvRow { id: string; el: HTMLElement; d: HTMLElement; v: HTMLElement; hostile: boolean; }
type OvTab = 'general' | 'hostile' | 'fleet';

/** One-click difficulty ladder (design-brief progression): static single lane
 *  with aids → moving fleets → warp relocations → second lane → three mixed
 *  fleets at speed with aids off. */
const LEVELS: { label: string; title: string; brief: string; aids: boolean; cfg: Partial<ScenarioConfig> }[] = [
  { label: 'L1', title: 'Level 1 — static lane', aids: true,
    brief: 'Nobody moves. One lane, slow volleys, the amber firewall spot marked. Learn the geometry: sit one missile-tick upstream of the ball and stagger the seven bombs.',
    cfg: {
    shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0, hostileCount: 40,
    fightingDistanceKm: 50, hostileSpeed: 0, friendlySpeed: 0, warpPeriodS: 0,
    volleyPeriodS: 10, fleetSloppiness: 0, fcSkill: 0, hostilePersonalities: false,
    alphaSync: false, wingSplits: false, extraFleets: [], playerStart: 'ball', gate: false } },
  { label: 'L2', title: 'Level 2 — moving fleets', aids: true,
    brief: 'Both fleets under way in tight balls. The lane swings as the FCs orbit: keep station on it with orbit or keep-at-range on the anchor.',
    cfg: {
    shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0, hostileCount: 45,
    fightingDistanceKm: 50, hostileSpeed: 400, friendlySpeed: 300, warpPeriodS: 0,
    volleyPeriodS: 8, fleetSloppiness: 0, fcSkill: 0, hostilePersonalities: true,
    alphaSync: false, wingSplits: false, extraFleets: [], playerStart: 'ball', gate: false } },
  { label: 'L3', title: 'Level 3 — relocations', aids: true,
    brief: 'The hostile FC warps off and lands on a new bearing every 90 s, and now lands where your bubble is not. Reaction time is scored from the landing.',
    cfg: {
    shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0, hostileCount: 50,
    fightingDistanceKm: 50, hostileSpeed: 400, friendlySpeed: 300, warpPeriodS: 90,
    volleyPeriodS: 8, fleetSloppiness: 0.3, fcSkill: 0.5, hostilePersonalities: true,
    alphaSync: false, wingSplits: false, extraFleets: [], playerStart: 'ball', gate: false } },
  { label: 'L4', title: 'Level 4 — second lane', aids: true,
    brief: 'A Raven cruise fleet joins at 90 km. Two lanes, one firewall: use the coverage rows to decide which lane to hold and when to swap.',
    cfg: {
    shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0, hostileCount: 40,
    fightingDistanceKm: 50, hostileSpeed: 400, friendlySpeed: 300, warpPeriodS: 120,
    volleyPeriodS: 8, fleetSloppiness: 0.5, fcSkill: 0.5, hostilePersonalities: true,
    alphaSync: false, wingSplits: false, playerStart: 'ball', gate: false,
    extraFleets: [{ doctrine: 'raven-cruise', count: 40, distanceKm: 90, warpPeriodS: 120 }] } },
  { label: 'L5', title: 'Level 5 — the real thing', aids: false,
    brief: 'Three mixed fleets including a HAM dive and a turret distractor, a ruthless FC with wing splits, a sloppy strung-out blue worm, and no training aids. Read everything from the overview and Local.',
    cfg: {
    shipType: 'Typhoon', missile: 'heavy', missileVelocityMult: 1.0, hostileCount: 35,
    fightingDistanceKm: 50, hostileSpeed: 500, friendlySpeed: 350, warpPeriodS: 90,
    volleyPeriodS: 7, fleetSloppiness: 0.75, fcSkill: 1, hostilePersonalities: true,
    alphaSync: false, wingSplits: true, playerStart: 'off', gate: false,
    extraFleets: [
      { doctrine: 'cerberus-ham', count: 35, distanceKm: 20, warpPeriodS: 60 },
      { doctrine: 'eagle-rail', count: 30, distanceKm: 60, warpPeriodS: 60 },
    ] } },
];

/** EVE combat-log line markup: teal damage number, dim connectives, white name
 *  ("375 to Heavy Missile - Hits" — format verified in the reference footage). */
function combatLineHtml(text: string): string {
  const m = /^([\d,]+) to (.+) - (.+)$/.exec(text);
  if (!m) return text;
  return `<span class="cl-dmg">${m[1]}</span><span class="cl-dim"> to </span>` +
    `<span class="cl-name">${m[2]}</span><span class="cl-dim"> - ${m[3]}</span>`;
}

export class Hud {
  private cb: HudCallbacks;
  private root: HTMLElement;
  private gaugeFill!: SVGCircleElement;
  private throttleMark!: SVGLineElement;
  private speedVal!: HTMLElement;
  private speedMax!: HTMLElement;
  private statusEl!: HTMLElement;
  private toastsEl!: HTMLElement;
  private tickerEl!: HTMLElement;
  private scoreEl!: HTMLElement;
  private toastCount = 0;
  private tickerCount = 0;
  private modSlots = new Map<PropKey, HTMLElement>();
  private bombSlots: HTMLElement[] = [];
  private mjdSlot!: HTMLElement;
  private localEl!: HTMLElement;
  private lastLocalCount = -1;
  private selectedPanel!: HTMLElement;
  private overviewBody!: HTMLElement;
  private ovRows: OvRow[] = [];
  private lastOverviewAt = -1;
  private readoutsEl!: HTMLElement;
  private leftCol!: HTMLElement;
  private keysEl!: HTMLElement;
  private ro: Record<'vel' | 'sig' | 'mass' | 'tau' | 'time', HTMLElement> | null = null;
  private briefEl!: HTMLElement;
  private lastBrief = '';
  private lastScoreHtml = '';
  private lastStatusHtml = '';
  private scenarioCfg: ScenarioConfig;
  private ovTab: OvTab = 'hostile';   // firewalling default (user preference)
  selectedId: string | null = null;

  constructor(root: HTMLElement, sim: Sim, scenarioCfg: ScenarioConfig, cb: HudCallbacks) {
    this.cb = cb;
    this.root = root;
    this.scenarioCfg = scenarioCfg;
    root.innerHTML = '';
    this.buildStatus();
    this.buildGaugeCluster();
    this.buildSelected();
    this.buildOverview();
    // Left column: ship panel on top, Local + Drill anchored at the bottom.
    // One flex column so the panels can never overlap — the ship panel
    // scrolls instead when the viewport is short.
    this.leftCol = this.el('div', '', this.root);
    this.leftCol.id = 'left-col';
    this.buildReadouts();
    this.el('div', 'left-spacer', this.leftCol);
    this.buildScore();
    this.buildKeys();
    // Window minimize (the client's "—" collapses a window to its title bar).
    // Delegated so panels rebuilt later (Selected Item) get it too.
    this.root.addEventListener('click', e => {
      const t = (e.target as HTMLElement).closest('.win-min');
      if (!t) return;
      const p = t.closest('.panel') as HTMLElement;
      p.classList.toggle('min');
      if (p.id) savePref(`efs.min.${p.id}`, p.classList.contains('min'));
    });
    for (const p of this.root.querySelectorAll('.panel[id]')) {
      if (loadPref(`efs.min.${p.id}`, 0) !== 0) p.classList.add('min');
    }
    this.setSim(sim);
  }

  /** Flip the tactical-overlay checkbox (and notify) — one code path for the
   *  checkbox, the gauge-side button and the O key. */
  toggleOverlay(): void {
    const c = this.q('#c-overlay') as HTMLInputElement;
    c.checked = !c.checked;
    c.dispatchEvent(new Event('change'));
  }

  /** Root-scoped lookup (windows get moved out of the panel they were built in). */
  private q(sel: string): Element | null { return this.root.querySelector(sel); }

  /** Global keys owned by the HUD: ? / H toggles the shortcut sheet, Escape
   *  closes whatever window is open. Returns true when handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      const menu = document.querySelector('.range-menu');
      const open = [this.keysEl, this.q('#c-scenario') as HTMLElement]
        .filter(w => !w.classList.contains('hidden'));
      if (menu) menu.remove();
      for (const w of open) w.classList.add('hidden');
      return open.length > 0 || !!menu;
    }
    if (e.key === '?' || ((e.key === '/' || e.code === 'Slash') && e.shiftKey) || e.key === 'h' || e.key === 'H') {
      this.toggleKeys();
      return true;
    }
    return false;
  }

  toggleKeys(): void { this.keysEl.classList.toggle('hidden'); }

  /** Re-bind to a (new) sim: rebuild overview rows, reset event counters. */
  setSim(sim: Sim): void {
    this.toastCount = 0;
    this.tickerCount = 0;
    this.lastOverviewAt = -1;
    this.lastLocalCount = -1;
    this.selectedId = null;
    this.overviewBody.innerHTML = '';
    this.ovRows = [];
    this.tickerEl.innerHTML = '';
    // kind: 'beacon' (no colortag) | 'fleet' (violet star, blue bg) | 'hostile'
    // (red minus badge, red bg) — the client's standing colortags + backgrounds.
    const addRow = (id: string, name: string, type: string, kind: 'beacon' | 'fleet' | 'hostile'): void => {
      const el = document.createElement('div');
      const hostile = kind === 'hostile';
      el.className = `ov-row ov-${kind}`;
      el.innerHTML = `<span class="ico"><i class="sh"></i>${kind === 'beacon' ? '' : '<i class="tag"></i>'}</span>` +
        `<span class="d">—</span><span class="n">${name}</span><span class="t">${type}</span><span class="v">—</span>`;
      el.addEventListener('click', () => this.cb.select(id));
      this.overviewBody.appendChild(el);
      this.ovRows.push({
        id, el, hostile,
        d: el.querySelector('.d') as HTMLElement,
        v: el.querySelector('.v') as HTMLElement,
      });
    };
    for (const b of sim.beacons) addRow(b.id, b.name, 'Beacon', 'beacon');
    if (sim.combat) {
      for (const m of sim.combat.friendly.members) addRow(m.id, m.name, m.type, 'fleet');
      for (const f of sim.combat.hostiles) {
        for (const m of f.blob.members) addRow(m.id, m.name, m.type, 'hostile');
      }
    }
  }

  private el(tag: string, cls: string, parent: HTMLElement, html = ''): HTMLElement {
    const e = document.createElement(tag);
    e.className = cls;
    if (html) e.innerHTML = html;
    parent.appendChild(e);
    return e;
  }

  private buildStatus(): void {
    this.statusEl = this.el('div', '', this.root);
    this.statusEl.id = 'status';
    this.toastsEl = this.el('div', '', this.root);
    this.toastsEl.id = 'toasts';
    this.tickerEl = this.el('div', '', this.root);
    this.tickerEl.id = 'ticker';
  }

  private buildGaugeCluster(): void {
    const cluster = this.el('div', '', this.root);
    cluster.id = 'gauge-cluster';

    // Left of the gauge, where the client keeps its tactical-overlay button.
    const side = this.el('div', '', cluster);
    side.id = 'gauge-side';
    side.innerHTML = `
      <div class="side-btn" id="g-overlay" title="Tactical overlay [O]">
        <svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10" ry="4.2"/><ellipse cx="12" cy="12" rx="5.5" ry="2.3"/>
          <circle cx="12" cy="12" r="1.2" class="fill"/></svg></div>`;
    (side.querySelector('#g-overlay') as HTMLElement).addEventListener('click', () => this.toggleOverlay());

    const gauge = this.el('div', '', cluster);
    gauge.id = 'gauge';
    // Gauge anatomy per the client's HUD (user reference): a STATIC tick arc
    // over the top with a red end-segment, capacitor arcs in the center, and
    // speed shown ONLY at the bottom — a filling arc bar plus the number.
    // Screen angles (SVG y-down): lower-left 135°, top 270°, lower-right 45°.
    const P = (r: number, aDeg: number): string => {
      const a = aDeg * Math.PI / 180;
      return `${(84 + Math.cos(a) * r).toFixed(1)} ${(84 + Math.sin(a) * r).toFixed(1)}`;
    };
    const NT = 56;
    let ticks = '';
    for (let i = 0; i <= NT; i++) {
      const a = (135 + ARC * i / NT) * Math.PI / 180;
      const red = i > NT - 6;
      ticks += `<line x1="${(84 + Math.cos(a) * 59).toFixed(1)}" y1="${(84 + Math.sin(a) * 59).toFixed(1)}"
        x2="${(84 + Math.cos(a) * 71).toFixed(1)}" y2="${(84 + Math.sin(a) * 71).toFixed(1)}"
        stroke="${red ? '#c23328' : 'rgba(215,228,238,0.5)'}" stroke-width="${red ? 3 : 1.6}"/>`;
    }
    const barD = `M ${P(66, 135)} A 66 66 0 0 0 ${P(66, 45)}`;
    gauge.innerHTML = `
      <svg viewBox="0 0 168 168">
        <g>${ticks}</g>
        <path d="${barD}" fill="none" stroke="rgba(70,90,105,0.5)" stroke-width="10"/>
        <path id="g-bar" d="${barD}" pathLength="100" fill="none" stroke="#b8d2e2" stroke-width="10"
          stroke-dasharray="0 100"/>
        <line id="g-throttle" x1="0" y1="0" x2="0" y2="0" stroke="#d0a94f" stroke-width="3"/>
        <!-- Capacitor look (cosmetic — cap is out of scope by design): the
             client's concentric segmented amber arcs, rendered full. -->
        <g opacity="0.85">
          <circle cx="84" cy="84" r="24" fill="none" stroke="#a8642e" stroke-width="4" stroke-dasharray="3.4 2.2"/>
          <circle cx="84" cy="84" r="31" fill="none" stroke="#c07836" stroke-width="4" stroke-dasharray="4.1 2.4"/>
          <circle cx="84" cy="84" r="38" fill="none" stroke="#d08a3f" stroke-width="4" stroke-dasharray="4.8 2.6"/>
          <circle cx="84" cy="84" r="45" fill="none" stroke="#dc9c4c" stroke-width="4" stroke-dasharray="5.5 2.8"/>
        </g>
      </svg>
      <div class="gbtn gbtn-min" data-act="stop" title="Stop ship (Ctrl+Space)">−</div>
      <div class="gbtn gbtn-max" data-act="full" title="Full throttle">+</div>
      <div class="speed-read">
        <div class="speed-val">0 m/s</div>
        <div class="speed-max">of 87.5 m/s</div>
      </div>`;
    this.gaugeFill = gauge.querySelector('#g-bar') as SVGCircleElement;
    this.throttleMark = gauge.querySelector('#g-throttle') as SVGLineElement;
    this.speedVal = gauge.querySelector('.speed-val') as HTMLElement;
    this.speedMax = gauge.querySelector('.speed-max') as HTMLElement;
    (gauge.querySelector('[data-act=stop]') as HTMLElement).addEventListener('click', () => this.cb.stop());
    (gauge.querySelector('[data-act=full]') as HTMLElement).addEventListener('click', () => this.cb.setThrottle(1));
    const svg = gauge.querySelector('svg')!;
    // Click on the bottom speed bar sets throttle (0 at lower-left, 1 at
    // lower-right), as in the client.
    svg.addEventListener('click', e => {
      const r = svg.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const a = Math.atan2(dy, dx) * 180 / Math.PI; // bottom = +90
      if (a >= 30 && a <= 150) this.cb.setThrottle(Math.max(0, Math.min(1, (135 - a) / 90)));
    });

    // Rack layout matched to the user's client screenshot: smartbombs (high
    // slots) in the top row, prop mods + MJD in the second row.
    const mods = this.el('div', '', cluster);
    mods.id = 'modules';
    const rowTop = this.el('div', 'mod-row', mods);
    const rowBot = this.el('div', 'mod-row', mods);
    for (let i = 0; i < 7; i++) {
      const slot = this.el('div', 'mod-slot bomb-slot', rowTop, `
        <div class="mod-btn" style="--prog:0" title="Dark Blood Large EMP Smartbomb [F${i + 1} / ${i + 1}]">
          <div class="ring"></div><span class="mico">${modIcon('sb')}</span></div>`);
      (slot.querySelector('.mod-btn') as HTMLElement).addEventListener('click', () => this.cb.toggleBomb(i));
      this.bombSlots.push(slot);
    }
    for (const [key, name] of [['ab', 'Gist X-Type 100MN Afterburner'], ['mwd', 'Gist X-Type 500MN Microwarpdrive']] as [PropKey, string][]) {
      const slot = this.el('div', 'mod-slot', rowBot, `
        <div class="heat-pip" title="Toggle overheat"></div>
        <div class="mod-btn" style="--prog:0" title="${name}"><div class="ring"></div><span class="mico">${modIcon(key)}</span></div>`);
      (slot.querySelector('.heat-pip') as HTMLElement).addEventListener('click', () => this.cb.toggleHeat(key));
      (slot.querySelector('.mod-btn') as HTMLElement).addEventListener('click', () => this.cb.toggleProp(key));
      this.modSlots.set(key, slot);
    }
    this.mjdSlot = this.el('div', 'mod-slot bomb-slot mjd-slot', rowBot, `
      <div class="heat-spacer"></div>
      <div class="mod-btn" style="--prog:0" title="Large Micro Jump Drive [J]">
        <div class="ring"></div><span class="mico">${modIcon('mjd')}</span></div>`);
    (this.mjdSlot.querySelector('.mod-btn') as HTMLElement).addEventListener('click', () => this.cb.toggleMjd());
  }

  private buildSelected(): void {
    this.selectedPanel = this.el('div', 'panel hidden', this.root);
    this.selectedPanel.id = 'selected';
  }

  private buildOverview(): void {
    const ov = this.el('div', 'panel', this.root);
    ov.id = 'overview';
    ov.innerHTML = `
      <div class="win-title"><span>Overview (firewall)</span>${WIN_TOOLS}</div>
      <div class="ov-tabs">
        <span class="ov-tab" data-tab="general">General</span>
        <span class="ov-tab active" data-tab="hostile">Hostile</span>
        <span class="ov-tab" data-tab="fleet">Fleet</span>
        <span class="ov-tab-plus">+</span>
      </div>
      <div class="ov-head"><span class="ico"></span><span class="d sorted">Distance <i>▲</i></span>
        <span>Name</span><span>Type</span><span class="v">Velocity</span></div>
      <div class="ov-body"></div>`;
    this.overviewBody = ov.querySelector('.ov-body') as HTMLElement;
    for (const tab of ov.querySelectorAll('.ov-tab')) {
      tab.addEventListener('click', () => {
        this.ovTab = (tab as HTMLElement).dataset.tab as OvTab;
        for (const t of ov.querySelectorAll('.ov-tab')) t.classList.toggle('active', t === tab);
        this.lastOverviewAt = -1; // refilter immediately
      });
    }
  }

  private buildScore(): void {
    // Local chat mock: the member count is the early warning — it spikes a few
    // seconds before an out-of-system fleet lands back on grid.
    this.localEl = this.el('div', 'panel', this.leftCol);
    this.localEl.id = 'local';
    this.localEl.innerHTML = '<div class="win-title"><span class="l-title">Local <span class="l-count">[—]</span></span></div>';
    const score = this.el('div', 'panel', this.leftCol);
    score.id = 'score';
    // Title carries the name of whatever scenario was loaded last session.
    score.innerHTML = `<div class="win-title"><span id="d-title">Drill — ${this.scenarioCfg.name ?? 'Custom'}</span>` +
      `<span class="win-tools"><span class="win-tool" id="d-restart" title="Restart this drill (same seed)">↻</span>` +
      `<span class="win-tool win-min" title="Minimize">—</span></span></div><div class="sc-body"></div>`;
    this.scoreEl = score.querySelector('.sc-body') as HTMLElement;
    (score.querySelector('#d-restart') as HTMLElement).addEventListener('click', () =>
      this.restart({ ...this.scenarioCfg }, this.lastBrief));
    // Briefing card: what this drill trains, shown at every start.
    this.briefEl = this.el('div', 'panel hidden', this.root);
    this.briefEl.id = 'briefing';
    this.briefEl.addEventListener('click', () => this.briefEl.classList.add('hidden'));
  }

  /** Restart on a config, naming it in the Drill title and showing its briefing. */
  private restart(next: ScenarioConfig, brief: string): void {
    this.scenarioCfg = next;
    this.lastBrief = brief;
    (this.q('#d-title') as HTMLElement).textContent = `Drill — ${next.name ?? 'Custom'}`;
    this.cb.restartScenario(next);
    this.showBriefing(next.name ?? 'Custom drill', brief || this.describe(next));
  }

  /** One-line summary for unnamed (custom) scenarios. */
  private describe(c: ScenarioConfig): string {
    const extras = (c.extraFleets ?? []).map(e => `${e.count} ${e.doctrine} at ${e.distanceKm} km`).join(', ');
    return `${c.friendlyCount} blues vs ${c.hostileCount} ${c.shipType ?? 'Typhoon'} (${MISSILE_INFO[c.missile].label}) at ${c.fightingDistanceKm} km` +
      (extras ? ` + ${extras}` : '') +
      (c.warpPeriodS > 0 ? `, relocating every ${c.warpPeriodS} s` : ', no relocations') +
      `. Start: ${START_LABELS[c.playerStart ?? 'ball'].toLowerCase()}. Seed ${c.seed}.`;
  }

  private briefTimer: number | undefined;
  private showBriefing(title: string, text: string): void {
    this.briefEl.innerHTML = `<div class="win-title"><span>Briefing — ${title}</span></div>` +
      `<div class="win-body"><div class="brief-text">${text}</div><div class="ctl-note">click to dismiss</div></div>`;
    this.briefEl.classList.remove('hidden');
    this.briefEl.style.opacity = '1';
    if (this.briefTimer !== undefined) clearTimeout(this.briefTimer);
    this.briefTimer = window.setTimeout(() => {
      this.briefEl.style.opacity = '0';
      this.briefTimer = window.setTimeout(() => this.briefEl.classList.add('hidden'), 700);
    }, 12_000);
  }

  /** Keyboard cheat sheet — a small floating window (? / H, or the ? tool
   *  on the ship panel). */
  private buildKeys(): void {
    this.keysEl = this.el('div', 'panel hidden', this.root);
    this.keysEl.id = 'keys';
    const rows: [string, string][] = [
      ['F1–F7 · 1–7', 'Toggle smartbomb'],
      ['J', 'Micro Jump Drive'],
      ['Q · A · W · E', 'Approach · Align to · Orbit · Keep at range (selected item)'],
      ['C', 'Look at selected item'],
      ['R', 'Reset camera'],
      ['O', 'Tactical overlay'],
      ['Ctrl + Space', 'Stop ship'],
      ['Double-click space', 'Align to a point in space'],
      ['Drag (left or right)', 'Rotate camera · wheel zooms'],
      ['Right-click Orbit / Keep', 'Set the default distance'],
      ['Click speed bar', 'Set throttle · − stops · + full speed'],
      ['? · H', 'This list'],
      ['Esc', 'Close windows'],
    ];
    this.keysEl.innerHTML = `
      <div class="win-title"><span>Keyboard</span><span class="win-close" id="k-close">✕</span></div>
      <div class="win-body"><table class="keys">${rows.map(([k, v]) =>
        `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('')}</table></div>`;
    (this.keysEl.querySelector('#k-close') as HTMLElement)
      .addEventListener('click', () => this.keysEl.classList.add('hidden'));
    makeDraggable(this.keysEl, this.keysEl.querySelector('.win-title') as HTMLElement);
  }

  private buildReadouts(): void {
    this.readoutsEl = this.el('div', 'panel', this.leftCol);
    this.readoutsEl.id = 'readouts';
    const cfg = this.scenarioCfg;
    const missileOpts = (Object.keys(MISSILE_INFO) as MissileKey[])
      .map(k => `<option value="${k}" ${k === cfg.missile ? 'selected' : ''}>${MISSILE_INFO[k].label}</option>`).join('');
    const savedLevel = loadPref('efs.level', -1);
    this.readoutsEl.innerHTML = `
      <div class="win-title"><span>Ship</span>
        <span class="win-tools"><span class="win-tool" id="c-keys" title="Keyboard shortcuts [?]">?</span><span class="win-tool win-min" title="Minimize">—</span></span></div>
      <div class="win-body">
      <div class="r-rows">
        <div class="r-row"><span>Velocity</span><span id="ro-vel"></span></div>
        <div class="r-row"><span>Signature</span><span id="ro-sig"></span></div>
        <div class="r-row"><span>Mass</span><span id="ro-mass"></span></div>
        <div class="r-row"><span>Accel τ</span><span id="ro-tau"></span></div>
        <div class="r-row"><span>Sim time</span><span id="ro-time"></span></div>
      </div>
      <div class="controls">
        <div class="ctl-title fold" data-fold="opt">Options</div>
        <div class="fold-body" data-fold-body="opt">
        <label><input type="checkbox" id="c-links" checked> Fleet boosts (skirmish links)</label>
        <label><input type="checkbox" id="c-overlay" checked> Tactical overlay <kbd>O</kbd></label>
        <label><input type="checkbox" id="c-aids"> Training aids (lane + spot)</label>
        <label><input type="checkbox" id="c-coll"> Collisions (bumping)</label>
        <label title="Off: keep-at-range floats smoothly into position. On: the client's raw controller — full speed toward/away, overshoots on a heavy MWD hull and burns back"><input type="checkbox" id="c-kra"> EVE keep-at-range (overshoots)</label>
        </div>
        <div class="ctl-title fold" data-fold="cam">Camera</div>
        <div class="fold-body" data-fold-body="cam">
        <label>Sensitivity <input type="range" id="c-cam" min="0.3" max="3" step="0.1"></label>
        <label>Inertia <input type="range" id="c-inertia" min="0" max="1" step="0.05"></label>
        <label>Zoom speed <input type="range" id="c-zoom" min="0.3" max="3" step="0.1"></label>
        <label title="Shifts the view so your ship sits off-centre (right = ship moves left, clear of the overview)">Offset <input type="range" id="c-offset" min="-0.3" max="0.3" step="0.02"></label>
        <label title="EVE 'Dynamic camera movement': the camera lags and pulls back a little under acceleration, then settles"><input type="checkbox" id="c-dyncam"> Dynamic camera</label>
        <label title="Hide the cursor while rotating and let the drag run past the screen edge"><input type="checkbox" id="c-lock"> Hide cursor while rotating</label>
        </div>
        <div class="ctl-title fold" data-fold="diff">Difficulty</div>
        <div class="fold-body" data-fold-body="diff">
        <div class="lvl-row">${LEVELS.map((l, i) =>
          `<div class="lvl-btn${i === savedLevel ? ' active' : ''}" data-lvl="${i}" title="${l.label}: ${
            ['static single lane, aids on', 'moving fleets', '+ warp relocations',
             'second lane (Raven cruise)', 'three mixed fleets, aids off'][i]}">${l.label}</div>`).join('')}
        </div>
        </div>
        <div class="btn-row"><div class="sbtn" id="c-scenario-toggle">Scenario…</div></div>
      </div>
      </div>
      <div class="controls hidden" id="c-scenario">
        <div class="win-title"><span>Scenario</span><span class="win-close" id="s-close">✕</span></div>
        <div class="win-body">
        <div class="cfg-grid">
          <label title="Load a full scenario; edits below make it custom">Preset</label><select id="s-preset">
            <option value="">— custom —</option>
            ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('')}
          </select>
          <div class="ctl-title span2">Blue fleet</div>
          <label title="Fleet members anchored on the FC">Friendlies</label><input type="number" id="s-fn" min="5" max="200" value="${cfg.friendlyCount}">
          <label title="Blue DPS hull (Guardians stay the logi)">Hull</label><select id="s-fhull">
            ${['Machariel', 'Apocalypse', 'Typhoon', 'Raven', 'Nestor'].map(h =>
              `<option value="${h}" ${(cfg.friendlyHull ?? 'Machariel') === h ? 'selected' : ''}>${h}</option>`).join('')}
          </select>
          <label title="Fills the m/s field with a class-typical speed">Prop</label><select id="s-fprop">
            <option value="">— pick to set m/s —</option>
            <option value="160">None (~160 m/s)</option>
            <option value="440">AB (~440 m/s)</option>
            <option value="1200">MWD (~1,200 m/s)</option>
          </select>
          <label title="Anchor (FC) cruise speed; members chase at their own pace">Speed m/s</label><input type="number" id="s-fs" min="0" max="3000" value="${cfg.friendlySpeed}">
          <label title="How the FC flies the grid">Anchor move</label><select id="s-fpat">
            <option value="orbit" ${(cfg.friendlyPattern ?? 'orbit') === 'orbit' ? 'selected' : ''}>Large orbit</option>
            <option value="serpentine" ${cfg.friendlyPattern === 'serpentine' ? 'selected' : ''}>Serpentine</option>
            <option value="burnturn" ${cfg.friendlyPattern === 'burnturn' ? 'selected' : ''}>Burn &amp; turn</option>
            <option value="figure8" ${cfg.friendlyPattern === 'figure8' ? 'selected' : ''}>Figure-eight</option>
          </select>
          <label title="Both fleets. Tight: agile 1 km ball (beginner). Middle: realistic hull-derived helms, fleets string out on turns. Sloppy: sluggish helms, wide keep-at-range, long straggler tail">Fleet discipline</label><span class="disc-row"><small>Tight</small><input type="range" id="s-disc" min="0" max="1" step="0.05" value="${cfg.fleetSloppiness ?? 0.5}"><small>Sloppy</small></span>
          <label title="Guardians anchor their own small ball ~15 km off the FC">Separate logi ball</label><input type="checkbox" id="s-logisep" ${cfg.logiSeparate ? 'checked' : ''}>
          <div class="ctl-title span2">Hostile fleet</div>
          <label title="Ships in hostile fleet 1">Hostiles</label><input type="number" id="s-hn" min="5" max="200" value="${cfg.hostileCount}">
          <label title="Rough fighting distance they hold">Distance km</label><input type="number" id="s-dist" min="10" max="255" value="${cfg.fightingDistanceKm}">
          <label title="Fills the m/s field with a class-typical speed">Prop</label><select id="s-hprop">
            <option value="">— pick to set m/s —</option>
            <option value="160">None (~160 m/s)</option>
            <option value="430">AB (~430 m/s)</option>
            <option value="1100">MWD (~1,100 m/s)</option>
          </select>
          <label title="Hostile FC cruise speed">Speed m/s</label><input type="number" id="s-hs" min="0" max="3000" value="${cfg.hostileSpeed}">
          <label title="How they hold the fighting distance">Movement</label><select id="s-hpat">
            <option value="orbit" ${cfg.hostilePattern !== 'serpentine' ? 'selected' : ''}>Large orbit</option>
            <option value="serpentine" ${cfg.hostilePattern === 'serpentine' ? 'selected' : ''}>Serpentine</option>
          </select>
          <label title="Relocate to a new bearing this often (0 = never)">Warp every s</label><input type="number" id="s-warp" min="0" max="600" value="${cfg.warpPeriodS}">
          <label title="Target calls prefer the Guardians about half the time">Call the logi</label><input type="checkbox" id="s-logitgt" ${cfg.hostilesTargetLogi ? 'checked' : ''}>
          <label title="Random: relocations and target calls are random. Competent/Ruthless: lands where your bubble isn't, relocates early when its missiles are dying, calls stragglers and logi with a pre-called secondary">Enemy FC</label><select id="s-fc">
            <option value="0" ${(cfg.fcSkill ?? 0) < 0.25 ? 'selected' : ''}>Random</option>
            <option value="0.5" ${(cfg.fcSkill ?? 0) >= 0.25 && (cfg.fcSkill ?? 0) < 0.75 ? 'selected' : ''}>Competent</option>
            <option value="1" ${(cfg.fcSkill ?? 0) >= 0.75 ? 'selected' : ''}>Ruthless</option>
          </select>
          <label title="Cruise fleets kite (and sit still at 100 km+); HAM fleets dive to ~15 km, sometimes burn straight through the ball, and warp in close">Personalities</label><input type="checkbox" id="s-pers" ${cfg.hostilePersonalities ? 'checked' : ''}>
          <label title="Synced alpha volleys, with the FC calling hold fire while they reposition — instead of a staggered stream">Alpha sync</label><input type="checkbox" id="s-alpha" ${cfg.alphaSync ? 'checked' : ''}>
          <label title="On a relocation a wing of up to 15 ships sometimes lands on a second bearing — two lanes from one fleet">Wing splits</label><input type="checkbox" id="s-wings" ${cfg.wingSplits ? 'checked' : ''}>
          <div class="ctl-title span2">Extra fleets <span class="ctl-note">(from presets)</span></div>
          <label title="Prop override for the second fleet, if the preset has one">Fleet 2 prop</label><select id="s-ef1prop">
            <option value="">Doctrine default</option>
            <option value="none">None</option>
            <option value="ab">AB</option>
            <option value="mwd">MWD</option>
          </select>
          <label title="Prop override for the third fleet, if the preset has one">Fleet 3 prop</label><select id="s-ef2prop">
            <option value="">Doctrine default</option>
            <option value="none">None</option>
            <option value="ab">AB</option>
            <option value="mwd">MWD</option>
          </select>
          <div class="ctl-title span2">Missiles</div>
          <label title="Fleet 1 ammo; extra fleets use their doctrine's">Missile</label><select id="s-missile">${missileOpts}</select>
          <label title="Approximates two Hydraulic Bay Thrusters (×1.3 velocity)">Guidance rigs ×1.3</label><input type="checkbox" id="s-rigs" ${cfg.guidanceRigs !== false ? 'checked' : ''}>
          <label title="Per-ship launcher cycle">Volley every s</label><input type="number" id="s-vp" min="2" max="30" value="${cfg.volleyPeriodS}">
          <label title="Missiles per volley per ship">Launchers/ship</label><input type="number" id="s-lps" min="1" max="7" value="${cfg.launchersPerShip}">
          <div class="ctl-title span2">Drill</div>
          <label title="Where your Nestor spawns">Start position</label><select id="s-start">
            ${(Object.keys(START_LABELS) as (keyof typeof START_LABELS)[]).map(k =>
              `<option value="${k}" ${(cfg.playerStart ?? 'ball') === k ? 'selected' : ''}>${START_LABELS[k]}</option>`).join('')}
          </select>
          <label title="A static Stargate beacon under the friendly ball">Stargate</label><input type="checkbox" id="s-gate" ${cfg.gate ? 'checked' : ''}>
          <label title="Same seed = same drill, for repeatable practice">Seed</label><span class="disc-row"><input type="number" id="s-seed" min="1" max="99999" value="${cfg.seed}"><div class="sbtn" id="s-newseed" title="Roll a new seed">New</div></span>
          <div class="ctl-title span2">Saved scenarios</div>
          <label title="Named slots kept in this browser">Slot</label><select id="s-slots"></select>
          <div class="btn-row span2">
            <div class="sbtn" id="s-save" title="Save the current fields under a name">Save as…</div>
            <div class="sbtn" id="s-load" title="Load the selected slot and restart">Load</div>
            <div class="sbtn" id="s-delete" title="Delete the selected slot">Delete</div>
          </div>
          <div class="btn-row span2">
            <div class="sbtn" id="s-export" title="Copy the current scenario as JSON to the clipboard">Copy JSON</div>
            <div class="sbtn" id="s-import" title="Paste a scenario JSON to load it">Paste JSON</div>
          </div>
        </div>
        <div class="btn-row"><div class="sbtn sbtn-primary" id="s-apply">Apply &amp; restart</div></div>
        </div>
      </div>`;
    this.ro = {
      vel: this.q('#ro-vel') as HTMLElement, sig: this.q('#ro-sig') as HTMLElement,
      mass: this.q('#ro-mass') as HTMLElement, tau: this.q('#ro-tau') as HTMLElement,
      time: this.q('#ro-time') as HTMLElement,
    };
    // Collapsible groups (state persisted per group).
    for (const t of this.root.querySelectorAll('#readouts .fold')) {
      const key = (t as HTMLElement).dataset.fold!;
      const body = this.q(`[data-fold-body="${key}"]`) as HTMLElement;
      const apply = (folded: boolean): void => {
        t.classList.toggle('folded', folded);
        body.classList.toggle('hidden', folded);
      };
      apply(loadPref(`efs.fold.${key}`, 0) !== 0);
      t.addEventListener('click', () => {
        const folded = !t.classList.contains('folded');
        apply(folded);
        savePref(`efs.fold.${key}`, folded);
      });
    }
    // The scenario window floats free of the ship panel (which scrolls and
    // blurs its backdrop — both would trap a fixed-position child).
    const scen = this.q('#c-scenario') as HTMLElement;
    this.root.appendChild(scen);
    makeDraggable(scen, scen.querySelector('.win-title') as HTMLElement, 'efs.scenarioPos');
    (this.q('#c-keys') as HTMLElement).addEventListener('click', () => this.toggleKeys());
    (this.q('#c-links') as HTMLInputElement)
      .addEventListener('change', e => this.cb.setLinks((e.target as HTMLInputElement).checked));
    (this.q('#c-overlay') as HTMLInputElement)
      .addEventListener('change', e => {
        const on = (e.target as HTMLInputElement).checked;
        (this.q('#g-overlay') as HTMLElement).classList.toggle('active', on);
        this.cb.setOverlay(on);
      });
    (this.q('#g-overlay') as HTMLElement).classList.add('active');
    const wireSlider = (sel: string, key: string, apply: (f: number) => void, def = 1): void => {
      const el = this.q(sel) as HTMLInputElement;
      const saved = loadPref(key, def);
      el.value = String(saved);
      apply(saved);
      el.addEventListener('input', () => { const f = parseFloat(el.value); apply(f); savePref(key, f); });
    };
    wireSlider('#c-zoom', 'efs.zoomSpeed', f => this.cb.setZoomSpeed(f));
    wireSlider('#c-cam', 'efs.camSpeed', f => this.cb.setCamSpeed(f));
    const inertiaEl = this.q('#c-inertia') as HTMLInputElement;
    const savedInertia = loadPref('efs.camInertia', 0.4);
    inertiaEl.value = String(savedInertia);
    this.cb.setInertia(savedInertia);
    inertiaEl.addEventListener('input', () => {
      const f = parseFloat(inertiaEl.value);
      this.cb.setInertia(f);
      savePref('efs.camInertia', f);
    });
    const wireCheck = (sel: string, key: string, apply: (on: boolean) => void, def = true): void => {
      const el = this.q(sel) as HTMLInputElement;
      const saved = loadPref(key, def ? 1 : 0) !== 0;
      el.checked = saved;
      apply(saved);
      el.addEventListener('change', () => { apply(el.checked); savePref(key, el.checked); });
    };
    wireSlider('#c-offset', 'efs.camOffset', f => this.cb.setCamOffset(f), 0);
    wireCheck('#c-dyncam', 'efs.camDynamic', on => this.cb.setCamDynamic(on), false);
    wireCheck('#c-lock', 'efs.camLock', on => this.cb.setCamLock(on), true);
    wireCheck('#c-kra', 'efs.kraEve', on => this.cb.setKraEve(on), false);
    wireCheck('#c-aids', 'efs.aids', on => this.cb.setAids(on));
    wireCheck('#c-coll', 'efs.collisions', on => this.cb.setCollisions(on));
    // Prop presets: picking one writes the class-appropriate speed into the
    // m/s field (the number stays the source of truth).
    for (const [sel, target] of [['#s-hprop', '#s-hs'], ['#s-fprop', '#s-fs']] as const) {
      (this.q(sel) as HTMLSelectElement).addEventListener('change', e => {
        const v = (e.target as HTMLSelectElement).value;
        if (v) (this.q(target) as HTMLInputElement).value = v;
      });
    }
    // Difficulty ladder: apply the level's scenario + aids setting, restart.
    for (const btn of this.root.querySelectorAll('.lvl-btn')) {
      btn.addEventListener('click', () => {
        const lvl = LEVELS[parseInt((btn as HTMLElement).dataset.lvl!, 10)];
        const next: ScenarioConfig = { ...this.scenarioCfg, ...lvl.cfg, name: lvl.title };
        this.fillForm(next);
        (this.q('#s-preset') as HTMLSelectElement).value = '';
        const aidsEl = this.q('#c-aids') as HTMLInputElement;
        aidsEl.checked = lvl.aids;
        this.cb.setAids(lvl.aids);
        savePref('efs.aids', lvl.aids);
        this.markLevel(parseInt((btn as HTMLElement).dataset.lvl!, 10));
        this.restart(next, lvl.brief);
      });
    }
    // Any edit in the scenario window makes it a custom scenario.
    (this.q('#c-scenario .cfg-grid') as HTMLElement).addEventListener('input', e => {
      const id = (e.target as HTMLElement).id;
      if (id === 's-preset' || id === 's-slots') return;
      (this.q('#s-preset') as HTMLSelectElement).value = '';
    });
    (this.q('#s-newseed') as HTMLElement).addEventListener('click', () => {
      (this.q('#s-seed') as HTMLInputElement).value = String(1 + Math.floor(Math.random() * 99_999));
    });
    // Every field reflects the loaded config (the markup only seeds some).
    this.fillForm(cfg);
    // Saved slots + JSON transfer.
    this.refreshSlots();
    (this.q('#s-save') as HTMLElement).addEventListener('click', () => {
      const cfg = this.readForm();
      const name = window.prompt('Save scenario as', cfg.name && !cfg.name.startsWith('Level') ? cfg.name : '');
      if (!name) return;
      const slots = loadSlots();
      slots[name] = { ...cfg, name };
      saveSlots(slots);
      this.refreshSlots(name);
    });
    (this.q('#s-load') as HTMLElement).addEventListener('click', () => {
      const name = (this.q('#s-slots') as HTMLSelectElement).value;
      const cfg = loadSlots()[name];
      if (!cfg) return;
      const next = { ...DEFAULT_SCENARIO, ...cfg, name };
      this.fillForm(next);
      (this.q('#s-preset') as HTMLSelectElement).value = '';
      this.markLevel(-1);
      this.restart(next, '');
    });
    (this.q('#s-delete') as HTMLElement).addEventListener('click', () => {
      const sel = this.q('#s-slots') as HTMLSelectElement;
      if (!sel.value || !window.confirm(`Delete saved scenario "${sel.value}"?`)) return;
      const slots = loadSlots();
      delete slots[sel.value];
      saveSlots(slots);
      this.refreshSlots();
    });
    (this.q('#s-export') as HTMLElement).addEventListener('click', () => {
      const json = JSON.stringify(this.readForm(), null, 2);
      navigator.clipboard?.writeText(json).catch(() => window.prompt('Scenario JSON', json));
      const b = this.q('#s-export') as HTMLElement;
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy JSON'; }, 1200);
    });
    (this.q('#s-import') as HTMLElement).addEventListener('click', () => {
      const raw = window.prompt('Paste scenario JSON');
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Partial<ScenarioConfig>;
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        const next: ScenarioConfig = { ...DEFAULT_SCENARIO, ...parsed };
        this.fillForm(next);
        (this.q('#s-preset') as HTMLSelectElement).value = '';
        this.markLevel(-1);
        this.restart(next, '');
      } catch (err) {
        window.alert(`Could not read that scenario: ${(err as Error).message}`);
      }
    });
    (this.q('#c-scenario-toggle') as HTMLElement)
      .addEventListener('click', () =>
        (this.q('#c-scenario') as HTMLElement).classList.toggle('hidden'));
    (this.q('#s-close') as HTMLElement)
      .addEventListener('click', () =>
        (this.q('#c-scenario') as HTMLElement).classList.add('hidden'));
    (this.q('#s-preset') as HTMLSelectElement).addEventListener('change', e => {
      const key = (e.target as HTMLSelectElement).value;
      if (!key || !PRESETS[key]) return;
      const p = PRESETS[key];
      const next: ScenarioConfig = { ...this.scenarioCfg, ...p.cfg, name: p.label };
      this.fillForm(next);
      (this.q('#s-preset') as HTMLSelectElement).value = key;
      this.markLevel(-1);
      this.restart(next, p.brief);
    });
    (this.q('#s-apply') as HTMLElement).addEventListener('click', () => {
      const next = this.readForm();
      // Untouched preset/level keeps its name; anything edited is custom.
      const presetKey = (this.q('#s-preset') as HTMLSelectElement).value;
      if (!presetKey && !this.root.querySelector('.lvl-btn.active')) next.name = undefined;
      const brief = presetKey ? PRESETS[presetKey].brief : this.lastBrief;
      this.restart(next, presetKey || next.name ? brief : '');
    });
  }

  /** Write a config into every field of the scenario window. */
  private fillForm(c: ScenarioConfig): void {
    const set = (id: string, v: string | number | undefined): void => {
      const el = this.q(id) as HTMLInputElement | HTMLSelectElement | null;
      if (el && v !== undefined) el.value = String(v);
    };
    const chk = (id: string, on: boolean | undefined): void => {
      const el = this.q(id) as HTMLInputElement | null;
      if (el) el.checked = on === true;
    };
    set('#s-fn', c.friendlyCount); set('#s-fs', c.friendlySpeed); set('#s-fhull', c.friendlyHull ?? 'Machariel');
    set('#s-fpat', c.friendlyPattern ?? 'orbit'); set('#s-disc', c.fleetSloppiness ?? 0.5);
    chk('#s-logisep', c.logiSeparate);
    set('#s-hn', c.hostileCount); set('#s-dist', c.fightingDistanceKm); set('#s-hs', c.hostileSpeed);
    set('#s-hpat', c.hostilePattern ?? 'orbit'); set('#s-warp', c.warpPeriodS);
    chk('#s-logitgt', c.hostilesTargetLogi);
    const skill = c.fcSkill ?? 0;
    set('#s-fc', skill < 0.25 ? '0' : skill < 0.75 ? '0.5' : '1');
    chk('#s-pers', c.hostilePersonalities); chk('#s-alpha', c.alphaSync); chk('#s-wings', c.wingSplits);
    set('#s-ef1prop', c.extraFleets?.[0]?.prop ?? ''); set('#s-ef2prop', c.extraFleets?.[1]?.prop ?? '');
    set('#s-missile', c.missile); chk('#s-rigs', c.guidanceRigs !== false);
    set('#s-vp', c.volleyPeriodS); set('#s-lps', c.launchersPerShip);
    set('#s-start', c.playerStart ?? 'ball'); chk('#s-gate', c.gate);
    set('#s-seed', c.seed);
  }

  /** Read every field of the scenario window into a config (extra fleets and
   *  the hull traits come from the current config — they have no fields). */
  private readForm(): ScenarioConfig {
    const num = (id: string): number => parseFloat((this.q(id) as HTMLInputElement).value);
    const sel = (id: string): string => (this.q(id) as HTMLSelectElement).value;
    const on = (id: string): boolean => (this.q(id) as HTMLInputElement).checked;
    const next: ScenarioConfig = {
      ...this.scenarioCfg,
      hostileCount: num('#s-hn'), friendlyCount: num('#s-fn'), friendlyHull: sel('#s-fhull'),
      fightingDistanceKm: Math.min(255, Math.max(10, num('#s-dist'))),
      missile: sel('#s-missile') as MissileKey,
      hostileSpeed: num('#s-hs'), friendlySpeed: num('#s-fs'),
      volleyPeriodS: num('#s-vp'), launchersPerShip: num('#s-lps'),
      warpPeriodS: num('#s-warp'), seed: num('#s-seed'),
      guidanceRigs: on('#s-rigs'),
      hostilePattern: sel('#s-hpat') as ScenarioConfig['hostilePattern'],
      friendlyPattern: sel('#s-fpat') as ScenarioConfig['friendlyPattern'],
      logiSeparate: on('#s-logisep'), hostilesTargetLogi: on('#s-logitgt'),
      fleetSloppiness: num('#s-disc'), fcSkill: num('#s-fc'),
      hostilePersonalities: on('#s-pers'), alphaSync: on('#s-alpha'), wingSplits: on('#s-wings'),
      playerStart: sel('#s-start') as ScenarioConfig['playerStart'], gate: on('#s-gate'),
    };
    // Per-extra-fleet prop overrides (extras themselves come from presets).
    const efProp = (id: string): PropChoice | undefined => {
      const v = sel(id);
      return v === '' ? undefined : v as PropChoice;
    };
    next.extraFleets = (next.extraFleets ?? []).map((ef, i) => ({
      ...ef, prop: efProp(i === 0 ? '#s-ef1prop' : '#s-ef2prop'),
    }));
    return next;
  }

  private refreshSlots(select?: string): void {
    const el = this.q('#s-slots') as HTMLSelectElement;
    const names = Object.keys(loadSlots()).sort();
    el.innerHTML = names.length
      ? names.map(n => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('')
      : '<option value="">— none saved —</option>';
    if (select) el.value = select;
  }

  /** Highlight the active difficulty level (−1 = custom scenario); persisted. */
  private markLevel(i: number): void {
    for (const b of this.root.querySelectorAll('.lvl-btn'))
      b.classList.toggle('active', (b as HTMLElement).dataset.lvl === String(i));
    savePref('efs.level', i);
  }

  update(sim: Sim, tFrac: number, view: RenderView): void {
    const ship = sim.ship;
    const vMax = ship.maxSpeed();
    const sp = view.speed;
    const distTo = (id: string): number => {
      const t = sim.lookup(id);
      return t ? dist(view.shipPos, t.pos) : NaN;
    };
    // Bottom speed bar: fill fraction of max speed; amber throttle marker on
    // the same arc (0 at lower-left → 1 at lower-right).
    this.gaugeFill.setAttribute('stroke-dasharray', `${Math.min(1, sp / vMax) * 100} 100`);
    const ta = (135 - ship.throttle * 90) * Math.PI / 180;
    this.throttleMark.setAttribute('x1', `${84 + Math.cos(ta) * 59}`);
    this.throttleMark.setAttribute('y1', `${84 + Math.sin(ta) * 59}`);
    this.throttleMark.setAttribute('x2', `${84 + Math.cos(ta) * 74}`);
    this.throttleMark.setAttribute('y2', `${84 + Math.sin(ta) * 74}`);
    this.speedVal.textContent = fmtSpeed(sp);
    this.speedMax.textContent = `of ${fmtSpeed(ship.throttle * vMax)}`;

    const t = sim.time + tFrac;
    for (const key of ['ab', 'mwd'] as PropKey[]) {
      const mod = ship.module(key);
      const slot = this.modSlots.get(key)!;
      slot.classList.toggle('active', mod.active);
      slot.classList.toggle('pending', mod.active && mod.pendingDeactivate);
      (slot.querySelector('.heat-pip') as HTMLElement).classList.toggle('on', mod.overheat);
      (slot.querySelector('.mod-btn') as HTMLElement).style.setProperty('--prog', `${mod.cycleProgress(t)}`);
    }
    if (sim.combat) {
      sim.combat.bombs.forEach((b, i) => {
        const slot = this.bombSlots[i];
        slot.classList.toggle('active', b.active);
        slot.classList.toggle('pending', b.active && b.pendingOff);
        (slot.querySelector('.mod-btn') as HTMLElement).style.setProperty('--prog', `${b.cycleProgress(t)}`);
      });
    }
    const mj = sim.mjdStatus(t);
    this.mjdSlot.classList.toggle('active', mj.state === 'spooling');
    this.mjdSlot.classList.toggle('cooldown', mj.state === 'cooldown');
    (this.mjdSlot.querySelector('.mod-btn') as HTMLElement).style.setProperty('--prog', `${mj.prog}`);

    const st = sim.status();
    const stHtml = st ? `<div class="title">${st.title}</div><div class="sub">${st.sub}</div>` : '';
    if (stHtml !== this.lastStatusHtml) { this.lastStatusHtml = stHtml; this.statusEl.innerHTML = stHtml; }

    while (this.toastCount < sim.notifications.length) {
      const n = sim.notifications[this.toastCount++];
      const toast = this.el('div', 'toast', this.toastsEl,
        `<span class="bc-time">${fmtClock(n.at)}</span><span class="bc-dim"> - </span>${n.text}`);
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 700); }, 3200);
    }

    // Combat-log ticker (EVE format), newest at the bottom.
    if (sim.combat) {
      const events = sim.combat.ticker;
      const backlog = events.length - this.tickerCount;
      if (backlog > 40) this.tickerCount = events.length - 40; // don't flood the DOM
      while (this.tickerCount < events.length) {
        const ev = events[this.tickerCount++];
        const line = this.el('div', `tline ${ev.kind}`, this.tickerEl, combatLineHtml(ev.text));
        setTimeout(() => { line.style.opacity = '0'; setTimeout(() => line.remove(), 700); }, 3800);
        while (this.tickerEl.children.length > 9) this.tickerEl.firstElementChild!.remove();
      }
      if (events.length > 200) { events.splice(0, events.length - 50); this.tickerCount = Math.min(this.tickerCount, events.length); }

      // Local count: flash red on a spike (fleet inbound), dim on a drop.
      const lc = sim.combat.localCount();
      if (lc !== this.lastLocalCount) {
        (this.localEl.querySelector('.l-count') as HTMLElement).textContent = `[${lc}]`;
        if (this.lastLocalCount >= 0) {
          this.localEl.classList.remove('spike', 'drop');
          void this.localEl.offsetWidth; // restart the flash animation
          this.localEl.classList.add(lc > this.lastLocalCount ? 'spike' : 'drop');
        }
        this.lastLocalCount = lc;
      }

      // Live coverage per lane: expected catchable tick-samples = chord of the
      // lane inside the bubble / per-tick missile travel (phase-averaged).
      const rig = sim.combat.cfg.guidanceRigs !== false ? GUIDANCE_RIG_MULT : 1;
      const covRows = sim.combat.hostiles
        .filter(f => f.visible() && f.p.missile !== null)
        .map(f => {
          const tgt = sim.combat!.friendly.members[f.calledTargetIdx];
          const chord = segmentSphereChord(f.blob.center, tgt.pos, view.shipPos, Smartbomb.rangeM);
          const cov = chord / (MISSILE_INFO[f.p.missile!].speed * f.p.mult * rig);
          const cls = cov >= 1.5 ? 'val-good' : cov >= 0.7 ? 'val-mid' : 'val-bad';
          return `<div class="r-row"><span>Coverage — ${f.p.shipType}</span><span class="${cls}">${cov.toFixed(1)} ticks</span></div>`;
        }).join('');

      const s = sim.combat.score;
      const cum = s.killed + s.leaked === 0 ? null : (s.killed / (s.killed + s.leaked)) * 100;
      const roll = sim.combat.rollingIntercept(sim.time);
      const scoreHtml = `
        <div class="sc-big ${cum === null ? '' : cum >= 75 ? 'good' : cum >= 40 ? 'mid' : 'bad'}">
          ${cum === null ? '—' : cum.toFixed(1) + '%'}</div>
        <div class="sc-sub">intercepted (cumulative)</div>
        <div class="r-row"><span>Rolling 60 s</span><span>${roll === null ? '—' : roll.toFixed(1) + '%'}</span></div>
        <div class="r-row"><span>Killed</span><span>${s.killed.toLocaleString('en-US')}</span></div>
        <div class="r-row"><span>Leaked</span><span>${s.leaked.toLocaleString('en-US')}</span></div>
        <div class="r-row"><span>In flight</span><span>${sim.combat.aliveMissiles().toLocaleString('en-US')}</span></div>
        ${covRows}
        ${(() => {
          const rx = s.reactions;
          const oldestPending = sim.combat!.oldestPendingReaction();
          if (rx.length === 0 && oldestPending === null) return '';
          const pending = oldestPending !== null
            ? `<div class="r-row"><span>New lane!</span><span class="pending">${sim.time - oldestPending} s…</span></div>` : '';
          const last = rx.length ? `<div class="r-row"><span>Reaction (last)</span><span>${rx[rx.length - 1]} s</span></div>` : '';
          const avg = rx.length ? `<div class="r-row"><span>Reaction (avg)</span><span>${(rx.reduce((a, b) => a + b, 0) / rx.length).toFixed(1)} s</span></div>` : '';
          return pending + last + avg;
        })()}`;
      // Only touch the DOM when a value changed (this runs every frame).
      if (scoreHtml !== this.lastScoreHtml) { this.lastScoreHtml = scoreHtml; this.scoreEl.innerHTML = scoreHtml; }
    }

    // Overview refresh at 1 Hz (EVE-like) with distance sort.
    if (sim.time !== this.lastOverviewAt) {
      this.lastOverviewAt = sim.time;
      const withDist = this.ovRows.map(r => ({ r, d: distTo(r.id) }));
      withDist.sort((a, b) => a.d - b.d);
      for (const { r, d } of withDist) {
        let side = null;
        let offGrid = false;
        if (sim.combat) {
          if (r.id[0] === 'f') side = sim.combat.friendly;
          else if (r.id[0] === 'h') {
            const f = sim.combat.hostiles[parseInt(r.id.slice(1), 10)];
            side = f?.blob ?? null;
            offGrid = !!f && !f.visible();
          }
        }
        const tabHidden = (this.ovTab === 'hostile' && !r.hostile) || (this.ovTab === 'fleet' && r.hostile);
        r.el.style.display = offGrid || tabHidden ? 'none' : '';
        r.d.textContent = fmtDist(d);
        r.v.textContent = side ? fmtNum(Math.hypot(side.vel.x, side.vel.y, side.vel.z)) : '-';
        this.overviewBody.appendChild(r.el); // reorder
        r.el.classList.toggle('selected', this.selectedId === r.id);
      }
    }

    if (this.selectedId) {
      const info = sim.lookup(this.selectedId);
      if (info) {
        this.selectedPanel.classList.remove('hidden');
        if (this.selectedPanel.dataset.for !== this.selectedId) {
          this.selectedPanel.dataset.for = this.selectedId;
          // EVE selected-item verbs as monochrome icon buttons (Photon UI).
          this.selectedPanel.innerHTML = `
            <div class="win-title"><span>Selected Item</span>${WIN_TOOLS}</div>
            <div class="sname">${info.name}</div>
            <div class="sdist">Distance: <span>—</span></div>
            <div class="sbtns">
              <div class="ibtn" data-c="approach" title="Approach [Q]">
                <svg viewBox="0 0 20 20"><path d="M3 17 L14 6 M14 6 l-4.2 0.8 M14 6 l-0.8 4.2"/><circle cx="16.5" cy="3.5" r="1.6"/></svg></div>
              <div class="ibtn" data-c="alignTo" title="Align To [A] — full speed at it, never stops">
                <svg viewBox="0 0 20 20"><path d="M2.5 14 L16 6 M16 6 l-4.2 -0.4 M16 6 l-2 3.7"/><path d="M2.5 17 h6"/></svg></div>
              <div class="ibtn" data-c="orbit" title="${verbTitle('orbit')}">
                <svg viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="7" ry="4.5"/><circle cx="10" cy="10" r="1.4" class="fill"/><path d="M17 10 l-1.4 -1.8 M17 10 l-2.2 -0.4"/></svg></div>
              <div class="ibtn" data-c="keepAtRange" title="${verbTitle('keepAtRange')}">
                <svg viewBox="0 0 20 20"><path d="M8 10 H2.5 m2.2 -2.2 L2.5 10 l2.2 2.2 M12 10 h5.5 m-2.2 -2.2 L17.5 10 l-2.2 2.2"/><circle cx="10" cy="10" r="1.2" class="fill"/></svg></div>
              <div class="ibtn" data-c="look" title="Look At [C]">
                <svg viewBox="0 0 20 20"><path d="M2 10 C5 5.5 15 5.5 18 10 C15 14.5 5 14.5 2 10 Z"/><circle cx="10" cy="10" r="2.2"/></svg></div>
            </div>`;
          for (const btn of this.selectedPanel.querySelectorAll('.ibtn')) {
            btn.addEventListener('click', () => {
              const c = (btn as HTMLElement).dataset.c!;
              if (c === 'look') this.cb.lookAt(this.selectedId!);
              else this.cb.command(c as 'approach' | 'alignTo' | 'orbit' | 'keepAtRange', this.selectedId!);
            });
            const verb = (btn as HTMLElement).dataset.c;
            if (verb === 'orbit' || verb === 'keepAtRange') {
              btn.addEventListener('contextmenu', e => {
                e.preventDefault();
                showRangeMenu(btn as HTMLElement, verb, e as MouseEvent);
              });
            }
          }
        }
        (this.selectedPanel.querySelector('.sdist span') as HTMLElement).textContent =
          fmtDist(distTo(this.selectedId));
      }
    } else {
      this.selectedPanel.classList.add('hidden');
      delete this.selectedPanel.dataset.for;
    }

    if (this.ro) {
      const put = (el: HTMLElement, s: string): void => { if (el.textContent !== s) el.textContent = s; };
      put(this.ro.vel, `${sp.toFixed(1)} / ${vMax.toFixed(1)} m/s`);
      put(this.ro.sig, `${fmtNum(ship.sig())} m`);
      put(this.ro.mass, `${fmtNum(ship.mass())} kg`);
      put(this.ro.tau, `${ship.currentTau().toFixed(2)} s`);
      put(this.ro.time, fmtClock(sim.time));
    }
  }
}

/** Photon-style window drag by its title bar; clamped to the viewport and
 *  (optionally) remembered across sessions. */
function makeDraggable(win: HTMLElement, handle: HTMLElement, prefKey?: string): void {
  const clamp = (x: number, y: number): { x: number; y: number } => ({
    x: Math.max(0, Math.min(window.innerWidth - 60, x)),
    y: Math.max(0, Math.min(window.innerHeight - 30, y)),
  });
  const apply = (x: number, y: number): void => {
    const p = clamp(x, y);
    win.style.left = `${p.x}px`;
    win.style.top = `${p.y}px`;
    win.style.right = 'auto';
    win.style.transform = 'none';
  };
  if (prefKey) {
    try {
      const raw = localStorage.getItem(prefKey);
      if (raw) { const [x, y] = JSON.parse(raw) as [number, number]; apply(x, y); }
    } catch { /* ignore */ }
  }
  handle.style.cursor = 'move';
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.win-close, .win-tool')) return;
    const r = win.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev: PointerEvent): void => apply(ev.clientX - ox, ev.clientY - oy);
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (prefKey) {
        try { localStorage.setItem(prefKey, JSON.stringify([win.offsetLeft, win.offsetTop])); } catch { /* ignore */ }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });
}
