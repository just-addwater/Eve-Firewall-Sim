// EVE number formats, matched to the user's client (Photon UI screenshots in
// /ui): comma thousands separators ("3,610 m"), whole meters below 10 km,
// whole km above ("12 km"), velocity as a bare comma-separated integer.
export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtDist(m: number): string {
  if (!isFinite(m)) return '—';
  if (m >= 10_000) return `${fmtNum(m / 1000)} km`;
  return `${fmtNum(m)} m`;
}

export function fmtSpeed(ms: number): string {
  return `${fmtNum(ms)} m/s`;
}

/** Drill clock "18:11:05" style timestamp from sim seconds. */
export function fmtClock(t: number): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
}
