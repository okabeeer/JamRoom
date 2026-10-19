import { useState } from 'react';
import { useJam } from './Jam.jsx';
import { invite, openProfile } from './lib/platform.js';
import { Avatar, Icon, Modal, copyText } from './ui.jsx';

export default function MembersPanel() {
  const { code, room, memberId, isHost, act, toast, navigate } = useJam();
  const [confirm, setConfirm] = useState(null); // { kind: 'remove', member } | { kind: 'end' }
  const link = invite.value(code);
  const members = [...room.members].sort((a, b) => (a.id === room.hostId ? -1 : b.id === room.hostId ? 1 : a.joinedAt - b.joinedAt));
  const online = members.filter((m) => m.online).length;

  async function copy() {
    toast((await copyText(link)) ? invite.copied : link);
  }

  async function leave() {
    if (await act('room:leave')) navigate('/');
  }

  return (
    <>
      <section className="card invite" aria-labelledby="invite-title">
        <h2 id="invite-title">Invite friends</h2>
        <p className="muted">{invite.title}</p>
        <div className="invite-link">
          <code>{invite.shown(code)}</code>
          <button className="btn btn-primary" onClick={copy}>
            <Icon name="copy" size={16} /> {invite.button}
          </button>
        </div>
        <p className="fine">Code: <strong className="code">{code}</strong></p>
      </section>

      <section className="card" aria-labelledby="members-title">
        <div className="card-head">
          <h2 id="members-title">In this Jam</h2>
          <span className="muted">{online} listening</span>
        </div>
        <ul className="list">
          {members.map((m) => (
            <li key={m.id} className="row-item member">
              <span className="presence-wrap">
                <Avatar member={m} size={32} />
                <span className={`presence ${m.online ? 'on' : ''}`} title={m.online ? 'Online' : 'Offline'} />
              </span>
              <div className="row-main static">
                <span className="row-title">
                  {m.spotifyUser && openProfile ? (
                    <button className="member-name linked" title="Open their Spotify profile" onClick={() => openProfile(m.spotifyUser)}>{m.name}</button>
                  ) : (
                    m.name
                  )}
                  {m.id === memberId && <span className="muted"> (you)</span>}
                </span>
                <span className="row-sub">{m.id === room.hostId ? 'Host' : 'Guest'}</span>
              </div>
              {isHost && m.id !== room.hostId && (
                <button className="btn btn-small btn-ghost" onClick={() => setConfirm({ kind: 'remove', member: m })}>Remove</button>
              )}
            </li>
          ))}
        </ul>

        {isHost && (
          <label className="switch">
            <input
              type="checkbox"
              checked={!room.settings.queueOnlyMode}
              onChange={(e) => act('settings:queueOnlyMode', { enabled: !e.target.checked })}
            />
            <span className="switch-track" aria-hidden="true" />
            <span>
              Let others change what's playing
              <span className="fine block">When off, guests can still add to the queue.</span>
            </span>
          </label>
        )}
        {!isHost && room.settings.queueOnlyMode && (
          <p className="fine">Only the host can control what's playing. You can still add to the queue.</p>
        )}

        <div className="end-row">
          {isHost ? (
            <button className="btn btn-danger" onClick={() => setConfirm({ kind: 'end' })}>End Jam</button>
          ) : (
            <button className="btn btn-ghost" onClick={leave}>Leave Jam</button>
          )}
        </div>
      </section>

      {confirm?.kind === 'remove' && (
        <Modal
          title={`Remove ${confirm.member.name}?`}
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  act('member:remove', { memberId: confirm.member.id });
                  setConfirm(null);
                }}
              >
                Remove
              </button>
            </>
          }
        >
          <p className="muted">They'll stop listening along and can't rejoin with this link from the same browser.</p>
        </Modal>
      )}
      {confirm?.kind === 'end' && (
        <Modal
          title="End the Jam for everyone?"
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => act('room:end')}>End Jam</button>
            </>
          }
        >
          <p className="muted">Everyone stops listening, and the queue, library, playlists and uploaded files are deleted.</p>
        </Modal>
      )}
    </>
  );
}
