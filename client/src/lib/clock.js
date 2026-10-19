// Estimates server time so every device evaluates the shared player state
// against the same clock (Spotify keeps a server_time_provider; F3).

import { estimateOffset } from '../../../shared/timing.js';

const localNow = () => performance.timeOrigin + performance.now();
let offset = 0;
let lastRtt = null;

export const serverNow = () => localNow() + offset;
export const clockRtt = () => lastRtt;

export async function syncClock(ping, samples = 6) {
  const results = [];
  for (let i = 0; i < samples; i++) {
    try {
      const t0 = localNow();
      const { serverNow: remote } = await ping();
      results.push({ t0, t1: localNow(), serverNow: remote });
    } catch {
      // a lost sample is fine
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const best = estimateOffset(results);
  if (best) {
    offset = best.offset;
    lastRtt = best.rtt;
  }
  return best;
}
