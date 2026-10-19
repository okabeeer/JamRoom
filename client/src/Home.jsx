import { useState } from 'react';
import { call } from './lib/api.js';
import { getProfile, joinPlaceholder, parseJamCode } from './lib/platform.js';
import * as storage from './lib/storage.js';
import { Icon, useProfileName } from './ui.jsx';

export default function Home({ navigate }) {
  const [name, setName] = useState(storage.getName());
  const [joinInput, setJoinInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useProfileName(name, setName);

  async function start(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      storage.setName(name.trim());
      const profile = await getProfile();
      const { code, token } = await call('room:create', { name: name.trim(), avatar: profile?.avatar, spotifyUser: profile?.spotifyUser });
      storage.setToken(code, token);
      navigate(`/jam/${code}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  function join(e) {
    e.preventDefault();
    const code = parseJamCode(joinInput);
    if (!code) return setError(`Paste a ${joinPlaceholder.toLowerCase()} (6 characters)`);
    navigate(`/jam/${code}`);
  }

  return (
    <main className="home">
      <div className="home-card">
        <div className="brand brand-lg">
          <span className="brand-mark"><Icon name="headphones" size={26} /></span>
          JamRoom
        </div>
        <p className="home-lede">Listen together in real time. Everyone adds songs from files or links, builds playlists, and hears the same thing at the same moment.</p>

        <form onSubmit={start} className="stack">
          <label className="field">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="e.g. Sam" required autoFocus />
          </label>
          <button className="btn btn-primary btn-lg" disabled={busy || !name.trim()}>
            {busy ? 'Starting…' : 'Start a Jam'}
          </button>
        </form>

        <div className="divider"><span>or join a friend</span></div>

        <form onSubmit={join} className="row">
          <input value={joinInput} onChange={(e) => setJoinInput(e.target.value)} placeholder={joinPlaceholder} aria-label={joinPlaceholder} />
          <button className="btn" disabled={!joinInput.trim()}>Join</button>
        </form>

        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>
  );
}
