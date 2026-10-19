// Turns a pasted link into a playable source. The server never fetches the
// user's URL itself (no SSRF surface): direct audio links are played by each
// browser, YouTube and SoundCloud links by their official embedded players, and
// Spotify songs by each listener's own Spotify app (only in the plugin, plugin/).

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const RESERVED_SC = new Set(['discover', 'stream', 'search', 'you', 'upload', 'charts', 'pages', 'settings', 'messages', 'notifications']);
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|weba)$/i;

export class LinkError extends Error {
  code = 'bad-link';
}

export function parseLink(input) {
  const text = String(input ?? '').trim();
  const uri = text.match(/^spotify:track:([^:?#\s]+)$/i);
  if (uri) return spotify(uri[1]);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new LinkError("That doesn't look like a link");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new LinkError('Only http and https links are supported');
  }

  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') return youtube(url.pathname.split('/')[1] ?? '');
  if (YT_HOSTS.has(host)) {
    const v = url.searchParams.get('v');
    if (v) return youtube(v);
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/);
    if (m) return youtube(m[1]);
    throw new LinkError('Paste a link to a single YouTube video');
  }
  if (host === 'spotify.link' || host === 'spotify.app.link') {
    throw new LinkError('Open that short link first, then copy the full open.spotify.com link');
  }
  if (host === 'spotify.com' || host.endsWith('.spotify.com')) {
    // Optional locale prefix: /intl-fr/track/<id>
    const m = url.pathname.match(/^(?:\/intl-[a-z-]+)?\/track\/([^/]+)/i);
    if (m) return spotify(m[1]);
    throw new LinkError('Paste a link to a single Spotify song (open.spotify.com/track/…)');
  }
  if (host === 'on.soundcloud.com') {
    throw new LinkError('Open that short link first, then copy the full soundcloud.com link');
  }
  if (host === 'soundcloud.com' || host === 'www.soundcloud.com' || host === 'm.soundcloud.com') {
    // soundcloud.com/<artist>/<track>; sets (playlists) and profile pages aren't single songs.
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[1] === 'sets' || RESERVED_SC.has(parts[0])) {
      throw new LinkError('Paste a link to a single SoundCloud track (soundcloud.com/artist/track)');
    }
    return { kind: 'soundcloud', src: `https://soundcloud.com/${parts[0]}/${parts[1]}`.toLowerCase(), title: null };
  }
  return { kind: 'audio-url', src: url.href, title: titleFromPath(url) };
}

function youtube(id) {
  if (!YT_ID.test(id)) throw new LinkError('That YouTube link has no valid video ID');
  return { kind: 'youtube', src: id, title: null };
}

function spotify(id) {
  if (!SPOTIFY_ID.test(id)) throw new LinkError('That Spotify link has no valid song ID');
  return { kind: 'spotify', src: `spotify:track:${id}`, title: null };
}

function titleFromPath(url) {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let name;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  return name.replace(AUDIO_EXT, '').replace(/[_+]+/g, ' ').trim() || url.hostname;
}

/** Title and channel from YouTube's public oEmbed endpoint, or null. */
export async function youtubeInfo(id, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  try {
    const res = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: typeof data.title === 'string' ? data.title : null,
      artist: typeof data.author_name === 'string' ? data.author_name : null,
    };
  } catch {
    return null;
  }
}

/** Song title from Spotify's public oEmbed endpoint, or null. (It has no artist or duration.) */
export async function spotifyInfo(uri, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const page = `https://open.spotify.com/track/${uri.split(':').pop()}`;
  try {
    const res = await fetchImpl(`https://open.spotify.com/oembed?url=${encodeURIComponent(page)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { title: typeof data.title === 'string' ? data.title : null, artist: null };
  } catch {
    return null;
  }
}

/** Track title and artist from SoundCloud's public oEmbed endpoint, or null. */
export async function soundcloudInfo(url, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  try {
    const res = await fetchImpl(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const artist = typeof data.author_name === 'string' ? data.author_name : null;
    let title = typeof data.title === 'string' ? data.title : null;
    // oEmbed titles read "Track by Artist".
    if (title && artist && title.endsWith(` by ${artist}`)) title = title.slice(0, -(artist.length + 4));
    return { title, artist, art: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : null };
  } catch {
    return null;
  }
}

/** The link parseLink accepts for a stored track (used to re-check saved playlists). */
export function linkFor(kind, src) {
  if (typeof src !== 'string') return '';
  return kind === 'youtube' ? `https://www.youtube.com/watch?v=${src}` : src;
}
