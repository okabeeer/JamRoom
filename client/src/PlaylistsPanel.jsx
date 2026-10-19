import { useState } from 'react';
import { useJam } from './Jam.jsx';
import { deleteSavedPlaylist, savePlaylist, useSavedPlaylists } from './lib/savedPlaylists.js';
import { ConfirmButton, IconButton, formatTime } from './ui.jsx';

export default function PlaylistsPanel() {
  const { room, act } = useJam();
  const [name, setName] = useState('');

  async function create(e) {
    e.preventDefault();
    if (await act('playlist:create', { name: name.trim() })) setName('');
  }

  return (
    <section className="card" aria-labelledby="playlists-title">
      <div className="card-head">
        <h2 id="playlists-title">Playlists</h2>
      </div>
      <form className="row" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New playlist name" aria-label="New playlist name" maxLength={60} />
        <button className="btn" disabled={!name.trim()}>Create</button>
      </form>
      {room.playlists.length === 0 ? (
        <p className="empty">Make a playlist, then add songs to it from the library with “+ Playlist”.</p>
      ) : (
        <ul className="list">
          {room.playlists.map((pl) => (
            <Playlist key={pl.id} playlist={pl} />
          ))}
        </ul>
      )}
      <SavedPlaylists />
    </section>
  );
}

function Playlist({ playlist }) {
  const { room, memberId, isHost, canControl, act, toast } = useJam();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(playlist.name);
  const tracks = playlist.trackIds.map((id) => room.tracks[id]).filter(Boolean);
  const totalMs = tracks.reduce((sum, t) => sum + (t.duration ?? 0) * 1000, 0);
  const canDelete = playlist.createdBy === memberId || isHost;

  async function rename(e) {
    e.preventDefault();
    if (draft.trim() && draft.trim() !== playlist.name) await act('playlist:rename', { playlistId: playlist.id, name: draft.trim() });
    setEditing(false);
  }

  function save() {
    const { saved, replaced, skipped } = savePlaylist(playlist.name, tracks);
    const note = skipped ? ` (${skipped} uploaded ${skipped === 1 ? 'file' : 'files'} can't be kept here)` : '';
    toast(saved ? `${replaced ? 'Updated' : 'Saved'} “${playlist.name}” in your playlists${note}` : `Nothing to save${note}`);
  }

  return (
    <li className="playlist">
      <div className="row-item">
        {editing ? (
          <form className="row grow" onSubmit={rename}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} aria-label="Playlist name" autoFocus onBlur={rename} />
          </form>
        ) : (
          <button className="row-main" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span className="row-title">{playlist.name}</span>
            <span className="row-sub">
              {tracks.length} {tracks.length === 1 ? 'song' : 'songs'}
              {totalMs > 0 && ` · ${formatTime(totalMs)}`}
            </span>
          </button>
        )}
        <span className="row-actions always">
          {canControl && <IconButton icon="play" label="Play playlist (replaces the queue)" size={16} disabled={!tracks.length} onClick={() => act('playlist:play', { playlistId: playlist.id })} />}
          <IconButton icon="queue" label="Add playlist to queue" size={16} disabled={!tracks.length} onClick={() => act('playlist:enqueue', { playlistId: playlist.id })} />
          <IconButton icon="save" label="Save to your playlists (keep it for future Jams)" size={16} disabled={!tracks.length} onClick={save} />
          <IconButton icon="edit" label="Rename" size={16} onClick={() => { setDraft(playlist.name); setEditing(true); }} />
          {canDelete && <IconButton icon="trash" label="Delete playlist" size={16} onClick={() => act('playlist:delete', { playlistId: playlist.id })} />}
        </span>
      </div>
      {open && (
        <ol className="list nested">
          {!tracks.length && <li className="empty">Empty. Use “+ Playlist” on a library song.</li>}
          {canDelete && tracks.length > 1 && (
            <li className="row-item">
              <ConfirmButton confirmText={`Click again to remove all ${tracks.length} songs`} onConfirm={() => act('playlist:clear', { playlistId: playlist.id })}>
                Remove all songs
              </ConfirmButton>
            </li>
          )}
          {playlist.trackIds.map((id, i) => {
            const t = room.tracks[id];
            if (!t) return null;
            return (
              <li key={`${id}-${i}`} className="row-item">
                <span className="row-index">{i + 1}</span>
                <div className="row-main static">
                  <span className="row-title">{t.title}</span>
                  <span className="row-sub">{t.artist ?? ' '}</span>
                </div>
                <IconButton icon="trash" label="Remove from playlist" size={14} onClick={() => act('playlist:removeAt', { playlistId: playlist.id, index: i })} />
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

/** Playlists kept on this device across Jams (lib/savedPlaylists.js). */
function SavedPlaylists() {
  const saved = useSavedPlaylists();
  return (
    <>
      <div className="card-head">
        <h2>Your playlists</h2>
        <span className="muted">kept on this device</span>
      </div>
      {saved.length === 0 ? (
        <p className="empty">Use the bookmark on a playlist above to keep it. Then play it in any Jam.</p>
      ) : (
        <ul className="list">
          {saved.map((pl) => (
            <SavedPlaylist key={pl.id} playlist={pl} />
          ))}
        </ul>
      )}
    </>
  );
}

function SavedPlaylist({ playlist }) {
  const { canControl, act, toast } = useJam();
  const [confirming, setConfirming] = useState(false);
  const totalMs = playlist.items.reduce((sum, t) => sum + (t.durationSec ?? 0) * 1000, 0);

  async function load(how) {
    const res = await act('tracks:import', { items: playlist.items, playlistName: playlist.name, ...how });
    if (res?.skipped) toast(`${res.skipped} ${res.skipped === 1 ? "song couldn't" : "songs couldn't"} be added to this Jam`);
  }

  function remove() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    deleteSavedPlaylist(playlist.id);
    toast(`Deleted “${playlist.name}” from your playlists`);
  }

  return (
    <li className="playlist">
      <div className="row-item">
        <div className="row-main static">
          <span className="row-title">{playlist.name}</span>
          <span className="row-sub">
            {playlist.items.length} {playlist.items.length === 1 ? 'song' : 'songs'}
            {totalMs > 0 && ` · ${formatTime(totalMs)}`}
          </span>
        </div>
        <span className="row-actions always">
          {canControl && <IconButton icon="play" label="Play in this Jam (replaces the queue)" size={16} onClick={() => load({ play: true })} />}
          <IconButton icon="queue" label="Add to this Jam's queue" size={16} onClick={() => load({ enqueue: true })} />
          <IconButton icon="trash" label={confirming ? 'Click again to delete it for good' : 'Delete from your playlists'} size={16} className={confirming ? 'danger' : ''} onClick={remove} />
        </span>
      </div>
    </li>
  );
}
