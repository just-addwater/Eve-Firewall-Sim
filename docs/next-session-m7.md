# Next session (M7) — prompt

Continue the EVE Firewall Simulator (M1–M6 done; see docs/design-brief.md, docs/data-pinned.md, and project memory — M6 delivered chase-the-FC fleet worms, UniWiki bracket glyphs, the floating scenario window, tactical-overlay fidelity (dotted targeting ring + off-plane distance arc), sky-pinned align marker, and six rounds of missile darkening).

**2026-09-13: the user reviewed three recommendation menus (camera/movement, fleet stringing + enemy FC, scenarios) and asked for them to be written up here. Nothing below has been implemented yet. Ask the user which to start with; a suggested order is at the end of each section.**

**Progress (2026-09-13, session 2):** A1 DONE (main.ts: deselect only on a clean click ≤4 px travel, deferred 250 ms so dblclick-align cancels it). C first step DONE (combat.ts `memberTau()` — helm tau from hull class + prop implied by fleet speed: BS 7/8/18 s, cruiser 2.5/3/6.5 s, ×0.85–1.25 per pilot; speedMult now 0.80–1.02). Measured (50 blues, headless): 300 m/s → median 3.6 km, p90 7 km, max 8.5 km, 7/50 at the head; 1150 m/s MWD → median 33 km, max 37 km (members out-lag the tau-10 FC off the start and can't recover — awaiting user verdict; the discipline slider C6 is the knob). 36/36 tests.
C6 DONE: `cfg.fleetSloppiness` 0–1 (default 0.5), both sides, via `memberHelm()` — piecewise across tight (legacy tau 2.5–5 s, pace 0.90–1.06, 1 km ring) / realistic (the hull-derived values above) / sloppy (helm ×1.3, pace 0.72–1.00, stopDist ×2.5, maxLag ×2). Reuses each member's existing rnd() draws, so seeded phases are identical at every setting. Scenario window Blue fleet → "Fleet discipline" range (#s-disc); LEVELS set it (L1–L2 0, L3 0.3, L4 0.5, L5 0.75). Also fixed: members' pace cap now uses `FleetBlob.cruiseSpeed` (set once from the fit) instead of the FC's current speed — a stopped MWD fleet used to crawl back at the 100 m/s floor (21 km out after 2 min), now regroups to ~1–2 km. 38/38 tests.
**Section A (camera) DONE** (camera.ts rewrite): A2 pointer lock once a drag passes 4 px (setting "Hide cursor while rotating", efs.camLock, default on; click-vs-drag now measured from movementX/Y via `rig.draggedSincePress` because clientX freezes under lock); A3 right-drag rotates (canvas contextmenu suppressed); A4 look-at = 850 ms ease-in-out swing with distance swinging on the same curve; A5 per-subject zoom memory (`lookAt(getter, key, defaultDist)`, others open at 15 km, own ship gets its distance back); A6 "Dynamic camera" checkbox (efs.camDynamic, default off — lag = fast-vs-slow velocity average ×2.5 s, ≤3 km, pull-back ≤15%, MJD jumps reset it); A7 Offset slider −0.3…0.3 (efs.camOffset, via camera.setViewOffset so brackets/rays follow); A8 **R** resets camera (eases yaw/pitch/zoom to defaults, re-targets own ship).
**Section B (movement) DONE except orbit vertical drift**: B1 Align To verb (button + **A** key — user to confirm the client key) = full speed at the object's live position, never stops; B2 "EVE keep-at-range (overshoots)" setting (efs.kraEve → ship.kraMode 'eve': full speed toward/away outside a max(150 m, 5%) band, match target inside it); B3 status line shows actual orbit radius "(at 7 km)"; B4 bumps now mass-weighted with restitution 0.8 and shove the fleet member too (memberMass: BS 100,000 t, cruiser 12,000 t); B5 nose turn-rate cap 12°/s + bank into turns (≤20°, BANK_GAIN 1.7); B6 already worked (marker fades on command change); B7 approach stand-off 500 m centre-to-centre (shares the smooth range controller with keep-at-range) + right-click Orbit / Keep-at-Range buttons for a distance menu (efs.orbitRange / efs.karRange, W/E use them). 41/41 tests.
**Section D (enemy FC) DONE** (combat.ts HostileFleet): new cfg `fcSkill` 0–1 (DEFAULT 0.5; scenario select Random 0 / Competent 0.5 / Ruthless 1) drives D1 landing opposite the player's bubble as seen from the ball (`beginRelocation`, scatter ±81°·(1−0.7·skill), uses `CombatWorld.playerPos` stored in checkReaction), D2 one early relocation per engagement when rolling 30 s intercept > 70% (≥20 s after landing, within 12·(1−skill) s), D3 skilled calls = one of the 3 most isolated pilots (60%) or a Guardian, with a pre-called `secondaryIdx` promoted on the next call. Extra rnd() draws only inside skill/wing branches ⇒ skill 0 = legacy seeded sequence. D4 `hostilePersonalities` (DEFAULT on): cruise → kite (radial=1 while blues close >50 m/s, warp out inside 60% range) or sit at ≥100 km; HAM → dive to 15 km (DIVE_RANGE_M, also the warp-in range) with 35% burn-through-the-ball per engagement. D5 `alphaSync` (off): all fireAt on one tick, hold fire while aligning, synced first volley on landing. D6 `wingSplits` (off): 50% of relocations land ≤15 ships (30%) on a second bearing 60–90° round via `ShipEntity.wingOff`. D7 out-of-system trips 20–45 s, Local back 8 s before landing (always on). D8 `sim.calloutsVisible` follows the Training aids checkbox. LEVELS: L1–L2 random FC, L3–L4 competent, L5 ruthless + wing splits. Test helper `drill()` pins fcSkill 0 / personalities off; 6 new 'enemy FC' tests. 47/47. Still open from D9: reinforcement waves (→ E6 timeline scripting).
**UI polish pass DONE (2026-09-13, session 3)** — Photon-UI fidelity from the /ui client screenshots: neutral-grey palette (no blue tint), near-black blurred windows with no visible border, sentence-case titles with a working "—" minimize (persisted `efs.min.<id>`), Bahnschrift font (closest Windows-bundled match to EVE's, `font-stretch: 94%`, tabular numerals), underline tabs, `color-scheme: dark`, styled range sliders/checkboxes. Layout: `#left-col` flex column (Ship window top, Local + Drill anchored at the bottom; the Ship window scrolls when the viewport is short — the panels used to overlap at 800×600). Ship window groups Options / Camera / Difficulty fold (persisted `efs.fold.<key>`), level highlight persisted (`efs.level`, cleared by Apply/preset). Scenario window moved out of the Ship panel to the HUD root (a blurred/scrolling parent traps `position: fixed`), draggable by its title (`makeDraggable`, `efs.scenarioPos`). Keyboard cheat sheet window (`#keys`: **? / H**, or the ? tool on the Ship title), **Esc** closes windows/menus; **hotkeys are ignored while an input is focused** (typing "1" in Seed used to fire smartbomb 1). Tactical-overlay button beside the gauge (client position) — checkbox, button and O key share `hud.toggleOverlay()`. Score/status/readouts DOM now updated only on change (was innerHTML every frame); mass readout uses real fmtNum (was a string hack). 47/47.
**Camera feel pass (same session, user: "spinning/moving still feels off", "too fast", then "subject moves in linear 1 Hz segments"):** camera.ts rotation is now a CHASE — the mouse moves a target angle (`yawT/pitchT`) and the camera eases after it (`DRAG_TAU_MS` 90) so start/stop glide like the client; on release the smoothed drag rate × inertia×500 ms is added to the target and chased with `90 + inertia×350` ms (one continuous ease, no separate momentum integrator; a new press stops the coast dead). Base gain `ROT_GAIN` 0.005 → 0.003 rad/px (~2,100 px per turn); wheel zoom tau 120 → 160 ms. Own-ship render pos/vel = cubic Hermite across the tick using prevVel/vel (`src/render/interp.ts`, 5 unit tests: endpoints, C1 across a boundary, derivative, straight line, snapped tick) — linear interpolation gave piecewise-constant velocity, so the hard-locked camera kinked the sky once a second. Fleet members still interpolate linearly (they have `vel` but no `prevVel`) — do the same for them if the user looks at members while they accelerate. 52/52. Then `ROT_GAIN` 0.003 → 0.0042 ("speed the camera up a bit").
**Section E scenarios polish DONE (same session):** `cfg.playerStart` ball/lane/off (sim.ts makeCombatSim: lane = firewall spot one missile-tick upstream on fleet 1's lane; off = 30 km abeam) + `cfg.gate` (static "Stargate" beacon under the ball) + `cfg.name`. PRESETS are now `{label, brief, cfg}` (E8 briefing card `#briefing` shown at every start, 12 s auto-fade, click to dismiss; custom scenarios get a generated one-liner) with two new presets: **Gate camp** (E4: static ball, hostiles 40 km, relocate every 45 s) and **Full scale 150 v 150** (E7, starts on the lane). LEVELS carry title+brief; L5 starts 30 km off the lane. Scenario window: Start position select, Stargate checkbox, seed "New" button, **Saved scenarios** (E9: named slots in localStorage `efs.slots` — Save as…/Load/Delete) and Copy JSON / Paste JSON; any field edit flips the preset select back to custom; one `fillForm()`/`readForm()` pair replaces the three partial field syncs. Drill window title shows the scenario name (`cfg.name`, persisted) and has a ↻ restart tool (same seed).
**Missiles fly to impact + firewall effect pass (same session):** Missile gets `hitAt`/`impactFrac`; a leaked missile is dead for the sim at once but the renderer draws its last leg to the impact point during that tick (it used to vanish a tick short). `CombatWorld.killFx` → small additive kill flashes where the wave catches missiles (pooled sprites, 320 ms). Pulse retimed to 1.05 s (~0.45 s expansion then hold/fade), added an equatorial ring in the ship plane + a faint core fill so the wave reads as a sphere from any angle. Missile streak brightness untouched (standing rule). **User: "more subtle and EVE-like"** → central flash + core fill REMOVED; the ripple is now a thin band in the ship's plane (RingGeometry 0.9–1, opacity 0.5 fading from birth) + faint silhouette ring (0.16) + near-invisible shell (0.05), 800 ms ease-out; kill pops 220–600 m at 0.45. Matches the brief's "expanding ring torus, concentric ripples for staggered bombs" target.
**Defaults changed (user, same session):** DEFAULT_SCENARIO = Machariel blues (new `cfg.friendlyHull`, scenario select "Hull"; SHIP_CLASS gained Machariel + Nestor) on AB (350) in a serpentine; fleet 1 = cruise Typhoons on AB (350, mult 1.0); fleet 2 = cerberus-ham on MWD (40 at 20 km, warp 60 s); then re-tuned: Typhoons at **125 km, relocate every 5 min**; Cerbs now `cerberus-heavy` doctrine (NEW: heavy missiles, mult ×1.5 from Caldari Cruiser +10%/lvl velocity — VERIFY) at **60 km, relocate every 3 min**. Tests pin the old single-fleet heavy drill via `LEGACY` in combat.test.ts `drill()`. **Calibration button + modal removed** from the HUD (harness stays in sim/calibration.ts + vitest).
Still open in E: E1 per-hull fleet speeds, E2 distance ladder, E3 unknown-composition rerolls, E6 timeline/reinforcements, Esc quick-menu, EVE-format module tooltips.

## Standing rules learned the hard way

- **Missiles/streaks: do NOT brighten.** Darkened six times on request; current values (head 0.13/0.17/0.24 @ 0.17 additive) are deliberate. Only touch if the user asks again.
- Hostile brackets are plain UniWiki glyphs — **no standing chip** (removed by request).
- The dev server stops between turns — when the user says "link please"/"not working", `preview_start name "dev"` and hand back http://localhost:5173.
- Member-creation `rnd()` changes shift seeded phases — the warp test now steps-until-volley, but expect similar fallout from any new per-member randomness.
- The user verifies EVE fidelity from experience — when unsure how the client behaves, ask or request a screenshot rather than guessing.

---

## A. Camera (src/render/camera.ts, src/main.ts)

1. **BUG — rotating the camera clears the selection.** `canvas` has a plain `click` → `select(null)` handler (main.ts ~line 104) and browsers fire `click` after a left-drag that starts and ends on the canvas. In the client, dragging never touches selection. Fix: track pointer travel since `pointerdown`; only deselect on a clean click under ~4 px of movement. (Also: `dblclick` fires two clicks first — double-click-to-align should not deselect either.)
2. **Pointer lock while dragging.** The client hides the cursor during rotation, lets you drag indefinitely past the screen edge, and restores the cursor at its original spot on release. Use the Pointer Lock API (`requestPointerLock` on drag start, `movementX/Y` while locked, exit on release). Biggest remaining "feels like EVE" camera change.
3. **Right-drag rotates too.** CameraRig only listens to `button === 0`. The client accepts either button (user to confirm from experience).
4. **Look-at transitions are too fast.** Focus tau is 150 ms; a look-at to a hostile fleet 100 km away whips over in a fraction of a second. The client's look-at is an eased swing of roughly 0.7–1.0 s. Move to an ease-in-out curve and swing camera distance during the same move.
5. **Per-target zoom memory (design brief, still unbuilt).** One `targetDist` is shared across all look-ats. Remember distance per subject; on look-at to another object, pick a default distance from that object's size (client behaviour), and restore the own-ship distance on return.
6. **"Dynamic camera movement" toggle** (real client setting, on by default there). Camera lags/pulls back slightly under acceleration then settles. Current hard lock = client with the setting OFF (many pilots' preference) — add as a Camera-settings checkbox, default off.
7. **Camera offset slider** (real client setting). Shifts the focus so the ship sits off-centre, freeing screen space on the overview side.
8. **Reset-camera key.** Ease yaw/pitch/dist back to defaults (nothing does this after a long drill).

Suggested order: 1+2 together (same pointer handlers) → 4+5 → 6+7 → 3, 8.

## B. Ship movement (src/sim/ship.ts, src/render/scene.ts, src/sim/sim.ts)

1. **"Align to" verb on the selected object** (client default key **A** — user to confirm). Points at the target's current position at full speed and never stops — how you fly a lane onto a fleet member. Today the only align is double-click in space.
2. **EVE-accurate keep-at-range option.** Our controller deliberately floats in (burn/coast/damped close). The client's controller on a heavy MWD hull overshoots and burns back; that yo-yo is part of what a Nestor pilot manages. Add a settings option that swaps in a raw full-speed-with-hysteresis controller.
3. **Orbit balloon check.** Under the exponential model a 5 km MWD orbit should end up far wider than 5 km (correct client behaviour). Show the actual orbit radius in the status line so the user can confirm vs Tranquility; if it does not balloon, the radial correction gain in `desiredVelocity('orbit')` is too strong.
4. **Harsher, more EVE-like bumps.** Client collisions are near-elastic with mass ratio; a battleship at MWD speed gets thrown well off line and the other ship is shoved too. `resolveBumps()` only kills the inward velocity component. Add restitution + push the fleet member back.
5. **Visual turn-rate cap + bank/roll** (roll was already on the M6 menu). Nose slerp (tau 2.6 s) has no roll and no rate cap; a full reversal should read as the slow pivot a battleship does in the client.
6. **Align marker should clear when another command replaces the align** (approach/orbit/keep-at-range/stop). Verify brackets.ts does this; in the client the align point vanishes as soon as the verb changes.
7. Still open from the M6 menu: approach stand-off (~500 m, stop bumping the target), configurable orbit/keep-range default distances (client: right-click the verb button), orbit vertical drift.

Suggested order: 1 → 2 → 6 → 4 → 3, 5, 7.

## C. Fleet stringing — "ships should be strung out more" (src/sim/combat.ts FleetBlob.integrate + member creation ~lines 340–350 and 520–540)

Diagnosis of why it still reads as a clump:

- **Too many pilots pinned at the head.** `speedMult` is 0.90–1.06 ⇒ ~40% of members are ≥ fleet speed and all sit on the 1 km stop ring together. That knot is the "cloud". Shift the range down (e.g. **0.80–1.02**) so only a handful can hold the head.
- **The catch-up burn bounds the tail.** Past `maxLag` every member burns at `CATCHUP_MULT` 1.04 and rejoins, so the worm can never exceed ~9 km. In EVE a slower hull cannot catch a faster FC on a straight leg. Drop forced catch-up for the slowest third; they close only when the FC turns or stops.
- **Members are far too agile.** Member helm tau is 2.5–5 s while the player's plated Nestor is ~7 s on AB / ~20 s on MWD. **Derive member tau from hull class + prop exactly like the player ship (data.ts `tau()`).** Every FC turn will then fan the fleet out as it does in game. → Do this first.

Additional stringing mechanisms (all EVE-realistic):

1. **Anchor chains.** A share of pilots anchor on another pilot, 2–3 links deep — stop distance and lag compound into long strings. Replace fixed `chaseOff` with an optional `anchorId` per member.
2. **Per-pilot reaction delay.** Some pilots respond to a heading change 3–10 s late, overshoot on the old heading, then cut the corner. Implement as a per-member delayed copy of the anchor point.
3. **Wider keep-at-range settings.** Pilots use different defaults (500 m … 2.5–5 km). Resting ball becomes 3–6 km wide instead of 1 km.
4. **A few permanent stragglers** (2–3 pilots 10–30 km behind). Doubles as realistic target calls (see D).
5. **Real per-hull speeds in the friendly fleet** (Nestors + Guardians) so the worm gets a natural sort order.
6. **Expose all of the above as one "Fleet discipline" slider** (tight → sloppy) in the scenario window, so the tight 1 km ball stays available for beginner drills. Keep the current values as "tight".

Suggested order: hull-derived tau + speedMult shift (two constants) → discipline slider → anchor chains → reaction delay → stragglers.

## D. Enemy FC behaviour (src/sim/combat.ts HostileFleet)

1. **Purposeful landing spots.** Relocations pick a random bearing 60–180° away. A real FC lands where the firewall isn't: adversarial mode picks the bearing farthest from the player's current bubble relative to the ball, scaled by difficulty level.
2. **Adaptive relocation timer.** When rolling intercept > ~70%, the hostile FC "sees missiles dying" and relocates sooner. Natural escalator without touching scenario settings.
3. **Smarter target calling.** Today: random friendly every `retargetPeriodS` (logi 50% with the option). Real calls: isolated stragglers, logi, the worm's tail, with a pre-called secondary. Straggler calls force the real decision (cover the ball or the lone lane).
4. **Fleet personalities**, separate from the geometric orbit/serpentine patterns: cruise fleets **kite** (pull range when blues burn at them, warp out inside a set distance); HAM fleets **dive** to ~15 km and orbit, or **burn through** the ball and out the far side; cruise fleets at 100+ km often **sit still** on a ping.
5. **Hold-fire windows.** FC calls hold while repositioning, then releases a synced first volley (pairs with the alpha-sync toggle below).
6. **Wing splits.** On a relocation, a wing of 10–15 ships lands on a second bearing — two lanes from one fleet without an extra-fleet config.
7. **Longer out-of-system trips.** Fleets that leave Local currently return in 8–12 s like a ping bounce; a real system change is 20–45 s. Makes the Local spike a more honest early warning.
8. **Gate the text callouts behind training aids.** At L5 the player should read an align-out from overview velocities and Local, not from a toast.
9. Still open from the M6 menu: **hostile alpha-sync toggle** (synced volleys vs staggered stream), aggressive HAM warp-ins that land ON the friendly ball, reinforcement waves (see E).

Suggested order: 1 → 3 → 2 → 4 → 7+8 → 5, 6.

## E. Scenarios (src/ui/hud.ts PRESETS/LEVELS, scenario window, combat.ts ScenarioConfig)

1. **Fleet composition realism.** Friendly Nestors + Guardians with real per-hull speeds; hostile fleets carry a few non-firing logi cruisers.
2. **Distance ladder within one drill.** Hostile FC pulls range progressively (e.g. 50 → 90 km over ten minutes) so the correct firewall spot keeps moving.
3. **Unknown-composition mode.** Doctrine rerolls on each relocation; identify missile vs turret from the overview Type column before committing.
4. **Gate-camp preset.** Friendly ball static on a gate, hostiles landing at random bearings 30–70 km out — the most common lowsec engagement shape.
5. **Player start-position options.** On the lane / in the ball / 30 km off (pure reaction drills).
6. **Timeline scripting.** Reinforcement waves and doctrine swaps at set times.
7. **Full-scale presets.** Presets top out at 50 per side; the target was 50–200. Add a 150 v 150 preset (also a perf check for worm + missile streams).
8. **Per-scenario briefing text** at start: what this drill trains.
9. Still open from the M6 menu: named scenario save/load slots + JSON export/import; Esc quick-menu (pause / restart / reset camera); EVE-format module tooltips.
10. Design-brief shelf: stagger-phase indicator, per-lane time-to-impact, structure-defence (Astrahus), session stats/grading, warp-in/out visuals, webfont pass.

---

## Carry-overs (ask, don't assume)

- **GitHub Pages deploy:** `npm run build` works (vite, base './'). The folder is STILL not a git repo — **ask before `git init`** / creating the GitHub repo.
- **Guidance-rigs ×1.3 default ON** — the user still hasn't confirmed it matches their real opposition's fits; ask while they fly.
- Fleet-worm tail currently reaches ~9 km (speedMult 0.90–1.06, maxLag 1.5–9 km, tau 2.5–5 s). Section C supersedes the earlier "offer to pull maxLag in" note — the user wants MORE stringing, not less.

## Environment (details in project memory)

- Dev server: `preview_start name "dev"` (autoPort; vite.config reads PORT). Tests: `npx vitest run` (36 passing). Typecheck: `npx tsc --noEmit`.
- npm needs `--cache <scratchpad>/npm-cache`; System32 curl.exe `--ssl-no-revoke` for downloads — but **wiki.eveuniversity.org is firewalled for curl**: load it in a Browser-pane tab and extract images via canvas `toDataURL` (that's how public/icons/bracket_*.png got here).
- PowerShell 5.1 Utility module is broken — use the Bash tool.
- Chrome pauses rAF while the Browser pane is hidden; sim stepping is interval-driven and fine. Check `document.visibilityState` before chasing "frozen UI" ghosts; screenshots force a frame.
