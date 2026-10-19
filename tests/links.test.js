import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkError, linkFor, parseLink, soundcloudInfo, spotifyInfo, youtubeInfo } from '../server/links.js';

const ID = 'dQw4w9WgXcQ';

test('recognises the common YouTube link shapes', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&list=PL123&t=42`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
  ]) {
    assert.deepEqual(parseLink(url), { kind: 'youtube', src: ID, title: null }, url);
  }
});

test('rejects YouTube links without a single valid video', () => {
  assert.throws(() => parseLink('https://www.youtube.com/watch?v=short'), LinkError);
  assert.throws(() => parseLink('https://www.youtube.com/@somechannel'), LinkError);
  assert.throws(() => parseLink('https://youtu.be/'), LinkError);
});

test('treats other http(s) links as direct audio with a readable title', () => {
  assert.deepEqual(parseLink('https://cdn.example.com/music/My_Song%20Live.mp3?x=1'), {
    kind: 'audio-url',
    src: 'https://cdn.example.com/music/My_Song%20Live.mp3?x=1',
    title: 'My Song Live',
  });
  assert.equal(parseLink('https://radio.example.com/').title, 'radio.example.com');
});

test('rejects unsupported schemes and explains catalog links', () => {
  assert.throws(() => parseLink('ftp://example.com/a.mp3'), /http and https/);
  assert.throws(() => parseLink('javascript:alert(1)'), /http and https/);
  assert.throws(() => parseLink('not a url'), LinkError);
});

test('recognises Spotify song links and URIs', () => {
  const SID = '4cOdK2wGLETKBW3PvgPWqT';
  for (const url of [
    `https://open.spotify.com/track/${SID}`,
    `https://open.spotify.com/track/${SID}?si=abc123`,
    `https://open.spotify.com/intl-fr/track/${SID}`,
    `spotify:track:${SID}`,
  ]) {
    assert.deepEqual(parseLink(url), { kind: 'spotify', src: `spotify:track:${SID}`, title: null }, url);
  }
  assert.throws(() => parseLink('https://open.spotify.com/track/abc'), /valid song ID/);
  assert.throws(() => parseLink('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3'), /single Spotify song/);
  assert.throws(() => parseLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), /single Spotify song/);
  assert.throws(() => parseLink('https://spotify.link/abcdef'), /short link/);
  assert.throws(() => parseLink('spotify:album:1DFixLWuPkv3KT3TnV35m3'), /http and https/);
});

test('recognises single SoundCloud tracks only', () => {
  for (const url of ['https://soundcloud.com/forss/flickermood', 'https://m.soundcloud.com/Forss/Flickermood?in=x', 'https://www.soundcloud.com/forss/flickermood/']) {
    assert.deepEqual(parseLink(url), { kind: 'soundcloud', src: 'https://soundcloud.com/forss/flickermood', title: null }, url);
  }
  assert.throws(() => parseLink('https://soundcloud.com/forss/sets/soulhack'), /single SoundCloud track/);
  assert.throws(() => parseLink('https://soundcloud.com/forss'), /single SoundCloud track/);
  assert.throws(() => parseLink('https://soundcloud.com/discover/sets'), /single SoundCloud track/);
  assert.throws(() => parseLink('https://on.soundcloud.com/abc'), /short link/);
});

test('soundcloudInfo splits "Track by Artist" and fails soft', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ title: 'Flickermood by Forss', author_name: 'Forss' }) });
  assert.deepEqual(await soundcloudInfo('https://soundcloud.com/forss/flickermood', { fetchImpl: ok }), { title: 'Flickermood', artist: 'Forss', art: null });
  assert.equal(await soundcloudInfo('https://soundcloud.com/a/b', { fetchImpl: async () => ({ ok: false }) }), null);
});

test('spotifyInfo reads the title from oEmbed and fails soft', async () => {
  const ok = async (url) => {
    assert.equal(url, 'https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F4cOdK2wGLETKBW3PvgPWqT');
    return { ok: true, json: async () => ({ title: 'Never Gonna Give You Up' }) };
  };
  assert.deepEqual(await spotifyInfo('spotify:track:4cOdK2wGLETKBW3PvgPWqT', { fetchImpl: ok }), { title: 'Never Gonna Give You Up', artist: null });
  assert.equal(await spotifyInfo('spotify:track:x', { fetchImpl: async () => ({ ok: false }) }), null);
});

test('youtubeInfo reads oEmbed and fails soft', async () => {
  const ok = async (url) => {
    assert.match(url, /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=/);
    return { ok: true, json: async () => ({ title: 'Song', author_name: 'Channel' }) };
  };
  assert.deepEqual(await youtubeInfo(ID, { fetchImpl: ok }), { title: 'Song', artist: 'Channel' });
  assert.equal(await youtubeInfo(ID, { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await youtubeInfo(ID, { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('linkFor turns stored tracks back into links parseLink accepts', () => {
  for (const [kind, src] of [['youtube', ID], ['spotify', 'spotify:track:4cOdK2wGLETKBW3PvgPWqT'], ['soundcloud', 'https://soundcloud.com/forss/flickermood'], ['audio-url', 'https://cdn.example.com/a.mp3']]) {
    assert.deepEqual([parseLink(linkFor(kind, src)).kind, parseLink(linkFor(kind, src)).src], [kind, src]);
  }
  assert.equal(linkFor('youtube', 42), '');
});
