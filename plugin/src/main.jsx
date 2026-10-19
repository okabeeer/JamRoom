// JamRoom for Spotify: a Spicetify extension (https://spicetify.app).
//
// Jam with friends right inside Spotify. Everyone adds songs from Spotify, YouTube,
// SoundCloud, audio links or their own files; you build playlists and a shared queue
// and hear the same moment of the same song. Friends' Spotify apps connect to each
// other directly (WebRTC), so there is no server to run.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import appCss from '../../client/src/styles.css?inline';
import shelfCss from './shelf/shelf.css?inline';
import ShelfView from './shelf/ShelfView.jsx';
import { call, socket } from './api.js';
import { addJamMenuItems } from './contextMenu.js';
import { reportToDiscord } from './discord.js';
import { spotifyTracksFor } from './spotifyMeta.js';
import PluginApp from './PluginApp.jsx';

const ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2zM3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/></svg>';

// The panel sits on top of Spotify's UI.
const PANEL_CSS = `
  #jamroom-panel { position: fixed; top: 72px; right: 12px; bottom: 100px; width: min(480px, calc(100vw - 24px));
    z-index: 1000; display: flex; flex-direction: column; background: #0b0b0d; color: #f2f2f4;
    border: 1px solid #2c2c34; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.6); overflow: hidden;
    transform: translateX(0); transition: transform .2s ease, opacity .2s ease, width .2s ease; }
  #jamroom-panel.is-wide { width: min(1180px, calc(100vw - 24px)); }
  /* Hidden off-screen rather than display:none, so the Jam keeps playing at full speed. */
  #jamroom-panel.is-closed { transform: translateX(calc(100% + 24px)); opacity: 0; pointer-events: none; }
  #jamroom-panel > header { display: flex; align-items: center; gap: 4px; padding: 6px 8px 6px 14px; border-bottom: 1px solid #2c2c34;
    font: 700 13px/1 system-ui, sans-serif; }
  #jamroom-panel > header span { flex: 1; }
  #jamroom-panel > header button { background: none; border: 0; color: #a7a7b2; cursor: pointer; padding: 6px 10px; border-radius: 6px; font: 600 12px/1 system-ui, sans-serif; }
  #jamroom-panel > header button:hover { color: #fff; background: #26262d; }
  #jamroom-panel > .jr-host { flex: 1; min-height: 0; }

  /* Shelf mode: the 3D CD shelf over Spotify's main area (the player bar stays visible). */
  #jamroom-shelf { position: fixed; top: 64px; left: 8px; right: 8px; bottom: 92px; z-index: 999; border-radius: 12px; overflow: hidden;
    box-shadow: 0 12px 40px rgba(0,0,0,.6); transition: opacity .25s ease, transform .25s ease; }
  #jamroom-shelf.is-closed { opacity: 0; transform: scale(.985); pointer-events: none; visibility: hidden; }

  /* In shelf mode, the player bar's cover is a CD too: round, a clear hub, a sheen, spinning while playing. */
  body.jr-disc .main-nowPlayingBar-container [data-testid=cover-art-button] { position: relative; border-radius: 50% !important; overflow: visible !important; }
  body.jr-disc .main-nowPlayingBar-container [data-testid=cover-art-button] img { border-radius: 50% !important;
    box-shadow: 0 0 0 1px rgba(255,255,255,.3), 0 3px 10px rgba(0,0,0,.55); -webkit-mask: radial-gradient(circle, transparent 0 10%, #000 10.5%);
    animation: jr-disc-spin 2.4s linear infinite; animation-play-state: paused; }
  body.jr-disc.jr-playing .main-nowPlayingBar-container [data-testid=cover-art-button] img { animation-play-state: running; }
  body.jr-disc .main-nowPlayingBar-container [data-testid=cover-art-button]::after { content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none; mix-blend-mode: screen;
    background: radial-gradient(circle, rgba(230,233,238,.85) 0 23%, rgba(255,255,255,.6) 24%, transparent 26%),
      conic-gradient(from 210deg, transparent, rgba(255,90,200,.25) 25deg, rgba(90,220,255,.3) 45deg, transparent 80deg, transparent 190deg, rgba(150,120,255,.25) 220deg, transparent 250deg);
    -webkit-mask: radial-gradient(circle, transparent 0 10%, #000 10.5%); }
  @keyframes jr-disc-spin { to { transform: rotate(360deg); } }
`;

// The web app's stylesheet, scoped to the panel: it lives in a shadow root, the page
// rules apply to the app's own box, and the layout responds to the panel's width.
function scopedAppCss() {
  const css = appCss
    .replace(/:root\b/g, ':host')
    .replace(/html,\s*body\s*\{[^}]*\}/, '')
    .replace(/(^|\n)body\s*\{/, '$1.jr-app {')
    // Width queries, as written ("max-width: 760px") or as the minifier rewrites them ("width<=760px").
    .replace(/@media\s*(\((?:max-width\s*:|width\s*<=)[^)]*\))/g, '@container jr $1');
  return `${css}\n.jr-app { container: jr / inline-size; height: 100%; overflow: auto; }`;
}

function mountPanel(onShelf) {
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  document.head.append(style);

  const panel = document.createElement('section');
  panel.id = 'jamroom-panel';
  panel.className = 'is-closed';
  panel.setAttribute('aria-label', 'JamRoom');
  panel.innerHTML = `
    <header>
      <span>JamRoom</span>
      <button type="button" data-act="shelf" title="Switch to the 3D CD shelf">Shelf view</button>
      <button type="button" data-act="wide" title="Show more of the Jam">Wider</button>
      <button type="button" data-act="close" title="Hide (the Jam keeps playing)" aria-label="Hide">✕</button>
    </header>
    <div class="jr-host"></div>`;
  document.body.append(panel);

  const shadow = panel.querySelector('.jr-host').attachShadow({ mode: 'open' });
  const css = document.createElement('style');
  css.textContent = scopedAppCss();
  const app = document.createElement('div');
  app.className = 'jr-app';
  shadow.append(css, app);
  createRoot(app).render(
    <StrictMode>
      <PluginApp />
    </StrictMode>,
  );

  const wideButton = panel.querySelector('[data-act=wide]');
  const shelfButton = panel.querySelector('[data-act=shelf]');
  panel.addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (act === 'close') panel.classList.add('is-closed');
    if (act === 'shelf') onShelf();
    if (act === 'wide') wideButton.textContent = panel.classList.toggle('is-wide') ? 'Narrower' : 'Wider';
  });

  return {
    open: () => panel.classList.remove('is-closed'),
    toggle: () => panel.classList.toggle('is-closed'),
    isOpen: () => !panel.classList.contains('is-closed'),
    close: () => panel.classList.add('is-closed'),
    // over the shelf, the button just hides the panel again
    overShelf: (yes) => {
      shelfButton.textContent = yes ? 'Back to the shelf' : 'Shelf view';
      shelfButton.title = yes ? 'Hide this panel (the shelf stays)' : 'Switch to the 3D CD shelf';
    },
  };
}

/** The shelf is created the first time it's opened (it starts a WebGL scene). */
function shelfMount(onSimple, onPanel) {
  let el = null;
  let root = null;
  let open = false;
  const render = () => root.render(<ShelfView visible={open} onSimple={onSimple} onPanel={onPanel} onClose={() => set(false)} />);
  const ensure = () => {
    if (el) return;
    el = document.createElement('section');
    el.id = 'jamroom-shelf';
    el.className = 'is-closed';
    el.setAttribute('aria-label', 'JamRoom shelf');
    document.body.append(el);
    const shadow = el.attachShadow({ mode: 'open' });
    const css = document.createElement('style');
    css.textContent = shelfCss;
    const app = document.createElement('div');
    app.style.cssText = 'width:100%;height:100%';
    shadow.append(css, app);
    root = createRoot(app);
  };
  const set = (value) => {
    ensure();
    open = value;
    el.classList.toggle('is-closed', !open);
    render();
  };
  return { open: () => set(true), close: () => el && set(false), toggle: () => set(!open), isOpen: () => open };
}

// Spicetify 2.45 can't find the top bar in Spotify 1.3.5 (it looks for
// .main-globalNav-historyButtons, which Spotify renamed), so its buttons never appear.
// Put ours inside Spotify's own top-right button group, styled like them, and keep it
// there when Spotify re-renders.
//
// The top 60px of the window is a native drag strip (.body-drag-top, app-region: drag):
// real mouse clicks there move the window unless the element is marked no-drag.
function keepInTopBar(element) {
  element.style.setProperty('-webkit-app-region', 'no-drag');
  const place = () => {
    if (element.isConnected) return;
    const spot = document.querySelector('.main-actionButtons') ?? document.querySelector('.main-globalNav-contentRight');
    if (!spot) return;
    const native = spot.querySelector('button');
    const button = element.querySelector('button');
    if (native && button) button.className = native.className;
    spot.prepend(element);
  };
  setTimeout(place, 1500);
  setInterval(place, 2000);
}

// ---- "Add to Jam" in Spotify's right-click menu

// Songs, a whole album or playlist, or Liked Songs. An album or playlist also becomes a Jam
// playlist with its name, so it's easy to play again or save.
async function addToJam(S, panel, uris, enqueue) {
  if (!socket.joined) {
    panel.open();
    S.showNotification('Start or join a Jam in the JamRoom panel first', true);
    return;
  }
  try {
    const { name, tracks } = await spotifyTracksFor(uris);
    if (!tracks.length) return S.showNotification('No Spotify songs to add there', true);
    const items = tracks.map((t) => ({ kind: 'spotify', src: t.uri, title: t.title, artist: t.artist, durationSec: t.durationSec, art: t.art }));
    const res = await call('tracks:import', { items, enqueue, playlistName: name });
    const added = items.length - (res.skipped ?? 0);
    const what = name ? `“${name}” (${added} songs)` : added === 1 ? `“${tracks[0].title ?? 'the song'}”` : `${added} songs`;
    S.showNotification(`Added ${what} to the Jam${enqueue ? ' queue' : ' library'}`);
  } catch (err) {
    S.showNotification(err.message || "Couldn't add to the Jam", true);
  }
}

// Only the player is required. Buttons and menu items are extras: if this Spicetify or
// Spotify version lacks one, the others (and the fallback launcher) still get you in.
(function start(tries = 0) {
  // Marketplace and a manual install can both load JamRoom: only the first copy runs.
  if (tries === 0) {
    if (window.__jamroomStarted) return;
    window.__jamroomStarted = true;
  }
  const S = window.Spicetify;
  // Spicetify sets the player up in stages; it's usable once it can answer isPlaying().
  const playerReady = () => {
    try {
      S.Player.isPlaying();
      return true;
    } catch {
      return false;
    }
  };
  // If Spicetify's own start-up failed (it happens on Spotify versions it doesn't fully
  // support), start anyway after a while: everything but Spotify songs still works.
  if (!S?.Player?.playUri || !S.Platform || !document.body || (!playerReady() && tries < 40)) {
    if (tries === 100) console.error('[JamRoom] Spicetify player API not found; is Spicetify up to date?');
    setTimeout(() => start(tries + 1), 300);
    return;
  }
  // Two views of JamRoom: the simple panel, or the 3D CD shelf. The buttons and Ctrl+Alt+J
  // open whichever you used last.
  const MODE_KEY = 'jamroom:mode';
  let mode = localStorage.getItem(MODE_KEY) === 'shelf' ? 'shelf' : 'simple';
  const setMode = (next) => {
    mode = next;
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // not remembered
    }
    document.body.classList.toggle('jr-disc', next === 'shelf');
    panel.overShelf(false);
    if (next === 'shelf') {
      panel.close();
      shelf.open();
    } else {
      shelf.close();
      panel.open();
    }
  };
  const panel = mountPanel(() => setMode('shelf'));
  // In shelf mode the Jam panel slides in over the shelf, so nothing needs the simple mode.
  const shelf = shelfMount(
    () => setMode('simple'),
    () => {
      panel.overShelf(true);
      panel.toggle();
    },
  );
  document.body.classList.toggle('jr-disc', mode === 'shelf');
  if (!playerReady()) console.warn("[JamRoom] Spotify's player API is unavailable this time (Spicetify failed to start). Restart Spotify to play Spotify songs.");
  const markPlaying = () => document.body.classList.toggle('jr-playing', playerReady() && !!S.Player.isPlaying());
  S.Player.addEventListener('onplaypause', markPlaying);
  S.Player.addEventListener('songchange', markPlaying);
  markPlaying();
  let playbar = null;
  const toggle = () => {
    (mode === 'shelf' ? shelf : panel).toggle();
    if (mode === 'shelf' && !shelf.isOpen()) panel.close();
    if (playbar) playbar.active = panel.isOpen() || shelf.isOpen();
  };
  const attempt = (what, fn) => {
    try {
      return fn();
    } catch (err) {
      console.error(`[JamRoom] couldn't add the ${what}`, err);
      return null;
    }
  };
  playbar = attempt('playbar button', () => (S.Playbar?.Button ? new S.Playbar.Button('JamRoom', ICON, toggle, false, false, true) : null));
  const topbar = attempt('top bar button', () => topBarButton(S, toggle));
  if (topbar) keepInTopBar(topbar);
  keepLauncherIfHidden([topbar, playbar?.element], toggle);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'j') toggle();
  });
  attempt('right-click menu', () => addJamMenuItems((uris, enqueue) => addToJam(S, panel, uris, enqueue)));
  attempt('Discord status', () => reportToDiscord(socket));
})();

/** Spicetify's top bar button element, or our own lookalike if this Spicetify has none. */
function topBarButton(S, toggle) {
  if (S.Topbar?.Button) return new S.Topbar.Button('JamRoom', ICON, toggle).element;
  const wrap = document.createElement('div');
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'JamRoom');
  button.title = 'JamRoom';
  button.innerHTML = ICON;
  button.onclick = toggle;
  wrap.append(button);
  return wrap;
}

// Last resort: if neither button is on screen after a few seconds (a Spotify update moved
// things around), show a small round button above the playbar.
function keepLauncherIfHidden(elements, toggle) {
  const launcher = document.createElement('button');
  launcher.id = 'jamroom-launcher';
  launcher.setAttribute('aria-label', 'JamRoom');
  launcher.title = 'JamRoom (Ctrl+Alt+J)';
  launcher.innerHTML = ICON;
  launcher.onclick = toggle;
  launcher.style.cssText =
    'position:fixed;right:20px;bottom:104px;z-index:1001;width:40px;height:40px;border-radius:50%;border:0;display:none;' +
    'place-items:center;background:#1ed760;color:#000;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5);-webkit-app-region:no-drag;';
  document.body.append(launcher);
  const visible = (el) => !!el?.isConnected && el.getBoundingClientRect().width > 0;
  const check = () => {
    launcher.style.display = elements.some(visible) ? 'none' : 'grid';
  };
  setTimeout(check, 6000);
  setInterval(check, 3000);
}
