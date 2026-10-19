import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomStore } from './rooms.js';
import { createPersistence } from './persistence.js';
import { createUploadRouter } from './uploads.js';
import { registerSocketHandlers } from './sockets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.JAM_DATA_DIR ?? path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PORT = Number(process.env.PORT ?? 3000);
const DEV = process.argv.includes('--dev');
const UPLOAD_NAME = /^[a-f0-9]{24}\.[a-z0-9]{1,5}$/;

const store = new RoomStore();
const persistence = createPersistence(path.join(DATA_DIR, 'rooms.json'));
const saved = persistence.load();
if (saved) store.load(saved);

const save = () => persistence.schedule(() => store.toJSON());
store.on('change', save);
store.on('ended', ({ files }) => {
  files.forEach(deleteUpload);
  save();
});
store.on('fileRemoved', deleteUpload);

function deleteUpload(name) {
  if (!UPLOAD_NAME.test(name)) return;
  fs.rm(path.join(UPLOAD_DIR, name), { force: true }, (err) => {
    if (err) console.warn(`Could not delete upload ${name}: ${err.message}`);
  });
}

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
// destroyUpgrade: false leaves non-Socket.IO upgrades (Vite HMR in dev) alone.
const io = new Server(server, { maxHttpBufferSize: 64 * 1024, destroyUpgrade: false });
registerSocketHandlers(io, store);

app.use('/api', createUploadRouter({ store, uploadDir: UPLOAD_DIR }));
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true, index: false, fallthrough: false }));
// The Spotify plugin, so friends can download it from the Jam's server.
app.use('/spicetify', express.static(path.join(ROOT, 'spicetify'), { index: false, fallthrough: false }));

if (DEV) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const dist = path.join(ROOT, 'client', 'dist');
  const indexHtml = path.join(dist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    console.error('No client build found. Run "npm run build" first, or use "npm run dev".');
    process.exit(1);
  }
  app.use('/assets', express.static(path.join(dist, 'assets'), { maxAge: '1y', immutable: true }));
  app.use(express.static(dist, { index: false }));
  app.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? res.sendFile(indexHtml) : next()));
}

server.listen(PORT, () => {
  console.log(`JamRoom is running${DEV ? ' (dev)' : ''}:`);
  console.log(`  On this computer:   http://localhost:${PORT}`);
  for (const address of lanAddresses()) console.log(`  On the same Wi-Fi:  http://${address}:${PORT}`);
});

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    persistence.flush();
    process.exit(0);
  });
}
