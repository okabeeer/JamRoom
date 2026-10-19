JamRoom for Spotify
===================

Listen together inside Spotify. Add songs from Spotify, YouTube, SoundCloud, links
or your own files. Everyone hears the same moment. No account, no server.

Install (Windows)
-----------------
1. You need the Spotify desktop app from spotify.com (not the Microsoft Store version).
2. Unzip this folder, then double-click "Install JamRoom.cmd".
   It installs Spicetify (a tool that adds plugins to Spotify) if you don't have it,
   adds JamRoom, and restarts Spotify. If something goes wrong it tells you, and saves
   "JamRoom report.txt" on your Desktop: send that file back.

Mac / Linux: install Spicetify (https://spicetify.app), copy jamroom.js into
~/.config/spicetify/Extensions, then run:
   spicetify config extensions jamroom.js
   spicetify apply

Jam together
------------
- Click the headset icon in Spotify (top right, or bottom right next to the volume),
  or the round green button above the playbar, or press Ctrl+Alt+J.
- One person types their name and clicks "Start a Jam", then sends the 6-letter code.
- Everyone else types their name, enters the code under "or join a friend", and clicks Join.
- Click "Listen along" to hear the Jam on your computer.
- Add songs: right-click any Spotify song > "Add to Jam queue", or use the panel's
  Link tab (Spotify, YouTube, SoundCloud or audio links) or Upload tab (your files).

Two views: Simple and Shelf
---------------------------
"Shelf view" (top of the JamRoom panel) turns JamRoom into a 3D room over Spotify:
- A CD shelf: the Jam's queue, your playlists and your Spotify albums as glass jewel cases.
  Hover pulls a case out; click opens it: the booklet inside lists the songs (click one to
  play from there) and the disc spins in the tray (click it to play everything).
- Scroll down (or "TV corner") to an old CRT TV playing the song's Spotify Canvas video, a
  game console, and a whiteboard that writes the lyrics in marker, in time with the song.
  YouTube, SoundCloud and file songs get lyrics too (from lrclib.net) when the song is known;
  if they run early or late, use the "- 0.5 s / + 0.5 s" buttons bottom right.
- The gear button: three looks (Walnut, Birch, Ebony neon), quality for slower PCs, and
  "Back to normal Spotify". Shift+wheel or drag scrolls a shelf row; "Find a disc" searches.
- Right-click a song (in the booklet or the list) or a case for more: add one song to the Jam
  queue or library, remove it from a playlist, clear the queue, empty or delete a playlist.
- "Jam panel" (top right) slides the simple panel over the shelf: links, files, queue,
  playlists, people and settings, without leaving the shelf. "Clear queue" is there and on the deck.
Outside a Jam, discs play on your own Spotify. "Simple" (top left) switches back. The JamRoom
buttons and Ctrl+Alt+J open whichever view you used last.

Playlists you keep
------------------
- Bookmark icon on a Jam playlist = save it to "Your playlists" (kept on your computer,
  including your uploaded files). In any later Jam, press play on it under "Your playlists".
- Right-click a Spotify playlist, album or Liked Songs > "Add to Jam library" brings in all
  its songs as a Jam playlist with the same name. Save it with the bookmark to keep it.

Discord status
--------------
The installer asks whether to show what the Jam plays on your Discord profile
("Listening to ..."), for every source, not just Spotify. Discord must be open.
To turn it off: press Win+R, type shell:startup, delete "JamRoom Discord status".

Good to know
------------
- The person who starts the Jam must keep Spotify open, or the Jam pauses for everyone.
- Pausing or playing something yourself in Spotify means you stop listening along.
  Click "Listen along" to rejoin.
- Some strict networks (work, school, some mobile hotspots) block direct connections.
  If joining says it can't reach the Jam, try another network.
- The installer turns off two Spicetify options, "experimental features" and "home config":
  on this Spotify version they make the profile menu (your picture, top right) open empty.
- Spicetify changes the Spotify app, which Spotify's terms don't allow. To remove it:
  spicetify restore
