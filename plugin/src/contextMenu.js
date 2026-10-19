// "Add to Jam queue" / "Add to Jam library" in Spotify's right-click menu.
//
// Spicetify 2.45's ContextMenu API doesn't hook into Spotify 1.3.5's menus, so its items
// never appear. Instead we watch for Spotify's own menu to open, work out what it is for
// (from the menu's React props, the same way Spicetify does), and add our items to it,
// styled like Spotify's own.

import { isLikedSongs } from './spotifyMeta.js';

const MENU = '#context-menu ul[role=menu]';
const ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2zM3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/></svg>';

/** Songs, a single album, a single playlist, or Liked Songs. */
function supported(uris) {
  if (!uris?.length) return false;
  if (uris.every((u) => u.startsWith('spotify:track:'))) return true;
  return uris.length === 1 && (/^spotify:(album|playlist):/.test(uris[0]) || isLikedSongs(uris[0]));
}

/** The URIs this menu is about, from the nearest component props that describe them. */
function urisFor(menu) {
  const key = Object.keys(menu).find((k) => k.startsWith('__reactFiber'));
  const parse = window.Spicetify?.ContextMenuV2?.parseProps;
  for (let fiber = key && menu[key], depth = 0; fiber && depth < 60; fiber = fiber.return, depth++) {
    const props = fiber.memoizedProps;
    if (!props || typeof props !== 'object') continue;
    try {
      const parsed = parse?.(props);
      if (parsed?.[0]?.length) return parsed[0];
    } catch {
      // keep walking
    }
    if (Array.isArray(props.uris) && props.uris.length) return props.uris;
    if (typeof props.uri === 'string' && props.uri.startsWith('spotify:')) return [props.uri];
  }
  return null;
}

function itemLike(template, label, onClick) {
  const li = template.cloneNode(true);
  li.dataset.jamroom = '1';
  const button = li.querySelector('[role=menuitem]') ?? li;
  const icon = button.querySelector('svg');
  if (icon) icon.outerHTML = ICON;
  const text = button.querySelector('span') ?? button;
  text.textContent = label;
  // A plain DOM listener: React doesn't know about these clones.
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.querySelector('#context-menu')?.parentElement?._tippy?.hide();
    onClick();
  });
  return li;
}

/** onAdd(uris, enqueue) runs when one of our items is chosen. */
export function addJamMenuItems(onAdd) {
  let scheduled = false;
  const inject = () => {
    scheduled = false;
    const menu = document.querySelector(MENU);
    if (!menu || menu.querySelector('[data-jamroom]')) return;
    const uris = urisFor(menu);
    const template = menu.querySelector('li[role=presentation]');
    if (!supported(uris) || !template?.querySelector('[role=menuitem]')) return;
    const queue = itemLike(template, 'Add to Jam queue', () => onAdd(uris, true));
    const library = itemLike(template, 'Add to Jam library', () => onAdd(uris, false));
    menu.prepend(queue, library);
  };
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(inject);
  }).observe(document.body, { childList: true, subtree: true });
}
