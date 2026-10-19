// localStorage can throw (private windows, blocked site data); none of this is
// essential, so every access degrades to "nothing stored".

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export const getName = () => read('jam:name') ?? '';
export const setName = (name) => write('jam:name', name);
export const getToken = (code) => read(`jam:token:${code}`);
export const setToken = (code, token) => write(`jam:token:${code}`, token);
export const clearToken = (code) => write(`jam:token:${code}`, null);
export const getVolume = () => {
  const v = Number(read('jam:volume'));
  return read('jam:volume') != null && v >= 0 && v <= 1 ? v : 0.8;
};
export const setVolume = (v) => write('jam:volume', String(v));
