// The plugin's version of client/src/lib/platform.js.

import { AudioAdapter, SoundCloudAdapter, YouTubeAdapter } from '../../client/src/lib/players.js';
import { fileUrl } from './files.js';
import { SpotifyPlayer } from './spotifyPlayer.js';

export const invite = {
  title: 'Friends with the JamRoom plugin in Spotify join with this code.',
  value: (code) => code,
  shown: (code) => code,
  button: 'Copy code',
  copied: 'Code copied to clipboard',
};

export const joinPlaceholder = 'Jam code';

export function parseJamCode(input) {
  const m = String(input).trim().match(/^(?:jamroom:)?([a-z0-9]{6})$/i);
  return m ? m[1].toLowerCase() : null;
}

export const linkPlaceholder = 'Spotify, YouTube, SoundCloud or audio link';
export const maxUploadMb = 60; // files travel friend to friend (files.js MAX_FILE_BYTES)

/** Uploaded songs ("p2p:<id>") come from friends' computers instead of a server. */
class PeerAudioAdapter extends AudioAdapter {
  async load(track) {
    if (!track.src.startsWith('p2p:')) return super.load(track);
    this.loadedSrc = null;
    const src = await fileUrl(track.src.slice(4));
    return super.load({ ...track, src });
  }
}

export function createAdapters({ youtube, soundcloud }) {
  return {
    audio: new PeerAudioAdapter(),
    youtube: new YouTubeAdapter(youtube),
    soundcloud: new SoundCloudAdapter(soundcloud),
    spotify: new SpotifyPlayer(),
  };
}

/** Files in your saved playlists stay on this computer after their Jam ends. */
export { keptFiles } from './files.js';

// Your Spotify name and picture, so you join Jams as yourself.
let profile = null;
export function getProfile() {
  profile ??= (async () => {
    try {
      const user = await window.Spicetify.Platform.UserAPI.getUser();
      const images = [...(user?.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
      return { name: user?.displayName || user?.username || null, avatar: images[0]?.url ?? null, spotifyUser: user?.username ?? null };
    } catch {
      profile = null;
      return null;
    }
  })();
  return profile;
}

export const openProfile = (user) => window.Spicetify.Platform.History.push(`/user/${encodeURIComponent(user)}`);
