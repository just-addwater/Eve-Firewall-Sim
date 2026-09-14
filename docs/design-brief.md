# EVE Firewall Simulator — Design Brief (v4)

*Planning document, updated 2026-08-28. No code yet by design.*

## Vision

A browser-based practice simulator for **firewalling**: flying a smartbomb Nestor between a friendly fleet and hostile missile fleets, destroying missile volleys in flight. The skill being trained is **positioning — constant readjustment** as up to three hostile fleets move around, warp off, and land somewhere else. Mechanics and UI as close to EVE Online as public data and calibration allow. No sound. Hosted on GitHub Pages (fully static, client-side).

This is a positioning trainer, period. Everything that isn't positioning (cap, health, missile hitpoints, manual pulse timing, warping, target locking) is deliberately out.

## Locked decisions

| Decision | Choice |
|---|---|
| Player ship | Nestor, the user's actual fit ("[BBC] General Nestor v4.4"): **7× Dark Blood Large EMP Smartbomb (7.5 km)**, 2× Imperial Navy 1600mm Steel Plates, 3× Large Trimark Armor Pump II (**velocity drawback simulated**), Gist X-Type 500MN MWD + Gist X-Type 100MN AB (**both fitted → both mass penalties always on**), Large MJD (see below). EWAR/cap/drones in the fit are ignored. All-V pilot assumed (Energy Pulse Weapons V → 7.5 s bomb cycles) |
| Player systems | Movement only. No cap, no HP, no locking, no warping |
| MJD | **Later milestone** — HUD slot and data designed in, not functional in v1. When added: 12 s spool, facing sets the 100 km jump direction, long cooldown |
| Bumping | **Approximate sphere-based collision, as an option, default ON** — skimming the friendly ball at speed costs you, as on Tranquility. Toggleable off. Marked `approximated` (CCP's solver is proprietary) |
| Overheat | **Prop overheat only**: timed burst boost on AB/MWD for lane changes. No heat damage or burnout in v1. Smartbombs never overheated |
| Smartbombs | Turn on → **auto-cycle**; each of the 7 modules cycles independently from its own activation time |
| Missiles | **Binary kill** — no missile HP in v1 |
| Arena | Open space, single grid, low-sec flavor. Nobody warps except hostile fleet relocations |
| Friendly fleet | 50–200 ships **anchored tightly (~1 km) on one anchor ship**; anchor moves; the fleet is effectively a moving ball |
| Hostile fleets | **1–3 fleets** (option), each cruise/torp BS or HAM doctrine; can warp off and re-land elsewhere on grid |
| Session format | **Endless drill** — run until you quit; rolling + cumulative stats |
| Configurable per scenario | Per-fleet propulsion/speed (none / AB / MWD, with speed values) for friendlies and each hostile fleet; **rough fighting distance: 10–255 km**; hostile fleet count 1–3; doctrine per fleet; warp-relocation frequency; **fleet boosts (skirmish links) toggle, default on** |
| Hostile doctrine presets | From the user's actual low-sec opposition: **Typhoon** (heavy missiles — confirmed live doctrine in reference footage at both ~36 km and ~112–134 km; also cruise/torp), **Raven** (cruise/torp), **Barghest** (cruise/torp with hull missile-velocity bonus — the fastest lanes), **Cerberus** (heavy missiles / HAM). **Muninn** (artillery — no missiles) as an optional *distractor fleet*: its damage cannot be firewalled, so the skill it trains is recognizing which lane NOT to cover |
| Protected asset | Normally the friendly fleet ball; **optional structure-defense variant** (e.g., an Astrahus, as in the reference footage) — a static endpoint, the natural easiest difficulty tier |
| Rendering | Full 3D, EVE-style orbit camera, brackets + tactical overlay rings |
| Camera | Orbit cam around own ship + tactical overlay as the default flying view, **plus first-class look-at workflow**: smooth look-at transitions between own ship / friendly ball / hostile fleets, per-target zoom memory, quick return-to-ship. (User flies with frequent look-at and zoom swings) |
| Feedback | Live score HUD + training aids that fade with difficulty |
| Not planned | AI wingmen, replay viewer, sound, friendly warps/player warps |

## The intercept model — why positioning is the whole game

This section is the heart of the design. Everything rests on EVE's 1 Hz physics:

- A missile exists at **discrete 1-second sample points** along its lane. A cruise missile at ~5–9 km/s (skill/hull dependent) has sample points 5–9 km apart. Torps/HAMs are slower and sample more densely.
- A smartbomb pulse (on activation, then each auto-cycle) kills every missile whose current sample point is within 7.5 km.
- A missile **impacts mid-tick** when it reaches its target: its final sample point can be up to one full tick of travel (5–9 km) short of the target. After that point it detonates on arrival — no further pulse can catch it.

Three consequences, which together are exactly the skill being trained:

1. **Sitting inside your own fleet ball fails against fast missiles.** A cruise missile's last sample point is up to ~9 km short of the ball — *outside* a bubble centered on the ball. You must be upstream on the lane, where the missile's earlier sample points fall inside your bubble. (This matches real doctrine: firewallers hold between the fleets, not on top of their own.)
2. **Being centered on the lane maximizes catches.** Your bubble is a 15 km-wide window on the lane; off-axis, the chord a missile crosses shrinks and fast missiles can tick straight over it. On-axis and upstream, each missile presents 1–3 catchable sample points.
3. **Staggering makes coverage continuous.** Seven auto-cycling bombs started ~1 s apart pulse about once per second — every missile sample point inside the bubble gets caught. Started simultaneously, they pulse in unison with ~9 s gaps that whole volleys slip through. Staggering initial activation is the one bit of module skill retained, and the sim teaches it for free.

So the drill reduces honestly to: **hold the moving line segment between each hostile fleet and your fleet ball, at the right depth, with a battleship that takes ten seconds to answer the helm.** With 2–3 hostile fleets there are 2–3 lanes and one bubble — prioritization is part of the skill.

*Calibration note:* exact server event ordering (pulse vs missile-impact within a tick) is proprietary; the sim's rule — pulses resolve against tick-boundary positions, impacts resolve mid-tick — is a documented, swappable policy to be sanity-checked against Tranquility experience.

## The core loop

1. Friendly ball (50–200 ships, ~1 km spread on the anchor) moves per its configured propulsion (none/AB/MWD speed).
2. Each hostile fleet maneuvers per its own config at the configured rough fighting distance (10–255 km), volleying on launcher cadence at ships in the ball. Every launcher spawns a real missile entity; streams converge on the ball.
3. Player reads lanes and burns to hold bubble-on-lane at the right depth; AB for fine keeping, MWD for lane changes; plated-Nestor inertia makes anticipation mandatory.
4. Hostile fleets periodically warp off and land elsewhere → lane vanishes, new lane opens; reaction timer runs until bubble covers the new lane.
5. Endless: stats accumulate; rolling window (e.g., last 5 min) shows current form.

### Hostile fleet state machine (per fleet)

`WARP_IN (land with spread, decelerate) → MANEUVER (hold configured range / kite / burn in) → ENGAGE (volleys at launcher cadence) → [ALIGN → WARP_OFF (cooldown) → WARP_IN elsewhere] …`

Config per fleet: doctrine (cruise BS / torp BS / HAM), ship count, propulsion + speed, hold range, warp-relocation frequency, volley cadence.

### Fighting-distance ranges and what they train

| Rough distance | Doctrine fit | Missile flight | Character |
|---|---|---|---|
| 10–30 km | HAM / torp brawl | ~3–6 ticks | Frantic; lanes short and fast-moving; expert mode |
| 40–100 km | Cruise BS | ~10–20 ticks | The classic readable firewall scenario |
| 100–255 km | Long-range cruise | 20+ ticks (config warns if volleys can't physically reach) | Slow lanes, heavy anticipation, huge repositioning distances |

## Scoring (live HUD, endless)

- **Intercept %** — killed / launched, cumulative and rolling.
- **Leaked volleys** — count, attributed per hostile fleet/lane (shows which lane you're failing).
- **Repositioning reaction time** — from lane change (warp-in or big maneuver) to bubble-on-lane; rolling average.
- Friendly-fire is *not* scored (tight ball + no HP simulation; pulses hitting friendlies are cosmetically shown, as in EVE, but cost nothing).

### Training aids (fade with difficulty)

- Lane lines: hostile fleet → friendly ball.
- Ideal-position ghost marker (right depth on the active lane, accounting for missile speed).
- 7.5 km bubble ring on the tactical overlay (likely always on — EVE shows module ranges anyway).
- Volley-launch and warp-in/out callouts.
- Stagger indicator (are your 7 cycles spread or clumped).

### Difficulty progression (draft — mostly emerges from config)

1. One hostile fleet, static ranges, slow speeds, aids on.
2. Moving anchor + moving hostiles.
3. Warp relocations.
4. Second hostile fleet, different axis.
5. Third fleet, mixed doctrines (cruise + HAM), higher speeds, aids off.

## UI scope (from the /ui screenshots)

Replicate: overview (tabs; distance/type/velocity/angular columns), in-space brackets (instanced sprites — hundreds of ships + missiles), selected-item panel, bottom-center HUD (speed gauge + throttle, AB/MWD + 7 smartbomb slots with cycle animations), tactical overlay rings, broadcast-style event line (volley/warp callouts), and the **combat log feed** in EVE's format — `360 to Heavy Missile - Hits` per pulse kill, leak lines when missiles reach the protected asset (seen in reference footage; doubles as the sim's authentic kill ticker, including double-hit lines when two bombs overlap the same missile). Skip: chat/local, drones, D-scan, route.

Missile volley rendering target (user-corrected): missiles have **no brackets** (they're not selectable or on the overview) — they render as **light streaks**: bright elongated trails along the flight path, a volley reading as a stream of streaks converging on the target. Implementation-wise: instanced streak billboards oriented along the interpolated velocity vector, bright head + fading tail. The plus-bracket clusters in the video stills are other entities (likely drone swarms), not missiles. Hostile ships as red-boxed brackets.

Controls, EVE-native: double-click in space, approach/orbit/keep-at-range, module F-keys, orbit/zoom camera, tactical overlay toggle. Scenario-config screen is sim-specific (not EVE UI): fleet count, doctrines, speeds/prop, fighting distance, warp frequency, aids.

### UI/camera backlog (user feedback after M1, 2026-08-28)

- "A lot of UI work still needed" — general fidelity pass reserved for M5; collect specifics from the user as they fly.
- ~~Camera not fully locked to player ship~~ **fixed**: focus now carries the subject's motion 1:1 per frame (zero steady-state lag); smoothing applies only to look-at transitions.
- ~~Zoom speed should be an option~~ **added**: settings slider (0.3×–3×), persisted in localStorage; zoom itself is now smoothed toward the wheel target.
- "Camera feels a bit off" — partially addressed by the two fixes above; revisit remaining feel (rotate sensitivity, pitch limits, zoom curve, inertia) in M5 with the user's specifics.
- User's Nestor STL model integrated (nose orientation confirmed correct by user).
- ~~1 Hz tick visible as jerky animation~~ **fixed**: all visible quantities (speed, gauge, distances, model heading) now derive from interpolated render state; authoritative sim untouched.
- **EVE velocity-vector arrow** (re)added per user: arrow from the ship along travel direction, length ∝ speed (~10 m per m/s), tactical-UI styling.
- **Double-click destination marker** added per user: small pulsing ring anchored at the clicked point in space, fades over ~2.5 s.
- **Tactical overlay orientation settled (user screenshots as ground truth):** world-fixed horizontal plane through the ship; does NOT re-orient with the camera (a camera-following version was tried and reverted). Ring distance labels along a world-fixed diagonal axis, one at each end.
- **Missile arrival** de-synchronized per user: per-ship launcher cycles → continuous stream, not fleet-synced walls.

## Reference data

Simulated: **Dark Blood Large EMP Smartbomb — 7.5 km radius, 7.5 s cycle (Energy Pulse Weapons V), 375 EM damage per pulse** (fit shows volley 2,625 = 7 × 375; 350 DPS), pulse on activation then per cycle. Missile velocities/flight times per class from SDE at max-skill assumptions. Nestor + fit attributes from SDE. Pilot confirmed **all-V**.

### M1 calibration targets (superseded by the data pass — see docs/data-pinned.md for full derivation)

| Stat | No links (derived, SDE + all-V) | With links (fitting window) |
|---|---|---|
| Max velocity, props off | **87.5 m/s** (70 × Navigation V — exact match to fitting window; **no trimark velocity penalty applies**) | 87.5 m/s |
| Align time | 9.46 s | **7.44 s** (link agility × 0.786) |
| Signature radius | 420 m | 352 m (link sig × 0.838; display only) |
| AB top speed | **444 m/s** (622 overheated) | TBD — needs an in-game HUD reading |
| MWD top speed | **1,210 m/s** (1,771 overheated) | TBD |
| MWD accel time constant | **~20 s** (76M kg active mass) | ~15.7 s |
| Large MJD spool (M4) | 9 s at skill V (12 s base — exact match) | — |

*(Correction: the "813 / 1,620 m/s" figures earlier read off the fitting screenshot were actually the prop mods' capacitor costs.)* The links toggle applies the solve-for factors above; matching this table is milestone 1's exit test.

### Reference media

- `/ui` screenshots (sov-fight POV): overall layout, tactical overlay, missile swarms in flight.
- 2026-08-28 screenshots (Machariel POV — fine for UI layout): overview General tab with Distance/Name/Type/Velocity columns, selected-item panel, drones panel, local/corp chat, HUD module rack, warp states, tactical overlay at high zoom.
- Firewalling footage reference: "Rules Of Smartbombs", https://www.youtube.com/watch?v=IDkm0epTm1I (local copy: `reference/Rules Of Smartbombs.mp4`, 4:17, 720p60). Full 51-frame analysis (1 frame / 5 s) done 2026-08-28. Findings below.

### Video frame-analysis findings (mechanics)

- **Smartbomb cycle rules, straight from the client's own tooltips:** a smartbomb *"cannot be manually deactivated in the middle of an operation; it will deactivate without repeating in N seconds (its activation duration is 7 seconds)"* — toggling off schedules deactivation at the end of the current cycle, with a live countdown; spam-clicking shows *"Large Plasma Smartbomb II is already active"*. Simulate both behaviors and message texts verbatim.
- **Kill ticker format confirmed at scale:** one line per bomb-hit per missile; multiple bombs pulsing the same tick stack visibly (`360` → `720` → `1440 to Cruise Missile - Hits` = 4 bombs catching one missile). Missile classes killed on screen: Light, Heavy, Advanced Heavy, Cruise, Advanced Cruise. Pulses also log hits on nearby players (`91 to Davo B…`) — matching our cosmetic-only friendly fire.
- **Red module-range ring** rendered around the player's ship on the tactical overlay while smartbombs are active — EVE itself shows the bubble ring, confirming our always-on ring is authentic, in red.
- **Smartbomb pulse VFX:** expanding ring torus around the ship (orange for plasma; EMP is the blue-white variant); staggered bombs produce concentric ripples in sequence. This is the rendering target.
- **Missiles in flight** appear as light streaks, most visible against dark sky or planet backdrops; reads as crisscrossing rays during heavy volleys.
- **Pilot movement style:** overwhelmingly `ALIGNING — aligning to a point in space` (align-to-point as the primary steering verb) plus MWD at 1.3–2.5 km/s; `KEEPING AT RANGE — 2,000 m` on a reference object while bombing; occasional **on-grid tactical warps** (e.g., "381 km to warp tunnel destination") — observed in real play but excluded from our sim per user decision (MJD later fills this role).
- **Engagement envelope across the video:** Typhoon fleets fought at ~35–40 km, ~60–90 km, and ~110–140 km; the final segment is a 4–9 km brawl weaving between hostile Typhoons at an Athanor. Validates the 10–255 km scenario slider end to end.
- Also observed: firewaller under fire (`Glances Off / Hits / Wrecks` incoming lines — cosmetic for us); structure leak lines (`41 to RBW-8G – Save Point`); hostile **bombs** (Focused Void Bomb, 2,008 m/s) appear on the overview unlike missiles — bombers remain out of scope.
- (Earlier correction stands: missiles have no brackets; the purple plus-bracket clusters are drones.)

### M5 UI/camera research findings (2026-08-28 — wiki + dense frame study + user's Photon screenshots in /ui)

- **Number formats (user's client, Photon UI):** comma thousands separators — "3,610 m" below 10 km, whole-km "12 km" above, velocity "1,436". (The 2017-era video's thin-space "2 374" is the old UI; the /ui screenshots override it.) Implemented in ui/format.ts.
- **Overview (Photon):** window title bar ("Overview (default — Not Saved)"), tab strip with underlined active tab + a "+" stub (user runs General | Mining | WarpTo), columns Icon | Distance ▲ | Name | Type | Velocity (no Alliance column in the user's setup), distance-sorted with ▲ in the header. Row states: steel-blue background = fleet member; solid rust/red rows = hostile standing ("red flashy" war targets in the old footage); selected row = thin light border. Icon column carries the standing colortag badge (red minus = terrible standing, violet star = fleet). Implemented: General/Hostile/Fleet filter tabs, icon+badge column, row backgrounds, 1 Hz distance sort.
- **Color-tag palette (EVE Uni Color_Tag_Images):** red star war target / red skull outlaw / red minus terrible / orange minus bad / light-blue plus good / dark-blue plus excellent / violet star fleet-militia / green star corp / blue star alliance. We use red-minus (hostiles) and violet-star (fleet).
- **Combat lines:** float IN SPACE at the event point and fade (~2.6 s), stacking upward when simultaneous; format `<teal number> to <white name> - <dim quality>`. Implemented as world-anchored floats + the top-center log feed keeps the same markup.
- **Tactical overlay (wiki + frames):** ring ladder 1/5/10/20/30/40/50/75/100/150/200(+) km, labels at BOTH ends of one world-fixed diagonal axis; red DOTTED ellipse = targeting range (not simulated); SOLID red circle = module activation range (our smartbomb ring — correct); white line to the selected object (arc if off-plane); blue trajectory line with a bolder velocity arrow. Implemented: new ladder (shared scene/brackets constant), white selected-object line, blue align-trajectory line.
- **Align point (user screenshot + note):** the ticked-square marker STAYS anchored in space while the align command runs, fading only when the command changes; a thin blue line runs from ship toward it. Implemented (replaces the old 2.5 s fading click marker).
- **Status verbs:** "KEEPING AT RANGE — 2 000 m" two-line form; warp shows three lines ("ESTABLISHING WARP VECTOR" / Destination / Distance). ALIGNING's subtitle is the target name, or "Aligning to a point in space" for a point (ours matches).
- **Manual piloting (wiki):** double-click-in-space = align (ours ✓); Q-dial radial menu and first-person arrow-key nudges exist in the client but are out of scope; approach/orbit/keep-at-range are commands, not manual piloting. Spiral/slingshot are player techniques, nothing to simulate.
- **Camera:** slow idle drift (fades in after ~5 s of quiet, ~0.4°/s), rotation inertia after drag release (EVE Camera Settings' Inertia), exponential wheel zoom (constant ratio per notch — already ours). Implemented drift + inertia + Sensitivity/Inertia/Zoom sliders (persisted) in a Camera settings section.
- **Hull missile traits VERIFIED** — see docs/data-pinned.md "Hull missile traits": Typhoon ×1.0 (no velocity bonus!), Raven ×1.5, Barghest ×3.0 with half flight time, Cerberus ×2.0 HAM, Muninn ×1.0 (missile boat since 2022 — user's meta confirmed). DOCTRINES updated; new **Guidance rigs ×1.3** scenario toggle (default on) keeps the upstream drill honest vs trait-only Typhoon heavies.

Preserved for possible later hard mode (not v1): missile HP (Light 60 / Rocket 90 / Heavy 120 / HAM 180 / Cruise 240 / Torp 360; Guristas +33%), 20% self-type resist. Sources: [EVE Uni Smartbombs](https://wiki.eveuniversity.org/Smartbombs), [EVE Uni Missile mechanics](https://wiki.eveuniversity.org/Missile_mechanics), [CCP Aegis post](https://forums-archive.eveonline.com/topic/430967).

## Tech direction (no code yet)

- Static TypeScript app, WebGL (three.js or similar), GitHub Pages, no backend.
- Deterministic fixed-step 1 Hz sim decoupled from 60 fps interpolated rendering; seeded RNG.
- Entity budget: ≤800 ships + ~500–1500 missiles in flight → instanced bracket sprites; fleet members are blob-followers (cheap), only fleets have real AI.
- Build-time SDE extract → small version-pinned JSON.

## Open calibration items

- SDE pull for the exact fit: Dark Blood Large EMP Smartbomb (range/cycle/damage), Gist X-Type 500MN MWD and 100MN AB (velocity bonus, mass addition, overheat bonus), Imperial Navy 1600mm plate mass, Trimark II velocity drawback (with Armor Rigging V), Nestor hull mass/inertia/base speed, Large MJD numbers (for the later milestone).
- Verify prop-mod mass addition applies while fitted-but-inactive (believed yes; affects dual-prop agility significantly).
- Pulse-vs-impact event ordering within a tick → swappable policy, calibrate against in-game experience.
- Smartbomb range semantics (center vs surface) → in-game test.
- Missile velocities at hostile max skills; whether hull bonuses (e.g., velocity-bonused hulls) should be in doctrine presets → decide with user.

## Milestones (build order)

1. **M1 — Movement + camera:** ✅ **DELIVERED 2026-08-28.** 1 Hz authoritative core with interpolated 60 fps rendering; the real fit's mass/velocity model; AB/MWD with cycle-end deactivation rule, single-prop restriction and overheat; orbit camera + look-at + tactical overlay (with red 7.5 km smartbomb ring); brackets, overview, selected-item verbs (approach/orbit/keep-at-range), double-click align; EVE-style HUD (gauge with throttle, module rack with cycle sweeps and heat pips). Verified: 19/19 headless tests + in-app calibration panel (11/11) assert every derived number — 87.5 / 443.7 / 1210.0 / 621.8 / 1771.3 m/s, align 9.46 s (7.44 s linked), MWD τ 19.95 s — and a live browser run matched the analytic MWD accel curve (483 m/s at t=8 vs 485 predicted). Bumping deferred to M2 (needs other ships). Notes: keep-at-range uses a burn/coast/damped-close controller (APPROXIMATED — EVE's real one may yo-yo more with MWD; compare against Tranquility feel during calibration). Sim stepping is timer-driven so background-tab rAF throttling cannot stall the clock. *Remaining exit test: the user says "yes, that's my Nestor."*
2. **M2 — One lane:** ✅ **DELIVERED 2026-08-28.** Friendly ball (50 ships, 1 km, moving anchor with course changes) + hostile Typhoon fleet holding the configured fighting distance; volleys of real missile entities on cadence at called targets; 7-bomb Dark Blood rack (pulse-on-activation, auto-cycle, cycle-end deactivation, F1–F7/1–7 keys, stagger matters); binary tick-sample intercepts with documented step-order policy; EVE combat-log kill ticker + leak lines; live score panel (cumulative + rolling 60 s intercept %, killed/leaked/in-flight); combat overview (sorted 1 Hz, hostile/friendly coloring); scenario config panel (counts, 10–255 km distance, missile type, speeds, volley cadence, seed) with persist + restart; WebGL ship sprites, missile streaks, EMP pulse rings. 29/29 tests incl. interception-geometry proofs. **Design note:** hull missile-velocity bonus (Typhoon ≈ ×1.5 at V) is load-bearing — it pushes per-tick missile travel (9,675 m/s) past the 7.5 km bubble so parking on the ball fails; without hull bonuses, plain all-V heavies (6,450) would make center-sitting degenerate. Verify exact hull traits next data pass. Deferred from M2 → M3: bumping option (default on), friendly-fire cosmetic lines.
3. **M3 — The drill:** ✅ **DELIVERED 2026-08-28.** Hostile warp state machine (engage → align out [still firing] → 8–12 s off-grid [hidden from space + overview, fire stopped, missiles in flight persist] → land at a new bearing 60–180° away at the fighting distance → 5 s re-lock → re-engage with re-staggered launcher cycles); fleet-broadcast-style callouts; reaction-time scoring (seconds from warp-in until the player's bubble covers the new hostile→called-target lane, live amber counter + last/avg in the score panel); training aids toggle (lane line + "firewall spot" ghost one missile-tick upstream of the called target); collisions/bumping option default ON (600 m sphere push-out vs fleet members, APPROXIMATED); camera rotate-speed option (user request); warp period in scenario config (0 = off). 32/32 tests.
4. **M4 — Multi-fleet + MJD:** ✅ **DELIVERED 2026-08-28.** Up to 3 hostile fleets via doctrine presets (Typhoon HML / Raven cruise / Barghest cruise / Cerberus HAM / Muninn HAM / **Eagle rail distractor** — user corrected: Muninns fly missiles in the current meta, so the un-firewallable turret distractor is the Eagle). Each fleet: own blob, warp state machine, launcher cycles, called target → own lane; per-fleet lane lines + firewall-spot ghosts (none for turret fleets); per-fleet overview typing/hiding; reaction timing on every missile-fleet warp-in (oldest pending shown). Scenario presets dropdown (Typhoon 50 km / Raven 90 km / two fleets / three + Eagle / HAM brawl). **Large MJD functional**: 9 s spool (skill V), 100 km jump along heading, 180 s reactivation, HUD slot with spool/cooldown rings, key J, EVE-style notifications. Doctrine velocity multipliers approximate hull bonuses — verify traits in a data pass. 34/34 tests.
5. **M5 — UI fidelity + deploy:** IN PROGRESS 2026-08-28. Done: wiki research (Tactical_overlay, Overview settings, Color_Tag_Images, Manual_piloting) + dense frame mining + the user's Photon screenshots → findings section above; Photon-style overview (title, filter tabs, icon/colortag column, row backgrounds, comma formats); persistent align marker + blue trajectory line; white selected-object line; overlay ring ladder corrected; broadcast-style timestamped callout toasts; selected-item icon verbs; camera idle drift + inertia + Sensitivity/Inertia sliders; hull-trait verification pass (DOCTRINES corrected, Guidance-rigs ×1.3 toggle, 35/35 tests). **Punch-list round 1 (user, same day): EVE in-space cursor (SVG data-URI, ticks + SE square per user screenshot); damage text back to log-feed ONLY (in-space floats removed by request); overview defaults to Hostile tab; cross-glyph ship brackets; module-button SVG icons (AB/MWD thruster, smartbomb pulse, MJD arc) + cosmetic capacitor arcs in the gauge; darker nebula skybox (5 patches, dimmer stars); darker missile streaks; per-ship velocity-vector lines (overlay-gated); fleet members keep station on their FC (eased follow, per-member interpolation) instead of welded-blob offsets; FC movement patterns — friendly anchor large-orbit (25 km ring) or serpentine, hostile orbit or radial-weave serpentine (config selects); scenario panel reorganized into Fleets/Missiles/Drill sections with None/AB/MWD prop presets that fill the m/s fields.** **Punch-list round 2 (user, same day): ship brackets corrected to small square boxes (crosses are drone iconography; hostile boxes carry the corner standing-chip), align marker is a small circle, HUD rack matched to the user's client screenshot — smartbombs (teal orb icons) top row, AB/MWD (gold thruster icons) + MJD (blue arc) second row, speed readout at the gauge bottom flanked by − / +, green active rings.** **Punch-list round 3 (user, same day): real module icons pulled from CCP's official Image Service by typeID into public/icons/ (SB 14188, MWD 19359, AB 18676, MJD 4383); rack rows tightened to the client look (no labels — tooltips instead, uniform 46 px buttons); stars dimmed; bracket size-under-zoom verified constant (already matched the client).** **Round 4: gauge rebuilt to the client's command-board anatomy — static tick arc with red end-segment, speed ONLY at the bottom (filling arc bar + number), click-the-bar throttle, − / + at the midline.** Remaining: further fly-testing, GitHub Pages deploy (needs git init — ask), guidance-rig factor sign-off.

### Suggested next steps (proposed 2026-08-28; user picked four — DELIVERED same day)

**Delivered:** live coverage meter (segmentSphereChord in combat.ts — lane chord in bubble ÷ per-tick travel = expected catchable samples, per-lane colored rows in the score panel); difficulty ladder L1–L5 one-click buttons (LEVELS in hud.ts, sets aids too); Local chat mock with spike cue (half of relocations leave system; count drops on leave, spikes ~4 s before landing with a red flash); bracket hover labels (name + type + distance, screen-space nearest-member test). Also: firewall-spot ghost → pulsing amber ring, lane lines → dashed amber, missile streaks dimmed further.

**Still on the shelf:** stagger-phase indicator for the 7 bombs; per-lane time-to-impact countdowns / threat-sorted lane colors; structure-defense (Astrahus) scenario; session stats summary + reaction grading; friendly-splash discipline stat; missile-HP hard mode (researched numbers pinned); EVE-adjacent webfont pass; overview right-click context menu + sortable columns + called-target row flash; selected-item ship render from Image Service; incoming-damage stack above own ship; HUD left utility cluster; EVE-format module tooltips; warp-out/in visual; kill flash sprite; draggable/saved window layout.
