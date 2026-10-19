import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { call, socket } from './lib/api.js';
import { syncClock } from './lib/clock.js';
import { jamBridge } from './lib/jamBridge.js';
import { getProfile } from './lib/platform.js';
import * as storage from './lib/storage.js';
import { SyncEngine } from './lib/syncEngine.js';
import { Icon, Modal, Toasts, useProfileName, useToasts } from './ui.jsx';
import NowPlaying from './NowPlaying.jsx';
import QueuePanel from './QueuePanel.jsx';
import LibraryPanel from './LibraryPanel.jsx';
import PlaylistsPanel from './PlaylistsPanel.jsx';
import MembersPanel from './MembersPanel.jsx';

const JamContext = createContext(null);
export const useJam = () => useContext(JamContext);

const CLOCK_RESYNC_MS = 30000;
const LOCAL_STOP_TEXT = {
  paused: 'You paused Spotify, so you stopped listening along',
  changed: 'You played something else in Spotify, so you stopped listening along',
};

export default function Jam({ code, navigate }) {
  const [phase, setPhase] = useState(() => (storage.getToken(code) ? 'connecting' : 'needName'));
  const [room, setRoom] = useState(null);
  const [memberId, setMemberId] = useState(null);
  const [peek, setPeek] = useState(null);
  const [error, setError] = useState('');
  const [endedBy, setEndedBy] = useState(null);
  const [connected, setConnected] = useState(socket.connected);
  const [playback, setPlayback] = useState({ status: 'idle', driftMs: null, error: null, kind: null });
  const [listening, setListening] = useState(false);
  const [volume, setVolume] = useState(storage.getVolume);
  const { toasts, toast } = useToasts();

  const engineRef = useRef(null);
  const ytRef = useRef(null);
  const scRef = useRef(null);
  const revisionRef = useRef(-1);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const applyState = useCallback((state) => {
    if (state.revision < revisionRef.current) return;
    revisionRef.current = state.revision;
    setRoom(state);
    engineRef.current?.setState(state);
  }, []);

  const join = useCallback(
    async (name) => {
      const profile = await getProfile();
      const res = await call('room:join', { code, token: storage.getToken(code), name, avatar: profile?.avatar, spotifyUser: profile?.spotifyUser });
      storage.setToken(code, res.token);
      setMemberId(res.memberId);
      revisionRef.current = -1;
      applyState(res.state);
      setPhase('joined');
    },
    [code, applyState],
  );

  const failJoin = useCallback(
    (err) => {
      if (err.code === 'removed') {
        storage.clearToken(code);
        setPhase('removed');
      } else if (err.code === 'not-found') {
        storage.clearToken(code);
        setError(err.message);
        setPhase('error');
      } else {
        setError(err.message);
        setPhase((p) => (p === 'joined' ? p : 'error'));
      }
    },
    [code],
  );

  // The follower that plays audio locally.
  useEffect(() => {
    const engine = new SyncEngine({
      containers: { youtube: ytRef.current, soundcloud: scRef.current },
      onStatus: setPlayback,
      onEnded: (playId) => call('player:ended', { playId }).catch(() => {}),
      onDuration: (trackId, duration) => call('track:duration', { trackId, duration }).catch(() => {}),
      onLocalStop: (reason) => {
        setListening(false);
        toast(LOCAL_STOP_TEXT[reason] ?? 'Stopped listening along on this device');
      },
    });
    engine.setVolume(storage.getVolume());
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [toast]);

  // Server events, (re)joining on connect, and clock sync.
  useEffect(() => {
    const ping = () => call('time:ping');
    const onConnect = () => {
      setConnected(true);
      syncClock(ping);
      if (storage.getToken(code) && (phaseRef.current === 'connecting' || phaseRef.current === 'joined')) {
        join().catch(failJoin);
      }
    };
    const onDisconnect = () => setConnected(false);
    const onState = (state) => state.code === code && applyState(state);
    const onToast = (t) => toast(t.text);
    const onEnded = ({ by }) => {
      storage.clearToken(code);
      engineRef.current?.stop();
      setEndedBy(by);
      setPhase('ended');
    };
    const onRemoved = () => {
      storage.clearToken(code);
      engineRef.current?.stop();
      setPhase('removed');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state', onState);
    socket.on('toast', onToast);
    socket.on('ended', onEnded);
    socket.on('removed', onRemoved);
    if (socket.connected) onConnect();
    const resync = setInterval(() => socket.connected && syncClock(ping), CLOCK_RESYNC_MS);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state', onState);
      socket.off('toast', onToast);
      socket.off('ended', onEnded);
      socket.off('removed', onRemoved);
      clearInterval(resync);
    };
  }, [code, join, failJoin, applyState, toast]);

  // "Join Sam's Jam" needs the host's name before joining.
  useEffect(() => {
    if (phase !== 'needName') return;
    call('room:peek', { code }).then(setPeek, failJoin);
  }, [phase, code, failJoin]);

  // Run a command; failures become a toast and resolve to null.
  const act = useCallback(
    (event, payload) =>
      call(event, payload).catch((err) => {
        toast(err.message);
        return null;
      }),
    [toast],
  );

  const toggleListening = useCallback(() => {
    const on = !(listening && playback.status !== 'blocked');
    setListening(on);
    engineRef.current?.setListening(on);
  }, [listening, playback.status]);

  const changeVolume = useCallback((v) => {
    setVolume(v);
    storage.setVolume(v);
    engineRef.current?.setVolume(v);
  }, []);

  const isHost = !!room && room.hostId === memberId;
  const ctx = useMemo(
    () => ({
      code,
      room,
      memberId,
      isHost,
      canControl: !!room && (!room.settings.queueOnlyMode || isHost),
      member: (id) => room?.members.find((m) => m.id === id),
      act,
      toast,
      navigate,
    }),
    [code, room, memberId, isHost, act, toast, navigate],
  );

  const host = room?.members.find((m) => m.id === room.hostId);

  // Other views of this Jam (the plugin's shelf) follow and drive it through the bridge.
  useEffect(() => {
    const joined = phase === 'joined';
    jamBridge.set({
      code: joined ? code : null,
      room: joined ? room : null,
      memberId: joined ? memberId : null,
      canControl: joined && ctx.canControl,
      listening,
      playback,
      toggleListening: joined ? toggleListening : null,
      act: joined ? act : null,
    });
  }, [phase, code, room, memberId, ctx.canControl, listening, playback, toggleListening, act]);
  useEffect(() => () => jamBridge.set({ code: null, room: null, memberId: null, toggleListening: null, act: null }), []);

  return (
    <JamContext.Provider value={ctx}>
      <div className="jam">
        <header className="topbar">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
          >
            <span className="brand-mark"><Icon name="headphones" size={18} /></span>
            JamRoom
          </a>
          <div className="topbar-title">{host ? `${host.name}'s Jam` : 'Jam'}</div>
          <div className={`conn ${connected ? 'ok' : 'down'}`}>{connected ? 'Connected' : 'Reconnecting…'}</div>
        </header>

        <div className="layout">
          <aside className="col col-left">
            {room && <LibraryPanel />}
            {room && <PlaylistsPanel />}
          </aside>
          <main className="col col-center">
            <NowPlaying
              ytRef={ytRef}
              scRef={scRef}
              playback={playback}
              listening={listening}
              onToggleListening={toggleListening}
              volume={volume}
              onVolume={changeVolume}
            />
            {room && <QueuePanel />}
          </main>
          <aside className="col col-right">{room && <MembersPanel />}</aside>
        </div>

        <Toasts toasts={toasts} />
        <JamModals
          phase={phase}
          peek={peek}
          error={error}
          endedBy={endedBy}
          onJoin={(name) => {
            storage.setName(name);
            return join(name).catch((err) => {
              failJoin(err);
              throw err;
            });
          }}
          onHome={() => navigate('/')}
        />
      </div>
    </JamContext.Provider>
  );
}

function JamModals({ phase, peek, error, endedBy, onJoin, onHome }) {
  const [name, setName] = useState(storage.getName());
  useProfileName(name, setName);
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState('');

  if (phase === 'needName') {
    const submit = async (e) => {
      e.preventDefault();
      setBusy(true);
      setJoinError('');
      try {
        await onJoin(name.trim());
      } catch (err) {
        setJoinError(err.message);
        setBusy(false);
      }
    };
    return (
      <Modal title={peek ? `Join ${peek.hostName}'s Jam` : 'Join this Jam'}>
        <form onSubmit={submit} className="stack">
          <p className="muted">Listen and add songs together in real time, from anywhere.</p>
          <label className="field">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required autoFocus />
          </label>
          <p className="fine">People in the Jam will see your name and the songs you add.</p>
          {joinError && <p className="error" role="alert">{joinError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onHome}>Not now</button>
            <button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? 'Joining…' : 'Join'}</button>
          </div>
        </form>
      </Modal>
    );
  }
  if (phase === 'connecting') {
    return (
      <Modal title="Joining the Jam…">
        <div className="spinner" aria-hidden="true" />
      </Modal>
    );
  }
  if (phase === 'ended') {
    return (
      <Modal title={endedBy ? `${endedBy} ended the Jam` : 'The host has ended the Jam'} actions={<button className="btn btn-primary" onClick={onHome}>Got it</button>}>
        <p className="muted">You're no longer listening together, and the queue has been cleared.</p>
      </Modal>
    );
  }
  if (phase === 'removed') {
    return (
      <Modal title="You were removed from this Jam" actions={<button className="btn btn-primary" onClick={onHome}>Got it</button>}>
        <p className="muted">The host removed you. Start your own Jam to keep listening.</p>
      </Modal>
    );
  }
  if (phase === 'error') {
    return (
      <Modal title="Can't open this Jam" actions={<button className="btn btn-primary" onClick={onHome}>Go home</button>}>
        <p className="muted">{error || 'Something went wrong.'}</p>
      </Modal>
    );
  }
  return null;
}
