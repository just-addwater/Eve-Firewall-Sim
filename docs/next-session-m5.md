# Next-session prompt — M5: UI & camera fidelity pass

Copy-paste prompt for the next session (or just say "run the M5 plan in docs/next-session-m5.md").

---

Continue the EVE Firewall Simulator (M1–M4 are done; see docs/design-brief.md, docs/data-pinned.md, and project memory). This session is **M5: the UI and camera fidelity pass**. Work through these in order:

## 1. Research first — EVE Uni wiki pages (WebFetch each, extract implementation detail)

- https://wiki.eveuniversity.org/Tactical_overlay — exact ring/label/marker behavior and styling; what the overlay draws for other ships (velocity vectors, elevation lines); any spec for our red module-range ring.
- https://wiki.eveuniversity.org/Overview — column set, tabs, sorting, icons, row states/colors; what a faithful minimal overview needs that ours lacks.
- https://wiki.eveuniversity.org/Color_Tag_Images — the standing color-tag system (hostile red/orange, neutral, corp/alliance/fleet blues & purples) → apply to overview rows and brackets so colors match the client.
- https://wiki.eveuniversity.org/Manual_piloting — validate/extend movement verbs: double-click behavior, keyboard commands, spiraling, anything our controls get wrong.

## 2. Video frame mining for UI detail

`reference/Rules Of Smartbombs.mp4` (4:17, 720p60). ffmpeg is NOT installed and the
scratchpad is per-session: re-download ffmpeg-release-essentials.zip from gyan.dev
using **/c/Windows/System32/curl.exe -L --ssl-no-revoke** (Git-bash curl and winget are
firewall-blocked per-app), extract with /c/Windows/System32/tar.exe.

This time sample DENSELY for UI, not events: extract short 2–4 fps bursts around
UI-rich moments and **crop/zoom specific UI regions** (ffmpeg crop filter) to read
exact styling: overview rows + header + tab strip, HUD gauge + module rack, combat
log lines, tactical overlay rings/labels up close, brackets of ships/drones/wrecks,
selected-item panel. Goal: match colors, fonts/weights, spacing, iconography in our
HUD/overview/brackets. Compare side-by-side with our UI and fix deltas.

## 3. Camera feel (user's spec, quoted)

> "The orbital camera has a few flourishes to make the game more cinematic, such as
> a slow drift, and an exponential zoom." — and EVE's Camera Settings: "Sensitivity
> and Inertia change the way the camera responds to your mouse movements."

Implement in src/render/camera.ts:
- **Slow idle drift** (subtle autonomous orbit when input is idle, EVE-style; should be barely perceptible and stop on input).
- **Exponential zoom** — ours multiplies per wheel notch and eases; verify the curve *feels* like the client across the full 300 m–600 km range (near zoom should slow down dramatically).
- **Camera inertia**: rotation momentum that keeps easing after the drag ends; expose **Sensitivity** and **Inertia** sliders in settings (persisted) alongside the existing zoom/camera speed sliders — consider consolidating those four into a Camera section.

## 4. The user's UI punch list

They flagged "a lot of UI work still needed" after M1. Ask them to itemize while
flying (suggest the three-fleet preset). Fix quick items immediately; log the rest
in design-brief.md's backlog section. Known candidates: EVE-style fonts/colors
per the frame study, overview tabs, bracket iconography per ship class, gauge
styling, kill-ticker position/format vs the video.

## 5. If time remains

- **Deploy**: `npm run build` (vite, base './') → GitHub Pages. NOTE: the folder is
  not yet a git repo — ask the user before `git init`/creating a GitHub repo.
- **Hull-trait data pass**: verify doctrine missileVelocityMult values (Typhoon ×1.5,
  Raven ×1.25, Barghest ×1.6, Cerberus/Muninn ×1.5) against real hull traits (ESI
  type traits aren't in dogma_attributes — check type descriptions, everef.net
  ref-data, or ask the user to read the in-game traits tab) and update
  data/pinned.json + docs/data-pinned.md.

## Environment reminders (details in project memory)

- Dev server: preview_start name "dev" (port 5173). Tests: `npx vitest run` (34 passing). Typecheck: `npx tsc --noEmit`.
- npm needs `--cache <scratchpad>/npm-cache`; node.exe has a firewall exception now.
- PowerShell 5.1's Utility module is broken on this machine — use the Bash tool.
- User verifies EVE fidelity from experience — when unsure how the client behaves, ask or request a screenshot rather than guessing (see the tactical-overlay lesson in memory).
