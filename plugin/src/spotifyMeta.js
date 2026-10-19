// Song details from Spotify itself. Inside the Spotify app, the public Web API answers
// with 429 (rate limited) and fetches to open.spotify.com are blocked, so we use the same
// internal APIs the app uses for its own pages (GraphQL, PlaylistAPI, LibraryAPI).

const MAX_TRACKS = 500; // a Jam's queue holds 500
const PAGE = 100;

const S = () => window.Spicetify;

/** GraphQL cover sources: the 300px one (or the closest). */
function coverFrom(sources) {
  const list = (sources ?? []).filter((s) => s?.url);
  return (list.find((s) => s.width === 300) ?? list[0])?.url ?? null;
}

/** PlaylistAPI / LibraryAPI images: { url: 'spotify:image:<id>', label }. */
function imageFrom(images) {
  const image = images?.find((i) => i.label === 'standard') ?? images?.[0];
  const url = image?.url ?? '';
  return url.startsWith('spotify:image:') ? `https://i.scdn.co/image/${url.slice(14)}` : url.startsWith('https://') ? url : null;
}

const joinArtists = (names) => names.filter(Boolean).join(', ') || null;

/** { title, artist, durationSec, art } for a spotify:track: URI, or null. */
export async function spotifyTrackInfo(uri) {
  const item = S()?.Player?.data?.item;
  if (item?.uri === uri && item.name) {
    return {
      title: item.name,
      artist: joinArtists(item.artists?.map((a) => a.name) ?? []),
      durationSec: item.duration?.milliseconds / 1000,
      art: imageFrom(item.images) ?? null,
    };
  }
  try {
    const G = S().GraphQL;
    const res = await G.Request(G.Definitions.getTrack, { uri });
    const t = res?.data?.trackUnion;
    if (!t?.name) return null;
    return {
      title: t.name,
      artist: joinArtists([...(t.firstArtist?.items ?? []), ...(t.otherArtists?.items ?? [])].map((a) => a?.profile?.name)),
      durationSec: (t.duration?.totalMilliseconds ?? 0) / 1000 || null,
      art: coverFrom(t.albumOfTrack?.coverArt?.sources),
    };
  } catch {
    return null;
  }
}

const fromListItem = (t) => ({
  uri: t.uri,
  title: t.name,
  artist: joinArtists(t.artists?.map((a) => a.name) ?? []),
  durationSec: (t.duration?.milliseconds ?? 0) / 1000 || null,
  art: imageFrom(t.album?.images),
});
const isTrackUri = (uri) => typeof uri === 'string' && uri.startsWith('spotify:track:');
export const isLikedSongs = (uri) => /^spotify:(user:[^:]+:)?collection(:tracks)?$/.test(uri);

async function albumTracks(uri) {
  const G = S().GraphQL;
  const tracks = [];
  let name = null;
  for (let offset = 0; offset < MAX_TRACKS; offset += 50) {
    const res = await G.Request(G.Definitions.getAlbum, { uri, locale: '', offset, limit: 50 });
    const album = res?.data?.albumUnion;
    if (!album) break;
    name ??= album.name;
    const art = coverFrom(album.coverArt?.sources);
    const items = album.tracksV2?.items ?? [];
    for (const { track } of items) {
      if (!isTrackUri(track?.uri)) continue;
      tracks.push({
        uri: track.uri,
        title: track.name,
        artist: joinArtists(track.artists?.items?.map((a) => a?.profile?.name) ?? []),
        durationSec: (track.duration?.totalMilliseconds ?? 0) / 1000 || null,
        art,
      });
    }
    if (items.length < 50) break;
  }
  return { name, tracks };
}

async function pagedList(fetchPage) {
  const tracks = [];
  for (let offset = 0; offset < MAX_TRACKS; offset += PAGE) {
    const page = await fetchPage(offset);
    const items = page?.items ?? [];
    for (const t of items) if (isTrackUri(t?.uri)) tracks.push(fromListItem(t)); // skips local files and episodes
    if (items.length < PAGE) break;
  }
  return tracks;
}

/**
 * The songs behind what was right-clicked: songs, an album, a playlist or Liked Songs.
 * Returns { name, tracks }: name is set for a single album or playlist.
 */
export async function spotifyTracksFor(uris) {
  const P = S().Platform;
  if (uris.every(isTrackUri)) {
    const tracks = [];
    for (let i = 0; i < uris.length && i < MAX_TRACKS; i += 8) {
      const batch = await Promise.all(uris.slice(i, i + 8).map(async (uri) => ({ uri, ...((await spotifyTrackInfo(uri)) ?? {}) })));
      tracks.push(...batch);
    }
    return { name: null, tracks };
  }
  const uri = uris[0];
  if (uri.startsWith('spotify:album:')) return albumTracks(uri);
  if (uri.startsWith('spotify:playlist:')) {
    const name = (await P.PlaylistAPI.getMetadata(uri).catch(() => null))?.name ?? null;
    return { name, tracks: await pagedList((offset) => P.PlaylistAPI.getContents(uri, { offset, limit: PAGE })) };
  }
  if (isLikedSongs(uri)) {
    return { name: 'Liked Songs', tracks: await pagedList((offset) => P.LibraryAPI.getTracks({ offset, limit: PAGE })) };
  }
  return { name: null, tracks: [] };
}
