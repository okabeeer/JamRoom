// The booklet inside an open case: the tracklist printed on its inner page. Clicking a
// line plays that song; the line under the pointer is highlighted.

import * as THREE from 'three';

// Portrait, like the cases' covers (12.5 wide, 14.2 tall).
const W = 1000;
const H = 1136;
const ROWS_PER_COLUMN = 21;

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fit(g, text, width) {
  if (g.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}

export class Booklet {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.item = null;
    this.tracks = null;
    this.rows = [];
    this.hover = -1;
    this.playing = -1;
  }

  set(item, tracks, playingIndex = -1) {
    this.item = item;
    this.tracks = tracks;
    this.playing = playingIndex;
    this.hover = -1;
    this.draw();
  }

  setHover(index) {
    if (index === this.hover) return false;
    this.hover = index;
    this.draw();
    return true;
  }

  /** Track index under a point of the page (uv from a raycast), or -1. */
  trackAt(uv) {
    const x = uv.x * W;
    const y = (1 - uv.y) * H;
    return this.rows.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)?.index ?? -1;
  }

  draw() {
    const g = this.canvas.getContext('2d');
    const paper = g.createLinearGradient(0, 0, W, H);
    paper.addColorStop(0, '#f6f1e6');
    paper.addColorStop(1, '#e7dfcf');
    g.fillStyle = paper;
    g.fillRect(0, 0, W, H);
    // fold line and a subtle print border
    g.strokeStyle = 'rgba(80,60,30,0.18)';
    g.lineWidth = 2;
    g.strokeRect(36, 36, W - 72, H - 72);

    const item = this.item;
    const tracks = this.tracks;
    g.fillStyle = '#2a2116';
    g.font = '700 46px "Segoe UI", system-ui, sans-serif';
    g.fillText(fit(g, item?.title ?? '', W - 140), 70, 112);
    g.fillStyle = '#7a6a54';
    g.font = '28px "Segoe UI", system-ui, sans-serif';
    g.fillText(fit(g, item?.subtitle ?? '', W - 140), 70, 152);
    g.fillRect(70, 176, W - 140, 2);

    this.rows = [];
    if (!tracks) {
      g.fillStyle = '#7a6a54';
      g.font = 'italic 30px "Segoe UI", system-ui, sans-serif';
      g.fillText('Reading the tracklist…', 70, 240);
      this.texture.needsUpdate = true;
      return;
    }
    const columns = tracks.length > ROWS_PER_COLUMN ? 2 : 1;
    const perColumn = ROWS_PER_COLUMN;
    const shown = Math.min(tracks.length, perColumn * columns);
    const colW = (W - 140 - (columns - 1) * 40) / columns;
    const rowH = 41;
    for (let i = 0; i < shown; i++) {
      const col = Math.floor(i / perColumn);
      const x = 70 + col * (colW + 40);
      const y = 222 + (i % perColumn) * rowH;
      const t = tracks[i];
      if (i === this.hover || i === this.playing) {
        g.fillStyle = i === this.playing ? 'rgba(30,215,96,0.22)' : 'rgba(120,90,40,0.12)';
        g.fillRect(x - 10, y - 30, colW + 20, rowH - 2);
      }
      g.fillStyle = '#9a8a72';
      g.font = '600 24px "Segoe UI", system-ui, sans-serif';
      g.fillText(String(i + 1).padStart(2, '0'), x, y);
      const dur = formatTime(t.durationSec ?? t.duration);
      g.font = '24px "Segoe UI", system-ui, sans-serif';
      const durW = dur ? g.measureText(dur).width : 0;
      g.fillText(dur, x + colW - durW, y);
      g.fillStyle = i === this.hover ? '#000' : '#2a2116';
      g.font = `${i === this.hover ? 700 : 600} 25px "Segoe UI", system-ui, sans-serif`;
      g.fillText(fit(g, t.title ?? '', colW - 60 - durW - 16), x + 46, y);
      this.rows.push({ index: i, x0: x - 10, x1: x + colW + 10, y0: y - 30, y1: y + rowH - 32 });
    }
    if (tracks.length > shown) {
      g.fillStyle = '#7a6a54';
      g.font = 'italic 24px "Segoe UI", system-ui, sans-serif';
      g.fillText(`+ ${tracks.length - shown} more songs in the card on the right`, 70, H - 62);
    } else {
      g.fillStyle = '#9a8a72';
      g.font = 'italic 22px "Segoe UI", system-ui, sans-serif';
      g.fillText('Click a song to play it', 70, H - 62);
    }
    this.texture.needsUpdate = true;
  }
}
