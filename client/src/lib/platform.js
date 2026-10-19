// What differs between the web app and the Spotify plugin. The plugin build
// (plugin/vite.config.js) swaps this module for plugin/src/platform.js.

import { AudioAdapter, SoundCloudAdapter, YouTubeAdapter } from './players.js';

export const invite = {
  title: 'Send this link. Anyone with it can join and add songs.',
  value: (code) => `${window.location.origin}/jam/${code}`,
  shown: (code) => `${window.location.host}/jam/${code}`,
  button: 'Copy link',
  copied: 'Link copied to clipboard',
};

export const joinPlaceholder = 'Jam link or code';

export function parseJamCode(input) {
  const m = String(input).trim().match(/(?:\/jam\/)?([a-z0-9]{6})\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

export const linkPlaceholder = 'YouTube, SoundCloud or direct audio link (.mp3 …)';
export const maxUploadMb = 100;

/** One player per source; SyncEngine picks by track.kind. */
export function createAdapters({ youtube, soundcloud }) {
  return {
    audio: new AudioAdapter(),
    youtube: new YouTubeAdapter(youtube),
    soundcloud: new SoundCloudAdapter(soundcloud),
  };
}

/** Uploaded files live on the server only while their Jam exists, so saved playlists can't keep them. */
export const keptFiles = null;

/** { name, avatar, spotifyUser } of the person using the app, or null (the web app doesn't know). */
export const getProfile = async () => null;

/** Opens someone's Spotify profile, where possible. */
export const openProfile = null;
