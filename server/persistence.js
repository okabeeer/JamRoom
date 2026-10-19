// Debounced JSON snapshot of all rooms, written atomically (tmp + rename).

import fs from 'node:fs';
import path from 'node:path';

export function createPersistence(file, { delayMs = 400 } = {}) {
  let timer = null;
  let getData = null;

  function writeNow() {
    timer = null;
    if (!getData) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(getData()));
    fs.renameSync(tmp, file);
  }

  return {
    load() {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`Could not read ${file}: ${err.message}`);
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (err) {
        // Keep the broken file for inspection instead of overwriting it.
        const aside = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, aside);
        console.warn(`${file} was unreadable (${err.message}); moved it to ${aside} and started fresh.`);
        return null;
      }
    },
    schedule(fn) {
      getData = fn;
      if (!timer) timer = setTimeout(writeNow, delayMs);
    },
    flush() {
      if (!timer) return;
      clearTimeout(timer);
      writeNow();
    },
  };
}
