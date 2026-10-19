// Your Spotify library for the shelf: saved albums, playlists (including those inside
// folders) and Liked Songs, with their covers.

const PAGE = 200;

export function imageUrl(images) {
  const list = images ?? [];
  const image = list.find((i) => i.width === 300) ?? list.find((i) => i.label === 'standard') ?? list[0];
  const url = image?.url ?? '';
  if (url.startsWith('spotify:image:')) return `https://i.scdn.co/image/${url.slice(14)}`;
  return url.startsWith('https://') ? url : null;
}

async function libraryPage(params) {
  const items = [];
  for (let offset = 0; offset < 2000; offset += PAGE) {
    const res = await window.Spicetify.Platform.LibraryAPI.getContents({ ...params, offset, limit: PAGE });
    items.push(...(res?.items ?? []));
    if (!res?.items || res.items.length < PAGE) break;
  }
  return items;
}

/** { albums, playlists } as shelf items. Failures give empty lists (the shelf still works). */
export async function loadSpotifyLibrary() {
  let top = [];
  try {
    top = await libraryPage({});
  } catch {
    return { albums: [], playlists: [] };
  }
  const folders = top.filter((i) => i.type === 'folder' && i.uri);
  const inFolders = (await Promise.all(folders.map((f) => libraryPage({ folderUri: f.uri }).catch(() => [])))).flat();
  const seen = new Set();
  const all = [...top, ...inFolders].filter((i) => i?.uri && !seen.has(i.uri) && seen.add(i.uri));

  const albums = all
    .filter((i) => i.type === 'album')
    .map((a) => ({
      key: `sp:${a.uri}`,
      type: 'spotify-album',
      uri: a.uri,
      title: a.name,
      subtitle: a.artists?.map((x) => x.name).join(', ') ?? '',
      art: imageUrl(a.images),
    }));
  const playlists = all
    .filter((i) => i.type === 'playlist')
    .map((p) => ({
      key: `sp:${p.uri}`,
      type: 'spotify-playlist',
      uri: p.uri,
      title: p.name,
      subtitle: p.owner?.name ? `by ${p.owner.name}` : 'Playlist',
      art: imageUrl(p.images),
    }));
  playlists.unshift({ key: 'sp:liked', type: 'spotify-liked', uri: 'spotify:collection:tracks', title: 'Liked Songs', subtitle: 'Your favourites', art: null, color: '#5038a0' });
  return { albums, playlists };
}
