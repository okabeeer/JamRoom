// What the TV corner shows for a Spotify song: its Canvas (the looping video artists add
// to songs) and its lyrics, synced line by line when Spotify has the timing.
//
// Spotify's built-in browser can't decode H.264, so the Canvas's .mp4 won't play. Spotify's
// own player streams it instead: a manifest lists encodings (VP9 WebM among them) as an init
// piece plus segments on its video CDN. We fetch those, join them into one WebM file and hand
// the TV a local blob URL (which three.js can also draw).

const canvasCache = new Map(); // uri -> Promise<string | null>
const lyricsCache = new Map(); // uri -> Promise<{ synced, lines: [{ ms, text }] } | null>

const MAX_CANVAS_BYTES = 12 * 1024 * 1024;

async function webmFromManifest(fileId) {
  const m = await window.Spicetify.CosmosAsync.get(`https://spclient.wg.spotify.com/manifests/v9/json/sources/${fileId}/options/supports_drm`);
  const content = m?.contents?.[0];
  const vp9 = (content?.profiles ?? []).filter((p) => p.mime_type === 'video/webm').sort((a, b) => a.video_width - b.video_width);
  const profile = vp9.find((p) => p.video_width >= 480) ?? vp9.at(-1);
  const base = m?.base_urls?.[0];
  if (!profile || !base || !m.initialization_template || !m.segment_template) return null;
  const fill = (template, ts) =>
    template.replaceAll('{{profile_id}}', profile.id).replaceAll('{{file_type}}', profile.file_type).replaceAll('{{segment_timestamp}}', ts);
  const urls = [base + fill(m.initialization_template, 0)];
  const step = content.segment_length || 4;
  for (let t = (content.start_time_millis ?? 0) / 1000; t < (content.end_time_millis ?? 0) / 1000; t += step) urls.push(base + fill(m.segment_template, t));
  const parts = [];
  let bytes = 0;
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) return null;
    const part = await res.arrayBuffer();
    bytes += part.byteLength;
    if (bytes > MAX_CANVAS_BYTES) return null;
    parts.push(part);
  }
  return URL.createObjectURL(new Blob(parts, { type: 'video/webm' }));
}

/** A playable (blob) URL of the song's Canvas video, or null. */
export function canvasVideo(uri) {
  if (!canvasCache.has(uri)) {
    canvasCache.set(
      uri,
      (async () => {
        const G = window.Spicetify.GraphQL;
        const res = await G.Request(G.Definitions.canvas, { trackUri: uri });
        const canvas = res?.data?.trackUnion?.canvas;
        if (!canvas?.fileId || !/^VIDEO/.test(canvas.type ?? '')) return null;
        return webmFromManifest(canvas.fileId);
      })().catch(() => null),
    );
  }
  return canvasCache.get(uri);
}

const LRCLIB = 'https://lrclib.net/api';
const LRCLIB_HEADERS = { 'Lrclib-Client': 'JamRoom Spotify plugin' };

function spotifyLyrics(uri) {
  return (async () => {
    const id = uri.split(':').pop();
    const res = await window.Spicetify.CosmosAsync.get(
      `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`,
    );
    const lines = res?.lyrics?.lines;
    if (!Array.isArray(lines) || !lines.length) return null; // 404: Spotify has no lyrics for it
    return {
      source: 'Spotify',
      synced: res.lyrics.syncType === 'LINE_SYNCED',
      lines: lines.map((l) => ({ ms: Number(l.startTimeMs) || 0, text: String(l.words ?? '').replace(/♪/g, '').trim() })),
    };
  })().catch(() => null);
}

/**
 * "Artist - Song (Official Video) [HD]" → { artist: 'Artist', title: 'Song' }. YouTube titles and
 * channel names ("ArtistVEVO", "Artist - Topic") and file names need this before a lookup.
 */
export function cleanSongName(title, artist) {
  let t = String(title ?? '')
    .replace(/\s*[([【][^)\]】]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|4k|mv|clip|remaster(ed)?|live|explicit|music)\b[^)\]】]*[)\]】]/gi, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s*[([]?\s*\b(ft\.?|feat\.?|featuring)\s.*$/i, '')
    .trim();
  let a = String(artist ?? '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/^by\s+/i, '').trim();
  const split = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (split) {
    a = split[1].trim();
    t = split[2].trim();
  }
  return { title: t.replace(/^["'“]|["'”]$/g, '').trim(), artist: a };
}

/** "[01:02.50]words" (one or more stamps per line) → [{ ms, text }] */
function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ ms: Math.round((Number(s[1]) * 60 + Number(s[2])) * 1000), text });
  }
  return lines.sort((a, b) => a.ms - b.ms);
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The best LRCLIB entry for this song, or null. Junk entries (a word or two) are skipped. */
async function lrclibLyrics({ title, artist, durationSec }) {
  const { title: t, artist: a } = cleanSongName(title, artist);
  if (!t) return null;
  const search = async (params) => {
    const res = await fetch(`${LRCLIB}/search?${new URLSearchParams(params)}`, { headers: LRCLIB_HEADERS, signal: AbortSignal.timeout(6000) });
    return res.ok ? res.json() : [];
  };
  let found = a ? await search({ track_name: t, artist_name: a }) : [];
  if (!found.length) found = await search({ q: a ? `${a} ${t}` : t });
  let best = null;
  let bestScore = -Infinity;
  for (const c of found.slice(0, 20)) {
    const text = c.syncedLyrics || c.plainLyrics || '';
    if (c.instrumental) continue;
    if (text.split('\n').filter((l) => l.replace(/\[[^\]]*\]/g, '').trim()).length < 4) continue; // junk / vandalised
    let score = c.syncedLyrics ? 3 : 0;
    if (durationSec) {
      const off = Math.abs((c.duration ?? 0) - durationSec);
      score += off <= 3 ? 3 : off <= 10 ? 1 : -3;
    }
    if (norm(c.trackName).includes(norm(t)) || norm(t).includes(norm(c.trackName))) score += 2;
    if (a && (norm(c.artistName).includes(norm(a)) || norm(a).includes(norm(c.artistName)))) score += 2;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  if (!best || bestScore < 2) return null;
  if (best.syncedLyrics) {
    const lines = parseLrc(best.syncedLyrics);
    if (lines.length) return { source: 'LRCLIB', synced: true, lines };
  }
  return { source: 'LRCLIB', synced: false, lines: String(best.plainLyrics).split(/\r?\n/).map((text) => ({ ms: 0, text: text.trim() })) };
}

/**
 * Lyrics for whatever is playing: Spotify's own for Spotify songs, otherwise (or when Spotify
 * has none) the open LRCLIB database, matched by title, artist and length.
 * np: { uri?, title, artist?, durationSec? }. Resolves to { source, synced, lines } or null.
 */
export function lyricsFor(np) {
  const key = np.uri ?? `${np.title}|${np.artist ?? ''}`;
  if (!lyricsCache.has(key)) {
    lyricsCache.set(
      key,
      (async () => (np.uri ? await spotifyLyrics(np.uri) : null) ?? (await lrclibLyrics(np)))().catch(() => null),
    );
  }
  return lyricsCache.get(key);
}
