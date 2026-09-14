# Pinned Game Data — EVE Firewall Simulator

*Extracted 2026-08-28 from ESI (`esi.evetech.net`, Tranquility datasource). Raw responses: [`data/esi-raw.json`](../data/esi-raw.json); named digest: [`data/esi-digest.json`](../data/esi-digest.json); distilled machine-readable extract: [`data/pinned.json`](../data/pinned.json). Re-run the extraction after EVE balance patches and diff.*

## Player ship — Nestor (typeID 33472)

| Attribute | Value |
|---|---|
| Mass (hull) | 20,000,000 kg |
| Inertia modifier | 0.35 |
| Max velocity (hull) | 70 m/s |
| Signature radius | 420 m |
| Ship radius | 250 m |
| Slots | 7 high / 6 med / 6 low ✓ matches fit |
| Warp speed | 3 AU/s ✓ matches fitting window (unused — no warping) |

## Fit modules

| Module | typeID | Key attributes |
|---|---|---|
| Imperial Navy 1600mm Steel Plates ×2 | 31900 | +3,000,000 kg mass each → fitted mass **26,000,000 kg** |
| Large Trimark Armor Pump II ×3 | 26302 | drawback attr = 10, **but no velocity penalty appears in fitted stats** (see reconciliation) |
| Gist X-Type 500MN Microwarpdrive | 19359 | speed factor 520%, thrust 150,000,000 N, **+50,000,000 kg while active**, sig +350%, 10 s cycle, overload +50% |
| Gist X-Type 100MN Afterburner | 18676 | speed factor 165%, thrust 150,000,000 N, +50,000,000 kg while active, 10 s cycle, overload +50% |
| Dark Blood Large EMP Smartbomb ×7 | 14188 | **7,500 m range, 375 EM dmg, 10 s cycle → 7.5 s at Energy Pulse Weapons V** — all three user-stated values confirmed exactly |
| Large Micro Jump Drive (M4) | 4383 | 12 s spool → 9 s at skill V ✓ matches fitting window; 180 s reactivation; 100 km jump |

Reference: Large EMP Smartbomb II (3995) is 6,000 m / 300 EM — the Dark Blood is strictly better in both range and damage, confirming the faction-bomb choice.

## Derived movement model (all-V pilot) & reconciliation vs fitting window

Formulas: `v = v_hull × 1.25 (Navigation V)`; prop boost `× (1 + sf/100 × 1.25 (Accel Control V) × thrust/mass_active)`; align `t = 1.386294 × I × M / 10⁶` with Evasive Maneuvering V (I × 0.75).

| Quantity | Derived (no links) | Fitting window | Verdict |
|---|---|---|---|
| Speed, props off | 70 × 1.25 = **87.5 m/s** | 87.5 m/s | ✓ exact |
| Align time | 9.46 s | 7.44 s | needs link agility factor **× 0.786** (−21.4%) |
| Signature | 420 m | 352 m | needs link sig factor **× 0.838** (−16.2%) — consistent with Evasive Maneuvers burst running |
| AB top speed | **444 m/s** (622 overheated) | — | not shown in fitting screenshot (see correction) |
| MWD top speed | **1,210 m/s** (1,771 overheated) | — | not shown |
| MWD sig bloom | 420 → 1,890 m | — | display only |
| Accel time constant, MWD on | **~20 s** (mass 76M kg) | — | this is the "battleship answers the helm in ten+ seconds" number, quantified |

**Correction to earlier note:** the fitting-window module columns previously read as "AB 813 / MWD 1,620 m/s" are **capacitor activation costs**, not speeds. Derived speeds above are the real targets; the exact 87.5 m/s match validates the formula chain.

**Links model:** scenario "fleet boosts" toggle applies solve-for factors — agility × 0.786, sig × 0.838, plus a prop-boost bonus (magnitude TBD; verify with an in-game HUD speed reading). With links off, use the pure derived values.

**Trimark finding:** fitted stats show *no* max-velocity drawback (87.5 exact with zero penalty). Modern armor-rig drawback handling apparently differs from legacy −10%/rig. Sim applies **no trimark velocity penalty** pending an in-game check.

## Missiles (Scourge line; own-type resonance 0.8 = the 20% self-resist)

| Missile | typeID | Base vel | Base flight | HP | All-V vel | All-V flight | All-V range |
|---|---:|---:|---:|---:|---:|---:|---:|
| Light | 210 | 3,750 | 5.0 s | 60 | 5,625 | 7.5 s | ~42 km |
| Heavy | 209 | 4,300 | 6.5 s | 120 | 6,450 | 9.75 s | ~63 km |
| Fury Heavy | 2629 | 4,300 | 4.875 s | 120 | 6,450 | 7.3 s | ~47 km |
| HAM | 20307 | 2,250 | 4.0 s | 180 | 3,375 | 6.0 s | ~20 km |
| Cruise | 203 | 4,700 | 14.0 s | 240 | 7,050 | 21.0 s | ~148 km |
| Fury Cruise | 24533 | 4,700 | 10.5 s | 240 | 7,050 | 15.75 s | ~111 km |
| Torpedo | 267 | 1,800 | 7.2 s | 360 | 2,700 | 10.8 s | ~29 km |

All-V columns apply hostile Missile Projection V (×1.5 velocity) and Missile Bombardment V (×1.5 flight). Hull bonuses (Typhoon/Raven role bonuses, Barghest's missile-velocity bonus) stack on top — pull per-hull traits when building doctrine presets.

**Tick-sampling consequences** (vs the 7.5 km bubble, 15 km diameter):
- Cruise at all-V: sample points **7.05 km apart** — a centered lane crossing yields ~2 catchable points; the final point can fall 7 km short of the target, so a bubble sitting on the fleet ball catches nothing. Long lanes (up to ~148 km) give ~20 s of warning.
- Heavy: 6.45 km spacing, ~63 km reach — explains the video's Typhoon fleets holding 35–90 km (hull bonuses extend this).
- HAM: dense 3.4 km spacing but only ~6 s / ~20 km of flight — tiny reaction window; correctly the expert tier.
- Torpedo: slow, short-ranged, 360 HP (2 pulses in the later HP mode).

## Hostile hulls

| Hull | typeID | Max vel | Inertia | Sig | Mass |
|---|---:|---:|---:|---:|---:|
| Typhoon | 644 | 130 | 0.11 | 330 | 103.6M |
| Raven | 638 | 113 | 0.12 | 410 | 99.3M |
| Barghest | 33820 | 148 | 0.098 | 370 | 98.4M |
| Cerberus | 11993 | 220 | 0.463 | 135 | 12.3M |
| Muninn | 12015 | 235 | 0.571 | 125 | 12.2M |

(Fleet speeds: × 1.25 Navigation V, plus prop mods per scenario config.)

## Hull missile traits — VERIFIED (M5 pass, 2026-08-28, EVE Uni wiki)

| Hull | Missile bonuses (per level at V unless role) | Velocity mult @ V | Flight-time mult |
|---|---|---:|---:|
| Typhoon | 5%/lvl RHML/cruise/torp ROF; 7.5%/lvl cruise+torp **explosion** velocity. **No missile-velocity bonus.** | ×1.0 | ×1 |
| Raven | 5%/lvl RHML/cruise/torp ROF; **10%/lvl cruise+torp max velocity** | ×1.5 | ×1 |
| Barghest | 10%/lvl (Caldari BS) missile damage; role: **+200% missile velocity, −50% flight time** | ×3.0 | ×0.5 (range ×1.5 net) |
| Cerberus | 5%/lvl RLML/HML/HAM ROF; 5%/lvl kinetic damage; **20%/lvl HAM max velocity** | ×2.0 (HAM only) | ×1 |
| Muninn | 5%/lvl HML/HAM explosion velocity + ROF + damage (missile boat since the 2022 rework — confirms the user's meta). **No velocity bonus.** | ×1.0 | ×1 |

Encoded in `DOCTRINES` (src/sim/combat.ts) as `mult`/`ftMult`. On top of hull
traits, scenario config has a **Guidance rigs ×1.3** toggle (default on):
approximates two Hydraulic Bay Thruster I rigs (1.15 × (1 + 0.15×0.869) ≈ 1.30),
standing in for typical fleet-fit velocity mods. Without it, trait-only Typhoon
heavies (6,450 m/s) tick shorter than the 7.5 km bubble and park-on-ball
becomes viable against that one doctrine — with it (8,385 m/s) the upstream
drill holds. Whether ×1.3 matches the real opposition's fits is a user call.

## Open items after this pass

1. **In-game verification requests (whenever convenient):** HUD top speed with AB hot and MWD hot (settles the links prop-boost factor); whether trimarks really impose no velocity penalty now.
2. ~~Per-hull missile trait bonuses for doctrine presets~~ **done — see "Hull missile traits" above.** Remaining: confirm the guidance-rig ×1.3 assumption against the real opposition's fits (user judgment).
3. Standing calibration items (unchanged): smartbomb range center-vs-surface semantics; pulse-vs-impact tick ordering.
