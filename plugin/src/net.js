// Peer-to-peer rooms. Friends' Spotify apps talk to each other directly over WebRTC
// data channels; public Nostr relays are only used to find each other (via Trystero).
// No JamRoom server is involved.

import { joinRoom, selfId } from 'trystero';

export { selfId };

const APP_ID = 'jamroom-spotify-v1';

/**
 * The Jam code names the room and is also the password that encrypts the
 * connection handshake, so only people who know the code can connect.
 */
export function openRoom(code) {
  return joinRoom({ appId: APP_ID, password: `jamroom:${code}` }, `jam-${code}`);
}
