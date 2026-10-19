// The Jam the UI is in, for other views of it (the plugin's 3D shelf). Jam.jsx publishes
// its state and controls here; a view subscribes and can drive the same Jam.

let snapshot = { code: null, room: null, memberId: null, canControl: false, listening: false, playback: null, toggleListening: null, act: null };
const listeners = new Set();

export const jamBridge = {
  get: () => snapshot,
  set(patch) {
    snapshot = { ...snapshot, ...patch };
    for (const fn of listeners) fn(snapshot);
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
