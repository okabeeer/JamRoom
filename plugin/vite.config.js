// Builds the Spotify plugin: one self-contained script for Spicetify's Extensions folder.
// It reuses the web client and the server's room logic, swapping in the plugin's
// peer-to-peer api.js and platform.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Forward slashes, matching the module IDs Vite uses, so a swapped module is never loaded twice.
const here = (p) => fileURLToPath(new URL(p, import.meta.url)).split(path.sep).join('/');
const key = (p) => path.normalize(p).toLowerCase();

const SWAPS = new Map([
  [key(here('../client/src/lib/api.js')), here('./src/api.js')],
  [key(here('../client/src/lib/platform.js')), here('./src/platform.js')],
]);
const NODE_SHIMS = { 'node:events': here('./src/shims/events.js'), 'node:crypto': here('./src/shims/crypto.js') };

function swapModules() {
  return {
    name: 'jamroom-plugin-swaps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (NODE_SHIMS[source]) return NODE_SHIMS[source];
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return (resolved && SWAPS.get(key(resolved.id))) ?? null;
    },
  };
}

export default defineConfig({
  plugins: [swapModules(), react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: here('../spicetify'),
    emptyOutDir: false,
    lib: { entry: here('./src/main.jsx'), formats: ['iife'], name: 'JamRoomPlugin', fileName: () => 'jamroom.js' },
    target: 'chrome110',
  },
});
