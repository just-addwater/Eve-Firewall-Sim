# EVE Firewall Simulator

https://just-addwater.github.io/Eve-Firewall-Sim/

A browser-based practice simulator for **firewalling** in EVE Online — flying a
smartbomb Nestor between your fleet and hostile missile fleets. Trains
positioning and movement. See [docs/design-brief.md](docs/design-brief.md) for
the full design and [docs/data-pinned.md](docs/data-pinned.md) for the pinned
game data (all numbers derive from the SDE via ESI — nothing is hand-tuned).


## Controls (M1)

| Input | Action |
|---|---|
| Double-click in space | Align to that point ("Aligning to a point in space") |
| Click bracket / overview row | Select |
| Q / W / E | Approach / Orbit 5 km / Keep at Range 2,000 m (selected) |
| C | Look at selected (or back to your ship) |
| Ctrl+Space | Stop ship |
| O | Toggle tactical overlay |
| Click AB / MWD button | Toggle prop module (auto-cycles; deactivates at cycle end) |
| Small pip above module | Toggle prop overheat |
| Click speed gauge | Set throttle fraction |
| F1–F7 or 1–7 | Toggle each smartbomb (pulse on activation, then auto-cycle every 7.5 s; **stagger them** — activated together they pulse in unison and leave 7.5 s holes) |
| J (or MJD button) | Micro Jump Drive: 9 s spool, 100 km jump along your heading, 180 s cooldown |
| Scenario… (top left) | Configure the drill: fleet sizes, fighting distance 10–255 km, missile type, speeds, volley cadence, warp frequency, seed |
| Settings (top left) | Training aids (lane line + firewall-spot ghost), collisions/bumping, zoom & camera speed, fleet boosts, overlay |

The hostile fleet periodically warps off and lands on a new bearing — the
score panel times how long you take to cover the new lane (reaction last/avg).
