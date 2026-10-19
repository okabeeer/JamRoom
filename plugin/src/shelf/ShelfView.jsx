// Shelf mode: the Jam and your whole Spotify library as a 3D CD shelf (scene.js), with the
// controls drawn on top: a header (mode switch, search, the Jam), the open case's card
// (tracklist and actions) and a now-playing deck with a spinning CD.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { positionAt } from '../../../shared/timing.js';
import { serverNow } from '../../../client/src/lib/clock.js';
import { jamBridge } from '../../../client/src/lib/jamBridge.js';
import { deleteSavedPlaylist, savePlaylist, useSavedPlaylists } from '../../../client/src/lib/savedPlaylists.js';
import { call } from '../api.js';
import { spotifyTracksFor } from '../spotifyMeta.js';
import { imageUrl, loadSpotifyLibrary } from './library.js';
import { ShelfScene } from './scene.js';

const SOURCE = { spotify: 'Spotify', youtube: 'YouTube', soundcloud: 'SoundCloud', file: 'File', 'audio-url': 'Link' };
const SPOTIFY_TYPES = new Set(['spotify-album', 'spotify-playlist', 'spotify-liked']);

const useJam = () => useSyncExternalStore(jamBridge.subscribe, jamBridge.get);

const SETTINGS_KEY = 'jamroom:shelf';
const LOOK_NAMES = { walnut: 'Walnut', birch: 'Birch', ebony: 'Ebony neon' };
const QUALITY_NAMES = { high: 'High', medium: 'Medium', low: 'Low (slower PCs)' };

function loadSettings() {
  try {
    return { look: 'walnut', quality: 'high', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { look: 'walnut', quality: 'high' };
  }
}

const safe = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/**
 * What the TV corner follows: the Jam's song, or (outside a Jam) whatever your own Spotify
 * plays. { key, uri (Spotify track or null), title, art, position() }
 */
function useNowPlaying(room) {
  const [own, setOwn] = useState(null);
  useEffect(() => {
    const read = () => {
      const item = safe(() => window.Spicetify.Player.data?.item);
      setOwn((prev) =>
        prev?.uri === item?.uri
          ? prev
          : item?.uri
            ? { uri: item.uri, title: item.name, artist: item.artists?.map((a) => a.name).join(', '), durationSec: item.duration?.milliseconds / 1000, art: imageUrl(item.images) }
            : null,
      );
    };
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, []);

  return useMemo(() => {
    // the Jam's song when it has one; otherwise what your own Spotify plays
    const p = room?.player;
    const item = p && p.index >= 0 && !p.finished ? room.queue[p.index] : null;
    const track = item ? room.tracks[item.trackId] : null;
    if (track) {
      const durMs = track.duration ? track.duration * 1000 : null;
      return {
        key: p.playId,
        uri: track.kind === 'spotify' ? track.src : null,
        title: track.title,
        artist: track.artist,
        durationSec: track.duration,
        art: trackArt(track),
        position: () => positionAt(p, serverNow(), durMs),
      };
    }
    if (!own) return null;
    return {
      key: own.uri,
      uri: own.uri.startsWith('spotify:track:') ? own.uri : null,
      title: own.title,
      artist: own.artist,
      durationSec: own.durationSec,
      art: own.art,
      position: () => safe(() => window.Spicetify.Player.getProgress(), 0),
    };
  }, [room, own]);
}

function trackArt(t) {
  if (!t) return null;
  if (t.art) return t.art;
  if (t.kind === 'youtube') return `https://i.ytimg.com/vi/${t.src}/hqdefault.jpg`;
  return null;
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '–:––';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Avatar({ member, size = 26 }) {
  const [broken, setBroken] = useState(false);
  if (member.avatar && !broken) return <img className="sh-avatar" src={member.avatar} alt={member.name} title={member.name} width={size} height={size} onError={() => setBroken(true)} />;
  return (
    <span className="sh-avatar sh-initial" title={member.name} style={{ width: size, height: size }}>
      {member.name.charAt(0).toUpperCase()}
    </span>
  );
}

/** The shelf's rows from the Jam, your saved playlists and your Spotify library. */
function useRows(room, saved, library) {
  return useMemo(() => {
    const jam = [];
    if (room) {
      const p = room.player;
      const from = Math.max(0, p.index);
      room.queue.slice(from).forEach((q, i) => {
        const t = room.tracks[q.trackId];
        if (!t) return;
        jam.push({
          key: `q:${q.qid}`,
          type: 'jam-track',
          qid: q.qid,
          track: t,
          title: t.title,
          subtitle: t.artist ?? SOURCE[t.kind] ?? '',
          art: trackArt(t),
          nowPlaying: i === 0 && p.index >= 0 && p.isPlaying && !p.finished,
        });
      });
    }
    const playlists = [];
    for (const pl of room?.playlists ?? []) {
      const first = pl.trackIds.map((id) => room.tracks[id]).find(Boolean);
      playlists.push({ key: `jp:${pl.id}`, type: 'jam-playlist', playlist: pl, title: pl.name, subtitle: `${pl.trackIds.length} songs · this Jam`, art: trackArt(first) });
    }
    for (const pl of saved) {
      playlists.push({ key: `sv:${pl.id}`, type: 'saved', saved: pl, title: pl.name, subtitle: `${pl.items.length} songs · Your playlist`, art: pl.items.find((i) => i.art)?.art ?? null });
    }
    playlists.push(...library.playlists);
    return [
      { id: 'jam', label: 'In the Jam', items: jam, emptyText: room ? 'The queue is empty: open a case below and play it' : 'Start a Jam to put its songs on this shelf' },
      { id: 'playlists', label: 'Playlists', items: playlists },
      { id: 'albums', label: 'Albums', items: library.albums },
    ];
  }, [room, saved, library]);
}

/** What a playlist case holds, so its card and booklet refresh when songs come or go. */
const contentOf = (item) => (item?.type === 'jam-playlist' ? item.playlist.trackIds.join() : item?.type === 'saved' ? item.saved.items.length : '');

export default function ShelfView({ visible, onSimple, onClose, onPanel }) {
  const jam = useJam();
  const { room } = jam;
  const saved = useSavedPlaylists();
  const [library, setLibrary] = useState({ albums: [], playlists: [] });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [tracks, setTracks] = useState(null);
  const [settings, setSettings] = useState(loadSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [section, setSection] = useState(0);
  const [hover, setHover] = useState(null); // { item, x, y } for the label next to the pointer
  const [lyricInfo, setLyricInfo] = useState(null); // { source, synced } of what the whiteboard shows
  const [lyricOffset, setLyricOffset] = useState(0);
  const [menu, setMenu] = useState(null); // the right-click menu: { target, x, y }
  const rootRef = useRef(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const nowPlaying = useNowPlaying(room);
  const [toasts, setToasts] = useState([]);
  const hostRef = useRef(null);
  const sceneRef = useRef(null);
  const rows = useRows(room, saved, library);

  const toast = useCallback((text) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  // the library refreshes whenever the shelf opens
  useEffect(() => {
    if (visible) loadSpotifyLibrary().then(setLibrary);
  }, [visible]);

  const actionsRef = useRef(null);
  useEffect(() => {
    const scene = new ShelfScene(hostRef.current, {
      onSelect: (item) => setSelected(item),
      onDeselect: () => setSelected(null),
      onDisc: (item) => actionsRef.current?.primary(item, tracksRef.current),
      onTrack: (item, index) => actionsRef.current?.playFrom(item, tracksRef.current ?? [], index),
      onSection: setSection,
      onHover: (item) => setHover(item ? { item, ...pointerRef.current } : null),
      onMenu: (target, at) => openMenuRef.current(target, at),
      onLyrics: (info) => {
        setLyricInfo(info);
        setLyricOffset(0);
      },
      look: settings.look,
      quality: settings.quality,
    });
    sceneRef.current = scene;
    return () => scene.dispose();
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (visible) scene.start();
    else scene.stop();
  }, [visible]);

  useEffect(() => sceneRef.current?.setRows(rows), [rows]);
  // the open case follows changes to what it holds (a song removed, the playlist emptied)
  useEffect(() => {
    if (!selected) return;
    const fresh = rows.flatMap((r) => r.items).find((i) => i.key === selected.key);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => sceneRef.current?.setNowPlaying(nowPlaying), [nowPlaying]);
  useEffect(() => {
    sceneRef.current?.setLook(settings.look);
    sceneRef.current?.setQuality(settings.quality);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // not remembered
    }
  }, [settings]);

  // the open case's tracklist: printed in its booklet and listed in the card
  const tracksRef = useRef(null);
  useEffect(() => {
    tracksRef.current = null;
    setTracks(null);
    if (!selected) return undefined;
    let cancelled = false;
    actionsRef.current.tracksOf(selected).then(
      (t) => {
        if (cancelled) return;
        tracksRef.current = t;
        setTracks(t);
        sceneRef.current?.setBooklet(selected.key, t);
      },
      () => !cancelled && setTracks([]),
    );
    return () => {
      cancelled = true;
    };
  }, [selected?.key, contentOf(selected)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => sceneRef.current?.setFilter(query), [query]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || !visible) return;
      if (menuRef.current) setMenu(null);
      else sceneRef.current?.deselect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  const actions = useActions(jam, toast, onPanel);
  actionsRef.current = actions;

  const menuRef = useRef(null);
  menuRef.current = menu;
  // the menu is opened from the scene's callbacks (made once), so it reads the latest state through refs
  function openMenu(target, at) {
    const r = rootRef.current.getBoundingClientRect();
    setHover(null);
    setMenu({ target, x: at.x - r.left, y: at.y - r.top });
  }
  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;

  const host = room?.members.find((m) => m.id === room.hostId);

  return (
    <div
      className="sh-root"
      ref={rootRef}
      onPointerDownCapture={(e) => {
        if (menu && !e.target.closest?.('.sh-ctx')) setMenu(null);
      }}
      onWheel={() => menu && setMenu(null)}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        pointerRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
        if (hover) setHover((h) => (h ? { ...h, ...pointerRef.current } : h));
      }}
    >
      <div className="sh-canvas" ref={hostRef} />
      {hover && hover.item.key !== selected?.key && (
        <div className="sh-tip" style={{ left: hover.x + 18, top: hover.y + 18 }}>
          {hover.item.art ? <img src={hover.item.art} alt="" /> : <span className="sh-noart">♪</span>}
          <span>
            <b>{hover.item.title}</b>
            <small>{hover.item.subtitle}</small>
            <em>Click to open · right-click for more</em>
          </span>
        </div>
      )}

      <header className="sh-header">
        <div className="sh-brand">
          <span className="sh-mark">◉</span> JamRoom
        </div>
        <div className="sh-modes" role="tablist" aria-label="View">
          <button role="tab" aria-selected="false" onClick={onSimple}>Simple</button>
          <button role="tab" aria-selected="true" className="on">Shelf</button>
        </div>
        <label className="sh-search">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a disc" aria-label="Find a disc" />
        </label>
        <div className="sh-settings">
          <button className="sh-icon" aria-label="Shelf settings" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>⚙</button>
          {menuOpen && (
            <div className="sh-menu" role="dialog" aria-label="Shelf settings">
              <p>Look</p>
              <div className="sh-choices">
                {Object.entries(LOOK_NAMES).map(([id, name]) => (
                  <button key={id} className={settings.look === id ? 'on' : ''} onClick={() => setSettings((v) => ({ ...v, look: id }))}>{name}</button>
                ))}
              </div>
              <p>Quality</p>
              <div className="sh-choices">
                {Object.entries(QUALITY_NAMES).map(([id, name]) => (
                  <button key={id} className={settings.quality === id ? 'on' : ''} onClick={() => setSettings((v) => ({ ...v, quality: id }))}>{name}</button>
                ))}
              </div>
              <button className="sh-btn sh-wide" onClick={() => { setMenuOpen(false); onClose(); }}>Back to normal Spotify</button>
            </div>
          )}
        </div>
        <button className="sh-btn sh-panel-btn" onClick={onPanel} title="The Jam panel: add songs by link or file, queue, playlists, people, settings">☰ Jam panel</button>
        <div className="sh-jam">
          {room ? (
            <>
              <div className="sh-faces">
                {room.members.filter((m) => m.online).slice(0, 6).map((m) => (
                  <Avatar key={m.id} member={m} />
                ))}
              </div>
              <div className="sh-jam-text">
                <strong>{host ? `${host.name}'s Jam` : 'Jam'}</strong>
                <span>code {jam.code}</span>
              </div>
            </>
          ) : (
            <button className="sh-btn sh-primary" onClick={onPanel}>Start or join a Jam</button>
          )}
        </div>
      </header>

      {selected && (
        <CaseCard
          key={selected.key}
          item={selected}
          tracks={tracks}
          jam={jam}
          actions={actions}
          onClose={() => sceneRef.current?.deselect()}
          onMenu={(target, e) => {
            e.preventDefault();
            openMenu(target, { x: e.clientX, y: e.clientY });
          }}
        />
      )}
      <button className="sh-nav" onClick={() => sceneRef.current?.goTo(section ? 0 : 1)}>{section ? '↑ Back to the shelf' : 'TV corner ↓'}</button>
      {section === 1 && lyricInfo?.synced && (
        <div className="sh-timing" aria-label="Lyrics timing">
          <span>Lyrics {lyricOffset ? `${lyricOffset > 0 ? '+' : ''}${(lyricOffset / 1000).toFixed(1)} s` : 'in time?'}</span>
          <button title="Show the lyrics earlier" onClick={() => setLyricOffset(sceneRef.current.nudgeLyrics(-500))}>− 0.5 s</button>
          <button title="Show the lyrics later" onClick={() => setLyricOffset(sceneRef.current.nudgeLyrics(500))}>+ 0.5 s</button>
        </div>
      )}
      <Deck jam={jam} actions={actions} />
      {menu && <ShelfMenu menu={menu} entries={menuEntries(menu.target, actions, tracksRef.current)} onClose={() => setMenu(null)} />}

      <p className="sh-hint">Click a case to open it · click a song in the booklet, or the disc, to play · right-click a song or case for more · wheel: TV corner · Shift+wheel or drag: scroll a row</p>
      <div className="sh-toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className="sh-toast">{t.text}</div>
        ))}
      </div>
    </div>
  );
}

/** What you can do with what's on the shelf. */
function useActions(jam, toast, onPanel) {
  const joined = !!jam.room;
  const room = jam.room;
  const mine = (pl) => pl.createdBy === jam.memberId || room?.hostId === jam.memberId;
  const run = async (fn, done) => {
    try {
      await fn();
      if (done) toast(done);
    } catch (err) {
      toast(err.message || 'That didn’t work');
    }
  };
  const importTracks = (tracks, opts) =>
    call('tracks:import', {
      items: tracks.map((t) => ({ kind: t.kind ?? 'spotify', src: t.src ?? t.uri, title: t.title, artist: t.artist, durationSec: t.durationSec, art: t.art })),
      ...opts,
    });

  const tracksOf = async (item) => {
    if (SPOTIFY_TYPES.has(item.type)) return (await spotifyTracksFor([item.uri])).tracks.map((t) => ({ ...t, kind: 'spotify', src: t.uri }));
    if (item.type === 'saved') return item.saved.items;
    if (item.type === 'jam-playlist') return item.playlist.trackIds.map((id) => jam.room?.tracks[id]).filter(Boolean).map((t) => ({ ...t, durationSec: t.duration }));
    if (item.type === 'jam-track') return [{ ...item.track, durationSec: item.track.duration }];
    return [];
  };

  function actionsKeep(item, tracks) {
    const res = savePlaylist(item.title, tracks.map((t) => ({ ...t, duration: t.durationSec ?? t.duration })));
    toast(res.saved ? `${res.replaced ? 'Updated' : 'Kept'} “${item.title}” in Your playlists` : 'Nothing to keep');
  }

  return {
    joined,
    canControl: jam.canControl,
    tracksOf,
    openPanel: onPanel,
    // may this member take this song out of the queue (their own upcoming songs, or anything with control)
    canRemove: (item) => {
      if (jam.canControl) return true;
      const q = room?.queue.find((x) => x.qid === item.qid);
      return !!q && q.addedBy === jam.memberId && room.queue.indexOf(q) !== room.player.index;
    },
    canEdit: (item) => item.type === 'saved' || (item.type === 'jam-playlist' && mine(item.playlist)),
    addToLibrary: (track) => run(() => importTracks([track], {}), `${track.title} is in the Jam library`),
    enqueueCase: async (item) => {
      if (item.type === 'jam-playlist') return run(() => call('playlist:enqueue', { playlistId: item.playlist.id }), `Added ${item.title} to the queue`);
      const tracks = await tracksOf(item);
      return run(() => importTracks(tracks, { playlistName: tracks.length > 1 ? item.title : null, enqueue: true }), `Added ${item.title} to the queue`);
    },
    libraryCase: async (item) => {
      const tracks = await tracksOf(item);
      return run(() => importTracks(tracks, { playlistName: item.title }), `${item.title} is in the Jam library`);
    },
    keepCase: async (item) => actionsKeep(item, await tracksOf(item)),
    removeFromPlaylist: (item, index) => run(() => call('playlist:removeAt', { playlistId: item.playlist.id, index }), 'Removed from the playlist'),
    clearQueue: () => run(() => call('queue:clear'), 'Cleared the queue'),
    clearPlaylist: (item) => run(() => call('playlist:clear', { playlistId: item.playlist.id }), `Emptied ${item.title}`),
    deletePlaylist: (item) => {
      if (item.type === 'saved') {
        deleteSavedPlaylist(item.saved.id);
        return toast(`Deleted “${item.title}” from Your playlists`);
      }
      return run(() => call('playlist:delete', { playlistId: item.playlist.id }), `Deleted ${item.title}`);
    },
    spotifyQueue: (track) => run(() => window.Spicetify.addToQueue([{ uri: track.uri ?? track.src }]), `Added ${track.title} to your Spotify queue`),
    playOnSpotifyOnly: (track) => run(() => window.Spicetify.Player.playUri(track.uri ?? track.src), `Playing ${track.title} on Spotify`),
    primary: async (item, tracks) => {
      if (item.type === 'jam-track') return run(() => call('player:playAt', { qid: item.qid }));
      if (item.type === 'jam-playlist') return run(() => call('playlist:play', { playlistId: item.playlist.id }));
      if (!joined) {
        if (SPOTIFY_TYPES.has(item.type)) return run(() => window.Spicetify.Player.playUri(item.uri), `Playing ${item.title} on Spotify`);
        toast('Start or join a Jam to play this together');
        return onPanel();
      }
      const list = tracks ?? (await tracksOf(item));
      return run(() => importTracks(list, { playlistName: item.title, play: jam.canControl, enqueue: !jam.canControl }), jam.canControl ? `Playing ${item.title} in the Jam` : `Added ${item.title} to the queue`);
    },
    enqueue: (item, tracks) => run(() => importTracks(tracks, { playlistName: tracks.length > 1 ? item.title : null, enqueue: true }), `Added to the Jam queue`),
    library: (item, tracks) => run(() => importTracks(tracks, { playlistName: item.title }), `${item.title} is in the Jam library`),
    keep: (item, tracks) => actionsKeep(item, tracks),
    playOnSpotify: (item) => run(() => window.Spicetify.Player.playUri(item.uri), `Playing ${item.title} on Spotify`),
    remove: (item) => run(() => call('queue:remove', { qid: item.qid }), 'Removed from the queue'),
    playTrack: (track) => run(() => importTracks([track], { enqueue: true }), `Added ${track.title} to the queue`),
    // a song clicked in the booklet: the album or playlist plays from there
    playFrom: (item, list, index) => {
      const track = list[index];
      if (!track) return;
      if (item.type === 'jam-track') return run(() => call('player:playAt', { qid: item.qid }));
      if (!joined) {
        if (!SPOTIFY_TYPES.has(item.type)) {
          toast('Start or join a Jam to play this together');
          return onPanel();
        }
        return run(async () => {
          try {
            await window.Spicetify.Platform.PlayerAPI.play({ uri: item.uri }, {}, { skipTo: { uri: track.uri ?? track.src, index } });
          } catch {
            await window.Spicetify.Player.playUri(track.uri ?? track.src);
          }
        }, `Playing ${track.title} on Spotify`);
      }
      if (!jam.canControl) return run(() => importTracks([track], { enqueue: true }), `Added ${track.title} to the queue`);
      return run(() => importTracks(list, { playlistName: item.title, play: true, startAt: index }), `Playing ${track.title} in the Jam`);
    },
  };

}

function CaseCard({ item, tracks, jam, actions, onClose, onMenu }) {
  const spotify = SPOTIFY_TYPES.has(item.type);
  const totalMs = (tracks ?? []).reduce((s, t) => s + (t.durationSec ?? 0) * 1000, 0);
  const primaryLabel =
    item.type === 'jam-track' ? 'Play now' : item.type === 'jam-playlist' ? 'Play in the Jam' : actions.joined ? (actions.canControl ? 'Play in the Jam' : 'Add to the Jam queue') : spotify ? 'Play on Spotify' : 'Start a Jam to play';

  return (
    <aside className="sh-card" aria-label={item.title}>
      <button className="sh-close" onClick={onClose} aria-label="Put it back">✕</button>
      <div className="sh-card-head">
        {item.art ? <img src={item.art} alt="" /> : <div className="sh-noart">♪</div>}
        <div>
          <h2>{item.title}</h2>
          <p>{item.subtitle}</p>
          <p className="sh-muted">{tracks ? `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}${totalMs ? ` · ${formatTime(totalMs)}` : ''}` : 'Reading the tracklist…'}</p>
        </div>
      </div>
      <div className="sh-actions">
        <button className="sh-btn sh-primary" disabled={!tracks} onClick={() => actions.primary(item, tracks)}>▶ {primaryLabel}</button>
        {actions.joined && item.type !== 'jam-track' && <button className="sh-btn" disabled={!tracks?.length} onClick={() => actions.enqueue(item, tracks)}>+ Queue</button>}
        {actions.joined && spotify && <button className="sh-btn" disabled={!tracks?.length} onClick={() => actions.library(item, tracks)}>Add to Jam library</button>}
        {(item.type === 'jam-playlist' || (spotify && actions.joined)) && <button className="sh-btn" disabled={!tracks?.length} onClick={() => actions.keep(item, tracks)}>Keep in Your playlists</button>}
        {spotify && actions.joined && <button className="sh-btn" onClick={() => actions.playOnSpotify(item)}>Play on Spotify only</button>}
        {item.type === 'jam-track' && actions.canRemove(item) && <button className="sh-btn" onClick={() => actions.remove(item)}>Remove from queue</button>}
        {item.type === 'jam-track' && actions.canControl && (
          <Confirm confirmText="Click again to clear the queue" onConfirm={actions.clearQueue}>Clear the queue</Confirm>
        )}
        {item.type === 'jam-playlist' && actions.canEdit(item) && tracks?.length > 0 && (
          <Confirm confirmText={`Click again to remove all ${tracks.length}`} onConfirm={() => actions.clearPlaylist(item)}>Remove all songs</Confirm>
        )}
        {actions.canEdit(item) && (
          <Confirm confirmText="Click again to delete it" onConfirm={() => actions.deletePlaylist(item)}>
            {item.type === 'saved' ? 'Delete from Your playlists' : 'Delete playlist'}
          </Confirm>
        )}
      </div>
      <ol className="sh-tracks">
        {(tracks ?? []).slice(0, 300).map((t, i) => (
          <li key={`${t.src ?? t.uri}-${i}`} onContextMenu={(e) => onMenu({ item, index: i }, e)}>
            <span className="sh-n">{i + 1}</span>
            <span className="sh-t">
              <b>{t.title}</b>
              <small>{t.artist ?? ''}</small>
            </span>
            <span className="sh-d">{formatTime((t.durationSec ?? 0) * 1000)}</span>
            {actions.joined && item.type !== 'jam-track' && (
              <button className="sh-add" title="Add this song to the Jam queue" onClick={() => actions.playTrack(t)}>+</button>
            )}
          </li>
        ))}
      </ol>
      <p className="sh-muted sh-note">Right-click a song for more.</p>
      {!actions.joined && <p className="sh-muted sh-note">Not in a Jam: the disc plays on your Spotify. Start or join a Jam to play it together.</p>}
      {jam.room && !jam.canControl && <p className="sh-muted sh-note">The host locked playback, so songs go to the queue.</p>}
    </aside>
  );
}

function Deck({ jam, actions }) {
  const { room, listening, playback } = jam;
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!room) return null;
  const p = room.player;
  const item = p.index >= 0 ? room.queue[p.index] : null;
  const track = item ? room.tracks[item.trackId] : null;
  const durMs = track?.duration ? track.duration * 1000 : null;
  const pos = track ? positionAt(p, serverNow(), durMs) : 0;
  const playing = !!track && p.isPlaying && !p.finished;
  const art = trackArt(track);
  const status = !listening ? 'Not playing here' : playback?.status === 'playing' && playback.driftMs != null ? `In sync · ${Math.abs(playback.driftMs)} ms` : playback?.status === 'blocked' ? 'Click to allow audio' : 'Listening along';
  const can = jam.canControl;
  const act = (event, payload) => call(event, payload).catch(() => {});

  return (
    <section className="sh-deck" aria-label="Now playing">
      <div className={`sh-disc ${playing ? 'spin' : ''}`} style={art ? { backgroundImage: `url("${art}")` } : undefined} />
      <div className="sh-deck-body">
        <div className="sh-now">
          <b title={track?.title}>{track?.title ?? 'Nothing playing'}</b>
          <small>{track ? `${track.artist ?? ''}${track.artist ? ' · ' : ''}${SOURCE[track.kind] ?? ''}` : 'Pull a disc off the shelf'}</small>
        </div>
        <div className="sh-bar">
          <span style={{ width: durMs ? `${Math.min(100, (pos / durMs) * 100)}%` : 0 }} />
        </div>
        <div className="sh-controls">
          <button disabled={!track || !can} onClick={() => act('player:previous')} aria-label="Previous">⏮</button>
          <button className="sh-play" disabled={!room.queue.length || !can} onClick={() => act(playing ? 'player:pause' : 'player:play')} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button disabled={!track || !can} onClick={() => act('player:next')} aria-label="Next">⏭</button>
          <button className={`sh-btn sh-listen ${listening ? 'on' : 'sh-primary'}`} onClick={() => jam.toggleListening?.()}>
            {listening ? 'Stop listening' : 'Listen along'}
          </button>
          <span className="sh-muted">{status}</span>
          {can && room.queue.length > (p.index >= 0 && !p.finished ? 1 : 0) && (
            <Confirm className="sh-btn sh-small sh-push" confirmText="Click again" onConfirm={actions.clearQueue} title="Remove every song from the queue (the one playing keeps playing)">
              Clear queue
            </Confirm>
          )}
        </div>
      </div>
    </section>
  );
}

/** A button that asks for a second click before doing something that can't be undone. */
function Confirm({ children, confirmText, onConfirm, className = 'sh-btn', ...rest }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`${className} ${armed ? 'sh-danger' : ''}`}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
      {...rest}
    >
      {armed ? confirmText : children}
    </button>
  );
}

const isSpotify = (t) => String(t?.uri ?? t?.src ?? '').startsWith('spotify:');

/**
 * The right-click menu's entries for a song (target.index) or a whole case.
 * Each entry: { label, run, confirm? (asks for a second click), danger? } or '-' (a divider).
 */
function menuEntries({ item, index }, actions, list) {
  const track = index != null ? list?.[index] : null;
  const notJoined = { label: 'Start or join a Jam…', run: actions.openPanel };
  const out = [];
  if (item.type === 'jam-track') {
    if (actions.canControl && !item.nowPlaying) out.push({ label: '▶ Play now', run: () => actions.primary(item) });
    if (actions.canRemove(item)) out.push({ label: 'Remove from the queue', run: () => actions.remove(item) });
    if (actions.canControl) out.push('-', { label: 'Clear the queue', confirm: 'Click again to clear the queue', danger: true, run: actions.clearQueue });
    return out;
  }
  if (track) {
    if (actions.joined) {
      if (actions.canControl) out.push({ label: '▶ Play from here', run: () => actions.playFrom(item, list, index) });
      out.push({ label: '+ Add to the Jam queue', run: () => actions.playTrack(track) });
      if (item.type !== 'jam-playlist') out.push({ label: 'Add to the Jam library', run: () => actions.addToLibrary(track) });
      if (item.type === 'jam-playlist') out.push({ label: 'Remove from this playlist', danger: true, run: () => actions.removeFromPlaylist(item, index) });
      if (isSpotify(track)) out.push('-', { label: 'Play on Spotify only', run: () => actions.playOnSpotifyOnly(track) });
    } else if (isSpotify(track)) {
      out.push({ label: '▶ Play from here', run: () => actions.playFrom(item, list, index) });
      out.push({ label: '+ Add to your Spotify queue', run: () => actions.spotifyQueue(track) }, '-', notJoined);
    } else {
      out.push(notJoined);
    }
    return out;
  }
  // a whole case
  const spotify = SPOTIFY_TYPES.has(item.type);
  if (actions.joined) {
    if (actions.canControl) out.push({ label: '▶ Play in the Jam', run: () => actions.primary(item) });
    out.push({ label: '+ Add all to the Jam queue', run: () => actions.enqueueCase(item) });
    if (spotify) out.push({ label: 'Add to the Jam library', run: () => actions.libraryCase(item) });
    if (spotify || item.type === 'jam-playlist') out.push({ label: 'Keep in Your playlists', run: () => actions.keepCase(item) });
  } else if (spotify) {
    out.push({ label: '▶ Play on Spotify', run: () => actions.primary(item) }, '-', notJoined);
  } else {
    out.push(notJoined);
  }
  if (item.type === 'jam-playlist' && actions.canEdit(item) && item.playlist.trackIds.length) {
    out.push('-', { label: 'Remove all songs', confirm: `Click again to remove all ${item.playlist.trackIds.length}`, danger: true, run: () => actions.clearPlaylist(item) });
  }
  if (actions.canEdit(item)) {
    out.push(item.type === 'jam-playlist' && item.playlist.trackIds.length ? null : '-', {
      label: item.type === 'saved' ? 'Delete from Your playlists' : 'Delete playlist',
      confirm: 'Click again to delete it',
      danger: true,
      run: () => actions.deletePlaylist(item),
    });
  }
  return out.filter(Boolean);
}

function ShelfMenu({ menu, entries, onClose }) {
  const ref = useRef(null);
  const [armed, setArmed] = useState(-1);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  // keep it on screen: flip left / up when it would run off the edge
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el.parentElement.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: menu.x + w > box.width - 8 ? Math.max(8, menu.x - w) : menu.x,
      top: menu.y + h > box.height - 8 ? Math.max(8, menu.y - h) : menu.y,
    });
  }, [menu.x, menu.y]);
  const { item, index } = menu.target;
  const title = index != null ? null : item.title;
  if (!entries.length) return null;
  return (
    <div className="sh-ctx" ref={ref} role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {title && <p>{title}</p>}
      {entries.map((e, i) =>
        e === '-' ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={e.danger ? 'danger' : ''}
            onClick={() => {
              if (e.confirm && armed !== i) return setArmed(i);
              onClose();
              e.run();
            }}
          >
            {e.confirm && armed === i ? e.confirm : e.label}
          </button>
        ),
      )}
    </div>
  );
}
