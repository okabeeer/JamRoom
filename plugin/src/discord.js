// Discord status ("Listening to …") for whatever the Jam is playing, from any source.
//
// Spotify's page can't reach Discord's local IPC pipe, so a small helper on this computer
// ("JamRoom Discord.ps1" in the share folder) listens on 127.0.0.1 and forwards to Discord.
// If the helper isn't running, nothing happens.

import { serverNow } from '../../client/src/lib/clock.js';

const HELPER = 'http://127.0.0.1:6473/activity';
const HEARTBEAT_MS = 15000; // the helper clears the status if Spotify stops reporting
const RETRY_MS = 30000;

const SOURCE = { spotify: 'Spotify', youtube: 'YouTube', soundcloud: 'SoundCloud', file: 'a shared file', 'audio-url': 'a link' };

function openUrl(track) {
  if (track.kind === 'spotify') return `https://open.spotify.com/track/${track.src.split(':').pop()}`;
  if (track.kind === 'youtube') return `https://www.youtube.com/watch?v=${track.src}`;
  if (track.kind === 'soundcloud') return track.src;
  return null;
}

function activityFor(state) {
  const p = state?.player;
  const item = p && p.index >= 0 ? state.queue[p.index] : null;
  const track = item ? state.tracks[item.trackId] : null;
  if (!track || !p.isPlaying || p.finished) return { playing: false };
  const durMs = track.duration ? track.duration * 1000 : null;
  // Discord counts on this computer's clock; the Jam's clock is the host's.
  const offset = Date.now() - serverNow();
  const startMs = Math.round(p.timestamp - p.positionAsOfTimestamp + offset);
  const host = state.members.find((m) => m.id === state.hostId);
  return {
    playing: true,
    title: track.title,
    artist: track.artist,
    art: track.art ?? (track.kind === 'youtube' ? `https://i.ytimg.com/vi/${track.src}/hqdefault.jpg` : null),
    source: SOURCE[track.kind] ?? 'JamRoom',
    url: openUrl(track),
    startMs,
    endMs: durMs ? startMs + durMs : null,
    jam: host ? `${host.name}'s Jam` : 'a Jam',
    listeners: state.members.filter((m) => m.online).length,
  };
}

export function reportToDiscord(socket) {
  let latest = { playing: false };
  let lastSent = '';
  let lastSentAt = 0;
  let downUntil = 0;

  async function send(force = false) {
    const body = JSON.stringify(latest);
    const now = Date.now();
    if (now < downUntil) return;
    if (!force && body === lastSent && now - lastSentAt < HEARTBEAT_MS) return;
    try {
      await fetch(HELPER, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(2000) });
      lastSent = body;
      lastSentAt = now;
    } catch {
      downUntil = now + RETRY_MS; // helper not running
    }
  }

  socket.on('state', (state) => {
    latest = activityFor(state);
    send();
  });
  for (const event of ['ended', 'removed', 'disconnect']) {
    socket.on(event, () => {
      latest = { playing: false };
      send(true);
    });
  }
  setInterval(() => {
    if (!socket.joined && latest.playing) latest = { playing: false };
    send();
  }, HEARTBEAT_MS / 3);
}
