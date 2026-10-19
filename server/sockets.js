// Socket.IO wiring. Clients send commands with an ack; the server applies them
// to the RoomStore and broadcasts the whole room state (it is small) to
// everyone in the Jam, like Spotify's cluster/session_update pushes (F2, F3).

import { JamError, cleanText, LIMITS } from './rooms.js';
import { linkFor, parseLink, soundcloudInfo, spotifyInfo, youtubeInfo, LinkError } from './links.js';

const MAX_IMPORT = 500;

/**
 * allowSpotify: Spotify songs only play inside Spotify, so only Jams hosted by the
 *   plugin accept them.
 * extend(on, me): extra commands for the host (the plugin adds peer-to-peer files).
 * spotifyLookup(uri): song details; inside Spotify the plugin asks Spotify itself.
 * importFile(item): turns an uploaded file in a saved playlist back into a track, or null
 *   (only the plugin can, because its files live on people's computers).
 */
export function registerSocketHandlers(io, store, { allowSpotify = false, extend = null, spotifyLookup = spotifyInfo, importFile = null } = {}) {
  /** A song from a saved playlist or a Spotify list, checked like a pasted link. */
  function importable(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.kind === 'file') return importFile?.(item) ?? null;
    let link;
    try {
      link = parseLink(linkFor(item.kind, item.src));
    } catch {
      return null;
    }
    if (link.kind !== item.kind || (link.kind === 'spotify' && !allowSpotify)) return null;
    return { kind: link.kind, src: link.src, title: item.title || link.title, artist: item.artist, durationSec: item.durationSec, art: item.art };
  }

  const localSockets = () => io.of('/').sockets.values();

  function detach(socket) {
    const { code, memberId } = socket.data;
    if (!code) return;
    socket.leave(code);
    socket.data.code = null;
    socket.data.memberId = null;
    store.disconnect(code, memberId);
  }

  store.on('change', (code, toast) => {
    if (!store.has(code)) return;
    io.to(code).emit('state', store.publicState(code));
    if (toast) io.to(code).emit('toast', toast);
  });

  store.on('ended', ({ code, by }) => {
    for (const socket of localSockets()) {
      if (socket.data.code !== code) continue;
      socket.emit('ended', { by });
      detach(socket);
    }
  });

  store.on('removed', ({ code, memberId }) => {
    for (const socket of localSockets()) {
      if (socket.data.code !== code || socket.data.memberId !== memberId) continue;
      socket.emit('removed');
      detach(socket);
    }
  });

  io.on('connection', (socket) => {
    socket.data.code = null;
    socket.data.memberId = null;

    const on = (event, handler) =>
      socket.on(event, async (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          const result = await handler(payload && typeof payload === 'object' ? payload : {});
          reply({ ok: true, ...result });
        } catch (err) {
          const known = err instanceof JamError || err instanceof LinkError;
          if (!known) console.error(`[${event}]`, err);
          reply({ ok: false, error: known ? err.message : 'Something went wrong', code: known ? err.code : null });
        }
      });

    const me = () => {
      if (!socket.data.code) throw new JamError('not-joined', 'Join a Jam first');
      return [socket.data.code, socket.data.memberId];
    };

    on('time:ping', () => ({ serverNow: Date.now() }));

    // Session lifecycle
    on('room:create', ({ name, avatar, spotifyUser }) => {
      const { room, member } = store.createRoom(name, { avatar, spotifyUser });
      return { code: room.code, token: member.token };
    });
    on('room:peek', ({ code }) => store.peek(code));
    on('room:join', ({ code, token, name, avatar, spotifyUser }) => {
      const { room, member } = store.join(code, { token, name, avatar, spotifyUser });
      detach(socket);
      socket.join(room.code);
      socket.data.code = room.code;
      socket.data.memberId = member.id;
      store.connect(room.code, member.id);
      return { token: member.token, memberId: member.id, state: store.publicState(room.code) };
    });
    on('room:leave', () => {
      const [code, memberId] = me();
      store.leave(code, memberId);
      detach(socket);
    });
    on('room:end', () => void store.endRoom(...me()));
    on('member:remove', ({ memberId }) => void store.removeMember(...me(), memberId));
    on('settings:queueOnlyMode', ({ enabled }) => void store.setQueueOnlyMode(...me(), Boolean(enabled)));

    // Library
    // The Spotify plugin already knows a song's artist and length, so it sends them along.
    on('track:addLink', async ({ url, title, artist, durationSec, art, enqueue }) => {
      const [code, memberId] = me();
      const link = parseLink(url);
      if (link.kind === 'spotify' && !allowSpotify) {
        throw new LinkError("Spotify songs can only play inside Spotify. Start the Jam from the JamRoom Spotify plugin to use them.");
      }
      title = cleanText(title, LIMITS.title);
      let info = { title: link.title, artist: null };
      if (link.kind === 'youtube') {
        info = { ...((await youtubeInfo(link.src)) ?? { title: 'YouTube video', artist: null }), art: `https://i.ytimg.com/vi/${link.src}/hqdefault.jpg` };
      }
      if (link.kind === 'spotify' && (!title || !durationSec)) info = (await spotifyLookup(link.src)) ?? { title: 'Spotify song', artist: null };
      if (link.kind === 'soundcloud') info = (await soundcloudInfo(link.src)) ?? { title: link.src.split('/').pop().replace(/-/g, ' '), artist: null };
      const [track] = store.addTracks(
        code,
        memberId,
        [{
          kind: link.kind,
          src: link.src,
          title: title || info.title,
          artist: cleanText(artist, LIMITS.artist) || info.artist,
          durationSec: durationSec ?? info.durationSec,
          art: art ?? info.art,
        }],
        { enqueue: Boolean(enqueue) },
      );
      return { trackId: track.id };
    });
    // Many songs at once: a saved playlist, or a Spotify album / playlist from the right-click menu.
    on('tracks:import', ({ items, enqueue, playlistName, play, startAt }) => {
      const [code, memberId] = me();
      const songs = (Array.isArray(items) ? items.slice(0, MAX_IMPORT) : []).map(importable).filter(Boolean);
      if (!songs.length) throw new JamError('empty', "None of these songs can be added to this Jam");
      const result = store.importTracks(code, memberId, songs, { enqueue: Boolean(enqueue), playlistName, play: Boolean(play), startAt });
      return { ...result, skipped: (Array.isArray(items) ? Math.min(items.length, MAX_IMPORT) : 0) - songs.length };
    });
    on('track:remove', ({ trackId }) => void store.removeTrack(...me(), trackId));
    on('track:duration', ({ trackId, duration }) => void store.setDuration(...me(), trackId, Number(duration)));

    // Queue
    on('queue:add', ({ trackIds }) => void store.queueAdd(...me(), trackIds));
    on('queue:playNow', ({ trackId }) => void store.queuePlayNow(...me(), trackId));
    on('queue:remove', ({ qid }) => void store.queueRemove(...me(), qid));
    on('queue:clear', () => void store.queueClear(...me()));
    on('queue:move', ({ qid, toIndex }) => void store.queueMove(...me(), qid, toIndex));

    // Player
    on('player:play', () => void store.play(...me()));
    on('player:pause', () => void store.pause(...me()));
    on('player:seek', ({ positionMs }) => void store.seek(...me(), positionMs));
    on('player:next', () => void store.next(...me()));
    on('player:previous', () => void store.previous(...me()));
    on('player:playAt', ({ qid }) => void store.playAt(...me(), qid));
    on('player:ended', ({ playId }) => void store.ended(...me(), playId));

    // Playlists
    on('playlist:create', ({ name }) => ({ playlistId: store.createPlaylist(...me(), name).id }));
    on('playlist:rename', ({ playlistId, name }) => void store.renamePlaylist(...me(), playlistId, name));
    on('playlist:delete', ({ playlistId }) => void store.deletePlaylist(...me(), playlistId));
    on('playlist:addTracks', ({ playlistId, trackIds }) => void store.playlistAdd(...me(), playlistId, trackIds));
    on('playlist:clear', ({ playlistId }) => void store.playlistClear(...me(), playlistId));
    on('playlist:removeAt', ({ playlistId, index }) => void store.playlistRemoveAt(...me(), playlistId, index));
    on('playlist:play', ({ playlistId }) => void store.playlistPlay(...me(), playlistId));
    on('playlist:enqueue', ({ playlistId }) => void store.playlistEnqueue(...me(), playlistId));

    extend?.(on, me);

    socket.on('disconnect', () => detach(socket));
  });
}
