// The slice of node:events that server/rooms.js uses, for running it in Spotify.
export class EventEmitter {
  #listeners = new Map();

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
    return this;
  }

  off(event, fn) {
    const list = this.#listeners.get(event);
    if (list) this.#listeners.set(event, list.filter((f) => f !== fn));
    return this;
  }

  emit(event, ...args) {
    const list = this.#listeners.get(event);
    for (const fn of list ? [...list] : []) fn(...args);
    return !!list?.length;
  }
}

export default { EventEmitter };
