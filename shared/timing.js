// Timing math shared by the server (which owns the player state) and the
// browsers (which follow it). The player state has the same shape as Spotify
// Connect's: a position plus the server time at which that position was true
// (position_as_of_timestamp / timestamp). See EVIDENCE.md, finding F3.

/** Playback position in ms at server time `now`, clamped to [0, durationMs]. */
export function positionAt(player, now, durationMs = null) {
  let pos = player.isPlaying
    ? player.positionAsOfTimestamp + (now - player.timestamp)
    : player.positionAsOfTimestamp;
  if (pos < 0) pos = 0;
  if (durationMs != null && pos > durationMs) pos = durationMs;
  return pos;
}

/**
 * NTP-style clock offset (server minus local) from ping samples
 * `{ t0, t1, serverNow }`. The sample with the lowest round trip wins because
 * its midpoint assumption has the least room for error.
 */
export function estimateOffset(samples) {
  let best = null;
  for (const { t0, t1, serverNow } of samples) {
    const rtt = t1 - t0;
    if (!(rtt >= 0)) continue;
    if (!best || rtt < best.rtt) best = { rtt, offset: serverNow - (t0 + rtt / 2) };
  }
  return best;
}

/**
 * How a follower should correct drift. `diffMs` is local position minus
 * expected position, so positive means this device is ahead.
 *
 * Large drift: seek. Small drift on players that support it: nudge the
 * playback rate until within `settleMs`, which is inaudible compared with a
 * seek. `correcting` keeps nudging below `softMs` (hysteresis) so the rate
 * doesn't flap around the threshold.
 */
export function correction(diffMs, { hardMs, softMs, settleMs, supportsRate, correcting = false, maxRateDelta = 0.05 }) {
  const abs = Math.abs(diffMs);
  if (abs >= hardMs) return { action: 'seek', rate: 1 };
  if (supportsRate && (abs >= softMs || (correcting && abs > settleMs))) {
    const delta = Math.min(maxRateDelta, Math.max(0.01, abs / 5000));
    return { action: 'rate', rate: diffMs > 0 ? 1 - delta : 1 + delta };
  }
  return { action: 'none', rate: 1 };
}
