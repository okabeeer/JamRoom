// The slice of node:crypto that server/rooms.js uses, backed by Web Crypto.
function randomBytes(size) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(size));
  bytes.toString = (encoding) => {
    if (encoding !== 'base64url') throw new Error(`Unsupported encoding ${encoding}`);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return bytes;
}

export default { randomBytes };
