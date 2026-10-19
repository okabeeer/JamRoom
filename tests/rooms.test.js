import test from 'node:test';
import assert from 'node:assert/strict';
import { JamError, RoomStore } from '../server/rooms.js';

/** A store on a fake clock with captured timers. */
function setup() {
  let now = 1_000_000;
  const timers = [];
  const store = new RoomStore({
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.cleared = true;
    },
  });
  const { room, member: host } = store.createRoom('Sam');
  const { member: guest } = store.join(room.code, { name: 'Alex' });
  const song = (title, durationSec = 180) => ({ kind: 'file', src: `/media/${title}.mp3`, file: `${title}.mp3`, title, durationSec });
  return {
    store,
    code: room.code,
    host,
    guest,
    song,
    advance: (ms) => {
      now += ms;
    },
    runTimers: () => {
      for (const t of timers.splice(0)) if (!t.cleared && t.at <= now) t.fn();
    },
    state: () => store.publicState(room.code),
  };
}

test('joining with a stored token returns the same member; tokens are never published', () => {
  const { store, code, guest, state } = setup();
  const again = store.join(code, { token: guest.token });
  assert.equal(again.member.id, guest.id);
  assert.equal(again.isNew, false);
  assert.equal(state().members.length, 2);
  assert.ok(!JSON.stringify(state()).includes(guest.token));
  assert.equal(store.peek(code).hostName, 'Sam');
});

test('adding songs to an idle Jam starts playback; pause and resume keep the position', () => {
  const { store, code, host, guest, song, advance, state } = setup();
  store.addTracks(code, guest.id, [song('a'), song('b')], { enqueue: true });
  let p = state().player;
  assert.equal(p.index, 0);
  assert.equal(p.isPlaying, true);

  advance(30_000);
  store.pause(code, host.id);
  p = state().player;
  assert.equal(p.isPlaying, false);
  assert.equal(p.positionAsOfTimestamp, 30_000);

  advance(60_000); // paused time doesn't count
  store.play(code, guest.id);
  advance(5_000);
  p = state().player;
  assert.equal(p.positionAsOfTimestamp + (store.publicState(code).serverNow - p.timestamp), 35_000);
});

test('queue-only mode: guests can add to the queue but not control playback', () => {
  const { store, code, host, guest, song, state } = setup();
  const [a] = store.addTracks(code, guest.id, [song('a')], { enqueue: true });
  store.setQueueOnlyMode(code, host.id, true);

  assert.throws(() => store.pause(code, guest.id), (err) => err instanceof JamError && err.code === 'queue-only');
  assert.throws(() => store.next(code, guest.id), /Only the host/);
  store.queueAdd(code, guest.id, [a.id]);
  assert.equal(state().queue.length, 2);
  store.pause(code, host.id);
  assert.throws(() => store.setQueueOnlyMode(code, guest.id, false), /Only the host/);
});

test('guests may remove their own upcoming songs even in queue-only mode', () => {
  const { store, code, host, guest, song, state } = setup();
  store.addTracks(code, host.id, [song('a')], { enqueue: true });
  store.addTracks(code, guest.id, [song('b')], { enqueue: true });
  store.setQueueOnlyMode(code, host.id, true);
  const [current, mine] = state().queue;
  assert.throws(() => store.queueRemove(code, guest.id, current.qid), /Only the host/);
  store.queueRemove(code, guest.id, mine.qid);
  assert.equal(state().queue.length, 1);
});

test('next past the end finishes; adding a song after that starts it', () => {
  const { store, code, guest, song, state } = setup();
  store.addTracks(code, guest.id, [song('a', 100)], { enqueue: true });
  store.next(code, guest.id);
  let p = state().player;
  assert.equal(p.finished, true);
  assert.equal(p.isPlaying, false);
  assert.equal(p.positionAsOfTimestamp, 100_000);

  store.addTracks(code, guest.id, [song('b')], { enqueue: true });
  p = state().player;
  assert.equal(p.index, 1);
  assert.equal(p.isPlaying, true);
  assert.equal(p.finished, false);
});

test('removing and moving queue items keeps the current song pointed at', () => {
  const { store, code, guest, song, state } = setup();
  store.addTracks(code, guest.id, [song('a'), song('b'), song('c'), song('d')], { enqueue: true });
  const titleAt = (i) => state().tracks[state().queue[i].trackId].title;
  const qid = (i) => state().queue[i].qid;

  store.playAt(code, guest.id, qid(2)); // playing c
  store.queueRemove(code, guest.id, qid(0)); // remove a, before current
  assert.equal(titleAt(state().player.index), 'c');

  store.queueMove(code, guest.id, qid(2), 0); // move d to the top
  assert.equal(titleAt(state().player.index), 'c');

  const playId = state().player.playId;
  store.queueRemove(code, guest.id, qid(state().player.index)); // remove the current (and last) song
  assert.equal(state().player.index, 1, 'nothing follows, so the Jam finishes on the new last item');
  assert.equal(state().player.finished, true);
  assert.notEqual(state().player.playId, playId);
});

test('removing the playing song starts the next one', () => {
  const { store, code, guest, song, state } = setup();
  store.addTracks(code, guest.id, [song('a'), song('b')], { enqueue: true });
  store.queueRemove(code, guest.id, state().queue[0].qid);
  const p = state().player;
  assert.equal(state().tracks[state().queue[p.index].trackId].title, 'b');
  assert.equal(p.isPlaying, true);
  assert.equal(p.positionAsOfTimestamp, 0);
});

test('"ended" reports advance once; stale and early reports are ignored', () => {
  const { store, code, guest, song, advance, state } = setup();
  store.addTracks(code, guest.id, [song('a', 100), song('b', 100)], { enqueue: true });
  const first = state().player.playId;

  advance(10_000);
  store.ended(code, guest.id, first); // 90 s early
  assert.equal(state().player.index, 0);

  advance(89_000);
  store.ended(code, guest.id, first);
  assert.equal(state().player.index, 1);
  store.ended(code, guest.id, first); // a second listener's late report
  assert.equal(state().player.index, 1);
});

test('the server timer advances when nobody reports the end', () => {
  const { store, code, guest, song, advance, runTimers, state } = setup();
  store.addTracks(code, guest.id, [song('a', 100), song('b', 100)], { enqueue: true });
  advance(100_300);
  runTimers();
  assert.equal(state().player.index, 1);
  assert.equal(state().player.isPlaying, true);
});

test('previous restarts after 3 s, otherwise goes back a song', () => {
  const { store, code, guest, song, advance, state } = setup();
  store.addTracks(code, guest.id, [song('a'), song('b')], { enqueue: true });
  store.next(code, guest.id);
  advance(10_000);
  store.previous(code, guest.id);
  assert.equal(state().player.index, 1);
  assert.equal(state().player.positionAsOfTimestamp, 0);
  store.previous(code, guest.id);
  assert.equal(state().player.index, 0);
});

test('playlists: play replaces the queue, enqueue appends', () => {
  const { store, code, host, guest, song, state } = setup();
  const [a, b] = store.addTracks(code, guest.id, [song('a'), song('b')]);
  const pl = store.createPlaylist(code, guest.id, 'Road trip');
  store.playlistAdd(code, guest.id, pl.id, [a.id, b.id]);
  store.playlistPlay(code, host.id, pl.id);
  assert.deepEqual(state().queue.map((q) => q.trackId), [a.id, b.id]);
  assert.equal(state().player.isPlaying, true);

  store.playlistEnqueue(code, guest.id, pl.id);
  assert.equal(state().queue.length, 4);

  store.removeTrack(code, guest.id, a.id);
  assert.deepEqual(state().playlists[0].trackIds, [b.id]);
  assert.ok(state().queue.every((q) => q.trackId === b.id));
  assert.throws(() => store.deletePlaylist(code, store.join(code, { name: 'Kim' }).member.id, pl.id), /Only the person/);
});

test('a removed member cannot rejoin with their token', () => {
  const { store, code, host, guest } = setup();
  const removed = [];
  store.on('removed', (e) => removed.push(e));
  store.removeMember(code, host.id, guest.id);
  assert.deepEqual(removed, [{ code, memberId: guest.id }]);
  assert.throws(() => store.join(code, { token: guest.token }), (err) => err.code === 'removed');
  assert.throws(() => store.removeMember(code, guest.id, host.id), /no longer in this Jam/);
});

test('only the host can end the Jam; ending reports uploaded files for deletion', () => {
  const { store, code, host, guest, song } = setup();
  store.addTracks(code, guest.id, [song('a'), { kind: 'youtube', src: 'dQw4w9WgXcQ', title: 'yt' }]);
  assert.throws(() => store.endRoom(code, guest.id), /Only the host/);
  let ended = null;
  store.on('ended', (e) => (ended = e));
  store.endRoom(code, host.id);
  assert.deepEqual(ended, { code, by: 'Sam', files: ['a.mp3'] });
  assert.throws(() => store.get(code), (err) => err.code === 'not-found');
});

test('saved rooms come back paused at the position they were saved at', () => {
  const { store, code, guest, song, advance } = setup();
  store.addTracks(code, guest.id, [song('a', 300)], { enqueue: true });
  advance(42_000);
  const snapshot = JSON.parse(JSON.stringify(store.toJSON()));

  const restored = new RoomStore({ now: () => 9_999_999 });
  restored.load(snapshot);
  const p = restored.publicState(code).player;
  assert.equal(p.isPlaying, false);
  assert.equal(p.positionAsOfTimestamp, 42_000);
  assert.equal(restored.memberByToken(code, guest.token).id, guest.id);
});

test('presence counts sockets per member', () => {
  const { store, code, guest, state } = setup();
  store.connect(code, guest.id);
  store.connect(code, guest.id);
  store.disconnect(code, guest.id);
  assert.equal(state().members.find((m) => m.id === guest.id).online, true);
  store.disconnect(code, guest.id);
  assert.equal(state().members.find((m) => m.id === guest.id).online, false);
});

test('importing a saved playlist reuses Jam songs, names the playlist once, and can start it', () => {
  const { store, code, host, guest, song, state } = setup();
  const [a] = store.addTracks(code, guest.id, [song('a')]);
  const items = [song('a'), song('b'), { kind: 'youtube', src: 'dQw4w9WgXcQ', title: 'Video', art: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }];

  const first = store.importTracks(code, guest.id, items, { playlistName: 'Road trip', enqueue: true });
  assert.equal(first.trackIds[0], a.id, 'the song already in the Jam is reused');
  assert.equal(Object.keys(state().tracks).length, 3);
  assert.deepEqual(state().playlists.map((p) => [p.name, p.trackIds.length]), [['Road trip', 3]]);
  assert.equal(state().queue.length, 3);
  assert.equal(state().tracks[first.trackIds[2]].art, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');

  const again = store.importTracks(code, host.id, items.slice(1), { playlistName: 'Road trip', play: true });
  assert.equal(state().playlists.length, 1, 'same name replaces, not duplicates');
  assert.deepEqual(state().playlists[0].trackIds, again.trackIds);
  assert.deepEqual(state().queue.map((q) => q.trackId), again.trackIds);
  assert.equal(state().player.index, 0);
  assert.equal(state().player.isPlaying, true);
});

test('importing respects host lock for play and rejects art from unknown hosts', () => {
  const { store, code, host, guest, song, state } = setup();
  store.setQueueOnlyMode(code, host.id, true);
  assert.throws(() => store.importTracks(code, guest.id, [song('a')], { play: true }), JamError);
  store.importTracks(code, guest.id, [{ ...song('a'), art: 'https://evil.example.com/x.jpg' }], { enqueue: true });
  assert.equal(Object.values(state().tracks)[0].art, null);
});

test('members can show their Spotify picture and profile; other image hosts are dropped', () => {
  const store = new RoomStore();
  const pic = 'https://i.scdn.co/image/ab67757000000000000000000000000000000000';
  const { room, member: host } = store.createRoom('Sam', { avatar: pic, spotifyUser: 'demo_listener_1' });
  const { member: guest } = store.join(room.code, { name: 'Alex', avatar: 'https://evil.example.com/me.png', spotifyUser: 'not a user!' });
  const members = Object.fromEntries(store.publicState(room.code).members.map((m) => [m.id, m]));
  assert.equal(members[host.id].avatar, pic);
  assert.equal(members[host.id].spotifyUser, 'demo_listener_1');
  assert.deepEqual([members[guest.id].avatar, members[guest.id].spotifyUser], [null, null]);
  store.join(room.code, { token: guest.token, avatar: 'https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1' });
  assert.match(store.publicState(room.code).members.find((m) => m.id === guest.id).avatar, /^https:\/\/platform-lookaside\.fbsbx\.com\//);
});

test('importing with play can start at a chosen track', () => {
  const { store, code, host, song, state } = setup();
  store.importTracks(code, host.id, [song('a'), song('b'), song('c')], { playlistName: 'Album', play: true, startAt: 2 });
  assert.equal(state().player.index, 2);
  assert.equal(state().tracks[state().queue[2].trackId].title, 'c');
  store.importTracks(code, host.id, [song('a')], { play: true, startAt: 9 });
  assert.equal(state().player.index, 0, 'out of range starts at the top');
});

test('clearing the queue keeps the playing song; a finished Jam clears completely', () => {
  const { store, code, host, guest, song, state } = setup();
  store.addTracks(code, guest.id, [song('a'), song('b'), song('c')], { enqueue: true });
  store.next(code, host.id); // playing b, a is history
  const playing = state().queue[state().player.index].trackId;
  const playId = state().player.playId;
  store.queueClear(code, host.id);
  assert.deepEqual(state().queue.map((q) => q.trackId), [playing]);
  assert.equal(state().player.index, 0);
  assert.equal(state().player.playId, playId, 'the music keeps going');

  store.setQueueOnlyMode(code, host.id, true);
  assert.throws(() => store.queueClear(code, guest.id), JamError);

  store.next(code, host.id); // past the end: finished
  store.queueClear(code, host.id);
  assert.equal(state().queue.length, 0);
  assert.equal(state().player.index, -1);
});

test('emptying a playlist keeps it; only its maker or the host may', () => {
  const { store, code, host, guest, song, state } = setup();
  const [a, b] = store.addTracks(code, guest.id, [song('a'), song('b')]);
  const pl = store.createPlaylist(code, guest.id, 'Mix');
  store.playlistAdd(code, guest.id, pl.id, [a.id, b.id]);
  const kim = store.join(code, { name: 'Kim' }).member;
  assert.throws(() => store.playlistClear(code, kim.id, pl.id), /Only the person/);
  store.playlistClear(code, host.id, pl.id);
  assert.deepEqual(state().playlists[0].trackIds, []);
  assert.equal(state().playlists[0].name, 'Mix');
  assert.equal(Object.keys(state().tracks).length, 2, 'the songs stay in the library');
});
