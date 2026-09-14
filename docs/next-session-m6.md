# Next-session prompt — M6: fleet-anchor motion + streak pass (+ deploy)

Copy-paste prompt for the next session (or just say "run the M6 plan in docs/next-session-m6.md").

---

Continue the EVE Firewall Simulator (M1–M5 done; see docs/design-brief.md, docs/data-pinned.md, and project memory — M5 delivered the UI/camera fidelity pass, verified hull traits, coverage meter, difficulty ladder, Local spike cue, and bracket hover labels). This session:

## 1. Fleet members anchor by CHASING the FC (rough line / bunch-up)

Replace the current keep-station easing (members easing toward `center + fixed
ball offset`, MEMBER_TAU 2.5 s in src/sim/combat.ts FleetBlob) with real
anchored-fleet behavior: **every member keeps-at-range ~1,000 m on the FC
itself** (the blob center is the virtual FC; the friendly side's "Fleet anchor"
bracket is that point).

Wanted emergent look (user spec):
- FC under way → members chase its wake at their own speed and **string out
  into a rough trailing line** behind it.
- FC slow/stopped → members converge and **bunch up** into a tight ~1 km clump.

Implementation sketch (keep it 1 Hz, per member):
- Chase point = FC pos (not a per-member offset); stop distance ~1,000 m with a
  small per-member jitter (±200–400 m) so they don't stack onto one point.
- Member speed cap ≈ fleet speed × 1.05 — barely faster than the FC, which is
  what makes stragglers trail in a line instead of flying formation.
- Ease velocity with a per-member tau (~3 s) so direction changes look like
  ships answering the helm, not particles.
- Watch the interactions: missiles target `member.pos` (fine — they read it
  live); warp `teleport()` must snap members around the destination (land with
  a spread, then bunch); bumping in sim.ts pushes the player out of members.
- **Re-run the vitest suite** — the interception-geometry tests read member
  positions at runtime so they should survive, but the ball will now tighten
  toward ~1 km around the FC when static; adjust expectations only if a test's
  geometry premise (not its physics) changed.

## 2. Missiles more streaky

Current: constant-color LineSegments, length `500 + speed × 0.12`, 0x7a95ad
@ 0.32 additive. Make them read as proper light streaks (design brief target:
"bright head + fading tail"):
- Per-vertex colors on the streak geometry (head vertex bright blue-white,
  tail vertex near-black) with `vertexColors: true` + additive blending — the
  gradient IS the streak look.
- Longer tails: try ~0.4–0.7 × per-tick travel so fast missiles draw long rays.
- Keep overall brightness restrained — the user has asked twice to darken
  missiles; streakier ≠ brighter. Tune head brightness, not opacity.

## 3. Carry-overs (ask, don't assume)

- **GitHub Pages deploy**: `npm run build` (vite, base './') — the folder is
  STILL not a git repo; **ask before `git init`** / creating the GitHub repo.
- **Guidance-rigs ×1.3 verdict**: scenario default is ON (approximates two
  Hydraulic Bay Thrusters; keeps trait-true Typhoon heavies past the 7.5 km
  bubble per tick). The user hasn't confirmed it matches their real
  opposition's fits — ask while they fly.
- Suggestion shelf (design-brief "Suggested next steps"): stagger-phase
  indicator, per-lane time-to-impact, structure-defense scenario, session
  stats/grading, EVE-format module tooltips, warp-in/out visuals, webfont
  pass, and more — offer if time remains.

## Environment reminders (details in project memory)

- Dev server: preview_start name "dev" (autoPort on — 5173 may be taken by
  another session; vite.config reads PORT). Tests: `npx vitest run` (36
  passing). Typecheck: `npx tsc --noEmit`.
- npm needs `--cache <scratchpad>/npm-cache`; System32 curl.exe with
  --ssl-no-revoke for downloads; PowerShell 5.1 Utility module is broken —
  use the Bash tool.
- Chrome pauses rAF while the Browser pane is hidden: the picture freezes but
  the 1 Hz sim keeps stepping (by design). Check document.visibilityState
  before chasing "frozen UI" ghosts; screenshots force a frame.
- Module icons come from CCP's official Image Service by typeID into
  public/icons/ (SB 14188, MWD 19359, AB 18676, MJD 4383) — same pattern for
  any new icon (e.g. ship renders for the selected-item panel).
- The user verifies EVE fidelity from experience — when unsure how the client
  behaves, ask or request a screenshot rather than guessing.
