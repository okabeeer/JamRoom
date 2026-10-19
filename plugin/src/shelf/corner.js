// The TV corner under the shelf: a low cabinet with a CRT TV playing the song's Canvas
// (or its cover, or static), a game console, and a whiteboard that writes the lyrics out
// in marker, line by line, in time with the song.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const MARKER_FONT = '"Ink Free", "Segoe Print", "Comic Sans MS", cursive';
const BOARD_W = 46;
const BOARD_H = 31;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function srgb(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// A CRT: the picture bent onto a curved tube, scanlines, a soft glow and vignette.
const CRT = {
  uniforms: { map: { value: null }, hasMap: { value: 0 }, time: { value: 0 }, power: { value: 1 }, crop: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D map; uniform float hasMap; uniform float time; uniform float power; uniform vec2 crop; varying vec2 vUv;
    float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec2 bend(vec2 uv) { uv = uv * 2.0 - 1.0; vec2 o = abs(uv.yx) / vec2(5.5, 4.5); uv += uv * o * o; return uv * 0.5 + 0.5; }
    void main() {
      vec2 uv = bend(vUv);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      vec3 col;
      if (hasMap > 0.5) {
        // fill the 4:3 tube (portrait Canvas videos are cropped to their middle)
        vec2 p = 0.5 + (uv - 0.5) * crop;
        // a touch of colour bleed, like a real tube
        col.r = texture2D(map, p + vec2(0.0015, 0.0)).r;
        col.g = texture2D(map, p).g;
        col.b = texture2D(map, p - vec2(0.0015, 0.0)).b;
      } else {
        float n = rand(floor(uv * vec2(220.0, 160.0)) + floor(time * 24.0));
        col = vec3(n * 0.55);
      }
      col *= 0.82 + 0.18 * sin(uv.y * 900.0);                 // scanlines
      col *= 0.96 + 0.04 * sin(time * 50.0);                  // flicker
      vec2 v = uv * (1.0 - uv.yx); col *= pow(v.x * v.y * 18.0, 0.22); // vignette
      gl_FragColor = vec4(col * 1.25 * power, 1.0);
    }`,
};

/** The whiteboard and its "pen": lines are written out as the song reaches them. */
class Whiteboard {
  constructor() {
    this.canvas = canvas(1100, 740);
    this.g = this.canvas.getContext('2d');
    this.texture = srgb(this.canvas);
    this.lyrics = undefined; // undefined: loading; null: none
    this.title = '';
    this.index = -2;
    this.progress = 1;
    this.writeMs = 900;
    this.dirty = true;
  }

  set(lyrics, title, { idle = false } = {}) {
    this.lyrics = lyrics;
    this.idle = idle;
    this.title = title ?? '';
    this.index = -2;
    this.progress = 1;
    this.dirty = true;
  }

  /** Returns true while the pen is moving (the board needs redrawing every frame). */
  update(dt, positionMs) {
    const l = this.lyrics;
    if (l?.synced) {
      let i = -1;
      for (let k = 0; k < l.lines.length; k++) if (l.lines[k].ms <= positionMs + 120) i = k;
      if (i !== this.index) {
        this.index = i;
        this.progress = i >= 0 && l.lines[i].text ? 0 : 1;
        const next = l.lines[i + 1]?.ms ?? (l.lines[i]?.ms ?? 0) + 2500;
        this.writeMs = Math.min(1700, Math.max(450, (next - (l.lines[i]?.ms ?? 0)) * 0.55));
        this.dirty = true;
      }
      if (this.progress < 1) {
        this.progress = Math.min(1, this.progress + (dt * 1000) / this.writeMs);
        this.dirty = true;
      }
    }
    if (!this.dirty) return false;
    this.dirty = false;
    this.#draw();
    this.texture.needsUpdate = true;
    return this.progress < 1;
  }

  #marker(text, x, y, color, size, reveal = 1, seed = 0) {
    const g = this.g;
    g.font = `600 ${size}px ${MARKER_FONT}`;
    const width = g.measureText(text).width;
    g.save();
    if (reveal < 1) {
      g.beginPath();
      g.rect(x - 10, y - size * 1.2, (width + 20) * reveal, size * 1.8);
      g.clip();
    }
    g.translate(x, y);
    g.rotate(Math.sin(seed * 12.9) * 0.012);
    g.fillStyle = color;
    g.strokeStyle = color;
    g.lineWidth = size * 0.035;
    g.lineJoin = 'round';
    g.fillText(text, 0, 0);
    g.strokeText(text, 0, 0);
    g.restore();
    return width;
  }

  /** Long lines wrap onto the next row of the board. */
  #wrap(text, size, max) {
    const g = this.g;
    g.font = `600 ${size}px ${MARKER_FONT}`;
    const words = text.split(/\s+/);
    const rows = [];
    let row = '';
    for (const w of words) {
      const test = row ? `${row} ${w}` : w;
      if (g.measureText(test).width > max && row) {
        rows.push(row);
        row = w;
      } else row = test;
    }
    if (row) rows.push(row);
    return rows;
  }

  #draw() {
    const g = this.g;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // the board: white, with the ghosts of old writing
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#fbfbf8');
    bg.addColorStop(1, '#e9ebe9');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 0.05;
    for (let i = 0; i < 9; i++) {
      g.fillStyle = '#4a5a80';
      g.beginPath();
      g.ellipse(120 + ((i * 237) % 900), 90 + ((i * 131) % 560), 160, 26, (i % 3) * 0.2, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    const left = 52;
    const max = W - 2 * left;
    this.#marker(this.title ? `♪ ${this.title}` : '♪', left, 72, '#1f4fbf', 40, 1, 1);
    g.strokeStyle = 'rgba(31,79,191,0.6)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(left, 92);
    g.quadraticCurveTo(W / 2, 100, W - left, 88);
    g.stroke();

    const l = this.lyrics;
    if (this.idle) {
      this.#marker('nothing playing yet', left, 210, '#c4302b', 50, 1, 6);
      this.#marker('pick a disc on the shelf  ↑', left + 30, 290, '#1f4fbf', 44, 1, 7);
      return;
    }
    if (l === undefined) {
      this.#marker('reading the lyrics…', left, 200, '#555', 46, 1, 2);
      return;
    }
    if (l === null) {
      this.#marker('no lyrics for this one', left, 220, '#c4302b', 50, 1, 3);
      this.#marker('(just vibe)  ☺', left + 40, 300, '#333', 44, 1, 4);
      return;
    }
    g.font = `500 22px ${MARKER_FONT}`;
    g.fillStyle = 'rgba(60,60,60,0.55)';
    g.textAlign = 'right';
    g.fillText(`lyrics: ${l.source ?? 'Spotify'}`, W - 40, H - 28);
    g.textAlign = 'left';
    const size = 50;
    const lineH = 66;
    if (!l.synced) {
      let y = 170;
      for (const line of l.lines) {
        for (const row of this.#wrap(line.text, size - 8, max)) {
          if (y > H - 30) return;
          this.#marker(row, left, y, '#222', size - 8, 1, y);
          y += lineH - 8;
        }
      }
      return;
    }
    // the last few lines, oldest fading out; the current one written by the pen
    const shown = [];
    for (let k = Math.max(0, this.index - 5); k <= this.index; k++) if (l.lines[k]?.text) shown.push(k);
    const blocks = shown.map((k) => ({ k, rows: this.#wrap(l.lines[k].text, size, max) }));
    let total = blocks.reduce((n, b) => n + b.rows.length, 0);
    while (total > 8 && blocks.length > 1) total -= blocks.shift().rows.length;
    let y = 175;
    for (const b of blocks) {
      const current = b.k === this.index;
      const age = this.index - b.k;
      const color = current ? '#c4302b' : age === 1 ? '#1f4fbf' : `rgba(30,30,30,${Math.max(0.25, 0.85 - age * 0.15)})`;
      b.rows.forEach((row, r) => {
        let reveal = 1;
        if (current) {
          // the pen moves through the rows in order
          const per = 1 / b.rows.length;
          reveal = Math.max(0, Math.min(1, (this.progress - r * per) / per));
        }
        if (reveal > 0) this.#marker(row, left, y, color, size, reveal, b.k + r);
        y += lineH;
      });
    }
    if (this.index < 0) this.#marker('…waiting for the first line', left, 200, '#777', 44, 1, 5);
  }
}

export class Corner {
  constructor({ floorY, wallZ, look }) {
    this.group = new THREE.Group();
    this.floorY = floorY;
    this.board = new Whiteboard();
    this.screen = null;
    this.video = null;
    this.mediaKey = '';
    this.inView = false;
    this.time = 0;
    this.#build(floorY, wallZ);
    this.setLook(look);
  }

  #build(floorY, wallZ) {
    const g = this.group;
    const add = (mesh, x, y, z, shadow = true) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };

    // floor and a rug
    this.floorMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(700, 160), this.floorMat), 0, floorY, 40, false);
    floor.rotation.x = -Math.PI / 2;
    const rug = add(new THREE.Mesh(new THREE.CircleGeometry(38, 64), new THREE.MeshStandardMaterial({ color: '#3a2230', roughness: 1 })), -8, floorY + 0.05, 22, false);
    rug.rotation.x = -Math.PI / 2;

    // a low TV cabinet
    this.woodMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    const cabinetTop = floorY + 13;
    add(new THREE.Mesh(new RoundedBoxGeometry(70, 12, 22, 3, 0.6), this.woodMat), -14, floorY + 7, wallZ + 13);
    for (const x of [-46, 18]) add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 18), new THREE.MeshStandardMaterial({ color: '#111' })), x, floorY + 1, wallZ + 13);
    const drawerMat = new THREE.MeshStandardMaterial({ color: '#000', transparent: true, opacity: 0.25 });
    for (const x of [-31, 3]) add(new THREE.Mesh(new THREE.PlaneGeometry(30, 8), drawerMat), x, floorY + 7, wallZ + 24.05, false);

    // the CRT TV
    const tvX = -28;
    const tvY = cabinetTop + 14.5;
    const tvZ = wallZ + 13;
    const shell = new THREE.MeshPhysicalMaterial({ color: '#2a2b30', roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.3 });
    add(new THREE.Mesh(new RoundedBoxGeometry(36, 29, 22, 5, 2.2), shell), tvX, tvY, tvZ);
    add(new THREE.Mesh(new RoundedBoxGeometry(26, 21, 12, 4, 3), shell), tvX, tvY + 0.5, tvZ - 14);
    const bezel = add(new THREE.Mesh(new RoundedBoxGeometry(31, 23, 1, 4, 0.5), new THREE.MeshStandardMaterial({ color: '#0d0d10', roughness: 0.6 })), tvX, tvY + 2, tvZ + 10.7, false);
    bezel.receiveShadow = false;
    this.crt = new THREE.ShaderMaterial({ ...CRT, uniforms: THREE.UniformsUtils.clone(CRT.uniforms) });
    this.screen = add(new THREE.Mesh(new THREE.PlaneGeometry(27.5, 20.6), this.crt), tvX, tvY + 2, tvZ + 11.3, false);
    this.screen.castShadow = false;
    // glass over the tube: a faint reflection
    const glassCanvas = canvas(256, 256);
    const gg = glassCanvas.getContext('2d');
    const shine = gg.createLinearGradient(0, 0, 256, 256);
    shine.addColorStop(0, 'rgba(255,255,255,0.16)');
    shine.addColorStop(0.35, 'rgba(255,255,255,0.03)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    gg.fillStyle = shine;
    gg.fillRect(0, 0, 256, 256);
    add(new THREE.Mesh(new THREE.PlaneGeometry(27.5, 20.6), new THREE.MeshBasicMaterial({ map: srgb(glassCanvas), transparent: true, depthWrite: false })), tvX, tvY + 2, tvZ + 11.45, false);
    // speaker grille, knobs and a power light
    const grille = canvas(256, 32);
    const gr = grille.getContext('2d');
    gr.fillStyle = '#1a1a1e';
    gr.fillRect(0, 0, 256, 32);
    gr.fillStyle = '#060607';
    for (let x = 4; x < 256; x += 8) gr.fillRect(x, 6, 4, 20);
    add(new THREE.Mesh(new THREE.PlaneGeometry(18, 2.4), new THREE.MeshStandardMaterial({ map: srgb(grille) })), tvX - 5, tvY - 11.4, tvZ + 11.15, false);
    for (const dx of [8, 11.5]) {
      const knob = add(new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.8, 24), new THREE.MeshStandardMaterial({ color: '#888b92', metalness: 0.7, roughness: 0.3 })), tvX + dx, tvY - 11.4, tvZ + 11.2, false);
      knob.rotation.x = Math.PI / 2;
    }
    this.powerLight = add(new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 12), new THREE.MeshBasicMaterial({ color: '#4cff7a' })), tvX + 14.5, tvY - 11.4, tvZ + 11.2, false);
    this.tvGlow = new THREE.PointLight('#9fc4ff', 140, 70, 1.8);
    this.tvGlow.position.set(tvX, tvY + 2, tvZ + 20);
    g.add(this.tvGlow);

    // a grey game console with its controller
    const plastic = new THREE.MeshPhysicalMaterial({ color: '#b8bbc1', roughness: 0.5, clearcoat: 0.3 });
    const consoleX = 6;
    add(new THREE.Mesh(new RoundedBoxGeometry(22, 4.6, 17, 3, 1), plastic), consoleX, cabinetTop + 2.3, wallZ + 13);
    const lid = add(new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 0.4, 48), new THREE.MeshStandardMaterial({ color: '#a6a9af', roughness: 0.45 })), consoleX - 2.5, cabinetTop + 4.75, wallZ + 12.5);
    lid.receiveShadow = true;
    for (const [dx, color] of [[6.5, '#8f9298'], [8.6, '#8f9298'], [7.6, '#2a8a3a']]) {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.4, 20), new THREE.MeshStandardMaterial({ color, roughness: 0.4 })), consoleX + dx, cabinetTop + 4.75, wallZ + 12 + (color === '#2a8a3a' ? 3 : 0));
    }
    const pad = new THREE.Group();
    pad.add(new THREE.Mesh(new RoundedBoxGeometry(9, 1.6, 4, 3, 0.7), plastic));
    for (const side of [-1, 1]) {
      const grip = new THREE.Mesh(new RoundedBoxGeometry(2.6, 1.6, 4.6, 3, 0.9), plastic);
      grip.position.set(side * 3.6, 0, 2.2);
      grip.rotation.y = side * 0.25;
      pad.add(grip);
    }
    // four face buttons on the right, a d-pad on the left
    for (const [x, z, color] of [[2.4, -0.9, '#4fa36b'], [3.4, 0, '#d3524f'], [2.4, 0.9, '#5c6fd0'], [1.4, 0, '#d38ac7']]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.3, 12), new THREE.MeshStandardMaterial({ color }));
      b.position.set(x, 0.9, z);
      pad.add(b);
    }
    const dpad = new THREE.MeshStandardMaterial({ color: '#45474d' });
    for (const [w, d] of [[1.8, 0.55], [0.55, 1.8]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), dpad);
      arm.position.set(-2.4, 0.9, 0);
      pad.add(arm);
    }
    pad.position.set(consoleX + 4, floorY + 0.9, wallZ + 34);
    pad.rotation.y = -0.5;
    pad.traverse((m) => {
      m.castShadow = true;
    });
    g.add(pad);
    const cable = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
        new THREE.Vector3(consoleX + 1, cabinetTop + 1, wallZ + 21.5),
        new THREE.Vector3(consoleX + 2, floorY + 3, wallZ + 26),
        new THREE.Vector3(consoleX + 6, floorY + 0.6, wallZ + 29),
        new THREE.Vector3(consoleX + 4, floorY + 0.9, wallZ + 32.5),
      ]), 40, 0.22, 8),
      new THREE.MeshStandardMaterial({ color: '#2b2b2f', roughness: 0.7 }),
    );
    g.add(cable);

    // the whiteboard on the wall, with its marker tray
    const bx = 42;
    const by = floorY + 46;
    const bz = wallZ + 1.4;
    const frame = new THREE.MeshStandardMaterial({ color: '#c9ccd2', metalness: 0.8, roughness: 0.3 });
    add(new THREE.Mesh(new RoundedBoxGeometry(BOARD_W + 2, BOARD_H + 2, 1.2, 2, 0.5), frame), bx, by, bz);
    this.boardMesh = add(new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, BOARD_H), new THREE.MeshStandardMaterial({ map: this.board.texture, roughness: 0.35, metalness: 0 })), bx, by, bz + 0.62, false);
    add(new THREE.Mesh(new THREE.BoxGeometry(BOARD_W * 0.7, 0.5, 2.6), frame), bx, by - BOARD_H / 2 - 1.2, bz + 1.6);
    [['#c4302b', -6], ['#1f4fbf', -2], ['#222', 3]].forEach(([color, dx]) => {
      const pen = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 4.2, 4, 10), new THREE.MeshStandardMaterial({ color, roughness: 0.5 })), bx + dx, by - BOARD_H / 2 - 0.55, bz + 1.6);
      pen.rotation.z = Math.PI / 2 + (dx % 2) * 0.05;
    });
    this.lamp = new THREE.SpotLight('#ffe2b8', 2200, 120, Math.PI / 5, 0.6, 1.6);
    this.lamp.position.set(bx - 10, by + 40, bz + 45);
    this.lamp.target = this.boardMesh;
    g.add(this.lamp);
  }

  setLook(look) {
    this.floorMat.map?.dispose();
    this.floorMat.map = look.floorTexture();
    this.floorMat.map.repeat.set(6, 1.4);
    this.floorMat.needsUpdate = true;
    this.woodMat.map?.dispose();
    this.woodMat.map = look.woodTexture();
    this.woodMat.needsUpdate = true;
  }

  /** What's on: a Canvas video, else a still (cover / thumbnail), else static. */
  setScreen({ video = null, image = null } = {}) {
    const key = `${video}|${image}`;
    if (key === this.mediaKey) return;
    this.mediaKey = key;
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
    this.crt.uniforms.map.value?.dispose?.();
    this.crt.uniforms.map.value = null;
    this.crt.uniforms.hasMap.value = 0;
    if (video) {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.src = video;
      const tex = new THREE.VideoTexture(v);
      tex.colorSpace = THREE.NoColorSpace;
      this.video = v;
      v.addEventListener('loadeddata', () => {
        if (this.video !== v) return;
        this.#fit(v.videoWidth, v.videoHeight);
        this.crt.uniforms.map.value = tex;
        this.crt.uniforms.hasMap.value = 1;
      });
      // joined Canvas files don't record their length, so loop by hand too
      v.addEventListener('ended', () => {
        v.currentTime = 0;
        v.play().catch(() => {});
      });
      if (this.inView) v.play().catch(() => {});
    } else if (image) {
      new THREE.TextureLoader().setCrossOrigin('anonymous').load(image, (tex) => {
        if (this.mediaKey !== key) return tex.dispose();
        tex.colorSpace = THREE.NoColorSpace;
        this.#fit(tex.image.width, tex.image.height);
        this.crt.uniforms.map.value = tex;
        this.crt.uniforms.hasMap.value = 1;
      });
    }
  }

  /** Cover-fit a picture of this size into the 4:3 screen. */
  #fit(width, height) {
    const screen = 27.5 / 20.6;
    const aspect = width && height ? width / height : screen;
    this.crt.uniforms.crop.value.set(aspect > screen ? screen / aspect : 1, aspect < screen ? aspect / screen : 1);
  }

  setLyrics(lyrics, title, options) {
    this.board.set(lyrics, title, options);
  }

  /** Returns true when this frame needs drawing because of the corner. */
  update(dt, positionMs, inView) {
    this.time += dt;
    this.crt.uniforms.time.value = this.time;
    if (inView !== this.inView) {
      this.inView = inView;
      if (this.video) inView ? this.video.play().catch(() => {}) : this.video.pause();
    }
    const writing = this.board.update(dt, positionMs);
    if (!inView) return false;
    const moving = !!this.video && !this.video.paused;
    const snow = !this.crt.uniforms.hasMap.value;
    this.tvGlow.intensity = 120 + Math.sin(this.time * 9) * 12;
    return writing || moving || snow;
  }

  debug() {
    const v = this.video;
    const l = this.board.lyrics;
    return { board: { title: this.board.title, synced: l?.synced ?? null, lines: l?.lines?.length ?? null, index: this.board.index, idle: !!this.board.idle }, media: this.mediaKey, hasMap: this.crt.uniforms.hasMap.value, video: v ? { ready: v.readyState, paused: v.paused, error: v.error?.code ?? null, src: v.currentSrc.slice(-40) } : null, inView: this.inView };
  }

  dispose() {
    this.setScreen({});
  }
}
