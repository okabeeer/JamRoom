import { io } from 'socket.io-client';

export const socket = io();

/** Emit a command and resolve with the server's ack, or reject with its error. */
export function call(event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error('The server did not respond. Check your connection.'));
      if (!res?.ok) return reject(Object.assign(new Error(res?.error ?? 'Request failed'), { code: res?.code ?? null }));
      resolve(res);
    });
  });
}

export function uploadFiles({ code, token, files, enqueue, onProgress }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('enqueue', enqueue ? '1' : '0');
    for (const file of files) form.append('files', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${code}/upload`);
    xhr.setRequestHeader('x-jam-token', token ?? '');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through to the status-based error
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.ok) resolve(body);
      else reject(new Error(body?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(form);
  });
}
