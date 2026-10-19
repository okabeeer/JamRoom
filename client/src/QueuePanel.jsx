import { useJam } from './Jam.jsx';
import { Avatar, ConfirmButton, IconButton, formatTime } from './ui.jsx';

export default function QueuePanel() {
  const { room, memberId, canControl, act, member } = useJam();
  const { queue, tracks, player } = room;
  const upcoming = player.index >= 0 ? queue.length - player.index - 1 : queue.length;

  return (
    <section className="card" aria-labelledby="queue-title">
      <div className="card-head">
        <h2 id="queue-title">Queue</h2>
        <span className="muted">{upcoming} up next</span>
        {canControl && queue.length > (player.index >= 0 && !player.finished ? 1 : 0) && (
          <ConfirmButton confirmText="Click again to clear" title="Remove every song from the queue (the one playing keeps playing)" onConfirm={() => act('queue:clear')}>
            Clear queue
          </ConfirmButton>
        )}
      </div>
      {!queue.length ? (
        <p className="empty">The queue is empty. Add songs from the library, or play a playlist.</p>
      ) : (
        <ol className="list">
          {queue.map((item, i) => {
            const track = tracks[item.trackId];
            const current = i === player.index;
            const played = player.index >= 0 && i < player.index;
            const adder = member(item.addedBy);
            const canRemove = canControl || (item.addedBy === memberId && !current);
            return (
              <li key={item.qid} className={`row-item ${current ? 'is-current' : ''} ${played ? 'is-played' : ''}`}>
                <span className="row-index">{current ? <span className="eq" aria-label="Now playing"><i /><i /><i /></span> : i + 1}</span>
                <button className="row-main" disabled={!canControl || current} onClick={() => act('player:playAt', { qid: item.qid })} title={canControl ? 'Play this now' : undefined}>
                  <span className="row-title">{track?.title ?? 'Removed song'}</span>
                  <span className="row-sub">{track?.artist ?? ' '}</span>
                </button>
                {adder && <Avatar member={adder} size={22} />}
                <span className="row-time">{formatTime(track?.duration ? track.duration * 1000 : null)}</span>
                <span className="row-actions">
                  <IconButton icon="up" label="Move up" size={16} disabled={!canControl || i === 0} onClick={() => act('queue:move', { qid: item.qid, toIndex: i - 1 })} />
                  <IconButton icon="down" label="Move down" size={16} disabled={!canControl || i === queue.length - 1} onClick={() => act('queue:move', { qid: item.qid, toIndex: i + 1 })} />
                  <IconButton icon="trash" label="Remove from queue" size={16} disabled={!canRemove} onClick={() => act('queue:remove', { qid: item.qid })} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
