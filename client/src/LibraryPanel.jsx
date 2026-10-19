import { useMemo, useRef, useState } from 'react';
import { uploadFiles } from './lib/api.js';
import { linkPlaceholder, maxUploadMb as MAX_UPLOAD_MB } from './lib/platform.js';
import * as storage from './lib/storage.js';
import { useJam } from './Jam.jsx';
import { Icon, IconButton, SOURCE_LABEL, formatTime } from './ui.jsx';

const ACCEPT = '.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.flac,.webm,.weba,audio/*';

export default function LibraryPanel() {
  const { room, memberId, isHost, canControl, act, member } = useJam();
  const [query, setQuery] = useState('');

  const tracks = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return Object.values(room.tracks)
      .filter((t) => {
        if (!words.length) return true;
        const hay = `${t.title} ${t.artist ?? ''} ${member(t.addedBy)?.name ?? ''} ${SOURCE_LABEL[t.kind]}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => b.addedAt - a.addedAt);
  }, [room.tracks, query, member]);

  const total = Object.keys(room.tracks).length;

  return (
    <section className="card" aria-labelledby="library-title">
      <div className="card-head">
        <h2 id="library-title">Library</h2>
        <span className="muted">{total} {total === 1 ? 'song' : 'songs'}</span>
      </div>
      <AddMusic />
      {total > 0 && (
        <label className="search">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the library" aria-label="Search the library" />
        </label>
      )}
      {total === 0 ? (
        <p className="empty">No songs yet. Upload files or paste a link to get started.</p>
      ) : !tracks.length ? (
        <p className="empty">No songs match “{query}”.</p>
      ) : (
        <ul className="list">
          {tracks.map((t) => (
            <li key={t.id} className="row-item">
              <div className="row-main static">
                <span className="row-title">{t.title}</span>
                <span className="row-sub">
                  <span className="badge">{SOURCE_LABEL[t.kind]}</span> {t.artist ?? member(t.addedBy)?.name ?? ''}
                </span>
              </div>
              <span className="row-time">{formatTime(t.duration ? t.duration * 1000 : null)}</span>
              <span className="row-actions always">
                {canControl && <IconButton icon="play" label="Play now" size={16} onClick={() => act('queue:playNow', { trackId: t.id })} />}
                <IconButton icon="queue" label="Add to queue" size={16} onClick={() => act('queue:add', { trackIds: [t.id] })} />
                <AddToPlaylist trackId={t.id} />
                {(t.addedBy === memberId || isHost) && (
                  <IconButton icon="trash" label="Remove from library" size={16} onClick={() => act('track:remove', { trackId: t.id })} />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddToPlaylist({ trackId }) {
  const { room, act, toast } = useJam();
  if (!room.playlists.length) return null;
  return (
    <select
      className="mini-select"
      value=""
      aria-label="Add to playlist"
      title="Add to playlist"
      onChange={async (e) => {
        const playlist = room.playlists.find((pl) => pl.id === e.target.value);
        if (!playlist) return;
        if (await act('playlist:addTracks', { playlistId: playlist.id, trackIds: [trackId] })) toast(`Added to ${playlist.name}`);
      }}
    >
      <option value="">+ Playlist</option>
      {room.playlists.map((pl) => (
        <option key={pl.id} value={pl.id}>{pl.name}</option>
      ))}
    </select>
  );
}

function AddMusic() {
  const { code, act, toast } = useJam();
  const [tab, setTab] = useState('upload');
  const [enqueue, setEnqueue] = useState(true);
  const [progress, setProgress] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const fileInput = useRef(null);

  async function upload(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const tooBig = files.find((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
    if (tooBig) return toast(`${tooBig.name} is over ${MAX_UPLOAD_MB} MB`);
    setProgress(0);
    try {
      const res = await uploadFiles({ code, token: storage.getToken(code), files, enqueue, onProgress: setProgress });
      if (res.skipped?.length) toast(`Skipped ${res.skipped.length} file(s) that aren't audio`);
    } catch (err) {
      toast(err.message);
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function addLink(e) {
    e.preventDefault();
    setAdding(true);
    const res = await act('track:addLink', { url: url.trim(), title: title.trim(), enqueue });
    setAdding(false);
    if (res) {
      setUrl('');
      setTitle('');
    }
  }

  return (
    <div className="add-music">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'upload'} className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>
          <Icon name="upload" size={16} /> Upload
        </button>
        <button role="tab" aria-selected={tab === 'link'} className={tab === 'link' ? 'active' : ''} onClick={() => setTab('link')}>
          <Icon name="link" size={16} /> Link
        </button>
      </div>

      {tab === 'upload' ? (
        <div
          className={`dropzone ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            upload(e.dataTransfer.files);
          }}
        >
          {progress != null ? (
            <div className="upload-progress">
              <div className="bar"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              <span className="muted">{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Reading tags…'}</span>
            </div>
          ) : (
            <>
              <p>Drop audio files here</p>
              <button className="btn" onClick={() => fileInput.current?.click()}>Choose files</button>
              <p className="fine">mp3, m4a, ogg, opus, wav, flac · up to {MAX_UPLOAD_MB} MB each</p>
            </>
          )}
          <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => upload(e.target.files)} />
        </div>
      ) : (
        <form className="stack" onSubmit={addLink}>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={linkPlaceholder} aria-label="Song link" required />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" maxLength={200} />
          <button className="btn" disabled={adding || !url.trim()}>{adding ? 'Adding…' : 'Add link'}</button>
        </form>
      )}

      <label className="check">
        <input type="checkbox" checked={enqueue} onChange={(e) => setEnqueue(e.target.checked)} />
        Also add to the queue
      </label>
    </div>
  );
}
