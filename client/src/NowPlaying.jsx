import { useState } from 'react';
import { positionAt } from '../../shared/timing.js';
import { serverNow } from './lib/clock.js';
import { useJam } from './Jam.jsx';
import { Avatar, Icon, IconButton, SOURCE_LABEL, colorFor, formatTime, useTicker } from './ui.jsx';

const CONTROL_LOCKED = "Only the host can control what's playing";

export default function NowPlaying({ ytRef, scRef, playback, listening, onToggleListening, volume, onVolume }) {
  const { room, canControl, act, member } = useJam() ?? {};
  const player = room?.player;
  const item = player && player.index >= 0 ? room.queue[player.index] : null;
  const track = item ? room.tracks[item.trackId] : null;
  const durMs = track?.duration ? track.duration * 1000 : null;
  const isYouTube = track?.kind === 'youtube';
  const isSoundCloud = track?.kind === 'soundcloud';
  const [scrub, setScrub] = useState(null);

  useTicker(250, !!player?.isPlaying);
  const position = player && track ? positionAt(player, serverNow(), durMs) : 0;
  const shown = scrub ?? position;
  const adder = item ? member(item.addedBy) : null;

  const commitSeek = () => {
    if (scrub == null) return;
    act('player:seek', { positionMs: scrub });
    setScrub(null);
  };

  return (
    <section className="card now-playing" aria-label="Now playing">
      <div className="art" style={!isYouTube && !isSoundCloud && track ? { background: `linear-gradient(135deg, ${colorFor(track.id)}, #121212)` } : undefined}>
        {/* Embedded players must stay visible while they play; React never renders into these nodes. */}
        <div ref={ytRef} className={`yt-host ${isYouTube ? '' : 'is-hidden'}`} />
        <div ref={scRef} className={`yt-host ${isSoundCloud ? '' : 'is-hidden'}`} />
        {!isYouTube && !isSoundCloud && (track?.art ? <img className="art-img" src={track.art} alt="" /> : <Icon name="music" size={64} />)}
      </div>

      <div className="np-body">
        <div className="np-meta">
          {track ? (
            <>
              <div className="np-title" title={track.title}>{track.title}</div>
              <div className="np-sub">
                {track.artist && <span>{track.artist}</span>}
                <span className="badge">{SOURCE_LABEL[track.kind]}</span>
                {adder && (
                  <span className="added-by">
                    <Avatar member={adder} size={18} /> added by {adder.name}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="np-title muted">Nothing playing</div>
              <div className="np-sub">Add songs to the library and queue them up.</div>
            </>
          )}
        </div>

        <div className="progress">
          <span className="time">{formatTime(shown)}</span>
          <input
            type="range"
            min={0}
            max={durMs ?? 1}
            step={250}
            value={durMs ? Math.min(shown, durMs) : 0}
            disabled={!track || !durMs || !canControl}
            aria-label="Seek"
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onBlur={() => setScrub(null)}
            style={{ '--fill': `${durMs ? (Math.min(shown, durMs) / durMs) * 100 : 0}%` }}
          />
          <span className="time">{formatTime(durMs)}</span>
        </div>

        <div className="controls">
          <IconButton icon="previous" label="Previous" size={22} disabled={!track || !canControl} title={canControl ? 'Previous' : CONTROL_LOCKED} onClick={() => act('player:previous')} />
          {player?.isPlaying ? (
            <IconButton icon="pause" label="Pause" size={26} className="play-btn" disabled={!canControl} title={canControl ? 'Pause' : CONTROL_LOCKED} onClick={() => act('player:pause')} />
          ) : (
            <IconButton icon="play" label="Play" size={26} className="play-btn" disabled={!room?.queue.length || !canControl} title={canControl ? 'Play' : CONTROL_LOCKED} onClick={() => act('player:play')} />
          )}
          <IconButton icon="next" label="Next" size={22} disabled={!track || !canControl} title={canControl ? 'Next' : CONTROL_LOCKED} onClick={() => act('player:next')} />
        </div>

        <div className="listen-row">
          <ListenButton listening={listening} playback={playback} onClick={onToggleListening} disabled={!room} />
          <SyncStatus listening={listening} playback={playback} />
          <label className="volume" title="Volume on this device">
            <Icon name="volume" size={18} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              aria-label="Volume on this device"
              onChange={(e) => onVolume(Number(e.target.value))}
              style={{ '--fill': `${volume * 100}%` }}
            />
          </label>
        </div>
      </div>
    </section>
  );
}

function ListenButton({ listening, playback, onClick, disabled }) {
  if (listening && playback.status === 'blocked') {
    return <button className="btn btn-primary pulse" onClick={onClick}>Tap to start audio</button>;
  }
  return (
    <button className={`btn ${listening ? '' : 'btn-primary'}`} onClick={onClick} disabled={disabled}>
      <Icon name="headphones" size={16} />
      {listening ? 'Stop listening here' : 'Listen along'}
    </button>
  );
}

function SyncStatus({ listening, playback }) {
  let text;
  let tone = 'muted';
  if (!listening) text = 'Not playing on this device';
  else if (playback.status === 'error') {
    text = playback.error;
    tone = 'error';
  } else if (playback.status === 'playing' && playback.driftMs != null) {
    text = `In sync · ${Math.abs(playback.driftMs)} ms`;
    tone = Math.abs(playback.driftMs) <= 80 ? 'good' : 'muted';
  } else {
    text = { loading: 'Loading…', buffering: 'Syncing…', paused: 'Listening along · paused', idle: 'Listening along', playing: 'Listening along', blocked: 'Your browser blocked audio', unavailable: "Spotify songs can't play in a browser. They play in Spotify, with the JamRoom plugin" }[playback.status] ?? 'Listening along';
  }
  return <span className={`sync-status ${tone}`} role="status">{text}</span>;
}
