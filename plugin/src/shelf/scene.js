// The 3D CD shelf (three.js). A wooden shelf against the wall (three looks); every album,
// playlist and Jam song is a glass jewel case standing spine-out. Hover pulls a case
// forward; a click brings it to the front and opens it: the booklet inside has the
// tracklist (click a song to play it) and the disc spins in the tray (click it to play
// everything). The wheel walks down to the TV corner (corner.js): a CRT playing the song's
// Canvas and a whiteboard writing its lyrics. Shift+wheel or dragging scrolls a row.
//
// Items: { key, title, subtitle, art (URL or null), color?, nowPlaying? }

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Booklet } from './booklet.js';
import { Corner } from './corner.js';
import { canvasVideo, lyricsFor } from './media.js';

RectAreaLightUniformsLib.init();

const CASE = { thick: 2, height: 14.2, depth: 12.5 };
const GAP = 0.35;
const ROW_H = 18.5;
const BOARD = 0.9;
const MARGIN = 3;
const DISC_R = 5.6;
const LOAD_AHEAD = 30; // world units beyond the view that get their covers loaded
// Space the HTML header and deck take at the top and bottom of the view, in pixels.
const FRAME_TOP_PX = 80;
const FRAME_BOTTOM_PX = 118;
const MAX_LOADS = 6;
// Full frame rate only while something moves; otherwise just the dust drifting, at 20 fps.
const IDLE_FRAME_MS = 66; // 15 fps
const BUSY_AFTER_INPUT_MS = 1500;
const SETTLE_AFTER_MS = 10000; // then stop drawing until something changes
const CORNER_FRAME_MS = 33; // the TV and whiteboard alone: 30 fps is plenty

const damp = (k, dt) => 1 - Math.exp(-k * dt);

function hashColor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.45, 0.32);
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function texture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A printed spine: colour band, title and subtitle running top to bottom. */
function spineCanvas(item, color, dim = false) {
  const c = canvas(128, 900);
  const g = c.getContext('2d');
  const base = color.clone();
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, 128, 900);
  const shade = g.createLinearGradient(0, 0, 128, 0);
  shade.addColorStop(0, 'rgba(255,255,255,0.18)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = shade;
  g.fillRect(0, 0, 128, 900);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, 128, 54);
  g.fillRect(0, 846, 128, 54);
  const light = base.getHSL({}).l > 0.55;
  // The title runs down the spine (the artist is in the hover label), as big as the spine
  // allows and outlined, so it reads from across the room.
  g.save();
  g.translate(64, 66);
  g.rotate(Math.PI / 2);
  g.font = '800 62px "Segoe UI", system-ui, sans-serif';
  const title = fit(g, item.title ?? '', 770);
  g.lineJoin = 'round';
  g.lineWidth = 9;
  g.strokeStyle = light ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.6)';
  g.strokeText(title, 0, 22);
  g.fillStyle = light ? '#0d0d0d' : '#fffaf2';
  g.fillText(title, 0, 22);
  g.restore();
  if (item.nowPlaying) {
    g.fillStyle = '#1ed760';
    g.beginPath();
    g.arc(64, 875, 14, 0, Math.PI * 2);
    g.fill();
  }
  if (dim) {
    g.fillStyle = 'rgba(0,0,0,0.65)';
    g.fillRect(0, 0, 128, 900);
  }
  return c;
}

function fit(g, text, width) {
  if (width <= 0) return '';
  if (g.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}

/** A cover for things without one (Jam playlists, Liked Songs): gradient and title. */
function placeholderCover(item, color) {
  const c = canvas(512, 512);
  const g = c.getContext('2d');
  const a = `#${color.clone().offsetHSL(0, 0.1, 0.12).getHexString()}`;
  const b = `#${color.clone().offsetHSL(0.08, 0, -0.12).getHexString()}`;
  const grad = g.createLinearGradient(0, 0, 512, 512);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.font = '700 54px "Segoe UI", system-ui, sans-serif';
  const words = String(item.title ?? '').split(/\s+/);
  let line = '';
  let y = 330;
  const lines = [];
  for (const w of words) {
    if (g.measureText(`${line} ${w}`).width > 430 && line) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  lines.push(line);
  y = 470 - (lines.length - 1) * 62;
  for (const l of lines.slice(-3)) {
    g.fillText(l, 40, y);
    y += 62;
  }
  if (item.type === 'spotify-liked') {
    g.font = '160px "Segoe UI Symbol", system-ui';
    g.fillText('♥', 40, 200);
  }
  return c;
}

/** The disc: cover printed on it, a clear hub with a hole, a rainbow sheen. */
function discCanvas(image, color) {
  const size = 512;
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.save();
  g.beginPath();
  g.arc(256, 256, 255, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = '#c9ccd1';
  g.fillRect(0, 0, size, size);
  if (image) g.drawImage(image, 0, 0, size, size);
  else {
    g.fillStyle = `#${color.getHexString()}`;
    g.fillRect(0, 0, size, size);
  }
  if (g.createConicGradient) {
    const sheen = g.createConicGradient(3.4, 256, 256);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.06, 'rgba(255,80,200,0.25)');
    sheen.addColorStop(0.11, 'rgba(80,220,255,0.3)');
    sheen.addColorStop(0.17, 'rgba(255,240,120,0.22)');
    sheen.addColorStop(0.24, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.56, 'rgba(120,255,180,0.2)');
    sheen.addColorStop(0.61, 'rgba(160,120,255,0.26)');
    sheen.addColorStop(0.69, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.fillRect(0, 0, size, size);
  }
  // clear hub, then the hole
  g.beginPath();
  g.arc(256, 256, 70, 0, Math.PI * 2);
  g.fillStyle = 'rgba(225,228,233,0.92)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.stroke();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(256, 256, 24, 0, Math.PI * 2);
  g.fill();
  g.restore();
  return c;
}

function woodCanvas(base = '#5b3a24') {
  const c = canvas(1024, 128);
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 1024, 128);
  for (let i = 0; i < 70; i++) {
    const y = Math.random() * 128;
    g.strokeStyle = `rgba(${Math.random() < 0.5 ? '30,15,5' : '140,95,60'},${0.08 + Math.random() * 0.12})`;
    g.lineWidth = 0.5 + Math.random() * 2.5;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= 1024; x += 64) g.lineTo(x, y + Math.sin(x / (80 + Math.random() * 60)) * 3);
    g.stroke();
  }
  return c;
}

function wallCanvas([light, mid, dark]) {
  const c = canvas(1024, 768);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(380, 160, 40, 512, 384, 820);
  grad.addColorStop(0, light);
  grad.addColorStop(0.45, mid);
  grad.addColorStop(1, dark);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 768);
  return c;
}

function dustSprite() {
  const c = canvas(32, 32);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,240,215,1)');
  grad.addColorStop(1, 'rgba(255,240,215,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return texture(c);
}

/**
 * A jewel case as three draw calls instead of six: the front cover (+x), the spine (+z,
 * facing out of the shelf) and the plastic body (the other four sides).
 */
function caseGeometry() {
  const box = new THREE.BoxGeometry(CASE.thick, CASE.height, CASE.depth);
  const index = Array.from(box.index.array);
  const face = (f) => index.slice(f * 6, f * 6 + 6); // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  box.setIndex([0, 4, 1, 2, 3, 5].flatMap(face));
  box.clearGroups();
  box.addGroup(0, 6, 0);
  box.addGroup(6, 6, 1);
  box.addGroup(12, 24, 2);
  return box;
}

// Looks: the shelf's wood, the wall, the light.
const LOOKS = {
  walnut: { wood: '#5b3a24', back: '#2c1b10', floor: '#3d2717', wall: ['#4a3326', '#25190f', '#0d0907'], bg: '#0b0806', led: '#ffcf95', strip: '#ffd9a6', key: '#ffd6a0', ambient: '#ffe7cc', plate: ['#e9c983', '#9c7a3c', '#3a2a12'], sign: '#ffe2bd' },
  birch: { wood: '#c9a77c', back: '#8f7051', floor: '#a9875d', wall: ['#d9ccb9', '#a6957d', '#4f463b'], bg: '#211c17', led: '#fff1d8', strip: '#fff6e8', key: '#fff0d6', ambient: '#fff5e8', plate: ['#f5f2ec', '#c6bfb1', '#3b3328'], sign: '#fff4e2' },
  ebony: { wood: '#1e1d24', back: '#0e0d13', floor: '#141319', wall: ['#2a2450', '#120f25', '#04040a'], bg: '#030308', led: '#a07bff', strip: '#cdb6ff', key: '#b8c6ff', ambient: '#cfc8ff', plate: ['#dfe1e7', '#8b8e97', '#16151c'], sign: '#e4d9ff' },
};

// Quality: for slower computers.
const QUALITY = {
  high: { dpr: 1.5, shadows: true, leds: true, dust: true },
  medium: { dpr: 1, shadows: false, leds: true, dust: true },
  low: { dpr: 0.75, shadows: false, leds: false, dust: false },
};

const OPEN = { lid: -Math.PI * 0.965, scale: 2.1 };
// A hovered case comes out a little and turns its cover to you; its neighbours slide apart to
// make room, so it never covers them (they stay visible, hoverable and clickable).
const HOVER = { tz: 6, ry: -0.78, scale: 1.08, partLeft: 5.2, partRight: 4.4 };
const CORNER_DROP = 108; // from the shelf's bottom down to the TV corner's floor

export class ShelfScene {
  #renderer;
  #scene = new THREE.Scene();
  #camera = new THREE.PerspectiveCamera(30, 1, 1, 1200);
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2(-9, -9);
  #pointerInside = false;
  #pointerMoved = true;
  #rows = []; // { id, label, items, offset, target, y, left, right, empty }
  #cases = new Map(); // key -> case
  #hovered = null;
  #hoverHit = null;
  #selected = null;
  #open = null; // the open case model (lid, booklet, tray, disc)
  #booklet = new Booklet();
  #dust = null;
  #filter = '';
  #view = { width: 100, height: 60 };
  #frame = 0;
  #last = 0;
  #running = false;
  #loading = 0;
  #queue = [];
  #textureLoader = new THREE.TextureLoader();
  #covers = new Map(); // url -> Promise<{ texture, color, image }>
  #shared = {};
  #drag = null;
  #resizeObserver;
  #baseCam = new THREE.Vector3(0, 0, 100);
  #shelfY = 0;
  #cornerY = -100;
  #section = 0; // 0 = the shelf, 1 = the TV corner
  #sectionTarget = 0;
  #busyUntil = 0;
  #lastInput = 0;
  #needsFrame = true;
  #animating = false; // things in the room are moving: full frame rate, shadows redrawn
  #cornerBusy = false; // only the TV / whiteboard change: 30 fps, shadows kept
  #look = LOOKS.walnut;
  #quality = QUALITY.high;
  #lights = {};
  #corner = null;
  #nowPlaying = null;
  #lyricsOffset = new Map(); // now-playing key -> ms the lyrics are moved by
  #nowPlayingKey = Symbol('none yet');

  constructor(container, { onSelect, onDisc, onDeselect, onTrack, onSection, onHover, onLyrics, onMenu, look = 'walnut', quality = 'high' }) {
    this.container = container;
    this.callbacks = { onSelect, onDisc, onDeselect, onTrack, onSection, onHover, onLyrics, onMenu };
    this.#look = LOOKS[look] ?? LOOKS.walnut;
    this.#quality = QUALITY[quality] ?? QUALITY.high;
    this.#textureLoader.setCrossOrigin('anonymous');
    const r = (this.#renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.#quality.dpr));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.1;
    r.shadowMap.enabled = this.#quality.shadows;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false; // redrawn only while things move (see #tick)
    container.append(r.domElement);
    r.domElement.style.display = 'block';

    // soft reflections, so the jewel cases read as glass
    const pmrem = new THREE.PMREMGenerator(r);
    this.#scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.#scene.environmentIntensity = 0.12;
    pmrem.dispose();

    this.#buildRoom();
    this.#bindInput();
    container.jamroomStats = () => ({ frames: r.info.render.frame, calls: r.info.render.calls, animating: this.#animating, section: this.#section, tv: this.#corner?.debug(), booklet: { hover: this.#booklet.hover, rows: this.#booklet.rows.length, open: this.#open?.case.item.title ?? null } });
    // for tests: where a case is on screen (client pixels)
    container.jamroomCaseAt = (rowId, index) => {
      const c = [...this.#cases.values()].find((x) => x.row.id === rowId && x.index === index);
      if (!c) return null;
      const p = c.group.position.clone().add(new THREE.Vector3(0, 0, CASE.depth / 2)).project(this.#camera);
      const rect = r.domElement.getBoundingClientRect();
      return { x: Math.round(rect.left + ((p.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - p.y) / 2) * rect.height), title: c.item.title };
    };
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(container);
    this.#resize();
  }

  // ---- room

  #woodTexture(color) {
    const t = texture(woodCanvas(color));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  #buildRoom() {
    const s = this.#scene;
    this.#shared.wall = new THREE.MeshStandardMaterial({ roughness: 1 });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(800, 520), this.#shared.wall);
    wall.position.set(0, -70, -16);
    wall.receiveShadow = true;
    s.add(wall);

    this.#lights.ambient = new THREE.AmbientLight('#ffe7cc', 0.7);
    this.#lights.hemi = new THREE.HemisphereLight('#ffd9a8', '#1a0f08', 0.8);
    const key = (this.#lights.key = new THREE.SpotLight('#ffd6a0', 5200, 300, Math.PI / 4.5, 0.6, 1.6));
    key.position.set(-45, 70, 70);
    key.target.position.set(0, -5, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    const fill = new THREE.PointLight('#8fb7ff', 220, 200, 1.8);
    fill.position.set(60, -10, 60);
    s.add(this.#lights.ambient, this.#lights.hemi, key, key.target, fill);

    this.#shared.wood = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.05 });
    this.#shared.back = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    this.#shared.body = new THREE.MeshPhysicalMaterial({ color: '#1b1c21', roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 });
    this.#shared.caseGeo = caseGeometry();
    this.#shared.shelf = new THREE.Group();
    s.add(this.#shared.shelf);

    // dust drifting in the light, from the shelf down to the TV corner
    const n = 520;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 170;
      pos[i * 3 + 1] = 40 - Math.random() * 190;
      pos[i * 3 + 2] = 4 + Math.random() * 40;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.#dust = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.45, map: dustSprite(), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.add(this.#dust);
    this.#applyLook();
  }

  #applyLook() {
    const L = this.#look;
    const s = this.#scene;
    s.background = new THREE.Color(L.bg);
    s.fog = new THREE.Fog(L.bg, 160, 320);
    this.#shared.wall.map?.dispose();
    this.#shared.wall.map = texture(wallCanvas(L.wall));
    this.#shared.wall.needsUpdate = true;
    this.#shared.wood.map?.dispose();
    this.#shared.wood.map = this.#woodTexture(L.wood);
    this.#shared.wood.needsUpdate = true;
    this.#shared.back.map?.dispose();
    this.#shared.back.map = this.#woodTexture(L.back);
    this.#shared.back.needsUpdate = true;
    this.#lights.key.color.set(L.key);
    this.#lights.ambient.color.set(L.ambient);
    this.#lights.hemi.color.set(L.key);
    this.#corner?.setLook({ woodTexture: () => this.#woodTexture(L.wood), floorTexture: () => this.#woodTexture(L.floor) });
  }

  setLook(name) {
    if (!LOOKS[name] || LOOKS[name] === this.#look) return;
    this.#look = LOOKS[name];
    this.#applyLook();
    this.#buildShelf();
    this.#kick();
  }

  setQuality(name) {
    const q = QUALITY[name];
    if (!q || q === this.#quality) return;
    const shadowsChanged = q.shadows !== this.#quality.shadows;
    this.#quality = q;
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    this.#renderer.shadowMap.enabled = q.shadows;
    if (shadowsChanged) this.#scene.traverse((o) => [].concat(o.material ?? []).forEach((m) => (m.needsUpdate = true)));
    this.#dust.visible = q.dust;
    this.#resize();
  }

  /** Boards, sides, back, labels and LED strips for the current rows and view width; and the TV corner below. */
  #buildShelf() {
    const group = this.#shared.shelf;
    for (const child of [...group.children]) {
      group.remove(child);
      child.geometry?.dispose();
    }
    const L = this.#look;
    const rows = this.#rows.length || 1;
    const width = this.#view.width - MARGIN;
    const height = rows * ROW_H + BOARD;
    const top = (rows * ROW_H) / 2;
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
      return m;
    };
    add(new THREE.BoxGeometry(width + 4, height + 2, 1), this.#shared.back, 0, 0, -CASE.depth / 2 - 1);
    for (let i = 0; i <= rows; i++) add(new THREE.BoxGeometry(width + 4, BOARD, CASE.depth + 3), this.#shared.wood, 0, top - i * ROW_H, 0.6);
    for (const side of [-1, 1]) add(new THREE.BoxGeometry(2, height + 2, CASE.depth + 3.4), this.#shared.wood, side * (width / 2 + 1), 0, 0.6);
    this.#rows.forEach((row, i) => {
      row.y = top - (i + 1) * ROW_H + BOARD / 2 + CASE.height / 2 + 0.02; // standing on the board below
      row.left = -width / 2 + 1.6;
      row.right = width / 2 - 1.6;
      // an engraved plate on the board's front edge
      const label = canvas(512, 64);
      const g = label.getContext('2d');
      const metal = g.createLinearGradient(0, 0, 0, 64);
      metal.addColorStop(0, L.plate[0]);
      metal.addColorStop(1, L.plate[1]);
      g.fillStyle = metal;
      g.fillRect(0, 0, 512, 64);
      g.fillStyle = L.plate[2];
      g.font = '700 34px "Segoe UI", system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(row.label.toUpperCase(), 256, 44);
      const labelMap = texture(label);
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(14, 1.75),
        new THREE.MeshStandardMaterial({ map: labelMap, emissiveMap: labelMap, emissive: '#ffffff', emissiveIntensity: 0.35, metalness: 0.6, roughness: 0.35 }),
      );
      plate.position.set(row.left + 8, top - (i + 1) * ROW_H, CASE.depth / 2 + 2.15);
      group.add(plate);

      // an LED strip under the board above, lighting the CDs like a display shelf
      const boardBottom = top - i * ROW_H - BOARD / 2;
      if (this.#quality.leds) {
        const led = new THREE.RectAreaLight(L.led, 4.5, width, 1.2);
        led.position.set(0, boardBottom - 0.05, CASE.depth / 2 - 0.5);
        led.rotation.x = -Math.PI / 2;
        group.add(led);
      }
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.22), new THREE.MeshBasicMaterial({ color: L.strip }));
      strip.position.set(0, boardBottom - 0.02, CASE.depth / 2 + 0.6);
      strip.rotation.x = Math.PI / 2;
      group.add(strip);

      if (row.empty) {
        const sign = canvas(1024, 128);
        const sg = sign.getContext('2d');
        sg.font = '600 54px "Segoe UI", system-ui, sans-serif';
        const fitted = Math.min(54, Math.floor((54 * 960) / sg.measureText(row.empty).width));
        sg.font = `600 ${fitted}px "Segoe UI", system-ui, sans-serif`;
        sg.textAlign = 'center';
        sg.shadowColor = L.led;
        sg.shadowBlur = 24;
        sg.fillStyle = L.sign;
        sg.fillText(row.empty, 512, 82);
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(44, 5.5), new THREE.MeshBasicMaterial({ map: texture(sign), transparent: true, depthWrite: false }));
        glow.position.set(0, row.y, -CASE.depth / 2 + 0.2);
        group.add(glow);
      }
    });
    this.#lights.ambient.intensity = this.#quality.leds ? 0.7 : 1.15;

    // the TV corner sits on the floor below the shelf
    const floorY = -top - CORNER_DROP;
    if (!this.#corner || this.#corner.floorY !== floorY) {
      if (this.#corner) {
        this.#scene.remove(this.#corner.group);
        this.#corner.dispose();
      }
      this.#corner = new Corner({ floorY, wallZ: -16, look: { woodTexture: () => this.#woodTexture(this.#look.wood), floorTexture: () => this.#woodTexture(this.#look.floor) } });
      this.#scene.add(this.#corner.group);
      this.#showNowPlaying(this.#nowPlaying, true);
    }
    this.#cornerY = floorY + 30;
  }

  // ---- rows and cases

  /** rows: [{ id, label, items, emptyText }]. Keeps existing cases (and their scroll) where keys match. */
  setRows(rows) {
    const keep = new Set();
    const emptyText = (r) => (r.items.length ? null : r.emptyText ?? null);
    const shapeChanged = rows.length !== this.#rows.length || rows.some((r, i) => r.label !== this.#rows[i]?.label || emptyText(r) !== this.#rows[i]?.empty);
    const previous = new Map(this.#rows.map((r) => [r.id, r]));
    this.#rows = rows.map((r) => ({ ...r, empty: emptyText(r), offset: previous.get(r.id)?.offset ?? 0, target: previous.get(r.id)?.target ?? 0 }));
    if (shapeChanged) this.#buildShelf();
    else this.#rows.forEach((row) => Object.assign(row, { y: previous.get(row.id)?.y, left: previous.get(row.id)?.left, right: previous.get(row.id)?.right }));
    for (const row of this.#rows) {
      row.items.forEach((item, index) => {
        const key = `${row.id}|${item.key}`;
        keep.add(key);
        let c = this.#cases.get(key);
        if (!c) c = this.#makeCase(item, row);
        else if (c.item.title !== item.title || c.item.art !== item.art || !!c.item.nowPlaying !== !!item.nowPlaying) {
          c.item = item;
          this.#paintSpine(c);
          if (c.coverUrl !== item.art) this.#resetCover(c);
        }
        c.item = item;
        c.row = row;
        c.index = index;
      });
      this.#clampRow(row);
    }
    for (const [key, c] of this.#cases) {
      if (keep.has(key)) continue;
      if (this.#selected === c) this.deselect();
      this.#scene.remove(c.group);
      c.spine.map?.dispose();
      c.spine.dispose();
      c.cover.dispose();
      this.#cases.delete(key);
    }
    this.#applyFilter();
    this.#kick();
  }

  #makeCase(item, row) {
    const color = item.color ? new THREE.Color(item.color) : hashColor(item.title);
    const spine = new THREE.MeshPhysicalMaterial({ roughness: 0.45, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.2 });
    const cover = new THREE.MeshPhysicalMaterial({ color: '#222', roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 });
    const mesh = new THREE.Mesh(this.#shared.caseGeo, [cover, spine, this.#shared.body]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.add(mesh);
    const c = { key: `${row.id}|${item.key}`, item, row, index: 0, group, mesh, spine, cover, color, coverUrl: null, loaded: false, image: null, dim: false };
    mesh.userData.case = c;
    group.position.set(row.right + 20, row.y ?? 0, 0);
    this.#scene.add(group);
    this.#paintSpine(c);
    if (!item.art) this.#usePlaceholder(c);
    this.#cases.set(c.key, c);
    return c;
  }

  #paintSpine(c) {
    c.spine.map?.dispose();
    c.spine.map = texture(spineCanvas(c.item, c.color, c.dim));
    c.spine.needsUpdate = true;
  }

  #usePlaceholder(c) {
    c.cover.map = texture(placeholderCover(c.item, c.color));
    c.cover.color.set('#fff');
    c.cover.needsUpdate = true;
    c.loaded = true;
  }

  #resetCover(c) {
    c.loaded = false;
    c.coverUrl = null;
    c.image = null;
    if (!c.item.art) this.#usePlaceholder(c);
  }

  /** Covers load lazily (only near the view) and give the spine its colour. */
  #loadCover(c) {
    if (c.loaded || c.loading || !c.item.art) return;
    c.loading = true;
    this.#queue.push(c);
    this.#pump();
  }

  #pump() {
    while (this.#loading < MAX_LOADS && this.#queue.length) {
      const c = this.#queue.shift();
      const url = c.item.art;
      this.#loading++;
      if (!this.#covers.has(url)) {
        this.#covers.set(
          url,
          this.#textureLoader.loadAsync(url).then((t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            t.anisotropy = 4;
            return { texture: t, color: averageColor(t.image), image: t.image };
          }),
        );
      }
      this.#covers
        .get(url)
        .then(({ texture: t, color, image }) => {
          if (c.item.art !== url) return;
          c.cover.map = t;
          c.cover.color.set('#fff');
          c.cover.needsUpdate = true;
          c.image = image;
          c.coverUrl = url;
          if (color && !c.item.color) {
            c.color = color;
            this.#paintSpine(c);
          }
          c.loaded = true;
          if (this.#open?.case === c) this.#paintOpenCase();
        })
        .catch(() => this.#usePlaceholder(c))
        .finally(() => {
          c.loading = false;
          this.#loading--;
          this.#pump();
          this.#kick();
        });
    }
  }

  setFilter(text) {
    this.#filter = String(text ?? '').trim().toLowerCase();
    this.#applyFilter();
    if (this.#filter) {
      for (const row of this.#rows) {
        const i = row.items.findIndex((it) => matches(it, this.#filter));
        if (i >= 0) row.target = Math.max(0, i * (CASE.thick + GAP) - 6);
        this.#clampRow(row);
      }
      this.goTo(0);
    }
    this.#kick();
  }

  #applyFilter() {
    for (const c of this.#cases.values()) {
      const dim = !!this.#filter && !matches(c.item, this.#filter);
      if (dim !== c.dim) {
        c.dim = dim;
        this.#paintSpine(c);
      }
    }
  }

  // ---- the open case: lid, booklet with the tracklist, tray with the disc

  select(c) {
    if (this.#selected === c) return;
    this.deselect(false);
    this.#selected = c;
    this.#loadCover(c);
    this.#openCase(c);
    this.#booklet.set(c.item, null);
    this.callbacks.onSelect?.(c.item);
    this.#kick();
  }

  deselect(notify = true) {
    if (!this.#selected) return;
    this.#selected = null;
    if (this.#open) this.#open.closing = true;
    if (notify) this.callbacks.onDeselect?.();
    this.#kick();
  }

  /** The tracklist printed in the open case's booklet (ShelfView reads it). */
  setBooklet(itemKey, tracks, playingIndex = -1) {
    if (this.#open?.case.item.key !== itemKey) return;
    this.#booklet.set(this.#open.case.item, tracks, playingIndex);
    this.#kick();
  }

  #openCase(c) {
    if (this.#open) this.#disposeOpen();
    const W = CASE.depth;
    const H = CASE.height;
    const root = new THREE.Group();
    // the tray (right half): smoky plastic with a hub for the disc
    const trayFace = canvas(512, 580);
    const tg = trayFace.getContext('2d');
    tg.fillStyle = '#121216';
    tg.fillRect(0, 0, 512, 580);
    tg.strokeStyle = 'rgba(255,255,255,0.08)';
    tg.lineWidth = 3;
    for (const r of [70, 120, 236]) {
      tg.beginPath();
      tg.arc(256, 290, r, 0, Math.PI * 2);
      tg.stroke();
    }
    const trayMat = new THREE.MeshPhysicalMaterial({ map: texture(trayFace), roughness: 0.35, clearcoat: 1 });
    const tray = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.9), [this.#shared.body, this.#shared.body, this.#shared.body, this.#shared.body, trayMat, this.#shared.body]);
    tray.position.set(W / 2, 0, -0.2);
    tray.castShadow = true;
    root.add(tray);

    // the disc in the tray
    const discTop = new THREE.MeshPhysicalMaterial({ transparent: true, roughness: 0.18, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.6, iridescenceIOR: 1.6 });
    const edge = new THREE.MeshStandardMaterial({ color: '#d7dbe0', metalness: 0.8, roughness: 0.25 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(DISC_R, DISC_R, 0.12, 96), [edge, discTop, edge]);
    disc.position.set(W / 2, 0, 0.35);
    disc.castShadow = true;
    root.add(disc);

    // the lid, hinged on the left edge: glass with the cover behind it outside, the booklet inside
    const pivot = new THREE.Group();
    const coverMat = new THREE.MeshPhysicalMaterial({ roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.03 });
    const bookletMat = new THREE.MeshStandardMaterial({ map: this.#booklet.texture, roughness: 0.75 });
    const glass = new THREE.MeshPhysicalMaterial({ color: '#dfe6ee', roughness: 0.08, transparent: true, opacity: 0.35, clearcoat: 1 });
    const lid = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.55), [glass, glass, glass, glass, coverMat, bookletMat]);
    lid.position.set(W / 2, 0, 0.75);
    lid.castShadow = true;
    pivot.add(lid);
    root.add(pivot);

    root.scale.setScalar(1);
    root.position.copy(c.group.position);
    root.rotation.set(0, -Math.PI / 2, 0);
    this.#scene.add(root);
    c.group.visible = false;
    this.#open = { case: c, root, pivot, lid, tray, disc, discTop, coverMat, closing: false, lidAngle: 0, spin: 0, bookletMat };
    this.#paintOpenCase();
  }

  #paintOpenCase() {
    const o = this.#open;
    if (!o) return;
    const c = o.case;
    o.coverMat.map = c.cover.map;
    o.coverMat.needsUpdate = true;
    o.discTop.map?.dispose();
    o.discTop.map = texture(discCanvas(c.image, c.color));
    o.discTop.needsUpdate = true;
  }

  #disposeOpen() {
    const o = this.#open;
    this.#scene.remove(o.root);
    o.discTop.map?.dispose();
    o.case.group.visible = true;
    this.#open = null;
  }

  // ---- now playing: the TV and the whiteboard follow it

  /**
   * np: { key, uri (Spotify track URI or null), title, art, position() -> ms, playing }
   * The TV shows the song's Canvas (else its art, else static); the whiteboard its lyrics.
   */
  setNowPlaying(np) {
    this.#nowPlaying = np;
    const key = np?.key ?? null;
    if (key === this.#nowPlayingKey) return;
    this.#nowPlayingKey = key;
    this.#showNowPlaying(np);
  }

  async #showNowPlaying(np, force = false) {
    const corner = this.#corner;
    if (!corner) return;
    if (!np) {
      corner.setScreen({});
      corner.setLyrics(null, '', { idle: true });
      this.#kick();
      return;
    }
    corner.setScreen({ image: np.art });
    corner.setLyrics(undefined, np.title);
    this.#kick();
    const [video, words] = await Promise.all([np.uri ? canvasVideo(np.uri) : null, lyricsFor(np)]);
    if (this.#nowPlayingKey !== np.key && !force) return;
    if (video) corner.setScreen({ video });
    corner.setLyrics(words, np.title);
    this.callbacks.onLyrics?.(words ? { source: words.source, synced: words.synced } : null);
    this.#kick();
  }

  /** Lyrics a bit earlier (negative) or later for this song; YouTube videos often have intros. */
  nudgeLyrics(deltaMs) {
    const key = this.#nowPlayingKey;
    const offset = (this.#lyricsOffset.get(key) ?? 0) + deltaMs;
    this.#lyricsOffset.set(key, offset);
    this.#kick();
    return offset;
  }

  /** 0: the shelf, 1: the TV corner. */
  goTo(section) {
    this.#sectionTarget = section ? 1 : 0;
    this.#kick();
  }

  // ---- input

  #bindInput() {
    const el = this.#renderer.domElement;
    const toPointer = (e) => {
      const r = el.getBoundingClientRect();
      this.#pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    el.addEventListener('pointermove', (e) => {
      toPointer(e);
      this.#pointerInside = true;
      this.#pointerMoved = true;
      if (this.#drag) {
        const dx = e.clientX - this.#drag.x;
        if (Math.abs(dx) > 4) this.#drag.moved = true;
        const row = this.#drag.row;
        if (row) {
          row.target = this.#drag.start - dx * (this.#view.width / el.clientWidth);
          this.#clampRow(row);
        }
      }
      this.#kick();
    });
    el.addEventListener('pointerleave', () => {
      this.#pointerInside = false;
      this.#pointer.set(-9, -9);
      this.#kick();
    });
    el.addEventListener('pointerdown', (e) => {
      toPointer(e);
      const row = this.#section < 0.5 ? this.#rowAtPointer() : null;
      this.#drag = { x: e.clientX, start: row?.target ?? 0, row, moved: false };
    });
    window.addEventListener('pointerup', () => {
      setTimeout(() => (this.#drag = null), 0);
    });
    el.addEventListener('click', (e) => {
      if (this.#drag?.moved) return;
      toPointer(e);
      const hit = this.#pick();
      const item = this.#open?.case.item;
      if (hit?.disc && item) return this.callbacks.onDisc?.(item);
      if (hit?.booklet && item) {
        const index = this.#booklet.trackAt(hit.uv);
        if (index >= 0) this.callbacks.onTrack?.(item, index);
        return;
      }
      if (hit?.openCase) return;
      if (hit?.case) return this.select(hit.case);
      this.deselect();
    });
    // right-click: a song in the open booklet, the open case, or a case on the shelf
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      toPointer(e);
      const hit = this.#pick();
      const item = this.#open?.case.item;
      const at = { x: e.clientX, y: e.clientY };
      if (hit?.booklet && item) {
        const index = this.#booklet.trackAt(hit.uv);
        return this.callbacks.onMenu?.(index >= 0 ? { item, index } : { item }, at);
      }
      if ((hit?.disc || hit?.openCase) && item) return this.callbacks.onMenu?.({ item }, at);
      if (hit?.case) this.callbacks.onMenu?.({ item: hit.case.item }, at);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        toPointer(e);
        e.preventDefault();
        const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (sideways && this.#section < 0.5) {
          // Shift+wheel or a sideways swipe scrolls the row under the pointer
          const row = this.#rowAtPointer();
          if (row) {
            row.target += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * 0.06;
            this.#clampRow(row);
          }
        } else {
          // the wheel walks down to the TV corner and back up
          this.#sectionTarget = Math.min(1, Math.max(0, this.#sectionTarget + e.deltaY * 0.0022));
        }
        this.#kick();
      },
      { passive: false },
    );
  }

  #pick() {
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const targets = [];
    const o = this.#open;
    if (o && !o.closing) targets.push(o.disc, o.lid, o.tray);
    for (const c of this.#cases.values()) if (c.group.visible) targets.push(c.mesh);
    const hit = this.#raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    if (o && hit.object === o.disc) return { disc: true };
    if (o && hit.object === o.lid) return hit.face?.materialIndex === 5 ? { booklet: true, uv: hit.uv } : { openCase: true };
    if (o && hit.object === o.tray) return { openCase: true };
    return { case: hit.object.userData.case };
  }

  #rowAtPointer() {
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const p = new THREE.Vector3();
    if (!this.#raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -CASE.depth / 2), p)) return null;
    return this.#rows.find((r) => Math.abs(p.y - r.y) < ROW_H / 2) ?? null;
  }

  #clampRow(row) {
    const length = row.items.length * (CASE.thick + GAP);
    const room = (row.right ?? 0) - (row.left ?? 0) - 2;
    row.target = Math.min(Math.max(0, row.target), Math.max(0, length - room));
  }

  // ---- layout and animation

  #resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.#renderer.setSize(w, h, false);
    this.#renderer.domElement.style.width = '100%';
    this.#renderer.domElement.style.height = '100%';
    this.#camera.aspect = w / h;
    const rows = Math.max(1, this.#rows.length || 3);
    // Frame the shelf in the band between the header and the deck.
    const band = Math.max(120, h - FRAME_TOP_PX - FRAME_BOTTOM_PX);
    const needH = ((rows * ROW_H + 3) * h) / band;
    const fov = THREE.MathUtils.degToRad(this.#camera.fov);
    const dist = needH / 2 / Math.tan(fov / 2);
    const shiftPx = (FRAME_BOTTOM_PX - FRAME_TOP_PX) / 2;
    this.#shelfY = (-shiftPx * needH) / h;
    this.#baseCam = new THREE.Vector3(0, this.#shelfY, dist + CASE.depth / 2);
    this.#camera.updateProjectionMatrix();
    const viewH = 2 * Math.tan(fov / 2) * dist;
    this.#view = { width: Math.min(viewH * this.#camera.aspect, 400), height: viewH };
    this.#buildShelf();
    for (const row of this.#rows) this.#clampRow(row);
    this.#kick();
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#last = performance.now();
    this.#kick();
    const loop = (now) => {
      if (!this.#running) return;
      this.#frame = requestAnimationFrame(loop);
      const busy = this.#animating || now < this.#busyUntil;
      if (!busy && this.#cornerBusy) {
        if (now - this.#last < CORNER_FRAME_MS) return;
      } else if (!busy) {
        const settled = now - this.#lastInput > SETTLE_AFTER_MS;
        if (settled ? !this.#needsFrame : now - this.#last < IDLE_FRAME_MS) return;
      }
      this.#needsFrame = false;
      this.#tick(Math.min(0.05, (now - this.#last) / 1000));
      this.#last = now;
    };
    this.#frame = requestAnimationFrame(loop);
  }

  stop() {
    this.#running = false;
    cancelAnimationFrame(this.#frame);
    this.#corner?.update(0, 0, false); // pauses the TV
  }

  /** Something changed: render at full rate (and redraw shadows) for a moment. */
  #kick() {
    this.#lastInput = performance.now();
    this.#needsFrame = true;
    this.#busyUntil = this.#lastInput + BUSY_AFTER_INPUT_MS;
    this.#renderer.shadowMap.needsUpdate = true;
  }

  #tick(dt) {
    const t = performance.now() / 1000;
    let moving = false;

    // walking between the shelf and the TV corner
    if (Math.abs(this.#sectionTarget - this.#section) > 0.001) moving = true;
    const before = Math.round(this.#section);
    this.#section += (this.#sectionTarget - this.#section) * damp(5, dt);
    if (Math.round(this.#section) !== before) this.callbacks.onSection?.(Math.round(this.#section));
    const camY = this.#shelfY + (this.#cornerY - this.#shelfY) * this.#section;

    // the camera breathes a little and follows the pointer
    const cam = this.#camera;
    const px = this.#pointerInside ? this.#pointer.x : 0;
    const py = this.#pointerInside ? this.#pointer.y : 0;
    cam.position.x += (this.#baseCam.x + px * 2.2 - cam.position.x) * damp(3, dt);
    cam.position.y += (camY + py * 1.4 + Math.sin(t * 0.4) * 0.15 - cam.position.y) * damp(3, dt);
    cam.position.z = this.#baseCam.z;
    cam.lookAt(px * 0.6, camY + py * 0.4, 0);

    // hover: only re-picked when the pointer or things moved
    if (this.#pointerMoved || this.#animating) {
      this.#pointerMoved = false;
      this.#hoverHit = this.#pointerInside && !this.#drag?.moved ? this.#pick() : null;
      const h = this.#hoverHit;
      const overIndex = h?.booklet ? this.#booklet.trackAt(h.uv) : -1;
      const overTrack = overIndex >= 0;
      if (this.#booklet.setHover(overIndex)) this.#kick();
      this.renderer.domElement.style.cursor = h?.case || h?.disc || overTrack ? 'pointer' : this.#drag ? 'grabbing' : 'default';
    }
    const hoverCase = this.#hoverHit?.case ?? null;
    if (hoverCase !== this.#hovered) {
      this.#kick();
      this.callbacks.onHover?.(hoverCase?.item ?? null);
    }
    this.#hovered = hoverCase;

    for (const row of this.#rows) {
      if (Math.abs(row.target - row.offset) > 0.01) moving = true;
      row.offset += (row.target - row.offset) * damp(10, dt);
    }

    const k = damp(9, dt);
    const nearShelf = this.#section < 0.6;
    for (const c of this.#cases.values()) {
      const row = c.row;
      const slot = row.left + c.index * (CASE.thick + GAP) + CASE.thick / 2 - row.offset;
      const onShelf = slot > row.left - 1 && slot < row.right + 1;
      // the hovered case's row parts around it
      const parted = hoverCase && hoverCase.row === row && c !== hoverCase;
      const x = parted ? slot + (c.index < hoverCase.index ? -HOVER.partLeft : HOVER.partRight) : slot;
      if (this.#open?.case === c) continue; // the open case model stands in for it
      if (onShelf && nearShelf && Math.abs(x) < this.#view.width / 2 + LOAD_AHEAD) this.#loadCover(c);
      let tz = 0;
      let ry = 0;
      let scale = 1;
      if (c === hoverCase) {
        tz = HOVER.tz;
        ry = HOVER.ry;
        scale = HOVER.scale;
      } else if (c.item.nowPlaying) {
        tz = 2.2;
      }
      const g = c.group;
      if (!onShelf) {
        g.visible = false;
        g.position.set(slot, row.y, 0);
        continue;
      }
      g.visible = true;
      const far = Math.abs(x - g.position.x) + Math.abs(row.y - g.position.y) + Math.abs(tz - g.position.z);
      if (far > 0.02 || Math.abs(ry - g.rotation.y) > 0.002 || Math.abs(scale - g.scale.x) > 0.002) moving = true;
      g.scale.setScalar(g.scale.x + (scale - g.scale.x) * k);
      g.position.x += (x - g.position.x) * k;
      g.position.y += (row.y - g.position.y) * k;
      g.position.z += (tz - g.position.z) * k;
      g.rotation.y += (ry - g.rotation.y) * k;
      c.spine.emissive.set(c.item.nowPlaying ? '#1a5c30' : '#000');
      c.spine.emissiveIntensity = c.item.nowPlaying ? 0.35 + Math.sin(t * 3) * 0.15 : 0;
    }

    // the open case: flies to the front, the lid swings open on the booklet, the disc spins
    const o = this.#open;
    let gentle = false; // only the disc spins and the case sways: 30 fps, no shadow redraws
    if (o) {
      const c = o.case;
      const shelfPos = new THREE.Vector3(c.row.left + c.index * (CASE.thick + GAP) + CASE.thick / 2 - c.row.offset, c.row.y, 0);
      const front = new THREE.Vector3(-14, camY - 1, CASE.depth / 2 + 24);
      const target = o.closing ? shelfPos : front;
      const kk = damp(o.closing ? 10 : 6, dt);
      o.root.position.lerp(target, kk);
      const ryTarget = o.closing ? -Math.PI / 2 : Math.sin(t * 0.6) * 0.05;
      o.root.rotation.y += (ryTarget - o.root.rotation.y) * kk;
      o.root.scale.setScalar(o.root.scale.x + ((o.closing ? 1 : OPEN.scale) - o.root.scale.x) * kk);
      const arrived = o.root.position.distanceTo(front) < 3;
      const lidTarget = !o.closing && arrived ? OPEN.lid : 0;
      o.lidAngle += (lidTarget - o.lidAngle) * damp(o.closing ? 14 : 4, dt);
      o.pivot.rotation.y = o.lidAngle;
      const settled = !o.closing && o.root.position.distanceTo(front) < 0.3 && Math.abs(o.lidAngle - OPEN.lid) < 0.01;
      if (settled) gentle = true;
      else moving = true;
      o.spin += dt * (this.#hoverHit?.disc ? 4 : 1.2);
      o.disc.rotation.set(Math.PI / 2, o.spin, 0);
      if (o.closing && o.root.position.distanceTo(shelfPos) < 0.6 && Math.abs(o.lidAngle) < 0.05) {
        c.group.position.copy(shelfPos);
        c.group.rotation.y = 0;
        this.#disposeOpen();
      }
    }

    // the TV corner
    const np = this.#nowPlaying;
    if (this.#corner) {
      const positionMs = (np?.position?.() ?? 0) - (this.#lyricsOffset.get(this.#nowPlayingKey) ?? 0);
      if (this.#corner.update(dt, positionMs, this.#section > 0.35)) gentle = true;
    }

    // dust
    if (this.#dust.visible) {
      const p = this.#dust.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) + dt * (0.25 + (i % 7) * 0.05);
        if (y > 40) y = -150;
        p.setY(i, y);
        p.setX(i, p.getX(i) + Math.sin(t * 0.3 + i) * dt * 0.3);
      }
      p.needsUpdate = true;
    }

    this.#animating = moving;
    this.#cornerBusy = gentle;
    if (moving && this.#quality.shadows) this.#renderer.shadowMap.needsUpdate = true;
    this.#renderer.render(this.#scene, cam);
  }

  get renderer() {
    return this.#renderer;
  }

  dispose() {
    this.stop();
    this.#corner?.dispose();
    this.#resizeObserver.disconnect();
    this.#renderer.dispose();
    this.#renderer.domElement.remove();
  }
}

function matches(item, filter) {
  return `${item.title ?? ''} ${item.subtitle ?? ''}`.toLowerCase().includes(filter);
}

function averageColor(image) {
  try {
    const c = canvas(8, 8);
    const g = c.getContext('2d');
    g.drawImage(image, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data;
    let r = 0;
    let gr = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      gr += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    const color = new THREE.Color(r / n / 255, gr / n / 255, b / n / 255);
    color.convertSRGBToLinear();
    const hsl = color.getHSL({});
    // keep spines readable: not too dark, not too pale
    return new THREE.Color().setHSL(hsl.h, Math.min(0.7, hsl.s * 1.1), Math.min(0.62, Math.max(0.22, hsl.l)));
  } catch {
    return null;
  }
}
