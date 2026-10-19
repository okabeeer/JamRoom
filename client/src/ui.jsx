import { useCallback, useEffect, useRef, useState } from 'react';
import { getProfile } from './lib/platform.js';

const ICONS = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  next: 'M6 6l8.5 6L6 18zM16 6h2v12h-2z',
  previous: 'M18 6l-8.5 6L18 18zM6 6h2v12H6z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  trash: 'M9 4h6l1 2h4v2H4V6h4zM6 9h12l-1 11H7z',
  up: 'M12 6l6 7h-4v5h-4v-5H6z',
  down: 'M12 18l-6-7h4V6h4v5h4z',
  link: 'M10.6 13.4a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1.2 1.2 1.4 1.4 1.2-1.2a2 2 0 012.8 2.8l-3 3a2 2 0 01-2.8 0zM13.4 10.6a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1.2-1.2-1.4-1.4-1.2 1.2a2 2 0 01-2.8-2.8l3-3a2 2 0 012.8 0z',
  upload: 'M12 4l5 5h-3v6h-4V9H7zM5 17h14v3H5z',
  music: 'M10 17.5V6l10-2v11.5M10 17.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM20 15.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z',
  copy: 'M8 8h11v12H8zM5 4h11v2H7v10H5z',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12',
  headphones: 'M4 15v-3a8 8 0 0116 0v3M4 15h3v5H4zM17 15h3v5h-3z',
  save: 'M6 3h12v18l-6-4-6 4z',
  search: 'M10.5 4a6.5 6.5 0 015.2 10.4l4.4 4.4-1.4 1.4-4.4-4.4A6.5 6.5 0 1110.5 4zm0 2a4.5 4.5 0 100 9 4.5 4.5 0 000-9z',
  queue: 'M4 6h12v2H4zM4 11h12v2H4zM4 16h8v2H4zM17 14v6l4-3z',
  edit: 'M4 17v3h3l10-10-3-3zM15.5 5.5l3 3 1.5-1.5-3-3z',
};
const STROKED = new Set(['music', 'volume', 'headphones']);

/** A button that asks for a second click before doing something that can't be undone. */
export function ConfirmButton({ children, confirmText, onConfirm, className = 'btn btn-small btn-ghost', ...rest }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? `${className} btn-danger` : className}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
      {...rest}
    >
      {armed ? confirmText : children}
    </button>
  );
}

export function Icon({ name, size = 18, label }) {
  const d = ICONS[name];
  const stroked = STROKED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      fill={stroked ? 'none' : 'currentColor'}
      stroke={stroked ? 'currentColor' : 'none'}
      strokeWidth={stroked ? 2 : 0}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

export function IconButton({ icon, label, size, className = '', ...props }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={props.title ?? label} {...props}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);
  const toast = useCallback((text) => {
    const id = ++nextId.current;
    setToasts((list) => [...list.slice(-3), { id, text }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3500);
  }, []);
  return { toasts, toast };
}

export function Toasts({ toasts }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, children, actions }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">{title}</h2>
        {children}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Avatar({ member, size = 28 }) {
  const name = member?.name ?? '?';
  const [broken, setBroken] = useState(false);
  if (member?.avatar && !broken) {
    return <img className="avatar" src={member.avatar} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} />;
  }
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: colorFor(member?.id ?? name) }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function colorFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 42%)`;
}

export function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–:––';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const SOURCE_LABEL = { file: 'File', 'audio-url': 'Link', youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };

/** Re-render on an interval (for progress bars driven by server time). */
export function useTicker(ms, enabled = true) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs https or localhost; fall back for LAN addresses.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Fill an empty name box with the person's Spotify name (plugin only). */
export function useProfileName(name, setName) {
  useEffect(() => {
    if (name) return;
    let cancelled = false;
    getProfile().then((p) => !cancelled && p?.name && setName((current) => current || p.name));
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
